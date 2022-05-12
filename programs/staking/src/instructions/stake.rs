use crate::state::*;

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

use crate::errors::StakingError;

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        has_one = vault,
        constraint = !pool.paused @ StakingError::PoolPaused,
        constraint = !pool.closed @ StakingError::PoolClosed,
    )]
    pub pool: Account<'info, Pool>,

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
    pub from: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault".as_ref(), pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

impl<'a, 'b, 'c, 'info> From<&mut Stake<'info>> for CpiContext<'a, 'b, 'c, 'info, Transfer<'info>> {
    fn from(accounts: &mut Stake<'info>) -> CpiContext<'a, 'b, 'c, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: accounts.from.to_account_info(),
            to: accounts.vault.to_account_info(),
            authority: accounts.authority.to_account_info(),
        };
        let cpi_program = accounts.token_program.to_account_info();
        CpiContext::new(cpi_program, cpi_accounts)
    }
}
