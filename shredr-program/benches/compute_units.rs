//! Compute-unit benchmarks for the SHREDR program.
//!
//! Every instruction that runs on the base layer is covered, including
//! `InitializeAndDelegate` — the one the relayer pays for on every cycle. That
//! one CPIs into the MagicBlock delegation and ACL programs, so their ELFs are
//! vendored under `fixtures/` and loaded alongside ours; refresh them with
//! `scripts/dump-magicblock-programs.sh`.
//!
//! `CommitStealth` and `CommitAndUndelegateStealth` are the exception. They CPI
//! into `Magic11111111111111111111111111111111111111`, a builtin of the ephemeral
//! validator with no base-layer account to dump — and their compute budget is a
//! rollup concern, not a base-layer one.
//!
//! Read the numbers as a regression signal, not a cost model. The
//! `initialize_and_delegate_*` rows are dominated by the vendored programs' own
//! execution, so re-dumping them moves those rows without anything here
//! changing; and each case grinds a different bump, so cases are comparable to
//! their own previous value rather than to each other.
//!
//! ```sh
//! cargo build-sbf
//! cargo bench
//! ```
//!
//! Results are written to `target/benches/compute_units.md`.

use mollusk_svm::{
    program::loader_keys::LOADER_V3,
    program::{create_program_account_loader_v3, keyed_account_for_system_program},
    Mollusk,
};
use mollusk_svm_bencher::MolluskComputeUnitBencher;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use ephemeral_rollups_pinocchio::{
    acl::consts::PERMISSION_PROGRAM_ID, consts::DELEGATION_PROGRAM_ID,
};
use shredr_program::{
    constants::seeds,
    state::{role, STEALTH_ACCOUNT_DISCRIMINATOR, STEALTH_ACCOUNT_SIZE},
};

const IX_INITIALIZE_AND_DELEGATE: u8 = 0;
const IX_PRIVATE_TRANSFER: u8 = 1;
const IX_WITHDRAW: u8 = 4;
const IX_CLOSE: u8 = 5;
const IX_UNDELEGATION_CALLBACK: u8 = 0xFF;

const ACCOUNT_LEN: usize = 8 + STEALTH_ACCOUNT_SIZE;
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

// ─────────────────────────────────────────────
// Program ids and ELFs
// ─────────────────────────────────────────────

fn program_id() -> Pubkey {
    Pubkey::new_from_array(shredr_program::ID)
}

/// The vendored ELFs are keyed by these, so the ids come from the SDK consts
/// rather than a second copy of the base58 in this file.
fn delegation_program_id() -> Pubkey {
    Pubkey::new_from_array(*DELEGATION_PROGRAM_ID.as_array())
}

fn permission_program_id() -> Pubkey {
    Pubkey::new_from_array(*PERMISSION_PROGRAM_ID.as_array())
}

/// Locate and read an ELF. `shredr_program.so` comes out of the build, the
/// MagicBlock ones out of the committed `fixtures/` directory.
fn elf(file_name: &str) -> Vec<u8> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

    let mut candidates = Vec::new();
    if let Ok(dir) = std::env::var("SBF_OUT_DIR") {
        candidates.push(std::path::PathBuf::from(dir));
    }
    candidates.push(manifest.join("target").join("deploy"));
    candidates.push(manifest.join("fixtures"));

    for dir in &candidates {
        let path = dir.join(file_name);
        if path.exists() {
            return std::fs::read(&path)
                .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        }
    }

    panic!(
        "{file_name} not found in {candidates:?}. Run `cargo build-sbf`, and \
         `scripts/dump-magicblock-programs.sh` for the MagicBlock fixtures."
    );
}

fn mollusk() -> Mollusk {
    let mut mollusk = Mollusk::default();
    mollusk.add_program_with_loader_and_elf(&program_id(), &LOADER_V3, &elf("shredr_program.so"));
    mollusk.add_program_with_loader_and_elf(
        &delegation_program_id(),
        &LOADER_V3,
        &elf("delegation_program.so"),
    );
    mollusk.add_program_with_loader_and_elf(
        &permission_program_id(),
        &LOADER_V3,
        &elf("permission_program.so"),
    );
    mollusk
}

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

