//! Initialize a stealth PDA and delegate it to a MagicBlock TEE validator.
//!
//! Instruction data is `[deposit_amount: u64]`; accounts are listed in `idl.rs`.
//! `deposit_amount > 0` sweeps the burner's funds in (deposit PDA), `0` creates an
//! empty PDA to be funded later by a `PrivateTransfer` (exit PDA). The program
//! stores no role marker — the distinction is the client's.
//!
//! Both PDAs in a cycle must be delegated to the *same* validator or the transfer
//! between them is not executable — see `constants::tee_validator`.

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
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

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

        // Owned so its bytes can back the PDA signer seeds through the CPIs below.
        let burner_key = burner.address().clone();

        let bump = verify_stealth_pda(stealth_account, &burner_key)?;

        // Delegated PDAs are owned by the delegation program, so `get_stealth_mut`
        // would report the misleading `InvalidProgramOwner`.
        if stealth_account.owned_by(&DELEGATION_PROGRAM_ID) {
            return Err(ShredrError::AlreadyDelegated.into());
        }

        // "Initialized" means owned-with-data, not merely funded: anyone can send a
        // lamport to a derivable address, and keying off the balance would let that
        // brick the PDA forever. An existing undelegated PDA is reused, not refused.
        let is_new = !stealth_account.owned_by(&PROGRAM_ADDRESS) || stealth_account.data_len() == 0;

        if !is_new {
            let existing = get_stealth_mut(stealth_account)?;
            if existing.delegated {
                return Err(ShredrError::AlreadyDelegated.into());
            }

            if existing.owner != Address::default() && existing.owner != burner_key {
                return Err(ProgramError::IllegalOwner);
            }
        }

        // ── Step 1: Create the PDA account (relayer pays rent) ──
        let account_space = (8 + STEALTH_ACCOUNT_SIZE) as u64;

        let bump_slice = [bump];

        // Bump omitted: the SDK helpers below append it themselves, so including it
        // here would sign with it twice.
        let pda_seeds: &[&[u8]] = &[seeds::STEALTH_ADDRESS, burner_key.as_array()];

        // `invoke_signed`, unlike those helpers, wants the full seed list.
        let create_seeds = [
            Seed::from(seeds::STEALTH_ADDRESS),
            Seed::from(burner_key.as_array()),
            Seed::from(&bump_slice),
        ];

        if is_new {
            let rent = Rent::get()
                .map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;
            let rent_lamports = rent.try_minimum_balance(account_space as usize)?;
            let existing_lamports = stealth_account.lamports();

            if existing_lamports == 0 {
                CreateAccount {
                    from: relayer,
                    to: stealth_account,
                    lamports: rent_lamports,
                    space: account_space,
                    owner: &PROGRAM_ADDRESS,
                }
                .invoke_signed(&[Signer::from(&create_seeds)])?;
            } else {
                // Pre-funded address: CreateAccount refuses a non-empty account, so
                // do the three steps it fuses. The lamports already here are not
                // credited to `deposited_amount` — their sender is unknown, so they
                // must not become a balance the burner can claim.
                let shortfall = rent_lamports.saturating_sub(existing_lamports);
                if shortfall > 0 {
                    Transfer {
                        from: relayer,
                        to: stealth_account,
                        lamports: shortfall,
                    }
                    .invoke()?;
                }

                Allocate {
                    account: stealth_account,
                    space: account_space,
                }
                .invoke_signed(&[Signer::from(&create_seeds)])?;

                Assign {
                    account: stealth_account,
                    owner: &PROGRAM_ADDRESS,
                }
                .invoke_signed(&[Signer::from(&create_seeds)])?;
            }
        }

        // ── Step 2: Sweep the burner's received funds into the PDA ──
        // The relayer paid rent above, so only user funds land in
        // `deposited_amount`, preserving `lamports == rent_minimum + deposited`.
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
        // Preserve the original deposit time across a top-up.
        if previous_deposited == 0 {
            stealth_state.deposit_timestamp = clock.unix_timestamp;
        }
        stealth_state.delegated = true;
        stealth_state.bump = bump;

        // ── Step 4: Create ACL permission for the burner ──
        // A bare create, so it fails on an existing permission PDA. The member set
        // never changes for a given stealth PDA (the burner is baked into its
        // derivation), so on reuse the previous cycle's permission still holds.
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
        let delegate_config = DelegateConfig {
            validator: tee_validator(),
            ..Default::default()
        };

        // The relayer, not the burner, is the delegation payer: this account funds
        // `delegation_record` and `delegation_metadata`, and Step 2 already swept
        // the burner dry.
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

        // `delegate_account` uses `owner_program` as the delegation buffer's owner,
        // and only its derived bump is checked — one byte, so a caller can grind a
        // colliding address and take the buffer. Pin it.
        if owner_program.address() != &PROGRAM_ADDRESS {
            return Err(ProgramError::IncorrectProgramId);
        }

        if system_program.address() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }

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
