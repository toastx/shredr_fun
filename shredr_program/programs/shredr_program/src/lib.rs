use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::ephemeral;

pub mod instructions;
pub mod state;

use instructions::*;
use state::*;

declare_id!("A6aPwpTxFhQ9oSxdu1W8AH97LqjFwACXW81RkuTNAVEC");

#[ephemeral]
#[program]
pub mod shredr_program {
    use super::*;

    pub fn initialize_and_delegate(
        ctx: Context<InitializeAndDelegate>,
        salt: [u8; 32],
        burner_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::initialize_and_delegate(ctx, salt, burner_pubkey)
    }

    pub fn private_transfer(ctx: Context<PrivateTransfer>, amount: u64) -> Result<()> {
        instructions::private_transfer(ctx, amount)
    }

    pub fn settle_and_undelegate(ctx: Context<SettleAndUndelegate>) -> Result<()> {
        instructions::settle_and_undelegate(ctx)
    }
}
