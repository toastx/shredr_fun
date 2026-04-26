use pinocchio::error::ProgramError;
use pinocchio::Address;
use pinocchio::AccountView;
use crate::constants::PROGRAM_ADDRESS;

fn parse_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != core::mem::size_of::<u64>() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amt = u64::from_le_bytes(data.try_into().unwrap());
    if amt == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(amt)
}

fn derive_stealth_account(owner: &AccountView) -> Result<(Address, u8), ProgramError> {
    let vault_key = Address::derive_program_address(&[b"vault", owner.address().as_ref()], &PROGRAM_ADDRESS).ok_or(ProgramError::InvalidAccountData);
    vault_key
}