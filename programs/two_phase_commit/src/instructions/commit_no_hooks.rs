use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

/// Permissionless fallback for hook-griefing scenarios.
///
/// When phase is Committing (all votes YES), any caller can invoke
/// `commit_no_hooks` to finalize the transaction without firing CPI hooks.
///
/// **Use case:** a malicious or buggy hook program is blocking `commit()` —
/// all attempts to finalize via `commit()` fail due to the hook's CPI error.
/// `commit_no_hooks` bypasses every registered hook and marks the transaction
/// Committed unconditionally.
///
/// **Trade-off:** there is no enforcement that `commit()` must be tried first.
/// Any wallet may call `commit_no_hooks` immediately after all votes are cast,
/// skipping hooks even when they are fully operational. Applications that
/// require hooks to execute atomically on every commit cannot rely on this
/// guarantee in an adversarial environment — hooks provide a best-effort
/// guarantee, not an atomic one, when untrusted callers are present.
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
