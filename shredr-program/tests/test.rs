//! Integration tests for the SHREDR privacy program.
//!
//! These run the compiled SBF ELF inside [Mollusk](https://github.com/anza-xyz/mollusk),
//! a minified SVM harness. Build the program first:
//!
//! ```sh
//! cargo build-sbf
//! cargo test
//! ```
//!
//! ## Coverage
//!
//! `PrivateTransfer` and `Withdraw` are pure lamport/state instructions with no
//! cross-program invocations, so they are covered end to end — success paths and
//! every rejection path.
//!
//! `InitializeAndDelegate` is additionally gated on a KYT attestation signed by
//! the authority baked in at build time. Mollusk does not run the ed25519
//! precompile, so the signature bytes here are dummies — what is asserted is
//! everything the *program* checks about the precompile instruction, which is
//! exactly the part a real transaction leaves to us.
//!
//! The default build falls back to `constants::KYT_AUTHORITY_PLACEHOLDER`, so
//! the ELF and this test binary agree on an authority without either holding a
//! key. Override both together if you want to test against a real one:
//!
//! ```sh
//! SHREDR_KYT_AUTHORITY=<base58 pubkey> cargo build-sbf
//! SHREDR_KYT_AUTHORITY=<base58 pubkey> cargo test
//! ```
//!
//! `InitializeAndDelegate`, `CommitStealth`, `CommitAndUndelegateStealth` and
//! `UndelegationCallback` all CPI into the MagicBlock delegation program and the
//! ACL permission program. Those ELFs are not available to the harness, so only
//! the validation performed *before* the CPI is asserted here. Their happy paths
//! need a validator with the MagicBlock programs deployed.

use mollusk_svm::{
    program::{create_program_account_loader_v3, loader_keys::LOADER_V3},
    result::Check,
    Mollusk,
};
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

use shredr_program::{
    constants::seeds,
    errors::ShredrError,
    state::{StealthAccount, STEALTH_ACCOUNT_DISCRIMINATOR, STEALTH_ACCOUNT_SIZE},
};

// ─────────────────────────────────────────────
// Instruction discriminators (mirrors `InstructionDiscriminator` in lib.rs,
// which is private to the crate).
// ─────────────────────────────────────────────

const IX_INITIALIZE_AND_DELEGATE: u8 = 0;
const IX_PRIVATE_TRANSFER: u8 = 1;
const IX_COMMIT_STEALTH: u8 = 2;
const IX_COMMIT_AND_UNDELEGATE_STEALTH: u8 = 3;
const IX_WITHDRAW: u8 = 4;
const IX_CLOSE_STEALTH_ACCOUNT: u8 = 5;
const IX_INITIALIZE_POOL: u8 = 6;
const IX_POOL_DEPOSIT: u8 = 7;
const IX_POOL_SPEND: u8 = 8;
const IX_ADVANCE_EPOCH: u8 = 9;
const IX_UNDELEGATION_CALLBACK: u8 = 0xFF;

// ─────────────────────────────────────────────
// StealthAccount byte layout
//
// On-chain data is `[8-byte discriminator][StealthAccount]`. The offsets below
// encode the `#[repr(C)]` layout the program casts to; `stealth_account_layout_
// is_stable` pins them against the real struct so a field reorder breaks loudly
// instead of silently corrupting every fixture in this file.
// ─────────────────────────────────────────────

const OFF_OWNER: usize = 8;
const OFF_RECEIPT_COMMITMENT: usize = 40;
const OFF_DEPOSITED_AMOUNT: usize = 72;
const OFF_DEPOSIT_TIMESTAMP: usize = 80;
const OFF_DELEGATED: usize = 88;
const OFF_BUMP: usize = 89;
const OFF_ROLE: usize = 90;

/// Full on-chain size: 8-byte discriminator + `StealthAccount` (88 bytes,
/// including 6 bytes of trailing padding for its 8-byte alignment).
const ACCOUNT_LEN: usize = 8 + STEALTH_ACCOUNT_SIZE;

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

// ─────────────────────────────────────────────
// Harness setup
// ─────────────────────────────────────────────

fn program_id() -> Pubkey {
    Pubkey::new_from_array(shredr_program::ID)
}

/// Locate and read `shredr_program.so`.
///
/// Mollusk's own search path does not include `target/deploy`, so the ELF is
/// loaded explicitly instead of via `Mollusk::new`.
fn program_elf() -> &'static [u8] {
    use std::sync::OnceLock;
    static ELF: OnceLock<Vec<u8>> = OnceLock::new();

    ELF.get_or_init(|| {
        let mut candidates = Vec::new();
        if let Ok(dir) = std::env::var("SBF_OUT_DIR") {
            candidates.push(std::path::PathBuf::from(dir));
        }
        candidates.push(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("deploy"),
        );

        for dir in &candidates {
            let path = dir.join("shredr_program.so");
            if path.exists() {
                return std::fs::read(&path)
                    .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
            }
        }

        panic!(
            "shredr_program.so not found in {:?}. Run `cargo build-sbf` first.",
            candidates
        );
    })
    .as_slice()
}

fn mollusk() -> Mollusk {
    let mut mollusk = Mollusk::default();
    mollusk.add_program_with_loader_and_elf(&program_id(), &LOADER_V3, program_elf());
    mollusk
}

/// Rent-exempt minimum for a full-size stealth account, as the program computes it.
fn stealth_rent(mollusk: &Mollusk) -> u64 {
    mollusk.sysvars.rent.minimum_balance(ACCOUNT_LEN)
}

fn shredr_err(error: ShredrError) -> ProgramError {
    ProgramError::Custom(error as u32)
}

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

/// Derive a stealth PDA the same way the program does: `[STEALTH_ADDRESS, burner]`.
fn derive_stealth_pda(burner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::STEALTH_ADDRESS, burner.as_ref()], &program_id())
}

#[derive(Clone)]
struct StealthState {
    owner: Pubkey,
    receipt_commitment: [u8; 32],
    deposited_amount: u64,
    deposit_timestamp: i64,
    delegated: bool,
    bump: u8,
    role: u8,
}

impl StealthState {
    fn new(owner: Pubkey, receipt_commitment: [u8; 32], bump: u8) -> Self {
        Self {
            owner,
            receipt_commitment,
            deposited_amount: 0,
            deposit_timestamp: 1_700_000_000,
            delegated: false,
            bump,
            role: 0,
        }
    }

    fn deposited(mut self, amount: u64) -> Self {
        self.deposited_amount = amount;
        self
    }

    fn delegated(mut self, delegated: bool) -> Self {
        self.delegated = delegated;
        self
    }

    /// Serialize into the on-chain `[discriminator][StealthAccount]` layout.
    fn to_bytes(&self) -> Vec<u8> {
        let mut data = vec![0u8; ACCOUNT_LEN];
        data[0..8].copy_from_slice(&STEALTH_ACCOUNT_DISCRIMINATOR);
        data[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(self.owner.as_ref());
        data[OFF_RECEIPT_COMMITMENT..OFF_RECEIPT_COMMITMENT + 32].copy_from_slice(&self.receipt_commitment);
        data[OFF_DEPOSITED_AMOUNT..OFF_DEPOSITED_AMOUNT + 8]
            .copy_from_slice(&self.deposited_amount.to_le_bytes());
        data[OFF_DEPOSIT_TIMESTAMP..OFF_DEPOSIT_TIMESTAMP + 8]
            .copy_from_slice(&self.deposit_timestamp.to_le_bytes());
        data[OFF_DELEGATED] = self.delegated as u8;
        data[OFF_BUMP] = self.bump;
        data[OFF_ROLE] = self.role;
        data
    }

    fn to_account(&self, lamports: u64) -> Account {
        Account {
            lamports,
            data: self.to_bytes(),
            owner: program_id(),
            executable: false,
            rent_epoch: 0,
        }
    }
}

fn system_account(lamports: u64) -> Account {
    Account {
        lamports,
        data: vec![],
        owner: solana_sdk_ids::system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// A stealth PDA plus the state and account backing it, ready to drop into a test.
struct Stealth {
    key: Pubkey,
    state: StealthState,
    account: Account,
}

/// Build a funded, undelegated stealth account holding `deposited` lamports of
/// user funds on top of the rent-exempt minimum.
fn funded_stealth(mollusk: &Mollusk, burner: &Pubkey, receipt_commitment: [u8; 32], deposited: u64) -> Stealth {
    let (key, bump) = derive_stealth_pda(burner);
    let state = StealthState::new(*burner, receipt_commitment, bump).deposited(deposited);
    let account = state.to_account(stealth_rent(mollusk) + deposited);
    Stealth {
        key,
        state,
        account,
    }
}

// ─────────────────────────────────────────────
// Instruction builders
// ─────────────────────────────────────────────

fn private_transfer_ix(
    source_burner: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = vec![IX_PRIVATE_TRANSFER];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new_readonly(*source_burner, true),
            AccountMeta::new(*source, false),
            AccountMeta::new(*destination, false),
        ],
    )
}

fn withdraw_ix(owner: &Pubkey, stealth: &Pubkey, destination: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![IX_WITHDRAW];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*stealth, false),
            AccountMeta::new(*destination, false),
        ],
    )
}

fn close_ix(owner: &Pubkey, stealth: &Pubkey, rent_payee: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        program_id(),
        &[IX_CLOSE_STEALTH_ACCOUNT],
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*stealth, false),
            AccountMeta::new(*rent_payee, false),
        ],
    )
}

/// A spent stealth PDA: drained to `deposited_amount == 0`, holding only rent,
/// undelegated. This is the state both roles reach at the end of a cycle — the
/// deposit PDA after `PrivateTransfer`, the exit PDA after `Withdraw`.
fn spent_stealth(mollusk: &Mollusk, burner: &Pubkey) -> Stealth {
    funded_stealth(mollusk, burner, [12u8; 32], 0)
}

// ─────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────

/// The program reinterprets raw account bytes as a `StealthAccount`, so its
/// layout is part of the wire format shared with the TypeScript client. Pin it.
#[test]
fn stealth_account_layout_is_stable() {
    assert_eq!(STEALTH_ACCOUNT_SIZE, 88);
    assert_eq!(ACCOUNT_LEN, 96);
    assert_eq!(core::mem::align_of::<StealthAccount>(), 8);

    let state = StealthAccount {
        owner: Default::default(),
        receipt_commitment: [0u8; 32],
        deposited_amount: 0,
        deposit_timestamp: 0,
        delegated: false,
        bump: 0,
        role: 0,
    };
    let base = &state as *const StealthAccount as usize;
    let offset_of = |field: usize| field - base + 8; // +8 for the discriminator

    assert_eq!(offset_of(&state.owner as *const _ as usize), OFF_OWNER);
    assert_eq!(offset_of(&state.receipt_commitment as *const _ as usize), OFF_RECEIPT_COMMITMENT);
    assert_eq!(
        offset_of(&state.deposited_amount as *const _ as usize),
        OFF_DEPOSITED_AMOUNT
    );
    assert_eq!(
        offset_of(&state.deposit_timestamp as *const _ as usize),
        OFF_DEPOSIT_TIMESTAMP
    );
    assert_eq!(
        offset_of(&state.delegated as *const _ as usize),
        OFF_DELEGATED
    );
    assert_eq!(offset_of(&state.bump as *const _ as usize), OFF_BUMP);
    // `role` must land in what was trailing padding: if the size grows past 88
    // the rent changes and every already-deployed account breaks.
    assert_eq!(offset_of(&state.role as *const _ as usize), OFF_ROLE);
}

// ─────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────

#[test]
fn empty_instruction_data_is_rejected() {
    let mollusk = mollusk();
    let key = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &[], vec![AccountMeta::new(key, true)]),
        &[(key, system_account(LAMPORTS_PER_SOL))],
        &[Check::err(ProgramError::InvalidInstructionData)],
    );
}

#[test]
fn unknown_discriminator_is_rejected() {
    let mollusk = mollusk();
    let key = Pubkey::new_unique();

    // 6..=10 are the shielded pool's; 0xFF is the undelegation callback.
    for discriminator in [11u8, 42, 200, 0xFE] {
        mollusk.process_and_validate_instruction(
            &Instruction::new_with_bytes(
                program_id(),
                &[discriminator],
                vec![AccountMeta::new(key, true)],
            ),
            &[(key, system_account(LAMPORTS_PER_SOL))],
            &[Check::err(ProgramError::InvalidInstructionData)],
        );
    }
}

// ─────────────────────────────────────────────
// PrivateTransfer
// ─────────────────────────────────────────────

#[test]
fn private_transfer_moves_lamports_and_deposited_amount() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);

    let source_burner = Pubkey::new_unique();
    let dest_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &dest_burner, [2u8; 32], LAMPORTS_PER_SOL);

    let amount = 2 * LAMPORTS_PER_SOL;

    let expected_source = source
        .state
        .clone()
        .deposited(3 * LAMPORTS_PER_SOL)
        .to_bytes();
    let expected_dest = destination
        .state
        .clone()
        .deposited(3 * LAMPORTS_PER_SOL)
        .to_bytes();

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(&source_burner, &source.key, &destination.key, amount),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
            (destination.key, destination.account.clone()),
        ],
        &[
            Check::success(),
            Check::account(&source.key)
                .lamports(rent + 3 * LAMPORTS_PER_SOL)
                .data(&expected_source)
                .build(),
            Check::account(&destination.key)
                .lamports(rent + 3 * LAMPORTS_PER_SOL)
                .data(&expected_dest)
                .build(),
        ],
    );
}

