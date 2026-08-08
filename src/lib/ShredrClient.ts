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
  MAX_UTXO_SCAN_INDEX,
  UTXO_SCAN_EMPTY_THRESHOLD,
  DEFAULT_DENOMINATION_SOL,
  UNDELEGATION_POLL_INTERVAL_MS,
  UNDELEGATION_TIMEOUT_MS,
  type NormalizedDenomination,
} from "./constants";
import {
  deriveStealthPDA,
  createInitializeAndDelegateInstruction,
  createPrivateTransferInstruction,
  createCommitAndUndelegateStealthInstruction,
  createStealthWithdrawInstruction,
  parseStealthAccount,
  type StealthAccountData,
} from "./ShredrProgram";
import type { GeneratedNonce, BurnerKeyPair, CreateBlobRequest } from "./types";

// ============ TYPES ============

export type SigningMode = "auto" | "manual";

export type UtxoStatus =
  | "empty" // no balance, not yet used
  | "received" // funds sitting on the burner, awaiting init+delegate
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

/** Signatures produced by a full shred (receive → rollup → base layer). */
export interface ShredResult {
  burnerAddress: string;
  stealthPda: string;
  /** Lamports swept from the burner into the stealth PDA. */
  lamports: number;
  signatures: {
    initializeAndDelegate: string;
    initializeMainPda: string | null;
    privateTransfer: string;
    commitAndUndelegate: string;
  };
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

  /**
   * The address to share with senders: the one-time **burner pubkey**.
   *
   * Deposits land on the burner account and are swept into its stealth PDA by
   * `InitializeAndDelegate` (the burner signs that sweep). Sending straight to
   * the stealth PDA would break initialization, since the program requires the
   * PDA to be empty when it is created.
   */
  get receiveAddress(): string | null {
    return this._currentBurner?.address ?? null;
  }

  /** Stealth PDA derived from the *current* burner (created when shredding). */
  get stealthAddress(): string | null {
    return this._stealthPda?.toBase58() ?? null;
  }
  /** @deprecated use receiveAddress */
  get shadowireAddress(): string | null {
    return this.receiveAddress;
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
    const [pda] = deriveStealthPDA(burnerPub);
    this._stealthPda = pda;
  }

