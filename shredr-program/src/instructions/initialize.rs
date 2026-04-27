use ephemeral_rollups_pinocchio::acl::MemberFlags;
use pinocchio::AccountView;
use pinocchio::cpi::{invoke_signed,CpiAccount};
use pinocchio::instruction::{InstructionView,InstructionAccount};
use crate::ProgramError;
use crate::Address;
use crate::state::StealthAccount;
use crate::ProgramResult;
use crate::helpers::derive_stealth_account;
use pinocchio::sysvars::Sysvar;
use pinocchio::sysvars::clock::Clock;
use crate::constants::seeds;
use ephemeral_rollups_pinocchio::acl::CreatePermissionCpiBuilder;
use ephemeral_rollups_pinocchio::acl::MembersArgs;
use ephemeral_rollups_pinocchio::acl::Member;
use ephemeral_rollups_pinocchio::types::DelegateConfig;



pub struct InitializeAndDelegate<'a> {
    pub relayer: &'a AccountView,
    pub burner: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub permission_account: &'a AccountView,
    pub permission_program: &'a AccountView,
    pub delegation_program: &'a AccountView,
    pub system_program: &'a AccountView,
    pub salt: [u8; 32],
    pub burner_pubkey: Address,
}

impl<'a> InitializeAndDelegate<'a> {
    pub const DISCRIMINATOR: u8 = 0;

    pub fn process(self) -> ProgramResult {
        let InitializeAndDelegate {
            relayer,
            burner,
            stealth_account,
            permission_account,
            permission_program,
            delegation_program,
            system_program,
            salt,
            burner_pubkey
        } = self;
        
        let (expected_pda, bump) = derive_stealth_account(&burner,&salt)?;
    
        if stealth_account.address() != &expected_pda {
                return Err(ProgramError::InvalidSeeds);
        }
        
        // Write to StealthAccount (Assuming zero-copy/bytemuck layout)
        {
            let mut stealth_state = unsafe { &mut *(stealth_account.borrow_unchecked_mut().as_mut_ptr().add(8) as *mut StealthAccount) };
            let clock = Clock::get().unwrap();
    
            stealth_state.owner = burner_pubkey;
            stealth_state.salt = salt;
            stealth_state.deposited_amount = stealth_account.lamports();
            stealth_state.deposit_timestamp = clock.unix_timestamp;
            stealth_state.delegated = true;
            stealth_state.bump = bump;
        }
    
        // Seeds for signing
        let signer_seeds: &[&[u8]] = &[
            seeds::STEALTH_ADDRESS, 
            burner_pubkey.as_ref(), 
            salt.as_ref(), 
            &[bump]
        ];
        
        let member = [Member {
            flags: MemberFlags::new(),
            pubkey:burner_pubkey,
        }];
        
        let members = MembersArgs{
            members:Some(&member)
        };
        
        CreatePermissionCpiBuilder::new(
            stealth_account,   
            permission_account,
            relayer,
            system_program,
            permission_program.address(),
        )
        .members(members)
        .seeds(signer_seeds)
        .invoke()?;
    
        // 2. Wrap PDA with Permissions
        // Manual instruction construction for the Permission Program
        let create_perm_ix = Instruction {
            program_id: permission_program.address(),
            accounts: [
                AccountMeta::writable(ctx.stealth_account.key(), false),
                AccountMeta::writable(ctx.permission_account.key(), false),
                AccountMeta::writable(ctx.relayer.key(), true), // Payer
                AccountMeta::readonly(ctx.system_program.key(), false),
            ],
            data: build_permission_args(&ctx.burner_pubkey), // Helper to serialize args
        };
        invoke_signed(&create_perm_ix, accounts, &[signer_seeds])?;
    
        // 3. Delegate to the Ephemeral Rollup
        let delegate_ix = Instruction {
            program_id: ctx.delegation_program.key(),
            accounts: vec![
                AccountMeta::writable(ctx.stealth_account.key(), false),
                AccountMeta::readonly(ctx.relayer.key(), true),
            ],
            data: build_delegate_args(), // Helper to serialize DelegateConfig
        };
        invoke_signed(&delegate_ix, accounts, &[signer_seeds])?;
    
        Ok(())
    }
}



impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for InitializeAndDelegate<'a> {
    type Error = ProgramError;
    
    fn try_from(value:(&'a [AccountView],&[u8])) -> Result<Self, ProgramError> {
        let (accounts, instruction_data) = value;
        let mut iter = accounts.iter();

        // Parse Accounts
        let relayer = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let burner = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let permission_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let permission_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let delegation_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let system_program = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        // Parse Instruction Data
        // Expecting: [salt(32) + burner_pubkey(32)] = 64 bytes
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
            permission_program,
            delegation_program,
            system_program,
            salt,
            burner_pubkey,
        })
    }
}

