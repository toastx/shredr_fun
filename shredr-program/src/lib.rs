// lib.rs
#![no_std]
#![allow(unexpected_cfgs)]

use pinocchio::{AccountView,
    entrypoint,
    error::ProgramError,
    Address,
    ProgramResult,
};
use pinocchio_pubkey::declare_id;
entrypoint!(process_instruction);
pub mod instructions;
pub mod helpers;
pub mod constants;
pub mod state;
use crate::instructions::instructions::{Deposit,Withdraw};

declare_id!("H64YCQTWdQkx9vjs1ZB2Uo24FyUBibnDxhKdznamybpZ");

fn process_instruction(
    _program_id: &Address,
    accounts: & mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    match instruction_data.split_first() {
        Some((Deposit::DISCRIMINATOR, data)) => Deposit::try_from((data, accounts))?.process(),
        Some((Withdraw::DISCRIMINATOR, _)) => Withdraw::try_from(accounts)?.process(),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}