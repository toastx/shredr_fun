/**
 * Shielded-pool test client.
 *
 *   npx tsx scripts/pool-cli.ts <command> [args]
 *
 *   authority                      print/generate the KYT authority key
 *   state    <denom>               decode the vault and ledger
 *   init     <denom>               InitializePool
 *   deposit  <denom>               mint a note, screen it, PoolDeposit
 *   delegate <denom>               DelegatePoolLedger
 *   spend    <denom> <note> [dest] PoolSpend, against the ER
 *   undelegate <denom>             commit and undelegate the ledger
 *   epoch    <denom>               AdvanceEpoch
 *   notes                          list local notes
 *
 * `<denom>` is 1, 10, 100 or 1000 (SOL).
 *
 * Env: RPC_URL, ER_RPC_URL, PROGRAM_ID, KEYPAIR, KYT_AUTHORITY_KEY.
 *
 * Constants here mirror the program; each names the symbol it tracks. Nothing is
 * imported from `src/lib`, which reads `import.meta.env` and will not load here.
 *
 * `.pool-cli-state.json` holds note secrets in the clear. Test keys only.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

// ============ CONSTANTS, mirrored from the program ============

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6",
);
const MAGIC_BLOCK_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);
const PERMISSION_PROGRAM_ID = new PublicKey(
  "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1",
);
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/** `constants::seeds`. */
const SEED_POOL_VAULT = Buffer.from("shredr_pool_vault");
const SEED_POOL_LEDGER = Buffer.from("shredr_pool_ledger");
const SEED_NULLIFIER = Buffer.from("shredr_nullifier");
const SEED_BUFFER = Buffer.from("buffer");
const SEED_DELEGATION = Buffer.from("delegation");
const SEED_DELEGATION_METADATA = Buffer.from("delegation-metadata");
const SEED_PERMISSION = Buffer.from("permission:");

/** `ShredrInstruction::from_byte`. */
const IX = {
  initializePool: 6,
  poolDeposit: 7,
  poolSpend: 8,
  advanceEpoch: 9,
  delegatePoolLedger: 10,
  /// Reused verbatim for the ledger — it never looked at what it was flushing.
  commitAndUndelegate: 3,
} as const;

/** `constants::DENOMINATIONS`, in lamports. */
const DENOMINATIONS = [1n, 10n, 100n, 1000n].map((sol) => sol * 1_000_000_000n);

/** `merkle::DEPTH`. */
const DEPTH = 20;

/** `note` domain tags. Changing either is a new pool, not a migration. */
const COMMITMENT_TAG = Buffer.from("SHREDR_NOTE_V1");
const NULLIFIER_TAG = Buffer.from("SHREDR_NULL_V1");
const EMPTY_LEAF_TAG = Buffer.from("SHREDR_EMPTY_LEAF_V1");

/** `kyt` attestation layout. */
const ATTESTATION_MAGIC = Buffer.from("SHREDRKY");
const ATTESTATION_VERSION = 1;
const VERDICT_ALLOW = 1;
const ATTESTATION_TTL_SECS = 300;

const STATE_FILE = resolve(process.cwd(), ".pool-cli-state.json");

// ============ BASE58 ============
//
// `bs58` is a transitive dependency and ships no types. `PublicKey` covers
// 32-byte values but not the 64-byte `seed || pubkey` form.

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let out = "";
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  // Leading zero bytes are not carried by the arithmetic above.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out || "1";
}

