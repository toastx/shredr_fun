/**
 * KytService — deposit-side compliance screening.
 *
 * A deposit only enters the pool if the compliance relayer has screened the
 * depositing wallet and signed an attestation saying so. This is the client half
 * of that: ask, then turn the answer into the `Ed25519SigVerify` instruction the
 * program looks for.
 *
 * The instruction goes *first* in the transaction, ahead of
 * `InitializeAndDelegate`. Position is not what the program checks — it scans by
 * program id — but the runtime executes precompiles before programs either way,
 * and putting it first keeps the transaction readable.
 *
 * ## What this can and cannot promise
 *
 * A refusal here is not a security boundary. The gate is
 * `verify_deposit_attestation` on-chain, and a client that skipped this file
 * entirely would simply build a transaction the program rejects. What this does
 * buy is the difference between finding out before you broadcast and finding out
 * after: a refused screening costs nothing, an unattested deposit costs a
 * failed transaction and leaves a burner funded with nothing pointing at it.
 *
 * @see docs/concepts/kyt-gating.md
 */

import {
  Ed25519Program,
  PublicKey,
  type Connection,
  type ParsedInstruction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { KYT_API_URL } from "./constants";

// ============ WIRE FORMAT ============

/** Message length the program accepts. Anything else is a relayer bug. */
export const ATTESTATION_BYTES = 90;
const SIGNATURE_BYTES = 64;

/** `verdict` values in the signed message. */
export const KYT_VERDICT = {
  refuse: 0,
  allow: 1,
} as const;

/**
 * What `POST /api/kyt/screen` returns.
 *
 * A refusal is signed too, and comes back 200. The relayer having *screened and
 * said no* is a different fact from the relayer being unreachable, and the
 * client needs to tell them apart — one is final, the other is worth retrying.
 */
export interface KytAttestation {
  /** See {@link KYT_VERDICT}. */
  verdict: number;
  /** Base58 pubkey that signed `message`. */
  authority: string;
  /** Base64, 90 bytes. */
  message: string;
  /** Base64, 64 bytes. */
  signature: string;
  /** Unix seconds; the deposit must land before this. */
  expiresAt: number;
  /** Funders the relayer resolved from chain, most-funding first.
   *  `funders[0]` is the address bound into `message`. */
  funders: string[];
  /** Human-readable, present on a refusal. Never shown to the depositor's
   *  counterparty — it is the relayer's reasoning, not theirs. */
  reason?: string;
}

/** Thrown when the relayer screened the depositor and refused it. Final. */
export class KytRefusedError extends Error {
  constructor(
    readonly attestation: KytAttestation,
    readonly depositor: string,
  ) {
    super(attestation.reason ?? "Deposit refused by compliance screening");
    this.name = "KytRefusedError";
  }
}

/** Thrown when the relayer could not be reached or answered nonsense. */
export class KytUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "KytUnavailableError";
  }
}

// ============ SERVICE ============

export class KytService {
  constructor(private readonly baseUrl: string = KYT_API_URL) {}

