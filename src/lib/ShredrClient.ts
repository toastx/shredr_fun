/**
 * ShredrClient — Privacy wallet orchestrator (program-aware version)
 *
 * Coordinates:
 *   - Wallet signature → master seed (NonceService + BurnerService)
 *   - Per-receive **stealth burner** + **stealth PDA** (one-time receive address)
 *   - Persistent **main burner** + **main PDA** (consolidation account)
 *   - On-chain SHREDR program instructions (via {@link ShredrProgram})
 *   - Fee-payer / relayer signing (via {@link KoraRelayer})
 *   - MagicBlock ephemeral rollup RPC (for PrivateTransfer)
 *
 * The user's connected wallet (mainKeypair) signs ONCE to derive everything;
 * after that, all on-chain activity is signed by derived burner keypairs and
 * the Kora relayer — preserving privacy.
 */

import { nonceService } from "./NonceService";
import { burnerService } from "./BurnerService";
import { apiClient } from "./ApiClient";
import { koraRelayer } from "./KoraRelayer";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  HELIUS_RPC_URL,
  MAGICBLOCK_RPC_URL,
  SHREDR_FIXED_SALT,
  COMMIT_DELAY_MIN_SECS,
  COMMIT_DELAY_MAX_SECS,
  MAX_UTXO_SCAN_INDEX,
  UTXO_SCAN_EMPTY_THRESHOLD,
  DEFAULT_DENOMINATION_SOL,
  type NormalizedDenomination,
} from "./constants";
import {
  deriveStealthPDA,
  createInitializeAndDelegateInstruction,
  createPrivateTransferInstruction,
  createCommitAndUndelegateStealthInstruction,
  createStealthWithdrawInstruction,
  parseStealthAccount,
} from "./ShredrProgram";
import type { GeneratedNonce, BurnerKeyPair, CreateBlobRequest } from "./types";

// ============ TYPES ============

export type SigningMode = "auto" | "manual";

export type UtxoStatus =
  | "empty" // no balance, not yet used
  | "received" // funds received, awaiting init+delegate
  | "delegated" // initialized + delegated to rollup
  | "ready" // committed back, ready to withdraw
  | "spent"; // already withdrawn

export interface PendingUtxo {
  nonceIndex: number;
  burnerAddress: string;
  stealthPda: string;
  lamports: number;
  status: UtxoStatus;
}

export interface ShredrState {
  initialized: boolean;
  currentNonce: GeneratedNonce | null;
  currentBurner: BurnerKeyPair | null;
  stealthPda: string | null; // current PDA address to share with senders
  mainBurnerAddress: string | null;
  mainPda: string | null;
  signingMode: SigningMode;
  currentBlobId: string | null;
  preferredDenomination: NormalizedDenomination;
}

// ============ CLIENT ============

export class ShredrClient {
  private _initialized = false;
  private _currentNonce: GeneratedNonce | null = null;
  private _currentBurner: BurnerKeyPair | null = null;
  private _walletPubkey: Uint8Array | null = null;
  private _signingMode: SigningMode = "auto";
  private _currentBlobId: string | null = null;
  private _isNewUser = false;
  private _connection: Connection | null = null;
  private _rollupConnection: Connection | null = null;

  // Main burner (persistent, controls main PDA)
  private _mainBurner: BurnerKeyPair | null = null;
  private _mainPda: PublicKey | null = null;

  // Current stealth PDA (derived from currentBurner + fixed salt)
  private _stealthPda: PublicKey | null = null;

  // User-configurable
  private _preferredDenomination: NormalizedDenomination =
    DEFAULT_DENOMINATION_SOL;

  // ============ GETTERS ============

  get initialized(): boolean {
    return this._initialized;
  }
  get currentBurner(): BurnerKeyPair | null {
    return this._currentBurner;
  }
  get currentBurnerAddress(): string | null {
    return this._currentBurner?.address ?? null;
  }

  /** Stealth PDA derived from the *current* burner — share this with senders. */
  get stealthAddress(): string | null {
    return this._stealthPda?.toBase58() ?? null;
  }
  /** @deprecated use stealthAddress */
  get shadowireAddress(): string | null {
    return this.stealthAddress;
  }

  /** Persistent main burner pubkey (controls the main PDA). */
  get mainBurnerAddress(): string | null {
    return this._mainBurner?.address ?? null;
  }