#[test]
fn private_transfer_of_entire_balance_succeeds() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);

    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 4 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(
            &source_burner,
            &source.key,
            &destination.key,
            4 * LAMPORTS_PER_SOL,
        ),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
            (destination.key, destination.account.clone()),
        ],
        &[
            Check::success(),
            // The source keeps exactly its rent-exempt minimum: `deposited_amount`
            // never includes rent, so draining it cannot un-fund the account.
            Check::account(&source.key).lamports(rent).build(),
            Check::account(&destination.key)
                .lamports(rent + 4 * LAMPORTS_PER_SOL)
                .build(),
        ],
    );
}

#[test]
fn private_transfer_rejects_self_transfer() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(&source_burner, &source.key, &source.key, LAMPORTS_PER_SOL),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::SelfTransferNotAllowed))],
    );
}

#[test]
fn private_transfer_requires_source_signature() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    // Clear the signer flag on the source burner (account 0).
    let mut instruction = private_transfer_ix(
        &source_burner,
        &source.key,
        &destination.key,
        LAMPORTS_PER_SOL,
    );
    instruction.accounts[0].is_signer = false;

    mollusk.process_and_validate_instruction(
        &instruction,
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::MissingSigner))],
    );
}

/// A signer that is not the source PDA's recorded owner cannot move its funds,
/// even though it is a valid signer and both PDAs are program-owned.
#[test]
fn private_transfer_rejects_non_owner_signer() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(&attacker, &source.key, &destination.key, LAMPORTS_PER_SOL),
        &[
            (attacker, system_account(0)),
            (source.key, source.account.clone()),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(ProgramError::IllegalOwner)],
    );
}

#[test]
fn private_transfer_rejects_foreign_source() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source_key = Pubkey::new_unique();
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(
            &source_burner,
            &source_key,
            &destination.key,
            LAMPORTS_PER_SOL,
        ),
        &[
            (source_burner, system_account(0)),
            (source_key, system_account(10 * LAMPORTS_PER_SOL)),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidProgramOwner))],
    );
}

#[test]
fn private_transfer_rejects_foreign_destination() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination_key = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(
            &source_burner,
            &source.key,
            &destination_key,
            LAMPORTS_PER_SOL,
        ),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
            (destination_key, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidDestinationOwner))],
    );
}

#[test]
fn private_transfer_rejects_amount_above_deposited() {
    let mollusk = mollusk();
    // The account holds rent + 1 SOL of lamports but only 1 SOL is withdrawable.
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(
            &source_burner,
            &source.key,
            &destination.key,
            LAMPORTS_PER_SOL + 1,
        ),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(ProgramError::InsufficientFunds)],
    );
}

#[test]
fn private_transfer_refuses_to_break_rent_exemption() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let (source_key, bump) = derive_stealth_pda(&burner);

    // A desynced account: `deposited_amount` claims 5_000 but only 100 lamports
    // sit above the rent-exempt minimum. Moving the full claimed balance would
    // drop the account below rent and let the runtime reap it.
    let source_state = StealthState::new(burner, [9u8; 32], bump).deposited(5_000);
    let source_account = source_state.to_account(stealth_rent(&mollusk) + 100);

    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [10u8; 32], 0);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(&burner, &source_key, &destination.key, 5_000),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (source_key, source_account),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(shredr_err(
            ShredrError::BalanceInvariantViolation,
        ))],
    );
}

#[test]
fn private_transfer_rejects_zero_amount() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(&source_burner, &source.key, &destination.key, 0),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(ProgramError::InvalidInstructionData)],
    );
}

#[test]
fn private_transfer_rejects_malformed_amount() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    // 7 bytes and 9 bytes: `parse_amount` demands exactly 8.
    for payload in [vec![1u8; 7], vec![1u8; 9], vec![]] {
        let mut data = vec![IX_PRIVATE_TRANSFER];
        data.extend_from_slice(&payload);

        mollusk.process_and_validate_instruction(
            &Instruction::new_with_bytes(
                program_id(),
                &data,
                vec![
                    AccountMeta::new_readonly(source_burner, true),
                    AccountMeta::new(source.key, false),
                    AccountMeta::new(destination.key, false),
                ],
            ),
            &[
                (source_burner, system_account(0)),
                (source.key, source.account.clone()),
                (destination.key, destination.account.clone()),
            ],
            &[Check::err(ProgramError::InvalidInstructionData)],
        );
    }
}

#[test]
fn private_transfer_rejects_wrong_discriminator_in_account_data() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    // Program-owned and correctly sized, but not a StealthAccount.
    let mut impostor = source.account.clone();
    impostor.data[0..8].copy_from_slice(b"NOTSHRDR");

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(
            &source_burner,
            &source.key,
            &destination.key,
            LAMPORTS_PER_SOL,
        ),
        &[
            (source_burner, system_account(0)),
            (source.key, impostor),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidDiscriminator))],
    );
}

#[test]
fn private_transfer_rejects_undersized_account() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = funded_stealth(&mollusk, &Pubkey::new_unique(), [2u8; 32], 0);

    let mut truncated = source.account.clone();
    truncated.data.truncate(ACCOUNT_LEN - 1);

    mollusk.process_and_validate_instruction(
        &private_transfer_ix(
            &source_burner,
            &source.key,
            &destination.key,
            LAMPORTS_PER_SOL,
        ),
        &[
            (source_burner, system_account(0)),
            (source.key, truncated),
            (destination.key, destination.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::AccountDataTooSmall))],
    );
}

#[test]
fn private_transfer_requires_three_accounts() {
    let mollusk = mollusk();
    let source_burner = Pubkey::new_unique();
    let source = funded_stealth(&mollusk, &source_burner, [1u8; 32], 5 * LAMPORTS_PER_SOL);

    let mut data = vec![IX_PRIVATE_TRANSFER];
    data.extend_from_slice(&LAMPORTS_PER_SOL.to_le_bytes());

    // Only two of the three required accounts (missing the destination).
    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &data,
            vec![
                AccountMeta::new_readonly(source_burner, true),
                AccountMeta::new(source.key, false),
            ],
        ),
        &[
            (source_burner, system_account(0)),
            (source.key, source.account.clone()),
        ],
        &[Check::err(ProgramError::NotEnoughAccountKeys)],
    );
}

// ─────────────────────────────────────────────
// Withdraw
// ─────────────────────────────────────────────

#[test]
fn withdraw_moves_lamports_to_destination() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);

    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    let expected_state = stealth
        .state
        .clone()
        .deposited(3 * LAMPORTS_PER_SOL)
        .to_bytes();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &stealth.key, &destination, 2 * LAMPORTS_PER_SOL),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[
            Check::success(),
            Check::account(&stealth.key)
                .lamports(rent + 3 * LAMPORTS_PER_SOL)
                .data(&expected_state)
                .build(),
            Check::account(&destination)
                .lamports(2 * LAMPORTS_PER_SOL)
                .build(),
        ],
    );
}

#[test]
fn withdraw_of_full_balance_leaves_rent_and_preserves_owner() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);

    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    // Only `deposited_amount` moves. `owner` and `bump` must survive the drain:
    // `CloseStealthAccount` authorizes against `owner`, so clearing it here would
    // make the rent unreclaimable. `receipt_commitment` and `deposit_timestamp` are likewise
    // left intact.
    let mut expected_state = stealth.state.clone();
    expected_state.deposited_amount = 0;
    let expected_state = expected_state.to_bytes();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &stealth.key, &destination, 5 * LAMPORTS_PER_SOL),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[
            Check::success(),
            Check::account(&stealth.key)
                .lamports(rent)
                .data(&expected_state)
                .build(),
            Check::account(&destination)
                .lamports(5 * LAMPORTS_PER_SOL)
                .build(),
        ],
    );
}

#[test]
fn withdraw_requires_owner_signature() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    let mut instruction = withdraw_ix(&burner, &stealth.key, &destination, LAMPORTS_PER_SOL);
    instruction.accounts[0].is_signer = false;

    mollusk.process_and_validate_instruction(
        &instruction,
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::MissingSigner))],
    );
}

/// A signer that is not the recorded owner cannot drain someone else's stealth PDA.
#[test]
fn withdraw_rejects_non_owner_signer() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&attacker, &stealth.key, &destination, LAMPORTS_PER_SOL),
        &[
            (attacker, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[Check::err(ProgramError::IllegalOwner)],
    );
}

/// Withdraw is a base-layer-only operation; a delegated account is off limits.
#[test]
fn withdraw_rejects_delegated_account() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let (key, bump) = derive_stealth_pda(&burner);
    let state = StealthState::new(burner, [7u8; 32], bump)
        .deposited(5 * LAMPORTS_PER_SOL)
        .delegated(true);
    let destination = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &key, &destination, LAMPORTS_PER_SOL),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (
                key,
                state.to_account(stealth_rent(&mollusk) + 5 * LAMPORTS_PER_SOL),
            ),
            (destination, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::AlreadyDelegated))],
    );
}

#[test]
fn withdraw_rejects_amount_above_deposited() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &stealth.key, &destination, LAMPORTS_PER_SOL + 1),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[Check::err(ProgramError::InsufficientFunds)],
    );
}

/// The rent floor is the safety net for a `lamports` / `deposited_amount` desync:
/// here the state claims 1000 withdrawable lamports the account does not have
/// above rent, and the withdraw is refused rather than making the PDA reapable.
#[test]
fn withdraw_below_rent_exemption_is_refused() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);

    let burner = Pubkey::new_unique();
    let (key, bump) = derive_stealth_pda(&burner);
    let state = StealthState::new(burner, [7u8; 32], bump).deposited(1_000);
    let destination = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &key, &destination, 1_000),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (key, state.to_account(rent)), // rent only — no spare lamports
            (destination, system_account(0)),
        ],
        &[Check::err(shredr_err(
            ShredrError::BalanceInvariantViolation,
        ))],
    );
}

#[test]
fn withdraw_rejects_stealth_account_as_destination() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &stealth.key, &stealth.key, LAMPORTS_PER_SOL),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::SelfTransferNotAllowed))],
    );
}

#[test]
fn withdraw_rejects_non_derived_stealth_account() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let destination = Pubkey::new_unique();

    // Program-owned, correct discriminator, `owner` matches the signer — but the
    // address is not `[STEALTH_ADDRESS, burner]`. Ownership plus discriminator
    // must not be enough on their own.
    let (_, bump) = derive_stealth_pda(&burner);
    let impostor_key = Pubkey::new_unique();
    let state = StealthState::new(burner, [11u8; 32], bump).deposited(LAMPORTS_PER_SOL);
    let account = state.to_account(stealth_rent(&mollusk) + LAMPORTS_PER_SOL);

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &impostor_key, &destination, LAMPORTS_PER_SOL),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (impostor_key, account),
            (destination, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidStealthPDA))],
    );
}

#[test]
fn withdraw_rejects_zero_amount() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &stealth.key, &destination, 0),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[Check::err(ProgramError::InvalidInstructionData)],
    );
}

#[test]
fn withdraw_requires_three_accounts() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);

    let mut data = vec![IX_WITHDRAW];
    data.extend_from_slice(&LAMPORTS_PER_SOL.to_le_bytes());

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &data,
            vec![
                AccountMeta::new(burner, true),
                AccountMeta::new(stealth.key, false),
            ],
        ),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
        ],
        &[Check::err(ProgramError::NotEnoughAccountKeys)],
    );
}

// ─────────────────────────────────────────────
// CloseStealthAccount
// ─────────────────────────────────────────────

#[test]
fn close_reclaims_rent_and_returns_account_to_system() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);
    let burner = Pubkey::new_unique();
    let stealth = spent_stealth(&mollusk, &burner);
    let payee = Pubkey::new_unique();

    let result = mollusk.process_and_validate_instruction(
        &close_ix(&burner, &stealth.key, &payee),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (payee, system_account(0)),
        ],
        &[
            Check::success(),
            Check::account(&stealth.key).lamports(0).build(),
            Check::account(&payee).lamports(rent).build(),
        ],
    );

    // The rent is not merely moved — the account is handed back to the System
    // Program with no data, so it stops being an enumerable SHREDR account.
    let closed = result
        .get_account(&stealth.key)
        .expect("closed account still present in result");
    assert_eq!(closed.owner, solana_sdk_ids::system_program::ID);
    assert!(closed.data.is_empty(), "data should be truncated to zero");
}

#[test]
fn close_rejects_non_empty_account() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();

    // The interlock: an account still holding a deposit must never be closable,
    // or `Close` becomes a way to sweep user funds to an arbitrary payee.
    let stealth = funded_stealth(&mollusk, &burner, [13u8; 32], LAMPORTS_PER_SOL);
    let payee = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &close_ix(&burner, &stealth.key, &payee),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (payee, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::AccountNotEmpty))],
    );
}

#[test]
fn close_rejects_delegated_account() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let (key, bump) = derive_stealth_pda(&burner);
    let state = StealthState::new(burner, [14u8; 32], bump).delegated(true);
    let payee = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &close_ix(&burner, &key, &payee),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (key, state.to_account(stealth_rent(&mollusk))),
            (payee, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::AlreadyDelegated))],
    );
}

