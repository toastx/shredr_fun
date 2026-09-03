//! Commit and undelegate instructions for stealth PDAs.
//!
//! - **CommitStealth**: flush rollup state to base layer, stay delegated.
//! - **CommitAndUndelegateStealth**: flush and release to base layer.
//! - **UndelegationCallback**: invoked by the delegation program, not by users.
//!
//! Undelegation runs on both PDAs of a cycle — the exit PDA so it can pay out, the
//! drained deposit PDA so it can be closed. Both are observable base-layer events,
//! so the client must space them apart in time or they re-associate the accounts.
//!
//! The commit instructions never look at the account they are flushing, so the
//! shielded pool's ledger reuses them as-is. `UndelegationCallback` is the one
//! that has to know the difference: it clears the `delegated` flag, and which
//! struct that flag lives in depends on the discriminator.

use crate::errors::ShredrError;
use crate::helpers::{derive_pool_ledger, get_ledger_mut, get_stealth_mut, verify_stealth_pda};
use crate::state::{POOL_LEDGER_DISCRIMINATOR, STEALTH_ACCOUNT_DISCRIMINATOR};
use crate::AccountView;
use crate::ProgramError;
use crate::ProgramResult;

use crate::Address;
use ephemeral_rollups_pinocchio::instruction::{
    commit_accounts, commit_and_undelegate_accounts, undelegate,
};
use ephemeral_rollups_pinocchio::pda::undelegate_buffer_pda_from_delegated_account;

// ── Commit: flush state, stay delegated ──

pub struct CommitStealth<'a> {
    pub relayer: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub magic_program: &'a AccountView,
    pub magic_context: &'a AccountView,
}

impl<'a> CommitStealth<'a> {
    pub fn process(self) -> ProgramResult {
        let CommitStealth {
            relayer,
            stealth_account,
            magic_program,
            magic_context,
        } = self;

        if !relayer.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        commit_accounts(
            relayer,
            core::slice::from_ref(stealth_account),
            magic_context,
            magic_program,
            None, // magic_fee_vault — pass Some(fee_vault_account) if your setup charges fees
            None,
        )?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for CommitStealth<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, _instruction_data) = value;
        let mut iter = accounts.iter();

        let relayer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_context = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        Ok(Self {
            relayer,
            stealth_account,
            magic_program,
            magic_context,
        })
    }
}

// ── Commit + undelegate: flush and release to base layer ──

pub struct CommitAndUndelegateStealth<'a> {
    pub relayer: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub magic_program: &'a AccountView,
    pub magic_context: &'a AccountView,
}

impl<'a> CommitAndUndelegateStealth<'a> {
    pub fn process(self) -> ProgramResult {
        let CommitAndUndelegateStealth {
            relayer,
            stealth_account,
            magic_program,
            magic_context,
        } = self;

        if !relayer.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        commit_and_undelegate_accounts(
            relayer,
            core::slice::from_ref(stealth_account),
            magic_context,
            magic_program,
            None,
            None,
        )?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for CommitAndUndelegateStealth<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, _instruction_data) = value;
        let mut iter = accounts.iter();

        let relayer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_context = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        Ok(Self {
            relayer,
            stealth_account,
            magic_program,
            magic_context,
        })
    }
}

// ── Undelegation callback: driven by the delegation program ──

pub struct UndelegationCallback<'a> {
    pub stealth_account: &'a AccountView,
    pub buffer_account: &'a AccountView,
    pub payer: &'a AccountView,
    pub system_program: &'a AccountView,
    pub ix_data: &'a [u8],
}

impl<'a> UndelegationCallback<'a> {
    pub fn process(self, program_id: &Address) -> ProgramResult {
        let UndelegationCallback {
            stealth_account,
            buffer_account,
            payer,
            system_program: _,
            ix_data,
        } = self;

        undelegate(stealth_account, program_id, buffer_account, payer, ix_data)?;

        // Both branches exist to do the same one thing: the buffered state was
        // copied back verbatim and still says `delegated`. Left set, the account
        // is rejected by every base-layer instruction, forever.
        //
        // `undelegate` derives the account it re-creates from seeds in `ix_data`,
        // so each branch also re-derives the address it expects. Without that,
        // whatever came back is only asserted to be program-owned.
        let discriminator = read_discriminator(stealth_account)?;

        match discriminator {
            STEALTH_ACCOUNT_DISCRIMINATOR => {
                let stealth_state = get_stealth_mut(stealth_account)?;
                verify_stealth_pda(stealth_account, &stealth_state.owner)?;
                stealth_state.delegated = false;
            }
            POOL_LEDGER_DISCRIMINATOR => {
                let ledger_state = get_ledger_mut(stealth_account)?;
                let (expected, _) = derive_pool_ledger(ledger_state.denomination)?;
                if stealth_account.address() != &expected {
                    return Err(ShredrError::PoolMismatch.into());
                }
                ledger_state.delegated = false;
            }
            _ => return Err(ShredrError::InvalidDiscriminator.into()),
        }

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for UndelegationCallback<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, ix_data) = value;
        let mut iter = accounts.iter();

        // Order matches what the delegation program passes in the callback CPI.
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let buffer_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let payer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        // These two checks *are* the authorization: the undelegation buffer is a
        // PDA of the delegation program, so only that program can sign for it.
        // `undelegate` checks the signature but not the address, and takes the
        // seeds of the account it re-creates straight from `ix_data` — so without
        // the address check any caller could pass their own signing keypair and
        // mint a program-owned PDA with attacker-chosen state.
        let expected_buffer =
            undelegate_buffer_pda_from_delegated_account(stealth_account.address());
        if buffer_account.address() != &expected_buffer {
            return Err(ShredrError::InvalidBufferAccount.into());
        }

        // Duplicated from `undelegate` so the argument above holds locally.
        if !buffer_account.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        Ok(Self {
            stealth_account,
            buffer_account,
            payer,
            system_program,
            ix_data,
        })
    }
}

/// Read an account's 8-byte discriminator without committing to a type.
fn read_discriminator(account: &AccountView) -> Result<[u8; 8], ProgramError> {
    let data = account.try_borrow()?;
    data.get(0..8)
        .and_then(|bytes| <[u8; 8]>::try_from(bytes).ok())
        .ok_or_else(|| ShredrError::AccountDataTooSmall.into())
}
