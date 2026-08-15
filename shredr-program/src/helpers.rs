//! Helper utilities for the SHREDR program.
//!
//! Includes PDA derivation, safe account state access, and instruction data parsing.

use crate::constants::seeds;
use crate::constants::PROGRAM_ADDRESS;
use crate::errors::ShredrError;
use crate::state::{StealthAccount, STEALTH_ACCOUNT_DISCRIMINATOR, STEALTH_ACCOUNT_SIZE};
use pinocchio::error::ProgramError;
use pinocchio::AccountView;
use pinocchio::Address;

/// Parse a little-endian u64 amount from instruction data.
/// Returns an error if the data is not exactly 8 bytes or the value is zero.
pub fn parse_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != core::mem::size_of::<u64>() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amt = u64::from_le_bytes(data.try_into().unwrap());
    if amt == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(amt)
}

/// Derive a stealth account PDA from a burner pubkey. The burner is one-time, so
/// it alone makes the PDA unique — no salt needed.
pub fn derive_stealth_account_from_pubkey(
    burner_pubkey: &Address,
) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::STEALTH_ADDRESS, burner_pubkey.as_ref()],
        &PROGRAM_ADDRESS,
    )
    .ok_or(ProgramError::InvalidAccountData)
}

/// Mutable view of the `StealthAccount` in an account's data, after checking
/// program ownership, length, and discriminator.
///
/// # Safety
/// The cast requires 8-byte alignment, which holds because account data starts
/// aligned and the discriminator is 8 bytes. **Callers must not hold two of these
/// for the same account** — `borrow_unchecked_mut` leaves the borrow flag
/// untouched, so duplicate accounts would alias.
#[allow(clippy::mut_from_ref)]
pub fn get_stealth_mut(account: &AccountView) -> Result<&mut StealthAccount, ProgramError> {
    if !account.owned_by(&PROGRAM_ADDRESS) {
        return Err(ShredrError::InvalidProgramOwner.into());
    }

    let required_len = 8 + STEALTH_ACCOUNT_SIZE;
    if account.data_len() < required_len {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    // SAFETY: ownership and length checked above; see the doc comment.
    unsafe {
        let data = account.borrow_unchecked_mut();

        if data[0..8] != STEALTH_ACCOUNT_DISCRIMINATOR {
            return Err(ShredrError::InvalidDiscriminator.into());
        }

        Ok(&mut *(data.as_mut_ptr().add(8) as *mut StealthAccount))
    }
}

/// Write the discriminator into a freshly created stealth account, once, before
/// any state.
pub fn write_stealth_discriminator(account: &AccountView) -> Result<(), ProgramError> {
    if account.data_len() < 8 + STEALTH_ACCOUNT_SIZE {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    // SAFETY: length checked above, so the write is in bounds; called right after
    // creation, so no other reference to this data is live.
    unsafe {
        let data = account.borrow_unchecked_mut();
        data[0..8].copy_from_slice(&STEALTH_ACCOUNT_DISCRIMINATOR);
    }
    Ok(())
}

/// Validate that an account's address matches the expected PDA derivation.
pub fn verify_stealth_pda(
    account: &AccountView,
    burner_pubkey: &Address,
) -> Result<u8, ProgramError> {
    let (expected_pda, bump) = derive_stealth_account_from_pubkey(burner_pubkey)?;
    if account.address() != &expected_pda {
        return Err(ShredrError::InvalidStealthPDA.into());
    }
    Ok(bump)
}
