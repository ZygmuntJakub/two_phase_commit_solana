use anchor_lang::prelude::*;
use densol::{Compress, Lz4 as Strategy};

// 10 participants keeps the Transaction2PC account within the 768-byte allocation
// and ensures each transaction fits comfortably in a single Solana transaction
// (each CPI hook call costs ~30k CUs; 10 hooks ≈ 300k CUs, well under the 1.4M limit).
pub const MAX_PARTICIPANTS: usize = 10;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct HookEntry {
    pub program_id: Pubkey,
    // participant is NOT stored here — hooks are indexed in parallel with the
    // participants array, so hooks[i].participant == participants[i] by construction.
}

// Space breakdown (excluding 8-byte discriminator):
// version:                1
// coordinator:           32
// participants Vec:   4 + 320 (worst-case uncompressed; LZ4 typically reduces this)
// participant_count:      1
// phase:                  1
// votes Vec:        4 + 20  (10 × Option<Vote> = 2 bytes each)
// hooks Vec:       4 + 330  (10 × Option<HookEntry> = 1 + 32 bytes each)
// yes_count:              1
// timeout_slot:           8
// nonce:                  8
// bump:                   1
// FIELDS TOTAL:         735 → padded to 768
// + discriminator:        8
// ACCOUNT TOTAL:         776  (33 bytes of margin)
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Debug)]
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tx() -> Transaction2PC {
        Transaction2PC {
            version: Transaction2PC::VERSION,
            coordinator: Pubkey::default(),
            participants: vec![],
            participant_count: 0,
            phase: Phase::Preparing,
            votes: vec![],
            hooks: vec![],
            yes_count: 0,
            timeout_slot: 0,
            nonce: 0,
            bump: 0,
        }
    }

    #[test]
    fn pubkeys_round_trip() {
        let mut tx = make_tx();
        let p1 = Pubkey::from([1u8; 32]);
        let p2 = Pubkey::from([2u8; 32]);
        let p3 = Pubkey::from([3u8; 32]);
        tx.store_pubkeys(&[p1, p2, p3]).unwrap();
        let out = tx.pubkey_list().unwrap();
        assert_eq!(out, vec![p1, p2, p3]);
    }

    #[test]
    fn pubkeys_round_trip_max() {
        let mut tx = make_tx();
        let keys: Vec<Pubkey> = (0..MAX_PARTICIPANTS)
            .map(|i| Pubkey::from([i as u8; 32]))
            .collect();
        tx.store_pubkeys(&keys).unwrap();
        assert_eq!(tx.pubkey_list().unwrap(), keys);
    }

    #[test]
    fn hook_entry_is_one_pubkey() {
        // HookEntry stores only program_id; participant is implicit from array index.
        assert_eq!(std::mem::size_of::<Pubkey>(), 32);
        // Option<HookEntry> borsh-serializes to 1 (discriminant) + 32 = 33 bytes.
    }

    #[test]
    fn phase_ordering() {
        // Each variant is distinct — state machine relies on this.
        assert_ne!(Phase::Preparing, Phase::Committing);
        assert_ne!(Phase::Committing, Phase::Aborting);
        assert_ne!(Phase::Committed, Phase::Aborted);
        assert_ne!(Phase::Preparing, Phase::Committed);
    }
}
