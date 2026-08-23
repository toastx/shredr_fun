/**
 * ShredrProgram — web3.js v1 facade over the Codama-generated client.
 *
 * The instruction layouts, account layout and error codes live in
 * `src/generated` (regenerate with `npm run generate:client`). This module
 * adapts them to the `@solana/web3.js` v1 primitives the rest of the app uses,
 * and keeps PDA derivation synchronous (the generated finders are async because
 * `@solana/kit` hashes via SubtleCrypto).
 *
 * Program address: H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6
 *
 * Instructions:
 *   0    - InitializeAndDelegate: create the stealth PDA, sweep the burner's
 *          deposit into it, delegate to MagicBlock
 *   1    - PrivateTransfer: move lamports between stealth PDAs inside the rollup
 *   2    - CommitStealth: flush rollup state, keep delegated
 *   3    - CommitAndUndelegateStealth: flush state + release to the base layer
 *   4    - Withdraw: withdraw from a stealth PDA after undelegation
 *   0xFF - UndelegationCallback: called by the delegation program (not user-invoked)
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  address,
  createNoopSigner,
  isSignerRole,
  isWritableRole,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { Buffer } from "buffer";

import {
  getCommitAndUndelegateStealthInstruction,
  getCommitStealthInstruction,
  getInitializeAndDelegateInstruction,
  getPrivateTransferInstruction,
  getShredrProgramErrorMessage,
  getStealthAccountDecoder,
  getWithdrawInstruction,
  isShredrProgramError,
  SHREDR_PROGRAM_PROGRAM_ADDRESS,
  STEALTH_ACCOUNT_DISCRIMINATOR,
  type ShredrProgramError,
} from "../generated";
import {
  MAGIC_BLOCK_PROGRAM_ID as MAGIC_BLOCK_PROGRAM_ID_STR,
  MAGIC_CONTEXT as MAGIC_CONTEXT_STR,
  MAGIC_PROGRAM_ID as MAGIC_PROGRAM_ID_STR,
  PERMISSION_PROGRAM_ID as PERMISSION_PROGRAM_ID_STR,
} from "./constants";

// ============ PROGRAM CONSTANTS ============

/** The on-chain program address */
export const SHREDR_PROGRAM_ID = new PublicKey(SHREDR_PROGRAM_PROGRAM_ADDRESS);

/** PDA seed prefixes (must match on-chain constants.rs) */
export const SEEDS = {
  STEALTH_ADDRESS: Buffer.from("shredr_stealth_address"),
  PROGRAM_CONFIG: Buffer.from("shredr_program_config"),
  USER_ADDRESS: Buffer.from("shredr_user_address"),
} as const;

/** Instruction discriminators (matching the program's dispatch in lib.rs) */
export const StealthInstruction = {
  InitializeAndDelegate: 0,
  PrivateTransfer: 1,
  CommitStealth: 2,
  CommitAndUndelegateStealth: 3,
  Withdraw: 4,
  UndelegationCallback: 0xff,
} as const;

/** On-chain size of a stealth account: 8-byte discriminator + StealthAccount. */
export const STEALTH_ACCOUNT_LEN = 96;

/**
 * `StealthAccount.role` — which leg of a cycle a PDA is.
 *
 * Recorded so recovery can tell a stranded deposit from a stranded exit; the
 * program never authorizes on it. Accounts written before the field existed
 * read back as `unset`.
 */
export const STEALTH_ROLE = { unset: 0, deposit: 1, exit: 2 } as const;

export type StealthRole = (typeof STEALTH_ROLE)[keyof typeof STEALTH_ROLE];

// ============ MagicBlock Constants ============

/** MagicBlock Delegation Program ID (base layer — owns delegated accounts). */
export const MAGIC_BLOCK_PROGRAM_ID = new PublicKey(MAGIC_BLOCK_PROGRAM_ID_STR);

/** MagicBlock Magic Program ID (rollup side — handles ScheduleCommit). */
export const MAGIC_PROGRAM_ID = new PublicKey(MAGIC_PROGRAM_ID_STR);

/** MagicBlock context account (singleton, used by Commit/Undelegate). */
export const MAGIC_CONTEXT = new PublicKey(MAGIC_CONTEXT_STR);

/** ACL Permission program (used by InitializeAndDelegate). */
export const PERMISSION_PROGRAM_ID = new PublicKey(PERMISSION_PROGRAM_ID_STR);

/** MagicBlock SDK seed prefixes (matches ephemeral-rollups-sdk). */
const BUFFER_SEED = Buffer.from("buffer");
const DELEGATION_SEED = Buffer.from("delegation");
const DELEGATION_METADATA_SEED = Buffer.from("delegation-metadata");
/** Note the trailing colon — `acl::consts::PERMISSION` is `b"permission:"`. */
const PERMISSION_SEED = Buffer.from("permission:");

// ============ KIT <-> WEB3.JS v1 ADAPTERS ============

