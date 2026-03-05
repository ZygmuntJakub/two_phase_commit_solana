use anchor_lang::prelude::*;
use densol::{Compress, Lz4 as Strategy};

pub const MAX_PARTICIPANTS: usize = 10;

// Space breakdown:
// discriminator:          8
// version:                1
// coordinator:           32
// participants Vec:   4 + 320 (worst-case uncompressed; LZ4 typically reduces this)
// participant_count:      1
// phase:                  1
// votes Vec:        4 + 20  (10 × Option<Vote> = 2 bytes each)
// hooks Vec:       4 + 330  (10 × Option<Pubkey> = 33 bytes each)
// yes_count:              1
// timeout_slot:           8
// nonce:                  8
// bump:                   1
// TOTAL:                743  → 768 with padding
pub const TRANSACTION_2PC_SIZE: usize = 8 + 768;

#[account]
#[derive(Compress)]
pub struct Transaction2PC {
    pub version: u8,
    pub coordinator: Pubkey,
    #[compress]
    pub participants: Vec<u8>,
    pub participant_count: u8,
    pub phase: Phase,
    pub votes: Vec<Option<Vote>>,
    pub hooks: Vec<Option<Pubkey>>,
    pub yes_count: u8,
    pub timeout_slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

impl Transaction2PC {
    pub const VERSION: u8 = 1;

    pub fn pubkey_list(&self) -> Result<Vec<Pubkey>> {
        let bytes = self
            .get_participants()
            .map_err(|_| error!(crate::error::ErrorCode::InvalidPhase))?;
        Ok(bytes
            .chunks_exact(32)
            .map(|chunk| Pubkey::from(<[u8; 32]>::try_from(chunk).unwrap()))
            .collect())
    }

    pub fn store_pubkeys(&mut self, pubkeys: &[Pubkey]) -> Result<()> {
        let bytes: Vec<u8> = pubkeys.iter().flat_map(|p| p.to_bytes()).collect();
        self.set_participants(&bytes)
            .map_err(|_| error!(crate::error::ErrorCode::InvalidPhase))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum Phase {
    Preparing,
    Committing,
    Aborting,
    Committed,
    Aborted,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum Vote {
    Yes,
    No,
}
