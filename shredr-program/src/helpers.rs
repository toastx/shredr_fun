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

/// Derive a stealth account PDA from a burner pubkey.
///
/// The burner is one-time (derived client-side from the main key's signature +
/// a nonce), so it alone makes the PDA unique — no salt is needed.
pub fn derive_stealth_account_from_pubkey(
    burner_pubkey: &Address,
) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::STEALTH_ADDRESS, burner_pubkey.as_ref()],
        &PROGRAM_ADDRESS,
    )
    .ok_or(ProgramError::InvalidAccountData)
}

/// Safely obtain a mutable reference to the `StealthAccount` stored in an account's data.
///
/// Performs the following safety checks before the `unsafe` cast:
/// 1. The account is owned by the SHREDR program.
/// 2. The account data is large enough to hold `[8-byte discriminator] + StealthAccount`.
/// 3. The first 8 bytes match the expected discriminator.
///
/// # Safety
/// The underlying cast is still `unsafe` but guarded by the validation above.
/// The caller must ensure no aliasing mutable references exist.
#[allow(clippy::mut_from_ref)]
pub fn get_stealth_mut(account: &AccountView) -> Result<&mut StealthAccount, ProgramError> {
    if !account.owned_by(&PROGRAM_ADDRESS) {
        return Err(ShredrError::InvalidProgramOwner.into());
    }

    let required_len = 8 + STEALTH_ACCOUNT_SIZE;
    if account.data_len() < required_len {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    // SAFETY: We've verified ownership and data length above.
    // The borrow_unchecked_mut gives us raw access to account data bytes.
    unsafe {
        let data = account.borrow_unchecked_mut();

        // Compare the discriminator slice directly — the length is already
        // guaranteed above, so no intermediate copy is needed.
        if data[0..8] != STEALTH_ACCOUNT_DISCRIMINATOR {
            return Err(ShredrError::InvalidDiscriminator.into());
        }

        // The pointer arithmetic is bounded: we skip 8 bytes (discriminator) and
        // have confirmed at least 8 + size_of::<StealthAccount>() bytes exist.
        Ok(&mut *(data.as_mut_ptr().add(8) as *mut StealthAccount))
    }
}

/// Write the discriminator bytes to the first 8 bytes of a stealth account.
/// Should be called once during initialization before writing any state.
///
/// Returns [`ShredrError::AccountDataTooSmall`] if the account cannot hold a
/// full `[discriminator][StealthAccount]` layout, so the `unsafe` write below
/// can never index out of bounds.
pub fn write_stealth_discriminator(account: &AccountView) -> Result<(), ProgramError> {
    // Bounds precondition for the unsafe write (and the state that follows it).
    if account.data_len() < 8 + STEALTH_ACCOUNT_SIZE {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    // SAFETY: The length check above guarantees at least 8 bytes exist, so the
    // slice write to `data[0..8]` is in bounds. No other reference to this
    // account's data is live at this point (called once, right after creation).
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
