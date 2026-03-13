import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { TwoPhaseCommit } from "../target/types/two_phase_commit";
import { DemoParticipant } from "../target/types/demo_participant";
import { Keypair, PublicKey } from "@solana/web3.js";
import assert from "assert";

function hookStatePda(participant: PublicKey, hookProgram: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook_state"), participant.toBuffer()],
    hookProgram
  );
  return pda;
}

function txPda(
  coordinator: PublicKey,
  nonce: BN,
  programId: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("tx2pc"),
      coordinator.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
  return pda;
}

async function waitForSlot(
  connection: anchor.web3.Connection,
  targetSlot: number
) {
  while (true) {
    const current = await connection.getSlot();
    if (current > targetSlot) break;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function expectError(fn: () => Promise<any>, errorMsg: string) {
  try {
    await fn();
    assert.fail(`Expected error containing: ${errorMsg}`);
  } catch (err: any) {
    if (err.message === `Expected error containing: ${errorMsg}`) throw err;
    const haystack = [
      err.message ?? "",
      err.error?.errorCode?.code ?? "",
      err.error?.errorMessage ?? "",
      ...(err.logs ?? []),
    ].join(" ");
    assert.ok(
      haystack.includes(errorMsg),
      `Expected error "${errorMsg}" but got: ${err.message}`
    );
  }
}

describe("two_phase_commit", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.TwoPhaseCommit as Program<TwoPhaseCommit>;
  const demoProgram = anchor.workspace
    .DemoParticipant as Program<DemoParticipant>;

  const coordinator = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const charlie = Keypair.generate();

  // unique nonce per test so PDAs never collide
  let nonce = 0;
  function nextNonce(): BN {
    return new BN(++nonce);
  }

  before(async () => {
    await Promise.all(
      [coordinator, alice, bob, charlie].map(async (kp) => {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          10 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      })
    );
  });

  it("happy path: 2x YES → COMMITTING → commit() → COMMITTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    let state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("preparing" in state.phase, "should start in Preparing");

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc } as any)
      .signers([bob])
      .rpc();

    state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in state.phase, "all YES → Committing");
    assert.equal(state.yesCount, 2);

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committed" in state.phase, "after commit() → Committed");
  });

  it("abort path: 1x NO → ABORTING → permissionless abort() → ABORTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ no: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    let state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborting" in state.phase, "NO vote → Aborting");

    await program.methods.abort().accounts({ transaction: txAcc } as any).rpc();

    state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborted" in state.phase, "abort() → Aborted");
  });

  it("timeout abort (Preparing): no votes + slot expires → ABORTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(1), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    await waitForSlot(provider.connection, state.timeoutSlot.toNumber());

    await program.methods.timeoutAbort().accounts({ transaction: txAcc } as any).rpc();

    const final = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborted" in final.phase, "expired Preparing → Aborted");
  });

  it("timeout abort (Aborting): NO cast but abort() never called → ABORTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(1), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ no: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborting" in state.phase);

    await waitForSlot(provider.connection, state.timeoutSlot.toNumber());

    await program.methods.timeoutAbort().accounts({ transaction: txAcc } as any).rpc();

    const final = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborted" in final.phase, "expired Aborting → Aborted");
  });

  it("timeout_abort rejected in Committing: all YES = commit is logically final", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc } as any)
      .signers([bob])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in state.phase);

    // CannotTimeoutCommitting fires before NotYetExpired — no need to wait for expiry
    await expectError(
      () =>
        program.methods.timeoutAbort().accounts({ transaction: txAcc } as any).rpc(),
      "CannotTimeoutCommitting"
    );
  });

  it("replay protection: same (coordinator, nonce) PDA cannot be reused", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
          .signers([coordinator])
          .rpc(),
      "already in use"
    );
  });

  it("non-participant cannot cast_vote", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .castVote({ yes: {} }, null)
          .accounts({ participant: charlie.publicKey, transaction: txAcc } as any)
          .signers([charlie])
          .rpc(),
      "NotAParticipant"
    );
  });

  it("double vote rejected", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    await expectError(
      () =>
        program.methods
          .castVote({ yes: {} }, null)
          .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
          .signers([alice])
          .rpc(),
      "AlreadyVoted"
    );
  });

  it("validation: fewer than 2 participants rejected", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await expectError(
      () =>
        program.methods
          .beginTransaction([alice.publicKey], new BN(100), n)
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
          .signers([coordinator])
          .rpc(),
      "TooFewParticipants"
    );
  });

  it("validation: more than 10 participants rejected", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);
    const tooMany = Array.from(
      { length: 11 },
      () => Keypair.generate().publicKey
    );

    await expectError(
      () =>
        program.methods
          .beginTransaction(tooMany, new BN(100), n)
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
          .signers([coordinator])
          .rpc(),
      "TooManyParticipants"
    );
  });

  it("validation: duplicate participants rejected", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await expectError(
      () =>
        program.methods
          .beginTransaction([alice.publicKey, alice.publicKey], new BN(100), n)
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
          .signers([coordinator])
          .rpc(),
      "DuplicateParticipant"
    );
  });

  it("close_transaction: reclaims rent after COMMITTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc } as any)
      .signers([bob])
      .rpc();

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    const balanceBefore = await provider.connection.getBalance(
      coordinator.publicKey
    );

    await program.methods
      .closeTransaction()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(
      coordinator.publicKey
    );
    assert.ok(
      balanceAfter > balanceBefore,
      "coordinator should receive rent back"
    );

    const closed = await provider.connection.getAccountInfo(txAcc);
    assert.equal(closed, null, "transaction account should be closed");
  });

  it("close_transaction: wrong coordinator cannot close", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc } as any)
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc } as any)
      .signers([bob])
      .rpc();

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .closeTransaction()
          .accounts({ coordinator: alice.publicKey, transaction: txAcc } as any)
          .signers([alice])
          .rpc(),
      "NotAParticipant"
    );
  });

  it("close_transaction: rejected on active (Preparing) transaction", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .closeTransaction()
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
          .signers([coordinator])
          .rpc(),
      "NotTerminal"
    );
  });

  async function airdrop(kp: Keypair) {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  }

  it("CPI hooks: on_2pc_commit fires on all participants when commit() called", async () => {
    const p1 = Keypair.generate(); const p2 = Keypair.generate();
    await Promise.all([airdrop(p1), airdrop(p2)]);
    const p1Pda = hookStatePda(p1.publicKey, demoProgram.programId);
    const p2Pda = hookStatePda(p2.publicKey, demoProgram.programId);

    await demoProgram.methods.initialize(p1.publicKey)
      .accounts({ payer: coordinator.publicKey, state: p1Pda } as any)
      .signers([coordinator]).rpc();
    await demoProgram.methods.initialize(p2.publicKey)
      .accounts({ payer: coordinator.publicKey, state: p2Pda } as any)
      .signers([coordinator]).rpc();

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods.beginTransaction([p1.publicKey, p2.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator]).rpc();

    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p1.publicKey, transaction: txAcc } as any)
      .signers([p1]).rpc();
    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p2.publicKey, transaction: txAcc } as any)
      .signers([p2]).rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in state.phase);

    await program.methods.commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .remainingAccounts([
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: p1Pda, isWritable: true, isSigner: false },
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: p2Pda, isWritable: true, isSigner: false },
      ])
      .signers([coordinator]).rpc();

    const d1 = await demoProgram.account.participantState.fetch(p1Pda);
    const d2 = await demoProgram.account.participantState.fetch(p2Pda);
    assert.ok(d1.finalized && d1.committed, "p1 hook: committed");
    assert.ok(d2.finalized && d2.committed, "p2 hook: committed");
  });

  it("CPI hooks: on_2pc_abort fires when timeout_abort() called", async () => {
    const p1 = Keypair.generate(); const p2 = Keypair.generate();
    await Promise.all([airdrop(p1), airdrop(p2)]);
    const p1Pda = hookStatePda(p1.publicKey, demoProgram.programId);

    await demoProgram.methods.initialize(p1.publicKey)
      .accounts({ payer: coordinator.publicKey, state: p1Pda } as any)
      .signers([coordinator]).rpc();

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods.beginTransaction([p1.publicKey, p2.publicKey], new BN(1), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator]).rpc();

    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p1.publicKey, transaction: txAcc } as any)
      .signers([p1]).rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("preparing" in state.phase);
    await waitForSlot(provider.connection, state.timeoutSlot.toNumber());

    await program.methods.timeoutAbort()
      .accounts({ transaction: txAcc } as any)
      .remainingAccounts([
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: p1Pda, isWritable: true, isSigner: false },
      ])
      .rpc();

    const d1 = await demoProgram.account.participantState.fetch(p1Pda);
    assert.ok(d1.finalized && !d1.committed, "p1 hook: aborted");
  });

  it("CPI hooks: MissingHookAccount when remaining_accounts not provided", async () => {
    const p1 = Keypair.generate(); const p2 = Keypair.generate();
    await Promise.all([airdrop(p1), airdrop(p2)]);

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods.beginTransaction([p1.publicKey, p2.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator]).rpc();

    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p1.publicKey, transaction: txAcc } as any)
      .signers([p1]).rpc();
    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p2.publicKey, transaction: txAcc } as any)
      .signers([p2]).rpc();

    await expectError(
      () => program.methods.commit()
        .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
        .signers([coordinator]).rpc(),
      "MissingHookAccount"
    );
  });

  it("CPI hooks: hook failure rolls back commit() — tx stays in Committing", async () => {
    // p1 initializes its hook state; p2 does NOT.
    // When commit() fires hooks, the CPI for p2 fails (AccountNotInitialized),
    // rolling back the entire transaction — tx remains in Committing.
    const p1 = Keypair.generate(); const p2 = Keypair.generate();
    await Promise.all([airdrop(p1), airdrop(p2)]);
    const p1Pda = hookStatePda(p1.publicKey, demoProgram.programId);
    const p2Pda = hookStatePda(p2.publicKey, demoProgram.programId);

    // Only p1 sets up its hook state
    await demoProgram.methods.initialize(p1.publicKey)
      .accounts({ payer: coordinator.publicKey, state: p1Pda } as any)
      .signers([coordinator]).rpc();
    // p2Pda intentionally NOT initialized

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods.beginTransaction([p1.publicKey, p2.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator]).rpc();

    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p1.publicKey, transaction: txAcc } as any)
      .signers([p1]).rpc();
    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p2.publicKey, transaction: txAcc } as any)
      .signers([p2]).rpc();

    const beforeCommit = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in beforeCommit.phase);

    // commit() should fail — p2's hook state PDA is uninitialized
    await expectError(
      () => program.methods.commit()
        .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
        .remainingAccounts([
          { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
          { pubkey: p1Pda, isWritable: true, isSigner: false },
          { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
          { pubkey: p2Pda, isWritable: true, isSigner: false },
        ])
        .signers([coordinator]).rpc(),
      "AccountNotInitialized"
    );

    // tx must still be in Committing — the whole commit() was rolled back
    const afterFail = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in afterFail.phase, "tx rolled back to Committing");
  });

  it("CPI hooks: on_2pc_abort fires when abort() called", async () => {
    const p1 = Keypair.generate(); const p2 = Keypair.generate();
    await Promise.all([airdrop(p1), airdrop(p2)]);
    const p1Pda = hookStatePda(p1.publicKey, demoProgram.programId);
    const p2Pda = hookStatePda(p2.publicKey, demoProgram.programId);

    await demoProgram.methods.initialize(p1.publicKey)
      .accounts({ payer: coordinator.publicKey, state: p1Pda } as any)
      .signers([coordinator]).rpc();
    await demoProgram.methods.initialize(p2.publicKey)
      .accounts({ payer: coordinator.publicKey, state: p2Pda } as any)
      .signers([coordinator]).rpc();

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods.beginTransaction([p1.publicKey, p2.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc } as any)
      .signers([coordinator]).rpc();

    // p2 votes YES first (phase stays Preparing), then p1 votes NO
    await program.methods.castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: p2.publicKey, transaction: txAcc } as any)
      .signers([p2]).rpc();
    await program.methods.castVote({ no: {} }, demoProgram.programId)
      .accounts({ participant: p1.publicKey, transaction: txAcc } as any)
      .signers([p1]).rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborting" in state.phase);

    await program.methods.abort()
      .accounts({ transaction: txAcc } as any)
      .remainingAccounts([
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: p1Pda, isWritable: true, isSigner: false },
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: p2Pda, isWritable: true, isSigner: false },
      ])
      .rpc();

    const d1 = await demoProgram.account.participantState.fetch(p1Pda);
    const d2 = await demoProgram.account.participantState.fetch(p2Pda);
    assert.ok(d1.finalized && !d1.committed, "p1 hook: aborted");
    assert.ok(d2.finalized && !d2.committed, "p2 hook: aborted");
  });
});
