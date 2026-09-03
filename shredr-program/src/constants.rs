//! Program-wide constants.
//!
//! Values shared with the client mirror `src/lib/constants.ts`, which is the
//! source of truth — update it first.

use pinocchio::Address;

/// The program's own address, derived from the declared ID in lib.rs.
pub const PROGRAM_ADDRESS: Address = Address::new_from_array(crate::ID);

/// PDA seed prefixes. Mirrors `SEEDS` in `src/lib/ShredrProgram.ts`.
pub mod seeds {
    /// Stealth account PDAs: `[STEALTH_ADDRESS, burner_pubkey]`. Shared by the
    /// deposit and exit PDAs of the pre-pool transfer path.
    pub const STEALTH_ADDRESS: &[u8] = b"shredr_stealth_address";

    /// Pool vault PDAs: `[POOL_VAULT, denomination_le]`. One per denomination,
    /// so the address is derivable from the amount alone and there is exactly
    /// one canonical pool for each.
    pub const POOL_VAULT: &[u8] = b"shredr_pool_vault";

    /// Pool ledger PDAs: `[POOL_LEDGER, denomination_le]`.
    pub const POOL_LEDGER: &[u8] = b"shredr_pool_ledger";

    /// Nullifier record PDAs: `[NULLIFIER, nullifier]`. Keyed by the nullifier
    /// itself, so creating the account *is* the double-spend check and there is
    /// no set to search or to outgrow.
    pub const NULLIFIER: &[u8] = b"shredr_nullifier";
}

/// Lamport denominations a pool may be created for.
///
/// Enforced on-chain rather than left to the client. A pool for an arbitrary
/// amount would be a pool of one, and every odd denomination someone creates
/// splits the anonymity set of the ones that matter. Mirrors
/// `NORMALIZED_DENOMINATIONS_SOL` in `src/lib/constants.ts`.
pub const DENOMINATIONS: [u64; 4] = [
    1_000_000_000,
    10_000_000_000,
    100_000_000_000,
    1_000_000_000_000,
];

/// Whether a denomination has a pool.
pub fn is_valid_denomination(lamports: u64) -> bool {
    DENOMINATIONS.contains(&lamports)
}

/// Shortest gap between epoch turns, in seconds.
///
/// This is a privacy floor, not a rate limit. Settling is a base-layer event
/// that credits a destination; if anyone could turn the epoch on demand, every
/// payout would arrive alone in its own batch and the timing would tie it back
/// to the spend that queued it. The floor forces payouts to leave in groups.
///
/// It is a *minimum* only. The keeper is expected to wait a randomized interval
/// above it — a fixed cadence is itself a fingerprint, and the program has no
/// cheap source of randomness to impose one. Longer means bigger batches, better
/// privacy, and slower withdrawals; that trade is the operator's to make.
pub const MIN_EPOCH_SECS: i64 = 60;

// MagicBlock and ACL program addresses are not redeclared here — use the typed
// consts from `ephemeral_rollups_pinocchio` (`DELEGATION_PROGRAM_ID`,
// `MAGIC_PROGRAM_ID`, `MAGIC_CONTEXT_ID`, `acl::consts::PERMISSION_PROGRAM_ID`).

// Amount normalization and the commit-delay window are client-side policy and
// live only in `src/lib/constants.ts`. The program enforces neither: a deposit
// flows to a single exit PDA, so the amount arriving on the base layer equals the
// amount that left it, and an observer watching both legs links them by amount
// alone unless the client normalizes sizes and spaces the legs in time.

/// Nothing-up-my-sleeve placeholder authority: `sha256("shredr devnet kyt
/// placeholder")`, base58-encoded. No one holds a secret key for it, which is
/// the point — it is non-zero so the gate is *exercisable*, and unsignable so a
/// devnet build that forgets to configure a real relayer still clears nothing.
pub const KYT_AUTHORITY_PLACEHOLDER: &str = "BkGMGEoFKWUZgawwcp3uLt51DYCqF3prmQ6W5mutKvJL";

/// Ed25519 public key of the KYT attestation authority — the compliance relayer
/// whose signature every base-layer deposit has to carry. See `crate::kyt`.
///
/// Set at build time, so the key is part of the deployed binary and rotating it
/// is a redeploy rather than a runtime toggle:
///
/// ```sh
/// SHREDR_KYT_AUTHORITY=<base58 pubkey> cargo build-sbf --features mainnet
/// ```
///
/// # Unset
///
/// Under `mainnet` the fallback is the all-zero address, which
/// `verify_deposit_attestation` refuses outright with `KytAuthorityUnset`. A
/// mainnet build that forgets the key therefore takes no deposits at all, which
/// is the only acceptable way for a compliance gate to be missing.
///
/// Elsewhere it falls back to [`KYT_AUTHORITY_PLACEHOLDER`], so the test suite
/// has a real key shape to build attestations against. That is not a weaker
/// gate — nobody can sign for the placeholder either, so the ed25519 precompile
/// rejects the transaction before the program runs. It only moves the failure
/// from "no authority" to "bad signature".
#[cfg(feature = "mainnet")]
pub const KYT_ATTESTATION_AUTHORITY: Address =
    Address::from_str_const(match option_env!("SHREDR_KYT_AUTHORITY") {
        Some(key) => key,
        None => "11111111111111111111111111111111",
    });

/// See [`KYT_ATTESTATION_AUTHORITY`] — devnet/default variant.
#[cfg(not(feature = "mainnet"))]
pub const KYT_ATTESTATION_AUTHORITY: Address =
    Address::from_str_const(match option_env!("SHREDR_KYT_AUTHORITY") {
        Some(key) => key,
        None => KYT_AUTHORITY_PLACEHOLDER,
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
