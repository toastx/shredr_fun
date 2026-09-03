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

    for discriminator in [6u8, 7, 42, 0xFE] {
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
        check_attestation(&message, &burner.to_bytes(), LAMPORTS_PER_SOL, 0),
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
        check_attestation(&message, &Pubkey::new_unique().to_bytes(), 1, 0),
        Err(shredr_code(ShredrError::KytAttestationBurnerMismatch))
    );
    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), LAMPORTS_PER_SOL + 1, 0),
        Err(shredr_code(ShredrError::KytAttestationAmountExceeded))
    );
    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), 1, expiry + 1),
        Err(shredr_code(ShredrError::KytAttestationExpired))
    );
    // Inclusive: an attestation is good through its expiry second.
    assert_eq!(check_attestation(&message, &burner.to_bytes(), 1, expiry), Ok(()));
}

#[test]
fn check_attestation_refuses_a_screened_out_depositor() {
    let burner = Pubkey::new_unique();
    let message =
        attestation_message(0, &Pubkey::new_unique(), &burner, LAMPORTS_PER_SOL, far_future());

    assert_eq!(
        check_attestation(&message, &burner.to_bytes(), 1, 0),
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
            check_attestation(&message, &burner.to_bytes(), 1, 0),
            Err(shredr_code(ShredrError::KytAttestationMalformed))
        );
    }
}
