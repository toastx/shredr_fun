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
import {
  ATTESTATION_VERSION,
  AuditService,
  auditService,
  decodeDisclosure,
  decodeViewingKey,
  encodeDisclosure,
  encodeViewingKey,
  packAttestation,
  UNKNOWN_SIGNATURE,
  verifyDisclosure,
  type Attestation,
  type Disclosure,
  type SignedAttestation,
  type VerificationResult,
} from "./AuditService";
import { resolveAnchor } from "./anchor";
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
import { base64ToUint8Array, deriveWalletHash } from "./utils";
import type {
  GeneratedNonce,
  BurnerKeyPair,
  CreateBlobRequest,
  UtxoNote,
  UtxoRole,
  UtxoState,
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
  action: "initialize" | "undelegate" | "withdraw" | "close" | "forget";
  lamports: number;
}

export interface PendingUtxo {
  nonceIndex: number;
  burnerAddress: string;
  stealthPda: string;
  lamports: number;
  status: UtxoStatus;
  /** From the PDA's on-chain role byte; absent when it reads `unset`. */
  role?: UtxoRole;
}

/** One openable receipt, ready to display or hand over. */
export interface ReceiptView {
  depositIndex: number;
  exitIndex: number;
  attestation: SignedAttestation;
  /** The pasteable disclosure. Useless without the key. */
  token: string;
  /** The 44 bytes an auditor needs. Handing this over is irreversible. */
  viewingKey: string;
  /**
   * Another receipt withdrew to the same destination, so disclosing this one
   * lets that auditor link the others by watching the address.
   */
  destinationShared: boolean;
}

