use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock;
use std::collections::BTreeMap;

use crate::errors::*;
use std::mem::size_of;

#[account]
pub struct Pool {
    /// Privileged account.
    pub authority: Pubkey,
    /// Bump to derive the PDA owning the vaults.
    pub bump: u8,
    /// Paused state of the program - all user action restricted
    pub paused: bool,
    /// Closed for new stakes - new stakes are restricted
    pub closed: bool,
    /// The vault holding users' tokens
    pub vault: Pubkey,
    pub vault_bump: u8,
    /// The vault to store reward tokens
    pub reward_vault: Pubkey,
    pub reward_vault_bump: u8,
    /// Reward tiers
    pub tiers: [RewardTier; 3],
    /// Metrics
    pub metrics: Metrics,
}

impl Pool {
    pub fn space() -> usize {
        size_of::<Pool>()
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum Tier {
    Tier500 = 0,
    Tier1000 = 1,
    Tier1500 = 2,
}

/// Settings and state of reward for tier
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Default)]
pub struct RewardTier {
    /// Total supply of slots
    pub supply: u16,
    /// Available slots
    pub slots: u16,
    /// Completed and unstaked slots
    pub completed: u16,
    /// Stake size
    pub stake: u64,
    /// Lock duration
    pub duration: u64,
    /// Total reward for duration
    pub reward: u64,
}

impl RewardTier {
    fn check(&self) -> bool {
        self.supply > 0
            && self.slots == self.supply
            && self.completed == 0
            && self.stake > 0
            && self.duration > 0
            && self.reward > 0
    }

    pub fn use_slot(&mut self) {
        self.slots -= 1;
    }

    pub fn complete(&mut self) {
        self.completed += 1;
    }

    pub fn locked_until(&self) -> Result<u64> {
        let clock = clock::Clock::get()?;
        (clock.unix_timestamp as u64)
            .checked_add(self.duration)
            .ok_or_else(|| error!(StakingError::CalcFailure))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Default)]
pub struct Metrics {
    /// The required amount for reward claims
    pub reward_requirements: u64,
    /// The total paid rewards
    pub reward_paid: u64,
}

impl Metrics {
    pub fn stake(&mut self, reward: u64) {
        self.reward_requirements += reward;
    }

    pub fn claim(&mut self, amount: u64) {
        self.reward_paid += amount;
    }
}

pub trait PoolAccount {
    fn init(
        &mut self,
        authority: Pubkey,
        bumps: &BTreeMap<String, u8>,
        vault: Pubkey,
        reward_vault: Pubkey,
        tiers: [RewardTier; 3],
    ) -> Result<()>;

    fn pause(&mut self) -> Result<()>;
    fn unpause(&mut self) -> Result<()>;
    fn open(&mut self) -> Result<()>;
    fn close(&mut self) -> Result<()>;
}

impl PoolAccount for Account<'_, Pool> {
    fn init(
        &mut self,
        authority: Pubkey,
        bumps: &BTreeMap<String, u8>,
        vault: Pubkey,
        reward_vault: Pubkey,
        tiers: [RewardTier; 3],
    ) -> Result<()> {
        self.authority = authority;
        self.bump = *bumps
            .get("pool_signer")
            .ok_or_else(|| error!(StakingError::BumpFailure))?;
        self.paused = false;
        self.closed = false;
        self.vault = vault;
        self.vault_bump = *bumps
            .get("vault")
            .ok_or_else(|| error!(StakingError::BumpFailure))?;
        self.reward_vault = reward_vault;
        self.reward_vault_bump = *bumps
            .get("reward_vault")
            .ok_or_else(|| error!(StakingError::BumpFailure))?;

        require!(
            tiers.iter().all(|tier| tier.check()),
            StakingError::InvalidRewardTier
        );

        self.tiers = tiers;
        Ok(())
    }

    fn pause(&mut self) -> Result<()> {
        self.paused = true;
        Ok(())
    }

    fn unpause(&mut self) -> Result<()> {
        self.paused = false;
        Ok(())
    }

    fn open(&mut self) -> Result<()> {
        self.closed = false;
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        self.closed = true;
        Ok(())
    }
}
