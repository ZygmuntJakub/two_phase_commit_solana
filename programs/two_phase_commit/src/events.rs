use anchor_lang::prelude::*;

#[event]
pub struct TransactionBegun {
    pub transaction: Pubkey,
    pub coordinator: Pubkey,
    pub participant_count: u8,
    pub timeout_slot: u64,
}

#[event]
pub struct VoteCast {
    pub transaction: Pubkey,
    pub participant: Pubkey,
    pub approved: bool,
}

#[event]
pub struct TransactionFinalized {
    pub transaction: Pubkey,
    pub committed: bool,
}
