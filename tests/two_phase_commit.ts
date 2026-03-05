import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { TwoPhaseCommit } from "../target/types/two_phase_commit";
import { DemoParticipant } from "../target/types/demo_participant";
import { Keypair, PublicKey } from "@solana/web3.js";
import assert from "assert";

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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    let state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("preparing" in state.phase, "should start in Preparing");

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in state.phase, "all YES → Committing");
    assert.equal(state.yesCount, 2);

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ no: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    let state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborting" in state.phase, "NO vote → Aborting");

    await program.methods.abort().accounts({ transaction: txAcc }).rpc();

    state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborted" in state.phase, "abort() → Aborted");
  });

  it("timeout abort (Preparing): no votes + slot expires → ABORTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(1), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    await waitForSlot(provider.connection, state.timeoutSlot.toNumber());

    await program.methods.timeoutAbort().accounts({ transaction: txAcc }).rpc();

    const final = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborted" in final.phase, "expired Preparing → Aborted");
  });

  it("timeout abort (Aborting): NO cast but abort() never called → ABORTED", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(1), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ no: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborting" in state.phase);

    await waitForSlot(provider.connection, state.timeoutSlot.toNumber());

    await program.methods.timeoutAbort().accounts({ transaction: txAcc }).rpc();

    const final = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborted" in final.phase, "expired Aborting → Aborted");
  });

  it("timeout_abort rejected in Committing: all YES = commit is logically final", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in state.phase);

    // CannotTimeoutCommitting fires before NotYetExpired — no need to wait for expiry
    await expectError(
      () =>
        program.methods.timeoutAbort().accounts({ transaction: txAcc }).rpc(),
      "CannotTimeoutCommitting"
    );
  });

  it("replay protection: same (coordinator, nonce) PDA cannot be reused", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .castVote({ yes: {} }, null)
          .accounts({ participant: charlie.publicKey, transaction: txAcc })
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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await expectError(
      () =>
        program.methods
          .castVote({ yes: {} }, null)
          .accounts({ participant: alice.publicKey, transaction: txAcc })
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
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
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
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
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
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    const balanceBefore = await provider.connection.getBalance(
      coordinator.publicKey
    );

    await program.methods
      .closeTransaction()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, null)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .closeTransaction()
          .accounts({ coordinator: alice.publicKey, transaction: txAcc })
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
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await expectError(
      () =>
        program.methods
          .closeTransaction()
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
          .signers([coordinator])
          .rpc(),
      "NotTerminal"
    );
  });

  it("CPI hooks: on_2pc_commit fires on all participants when commit() called", async () => {
    // Initialize state accounts in demo_participant for alice and bob
    const aliceState = Keypair.generate();
    const bobState = Keypair.generate();

    await demoProgram.methods
      .initialize()
      .accounts({ payer: coordinator.publicKey, state: aliceState.publicKey })
      .signers([coordinator, aliceState])
      .rpc();

    await demoProgram.methods
      .initialize()
      .accounts({ payer: coordinator.publicKey, state: bobState.publicKey })
      .signers([coordinator, bobState])
      .rpc();

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("committing" in state.phase);

    await program.methods
      .commit()
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .remainingAccounts([
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: aliceState.publicKey, isWritable: true, isSigner: false },
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: bobState.publicKey, isWritable: true, isSigner: false },
      ])
      .signers([coordinator])
      .rpc();

    const aliceData = await demoProgram.account.participantState.fetch(
      aliceState.publicKey
    );
    const bobData = await demoProgram.account.participantState.fetch(
      bobState.publicKey
    );

    assert.ok(aliceData.finalized, "alice hook: finalized");
    assert.ok(aliceData.committed, "alice hook: committed=true");
    assert.ok(bobData.finalized, "bob hook: finalized");
    assert.ok(bobData.committed, "bob hook: committed=true");
  });

  it("CPI hooks: on_2pc_abort fires when timeout_abort() called", async () => {
    // Alice votes YES with a hook, bob never votes — tx expires in Preparing
    const aliceState = Keypair.generate();

    await demoProgram.methods
      .initialize()
      .accounts({ payer: coordinator.publicKey, state: aliceState.publicKey })
      .signers([coordinator, aliceState])
      .rpc();

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(1), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("preparing" in state.phase);
    await waitForSlot(provider.connection, state.timeoutSlot.toNumber());

    await program.methods
      .timeoutAbort()
      .accounts({ transaction: txAcc })
      .remainingAccounts([
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: aliceState.publicKey, isWritable: true, isSigner: false },
      ])
      .rpc();

    const aliceData = await demoProgram.account.participantState.fetch(
      aliceState.publicKey
    );
    assert.ok(aliceData.finalized, "alice hook: finalized");
    assert.ok(!aliceData.committed, "alice hook: committed=false");
  });

  it("CPI hooks: MissingHookAccount when remaining_accounts not provided", async () => {
    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    await program.methods
      .castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    await expectError(
      () =>
        program.methods
          .commit()
          .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
          .signers([coordinator])
          .rpc(),
      "MissingHookAccount"
    );
  });

  it("CPI hooks: on_2pc_abort fires when abort() called", async () => {
    const aliceState = Keypair.generate();
    const bobState = Keypair.generate();

    await demoProgram.methods
      .initialize()
      .accounts({ payer: coordinator.publicKey, state: aliceState.publicKey })
      .signers([coordinator, aliceState])
      .rpc();

    await demoProgram.methods
      .initialize()
      .accounts({ payer: coordinator.publicKey, state: bobState.publicKey })
      .signers([coordinator, bobState])
      .rpc();

    const n = nextNonce();
    const txAcc = txPda(coordinator.publicKey, n, program.programId);

    await program.methods
      .beginTransaction([alice.publicKey, bob.publicKey], new BN(100), n)
      .accounts({ coordinator: coordinator.publicKey, transaction: txAcc })
      .signers([coordinator])
      .rpc();

    // Bob votes YES first (phase still Preparing), registers hook
    await program.methods
      .castVote({ yes: {} }, demoProgram.programId)
      .accounts({ participant: bob.publicKey, transaction: txAcc })
      .signers([bob])
      .rpc();

    await program.methods
      .castVote({ no: {} }, demoProgram.programId)
      .accounts({ participant: alice.publicKey, transaction: txAcc })
      .signers([alice])
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    assert.ok("aborting" in state.phase);

    await program.methods
      .abort()
      .accounts({ transaction: txAcc })
      .remainingAccounts([
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: aliceState.publicKey, isWritable: true, isSigner: false },
        { pubkey: demoProgram.programId, isWritable: false, isSigner: false },
        { pubkey: bobState.publicKey, isWritable: true, isSigner: false },
      ])
      .rpc();

    const aliceData = await demoProgram.account.participantState.fetch(
      aliceState.publicKey
    );
    const bobData = await demoProgram.account.participantState.fetch(
      bobState.publicKey
    );

    assert.ok(aliceData.finalized, "alice hook: finalized");
    assert.ok(!aliceData.committed, "alice hook: committed=false");
    assert.ok(bobData.finalized, "bob hook: finalized");
    assert.ok(!bobData.committed, "bob hook: committed=false");
  });
});
