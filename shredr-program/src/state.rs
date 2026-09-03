//! The program's only account type. Deposit and exit PDAs are both
//! `StealthAccount`s — the role distinction is a client convention and is
//! deliberately not recorded here.

use pinocchio::Address;

/// Written at the start of every stealth PDA: `[discriminator][StealthAccount]`.
pub const STEALTH_ACCOUNT_DISCRIMINATOR: [u8; 8] = [0x53, 0x48, 0x52, 0x45, 0x44, 0x52, 0x53, 0x41]; // "SHREDRSA"

pub const STEALTH_ACCOUNT_SIZE: usize = core::mem::size_of::<StealthAccount>();

/// The layout is a wire format shared with the TypeScript client — see
/// `stealth_account_layout_is_stable` in the tests before reordering.
#[repr(C)]
pub struct StealthAccount {
    /// The burner pubkey that owns this account.
    pub owner: Address,
    /// Opaque 32-byte receipt commitment, supplied by the client and never read
    /// by the program. Occupies what used to be the unused `salt` slot, so the
    /// layout, size and rent are unchanged.
    ///
    /// Every account carries one — a field only some clients populate would
    /// itself identify those clients. The program does not care what the bytes
    /// mean and must never branch on them.
    pub receipt_commitment: [u8; 32],
    /// Tracked separately from `lamports`, which also holds the rent.
    pub deposited_amount: u64,
    pub deposit_timestamp: i64,
    pub delegated: bool,
    pub bump: u8,
    /// Which leg of a cycle this PDA is: 0 unset, 1 deposit, 2 exit. Occupies
    /// what was trailing padding, so the account size is unchanged and existing
    /// accounts read back as `unset`.
    ///
    /// A **recovery hint only** — never gate authorization on it. Ownership,
    /// PDA derivation and delegation state already authorize every instruction;
    /// branching on this would add attack surface for nothing.
    pub role: u8,
}

/// `StealthAccount::role` values.
pub mod role {
    pub const UNSET: u8 = 0;
    pub const DEPOSIT: u8 = 1;
    pub const EXIT: u8 = 2;

    pub fn is_valid(value: u8) -> bool {
        matches!(value, UNSET | DEPOSIT | EXIT)
    }
}

// ─────────────────────────────────────────────
// Shielded pool
//
// Three account kinds, and which layer each lives on is the design:
//
//   PoolVault      — base layer, always. Every lamport, plus the Merkle tree's
//                    frontier. Never delegated, so a deposit always lands.
//   PoolLedger     — alternates. Delegated to the rollup while notes are spent,
//                    undelegated while an epoch settles.
//   NullifierRecord— base layer. One tiny PDA per spent note. Its *existence* is
//                    the double-spend check.
//
// The split exists because a delegated account is not writable on the base
// layer. One account for funds and spends would mean deposits failing whenever
// the pool was busy, which is most of the time.
//
// Nothing here grows with the number of notes. That is deliberate: an array of
// commitments would cap deposits at whatever fits in an account, and a pool that
// stops taking deposits stops growing the only thing that makes it private.
// ─────────────────────────────────────────────

/// Written at the start of a pool vault: `[discriminator][PoolVault]`.
pub const POOL_VAULT_DISCRIMINATOR: [u8; 8] = *b"SHREDRPV";

/// Written at the start of a pool ledger: `[discriminator][PoolLedger]`.
pub const POOL_LEDGER_DISCRIMINATOR: [u8; 8] = *b"SHREDRPL";

/// The entire contents of a nullifier record. It carries no state — the account
/// existing at `[NULLIFIER, nullifier]` is the whole fact being recorded.
pub const NULLIFIER_RECORD_DISCRIMINATOR: [u8; 8] = *b"SHREDRNL";

/// Bytes a nullifier record occupies. Just the discriminator.
pub const NULLIFIER_RECORD_LEN: usize = 8;