/** Signatures produced by a full shred (receive → rollup → base layer). */
export interface ShredResult {
  burnerAddress: string;
  stealthPda: string;
  /** Lamports swept from the burner into the stealth PDA. */
  lamports: number;
  signatures: {
    initializeAndDelegate: string;
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
  /** @deprecated Legacy consolidation account; kept so old balances drain. */
  get mainBurnerAddress(): string | null {
    return this._mainBurner?.address ?? null;
  }

  /** Persistent main PDA — where funds consolidate after the rollup commit. */
  /** @deprecated Legacy consolidation account; kept so old balances drain. */
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
    await auditService.initFromSignature(signature);

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
    commitment?: Uint8Array,
  ): Promise<string> {
    const b = burner ?? this._currentBurner;
    if (!b) throw new Error("No burner available");

    const burnerKp = this.burnerToKeypair(b);
    const relayer = koraRelayer.getRelayerPubkey();
    const connection = this.getConnection();

    // Kora pays rent and fees, so the whole burner balance is user deposit.
    const deposit =
      depositAmount ?? BigInt(await connection.getBalance(burnerKp.publicKey));

    const [pda] = deriveStealthPDA(burnerKp.publicKey);
    const resolvedRole = role ?? "deposit";

    // Every account is anchored. A caller with nothing to commit still writes a
    // real commitment over the deposit leg rather than a placeholder — a field
    // only some accounts populate would identify those accounts.
    const anchor =
      commitment ??
      (await AuditService.depositCommitment(
        await auditService.deriveViewingKey(pda.toBytes(), b.nonceIndex),
        b.nonceIndex,
        pda.toBytes(),
        deposit,
      ));

    const ix = createInitializeAndDelegateInstruction(
      relayer,
      burnerKp.publicKey,
      deposit,
      anchor,
      STEALTH_ROLE[resolvedRole],
    );

    // Write-ahead: record the note *before* broadcasting. A crash between send
    // and persist is the one window that strands funds with nothing pointing
    // at them, so the record must always land first.
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
   * @param destination    The exit PDA receiving the funds. Required: this used
   *                       to default to a shared consolidation account, which
   *                       is the design being removed.
   */
  async privateTransfer(
    sourceBurner: BurnerKeyPair,
    amountLamports: bigint,
    destination: PublicKey,
  ): Promise<string> {
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

    const burnerKp = this.burnerToKeypair(b);
    const [stealthPda] = deriveStealthPDA(burnerKp.publicKey);
    const connection = this.getConnection();

    const lamports = await connection.getBalance(burnerKp.publicKey);
    if (lamports <= 0) {
      throw new Error(`Burner ${b.address} has no funds to shred`);
    }

    // Sweep into the deposit PDA and leave it delegated. There is no longer a
    // consolidation account to forward to: the hop that breaks the link now
    // happens at withdrawal time, deposit PDA -> exit PDA, inside the rollup.
    //
    // Consolidating on deposit meant every user's funds passed through one
    // long-lived address, so a single forced undelegation exposed the whole
    // set at once. Holding them in per-deposit PDAs keeps that blast radius
    // to one deposit.
    const initializeAndDelegate = await this.initializeAndDelegate(
      b,
      BigInt(lamports),
      "deposit",
    );

    return {
      burnerAddress: b.address,
      stealthPda: stealthPda.toBase58(),
      lamports,
      signatures: { initializeAndDelegate },
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
    if (!this._initialized) throw new Error("ShredrClient not initialized");

    const connection = this.getConnection();
    const destination = new PublicKey(destinationAddress);

    const sources = await this.fundedSources();
    const availableLamports = sources.reduce((sum, s) => sum + s.lamports, 0);

    const withdrawLamports =
      amountInSol === "all"
        ? availableLamports
        : Math.floor(amountInSol * LAMPORTS_PER_SOL);

    if (withdrawLamports <= 0) {
      throw new Error("Insufficient balance for withdrawal");
    }
    if (withdrawLamports > availableLamports) {
      throw new Error(
        `Requested ${withdrawLamports} lamports but only ${availableLamports} are withdrawable`,
      );
    }

    // Route the exit through a throwaway PDA so no deposit PDA is ever the
    // source of a base-layer transfer. The hops happen inside the rollup and
    // are invisible on Solana, so consecutive withdrawals have unrelated
    // sources rather than a shared, linkable parent.
    //
    // The exit burner comes off the deposit nonce chain rather than being
    // random: if this flow dies partway, the funds must stay derivable. The
    // chain walk finds it and recovery reports it as ready.
    const exitBurner = await this.consumeAndGenerateNew();
    // Advance again so the exit burner is not left as the displayed deposit
    // address: its withdrawal is public on base layer, so a later deposit to it
    // would link the depositor to the withdrawal destination.
    await this.consumeAndGenerateNew();

    try {
      const exitBurnerKp = this.burnerToKeypair(exitBurner);
      const [exitPda] = deriveStealthPDA(exitBurnerKp.publicKey);

      // Plan the draw before touching anything. The exit PDA's commitment covers
      // the whole batch and has to be written when that PDA is initialised —
      // which is before any transfer runs — so the allocation must be known now.
      // Drawing newest-first because the oldest deposits are the ones most worth
      // leaving in the rollup: their timing is furthest from this withdrawal, so
      // they correlate least with it.
      const plan: Array<{ source: (typeof sources)[number]; take: number }> = [];
      let unplanned = withdrawLamports;
      for (const source of sources) {
        if (unplanned <= 0) break;
        const take = Math.min(unplanned, source.lamports);
        plan.push({ source, take });
        unplanned -= take;
      }
      if (unplanned > 0) {
        // Balance moved between reading and planning. Nothing has been spent
        // yet, so this is a clean failure.
        throw new Error(
          `Could not gather the full amount; ${unplanned} lamports short.`,
        );
      }

      const exitTs = BigInt(Math.floor(Date.now() / 1000));
      const invoices = await this.buildInvoices(plan, exitBurner, exitPda, destination, exitTs);
      const root = await AuditService.root(invoices.map((inv) => inv.leaf));

      await this.initializeAndDelegate(exitBurner, 0n, "exit", root);

      let remaining = withdrawLamports;
      for (const { source, take } of plan) {
        const burner = await this.burnerForNote(source.note);
        try {
          await this.privateTransfer(burner, BigInt(take), exitPda);
        } finally {
          if (burner !== this._mainBurner) burnerService.clearBurner(burner);
        }
        await utxoService.link(source.note.stealthPda, exitBurner.nonceIndex);
        remaining -= take;
      }

      if (remaining > 0) {
        // A transfer silently moved less than planned. The transferred amount is
        // safe in the exit PDA and recovery will finish it, so fail loudly
        // rather than withdrawing an amount that no longer matches.
        throw new Error(
          `Could not gather the full amount; ${remaining} lamports short. ` +
            `Funds are in the exit PDA and will be recovered on next sign-in.`,
        );
      }

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

      // Best-effort, same reasoning as the rent reclaim below: the receipt is a
      // record of a payment that has already completed, so failing to store it
      // must not surface as a failed withdrawal.
      try {
        await this.sealReceipts(invoices, exitBurner, signature);
      } catch (err) {
        console.warn("[ShredrClient] receipt sealing failed:", err);
      }

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

  // ============ RECEIPTS ============

  /**
   * Build one invoice per drawn deposit, plus its commitment leaf.
   *
   * Runs before the exit PDA is initialised, because the root over these leaves
   * is what that PDA commits to. The transaction signatures are left empty here
   * — the withdrawal has not happened yet — and are filled in by
   * {@link sealReceipts}. They are outside the committed prefix for exactly that
   * reason; see `INVOICE_LEN`.
   */
  private async buildInvoices(
    plan: Array<{ source: { note: UtxoNote; pda: PublicKey; depositTs: bigint }; take: number }>,
    exitBurner: BurnerKeyPair,
    exitPda: PublicKey,
    destination: PublicKey,
    exitTs: bigint,
  ): Promise<Array<{ attestation: Attestation; leaf: Uint8Array; index: number }>> {
    const out: Array<{ attestation: Attestation; leaf: Uint8Array; index: number }> = [];

    for (const { source, take } of plan) {
      const index = source.note.nonceIndex;
      const attestation: Attestation = {
        version: ATTESTATION_VERSION,
        depositIndex: index,
        exitIndex: exitBurner.nonceIndex,
        depositPda: source.note.stealthPda,
        exitPda: exitPda.toBase58(),
        depositBurner: source.note.burnerAddress,
        exitBurner: exitBurner.address,
        sender: await this.resolveSender(source.note.burnerAddress),
        destination: destination.toBase58(),
        amount: BigInt(take),
        depositTs: source.depositTs,
        exitTs,
        depositTxSig: UNKNOWN_SIGNATURE,
        exitTxSig: UNKNOWN_SIGNATURE,
      };

      const vk = await auditService.deriveViewingKey(source.pda.toBytes(), index);
      out.push({
        attestation,
        leaf: await AuditService.leaf(vk, packAttestation(attestation)),
        index,
      });
    }

    return out;
  }

  /**
   * Sign, encrypt and store the receipts for a completed withdrawal.
   *
   * Signing re-derives the deposit burners: the transfer loop clears them as it
   * goes, and re-deriving is a hash and a keypair construction. Cheaper than
   * holding secret keys alive across the undelegation wait, which can be two
   * minutes.
   */
  private async sealReceipts(
    invoices: Array<{ attestation: Attestation; leaf: Uint8Array; index: number }>,
    exitBurner: BurnerKeyPair,
    exitTxSig: string,
  ): Promise<void> {
    const exitKp = this.burnerToKeypair(exitBurner);
    const leaves = invoices.map((inv) => inv.leaf);

    for (const invoice of invoices) {
      const depositBurner = await burnerService.deriveBurnerFromNonce(
        await nonceService.generateNonceAtIndex(invoice.index, this._walletPubkey!),
      );

      try {
        const depositKp = this.burnerToKeypair(depositBurner);
        const attestation: Attestation = {
          ...invoice.attestation,
          exitTxSig,
          depositTxSig: await this.resolveDepositTxSig(invoice.attestation.depositBurner),
        };

        const pda = new PublicKey(invoice.attestation.depositPda);
        const vk = await auditService.deriveViewingKey(pda.toBytes(), invoice.index);
        const signed = auditService.signAttestation(
          attestation,
          depositKp.secretKey,
          exitKp.secretKey,
        );

        // Siblings are the other leaves of this batch, handed over as opaque
        // hashes: they are needed to recompute the root and reveal nothing,
        // being hashes under keys the auditor does not hold.
        const siblings = leaves.filter((leaf) => leaf !== invoice.leaf);
        await utxoService.recordReceipt({
          depositIndex: invoice.index,
          exitIndex: exitBurner.nonceIndex,
          disclosure: await AuditService.makeDisclosure(vk, signed, siblings),
        });
      } finally {
        burnerService.clearBurner(depositBurner);
      }
    }
  }

  /**
   * Every receipt this wallet can open, newest first.
   *
   * The stored blob holds only the indices and the sealed disclosure, so the
   * viewing key is re-derived here rather than stored — that derivation *is* the
   * map from invoice to key, and persisting it would rebuild the linkability
   * graph the nonce chain exists to destroy.
   */
  async listReceipts(): Promise<ReceiptView[]> {
    if (!this._initialized || !this._walletPubkey) {
      throw new Error("ShredrClient not initialized");
    }

    const views: ReceiptView[] = [];

    for (const entry of await utxoService.loadReceipts()) {
      const burner = await burnerService.deriveBurnerFromNonce(
        await nonceService.generateNonceAtIndex(entry.depositIndex, this._walletPubkey),
      );
      try {
        const [pda] = deriveStealthPDA(new PublicKey(burner.publicKey));
        const vk = await auditService.deriveViewingKey(pda.toBytes(), entry.depositIndex);
        const disclosure = entry.disclosure as Disclosure;

        views.push({
          depositIndex: entry.depositIndex,
          exitIndex: entry.exitIndex,
          attestation: await AuditService.open(vk, base64ToUint8Array(disclosure.ciphertext)),
          token: encodeDisclosure(disclosure),
          viewingKey: encodeViewingKey(vk),
          destinationShared: false,
        });
      } catch (err) {
        // A receipt that will not open is a bug worth seeing, not a reason to
        // hide the rest of someone's history.
        console.warn("[listReceipts] could not open receipt", entry.depositIndex, err);
      } finally {
        burnerService.clearBurner(burner);
      }
    }

    // Disclosing a receipt exposes its destination. Every other receipt sharing
    // that address becomes linkable to the same auditor from then on, including
    // ones already disclosed, so flag the whole group rather than the later ones.
    const seen = new Map<string, number>();
    for (const v of views) {
      seen.set(v.attestation.destination, (seen.get(v.attestation.destination) ?? 0) + 1);
    }
    for (const v of views) {
      v.destinationShared = (seen.get(v.attestation.destination) ?? 0) > 1;
    }

    return views.sort((a, b) => Number(b.attestation.exitTs - a.attestation.exitTs));
  }

  /**
   * Check a disclosure someone handed you.
   *
   * Needs nothing but the token, the key and a public RPC — no wallet, no
   * initialized client, no shredr account. That is the point: an auditor runs
   * this, and they are not a shredr user.
   */
  async verifyDisclosureToken(
    token: string,
    viewingKey: string,
  ): Promise<VerificationResult> {
    const disclosure = decodeDisclosure(token);
    const vk = decodeViewingKey(viewingKey);

    // The exit PDA is inside the ciphertext, so the anchor cannot be fetched
    // until the token is open. A wrong key stops here, before any RPC call.
    let exitPda: PublicKey;
    try {
      const opened = await AuditService.open(vk, base64ToUint8Array(disclosure.ciphertext));
      exitPda = new PublicKey(opened.exitPda);
    } catch {
      return { ok: false, failed: "decrypt" };
    }

    const root = await resolveAnchor(this.getConnection(), exitPda);
    if (!root) {
      throw new Error(
        `No commitment found for exit account ${exitPda.toBase58()}. ` +
          `If it was closed, verifying needs an RPC that serves archival history.`,
      );
    }

    return verifyDisclosure(disclosure, vk, root, (burner) =>
      deriveStealthPDA(new PublicKey(burner))[0].toBytes(),
    );
  }

  /**
   * The address that funded a burner — the invoice's payer.
   *
   * Read from the burner's oldest transaction rather than stored, so it survives
   * a device wipe. Returns the system program address when history is
   * unavailable, which is a visible "unknown" rather than a wrong answer: the
   * auditor cross-checks the sender against the ledger regardless.
   */
  private async resolveSender(burnerAddress: string): Promise<string> {
    try {
      const connection = this.getConnection();
      const pubkey = new PublicKey(burnerAddress);
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 20 });
      if (sigs.length === 0) return PublicKey.default.toBase58();

      const oldest = sigs[sigs.length - 1];
      const tx = await connection.getTransaction(oldest.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) return PublicKey.default.toBase58();

      const keys = tx.transaction.message.staticAccountKeys;
      const target = keys.findIndex((k) => k.equals(pubkey));
      if (target < 0) return PublicKey.default.toBase58();
      if (tx.meta.postBalances[target] <= tx.meta.preBalances[target]) {
        return PublicKey.default.toBase58();
      }

      // The funder is whoever lost lamports and is not the fee payer's own
      // rent-exempt shuffle; the largest debit is the deposit.
      let best = -1;
      let bestDelta = 0;
      for (let i = 0; i < keys.length; i++) {
        if (i === target) continue;
        const delta = tx.meta.preBalances[i] - tx.meta.postBalances[i];
        if (delta > bestDelta) {
          bestDelta = delta;
          best = i;
        }
      }
      return best >= 0 ? keys[best].toBase58() : PublicKey.default.toBase58();
    } catch (err) {
      console.warn("[resolveSender] failed for", burnerAddress, err);
      return PublicKey.default.toBase58();
    }
  }

  /** The signature of the transaction that funded a burner. A ledger pointer. */
  private async resolveDepositTxSig(burnerAddress: string): Promise<string> {
    try {
      const sigs = await this.getConnection().getSignaturesForAddress(
        new PublicKey(burnerAddress),
        { limit: 20 },
      );
      return sigs.length > 0 ? sigs[sigs.length - 1].signature : UNKNOWN_SIGNATURE;
    } catch {
      return UNKNOWN_SIGNATURE;
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
  /**
   * @deprecated Use {@link resumePending}, which this now delegates to.
   *
   * This used to run its own nonce-chain scan and act only on unswept burners,
   * in parallel with the recovery path's note-driven plan. Two discovery paths
   * over the same funds could disagree about what was outstanding; there is
   * now one.
   */
  async shredPendingDeposits(): Promise<
    Array<{ plan: PendingAction; ok: boolean; error?: string }>
  > {
    if (!this._initialized || !this._walletPubkey) {
      throw new Error("ShredrClient not initialized");
    }
    return this.resumePending();
  }

  /**
   * Every delegated PDA currently holding funds, newest first.
   *
   * Replaces reading a single consolidation account: without a hub the balance
   * is spread across one PDA per deposit, so both the balance display and a
   * withdrawal have to gather them.
   *
   * Reads live state rather than the note's recorded `lamports`, which is only
   * as fresh as the last write.
   */
  private async fundedSources(): Promise<
    Array<{ note: UtxoNote; pda: PublicKey; lamports: number; depositTs: bigint }>
  > {
    await this.adoptUnrecordedUtxos();

    const sources: Array<{
      note: UtxoNote;
      pda: PublicKey;
      lamports: number;
      depositTs: bigint;
    }> = [];

    for (const note of utxoService.unsettled) {
      if (note.role !== "deposit") continue;

      try {
        const pda = new PublicKey(note.stealthPda);
        const { state } = await this.readStealthState(pda);
        const lamports = state ? Number(state.depositedAmount) : 0;
        // Carried through so receipt building does not re-read the account: the
        // program's Clock value is authoritative and already in hand here.
        const depositTs = state ? state.depositTimestamp : 0n;
        if (lamports > 0) sources.push({ note, pda, lamports, depositTs });
      } catch (err) {
        console.warn("[fundedSources] skipped", note.stealthPda, err);
      }
    }

    return sources.sort((a, b) => b.note.createdAt - a.note.createdAt);
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
    /** The single source's PDA, or null when the balance spans several. */
    address: string | null;
    /** How many PDAs the balance is spread across. */
    sources: number;
    delegated: boolean;
  }> {
    if (!this._initialized) {
      throw new Error("ShredrClient not initialized. Call initFromSignature first.");
    }

    // Delegation zeroes the base-layer copy, so a delegated PDA reads as empty
    // on base; `readStealthState` inside `fundedSources` falls through to the
    // rollup.
    const sources = await this.fundedSources();
    const lamports = sources.reduce((sum, s) => sum + s.lamports, 0);

    return {
      available: lamports / LAMPORTS_PER_SOL,
      availableLamports: lamports,
      address: sources.length === 1 ? sources[0].pda.toBase58() : null,
      sources: sources.length,
      delegated: sources.length > 0,
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

    // A funded, delegated deposit PDA is the resting state of a shielded
    // balance, not an interrupted cycle — `getStealthBalance` sums exactly this
    // set. Recovery must leave it alone. Treating it as pending would push it
    // to an exit PDA and, a pass later, withdraw it to the connected wallet:
    // the user's whole balance swept out unprompted on sign-in.
    //
    // Only two things are genuinely stranded: an exit PDA, which exists solely
    // inside a withdrawal the user already asked for, and a deposit that cannot
    // currently be spent.
    if (role === "deposit") {
      if (state.delegated) {
        // Spendable and at rest, or drained and awaiting cleanup.
        return lamports > 0
          ? null
          : { note, action: "undelegate", lamports: 0 };
      }

      // Undelegated: it counts toward the balance but `PrivateTransfer` cannot
      // move it, so it has to be re-delegated before it is spendable again.
      // `InitializeAndDelegate` reuses an existing undelegated PDA.
      return lamports > 0
        ? { note, action: "initialize", lamports }
        : { note, action: "close", lamports: 0 };
    }

    // Exit PDA: always mid-withdrawal, so always finish it.
    if (state.delegated) {
      return { note, action: "undelegate", lamports };
    }
    return lamports > 0
      ? { note, action: "withdraw", lamports }
      : { note, action: "close", lamports: 0 };
  }

  /**
   * Inspect every unsettled note and report what would be done. Read-only —
   * callers show this before {@link resumePending} acts on it.
   */
  async planPending(): Promise<PendingAction[]> {
    if (!this._initialized) throw new Error("ShredrClient not initialized");

    await this.adoptUnrecordedUtxos();

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
   * Fold anything the chain walk finds into the note tree.
   *
   * The tree is the source of truth for role, but it can miss a PDA: a crash
   * between broadcasting and persisting, a failed blob publish, or a note
   * trimmed to fit the blob cap. The nonce-chain walk is derived purely from
   * the signature, so it still finds those.
   *
   * Running it here means there is one discovery path, not two that can
   * disagree — `planPending` sees the union and everything downstream works
   * off the tree alone.
   */
  private async adoptUnrecordedUtxos(): Promise<void> {
    let found: PendingUtxo[];
    try {
      found = await this.scanPendingUtxos();
    } catch (err) {
      // The tree alone is still a usable plan; a failed walk should not block it.
      console.warn("[adoptUnrecordedUtxos] chain walk failed:", err);
      return;
    }

    const known = new Set(utxoService.notes.map((n) => n.stealthPda));

    // Legacy: deposits used to consolidate into a single main PDA derived from
    // its own domain, not from the nonce chain — so the walk above cannot see
    // it. Anyone who shredded under that scheme still has funds there. Adopt it
    // as a deposit note so the normal path drains it, then never write to it
    // again.
    if (this._mainPda && this._mainBurner && !known.has(this._mainPda.toBase58())) {
      try {
        const { state } = await this.readStealthState(this._mainPda);
        const lamports = state ? Number(state.depositedAmount) : 0;
        if (lamports > 0) {
          await utxoService.record({
            nonceIndex: this._mainBurner.nonceIndex,
            role: "deposit",
            burnerAddress: this._mainBurner.address,
            stealthPda: this._mainPda.toBase58(),
            state: state?.delegated ? "delegated" : "undelegated",
            lamports,
          });
          known.add(this._mainPda.toBase58());
        }
      } catch (err) {
        console.warn("[adoptUnrecordedUtxos] legacy main PDA probe failed:", err);
      }
    }

    for (const utxo of found) {
      if (known.has(utxo.stealthPda)) continue;

      // A funded burner with no PDA is by definition a deposit that never got
      // swept; anything else takes the role the chain reported.
      const role: UtxoRole =
        utxo.status === "received" ? "deposit" : (utxo.role ?? "deposit");

      const state: UtxoState =
        utxo.status === "received"
          ? "pending_init"
          : utxo.status === "delegated"
            ? "delegated"
            : "undelegated";

      try {
        await utxoService.record({
          nonceIndex: utxo.nonceIndex,
          role,
          burnerAddress: utxo.burnerAddress,
          stealthPda: utxo.stealthPda,
          state,
          lamports: utxo.lamports,
        });
      } catch (err) {
        console.warn("[adoptUnrecordedUtxos] could not record", utxo.stealthPda, err);
      }
    }
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
        role:
          pdaState?.role === STEALTH_ROLE.exit
            ? "exit"
            : pdaState?.role === STEALTH_ROLE.deposit
              ? "deposit"
              : undefined,
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

