use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(
        mut,
        constraint = transaction.phase == Phase::Committing @ ErrorCode::InvalidPhase,
        constraint = transaction.yes_count == transaction.participant_count @ ErrorCode::NotAllVotesYes,
    )]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn commit<'info>(ctx: Context<'_, '_, '_, 'info, Commit<'info>>) -> Result<()> {
    let tx_key = ctx.accounts.transaction.key();
    ctx.accounts.transaction.phase = Phase::Committed;
    let hooks = ctx.accounts.transaction.hooks.clone();
    let participants = ctx.accounts.transaction.pubkey_list()?;
    emit!(TransactionFinalized { transaction: tx_key, committed: true });

    let tx_info = ctx.accounts.transaction.to_account_info();
    crate::hooks::fire_hooks(&hooks, &participants, "on_2pc_commit", tx_key, &tx_info, ctx.remaining_accounts)
}
