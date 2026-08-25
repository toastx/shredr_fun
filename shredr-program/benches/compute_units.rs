//! Compute-unit benchmarks for the SHREDR program.
//!
//! Only the CPI-free instructions are benchmarked; everything else bottoms out
//! in the MagicBlock delegation program, which the harness cannot load.
//!
//! ```sh
//! cargo build-sbf
//! cargo bench
//! ```
//!
//! Results are written to `target/benches/compute_units.md`.

use mollusk_svm::{program::loader_keys::LOADER_V3, Mollusk};
use mollusk_svm_bencher::MolluskComputeUnitBencher;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use shredr_program::{
    constants::seeds,
    state::{STEALTH_ACCOUNT_DISCRIMINATOR, STEALTH_ACCOUNT_SIZE},
};

const IX_PRIVATE_TRANSFER: u8 = 1;
const IX_WITHDRAW: u8 = 4;
const IX_CLOSE: u8 = 5;

const ACCOUNT_LEN: usize = 8 + STEALTH_ACCOUNT_SIZE;
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(shredr_program::ID)
}

fn program_elf() -> Vec<u8> {
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
            return std::fs::read(&path).expect("failed to read shredr_program.so");
        }
    }

    panic!("shredr_program.so not found in {candidates:?}. Run `cargo build-sbf` first.");
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

/// Build a program-owned stealth account holding `deposited` lamports of user
/// funds on top of rent, mirroring the layout asserted in `tests/test.rs`.
fn stealth_account(owner: &Pubkey, salt: [u8; 32], bump: u8, deposited: u64, rent: u64) -> Account {
    let mut data = vec![0u8; ACCOUNT_LEN];
    data[0..8].copy_from_slice(&STEALTH_ACCOUNT_DISCRIMINATOR);
    data[8..40].copy_from_slice(owner.as_ref());
    data[40..72].copy_from_slice(&salt);
    data[72..80].copy_from_slice(&deposited.to_le_bytes());
    data[80..88].copy_from_slice(&1_700_000_000i64.to_le_bytes());
    data[88] = 0; // delegated
    data[89] = bump;

    Account {
        lamports: rent + deposited,
        data,
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

/// Must match `helpers::derive_stealth_account_from_pubkey`: the burner alone,
/// no salt. `salt` is a stored field, not a seed — including it here derived
/// addresses the program rejects with `InvalidStealthPDA`.
fn derive(burner: &Pubkey, _salt: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[seeds::STEALTH_ADDRESS, burner.as_ref()],
        &program_id(),
    )
}

fn main() {
    let mut mollusk = Mollusk::default();
    mollusk.add_program_with_loader_and_elf(&program_id(), &LOADER_V3, &program_elf());
    let rent = mollusk.sysvars.rent.minimum_balance(ACCOUNT_LEN);

    // ── private transfer ──
    let source_burner = Pubkey::new_unique();
    let dest_burner = Pubkey::new_unique();
    let (source_key, source_bump) = derive(&source_burner, &[1u8; 32]);
    let (dest_key, dest_bump) = derive(&dest_burner, &[2u8; 32]);

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
            ),
        ),
        (
            dest_key,
            stealth_account(&dest_burner, [2u8; 32], dest_bump, LAMPORTS_PER_SOL, rent),
        ),
    ];

    // ── withdraw ──
    let burner = Pubkey::new_unique();
    let (stealth_key, stealth_bump) = derive(&burner, &[7u8; 32]);
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
            stealth_account(&burner, [7u8; 32], stealth_bump, 5 * LAMPORTS_PER_SOL, rent),
        ),
        (destination, system_account(0)),
    ];

    // ── private transfer, full drain ──
    // Moves the source's entire deposited balance, leaving it at exactly rent —
    // the boundary path where `deposited_amount` reaches zero.
    let drain_source_burner = Pubkey::new_unique();
    let drain_dest_burner = Pubkey::new_unique();
    let (drain_source_key, drain_source_bump) = derive(&drain_source_burner, &[3u8; 32]);
    let (drain_dest_key, drain_dest_bump) = derive(&drain_dest_burner, &[4u8; 32]);

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
            ),
        ),
        (
            drain_dest_key,
            stealth_account(&drain_dest_burner, [4u8; 32], drain_dest_bump, 0, rent),
        ),
    ];

    // ── withdraw, full drain ──
    // Withdraws the entire deposit, exercising the extra work the partial path
    // skips: the rent-exemption floor check and the state-clearing branch that
    // zeroes owner/delegated/bump.
    let wd_burner = Pubkey::new_unique();
    let (wd_stealth_key, wd_stealth_bump) = derive(&wd_burner, &[8u8; 32]);
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
            ),
        ),
        (wd_destination, system_account(0)),
    ];

    // ── close ──
    // Every cycle now ends in two of these, and it re-derives the PDA to verify
    // it, so the bump grind lands on the hot path.
    let cl_burner = Pubkey::new_unique();
    let (cl_stealth_key, cl_stealth_bump) = derive(&cl_burner, &[9u8; 32]);
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
            stealth_account(&cl_burner, [9u8; 32], cl_stealth_bump, 0, rent),
        ),
        (cl_payee, system_account(0)),
    ];

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
        .must_pass(true)
        .out_dir("target/benches")
        .execute();
}
