//! Close a spent stealth PDA and reclaim its rent.
//!
//! ## Accounts
//!
//! | # | Account          | Signer | Writable | Description                                  |
//! |---|------------------|--------|----------|----------------------------------------------|
//! | 0 | owner            | ✓      |          | Burner that owns the stealth account         |
//! | 1 | stealth_account  |        | ✓        | Stealth PDA to close                         |
//! | 2 | rent_payee       |        | ✓        | Receives the reclaimed rent (the relayer)    |
//!
//! ## Instruction Data
//!
//! None.
//!
//! ## When it runs
//!
//! Both stealth PDA roles end here, and both are one-shot because the client
//! rotates burners:
//!
//! - **Deposit PDA** — after its balance has been moved to an exit PDA inside the
//!   rollup by `PrivateTransfer`, then committed and undelegated.
//! - **Exit PDA** — after `Withdraw` has paid out to a base-layer address.
//!
//! Without this, every cycle would permanently strand the relayer's rent (~0.0011
//! SOL per PDA) and leave a program-owned account that anyone can enumerate.
//!
//! ## Security
//!
//! - The owner (burner) must sign, and must match the PDA's recorded `owner`.
//! - The account must be the real `[STEALTH_ADDRESS, burner]` derivation, not just
//!   some program-owned account carrying a valid discriminator.
//! - The account must be undelegated — closing is a base-layer operation.
//! - `deposited_amount` must be zero. This is the interlock that keeps `Close`
//!   from ever becoming a theft primitive: an account holding user funds cannot
//!   be closed, so the only lamports this instruction can ever move are the
//!   rent-exempt minimum.
//!
//! ## Privacy note
//!
//! Closing the deposit PDA and closing the exit PDA are both *base-layer* events.
//! Issued in one transaction, or close together in time, they re-associate the two
//! accounts — undoing exactly what moving the transfer into the rollup bought. The
//! client must decorrelate them in time, and should pass the shared relayer as
//! `rent_payee`: a counterparty common to every user is an anonymity set, not a
//! leak.
//!
//! `rent_payee` is chosen by the burner even though the relayer paid the rent, so
//! a user can route it to themselves. The relayer pays the transaction fee and so
//! decides whether the close happens at all; not worth enforcing on-chain.

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

        let stealth_data = get_stealth_mut(stealth_account)?;

        if &stealth_data.owner != owner.address() {
            return Err(ProgramError::IllegalOwner);
        }

        verify_stealth_pda(stealth_account, owner.address())?;

        // Closing is a base-layer operation. A delegated account is owned by the
        // delegation program, so `get_stealth_mut` above would already have
        // failed — this catches the case where the flag outlived the ownership.
        if stealth_data.delegated {
            return Err(ShredrError::AlreadyDelegated.into());
        }

        // The interlock: only a spent PDA can be closed, so the lamports moved
        // below are always just the rent-exempt minimum.
        if stealth_data.deposited_amount != 0 {
            return Err(ShredrError::AccountNotEmpty.into());
        }

        // Sweep the rent, then hand the account back to the System Program. This
        // mirrors `ephemeral_rollups_pinocchio::utils::close_pda_acc`, open-coded
        // to keep the crate's checked-arithmetic convention.
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

        // SAFETY: the account is program-owned (checked by `get_stealth_mut`), is
        // the verified stealth PDA, and has been drained to zero lamports and zero
        // data above. The `&mut StealthAccount` from `get_stealth_mut` is dead by
        // this point — `resize(0)` has already invalidated that view, and nothing
        // reads it afterwards.
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

        // Paying the rent to the account being closed would credit and debit the
        // same account, which the runtime rejects as a lamports imbalance. Fail
        // early with a clear error, as `Withdraw` does for its destination.
        if rent_payee.address() == stealth_account.address() {
            return Err(ShredrError::SelfTransferNotAllowed.into());
        }

        if !owner.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // A still-delegated PDA is owned by the delegation program on base layer,
        // so `get_stealth_mut` would report the misleading `InvalidProgramOwner`.
        // Name the real condition instead, as `InitializeAndDelegate` does.
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
