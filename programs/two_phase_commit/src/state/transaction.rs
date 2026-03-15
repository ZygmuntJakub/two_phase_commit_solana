use anchor_lang::prelude::*;
use densol::{Compress, Lz4 as Strategy};

// 10 participants keeps the Transaction2PC account within the 1088-byte allocation
// and ensures each transaction fits comfortably in a single Solana transaction
// (compute budget ~1.4M CUs for 10 CPI hook calls, well under the 1.4M limit).
pub const MAX_PARTICIPANTS: usize = 10;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct HookEntry {
    pub program_id: Pubkey,
    pub participant: Pubkey,
}

// Space breakdown:
// discriminator:          8
// version:                1
// coordinator:           32
// participants Vec:   4 + 320 (worst-case uncompressed; LZ4 typically reduces this)
// participant_count:      1
// phase:                  1
// votes Vec:        4 + 20  (10 × Option<Vote> = 2 bytes each)
// hooks Vec:       4 + 650  (10 × Option<HookEntry> = 1 + 64 bytes each)
// yes_count:              1
// timeout_slot:           8
// nonce:                  8
// bump:                   1
// TOTAL:               1063  → 1088 with padding
pub const TRANSACTION_2PC_SIZE: usize = 8 + 1088;

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
    pub hooks: Vec<Option<HookEntry>>,
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
            .map_err(|_| error!(crate::error::ErrorCode::DecompressionError))?;
        Ok(bytes
            .chunks_exact(32)
            .map(|chunk| Pubkey::from(<[u8; 32]>::try_from(chunk).unwrap()))
            .collect())
    }

    pub fn store_pubkeys(&mut self, pubkeys: &[Pubkey]) -> Result<()> {
        let bytes: Vec<u8> = pubkeys.iter().flat_map(|p| p.to_bytes()).collect();
        self.set_participants(&bytes)
            .map_err(|_| error!(crate::error::ErrorCode::DecompressionError))
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
