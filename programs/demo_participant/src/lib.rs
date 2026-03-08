use anchor_lang::prelude::*;

declare_id!("7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn");

#[program]
pub mod demo_participant {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, _participant: Pubkey) -> Result<()> {
        ctx.accounts.state.finalized = false;
        ctx.accounts.state.committed = false;
        Ok(())
    }

    pub fn on_2pc_commit(ctx: Context<OnFinalize>, _participant: Pubkey) -> Result<()> {
        ctx.accounts.state.finalized = true;
        ctx.accounts.state.committed = true;
        msg!("2PC hook: COMMITTED");
        Ok(())
    }

    pub fn on_2pc_abort(ctx: Context<OnFinalize>, _participant: Pubkey) -> Result<()> {
        ctx.accounts.state.finalized = true;
        ctx.accounts.state.committed = false;
        msg!("2PC hook: ABORTED");
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(participant: Pubkey)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 2,
        seeds = [b"hook_state", participant.as_ref()],
        bump
    )]
    pub state: Account<'info, ParticipantState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(participant: Pubkey)]
pub struct OnFinalize<'info> {
    /// CHECK: Passed by the 2PC coordinator via CPI — caller is trusted to provide a valid Transaction2PC account.
    pub transaction: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"hook_state", participant.as_ref()],
        bump
    )]
    pub state: Account<'info, ParticipantState>,
}

#[account]
pub struct ParticipantState {
    pub finalized: bool,
    pub committed: bool,
}
