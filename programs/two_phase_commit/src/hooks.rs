use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use sha2::{Digest, Sha256};
use crate::state::HookEntry;

/// remaining_accounts layout (one pair per participant with a hook, in participant order):
///   [program_account, state_account, ...]
/// state_account must be the PDA: ["hook_state", participant] under hook program
pub fn fire_hooks<'info>(
    hooks: &[Option<HookEntry>],
    participants: &[Pubkey],
    instruction_name: &str,
    tx_key: Pubkey,
    tx_info: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let discriminator = ix_discriminator(instruction_name);
    let mut iter = remaining_accounts.iter();

    for (idx, entry) in hooks.iter().enumerate() {
        let Some(entry) = entry else { continue };
        let participant = participants[idx];

        let program_info = iter
            .next()
            .ok_or(error!(crate::error::ErrorCode::MissingHookAccount))?;
        let state_info = iter
            .next()
            .ok_or(error!(crate::error::ErrorCode::MissingHookAccount))?;

        let mut data = discriminator.to_vec();
        data.extend_from_slice(participant.as_ref());

        let ix = Instruction {
            program_id: entry.program_id,
            accounts: vec![
                AccountMeta::new_readonly(tx_key, false),
                AccountMeta::new(*state_info.key, false),
            ],
            data,
        };

        invoke(
            &ix,
            &[tx_info.clone(), state_info.clone(), program_info.clone()],
        )?;
    }

    Ok(())
}

fn ix_discriminator(name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", name);
    let h = Sha256::digest(preimage.as_bytes());
    h[..8].try_into().unwrap()
}
