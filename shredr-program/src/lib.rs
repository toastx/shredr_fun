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
//! ### Account roles
//!
//! A full cycle uses two stealth PDAs:
//!
//! - **Deposit PDA** — receives the funds sent to a one-time burner.
//! - **Exit PDA** — receives those funds *inside the rollup*, then undelegates
//!   and pays out on the base layer.
//!
//! The hop between them happens in the rollup and is invisible on Solana, so the
//! address that receives a deposit is never the address that pays it out.
//!
//! **The program does not distinguish these roles**, and should not start to.
//! Both are the same derivation, `[STEALTH_ADDRESS, burner_pubkey]`, and which
//! one is a deposit and which an exit is purely a client convention. Keeping the
//! roles out of on-chain state is what lets every instruction apply one uniform
//! set of checks.
//!
//! ### Instruction Flow
//!
//! 1. **InitializeAndDelegate**: Creates a stealth PDA from a burner, writes
//!    initial state, sets up ACL permissions, and delegates to a MagicBlock TEE
//!    validator. `deposit_amount > 0` sweeps the burner's funds in (deposit PDA);
//!    `0` creates an empty delegated PDA to be funded later (exit PDA).
//!
//! 2. **PrivateTransfer**: Moves lamports from the deposit PDA to the exit PDA
//!    inside the rollup. Both accounts must be program-owned and delegated to the
//!    same validator, and the source's burner must sign.
//!
//! 3. **CommitStealth**: Flushes rollup state to the base layer while keeping
//!    the account delegated.
//!
//! 4. **CommitAndUndelegateStealth**: Flushes state AND releases the account
//!    back to the base layer. Runs on both PDAs — the deposit PDA once drained,
//!    the exit PDA before it pays out.
//!
//! 5. **Withdraw**: After undelegation, the owner (burner) can withdraw
//!    lamports from the exit PDA to any destination address.
//!
//! 6. **CloseStealthAccount**: Reclaims the rent from a spent PDA and hands it
//!    back to the System Program. Both PDAs end here; without it every cycle
//!    strands the relayer's rent and leaves an enumerable account behind.
//!
//! 7. **UndelegationCallback**: Called by the MagicBlock delegation program
//!    after finalization. Not user-invoked.
//!
//! ### Security Model
//!
//! - Stealth PDAs are derived deterministically: `[STEALTH_ADDRESS, burner_pubkey]`.
//! - The burner keypair is a one-time key derived client-side from `mainKey + nonce`.
//! - Private transfers happen inside the MagicBlock ephemeral rollup (TEE-secured).
//! - Withdrawals require the burner to sign and the account to be undelegated.
//!
//! ### What this program does *not* enforce
//!
//! Amount- and timing-correlation resistance are **client-side policy**. The
//! program accepts any deposit and withdrawal amount and imposes no delay between
//! them. Since a deposit now flows to a single exit PDA rather than through a
//! shared aggregation account, an on-chain observer who sees both legs can link
//! them by amount alone. Normalizing deposit sizes and spacing the base-layer
//! legs apart in time is the client's responsibility.

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
