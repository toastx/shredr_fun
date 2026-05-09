//! Domain-specific error types for the SHREDR program.
//!
//! These wrap into `ProgramError::Custom(u32)` using a base offset of 6000
//! to avoid conflicts with built-in Solana error codes.

use pinocchio::error::ProgramError;

/// SHREDR-specific errors starting at offset 6000.
#[repr(u32)]
pub enum ShredrError {
    /// The stealth account PDA does not match the expected derivation.
    InvalidStealthPDA = 6000,
    /// The account is not owned by the SHREDR program.
    InvalidProgramOwner = 6001,
    /// The account data is too small to contain a StealthAccount.
    AccountDataTooSmall = 6002,
    /// The account discriminator does not match the expected value.
    InvalidDiscriminator = 6003,
    /// The stealth account is already delegated.
    AlreadyDelegated = 6004,
    /// The stealth account is not delegated when it should be.
    NotDelegated = 6005,
    /// The destination account is not owned by the SHREDR program.
    InvalidDestinationOwner = 6006,
    /// Signer is required but was not provided.
    MissingSigner = 6007,
    /// Clock sysvar is unavailable.
    ClockUnavailable = 6008,
    /// Deposited amount would desync from actual lamports.
    BalanceInvariantViolation = 6009,
    /// Attempted to initialize an account that already exists.
    AccountAlreadyInitialized = 6010,
}

impl From<ShredrError> for ProgramError {
    fn from(e: ShredrError) -> ProgramError {
        ProgramError::Custom(e as u32)
    }
}
