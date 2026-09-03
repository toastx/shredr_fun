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
   * Screen `depositor` for a deposit of up to `maxAmount` lamports into
   * `burner`'s stealth PDA.
   *
   * `burner` and `maxAmount` are part of the signed message, not just the
   * request: an attestation that said only "this wallet is clean" would be a
   * bearer token good for every deposit that wallet ever makes.
   *
   * Returns the attestation whatever the verdict — including a refusal. Use
   * {@link attest} if you want a refusal to throw.
   */
  async screen(
    depositor: PublicKey,
    burner: PublicKey,
    maxAmount: bigint,
  ): Promise<KytAttestation> {
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
          depositor: depositor.toBase58(),
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
    depositor: PublicKey,
    burner: PublicKey,
    maxAmount: bigint,
  ): Promise<TransactionInstruction> {
    const attestation = await this.screen(depositor, burner, maxAmount);

    if (attestation.verdict !== KYT_VERDICT.allow) {
      throw new KytRefusedError(attestation, depositor.toBase58());
    }

    return toInstruction(attestation);
  }
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
    typeof value.expiresAt !== "number"
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
