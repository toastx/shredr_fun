// instructions_idl.rs  (or add to lib.rs)
use shank::ShankInstruction;

#[derive(ShankInstruction)]
pub enum StealthInstruction {
    /// Initialize a stealth PDA and delegate it to MagicBlock rollup
    #[account(0, signer, writable, name = "relayer", desc = "Relayer paying for the transaction")]
    #[account(1, writable, name = "burner", desc = "One-time burner keypair derived from mainKey+nonce")]
    #[account(2, name = "owner_program", desc = "This program's address")]
    #[account(3, writable, name = "stealth_account", desc = "Stealth PDA derived from burner+salt")]
    #[account(4, writable, name = "permission_account", desc = "ACL permission account")]
    #[account(5, writable, name = "delegation_buffer", desc = "MagicBlock delegation buffer")]
    #[account(6, writable, name = "delegation_record", desc = "MagicBlock delegation record")]
    #[account(7, writable, name = "delegation_metadata", desc = "MagicBlock delegation metadata")]
    #[account(8, name = "system_program", desc = "System Program")]
    InitializeAndDelegate {
        salt: [u8; 32],
        burner_pubkey: [u8; 32],
        commit_delay: i64,
    },

    /// Private transfer between two stealth PDAs inside the MagicBlock rollup
    #[account(0, signer, writable, name = "source_pda", desc = "Source stealth PDA, must sign")]
    #[account(1, writable, name = "destination_pda", desc = "Destination stealth PDA")]
    PrivateTransfer {
        amount: u64,
    },

    /// Commit stealth PDA state to base layer, keeping it delegated
    #[account(0, signer, writable, name = "relayer", desc = "Relayer paying for the transaction")]
    #[account(1, writable, name = "stealth_account", desc = "Stealth PDA to commit")]
    #[account(2, name = "magic_program", desc = "MagicBlock program")]
    #[account(3, writable, name = "magic_context", desc = "MagicBlock context account")]
    CommitStealth {},

    /// Commit stealth PDA state and undelegate back to base layer
    #[account(0, signer, writable, name = "relayer", desc = "Relayer paying for the transaction")]
    #[account(1, writable, name = "stealth_account", desc = "Stealth PDA to commit and undelegate")]
    #[account(2, name = "magic_program", desc = "MagicBlock program")]
    #[account(3, writable, name = "magic_context", desc = "MagicBlock context account")]
    CommitAndUndelegateStealth {},

    /// Withdraw lamports from main PDA to any destination after undelegation
    #[account(0, signer, writable, name = "main_burner", desc = "Main burner keypair derived from mainKey, proves ownership")]
    #[account(1, writable, name = "main_pda", desc = "Main stealth PDA holding funds after private transfer")]
    #[account(2, writable, name = "destination", desc = "Any destination address to receive funds")]
    Withdraw {
        amount: u64,
    },

    /// Undelegation callback invoked by MagicBlock delegation program
    #[account(0, writable, name = "stealth_account", desc = "Stealth account being undelegated")]
    #[account(1, writable, name = "buffer_account", desc = "MagicBlock buffer account")]
    #[account(2, signer, writable, name = "payer", desc = "Payer for the callback")]
    #[account(3, name = "system_program", desc = "System Program")]
    UndelegationCallback {},
}