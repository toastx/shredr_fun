use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::anchor::{delegate, commit_and_undelegate_accounts, DelegateConfig};
use ephemeral_rollups_sdk::access_control::instructions::{CreatePermissionCpiBuilder};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, AUTHORITY_FLAG};

use crate::state::*;

// ────────────────────────────────────────────────────────────────────────────
// INSTRUCTION: initialize_and_delegate
// Creates the StealthAccount (Burner PDA) and locks it into the Private ER.
// ────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
#[instruction(salt: [u8; 32], burner_pubkey: Pubkey)]
pub struct InitializeAndDelegate<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub burner: Signer<'info>,

    #[account(
        init,
        payer = relayer,
        space = 8 + StealthAccount::INIT_SPACE,
        seeds = [seeds::STEALTH_ADDRESS, burner.key().as_ref(), &salt],
        bump
    )]
    pub stealth_account: Account<'info, StealthAccount>,

    /// ACL account for the TEE
    #[account(mut)]
    pub permission_account: UncheckedAccount<'info>,

    #[account(address = PERMISSION_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub permission_program: UncheckedAccount<'info>,

    #[account(address = DELEGATION_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub delegation_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_and_delegate(
    ctx: Context<InitializeAndDelegate>,
    salt: [u8; 32],
    burner_pubkey: Pubkey,
) -> Result<()> {
    let stealth = &mut ctx.accounts.stealth_account;
    let clock = Clock::get()?;

    // 1. Setup State
    // Since the sender already sent money to this address, 
    // it already has lamports. We just record the total.
    stealth.owner = burner_pubkey;
    stealth.salt = salt;
    stealth.deposited_amount = stealth.to_account_info().lamports(); 
    stealth.deposit_timestamp = clock.unix_timestamp;
    stealth.delegated = true;
    stealth.bump = ctx.bumps.stealth_account;

    // 2. Wrap PDA with Permissions for the TEE
    let seeds: &[&[u8]] = &[
        seeds::STEALTH_ADDRESS,
        burner_pubkey.as_ref(),
        &salt,
        &[stealth.bump],
    ];

    CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
        .permissioned_account(&stealth.to_account_info())
        .permission(&ctx.accounts.permission_account.to_account_info())
        .payer(&ctx.accounts.payer.to_account_info()) // Payer covers the ACL rent
        .system_program(&ctx.accounts.system_program.to_account_info())
        .args(MembersArgs {
            members: Some(vec![Member {
                flags: AUTHORITY_FLAG,
                pubkey: burner_pubkey, // Only the burner can move funds in the ER
            }]),
        })
        .invoke_signed(&[seeds])?;

    // 3. Delegate to the Ephemeral Rollup
    ctx.accounts.delegate_pda(
        &ctx.accounts.relayer, // Payer signs for delegation
        &[seeds::STEALTH_ADDRESS, burner_pubkey.as_ref(), &salt],
        DelegateConfig {
            validator: Some(TEE_VALIDATOR_MAINNET.parse::<Pubkey>().unwrap()),
            ..Default::default()
        },
    )?;

    emit!(StealthDeposited {
        stealth_pda: stealth.key(),
        amount: stealth.deposited_amount,
        slot: clock.slot,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct PrivateTransfer<'info> {
    #[account(mut)]
    pub source_pda: Account<'info, StealthAccount>,
    #[account(mut)]
    pub dest_pda: Account<'info, StealthAccount>,
}

pub fn private_transfer(ctx: Context<PrivateTransfer>, amount: u64) -> Result<()> {
    require!(ctx.accounts.source_pda.deposited_amount >= amount, PrivacyError::InsufficientStealthBalance);
    
    **ctx.accounts.source_pda.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.dest_pda.to_account_info().try_borrow_mut_lamports()? += amount;

    ctx.accounts.source_pda.deposited_amount -= amount;
    ctx.accounts.dest_pda.deposited_amount += amount;

    Ok(())
}

#[derive(Accounts)]
pub struct SettleAndUndelegate<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [seeds::STEALTH_ADDRESS, user.key().as_ref(), stealth_account.salt.as_ref()], bump = stealth_account.bump)]
    pub stealth_account: Account<'info, StealthAccount>,

    pub magic_context: UncheckedAccount<'info>,
    pub magic_program: UncheckedAccount<'info>,
}

pub fn settle_and_undelegate(ctx: Context<SettleAndUndelegate>) -> Result<()> {
    commit_and_undelegate_accounts(
        &ctx.accounts.user,
        vec![&ctx.accounts.stealth_account.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;

    ctx.accounts.stealth_account.delegated = false;

    emit!(FlushedToVault {
        slot: Clock::get()?.slot,
    });

    Ok(())
}