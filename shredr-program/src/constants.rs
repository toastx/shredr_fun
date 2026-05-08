//! Program-wide constants for the SHREDR program.
//!
//! Includes the canonical program address, PDA seed prefixes, and
//! environment-specific configuration.

use pinocchio::Address;

/// The program's own address, derived from the declared ID in lib.rs.
pub const PROGRAM_ADDRESS: Address = Address::new_from_array(crate::ID);

/// PDA seed prefixes used for deterministic account derivation.
pub mod seeds {
    /// Seed for the global program config PDA (reserved for future use).
    pub const PROGRAM_CONFIG: &[u8] = b"shredr_program_config";
    /// Seed for stealth account PDAs: `[STEALTH_ADDRESS, burner_pubkey, salt]`.
    pub const STEALTH_ADDRESS: &[u8] = b"shredr_stealth_address";
    /// Seed for user address PDAs (reserved for future use).
    pub const USER_ADDRESS: &[u8] = b"shredr_user_address";
}

/// TEE validator pubkey for **mainnet** MagicBlock delegation.
///
/// **WARNING**: This is hardcoded for mainnet only. For devnet/testnet deployments,
/// this value should be overridden. A future improvement is to store this in a
/// `ProgramConfig` PDA so it can be set at runtime per environment.
pub const TEE_VALIDATOR_MAINNET: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";