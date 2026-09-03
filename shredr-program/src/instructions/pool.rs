//! The shielded pool.
//!
//! One vault per denomination holds every lamport and the commitment tree; one
//! ledger per denomination holds the recent roots and the payout queue. A deposit
//! appends a commitment. A spend, inside the rollup, proves a Merkle path and
//! queues a payout. An epoch turn, on the base layer, pays the queue out and
//! publishes the new root.
//!
//! What the base layer ever sees is a stream of equal-sized deposits, a stream of
//! nullifiers, and batches of equal-sized transfers. Pairing any deposit with any
//! withdrawal requires a note secret, and the only instruction that carries one
//! runs inside the enclave.
//!
//! ## Nothing here is capped by the number of notes
//!
//! The tree's on-chain footprint is `merkle::DEPTH` nodes whatever the pool holds,
//! and spent notes are recorded as one small PDA each rather than in a list. So
//! deposits are bounded by `2^DEPTH` and withdrawals by nothing at all. Storing
//! commitments in an account would have capped both at whatever fit — which is
//! backwards, because a pool's size is exactly what makes it private.
//!
//! ## Instruction set
//!
//! | | Layer | Ledger must be |
//! |---|---|---|
//! | `InitializePool` | base | — (creates it) |
//! | `PoolDeposit` | base | either; touches only the vault |
//! | `PoolSpend` | rollup | delegated |
//! | `AdvanceEpoch` | base | undelegated |
//! | `DelegatePoolLedger` | base | undelegated |
//!
//! Committing and undelegating the ledger reuses `CommitStealth` and
//! `CommitAndUndelegateStealth`, which never looked at the account they were
//! flushing.
//!
//! See `docs/concepts/shielded-pool.md`.

use crate::constants::{
    is_valid_denomination, seeds, tee_validator, MIN_EPOCH_SECS, PROGRAM_ADDRESS,
};
use crate::errors::ShredrError;
use crate::helpers::{
    derive_pool_ledger, derive_pool_vault, get_ledger_mut, get_vault_mut, write_discriminator,
};
use crate::kyt::verify_deposit_attestation;
use crate::merkle;
use crate::note;
use crate::state::{
    Payout, PoolLedger, NULLIFIER_RECORD_DISCRIMINATOR, NULLIFIER_RECORD_LEN, PAYOUT_QUEUE_CAP,
    POOL_LEDGER_DISCRIMINATOR, POOL_LEDGER_SIZE, POOL_VAULT_DISCRIMINATOR, POOL_VAULT_SIZE,
    ROOT_HISTORY_CAP,
};
use crate::{Address, ProgramError, ProgramResult};

use ephemeral_rollups_pinocchio::instruction::delegate_account;
use ephemeral_rollups_pinocchio::types::DelegateConfig;

use pinocchio::cpi::{Seed, Signer};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;
use pinocchio::AccountView;
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

/// Lamports a deposit leaves behind, on top of the denomination, to fund the
/// nullifier record its note will need when it is spent.
///
/// Charging it at deposit rather than at withdrawal keeps every payout exactly
/// one denomination — a payout net of a fee would be a payout of a distinguishing
/// size — and keeps `AdvanceEpoch` free to be run by anyone, since the epoch
/// turner is not out of pocket.
fn nullifier_rent(rent: &Rent) -> Result<u64, ProgramError> {
    rent.try_minimum_balance(NULLIFIER_RECORD_LEN)
}

// ─────────────────────────────────────────────
// InitializePool
// ─────────────────────────────────────────────

/// Create the vault and ledger for one denomination.
///
/// Permissionless. Both addresses derive from the denomination alone, so there is
/// one canonical pool per amount and the only thing a caller gains by running
/// this first is paying the rent for everyone else.
pub struct InitializePool<'a> {
    pub payer: &'a AccountView,
    pub vault: &'a AccountView,
    pub ledger: &'a AccountView,
    pub system_program: &'a AccountView,
    pub denomination: u64,
}

