use crate::constants::{TEE_VALIDATOR_MAINNET, seeds};
use crate::helpers::derive_stealth_account;
use crate::state::StealthAccount;
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

use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::Sysvar;
use pinocchio::AccountView;



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
    pub const DISCRIMINATOR: u8 = 0;

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
        
        let (expected_pda, bump) = derive_stealth_account(&burner,&salt)?;
    
        if stealth_account.address() != &expected_pda {
                return Err(ProgramError::InvalidSeeds);
        }
        
        // Write to StealthAccount (Assuming zero-copy/bytemuck layout)
        {
            let stealth_state = unsafe { &mut *(stealth_account.borrow_unchecked_mut().as_mut_ptr().add(8) as *mut StealthAccount) };
            let clock = Clock::get().unwrap();
    
            stealth_state.owner = &burner_pubkey;
            stealth_state.salt = salt;
            stealth_state.deposited_amount = stealth_account.lamports();
            stealth_state.deposit_timestamp = clock.unix_timestamp;
            stealth_state.delegated = true;
            stealth_state.bump = bump;
        }
        let burner_seeds = burner_pubkey.clone();
        
        let permission_program = PERMISSION_PROGRAM_ID;
    
        // Seeds for signing
        let signer_seeds: &[&[u8]] = &[
            seeds::STEALTH_ADDRESS, 
            burner_seeds.as_array(), 
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
            &permission_program,
        )
        .members(members)
        .seeds(signer_seeds)
        .invoke()?;
        
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
    
    fn try_from(value:(&'a [AccountView],&[u8])) -> Result<Self, ProgramError> {
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

