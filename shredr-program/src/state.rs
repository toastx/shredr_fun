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
    /// Unused: the PDA derives from the burner alone. Kept for layout stability.
    pub salt: [u8; 32],
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