impl InitializePool<'_> {
    pub fn process(self) -> ProgramResult {
        let InitializePool {
            payer,
            vault,
            ledger,
            system_program: _,
            denomination,
        } = self;

        let (expected_vault, vault_bump) = derive_pool_vault(denomination)?;
        let (expected_ledger, ledger_bump) = derive_pool_ledger(denomination)?;

        if vault.address() != &expected_vault || ledger.address() != &expected_ledger {
            return Err(ShredrError::PoolMismatch.into());
        }

        if vault.data_len() > 0 || ledger.data_len() > 0 {
            return Err(ShredrError::AccountAlreadyInitialized.into());
        }

        let denomination_bytes = denomination.to_le_bytes();

        create_pda(
            payer,
            vault,
            &[
                Seed::from(seeds::POOL_VAULT),
                Seed::from(&denomination_bytes),
                Seed::from(core::slice::from_ref(&vault_bump)),
            ],
            (8 + POOL_VAULT_SIZE) as u64,
        )?;

        create_pda(
            payer,
            ledger,
            &[
                Seed::from(seeds::POOL_LEDGER),
                Seed::from(&denomination_bytes),
                Seed::from(core::slice::from_ref(&ledger_bump)),
            ],
            (8 + POOL_LEDGER_SIZE) as u64,
        )?;

        write_discriminator(vault, &POOL_VAULT_DISCRIMINATOR, POOL_VAULT_SIZE)?;
        write_discriminator(ledger, &POOL_LEDGER_DISCRIMINATOR, POOL_LEDGER_SIZE)?;

        let clock =
            Clock::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;

        let empty_root = merkle::empty_root();

        let vault_state = get_vault_mut(vault)?;
        vault_state.denomination = denomination;
        vault_state.total_deposited = 0;
        vault_state.total_settled = 0;
        vault_state.epoch = 0;
        vault_state.last_epoch_at = clock.unix_timestamp;
        vault_state.next_leaf_index = 0;
        vault_state.bump = vault_bump;
        vault_state.root = empty_root;
        // The frontier of an empty tree: every pending left sibling is the empty
        // subtree of its level.
        vault_state.filled_subtrees = merkle::ZEROS;

        let ledger_state = get_ledger_mut(ledger)?;
        ledger_state.denomination = denomination;
        ledger_state.epoch = 0;
        ledger_state.root_count = 0;
        ledger_state.root_cursor = 0;
        ledger_state.payout_count = 0;
        ledger_state.bump = ledger_bump;
        ledger_state.delegated = false;
        push_root(ledger_state, &empty_root);

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for InitializePool<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, ProgramError> {
        let (accounts, data) = value;
        let mut iter = accounts.iter();

        let payer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let vault = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let ledger = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        if !payer.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }
        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        let denomination = parse_u64(data, 0)?;
        if !is_valid_denomination(denomination) {
            return Err(ShredrError::InvalidDenomination.into());
        }

        Ok(Self {
            payer,
            vault,
            ledger,
            system_program,
            denomination,
        })
    }
}

// ─────────────────────────────────────────────
// PoolDeposit
// ─────────────────────────────────────────────

/// Put one denomination into the pool and append its note commitment.
///
/// Deliberately public. Everyone's deposit is visible and that is what makes the
/// withdrawal private: the anonymity set is every note in the pool, so a
/// depositor wants the deposit list to be as long and as public as possible.
/// There is no burner here and no stealth PDA — the wallet signs its own
/// transfer.
///
/// Which is also why this is the one place the KYT attestation's `depositor`
/// field can be checked against reality: unlike the stealth path, the wallet is
/// an account in the transaction.
///
/// # Duplicate commitments
///
/// Not rejected, and they do not need to be. Two identical leaves share one
/// nullifier, so only one can ever be spent — but the spender is whoever holds
/// the secret, which the copier by definition does not. Submitting someone
/// else's commitment donates a denomination to the pool and takes nothing from
/// them. The only person a duplicate hurts is a client that reused a secret, and
/// that is a client bug to fix where the randomness lives.
pub struct PoolDeposit<'a> {
    pub depositor: &'a AccountView,
    pub vault: &'a AccountView,
    pub instructions_sysvar: &'a AccountView,
    pub commitment: [u8; 32],
}

