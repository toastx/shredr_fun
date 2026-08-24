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
  WALLET_HASH_LENGTH,
  type NormalizedDenomination,
} from "./constants";
import {
  deriveStealthPDA,
  createInitializeAndDelegateInstruction,
  createPrivateTransferInstruction,
  createCommitAndUndelegateStealthInstruction,
  createStealthWithdrawInstruction,
  createCloseStealthAccountInstruction,
  parseStealthAccount,
  MAGIC_BLOCK_PROGRAM_ID,
  STEALTH_ROLE,
  type StealthAccountData,
} from "./ShredrProgram";
import { utxoService } from "./UtxoService";
import { deriveWalletHash } from "./utils";
import type {
  GeneratedNonce,
  BurnerKeyPair,
  CreateBlobRequest,
  UtxoNote,
  UtxoRole,
} from "./types";

// ============ TYPES ============

export type SigningMode = "auto" | "manual";

export type UtxoStatus =
  | "empty" // no balance, not yet used
  | "received" // funds sitting on the burner, awaiting init+delegate
  | "delegated" // initialized + delegated to rollup
  | "ready" // committed back, ready to withdraw
  | "spent"; // already withdrawn

/** A stranded note plus the step that would move it forward. */
export interface PendingAction {
  note: UtxoNote;
  action: "initialize" | "transfer" | "undelegate" | "withdraw" | "close" | "forget";
  lamports: number;
}

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
  private _resuming: Promise<
    Array<{ plan: PendingAction; ok: boolean; error?: string }>
  > | null = null;

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

  /**
   * Read a stealth PDA from whichever layer actually holds its state.
   *
   * Delegation zeroes the base-layer account data and hands ownership to the
   * delegation program, so a delegated PDA parses as `null` on base even though
   * it is holding funds in the rollup. Reading base alone therefore reports
   * live deposits as empty — re-read from the rollup before concluding that.
   *
   * `absent` distinguishes "no such account" from "exists but unreadable here",
   * so callers never treat an RPC gap as an empty slot.
   */
  private async readStealthState(pda: PublicKey): Promise<{
    state: StealthAccountData | null;
    absent: boolean;
    layer: "base" | "rollup";
  }> {
    const info = await this.getConnection().getAccountInfo(pda);

    if (info) {
      const parsed = parseStealthAccount(new Uint8Array(info.data));
      if (parsed) return { state: parsed, absent: false, layer: "base" };
    }

    // Either the account is delegated (data zeroed on base) or base has not
    // caught up yet. The rollup is the only place its state still exists.
    const delegated =
      info?.owner.equals(MAGIC_BLOCK_PROGRAM_ID) ?? false;

    if (!info || delegated) {
      try {
        const rollup = await this.fetchStealthState(
          pda,
          this.getRollupConnection(),
        );
        if (rollup) return { state: rollup, absent: false, layer: "rollup" };
      } catch (err) {
        // Rollup unreachable: report unreadable, never empty.
        console.warn("[readStealthState] rollup read failed:", err);
        if (delegated) return { state: null, absent: false, layer: "rollup" };
      }
    }

    return { state: null, absent: !info, layer: "base" };
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

    // The UTXO tree shares the storage key derived from the same signature, so
    // it is recoverable on any device the user can sign from.
    const encKey = nonceService.getEncryptionKey();
    if (encKey) {
      try {
        await utxoService.init(
          encKey,
          await deriveWalletHash(walletPubkey, WALLET_HASH_LENGTH),
        );
        await utxoService.load();
      } catch (err) {
        console.warn("[ShredrClient] UTXO tree unavailable:", err);
      }
    }

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
    role?: UtxoRole,
  ): Promise<string> {
    const b = burner ?? this._currentBurner;
    if (!b) throw new Error("No burner available");

    const burnerKp = this.burnerToKeypair(b);
    const relayer = koraRelayer.getRelayerPubkey();
    const connection = this.getConnection();

    // Kora pays rent and fees, so the whole burner balance is user deposit.
    const deposit =
      depositAmount ?? BigInt(await connection.getBalance(burnerKp.publicKey));

    const resolvedRole = role ?? "deposit";
    const ix = createInitializeAndDelegateInstruction(
      relayer,
      burnerKp.publicKey,
      deposit,
      STEALTH_ROLE[resolvedRole],
    );

    // Write-ahead: record the note *before* broadcasting. A crash between send
    // and persist is the one window that strands funds with nothing pointing
    // at them, so the record must always land first.
    const [pda] = deriveStealthPDA(burnerKp.publicKey);
    await this.recordNote(b, pda, resolvedRole, Number(deposit));

    const signature = await koraRelayer.signAndSend(connection, [ix], [burnerKp]);
    await utxoService.setState(pda.toBase58(), "delegated", Number(deposit));
    return signature;
  }

  /** Persist a note for a burner/PDA pair, tolerating an uninitialised tree. */
  private async recordNote(
    burner: BurnerKeyPair,
    pda: PublicKey,
    role: UtxoRole,
    lamports: number,
  ): Promise<void> {
    try {
      await utxoService.record({
        nonceIndex: burner.nonceIndex,
        role,
        burnerAddress: burner.address,
        stealthPda: pda.toBase58(),
        lamports,
      });
    } catch (err) {
      // Recovery bookkeeping must never break the flow it is recording.
      console.warn("[ShredrClient] failed to record UTXO note:", err);
    }
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
   * @param destinationPda Defaults to the main PDA (deposits consolidating in).
   *                       `withdrawToWallet` passes an exit PDA to send funds
   *                       back out without the main PDA appearing on base layer.
   */
  async privateTransfer(
    sourceBurner: BurnerKeyPair,
    amountLamports: bigint,
    destinationPda?: PublicKey,
  ): Promise<string> {
    const destination = destinationPda ?? this._mainPda;
    if (!destination) throw new Error("Main PDA not initialized");

    const burnerKp = this.burnerToKeypair(sourceBurner);
    const [sourcePda] = deriveStealthPDA(burnerKp.publicKey);

    const ix = createPrivateTransferInstruction(
      burnerKp.publicKey,
      sourcePda,
      destination,
      amountLamports,
    );

    // Dispatched against the rollup RPC, where the delegated PDAs live: Kora
    // signs as fee payer but the transaction is broadcast on the rollup.
    const signature = await koraRelayer.signAndSendOn(
      this.getRollupConnection(),
      [ix],
      [burnerKp],
    );

    // The source is spent only once the transfer confirms; the destination now
    // carries the balance and becomes the note recovery must chase.
    await utxoService.setState(sourcePda.toBase58(), "spent", 0);
    await utxoService.setState(
      destination.toBase58(),
      "delegated",
      Number(amountLamports),
    );

    return signature;
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
    const privateTransfer = await this.privateTransfer(b, deposit);
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
    const destination = new PublicKey(destinationAddress);

    // The main PDA stays delegated throughout, so its live balance is in the
    // rollup — the base-layer copy is only as fresh as the last commit.
    const state = await this.fetchStealthState(
      this._mainPda,
      this.getRollupConnection(),
    );
    if (!state) throw new Error("Main PDA has not been initialized on-chain");

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

    // Route the exit through a throwaway PDA so the main PDA never appears as
    // the source of a base-layer transfer. The hop to it happens inside the
    // rollup and is invisible on Solana, so consecutive withdrawals have
    // unrelated sources instead of a shared, linkable parent.
    //
    // The exit burner comes off the deposit nonce chain rather than being
    // random: if this flow dies between the transfer and the withdraw, the
    // funds must stay derivable. `scanPendingUtxos` walks the same indices and
    // reports the stranded PDA as `ready`.
    const exitBurner = await this.consumeAndGenerateNew();
    // Advance again so the exit burner is not left as the displayed deposit
    // address: its withdrawal is public on base layer, so a later deposit to it
    // would link the depositor to the withdrawal destination.
    await this.consumeAndGenerateNew();

    try {
      const exitBurnerKp = this.burnerToKeypair(exitBurner);
      const [exitPda] = deriveStealthPDA(exitBurnerKp.publicKey);

      await this.initializeAndDelegate(exitBurner, 0n, "exit");
      await this.privateTransfer(
        this._mainBurner,
        BigInt(withdrawLamports),
        exitPda,
      );

      await this.commitAndUndelegate(exitPda);
      await this.waitForUndelegation(exitPda);
      await utxoService.setState(exitPda.toBase58(), "undelegated");

      const ix = createStealthWithdrawInstruction(
        exitBurnerKp.publicKey,
        exitPda,
        destination,
        BigInt(withdrawLamports),
      );

      const signature = await koraRelayer.signAndSend(
        connection,
        [ix],
        [exitBurnerKp],
      );

      await utxoService.setState(exitPda.toBase58(), "withdrawn", 0);

      // Best-effort: the money has already arrived, so a failed rent reclaim
      // must not surface as a failed withdrawal. Recovery picks up any PDA
      // left in `withdrawn` on the next login.
      try {
        await this.closeStealthAccount(exitBurner, exitPda);
      } catch (err) {
        console.warn("[ShredrClient] exit PDA rent reclaim failed:", err);
      }

      return {
        signature,
        amount: withdrawLamports / LAMPORTS_PER_SOL,
      };
    } finally {
      burnerService.clearBurner(exitBurner);
    }
  }

  /**
   * Reclaim a spent stealth PDA's rent and return the account to the System
   * Program. Requires the PDA to be undelegated with `depositedAmount == 0`.
   *
   * Rent goes to the relayer, which paid it. That is also the better privacy
   * choice — every user's closes share one counterparty, so the payee reveals
   * nothing about which PDAs belong together.
   */
  async closeStealthAccount(
    burner: BurnerKeyPair,
    stealthPda: PublicKey,
  ): Promise<string> {
    const burnerKp = this.burnerToKeypair(burner);
    const ix = createCloseStealthAccountInstruction(
      burnerKp.publicKey,
      stealthPda,
      koraRelayer.getRelayerPubkey(),
    );

    const signature = await koraRelayer.signAndSend(
      this.getConnection(),
      [ix],
      [burnerKp],
    );

    await utxoService.setState(stealthPda.toBase58(), "closed");
    return signature;
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

    // Delegation zeroes the base-layer copy, so reading base alone reports a
    // delegated PDA as empty. `readStealthState` falls through to the rollup.
    const { state } = await this.readStealthState(this._mainPda);
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

  // ============ RECOVERY ============

  /**
   * What a stranded note needs next, derived from live chain state.
   *
   * The note supplies the role — chain state cannot, since the program stores
   * no role marker — and chain state supplies everything else. A note is only
   * ever a hint: if the two disagree, chain state wins.
   */
  private async planFor(note: UtxoNote): Promise<PendingAction | null> {
    const pda = new PublicKey(note.stealthPda);
    const { state, absent } = await this.readStealthState(pda);

    if (absent) {
      // Never created, or already closed and reaped. A funded burner means the
      // deposit landed but init never ran.
      const burnerLamports = await this.getConnection().getBalance(
        new PublicKey(note.burnerAddress),
      );
      if (burnerLamports > 0) {
        return { note, action: "initialize", lamports: burnerLamports };
      }
      return { note, action: "forget", lamports: 0 };
    }

    if (!state) {
      // Exists but unreadable right now (rollup down). Leave it alone rather
      // than acting on a guess.
      return null;
    }

    const lamports = Number(state.depositedAmount);

    // The chain is authoritative when it knows. Accounts written before the
    // role field existed read back as `unset`, so fall back to the note.
    const role: UtxoRole =
      state.role === STEALTH_ROLE.deposit
        ? "deposit"
        : state.role === STEALTH_ROLE.exit
          ? "exit"
          : note.role;

    if (state.delegated) {
      if (lamports > 0) {
        return role === "deposit"
          ? { note, action: "transfer", lamports }
          : { note, action: "undelegate", lamports };
      }
      return { note, action: "undelegate", lamports: 0 };
    }

    if (lamports > 0) {
      return role === "exit"
        ? { note, action: "withdraw", lamports }
        : { note, action: "transfer", lamports };
    }

    return { note, action: "close", lamports: 0 };
  }

  /**
   * Inspect every unsettled note and report what would be done. Read-only —
   * callers show this before {@link resumePending} acts on it.
   */
  async planPending(): Promise<PendingAction[]> {
    if (!this._initialized) throw new Error("ShredrClient not initialized");

    const plans: PendingAction[] = [];
    for (const note of utxoService.unsettled) {
      try {
        const plan = await this.planFor(note);
        if (plan) plans.push(plan);
      } catch (err) {
        console.warn("[planPending] skipped", note.stealthPda, err);
      }
    }
    return plans;
  }

  /**
   * Drive stranded cycles to completion.
   *
   * Each note is independent, so one failure must not abort the rest — a
   * single unreachable PDA should not strand every other recovered deposit.
   */
  async resumePending(
    plans?: PendingAction[],
  ): Promise<Array<{ plan: PendingAction; ok: boolean; error?: string }>> {
    // Several entry points call this on sign-in, and a user can move between
    // them. Two concurrent runs would plan from the same notes and submit the
    // same transfers twice — the second fails once the source is drained, but
    // not before creating a redundant exit PDA and burning its rent.
    if (this._resuming) return this._resuming;

    this._resuming = this.resumePendingInner(plans).finally(() => {
      this._resuming = null;
    });
    return this._resuming;
  }

  private async resumePendingInner(
    plans?: PendingAction[],
  ): Promise<Array<{ plan: PendingAction; ok: boolean; error?: string }>> {
    const todo = plans ?? (await this.planPending());
    const results: Array<{ plan: PendingAction; ok: boolean; error?: string }> = [];

    for (const plan of todo) {
      try {
        await this.executePlan(plan);
        results.push({ plan, ok: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn("[resumePending] failed", plan.note.stealthPda, error);
        results.push({ plan, ok: false, error });
      }
    }

    return results;
  }

  private async executePlan(plan: PendingAction): Promise<void> {
    const { note } = plan;
    const pda = new PublicKey(note.stealthPda);

    switch (plan.action) {
      case "forget":
        await utxoService.setState(note.stealthPda, "closed");
        return;

      case "initialize": {
        const burner = await this.burnerForNote(note);
        try {
          await this.initializeAndDelegate(burner, undefined, note.role);
        } finally {
          burnerService.clearBurner(burner);
        }
        return;
      }

      case "transfer": {
        // Push the balance one hop forward into a fresh exit PDA, then settle
        // it. Safe whichever role the note actually was.
        const burner = await this.burnerForNote(note);
        try {
          const exitBurner = await this.consumeAndGenerateNew();
          const exitKp = this.burnerToKeypair(exitBurner);
          const [exitPda] = deriveStealthPDA(exitKp.publicKey);

          await this.initializeAndDelegate(exitBurner, 0n, "exit");
          await this.privateTransfer(burner, BigInt(plan.lamports), exitPda);
          await utxoService.link(note.stealthPda, exitBurner.nonceIndex);
        } finally {
          burnerService.clearBurner(burner);
        }
        return;
      }

      case "undelegate":
        await this.commitAndUndelegate(pda);
        await this.waitForUndelegation(pda);
        await utxoService.setState(note.stealthPda, "undelegated");
        return;

      case "withdraw": {
        const burner = await this.burnerForNote(note);
        try {
          const kp = this.burnerToKeypair(burner);
          const ix = createStealthWithdrawInstruction(
            kp.publicKey,
            pda,
            new PublicKey(this._walletPubkey!),
            BigInt(plan.lamports),
          );
          await koraRelayer.signAndSend(this.getConnection(), [ix], [kp]);
          await utxoService.setState(note.stealthPda, "withdrawn", 0);
        } finally {
          burnerService.clearBurner(burner);
        }
        return;
      }

      case "close": {
        const burner = await this.burnerForNote(note);
        try {
          await this.closeStealthAccount(burner, pda);
        } finally {
          burnerService.clearBurner(burner);
        }
        return;
      }
    }
  }

  /** Re-derive the signing burner for a note from its nonce index. */
  private async burnerForNote(note: UtxoNote): Promise<BurnerKeyPair> {
    if (note.nonceIndex < 0) {
      if (!this._mainBurner) throw new Error("Main burner unavailable");
      return this._mainBurner;
    }
    const nonce = await nonceService.generateNonceAtIndex(
      note.nonceIndex,
      this._walletPubkey!,
    );
    return burnerService.deriveBurnerFromNonce(nonce);
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

      const [burnerLamports, pdaRead] = await Promise.all([
        connection.getBalance(burnerPub),
        this.readStealthState(pda),
      ]);
      const pdaState = pdaRead.state;
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
        burnerService.clearBurner(burner);
        // Only a genuinely absent account counts toward the early exit. An
        // account that exists but could not be read (delegated, or a flaky
        // RPC) must not shorten the scan and hide funded indices past it.
        if (!pdaRead.absent) continue;
        consecutiveEmpty++;
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
