use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

/// Permissionless fallback for hook-griefing scenarios.
///
/// When phase is Committing (all votes YES), any caller can invoke
/// `commit_no_hooks` to finalize the transaction without firing CPI hooks.
/// Use this when a malicious or buggy hook is blocking `commit()`.
#[derive(Accounts)]
pub struct CommitNoHooks<'info> {
    #[account(
        mut,
        constraint = transaction.phase == Phase::Committing @ ErrorCode::InvalidPhase,
        constraint = transaction.yes_count == transaction.participant_count @ ErrorCode::NotAllVotesYes,
    )]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn commit_no_hooks(ctx: Context<CommitNoHooks>) -> Result<()> {
    let tx_key = ctx.accounts.transaction.key();
    ctx.accounts.transaction.phase = Phase::Committed;
    emit!(TransactionFinalized { transaction: tx_key, committed: true });
    Ok(())
}