type GeneratedInstruction = Instruction<string> &
  InstructionWithAccounts<readonly { address: Address; role: number }[]> &
  InstructionWithData<ReadonlyUint8Array>;

/** web3.js pubkey → kit address. */
function toAddress(pubkey: PublicKey): Address {
  return address(pubkey.toBase58());
}

/**
 * Signer placeholder for the generated builders. Only the address matters here:
 * the transaction is actually signed downstream by web3.js keypairs and the
 * Kora relayer, so the builder just needs to mark the account as a signer.
 */
function toSigner(pubkey: PublicKey) {
  return createNoopSigner(toAddress(pubkey));
}

/** Generated (kit) instruction → web3.js v1 TransactionInstruction. */
function toTransactionInstruction(
  instruction: GeneratedInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: isSignerRole(account.role),
      isWritable: isWritableRole(account.role),
    })),
    data: Buffer.from(instruction.data),
  });
}

// ============ PDA DERIVATION ============

/**
 * Derive a stealth account PDA from a burner pubkey.
 * Seeds: [STEALTH_ADDRESS, burner_pubkey]
 *
 * Used for both:
 *   - Stealth PDA (one-time burner per receive)
 *   - Main PDA (persistent main burner)
 *
 * Mirrors `findStealthAccountPda` in `src/generated/pdas`, synchronously.
 */
export function deriveStealthPDA(burnerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_ADDRESS, burnerPubkey.toBuffer()],
    SHREDR_PROGRAM_ID,
  );
}

/**
 * Derive MagicBlock delegation-related PDAs.
 *
 * MagicBlock conventions (from ephemeral-rollups-sdk):
 *   - delegation_record:   PDA(["delegation", account.key], DELEGATION_PROGRAM_ID)
 *   - delegation_metadata: PDA(["delegation-metadata", account.key], DELEGATION_PROGRAM_ID)
 *   - delegation_buffer:   PDA(["buffer", account.key], OWNER_PROGRAM_ID)  ← under owner program
 *   - permission_account:  PDA(["permission:", account.key], PERMISSION_PROGRAM_ID)
 */
export function deriveDelegationPDAs(stealthPda: PublicKey) {
  const [permissionAccount] = PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, stealthPda.toBuffer()],
    PERMISSION_PROGRAM_ID,
  );

  // Buffer is owned by the SHREDR program (the delegated account's owner)
  const [delegationBuffer] = PublicKey.findProgramAddressSync(
    [BUFFER_SEED, stealthPda.toBuffer()],
    SHREDR_PROGRAM_ID,
  );

  const [delegationRecord] = PublicKey.findProgramAddressSync(
    [DELEGATION_SEED, stealthPda.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID,
  );

  const [delegationMetadata] = PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_SEED, stealthPda.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID,
  );

  return {
    permissionAccount,
    delegationBuffer,
    delegationRecord,
    delegationMetadata,
  };
}

// ============ INSTRUCTION BUILDERS ============

/**
 * Build an InitializeAndDelegate instruction.
 *
 * Creates the stealth PDA for `burner`, sweeps `depositAmount` lamports from
 * the burner account into it, and delegates it to a MagicBlock TEE validator.
 * The relayer pays rent and fees, so `depositAmount` is exactly what the sender
 * deposited on the burner address.
 *
 * Pass `depositAmount = 0n` to create an empty delegated PDA — that is how the
 * main PDA is prepared before it receives a private transfer.
 *
 * @param relayer       - Kora relayer paying for the transaction (signer)
 * @param burner        - One-time burner keypair (signer)
 * @param depositAmount - Lamports to sweep from the burner into the PDA (u64)
 */
export function createInitializeAndDelegateInstruction(
  relayer: PublicKey,
  burner: PublicKey,
  depositAmount: bigint,
  role: StealthRole = depositAmount > 0n ? STEALTH_ROLE.deposit : STEALTH_ROLE.exit,
): TransactionInstruction {
  const [stealthAccount] = deriveStealthPDA(burner);
  const delegationPDAs = deriveDelegationPDAs(stealthAccount);

  const instruction = toTransactionInstruction(
    getInitializeAndDelegateInstruction({
      relayer: toSigner(relayer),
      burner: toSigner(burner),
      stealthAccount: toAddress(stealthAccount),
      permissionAccount: toAddress(delegationPDAs.permissionAccount),
      delegationBuffer: toAddress(delegationPDAs.delegationBuffer),
      delegationRecord: toAddress(delegationPDAs.delegationRecord),
      delegationMetadata: toAddress(delegationPDAs.delegationMetadata),
      depositAmount,
      role,
    }),
  );

  // The program CPIs into the ACL permission program and the MagicBlock
  // delegation program. Solana resolves a CPI's callee from the transaction's
  // account keys, so both must appear here or the CPI cannot be dispatched.
  // `InitializeAndDelegate::try_from` reads exactly nine accounts positionally,
  // so these trailing entries are ignored by the program itself.
  instruction.keys.push(
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MAGIC_BLOCK_PROGRAM_ID, isSigner: false, isWritable: false },
  );

  return instruction;
}

