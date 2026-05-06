use crate::ProgramError;
use crate::AccountView;
use crate::ProgramResult;

use ephemeral_rollups_pinocchio::instruction::{
    commit_accounts,
    commit_and_undelegate_accounts,
    undelegate,
};
use crate::Address;

// ─────────────────────────────────────────────
// Commit  (keeps account delegated, just flushes state to base layer)
// ─────────────────────────────────────────────

pub struct CommitStealth<'a> {
    pub relayer:         &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub magic_program:   &'a AccountView,
    pub magic_context:   &'a AccountView,
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

        let relayer         = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_program   = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_context   = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

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
    pub relayer:         &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub magic_program:   &'a AccountView,
    pub magic_context:   &'a AccountView,
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
            None
        )?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for CommitAndUndelegateStealth<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, _instruction_data) = value;
        let mut iter = accounts.iter();

        let relayer         = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_program   = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let magic_context   = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

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
    pub buffer_account:  &'a AccountView,
    pub payer:           &'a AccountView,
    pub system_program:  &'a AccountView,
    pub ix_data:         &'a [u8],
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
        let buffer_account  = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let payer           = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program  = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        Ok(Self {
            stealth_account,
            buffer_account,
            payer,
            system_program,
            ix_data,
        })
    }
}