  /** Persistent main PDA — where funds consolidate after the rollup commit. */
  get mainPdaAddress(): string | null {
    return this._mainPda?.toBase58() ?? null;
  }

  /** @deprecated kept for old UI compat */
  get stealthBurner(): BurnerKeyPair | null {
    return this._mainBurner;
  }
  /** @deprecated kept for old UI compat */
  get shadowireBurner(): BurnerKeyPair | null {
    return this._mainBurner;
  }

  get signingMode(): SigningMode {
    return this._signingMode;
  }
  get isNewUser(): boolean {
    return this._isNewUser;
  }
  get preferredDenomination(): NormalizedDenomination {
    return this._preferredDenomination;
  }
  setPreferredDenomination(d: NormalizedDenomination): void {
    this._preferredDenomination = d;
  }

  get state(): ShredrState {
    return {
      initialized: this._initialized,
      currentNonce: this._currentNonce,
      currentBurner: this._currentBurner,
      stealthPda: this._stealthPda?.toBase58() ?? null,
      mainBurnerAddress: this._mainBurner?.address ?? null,
      mainPda: this._mainPda?.toBase58() ?? null,
      signingMode: this._signingMode,
      currentBlobId: this._currentBlobId,
      preferredDenomination: this._preferredDenomination,
    };
  }

  // ============ CONNECTIONS ============

  /** Base-layer Solana RPC. */
  private getConnection(rpcUrl?: string): Connection {
    if (rpcUrl) return new Connection(rpcUrl, "confirmed");
    if (!this._connection) {
      this._connection = new Connection(HELIUS_RPC_URL, "confirmed");
    }
    return this._connection;
  }

  /** MagicBlock ephemeral-rollup RPC (for PrivateTransfer inside the rollup). */
  private getRollupConnection(): Connection {
    if (!this._rollupConnection) {
      this._rollupConnection = new Connection(MAGICBLOCK_RPC_URL, "confirmed");
    }
    return this._rollupConnection;
  }

  /** Build a Solana-web3 Keypair from a BurnerKeyPair. */
  private burnerToKeypair(burner: BurnerKeyPair): Keypair {
    return Keypair.fromSecretKey(burner.secretKey);
  }

  /** Recompute and cache the stealth PDA from the current burner. */
  private refreshStealthPda(): void {
    if (!this._currentBurner) {
      this._stealthPda = null;
      return;
    }
    const burnerPub = new PublicKey(this._currentBurner.publicKey);
    const [pda] = deriveStealthPDA(burnerPub, SHREDR_FIXED_SALT);
    this._stealthPda = pda;
  }

  // ============ USER STATUS CHECK ============

  async checkIfNewUser(
    signature: Uint8Array,
    walletPubkey: Uint8Array,
    fetchBlobsFn: () => Promise<
      Array<{ id: string; encryptedBlob: string; createdAt: number }>
    > = () => apiClient.fetchAllBlobs(),
  ): Promise<boolean> {
    await nonceService.initFromSignature(signature);

    const nonce = await nonceService.loadCurrentNonce(walletPubkey);
    if (nonce) return false;

    if (fetchBlobsFn) {
      try {
        const blobs = await fetchBlobsFn();
        const result = await nonceService.tryDecryptBlobs(blobs);
        if (result.found && result.nonce) return false;
      } catch (err) {
        console.warn("[checkIfNewUser] fetchBlobs failed:", err);
      }
    }
    return true;
  }

  // ============ INITIALIZATION ============

