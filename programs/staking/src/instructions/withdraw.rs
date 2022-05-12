use crate::errors::StakingError;
use crate::state::*;
use crate::ID;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::InstructionData;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        has_one = authority,
        has_one = reward_vault,
        has_one = vault,
        constraint = !pool.paused @ StakingError::PoolPaused,
        constraint = pool.closed @ StakingError::PoolHasToBeClosed,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        seeds = [
            pool.key().as_ref()
        ],
        bump = pool.bump
    )]
    /// CHECK: only for key()
    pub pool_signer: UncheckedAccount<'info>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub to: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault".as_ref(), pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"reward".as_ref(), pool.key().as_ref()],
        bump = pool.reward_vault_bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

impl Withdraw<'_> {
    pub fn withdraw_extra(&mut self) -> Result<()> {
        let key = self.pool.key();
        let seeds = [key.as_ref(), &[self.pool.bump]];

        let extra_rewards = self.reward_vault.amount.saturating_sub(
            self.pool
                .metrics
                .reward_requirements
                .saturating_sub(self.pool.metrics.reward_paid),
        );

        if extra_rewards > 0 {
            let cpi_accounts = Transfer {
                from: self.reward_vault.to_account_info(),
                to: self.to.to_account_info(),
                authority: self.pool_signer.to_account_info(),
            };

            token::transfer(
                CpiContext::new_with_signer(
                    self.token_program.to_account_info(),
                    cpi_accounts,
                    &[&seeds],
                ),
                extra_rewards,
            )?;
        }

        let expected_vault_amount: u64 = self
            .pool
            .tiers
            .iter()
            .map(|tier| {
                let active = tier.supply - tier.slots - tier.completed;
                active as u64 * tier.stake
            })
            .sum();
        let extra_vault = self.vault.amount.saturating_sub(expected_vault_amount);

        if extra_vault > 0 {
            let cpi_accounts = Transfer {
                from: self.vault.to_account_info(),
                to: self.to.to_account_info(),
                authority: self.pool_signer.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    self.token_program.to_account_info(),
                    cpi_accounts,
                    &[&seeds],
                ),
                extra_vault,
            )?;
        }

        require!(
            extra_vault > 0 || extra_rewards > 0,
            StakingError::OnlyExtraWithdrawAllowed
        );

        Ok(())
    }
}

pub fn withdraw(pool: Pubkey, authority: Pubkey, destination: Pubkey) -> Instruction {
    let (pool_signer, _) = Pubkey::find_program_address(&[pool.as_ref()], &ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault".as_ref(), pool.as_ref()], &ID);
    let (reward_vault, _) = Pubkey::find_program_address(&[b"reward".as_ref(), pool.as_ref()], &ID);
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(pool, false),
            AccountMeta::new_readonly(pool_signer, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(destination, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(reward_vault, false),
            AccountMeta::new_readonly(token::ID, false),
        ],
        data: crate::instruction::WithdrawExtra.data(),
    }
}