impl PoolDeposit<'_> {
    pub fn process(self) -> ProgramResult {
        let PoolDeposit {
            depositor,
            vault,
            instructions_sysvar,
            commitment,
        } = self;

        let denomination = {
            let state = get_vault_mut(vault)?;
            state.denomination
        };

        let (expected_vault, _) = derive_pool_vault(denomination)?;
        if vault.address() != &expected_vault {
            return Err(ShredrError::PoolMismatch.into());
        }

        let clock =
            Clock::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;

        // Before the transfer. Everything below moves lamports, and a compliance
        // check that ran after them would be a refund path, not a gate.
        verify_deposit_attestation(
            instructions_sysvar,
            &commitment,
            Some(depositor.address().as_array()),
            denomination,
            clock.unix_timestamp,
        )?;

        let rent =
            Rent::get().map_err(|_| -> ProgramError { ShredrError::RentUnavailable.into() })?;
        let surcharge = nullifier_rent(&rent)?;

        Transfer {
            from: depositor,
            to: vault,
            lamports: denomination
                .checked_add(surcharge)
                .ok_or(ProgramError::ArithmeticOverflow)?,
        }
        .invoke()?;

        let state = get_vault_mut(vault)?;

        let root = merkle::insert(
            &mut state.filled_subtrees,
            state.next_leaf_index,
            &commitment,
        )?;

        state.root = root;
        state.next_leaf_index += 1;
        // The surcharge is surplus, not backing: it is spent creating this note's
        // nullifier record, and counting it would let a payout draw on rent.
        state.total_deposited = state
            .total_deposited
            .checked_add(denomination)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for PoolDeposit<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, ProgramError> {
        let (accounts, data) = value;
        let mut iter = accounts.iter();

        let depositor = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let vault = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let instructions_sysvar = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        if !depositor.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }
        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        if data.len() != 32 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let commitment = <[u8; 32]>::try_from(data).expect("length checked");

        Ok(Self {
            depositor,
            vault,
            instructions_sysvar,
            commitment,
        })
    }
}

// ─────────────────────────────────────────────
// PoolSpend — rollup only
// ─────────────────────────────────────────────

/// Spend a note and queue its payout. Runs inside the ephemeral rollup.
///
/// Instruction data is
/// `[secret 32][destination 32][root 32][leaf_index u64][path 32 * DEPTH]`.
///
/// The note secret is the authorization: no signer is required, because anyone
/// who knows the secret is by definition the note's owner. That is also why this
/// instruction must never run on the base layer — the secret is in its data, and
/// on L1 that data is public forever. The `delegated` flag is what enforces it.
///
/// Every party that handles this transaction before it reaches the enclave sees
/// the secret and the leaf index, and can pair the deposit with the withdrawal
/// itself. In practice that means the rollup fee payer, which therefore has to
/// sit inside the same trust domain as the enclave. See
/// `docs/concepts/shielded-pool.md`.
pub struct PoolSpend<'a> {
    pub ledger: &'a AccountView,
    pub secret: [u8; 32],
    pub destination: [u8; 32],
    pub root: [u8; 32],
    pub leaf_index: u64,
    pub path: [[u8; 32]; merkle::DEPTH],
}

