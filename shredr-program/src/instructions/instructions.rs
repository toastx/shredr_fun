// instructions.rs
use core::convert::TryFrom;
use core::mem::size_of;
use pinocchio::AccountView;
use pinocchio::ProgramResult;
use pinocchio::sysvars::{rent::Rent, Sysvar};
use pinocchio::Address;

use pinocchio::error::ProgramError;
use pinocchio::cpi::{Seed,Signer};
use pinocchio_log::log;
use pinocchio_system::instructions::{CreateAccount, Transfer as SystemTransfer};
use shank::ShankInstruction;

const PROGRAM_ADDRESS:Address = Address::new_from_array(crate::ID);

// instructions.rs
/// Shank IDL facade enum describing all program instructions and their required accounts.
/// This is used only for IDL generation and does not affect runtime behavior.
#[derive(ShankInstruction)]
pub enum ProgramIx {
    /// Deposit lamports into the vault.
    #[account(0, signer, writable, name = "owner", desc = "Vault owner and payer")]
    #[account(1, writable, name = "vault", desc = "Vault PDA for lamports")]
    #[account(2, name = "program", desc = "Program Address")]
    #[account(3, name = "system_program", desc = "System Program Address")]
    Deposit { amount: u64 },

    /// Withdraw all lamports from the vault back to the owner.
    #[account(0, signer, writable, name = "owner", desc = "Vault owner and authority")]
    #[account(1, writable, name = "vault", desc = "Vault PDA for lamports")]
    #[account(2, name = "program", desc = "Program Address")]
    Withdraw {},
}
// instructions.rs
/// Parse a u64 from instruction data.
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

/// Derive the vault PDA for an owner and return (pda, bump).
fn derive_vault(owner: &AccountView) -> Result<(Address, u8), ProgramError> {
    let vault_key = Address::derive_program_address(&[b"vault", owner.address().as_ref()], &PROGRAM_ADDRESS).ok_or(ProgramError::InvalidAccountData);
    vault_key
}

/// Ensure the vault exists; if not, create it with PDA seeds.
fn ensure_vault_exists(owner: &AccountView, vault: &AccountView) -> ProgramResult {
    if !owner.is_signer() {
        return Err(ProgramError::InvalidAccountOwner);
    }

    // Create when empty and fund rent-exempt.
    if vault.lamports() == 0 {

        const ACCOUNT_DISCRIMINATOR_SIZE: usize = 8;
        
        let (_pda, bump) = derive_vault(owner)?;
        let signer_seeds = [
            Seed::from(b"vault".as_slice()),
            Seed::from(owner.address().as_ref()),
            Seed::from(core::slice::from_ref(&bump)),
        ];
        let signer = Signer::from(&signer_seeds);

        // Make the account rent-exempt.
        const VAULT_SIZE: usize = ACCOUNT_DISCRIMINATOR_SIZE + size_of::<u64>();
        let needed_lamports = Rent::get()?.try_minimum_balance(VAULT_SIZE)?;

        CreateAccount {
            from: owner,
            to: vault,
            lamports: needed_lamports,
            space: VAULT_SIZE as u64,
            owner: &PROGRAM_ADDRESS,
        }
        .invoke_signed(&[signer])?;

        log!("Vault created");

    } else {
        // If vault already exists, validate owner matches the program.
        if !vault.owned_by(&PROGRAM_ADDRESS) {
            return Err(ProgramError::InvalidAccountOwner);
        }

        log!("Vault already exists");
    }

    Ok(())
}
// instructions.rs
pub struct Deposit<'a> {
    pub owner: &'a AccountView,
    pub vault: &'a AccountView,
    pub amount: u64,
}

impl<'a> Deposit<'a> {
    pub const DISCRIMINATOR: &'a u8 = &0;

    pub fn process(self) -> ProgramResult {
        let Deposit {
            owner,
            vault,
            amount,
        } = self;

        ensure_vault_exists(owner, vault)?;

        SystemTransfer {
            from: owner,
            to: vault,
            lamports: amount,
        }
        .invoke()?;
        log!("{} Lamports deposited to vault", amount);
        Ok(())
    }
}

impl<'a> TryFrom<(&'a [u8], &'a mut [AccountView])> for Deposit<'a> {
    type Error = ProgramError;

    fn try_from(value: (&'a [u8], &'a mut [AccountView])) -> Result<Self, Self::Error> {
        let (data, accounts) = value;
        if accounts.len() < 2 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let owner = &accounts[0];
        let vault = &accounts[1];
        let amount = parse_amount(data)?;
        Ok(Self {
            owner,
            vault,
            amount,
        })
    }
}
// instructions.rs
pub struct Withdraw<'a> {
    pub owner: &'a mut AccountView,
    pub vault: &'a mut AccountView,
}

impl<'a> Withdraw<'a> {
    pub const DISCRIMINATOR: &'a u8 = &1;

    /// Transfer lamports from the vault PDA to the owner, leaving the rent minimum in place.
    pub fn process(self) -> ProgramResult {
        let Withdraw { owner, vault } = self;
        if !owner.is_signer() {
            return Err(ProgramError::InvalidAccountOwner);
        }

        // Validate that the vault is owned by the program
        if !vault.owned_by(&PROGRAM_ADDRESS) {
            return Err(ProgramError::InvalidAccountOwner);
        }

        // Validate that the provided vault account is the correct PDA for this owner
        let (expected_vault_pda, _bump) = derive_vault(owner)?;
        if vault.address() != &expected_vault_pda {
            return Err(ProgramError::InvalidAccountData);
        }

        // Compute how much can be withdrawn while keeping the account rent-exempt
        let data_len = vault.data_len();
        let min_balance = Rent::get()?.try_minimum_balance(data_len)?;
        let current = vault.lamports();
        if current <= min_balance {
            // Nothing withdrawable; keep behavior strict to avoid rent violations
            return Err(ProgramError::InsufficientFunds);
        }
        let withdraw_amount = current - min_balance;

        // Transfer from vault to owner
        {
            let mut vault_lamports = vault.lamports();
            vault_lamports = vault_lamports
                .checked_sub(withdraw_amount)
                .ok_or(ProgramError::InsufficientFunds)?;
            vault.set_lamports(vault_lamports);
        }

        {
            let mut owner_lamports = owner.lamports();
            owner_lamports = owner_lamports
                .checked_add(withdraw_amount)
                .ok_or(ProgramError::InsufficientFunds)?;
            owner.set_lamports(owner_lamports);
        }

        log!("{} lamports withdrawn from vault", withdraw_amount);
        Ok(())
    }
}

impl<'a> TryFrom<&'a mut [AccountView]> for Withdraw<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a mut [AccountView]) -> Result<Self, Self::Error> {
        if accounts.len() < 2 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let mut iter = accounts.iter_mut();
        let owner = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let vault = iter.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        Ok(Self { owner, vault })
    }
}