/**
 * Build a PrivateTransfer instruction (executed inside the MagicBlock rollup).
 *
 * A PDA can never sign, so the transfer is authorized by the burner that owns
 * the source PDA: it signs, and its address must match the PDA's recorded
 * owner (the ACL member registered at delegation time).
 *
 * @param sourceBurner   - Burner owning the source stealth PDA (signer)
 * @param sourcePda      - Source stealth PDA
 * @param destinationPda - Destination stealth PDA (typically the main PDA)
 * @param amount         - Amount in lamports (u64)
 */
export function createPrivateTransferInstruction(
  sourceBurner: PublicKey,
  sourcePda: PublicKey,
  destinationPda: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return toTransactionInstruction(
    getPrivateTransferInstruction({
      sourceBurner: toSigner(sourceBurner),
      sourcePda: toAddress(sourcePda),
      destinationPda: toAddress(destinationPda),
      amount,
    }),
  );
}

/**
 * Build a CommitStealth instruction.
 *
 * Flushes rollup state to the base layer while keeping the account delegated.
 */
export function createCommitStealthInstruction(
  relayer: PublicKey,
  stealthAccount: PublicKey,
  magicProgram: PublicKey = MAGIC_PROGRAM_ID,
  magicContext: PublicKey = MAGIC_CONTEXT,
): TransactionInstruction {
  return toTransactionInstruction(
    getCommitStealthInstruction({
      relayer: toSigner(relayer),
      stealthAccount: toAddress(stealthAccount),
      magicProgram: toAddress(magicProgram),
      magicContext: toAddress(magicContext),
    }),
  );
}

/**
 * Build a CommitAndUndelegateStealth instruction.
 *
 * Flushes state AND releases the account back to the base layer.
 */
export function createCommitAndUndelegateStealthInstruction(
  relayer: PublicKey,
  stealthAccount: PublicKey,
  magicProgram: PublicKey = MAGIC_PROGRAM_ID,
  magicContext: PublicKey = MAGIC_CONTEXT,
): TransactionInstruction {
  return toTransactionInstruction(
    getCommitAndUndelegateStealthInstruction({
      relayer: toSigner(relayer),
      stealthAccount: toAddress(stealthAccount),
      magicProgram: toAddress(magicProgram),
      magicContext: toAddress(magicContext),
    }),
  );
}

/**
 * Build a Withdraw instruction.
 *
 * After undelegation, the burner that owns a stealth PDA can withdraw from it
 * to any destination address. Signed by that burner keypair.
 *
 * @param burner      - Burner pubkey recorded as the PDA owner (signer)
 * @param stealthPda  - The stealth PDA holding the funds
 * @param destination - Any destination address to receive funds
 * @param amount      - Amount in lamports (u64)
 */
export function createStealthWithdrawInstruction(
  burner: PublicKey,
  stealthPda: PublicKey,
  destination: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return toTransactionInstruction(
    getWithdrawInstruction({
      burner: toSigner(burner),
      stealthAccount: toAddress(stealthPda),
      destination: toAddress(destination),
      amount,
    }),
  );
}

// ============ ACCOUNT DATA PARSING ============

/** Parsed stealth account data */
export interface StealthAccountData {
  owner: PublicKey;
  salt: Uint8Array;
  depositedAmount: bigint;
  depositTimestamp: bigint;
  delegated: boolean;
  bump: number;
  /** 0 unset, 1 deposit, 2 exit — see {@link STEALTH_ROLE}. */
  role: number;
}

/**
 * Parse a stealth account's on-chain data.
 *
 * @param data - Raw account data bytes
 * @returns Parsed StealthAccountData or null if the account is not a
 *          SHREDR stealth account (wrong size or discriminator)
 */
export function parseStealthAccount(
  data: Uint8Array,
): StealthAccountData | null {
  if (data.length < STEALTH_ACCOUNT_LEN) return null;

  for (let i = 0; i < STEALTH_ACCOUNT_DISCRIMINATOR.length; i++) {
    if (data[i] !== STEALTH_ACCOUNT_DISCRIMINATOR[i]) return null;
  }

  const decoded = getStealthAccountDecoder().decode(data);

  return {
    owner: new PublicKey(decoded.owner),
    salt: new Uint8Array(decoded.salt),
    depositedAmount: decoded.depositedAmount,
    depositTimestamp: decoded.depositTimestamp,
    delegated: decoded.delegated,
    bump: decoded.bump,
    role: decoded.role,
  };
}

// ============ ERRORS ============

/**
 * Map a SHREDR custom program error code to its message.
 *
 * Returns null for codes the program does not define (e.g. errors raised by
 * the System Program or the MagicBlock delegation program).
 */
export function getShredrErrorMessage(code: number): string | null {
  if (!isShredrProgramErrorCode(code)) return null;
  return getShredrProgramErrorMessage(code);
}

function isShredrProgramErrorCode(code: number): code is ShredrProgramError {
  return code >= 6000 && code <= 6011;
}

export { isShredrProgramError };
