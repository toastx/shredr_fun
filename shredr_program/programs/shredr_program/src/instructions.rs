use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::anchor::{commit_and_undelegate_accounts, delegate, DelegateConfig};
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpiBuilder,
    DelegatePermissionCpiBuilder,
    CommitAndUndelegatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, AUTHORITY_FLAG};

use crate::state::{
    seeds, ProgramConfig, StealthAccount, UserAddress,
    PrivacyError,
    StealthDeposited, StealthDelegated, FlushedToVault, VaultWithdrawn,
    TEE_VALIDATOR_MAINNET,
};

// ────────────────────────────────────────────────────────────────────────────
// INSTRUCTION 1: initialize_config
// ────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + ProgramConfig::INIT_SPACE,
        seeds = [seeds::PROGRAM_CONFIG],
        bump,
    )]
    pub program_config: Account<'info, ProgramConfig>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    admin_multisig: Pubkey,
    min_flush_delay_secs: i64,
) -> Result<()> {
    require!(min_flush_delay_secs >= 0, PrivacyError::InvalidFlushDelay);

    let config = &mut ctx.accounts.program_config;
    config.admin_multisig = admin_multisig;
    config.paused = false;
    config.min_flush_delay_secs = min_flush_delay_secs;
    config.bump = ctx.bumps.program_config;

    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// INSTRUCTION 2: update_config
// ────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::PROGRAM_CONFIG],
        bump = program_config.bump,
        constraint = program_config.admin_multisig == admin.key()
            @PrivacyError::InvalidAdminAuthority,
    )]
    pub program_config: Account<'info, ProgramConfig>,
}

pub fn update_config(
    ctx: Context<UpdateConfig>,
    new_min_flush_delay_secs: Option<i64>,
    new_paused: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.program_config;

    if let Some(delay) = new_min_flush_delay_secs {
        require!(delay >= 0, PrivacyError::InvalidFlushDelay);
        config.min_flush_delay_secs = delay;
    }
    if let Some(paused) = new_paused {
        config.paused = paused;
    }

    Ok(())
}


#[derive(Accounts)]
#[instruction(salt: [u8; 32])]
pub struct CreateStealthAccount<'info> {

    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        seeds = [seeds::PROGRAM_CONFIG],
        bump = program_config.bump,
        constraint = !program_config.paused @ PrivacyError::ProtocolPaused,
    )]
    pub program_config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = relayer,
        space = 8 + StealthAccount::INIT_SPACE,
        seeds = [seeds::STEALTH_ADDRESS, owner.as_ref(), &salt],
        bump,
    )]
    pub stealth_account: Account<'info, StealthAccount>,
    pub system_program: Program<'info, System>,
}

pub fn create_stealth_account(
    ctx: Context<CreateStealthAccount>,
    salt: [u8; 32],
    owner: Pubkey,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, PrivacyError::ZeroDeposit);

    let clock   = Clock::get()?;
    let stealth = &mut ctx.accounts.stealth_account;

    stealth.owner             = owner;
    stealth.salt              = salt;
    stealth.deposited_amount  = amount;
    stealth.deposit_timestamp = clock.unix_timestamp;
    stealth.delegated         = false;
    stealth.bump              = ctx.bumps.stealth_account;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.relayer.to_account_info(),
                to:   ctx.accounts.stealth_account.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(StealthDeposited {
        stealth_pda: ctx.accounts.stealth_account.key(),
        amount,
        slot: clock.slot,
        // owner not emitted
    });

    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct CreateAndDelegatePermission<'info> {
    /// Relayer pays — no user wallet on-chain.
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        constraint = !stealth_account.delegated @ PrivacyError::AlreadyDelegated,
    )]
    #[account(mut, del)]
    pub stealth_account: AccountInfo<'info>,

    #[account(mut)]
    pub permission: UncheckedAccount<'info>,

    #[account(address = crate::state::PERMISSION_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub permission_program: UncheckedAccount<'info>,

    #[account(address = crate::state::DELEGATION_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub delegation_program: UncheckedAccount<'info>,

    pub validator: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn create_and_delegate_permission(
    ctx: Context<CreateAndDelegatePermission>,
    stealth_bump: u8,
    stealth_salt: [u8; 32],
    stealth_owner: Pubkey,
) -> Result<()> {
    let stealth_seeds: &[&[u8]] = &[
        seeds::STEALTH_ADDRESS,
        stealth_owner.as_ref(),
        &stealth_salt,
        &[stealth_bump],
    ];

    let initial_members = Some(vec![Member {
        flags: AUTHORITY_FLAG,
        pubkey: stealth_owner,
    }]);

    CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .permissioned_account(&ctx.accounts.stealth_account)
        .permission(&ctx.accounts.permission.to_account_info())
        .payer(&ctx.accounts.relayer.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .args(MembersArgs { members: initial_members })
        .invoke_signed(&[stealth_seeds])?;

    DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .payer(&ctx.accounts.relayer.to_account_info())
        .authority(&ctx.accounts.relayer.to_account_info(), false)
        .permissioned_account(&ctx.accounts.stealth_account, true)
        .permission(&ctx.accounts.permission.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .owner_program(&ctx.accounts.permission_program.to_account_info())
        .delegation_program(&ctx.accounts.delegation_program.to_account_info())
        .validator(ctx.accounts.validator.as_ref().map(|v| v.as_ref()))
        .invoke_signed(&[stealth_seeds])?;

    let validator_key = ctx.accounts.validator
        .as_ref()
        .map(|v| v.key());

    ctx.accounts.delegate_pda(
        &ctx.accounts.relayer,
        &[seeds::STEALTH_ADDRESS, stealth_owner.as_ref(), &stealth_salt],
        DelegateConfig {
            validator: validator_key,
            ..Default::default()
        },
    )?;

    emit!(StealthDelegated {
        stealth_pda: ctx.accounts.stealth_account.key(),
        slot: Clock::get()?.slot,
    });

    Ok(())
}


#[commit]
#[derive(Accounts)]
pub struct FlushToUserAddress<'info> {
    /// Relayer triggers the flush — no user wallet.
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        seeds = [seeds::PROGRAM_CONFIG],
        bump = program_config.bump,
        // paused does NOT block flush — in-flight TEE operations must land.
    )]
    pub program_config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        constraint = stealth_account.delegated @ PrivacyError::NotDelegated,
    )]
    pub stealth_account: Account<'info, StealthAccount>,
    #[account(
        init_if_needed,
        payer = relayer,
        space = 8 + UserAddress::INIT_SPACE,
        seeds = [seeds::USER_ADDRESS, stealth_account.owner.as_ref()],
        bump,
    )]
    pub user_address: Account<'info, UserAddress>,

    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    #[account(address = crate::state::PERMISSION_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub permission_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

}

