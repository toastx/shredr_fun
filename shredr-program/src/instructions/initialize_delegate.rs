//! Initialize a stealth PDA and delegate it to a MagicBlock TEE validator.
//!
//! ## Accounts
//!
//! | # | Account             | Signer | Writable | Description                                    |
//! |---|---------------------|--------|----------|------------------------------------------------|
//! | 0 | relayer             | ✓      | ✓        | Pays for the transaction + rent                |
//! | 1 | burner              | ✓      | ✓        | One-time burner keypair (mainKey+nonce derived) |
//! | 2 | owner_program       |        |          | This program's address                         |
//! | 3 | stealth_account     |        | ✓        | Stealth PDA derived from burner+salt           |
//! | 4 | permission_account  |        | ✓        | ACL permission account                         |
//! | 5 | delegation_buffer   |        | ✓        | MagicBlock delegation buffer                   |
//! | 6 | delegation_record   |        | ✓        | MagicBlock delegation record                   |
//! | 7 | delegation_metadata |        | ✓        | MagicBlock delegation metadata                 |
//! | 8 | system_program      |        |          | System Program                                 |
//!
//! ## Instruction Data
//!
//! `[salt: [u8; 32], burner_pubkey: [u8; 32], commit_delay: i64]` — 72 bytes total.
//!
//! ## Flow
//!
//! 1. Derive and verify the stealth PDA address.
//! 2. **Create the PDA account** via System Program CPI (relayer pays rent).
//! 3. Write discriminator + stealth state.
//! 4. Create ACL permission for the burner.
//! 5. Delegate the account to MagicBlock TEE validator.
//!
//! ## Security
//!
//! - Relayer must sign (pays for account creation + delegation).
//! - Burner must sign (proves ownership of the derived keypair).
//! - The stealth PDA is re-derived and compared to the provided account.
//! - Account must not already exist (prevents re-initialization attacks).
//! - A discriminator is written before any state to prevent type confusion.

use crate::constants::{PROGRAM_ADDRESS, TEE_VALIDATOR_MAINNET, seeds};
use crate::errors::ShredrError;
use crate::helpers::{get_stealth_mut, verify_stealth_pda, write_stealth_discriminator};
use crate::state::STEALTH_ACCOUNT_SIZE;

use crate::{Address, ProgramError, ProgramResult};

use ephemeral_rollups_pinocchio::acl::{
    consts::PERMISSION_PROGRAM_ID,
    CreatePermissionCpiBuilder,
    Member,
    MemberFlags,
    MembersArgs,
};
use ephemeral_rollups_pinocchio::instruction::delegate_account;
use ephemeral_rollups_pinocchio::types::DelegateConfig;

use pinocchio::cpi::Signer;
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;
use pinocchio::AccountView;
use pinocchio_system::instructions::CreateAccount;


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
    pub salt: [u8; 32],
    pub burner_pubkey: Address,
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
            salt,
            burner_pubkey
        } = self;

        // Verify PDA derivation matches the provided stealth_account
        let bump = verify_stealth_pda(stealth_account, &burner_pubkey, &salt)?;

        // Guard: account must not already exist (lamports == 0 means uninitialized)
        if stealth_account.lamports() > 0 {
            return Err(ShredrError::AccountAlreadyInitialized.into());
        }

        // ── Step 1: Create the PDA account ──
        // The relayer pays rent. The PDA is owned by the SHREDR program.
        let account_space = (8 + STEALTH_ACCOUNT_SIZE) as u64;

        let rent = Rent::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;
        let rent_lamports = rent.try_minimum_balance(account_space as usize)?;

        // Keep an owned copy for PDA signer seeds (needs to outlive the CPI calls)
        let burner_for_seeds = burner_pubkey.clone();

        // Seeds for PDA signing
        let bump_slice = [bump];
        
        CreateAccount {
            from: relayer,
            to: stealth_account,
            lamports: rent_lamports,
            space: account_space,
            owner: &PROGRAM_ADDRESS,
        }
        .invoke()?;

        // ── Step 2: Write discriminator + stealth state ──
        write_stealth_discriminator(stealth_account);

        // Safely get mutable reference to stealth state
        let stealth_state = get_stealth_mut(stealth_account)?;

        // Get clock, propagating error instead of panicking
        let clock = Clock::get().map_err(|_| -> ProgramError { ShredrError::ClockUnavailable.into() })?;

        stealth_state.owner = burner_pubkey.clone();
        stealth_state.salt = salt;
        stealth_state.deposited_amount = stealth_account.lamports();
        stealth_state.deposit_timestamp = clock.unix_timestamp;
        stealth_state.delegated = true;
        stealth_state.bump = bump;

        // ── Step 3: Create ACL permission for the burner ──
        let permission_program = PERMISSION_PROGRAM_ID;

        let signer_seeds: &[&[u8]] = &[
            seeds::STEALTH_ADDRESS,
            burner_for_seeds.as_array(),
            salt.as_ref(),
            &bump_slice,
        ];

        let member = [Member {
            flags: MemberFlags::new(),
            pubkey: burner_pubkey,
        }];

        let members = MembersArgs {
            members: Some(&member)
        };

        CreatePermissionCpiBuilder::new(
            stealth_account,
            permission_account,
            relayer,
            system_program,
            &permission_program,
        )
        .members(members)
        .seeds(signer_seeds)
        .invoke()?;

        // ── Step 4: Delegate to MagicBlock TEE validator ──
        let delegate_config = DelegateConfig {
            validator: Some(Address::from_str_const(TEE_VALIDATOR_MAINNET)),
            ..Default::default()
        };

        delegate_account(&[
            burner,
            stealth_account,
            owner_program,
            delegation_buffer,
            delegation_record,
            delegation_metadata,
            system_program
        ], signer_seeds, bump, delegate_config)?;

        Ok(())
    }
}



impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for InitializeAndDelegate<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &[u8])) -> Result<Self, ProgramError> {
        let (accounts, instruction_data) = value;
        let mut iter = accounts.iter();

        // Parse Accounts
        let relayer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let burner = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let owner_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let permission_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_buffer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_record = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_metadata = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        // Signer checks — relayer and burner must sign
        if !relayer.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }
        if !burner.is_signer() {
            return Err(ShredrError::MissingSigner.into());
        }

        // Parse Instruction Data
        // Expecting: [salt(32) + burner_pubkey(32)] = 64 bytes minimum
        if instruction_data.len() < 64 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let salt: [u8; 32] = instruction_data[0..32].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
        let burner_pubkey = Address::new_from_array(
            instruction_data[32..64]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?
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
            salt,
            burner_pubkey,
        })
    }
}

