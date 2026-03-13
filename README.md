# Two-Phase Commit — On-Chain

**Program ID:** `2PCPgunAXWWUSiKGChz6UQuspAz6Tgqc7mNdWkanGSMM` · [Devnet](https://explorer.solana.com/address/2PCPgunAXWWUSiKGChz6UQuspAz6Tgqc7mNdWkanGSMM?cluster=devnet)

Two-Phase Commit (2PC) is the algorithm that makes distributed database transactions possible. It's been running inside PostgreSQL, MySQL, and Oracle since 1978. This project is a faithful implementation of the protocol as an on-chain Solana program — and it accidentally fixes the one flaw 2PC has had for 47 years.

---

## The problem with Web2 2PC

The protocol is simple: a coordinator asks all participants to vote YES or NO, then sends COMMIT or ABORT based on the result. A YES vote is a promise — "I have durable state and can commit at any point."

```
Phase 1:  Coordinator ──PREPARE──► A, B
          A, B ──YES──► Coordinator

Phase 2:  Coordinator ──COMMIT──► A, B
```

The flaw: if the coordinator crashes after collecting all YES votes but before sending COMMIT, participants are stuck. They voted YES so they can't abort unilaterally, but they have no commit confirmation either. They hold locks. Other transactions block. This is called an **in-doubt transaction**.

PostgreSQL documents this as a known operational hazard. DBAs are instructed to manually inspect `pg_prepared_xacts` and resolve stuck transactions. Production dbs have had tables locked for hours.

Every proposed fix (Three-Phase Commit, Paxos Commit, Presumed Abort) adds complexity without fully solving it. The FLP impossibility theorem (1985) proves you can't fully solve it in an asynchronous network.

---

## Why on-chain?

The root cause is that coordinator state is **private**. When the coordinator decides to commit, only it knows — until it successfully notifies everyone. A crash in that window loses the decision.

On Solana, a coordinator "crash" changes nothing:

```
Web2:   crash → decision in local WAL → inaccessible → deadlock

Solana: crash → decision already in global ledger → visible to everyone → no deadlock
```

A Solana transaction either lands in the ledger or it doesn't. There is no intermediate state. The moment the coordinator writes its decision, every participant in the world can read it.

For transactions that expire without a decision, `timeout_abort` is permissionless — any wallet can call it. No DBA required. No recovery coordinator. No Paxos.

---

## State machine

```
              PREPARING
             /         \
     all YES             any NO
           /               \
      COMMITTING          ABORTING ◄── timeout_abort
           |                 |
        commit()         abort() / timeout_abort
           |                 |
       COMMITTED           ABORTED
```

`timeout_abort` is blocked in COMMITTING. Once all participants voted YES, the commit decision is logically final — aborting would violate the 2PC invariant. If the coordinator disappears after all YES votes, the transaction stays in COMMITTING, but anyone can verify the outcome by reading the on-chain votes.

---

## Account

One PDA per transaction: `["tx2pc", coordinator, nonce]`

```rust
pub struct Transaction2PC {
    pub version: u8, // version of the protocol
    pub coordinator: Pubkey, // who initiated the transaction
    pub participants: Vec<u8>,        // LZ4-compressed via densol
    pub participant_count: u8, // number of participants
    pub phase: Phase, // current phase of the transaction
    pub votes: Vec<Option<Vote>>, // votes of the participants
    pub hooks: Vec<Option<Pubkey>>,   // CPI callback program per participant
    pub yes_count: u8, // number of YES votes (cached to avoid re-counting on each vote)
    pub timeout_slot: u64, // slot at which the transaction will be aborted if not committed
    pub nonce: u64, // nonce to prevent reuse of the PDA
    pub bump: u8, // bump to prevent reuse of the PDA
}
```

Participants are stored LZ4-compressed using [densol](https://crates.io/crates/densol). For small lists the saving is slight. The pattern matters for programs with large variable-length data. Honestly, I used only for testing this concept purposes.

`hooks` stores an optional program ID per participant. When a participant casts their vote, they can register a program that will be called via CPI when the transaction finalizes. This turns 2PC from a coordination ledger into an actual execution coordinator — commit and abort trigger state changes in participant programs atomically, in the same Solana transaction.

---

## Instructions

| Instruction | Signer | Condition |
|---|---|---|
| `begin_transaction` | coordinator | — |
| `cast_vote(vote, hook_program?)` | participant | phase == Preparing, not expired |
| `commit` | coordinator | phase == Committing — fires `on_2pc_commit` hooks |
| `abort` | anyone | phase == Aborting — fires `on_2pc_abort` hooks |
| `timeout_abort` | anyone | expired, phase != Committing — fires `on_2pc_abort` hooks |
| `close_transaction` | coordinator | terminal state |

---

## Devnet

| Step | Transaction |
|---|---|
| `begin_transaction` | [kwYj9BKnKJ4k...](https://explorer.solana.com/tx/kwYj9BKnKJ4keFFshuTDJhv8EzP6MHX9prAFLvQbNkHZ4vPZ4jXHtbgQfwx4snaVZyWEp3KX2xQFBdu9bqr8roJ?cluster=devnet) |
| `cast_vote` (Alice YES) | [2cz6mvRYBWse...](https://explorer.solana.com/tx/2cz6mvRYBWsehfNDxCPfD8cvqwMQmoA425JUrhqUxTika8MjRSqVJD1d9Y5vwnH4bfjhpktmiPemFz4LrYk4gHBb?cluster=devnet) |
| `cast_vote` (Bob YES) | [2DwqKY1VaVXS...](https://explorer.solana.com/tx/2DwqKY1VaVXSiZ2aN45qukshKGiFtPsv9p14xpRpH4wW1hmp6hFbXwupmBV5KiuYCHtrFoQ8zJagjhyubKDS7nYu?cluster=devnet) |
| `commit` | [pC9ZvozmYj1Z...](https://explorer.solana.com/tx/pC9ZvozmYj1ZBqdz4kMi3H6vDD3gTdqqZdQfJiGMq97MJrQ1wrQM51SG5v9qtsJ2NaaTjrUzbfvE5YCCtPxTakn?cluster=devnet) |

---

## Running locally

```bash
npm install
anchor test
```

## CPI hooks

A participant registers a hook program when casting their vote. When `commit` or `abort` fires, the 2PC program CPIs into every registered hook — in the same Solana transaction:

```
commit()
  └─ CPI ──► program_A::on_2pc_commit(transaction, state_A)
  └─ CPI ──► program_B::on_2pc_commit(transaction, state_B)
```

This makes the decision and its execution atomic. Neither program updates its state until all votes are in — and when they do, both update in a single slot.

**Concrete example:** two SPL token programs coordinating an atomic swap. Each holds tokens in escrow during PREPARING. On commit, both `on_2pc_commit` handlers release tokens to the counterparty. On abort, both return tokens to the original owner. No trusted intermediary, no sequential settlement risk.

`programs/demo_participant` shows the minimal interface a hook program must implement.

**Tradeoff:** if a hook program panics or returns an error, the entire `commit()` transaction fails. This means participants must trust each other's hook implementations — the same social contract as 2PC itself. A buggy or malicious hook can delay commit, but cannot forge votes or steal funds.

---

## CLI

```bash
./2pc begin <P1> <P2> --timeout 300
./2pc vote <TX> yes --keypair ./alice.json
./2pc vote <TX> yes --keypair ./bob.json --hook <HOOK_PROGRAM_ID>
./2pc commit <TX>
./2pc status <TX>
./2pc abort <TX>
./2pc timeout-abort <TX>
./2pc close <TX>
```

## Demo

### Happy path

```bash
2pc> ./2pc -c devnet init-hook $(solana-keygen pubkey alice.json) $HOOK_PROGRAM                                                                                                                                 130 ↵

Participant : TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy
Hook program: 7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn
State PDA   : 53NdBp8PDFvGtfkJvE8WUzaBrp6gbAvFeYJetU2KwUBS

✅ Hook state initialized
Explorer : https://explorer.solana.com/tx/2YxNSbzoeeVqQjFkc3GWPEr6EcKVxdUiTM2c8MWeYbm5RqmF9yXNTa8ENQ32BzYWqQcfnB6MGdXECv488jsyETaR?cluster=devnet

💾 Saved HOOK to .2pc-env
2pc> ./2pc -c devnet init-hook $(solana-keygen pubkey bob.json) $HOOK_PROGRAM

Participant : 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
Hook program: 7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn
State PDA   : 7UicipRr2dDkDiRwiTckFZZ3omzNpat3NBzmKgYgcVgd

✅ Hook state initialized
Explorer : https://explorer.solana.com/tx/2KaTc7eDBdHkv6pcrwmyrk2FL7Wk3F8MdhETcQhSQnNpSdryTRaLcnmKNm3TdcrozQ7hg8phYQTgXKdHSKH8sMDy?cluster=devnet

💾 Saved HOOK to .2pc-env
2pc> ./2pc -c devnet begin $(solana-keygen pubkey alice.json) $(solana-keygen pubkey bob.json) --timeout 500000

Cluster     : devnet
Coordinator : 5HbsftX6dPm64URQoJy88fJnjK4p15w3TxeAaHEsRmi5
Participants: TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy, 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
Timeout     : 500000 slots
Nonce       : 1773584325534
TX account  : 3VC4NviGgzA1maAzQLgr5gaUxUsc67irFtbhZGW5H9gq

✅ Transaction created
Signature  : 5XJXLZEGMSGoakmrJH9Fh5nkusCPJspCeL6rH5eXDdvKpTnsBsVDoGu1RUdR9gnbUyZ5xrYCa3KNbfWGaK9q1bhn
TX account : 3VC4NviGgzA1maAzQLgr5gaUxUsc67irFtbhZGW5H9gq
Explorer   : https://explorer.solana.com/tx/5XJXLZEGMSGoakmrJH9Fh5nkusCPJspCeL6rH5eXDdvKpTnsBsVDoGu1RUdR9gnbUyZ5xrYCa3KNbfWGaK9q1bhn?cluster=devnet

💾 Saved to .2pc-env
2pc> ./2pc -c devnet vote yes --keypair alice.json

Participant : TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy
TX account  : 3VC4NviGgzA1maAzQLgr5gaUxUsc67irFtbhZGW5H9gq
Vote        : YES
Hook        : 7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn

✅ Vote recorded
Phase      : PREPARING
Yes count  : 1/2
Explorer   : https://explorer.solana.com/tx/VfZd6Q5EQukCBpuV5JedQvKKPt3owAoz2cycNPsJrapomFk7XQb24NkkkPARPTwTTatYTLZEPAaMaBfMzkZ3ibW?cluster=devnet
2pc> ./2pc -c devnet vote yes --keypair bob.json

Participant : 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
TX account  : 3VC4NviGgzA1maAzQLgr5gaUxUsc67irFtbhZGW5H9gq
Vote        : YES
Hook        : 7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn

✅ Vote recorded
Phase      : COMMITTING
Yes count  : 2/2
Explorer   : https://explorer.solana.com/tx/42mAo83EGYLFpwfk2d1Jd8JBoAkiynKt3SZgnMNWKp4dB949V6wLNmd4JqdL8TAHwm4Vp3Kn3PRiXxjzTtRFeCPN?cluster=devnet
2pc> ./2pc -c devnet commit

✅ COMMITTED
Explorer : https://explorer.solana.com/tx/pPwK78vcbmVTS6ZSnFFJo8iu3LDJZZpE2rZHkNdVADK3JiVUSM3BDVX6XgLyXcV9kvG1UQNhSpNSz3zJcbfv79s?cluster=devnet
2pc> ./2pc -c devnet status

────────────────────────────────────────────────────────
  2PC Transaction Status
────────────────────────────────────────────────────────
  Account     : 3VC4NviGgzA1maAzQLgr5gaUxUsc67irFtbhZGW5H9gq
  Phase       : COMMITTED ✅
  Coordinator : 5HbsftX6dPm64URQoJy88fJnjK4p15w3TxeAaHEsRmi5
  Timeout     : 449165187 (499870 slots left)
  Yes votes   : 2/2
────────────────────────────────────────────────────────
  [1] YES ✅
  [2] YES ✅
────────────────────────────────────────────────────────
  Explorer: https://explorer.solana.com/address/3VC4NviGgzA1maAzQLgr5gaUxUsc67irFtbhZGW5H9gq?cluster=devnet
2pc> ./2pc -c devnet hook-status $(solana-keygen pubkey alice.json)

Participant : TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy
State PDA   : 53NdBp8PDFvGtfkJvE8WUzaBrp6gbAvFeYJetU2KwUBS
Finalized   : true
Committed   : true
2pc> ./2pc -c devnet hook-status $(solana-keygen pubkey bob.json)

Participant : 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
State PDA   : 7UicipRr2dDkDiRwiTckFZZ3omzNpat3NBzmKgYgcVgd
Finalized   : true
Committed   : true
2pc> ./2pc -c devnet close

✅ Accounts closed, rent reclaimed
Explorer : https://explorer.solana.com/tx/XXC42SRhHHbK61ZwEGKJaZmuKNnuwTUFzVEyv7Djbg5YEhUA6zbcvgw3oCH6SCJJXN4oKyADEAmi4S87XHSEyh8?cluster=devnet
```

### Abort path

```bash
2pc> ./2pc -c devnet begin $(solana-keygen pubkey alice.json) $(solana-keygen pubkey bob.json) --timeout 500000                                                                                                 130 ↵

Cluster     : devnet
Coordinator : 5HbsftX6dPm64URQoJy88fJnjK4p15w3TxeAaHEsRmi5
Participants: TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy, 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
Timeout     : 500000 slots
Nonce       : 1773584472475
TX account  : 97BYa7WKgr4V8xs4Xx2VUwpz4rdwxVP2hcvRL7Jp8XpK

✅ Transaction created
Signature  : 5mpBmevfFdjcLiPhhXP96m1zH1Kg8dpwUbkLhjBc1yXigwtWmvWUFJzRhozDheibxMm5Ev8xns1NYzpEfNcQRkp6
TX account : 97BYa7WKgr4V8xs4Xx2VUwpz4rdwxVP2hcvRL7Jp8XpK
Explorer   : https://explorer.solana.com/tx/5mpBmevfFdjcLiPhhXP96m1zH1Kg8dpwUbkLhjBc1yXigwtWmvWUFJzRhozDheibxMm5Ev8xns1NYzpEfNcQRkp6?cluster=devnet

💾 Saved to .2pc-env
2pc> ./2pc -c devnet vote yes --keypair alice.json

Participant : TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy
TX account  : 97BYa7WKgr4V8xs4Xx2VUwpz4rdwxVP2hcvRL7Jp8XpK
Vote        : YES
Hook        : 7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn

✅ Vote recorded
Phase      : PREPARING
Yes count  : 1/2
Explorer   : https://explorer.solana.com/tx/2DSiJJprCZyMARgdufpFJUVtZaCBFhsbkPQNxr6Ketzayre1pPPzXNQsFb5rxgPiBdsSV5398kkK1Ly8jQq9ePyt?cluster=devnet
2pc> ./2pc -c devnet vote no --keypair bob.json

Participant : 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
TX account  : 97BYa7WKgr4V8xs4Xx2VUwpz4rdwxVP2hcvRL7Jp8XpK
Vote        : NO
Hook        : 7tQZaZaLooXGEXgpDfDakxMS69j4t8KsrqeGZYeLLbCn

✅ Vote recorded
Phase      : ABORTING
Yes count  : 1/2
Explorer   : https://explorer.solana.com/tx/329YYVFh3DKNNfigDz5QgZ6FmMT82M6mmckyuYhj2a2tbGR7tPCE4VrBqucQAW1oTsrSV3PqsVvc9Nz4yZfTkQMd?cluster=devnet
2pc> ./2pc -c devnet abort

✅ ABORTED
Explorer : https://explorer.solana.com/tx/5SkcjFfPMb5F8wD5jwAbDySBJsQswGBdzXK1P9aNdCF99ZMrhWYbA5QjMe3WTSpFtR5RKYKfAR8e54fvSYpwrXPt?cluster=devnet
2pc> ./2pc -c devnet hook-status $(solana-keygen pubkey alice.json)

Participant : TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy
State PDA   : 53NdBp8PDFvGtfkJvE8WUzaBrp6gbAvFeYJetU2KwUBS
Finalized   : true
Committed   : false
2pc> ./2pc -c devnet hook-status $(solana-keygen pubkey bob.json)

Participant : 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
State PDA   : 7UicipRr2dDkDiRwiTckFZZ3omzNpat3NBzmKgYgcVgd
Finalized   : true
Committed   : false
2pc> ./2pc -c devnet close

✅ Accounts closed, rent reclaimed
Explorer : https://explorer.solana.com/tx/4TBTe2DWhy4UepB1p8rSZhFdTGqfujfR9v66g8jHWQYXnV91QhdWSrxVLUjuEgVBNP8ouATZzvNRc7DZtz6NsHDH?cluster=devnet
```

### Timeout Path

```bash
2pc> ./2pc -c devnet begin $(solana-keygen pubkey alice.json) $(solana-keygen pubkey bob.json) --timeout 10                                                                                                     130 ↵

Cluster     : devnet
Coordinator : 5HbsftX6dPm64URQoJy88fJnjK4p15w3TxeAaHEsRmi5
Participants: TMeKk4T8Xx7m8u8tUm2Tq6kUteEG9o4cJ5sQDAuSxPy, 2xzjqGZSQWbVk8937nG1sDvc7inQTswgQ9qbwAAw6WFh
Timeout     : 10 slots
Nonce       : 1773584601158
TX account  : Bfb7KE8ChjsqFjzQsmBYpPDdZ52QUZqScz8VJqQrVnes

✅ Transaction created
Signature  : 61bwACpRnuZ1NBQbENVCvMyEcRSN5A1jbxdWKxTFtSddpGrvQrvpUTWy6vthEw9BsNPuySKpbjE9dxrPZK6xm43r
TX account : Bfb7KE8ChjsqFjzQsmBYpPDdZ52QUZqScz8VJqQrVnes
Explorer   : https://explorer.solana.com/tx/61bwACpRnuZ1NBQbENVCvMyEcRSN5A1jbxdWKxTFtSddpGrvQrvpUTWy6vthEw9BsNPuySKpbjE9dxrPZK6xm43r?cluster=devnet

💾 Saved to .2pc-env
2pc> ./2pc -c devnet timeout-abort

Phase       : PREPARING
Timeout slot: 448665923
Current slot: 448665950
Expired     : YES

✅ ABORTED (timeout)
Explorer : https://explorer.solana.com/tx/4jXaosbPSff4g1fbDknJKLPEcCzRoGHSKULSKeQ6jbyHwyTmAum6BG4ZxuUyF3AJBDgA2BygEYpmuKtH2FbiSV2Z?cluster=devnet
2pc> ./2pc -c devnet status

────────────────────────────────────────────────────────
  2PC Transaction Status
────────────────────────────────────────────────────────
  Account     : Bfb7KE8ChjsqFjzQsmBYpPDdZ52QUZqScz8VJqQrVnes
  Phase       : ABORTED ❌
  Coordinator : 5HbsftX6dPm64URQoJy88fJnjK4p15w3TxeAaHEsRmi5
  Timeout     : 448665923 (EXPIRED)
  Yes votes   : 0/2
────────────────────────────────────────────────────────
  [1] pending
  [2] pending
────────────────────────────────────────────────────────
  Explorer: https://explorer.solana.com/address/Bfb7KE8ChjsqFjzQsmBYpPDdZ52QUZqScz8VJqQrVnes?cluster=devnet
2pc> ./2pc -c devnet close

✅ Accounts closed, rent reclaimed
Explorer : https://explorer.solana.com/tx/4kefeLP6qYdLVZJqMkqY7RaCZy9MeRtM2qwB8dQm4TSZ3LuFSvKeuBxpF3GN7tWSwzjKbyn1aHxYSiE5HCt8GHk?cluster=devnet
```
---

## References

- Kleppmann (2017) — *Designing Data-Intensive Applications*, ch. 9 (consistency and consensus)
