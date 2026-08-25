//! Private transfer from a deposit PDA to an exit PDA inside the MagicBlock rollup.
//! Instruction data is `[amount: u64]`; accounts are listed in `idl.rs`.
//!
//! This is the hop that breaks the on-chain link — it happens in the rollup and
//! never appears on Solana. Both accounts must be delegated to the *same*
//! validator to be writable together; see `constants::tee_validator`.
//!
//! Moving the full balance leaves the source at its rent-exempt minimum with
//! `deposited_amount == 0`, the state `CloseStealthAccount` requires.
//!
//! A PDA can never sign, so the source's burner authorizes: it signs, and must
//! match the PDA's recorded `owner` (the ACL member registered at delegation).
//! Lamports move via `set_lamports` rather than a System CPI because both
//! accounts are program-owned and the rollup may not offer that CPI.

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

        // Safety net against a lamports/deposited_amount desync: below rent the
        // runtime reaps the account, stranding the residue. Same floor `Withdraw`
        // enforces.
        let rent =
            Rent::get().map_err(|_| -> ProgramError { ShredrError::RentUnavailable.into() })?;
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

        // One account passed twice would make `get_stealth_mut` hand out two
        // aliasing `&mut` to the same bytes — UB, and a violation of its SAFETY
        // contract.
        if source_pda.address() == destination_pda.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

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
