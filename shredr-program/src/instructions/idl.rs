use shank::ShankInstruction;

#[derive(ShankInstruction)]
pub enum StealthInstruction {
    /// Initialize a stealth PDA and delegate it to MagicBlock rollup
    #[account(
        0,
        signer,
        writable,
        name = "relayer",
        desc = "Relayer paying for the transaction"
    )]
    #[account(
        1,
        signer,
        writable,
        name = "burner",
        desc = "One-time burner keypair derived from mainKey+nonce"
    )]
    #[account(2, name = "owner_program", desc = "This program's address")]
    #[account(
        3,
        writable,
        name = "stealth_account",
        desc = "Stealth PDA derived from the burner"
    )]
    #[account(
        4,
        writable,
        name = "permission_account",
        desc = "ACL permission account"
    )]
    #[account(
        5,
        writable,
        name = "delegation_buffer",
        desc = "MagicBlock delegation buffer"
    )]
    #[account(
        6,
        writable,
        name = "delegation_record",
        desc = "MagicBlock delegation record"
    )]
    #[account(
        7,
        writable,
        name = "delegation_metadata",
        desc = "MagicBlock delegation metadata"
    )]
    #[account(8, name = "system_program", desc = "System Program")]
    #[account(
        9,
        name = "instructions_sysvar",
        desc = "Instructions sysvar, read to find the relayer's KYT attestation"
    )]
    InitializeAndDelegate { deposit_amount: u64, role: u8 },

    /// Create the vault and ledger for one shielded-pool denomination
    #[account(0, signer, writable, name = "payer", desc = "Pays rent for both accounts")]
    #[account(1, writable, name = "vault", desc = "Pool vault PDA, holds the lamports")]
    #[account(2, writable, name = "ledger", desc = "Pool ledger PDA, holds the note set")]
    #[account(3, name = "system_program", desc = "System Program")]
    InitializePool { denomination: u64 },

    /// Deposit one denomination into the shielded pool under a note commitment
    #[account(
        0,
        signer,
        writable,
        name = "depositor",
        desc = "Wallet funding the deposit; screened by the KYT attestation"
    )]
    #[account(1, writable, name = "vault", desc = "Pool vault PDA")]
    #[account(
        2,
        name = "instructions_sysvar",
        desc = "Instructions sysvar, read to find the relayer's KYT attestation"
    )]
    #[account(3, name = "system_program", desc = "System Program")]
    PoolDeposit { commitment: [u8; 32] },

    /// Spend a note and queue its payout. Rollup only — carries the note secret
    #[account(0, writable, name = "ledger", desc = "Delegated pool ledger PDA")]
    PoolSpend { secret: [u8; 32], destination: [u8; 32] },

    /// Pay the payout queue out and fold pending commitments into the ledger
    #[account(0, signer, writable, name = "payer", desc = "Pays the transaction")]
    #[account(1, writable, name = "vault", desc = "Pool vault PDA")]
    #[account(2, writable, name = "ledger", desc = "Undelegated pool ledger PDA")]
    #[account(
        3,
        writable,
        optional,
        name = "destinations",
        desc = "One writable account per payout to settle, in queue order"
    )]
    AdvanceEpoch,

    /// Delegate the pool ledger to the MagicBlock TEE validator
    #[account(0, signer, writable, name = "payer", desc = "Pays for the delegation")]
    #[account(1, writable, name = "ledger", desc = "Pool ledger PDA")]
    #[account(2, name = "owner_program", desc = "This program's address")]
    #[account(3, writable, name = "delegation_buffer", desc = "MagicBlock delegation buffer")]
    #[account(4, writable, name = "delegation_record", desc = "MagicBlock delegation record")]
    #[account(5, writable, name = "delegation_metadata", desc = "MagicBlock delegation metadata")]
    #[account(6, name = "system_program", desc = "System Program")]
    DelegatePoolLedger,

    /// Private transfer between two stealth PDAs inside the MagicBlock rollup
    #[account(
        0,
        signer,
        name = "source_burner",
        desc = "Burner that owns the source PDA, authorizes the transfer"
    )]
    #[account(1, writable, name = "source_pda", desc = "Source stealth PDA")]
    #[account(
        2,
        writable,
        name = "destination_pda",
        desc = "Destination stealth PDA"
    )]
    PrivateTransfer { amount: u64 },

    /// Commit stealth PDA state to base layer, keeping it delegated
    #[account(
        0,
        signer,
        writable,
        name = "relayer",
        desc = "Relayer paying for the transaction"
    )]
    #[account(1, writable, name = "stealth_account", desc = "Stealth PDA to commit")]
    #[account(2, name = "magic_program", desc = "MagicBlock program")]
    #[account(
        3,
        writable,
        name = "magic_context",
        desc = "MagicBlock context account"
    )]
    CommitStealth {},

    /// Commit stealth PDA state and undelegate back to base layer
    #[account(
        0,
        signer,
        writable,
        name = "relayer",
        desc = "Relayer paying for the transaction"
    )]
    #[account(
        1,
        writable,
        name = "stealth_account",
        desc = "Stealth PDA to commit and undelegate"
    )]
    #[account(2, name = "magic_program", desc = "MagicBlock program")]
    #[account(
        3,
        writable,
        name = "magic_context",
        desc = "MagicBlock context account"
    )]
    CommitAndUndelegateStealth {},

    /// Withdraw lamports from the stealth PDA to any destination after undelegation
    #[account(
        0,
        signer,
        writable,
        name = "burner",
        desc = "Burner keypair that owns the stealth account, proves ownership"
    )]
    #[account(
        1,
        writable,
        name = "stealth_account",
        desc = "Stealth PDA holding the funds"
    )]
    #[account(
        2,
        writable,
        name = "destination",
        desc = "Any destination address to receive funds"
    )]
    Withdraw { amount: u64 },

    /// Close a spent stealth PDA and reclaim its rent to the payee
    #[account(
        0,
        signer,
        name = "burner",
        desc = "Burner keypair that owns the stealth account, proves ownership"
    )]
    #[account(
        1,
        writable,
        name = "stealth_account",
        desc = "Spent stealth PDA to close (deposited_amount must be zero)"
    )]
    #[account(
        2,
        writable,
        name = "rent_payee",
        desc = "Receives the reclaimed rent, normally the relayer"
    )]
    CloseStealthAccount {},

    /// Undelegation callback invoked by MagicBlock delegation program
    #[account(
        0,
        writable,
        name = "stealth_account",
        desc = "Stealth account being undelegated"
    )]
    #[account(
        1,
        writable,
        name = "buffer_account",
        desc = "MagicBlock buffer account"
    )]
    #[account(2, signer, writable, name = "payer", desc = "Payer for the callback")]
    #[account(3, name = "system_program", desc = "System Program")]
    UndelegationCallback {},
}
