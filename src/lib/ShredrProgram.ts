/**
 * ShredrProgram - TypeScript client for the shredr_program smart contract
 *
 * Builds transaction instructions matching the on-chain IDL.
 * Program address: H64YCQTWdQkx9vjs1ZB2Uo24FyUBibnDxhKdznamybpZ
 *
 * Instructions:
 *   0 - InitializeAndDelegate: Create stealth PDA, delegate to MagicBlock
 *   1 - PrivateTransfer: Move lamports between stealth PDAs inside rollup
 *   2 - CommitStealth: Flush rollup state, keep delegated
 *   3 - CommitAndUndelegateStealth: Flush state + release back to base layer
 *   4 - Withdraw: Withdraw from stealth/main PDA after undelegation
 *   5 - UndelegationCallback: Called by delegation program (not user-invoked)
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  MAGIC_BLOCK_PROGRAM_ID as MAGIC_BLOCK_PROGRAM_ID_STR,
  MAGIC_CONTEXT as MAGIC_CONTEXT_STR,
  PERMISSION_PROGRAM_ID as PERMISSION_PROGRAM_ID_STR,
} from "./constants";
import { Buffer } from "buffer";

// ============ PROGRAM CONSTANTS ============

/** The on-chain program address */
export const SHREDR_PROGRAM_ID = new PublicKey(
  "H64YCQTWdQkx9vjs1ZB2Uo24FyUBibnDxhKdznamybpZ",
);

/** PDA seed prefixes (must match on-chain constants.rs) */
export const SEEDS = {
  STEALTH_ADDRESS: Buffer.from("shredr_stealth_address"),
  PROGRAM_CONFIG: Buffer.from("shredr_program_config"),
  USER_ADDRESS: Buffer.from("shredr_user_address"),
} as const;

/** Instruction discriminators (matching IDL) */
export const StealthInstruction = {
  InitializeAndDelegate: 0,
  PrivateTransfer: 1,
  CommitStealth: 2,
  CommitAndUndelegateStealth: 3,
  Withdraw: 4,
  UndelegationCallback: 0xff,
} as const;

// ============ MagicBlock Constants ============

/** MagicBlock Delegation Program ID */
export const MAGIC_BLOCK_PROGRAM_ID = new PublicKey(MAGIC_BLOCK_PROGRAM_ID_STR);

/** MagicBlock context account (singleton, used by Commit/Undelegate). */
export const MAGIC_CONTEXT = new PublicKey(MAGIC_CONTEXT_STR);

/** ACL Permission program (used by InitializeAndDelegate). */
export const PERMISSION_PROGRAM_ID = new PublicKey(PERMISSION_PROGRAM_ID_STR);

/** MagicBlock SDK seed prefixes (matches ephemeral-rollups-sdk). */
const BUFFER_SEED = Buffer.from("buffer");
const DELEGATION_SEED = Buffer.from("delegation");
const DELEGATION_METADATA_SEED = Buffer.from("delegation-metadata");
const PERMISSION_SEED = Buffer.from("permission");

// ============ PDA DERIVATION ============

/**
 * Derive a stealth account PDA from burner pubkey and salt.
 * Seeds: [STEALTH_ADDRESS, burner_pubkey, salt]
 *
 * Used for both:
 *   - Stealth PDA (one-time burner per receive)
 *   - Main PDA (persistent main burner)
 */
export function deriveStealthPDA(
  burnerPubkey: PublicKey,
  salt: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_ADDRESS, burnerPubkey.toBuffer(), Buffer.from(salt)],
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
 *   - permission_account:  PDA(["permission", account.key], PERMISSION_PROGRAM_ID)
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
 * Creates a stealth PDA from burner+salt, initializes state, and delegates
 * to a MagicBlock TEE validator.
 *
 * @param relayer      - Kora relayer paying for the transaction (signer)
 * @param burner       - One-time burner keypair (signer)
 * @param salt         - 32-byte random salt for PDA derivation
 * @param burnerPubkey - Burner's public key as 32-byte array
 * @param commitDelay  - Commit delay in seconds (i64)
 */
export function createInitializeAndDelegateInstruction(
  relayer: PublicKey,
  burner: PublicKey,
  salt: Uint8Array,
  burnerPubkey: Uint8Array,
  commitDelay: bigint,
): TransactionInstruction {
  const [stealthAccount] = deriveStealthPDA(burner, salt);
  const delegationPDAs = deriveDelegationPDAs(stealthAccount);

  // Instruction data: [discriminator(1)] [salt(32)] [burnerPubkey(32)] [commitDelay(8)]
  const data = Buffer.alloc(1 + 32 + 32 + 8);
  data.writeUInt8(StealthInstruction.InitializeAndDelegate, 0);
  Buffer.from(salt).copy(data, 1);
  Buffer.from(burnerPubkey).copy(data, 33);
  data.writeBigInt64LE(commitDelay, 65);

  return new TransactionInstruction({
    programId: SHREDR_PROGRAM_ID,
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: burner, isSigner: true, isWritable: true },
      { pubkey: SHREDR_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: stealthAccount, isSigner: false, isWritable: true },
      {
        pubkey: delegationPDAs.permissionAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationPDAs.delegationBuffer,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationPDAs.delegationRecord,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationPDAs.delegationMetadata,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });
}

