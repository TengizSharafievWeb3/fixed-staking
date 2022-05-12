use crate::state::*;

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[cfg(not(feature = "mock-mint"))]
pub const TOKEN_MINT_PUBKEY: &str = "ZfnjRUKtc5vweE1GCLdHV4MkDQ3ebSpQXLobSKgQ9RB1";

#[cfg(feature = "mock-mint")]
pub const TOKEN_MINT_PUBKEY: &str = "CxEgZaGFN1eSezxiaKsVdUm4LJVBTi4weCmVReiGbPLA";

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = Pool::space(),
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: only for key()
    pub authority: UncheckedAccount<'info>,

    #[account(
        seeds = [
            pool.key().as_ref()
        ],
        bump,
    )]
    /// CHECK: only for key()
    pub pool_signer: UncheckedAccount<'info>,

    #[account(address = TOKEN_MINT_PUBKEY.parse::<Pubkey>().unwrap())]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        seeds = [b"vault".as_ref(), pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_signer,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [b"reward".as_ref(), pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_signer,
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