function b58decode(text: string): Buffer {
  let value = 0n;
  for (const char of text) {
    const digit = B58_ALPHABET.indexOf(char);
    if (digit < 0) fail(`not base58: ${text.slice(0, 12)}…`);
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

// ============ HASHING, NOTES, TREE ============

const sha256 = (...parts: Buffer[]): Buffer =>
  createHash("sha256").update(Buffer.concat(parts)).digest();

const commitmentOf = (secret: Buffer) => sha256(COMMITMENT_TAG, secret);
const nullifierOf = (secret: Buffer) => sha256(NULLIFIER_TAG, secret);

/** `merkle::ZEROS`, recomputed from the same recurrence rather than copied. */
const ZEROS: Buffer[] = (() => {
  const zeros = [sha256(EMPTY_LEAF_TAG)];
  for (let level = 1; level < DEPTH; level += 1) {
    zeros.push(sha256(zeros[level - 1], zeros[level - 1]));
  }
  return zeros;
})();

/**
 * Root and authentication path for `index`.
 *
 * Mirrors `merkle::insert`: a partly filled level pairs its last node with
 * `ZEROS[level]`, not with itself.
 */
function rootAndPath(
  leaves: Buffer[],
  index: number,
): { root: Buffer; path: Buffer[] } {
  let level = leaves.slice();
  let cursor = index;
  const path: Buffer[] = [];

  for (let depth = 0; depth < DEPTH; depth += 1) {
    const sibling = level[cursor ^ 1] ?? ZEROS[depth];
    path.push(sibling);

    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(level[i], level[i + 1] ?? ZEROS[depth]));
    }

    level = next;
    cursor >>= 1;
  }

  return { root: level[0] ?? ZEROS[DEPTH - 1], path };
}

// ============ PDAs ============

const denominationBytes = (denomination: bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(denomination);
  return buf;
};

const poolVaultPda = (denomination: bigint) =>
  PublicKey.findProgramAddressSync(
    [SEED_POOL_VAULT, denominationBytes(denomination)],
    PROGRAM_ID,
  );

const poolLedgerPda = (denomination: bigint) =>
  PublicKey.findProgramAddressSync(
    [SEED_POOL_LEDGER, denominationBytes(denomination)],
    PROGRAM_ID,
  );

const nullifierPda = (nullifier: Buffer) =>
  PublicKey.findProgramAddressSync([SEED_NULLIFIER, nullifier], PROGRAM_ID);

const delegationPdas = (account: PublicKey) => ({
  permission: PublicKey.findProgramAddressSync(
    [SEED_PERMISSION, account.toBuffer()],
    PERMISSION_PROGRAM_ID,
  )[0],
  // Owned by the delegated account's owner, which is this program.
  buffer: PublicKey.findProgramAddressSync(
    [SEED_BUFFER, account.toBuffer()],
    PROGRAM_ID,
  )[0],
  record: PublicKey.findProgramAddressSync(
    [SEED_DELEGATION, account.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID,
  )[0],
  metadata: PublicKey.findProgramAddressSync(
    [SEED_DELEGATION_METADATA, account.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID,
  )[0],
});

// ============ ACCOUNT DECODING ============

/** `state::PoolVault`, after the 8-byte discriminator. */
function decodeVault(data: Buffer) {
  const body = data.subarray(8);
  return {
    denomination: body.readBigUInt64LE(0),
    totalDeposited: body.readBigUInt64LE(8),
    totalSettled: body.readBigUInt64LE(16),
    epoch: body.readBigUInt64LE(24),
    lastEpochAt: body.readBigInt64LE(32),
    nextLeafIndex: body.readBigUInt64LE(40),
    bump: body.readUInt8(48),
    root: Buffer.from(body.subarray(56, 88)),
  };
}

/** `state::PoolLedger`, after the 8-byte discriminator. */
function decodeLedger(data: Buffer) {
  const body = data.subarray(8);
  const rootCount = body.readUInt32LE(16);
  const payoutCount = body.readUInt32LE(24);

  const roots: Buffer[] = [];
  for (let i = 0; i < rootCount; i += 1) {
    roots.push(Buffer.from(body.subarray(32 + i * 32, 64 + i * 32)));
  }

  const payouts: { nullifier: Buffer; destination: PublicKey }[] = [];
  for (let i = 0; i < payoutCount; i += 1) {
    const at = 1056 + i * 64;
    payouts.push({
      nullifier: Buffer.from(body.subarray(at, at + 32)),
      destination: new PublicKey(body.subarray(at + 32, at + 64)),
    });
  }

  return {
    denomination: body.readBigUInt64LE(0),
    epoch: body.readBigUInt64LE(8),
    rootCount,
    rootCursor: body.readUInt32LE(20),
    payoutCount,
    bump: body.readUInt8(28),
    delegated: body.readUInt8(29) === 1,
    roots,
    payouts,
  };
}

// ============ KYT ATTESTATION ============

/**
 * Sign the 90-byte attestation.
 *
 * `subject` is the note commitment on this path, a burner on the stealth path.
 * `depositor` is checked on-chain against the signing wallet.
 */
function attestation(subject: Buffer, depositor: PublicKey, maxAmount: bigint) {
  const authorityKey = process.env.KYT_AUTHORITY_KEY;
  if (!authorityKey) {
    fail(
      "KYT_AUTHORITY_KEY is unset. The program requires a signed attestation for " +
        "every deposit; run `pool-cli authority` for how to generate one.",
    );
  }

  const decoded = b58decode(authorityKey.trim());
  if (decoded.length !== 32 && decoded.length !== 64) {
    fail(`KYT_AUTHORITY_KEY must be 32 or 64 bytes, got ${decoded.length}`);
  }
  const keypair = nacl.sign.keyPair.fromSeed(decoded.subarray(0, 32));

  const expiry = BigInt(Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SECS);
  const message = Buffer.alloc(90);
  ATTESTATION_MAGIC.copy(message, 0);
  message.writeUInt8(ATTESTATION_VERSION, 8);
  message.writeUInt8(VERDICT_ALLOW, 9);
  depositor.toBuffer().copy(message, 10);
  subject.copy(message, 42);
  message.writeBigUInt64LE(maxAmount, 74);
  message.writeBigInt64LE(expiry, 82);

  const signature = nacl.sign.detached(message, keypair.secretKey);

  // Indices default to u16::MAX ("this instruction"), which
  // `kyt::attested_message` requires.
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: keypair.publicKey,
    message,
    signature,
  });
}