  /**
   * Initialize the client from a single wallet signature.
   *
   * Flow:
   *  1. Init NonceService + BurnerService from signature
   *  2. Derive the persistent **main burner** + **main PDA** (controls consolidation)
   *  3. Load (local → remote) or generate the spending nonce chain
   *  4. Derive the **current stealth burner** + **current stealth PDA**
   */
  async initFromSignature(
    signature: Uint8Array,
    walletPubkey: Uint8Array,
    fetchBlobsFn: () => Promise<
      Array<{ id: string; encryptedBlob: string; createdAt: number }>
    > = () => apiClient.fetchAllBlobs(),
    createBlobFn: (data: CreateBlobRequest) => Promise<{ id: string }> = (d) =>
      apiClient.createBlob(d),
  ): Promise<void> {
    // 1. Init crypto services
    await nonceService.initFromSignature(signature);
    await burnerService.initFromSignature(signature);

    this._walletPubkey = walletPubkey;

    // 2. Derive persistent main burner + main PDA
    this._mainBurner = await burnerService.deriveMainBurner(signature);
    const mainBurnerPub = new PublicKey(this._mainBurner.publicKey);
    const [mainPda] = deriveStealthPDA(mainBurnerPub, SHREDR_FIXED_SALT);
    this._mainPda = mainPda;
    console.log(
      "[ShredrClient] mainBurner:",
      this._mainBurner.address,
      "mainPda:",
      this._mainPda.toBase58(),
    );

    // 3. Load / generate current spending nonce
    let nonce = await nonceService.loadCurrentNonce(walletPubkey);

    if (!nonce && fetchBlobsFn) {
      try {
        const blobs = await fetchBlobsFn();
        const result = await nonceService.tryDecryptBlobs(blobs);
        if (result.found && result.nonce) {
          await nonceService.setCurrentState(result.nonce);
          nonce = result.nonce;
          this._currentBlobId = result.blobId ?? null;
        }
      } catch (err) {
        console.warn("[initFromSignature] fetchBlobs failed:", err);
      }
    }

    if (!nonce) {
      // New user — generate base nonce, then move to index 1 (index 0 reserved)
      await nonceService.generateBaseNonce(walletPubkey);
      nonce = await nonceService.incrementNonce();
      this._isNewUser = true;

      if (createBlobFn) {
        try {
          const blobData = await nonceService.createBlobData(nonce);
          const newBlob = await createBlobFn(blobData);
          this._currentBlobId = newBlob.id;
        } catch (err) {
          console.warn("[initFromSignature] createBlob failed:", err);
        }
      }
    } else {
      this._isNewUser = false;
    }

    this._currentNonce = nonce;

    // 4. Derive current burner + stealth PDA
    this._currentBurner = await burnerService.deriveBurnerFromNonce(nonce);
    this.refreshStealthPda();

    this._initialized = true;
    console.log(
      "[ShredrClient] currentBurner:",
      this._currentBurner.address,
      "stealthPda:",
      this._stealthPda?.toBase58(),
    );
  }

  // ============ SIGNING MODE ============
  setSigningMode(mode: SigningMode): void {
    this._signingMode = mode;
  }

  // ============ BURNER ROTATION ============

  /**
   * Consume the current nonce and rotate to a fresh burner / stealth PDA.
   * Call this after a stealth PDA has been used (funds received) so the next
   * receive lands on a brand-new address.
   */
  async consumeAndGenerateNew(
    createBlobFn: (data: CreateBlobRequest) => Promise<{ id: string }> = (d) =>
      apiClient.createBlob(d),
    deleteBlobFn: (id: string) => Promise<boolean> = (id) =>
      apiClient.deleteBlob(id),
  ): Promise<BurnerKeyPair> {
    if (!this._initialized || !this._currentNonce) {
      throw new Error("ShredrClient not initialized");
    }

    if (this._currentBurner) {
      burnerService.clearBurner(this._currentBurner);
    }

    const { newNonce, newBlobData } = await nonceService.consumeNonce();
    const oldBlobId = this._currentBlobId;

    if (createBlobFn) {
      try {
        const newBlob = await createBlobFn(newBlobData);
        this._currentBlobId = newBlob.id;
      } catch (err) {
        console.warn("[consumeAndGenerateNew] createBlob failed:", err);
      }
    }
    if (deleteBlobFn && oldBlobId) {
      try {
        await deleteBlobFn(oldBlobId);
      } catch (err) {
        console.warn("[consumeAndGenerateNew] deleteBlob failed:", err);
      }
    }

    this._currentNonce = newNonce;
    this._currentBurner = await burnerService.deriveBurnerFromNonce(newNonce);
    this.refreshStealthPda();
    return this._currentBurner;
  }

  // ============ ON-CHAIN: INITIALIZE & DELEGATE ============

