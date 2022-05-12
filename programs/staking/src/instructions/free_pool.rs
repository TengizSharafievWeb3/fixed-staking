use crate::errors::StakingError;
use crate::state::*;
use crate::ID;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::InstructionData;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct FreePool<'info> {
    #[account(
        mut,
        close = receiver,
        has_one = authority,
        has_one = vault,
        has_one = reward_vault,
        constraint = !pool.paused @ StakingError::PoolPaused,
        constraint = pool.closed @ StakingError::PoolHasToBeClosed,
    )]
    pub pool: Account<'info, Pool>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [
            pool.key().as_ref()
        ],
        bump = pool.bump,
    )]
    /// CHECK: only for key()
    pub pool_signer: UncheckedAccount<'info>,

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

    #[account(mut)]
    pub receiver: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn free_pool(pool: Pubkey, authority: Pubkey, destination: Pubkey) -> Instruction {
    let (pool_signer, _) = Pubkey::find_program_address(&[pool.as_ref()], &ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault".as_ref(), pool.as_ref()], &ID);
    let (reward_vault, _) = Pubkey::find_program_address(&[b"reward".as_ref(), pool.as_ref()], &ID);
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new_readonly(pool_signer, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(reward_vault, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
        ],
        data: crate::instruction::FreePool.data(),
    }
}
