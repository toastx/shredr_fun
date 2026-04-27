use pinocchio::Address;

pub const PROGRAM_ADDRESS:Address = Address::new_from_array(crate::ID);
pub mod seeds {
    pub const PROGRAM_CONFIG:&[u8] = b"shredr_program_config";
    pub const STEALTH_ADDRESS:&[u8] = b"shredr_stealth_address";
    pub const USER_ADDRESS:&[u8] = b"shredr_user_address";
}