// ============ LOCAL NOTE STORE ============

interface StoredNote {
  secret: string;
  commitment: string;
  denomination: string;
  leafIndex: number;
  spent: boolean;
}

interface CliState {
  /** Every commitment seen, in insertion order; the tree is rebuilt from it. */
  leaves: string[];
  notes: StoredNote[];
}

const loadState = (): CliState =>
  existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : { leaves: [], notes: [] };

const saveState = (state: CliState) =>
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

// ============ PLUMBING ============

const log = (...args: unknown[]) => console.log(...args);
const sol = (lamports: bigint) => `${Number(lamports) / 1e9} SOL`;
const short = (value: PublicKey | Buffer) => {
  const text = value instanceof PublicKey ? value.toBase58() : value.toString("hex");
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
};

function fail(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

function payer(): Keypair {
  const path = process.env.KEYPAIR ?? resolve(homedir(), ".config/solana/id.json");
  if (!existsSync(path)) fail(`keypair not found at ${path} — set KEYPAIR`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

const baseConnection = () =>
  new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const erConnection = () =>
  new Connection(process.env.ER_RPC_URL ?? "http://127.0.0.1:6699", "confirmed");

function parseDenomination(arg: string | undefined): bigint {
  if (!arg) fail("missing <denom> — one of 1, 10, 100, 1000");
  const lamports = BigInt(Math.round(Number(arg) * 1e9));
  if (!DENOMINATIONS.includes(lamports)) {
    fail(`${arg} SOL is not a pool denomination. Use 1, 10, 100 or 1000.`);
  }
  return lamports;
}

async function send(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = signers[0].publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  try {
    const signature = await connection.sendTransaction(transaction, signers, {
      skipPreflight: false,
    });
    await connection.confirmTransaction(signature, "confirmed");
    log(`  ${label} ✓  ${signature}`);
    return signature;
  } catch (err) {
    const logs = (err as { logs?: string[] }).logs;
    console.error(`\n  ${label} ✗  ${(err as Error).message}`);
    if (logs) logs.forEach((line) => console.error(`      ${line}`));
    process.exit(1);
  }
}

async function readPool(connection: Connection, denomination: bigint) {
  const [vault] = poolVaultPda(denomination);
  const [ledger] = poolLedgerPda(denomination);
  const [vaultInfo, ledgerInfo] = await connection.getMultipleAccountsInfo([
    vault,
    ledger,
  ]);
  return { vault, ledger, vaultInfo, ledgerInfo };
}

// ============ COMMANDS ============

function cmdAuthority() {
  const existing = process.env.KYT_AUTHORITY_KEY;
  if (existing) {
    const seed = b58decode(existing.trim()).subarray(0, 32);
    const keypair = nacl.sign.keyPair.fromSeed(seed);
    log(`\n  KYT authority: ${b58encode(keypair.publicKey)}`);
    log(`\n  The program must be built against it:`);
    log(`    SHREDR_KYT_AUTHORITY=${b58encode(keypair.publicKey)} cargo-build-sbf\n`);
    return;
  }

  const seed = randomBytes(32);
  const keypair = nacl.sign.keyPair.fromSeed(seed);
  log(`\n  No KYT_AUTHORITY_KEY set. Generated one:\n`);
  log(`    export KYT_AUTHORITY_KEY=${b58encode(seed)}`);
  log(`\n  Then rebuild the program so it trusts the matching pubkey:\n`);
  log(`    SHREDR_KYT_AUTHORITY=${b58encode(keypair.publicKey)} cargo-build-sbf\n`);
  log(`  Deposits fail with KytUnknownAuthority until those two agree.\n`);
}

async function cmdState(denomination: bigint) {
  const connection = baseConnection();
  const { vault, ledger, vaultInfo, ledgerInfo } = await readPool(
    connection,
    denomination,
  );

  log(`\n  pool ${sol(denomination)}`);
  log(`    vault   ${vault.toBase58()}`);
  log(`    ledger  ${ledger.toBase58()}`);

  if (!vaultInfo || !ledgerInfo) {
    log(`\n  not initialized — run: pool-cli init ${Number(denomination) / 1e9}\n`);
    return;
  }

  const v = decodeVault(Buffer.from(vaultInfo.data));
  const l = decodeLedger(Buffer.from(ledgerInfo.data));
  const outstanding = v.totalDeposited - v.totalSettled;

  log(`\n  vault`);
  log(`    lamports        ${sol(BigInt(vaultInfo.lamports))}`);
  log(`    deposited       ${sol(v.totalDeposited)}`);
  log(`    settled         ${sol(v.totalSettled)}`);
  log(`    outstanding     ${sol(outstanding)}   (backing owed to notes)`);
  log(`    leaves          ${v.nextLeafIndex}`);
  log(`    epoch           ${v.epoch}`);
  log(`    root            ${v.root.toString("hex")}`);

  log(`\n  ledger`);
  log(`    delegated       ${l.delegated}`);
  log(
    `    epoch           ${l.epoch}${l.epoch === v.epoch ? "" : "   ⚠ stale vs vault"}`,
  );
  log(`    known roots     ${l.rootCount}`);
  log(`    payout queue    ${l.payoutCount}`);
  for (const payout of l.payouts) {
    log(`      → ${payout.destination.toBase58()}  null ${short(payout.nullifier)}`);
  }

  const spendable = l.roots.some((root) => root.equals(v.root));
  log(
    `\n  vault root published to ledger: ${spendable ? "yes" : "no — run advance-epoch to make recent deposits spendable"}\n`,
  );
}

async function cmdInit(denomination: bigint) {
  const connection = baseConnection();
  const wallet = payer();
  const [vault] = poolVaultPda(denomination);
  const [ledger] = poolLedgerPda(denomination);

  const data = Buffer.alloc(9);
  data.writeUInt8(IX.initializePool, 0);
  data.writeBigUInt64LE(denomination, 1);

  log(`\n  initializing the ${sol(denomination)} pool`);
  log(`    vault   ${vault.toBase58()}`);
  log(`    ledger  ${ledger.toBase58()}`);

  await send(
    connection,
    [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: ledger, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }),
    ],
    [wallet],
    "InitializePool",
  );
  log("");
}

async function cmdDeposit(denomination: bigint) {
  const connection = baseConnection();
  const wallet = payer();
  const { vault, vaultInfo } = await readPool(connection, denomination);
  if (!vaultInfo) fail("pool is not initialized — run `init` first");

  const before = decodeVault(Buffer.from(vaultInfo.data));
  const secret = randomBytes(32);
  const commitment = commitmentOf(secret);
  const leafIndex = Number(before.nextLeafIndex);

  log(`\n  depositing ${sol(denomination)}`);
  log(
    `    secret      ${secret.toString("hex")}   ← the whole note; losing it loses the funds`,
  );
  log(`    commitment  ${commitment.toString("hex")}`);
  log(`    leaf index  ${leafIndex}`);

  const data = Buffer.concat([Buffer.from([IX.poolDeposit]), commitment]);

  await send(
    connection,
    [
      attestation(commitment, wallet.publicKey, denomination),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }),
    ],
    [wallet],
    "PoolDeposit",
  );

  const state = loadState();
  state.leaves.push(commitment.toString("hex"));
  state.notes.push({
    secret: secret.toString("hex"),
    commitment: commitment.toString("hex"),
    denomination: denomination.toString(),
    leafIndex,
    spent: false,
  });
  saveState(state);

  log(`\n  saved as note ${state.notes.length - 1}`);
  log(`  run \`advance-epoch\` to publish the new root before spending\n`);
}

