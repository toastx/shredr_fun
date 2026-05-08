//! Helper utilities for the SHREDR program.
//!
//! Includes PDA derivation, safe account state access, and instruction data parsing.

use pinocchio::error::ProgramError;
use pinocchio::Address;
use pinocchio::AccountView;
use crate::constants::PROGRAM_ADDRESS;
use crate::constants::seeds;
use crate::errors::ShredrError;
use crate::state::{StealthAccount, STEALTH_ACCOUNT_DISCRIMINATOR, STEALTH_ACCOUNT_SIZE};

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

/// Derive a stealth account PDA from a burner's AccountView and salt.
///
/// Seeds: `[STEALTH_ADDRESS, burner_address, salt]`
pub fn derive_stealth_account(burner: &AccountView, salt: &[u8; 32]) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::STEALTH_ADDRESS, burner.address().as_ref(), salt.as_ref()],
        &PROGRAM_ADDRESS,
    )
    .ok_or(ProgramError::InvalidAccountData)
}

/// Derive a stealth account PDA from a raw burner pubkey and salt.
///
/// Used when we have the pubkey bytes (e.g. from instruction data) rather than an AccountView.
pub fn derive_stealth_account_from_pubkey(burner_pubkey: &Address, salt: &[u8; 32]) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::STEALTH_ADDRESS, burner_pubkey.as_ref(), salt.as_ref()],
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
pub fn get_stealth_mut(account: &AccountView) -> Result<&mut StealthAccount, ProgramError> {
    // 1. Ownership check
    if !account.owned_by(&PROGRAM_ADDRESS) {
        return Err(ShredrError::InvalidProgramOwner.into());
    }

    // 2. Data length check
    let required_len = 8 + STEALTH_ACCOUNT_SIZE;
    if account.data_len() < required_len {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    // SAFETY: We've verified ownership and data length above.
    // The borrow_unchecked_mut gives us raw access to account data bytes.
    unsafe {
        let data = account.borrow_unchecked_mut();

        // 3. Discriminator check
        let disc: [u8; 8] = data[0..8].try_into().map_err(|_| -> ProgramError { ShredrError::InvalidDiscriminator.into() })?;
        if disc != STEALTH_ACCOUNT_DISCRIMINATOR {
            return Err(ShredrError::InvalidDiscriminator.into());
        }

        // The pointer arithmetic is bounded: we skip 8 bytes (discriminator) and
        // have confirmed at least 8 + size_of::<StealthAccount>() bytes exist.
        Ok(&mut *(data.as_mut_ptr().add(8) as *mut StealthAccount))
    }
}

/// Write the discriminator bytes to the first 8 bytes of a stealth account.
/// Should be called once during initialization before writing any state.
pub fn write_stealth_discriminator(account: &AccountView) {
    // SAFETY: We're writing the discriminator to the first 8 bytes of account data.
    // The caller is responsible for ensuring the account has sufficient data length.
    unsafe {
        let data = account.borrow_unchecked_mut();
        data[0..8].copy_from_slice(&STEALTH_ACCOUNT_DISCRIMINATOR);
    }
}

/// Validate that an account's address matches the expected PDA derivation.
pub fn verify_stealth_pda(
    account: &AccountView,
    burner_pubkey: &Address,
    salt: &[u8; 32],
) -> Result<u8, ProgramError> {
    let (expected_pda, bump) = derive_stealth_account_from_pubkey(burner_pubkey, salt)?;
    if account.address() != &expected_pda {
        return Err(ShredrError::InvalidStealthPDA.into());
    }
    Ok(bump)
}