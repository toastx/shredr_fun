//! Withdraw lamports from a stealth PDA to any destination address.
//!
//! ## Accounts
//!
//! | # | Account          | Signer | Writable | Description                                      |
//! |---|------------------|--------|----------|--------------------------------------------------|
//! | 0 | owner            | ✓      | ✓        | Burner keypair that owns the stealth account     |
//! | 1 | stealth_account  |        | ✓        | Stealth PDA holding the funds                    |
//! | 2 | destination      |        | ✓        | Any destination address to receive lamports      |
//!
//! ## Instruction Data
//!
//! `[amount: u64]` — 8 bytes, little-endian.
//!
//! ## Security
//!
//! - The owner (burner) must sign.
//! - The stealth account must be owned by the SHREDR program.
//! - The stealth account must NOT be delegated (withdraw only on base layer).
//! - The owner field in stealth state must match the signer's address.
//!
//! ## Note on lamport manipulation
//!
//! Direct `set_lamports` is used here because the stealth account is a
//! program-owned PDA. The program has authority to debit its own accounts.

use crate::errors::ShredrError;
use crate::helpers::get_stealth_mut;
use crate::helpers::parse_amount;
use crate::helpers::verify_stealth_pda;
use crate::AccountView;
use crate::Address;
use crate::ProgramError;
use crate::ProgramResult;

use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;

pub struct Withdraw<'a> {
    pub owner: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub destination: &'a AccountView,
    pub amount: u64,
}

impl<'a> Withdraw<'a> {
    pub fn process(self) -> ProgramResult {
        let Withdraw {
            owner,
            stealth_account,
            destination,
            amount,
        } = self;

        let stealth_data = get_stealth_mut(stealth_account)?;

        if &stealth_data.owner != owner.address() {
            return Err(ProgramError::IllegalOwner);
        }

        // Confirm this really is the stealth PDA for that owner, not just some
        // program-owned account carrying a valid discriminator. Ownership and
        // discriminator alone would make the withdraw path depend on no other
        // instruction ever minting a program-owned account outside the
        // `[STEALTH_ADDRESS, burner]` family.
        verify_stealth_pda(stealth_account, owner.address())?;

        // Must be undelegated — can only withdraw on base layer
        if stealth_data.delegated {
            return Err(ShredrError::AlreadyDelegated.into());
        }

        if stealth_data.deposited_amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }

        let new_stealth_lamports = stealth_account
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        // Never let the stealth account drop below rent-exemption. `deposited_amount`
        // excludes rent, so a well-formed withdraw (amount <= deposited_amount)
        // always leaves at least the rent-exempt minimum. This floor is a safety
        // net against any lamports/deposited_amount desync: dropping below rent
        // would let the runtime reap the account and strand the residual lamports.
        let rent =
            Rent::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;
        let rent_minimum = rent.try_minimum_balance(stealth_account.data_len())?;
        if new_stealth_lamports < rent_minimum {
            return Err(ShredrError::BalanceInvariantViolation.into());
        }

        let new_destination_lamports = destination
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        stealth_account.set_lamports(new_stealth_lamports);
        destination.set_lamports(new_destination_lamports);

        stealth_data.deposited_amount = stealth_data
            .deposited_amount
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        // If fully drained, zero out the account state
        if stealth_data.deposited_amount == 0 {
            stealth_data.owner = Address::default();
            stealth_data.delegated = false;
            stealth_data.bump = 0;
        }

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for Withdraw<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, instruction_data) = value;
        let mut iter = accounts.iter();

        let owner = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let destination = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        let amount = parse_amount(instruction_data)?;

        // Reject a destination that is the stealth account itself: the paired
        // set_lamports calls would credit the account without a matching debit,
        // which the runtime rejects as a lamports imbalance. Fail early with a
        // clear error instead.
        if destination.address() == stealth_account.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        if !owner.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        Ok(Self {
            owner,
            stealth_account,
            destination,
            amount,
        })
    }
}