  /**
   * Screen whoever funded `burner` for a deposit of up to `maxAmount` lamports
   * into its stealth PDA.
   *
   * The request carries the burner and nothing else. Who funded it is the
   * relayer's to work out, from the chain — this client is the party asking to
   * be screened, so anything it asserted about its own funding would be worth
   * exactly nothing. The resolved funders come back on
   * {@link KytAttestation.funders}, most-funding first, and every one of them is
   * screened: any single refusal refuses the deposit.
   *
   * `burner` and `maxAmount` are part of the signed message, not just the
   * request: an attestation that said only "this wallet is clean" would be a
   * bearer token good for every deposit that wallet ever makes.
   *
   * Returns the attestation whatever the verdict — including a refusal. Use
   * {@link attest} if you want a refusal to throw.
   */
  async screen(burner: PublicKey, maxAmount: bigint): Promise<KytAttestation> {

    if (!this.baseUrl) {
      throw new KytUnavailableError(
        "KYT screening endpoint is not configured (VITE_KYT_API_URL)",
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/kyt/screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          burner: burner.toBase58(),
          maxAmount: maxAmount.toString(),
        }),
      });
    } catch (err) {
      throw new KytUnavailableError("KYT screening request failed", err);
    }

    if (!response.ok) {
      throw new KytUnavailableError(
        `KYT screening failed: ${response.status} ${response.statusText}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new KytUnavailableError("KYT screening returned invalid JSON", err);
    }

    return assertAttestation(body);
  }

  /**
   * Screen, and return the instruction to prepend. Throws {@link KytRefusedError}
   * on a refusal, so the caller cannot accidentally build a transaction that the
   * program will reject anyway.
   */
  async attest(
    burner: PublicKey,
    maxAmount: bigint,
    connection?: Connection,
  ): Promise<TransactionInstruction> {
    const attestation = await this.screen(burner, maxAmount);

    if (attestation.verdict !== KYT_VERDICT.allow) {
      throw new KytRefusedError(
        attestation,
        attestation.funders[0] ?? burner.toBase58(),
      );
    }

    // Diagnostic only, and deliberately after the verdict: see
    // {@link fundersAgree} for why this cannot be a gate.
    if (connection) {
      await fundersAgree(connection, burner, attestation.funders);
    }

    return toInstruction(attestation);
  }
}

/**
 * Compare the relayer's funder list against a local read of the same chain.
 *
 * ## What this is not
 *
 * It is not a tamper check. An attacker who can modify this client can also
 * delete this call, so a disagreement it reports is only ever a disagreement an
 * honest client volunteered. Nothing here defends the deposit.
 *
 * What defends the deposit is that the relayer resolved these funders itself and
 * signed over the result: `funders[0]` is inside the attested message, so a
 * modified client cannot change which address was screened — only whether it
 * hears about the mismatch.
 *
 * ## What it is for
 *
 * Desync. The two sides read different RPC nodes at different moments, so a
 * disagreement usually means one of them has not seen the funding transfer yet —
 * worth surfacing, not worth failing on. Hard-failing would trade a real class of
 * flaky deposits for no security at all, so this warns and returns.
 */
export async function fundersAgree(
  connection: Connection,
  burner: PublicKey,
  relayerFunders: string[],
): Promise<boolean> {
  let local: PublicKey[];
  try {
    local = await resolveBurnerFunders(connection, burner);
  } catch {
    // Our own read failing says nothing about the relayer's, which stands on its
    // own signature either way.
    return true;
  }

  const ours = new Set(local.map((funder) => funder.toBase58()));
  const theirs = new Set(relayerFunders);
  const agree =
    ours.size === theirs.size && [...ours].every((funder) => theirs.has(funder));

  if (!agree) {
    console.warn(
      "[KytService] relayer and client disagree about who funded this burner. " +
        "The relayer's list is the one that was screened and signed. " +
        `relayer=[${[...theirs].join(", ")}] client=[${[...ours].join(", ")}]`,
    );
  }

  return agree;
}

/**
 * Resolve the addresses that funded `burner`, most-funding first.
 *
 * The address worth screening is the source of the funds, not whoever is driving
 * the UI. A burner is a one-time address someone sends SOL to, and that sender
 * is the only party whose provenance means anything — the connected wallet may
 * not have paid for a single lamport of it.
 *
 * Reads System-program transfers into `burner`, including ones made by CPI, and
 * sums per source so the caller can bind the largest. Anything it cannot
 * attribute is left out rather than guessed at, and a burner with no attributable
 * funder throws rather than falling back to a wallet that merely happens to be
 * connected: screening the wrong address is worse than admitting we cannot.
 *
 * Throws {@link KytUnavailableError}, never a refusal — being unable to work out
 * who paid is a transient state, and the funding transfer simply may not have
 * confirmed yet.
 */
export async function resolveBurnerFunders(
  connection: Connection,
  burner: PublicKey,
  limit = 20,
): Promise<PublicKey[]> {
  const address = burner.toBase58();

  let signatures;
  try {
    signatures = await connection.getSignaturesForAddress(burner, { limit });
  } catch (err) {
    throw new KytUnavailableError("Could not read the burner's history", err);
  }

  if (signatures.length === 0) {
    throw new KytUnavailableError(
      "Burner has no on-chain history — its funding transfer may not have confirmed yet",
    );
  }

  // Summed rather than collected, so a source that paid across several transfers
  // is one funder with a total and not several small ones.
  const contributed = new Map<string, bigint>();

  for (const { signature } of signatures) {
    let transaction;
    try {
      transaction = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      throw new KytUnavailableError(
        "Could not read a transaction that funded the burner",
        err,
      );
    }

    // A failed transaction moved nothing, so it says nothing about provenance.
    if (!transaction || transaction.meta?.err) continue;

    const instructions = [
      ...transaction.transaction.message.instructions,
      ...(transaction.meta?.innerInstructions?.flatMap((entry) => entry.instructions) ?? []),
    ];

    for (const instruction of instructions) {
      const parsed = (instruction as ParsedInstruction).parsed;
      if (parsed?.type !== "transfer" && parsed?.type !== "transferWithSeed") {
        continue;
      }

      const info = parsed.info as {
        source?: string;
        destination?: string;
        lamports?: number;
      };
      // Self-transfers are not funding, and neither is anything aimed elsewhere.
      if (info.destination !== address || !info.source || info.source === address) {
        continue;
      }

      contributed.set(
        info.source,
        (contributed.get(info.source) ?? 0n) + BigInt(info.lamports ?? 0),
      );
    }
  }

  if (contributed.size === 0) {
    throw new KytUnavailableError(
      "Could not identify who funded the burner from its transaction history",
    );
  }

  return [...contributed.entries()]
    .sort(([, a], [, b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([source]) => new PublicKey(source));
}

/**
 * Build the `Ed25519SigVerify` instruction covering an attestation.
 *
 * `createInstructionWithPublicKey` defaults all three instruction indices to
 * `u16::MAX` — "read from my own data" — which is exactly what the program
 * requires. An instruction built any other way verifies a signature over bytes
 * the program cannot see, and is rejected.
 */
export function toInstruction(
  attestation: KytAttestation,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: new PublicKey(attestation.authority).toBytes(),
    message: decodeBase64(attestation.message, ATTESTATION_BYTES, "message"),
    signature: decodeBase64(attestation.signature, SIGNATURE_BYTES, "signature"),
  });
}

/**
 * Reject a malformed response here rather than at the precompile.
 *
 * The relayer is a trust boundary: it is a separate service, and a deploy that
 * changes its wire format should surface as "the relayer is wrong" and not as an
 * opaque transaction failure three calls later.
 */
function assertAttestation(body: unknown): KytAttestation {
  const value = body as Partial<KytAttestation>;

  if (
    typeof value?.verdict !== "number" ||
    typeof value.authority !== "string" ||
    typeof value.message !== "string" ||
    typeof value.signature !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Array.isArray(value.funders) ||
    !value.funders.every((funder) => typeof funder === "string")
  ) {
    throw new KytUnavailableError(
      "KYT screening returned an unrecognised attestation",
    );
  }

  try {
    new PublicKey(value.authority);
  } catch (err) {
    throw new KytUnavailableError("KYT attestation authority is not a pubkey", err);
  }

  // Lengths are checked eagerly so that a refusal and a corrupt allow are
  // distinguishable: only the second one is a bug worth paging someone about.
  decodeBase64(value.message, ATTESTATION_BYTES, "message");
  decodeBase64(value.signature, SIGNATURE_BYTES, "signature");

  return value as KytAttestation;
}

function decodeBase64(
  encoded: string,
  expectedBytes: number,
  label: string,
): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (bytes.length !== expectedBytes) {
    throw new KytUnavailableError(
      `KYT attestation ${label} must be ${expectedBytes} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

export const kytService = new KytService();