impl PoolSpend<'_> {
    pub fn process(self) -> ProgramResult {
        let PoolSpend {
            ledger,
            secret,
            destination,
            root,
            leaf_index,
            path,
        } = self;

        let state = get_ledger_mut(ledger)?;

        if !state.delegated {
            return Err(ShredrError::PoolLedgerDelegationState.into());
        }

        let (expected_ledger, _) = derive_pool_ledger(state.denomination)?;
        if ledger.address() != &expected_ledger {
            return Err(ShredrError::PoolMismatch.into());
        }

        // Any root the ledger has seen, not only the newest. A path is built
        // against the tree as it stood when the client read it, and every deposit
        // since has moved the root — accepting only the current one would make a
        // spend race every deposit in flight.
        let known = state.root_count as usize;
        if !state.roots[..known].iter().any(|entry| entry == &root) {
            return Err(ShredrError::PoolUnknownRoot.into());
        }

        let commitment = note::commitment(&secret);
        if merkle::root_from_path(&commitment, leaf_index, &path) != root {
            return Err(ShredrError::PoolUnknownNote.into());
        }

        let nullifier = note::nullifier(&secret);

        // This epoch's spent set is the queue itself. A note spent twice in one
        // epoch is caught here; one spent across epochs is caught at settlement
        // by its record PDA already existing.
        let queued = state.payout_count as usize;
        if state.payouts[..queued]
            .iter()
            .any(|payout| payout.nullifier == nullifier)
        {
            return Err(ShredrError::PoolNoteAlreadySpent.into());
        }

        if queued >= PAYOUT_QUEUE_CAP {
            return Err(ShredrError::PoolPayoutQueueFull.into());
        }

        state.payouts[queued] = Payout {
            nullifier,
            destination,
        };
        state.payout_count += 1;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for PoolSpend<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, ProgramError> {
        let (accounts, data) = value;

        let ledger = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;

        const PATH_OFFSET: usize = 32 + 32 + 32 + 8;
        if data.len() != PATH_OFFSET + merkle::DEPTH * 32 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut path = [[0u8; 32]; merkle::DEPTH];
        for (level, sibling) in path.iter_mut().enumerate() {
            let start = PATH_OFFSET + level * 32;
            sibling.copy_from_slice(&data[start..start + 32]);
        }

        Ok(Self {
            ledger,
            secret: <[u8; 32]>::try_from(&data[0..32]).expect("length checked"),
            destination: <[u8; 32]>::try_from(&data[32..64]).expect("length checked"),
            root: <[u8; 32]>::try_from(&data[64..96]).expect("length checked"),
            leaf_index: parse_u64(data, 96)?,
            path,
        })
    }
}

// ─────────────────────────────────────────────
// AdvanceEpoch
// ─────────────────────────────────────────────

/// Turn the epoch: pay out the queue, then publish the tree's current root.
///
/// Permissionless, so the pool has no admin and no single keeper it depends on.
/// The queue is authoritative — whoever pays the fee just executes what the
/// enclave already authorized.
///
/// Trailing accounts come in `(destination, nullifier_record)` pairs, matched
/// positionally to the front of the queue. Passing fewer pairs than the queue
/// holds settles that many and leaves the rest, which is how a queue larger than
/// one transaction's account limit drains.
///
/// Settling and root publication are one instruction because they are one atomic
/// epoch: a settle that succeeded with the root left stale would strand every
/// deposit since the last turn.
pub struct AdvanceEpoch<'a> {
    pub payer: &'a AccountView,
    pub vault: &'a AccountView,
    pub ledger: &'a AccountView,
    /// `(destination, nullifier_record)` pairs.
    pub settlements: &'a [AccountView],
}

