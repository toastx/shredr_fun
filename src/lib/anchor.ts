/**
 * Where a receipt commitment lives on-chain.
 *
 * This is a seam, not an abstraction for its own sake. `AuditService` computes
 * commitments and never learns they are stored in an account; everything that
 * knows about PDAs and account layouts is here. A shielded pool replaces
 * per-payment PDAs with note commitments in a Merkle tree, at which point this
 * file is rewritten and nothing else moves.
 *
 * The commitment is written in two places, which costs nothing because it is the
 * same 32 bytes:
 *
 *   fast     the `receiptCommitment` field on the stealth PDA — one
 *            `getAccountInfo`, valid while the account is open
 *   durable  the `InitializeAndDelegate` instruction data — permanent in ledger
 *            history, survives `CloseStealthAccount` reclaiming the rent
 *
 * They cannot disagree: the program copies one into the other.
 */

import type { Connection, PublicKey } from "@solana/web3.js";

import { COMMITMENT_BYTES } from "./constants";
import { SHREDR_PROGRAM_ID, StealthInstruction, parseStealthAccount } from "./ShredrProgram";

/**
 * Read a commitment from the live account.
 *
 * Returns null once the account is closed — `CloseStealthAccount` resizes it to
 * zero and hands it back to the system program, so the field is gone. Fall back
 * to `readAnchorFromLedger`.
 *
 * `parseStealthAccount` checks the discriminator, which is what stops an
 * attacker parking look-alike bytes at a derivable address.
 */
export async function readAnchor(
    connection: Connection,
    stealthPda: PublicKey,
): Promise<Uint8Array | null> {
    const info = await connection.getAccountInfo(stealthPda);
    if (!info || !info.owner.equals(SHREDR_PROGRAM_ID)) return null;

    return parseStealthAccount(new Uint8Array(info.data))?.receiptCommitment ?? null;
}

/**
 * Recover a commitment from the transaction that wrote it.
 *
 * The durable path. Needs an RPC that serves history for the slot in question;
 * Helius does. Scans the account's signatures oldest-first for the
 * `InitializeAndDelegate` that created it, and reads the 32-byte tail of its
 * instruction data.
 */
export async function readAnchorFromLedger(
    connection: Connection,
    stealthPda: PublicKey,
): Promise<Uint8Array | null> {
    const signatures = await connection.getSignaturesForAddress(stealthPda, { limit: 50 });
    // Oldest first: initialization is the account's first transaction.
    for (const { signature } of signatures.reverse()) {
        const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
        });
        if (!tx) continue;

        const keys = tx.transaction.message.staticAccountKeys;
        for (const ix of tx.transaction.message.compiledInstructions) {
            if (!keys[ix.programIdIndex]?.equals(SHREDR_PROGRAM_ID)) continue;

            const data = ix.data;
            if (data.length !== 1 + 8 + 1 + COMMITMENT_BYTES) continue;
            if (data[0] !== StealthInstruction.InitializeAndDelegate) continue;

            return new Uint8Array(data.subarray(data.length - COMMITMENT_BYTES));
        }
    }
    return null;
}

/**
 * Read a commitment, account first and ledger second.
 *
 * The order matters for cost, not correctness: the account read is one call, the
 * ledger walk is many.
 */
export async function resolveAnchor(
    connection: Connection,
    stealthPda: PublicKey,
): Promise<Uint8Array | null> {
    return (
        (await readAnchor(connection, stealthPda)) ??
        (await readAnchorFromLedger(connection, stealthPda))
    );
}
