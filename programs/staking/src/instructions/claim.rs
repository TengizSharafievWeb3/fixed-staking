use crate::state::*;

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

use crate::errors::StakingError;

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        has_one = reward_vault,
        constraint = !pool.paused @ StakingError::PoolPaused,
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

    #[account(
        mut,
        has_one = authority,
        has_one = pool,
        seeds = [
            pool.key().as_ref(),
            authority.key().as_ref(),
        ],
        bump = user.bump,
    )]
    pub user: Account<'info, User>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub to: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"reward".as_ref(), pool.key().as_ref()],
        bump = pool.reward_vault_bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

impl<'a, 'b, 'c, 'info> From<&mut Claim<'info>> for CpiContext<'a, 'b, 'c, 'info, Transfer<'info>> {
    fn from(accounts: &mut Claim<'info>) -> CpiContext<'a, 'b, 'c, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: accounts.reward_vault.to_account_info(),
            to: accounts.to.to_account_info(),
            authority: accounts.pool_signer.to_account_info(),
        };
        let cpi_program = accounts.token_program.to_account_info();
        CpiContext::new(cpi_program, cpi_accounts)
    }
}