impl AdvanceEpoch<'_> {
    pub fn process(self) -> ProgramResult {
        let AdvanceEpoch {
            payer,
            vault,
            ledger,
            settlements,
        } = self;

        let clock =
            Clock::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;

        let (denomination, epoch, last_epoch_at, root) = {
            let state = get_vault_mut(vault)?;
            (
                state.denomination,
                state.epoch,
                state.last_epoch_at,
                state.root,
            )
        };

        let (expected_vault, _) = derive_pool_vault(denomination)?;
        let (expected_ledger, _) = derive_pool_ledger(denomination)?;
        if vault.address() != &expected_vault || ledger.address() != &expected_ledger {
            return Err(ShredrError::PoolMismatch.into());
        }

        // The floor that makes payouts batch. Without it anyone could turn the
        // epoch straight after a spend, and a batch of one is a batch that ties
        // the payout to the spend that queued it.
        if clock.unix_timestamp < last_epoch_at.saturating_add(MIN_EPOCH_SECS) {
            return Err(ShredrError::PoolEpochTooSoon.into());
        }

        let ledger_state = get_ledger_mut(ledger)?;

        // On the base layer a delegated ledger is owned by the delegation
        // program, so `get_ledger_mut` would already have failed. This catches
        // the other order: state committed back but the flag not yet cleared.
        if ledger_state.delegated {
            return Err(ShredrError::PoolLedgerDelegationState.into());
        }
        if ledger_state.denomination != denomination {
            return Err(ShredrError::PoolMismatch.into());
        }
        if ledger_state.epoch != epoch {
            return Err(ShredrError::PoolEpochMismatch.into());
        }

        let paid = settle_payouts(ledger_state, vault, payer, settlements, denomination)?;

        let vault_state = get_vault_mut(vault)?;
        vault_state.total_settled = vault_state
            .total_settled
            .checked_add((paid as u64).saturating_mul(denomination))
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // Publish the root every deposit since the last turn has been folding
        // into. This is what makes those deposits spendable.
        push_root(ledger_state, &root);

        vault_state.epoch = epoch.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
        vault_state.last_epoch_at = clock.unix_timestamp;
        ledger_state.epoch = vault_state.epoch;

        Ok(())
    }
}

