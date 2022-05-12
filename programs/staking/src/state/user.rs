use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock;

use crate::RewardTier;
use std::mem::size_of;

#[account]
pub struct User {
    /// Pool this user belongs to.
    pub pool: Pubkey,
    /// The owner/authority of this account
    pub authority: Pubkey,
    /// The locked periods
    pub stakes: [StakeStatus; 3],
    /// Signer bump
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum StakeStatus {
    None,
    Staking {
        locked_until: u64,
        last_claimed: u64,
        reward_paid: u64,
    },
    Ready,
    Used,
}

impl StakeStatus {
    pub fn is_none(&self) -> bool {
        matches!(self, StakeStatus::None)
    }

    pub fn new_stake(locked_until: u64) -> Result<Self> {
        let clock = clock::Clock::get()?;
        Ok(StakeStatus::Staking {
            locked_until,
            last_claimed: clock.unix_timestamp as u64,
            reward_paid: 0,
        })
    }

    /// Calc reword for tier, update StakeStatus numbers
    pub fn update_reword(&self, tier: &RewardTier, now: u64) -> (u64, StakeStatus) {
        match self {
            StakeStatus::Staking {
                locked_until,
                last_claimed,
                reward_paid,
            } => {
                if now >= *locked_until {
                    (tier.reward - reward_paid, StakeStatus::Ready)
                } else {
                    let time_passed = now - last_claimed;
                    let remaining = tier.reward - reward_paid;
                    let amount = remaining.min(
                        ((tier.reward as u128 * time_passed as u128) / tier.duration as u128)
                            as u64,
                    );
                    if amount == remaining {
                        (amount, StakeStatus::Ready)
                    } else {
                        (
                            amount,
                            StakeStatus::Staking {
                                locked_until: *locked_until,
                                last_claimed: now,
                                reward_paid: reward_paid + amount,
                            },
                        )
                    }
                }
            }
            _ => (0, *self),
        }
    }
}

impl Default for StakeStatus {
    fn default() -> Self {
        StakeStatus::None
    }
}

impl User {
    pub fn space() -> usize {
        size_of::<User>()
    }
}

pub trait UserAccount {
    fn init(&mut self, pool: Pubkey, authority: Pubkey, bump: u8) -> Result<()>;
}

impl UserAccount for Account<'_, User> {
    fn init(&mut self, pool: Pubkey, authority: Pubkey, bump: u8) -> Result<()> {
        self.pool = pool;
        self.authority = authority;
        self.bump = bump;

        Ok(())
    }
}
