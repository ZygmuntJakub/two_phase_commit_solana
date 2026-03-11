#!/usr/bin/env npx ts-node

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Command } from "commander";
import { TwoPhaseCommit } from "../target/types/two_phase_commit";
import { DemoParticipant } from "../target/types/demo_participant";
import { Keypair, PublicKey, Connection, clusterApiUrl } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_KEYPAIR = path.join(os.homedir(), ".config/solana/id.json");
const DEFAULT_TIMEOUT_SLOTS = 150;
const DEFAULT_CLUSTER = "localnet";
const ENV_FILE = path.join(process.cwd(), ".2pc-env");

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=", 2) as [string, string])
  );
}

function writeEnv(key: string, value: string) {
  const env = readEnv();
  env[key] = value;
  fs.writeFileSync(ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function resolveArg(arg: string | undefined, envKey: string, label: string): string {
  const value = arg ?? readEnv()[envKey];
  if (!value) {
    console.error(`❌ Missing ${label}. Pass it as argument or run the appropriate command first.`);
    process.exit(1);
  }
  return value;
}
const PROGRAM_ID = new PublicKey(
  "2PCPgunAXWWUSiKGChz6UQuspAz6Tgqc7mNdWkanGSMM"
);

function clusterUrl(cluster: string): string {
  if (cluster === "localnet") return "http://localhost:8899";
  if (cluster === "mainnet-beta") return clusterApiUrl("mainnet-beta");
  return clusterApiUrl(cluster as any);
}

function explorerUrl(sig: string, cluster: string): string {
  const base = `https://explorer.solana.com/tx/${sig}`;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`;
  if (cluster === "devnet") return `${base}?cluster=devnet`;
  if (cluster === "testnet") return `${base}?cluster=testnet`;
  return base;
}

async function buildHookAccounts(
  program: Program<TwoPhaseCommit>,
  txAcc: PublicKey
): Promise<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[]> {
  const state = await program.account.transaction2Pc.fetch(txAcc);
  const remaining: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (const hook of state.hooks) {
    if (hook) {
      const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("hook_state"), (hook as any).participant.toBuffer()],
        (hook as any).programId
      );
      remaining.push(
        { pubkey: (hook as any).programId, isWritable: false, isSigner: false },
        { pubkey: statePda, isWritable: true, isSigner: false }
      );
    }
  }
  return remaining;
}

function explorerAddressUrl(address: string, cluster: string): string {
  const base = `https://explorer.solana.com/address/${address}`;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`;
  if (cluster === "devnet") return `${base}?cluster=devnet`;
  if (cluster === "testnet") return `${base}?cluster=testnet`;
  return base;
}

function loadKeypair(keyPath: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8")))
  );
}

function setupProgram(keypairPath: string, cluster: string): {
  program: Program<TwoPhaseCommit>;
  wallet: Keypair;
} {
  const wallet = loadKeypair(keypairPath);
  const connection = new Connection(clusterUrl(cluster), "confirmed");
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
  .description("Two-Phase Commit CLI")
  .version("1.0.0")
  .option("-c, --cluster <name>", "localnet | devnet | testnet | mainnet-beta", DEFAULT_CLUSTER);

cli
  .command("begin <participants...>")
  .description("Start a new 2PC transaction")
  .option("-k, --keypair <path>", "coordinator keypair", DEFAULT_KEYPAIR)
  .option("-t, --timeout <slots>", "slots before timeout", String(DEFAULT_TIMEOUT_SLOTS))
  .option("-n, --nonce <n>", "custom nonce (default: timestamp)")
  .action(async (participantArgs: string[], opts) => {
    const cluster = cli.opts().cluster;
    const { program, wallet } = setupProgram(opts.keypair, cluster);
    const participants = participantArgs.map((p) => new PublicKey(p));
    const nonce = new BN(opts.nonce ?? Date.now());
    const txAcc = txPda(wallet.publicKey, nonce);

    console.log(`\nCluster     : ${cluster}`);
    console.log(`Coordinator : ${wallet.publicKey.toBase58()}`);
    console.log(`Participants: ${participants.map((p) => p.toBase58()).join(", ")}`);
    console.log(`Timeout     : ${opts.timeout} slots`);
    console.log(`Nonce       : ${nonce.toString()}`);
    console.log(`TX account  : ${txAcc.toBase58()}`);

    const sig = await program.methods
      .beginTransaction(participants, new BN(opts.timeout), nonce)
      .accounts({ coordinator: wallet.publicKey, transaction: txAcc } as any)
      .rpc();

    writeEnv("TX", txAcc.toBase58());
    console.log(`\n✅ Transaction created`);
    console.log(`Signature  : ${sig}`);
    console.log(`TX account : ${txAcc.toBase58()}`);
    console.log(`Explorer   : ${explorerUrl(sig, cluster)}`);
    console.log(`\n💾 Saved to .2pc-env`);
  });

cli
  .command("vote <choice> [tx]")
  .description("Cast a vote (yes or no) — tx defaults to TX in .2pc-env")
  .option("-k, --keypair <path>", "participant keypair", DEFAULT_KEYPAIR)
  .option("-H, --hook <program_id>", "CPI hook program to call on finalization")
  .action(async (choice: string, txArg: string | undefined, opts) => {
    if (choice !== "yes" && choice !== "no") {
      console.error("Choice must be 'yes' or 'no'");
      process.exit(1);
    }
    const cluster = cli.opts().cluster;
    const { program, wallet } = setupProgram(opts.keypair, cluster);
    const txAcc = new PublicKey(resolveArg(txArg, "TX", "transaction account"));
    const vote = choice === "yes" ? { yes: {} } : { no: {} };
    const hookAddr = opts.hook ?? readEnv()["HOOK"];
    const hookProgram = hookAddr ? new PublicKey(hookAddr) : null;

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
    console.log(`Explorer   : ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("commit [tx]")
  .description("Finalize commit (coordinator only) — tx defaults to TX in .2pc-env")
  .option("-k, --keypair <path>", "coordinator keypair", DEFAULT_KEYPAIR)
  .action(async (txArg: string | undefined, opts) => {
    const cluster = cli.opts().cluster;
    const { program, wallet } = setupProgram(opts.keypair, cluster);
    const txAcc = new PublicKey(resolveArg(txArg, "TX", "transaction account"));

    const remainingAccounts = await buildHookAccounts(program, txAcc);
    const sig = await program.methods
      .commit()
      .accounts({ coordinator: wallet.publicKey, transaction: txAcc } as any)
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log(`\n✅ COMMITTED`);
    console.log(`Explorer : ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("abort [tx]")
  .description("Finalize abort (permissionless) — tx defaults to TX in .2pc-env")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .action(async (txArg: string | undefined, opts) => {
    const cluster = cli.opts().cluster;
    const { program } = setupProgram(opts.keypair, cluster);
    const txAcc = new PublicKey(resolveArg(txArg, "TX", "transaction account"));

    const remainingAccounts = await buildHookAccounts(program, txAcc);
    const sig = await program.methods
      .abort()
      .accounts({ transaction: txAcc })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log(`\n✅ ABORTED`);
    console.log(`Explorer : ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("timeout-abort [tx]")
  .description("Abort an expired transaction (permissionless) — tx defaults to TX in .2pc-env")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .action(async (txArg: string | undefined, opts) => {
    const cluster = cli.opts().cluster;
    const { program } = setupProgram(opts.keypair, cluster);
    const txAcc = new PublicKey(resolveArg(txArg, "TX", "transaction account"));

    const state = await program.account.transaction2Pc.fetch(txAcc);
    const currentSlot = await program.provider.connection.getSlot();
    const expired = currentSlot > state.timeoutSlot.toNumber();

    console.log(`\nPhase       : ${phaseName(state.phase)}`);
    console.log(`Timeout slot: ${state.timeoutSlot.toString()}`);
    console.log(`Current slot: ${currentSlot}`);
    console.log(`Expired     : ${expired ? "YES" : "NO"}`);

    if (!expired) {
      const wait = state.timeoutSlot.toNumber() - currentSlot + 1;
      console.log(`\nNot expired yet. Wait ~${Math.ceil(wait * 0.4)}s (${wait} slots)`);
    }

    const remainingAccounts = await buildHookAccounts(program, txAcc);
    const sig = await program.methods
      .timeoutAbort()
      .accounts({ transaction: txAcc })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log(`\n✅ ABORTED (timeout)`);
    console.log(`Explorer : ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("close [tx]")
  .description("Close accounts and reclaim rent (coordinator only) — tx defaults to TX in .2pc-env")
  .option("-k, --keypair <path>", "coordinator keypair", DEFAULT_KEYPAIR)
  .action(async (txArg: string | undefined, opts) => {
    const cluster = cli.opts().cluster;
    const { program, wallet } = setupProgram(opts.keypair, cluster);
    const txAcc = new PublicKey(resolveArg(txArg, "TX", "transaction account"));

    const sig = await program.methods
      .closeTransaction()
      .accounts({ coordinator: wallet.publicKey, transaction: txAcc } as any)
      .rpc();

    console.log(`\n✅ Accounts closed, rent reclaimed`);
    console.log(`Explorer : ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("status [tx]")
  .description("Show current transaction state — tx defaults to TX in .2pc-env")
  .option("-k, --keypair <path>", "keypair", DEFAULT_KEYPAIR)
  .action(async (txArg: string | undefined, opts) => {
    const cluster = cli.opts().cluster;
    const { program } = setupProgram(opts.keypair, cluster);
    const txAcc = new PublicKey(resolveArg(txArg, "TX", "transaction account"));

    const state = await program.account.transaction2Pc.fetch(txAcc);
    const currentSlot = await program.provider.connection.getSlot();
    const slotsLeft = state.timeoutSlot.toNumber() - currentSlot;

    console.log(`\n${"─".repeat(56)}`);
    console.log(`  2PC Transaction Status`);
    console.log(`${"─".repeat(56)}`);
    console.log(`  Account     : ${txAcc.toBase58()}`);
    console.log(`  Phase       : ${phaseName(state.phase)}`);
    console.log(`  Coordinator : ${state.coordinator.toBase58()}`);
    console.log(`  Timeout     : ${state.timeoutSlot.toString()} (${slotsLeft > 0 ? `${slotsLeft} slots left` : "EXPIRED"})`);
    console.log(`  Yes votes   : ${state.yesCount}/${state.participantCount}`);
    console.log(`${"─".repeat(56)}`);

    for (let i = 0; i < state.participantCount; i++) {
      console.log(`  [${i + 1}] ${voteName(state.votes[i])}`);
    }

    console.log(`${"─".repeat(56)}`);
    console.log(`  Explorer: ${explorerAddressUrl(txAcc.toBase58(), cluster)}`);
  });

cli
  .command("init-hook <participant> [hook_program]")
  .description("Initialize hook state PDA for a participant")
  .option("-k, --keypair <path>", "payer keypair", DEFAULT_KEYPAIR)
  .action(async (participantArg: string, hookProgramArg: string | undefined, opts) => {
    const cluster = cli.opts().cluster;
    const { wallet } = setupProgram(opts.keypair, cluster);
    const participant = new PublicKey(participantArg);
    const hookProgramId = new PublicKey(resolveArg(hookProgramArg, "HOOK", "hook program"));

    const connection = new Connection(clusterUrl(cluster), "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
    anchor.setProvider(provider);

    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/demo_participant.json"), "utf-8"));
    const hookProgram = new Program<DemoParticipant>(idl, provider);

    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hook_state"), participant.toBuffer()],
      hookProgramId
    );

    console.log(`\nParticipant : ${participant.toBase58()}`);
    console.log(`Hook program: ${hookProgramId.toBase58()}`);
    console.log(`State PDA   : ${statePda.toBase58()}`);

    const sig = await hookProgram.methods
      .initialize(participant)
      .accounts({ payer: wallet.publicKey, state: statePda } as any)
      .rpc();

    writeEnv("HOOK", hookProgramId.toBase58());
    console.log(`\n✅ Hook state initialized`);
    console.log(`Explorer : ${explorerUrl(sig, cluster)}`);
    console.log(`\n💾 Saved HOOK to .2pc-env`);
  });

cli
  .command("hook-status <participant> [hook_program]")
  .description("Show hook state PDA for a participant — hook_program defaults to HOOK in .2pc-env")
  .action(async (participantArg: string, hookProgramArg: string | undefined) => {
    const cluster = cli.opts().cluster;
    const { wallet } = setupProgram(DEFAULT_KEYPAIR, cluster);
    const participant = new PublicKey(participantArg);
    const hookProgramId = new PublicKey(resolveArg(hookProgramArg, "HOOK", "hook program"));

    const connection = new Connection(clusterUrl(cluster), "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
    anchor.setProvider(provider);

    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/demo_participant.json"), "utf-8"));
    const hookProgram = new Program<DemoParticipant>(idl, provider);

    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("hook_state"), participant.toBuffer()],
      hookProgramId
    );

    const state = await hookProgram.account.participantState.fetch(statePda);

    console.log(`\nParticipant : ${participant.toBase58()}`);
    console.log(`State PDA   : ${statePda.toBase58()}`);
    console.log(`Finalized   : ${state.finalized}`);
    console.log(`Committed   : ${state.committed}`);
  });

cli.parseAsync(process.argv).catch((err) => {
  console.error("\n❌", err.message ?? err);
  process.exit(1);
});
