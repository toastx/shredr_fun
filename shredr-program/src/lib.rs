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

use crate::instructions::initialize_delegate::InitializeAndDelegate;
use crate::instructions::private_transfer::PrivateTransfer;
use crate::instructions::commit_undelegate::{CommitStealth, CommitAndUndelegateStealth, UndelegationCallback};
use crate::instructions::withdraw::Withdraw;

declare_id!("H64YCQTWdQkx9vjs1ZB2Uo24FyUBibnDxhKdznamybpZ");

fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    log_instruction(*discriminator);

    match *discriminator {
        InitializeAndDelegate::DISCRIMINATOR => {
            InitializeAndDelegate::try_from((accounts, data))?.process()
        }
        PrivateTransfer::DISCRIMINATOR => {
            PrivateTransfer::try_from((data, accounts))?.process()
        }
        CommitStealth::DISCRIMINATOR => {
            CommitStealth::try_from((accounts, data))?.process()
        }
        CommitAndUndelegateStealth::DISCRIMINATOR => {
            CommitAndUndelegateStealth::try_from((accounts, data))?.process()
        }
        Withdraw::DISCRIMINATOR => {
            Withdraw::try_from((accounts, data))?.process()
        }
        UndelegationCallback::DISCRIMINATOR => {
            UndelegationCallback::try_from((accounts, data))?.process(program_id)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[allow(unused_variables)]
fn log_instruction(discriminator: u8) {
    #[cfg(feature = "logging")]
    {
        match discriminator {
            InitializeAndDelegate::DISCRIMINATOR => {
                pinocchio_log::log!("InitializeAndDelegate");
            }
            PrivateTransfer::DISCRIMINATOR => {
                pinocchio_log::log!("PrivateTransfer");
            }
            CommitStealth::DISCRIMINATOR => {
                pinocchio_log::log!("CommitStealth");
            }
            CommitAndUndelegateStealth::DISCRIMINATOR => {
                pinocchio_log::log!("CommitAndUndelegateStealth");
            }
            Withdraw::DISCRIMINATOR => {
                pinocchio_log::log!("Withdraw");
            }
            UndelegationCallback::DISCRIMINATOR => {
                pinocchio_log::log!("UndelegationCallback");
            }
            _ => {
                pinocchio_log::log!("UnknownInstruction");
            }
        }
    }
}