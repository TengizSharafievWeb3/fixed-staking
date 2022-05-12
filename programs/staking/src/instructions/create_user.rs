use crate::state::*;

use crate::errors::StakingError;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CreateUser<'info> {
    #[account(
        constraint = !pool.paused @ StakingError::PoolPaused,
        constraint = !pool.closed @ StakingError::PoolClosed,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = authority,
        space = User::space(),
        seeds = [
            pool.key().as_ref(),
            authority.key().as_ref(),
        ],
        bump,
    )]
    pub user: Account<'info, User>,

    #[account(mut)]
    pub authority: Signer<'info>,

    system_program: Program<'info, System>,
}