#[test]
fn close_rejects_delegation_program_owned_account() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = spent_stealth(&mollusk, &burner);

    // The realistic on-chain shape of a delegated PDA: the delegation program owns
    // it. Without the pre-check this would surface as the misleading
    // `InvalidProgramOwner` from `get_stealth_mut`.
    let mut account = stealth.account.clone();
    account.owner = DELEGATION_PROGRAM_ID;
    let payee = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &close_ix(&burner, &stealth.key, &payee),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, account),
            (payee, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::AlreadyDelegated))],
    );
}

#[test]
fn close_requires_owner_signature() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = spent_stealth(&mollusk, &burner);
    let payee = Pubkey::new_unique();

    let mut ix = close_ix(&burner, &stealth.key, &payee);
    ix.accounts[0].is_signer = false;

    mollusk.process_and_validate_instruction(
        &ix,
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (payee, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::MissingSigner))],
    );
}

#[test]
fn close_rejects_non_owner_signer() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = spent_stealth(&mollusk, &burner);
    let stranger = Pubkey::new_unique();
    let payee = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &close_ix(&stranger, &stealth.key, &payee),
        &[
            (stranger, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (payee, system_account(0)),
        ],
        &[Check::err(ProgramError::IllegalOwner)],
    );
}

#[test]
fn close_rejects_non_derived_stealth_account() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let (_, bump) = derive_stealth_pda(&burner);

    // Program-owned, valid discriminator, owner matches the signer — but not the
    // canonical `[STEALTH_ADDRESS, burner]` address.
    let impostor_key = Pubkey::new_unique();
    let state = StealthState::new(burner, [15u8; 32], bump);
    let payee = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &close_ix(&burner, &impostor_key, &payee),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (impostor_key, state.to_account(stealth_rent(&mollusk))),
            (payee, system_account(0)),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidStealthPDA))],
    );
}

#[test]
fn close_rejects_stealth_account_as_payee() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = spent_stealth(&mollusk, &burner);

    mollusk.process_and_validate_instruction(
        &close_ix(&burner, &stealth.key, &stealth.key),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
        ],
        &[Check::err(shredr_err(ShredrError::SelfTransferNotAllowed))],
    );
}

#[test]
fn close_requires_three_accounts() {
    let mollusk = mollusk();
    let burner = Pubkey::new_unique();
    let stealth = spent_stealth(&mollusk, &burner);

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &[IX_CLOSE_STEALTH_ACCOUNT],
            vec![
                AccountMeta::new_readonly(burner, true),
                AccountMeta::new(stealth.key, false),
            ],
        ),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
        ],
        &[Check::err(ProgramError::NotEnoughAccountKeys)],
    );
}

/// The Phase A regression: `Withdraw` used to zero `owner` on a full drain, which
/// would leave the exit PDA permanently unclosable and its rent stranded. Drain
/// it, then close it, in that order.
#[test]
fn withdraw_full_drain_leaves_account_closable() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);
    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [16u8; 32], 2 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();
    let payee = Pubkey::new_unique();

    let drained = mollusk.process_and_validate_instruction(
        &withdraw_ix(&burner, &stealth.key, &destination, 2 * LAMPORTS_PER_SOL),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, stealth.account.clone()),
            (destination, system_account(0)),
        ],
        &[Check::success()],
    );

    let drained_account = drained
        .get_account(&stealth.key)
        .expect("drained account present");

    mollusk.process_and_validate_instruction(
        &close_ix(&burner, &stealth.key, &payee),
        &[
            (burner, system_account(LAMPORTS_PER_SOL)),
            (stealth.key, drained_account.clone()),
            (payee, system_account(0)),
        ],
        &[
            Check::success(),
            Check::account(&payee).lamports(rent).build(),
        ],
    );
}

// ─────────────────────────────────────────────
// KYT attestation fixtures
//
// The program never verifies a signature — the ed25519 precompile does, and
// Mollusk does not run precompiles. So the signature below is 64 zero bytes and
// nothing here depends on it. What these fixtures do exercise is the layout the
// program parses: the offsets table, the instruction-index sentinels, and the
// message the offsets point at.
// ─────────────────────────────────────────────

/// `Ed25519SigVerify111111111111111111111111111`.
fn ed25519_program_id() -> Pubkey {
    solana_sdk_ids::ed25519_program::ID
}

/// The KYT authority compiled into *this* build of the library. All-zero when
/// `SHREDR_KYT_AUTHORITY` was unset, which is the fail-closed sentinel.
fn kyt_authority() -> [u8; 32] {
    *shredr_program::constants::KYT_ATTESTATION_AUTHORITY.as_array()
}

/// Far enough out that a test never races the clock.
fn far_future() -> i64 {
    i64::MAX / 2
}

/// Build the 90-byte attestation message the relayer signs.
fn attestation_message(
    verdict: u8,
    depositor: &Pubkey,
    burner: &Pubkey,
    max_amount: u64,
    expiry_unix: i64,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(90);
    message.extend_from_slice(b"SHREDRKY");
    message.push(1); // version
    message.push(verdict);
    message.extend_from_slice(depositor.as_ref());
    message.extend_from_slice(burner.as_ref());
    message.extend_from_slice(&max_amount.to_le_bytes());
    message.extend_from_slice(&expiry_unix.to_le_bytes());
    assert_eq!(message.len(), 90);
    message
}

/// Offsets for one signature, laid out the way `solana_sdk`'s own builder does:
/// header, then pubkey, signature and message packed in that order.
struct Ed25519Layout {
    signature_ix_index: u16,
    pubkey_ix_index: u16,
    message_ix_index: u16,
    signature_count: u8,
    /// Overrides the declared message size; `None` uses the real length.
    declared_message_size: Option<u16>,
}

impl Default for Ed25519Layout {
    fn default() -> Self {
        Self {
            signature_ix_index: u16::MAX,
            pubkey_ix_index: u16::MAX,
            message_ix_index: u16::MAX,
            signature_count: 1,
            declared_message_size: None,
        }
    }
}

fn ed25519_ix_data(authority: &[u8; 32], message: &[u8], layout: Ed25519Layout) -> Vec<u8> {
    const HEADER: u16 = 16;
    let pubkey_offset = HEADER;
    let signature_offset = pubkey_offset + 32;
    let message_offset = signature_offset + 64;

    let mut data = vec![layout.signature_count, 0];
    for field in [
        signature_offset,
        layout.signature_ix_index,
        pubkey_offset,
        layout.pubkey_ix_index,
        message_offset,
        layout
            .declared_message_size
            .unwrap_or(message.len() as u16),
        layout.message_ix_index,
    ] {
        data.extend_from_slice(&field.to_le_bytes());
    }

    data.extend_from_slice(authority);
    data.extend_from_slice(&[0u8; 64]); // the precompile's job, not ours
    data.extend_from_slice(message);
    data
}

fn ed25519_ix(authority: &[u8; 32], message: &[u8]) -> Instruction {
    Instruction::new_with_bytes(
        ed25519_program_id(),
        &ed25519_ix_data(authority, message, Ed25519Layout::default()),
        vec![],
    )
}

/// The instructions sysvar account the program introspects.
///
/// Only the ed25519 instruction is in here. A real transaction also carries the
/// deposit instruction itself, but the program scans by program id rather than
/// by position, so its presence changes nothing and threading it in would mean
/// rebuilding this after every test mutates its metas.
fn instructions_sysvar_account(instructions: &[Instruction]) -> (Pubkey, Account) {
    mollusk_svm::instructions_sysvar::keyed_account(instructions.iter())
}

// ─────────────────────────────────────────────
// InitializeAndDelegate — pre-CPI validation only
// ─────────────────────────────────────────────

struct InitAccounts {
    burner: Pubkey,
    stealth: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
    metas: Vec<AccountMeta>,
}

fn init_setup(stealth_override: Option<Pubkey>, stealth_lamports: u64) -> InitAccounts {
    init_setup_with_attestation(stealth_override, stealth_lamports, |burner| {
        vec![ed25519_ix(
            &kyt_authority(),
            &attestation_message(1, &Pubkey::new_unique(), burner, u64::MAX, far_future()),
        )]
    })
}

/// `init_setup`, but the caller decides what the instructions sysvar holds —
/// that is the only lever the KYT gate reads.
fn init_setup_with_attestation(
    stealth_override: Option<Pubkey>,
    stealth_lamports: u64,
    attestation: impl Fn(&Pubkey) -> Vec<Instruction>,
) -> InitAccounts {
    let relayer = Pubkey::new_unique();
    let burner = Pubkey::new_unique();
    let (derived, _) = derive_stealth_pda(&burner);
    let stealth = stealth_override.unwrap_or(derived);

    let owner_program = program_id();
    let permission = Pubkey::new_unique();
    let delegation_buffer = Pubkey::new_unique();
    let delegation_record = Pubkey::new_unique();
    let delegation_metadata = Pubkey::new_unique();
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();
    let (instructions_sysvar_key, instructions_sysvar_acct) =
        instructions_sysvar_account(&attestation(&burner));

    let metas = vec![
        AccountMeta::new(relayer, true),
        AccountMeta::new(burner, true),
        AccountMeta::new_readonly(owner_program, false),
        AccountMeta::new(stealth, false),
        AccountMeta::new(permission, false),
        AccountMeta::new(delegation_buffer, false),
        AccountMeta::new(delegation_record, false),
        AccountMeta::new(delegation_metadata, false),
        AccountMeta::new_readonly(system_program_key, false),
        AccountMeta::new_readonly(instructions_sysvar_key, false),
    ];

    let accounts = vec![
        (relayer, system_account(10 * LAMPORTS_PER_SOL)),
        (burner, system_account(LAMPORTS_PER_SOL)),
        (
            owner_program,
            Account {
                lamports: LAMPORTS_PER_SOL,
                data: vec![],
                owner: LOADER_V3,
                executable: true,
                rent_epoch: 0,
            },
        ),
        (stealth, system_account(stealth_lamports)),
        (permission, system_account(0)),
        (delegation_buffer, system_account(0)),
        (delegation_record, system_account(0)),
        (delegation_metadata, system_account(0)),
        (system_program_key, system_program_account),
        (instructions_sysvar_key, instructions_sysvar_acct),
    ];

    InitAccounts {
        burner,
        stealth,
        accounts,
        metas,
    }
}

fn init_ix_data(deposit_amount: u64) -> Vec<u8> {
    init_ix_data_with_role(deposit_amount, ROLE_DEPOSIT)
}

const ROLE_DEPOSIT: u8 = 1;

fn init_ix_data_with_role(deposit_amount: u64, role: u8) -> Vec<u8> {
    let mut data = vec![IX_INITIALIZE_AND_DELEGATE];
    data.extend_from_slice(&deposit_amount.to_le_bytes());
    data.push(role);
    data
}

#[test]
fn initialize_requires_relayer_signature() {
    let mollusk = mollusk();
    let mut setup = init_setup(None, 0);
    setup.metas[0].is_signer = false;

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(shredr_err(ShredrError::MissingSigner))],
    );
}

#[test]
fn initialize_requires_burner_signature() {
    let mollusk = mollusk();
    let mut setup = init_setup(None, 0);
    setup.metas[1].is_signer = false;

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(shredr_err(ShredrError::MissingSigner))],
    );
}

#[test]
fn initialize_rejects_wrong_owner_program() {
    let mollusk = mollusk();
    let mut setup = init_setup(None, 0);

    // `owner_program` reaches `delegate_account`, which uses it to derive the
    // delegation buffer's bump *and* as the owner it creates the buffer with.
    // A bump collision is only a 1-in-256 grind, so the address itself must be
    // pinned to this program.
    let impostor = Pubkey::new_unique();
    setup.metas[2].pubkey = impostor;
    setup.accounts[2].0 = impostor;

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(ProgramError::IncorrectProgramId)],
    );
}

#[test]
fn initialize_rejects_wrong_system_program() {
    let mollusk = mollusk();
    let mut setup = init_setup(None, 0);

    let impostor = Pubkey::new_unique();
    setup.metas[8].pubkey = impostor;
    setup.accounts[8] = (impostor, system_account(0));

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(ProgramError::IncorrectProgramId)],
    );
}

#[test]
fn initialize_credits_prefunded_lamports() {
    let mollusk = mollusk();

    // Someone sent to the derivable PDA address before it was initialized.
    // Those lamports used to be left uncredited, which quietly broke
    // `lamports == rent_minimum + deposited_amount` — the balance was still
    // reachable via CloseStealthAccount, just invisible to the accounting.
    let setup = init_setup(None, 3 * LAMPORTS_PER_SOL);

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
    );

    assert!(
        !matches!(
            result.raw_result,
            Err(InstructionError::Custom(6000..=6022))
        ),
        "a pre-funded PDA must still initialize; got {:?}",
        result.raw_result
    );
}

/// Every KYT rejection code. The tests below assert only that a deposit was
/// refused *by the gate*: which reason surfaces depends on the compiled-in
/// authority, and the reasons themselves are pinned by the unit tests at the
/// bottom of this file.
const KYT_ERRORS: std::ops::RangeInclusive<u32> = 6015..=6022;

