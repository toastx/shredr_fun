//! Close a spent stealth PDA and reclaim its rent. Accounts are listed in `idl.rs`.
//!
//! Both roles end here: the deposit PDA once `PrivateTransfer` has emptied it, the
//! exit PDA once `Withdraw` has paid out — in each case after undelegation.
//! Without it every cycle strands the relayer's rent and leaves an enumerable
//! program-owned account behind.
//!
//! Sweeps the account's whole remaining balance, not a computed rent figure.
//! With `deposited_amount == 0` enforced, that is the rent plus anything sent
//! directly to the PDA address after initialization — uncredited by definition,
//! since nothing observed it arrive. Only the recorded owner can ever close, so
//! this is the burner recovering their own residue, not a path to anyone else's
//! funds.
//!
//! Closing both PDAs are *base-layer* events; issued together they re-associate
//! the two accounts and undo what the in-rollup hop bought, so the client must
//! space them apart in time. `rent_payee` should be the shared relayer — a
//! counterparty common to every user is an anonymity set, not a leak. It is the
//! burner's choice rather than the rent payer's, but the relayer pays the fee and
//! so decides whether the close happens at all.

use crate::errors::ShredrError;
use crate::helpers::{get_stealth_mut, verify_stealth_pda};
use crate::AccountView;
use crate::ProgramError;
use crate::ProgramResult;

use ephemeral_rollups_pinocchio::consts::DELEGATION_PROGRAM_ID;

pub struct CloseStealthAccount<'a> {
    pub owner: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub rent_payee: &'a AccountView,
}

impl<'a> CloseStealthAccount<'a> {
    pub fn process(self) -> ProgramResult {
        let CloseStealthAccount {
            owner,
            stealth_account,
            rent_payee,
        } = self;

        // Scoped so the borrow provably ends before `resize(0)` below, which is
        // what invalidates it. Left open, a later read of `stealth_data` after
        // the resize would be undefined behaviour that still compiles.
        {
            let stealth_data = get_stealth_mut(stealth_account)?;

            if &stealth_data.owner != owner.address() {
                return Err(ProgramError::IllegalOwner);
            }

            verify_stealth_pda(stealth_account, owner.address())?;

            // Catches a `delegated` flag that outlived the ownership change.
            if stealth_data.delegated {
                return Err(ShredrError::AlreadyDelegated.into());
            }

            // The interlock that keeps this from becoming a theft primitive: a
            // funded PDA never closes, so this can only ever move residue.
            if stealth_data.deposited_amount != 0 {
                return Err(ShredrError::AccountNotEmpty.into());
            }
        }

        let remaining = stealth_account.lamports();
        let payee_lamports = rent_payee
            .lamports()
            .checked_add(remaining)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        rent_payee.set_lamports(payee_lamports);
        stealth_account.set_lamports(0);

        stealth_account
            .resize(0)
            .map_err(|_| -> ProgramError { ShredrError::AccountDataTooSmall.into() })?;

        // SAFETY: verified program-owned stealth PDA, now at zero lamports and
        // zero data. The `&mut StealthAccount` ended with the block above, so
        // nothing holds a reference into the buffer `resize(0)` just shrank.
        unsafe { stealth_account.assign(&pinocchio_system::ID) };

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for CloseStealthAccount<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, _instruction_data) = value;
        let mut iter = accounts.iter();

        let owner = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let rent_payee = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        // Paying into the account being closed credits and debits the same account,
        // which the runtime rejects as a lamports imbalance.
        if rent_payee.address() == stealth_account.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        if !owner.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // Delegated PDAs are owned by the delegation program, so `get_stealth_mut`
        // would report the misleading `InvalidProgramOwner`.
        if stealth_account.owned_by(&DELEGATION_PROGRAM_ID) {
            return Err(ShredrError::AlreadyDelegated.into());
        }

        Ok(Self {
            owner,
            stealth_account,
            rent_payee,
        })
    }
}
