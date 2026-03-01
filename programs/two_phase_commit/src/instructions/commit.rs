use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct Commit<'info> {
    pub coordinator: Signer<'info>,

    #[account(
        mut,
        constraint = transaction.coordinator == coordinator.key() @ ErrorCode::NotAParticipant,
        constraint = transaction.phase == Phase::Committing @ ErrorCode::InvalidPhase,
    )]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn commit<'info>(ctx: Context<'_, '_, '_, 'info, Commit<'info>>) -> Result<()> {
    let tx_key = ctx.accounts.transaction.key();
    ctx.accounts.transaction.phase = Phase::Committed;
    let hooks = ctx.accounts.transaction.hooks.clone();
    emit!(TransactionFinalized { transaction: tx_key, committed: true });

    let tx_info = ctx.accounts.transaction.to_account_info();
    crate::hooks::fire_hooks(&hooks, "on_2pc_commit", tx_key, &tx_info, ctx.remaining_accounts)
}