#[test]
fn initialize_refuses_a_deposit_with_no_attestation() {
    let mollusk = mollusk();
    let setup = init_setup_with_attestation(None, 0, |_| vec![]);

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &init_ix_data(LAMPORTS_PER_SOL),
            setup.metas.clone(),
        ),
        &setup.accounts,
    );

    assert!(
        matches!(result.raw_result, Err(InstructionError::Custom(code)) if KYT_ERRORS.contains(&code)),
        "an unattested deposit must be refused; got {:?}",
        result.raw_result
    );
}

#[test]
fn initialize_refuses_an_attestation_for_another_burner() {
    let mollusk = mollusk();
    let stranger = Pubkey::new_unique();
    let setup = init_setup_with_attestation(None, 0, move |_| {
        vec![ed25519_ix(
            &kyt_authority(),
            &attestation_message(1, &Pubkey::new_unique(), &stranger, u64::MAX, far_future()),
        )]
    });

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &init_ix_data(LAMPORTS_PER_SOL),
            setup.metas.clone(),
        ),
        &setup.accounts,
    );

    assert!(
        matches!(result.raw_result, Err(InstructionError::Custom(code)) if KYT_ERRORS.contains(&code)),
        "an attestation bound to another burner must not clear this deposit; got {:?}",
        result.raw_result
    );
}

#[test]
fn initialize_ignores_a_non_ed25519_instruction_in_the_sysvar() {
    let mollusk = mollusk();

    // Same bytes, wrong program: the precompile never ran, so nothing verified
    // this signature and the scan must skip it rather than read it.
    let setup = init_setup_with_attestation(None, 0, |burner| {
        let message =
            attestation_message(1, &Pubkey::new_unique(), burner, u64::MAX, far_future());
        vec![Instruction::new_with_bytes(
            Pubkey::new_unique(),
            &ed25519_ix_data(&kyt_authority(), &message, Ed25519Layout::default()),
            vec![],
        )]
    });

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &init_ix_data(LAMPORTS_PER_SOL),
            setup.metas.clone(),
        ),
        &setup.accounts,
    );

    assert!(
        matches!(result.raw_result, Err(InstructionError::Custom(code)) if KYT_ERRORS.contains(&code)),
        "an attestation not verified by the precompile must be ignored; got {:?}",
        result.raw_result
    );
}

#[test]
fn initialize_rejects_unknown_role() {
    let mollusk = mollusk();
    let setup = init_setup(None, 0);

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &init_ix_data_with_role(0, 3),
            setup.metas.clone(),
        ),
        &setup.accounts,
        &[Check::err(ProgramError::InvalidInstructionData)],
    );
}

#[test]
fn initialize_requires_deposit_amount_bytes() {
    let mollusk = mollusk();
    let setup = init_setup(None, 0);

    let mut short = init_ix_data(0);
    short.truncate(8); // discriminator + 7 payload bytes (one short of the 8-byte deposit_amount)

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &short, setup.metas.clone()),
        &setup.accounts,
        &[Check::err(ProgramError::InvalidInstructionData)],
    );
}

/// The commitment is appended after the role byte, so only three data lengths
/// are meaningful: 8 (legacy), 9 (+role), 41 (+role+commitment). Anything else
/// is a client bug, and guessing at its shape would be worse than refusing it.
#[test]
fn initialize_rejects_partial_commitment() {
    let mollusk = mollusk();

    for extra in [1usize, 31, 33] {
        let setup = init_setup(None, 0);
        let mut data = init_ix_data_with_role(0, ROLE_DEPOSIT);
        data.extend_from_slice(&vec![0xABu8; extra]);

        mollusk.process_and_validate_instruction(
            &Instruction::new_with_bytes(program_id(), &data, setup.metas.clone()),
            &setup.accounts,
            &[Check::err(ProgramError::InvalidInstructionData)],
        );
    }
}

/// A 41-byte payload stores the commitment verbatim. The program never reads
/// the field, so "stored unchanged" is the whole contract.
///
/// Needs the vendored MagicBlock ELFs, because `InitializeAndDelegate` cannot
/// run to completion without them — every other test in this file stops at the
/// unresolvable ACL CPI, and a failed instruction rolls the state write back.
#[test]
fn initialize_stores_receipt_commitment() {
    let mollusk = mollusk_with_magicblock();
    let setup = init_setup_delegatable();

    let commitment: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(3));
    let mut data = init_ix_data_with_role(0, ROLE_DEPOSIT);
    data.extend_from_slice(&commitment);

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(program_id(), &data, setup.metas.clone()),
        &setup.accounts,
    );
    assert!(
        result.raw_result.is_ok(),
        "initialize must succeed with the MagicBlock fixtures loaded; got {:?}",
        result.raw_result
    );

    let stealth = result
        .get_account(&setup.metas[3].pubkey)
        .expect("stealth account");
    assert_eq!(
        &stealth.data[OFF_RECEIPT_COMMITMENT..OFF_RECEIPT_COMMITMENT + 32],
        &commitment,
        "commitment must be stored byte-for-byte"
    );
}

/// A `mollusk()` with the MagicBlock delegation and ACL programs loaded, so
/// `InitializeAndDelegate` can run all the way through its CPIs. Kept separate
/// from `mollusk()` because most tests here rely on the CPI being unresolvable
/// to prove they reached it.
fn mollusk_with_magicblock() -> Mollusk {
    let mut mollusk = mollusk();
    mollusk.add_program_with_loader_and_elf(
        &DELEGATION_PROGRAM_ID,
        &LOADER_V3,
        &fixture_elf("delegation_program.so"),
    );
    mollusk.add_program_with_loader_and_elf(
        &PERMISSION_PROGRAM_ID,
        &LOADER_V3,
        &fixture_elf("permission_program.so"),
    );
    mollusk
}

/// The MagicBlock ACL program that guards in-rollup access.
const PERMISSION_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

fn fixture_elf(file_name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(file_name);
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!("{path:?} missing. Run `scripts/dump-magicblock-programs.sh`.")
    })
}

/// `init_setup` with the real delegation PDAs and both CPI callees appended, so
/// the instruction can actually delegate.
fn init_setup_delegatable() -> InitAccounts {
    let mut setup = init_setup(None, 0);
    let stealth = setup.metas[3].pubkey;

    let delegation_program = DELEGATION_PROGRAM_ID;
    let permission_program = PERMISSION_PROGRAM_ID;

    // The SDK derives these; a random pubkey is rejected once the real program
    // is the one checking.
    let (permission, _) =
        Pubkey::find_program_address(&[b"permission:", stealth.as_ref()], &permission_program);
    let (buffer, _) = Pubkey::find_program_address(&[b"buffer", stealth.as_ref()], &program_id());
    let (record, _) =
        Pubkey::find_program_address(&[b"delegation", stealth.as_ref()], &delegation_program);
    let (metadata, _) = Pubkey::find_program_address(
        &[b"delegation-metadata", stealth.as_ref()],
        &delegation_program,
    );

    for (idx, key) in [(4, permission), (5, buffer), (6, record), (7, metadata)] {
        setup.metas[idx].pubkey = key;
        setup.accounts[idx] = (key, system_account(0));
    }

    // Solana resolves a CPI's callee from the transaction's account keys, so
    // both programs `process` invokes must appear. `try_from` reads exactly nine
    // accounts positionally and ignores these.
    setup
        .metas
        .push(AccountMeta::new_readonly(permission_program, false));
    setup
        .metas
        .push(AccountMeta::new_readonly(delegation_program, false));
    setup.accounts.push((
        permission_program,
        create_program_account_loader_v3(&permission_program),
    ));
    setup.accounts.push((
        delegation_program,
        create_program_account_loader_v3(&delegation_program),
    ));

    setup
}

/// Clients that predate the field keep working, and leave whatever the account
/// already held rather than zeroing it.
#[test]
fn initialize_without_commitment_still_works() {
    let mollusk = mollusk();

    for data in [init_ix_data(0), init_ix_data_with_role(0, ROLE_DEPOSIT)] {
        let setup = init_setup(None, 0);
        let result = mollusk.process_instruction(
            &Instruction::new_with_bytes(program_id(), &data, setup.metas.clone()),
            &setup.accounts,
        );

        assert!(
            !matches!(
                result.raw_result,
                Err(InstructionError::Custom(6000..=6014))
            ),
            "the shorter forms must stay valid; got {:?}",
            result.raw_result
        );
    }
}

#[test]
fn initialize_requires_nine_accounts() {
    let mollusk = mollusk();
    let setup = init_setup(None, 0);

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas[..8].to_vec()),
        &setup.accounts[..8],
        &[Check::err(ProgramError::NotEnoughAccountKeys)],
    );
}

/// An attacker-supplied account that is not the canonical `[seed, burner]` PDA
/// must be rejected before any lamports are spent on it.
#[test]
fn initialize_rejects_wrong_pda() {
    let mollusk = mollusk();
    let setup = init_setup(Some(Pubkey::new_unique()), 0);

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(shredr_err(ShredrError::InvalidStealthPDA))],
    );
}

/// Replace the freshly-created stealth account with one that already exists:
/// program-owned, discriminator written, carrying prior state. This is the shape
/// a PDA has after `CommitAndUndelegateStealth` + `Withdraw`.
/// `owner: None` means the account's own burner — the normal reuse case.
fn init_setup_reused(
    mollusk: &Mollusk,
    owner: Option<Pubkey>,
    deposited: u64,
    delegated: bool,
) -> InitAccounts {
    let mut setup = init_setup(None, 0);
    let (_, bump) = derive_stealth_pda(&setup.burner);
    let state = StealthState::new(owner.unwrap_or(setup.burner), [0u8; 32], bump)
        .deposited(deposited)
        .delegated(delegated);
    setup.accounts[3].1 = state.to_account(stealth_rent(mollusk) + deposited);
    setup
}

/// A stealth PDA outlives its first cycle, so a second `InitializeAndDelegate`
/// must reuse it rather than refuse it — this is what lets a burner take another
/// deposit and the main PDA be re-delegated for the next round. Reaching the
/// unresolvable ACL CPI proves the reuse branch let it through.
#[test]
fn initialize_reuses_undelegated_account() {
    let mollusk = mollusk();
    let setup = init_setup_reused(&mollusk, None, 0, false);

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
    );

    assert!(
        !matches!(
            result.raw_result,
            Err(InstructionError::Custom(6000..=6011))
        ),
        "reuse must not be blocked by a SHREDR check, got {:?}",
        result.raw_result,
    );
}

/// A PDA still delegated cannot be delegated again.
#[test]
fn initialize_rejects_delegated_account() {
    let mollusk = mollusk();
    let setup = init_setup_reused(&mollusk, None, LAMPORTS_PER_SOL, true);

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(shredr_err(ShredrError::AlreadyDelegated))],
    );
}

/// A zeroed `owner` must still be reusable by the burner the PDA derives from.
///
/// `Withdraw` preserves `owner` on a full drain now, so this is the legacy shape
/// rather than one the current program produces — accounts drained by the older
/// build are still out there and must keep working.
#[test]
fn initialize_reuses_fully_drained_account() {
    let mollusk = mollusk();
    let setup = init_setup_reused(&mollusk, Some(Pubkey::default()), 0, false);

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
    );

    assert!(
        !matches!(
            result.raw_result,
            Err(InstructionError::Custom(6000..=6011))
        ),
        "drained account must be reusable, got {:?}",
        result.raw_result,
    );
}

/// Reuse is only for the account's own burner (or a fully-drained account, whose
/// `owner` `Withdraw` has zeroed). Someone else's live PDA stays off limits.
#[test]
fn initialize_rejects_reuse_by_another_burner() {
    let mollusk = mollusk();
    let setup = init_setup_reused(
        &mollusk,
        Some(Pubkey::new_unique()),
        LAMPORTS_PER_SOL,
        false,
    );

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(ProgramError::IllegalOwner)],
    );
}

/// With every SHREDR-side check satisfied, execution reaches the ACL permission
/// CPI, which cannot resolve here because the MagicBlock programs are not loaded
/// into the harness. Asserting only that no SHREDR error surfaces still proves
/// PDA derivation, the System `CreateAccount` CPI, and the burner→PDA deposit
/// `Transfer` (a non-zero `deposit_amount` is passed) all went through.
#[test]
fn initialize_clears_program_validation_before_cpi() {
    let mollusk = mollusk();
    let setup = init_setup(None, 0);

    // Burner is funded with 1 SOL in `init_setup`; sweep half of it into the PDA.
    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &init_ix_data(LAMPORTS_PER_SOL / 2),
            setup.metas.clone(),
        ),
        &setup.accounts,
    );

    // The stealth PDA is the canonical derivation, so validation cannot have
    // been what stopped it.
    assert_eq!(setup.stealth, derive_stealth_pda(&setup.burner).0);
    assert!(
        !matches!(
            result.raw_result,
            Err(InstructionError::Custom(6000..=6014))
        ),
        "expected failure to come from the missing MagicBlock/ACL programs, \
         not from SHREDR validation; got {:?}",
        result.raw_result
    );
}

