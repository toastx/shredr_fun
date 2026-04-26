use crate::ProgramError;
use crate::AccountView;
use crate::ProgramResult;
use crate::state::StealthAccount;
use crate::helpers::parse_amount;


pub struct PrivateTransfer<'a> {
    pub source_pda: &'a mut AccountView,
    pub destination_pda: &'a mut AccountView,
    pub amount: u64,
}

impl<'a> PrivateTransfer<'a> {
    pub const DISCRIMINATOR: u8 = 0;

    pub fn process(self) -> ProgramResult {
        let PrivateTransfer {
            source_pda,
            destination_pda,
            amount,
        } = self;

        let source_data = unsafe { &mut *(source_pda.borrow_unchecked_mut().as_mut_ptr().add(8) as *mut StealthAccount) };
        let destination_data = unsafe { &mut *(destination_pda.borrow_unchecked_mut().as_mut_ptr().add(8) as *mut StealthAccount) };

        let mut source_lamports  = source_pda.lamports();
        let mut destination_lamports = destination_pda.lamports();

        if source_data.deposited_amount < amount {
            return Err(ProgramError::InsufficientFunds);
        }
        
        source_lamports = source_lamports
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        source_pda.set_lamports(source_lamports);

        source_data.deposited_amount = source_data.deposited_amount
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        
        destination_lamports = destination_lamports
            .checked_add(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        destination_pda.set_lamports(destination_lamports);

        destination_data.deposited_amount = destination_data.deposited_amount
            .checked_add(amount)
            .ok_or(ProgramError::InsufficientFunds)?;

        // log!("{} transfered from {} to {}", amount, source_pda.address().into(), destination_pda.address().into());
        Ok(())
    }
}

impl<'a> TryFrom<(&'a [u8], &'a mut [AccountView])> for PrivateTransfer<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [u8], &'a mut [AccountView])) -> Result<Self, Self::Error> {
        let (data, accounts) = value;
        if accounts.len() < 2 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let mut iter = accounts.iter_mut();
        let source_pda = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let destination_pda = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let amount = parse_amount(data)?;
        
        if !source_pda.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        
        Ok(Self {
            source_pda,
            destination_pda,
            amount,
        })
    }
}
