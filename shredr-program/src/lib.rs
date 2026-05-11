//! # SHREDR Privacy Program
//!
//! A Solana program implementing stealth account functionality with MagicBlock
//! ephemeral rollup delegation for private transfers.
//!
//! ## Architecture
//!
//! The program manages **stealth PDAs** derived from one-time burner keypairs.
//! Each stealth PDA tracks deposited lamports, ownership, and delegation status.
//!
//! ### Instruction Flow
//!
//! 1. **InitializeAndDelegate**: Creates a stealth PDA from a burner + salt,
//!    writes initial state, sets up ACL permissions, and delegates to a
//!    MagicBlock TEE validator for ephemeral rollup processing.
//!
//! 2. **PrivateTransfer**: Moves lamports between two stealth PDAs inside
//!    the rollup. Both accounts must be program-owned and the source must sign.
//!
//! 3. **CommitStealth**: Flushes rollup state to the base layer while keeping
//!    the account delegated.
//!
//! 4. **CommitAndUndelegateStealth**: Flushes state AND releases the account
//!    back to the base layer.
//!
//! 5. **Withdraw**: After undelegation, the owner (burner) can withdraw
//!    lamports to any destination address.
//!
//! 6. **UndelegationCallback**: Called by the MagicBlock delegation program
//!    after finalization. Not user-invoked.
//!
//! ### Security Model
//!
//! - Stealth PDAs are derived deterministically: `[STEALTH_ADDRESS, burner_pubkey, salt]`.
//! - The burner keypair is a one-time key derived client-side from `mainKey + nonce`.
//! - Private transfers happen inside the MagicBlock ephemeral rollup (TEE-secured).
//! - Withdrawals require the burner to sign and the account to be undelegated.

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
pub mod errors;

use crate::instructions::initialize_delegate::InitializeAndDelegate;
use crate::instructions::private_transfer::PrivateTransfer;
use crate::instructions::commit_undelegate::{CommitStealth, CommitAndUndelegateStealth, UndelegationCallback};
use crate::instructions::withdraw::Withdraw;

declare_id!("FfJtZKQaW7Nac8nEZKyVj64kq6Di8HtvCgzTokj2yuqi");

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

    // All TryFrom implementations use the standardized (accounts, data) signature.
    match instruction {
        InstructionDiscriminator::InitializeAndDelegate => {
            InitializeAndDelegate::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::PrivateTransfer => {
            PrivateTransfer::try_from((accounts, data))?.process()
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