use anchor_lang::prelude::*;
use crate::events::*;
use crate::state::*;
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct CastVote<'info> {
    pub participant: Signer<'info>,

    #[account(
        mut,
        constraint = transaction.phase == Phase::Preparing @ ErrorCode::InvalidPhase,
    )]
    pub transaction: Account<'info, Transaction2PC>,
}

pub fn cast_vote(ctx: Context<CastVote>, vote: Vote, hook_program: Option<Pubkey>) -> Result<()> {
    let tx = &mut ctx.accounts.transaction;
    let participant_key = ctx.accounts.participant.key();

    let clock = Clock::get()?;
    require!(clock.slot <= tx.timeout_slot, ErrorCode::TransactionExpired);

    let pubkeys = tx.pubkey_list()?;
    let idx = pubkeys
        .iter()
        .position(|p| p == &participant_key)
        .ok_or(ErrorCode::NotAParticipant)?;

    require!(tx.votes[idx].is_none(), ErrorCode::AlreadyVoted);

    if let Some(hook_key) = hook_program {
        let hook_info = ctx.remaining_accounts.first()
            .ok_or(error!(ErrorCode::MissingHookAccount))?;
        require!(hook_info.key() == hook_key, ErrorCode::MissingHookAccount);
        require!(hook_info.executable, ErrorCode::HookNotExecutable);
    }

    tx.votes[idx] = Some(vote);
    tx.hooks[idx] = hook_program.map(|program_id| HookEntry { program_id, participant: participant_key });

    match vote {
        Vote::Yes => {
            tx.yes_count += 1;
            if tx.yes_count == tx.participant_count {
                tx.phase = Phase::Committing;
            }
        }
        Vote::No => {
            tx.phase = Phase::Aborting;
        }
    }

    emit!(VoteCast {
        transaction: tx.key(),
        participant: participant_key,
        approved: matches!(vote, Vote::Yes),
    });

    Ok(())
}