/// Roots a spender may prove against.
///
/// A path is computed against the tree as it stood when the client built it, and
/// every deposit since then has moved the root. Accepting only the current root
/// would make a spend race every deposit in flight. The ring is how long a proof
/// stays valid: `ROOT_HISTORY_CAP` epochs, since the root advances once per turn.
pub const ROOT_HISTORY_CAP: usize = 32;

/// Payouts that may be queued between epoch turns.
///
/// Settling credits this many accounts in one base-layer transaction, so the
/// real ceiling is the transaction's account limit and its compute budget. A
/// full queue makes further spends fail until the keeper settles — which is a
/// liveness bound on the keeper, not a bound on the pool.
pub const PAYOUT_QUEUE_CAP: usize = 32;

/// One authorized withdrawal, written inside the rollup and paid out on the base
/// layer.
///
/// The nullifier rides along because settling needs it: it derives the record
/// PDA whose existence stops the note being spent again in a later epoch. It is
/// deliberately *not* linkable to the commitment it came from — see
/// [`crate::note`].
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Payout {
    pub nullifier: [u8; 32],
    pub destination: [u8; 32],
}

/// Base-layer half of a pool. Holds the lamports and the commitment tree.
///
/// `lamports >= rent_minimum + (total_deposited - total_settled)` is the
/// invariant every instruction preserves. Greater-or-equal, not equal: anyone can
/// send lamports to a derivable address, and each deposit also leaves behind the
/// rent for the nullifier record its note will eventually need. The surplus is
/// never counted as backing, so a stranger cannot inflate the pool by donating.
#[repr(C)]
pub struct PoolVault {
    /// Lamports per note. Fixed at creation, and the reason amounts do not link
    /// deposits to withdrawals.
    pub denomination: u64,
    pub total_deposited: u64,
    pub total_settled: u64,
    /// Incremented by each epoch turn. Mirrored into the ledger, so a settle
    /// against a stale ledger is detectable.
    pub epoch: u64,
    /// When the last epoch turned. The floor under the next turn, which is what
    /// forces payouts to batch.
    pub last_epoch_at: i64,
    /// Leaves inserted so far, and the index the next one takes.
    pub next_leaf_index: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
    /// Root after the most recent insert. Copied into the ledger's ring on each
    /// epoch turn, which is what makes a deposit spendable.
    pub root: [u8; 32],
    /// The tree's frontier: one pending left sibling per level. Fixed size no
    /// matter how many notes the pool holds.
    pub filled_subtrees: [[u8; 32]; crate::merkle::DEPTH],
}

pub const POOL_VAULT_SIZE: usize = core::mem::size_of::<PoolVault>();

/// The shielded half. Delegated to the rollup while notes are spent.
///
/// Committed back to the base layer verbatim, so everything here is public
/// eventually. That is fine: roots are public already, and a payout's nullifier
/// cannot be paired with any commitment without the secret behind it.
#[repr(C)]
pub struct PoolLedger {
    pub denomination: u64,
    pub epoch: u64,
    /// How many of `roots` are populated, saturating at [`ROOT_HISTORY_CAP`].
    pub root_count: u32,
    /// Next write position in the ring.
    pub root_cursor: u32,
    pub payout_count: u32,
    pub bump: u8,
    /// True between `DelegatePoolLedger` and the undelegation callback. Spends
    /// require it set, epoch turns require it clear — one flag keeping the rollup
    /// and base-layer instructions from running in the wrong place.
    pub delegated: bool,
    pub _padding: [u8; 2],
    /// Recent tree roots a spender may prove against.
    pub roots: [[u8; 32]; ROOT_HISTORY_CAP],
    /// Payouts awaiting settlement. Their nullifiers double as this epoch's
    /// spent set, which is why there is no separate list: a note spent twice
    /// inside one epoch is caught here, and one spent across epochs is caught by
    /// its record PDA already existing.
    pub payouts: [Payout; PAYOUT_QUEUE_CAP],
}

pub const POOL_LEDGER_SIZE: usize = core::mem::size_of::<PoolLedger>();
