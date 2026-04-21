use anchor_lang::prelude::*;
pub mod instructions;
pub mod state;
use crate::instructions::*;
use crate::state::*;
declare_id!("A6aPwpTxFhQ9oSxdu1W8AH97LqjFwACXW81RkuTNAVEC");

#[ephemeral]
#[program]
pub mod shredr_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
