//! The shielded pool.
//!
//! One vault per denomination holds every lamport; one ledger per denomination
//! holds the note set. A deposit publishes a commitment and hands over
//! `denomination` lamports. A spend, inside the rollup, publishes a nullifier
//! and queues a payout. An epoch turn, on the base layer, pays the queue out and
//! folds new commitments in.
//!
//! What the base layer ever sees is a list of commitments, a list of nullifiers,
//! and a batch of equal-sized transfers. Pairing any commitment with any
//! nullifier requires a note secret, and the only instruction that carries one
//! runs inside the enclave.
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
    contains_hash, derive_pool_ledger, derive_pool_vault, get_ledger_mut, get_vault_mut,
    write_discriminator,
};
use crate::kyt::verify_deposit_attestation;
use crate::note;
use crate::state::{
    Payout, PoolLedger, PAYOUT_QUEUE_CAP, PENDING_COMMITMENT_CAP, POOL_COMMITMENT_CAP,
    POOL_LEDGER_DISCRIMINATOR, POOL_LEDGER_SIZE, POOL_NULLIFIER_CAP, POOL_VAULT_DISCRIMINATOR,
    POOL_VAULT_SIZE,
};
use crate::{ProgramError, ProgramResult};

use ephemeral_rollups_pinocchio::instruction::delegate_account;
use ephemeral_rollups_pinocchio::types::DelegateConfig;

use pinocchio::cpi::{Seed, Signer};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;
use pinocchio::AccountView;
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

// ─────────────────────────────────────────────
// InitializePool
// ─────────────────────────────────────────────

/// Create the vault and ledger for one denomination.
///
/// Permissionless. Both addresses derive from the denomination alone, so there
/// is one canonical pool per amount and the only thing a caller can do by
/// running this first is pay the rent for everyone else.
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

        let vault_state = get_vault_mut(vault)?;
        vault_state.denomination = denomination;
        vault_state.total_deposited = 0;
        vault_state.total_settled = 0;
        vault_state.epoch = 0;
        vault_state.last_epoch_at = clock.unix_timestamp;
        vault_state.pending_count = 0;
        vault_state.bump = vault_bump;

        let ledger_state = get_ledger_mut(ledger)?;
        ledger_state.denomination = denomination;
        ledger_state.epoch = 0;
        ledger_state.commitment_count = 0;
        ledger_state.nullifier_count = 0;
        ledger_state.payout_count = 0;
        ledger_state.bump = ledger_bump;
        ledger_state.delegated = false;

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

/// Put `denomination` lamports into the pool under a note commitment.
///
/// Deliberately public. Everyone's deposit is visible and that is what makes the
/// withdrawal private: the anonymity set is every note in the pool, so the
/// depositor wants the deposit list to be as long and as public as possible.
/// There is no burner here and no stealth PDA — the wallet signs its own
/// transfer.
///
/// Which is also why this is the one place the KYT attestation's `depositor`
/// field can be checked: unlike the stealth path, the wallet is an account in
/// the transaction.
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

        Transfer {
            from: depositor,
            to: vault,
            lamports: denomination,
        }
        .invoke()?;

        let state = get_vault_mut(vault)?;

        let pending = state.pending_count as usize;
        if pending >= PENDING_COMMITMENT_CAP {
            return Err(ShredrError::PoolPendingFull.into());
        }

        // A repeated commitment would be a note two people could spend, and the
        // second spend would find the nullifier already used — so the loser's
        // funds would be stuck in the pool with nothing able to release them.
        // Cheaper to refuse here than to explain later.
        if contains_hash(&state.pending, pending, &commitment) {
            return Err(ShredrError::PoolUnknownNote.into());
        }

        state.pending[pending] = commitment;
        state.pending_count += 1;
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
/// The note secret is the authorization: no signer is required, because anyone
/// who knows the secret is by definition the note's owner. That is also why this
/// instruction must never run on the base layer — the secret is in its data, and
/// on L1 that data is public forever. The `delegated` flag is what enforces it.
///
/// Every party that handles this transaction before it reaches the enclave sees
/// the secret and can link the deposit to the withdrawal. In practice that means
/// the rollup fee payer, which therefore has to sit inside the same trust domain
/// as the enclave. See `docs/concepts/shielded-pool.md`.
pub struct PoolSpend<'a> {
    pub ledger: &'a AccountView,
    pub secret: [u8; 32],
    pub destination: [u8; 32],
}

