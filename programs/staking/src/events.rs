use crate::Tier;
use anchor_lang::prelude::*;

#[event]
pub struct StakeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub tier: Tier,
    pub locked_until: u64,
    pub amount: u64,
}

#[event]
pub struct UnstakeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub tier: Tier,
    pub amount: u64,
}

#[event]
pub struct ClaimEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}