pub fn flush_to_user_address(
    ctx: Context<FlushToUserAddress>,
    amount: u64,
) -> Result<()> {
    let config  = &ctx.accounts.program_config;
    let stealth = &mut ctx.accounts.stealth_account;
    let vault   = &mut ctx.accounts.user_address;
    let clock   = Clock::get()?;
    
    require!(
        clock.unix_timestamp >= stealth.deposit_timestamp + config.min_flush_delay_secs,
        PrivacyError::FlushTooEarly
    );

    require!(
        amount <= stealth.deposited_amount,
        PrivacyError::InsufficientStealthBalance
    );

    // Initialize vault on first use.
    if vault.owner == Pubkey::default() {
        vault.owner = stealth.owner;
        vault.bump  = ctx.bumps.user_address;
    }

 
    require!(vault.owner == stealth.owner, PrivacyError::OwnerMismatch);

    **stealth.to_account_info().try_borrow_mut_lamports()? -= amount;
    **vault.to_account_info().try_borrow_mut_lamports()?   += amount;

    stealth.deposited_amount   -= amount;
    vault.available_balance    += amount;
    vault.total_ever_received  += amount;

    let stealth_seeds: &[&[u8]] = &[
        seeds::STEALTH_ADDRESS,
        stealth.owner.as_ref(),
        &stealth.salt,
        &[stealth.bump],
    ];

    CommitAndUndelegatePermissionCpiBuilder::new(
        &ctx.accounts.permission_program.to_account_info()
    )
        .authority(&ctx.accounts.relayer.to_account_info(), false)
        .permissioned_account(&ctx.accounts.stealth_account.to_account_info(), true)
        .permission(&ctx.accounts.permission.to_account_info())
        .magic_program(&ctx.accounts.magic_program)
        .magic_context(&ctx.accounts.magic_context)
        .invoke_signed(&[stealth_seeds])?;

    commit_and_undelegate_accounts(
        &ctx.accounts.relayer,
        vec![
            &ctx.accounts.stealth_account.to_account_info(),
            &ctx.accounts.user_address.to_account_info(),
        ],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;

    emit!(FlushedToVault { slot: clock.slot });

    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [seeds::PROGRAM_CONFIG],
        bump = program_config.bump,
        constraint = !program_config.paused @ PrivacyError::ProtocolPaused,
    )]
    pub program_config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        has_one = owner @ PrivacyError::InvalidAdminAuthority,
        seeds = [seeds::USER_ADDRESS, owner.key().as_ref()],
        bump = user_address.bump,
    )]
    pub user_address: Account<'info, UserAddress>,

    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.user_address;
    require!(
        amount <= vault.available_balance,
        PrivacyError::InsufficientVaultBalance
    );
    **vault.to_account_info().try_borrow_mut_lamports()?-= amount;
    **ctx.accounts.destination.try_borrow_mut_lamports()?+= amount;
    vault.available_balance -= amount;
    emit!(VaultWithdrawn { slot: Clock::get()?.slot });
    Ok(())
}