async function cmdDelegate(denomination: bigint) {
  const connection = baseConnection();
  const wallet = payer();
  const [ledger] = poolLedgerPda(denomination);
  const pdas = delegationPdas(ledger);

  log(`\n  delegating the ${sol(denomination)} ledger`);
  log(`    permission  ${pdas.permission.toBase58()}`);

  await send(
    connection,
    [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: ledger, isSigner: false, isWritable: true },
          { pubkey: pdas.permission, isSigner: false, isWritable: true },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: pdas.buffer, isSigner: false, isWritable: true },
          { pubkey: pdas.record, isSigner: false, isWritable: true },
          { pubkey: pdas.metadata, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([IX.delegatePoolLedger]),
      }),
    ],
    [wallet],
    "DelegatePoolLedger",
  );
  log("");
}

async function cmdSpend(
  denomination: bigint,
  noteArg: string,
  destinationArg?: string,
) {
  const state = loadState();
  const index = Number(noteArg);
  const note = state.notes[index];
  if (!note) fail(`no note ${index} — run \`notes\` to list them`);
  if (note.spent) fail(`note ${index} is already marked spent`);

  const wallet = payer();
  const destination = destinationArg ? new PublicKey(destinationArg) : wallet.publicKey;
  const secret = Buffer.from(note.secret, "hex");

  // The path is proven against a root the ledger already knows, so read it from
  // the ledger rather than assuming the newest.
  const base = baseConnection();
  const { ledger, ledgerInfo } = await readPool(base, denomination);
  if (!ledgerInfo) fail("pool is not initialized");
  const decoded = decodeLedger(Buffer.from(ledgerInfo.data));
  if (!decoded.delegated) fail("ledger is not delegated — run `delegate` first");

  const leaves = state.leaves.map((leaf) => Buffer.from(leaf, "hex"));
  const { root, path } = rootAndPath(leaves, note.leafIndex);

  if (!decoded.roots.some((known) => known.equals(root))) {
    fail(
      `the ledger has not published the root this note proves against.\n` +
        `  Run \`advance-epoch\` on the base layer, then retry.\n` +
        `  computed ${root.toString("hex")}`,
    );
  }

  log(`\n  spending note ${index} (${sol(BigInt(note.denomination))})`);
  log(`    nullifier    ${nullifierOf(secret).toString("hex")}`);
  log(`    destination  ${destination.toBase58()}`);
  log(`    root         ${short(root)}`);
  log(`\n  ⚠ the secret and leaf index travel in this instruction's data. Anyone`);
  log(`    handling it before the enclave can pair this spend with its deposit.\n`);

  const data = Buffer.concat([
    Buffer.from([IX.poolSpend]),
    secret,
    destination.toBuffer(),
    root,
    (() => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(note.leafIndex));
      return buf;
    })(),
    ...path,
  ]);

  await send(
    erConnection(),
    [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [{ pubkey: ledger, isSigner: false, isWritable: true }],
        data,
      }),
    ],
    [wallet],
    "PoolSpend",
  );

  note.spent = true;
  saveState(state);
  log(`\n  queued. run \`advance-epoch\` to settle it\n`);
}

