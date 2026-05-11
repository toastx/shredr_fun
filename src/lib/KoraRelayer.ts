/**
 * KoraRelayer - JSON-RPC client for the Kora Solana paymaster/relayer.
 *
 * Kora is a remote signer that:
 *   - signs transactions as the fee payer
 *   - (for SHREDR) also acts as the on-chain `relayer` account in
 *     `InitializeAndDelegate` and `CommitAndUndelegate`/`CommitStealth`
 *     instructions
 *
 * The client is intentionally thin: the frontend pre-signs as the burner /
 * mainBurner where required, sends the partially-signed transaction to Kora,
 * and Kora returns a final signature (or signs+sends in a single call).
 *
 * The exact wire format depends on the Kora deployment. This implementation
 * supports the most common shape:
 *
 *    POST {KORA_RELAYER_URL}
 *    Content-Type: application/json
 *    {
 *      "jsonrpc": "2.0",
 *      "id": 1,
 *      "method": "signAndSendTransaction",
 *      "params": { "transaction": "<base64-encoded VersionedTransaction>" }
 *    }
 *    --> { result: { signature: "<base58>" } }
 *
 * For Kora deployments using REST endpoints, swap out `signAndSendTransaction`
 * for the appropriate path.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  type TransactionInstruction,
  type Signer,
} from "@solana/web3.js";
import { KORA_RELAYER_URL, KORA_RELAYER_PUBKEY } from "./constants";

// ============ TYPES ============

export interface KoraSignResult {
  signature: string;
}

export interface KoraConfigInfo {
  /** Public key of the Kora relayer (used as fee payer + on-chain relayer). */
  relayerPubkey: PublicKey;
}

// ============ CLIENT ============

export class KoraRelayer {
  private endpoint: string;
  private cachedRelayerPubkey: PublicKey | null = null;

  constructor(endpoint: string = KORA_RELAYER_URL) {
    this.endpoint = endpoint;
  }

  /** Get the relayer pubkey (used as fee payer + program-level relayer). */
  getRelayerPubkey(): PublicKey {
    if (this.cachedRelayerPubkey) return this.cachedRelayerPubkey;
    this.cachedRelayerPubkey = new PublicKey(KORA_RELAYER_PUBKEY);
    return this.cachedRelayerPubkey;
  }

  /**
   * Optional: fetch live relayer pubkey from Kora (`getConfig`-style RPC).
   * Falls back to the static constant on error.
   */
  async fetchRelayerPubkey(): Promise<PublicKey> {
    try {
      const res = await this.rpc<{ pubkey?: string; relayerPubkey?: string }>(
        "getConfig",
        {},
      );
      const key = res.pubkey ?? res.relayerPubkey;
      if (key) {
        this.cachedRelayerPubkey = new PublicKey(key);
        return this.cachedRelayerPubkey;
      }
    } catch (err) {
      console.warn("[KoraRelayer] getConfig failed, using static pubkey:", err);
    }
    return this.getRelayerPubkey();
  }

  /**
   * Build a VersionedTransaction with Kora as fee payer, pre-sign with the
   * given client-side signers (burner / mainBurner), serialize, and send to
   * Kora for fee-payer signing + broadcast.
   *
   * @param connection RPC connection used only for fetching a recent blockhash
   * @param instructions Transaction instructions
   * @param clientSigners Keypairs available client-side (burner, mainBurner)
   * @returns The signature string (base58)
   */
  async signAndSend(
    connection: Connection,
    instructions: TransactionInstruction[],
    clientSigners: Signer[],
  ): Promise<string> {
    const relayer = this.getRelayerPubkey();
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const message = new TransactionMessage({
      payerKey: relayer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);

    if (clientSigners.length > 0) {
      tx.sign(clientSigners);
    }

    const serialized = tx.serialize();
    const b64 = uint8ArrayToBase64(serialized);

    const res = await this.rpc<KoraSignResult>("signAndSendTransaction", {
      transaction: b64,
    });
    return res.signature;
  }

  /**
   * Variant for legacy (non-versioned) transactions. Some pinocchio programs
   * are easier to debug with legacy txs while developing.
   */
  async signAndSendLegacy(
    connection: Connection,
    instructions: TransactionInstruction[],
    clientSigners: Signer[],
  ): Promise<string> {
    const relayer = this.getRelayerPubkey();
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: relayer,
      blockhash,
      lastValidBlockHeight: 0,
    }).add(...instructions);

    // Partial-sign with client signers (Kora signs as fee payer)
    if (clientSigners.length > 0) {
      tx.partialSign(...clientSigners);
    }

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const b64 = uint8ArrayToBase64(new Uint8Array(serialized));

    const res = await this.rpc<KoraSignResult>("signAndSendTransaction", {
      transaction: b64,
    });
    return res.signature;
  }

  /** Generic JSON-RPC POST helper. */
  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    };

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kora ${method} failed: ${res.status} ${text}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(
        `Kora ${method} error: ${json.error.message ?? JSON.stringify(json.error)}`,
      );
    }
    return json.result as T;
  }
}

// ============ Inline base64 helper (avoid circular import on utils) ============
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ============ SINGLETON ============

export const koraRelayer = new KoraRelayer();