fn system_account(lamports: u64) -> Account {
    Account {
        lamports,
        data: vec![],
        owner: solana_sdk_ids::system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// Serialize the `[discriminator][StealthAccount]` image, mirroring the offsets
/// asserted by `stealth_account_layout_is_stable` in `tests/test.rs`.
fn stealth_bytes(owner: &Pubkey, receipt_commitment: [u8; 32], bump: u8, deposited: u64, role: u8) -> Vec<u8> {
    let mut data = vec![0u8; ACCOUNT_LEN];
    data[0..8].copy_from_slice(&STEALTH_ACCOUNT_DISCRIMINATOR);
    data[8..40].copy_from_slice(owner.as_ref());
    data[40..72].copy_from_slice(&receipt_commitment);
    data[72..80].copy_from_slice(&deposited.to_le_bytes());
    data[80..88].copy_from_slice(&1_700_000_000i64.to_le_bytes());
    data[88] = 0; // delegated
    data[89] = bump;
    data[90] = role;
    data
}

/// Build a program-owned stealth account holding `deposited` lamports of user
/// funds on top of rent.
fn stealth_account(
    owner: &Pubkey,
    receipt_commitment: [u8; 32],
    bump: u8,
    deposited: u64,
    rent: u64,
    role: u8,
) -> Account {
    Account {
        lamports: rent + deposited,
        data: stealth_bytes(owner, receipt_commitment, bump, deposited, role),
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

/// Must match `helpers::derive_stealth_account_from_pubkey`: the burner alone,
/// no receipt_commitment. `receipt_commitment` is a stored field, not a seed — including it here derived
/// addresses the program rejects with `InvalidStealthPDA`.
fn derive(burner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::STEALTH_ADDRESS, burner.as_ref()], &program_id())
}

// The delegation-side PDAs, mirroring `ephemeral_rollups_pinocchio::pda` and
// `::acl::pda`. `tests/test.rs` fills these with random keys because its
// `InitializeAndDelegate` cases stop before the CPI; these ones do not.

fn permission_pda(stealth: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"permission:", stealth.as_ref()],
        &permission_program_id(),
    )
    .0
}

fn delegation_buffer_pda(stealth: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"buffer", stealth.as_ref()], &program_id()).0
}

fn delegation_record_pda(stealth: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"delegation", stealth.as_ref()], &delegation_program_id()).0
}

fn delegation_metadata_pda(stealth: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"delegation-metadata", stealth.as_ref()],
        &delegation_program_id(),
    )
    .0
}

fn undelegate_buffer_pda(stealth: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"undelegate-buffer", stealth.as_ref()],
        &delegation_program_id(),
    )
    .0
}

// ─────────────────────────────────────────────
// InitializeAndDelegate setup
// ─────────────────────────────────────────────

struct Init {
    ix: Instruction,
    accounts: Vec<(Pubkey, Account)>,
}

/// `existing_deposited` is `Some` when the PDA is being reused: an already
/// program-owned, undelegated account carrying that much deposit. `None` leaves
/// a bare system account holding `stealth_lamports`.
fn init_case(
    deposit_amount: u64,
    role: u8,
    existing_deposited: Option<u64>,
    stealth_lamports: u64,
    permission_funded: bool,
    rent: u64,
) -> Init {
    let relayer = Pubkey::new_unique();
    let burner = Pubkey::new_unique();
    let (stealth, bump) = derive(&burner);

    let permission = permission_pda(&stealth);
    let delegation_buffer = delegation_buffer_pda(&stealth);
    let delegation_record = delegation_record_pda(&stealth);
    let delegation_metadata = delegation_metadata_pda(&stealth);
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    let mut data = vec![IX_INITIALIZE_AND_DELEGATE];
    data.extend_from_slice(&deposit_amount.to_le_bytes());
    data.push(role);

    let ix = Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(relayer, true),
            AccountMeta::new(burner, true),
            AccountMeta::new_readonly(program_id(), false),
            AccountMeta::new(stealth, false),
            AccountMeta::new(permission, false),
            AccountMeta::new(delegation_buffer, false),
            AccountMeta::new(delegation_record, false),
            AccountMeta::new(delegation_metadata, false),
            AccountMeta::new_readonly(system_program_key, false),
            // Solana resolves a CPI's callee from the transaction's account keys,
            // so both programs `process` invokes must appear. `try_from` reads
            // exactly nine accounts positionally and ignores these, which is why
            // the real client appends them too — see `createInitializeAndDelegate
            // Instruction` in `src/lib/ShredrProgram.ts`.
            AccountMeta::new_readonly(permission_program_id(), false),
            AccountMeta::new_readonly(delegation_program_id(), false),
        ],
    );

    let stealth_state = match existing_deposited {
        Some(deposited) => stealth_account(&burner, [11u8; 32], bump, deposited, rent, role),
        None => system_account(stealth_lamports),
    };

    let accounts = vec![
        (relayer, system_account(100 * LAMPORTS_PER_SOL)),
        (burner, system_account(10 * LAMPORTS_PER_SOL)),
        (
            program_id(),
            create_program_account_loader_v3(&program_id()),
        ),
        (stealth, stealth_state),
        (
            permission,
            // Non-zero lamports is what makes `process` skip the ACL CPI, which
            // is the reuse path: the permission PDA outlives a cycle.
            system_account(if permission_funded {
                LAMPORTS_PER_SOL
            } else {
                0
            }),
        ),
        (delegation_buffer, system_account(0)),
        (delegation_record, system_account(0)),
        (delegation_metadata, system_account(0)),
        (system_program_key, system_program_account),
        (
            permission_program_id(),
            create_program_account_loader_v3(&permission_program_id()),
        ),
        (
            delegation_program_id(),
            create_program_account_loader_v3(&delegation_program_id()),
        ),
    ];

    Init { ix, accounts }
}

