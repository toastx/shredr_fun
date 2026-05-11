//! Program-wide constants for the SHREDR program.
//!
//! Includes the canonical program address, PDA seed prefixes, and
//! environment-specific configuration.
//!
//! **NOTE**: Values here must remain consistent with the canonical client-side
//! constants in [`src/lib/constants.ts`](../../../src/lib/constants.ts). The
//! TypeScript file is the source of truth — update it first, then mirror here.

use pinocchio::Address;

/// The program's own address, derived from the declared ID in lib.rs.
pub const PROGRAM_ADDRESS: Address = Address::new_from_array(crate::ID);

/// PDA seed prefixes used for deterministic account derivation.
///
/// Mirrors `SEEDS` in [`src/lib/ShredrProgram.ts`].
pub mod seeds {
    /// Seed for the global program config PDA (reserved for future use).
    pub const PROGRAM_CONFIG: &[u8] = b"shredr_program_config";
    /// Seed for stealth account PDAs: `[STEALTH_ADDRESS, burner_pubkey, salt]`.
    pub const STEALTH_ADDRESS: &[u8] = b"shredr_stealth_address";
    /// Seed for user address PDAs (reserved for future use).
    pub const USER_ADDRESS: &[u8] = b"shredr_user_address";
}

// ============ SHREDR DENOMINATIONS ============
// Mirrors `NORMALIZED_DENOMINATIONS_SOL` / `DEFAULT_DENOMINATION_SOL` in
// `src/lib/constants.ts`.

/// Lamports per SOL.
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Allowed normalized denominations (in lamports) for amount-correlation
/// resistance. Mirrors `NORMALIZED_DENOMINATIONS_SOL = [1, 10, 100, 1000]` SOL.
pub const NORMALIZED_DENOMINATIONS_LAMPORTS: [u64; 4] = [
    1 * LAMPORTS_PER_SOL,
    10 * LAMPORTS_PER_SOL,
    100 * LAMPORTS_PER_SOL,
    1_000 * LAMPORTS_PER_SOL,
];

/// Default user-preferred denomination (in lamports). Mirrors
/// `DEFAULT_DENOMINATION_SOL = 1` SOL.
pub const DEFAULT_DENOMINATION_LAMPORTS: u64 = 1 * LAMPORTS_PER_SOL;

// ============ COMMIT DELAY WINDOW ============
// Mirrors `COMMIT_DELAY_MIN_SECS` / `COMMIT_DELAY_MAX_SECS` in
// `src/lib/constants.ts`.

/// Minimum commit-delay window (seconds): 6 hours.
pub const COMMIT_DELAY_MIN_SECS: i64 = 6 * 60 * 60;
/// Maximum commit-delay window (seconds): 48 hours.
pub const COMMIT_DELAY_MAX_SECS: i64 = 48 * 60 * 60;

// ============ FIXED SALT ============

/// Fixed salt used when deriving stealth/main PDAs from a burner pubkey.
/// Mirrors `SHREDR_FIXED_SALT` (all-zero 32 bytes) in `src/lib/constants.ts`.
pub const SHREDR_FIXED_SALT: [u8; 32] = [0u8; 32];

// ============ MAGICBLOCK / ACL PROGRAM IDS ============
// Mirrors `MAGIC_BLOCK_PROGRAM_ID`, `MAGIC_CONTEXT`, `PERMISSION_PROGRAM_ID`
// in `src/lib/constants.ts`. Stored as base58 strings for documentation;
// runtime accounts are passed in via `AccountView`s.

/// MagicBlock delegation program ID (base layer).
/// Base58: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSS`.
pub const MAGIC_BLOCK_PROGRAM_ID_B58: &str = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSS";

/// MagicBlock context account (singleton, static).
/// Base58: `MagicContext1111111111111111111111111111111`.
pub const MAGIC_CONTEXT_B58: &str = "MagicContext1111111111111111111111111111111";

/// ACL Permission program ID (used by InitializeAndDelegate).
/// Base58: `EPHpaA1tt7nJpEgAjRwkPx5tWHiV6cfKZjPPDDZxFKa9`.
pub const PERMISSION_PROGRAM_ID_B58: &str = "EPHpaA1tt7nJpEgAjRwkPx5tWHiV6cfKZjPPDDZxFKa9";

// ============ TEE VALIDATOR ============

/// TEE validator pubkey for **mainnet** MagicBlock delegation.
///
/// **WARNING**: This is hardcoded for mainnet only. For devnet/testnet deployments,
/// this value should be overridden. A future improvement is to store this in a
/// `ProgramConfig` PDA so it can be set at runtime per environment.
pub const TEE_VALIDATOR_MAINNET: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