/// Pay the front of the queue out, recording each spent nullifier, and compact
/// what is left.
///
/// Returns how many were actually paid, which can be fewer than were processed:
/// a note whose record already exists was spent in an earlier epoch, so its
/// queue entry is dropped rather than honoured. Dropping beats failing, because
/// one stale entry would otherwise block every other payout in the batch.
fn settle_payouts(
    ledger: &mut PoolLedger,
    vault: &AccountView,
    payer: &AccountView,
    settlements: &[AccountView],
    denomination: u64,
) -> Result<usize, ProgramError> {
    let queued = ledger.payout_count as usize;
    let processing = queued.min(settlements.len() / 2);
    if processing == 0 {
        return Ok(0);
    }

    let rent = Rent::get().map_err(|_| -> ProgramError { ShredrError::RentUnavailable.into() })?;
    let record_rent = nullifier_rent(&rent)?;
    let vault_rent_minimum = rent.try_minimum_balance(vault.data_len())?;

    // Checked against the counters rather than the balance: anyone can send
    // lamports to a derivable address, and backing inferred from the balance
    // would let them fake it.
    let (total_deposited, total_settled) = {
        let state = get_vault_mut(vault)?;
        (state.total_deposited, state.total_settled)
    };
    let mut payable = total_deposited.saturating_sub(total_settled);

    let mut paid = 0usize;

    for index in 0..processing {
        let destination = &settlements[index * 2];
        let record = &settlements[index * 2 + 1];
        let payout = ledger.payouts[index];

        if destination.address().as_array() != &payout.destination {
            return Err(ShredrError::PoolDestinationMismatch.into());
        }
        // Crediting the vault from the vault is a lamports imbalance the runtime
        // rejects, and would silently zero a payout if it did not.
        if destination.address() == vault.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        let (expected_record, record_bump) = Address::derive_program_address(
            &[seeds::NULLIFIER, &payout.nullifier],
            &PROGRAM_ADDRESS,
        )
        .ok_or(ProgramError::InvalidAccountData)?;

        if record.address() != &expected_record {
            return Err(ShredrError::PoolNullifierRecordMismatch.into());
        }

        // Already spent in an earlier epoch. Drop the entry and pay nothing —
        // the note was honoured the first time, and failing here would let one
        // stale queue entry hold up everyone else's withdrawal.
        if record.data_len() > 0 || record.lamports() > 0 {
            continue;
        }

        if payable < denomination {
            return Err(ShredrError::PoolInsufficientBacking.into());
        }

        // Everything this payout costs the vault, checked before any of it
        // moves: the payout itself plus the record's rent.
        let outgoing = denomination
            .checked_add(record_rent)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let remaining = vault
            .lamports()
            .checked_sub(outgoing)
            .ok_or(ProgramError::InsufficientFunds)?;
        if remaining < vault_rent_minimum {
            return Err(ShredrError::BalanceInvariantViolation.into());
        }

        // The record is created by the payer rather than the vault, because
        // System will not debit an account it does not own and the vault is
        // ours. The vault reimburses below, out of the surcharge this note's own
        // deposit left behind — so the epoch turner is still not out of pocket,
        // and every payout stays exactly one denomination.
        let record_bump_slice = [record_bump];
        let record_seeds = [
            Seed::from(seeds::NULLIFIER),
            Seed::from(&payout.nullifier),
            Seed::from(&record_bump_slice),
        ];

        CreateAccount {
            from: payer,
            to: record,
            lamports: record_rent,
            space: NULLIFIER_RECORD_LEN as u64,
            owner: &PROGRAM_ADDRESS,
        }
        .invoke_signed(&[Signer::from(&record_seeds)])?;

        write_discriminator(record, &NULLIFIER_RECORD_DISCRIMINATOR, 0)?;

        let reimbursed = payer
            .lamports()
            .checked_add(record_rent)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let credited = destination
            .lamports()
            .checked_add(denomination)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        vault.set_lamports(remaining);
        payer.set_lamports(reimbursed);
        destination.set_lamports(credited);

        payable -= denomination;
        paid += 1;
    }

    ledger.payouts.copy_within(processing..queued, 0);
    ledger.payout_count = (queued - processing) as u32;

    Ok(paid)
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for AdvanceEpoch<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, ProgramError> {
        let (accounts, _data) = value;

        if accounts.len() < 4 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let payer = &accounts[0];
        let vault = &accounts[1];
        let ledger = &accounts[2];
        let system_program = &accounts[3];

        if !payer.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }
        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Both are read through `borrow_unchecked_mut`, so the same account
        // passed twice would hand out two aliasing `&mut`.
        if vault.address() == ledger.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        Ok(Self {
            payer,
            vault,
            ledger,
            settlements: &accounts[4..],
        })
    }
}

// ─────────────────────────────────────────────
// DelegatePoolLedger
// ─────────────────────────────────────────────

/// Hand the ledger to the rollup so notes can be spent against it.
///
/// No ACL permission is created, unlike the stealth path. There the permission
/// names the one burner allowed to write; here any holder of a note secret may
/// spend, and the secret is the authorization. A member list would be a list of
/// the pool's users, which is the last thing this account should hold.
pub struct DelegatePoolLedger<'a> {
    pub payer: &'a AccountView,
    pub ledger: &'a AccountView,
    pub owner_program: &'a AccountView,
    pub delegation_buffer: &'a AccountView,
    pub delegation_record: &'a AccountView,
    pub delegation_metadata: &'a AccountView,
    pub system_program: &'a AccountView,
}