impl PoolSpend<'_> {
    pub fn process(self) -> ProgramResult {
        let PoolSpend {
            ledger,
            secret,
            destination,
        } = self;

        let state = get_ledger_mut(ledger)?;

        if !state.delegated {
            return Err(ShredrError::PoolLedgerDelegationState.into());
        }

        let (expected_ledger, _) = derive_pool_ledger(state.denomination)?;
        if ledger.address() != &expected_ledger {
            return Err(ShredrError::PoolMismatch.into());
        }

        let commitment = note::commitment(&secret);
        if !contains_hash(
            &state.commitments,
            state.commitment_count as usize,
            &commitment,
        ) {
            return Err(ShredrError::PoolUnknownNote.into());
        }

        let nullifier = note::nullifier(&secret);
        let spent = state.nullifier_count as usize;
        if contains_hash(&state.nullifiers, spent, &nullifier) {
            return Err(ShredrError::PoolNoteAlreadySpent.into());
        }

        let queued = state.payout_count as usize;
        if queued >= PAYOUT_QUEUE_CAP {
            return Err(ShredrError::PoolPayoutQueueFull.into());
        }
        // Unreachable while the two caps match, since a nullifier can only be
        // added for a commitment that exists. Checked anyway: the alternative to
        // an error here is a write past the end of the account.
        if spent >= POOL_NULLIFIER_CAP {
            return Err(ShredrError::PoolCommitmentsFull.into());
        }

        state.nullifiers[spent] = nullifier;
        state.nullifier_count += 1;

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

        if data.len() != 64 {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(Self {
            ledger,
            secret: <[u8; 32]>::try_from(&data[0..32]).expect("length checked"),
            destination: <[u8; 32]>::try_from(&data[32..64]).expect("length checked"),
        })
    }
}

// ─────────────────────────────────────────────
// AdvanceEpoch
// ─────────────────────────────────────────────

/// Turn the epoch: pay out the queue, then fold pending commitments into the
/// ledger.
///
/// Permissionless, so the pool has no admin and no single keeper it depends on.
/// The queue is authoritative — whoever pays the fee just executes what the
/// enclave already authorized.
///
/// Destinations are passed as trailing accounts, matched positionally to the
/// front of the payout queue. Passing fewer than the queue holds settles that
/// many and leaves the rest for the next turn, which is how a queue larger than
/// one transaction's account limit drains.
///
/// The two halves are one instruction because they are one atomic epoch: a
/// settle that succeeded and an ingest that failed would leave deposits stranded
/// in `pending` with the vault already lighter.
pub struct AdvanceEpoch<'a> {
    pub vault: &'a AccountView,
    pub ledger: &'a AccountView,
    pub destinations: &'a [AccountView],
}

impl AdvanceEpoch<'_> {
    pub fn process(self) -> ProgramResult {
        let AdvanceEpoch {
            vault,
            ledger,
            destinations,
        } = self;

        let clock =
            Clock::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;

        let (denomination, epoch, last_epoch_at) = {
            let state = get_vault_mut(vault)?;
            (state.denomination, state.epoch, state.last_epoch_at)
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

        let settled = settle_payouts(vault, ledger_state, destinations, denomination)?;

        let vault_state = get_vault_mut(vault)?;
        vault_state.total_settled = vault_state
            .total_settled
            .checked_add((settled as u64).saturating_mul(denomination))
            .ok_or(ProgramError::ArithmeticOverflow)?;

        // Ingest. Whatever does not fit stays pending rather than being dropped:
        // those lamports are already in the vault, so a discarded commitment is a
        // note nobody can ever spend.
        let mut ingested = 0usize;
        let pending = vault_state.pending_count as usize;
        while ingested < pending {
            let next = ledger_state.commitment_count as usize;
            if next >= POOL_COMMITMENT_CAP {
                break;
            }
            ledger_state.commitments[next] = vault_state.pending[ingested];
            ledger_state.commitment_count += 1;
            ingested += 1;
        }

        // Keep the tail. `copy_within` rather than a loop so an overlapping move
        // is the compiler's problem.
        if ingested > 0 {
            vault_state.pending.copy_within(ingested..pending, 0);
            vault_state.pending_count = (pending - ingested) as u32;
        }

        vault_state.epoch = epoch.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
        vault_state.last_epoch_at = clock.unix_timestamp;
        ledger_state.epoch = vault_state.epoch;

        Ok(())
    }
}

