//! Program-wide constants.
//!
//! Values shared with the client mirror `src/lib/constants.ts`, which is the
//! source of truth — update it first.

use pinocchio::Address;

/// The program's own address, derived from the declared ID in lib.rs.
pub const PROGRAM_ADDRESS: Address = Address::new_from_array(crate::ID);

/// PDA seed prefixes. Mirrors `SEEDS` in `src/lib/ShredrProgram.ts`.
pub mod seeds {
    /// Stealth account PDAs: `[STEALTH_ADDRESS, burner_pubkey]`. The only prefix
    /// the program uses; deposit and exit PDAs share it.
    pub const STEALTH_ADDRESS: &[u8] = b"shredr_stealth_address";
}

// MagicBlock and ACL program addresses are not redeclared here — use the typed
// consts from `ephemeral_rollups_pinocchio` (`DELEGATION_PROGRAM_ID`,
// `MAGIC_PROGRAM_ID`, `MAGIC_CONTEXT_ID`, `acl::consts::PERMISSION_PROGRAM_ID`).

// Amount normalization and the commit-delay window are client-side policy and
// live only in `src/lib/constants.ts`. The program enforces neither: a deposit
// flows to a single exit PDA, so the amount arriving on the base layer equals the
// amount that left it, and an observer watching both legs links them by amount
// alone unless the client normalizes sizes and spaces the legs in time.

/// Ed25519 public key of the KYT attestation authority — the compliance relayer
/// whose signature every base-layer deposit has to carry. See `crate::kyt`.
///
/// Set at build time so the key is part of the deployed binary and rotating it
/// is a redeploy, not a runtime toggle:
///
/// ```sh
/// SHREDR_KYT_AUTHORITY=<base58 pubkey> cargo build-sbf
/// ```
///
/// The default is the all-zero address, which no one can sign for. That is the
/// intended failure mode for an unconfigured build: `verify_deposit_attestation`
/// returns `KytAuthorityUnset` and every deposit is refused. A build that
/// silently accepted deposits without a gate would be worse than one that takes
/// none at all.
pub const KYT_ATTESTATION_AUTHORITY: Address =
    Address::from_str_const(match option_env!("SHREDR_KYT_AUTHORITY") {
        Some(key) => key,
        None => "11111111111111111111111111111111",
    });

/// TEE validator identity for **mainnet** MagicBlock delegation.
pub const TEE_VALIDATOR_MAINNET: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";

/// The validator to pin when delegating, chosen at build time: pinned on
/// `mainnet`, `None` (network default) otherwise. Build with
/// `cargo build-sbf --features mainnet`.
///
/// # Co-residency
///
/// `PrivateTransfer` needs both PDAs writable in the *same* rollup, so both must
/// be delegated to the same validator. `None` defers that to the network — safe
/// only while its choice is stable. Two PDAs on different rollups cannot transfer
/// between them, and this is on every withdrawal's critical path.
#[cfg(feature = "mainnet")]
pub fn tee_validator() -> Option<Address> {
    Some(Address::from_str_const(TEE_VALIDATOR_MAINNET))
}

/// See [`tee_validator`] — devnet/default variant (no pinned validator).
#[cfg(not(feature = "mainnet"))]
pub fn tee_validator() -> Option<Address> {
    None
}
