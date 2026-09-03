//! Shielded note derivation.
//!
//! A note is one 32-byte secret, picked by the client and never sent to the base
//! layer. Two domain-separated hashes come off it:
//!
//! ```text
//! commitment = sha256("SHREDR_NOTE_V1" || secret)   published at deposit
//! nullifier  = sha256("SHREDR_NULL_V1" || secret)   published at spend
//! ```
//!
//! That is the whole scheme. There is no Merkle tree and no proof: membership is
//! a scan of the ledger's commitment list, and the *spend* — the only step that
//! reveals the secret — happens inside the ephemeral rollup's enclave.
//!
//! ## What the separation buys, and what it does not
//!
//! Commitment and nullifier are both images of the same secret under different
//! domain tags, so given one you cannot compute the other. An observer holding
//! the base layer's full history sees a list of commitments and a list of
//! nullifiers and cannot pair them up. That is the pool's privacy claim, and it
//! holds against anyone who never sees a secret.
//!
//! It does not hold against anyone who does. The spend instruction carries the
//! secret in its data, so every party that handles that transaction before it
//! reaches the enclave — the rollup fee payer above all — can hash it twice and
//! link the deposit to the withdrawal itself. That is the cost of having no
//! proof system, and it is an operational requirement rather than a bug to fix
//! in this file: see `docs/concepts/shielded-pool.md`.
//!
//! The tags are versioned. Changing either one changes every note, so a new
//! version means a new pool, not a migration.

/// Domain tag for the deposit commitment.
pub const COMMITMENT_TAG: &[u8] = b"SHREDR_NOTE_V1";

/// Domain tag for the spend nullifier.
pub const NULLIFIER_TAG: &[u8] = b"SHREDR_NULL_V1";

/// The commitment published when a note is deposited.
pub fn commitment(secret: &[u8; 32]) -> [u8; 32] {
    sha256(&[COMMITMENT_TAG, secret])
}

/// The nullifier published when a note is spent.
pub fn nullifier(secret: &[u8; 32]) -> [u8; 32] {
    sha256(&[NULLIFIER_TAG, secret])
}

/// sha256 over the concatenation of `parts`, via the runtime syscall.
///
/// The syscall takes a pointer to the slice-of-slices itself, so it hashes the
/// concatenation without the program allocating a joined buffer — which matters
/// in a `no_std` program with a bump allocator.
#[cfg(target_os = "solana")]
fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = [0u8; 32];
    // SAFETY: `parts` is a live slice of live slices, and `digest` is 32 bytes,
    // which is what the syscall writes.
    unsafe {
        pinocchio::syscalls::sol_sha256(
            parts.as_ptr() as *const u8,
            parts.len() as u64,
            digest.as_mut_ptr(),
        );
    }
    digest
}

/// See [`sha256`] — host build, so `cargo test` can derive notes the same way
/// the on-chain build does. `sha2` is a target-scoped dependency and is not
/// linked into the SBF binary.
#[cfg(not(target_os = "solana"))]
fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}
