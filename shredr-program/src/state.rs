use pinocchio::Address;

#[repr(C)]
pub struct StealthAccount<'a> {
    pub owner: &'a Address,
    pub salt: [u8; 32],
    pub deposited_amount: u64,
    pub deposit_timestamp: i64,
    pub delegated: bool,
    pub bump: u8,
}

#[repr(C)]
pub struct UserAddress{
    pub owner: Address,
    pub available_balance: u64,
    pub total_ever_received: u64,
    pub bump: u8,    
}

#[repr(C)]
pub struct ProgramConfig {
    pub admin_multisig: Address,
    pub paused: bool,
    pub min_flush_delay_secs: i64,
    pub bump: u8,
}
