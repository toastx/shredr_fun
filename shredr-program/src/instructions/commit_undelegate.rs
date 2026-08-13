//! Commit and undelegate instructions for stealth PDAs.
//!
//! These instructions manage the lifecycle of delegated stealth accounts
//! in the MagicBlock ephemeral rollup:
//!
//! - **CommitStealth**: Flush rollup state to base layer, keeping delegation active.
//! - **CommitAndUndelegateStealth**: Flush state AND release the account back to base layer.
//! - **UndelegationCallback**: Called by the delegation program after finalization (not user-invoked).
//!
//! Undelegation runs on **both** PDAs of a cycle, for different reasons: the exit
//! PDA so it can pay out on the base layer, and the drained deposit PDA so it can
//! be closed and its rent reclaimed. Both base-layer events are observable, so the
//! client must space them apart in time — issued together they re-associate the
//! two accounts and undo what the in-rollup transfer bought.
//!
//! ## Security
//!
//! - Commit operations require the relayer to sign.
//! - UndelegationCallback is invoked by the MagicBlock delegation program via CPI.

use crate::errors::ShredrError;
use crate::helpers::{get_stealth_mut, verify_stealth_pda};
use crate::AccountView;
use crate::ProgramError;
use crate::ProgramResult;

use crate::Address;
use ephemeral_rollups_pinocchio::instruction::{
    commit_accounts, commit_and_undelegate_accounts, undelegate,
};
use ephemeral_rollups_pinocchio::pda::undelegate_buffer_pda_from_delegated_account;

// ─────────────────────────────────────────────
// Commit  (keeps account delegated, just flushes state to base layer)
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Commit + Undelegate  (flush state AND release the account back to base layer)
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Undelegation callback  (called by the delegation program after finalization)
// ─────────────────────────────────────────────

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

        let stealth_state = get_stealth_mut(stealth_account)?;

        // `undelegate` derives the account it re-creates from seeds carried in
        // `ix_data`, not from anything this program pins down. Confirm what came
        // back really is this program's stealth PDA for the recorded owner, so
        // the callback can never mint a program-owned account outside the
        // `[STEALTH_ADDRESS, burner]` family.
        verify_stealth_pda(stealth_account, &stealth_state.owner)?;

        // `undelegate` has just recreated the base-layer account (program-owned)
        // and copied the buffered rollup state back verbatim — which still carries
        // `delegated = true` from initialization. Clear it now so the account
        // reflects that it lives on the base layer again; otherwise `Withdraw`
        // would permanently reject with `AlreadyDelegated` and funds could never
        // be claimed.
        stealth_state.delegated = false;

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

        // Only the MagicBlock delegation program may drive this callback, and
        // the buffer account is what proves it: the delegation program's
        // undelegation buffer is the PDA `["undelegate-buffer", stealth_account]`
        // derived from *its own* program ID, so nothing else can sign for that
        // address.
        //
        // `undelegate` checks `is_signer` but not the address, and it takes the
        // seeds of the account it re-creates straight from `ix_data`. Without
        // the address check any caller could pass their own signing keypair as
        // `buffer_account` and have `undelegate` mint a program-owned PDA of
        // their choosing with fully attacker-chosen `StealthAccount` bytes —
        // including pre-creating a victim's stealth PDA with a foreign `owner`,
        // which would make their `InitializeAndDelegate` fail forever.
        let expected_buffer =
            undelegate_buffer_pda_from_delegated_account(stealth_account.address());
        if buffer_account.address() != &expected_buffer {
            return Err(ShredrError::InvalidBufferAccount.into());
        }

        // Re-checked here (and not left to `undelegate`) so the authorization
        // argument above holds locally: the address alone means nothing if the
        // account never actually signs.
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
