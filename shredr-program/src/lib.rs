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

#[derive(Copy, Clone, PartialEq, Eq)]
enum InstructionDiscriminator {
    InitializeAndDelegate,
    PrivateTransfer,
    CommitStealth,
    CommitAndUndelegateStealth,
    Withdraw,
    UndelegationCallback,
}

impl InstructionDiscriminator {
    const INITIALIZE_AND_DELEGATE: u8 = 0;
    const PRIVATE_TRANSFER: u8 = 1;
    const COMMIT_STEALTH: u8 = 2;
    const COMMIT_AND_UNDELEGATE_STEALTH: u8 = 3;
    const WITHDRAW: u8 = 4;
    // Undelegation callback called by the delegation program
    const UNDELEGATION_CALLBACK: u8 = 0xFF;

    fn from_byte(byte: u8) -> Result<Self, ProgramError> {
        match byte {
            Self::INITIALIZE_AND_DELEGATE => Ok(Self::InitializeAndDelegate),
            Self::PRIVATE_TRANSFER => Ok(Self::PrivateTransfer),
            Self::COMMIT_STEALTH => Ok(Self::CommitStealth),
            Self::COMMIT_AND_UNDELEGATE_STEALTH => Ok(Self::CommitAndUndelegateStealth),
            Self::WITHDRAW => Ok(Self::Withdraw),
            Self::UNDELEGATION_CALLBACK => Ok(Self::UndelegationCallback),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    let instruction = InstructionDiscriminator::from_byte(*discriminator)?;

    log_instruction(instruction);

    match instruction {
        InstructionDiscriminator::InitializeAndDelegate => {
            InitializeAndDelegate::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::PrivateTransfer => {
            PrivateTransfer::try_from((data, accounts))?.process()
        }
        InstructionDiscriminator::CommitStealth => {
            CommitStealth::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::CommitAndUndelegateStealth => {
            CommitAndUndelegateStealth::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::Withdraw => {
            Withdraw::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::UndelegationCallback => {
            UndelegationCallback::try_from((accounts, data))?.process(program_id)
        }
    }
}

#[allow(unused_variables)]
fn log_instruction(instruction: InstructionDiscriminator) {
    #[cfg(feature = "logging")]
    {
        match instruction {
            InstructionDiscriminator::InitializeAndDelegate => {
                pinocchio_log::log!("InitializeAndDelegate");
            }
            InstructionDiscriminator::PrivateTransfer => {
                pinocchio_log::log!("PrivateTransfer");
            }
            InstructionDiscriminator::CommitStealth => {
                pinocchio_log::log!("CommitStealth");
            }
            InstructionDiscriminator::CommitAndUndelegateStealth => {
                pinocchio_log::log!("CommitAndUndelegateStealth");
            }
            InstructionDiscriminator::Withdraw => {
                pinocchio_log::log!("Withdraw");
            }
            InstructionDiscriminator::UndelegationCallback => {
                pinocchio_log::log!("UndelegationCallback");
            }
        }
    }
}