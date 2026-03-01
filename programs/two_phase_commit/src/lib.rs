use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod hooks;
pub mod instructions;
pub mod state;

use instructions::*;
use state::Vote;

declare_id!("2PCPgunAXWWUSiKGChz6UQuspAz6Tgqc7mNdWkanGSMM");

#[program]
pub mod two_phase_commit {
    use super::*;

    pub fn begin_transaction(
        ctx: Context<BeginTransaction>,
        participants: Vec<Pubkey>,
        timeout_slots: u64,
        nonce: u64,
    ) -> Result<()> {
        instructions::begin_transaction::begin_transaction(ctx, participants, timeout_slots, nonce)
    }

    pub fn cast_vote(ctx: Context<CastVote>, vote: Vote, hook_program: Option<Pubkey>) -> Result<()> {
        instructions::cast_vote::cast_vote(ctx, vote, hook_program)
    }

    pub fn commit<'info>(ctx: Context<'_, '_, '_, 'info, Commit<'info>>) -> Result<()> {
        instructions::commit::commit(ctx)
    }

    pub fn abort<'info>(ctx: Context<'_, '_, '_, 'info, Abort<'info>>) -> Result<()> {
        instructions::abort::abort(ctx)
    }

    pub fn timeout_abort<'info>(ctx: Context<'_, '_, '_, 'info, TimeoutAbort<'info>>) -> Result<()> {
        instructions::timeout_abort::timeout_abort(ctx)
    }

    pub fn close_transaction(ctx: Context<CloseTransaction>) -> Result<()> {
        instructions::close_transaction::close_transaction(ctx)
    }
}
