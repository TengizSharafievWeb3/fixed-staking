use crate::errors::StakingError;
use crate::state::*;
use crate::ID;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::InstructionData;

#[derive(Accounts)]
pub struct FreeUser<'info> {
    #[account(
        has_one = authority,
        constraint = !pool.paused @ StakingError::PoolPaused,
        constraint = pool.closed @ StakingError::PoolHasToBeClosed,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        close = receiver,
        has_one = pool,
        seeds = [
            pool.key().as_ref(),
            user.authority.key().as_ref(),
        ],
        bump = user.bump,
    )]
    pub user: Account<'info, User>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub receiver: SystemAccount<'info>,
}

pub fn free_user(pool: Pubkey, authority: Pubkey, user: Pubkey, receiver: Pubkey) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(pool, false),
            AccountMeta::new(user, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(receiver, false),
        ],
        data: crate::instruction::FreeUser.data(),
    }
}