impl DelegatePoolLedger<'_> {
    pub fn process(self) -> ProgramResult {
        let DelegatePoolLedger {
            payer,
            ledger,
            owner_program,
            delegation_buffer,
            delegation_record,
            delegation_metadata,
            system_program,
        } = self;

        let (denomination, bump) = {
            let state = get_ledger_mut(ledger)?;
            if state.delegated {
                return Err(ShredrError::AlreadyDelegated.into());
            }
            // Set before the CPI: delegation reassigns the account away from this
            // program, so this is the last chance to write it.
            state.delegated = true;
            (state.denomination, state.bump)
        };

        let (expected_ledger, _) = derive_pool_ledger(denomination)?;
        if ledger.address() != &expected_ledger {
            return Err(ShredrError::PoolMismatch.into());
        }

        let denomination_bytes = denomination.to_le_bytes();
        let pda_seeds: &[&[u8]] = &[seeds::POOL_LEDGER, &denomination_bytes];

        delegate_account(
            &[
                payer,
                ledger,
                owner_program,
                delegation_buffer,
                delegation_record,
                delegation_metadata,
                system_program,
            ],
            pda_seeds,
            bump,
            DelegateConfig {
                validator: tee_validator(),
                ..Default::default()
            },
        )?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for DelegatePoolLedger<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, ProgramError> {
        let (accounts, _data) = value;
        let mut iter = accounts.iter();

        let payer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let ledger = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let owner_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_buffer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_record = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_metadata = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        if !payer.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // `delegate_account` derives the buffer's bump from `owner_program` and
        // checks only that — one byte, so a caller can grind a colliding address
        // and take the buffer. Same reasoning as `InitializeAndDelegate`.
        if owner_program.address() != &PROGRAM_ADDRESS {
            return Err(ProgramError::IncorrectProgramId);
        }
        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(Self {
            payer,
            ledger,
            owner_program,
            delegation_buffer,
            delegation_record,
            delegation_metadata,
            system_program,
        })
    }
}

// ─────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────

/// Append a root to the ledger's ring, oldest first out.
fn push_root(ledger: &mut PoolLedger, root: &[u8; 32]) {
    let cursor = ledger.root_cursor as usize % ROOT_HISTORY_CAP;
    ledger.roots[cursor] = *root;
    ledger.root_cursor = ((cursor + 1) % ROOT_HISTORY_CAP) as u32;
    if (ledger.root_count as usize) < ROOT_HISTORY_CAP {
        ledger.root_count += 1;
    }
}

/// Create a program-owned PDA, tolerating an address someone has already sent
/// lamports to.
///
/// `CreateAccount` refuses a non-empty account, and both pool addresses are
/// derivable from a public denomination — so without this, one lamport sent to a
/// vault address would make that pool permanently uncreatable.
///
/// Anything found there stays as unaccounted surplus. Unlike a stealth PDA it is
/// deliberately *not* credited: `total_deposited` backs the notes, and crediting
/// a stranger's lamports would let them inflate the pool's apparent backing
/// without a commitment to match.
fn create_pda(
    payer: &AccountView,
    account: &AccountView,
    seeds: &[Seed],
    space: u64,
) -> Result<(), ProgramError> {
    let rent = Rent::get().map_err(|_| -> ProgramError { ShredrError::RentUnavailable.into() })?;
    let rent_lamports = rent.try_minimum_balance(space as usize)?;
    let existing = account.lamports();

    if existing == 0 {
        CreateAccount {
            from: payer,
            to: account,
            lamports: rent_lamports,
            space,
            owner: &PROGRAM_ADDRESS,
        }
        .invoke_signed(&[Signer::from(seeds)])?;
        return Ok(());
    }

    let shortfall = rent_lamports.saturating_sub(existing);
    if shortfall > 0 {
        Transfer {
            from: payer,
            to: account,
            lamports: shortfall,
        }
        .invoke()?;
    }

    Allocate { account, space }.invoke_signed(&[Signer::from(seeds)])?;
    Assign {
        account,
        owner: &PROGRAM_ADDRESS,
    }
    .invoke_signed(&[Signer::from(seeds)])?;

    Ok(())
}

fn parse_u64(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    data.get(offset..offset + 8)
        .and_then(|bytes| <[u8; 8]>::try_from(bytes).ok())
        .map(u64::from_le_bytes)
        .ok_or(ProgramError::InvalidInstructionData)
}