async function cmdEpoch(denomination: bigint) {
  const connection = baseConnection();
  const wallet = payer();
  const { vault, ledger, ledgerInfo } = await readPool(connection, denomination);
  if (!ledgerInfo) fail("pool is not initialized");

  const decoded = decodeLedger(Buffer.from(ledgerInfo.data));
  if (decoded.delegated) {
    fail(
      "ledger is still delegated — commit and undelegate it before turning the epoch",
    );
  }

  // (destination, nullifier_record) pairs, matched positionally to the queue
  // front. Fewer pairs than the queue holds leaves the rest for the next turn.
  const settlements = decoded.payouts.flatMap((payout) => [
    { pubkey: payout.destination, isSigner: false, isWritable: true },
    { pubkey: nullifierPda(payout.nullifier)[0], isSigner: false, isWritable: true },
  ]);

  log(`\n  turning the epoch on the ${sol(denomination)} pool`);
  log(`    queued payouts  ${decoded.payoutCount}`);

  await send(
    connection,
    [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: ledger, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ...settlements,
        ],
        data: Buffer.from([IX.advanceEpoch]),
      }),
    ],
    [wallet],
    "AdvanceEpoch",
  );
  log("");
}

/**
 * Flush the ledger and return it to the base layer.
 *
 * Issued against the ER. `AdvanceEpoch` refuses a delegated ledger.
 */
