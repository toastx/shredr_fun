//! # SHREDR Privacy Program
//!
//! Stealth accounts on Solana, using MagicBlock ephemeral rollup delegation to
//! keep transfers private. State lives in **stealth PDAs** derived from one-time
//! burner keypairs, each tracking ownership, deposited lamports, and delegation.
//!
//! ## Account roles
//!
//! A cycle uses two stealth PDAs: a **deposit PDA** receives funds sent to a
//! one-time burner, and an **exit PDA** receives them *inside the rollup* before
//! undelegating and paying out on the base layer. The hop between them never
//! appears on Solana, so the address that takes a deposit is not the one that
//! pays it out.
//!
//! **The program does not distinguish the two roles**, and should not start to.
//! Both are `[STEALTH_ADDRESS, burner_pubkey]`; the roles are a client
//! convention, which is what lets every instruction apply one uniform set of
//! checks.
//!
//! ### Instructions
//!
//! 1. **InitializeAndDelegate** — create a stealth PDA, set up ACL permissions,
//!    delegate to a MagicBlock TEE validator.
//! 2. **PrivateTransfer** — deposit PDA → exit PDA, inside the rollup.
//! 3. **CommitStealth** — flush rollup state, stay delegated.
//! 4. **CommitAndUndelegateStealth** — flush and release to the base layer. Runs
//!    on both PDAs: the deposit PDA once drained, the exit PDA before payout.
//! 5. **Withdraw** — exit PDA → any address, once undelegated.
//! 6. **CloseStealthAccount** — reclaim a spent PDA's rent. Both PDAs end here.
//! 7. **UndelegationCallback** — invoked by the delegation program, not by users.
//!
//! ### Security model
//!
//! - The burner is a one-time key derived client-side from `mainKey + nonce`.
//! - Private transfers happen inside the TEE-secured ephemeral rollup.
//! - Withdrawals require the burner to sign and the account to be undelegated.
//! - Amount- and timing-correlation resistance are **client-side policy**; the
//!   program accepts any amount and imposes no delay. See `constants`.

#![no_std]
#![allow(unexpected_cfgs)]

use pinocchio::{entrypoint, error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_pubkey::declare_id;
entrypoint!(process_instruction);
pub mod constants;
pub mod errors;
pub mod helpers;
pub mod instructions;
pub mod state;

use crate::instructions::close::CloseStealthAccount;
use crate::instructions::commit_undelegate::{
    CommitAndUndelegateStealth, CommitStealth, UndelegationCallback,
};
use crate::instructions::initialize_delegate::InitializeAndDelegate;
use crate::instructions::private_transfer::PrivateTransfer;
use crate::instructions::withdraw::Withdraw;

declare_id!("H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6");

#[derive(Copy, Clone, PartialEq, Eq)]
enum InstructionDiscriminator {
    InitializeAndDelegate,
    PrivateTransfer,
    CommitStealth,
    CommitAndUndelegateStealth,
    Withdraw,
    CloseStealthAccount,
    UndelegationCallback,
}

impl InstructionDiscriminator {
    const INITIALIZE_AND_DELEGATE: u8 = 0;
    const PRIVATE_TRANSFER: u8 = 1;
    const COMMIT_STEALTH: u8 = 2;
    const COMMIT_AND_UNDELEGATE_STEALTH: u8 = 3;
    const WITHDRAW: u8 = 4;
    const CLOSE_STEALTH_ACCOUNT: u8 = 5;
    // Undelegation callback called by the delegation program
    const UNDELEGATION_CALLBACK: u8 = 0xFF;

    fn from_byte(byte: u8) -> Result<Self, ProgramError> {
        match byte {
            Self::INITIALIZE_AND_DELEGATE => Ok(Self::InitializeAndDelegate),
            Self::PRIVATE_TRANSFER => Ok(Self::PrivateTransfer),
            Self::COMMIT_STEALTH => Ok(Self::CommitStealth),
            Self::COMMIT_AND_UNDELEGATE_STEALTH => Ok(Self::CommitAndUndelegateStealth),
            Self::WITHDRAW => Ok(Self::Withdraw),
            Self::CLOSE_STEALTH_ACCOUNT => Ok(Self::CloseStealthAccount),
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
            PrivateTransfer::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::CommitStealth => {
            CommitStealth::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::CommitAndUndelegateStealth => {
            CommitAndUndelegateStealth::try_from((accounts, data))?.process()
        }
        InstructionDiscriminator::Withdraw => Withdraw::try_from((accounts, data))?.process(),
        InstructionDiscriminator::CloseStealthAccount => {
            CloseStealthAccount::try_from((accounts, data))?.process()
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
            InstructionDiscriminator::CloseStealthAccount => {
                pinocchio_log::log!("CloseStealthAccount");
            }
            InstructionDiscriminator::UndelegationCallback => {
                pinocchio_log::log!("UndelegationCallback");
            }
        }
    }
}
