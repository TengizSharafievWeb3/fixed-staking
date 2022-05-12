pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount};

use errors::*;
use events::*;
use instructions::*;
use state::*;

declare_id!("EMVNZcM6epTkxfCcjxqv44aXNcaaPArLGAjxjMWfjsoy");

#[program]
pub mod staking {
    use super::*;
    use anchor_lang::solana_program::clock;

    /// Initialize new staking pool
    pub fn initialize(ctx: Context<Initialize>, tiers: [RewardTier; 3]) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let bumps = &ctx.bumps;
        let vault = ctx.accounts.vault.key();
        let reward_vault = ctx.accounts.reward_vault.key();

        ctx.accounts
            .pool
            .init(authority, bumps, vault, reward_vault, tiers)
    }

    /// Withdraw extra
    pub fn withdraw_extra(ctx: Context<Withdraw>) -> Result<()> {
        ctx.accounts.withdraw_extra()
    }

    /// Pause - all user actions are restricted
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        ctx.accounts.pool.pause()
    }

    /// Unpause - allow user actions
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        ctx.accounts.pool.unpause()
    }

    /// Close pool for new stakes - users can't create new stake
    pub fn close(ctx: Context<ClosePool>) -> Result<()> {
        ctx.accounts.pool.close()
    }

    /// Open pool for new stakes
    pub fn open(ctx: Context<OpenPool>) -> Result<()> {
        ctx.accounts.pool.open()
    }

    /// Initialize a user staking account
    pub fn create_user(ctx: Context<CreateUser>) -> Result<()> {
        let pool = ctx.accounts.pool.key();
        let authority = ctx.accounts.authority.key();
        let bump = *ctx.bumps.get("user").unwrap();

        ctx.accounts.user.init(pool, authority, bump)
    }

    /// Stake tokens
    pub fn stake(ctx: Context<Stake>, tier: Tier) -> Result<()> {
        let reward_tier: &RewardTier = &ctx.accounts.pool.tiers[tier as usize];
        let user_stake: &StakeStatus = &ctx.accounts.user.stakes[tier as usize];

        require!(reward_tier.slots > 0, StakingError::NoAvailableSlotForTier);
        require!(user_stake.is_none(), StakingError::TierAlreadyUsed);

        let locked_until = reward_tier.locked_until()?;
        let amount = reward_tier.stake;
        let reward = reward_tier.reward;

        token::transfer(ctx.accounts.into(), amount)?;

        ctx.accounts.pool.tiers[tier as usize].use_slot();
        ctx.accounts.user.stakes[tier as usize] = StakeStatus::new_stake(locked_until)?;
        ctx.accounts.pool.metrics.stake(reward);

        emit!(StakeEvent {
            pool: ctx.accounts.pool.key(),
            user: ctx.accounts.user.key(),
            tier,
            locked_until,
            amount
        });

        Ok(())
    }

    /// Unstake tokens
    pub fn unstake(ctx: Context<Unstake>, tier: Tier) -> Result<()> {
        let stake: &StakeStatus = &ctx.accounts.user.stakes[tier as usize];

        let clock = clock::Clock::get()?;
        match stake {
            StakeStatus::None | StakeStatus::Used => return err!(StakingError::UserDoesntHaveTier),
            StakeStatus::Staking { locked_until, .. } => {
                return if *locked_until > clock.unix_timestamp as u64 {
                    err!(StakingError::TimeLockHasntYetPassed)
                } else {
                    err!(StakingError::PendingReward)
                }
            }
            _ => {}
        }

        let reward_tier: &RewardTier = &ctx.accounts.pool.tiers[tier as usize];
        let amount = reward_tier.stake;

        let key = ctx.accounts.user.pool;
        let seeds = [key.as_ref(), &[ctx.accounts.pool.bump]];

        let cpi_ctx: CpiContext<_> = ctx.accounts.into();
        token::transfer(cpi_ctx.with_signer(&[&seeds]), amount)?;

        ctx.accounts.user.stakes[tier as usize] = StakeStatus::Used;
        ctx.accounts.pool.tiers[tier as usize].complete();

        emit!(UnstakeEvent {
            pool: ctx.accounts.pool.key(),
            user: ctx.accounts.user.key(),
            tier,
            amount,
        });

        Ok(())
    }

    /// Claim reward
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        require!(
            ctx.accounts
                .user
                .stakes
                .iter()
                .any(|stake| matches!(stake, StakeStatus::Staking { .. })),
            StakingError::UserDoensntHaveStakes
        );

        let clock = anchor_lang::solana_program::clock::Clock::get()?;
        let now = clock.unix_timestamp as u64;

        let new_state: Vec<(u64, StakeStatus)> = ctx
            .accounts
            .user
            .stakes
            .iter()
            .zip(ctx.accounts.pool.tiers.iter())
            .map(|(stake, tier)| stake.update_reword(tier, now))
            .collect();

        let amount: u64 = new_state.iter().map(|(value, _)| value).sum();

        require!(amount > 0, StakingError::AmountMustBeGreaterThanZero);

        let key = ctx.accounts.user.pool;
        let seeds = [key.as_ref(), &[ctx.accounts.pool.bump]];

        let cpi_ctx: CpiContext<_> = ctx.accounts.into();
        token::transfer(cpi_ctx.with_signer(&[&seeds]), amount)?;

        for (stake, new_stake) in ctx
            .accounts
            .user
            .stakes
            .iter_mut()
            .zip(new_state.into_iter().map(|(_, stake)| stake))
        {
            *stake = new_stake;
        }

        ctx.accounts.pool.metrics.claim(amount);

        emit!(ClaimEvent {
            pool: ctx.accounts.pool.key(),
            user: ctx.accounts.user.key(),
            amount,
        });

        Ok(())
    }

    pub fn free_user(ctx: Context<FreeUser>) -> Result<()> {
        require!(
            ctx.accounts
                .user
                .stakes
                .iter()
                .all(|stake| matches!(stake, StakeStatus::Used)
                    || matches!(stake, StakeStatus::None)),
            StakingError::UserHasActiveStakes
        );
        Ok(())
    }

    pub fn free_pool(ctx: Context<FreePool>) -> Result<()> {
        require!(
            ctx.accounts
                .pool
                .tiers
                .iter()
                .all(|tier| tier.supply - tier.slots == tier.completed),
            StakingError::UserHasActiveStakes
        );
        require!(
            ctx.accounts.vault.amount == 0,
            StakingError::AmountMustBeZero
        );
        require!(
            ctx.accounts.reward_vault.amount == 0,
            StakingError::AmountMustBeZero
        );

        let key = ctx.accounts.pool.key();
        let seeds = [key.as_ref(), &[ctx.accounts.pool.bump]];

        // Close vault
        let cpi_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.receiver.to_account_info(),
            authority: ctx.accounts.pool_signer.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &[&seeds],
        ))?;

        // Close reward_vault
        let cpi_accounts = CloseAccount {
            account: ctx.accounts.reward_vault.to_account_info(),
            destination: ctx.accounts.receiver.to_account_info(),
            authority: ctx.accounts.pool_signer.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &[&seeds],
        ))?;

        Ok(())
    }
}
