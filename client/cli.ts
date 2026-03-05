#!/usr/bin/env npx ts-node

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Command } from "commander";
import { TwoPhaseCommit } from "../target/types/two_phase_commit";
import { Keypair, PublicKey, Connection, clusterApiUrl } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_KEYPAIR = path.join(os.homedir(), ".config/solana/id.json");
const DEFAULT_TIMEOUT_SLOTS = 150;
const PROGRAM_ID = new PublicKey(
  "2PCPgunAXWWUSiKGChz6UQuspAz6Tgqc7mNdWkanGSMM"
);

function loadKeypair(keyPath: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8")))
  );
}

function setupProgram(keypairPath: string): {
  program: Program<TwoPhaseCommit>;
  wallet: Keypair;
} {
  const wallet = loadKeypair(keypairPath);
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/two_phase_commit.json"),
      "utf-8"
    )
  );
  return { program: new Program<TwoPhaseCommit>(idl, provider), wallet };
}

function txPda(coordinator: PublicKey, nonce: BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("tx2pc"),
      coordinator.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );
  return pda;
}

function phaseName(phase: any): string {
  if ("preparing" in phase) return "PREPARING";
  if ("committing" in phase) return "COMMITTING";
  if ("aborting" in phase) return "ABORTING";
  if ("committed" in phase) return "COMMITTED ✅";
  if ("aborted" in phase) return "ABORTED ❌";
  return "UNKNOWN";
}

function voteName(vote: any): string {
  if (!vote) return "pending";
  if ("yes" in vote) return "YES ✅";
  if ("no" in vote) return "NO ❌";
  return "?";
}

const cli = new Command()
  .name("2pc")
  .description("Two-Phase Commit CLI — Solana Devnet")
  .version("1.0.0");

