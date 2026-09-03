//! Helper utilities for the SHREDR program.
//!
//! Includes PDA derivation, safe account state access, and instruction data parsing.

use crate::constants::seeds;
use crate::constants::PROGRAM_ADDRESS;
use crate::errors::ShredrError;
use crate::state::{
    PoolLedger, PoolVault, StealthAccount, POOL_LEDGER_DISCRIMINATOR, POOL_LEDGER_SIZE,
    POOL_VAULT_DISCRIMINATOR, POOL_VAULT_SIZE, STEALTH_ACCOUNT_DISCRIMINATOR,
    STEALTH_ACCOUNT_SIZE,
};
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

// ─────────────────────────────────────────────
// Shielded pool accounts
// ─────────────────────────────────────────────

/// Derive a pool's vault and ledger PDAs from its denomination.
///
/// Keyed by the amount alone, so there is exactly one canonical pool per
/// denomination and a client can find it without a registry.
pub fn derive_pool_vault(denomination: u64) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::POOL_VAULT, &denomination.to_le_bytes()],
        &PROGRAM_ADDRESS,
    )
    .ok_or(ProgramError::InvalidAccountData)
}

/// See [`derive_pool_vault`].
pub fn derive_pool_ledger(denomination: u64) -> Result<(Address, u8), ProgramError> {
    Address::derive_program_address(
        &[seeds::POOL_LEDGER, &denomination.to_le_bytes()],
        &PROGRAM_ADDRESS,
    )
    .ok_or(ProgramError::InvalidAccountData)
}

/// Mutable view of a `PoolVault`, after checking ownership, length and
/// discriminator.
///
/// # Safety
/// Same contract as [`get_stealth_mut`]: never hold two of these for one
/// account. The vault and ledger have different discriminators, so a caller that
/// swapped them gets `InvalidDiscriminator` rather than a reinterpreted struct.
#[allow(clippy::mut_from_ref)]
pub fn get_vault_mut(account: &AccountView) -> Result<&mut PoolVault, ProgramError> {
    // SAFETY: delegated to the checked helper below; see its doc comment.
    unsafe { typed_account_mut(account, &POOL_VAULT_DISCRIMINATOR, POOL_VAULT_SIZE) }
}

/// Mutable view of a `PoolLedger`. See [`get_vault_mut`].
#[allow(clippy::mut_from_ref)]
pub fn get_ledger_mut(account: &AccountView) -> Result<&mut PoolLedger, ProgramError> {
    // SAFETY: delegated to the checked helper below; see its doc comment.
    unsafe { typed_account_mut(account, &POOL_LEDGER_DISCRIMINATOR, POOL_LEDGER_SIZE) }
}

/// Cast an account's data to `T` after checking program ownership, length and
/// discriminator.
///
/// # Safety
/// `T` must be the type the discriminator names, and its size must be `size`.
/// The 8-byte alignment the cast needs holds because account data starts aligned
/// and the discriminator is 8 bytes. **Callers must not hold two of these for
/// the same account** — `borrow_unchecked_mut` leaves the borrow flag untouched,
/// so duplicate accounts would alias.
#[allow(clippy::mut_from_ref)]
unsafe fn typed_account_mut<'a, T>(
    account: &'a AccountView,
    discriminator: &[u8; 8],
    size: usize,
) -> Result<&'a mut T, ProgramError> {
    if !account.owned_by(&PROGRAM_ADDRESS) {
        return Err(ShredrError::InvalidProgramOwner.into());
    }

    if account.data_len() < 8 + size {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    let data = account.borrow_unchecked_mut();

    if &data[0..8] != discriminator.as_slice() {
        return Err(ShredrError::InvalidDiscriminator.into());
    }

    Ok(&mut *(data.as_mut_ptr().add(8) as *mut T))
}

/// Write a discriminator into a freshly created account, once, before any state.
pub fn write_discriminator(
    account: &AccountView,
    discriminator: &[u8; 8],
    size: usize,
) -> Result<(), ProgramError> {
    if account.data_len() < 8 + size {
        return Err(ShredrError::AccountDataTooSmall.into());
    }

    // SAFETY: length checked above, so the write is in bounds; called right after
    // creation, so no other reference to this data is live.
    unsafe {
        let data = account.borrow_unchecked_mut();
        data[0..8].copy_from_slice(discriminator);
    }
    Ok(())
}

/// Whether `needle` appears in the first `count` entries of `haystack`.
///
// ponytail: linear scan. At POOL_COMMITMENT_CAP = 512 that is 512 32-byte
// compares, which fits the budget with room to spare. If the caps grow, keep the
// lists sorted on insert and binary-search here — the entries are opaque hashes,
// so sort order leaks nothing.
pub fn contains_hash(haystack: &[[u8; 32]], count: usize, needle: &[u8; 32]) -> bool {
    haystack[..count].iter().any(|entry| entry == needle)
}