#[test]
fn initialize_survives_prefunded_stealth_pda() {
    let mollusk = mollusk();

    // Anyone can send lamports to a stealth PDA, and the address is derivable
    // from the burner pubkey. One lamport sent ahead of initialization must not
    // be able to brick the address: keying "already initialized" off the balance
    // would skip account creation and then fail as system-owned forever.
    let setup = init_setup(None, 1);

    let result = mollusk.process_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &init_ix_data(LAMPORTS_PER_SOL / 2),
            setup.metas.clone(),
        ),
        &setup.accounts,
    );

    assert_eq!(setup.stealth, derive_stealth_pda(&setup.burner).0);
    assert!(
        !matches!(
            result.raw_result,
            Err(InstructionError::Custom(6000..=6014))
        ),
        "a pre-funded stealth PDA must still initialize (failure should come from \
         the missing MagicBlock/ACL programs); got {:?}",
        result.raw_result
    );
}

// ─────────────────────────────────────────────
// Commit / undelegate — pre-CPI validation only
// ─────────────────────────────────────────────

fn commit_metas(relayer: &Pubkey, stealth: &Pubkey) -> (Vec<AccountMeta>, Vec<(Pubkey, Account)>) {
    let magic_program = Pubkey::new_unique();
    let magic_context = Pubkey::new_unique();

    (
        vec![
            AccountMeta::new(*relayer, true),
            AccountMeta::new(*stealth, false),
            AccountMeta::new_readonly(magic_program, false),
            AccountMeta::new(magic_context, false),
        ],
        vec![
            (*relayer, system_account(LAMPORTS_PER_SOL)),
            (magic_program, system_account(0)),
            (magic_context, system_account(0)),
        ],
    )
}

#[test]
fn commit_requires_relayer_signature() {
    let mollusk = mollusk();
    let relayer = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &Pubkey::new_unique(), [3u8; 32], LAMPORTS_PER_SOL);

    for discriminator in [IX_COMMIT_STEALTH, IX_COMMIT_AND_UNDELEGATE_STEALTH] {
        let (mut metas, mut accounts) = commit_metas(&relayer, &stealth.key);
        metas[0].is_signer = false;
        accounts.insert(1, (stealth.key, stealth.account.clone()));

        mollusk.process_and_validate_instruction(
            &Instruction::new_with_bytes(program_id(), &[discriminator], metas),
            &accounts,
            &[Check::err(ProgramError::MissingRequiredSignature)],
        );
    }
}

#[test]
fn commit_requires_four_accounts() {
    let mollusk = mollusk();
    let relayer = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &Pubkey::new_unique(), [3u8; 32], LAMPORTS_PER_SOL);

    for discriminator in [IX_COMMIT_STEALTH, IX_COMMIT_AND_UNDELEGATE_STEALTH] {
        let (metas, mut accounts) = commit_metas(&relayer, &stealth.key);
        accounts.insert(1, (stealth.key, stealth.account.clone()));

        mollusk.process_and_validate_instruction(
            &Instruction::new_with_bytes(program_id(), &[discriminator], metas[..3].to_vec()),
            &accounts[..3],
            &[Check::err(ProgramError::NotEnoughAccountKeys)],
        );
    }
}

#[test]
fn undelegation_callback_requires_four_accounts() {
    let mollusk = mollusk();
    let stealth = funded_stealth(&mollusk, &Pubkey::new_unique(), [4u8; 32], LAMPORTS_PER_SOL);
    let buffer = Pubkey::new_unique();

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &[IX_UNDELEGATION_CALLBACK],
            vec![
                AccountMeta::new(stealth.key, false),
                AccountMeta::new(buffer, false),
            ],
        ),
        &[
            (stealth.key, stealth.account.clone()),
            (buffer, system_account(0)),
        ],
        &[Check::err(ProgramError::NotEnoughAccountKeys)],
    );
}

/// The MagicBlock delegation program.
const DELEGATION_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/// The delegation program's undelegation buffer for a delegated account:
/// `["undelegate-buffer", delegated]` derived from the *delegation program*.
/// Only that program can sign for this address, which is what authorizes the
/// callback.
fn derive_undelegate_buffer(delegated: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"undelegate-buffer", delegated.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0
}

#[test]
fn undelegation_callback_rejects_foreign_buffer() {
    let mollusk = mollusk();
    let stealth = funded_stealth(&mollusk, &Pubkey::new_unique(), [4u8; 32], LAMPORTS_PER_SOL);

    // An attacker-controlled keypair, signing. `undelegate` only checks
    // `is_signer`, and takes the seeds of the account it re-creates from
    // `ix_data` — so without the address check this would let anyone mint a
    // program-owned PDA holding state of their choosing.
    let rogue_buffer = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &[IX_UNDELEGATION_CALLBACK],
            vec![
                AccountMeta::new(stealth.key, false),
                AccountMeta::new(rogue_buffer, true),
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(system_program_key, false),
            ],
        ),
        &[
            (stealth.key, stealth.account.clone()),
            (rogue_buffer, system_account(LAMPORTS_PER_SOL)),
            (payer, system_account(LAMPORTS_PER_SOL)),
            (system_program_key, system_program_account),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidBufferAccount))],
    );
}

#[test]
fn undelegation_callback_requires_buffer_signature() {
    let mollusk = mollusk();
    let stealth = funded_stealth(&mollusk, &Pubkey::new_unique(), [5u8; 32], LAMPORTS_PER_SOL);

    // Right address, but not signing — the address alone proves nothing.
    let buffer = derive_undelegate_buffer(&stealth.key);
    let payer = Pubkey::new_unique();
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &[IX_UNDELEGATION_CALLBACK],
            vec![
                AccountMeta::new(stealth.key, false),
                AccountMeta::new(buffer, false),
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(system_program_key, false),
            ],
        ),
        &[
            (stealth.key, stealth.account.clone()),
            (buffer, system_account(0)),
            (payer, system_account(LAMPORTS_PER_SOL)),
            (system_program_key, system_program_account),
        ],
        &[Check::err(shredr_err(ShredrError::MissingSigner))],
    );
}

// ─────────────────────────────────────────────
// KYT attestation parsing and policy
//
// These call the library directly rather than through Mollusk: the compiled-in
// authority is irrelevant here, so every branch runs on a plain `cargo test`.
// ─────────────────────────────────────────────

use shredr_program::kyt::{attested_message, check_attestation};

fn shredr_code(error: ShredrError) -> ProgramError {
    ProgramError::Custom(error as u32)
}

/// A well-formed blob and the message inside it, for the authority given.
fn attestation_fixture(burner: &Pubkey) -> ([u8; 32], Vec<u8>, Vec<u8>) {
    let authority = Pubkey::new_unique().to_bytes();
    let message = attestation_message(1, &Pubkey::new_unique(), burner, LAMPORTS_PER_SOL, far_future());
    let blob = ed25519_ix_data(&authority, &message, Ed25519Layout::default());
    (authority, message, blob)
}

#[test]
fn attested_message_returns_the_signed_bytes() {
    let burner = Pubkey::new_unique();
    let (authority, message, blob) = attestation_fixture(&burner);

    assert_eq!(attested_message(&blob, &authority).unwrap(), &message[..]);
}

#[test]
fn attested_message_rejects_another_authority() {
    let burner = Pubkey::new_unique();
    let (_, _, blob) = attestation_fixture(&burner);

    assert_eq!(
        attested_message(&blob, &Pubkey::new_unique().to_bytes()),
        Err(shredr_code(ShredrError::KytUnknownAuthority))
    );
}

#[test]
fn attested_message_rejects_offsets_into_another_instruction() {
    // The precompile can be told to read its pubkey, signature or message from a
    // different instruction in the transaction. Then the bytes sitting in this
    // blob are not the bytes it verified, and reading them back would be a
    // forgery with extra steps.
    let burner = Pubkey::new_unique();
    let authority = Pubkey::new_unique().to_bytes();
    let message =
        attestation_message(1, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());

    for layout in [
        Ed25519Layout {
            message_ix_index: 0,
            ..Default::default()
        },
        Ed25519Layout {
            pubkey_ix_index: 0,
            ..Default::default()
        },
        Ed25519Layout {
            signature_ix_index: 0,
            ..Default::default()
        },
    ] {
        let blob = ed25519_ix_data(&authority, &message, layout);
        assert_eq!(
            attested_message(&blob, &authority),
            Err(shredr_code(ShredrError::KytAttestationMalformed))
        );
    }
}

#[test]
fn attested_message_rejects_extra_signatures() {
    // Only the first offsets entry is read, so a blob claiming more would carry
    // signatures nobody looked at.
    let burner = Pubkey::new_unique();
    let authority = Pubkey::new_unique().to_bytes();
    let message =
        attestation_message(1, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());
    let blob = ed25519_ix_data(
        &authority,
        &message,
        Ed25519Layout {
            signature_count: 2,
            ..Default::default()
        },
    );

    assert_eq!(
        attested_message(&blob, &authority),
        Err(shredr_code(ShredrError::KytAttestationMalformed))
    );
}

#[test]
fn attested_message_rejects_offsets_past_the_end() {
    let burner = Pubkey::new_unique();
    let authority = Pubkey::new_unique().to_bytes();
    let message =
        attestation_message(1, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());

    // Declares a 90-byte message but carries none of it.
    let mut truncated = ed25519_ix_data(&authority, &message, Ed25519Layout::default());
    truncated.truncate(112);
    assert_eq!(
        attested_message(&truncated, &authority),
        Err(shredr_code(ShredrError::KytAttestationMalformed))
    );

    // A size the program does not accept, whatever the blob holds.
    let wrong_size = ed25519_ix_data(
        &authority,
        &message,
        Ed25519Layout {
            declared_message_size: Some(64),
            ..Default::default()
        },
    );
    assert_eq!(
        attested_message(&wrong_size, &authority),
        Err(shredr_code(ShredrError::KytAttestationMalformed))
    );

    assert_eq!(
        attested_message(&[], &authority),
        Err(shredr_code(ShredrError::KytAttestationMalformed))
    );
}

#[test]
fn check_attestation_clears_a_matching_deposit() {
    let burner = Pubkey::new_unique();
    let message =
        attestation_message(1, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());

    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), None, LAMPORTS_PER_SOL, 0),
        Ok(())
    );
}

#[test]
fn check_attestation_enforces_the_binding_and_the_ceiling() {
    let burner = Pubkey::new_unique();
    let expiry = 1_800_000_000;
    let message =
        attestation_message(1, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, expiry);

    assert_eq!(
        check_attestation(&message, &Pubkey::new_unique().to_bytes(), None, 1, 0),
        Err(shredr_code(ShredrError::KytAttestationBurnerMismatch))
    );
    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), None, LAMPORTS_PER_SOL + 1, 0),
        Err(shredr_code(ShredrError::KytAttestationAmountExceeded))
    );
    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), None, 1, expiry + 1),
        Err(shredr_code(ShredrError::KytAttestationExpired))
    );
    // Inclusive: an attestation is good through its expiry second.
    assert_eq!(check_attestation(&message, &burner.to_bytes(), None, 1, expiry), Ok(()));
}

#[test]
fn check_attestation_refuses_a_screened_out_depositor() {
    let burner = Pubkey::new_unique();
    let message =
        attestation_message(0, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());

    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), None, 1, 0),
        Err(shredr_code(ShredrError::KytScreeningRejected))
    );
}

#[test]
fn check_attestation_rejects_a_foreign_envelope() {
    let burner = Pubkey::new_unique();
    let good =
        attestation_message(1, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());

    // Magic: the authority signs other things, and none of them are deposits.
    let mut wrong_magic = good.clone();
    wrong_magic[..8].copy_from_slice(b"NOTSHRED");

    // Version: a future layout means these offsets read different fields.
    let mut wrong_version = good.clone();
    wrong_version[8] = 2;

    let mut short = good.clone();
    short.truncate(89);

    for message in [wrong_magic, wrong_version, short] {
        assert_eq!(
            check_attestation(&message, &burner.to_bytes(), None, 1, 0),
            Err(shredr_code(ShredrError::KytAttestationMalformed))
        );
    }
}

// ─────────────────────────────────────────────
// Shielded pool
//
// The pool's accounts are built here byte by byte rather than through
// `InitializePool`, so a test can start mid-epoch or with a note already spent
// without replaying the instructions that got it there. `pool_layout_is_stable`
// is what keeps these offsets honest.
// ─────────────────────────────────────────────

use sha2::{Digest, Sha256};
use shredr_program::{
    constants::{DENOMINATIONS, MIN_EPOCH_SECS},
    merkle, note,
    state::{
        PoolLedger, PoolVault, NULLIFIER_RECORD_LEN, PAYOUT_QUEUE_CAP, POOL_LEDGER_SIZE,
        POOL_VAULT_SIZE, ROOT_HISTORY_CAP,
    },
};

const DENOM: u64 = DENOMINATIONS[0];

const VAULT_LEN: usize = 8 + POOL_VAULT_SIZE;
const LEDGER_LEN: usize = 8 + POOL_LEDGER_SIZE;

// PoolVault
const V_DENOMINATION: usize = 8;
const V_TOTAL_DEPOSITED: usize = 16;
const V_TOTAL_SETTLED: usize = 24;
const V_EPOCH: usize = 32;
const V_LAST_EPOCH_AT: usize = 40;
const V_NEXT_LEAF_INDEX: usize = 48;
const V_BUMP: usize = 56;
const V_ROOT: usize = 64;
const V_FILLED_SUBTREES: usize = 96;

