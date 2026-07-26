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
//! `InitializeAndDelegate`, `CommitStealth`, `CommitAndUndelegateStealth` and
//! `UndelegationCallback` all CPI into the MagicBlock delegation program and the
//! ACL permission program. Those ELFs are not available to the harness, so only
//! the validation performed *before* the CPI is asserted here. Their happy paths
//! need a validator with the MagicBlock programs deployed.

use mollusk_svm::{program::loader_keys::LOADER_V3, result::Check, Mollusk};
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
const OFF_SALT: usize = 40;
const OFF_DEPOSITED_AMOUNT: usize = 72;
const OFF_DEPOSIT_TIMESTAMP: usize = 80;
const OFF_DELEGATED: usize = 88;
const OFF_BUMP: usize = 89;

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
    salt: [u8; 32],
    deposited_amount: u64,
    deposit_timestamp: i64,
    delegated: bool,
    bump: u8,
}

impl StealthState {
    fn new(owner: Pubkey, salt: [u8; 32], bump: u8) -> Self {
        Self {
            owner,
            salt,
            deposited_amount: 0,
            deposit_timestamp: 1_700_000_000,
            delegated: false,
            bump,
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
        data[OFF_SALT..OFF_SALT + 32].copy_from_slice(&self.salt);
        data[OFF_DEPOSITED_AMOUNT..OFF_DEPOSITED_AMOUNT + 8]
            .copy_from_slice(&self.deposited_amount.to_le_bytes());
        data[OFF_DEPOSIT_TIMESTAMP..OFF_DEPOSIT_TIMESTAMP + 8]
            .copy_from_slice(&self.deposit_timestamp.to_le_bytes());
        data[OFF_DELEGATED] = self.delegated as u8;
        data[OFF_BUMP] = self.bump;
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
fn funded_stealth(mollusk: &Mollusk, burner: &Pubkey, salt: [u8; 32], deposited: u64) -> Stealth {
    let (key, bump) = derive_stealth_pda(burner);
    let state = StealthState::new(*burner, salt, bump).deposited(deposited);
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
        salt: [0u8; 32],
        deposited_amount: 0,
        deposit_timestamp: 0,
        delegated: false,
        bump: 0,
    };
    let base = &state as *const StealthAccount as usize;
    let offset_of = |field: usize| field - base + 8; // +8 for the discriminator

    assert_eq!(offset_of(&state.owner as *const _ as usize), OFF_OWNER);
    assert_eq!(offset_of(&state.salt as *const _ as usize), OFF_SALT);
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

    for discriminator in [5u8, 6, 42, 0xFE] {
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
fn withdraw_of_full_balance_clears_state_and_leaves_rent() {
    let mollusk = mollusk();
    let rent = stealth_rent(&mollusk);

    let burner = Pubkey::new_unique();
    let stealth = funded_stealth(&mollusk, &burner, [7u8; 32], 5 * LAMPORTS_PER_SOL);
    let destination = Pubkey::new_unique();

    // A fully drained account is reset: owner zeroed, undelegated, bump cleared.
    // `salt` and `deposit_timestamp` are deliberately left intact by the program.
    let mut expected_state = stealth.state.clone();
    expected_state.owner = Pubkey::default();
    expected_state.deposited_amount = 0;
    expected_state.delegated = false;
    expected_state.bump = 0;
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
// InitializeAndDelegate — pre-CPI validation only
// ─────────────────────────────────────────────

struct InitAccounts {
    burner: Pubkey,
    stealth: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
    metas: Vec<AccountMeta>,
}

fn init_setup(stealth_override: Option<Pubkey>, stealth_lamports: u64) -> InitAccounts {
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
    ];

    InitAccounts {
        burner,
        stealth,
        accounts,
        metas,
    }
}

fn init_ix_data(deposit_amount: u64) -> Vec<u8> {
    let mut data = vec![IX_INITIALIZE_AND_DELEGATE];
    data.extend_from_slice(&deposit_amount.to_le_bytes());
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

/// Re-initialization guard: a stealth PDA that already holds lamports is treated
/// as live and cannot be re-created (which would reset `owner` to a new burner).
#[test]
fn initialize_rejects_existing_account() {
    let mollusk = mollusk();
    let setup = init_setup(None, LAMPORTS_PER_SOL);

    mollusk.process_and_validate_instruction(
        &Instruction::new_with_bytes(program_id(), &init_ix_data(0), setup.metas.clone()),
        &setup.accounts,
        &[Check::err(shredr_err(
            ShredrError::AccountAlreadyInitialized,
        ))],
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
            Err(InstructionError::Custom(6000..=6011))
        ),
        "expected failure to come from the missing MagicBlock/ACL programs, \
         not from SHREDR validation; got {:?}",
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