/// Pay the front of the queue out to `destinations`, and compact what is left.
///
/// Returns how many were settled.
fn settle_payouts(
    vault: &AccountView,
    ledger: &mut PoolLedger,
    destinations: &[AccountView],
    denomination: u64,
) -> Result<usize, ProgramError> {
    let queued = ledger.payout_count as usize;
    let settling = queued.min(destinations.len());
    if settling == 0 {
        return Ok(0);
    }

    let rent = Rent::get().map_err(|_| -> ProgramError { ShredrError::RentUnavailable.into() })?;
    let rent_minimum = rent.try_minimum_balance(vault.data_len())?;

    // Checked against the counters rather than the balance: anyone can send
    // lamports to a derivable address, and backing inferred from the balance
    // would let them do it.
    let (total_deposited, total_settled) = {
        let state = get_vault_mut(vault)?;
        (state.total_deposited, state.total_settled)
    };
    let payable = total_deposited.saturating_sub(total_settled);
    let requested = (settling as u64)
        .checked_mul(denomination)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if requested > payable {
        return Err(ShredrError::PoolInsufficientBacking.into());
    }

    let remaining = vault
        .lamports()
        .checked_sub(requested)
        .ok_or(ProgramError::InsufficientFunds)?;
    if remaining < rent_minimum {
        return Err(ShredrError::BalanceInvariantViolation.into());
    }

    for (index, destination) in destinations.iter().take(settling).enumerate() {
        if destination.address().as_array() != &ledger.payouts[index].destination {
            return Err(ShredrError::PoolDestinationMismatch.into());
        }
        // Crediting the vault from the vault is a lamports imbalance the runtime
        // rejects, and would silently zero a payout if it did not.
        if destination.address() == vault.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        let credited = destination
            .lamports()
            .checked_add(denomination)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        destination.set_lamports(credited);
    }

    vault.set_lamports(remaining);

    ledger.payouts.copy_within(settling..queued, 0);
    ledger.payout_count = (queued - settling) as u32;

    Ok(settling)
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for AdvanceEpoch<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, ProgramError> {
        let (accounts, _data) = value;

        if accounts.len() < 3 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let payer = &accounts[0];
        let vault = &accounts[1];
        let ledger = &accounts[2];

        if !payer.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // Both are read through `borrow_unchecked_mut`, so the same account
        // passed twice would hand out two aliasing `&mut`.
        if vault.address() == ledger.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        Ok(Self {
            vault,
            ledger,
            destinations: &accounts[3..],
        })
    }
}

// ─────────────────────────────────────────────
// DelegatePoolLedger
// ─────────────────────────────────────────────

/// Hand the ledger to the rollup so notes can be spent against it.
///
/// No ACL permission is created, unlike the stealth path. There the permission
/// names the one burner allowed to write; here any holder of a note secret is
/// allowed to spend, and the secret is the authorization. A member list would be
/// a list of the pool's users, which is the last thing this account should hold.
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

/// Create a program-owned PDA, tolerating an address someone has already sent
/// lamports to.
///
/// `CreateAccount` refuses a non-empty account, and both pool addresses are
/// derivable from a public denomination — so without this, one lamport sent to a
/// vault address would make that pool permanently uncreatable.
///
/// Anything found there stays as an unaccounted surplus. Unlike a stealth PDA it
/// is deliberately *not* credited: `total_deposited` backs the notes, and
/// crediting a stranger's lamports would let them inflate the pool's apparent
/// backing without a commitment to match.
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