// PoolLedger
const L_DENOMINATION: usize = 8;
const L_EPOCH: usize = 16;
const L_ROOT_COUNT: usize = 24;
const L_ROOT_CURSOR: usize = 28;
const L_PAYOUT_COUNT: usize = 32;
const L_BUMP: usize = 36;
const L_DELEGATED: usize = 37;
const L_ROOTS: usize = 40;
const L_PAYOUTS: usize = L_ROOTS + ROOT_HISTORY_CAP * 32;

/// Pins the `#[repr(C)]` layout the program casts to, so a field reorder breaks
/// here instead of silently corrupting every fixture below.
#[test]
fn pool_layout_is_stable() {
    assert_eq!(V_FILLED_SUBTREES - 8 + merkle::DEPTH * 32, POOL_VAULT_SIZE);
    assert_eq!(L_PAYOUTS - 8 + PAYOUT_QUEUE_CAP * 64, POOL_LEDGER_SIZE);

    let vault: Box<PoolVault> = Box::new(unsafe { core::mem::zeroed() });
    let base = vault.as_ref() as *const _ as usize;
    let at = |field: *const u8| field as usize - base + 8;

    assert_eq!(at(&vault.denomination as *const _ as *const u8), V_DENOMINATION);
    assert_eq!(at(&vault.total_deposited as *const _ as *const u8), V_TOTAL_DEPOSITED);
    assert_eq!(at(&vault.total_settled as *const _ as *const u8), V_TOTAL_SETTLED);
    assert_eq!(at(&vault.epoch as *const _ as *const u8), V_EPOCH);
    assert_eq!(at(&vault.last_epoch_at as *const _ as *const u8), V_LAST_EPOCH_AT);
    assert_eq!(at(&vault.next_leaf_index as *const _ as *const u8), V_NEXT_LEAF_INDEX);
    assert_eq!(at(&vault.bump as *const _ as *const u8), V_BUMP);
    assert_eq!(at(&vault.root as *const _ as *const u8), V_ROOT);
    assert_eq!(at(&vault.filled_subtrees as *const _ as *const u8), V_FILLED_SUBTREES);

    let ledger: Box<PoolLedger> = Box::new(unsafe { core::mem::zeroed() });
    let base = ledger.as_ref() as *const _ as usize;
    let at = |field: *const u8| field as usize - base + 8;

    assert_eq!(at(&ledger.denomination as *const _ as *const u8), L_DENOMINATION);
    assert_eq!(at(&ledger.epoch as *const _ as *const u8), L_EPOCH);
    assert_eq!(at(&ledger.root_count as *const _ as *const u8), L_ROOT_COUNT);
    assert_eq!(at(&ledger.root_cursor as *const _ as *const u8), L_ROOT_CURSOR);
    assert_eq!(at(&ledger.payout_count as *const _ as *const u8), L_PAYOUT_COUNT);
    assert_eq!(at(&ledger.bump as *const _ as *const u8), L_BUMP);
    assert_eq!(at(&ledger.delegated as *const _ as *const u8), L_DELEGATED);
    assert_eq!(at(&ledger.roots as *const _ as *const u8), L_ROOTS);
    assert_eq!(at(&ledger.payouts as *const _ as *const u8), L_PAYOUTS);
}

/// The pool's privacy claim in one assertion: given a commitment you cannot
/// recognise its nullifier, because the two are images of the same secret under
/// different domain tags.
#[test]
fn commitment_and_nullifier_are_unlinkable_without_the_secret() {
    let secret = [42u8; 32];

    assert_eq!(note::commitment(&secret), note::commitment(&secret));
    assert_ne!(note::commitment(&secret), note::nullifier(&secret));
    assert_ne!(note::commitment(&secret), note::commitment(&[43u8; 32]));
    assert_ne!(note::nullifier(&secret), note::nullifier(&[43u8; 32]));
}

// ─────────────────────────────────────────────
// Merkle tree
//
// `TestTree` is a plain, obviously-correct tree: it holds every leaf and hashes
// the whole thing on demand. The program's incremental construction keeps only
// `DEPTH` nodes and never sees the leaves again, so the tests below are worth
// having precisely because the two implementations share no code.
// ─────────────────────────────────────────────

fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

/// Hash of an empty subtree at `level`, where `DEPTH` is the root.
fn zero_at(level: usize) -> [u8; 32] {
    if level < merkle::DEPTH {
        merkle::ZEROS[level]
    } else {
        merkle::empty_root()
    }
}

#[derive(Default)]
struct TestTree {
    leaves: Vec<[u8; 32]>,
}

impl TestTree {
    fn push(&mut self, leaf: [u8; 32]) -> u64 {
        self.leaves.push(leaf);
        self.leaves.len() as u64 - 1
    }

    fn node(&self, level: usize, index: usize) -> [u8; 32] {
        // Everything past the last leaf is empty by definition, which is also
        // what keeps this from walking 2^20 nodes.
        if (index << level) >= self.leaves.len() {
            return zero_at(level);
        }
        if level == 0 {
            return self.leaves[index];
        }
        hash_pair(
            &self.node(level - 1, index * 2),
            &self.node(level - 1, index * 2 + 1),
        )
    }

    fn root(&self) -> [u8; 32] {
        self.node(merkle::DEPTH, 0)
    }

    fn path(&self, leaf_index: u64) -> [[u8; 32]; merkle::DEPTH] {
        let mut path = [[0u8; 32]; merkle::DEPTH];
        for (level, sibling) in path.iter_mut().enumerate() {
            *sibling = self.node(level, ((leaf_index as usize) >> level) ^ 1);
        }
        path
    }
}

/// The constants are a compile-time table; this is the recurrence they came
/// from. If someone changes `DEPTH` and forgets to regenerate them, the tree
/// silently accepts paths against the wrong empty subtrees.
#[test]
fn zeros_are_the_empty_subtree_hashes() {
    let mut expected: [u8; 32] = Sha256::digest(b"SHREDR_EMPTY_LEAF_V1").into();

    for level in 0..merkle::DEPTH {
        assert_eq!(merkle::ZEROS[level], expected, "ZEROS[{level}]");
        expected = hash_pair(&expected, &expected);
    }

    assert_eq!(merkle::empty_root(), expected);
}

/// The incremental insert and a full recompute must agree at every size, and a
/// path taken from one must verify against the other. This is the load-bearing
/// test of the whole pool: if these two ever disagree, deposits become
/// unspendable.
#[test]
fn incremental_inserts_match_a_full_recompute() {
    let mut filled = merkle::ZEROS;
    let mut tree = TestTree::default();

    assert_eq!(tree.root(), merkle::empty_root(), "an empty tree");

    // Deliberately odd count: the incremental and recomputed trees only differ
    // on how they treat the unfilled right-hand side, so an even number of
    // leaves would hide exactly the bug worth catching.
    for i in 0u64..9 {
        let leaf = note::commitment(&[i as u8; 32]);
        let index = tree.push(leaf);

        let incremental = merkle::insert(&mut filled, index, &leaf).expect("insert");

        assert_eq!(incremental, tree.root(), "root after leaf {i}");
        assert_eq!(
            merkle::root_from_path(&leaf, index, &tree.path(index)),
            incremental,
            "path for leaf {i} must reach the root the insert produced"
        );
    }

    // Every earlier leaf must still verify against the newest root — otherwise
    // only the most recent depositor could ever withdraw.
    let root = tree.root();
    for i in 0u64..9 {
        let leaf = note::commitment(&[i as u8; 32]);
        assert_eq!(merkle::root_from_path(&leaf, i, &tree.path(i)), root);
    }
}

#[test]
fn a_path_for_the_wrong_leaf_reaches_a_different_root() {
    let mut tree = TestTree::default();
    for i in 0u64..4 {
        tree.push(note::commitment(&[i as u8; 32]));
    }

    let forged = note::commitment(&[99u8; 32]);
    assert_ne!(
        merkle::root_from_path(&forged, 0, &tree.path(0)),
        tree.root(),
        "a note that was never deposited must not verify"
    );
}

// ─────────────────────────────────────────────
// Pool fixtures
// ─────────────────────────────────────────────

fn pool_vault_pda(denomination: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"shredr_pool_vault", &denomination.to_le_bytes()],
        &program_id(),
    )
}

fn pool_ledger_pda(denomination: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"shredr_pool_ledger", &denomination.to_le_bytes()],
        &program_id(),
    )
}

fn nullifier_record_pda(nullifier: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"shredr_nullifier", nullifier], &program_id())
}

fn rent_exempt(len: usize) -> u64 {
    mollusk().sysvars.rent.minimum_balance(len)
}

/// What each deposit leaves behind to fund its note's eventual nullifier record.
fn record_rent() -> u64 {
    rent_exempt(NULLIFIER_RECORD_LEN)
}

struct PoolSetup {
    vault: Pubkey,
    ledger: Pubkey,
    vault_account: Account,
    ledger_account: Account,
}

/// An initialized pool holding `deposited` lamports of backing, plus the record
/// rent those deposits would have left behind, so settle tests do not have to
/// walk deposits in first.
fn pool_setup(deposited: u64, last_epoch_at: i64) -> PoolSetup {
    let (vault, vault_bump) = pool_vault_pda(DENOM);
    let (ledger, ledger_bump) = pool_ledger_pda(DENOM);
    let notes = deposited / DENOM;

    let mut vault_data = vec![0u8; VAULT_LEN];
    vault_data[0..8].copy_from_slice(b"SHREDRPV");
    vault_data[V_DENOMINATION..V_DENOMINATION + 8].copy_from_slice(&DENOM.to_le_bytes());
    vault_data[V_TOTAL_DEPOSITED..V_TOTAL_DEPOSITED + 8].copy_from_slice(&deposited.to_le_bytes());
    vault_data[V_LAST_EPOCH_AT..V_LAST_EPOCH_AT + 8].copy_from_slice(&last_epoch_at.to_le_bytes());
    vault_data[V_BUMP] = vault_bump;
    vault_data[V_ROOT..V_ROOT + 32].copy_from_slice(&merkle::empty_root());
    for (level, zero) in merkle::ZEROS.iter().enumerate() {
        let start = V_FILLED_SUBTREES + level * 32;
        vault_data[start..start + 32].copy_from_slice(zero);
    }

    let mut ledger_data = vec![0u8; LEDGER_LEN];
    ledger_data[0..8].copy_from_slice(b"SHREDRPL");
    ledger_data[L_DENOMINATION..L_DENOMINATION + 8].copy_from_slice(&DENOM.to_le_bytes());
    ledger_data[L_BUMP] = ledger_bump;

    PoolSetup {
        vault,
        ledger,
        vault_account: Account {
            lamports: rent_exempt(VAULT_LEN) + deposited + notes * record_rent(),
            data: vault_data,
            owner: program_id(),
            executable: false,
            rent_epoch: 0,
        },
        ledger_account: Account {
            lamports: rent_exempt(LEDGER_LEN),
            data: ledger_data,
            owner: program_id(),
            executable: false,
            rent_epoch: 0,
        },
    }
}

fn set_u32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

/// Publish `root` so spends may prove against it.
fn publish_root(ledger: &mut Account, root: &[u8; 32]) {
    let count = u32::from_le_bytes(
        ledger.data[L_ROOT_COUNT..L_ROOT_COUNT + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    let start = L_ROOTS + count * 32;
    ledger.data[start..start + 32].copy_from_slice(root);
    set_u32(&mut ledger.data, L_ROOT_COUNT, count as u32 + 1);
    set_u32(&mut ledger.data, L_ROOT_CURSOR, count as u32 + 1);
}

fn set_delegated(ledger: &mut Account, delegated: bool) {
    ledger.data[L_DELEGATED] = delegated as u8;
}

/// A delegated ledger holding `secrets` as spendable notes, and the tree that
/// produces their paths.
fn spendable_pool(secrets: &[[u8; 32]]) -> (PoolSetup, TestTree) {
    let mut setup = pool_setup(DENOM * secrets.len() as u64, 0);
    let mut tree = TestTree::default();

    for secret in secrets {
        tree.push(note::commitment(secret));
    }

    publish_root(&mut setup.ledger_account, &tree.root());
    set_delegated(&mut setup.ledger_account, true);

    (setup, tree)
}

fn spend_instruction(
    setup: &PoolSetup,
    secret: &[u8; 32],
    destination: &Pubkey,
    root: &[u8; 32],
    leaf_index: u64,
    path: &[[u8; 32]; merkle::DEPTH],
) -> Instruction {
    let mut data = vec![IX_POOL_SPEND];
    data.extend_from_slice(secret);
    data.extend_from_slice(&destination.to_bytes());
    data.extend_from_slice(root);
    data.extend_from_slice(&leaf_index.to_le_bytes());
    for sibling in path {
        data.extend_from_slice(sibling);
    }

    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![AccountMeta::new(setup.ledger, false)],
    )
}

// ── InitializePool ──

#[test]
fn initialize_pool_rejects_an_unlisted_denomination() {
    let mollusk = mollusk();
    let odd = 7 * LAMPORTS_PER_SOL;
    let payer = Pubkey::new_unique();
    let (vault, _) = pool_vault_pda(odd);
    let (ledger, _) = pool_ledger_pda(odd);
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();

    let mut data = vec![IX_INITIALIZE_POOL];
    data.extend_from_slice(&odd.to_le_bytes());

    // A pool for an arbitrary amount is a pool of one, and every odd
    // denomination someone creates splits the anonymity set of the real ones.
    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &data,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new(vault, false),
                AccountMeta::new(ledger, false),
                AccountMeta::new_readonly(system_program_key, false),
            ],
        ),
        &[
            (payer, system_account(10 * LAMPORTS_PER_SOL)),
            (vault, system_account(0)),
            (ledger, system_account(0)),
            (system_program_key, system_program_account),
        ],
        &[Check::err(shredr_err(ShredrError::InvalidDenomination))],
    );
}