// ─────────────────────────────────────────────
// UndelegationCallback setup
// ─────────────────────────────────────────────

/// The delegation program hands back the committed image in a buffer PDA it
/// signs for, and the callback re-creates the stealth PDA from it. `undelegate`
/// only CPIs `CreateAccount` into the system program, so no MagicBlock ELF is
/// involved on this path.
fn undelegation_callback_case(rent: u64) -> Init {
    let burner = Pubkey::new_unique();
    let (stealth, bump) = derive(&burner);
    let buffer = undelegate_buffer_pda(&stealth);
    let payer = Pubkey::new_unique();
    let (system_program_key, system_program_account) = keyed_account_for_system_program();

    // `[0xFF][u32 seed count][u32 len + bytes]…` — the seeds `undelegate` re-derives
    // the account from, exactly as the delegation program encodes them.
    let mut data = vec![IX_UNDELEGATION_CALLBACK];
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&(seeds::STEALTH_ADDRESS.len() as u32).to_le_bytes());
    data.extend_from_slice(seeds::STEALTH_ADDRESS);
    data.extend_from_slice(&32u32.to_le_bytes());
    data.extend_from_slice(burner.as_ref());

    let ix = Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(stealth, false),
            AccountMeta::new(buffer, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(system_program_key, false),
        ],
    );

    // Still flagged delegated: clearing that flag is the callback's whole job.
    let mut buffered = stealth_bytes(&burner, [21u8; 32], bump, 2 * LAMPORTS_PER_SOL, role::EXIT);
    buffered[88] = 1;

    let accounts = vec![
        // Empty and system-owned — `CreateAccount` refuses anything else.
        (stealth, system_account(0)),
        (
            buffer,
            Account {
                lamports: rent,
                data: buffered,
                owner: delegation_program_id(),
                executable: false,
                rent_epoch: 0,
            },
        ),
        (payer, system_account(10 * LAMPORTS_PER_SOL)),
        (system_program_key, system_program_account),
    ];

    Init { ix, accounts }
}