  /**
   * Step 2 of the SHREDR flow.
   *
   * After a sender deposits SOL into the stealth PDA via a regular SOL
   * transfer, the relayer calls `InitializeAndDelegate` to create the PDA
   * state and delegate it to the MagicBlock TEE validator.
   *
   * This is signed by:
   *   - **Kora** as relayer + fee payer (server-side)
   *   - The **burner keypair** (we have it client-side)
   *
   * @param burner   Burner keypair owning the stealth PDA (defaults to current)
   * @param salt     32-byte salt (defaults to {@link SHREDR_FIXED_SALT})
   * @returns Signature of the broadcast transaction
   */
  async initializeAndDelegate(
    burner?: BurnerKeyPair,
    salt: Uint8Array = SHREDR_FIXED_SALT,
  ): Promise<string> {
    const b = burner ?? this._currentBurner;
    if (!b) throw new Error("No burner available");

    const burnerKp = this.burnerToKeypair(b);
    const relayer = koraRelayer.getRelayerPubkey();

    // Random commit delay in [6h, 48h] for timing obfuscation
    const delaySpan = COMMIT_DELAY_MAX_SECS - COMMIT_DELAY_MIN_SECS;
    const commitDelay =
      COMMIT_DELAY_MIN_SECS + Math.floor(Math.random() * delaySpan);

    const ix = createInitializeAndDelegateInstruction(
      relayer,
      burnerKp.publicKey,
      salt,
      burnerKp.publicKey.toBytes(),
      BigInt(commitDelay),
    );

    return koraRelayer.signAndSend(this.getConnection(), [ix], [burnerKp]);
  }

  // ============ ON-CHAIN: PRIVATE TRANSFER (inside rollup) ============

  /**
   * Step 3 — execute the private transfer inside the MagicBlock rollup.
   * Moves the full balance from a stealth PDA to the main PDA.
   *
   * @param sourceBurner  Burner that owns the source stealth PDA
   * @param amountLamports Amount to transfer (typically the full PDA balance)
   * @param salt          Salt used when deriving the source PDA
   */
  async privateTransferToMainPda(
    sourceBurner: BurnerKeyPair,
    amountLamports: bigint,
    salt: Uint8Array = SHREDR_FIXED_SALT,
  ): Promise<string> {
    if (!this._mainPda) throw new Error("Main PDA not initialized");

    const burnerKp = this.burnerToKeypair(sourceBurner);
    const [sourcePda] = deriveStealthPDA(burnerKp.publicKey, salt);

    const ix = createPrivateTransferInstruction(
      sourcePda,
      this._mainPda,
      amountLamports,
    );

    // PrivateTransfer is dispatched against the rollup RPC.
    // The source burner is registered in the ACL during InitializeAndDelegate,
    // so it can sign on behalf of the source PDA inside the rollup.
    return koraRelayer.signAndSend(
      this.getRollupConnection(),
      [ix],
      [burnerKp],
    );
  }

  // ============ ON-CHAIN: COMMIT & UNDELEGATE ============

  /**
   * Step 4 — commit rollup state to base layer AND undelegate the stealth PDA.
   * Signed by Kora (relayer + fee payer).
   */
  async commitAndUndelegate(stealthPda: PublicKey): Promise<string> {
    const relayer = koraRelayer.getRelayerPubkey();
    const ix = createCommitAndUndelegateStealthInstruction(
      relayer,
      stealthPda,
    );

    // No client-side signers needed (Kora signs as relayer)
    return koraRelayer.signAndSend(this.getConnection(), [ix], []);
  }

  // ============ ON-CHAIN: WITHDRAW ============

  /**
   * Step 5 — withdraw lamports from the main PDA to any destination.
   * Signed by the main burner; fee paid by Kora.
   *
   * @param destinationAddress  Destination wallet (any base58 pubkey)
   * @param amountInSol         Amount in SOL or "all" for the full balance
   */
  async withdrawToWallet(
    destinationAddress: string,
    amountInSol: number | "all",
  ): Promise<{ signature: string; amount: number }> {
    if (!this._mainBurner || !this._mainPda) {
      throw new Error("Main burner / main PDA not initialized");
    }

    const connection = this.getConnection();
    const mainBurnerKp = this.burnerToKeypair(this._mainBurner);
    const destination = new PublicKey(destinationAddress);

    // Look up current balance of the main PDA
    const balanceLamports = await connection.getBalance(this._mainPda);

    let withdrawLamports: number;
    if (amountInSol === "all") {
      // Leave a small buffer for rent (program will reject < rent_exempt)
      withdrawLamports = balanceLamports;
    } else {
      withdrawLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
    }

    if (withdrawLamports <= 0) {
      throw new Error("Insufficient balance for withdrawal");
    }

    const ix = createStealthWithdrawInstruction(
      mainBurnerKp.publicKey,
      this._mainPda,
      destination,
      BigInt(withdrawLamports),
    );

    const signature = await koraRelayer.signAndSend(
      connection,
      [ix],
      [mainBurnerKp],
    );

    return {
      signature,
      amount: withdrawLamports / LAMPORTS_PER_SOL,
    };
  }

