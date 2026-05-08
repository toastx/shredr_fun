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
use crate::ProgramError;
use crate::AccountView;
use crate::ProgramResult;
use crate::Address;
use crate::helpers::parse_amount;

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

        // Safe access with ownership/length/discriminator validation
        let stealth_data = get_stealth_mut(stealth_account)?;

        // Owner check — stealth state owner must match the signer
        if &stealth_data.owner != owner.address() {
            return Err(ProgramError::IllegalOwner);
        }

        // Must be undelegated — can only withdraw on base layer
        if stealth_data.delegated {
            return Err(ShredrError::AlreadyDelegated.into());
        }

        // Amount check
        if stealth_data.deposited_amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }

        // Transfer lamports: stealth_account -> destination
        let new_stealth_lamports = stealth_account
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        let new_destination_lamports = destination
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        stealth_account.set_lamports(new_stealth_lamports);
        destination.set_lamports(new_destination_lamports);

        // Update state
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

        let owner           = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let destination     = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        let amount = parse_amount(instruction_data)?;

        // Signer check — only in TryFrom (removed duplicate from process)
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