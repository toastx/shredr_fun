//! Account state definitions for the SHREDR privacy program.
//!
//! `StealthAccount` is the core struct stored in stealth PDAs. It tracks
//! ownership, deposited lamports, delegation status, and PDA derivation info.
//!
//! `UserAddress` and `ProgramConfig` are reserved for future use:
//! - `UserAddress`: per-user aggregation of received funds.
//! - `ProgramConfig`: global admin config (paused state, validator key, etc.).

use pinocchio::Address;

/// 8-byte discriminator written at the start of every StealthAccount PDA.
/// SHA-256("stealth_account")[0..8] — chosen to avoid collisions.
pub const STEALTH_ACCOUNT_DISCRIMINATOR: [u8; 8] = [0x53, 0x48, 0x52, 0x45, 0x44, 0x52, 0x53, 0x41]; // "SHREDRSA"

/// Size of `StealthAccount` in bytes (for account data length validation).
pub const STEALTH_ACCOUNT_SIZE: usize = core::mem::size_of::<StealthAccount>();

/// Core state stored inside each stealth PDA.
///
/// Layout: `[8-byte discriminator][StealthAccount bytes]`
///
/// # Fields
/// - `owner`: The burner pubkey that owns this stealth account.
/// - `salt`: 32-byte random salt used in PDA derivation.
/// - `deposited_amount`: Lamports deposited (tracked independently of actual lamports for accounting).
/// - `deposit_timestamp`: Unix timestamp when funds were first deposited.
/// - `delegated`: Whether this account is currently delegated to a MagicBlock validator.
/// - `bump`: PDA bump seed for re-derivation.
#[repr(C)]
pub struct StealthAccount {
    pub owner: Address,
    pub salt: [u8; 32],
    pub deposited_amount: u64,
    pub deposit_timestamp: i64,
    pub delegated: bool,
    pub bump: u8,
}

/// Reserved: Per-user address tracking for future aggregation features.
#[repr(C)]
pub struct UserAddress {
    pub owner: Address,
    pub available_balance: u64,
    pub total_ever_received: u64,
    pub bump: u8,
}

/// Reserved: Global program configuration for future admin features.
///
/// Planned use: store the TEE validator pubkey per-environment,
/// pause/unpause the program, set minimum flush delays, etc.
#[repr(C)]
pub struct ProgramConfig {
    pub admin_multisig: Address,
    pub paused: bool,
    pub min_flush_delay_secs: i64,
    pub bump: u8,
}
