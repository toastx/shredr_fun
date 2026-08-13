//! Private transfer from a deposit PDA to an exit PDA inside the MagicBlock rollup.
//!
//! This is the hop that breaks the on-chain link: the address that received a
//! deposit is not the address that later pays out, and the move between them
//! happens in the rollup, so it never appears on Solana. Both accounts must be
//! delegated to the *same* validator for this to be executable — see
//! `constants::tee_validator`.
//!
//! Transferring the source's full balance leaves it at exactly its rent-exempt
//! minimum with `deposited_amount == 0`, which is the state
//! `CloseStealthAccount` requires: undelegate the drained deposit PDA, then close
//! it to reclaim the rent.
//!
//! The instruction itself is symmetric and role-agnostic — it moves lamports
//! between any two stealth PDAs. "Deposit" and "exit" are client conventions.
//!
//! ## Accounts
//!
//! | # | Account          | Signer | Writable | Description                                  |
//! |---|------------------|--------|----------|----------------------------------------------|
//! | 0 | source_burner    | ✓      |          | Burner that owns the source PDA, authorizes  |
//! | 1 | source_pda       |        | ✓        | Source stealth PDA                           |
//! | 2 | destination_pda  |        | ✓        | Destination stealth PDA                      |
//!
//! ## Instruction Data
//!
//! `[amount: u64]` — 8 bytes, little-endian.
//!
//! ## Security
//!
//! - A PDA can never sign, so the transfer is authorized by the source's burner:
//!   it must sign, and its address must equal the source PDA's recorded `owner`.
//!   This is the burner registered as the ACL member at delegation time.
//! - Both accounts must be owned by the SHREDR program.
//! - Lamports are moved directly (valid inside MagicBlock ephemeral rollups).
//! - `deposited_amount` is updated atomically for both accounts.
//!
//! ## Note on lamport manipulation
//!
//! Direct `set_lamports` is used instead of CPI `SystemTransfer` because this
//! instruction executes inside a MagicBlock ephemeral rollup where the program
//! owns both accounts and CPI to the System Program may not be available.

use crate::constants::PROGRAM_ADDRESS;
use crate::errors::ShredrError;
use crate::helpers::{get_stealth_mut, parse_amount};
use crate::AccountView;
use crate::ProgramError;
use crate::ProgramResult;

use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;

pub struct PrivateTransfer<'a> {
    pub source_burner: &'a AccountView,
    pub source_pda: &'a AccountView,
    pub destination_pda: &'a AccountView,
    pub amount: u64,
}

impl<'a> PrivateTransfer<'a> {
    pub fn process(self) -> ProgramResult {
        let PrivateTransfer {
            source_burner,
            source_pda,
            destination_pda,
            amount,
        } = self;

        let source_data = get_stealth_mut(source_pda)?;

        // Authorize against the recorded owner: the signer must be the burner
        // that owns the source PDA, not the PDA itself (a PDA never signs).
        if &source_data.owner != source_burner.address() {
            return Err(ProgramError::IllegalOwner);
        }

        if source_data.deposited_amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }

        let new_source_lamports = source_pda
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        // Same floor `Withdraw` enforces: `deposited_amount` excludes rent, so a
        // well-formed transfer always leaves the rent-exempt minimum behind. The
        // check is a safety net against a lamports/deposited_amount desync —
        // dropping below rent lets the runtime reap the account, stranding both
        // the residual lamports and the delegation the rollup depends on.
        let rent =
            Rent::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;
        let rent_minimum = rent.try_minimum_balance(source_pda.data_len())?;
        if new_source_lamports < rent_minimum {
            return Err(ShredrError::BalanceInvariantViolation.into());
        }

        source_pda.set_lamports(new_source_lamports);

        source_data.deposited_amount = source_data
            .deposited_amount
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        let destination_data = get_stealth_mut(destination_pda)?;

        let new_dest_lamports = destination_pda
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        destination_pda.set_lamports(new_dest_lamports);

        destination_data.deposited_amount = destination_data
            .deposited_amount
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for PrivateTransfer<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, data) = value;
        if accounts.len() < 3 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let source_burner = &accounts[0];
        let source_pda = &accounts[1];
        let destination_pda = &accounts[2];
        let amount = parse_amount(data)?;

        // Reject self-transfer. Passing the same account as both source and
        // destination would make `get_stealth_mut` hand out two aliasing
        // `&mut StealthAccount` references to the same bytes (undefined
        // behavior, and a violation of that helper's documented SAFETY
        // contract), on top of being a meaningless no-op transfer.
        if source_pda.address() == destination_pda.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        // The source's burner authorizes the move (owner match is checked in
        // `process` against the PDA's recorded owner).
        if !source_burner.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        if !source_pda.owned_by(&PROGRAM_ADDRESS) {
            return Err(ShredrError::InvalidProgramOwner.into());
        }
        if !destination_pda.owned_by(&PROGRAM_ADDRESS) {
            return Err(ShredrError::InvalidDestinationOwner.into());
        }

        Ok(Self {
            source_burner,
            source_pda,
            destination_pda,
            amount,
        })
    }
}