fn main() {
    let mollusk = mollusk();
    let rent = mollusk.sysvars.rent.minimum_balance(ACCOUNT_LEN);

    // ── private transfer ──
    let source_burner = Pubkey::new_unique();
    let dest_burner = Pubkey::new_unique();
    let (source_key, source_bump) = derive(&source_burner);
    let (dest_key, dest_bump) = derive(&dest_burner);

    let mut transfer_data = vec![IX_PRIVATE_TRANSFER];
    transfer_data.extend_from_slice(&(2 * LAMPORTS_PER_SOL).to_le_bytes());

    let transfer_ix = Instruction::new_with_bytes(
        program_id(),
        &transfer_data,
        vec![
            AccountMeta::new_readonly(source_burner, true),
            AccountMeta::new(source_key, false),
            AccountMeta::new(dest_key, false),
        ],
    );
    let transfer_accounts = vec![
        (source_burner, system_account(0)),
        (
            source_key,
            stealth_account(
                &source_burner,
                [1u8; 32],
                source_bump,
                5 * LAMPORTS_PER_SOL,
                rent,
                role::DEPOSIT,
            ),
        ),
        (
            dest_key,
            stealth_account(
                &dest_burner,
                [2u8; 32],
                dest_bump,
                LAMPORTS_PER_SOL,
                rent,
                role::EXIT,
            ),
        ),
    ];

    // ── withdraw ──
    let burner = Pubkey::new_unique();
    let (stealth_key, stealth_bump) = derive(&burner);
    let destination = Pubkey::new_unique();

    let mut withdraw_data = vec![IX_WITHDRAW];
    withdraw_data.extend_from_slice(&(2 * LAMPORTS_PER_SOL).to_le_bytes());

    let withdraw_ix = Instruction::new_with_bytes(
        program_id(),
        &withdraw_data,
        vec![
            AccountMeta::new(burner, true),
            AccountMeta::new(stealth_key, false),
            AccountMeta::new(destination, false),
        ],
    );
    let withdraw_accounts = vec![
        (burner, system_account(LAMPORTS_PER_SOL)),
        (
            stealth_key,
            stealth_account(
                &burner,
                [7u8; 32],
                stealth_bump,
                5 * LAMPORTS_PER_SOL,
                rent,
                role::EXIT,
            ),
        ),
        (destination, system_account(0)),
    ];

    // ── private transfer, full drain ──
    // Moves the source's entire deposited balance, leaving it at exactly rent —
    // the boundary path where `deposited_amount` reaches zero.
    let drain_source_burner = Pubkey::new_unique();
    let drain_dest_burner = Pubkey::new_unique();
    let (drain_source_key, drain_source_bump) = derive(&drain_source_burner);
    let (drain_dest_key, drain_dest_bump) = derive(&drain_dest_burner);

    let mut transfer_full_data = vec![IX_PRIVATE_TRANSFER];
    transfer_full_data.extend_from_slice(&(4 * LAMPORTS_PER_SOL).to_le_bytes());

    let transfer_full_ix = Instruction::new_with_bytes(
        program_id(),
        &transfer_full_data,
        vec![
            AccountMeta::new_readonly(drain_source_burner, true),
            AccountMeta::new(drain_source_key, false),
            AccountMeta::new(drain_dest_key, false),
        ],
    );
    let transfer_full_accounts = vec![
        (drain_source_burner, system_account(0)),
        (
            drain_source_key,
            stealth_account(
                &drain_source_burner,
                [3u8; 32],
                drain_source_bump,
                4 * LAMPORTS_PER_SOL,
                rent,
                role::DEPOSIT,
            ),
        ),
        (
            drain_dest_key,
            stealth_account(
                &drain_dest_burner,
                [4u8; 32],
                drain_dest_bump,
                0,
                rent,
                role::EXIT,
            ),
        ),
    ];

    // ── withdraw, full drain ──
    // Withdraws the entire deposit, exercising the extra work the partial path
    // skips: the rent-exemption floor check on the way to a zero balance.
    // `owner` is deliberately preserved so `CloseStealthAccount` can still
    // authorize against it.
    let wd_burner = Pubkey::new_unique();
    let (wd_stealth_key, wd_stealth_bump) = derive(&wd_burner);
    let wd_destination = Pubkey::new_unique();

    let mut withdraw_full_data = vec![IX_WITHDRAW];
    withdraw_full_data.extend_from_slice(&(5 * LAMPORTS_PER_SOL).to_le_bytes());

    let withdraw_full_ix = Instruction::new_with_bytes(
        program_id(),
        &withdraw_full_data,
        vec![
            AccountMeta::new(wd_burner, true),
            AccountMeta::new(wd_stealth_key, false),
            AccountMeta::new(wd_destination, false),
        ],
    );
    let withdraw_full_accounts = vec![
        (wd_burner, system_account(LAMPORTS_PER_SOL)),
        (
            wd_stealth_key,
            stealth_account(
                &wd_burner,
                [8u8; 32],
                wd_stealth_bump,
                5 * LAMPORTS_PER_SOL,
                rent,
                role::EXIT,
            ),
        ),
        (wd_destination, system_account(0)),
    ];

    // ── close ──
    // Every cycle now ends in two of these, and it re-derives the PDA to verify
    // it, so the bump grind lands on the hot path.
    let cl_burner = Pubkey::new_unique();
    let (cl_stealth_key, cl_stealth_bump) = derive(&cl_burner);
    let cl_payee = Pubkey::new_unique();

    let close_ix = Instruction::new_with_bytes(
        program_id(),
        &[IX_CLOSE],
        vec![
            AccountMeta::new_readonly(cl_burner, true),
            AccountMeta::new(cl_stealth_key, false),
            AccountMeta::new(cl_payee, false),
        ],
    );
    let close_accounts = vec![
        (cl_burner, system_account(LAMPORTS_PER_SOL)),
        // Spent: deposited_amount zero, holding only rent.
        (
            cl_stealth_key,
            stealth_account(
                &cl_burner,
                [9u8; 32],
                cl_stealth_bump,
                0,
                rent,
                role::DEPOSIT,
            ),
        ),
        (cl_payee, system_account(0)),
    ];

    // ── close, with residue ──
    // `deposited_amount` is zero but the account holds more than rent: lamports
    // sent straight to the derivable address after initialization, uncredited
    // because nothing observed them arrive. Close sweeps the whole balance
    // rather than a computed rent figure, so this is the path that moves it.
    let res_burner = Pubkey::new_unique();
    let (res_stealth_key, res_stealth_bump) = derive(&res_burner);
    let res_payee = Pubkey::new_unique();

    let close_residue_ix = Instruction::new_with_bytes(
        program_id(),
        &[IX_CLOSE],
        vec![
            AccountMeta::new_readonly(res_burner, true),
            AccountMeta::new(res_stealth_key, false),
            AccountMeta::new(res_payee, false),
        ],
    );
    let mut residue_account = stealth_account(
        &res_burner,
        [10u8; 32],
        res_stealth_bump,
        0,
        rent,
        role::EXIT,
    );
    residue_account.lamports += 3 * LAMPORTS_PER_SOL;

    let close_residue_accounts = vec![
        (res_burner, system_account(LAMPORTS_PER_SOL)),
        (res_stealth_key, residue_account),
        (res_payee, system_account(0)),
    ];

    // ── initialize and delegate ──
    // Fresh address, funded: the `CreateAccount` branch plus the burner sweep.
    let init_deposit = init_case(2 * LAMPORTS_PER_SOL, role::DEPOSIT, None, 0, false, rent);
    // Fresh address, empty: the exit PDA, created to be funded by a later transfer.
    let init_exit = init_case(0, role::EXIT, None, 0, false, rent);
    // Someone sent to the derivable address first, so `CreateAccount` refuses it
    // and the Transfer + Allocate + Assign branch runs, crediting the excess.
    let init_prefunded = init_case(
        LAMPORTS_PER_SOL,
        role::DEPOSIT,
        None,
        3 * LAMPORTS_PER_SOL,
        false,
        rent,
    );
    // Reuse of an undelegated PDA that still holds funds: accumulates onto
    // `previous_deposited` and skips the ACL create, since the permission PDA
    // from the previous cycle is still there.
    let init_reuse = init_case(
        LAMPORTS_PER_SOL,
        role::DEPOSIT,
        Some(LAMPORTS_PER_SOL),
        0,
        true,
        rent,
    );

    // ── undelegation callback ──
    let callback = undelegation_callback_case(rent);

    MolluskComputeUnitBencher::new(mollusk)
        .bench(("private_transfer", &transfer_ix, &transfer_accounts))
        .bench((
            "private_transfer_full_drain",
            &transfer_full_ix,
            &transfer_full_accounts,
        ))
        .bench(("withdraw", &withdraw_ix, &withdraw_accounts))
        .bench((
            "withdraw_full_drain",
            &withdraw_full_ix,
            &withdraw_full_accounts,
        ))
        .bench(("close", &close_ix, &close_accounts))
        .bench((
            "close_with_residue",
            &close_residue_ix,
            &close_residue_accounts,
        ))
        .bench((
            "initialize_and_delegate_deposit",
            &init_deposit.ix,
            &init_deposit.accounts,
        ))
        .bench((
            "initialize_and_delegate_exit",
            &init_exit.ix,
            &init_exit.accounts,
        ))
        .bench((
            "initialize_and_delegate_prefunded",
            &init_prefunded.ix,
            &init_prefunded.accounts,
        ))
        .bench((
            "initialize_and_delegate_reuse",
            &init_reuse.ix,
            &init_reuse.accounts,
        ))
        .bench(("undelegation_callback", &callback.ix, &callback.accounts))
        .must_pass(true)
        .out_dir("target/benches")
        .execute();
}