cli
  .command("begin <participants...>")
  .description("Start a new 2PC transaction")
  .option("-k, --keypair <path>", "coordinator keypair", DEFAULT_KEYPAIR)
  .option(
    "-t, --timeout <slots>",
    "slots before timeout",
    String(DEFAULT_TIMEOUT_SLOTS)
  )
  .option("-n, --nonce <n>", "custom nonce (default: timestamp)")
  .action(async (participantArgs: string[], opts) => {
    const { program, wallet } = setupProgram(opts.keypair);
    const participants = participantArgs.map((p) => new PublicKey(p));
    const nonce = new BN(opts.nonce ?? Date.now());
    const txAcc = txPda(wallet.publicKey, nonce);

    console.log(`\nCoordinator : ${wallet.publicKey.toBase58()}`);
    console.log(
      `Participants: ${participants.map((p) => p.toBase58()).join(", ")}`
    );
    console.log(`Timeout     : ${opts.timeout} slots`);
    console.log(`Nonce       : ${nonce.toString()}`);
    console.log(`TX account  : ${txAcc.toBase58()}`);

    const sig = await program.methods
      .beginTransaction(participants, new BN(opts.timeout), nonce)
      .accounts({ coordinator: wallet.publicKey, transaction: txAcc } as any)
      .rpc();

    console.log(`\n✅ Transaction created`);
    console.log(`Signature  : ${sig}`);
    console.log(`TX account : ${txAcc.toBase58()}`);
    console.log(
      `Explorer   : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  });

cli
  .command("vote <tx> <choice>")
  .description("Cast a vote (yes or no)")
  .option("-k, --keypair <path>", "participant keypair", DEFAULT_KEYPAIR)
  .option("-H, --hook <program_id>", "CPI hook program to call on finalization")
  .action(async (txPubkey: string, choice: string, opts) => {
    if (choice !== "yes" && choice !== "no") {
      console.error("Choice must be 'yes' or 'no'");
      process.exit(1);
    }
    const { program, wallet } = setupProgram(opts.keypair);
    const txAcc = new PublicKey(txPubkey);
    const vote = choice === "yes" ? { yes: {} } : { no: {} };
    const hookProgram = opts.hook ? new PublicKey(opts.hook) : null;

    console.log(`\nParticipant : ${wallet.publicKey.toBase58()}`);
    console.log(`TX account  : ${txAcc.toBase58()}`);
    console.log(`Vote        : ${choice.toUpperCase()}`);
    if (hookProgram) console.log(`Hook        : ${hookProgram.toBase58()}`);

    const sig = await (program.methods as any)
      .castVote(vote, hookProgram)
      .accounts({ participant: wallet.publicKey, transaction: txAcc })
      .rpc();

    const state = await program.account.transaction2Pc.fetch(txAcc);
    console.log(`\n✅ Vote recorded`);
    console.log(`Phase      : ${phaseName(state.phase)}`);
    console.log(`Yes count  : ${state.yesCount}/${state.participantCount}`);
    console.log(
      `Explorer   : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  });

cli
  .command("commit <tx>")
  .description("Finalize commit (coordinator only)")
  .option("-k, --keypair <path>", "coordinator keypair", DEFAULT_KEYPAIR)
  .action(async (txPubkey: string, opts) => {
    const { program, wallet } = setupProgram(opts.keypair);
    const txAcc = new PublicKey(txPubkey);

    const sig = await program.methods
      .commit()
      .accounts({ coordinator: wallet.publicKey, transaction: txAcc } as any)
      .rpc();

    console.log(`\n✅ COMMITTED`);
    console.log(
      `Explorer : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  });

cli
  .command("abort <tx>")
  .description("Finalize abort (permissionless)")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .action(async (txPubkey: string, opts) => {
    const { program } = setupProgram(opts.keypair);
    const txAcc = new PublicKey(txPubkey);

    const sig = await program.methods
      .abort()
      .accounts({ transaction: txAcc })
      .rpc();

    console.log(`\n✅ ABORTED`);
    console.log(
      `Explorer : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  });

cli
  .command("timeout-abort <tx>")
  .description("Abort an expired transaction (permissionless)")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .action(async (txPubkey: string, opts) => {
    const { program } = setupProgram(opts.keypair);
    const txAcc = new PublicKey(txPubkey);

    const state = await program.account.transaction2Pc.fetch(txAcc);
    const currentSlot = await program.provider.connection.getSlot();
    const expired = currentSlot > state.timeoutSlot.toNumber();

    console.log(`\nPhase       : ${phaseName(state.phase)}`);
    console.log(`Timeout slot: ${state.timeoutSlot.toString()}`);
    console.log(`Current slot: ${currentSlot}`);
    console.log(`Expired     : ${expired ? "YES" : "NO"}`);

    if (!expired) {
      const wait = state.timeoutSlot.toNumber() - currentSlot + 1;
      console.log(
        `\nNot expired yet. Wait ~${Math.ceil(wait * 0.4)}s (${wait} slots)`
      );
    }

    const sig = await program.methods
      .timeoutAbort()
      .accounts({ transaction: txAcc })
      .rpc();

    console.log(`\n✅ ABORTED (timeout)`);
    console.log(
      `Explorer : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  });

cli
  .command("close <tx>")
  .description("Close accounts and reclaim rent (coordinator only)")
  .option("-k, --keypair <path>", "coordinator keypair", DEFAULT_KEYPAIR)
  .action(async (txPubkey: string, opts) => {
    const { program, wallet } = setupProgram(opts.keypair);
    const txAcc = new PublicKey(txPubkey);

    const sig = await program.methods
      .closeTransaction()
      .accounts({ coordinator: wallet.publicKey, transaction: txAcc } as any)
      .rpc();

    console.log(`\n✅ Accounts closed, rent reclaimed`);
    console.log(
      `Explorer : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  });

cli
  .command("status <tx>")
  .description("Show current transaction state")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .action(async (txPubkey: string, opts) => {
    const { program } = setupProgram(opts.keypair);
    const txAcc = new PublicKey(txPubkey);

    const state = await program.account.transaction2Pc.fetch(txAcc);
    const currentSlot = await program.provider.connection.getSlot();
    const slotsLeft = state.timeoutSlot.toNumber() - currentSlot;

    console.log(`\n${"─".repeat(56)}`);
    console.log(`  2PC Transaction Status`);
    console.log(`${"─".repeat(56)}`);
    console.log(`  Account     : ${txAcc.toBase58()}`);
    console.log(`  Phase       : ${phaseName(state.phase)}`);
    console.log(`  Coordinator : ${state.coordinator.toBase58()}`);
    console.log(
      `  Timeout     : ${state.timeoutSlot.toString()} (${
        slotsLeft > 0 ? `${slotsLeft} slots left` : "EXPIRED"
      })`
    );
    console.log(`  Yes votes   : ${state.yesCount}/${state.participantCount}`);
    console.log(`${"─".repeat(56)}`);

    for (let i = 0; i < state.participantCount; i++) {
      console.log(`  [${i + 1}] ${voteName(state.votes[i])}`);
    }

    console.log(`${"─".repeat(56)}`);
    console.log(
      `  Explorer: https://explorer.solana.com/address/${txAcc.toBase58()}?cluster=devnet`
    );
  });

cli
  .command("watchdog")
  .description("Poll for expired transactions and auto-abort them (permissionless)")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .option("-i, --interval <seconds>", "poll interval", "10")
  .action(async (opts) => {
    const { program } = setupProgram(opts.keypair);
    const intervalMs = parseInt(opts.interval) * 1000;

    console.log(`\nWatchdog started — polling every ${opts.interval}s`);
    console.log(`Program : ${PROGRAM_ID.toBase58()}`);

    while (true) {
      const currentSlot = await program.provider.connection.getSlot();
      const accounts = await program.account.transaction2Pc.all();

      for (const { publicKey, account } of accounts) {
        const phase = account.phase;
        const abortable = "preparing" in phase || "aborting" in phase;
        const expired = currentSlot > account.timeoutSlot.toNumber();

        if (abortable && expired) {
          console.log(`\nExpired: ${publicKey.toBase58()} (${phaseName(phase)})`);
          try {
            const sig = await program.methods
              .timeoutAbort()
              .accounts({ transaction: publicKey })
              .rpc();
            console.log(`✅ Aborted — ${sig}`);
          } catch (e: any) {
            console.log(`❌ ${e.message}`);
          }
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
  });

cli.parseAsync(process.argv).catch((err) => {
  console.error("\n❌", err.message ?? err);
  process.exit(1);
});
