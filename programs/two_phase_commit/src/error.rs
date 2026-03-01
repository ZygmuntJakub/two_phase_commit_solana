use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Transaction has expired")]
    TransactionExpired,
    #[msg("Invalid phase transition")]
    InvalidPhase,
    #[msg("Signer is not a registered participant")]
    NotAParticipant,
    #[msg("Cannot commit: not all votes are YES")]
    NotAllVotesYes,
    #[msg("Transaction is not yet expired")]
    NotYetExpired,
    #[msg("Duplicate participant in list")]
    DuplicateParticipant,
    #[msg("Too many participants (max 10)")]
    TooManyParticipants,
    #[msg("Need at least 2 participants")]
    TooFewParticipants,
    #[msg("timeout_slots must be greater than zero")]
    InvalidTimeoutSlots,
    #[msg("Participant has already cast a vote")]
    AlreadyVoted,
    #[msg("Transaction is not in a terminal state")]
    NotTerminal,
    #[msg("timeout_abort does not apply to Committing phase")]
    CannotTimeoutCommitting,
    #[msg("Missing hook account in remaining_accounts")]
    MissingHookAccount,
}
