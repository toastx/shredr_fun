use anchor_lang::prelude::*;

declare_id!("A6aPwpTxFhQ9oSxdu1W8AH97LqjFwACXW81RkuTNAVEC");

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
