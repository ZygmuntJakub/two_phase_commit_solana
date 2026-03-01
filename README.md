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

Any participant can register a hook program at vote time. When `commit` or `abort` fires, the 2PC program calls each registered program via CPI:

```
commit() → CPI → participant_A::on_2pc_commit(transaction, state)
         → CPI → participant_B::on_2pc_commit(transaction, state)
```

All calls happen in a single Solana transaction — atomically. The hook program receives the `Transaction2PC` account and its own state account (passed via `remaining_accounts`).

`programs/demo_participant` is a minimal example showing the interface.

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

---

## References

- Kleppmann (2017) — *Designing Data-Intensive Applications*, ch. 9 (consistency and consensus)
