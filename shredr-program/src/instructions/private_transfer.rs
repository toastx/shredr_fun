//! Private transfer between two stealth PDAs inside the MagicBlock rollup.
//!
//! ## Accounts
//!
//! | # | Account          | Signer | Writable | Description                      |
//! |---|------------------|--------|----------|----------------------------------|
//! | 0 | source_pda       | ✓      | ✓        | Source stealth PDA (must sign)   |
//! | 1 | destination_pda  |        | ✓        | Destination stealth PDA          |
//!
//! ## Instruction Data
//!
//! `[amount: u64]` — 8 bytes, little-endian.
//!
//! ## Security
//!
//! - Source PDA must sign (delegated key signs inside the rollup).
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
use crate::ProgramError;
use crate::AccountView;
use crate::ProgramResult;
use crate::helpers::{get_stealth_mut, parse_amount};


pub struct PrivateTransfer<'a> {
    pub source_pda: &'a AccountView,
    pub destination_pda: &'a AccountView,
    pub amount: u64,
}

impl<'a> PrivateTransfer<'a> {
    pub fn process(self) -> ProgramResult {
        let PrivateTransfer {
            source_pda,
            destination_pda,
            amount,
        } = self;

        // Safe access with ownership/length/discriminator validation
        let source_data = get_stealth_mut(source_pda)?;

        if source_data.deposited_amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }

        // Update source lamports
        let new_source_lamports = source_pda.lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        source_pda.set_lamports(new_source_lamports);

        source_data.deposited_amount = source_data.deposited_amount
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        // Safe access for destination (validates it's a real stealth account)
        let destination_data = get_stealth_mut(destination_pda)?;

        // Update destination lamports
        let new_dest_lamports = destination_pda.lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        destination_pda.set_lamports(new_dest_lamports);

        destination_data.deposited_amount = destination_data.deposited_amount
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(())
    }
}

// Standardized to (accounts, data) — previously was (data, accounts)
impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for PrivateTransfer<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, data) = value;
        if accounts.len() < 2 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let source_pda = &accounts[0];
        let destination_pda = &accounts[1];
        let amount = parse_amount(data)?;

        // Source must sign (delegated key signs inside rollup)
        if !source_pda.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // Both accounts must be owned by the SHREDR program
        if !source_pda.owned_by(&PROGRAM_ADDRESS) {
            return Err(ShredrError::InvalidProgramOwner.into());
        }
        if !destination_pda.owned_by(&PROGRAM_ADDRESS) {
            return Err(ShredrError::InvalidDestinationOwner.into());
        }

        Ok(Self {
            source_pda,
            destination_pda,
            amount,
        })
    }
}
