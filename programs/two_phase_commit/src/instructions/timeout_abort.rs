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
    require!(
        ctx.accounts.transaction.phase != Phase::Committing,
        ErrorCode::CannotTimeoutCommitting
    );
    require!(
        ctx.accounts.transaction.phase == Phase::Preparing
            || ctx.accounts.transaction.phase == Phase::Aborting,
        ErrorCode::InvalidPhase
    );

    let clock = Clock::get()?;
    require!(clock.slot > ctx.accounts.transaction.timeout_slot, ErrorCode::NotYetExpired);

    let tx_key = ctx.accounts.transaction.key();
    ctx.accounts.transaction.phase = Phase::Aborted;
    let hooks = ctx.accounts.transaction.hooks.clone();
    let participants = ctx.accounts.transaction.pubkey_list()?;
    emit!(TransactionFinalized { transaction: tx_key, committed: false });

    let tx_info = ctx.accounts.transaction.to_account_info();
    crate::hooks::fire_hooks(&hooks, &participants, "on_2pc_abort", tx_key, &tx_info, ctx.remaining_accounts)
}
