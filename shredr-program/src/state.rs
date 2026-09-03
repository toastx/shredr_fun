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
// Two accounts per denomination, and which layer each one lives on is the whole
// design:
//
//   PoolVault  — base layer, always. Holds every lamport in the pool and the
//                commitments waiting to be ingested. Never delegated, so a
//                deposit always has somewhere to land.
//   PoolLedger — alternates. Delegated to the rollup while notes are being
//                spent, undelegated on the base layer while an epoch is settled
//                and new commitments are folded in.
//
// The split exists because a delegated account is not writable on the base
// layer. Putting the funds and the spend ledger in one account would mean
// deposits failing whenever the pool was busy.
// ─────────────────────────────────────────────

/// Written at the start of a pool vault: `[discriminator][PoolVault]`.
pub const POOL_VAULT_DISCRIMINATOR: [u8; 8] = *b"SHREDRPV";

/// Written at the start of a pool ledger: `[discriminator][PoolLedger]`.
pub const POOL_LEDGER_DISCRIMINATOR: [u8; 8] = *b"SHREDRPL";

/// Commitments a vault can hold between epoch turns. A deposit fails once this
/// is full, so it bounds how long the keeper may sleep, not how big the pool is.
pub const PENDING_COMMITMENT_CAP: usize = 64;

/// The anonymity set. Every unspent note in a pool hides behind every other, so
/// this is the single number that decides how private the pool actually is.
//
// ponytail: fixed capacity, and it is a lifetime total rather than a rolling
// window — the pool accepts 512 deposits ever, then refuses. The upgrade path is
// pool rotation: `InitializePool` is keyed by denomination, so a second
// generation would key by `(denomination, generation)` and the client would
// deposit into the newest. Do that before raising this number; a 10x larger
// account is 2.4 SOL of rent and a linear scan 10x longer.
pub const POOL_COMMITMENT_CAP: usize = 512;

/// Spent notes. Matches [`POOL_COMMITMENT_CAP`] because every commitment can be
/// spent exactly once.
pub const POOL_NULLIFIER_CAP: usize = 512;

/// Payouts that may be queued between epoch turns.
///
/// Settling is one base-layer transaction that credits this many accounts, so
/// the ceiling is really the transaction's account limit and its compute budget,
/// not storage. A full queue makes further spends fail until the keeper settles.
pub const PAYOUT_QUEUE_CAP: usize = 32;

/// One authorized withdrawal, written inside the rollup and paid out on the base
/// layer.
///
/// The nullifier rides along so that settling can be reasoned about from the
/// queue alone. It is deliberately *not* linkable to the commitment it came
/// from — see [`crate::note`].
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Payout {
    pub nullifier: [u8; 32],
    pub destination: [u8; 32],
}

/// Base-layer half of a pool. Holds the lamports.
///
/// `lamports == rent_minimum + (total_deposited - total_settled)` is the
/// invariant every instruction here preserves, and the reason both counters are
/// tracked rather than inferred from the balance: anyone can send lamports to a
/// derivable address, and a balance-derived total would let them fake backing.
#[repr(C)]
pub struct PoolVault {
    /// Lamports per note. Fixed at creation, and the reason amounts do not link
    /// deposits to withdrawals.
    pub denomination: u64,
    pub total_deposited: u64,
    pub total_settled: u64,
    /// Incremented by each epoch turn. Mirrored into the ledger so a settle
    /// against a stale ledger is detectable.
    pub epoch: u64,
    /// When the last epoch turned. The floor under the next turn, which is what
    /// forces payouts to batch.
    pub last_epoch_at: i64,
    pub pending_count: u32,
    pub bump: u8,
    pub _padding: [u8; 3],
    /// Commitments from deposits since the last ingest.
    pub pending: [[u8; 32]; PENDING_COMMITMENT_CAP],
}

pub const POOL_VAULT_SIZE: usize = core::mem::size_of::<PoolVault>();

/// The shielded half. Delegated to the rollup while notes are spent.
///
/// Committed back to the base layer verbatim, so everything in here is public
/// eventually. That is fine: commitments and nullifiers are both one-way images
/// of secrets that never leave the client, and neither list can be paired with
/// the other.
#[repr(C)]
pub struct PoolLedger {
    pub denomination: u64,
    pub epoch: u64,
    pub commitment_count: u32,
    pub nullifier_count: u32,
    pub payout_count: u32,
    pub bump: u8,
    /// True between `DelegatePoolLedger` and the undelegation callback. Spends
    /// require it set, epoch turns require it clear — which is how one flag
    /// keeps the rollup and base-layer instructions from running in the wrong
    /// place.
    pub delegated: bool,
    pub _padding: [u8; 2],
    pub commitments: [[u8; 32]; POOL_COMMITMENT_CAP],
    pub nullifiers: [[u8; 32]; POOL_NULLIFIER_CAP],
    pub payouts: [Payout; PAYOUT_QUEUE_CAP],
}

pub const POOL_LEDGER_SIZE: usize = core::mem::size_of::<PoolLedger>();
