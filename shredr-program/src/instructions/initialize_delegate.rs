//! Initialize a stealth PDA and delegate it to a MagicBlock TEE validator.
//!
//! ## Accounts
//!
//! | # | Account             | Signer | Writable | Description                                    |
//! |---|---------------------|--------|----------|------------------------------------------------|
//! | 0 | relayer             | ✓      | ✓        | Pays for the transaction + rent                |
//! | 1 | burner              | ✓      | ✓        | One-time burner keypair (mainKey+nonce derived) |
//! | 2 | owner_program       |        |          | This program's address                         |
//! | 3 | stealth_account     |        | ✓        | Stealth PDA derived from the burner            |
//! | 4 | permission_account  |        | ✓        | ACL permission account                         |
//! | 5 | delegation_buffer   |        | ✓        | MagicBlock delegation buffer                   |
//! | 6 | delegation_record   |        | ✓        | MagicBlock delegation record                   |
//! | 7 | delegation_metadata |        | ✓        | MagicBlock delegation metadata                 |
//! | 8 | system_program      |        |          | System Program                                 |
//!
//! ## Instruction Data
//!
//! `[deposit_amount: u64]` — 8 bytes. The burner's identity comes from the
//! `burner` account (index 1); the PDA is `[STEALTH_ADDRESS, burner_pubkey]`, so
//! no salt or separate pubkey is passed — the one-time burner alone makes it
//! unique.
//!
//! `deposit_amount` is the amount of SOL the burner has already received and is
//! swept into the PDA here. Pass `0` to create an empty delegated PDA (used for
//! the destination account, which is funded later by a private transfer).
//!
//! ## Flow
//!
//! 1. Derive and verify the stealth PDA address from the burner.
//! 2. **Create the PDA account** via System Program CPI (relayer pays rent).
//! 3. **Sweep `deposit_amount` from the burner into the PDA** (burner signs).
//! 4. Write discriminator + stealth state.
//! 5. Create ACL permission for the burner.
//! 6. Delegate the account to MagicBlock TEE validator.
//!
//! ## Security
//!
//! - Relayer must sign (pays for account creation + delegation).
//! - Burner must sign (proves ownership of the derived keypair *and* authorizes
//!   moving its received funds into the PDA).
//! - The stealth PDA is re-derived and compared to the provided account.
//! - Account must not already exist (prevents re-initialization attacks).
//! - A discriminator is written before any state to prevent type confusion.

use crate::constants::{seeds, tee_validator, PROGRAM_ADDRESS};
use crate::errors::ShredrError;
use crate::helpers::{get_stealth_mut, verify_stealth_pda, write_stealth_discriminator};
use crate::state::STEALTH_ACCOUNT_SIZE;

use crate::Address;
use crate::{ProgramError, ProgramResult};

use ephemeral_rollups_pinocchio::acl::{
    consts::PERMISSION_PROGRAM_ID, CreatePermissionCpiBuilder, Member, MemberFlags, MembersArgs,
};
use ephemeral_rollups_pinocchio::consts::DELEGATION_PROGRAM_ID;
use ephemeral_rollups_pinocchio::instruction::delegate_account;
use ephemeral_rollups_pinocchio::types::DelegateConfig;

use pinocchio::cpi::{Seed, Signer};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;
use pinocchio::AccountView;
use pinocchio_system::instructions::{CreateAccount, Transfer};

pub struct InitializeAndDelegate<'a> {
    pub relayer: &'a AccountView,
    pub burner: &'a AccountView,
    pub owner_program: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub permission_account: &'a AccountView,
    pub delegation_buffer: &'a AccountView,
    pub delegation_record: &'a AccountView,
    pub delegation_metadata: &'a AccountView,
    pub system_program: &'a AccountView,
    pub deposit_amount: u64,
}