/**
 * Build a PrivateTransfer instruction (executed inside the MagicBlock rollup).
 *
 * Moves lamports between two stealth PDAs. Source PDA must sign, which means
 * inside the rollup the burner keypair (which owns the stealth PDA via ACL)
 * is the actual signer.
 *
 * @param sourcePda      - Source stealth PDA (signer inside rollup)
 * @param destinationPda - Destination stealth PDA (typically the main PDA)
 * @param amount         - Amount in lamports (u64)
 */
export function createPrivateTransferInstruction(
  sourcePda: PublicKey,
  destinationPda: PublicKey,
  amount: bigint,
): TransactionInstruction {
  // Instruction data: [discriminator(1)] [amount(8)]
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(StealthInstruction.PrivateTransfer, 0);
  data.writeBigUInt64LE(amount, 1);

  return new TransactionInstruction({
    programId: SHREDR_PROGRAM_ID,
    keys: [
      { pubkey: sourcePda, isSigner: true, isWritable: true },
      { pubkey: destinationPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Build a CommitStealth instruction.
 *
 * Flushes rollup state to the base layer while keeping the account delegated.
 */
export function createCommitStealthInstruction(
  relayer: PublicKey,
  stealthAccount: PublicKey,
  magicProgram: PublicKey = MAGIC_BLOCK_PROGRAM_ID,
  magicContext: PublicKey = MAGIC_CONTEXT,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(StealthInstruction.CommitStealth, 0);

  return new TransactionInstruction({
    programId: SHREDR_PROGRAM_ID,
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: stealthAccount, isSigner: false, isWritable: true },
      { pubkey: magicProgram, isSigner: false, isWritable: false },
      { pubkey: magicContext, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Build a CommitAndUndelegateStealth instruction.
 *
 * Flushes state AND releases the account back to the base layer.
 */
export function createCommitAndUndelegateStealthInstruction(
  relayer: PublicKey,
  stealthAccount: PublicKey,
  magicProgram: PublicKey = MAGIC_BLOCK_PROGRAM_ID,
  magicContext: PublicKey = MAGIC_CONTEXT,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(StealthInstruction.CommitAndUndelegateStealth, 0);

  return new TransactionInstruction({
    programId: SHREDR_PROGRAM_ID,
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: stealthAccount, isSigner: false, isWritable: true },
      { pubkey: magicProgram, isSigner: false, isWritable: false },
      { pubkey: magicContext, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Build a Withdraw instruction.
 *
 * After undelegation, the main burner can withdraw from the main PDA to
 * any destination address. Signed by the main burner keypair.
 *
 * @param mainBurner  - The main burner pubkey (signer, must match PDA owner)
 * @param mainPda     - The main stealth PDA holding funds
 * @param destination - Any destination address to receive funds
 * @param amount      - Amount in lamports (u64)
 */
export function createStealthWithdrawInstruction(
  mainBurner: PublicKey,
  mainPda: PublicKey,
  destination: PublicKey,
  amount: bigint,
): TransactionInstruction {
  // Instruction data: [discriminator(1)] [amount(8)]
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(StealthInstruction.Withdraw, 0);
  data.writeBigUInt64LE(amount, 1);

  return new TransactionInstruction({
    programId: SHREDR_PROGRAM_ID,
    keys: [
      { pubkey: mainBurner, isSigner: true, isWritable: true },
      { pubkey: mainPda, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ============ ACCOUNT DATA PARSING ============

/** StealthAccount discriminator bytes (must match on-chain) */
const STEALTH_ACCOUNT_DISCRIMINATOR = Buffer.from([
  0x53, 0x48, 0x52, 0x45, 0x44, 0x52, 0x53, 0x41,
]); // "SHREDRSA"

/** Parsed stealth account data */
export interface StealthAccountData {
  owner: PublicKey;
  salt: Uint8Array;
  depositedAmount: bigint;
  depositTimestamp: bigint;
  delegated: boolean;
  bump: number;
}

/**
 * Parse a stealth account's on-chain data.
 *
 * @param data - Raw account data bytes
 * @returns Parsed StealthAccountData or null if invalid
 */
export function parseStealthAccount(
  data: Buffer,
): StealthAccountData | null {
  // Minimum size: 8 (discriminator) + 32 (owner) + 32 (salt) + 8 (amount) + 8 (timestamp) + 1 (delegated) + 1 (bump)
  const MIN_SIZE = 8 + 32 + 32 + 8 + 8 + 1 + 1;
  if (data.length < MIN_SIZE) return null;

  // Verify discriminator
  if (!data.subarray(0, 8).equals(STEALTH_ACCOUNT_DISCRIMINATOR)) return null;

  let offset = 8;

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const salt = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const depositedAmount = data.readBigUInt64LE(offset);
  offset += 8;

  const depositTimestamp = data.readBigInt64LE(offset);
  offset += 8;

  const delegated = data[offset] !== 0;
  offset += 1;

  const bump = data[offset];

  return {
    owner,
    salt,
    depositedAmount,
    depositTimestamp,
    delegated,
    bump,
  };
}
