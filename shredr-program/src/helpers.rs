use pinocchio::error::ProgramError;
use pinocchio::Address;
use pinocchio::AccountView;
use crate::constants::PROGRAM_ADDRESS;
use crate::constants::seeds;

pub fn parse_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != core::mem::size_of::<u64>() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amt = u64::from_le_bytes(data.try_into().unwrap());
    if amt == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(amt)
}

pub fn derive_stealth_account(owner: &AccountView,salt:&[u8;32]) -> Result<(Address, u8), ProgramError> {
    let stealth_key = Address::derive_program_address(&[seeds::STEALTH_ADDRESS, owner.address().as_ref(),salt.as_ref()], &PROGRAM_ADDRESS).ok_or(ProgramError::InvalidAccountData);
    stealth_key
}