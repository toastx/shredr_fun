use anchor_lang::prelude::*;

// PROGRAM IDS — MagicBlock infrastructure

pub const PERMISSION_PROGRAM_ID: &str = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
pub const DELEGATION_PROGRAM_ID: &str = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
pub const TEE_VALIDATOR_MAINNET: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";


// PDA SEEDS
pub mod seeds {
    pub const PROGRAM_CONFIG:&[u8] = b"shredr_program_config";
    pub const STEALTH_ADDRESS:&[u8] = b"shredr_stealth_address";
    pub const USER_ADDRESS:&[u8] = b"shredr_user_address";
}

// ────────────────────────────────────────────────────────────────────────────
// PROGRAM CONFIG
// PDA: [seeds::PROGRAM_CONFIG]
// Singleton. Initialized once at deployment. Only admin_multisig can mutate.
// ────────────────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct ProgramConfig {
    pub admin_multisig: Pubkey,
    pub paused: bool,
    pub min_flush_delay_secs: i64,
    pub bump: u8,
}


#[account]
#[derive(InitSpace)]
pub struct StealthAccount {
    pub owner: Pubkey,
    pub salt: [u8; 32],
    pub deposited_amount: u64,
    pub deposit_timestamp: i64,
    pub delegated: bool,

    pub bump: u8,
}


#[account]
#[derive(InitSpace)]
pub struct UserAddress {
    pub owner: Pubkey,
    pub available_balance: u64,
    pub total_ever_received: u64,
    pub bump: u8,
}

// ────────────────────────────────────────────────────────────────────────────
// EVENTS — no user-identifying fields in any event
// ────────────────────────────────────────────────────────────────────────────

#[event]
pub struct StealthDeposited {
    pub stealth_pda: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[event]
pub struct StealthDelegated {
    pub stealth_pda: Pubkey,
    pub slot: u64,
}

#[event]
pub struct FlushedToVault {.
    pub slot: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub slot: u64,
}

// ────────────────────────────────────────────────────────────────────────────
// ERRORS
// 6000–6099  account / authority
// 6100–6199  flow / timing
// 6200–6299  balance
// 6300–6399  config / admin
// ────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum PrivacyError {
    // 6000
    #[msg("Signer is not the admin multisig")]
    InvalidAdminAuthority,

    #[msg("Stealth account has not been delegated to the TEE")]
    NotDelegated,

    #[msg("Stealth account is already delegated to the TEE")]
    AlreadyDelegated,

    #[msg("User vault owner does not match the stealth account owner")]
    OwnerMismatch,

    // 6100
    #[msg("Protocol is paused — deposits and withdrawals are temporarily disabled")]
    ProtocolPaused,

    #[msg("Flush attempted before the minimum delay has elapsed since deposit")]
    FlushTooEarly,

    // 6200
    #[msg("Flush amount exceeds the stealth account deposited balance")]
    InsufficientStealthBalance,

    #[msg("Withdrawal amount exceeds available vault balance")]
    InsufficientVaultBalance,

    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,

    // 6300
    #[msg("Minimum flush delay cannot be negative")]
    InvalidFlushDelay,
}