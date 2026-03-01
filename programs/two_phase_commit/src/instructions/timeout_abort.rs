use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct TimeoutAbort<'info> {
    #[account(mut)]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn timeout_abort<'info>(ctx: Context<'_, '_, '_, 'info, TimeoutAbort<'info>>) -> Result<()> {
    let tx = &mut ctx.accounts.transaction;

    require!(
        tx.phase != Phase::Committing,
        ErrorCode::CannotTimeoutCommitting
    );
    require!(
        tx.phase == Phase::Preparing || tx.phase == Phase::Aborting,
        ErrorCode::InvalidPhase
    );

    let clock = Clock::get()?;
    require!(clock.slot > tx.timeout_slot, ErrorCode::NotYetExpired);

    let tx_key = tx.key();
    tx.phase = Phase::Aborted;
    let hooks = tx.hooks.clone();
    emit!(TransactionFinalized { transaction: tx_key, committed: false });
    let _ = tx;

    let tx_info = ctx.accounts.transaction.to_account_info();
    crate::hooks::fire_hooks(&hooks, "on_2pc_abort", tx_key, &tx_info, ctx.remaining_accounts)
}