#[test]
fn initialize_pool_creates_both_accounts_with_an_empty_tree() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let (vault, _) = pool_vault_pda(DENOM);
    let (ledger, _) = pool_ledger_pda(DENOM);
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();

    let mut data = vec![IX_INITIALIZE_POOL];
    data.extend_from_slice(&DENOM.to_le_bytes());

    let result = mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(
            program_id(),
            &data,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new(vault, false),
                AccountMeta::new(ledger, false),
                AccountMeta::new_readonly(system_program_key, false),
            ],
        ),
        &[
            (payer, system_account(10 * LAMPORTS_PER_SOL)),
            (vault, system_account(0)),
            (ledger, system_account(0)),
            (system_program_key, system_program_account),
        ],
        &[Check::success()],
    );

    let vault_account = result.get_account(&vault).expect("vault");
    let ledger_account = result.get_account(&ledger).expect("ledger");

    assert_eq!(vault_account.data.len(), VAULT_LEN);
    assert_eq!(ledger_account.data.len(), LEDGER_LEN);
    assert_eq!(
        &vault_account.data[V_ROOT..V_ROOT + 32],
        &merkle::empty_root(),
        "a fresh pool starts at the empty root"
    );
    assert_eq!(
        &vault_account.data[V_FILLED_SUBTREES..V_FILLED_SUBTREES + 32],
        &merkle::ZEROS[0],
        "the frontier starts as the empty subtrees"
    );
    // Published immediately, so the first depositor is not waiting on an epoch
    // turn before any root exists to prove against.
    assert_eq!(ledger_account.data[L_ROOT_COUNT], 1);
    assert_eq!(
        &ledger_account.data[L_ROOTS..L_ROOTS + 32],
        &merkle::empty_root()
    );
}

// ── PoolSpend ──

#[test]
fn pool_spend_queues_a_payout_for_a_proven_note() {
    let mollusk = mollusk();
    let secret = [1u8; 32];
    let destination = Pubkey::new_unique();
    let (setup, tree) = spendable_pool(&[secret, [2u8; 32], [3u8; 32]]);

    let result = mollusk.process_and_validate_instruction(
        &spend_instruction(&setup, &secret, &destination, &tree.root(), 0, &tree.path(0)),
        &[(setup.ledger, setup.ledger_account.clone())],
        &[Check::success()],
    );

    let ledger = result.get_account(&setup.ledger).expect("ledger");

    assert_eq!(ledger.data[L_PAYOUT_COUNT], 1);
    assert_eq!(
        &ledger.data[L_PAYOUTS..L_PAYOUTS + 32],
        &note::nullifier(&secret),
        "the published nullifier must be the note's, not its commitment"
    );
    assert_eq!(
        &ledger.data[L_PAYOUTS + 32..L_PAYOUTS + 64],
        &destination.to_bytes(),
        "the payout must name the destination the spender asked for"
    );
    assert_eq!(
        ledger.data[L_ROOT_COUNT], 1,
        "spending changes no root — the tree only grows on the base layer"
    );
}

#[test]
fn pool_spend_refuses_a_note_that_was_never_deposited() {
    let mollusk = mollusk();
    let (setup, tree) = spendable_pool(&[[1u8; 32], [2u8; 32]]);

    // A real path, but for a leaf the tree does not contain.
    mollusk.process_and_validate_instruction(
        &spend_instruction(
            &setup,
            &[99u8; 32],
            &Pubkey::new_unique(),
            &tree.root(),
            0,
            &tree.path(0),
        ),
        &[(setup.ledger, setup.ledger_account.clone())],
        &[Check::err(shredr_err(ShredrError::PoolUnknownNote))],
    );
}

#[test]
fn pool_spend_refuses_a_path_to_a_root_nobody_published() {
    let mollusk = mollusk();
    let secret = [1u8; 32];
    let (setup, _) = spendable_pool(&[secret]);

    // A tree the pool never saw: internally consistent, and worthless.
    let mut forged = TestTree::default();
    forged.push(note::commitment(&secret));
    forged.push(note::commitment(&[7u8; 32]));

    mollusk.process_and_validate_instruction(
        &spend_instruction(
            &setup,
            &secret,
            &Pubkey::new_unique(),
            &forged.root(),
            0,
            &forged.path(0),
        ),
        &[(setup.ledger, setup.ledger_account.clone())],
        &[Check::err(shredr_err(ShredrError::PoolUnknownRoot))],
    );
}

#[test]
fn pool_spend_refuses_a_second_spend_in_the_same_epoch() {
    let mollusk = mollusk();
    let secret = [1u8; 32];
    let (mut setup, tree) = spendable_pool(&[secret]);

    // Already queued this epoch. Across epochs the record PDA catches it
    // instead; within one, the queue is the spent set.
    setup.ledger_account.data[L_PAYOUTS..L_PAYOUTS + 32]
        .copy_from_slice(&note::nullifier(&secret));
    set_u32(&mut setup.ledger_account.data, L_PAYOUT_COUNT, 1);

    mollusk.process_and_validate_instruction(
        &spend_instruction(
            &setup,
            &secret,
            &Pubkey::new_unique(),
            &tree.root(),
            0,
            &tree.path(0),
        ),
        &[(setup.ledger, setup.ledger_account.clone())],
        &[Check::err(shredr_err(ShredrError::PoolNoteAlreadySpent))],
    );
}

#[test]
fn pool_spend_refuses_to_run_on_the_base_layer() {
    let mollusk = mollusk();
    let secret = [1u8; 32];
    let (mut setup, tree) = spendable_pool(&[secret]);
    set_delegated(&mut setup.ledger_account, false);

    // The instruction data carries the note secret and its leaf index. On the
    // base layer that data is public forever, and publishing it hands every
    // observer the link between this note's deposit and its withdrawal.
    mollusk.process_and_validate_instruction(
        &spend_instruction(
            &setup,
            &secret,
            &Pubkey::new_unique(),
            &tree.root(),
            0,
            &tree.path(0),
        ),
        &[(setup.ledger, setup.ledger_account.clone())],
        &[Check::err(shredr_err(
            ShredrError::PoolLedgerDelegationState,
        ))],
    );
}

// ── AdvanceEpoch ──

fn queue_payout(ledger: &mut Account, index: usize, secret: &[u8; 32], destination: &Pubkey) {
    let start = L_PAYOUTS + index * 64;
    ledger.data[start..start + 32].copy_from_slice(&note::nullifier(secret));
    ledger.data[start + 32..start + 64].copy_from_slice(&destination.to_bytes());
    set_u32(&mut ledger.data, L_PAYOUT_COUNT, index as u32 + 1);
}

/// `AdvanceEpoch` takes `(destination, nullifier_record)` pairs after its four
/// fixed accounts.
fn advance_call(
    setup: &PoolSetup,
    payer: &Pubkey,
    settlements: &[(Pubkey, [u8; 32])],
    existing_records: &[Pubkey],
) -> (Instruction, Vec<(Pubkey, Account)>) {
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();

    let mut metas = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(setup.vault, false),
        AccountMeta::new(setup.ledger, false),
        AccountMeta::new_readonly(system_program_key, false),
    ];
    let mut accounts = vec![
        (*payer, system_account(LAMPORTS_PER_SOL)),
        (setup.vault, setup.vault_account.clone()),
        (setup.ledger, setup.ledger_account.clone()),
        (system_program_key, system_program_account),
    ];

    for (destination, secret) in settlements {
        let (record, _) = nullifier_record_pda(&note::nullifier(secret));
        metas.push(AccountMeta::new(*destination, false));
        metas.push(AccountMeta::new(record, false));
        accounts.push((*destination, system_account(0)));
        accounts.push((
            record,
            if existing_records.contains(&record) {
                Account {
                    lamports: record_rent(),
                    data: b"SHREDRNL".to_vec(),
                    owner: program_id(),
                    executable: false,
                    rent_epoch: 0,
                }
            } else {
                system_account(0)
            },
        ));
    }

    (
        Instruction::new_with_bytes(program_id(), &[IX_ADVANCE_EPOCH], metas),
        accounts,
    )
}

/// A pool whose last epoch is far enough back that the batching floor elapsed.
///
/// Anchored to the harness clock rather than to zero: Mollusk starts at
/// timestamp 0, so a literal 0 here is "the epoch turned just now".
fn settled_pool(deposited: u64) -> PoolSetup {
    let now = mollusk().sysvars.clock.unix_timestamp;
    pool_setup(deposited, now - MIN_EPOCH_SECS - 1)
}

#[test]
fn advance_epoch_pays_the_queue_and_publishes_the_root() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let secret = [1u8; 32];

    let mut setup = settled_pool(2 * DENOM);
    queue_payout(&mut setup.ledger_account, 0, &secret, &destination);

    // A root the deposits since the last turn have been folding into.
    let mut tree = TestTree::default();
    tree.push(note::commitment(&secret));
    setup.vault_account.data[V_ROOT..V_ROOT + 32].copy_from_slice(&tree.root());

    let vault_before = setup.vault_account.lamports;
    let (instruction, accounts) = advance_call(&setup, &payer, &[(destination, secret)], &[]);

    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    let vault = result.get_account(&setup.vault).expect("vault");
    let ledger = result.get_account(&setup.ledger).expect("ledger");
    let (record, _) = nullifier_record_pda(&note::nullifier(&secret));

    assert_eq!(
        result.get_account(&destination).expect("destination").lamports,
        DENOM,
        "the destination is paid exactly one denomination"
    );
    // The record rent came out of the surcharge this note's deposit left behind,
    // so the epoch turner is not out of pocket.
    assert_eq!(vault.lamports, vault_before - DENOM - record_rent());
    assert_eq!(
        result.get_account(&record).expect("record").data,
        b"SHREDRNL",
        "the spent note is recorded so it cannot be spent in a later epoch"
    );
    assert_eq!(
        u64::from_le_bytes(
            vault.data[V_TOTAL_SETTLED..V_TOTAL_SETTLED + 8]
                .try_into()
                .unwrap()
        ),
        DENOM
    );

    assert_eq!(ledger.data[L_PAYOUT_COUNT], 0, "the queue is drained");
    assert_eq!(ledger.data[L_ROOT_COUNT], 1, "the new root is published");
    assert_eq!(&ledger.data[L_ROOTS..L_ROOTS + 32], &tree.root());

    // Both halves move together, so a settle cannot be replayed against a ledger
    // that has already advanced.
    assert_eq!(vault.data[V_EPOCH], 1);
    assert_eq!(ledger.data[L_EPOCH], 1);
}

#[test]
fn advance_epoch_drops_a_note_already_spent_in_an_earlier_epoch() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let secret = [1u8; 32];

    let mut setup = settled_pool(2 * DENOM);
    queue_payout(&mut setup.ledger_account, 0, &secret, &destination);

    let (record, _) = nullifier_record_pda(&note::nullifier(&secret));
    let vault_before = setup.vault_account.lamports;
    let (instruction, accounts) = advance_call(&setup, &payer, &[(destination, secret)], &[record]);

    // Dropped rather than failed: the note was honoured the first time, and
    // erroring here would let one stale entry hold up everyone else's payout.
    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    assert_eq!(
        result.get_account(&destination).expect("destination").lamports,
        0,
        "a note is paid once"
    );
    assert_eq!(
        result.get_account(&setup.vault).expect("vault").lamports,
        vault_before
    );
    assert_eq!(
        result.get_account(&setup.ledger).expect("ledger").data[L_PAYOUT_COUNT],
        0,
        "the entry is still consumed"
    );
}

#[test]
fn advance_epoch_pays_a_note_whose_record_address_was_griefed() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let secret = [1u8; 32];

    let mut setup = settled_pool(2 * DENOM);
    queue_payout(&mut setup.ledger_account, 0, &secret, &destination);

    let (instruction, mut accounts) = advance_call(&setup, &payer, &[(destination, secret)], &[]);

    // Nullifiers go public the moment the ledger commits, and the record address
    // derives from the nullifier — so anyone watching can send a lamport to it
    // before the epoch turns. If that counted as "already spent" the payout
    // would be dropped, the note would stay unrecorded, and it would be dropped
    // again every epoch after: one lamport, and the deposit is unwithdrawable
    // forever.
    let (record, _) = nullifier_record_pda(&note::nullifier(&secret));
    accounts
        .iter_mut()
        .find(|(key, _)| *key == record)
        .expect("record account")
        .1
        .lamports = 1;

    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    assert_eq!(
        result.get_account(&destination).expect("destination").lamports,
        DENOM,
        "a donated lamport must not cancel a withdrawal"
    );
    let written = result.get_account(&record).expect("record");
    assert_eq!(written.owner, program_id());
    assert_eq!(written.data, b"SHREDRNL", "the note is properly recorded");
}

