use crate::state::*;
use crate::ID;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::InstructionData;

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        mut,
        has_one = authority,
        constraint = pool.paused,
    )]
    pub pool: Account<'info, Pool>,

    pub authority: Signer<'info>,
}

pub fn unpause(pool: Pubkey, authority: Pubkey) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: crate::instruction::Unpause.data(),
    }
}