async function cmdUndelegate(denomination: bigint) {
  const wallet = payer();
  const [ledger] = poolLedgerPda(denomination);

  log(`\n  committing and undelegating the ${sol(denomination)} ledger`);

  await send(
    erConnection(),
    [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: ledger, isSigner: false, isWritable: true },
          { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([IX.commitAndUndelegate]),
      }),
    ],
    [wallet],
    "CommitAndUndelegateStealth",
  );

  log(`\n  undelegation is asynchronous — poll \`state\` until delegated is false\n`);
}

function cmdNotes() {
  const state = loadState();
  if (state.notes.length === 0) {
    log("\n  no notes yet\n");
    return;
  }

  log(
    `\n  ${state.notes.length} note(s), ${state.leaves.length} leaf/leaves tracked\n`,
  );
  state.notes.forEach((note, index) => {
    const status = note.spent ? "spent  " : "unspent";
    log(
      `    ${String(index).padStart(3)}  ${status}  ${sol(BigInt(note.denomination)).padEnd(10)}` +
        `  leaf ${String(note.leafIndex).padEnd(5)}  ${short(Buffer.from(note.commitment, "hex"))}`,
    );
  });
  log("");
}

// ============ ENTRY ============

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "authority":
      return cmdAuthority();
    case "notes":
      return cmdNotes();
    case "state":
      return cmdState(parseDenomination(args[0]));
    case "init":
      return cmdInit(parseDenomination(args[0]));
    case "deposit":
      return cmdDeposit(parseDenomination(args[0]));
    case "delegate":
      return cmdDelegate(parseDenomination(args[0]));
    case "spend":
      return cmdSpend(parseDenomination(args[0]), args[1], args[2]);
    case "undelegate":
      return cmdUndelegate(parseDenomination(args[0]));
    case "epoch":
    case "advance-epoch":
      return cmdEpoch(parseDenomination(args[0]));
    default:
      log(`
  shielded-pool test client

    npx tsx scripts/pool-cli.ts <command> [args]

    authority                      print/generate the KYT authority key
    state    <denom>               decode the vault and ledger
    init     <denom>               InitializePool
    deposit  <denom>               mint a note, screen it, PoolDeposit
    delegate <denom>               DelegatePoolLedger
    spend    <denom> <note> [dest] PoolSpend, against the ER
    undelegate <denom>             commit + undelegate the ledger, against the ER
    epoch    <denom>               AdvanceEpoch
    notes                          list local notes

  <denom> is 1, 10, 100 or 1000 (SOL).

  A full cycle:
    init 1 → deposit 1 → epoch 1 → delegate 1 → spend 1 0 → undelegate 1 → epoch 1
`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