  // ============ BALANCE ============

  /**
   * Get the balance of the main PDA (where consolidated funds end up).
   *
   * The `address` returned is the **main PDA**, not the burner pubkey.
   */
  async getStealthBalance(): Promise<{
    available: number;
    availableLamports: number;
    address: string;
  }> {
    if (!this._mainPda) {
      throw new Error("Main PDA not initialized. Call initFromSignature first.");
    }

    const connection = this.getConnection();
    const lamports = await connection.getBalance(this._mainPda);

    return {
      available: lamports / LAMPORTS_PER_SOL,
      availableLamports: lamports,
      address: this._mainPda.toBase58(),
    };
  }

  /** @deprecated alias kept for the old UI */
  async getShadowireBalance() {
    const r = await this.getStealthBalance();
    return {
      available: r.available,
      availableLamports: r.availableLamports,
      poolAddress: r.address,
    };
  }

  // ============ UTXO SCANNING ============

  /**
   * Scan stealth PDAs across nonce indices and return the ones with non-zero
   * balance / pending state. Used by the dashboard to surface in-flight funds.
   *
   * Stops after {@link UTXO_SCAN_EMPTY_THRESHOLD} consecutive empty PDAs to
   * keep the scan cheap.
   */
  async scanPendingUtxos(): Promise<PendingUtxo[]> {
    if (!this._initialized || !this._walletPubkey) {
      throw new Error("ShredrClient not initialized");
    }

    const connection = this.getConnection();
    const utxos: PendingUtxo[] = [];
    let consecutiveEmpty = 0;

    for (let i = 1; i < MAX_UTXO_SCAN_INDEX; i++) {
      const nonce = await nonceService.generateNonceAtIndex(
        i,
        this._walletPubkey,
      );
      const burner = await burnerService.deriveBurnerFromNonce(nonce);
      const burnerPub = new PublicKey(burner.publicKey);
      const [pda] = deriveStealthPDA(burnerPub, SHREDR_FIXED_SALT);

      const accountInfo = await connection.getAccountInfo(pda);
      const lamports = accountInfo?.lamports ?? 0;

      let status: UtxoStatus = "empty";
      if (lamports > 0) {
        consecutiveEmpty = 0;
        // Try to parse the on-chain state to determine the lifecycle phase.
        if (accountInfo?.data && accountInfo.data.length > 0) {
          const state = parseStealthAccount(Buffer.from(accountInfo.data));
          if (state) {
            status = state.delegated ? "delegated" : "ready";
          } else {
            status = "received"; // raw lamports landed, not yet initialized
          }
        } else {
          status = "received";
        }
        utxos.push({
          nonceIndex: i,
          burnerAddress: burner.address,
          stealthPda: pda.toBase58(),
          lamports,
          status,
        });
      } else {
        consecutiveEmpty++;
        if (consecutiveEmpty >= UTXO_SCAN_EMPTY_THRESHOLD) break;
      }

      // Wipe the burner private key when we don't keep it
      burnerService.clearBurner(burner);
    }

    return utxos;
  }

  // ============ CLEANUP ============

  destroy(): void {
    if (this._currentBurner) {
      burnerService.clearBurner(this._currentBurner);
    }
    if (this._mainBurner) {
      burnerService.clearBurner(this._mainBurner);
    }

    nonceService.destroy();
    burnerService.destroy();
    this._initialized = false;
    this._currentNonce = null;
    this._currentBurner = null;
    this._mainBurner = null;
    this._mainPda = null;
    this._stealthPda = null;
    this._walletPubkey = null;
    this._currentBlobId = null;
    this._isNewUser = false;
    this._connection = null;
    this._rollupConnection = null;
  }
}

// ============ SINGLETON EXPORT ============
export const shredrClient = new ShredrClient();
