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
    /// Seed for stealth account PDAs: `[STEALTH_ADDRESS, burner_pubkey]`.
    ///
    /// The only seed prefix the program uses. Deposit and exit PDAs share it —
    /// the program does not distinguish the two roles.
    pub const STEALTH_ADDRESS: &[u8] = b"shredr_stealth_address";
}

// ============ POLICY: NOT ENFORCED ON-CHAIN ============
//
// Amount normalization (`NORMALIZED_DENOMINATIONS_SOL`) and the commit-delay
// window (`COMMIT_DELAY_MIN_SECS` / `COMMIT_DELAY_MAX_SECS`) live in
// `src/lib/constants.ts` and are enforced by the client alone. They are
// deliberately absent here: mirroring them as unused constants implied an
// on-chain guarantee the program never made.
//
// The consequence is worth stating plainly. A deposit flows to a single exit
// PDA rather than through a shared aggregation account, so the amount arriving
// on the base layer equals the amount that left it. An observer watching both
// legs links them by amount alone unless the client normalizes deposit sizes
// and spaces the legs apart in time.

// ============ MAGICBLOCK / ACL PROGRAM IDS ============
// Mirrors `MAGIC_BLOCK_PROGRAM_ID`, `MAGIC_CONTEXT`, `PERMISSION_PROGRAM_ID`
// in `src/lib/constants.ts`. Stored as base58 strings for documentation;
// runtime accounts are passed in via `AccountView`s.

/// MagicBlock delegation program ID (base layer).
/// Base58: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`.
/// Mirrors `ephemeral_rollups_pinocchio::consts::DELEGATION_PROGRAM_ID`.
pub const MAGIC_BLOCK_PROGRAM_ID_B58: &str = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

/// MagicBlock magic program ID — the rollup-side program that handles
/// ScheduleCommit / ScheduleCommitAndUndelegate, and therefore the CPI target
/// of `CommitStealth` / `CommitAndUndelegateStealth` (the `magic_program`
/// account). Distinct from the base-layer delegation program above.
/// Base58: `Magic11111111111111111111111111111111111111`.
/// Mirrors `ephemeral_rollups_pinocchio::consts::MAGIC_PROGRAM_ID`.
pub const MAGIC_PROGRAM_ID_B58: &str = "Magic11111111111111111111111111111111111111";

/// MagicBlock context account (singleton, static).
/// Base58: `MagicContext1111111111111111111111111111111`.
pub const MAGIC_CONTEXT_B58: &str = "MagicContext1111111111111111111111111111111";

/// ACL Permission program ID (used by InitializeAndDelegate).
/// Base58: `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`.
/// Mirrors `ephemeral_rollups_pinocchio::acl::consts::PERMISSION_PROGRAM_ID`,
/// which is the address `InitializeAndDelegate` actually CPIs into.
pub const PERMISSION_PROGRAM_ID_B58: &str = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";

// ============ TEE VALIDATOR ============

/// TEE validator identity for **mainnet** MagicBlock delegation.
pub const TEE_VALIDATOR_MAINNET: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";

/// The TEE validator to pin when delegating, selected at build time via Cargo
/// features so the same source can target either network:
///
/// - `mainnet` feature → pin [`TEE_VALIDATOR_MAINNET`].
/// - otherwise (default `devnet`) → `None`, which lets the MagicBlock delegation
///   program fall back to the network's default validator. This avoids hardcoding
///   a devnet validator identity that would be invalid on-chain there.
///
/// Build for mainnet with `cargo build-sbf --features mainnet`.
///
/// # Co-residency
///
/// `PrivateTransfer` needs the deposit PDA and the exit PDA program-owned and
/// writable **in the same rollup at the same time**, so both must be delegated to
/// the same validator. Returning `None` delegates to whatever the network picks,
/// which is only safe while that choice is stable — if two PDAs in one cycle land
/// on different ephemeral rollups, the transfer between them is simply not
/// executable and the funds sit in the deposit PDA until it is undelegated.
///
/// This is on the critical path of every withdrawal, so on devnet either confirm
/// the network default is a single validator or pin one here.
#[cfg(feature = "mainnet")]
pub fn tee_validator() -> Option<Address> {
    Some(Address::from_str_const(TEE_VALIDATOR_MAINNET))
}

/// See [`tee_validator`] — devnet/default variant (no pinned validator).
#[cfg(not(feature = "mainnet"))]
pub fn tee_validator() -> Option<Address> {
    None
}
