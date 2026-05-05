use crate::ProgramError;
use crate::AccountView;
use crate::ProgramResult;
use crate::Address;
use crate::state::StealthAccount;
use crate::helpers::parse_amount;

pub struct Withdraw<'a> {
    pub owner: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub destination: &'a AccountView,
    pub amount: u64,
}

impl<'a> Withdraw<'a> {
    pub const DISCRIMINATOR: u8 = 4;

    pub fn process(self) -> ProgramResult {
        let Withdraw {
            owner,
            stealth_account,
            destination,
            amount,
        } = self;

        let stealth_data = unsafe {
            &mut *(stealth_account
                .borrow_unchecked_mut()
                .as_mut_ptr()
                .add(8) as *mut StealthAccount)
        };

        // Owner check
        if stealth_data.owner != owner.address() {
            return Err(ProgramError::IllegalOwner);
        }

        // Must be undelegated — can only withdraw on base layer
        if stealth_data.delegated {
            return Err(ProgramError::InvalidAccountData);
        }

        // Owner must sign
        if !owner.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Amount check
        if stealth_data.deposited_amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }

        // Transfer lamports: stealth_account -> destination
        let new_stealth_lamports = stealth_account
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        let new_destination_lamports = destination
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        stealth_account.set_lamports(new_stealth_lamports);
        destination.set_lamports(new_destination_lamports);

        // Update state
        stealth_data.deposited_amount = stealth_data
            .deposited_amount
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        // If fully drained, zero out the account state
        if stealth_data.deposited_amount == 0 {
            stealth_data.owner = &Address::default();
            stealth_data.delegated = false;
            stealth_data.bump = 0;
        }

        Ok(())
    }
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for Withdraw<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        let (accounts, instruction_data) = value;
        let mut iter = accounts.iter();

        let owner           = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let stealth_account = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let destination     = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;

        let amount = parse_amount(instruction_data)?;

        if !owner.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            owner,
            stealth_account,
            destination,
            amount,
        })
    }
}