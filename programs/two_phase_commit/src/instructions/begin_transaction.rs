use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
#[instruction(_participants: Vec<Pubkey>, _timeout_slots: u64, nonce: u64)]
pub struct BeginTransaction<'info> {
    #[account(mut)]
    pub coordinator: Signer<'info>,
    #[account(
        init,
        payer = coordinator,
        space = TRANSACTION_2PC_SIZE,
        seeds = [b"tx2pc", coordinator.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub transaction: Account<'info, Transaction2PC>,
    pub system_program: Program<'info, System>,
}

pub fn begin_transaction(
    ctx: Context<BeginTransaction>,
    participants: Vec<Pubkey>,
    timeout_slots: u64,
    nonce: u64,
) -> Result<()> {
    require!(participants.len() >= 2, ErrorCode::TooFewParticipants);
    require!(participants.len() <= MAX_PARTICIPANTS, ErrorCode::TooManyParticipants);
    require!(timeout_slots > 0, ErrorCode::InvalidTimeoutSlots);

    for i in 0..participants.len() {
        for j in (i + 1)..participants.len() {
            require!(participants[i] != participants[j], ErrorCode::DuplicateParticipant);
        }
    }

    let clock = Clock::get()?;
    let tx = &mut ctx.accounts.transaction;

    tx.version = Transaction2PC::VERSION;
    tx.coordinator = ctx.accounts.coordinator.key();
    tx.store_pubkeys(&participants)?;
    tx.participant_count = participants.len() as u8;
    tx.phase = Phase::Preparing;
    tx.votes = vec![None; participants.len()];
    tx.hooks = vec![None; participants.len()];
    tx.yes_count = 0;
    tx.timeout_slot = clock.slot + timeout_slots;
    tx.nonce = nonce;
    tx.bump = ctx.bumps.transaction;

    emit!(TransactionBegun {
        transaction: tx.key(),
        coordinator: tx.coordinator,
        participant_count: tx.participant_count,
        timeout_slot: tx.timeout_slot,
    });

    Ok(())
}