/// The queue exists so payouts leave in batches — a batch of one is a batch
/// that ties each payout to the spend that queued it. Every other settle test
/// here passes a single pair, which is exactly how a defect that let only one
/// payout through per turn stayed invisible.
#[test]
fn advance_epoch_settles_several_payouts_in_one_turn() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();

    let notes: [(Pubkey, [u8; 32]); 3] = [
        (Pubkey::new_unique(), [11u8; 32]),
        (Pubkey::new_unique(), [12u8; 32]),
        (Pubkey::new_unique(), [13u8; 32]),
    ];

    let mut setup = settled_pool(3 * DENOM);
    for (index, (destination, secret)) in notes.iter().enumerate() {
        queue_payout(&mut setup.ledger_account, index, secret, destination);
    }

    let vault_before = setup.vault_account.lamports;
    let (instruction, accounts) = advance_call(&setup, &payer, &notes, &[]);

    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    for (destination, secret) in &notes {
        assert_eq!(
            result.get_account(destination).expect("destination").lamports,
            DENOM,
            "every queued payout in the batch is paid"
        );
        let (record, _) = nullifier_record_pda(&note::nullifier(secret));
        assert_eq!(
            result.get_account(&record).expect("record").data,
            b"SHREDRNL"
        );
    }

    let vault = result.get_account(&setup.vault).expect("vault");
    assert_eq!(
        vault.lamports,
        vault_before - 3 * (DENOM + record_rent()),
        "the vault funds three payouts and three records, and nothing else"
    );
    assert_eq!(
        u64::from_le_bytes(
            vault.data[V_TOTAL_SETTLED..V_TOTAL_SETTLED + 8]
                .try_into()
                .unwrap()
        ),
        3 * DENOM
    );
    assert_eq!(
        result.get_account(&payer).expect("payer").lamports,
        LAMPORTS_PER_SOL,
        "the epoch turner fronts the record rent and is made whole"
    );
    assert_eq!(
        result.get_account(&setup.ledger).expect("ledger").data[L_PAYOUT_COUNT],
        0
    );
}

#[test]
fn advance_epoch_survives_a_payout_aimed_at_the_vault() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let good_destination = Pubkey::new_unique();
    let poison = [1u8; 32];
    let honest = [2u8; 32];

    let mut setup = settled_pool(3 * DENOM);
    // A spender picks their own destination, so nothing stops them naming the
    // vault. Crediting the vault from itself is an unbalanced instruction the
    // runtime rejects — so if this were an error rather than a skip, one note
    // would sit at the front of the queue and brick every other withdrawal in
    // the pool, permanently, for the price of a single deposit.
    let vault_address = setup.vault;
    queue_payout(&mut setup.ledger_account, 0, &poison, &vault_address);
    queue_payout(&mut setup.ledger_account, 1, &honest, &good_destination);

    let (instruction, accounts) = advance_call(
        &setup,
        &payer,
        &[(vault_address, poison), (good_destination, honest)],
        &[],
    );

    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    assert_eq!(
        result.get_account(&good_destination).expect("destination").lamports,
        DENOM,
        "an honest payout behind a poisoned one must still be paid"
    );

    let (poison_record, _) = nullifier_record_pda(&note::nullifier(&poison));
    assert_eq!(
        result.get_account(&poison_record).expect("record").data,
        b"SHREDRNL",
        "the poisoned note is burned so it cannot be replayed every epoch"
    );

    assert_eq!(
        result.get_account(&setup.ledger).expect("ledger").data[L_PAYOUT_COUNT],
        0,
        "both entries are consumed"
    );

    let vault = result.get_account(&setup.vault).expect("vault");
    assert_eq!(
        u64::from_le_bytes(
            vault.data[V_TOTAL_SETTLED..V_TOTAL_SETTLED + 8]
                .try_into()
                .unwrap()
        ),
        DENOM,
        "only the honest payout counts as settled"
    );
}

#[test]
fn advance_epoch_refuses_before_the_batching_floor() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let destination = Pubkey::new_unique();

    let now = mollusk.sysvars.clock.unix_timestamp;
    let mut setup = pool_setup(DENOM, now - MIN_EPOCH_SECS + 5);
    queue_payout(&mut setup.ledger_account, 0, &[1u8; 32], &destination);

    // Without the floor anyone could settle immediately after a spend, and a
    // batch of one ties the payout to the spend that queued it.
    let (instruction, accounts) = advance_call(&setup, &payer, &[(destination, [1u8; 32])], &[]);

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(shredr_err(ShredrError::PoolEpochTooSoon))],
    );
}

#[test]
fn advance_epoch_refuses_a_destination_the_queue_did_not_name() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let queued_destination = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let secret = [1u8; 32];

    let mut setup = settled_pool(DENOM);
    queue_payout(&mut setup.ledger_account, 0, &secret, &queued_destination);

    // Destinations are matched positionally against the queue, so this is what
    // stops whoever turns the epoch from redirecting a payout to themselves.
    let (instruction, accounts) = advance_call(&setup, &payer, &[(attacker, secret)], &[]);

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(shredr_err(ShredrError::PoolDestinationMismatch))],
    );
}

#[test]
fn advance_epoch_refuses_to_pay_more_than_was_deposited() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let secret = [1u8; 32];

    // Backing for nothing, but a payout queued anyway — what a compromised or
    // buggy enclave would produce. The counters, not the balance, are what stop
    // it: lamports anyone can send to a derivable address are not backing.
    let mut setup = settled_pool(0);
    setup.vault_account.lamports += 10 * DENOM;
    queue_payout(&mut setup.ledger_account, 0, &secret, &destination);

    let (instruction, accounts) = advance_call(&setup, &payer, &[(destination, secret)], &[]);

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(shredr_err(ShredrError::PoolInsufficientBacking))],
    );
}

#[test]
fn advance_epoch_settles_only_what_it_was_given_accounts_for() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();
    let first = Pubkey::new_unique();
    let second = Pubkey::new_unique();

    let mut setup = settled_pool(2 * DENOM);
    queue_payout(&mut setup.ledger_account, 0, &[1u8; 32], &first);
    queue_payout(&mut setup.ledger_account, 1, &[2u8; 32], &second);

    // A queue larger than one transaction's account limit drains over several
    // turns, so a partial settle must compact rather than drop.
    let (instruction, accounts) = advance_call(&setup, &payer, &[(first, [1u8; 32])], &[]);

    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    let ledger = result.get_account(&setup.ledger).expect("ledger");
    assert_eq!(ledger.data[L_PAYOUT_COUNT], 1);
    assert_eq!(
        &ledger.data[L_PAYOUTS + 32..L_PAYOUTS + 64],
        &second.to_bytes(),
        "the unsettled payout moves to the front of the queue"
    );
    assert_eq!(result.get_account(&first).expect("first").lamports, DENOM);
}

#[test]
fn advance_epoch_refuses_a_delegated_ledger() {
    let mollusk = mollusk();
    let payer = Pubkey::new_unique();

    let mut setup = settled_pool(DENOM);
    set_delegated(&mut setup.ledger_account, true);

    let (instruction, accounts) = advance_call(&setup, &payer, &[], &[]);

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(shredr_err(
            ShredrError::PoolLedgerDelegationState,
        ))],
    );
}

// ── PoolDeposit ──

/// The deposit instruction plus the accounts it needs, given an attestation.
fn deposit_call(
    setup: &PoolSetup,
    depositor: &Pubkey,
    commitment: &[u8; 32],
    attestation: Option<Instruction>,
) -> (Instruction, Vec<(Pubkey, Account)>) {
    let (system_program_key, system_program_account) =
        mollusk_svm::program::keyed_account_for_system_program();

    let mut data = vec![IX_POOL_DEPOSIT];
    data.extend_from_slice(commitment);

    let instruction = Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*depositor, true),
            AccountMeta::new(setup.vault, false),
            AccountMeta::new_readonly(solana_sdk_ids::sysvar::instructions::ID, false),
            AccountMeta::new_readonly(system_program_key, false),
        ],
    );

    let attestations: Vec<Instruction> = attestation.into_iter().collect();
    let (sysvar_key, sysvar_account) = instructions_sysvar_account(&attestations);

    (
        instruction,
        vec![
            (*depositor, system_account(5 * LAMPORTS_PER_SOL)),
            (setup.vault, setup.vault_account.clone()),
            (sysvar_key, sysvar_account),
            (system_program_key, system_program_account),
        ],
    )
}

/// Subject is the commitment, not a burner: it is what is unique about this
/// deposit. `cleared` is the wallet the relayer screened.
fn pool_attestation(cleared: &Pubkey, commitment: &[u8; 32]) -> Instruction {
    ed25519_ix(
        &kyt_authority(),
        &attestation_message(
            1,
            cleared,
            &Pubkey::new_from_array(*commitment),
            DENOM,
            far_future(),
        ),
    )
}

#[test]
fn pool_deposit_appends_the_commitment_and_moves_the_root() {
    let mollusk = mollusk();
    let depositor = Pubkey::new_unique();
    let secret = [5u8; 32];
    let commitment = note::commitment(&secret);
    let setup = pool_setup(0, 0);

    let (instruction, accounts) = deposit_call(
        &setup,
        &depositor,
        &commitment,
        Some(pool_attestation(&depositor, &commitment)),
    );
    let vault_before = setup.vault_account.lamports;

    let result =
        mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);

    let vault = result.get_account(&setup.vault).expect("vault");

    // Denomination plus the record rent this note will need when it is spent.
    assert_eq!(vault.lamports, vault_before + DENOM + record_rent());
    assert_eq!(
        u64::from_le_bytes(
            vault.data[V_TOTAL_DEPOSITED..V_TOTAL_DEPOSITED + 8]
                .try_into()
                .unwrap()
        ),
        DENOM,
        "only the denomination is backing; the surcharge is not"
    );
    assert_eq!(vault.data[V_NEXT_LEAF_INDEX], 1);

    let mut tree = TestTree::default();
    tree.push(commitment);
    assert_eq!(
        &vault.data[V_ROOT..V_ROOT + 32],
        &tree.root(),
        "the on-chain root must match a full recompute of the same leaf"
    );
}

#[test]
fn pool_deposit_refuses_an_attestation_issued_to_another_wallet() {
    let mollusk = mollusk();
    let depositor = Pubkey::new_unique();
    let cleared_wallet = Pubkey::new_unique();
    let commitment = note::commitment(&[5u8; 32]);
    let setup = pool_setup(0, 0);

    // Right commitment, wrong wallet. Without the depositor check an attestation
    // issued for a clean wallet could be presented by a dirty one that happened
    // to learn the commitment.
    let (instruction, accounts) = deposit_call(
        &setup,
        &depositor,
        &commitment,
        Some(pool_attestation(&cleared_wallet, &commitment)),
    );

    mollusk.process_and_validate_instruction(
        &instruction,
        &accounts,
        &[Check::err(shredr_err(
            ShredrError::KytAttestationDepositorMismatch,
        ))],
    );
}

#[test]
fn pool_deposit_refuses_without_an_attestation() {
    let mollusk = mollusk();
    let depositor = Pubkey::new_unique();
    let commitment = note::commitment(&[5u8; 32]);
    let setup = pool_setup(0, 0);

    let (instruction, accounts) = deposit_call(&setup, &depositor, &commitment, None);
    let result = mollusk.process_instruction(&instruction, &accounts);

    assert!(
        matches!(result.raw_result, Err(InstructionError::Custom(code)) if KYT_ERRORS.contains(&code)),
        "an unattested pool deposit must be refused; got {:?}",
        result.raw_result
    );
    assert_eq!(
        result.get_account(&setup.vault).expect("vault").lamports,
        setup.vault_account.lamports,
        "the gate must run before any lamports move"
    );
}

/// Deposit, then spend what was deposited — the two halves have to agree on the
/// tree or nothing in the pool is ever withdrawable.
#[test]
fn a_deposited_note_is_spendable_against_the_published_root() {
    let mollusk = mollusk();
    let depositor = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let secret = [5u8; 32];
    let commitment = note::commitment(&secret);

    let setup = pool_setup(0, 0);
    let (deposit, accounts) = deposit_call(
        &setup,
        &depositor,
        &commitment,
        Some(pool_attestation(&depositor, &commitment)),
    );
    let deposited = mollusk.process_and_validate_instruction(&deposit, &accounts, &[Check::success()]);

    // The root the vault ended up with, published as an epoch turn would.
    let vault = deposited.get_account(&setup.vault).expect("vault");
    let root: [u8; 32] = vault.data[V_ROOT..V_ROOT + 32].try_into().unwrap();

    let mut spendable = setup;
    spendable.ledger_account.data[L_ROOTS..L_ROOTS + 32].copy_from_slice(&root);
    set_u32(&mut spendable.ledger_account.data, L_ROOT_COUNT, 1);
    set_delegated(&mut spendable.ledger_account, true);

    let mut tree = TestTree::default();
    tree.push(commitment);

    mollusk.process_and_validate_instruction(
        &spend_instruction(&spendable, &secret, &destination, &root, 0, &tree.path(0)),
        &[(spendable.ledger, spendable.ledger_account.clone())],
        &[Check::success()],
    );
}
