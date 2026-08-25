//! Withdraw lamports from an undelegated exit PDA to any destination address.
//! Instruction data is `[amount: u64]`; accounts are listed in `idl.rs`.
//!
//! The exit PDA has received funds via `PrivateTransfer` and been returned to the
//! base layer by `CommitAndUndelegateStealth`. A full withdrawal leaves it at its
//! rent-exempt minimum with `deposited_amount == 0` — the state
//! `CloseStealthAccount` needs. `owner` is deliberately left intact when draining:
//! `Close` authorizes against it, so clearing it would strand the rent.

use crate::errors::ShredrError;
use crate::helpers::get_stealth_mut;
use crate::helpers::parse_amount;
use crate::helpers::verify_stealth_pda;
use crate::AccountView;
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

        // Not just any program-owned account carrying a valid discriminator.
        verify_stealth_pda(stealth_account, owner.address())?;

        // Withdrawal is a base-layer operation.
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

        // Safety net against a lamports/deposited_amount desync: below rent the
        // runtime reaps the account, stranding the residue.
        let rent =
            Rent::get().map_err(|_| -> ProgramError { ShredrError::RentUnavailable.into() })?;
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

        // A drained account keeps `owner` and `bump` — `CloseStealthAccount`
        // authorizes against `owner`, so zeroing it here would strand the rent.
        stealth_data.deposited_amount = stealth_data
            .deposited_amount
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

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

        // Paying into the stealth account credits it without a matching debit,
        // which the runtime rejects as a lamports imbalance.
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
