use anchor_lang::prelude::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct CloseTransaction<'info> {
    #[account(mut)]
    pub coordinator: Signer<'info>,

    #[account(
        mut,
        close = coordinator,
        constraint = transaction.coordinator == coordinator.key() @ ErrorCode::NotAParticipant,
        constraint = (transaction.phase == Phase::Committed || transaction.phase == Phase::Aborted) @ ErrorCode::NotTerminal,
    )]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn close_transaction(_ctx: Context<CloseTransaction>) -> Result<()> {
    Ok(())
}
