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
 *   4 - Withdraw (stealth): Withdraw from stealth PDA after undelegation
 *   5 - UndelegationCallback: Called by delegation program (not user-invoked)
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  Connection,
  Transaction,
  Keypair,
  sendAndConfirmTransaction,
  type Signer,
} from "@solana/web3.js";

// ============ PROGRAM CONSTANTS ============

/** The on-chain program address */
export const SHREDR_PROGRAM_ID = new PublicKey(
  "H64YCQTWdQkx9vjs1ZB2Uo24FyUBibnDxhKdznamybpZ"
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
export const MAGIC_BLOCK_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSS"
);

/** MagicBlock Delegation Metadata seed */
const DELEGATION_METADATA_SEED = Buffer.from("delegation_metadata");
const DELEGATION_RECORD_SEED = Buffer.from("delegation_record");

// ============ PDA DERIVATION ============

/**
 * Derive a stealth account PDA from burner pubkey and salt.
 * Seeds: [STEALTH_ADDRESS, burner_pubkey, salt]
 */
export function deriveStealthPDA(
  burnerPubkey: PublicKey,
  salt: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_ADDRESS, burnerPubkey.toBuffer(), Buffer.from(salt)],
    SHREDR_PROGRAM_ID
  );
}

/**
 * Derive MagicBlock delegation-related PDAs.
 */
export function deriveDelegationPDAs(stealthPda: PublicKey) {
  const [permissionAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("permission"), stealthPda.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID
  );

  const [delegationBuffer] = PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), stealthPda.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID
  );

  const [delegationRecord] = PublicKey.findProgramAddressSync(
    [DELEGATION_RECORD_SEED, stealthPda.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID
  );

  const [delegationMetadata] = PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_SEED, stealthPda.toBuffer()],
    MAGIC_BLOCK_PROGRAM_ID
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
 * @param relayer      - Relayer paying for the transaction (signer)
 * @param burner       - One-time burner keypair derived from mainKey+nonce (signer)
 * @param salt         - 32-byte random salt for PDA derivation
 * @param burnerPubkey - Burner's public key as 32-byte array
 * @param commitDelay  - Commit delay in seconds (i64)
 */
export function createInitializeAndDelegateInstruction(
  relayer: PublicKey,
  burner: PublicKey,
  salt: Uint8Array,
  burnerPubkey: Uint8Array,
  commitDelay: bigint
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
 * Build a PrivateTransfer instruction.
 *
 * Moves lamports between two stealth PDAs inside the MagicBlock rollup.
 *
 * @param sourcePda      - Source stealth PDA (must sign)
 * @param destinationPda - Destination stealth PDA
 * @param amount         - Amount in lamports (u64)
 */
export function createPrivateTransferInstruction(
  sourcePda: PublicKey,
  destinationPda: PublicKey,
  amount: bigint
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
 *
 * @param relayer        - Relayer paying for the transaction
 * @param stealthAccount - The stealth PDA to commit
 * @param magicProgram   - MagicBlock program address
 * @param magicContext   - MagicBlock context account
 */
export function createCommitStealthInstruction(
  relayer: PublicKey,
  stealthAccount: PublicKey,
  magicProgram: PublicKey,
  magicContext: PublicKey
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
 *
 * @param relayer        - Relayer paying for the transaction
 * @param stealthAccount - The stealth PDA to commit and undelegate
 * @param magicProgram   - MagicBlock program address
 * @param magicContext   - MagicBlock context account
 */
export function createCommitAndUndelegateStealthInstruction(
  relayer: PublicKey,
  stealthAccount: PublicKey,
  magicProgram: PublicKey,
  magicContext: PublicKey
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
 * Build a Withdraw instruction (stealth PDA withdrawal).
 *
 * After undelegation, the owner (burner) can withdraw lamports to any destination.
 *
 * @param mainBurner  - The burner keypair proving ownership (signer)
 * @param mainPda     - The stealth PDA holding funds
 * @param destination - Any destination address to receive funds
 * @param amount      - Amount in lamports (u64)
 */
export function createStealthWithdrawInstruction(
  mainBurner: PublicKey,
  mainPda: PublicKey,
  destination: PublicKey,
  amount: bigint
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
  data: Buffer
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

// ============ HIGH-LEVEL HELPERS ============

/**
 * Get balance of a stealth PDA (raw lamports on the account).
 */
export async function getStealthBalance(
  connection: Connection,
  burnerPubkey: PublicKey,
  salt: Uint8Array
): Promise<{ lamports: number; pda: PublicKey }> {
  const [pda] = deriveStealthPDA(burnerPubkey, salt);
  const accountInfo = await connection.getAccountInfo(pda);
  return {
    lamports: accountInfo?.lamports ?? 0,
    pda,
  };
}

/**
 * Send a transaction with one or more instructions, signing with the provided signers.
 */
export async function sendShredrTransaction(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Signer[],
  opts?: { skipPreflight?: boolean }
): Promise<string> {
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, signers, {
    skipPreflight: opts?.skipPreflight ?? false,
    commitment: "confirmed",
  });
}

/**
 * Withdraw from a stealth PDA to a destination address.
 *
 * Convenience function that builds the instruction and sends the transaction.
 *
 * @param connection  - Solana RPC connection
 * @param burner      - The burner Keypair (signer, must match PDA owner)
 * @param salt        - 32-byte salt used in PDA derivation
 * @param destination - Destination pubkey for the withdrawal
 * @param amount      - Amount in lamports
 */
export async function withdrawFromStealth(
  connection: Connection,
  burner: Keypair,
  salt: Uint8Array,
  destination: PublicKey,
  amount: bigint
): Promise<string> {
  const [stealthPda] = deriveStealthPDA(burner.publicKey, salt);

  const ix = createStealthWithdrawInstruction(
    burner.publicKey,
    stealthPda,
    destination,
    amount
  );

  return sendShredrTransaction(connection, [ix], [burner]);
}