  /** Read and decode a stealth PDA's on-chain state (null if uninitialized). */
  private async fetchStealthState(
    pda: PublicKey,
    connection: Connection = this.getConnection(),
  ): Promise<StealthAccountData | null> {
    const info = await connection.getAccountInfo(pda);
    if (!info) return null;
    return parseStealthAccount(new Uint8Array(info.data));
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
    const [mainPda] = deriveStealthPDA(mainBurnerPub);
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
   * A sender deposits SOL on the **burner address**; `InitializeAndDelegate`
   * then creates the burner's stealth PDA, sweeps the deposit into it, and
   * delegates it to the MagicBlock TEE validator.
   *
   * This is signed by:
   *   - **Kora** as relayer + fee payer (server-side)
   *   - The **burner keypair** (we have it client-side), which authorizes
   *     moving its balance into the PDA
   *
   * @param burner        Burner keypair owning the stealth PDA (defaults to current)
   * @param depositAmount Lamports to sweep; defaults to the burner's full balance.
   *                      Pass `0n` to create an empty delegated PDA.
   * @returns Signature of the broadcast transaction
   */
  async initializeAndDelegate(
    burner?: BurnerKeyPair,
    depositAmount?: bigint,
  ): Promise<string> {
    const b = burner ?? this._currentBurner;
    if (!b) throw new Error("No burner available");

    const burnerKp = this.burnerToKeypair(b);
    const relayer = koraRelayer.getRelayerPubkey();
    const connection = this.getConnection();

    // Kora pays rent and fees, so the whole burner balance is user deposit.
    const deposit =
      depositAmount ?? BigInt(await connection.getBalance(burnerKp.publicKey));

    const ix = createInitializeAndDelegateInstruction(
      relayer,
      burnerKp.publicKey,
      deposit,
    );

    return koraRelayer.signAndSend(connection, [ix], [burnerKp]);
  }

  /**
   * Make sure the main PDA exists and is delegated, so it can receive a
   * private transfer inside the rollup. Creates it empty when missing.
   *
   * Note: the program creates the PDA as part of delegation and rejects a
   * non-empty account, so a main PDA that has already been undelegated cannot
   * be re-delegated — that case throws instead of silently failing later.
   *
   * @returns The `InitializeAndDelegate` signature, or null if already delegated.
   */
  async ensureMainPdaDelegated(): Promise<string | null> {
    if (!this._mainBurner || !this._mainPda) {
      throw new Error("Main burner / main PDA not initialized");
    }

    const state = await this.fetchStealthState(this._mainPda);
    if (state?.delegated) return null;

    // Covers both the first run and re-delegation after a withdraw cycle: the
    // program reuses an existing undelegated PDA instead of rejecting it.
    return this.initializeAndDelegate(this._mainBurner, 0n);
  }

  // ============ ON-CHAIN: PRIVATE TRANSFER (inside rollup) ============

  /**
   * Step 3 — execute the private transfer inside the MagicBlock rollup.
   * Moves lamports from a stealth PDA to the main PDA.
   *
   * A PDA cannot sign, so the source burner authorizes the transfer: it signs
   * and the program checks it against the source PDA's recorded owner (the ACL
   * member registered during `InitializeAndDelegate`).
   *
   * @param sourceBurner   Burner that owns the source stealth PDA
   * @param amountLamports Amount to transfer (typically the full deposit)
   */
  async privateTransferToMainPda(
    sourceBurner: BurnerKeyPair,
    amountLamports: bigint,
  ): Promise<string> {
    if (!this._mainPda) throw new Error("Main PDA not initialized");

    const burnerKp = this.burnerToKeypair(sourceBurner);
    const [sourcePda] = deriveStealthPDA(burnerKp.publicKey);

    const ix = createPrivateTransferInstruction(
      burnerKp.publicKey,
      sourcePda,
      this._mainPda,
      amountLamports,
    );

    // Dispatched against the rollup RPC, where the delegated PDAs live: Kora
    // signs as fee payer but the transaction is broadcast on the rollup.
    return koraRelayer.signAndSendOn(
      this.getRollupConnection(),
      [ix],
      [burnerKp],
    );
  }

  // ============ ON-CHAIN: COMMIT & UNDELEGATE ============

  /**
   * Step 4 — commit rollup state to the base layer AND undelegate the PDA.
   * Signed by Kora (relayer + fee payer).
   *
   * Sent to the rollup RPC: the MagicBlock program schedules the settlement
   * from inside the ephemeral rollup, which then calls the program's
   * `UndelegationCallback` on the base layer.
   */
  async commitAndUndelegate(stealthPda: PublicKey): Promise<string> {
    const relayer = koraRelayer.getRelayerPubkey();
    const ix = createCommitAndUndelegateStealthInstruction(relayer, stealthPda);

    // No client-side signers needed (Kora signs as relayer)
    return koraRelayer.signAndSendOn(this.getRollupConnection(), [ix], []);
  }

  /**
   * Poll the base layer until `stealthPda` is back and undelegated.
   *
   * Undelegation settles asynchronously: the rollup commits state, then the
   * delegation program recreates the account and invokes the program's
   * `UndelegationCallback`, which clears the `delegated` flag.
   */
  async waitForUndelegation(
    stealthPda: PublicKey,
    timeoutMs: number = UNDELEGATION_TIMEOUT_MS,
  ): Promise<StealthAccountData> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const state = await this.fetchStealthState(stealthPda);
      if (state && !state.delegated) return state;

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${stealthPda.toBase58()} to undelegate`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, UNDELEGATION_POLL_INTERVAL_MS),
      );
    }
  }

  // ============ ON-CHAIN: FULL SHRED FLOW ============

  /**
   * Run the whole flow for one received deposit:
   *
   *   1. `InitializeAndDelegate` the burner's stealth PDA, sweeping the deposit
   *   2. `InitializeAndDelegate` the main PDA (empty) if it isn't delegated yet
   *   3. `PrivateTransfer` the deposit stealth PDA → main PDA, inside the rollup
   *   4. `CommitAndUndelegateStealth` the now-empty source PDA
   *
   * The main PDA stays delegated so it can keep receiving private transfers;
   * {@link withdrawToWallet} undelegates it when the user claims.
   *
   * @param burner Burner holding the deposit (defaults to the current one)
   */
  async shredBurner(burner?: BurnerKeyPair): Promise<ShredResult> {
    const b = burner ?? this._currentBurner;
    if (!b) throw new Error("No burner available");
    if (!this._mainPda) throw new Error("Main PDA not initialized");

    const burnerKp = this.burnerToKeypair(b);
    const [stealthPda] = deriveStealthPDA(burnerKp.publicKey);
    const connection = this.getConnection();

    const lamports = await connection.getBalance(burnerKp.publicKey);
    if (lamports <= 0) {
      throw new Error(`Burner ${b.address} has no funds to shred`);
    }
    const deposit = BigInt(lamports);

    const initializeAndDelegate = await this.initializeAndDelegate(b, deposit);
    const initializeMainPda = await this.ensureMainPdaDelegated();
    const privateTransfer = await this.privateTransferToMainPda(b, deposit);
    const commitAndUndelegate = await this.commitAndUndelegate(stealthPda);

    return {
      burnerAddress: b.address,
      stealthPda: stealthPda.toBase58(),
      lamports,
      signatures: {
        initializeAndDelegate,
        initializeMainPda,
        privateTransfer,
        commitAndUndelegate,
      },
    };
  }

  // ============ ON-CHAIN: WITHDRAW ============

  /**
   * Step 5 — withdraw the main PDA's balance to any destination.
   * Signed by the main burner; fee paid by Kora.
   *
   * `Withdraw` only works on the base layer, so a delegated main PDA is
   * committed and undelegated first — that settlement is asynchronous and this
   * method waits for it.
   *
   * Only `depositedAmount` can be withdrawn: the rest of the PDA's lamports is
   * the rent-exemption Kora paid, which the program refuses to touch.
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

    let state = await this.fetchStealthState(this._mainPda, connection);
    if (!state) throw new Error("Main PDA has not been initialized on-chain");

    if (state.delegated) {
      await this.commitAndUndelegate(this._mainPda);
      state = await this.waitForUndelegation(this._mainPda);
    }

    const availableLamports = Number(state.depositedAmount);

    let withdrawLamports: number;
    if (amountInSol === "all") {
      withdrawLamports = availableLamports;
    } else {
      withdrawLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
    }

    if (withdrawLamports <= 0) {
      throw new Error("Insufficient balance for withdrawal");
    }
    if (withdrawLamports > availableLamports) {
      throw new Error(
        `Requested ${withdrawLamports} lamports but only ${availableLamports} are withdrawable`,
      );
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

  /**
   * Shred every burner that is holding an unswept deposit.
   *
   * Covers deposits that arrived while the app was closed, and manual-signing
   * mode, where the generator page does not shred on its own.
   */
  async shredPendingDeposits(): Promise<ShredResult[]> {
    if (!this._initialized || !this._walletPubkey) {
      throw new Error("ShredrClient not initialized");
    }

    const pending = (await this.scanPendingUtxos()).filter(
      (utxo) => utxo.status === "received",
    );

    const results: ShredResult[] = [];
    for (const utxo of pending) {
      const nonce = await nonceService.generateNonceAtIndex(
        utxo.nonceIndex,
        this._walletPubkey,
      );
      const burner = await burnerService.deriveBurnerFromNonce(nonce);
      try {
        results.push(await this.shredBurner(burner));
      } finally {
        burnerService.clearBurner(burner);
      }
    }
    return results;
  }

  // ============ BALANCE ============

  /**
   * Get the withdrawable balance of the main PDA (where funds consolidate).
   *
   * Reads the PDA's `depositedAmount` rather than its raw lamports, which also
   * include the rent-exemption the relayer paid. Returns zero while the main
   * PDA does not exist yet.
   *
   * The `address` returned is the **main PDA**, not the burner pubkey.
   */
  async getStealthBalance(): Promise<{
    available: number;
    availableLamports: number;
    address: string;
    delegated: boolean;
  }> {
    if (!this._mainPda) {
      throw new Error("Main PDA not initialized. Call initFromSignature first.");
    }

    const state = await this.fetchStealthState(this._mainPda);
    const lamports = state ? Number(state.depositedAmount) : 0;

    return {
      available: lamports / LAMPORTS_PER_SOL,
      availableLamports: lamports,
      address: this._mainPda.toBase58(),
      delegated: state?.delegated ?? false,
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
   * Scan burners and their stealth PDAs across nonce indices and return the
   * ones holding funds. Used by the dashboard to surface in-flight funds.
   *
   * Each index can be in one of three funded states:
   *   - `received`  — SOL sits on the burner, waiting to be shredded
   *   - `delegated` — swept into the stealth PDA and living in the rollup
   *   - `ready`     — committed back to the base layer, withdrawable
   *
   * Stops after {@link UTXO_SCAN_EMPTY_THRESHOLD} consecutive empty indices to
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
      const [pda] = deriveStealthPDA(burnerPub);

      const [burnerLamports, pdaInfo] = await Promise.all([
        connection.getBalance(burnerPub),
        connection.getAccountInfo(pda),
      ]);
      const pdaState = pdaInfo
        ? parseStealthAccount(new Uint8Array(pdaInfo.data))
        : null;
      const pdaLamports = pdaState ? Number(pdaState.depositedAmount) : 0;

      let status: UtxoStatus = "empty";
      let lamports = 0;

      if (pdaLamports > 0) {
        // Swept into the PDA already: either still in the rollup or settled.
        status = pdaState?.delegated ? "delegated" : "ready";
        lamports = pdaLamports;
      } else if (burnerLamports > 0) {
        // Raw deposit landed on the burner, not yet swept.
        status = "received";
        lamports = burnerLamports;
      }

      if (status === "empty") {
        consecutiveEmpty++;
        burnerService.clearBurner(burner);
        if (consecutiveEmpty >= UTXO_SCAN_EMPTY_THRESHOLD) break;
        continue;
      }

      consecutiveEmpty = 0;
      utxos.push({
        nonceIndex: i,
        burnerAddress: burner.address,
        stealthPda: pda.toBase58(),
        lamports,
        status,
      });

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
