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
    /// Source and destination stealth accounts are the same account.
    SelfTransferNotAllowed = 6011,
    /// The undelegation buffer is not the delegation program's buffer for this account.
    InvalidBufferAccount = 6012,
    /// The stealth account still holds a deposit and cannot be closed.
    AccountNotEmpty = 6013,
    /// Rent sysvar is unavailable.
    RentUnavailable = 6014,
    /// The build has no KYT attestation authority configured, so no deposit can
    /// be cleared. Deliberate: an unconfigured gate must refuse, not wave through.
    KytAuthorityUnset = 6015,
    /// No `Ed25519SigVerify` instruction in this transaction carried a KYT
    /// attestation for this deposit.
    KytAttestationMissing = 6016,
    /// The ed25519 instruction or the message it covers is not shaped like an
    /// attestation: wrong length, wrong magic, wrong version, several signatures,
    /// or offsets pointing outside the instruction.
    KytAttestationMalformed = 6017,
    /// The signature was verified, but against a key that is not the configured
    /// KYT attestation authority.
    KytUnknownAuthority = 6018,
    /// The attestation is bound to a different subject — burner, or note
    /// commitment for a pool deposit.
    KytAttestationBurnerMismatch = 6019,
    /// The deposit is larger than the amount the relayer cleared.
    KytAttestationAmountExceeded = 6020,
    /// The attestation is past its expiry.
    KytAttestationExpired = 6021,
    /// The relayer screened the depositor and refused it.
    KytScreeningRejected = 6022,
    /// The attestation cleared a different wallet than the one depositing.
    /// Only checkable where the depositor signs — see `kyt`.
    KytAttestationDepositorMismatch = 6035,
    /// The requested denomination has no pool. See `constants::DENOMINATIONS`.
    InvalidDenomination = 6023,
    /// The vault and ledger passed together belong to different pools.
    PoolMismatch = 6024,
    /// No room for another commitment before the next epoch turn.
    PoolPendingFull = 6025,
    /// The pool has taken every deposit it can hold.
    PoolCommitmentsFull = 6026,
    /// No room for another payout until the keeper settles.
    PoolPayoutQueueFull = 6027,
    /// No commitment in the ledger matches this note.
    PoolUnknownNote = 6028,
    /// This note has already been spent.
    PoolNoteAlreadySpent = 6029,
    /// The ledger is delegated when it must not be, or the reverse.
    PoolLedgerDelegationState = 6030,
    /// The epoch floor has not elapsed yet.
    PoolEpochTooSoon = 6031,
    /// A destination account does not match the payout it was passed for.
    PoolDestinationMismatch = 6032,
    /// Paying this out would take more from the vault than was ever put in.
    PoolInsufficientBacking = 6033,
    /// The ledger's epoch does not match the vault's.
    PoolEpochMismatch = 6034,
}

impl From<ShredrError> for ProgramError {
    fn from(e: ShredrError) -> ProgramError {
        ProgramError::Custom(e as u32)
    }
}