impl<'a> InitializeAndDelegate<'a> {
    pub fn process(self) -> ProgramResult {
        let InitializeAndDelegate {
            relayer,
            burner,
            owner_program,
            stealth_account,
            permission_account,
            delegation_buffer,
            delegation_record,
            delegation_metadata,
            system_program,
            deposit_amount,
        } = self;

        // The burner's identity is the burner account itself — no pubkey is
        // passed in the instruction data. Kept owned so its bytes can back the
        // PDA signer seeds through the CPIs below.
        let burner_key = burner.address().clone();

        let bump = verify_stealth_pda(stealth_account, &burner_key)?;

        // A PDA that is currently delegated is owned by the delegation program on
        // base, so `get_stealth_mut` below would report the misleading
        // `InvalidProgramOwner`. Name the real condition instead.
        if stealth_account.owned_by(&DELEGATION_PROGRAM_ID) {
            return Err(ShredrError::AlreadyDelegated.into());
        }

        // A stealth PDA outlives its first cycle: after `CommitAndUndelegateStealth`
        // and `Withdraw` it still holds its rent-exempt lamports. Reuse it rather
        // than refusing, so a burner can take a second deposit and the main PDA can
        // be re-delegated for the next accumulate/withdraw round.
        let is_new = stealth_account.lamports() == 0;

        if !is_new {
            let existing = get_stealth_mut(stealth_account)?;
            if existing.delegated {
                return Err(ShredrError::AlreadyDelegated.into());
            }

            if existing.owner != Address::default() && existing.owner != burner_key {
                return Err(ProgramError::IllegalOwner);
            }
        }

        // ── Step 1: Create the PDA account ──
        // The relayer pays rent. The PDA is owned by the SHREDR program.
        let account_space = (8 + STEALTH_ACCOUNT_SIZE) as u64;

        let bump_slice = [bump];

        // The PDA's own seeds, *without* the bump. The SDK helpers below
        // (`CreatePermissionCpiBuilder::invoke`, `delegate_account`) append the
        // bump themselves, so passing it here would sign with it twice.
        let pda_seeds: &[&[u8]] = &[seeds::STEALTH_ADDRESS, burner_key.as_array()];

        // System's CreateAccount requires the new account to sign, and the new
        // account is a PDA — so this program signs for it. Unlike the SDK
        // helpers, `invoke_signed` takes the full seed list, bump included.
        let create_seeds = [
            Seed::from(seeds::STEALTH_ADDRESS),
            Seed::from(burner_key.as_array()),
            Seed::from(&bump_slice),
        ];

        if is_new {
            let rent =
                Rent::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;
            let rent_lamports = rent.try_minimum_balance(account_space as usize)?;

            CreateAccount {
                from: relayer,
                to: stealth_account,
                lamports: rent_lamports,
                space: account_space,
                owner: &PROGRAM_ADDRESS,
            }
            .invoke_signed(&[Signer::from(&create_seeds)])?;
        }

        // ── Step 2: Sweep the burner's received funds into the PDA ──
        // People send SOL to the burner (a one-time keypair); the burner signs
        // here to move that deposit into its program-owned stealth PDA. The
        // relayer paid rent above, so only user funds land in `deposited_amount`,
        // preserving the invariant `lamports == rent_exempt_minimum + deposited`.
        // `deposit_amount == 0` creates an empty delegated PDA (the destination
        // account, funded later by a private transfer).
        if deposit_amount > 0 {
            Transfer {
                from: burner,
                to: stealth_account,
                lamports: deposit_amount,
            }
            .invoke()?;
        }

        // ── Step 3: Write discriminator + stealth state ──
        if is_new {
            write_stealth_discriminator(stealth_account)?;
        }

        let stealth_state = get_stealth_mut(stealth_account)?;

        let clock =
            Clock::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;

        // Accumulate: a reused PDA may still hold funds from a partial withdraw.
        let previous_deposited = stealth_state.deposited_amount;

        stealth_state.owner = burner_key.clone();
        stealth_state.deposited_amount = previous_deposited
            .checked_add(deposit_amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        // Keep the original deposit time across a top-up; stamp it when funds
        // first land in an empty account.
        if previous_deposited == 0 {
            stealth_state.deposit_timestamp = clock.unix_timestamp;
        }
        stealth_state.delegated = true;
        stealth_state.bump = bump;

        // ── Step 4: Create ACL permission for the burner ──
        // `cpi_create_permission` forwards a bare create, so a second one on an
        // existing permission PDA fails. The member set never changes for a given
        // stealth PDA (the burner is baked into its derivation), so on reuse the
        // permission from the previous cycle is still correct.
        if permission_account.lamports() == 0 {
            let member = [Member {
                flags: MemberFlags::new(),
                pubkey: burner_key.clone(),
            }];

            let members = MembersArgs {
                members: Some(&member),
            };

            CreatePermissionCpiBuilder::new(
                stealth_account,
                permission_account,
                relayer,
                system_program,
                &PERMISSION_PROGRAM_ID,
            )
            .members(members)
            .seeds(pda_seeds)
            .bump(bump)
            .invoke()?;
        }

        // ── Step 5: Delegate to MagicBlock TEE validator ──
        // The validator is selected at build time by Cargo feature (see
        // `constants::tee_validator`): pinned on mainnet, network-default on devnet.
        let delegate_config = DelegateConfig {
            validator: tee_validator(),
            ..Default::default()
        };

        // The relayer is the delegation payer, not the burner: `cpi_delegate`
        // marks this account `writable_signer` so the delegation program can
        // fund `delegation_record` and `delegation_metadata`, and Step 2 has
        // already swept the burner's entire balance into the stealth PDA. The
        // relayer also paid the PDA's rent in Step 1, so this keeps the
        // invariant that `deposited_amount` holds only user funds.
        delegate_account(
            &[
                relayer,
                stealth_account,
                owner_program,
                delegation_buffer,
                delegation_record,
                delegation_metadata,
                system_program,
            ],
            pda_seeds,
            bump,
            delegate_config,
        )?;

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for InitializeAndDelegate<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &[u8])) -> Result<Self, ProgramError> {
        let (accounts, instruction_data) = value;
        let mut iter = accounts.iter();

        let relayer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let burner = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let owner_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let permission_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_buffer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_record = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_metadata = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        if !relayer.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }
        if !burner.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // Expecting: [deposit_amount(8)] = 8 bytes
        if instruction_data.len() < 8 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let deposit_amount = u64::from_le_bytes(
            instruction_data[0..8]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );

        Ok(Self {
            relayer,
            burner,
            stealth_account,
            permission_account,
            owner_program,
            delegation_buffer,
            delegation_record,
            delegation_metadata,
            system_program,
            deposit_amount,
        })
    }
}
