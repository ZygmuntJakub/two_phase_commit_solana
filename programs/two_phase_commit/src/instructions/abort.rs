use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct Abort<'info> {
    #[account(
        mut,
        constraint = transaction.phase == Phase::Aborting @ ErrorCode::InvalidPhase,
    )]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn abort<'info>(ctx: Context<'_, '_, '_, 'info, Abort<'info>>) -> Result<()> {
    let tx_key = ctx.accounts.transaction.key();
    ctx.accounts.transaction.phase = Phase::Aborted;
    let hooks = ctx.accounts.transaction.hooks.clone();
    emit!(TransactionFinalized { transaction: tx_key, committed: false });

    let tx_info = ctx.accounts.transaction.to_account_info();
    crate::hooks::fire_hooks(&hooks, "on_2pc_abort", tx_key, &tx_info, ctx.remaining_accounts)
}
