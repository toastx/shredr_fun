/**
 * ShredrClient - Main orchestrator for SHREDR privacy wallet
 *
 * Coordinates NonceService and BurnerService to provide:
 * - Initialization from wallet signature
 * - Burner address generation
 * - Transaction sweeping (auto/manual mode)
 * - State management
 */
import { nonceService } from "./NonceService";
import { burnerService } from "./BurnerService";
import { apiClient } from "./ApiClient";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  SWEEP_FEE_BUFFER_LAMPORTS,
  SWEEP_THRESHOLD_LAMPORTS,
} from "./constants";
import type { GeneratedNonce, BurnerKeyPair, CreateBlobRequest } from "./types";

// ============ TYPES ============
export type SigningMode = "auto" | "manual";
export interface PendingTransaction {
  amount: number; // SOL amount (lamports)
  signature: string; // Transaction signature
  from: string; // Sender address
  timestamp: number; // Unix timestamp
}

export interface IncomingTxResult {
  needsApproval: boolean;
  pendingTx?: PendingTransaction;
  sweepSignature?: string;
}

export interface ShredrState {
  initialized: boolean;
  currentNonce: GeneratedNonce | null;
  currentBurner: BurnerKeyPair | null;
  shadowireAddress: string | null; // The stable receiving address (burner[0])
  signingMode: SigningMode;
  currentBlobId: string | null;
}

// ============ SHREDR CLIENT ============
export class ShredrClient {
  private _initialized = false;
  private _currentNonce: GeneratedNonce | null = null;
  private _currentBurner: BurnerKeyPair | null = null;
  private _shadowireBurner: BurnerKeyPair | null = null; // burner[0] - stable receiving address
  private _walletPubkey: Uint8Array | null = null;
  private _signingMode: SigningMode = "auto";
  private _currentBlobId: string | null = null;
  private _isNewUser = false;

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
   * The user's stable "Shadowire Address" - burner[0]
   * This is the address they share for receiving private payments.
   */
  get shadowireAddress(): string | null {
    return this._shadowireBurner?.address ?? null;
  }
  /**
   * The full burner keypair for Shadowire Address (needed for withdrawals)
   */
  get shadowireBurner(): BurnerKeyPair | null {
    return this._shadowireBurner;
  }
  get signingMode(): SigningMode {
    return this._signingMode;
  }
  get isNewUser(): boolean {
    return this._isNewUser;
  }
  get state(): ShredrState {
    return {
      initialized: this._initialized,
      currentNonce: this._currentNonce,
      currentBurner: this._currentBurner,
      shadowireAddress: this._shadowireBurner?.address ?? null,
      signingMode: this._signingMode,
      currentBlobId: this._currentBlobId,
    };
  }

  // ============ USER STATUS CHECK ============
  /**
   * Check if user is new without initializing the full client
   * Returns true if no existing nonce found in local or remote storage
   */
  async checkIfNewUser(
    signature: Uint8Array,
    walletPubkey: Uint8Array,
    fetchBlobsFn: () => Promise<
      Array<{ id: string; encryptedBlob: string; createdAt: number }>
    > = () => apiClient.fetchAllBlobs(),
  ): Promise<boolean> {
    console.log("[checkIfNewUser] Starting check...");

    // Initialize nonce service to enable storage access
    await nonceService.initFromSignature(signature);
    console.log("[checkIfNewUser] NonceService initialized");

    // Try local storage first
    const nonce = await nonceService.loadCurrentNonce(walletPubkey);
    console.log(
      "[checkIfNewUser] Local storage nonce:",
      nonce ? `index=${nonce.index}` : "null",
    );
    if (nonce) {
      return false;
    }

    // Try remote backend if fetch function provided
    if (fetchBlobsFn) {
      try {
        console.log("[checkIfNewUser] Fetching blobs from backend...");
        const blobs = await fetchBlobsFn();
        console.log("[checkIfNewUser] Backend returned blobs:", blobs.length);

        const result = await nonceService.tryDecryptBlobs(blobs);
        console.log("[checkIfNewUser] tryDecryptBlobs result:", {
          found: result.found,
          blobId: result.blobId,
          nonceIndex: result.nonce?.index,
        });

        if (result.found && result.nonce) {
          return false;
        }
      } catch (err) {
        console.warn(
          "[checkIfNewUser] Failed to fetch blobs from backend:",
          err,
        );
      }
    }

    // No nonce found - new user
    console.log("[checkIfNewUser] No nonce found - treating as new user");
    return true;
  }

  // ============ INITIALIZATION ============
  /**
   * Initialize ShredrClient with wallet signature
   * This follows the flow from SKILL.md:
   * 1. Init services from signature
   * 2. Check local storage for nonce
   * 3. If not found, check backend
   * 4. If not found, generate new base nonce
   * 5. Derive burner from nonce
   */
  async initFromSignature(
    signature: Uint8Array,
    walletPubkey: Uint8Array,
    fetchBlobsFn: () => Promise<
      Array<{ id: string; encryptedBlob: string; createdAt: number }>
    > = () => apiClient.fetchAllBlobs(),
    createBlobFn: (data: CreateBlobRequest) => Promise<{ id: string }> = (
      data,
    ) => apiClient.createBlob(data),
  ): Promise<void> {
    console.log("[initFromSignature] Starting initialization...");

    // 1. Initialize both services
    await nonceService.initFromSignature(signature);
    await burnerService.initFromSignature(signature);
    console.log("[initFromSignature] Services initialized");

    // Store wallet pubkey for Shadowire Address derivation
    this._walletPubkey = walletPubkey;

    // 2. Derive the Shadowire Address (burner[0]) - always same for this wallet
    const baseNonce = await nonceService.generateNonceAtIndex(0, walletPubkey);
    this._shadowireBurner =
      await burnerService.deriveShadowireAddress(baseNonce);
    console.log(
      "[initFromSignature] Shadowire address derived:",
      this._shadowireBurner?.address,
    );

    // 3. Try local storage first for current spending nonce
    let nonce = await nonceService.loadCurrentNonce(walletPubkey);
    console.log(
      "[initFromSignature] Local storage nonce:",
      nonce ? `index=${nonce.index}` : "null",
    );

    if (!nonce) {
      // 4. Try remote backend if fetch function provided
      if (fetchBlobsFn) {
        try {
          console.log("[initFromSignature] Fetching blobs from backend...");
          const blobs = await fetchBlobsFn();
          console.log(
            "[initFromSignature] Backend returned blobs:",
            blobs.length,
          );

          const result = await nonceService.tryDecryptBlobs(blobs);
          console.log("[initFromSignature] tryDecryptBlobs result:", {
            found: result.found,
            blobId: result.blobId,
            nonceIndex: result.nonce?.index,
          });

          if (result.found && result.nonce) {
            // Found in remote - sync to local
            console.log(
              "[initFromSignature] Syncing remote nonce to local storage...",
            );
            await nonceService.setCurrentState(result.nonce);
            nonce = result.nonce;
            this._currentBlobId = result.blobId ?? null;
          }
        } catch (err) {
          console.warn(
            "[initFromSignature] Failed to fetch blobs from backend:",
            err,
          );
        }
      }
    }
    if (!nonce) {
      // 5. New user - generate base nonce (index 0), then increment to index 1
      console.log(
        "[initFromSignature] No nonce found - generating new base nonce (NEW USER)",
      );
      await nonceService.generateBaseNonce(walletPubkey);
      nonce = await nonceService.incrementNonce(); // Move to index 1
      console.log(
        "[initFromSignature] New nonce generated at index:",
        nonce.index,
      );
      this._isNewUser = true;

      // Upload to backend if function provided
      if (createBlobFn) {
        try {
          const blobData = await nonceService.createBlobData(nonce);
          const newBlob = await createBlobFn(blobData);
          this._currentBlobId = newBlob.id;
          console.log(
            "[initFromSignature] Blob uploaded to backend:",
            newBlob.id,
          );
        } catch (err) {
          console.warn(
            "[initFromSignature] Failed to upload blob to backend:",
            err,
          );
        }
      }
    } else {
      console.log(
        "[initFromSignature] Returning user - using nonce at index:",
        nonce.index,
      );
      this._isNewUser = false;
    }

    const isSameAsBaseNonce =
      nonce.nonce.length === baseNonce.nonce.length &&
      nonce.nonce.every((byte, i) => byte === baseNonce.nonce[i]);

    if (isSameAsBaseNonce) {
      console.warn(
        "Current nonce matches burner[0] - incrementing to protect Shadowire Address",
      );
      nonce = await nonceService.incrementNonce();
    }

    this._currentNonce = nonce;
    // 6. Derive current spending burner from nonce (index 1+)
    this._currentBurner = await burnerService.deriveBurnerFromNonce(nonce);
    this._initialized = true;
  }

  // ============ SIGNING MODE ============
  setSigningMode(mode: SigningMode): void {
    this._signingMode = mode;
  }

  // ============ BURNER MANAGEMENT ============
  async consumeAndGenerateNew(
    createBlobFn: (data: CreateBlobRequest) => Promise<{ id: string }> = (
      data,
    ) => apiClient.createBlob(data),
    deleteBlobFn: (id: string) => Promise<boolean> = (id) =>
      apiClient.deleteBlob(id),
  ): Promise<BurnerKeyPair> {
    if (!this._initialized || !this._currentNonce) {
      throw new Error("ShredrClient not initialized");
    }
    // Clear old burner from memory
    if (this._currentBurner) {
      burnerService.clearBurner(this._currentBurner);
    }
    // Consume nonce and get new one
    const { newNonce, newBlobData } = await nonceService.consumeNonce();
    const oldBlobId = this._currentBlobId;
    // Sync with backend
    if (createBlobFn) {
      try {
        const newBlob = await createBlobFn(newBlobData);
        this._currentBlobId = newBlob.id;
      } catch (err) {
        console.warn("Failed to upload new blob:", err);
      }
    }
    if (deleteBlobFn && oldBlobId) {
      try {
        await deleteBlobFn(oldBlobId);
      } catch (err) {
        console.warn("Failed to delete old blob:", err);
      }
    }
    this._currentNonce = newNonce;
    // Derive new burner
    this._currentBurner = await burnerService.deriveBurnerFromNonce(newNonce);
    return this._currentBurner;
  }

  // ============ PENDING POOL TRANSFER RECOVERY ============

  async checkPendingPoolBalance(rpcUrl?: string): Promise<{
    hasPending: boolean;
    poolBalanceSol: number;
    poolBalanceLamports: number;
  }> {
    if (!this._initialized || !this._currentBurner) {
      return { hasPending: false, poolBalanceSol: 0, poolBalanceLamports: 0 };
    }

    // TODO: implement with new provider
    return {
      hasPending: false,
      poolBalanceSol: 0,
      poolBalanceLamports: 0,
    };
  }

  async completePendingPoolTransfer(rpcUrl?: string): Promise<string | null> {
    if (!this._initialized || !this._currentBurner) {
      throw new Error("ShredrClient not initialized");
    }
    if (!this._shadowireBurner) {
      throw new Error("Shadowire burner not available");
    }

    // Check pool balance
    const { hasPending, poolBalanceSol } =
      await this.checkPendingPoolBalance(rpcUrl);

    if (!hasPending || poolBalanceSol <= 0) {
      console.log("No pending pool balance to transfer");
      return null;
    }

    console.log(
      `Found ${poolBalanceSol} SOL in burner pool - completing transfer...`,
    );

    // TODO: implement with new provider
    const transferSig = "dummy_transfer_sig";
    console.log(`Pool transfer completed: ${transferSig}`);

    // Rotate to new burner after successful transfer
    await this.consumeAndGenerateNew();

    return transferSig;
  }

  // ============ TRANSACTION HANDLING ============

  async incomingTx(balanceLamports: number): Promise<IncomingTxResult> {
    if (!this._initialized || !this._currentBurner) {
      throw new Error("ShredrClient not initialized");
    }

    // Check threshold
    if (balanceLamports < SWEEP_THRESHOLD_LAMPORTS) {
      return { needsApproval: false };
    }

    const pendingTx: PendingTransaction = {
      amount: balanceLamports,
      signature: "",
      from: "unknown",
      timestamp: Date.now(),
    };

    if (this._signingMode === "auto") {
      console.log(
        `Auto-sweep triggered: ${balanceLamports / LAMPORTS_PER_SOL} SOL`,
      );
      const sweepSig = await this.executeSweep(
        balanceLamports,
        undefined,
        true,
      );
      return { needsApproval: false, sweepSignature: sweepSig };
    } else {
      return { needsApproval: true, pendingTx };
    }
  }

  async approveSweep(pendingTx: PendingTransaction): Promise<string> {
    if (!this._initialized || !this._currentBurner) {
      throw new Error("ShredrClient not initialized");
    }
    return await this.executeSweep(pendingTx.amount);
  }

  async executeSweep(
    amountInLamports: number,
    rpcUrl?: string,
    trustBalance: boolean = false,
  ): Promise<string> {
    if (!this._initialized || !this._currentBurner) {
      throw new Error("ShredrClient not initialized");
    }
    if (!this._shadowireBurner) {
      throw new Error("Shadowire burner not available");
    }

    console.log(`Sweep: Using burner address ${this._currentBurner.address}`);

    let amountToDeposit: number;

    if (trustBalance) {
      amountToDeposit = amountInLamports - SWEEP_FEE_BUFFER_LAMPORTS;
      console.log(
        `Sweep: Trusting WebSocket balance: ${amountInLamports}, depositing: ${amountToDeposit}`,
      );
    } else {
      // TODO: Get actual wallet balance from new provider
      const walletBalance = amountInLamports;
      console.log(`Sweep: RPC wallet balance: ${walletBalance} lamports`);
      const maxSweepable = walletBalance - SWEEP_FEE_BUFFER_LAMPORTS;
      amountToDeposit = Math.min(amountInLamports, maxSweepable);
    }

    if (amountToDeposit <= 0) {
      throw new Error(
        `Insufficient funds after fees: need > ${SWEEP_FEE_BUFFER_LAMPORTS} lamports`,
      );
    }

    const shadowireAddress = this._shadowireBurner.address;

    // TODO: implement with new provider
    const transferSig = "dummy_transfer_sig";

    // Clear any pending sweep state since we succeeded
    this._pendingSweep = null;

    // Step 4: Rotate nonce/burner after successful sweep
    await this.consumeAndGenerateNew();

    return transferSig;
  }

  // Pending sweep state for recovery
  private _pendingSweep: {
    burnerAddress: string;
    burnerNonceIndex: number;
    poolBalance: number;
    timestamp: number;
  } | null = null;

  get hasPendingSweep(): boolean {
    return this._pendingSweep !== null;
  }

  get pendingSweepInfo(): {
    burnerAddress: string;
    poolBalance: number;
    timestamp: number;
  } | null {
    if (!this._pendingSweep) return null;
    return {
      burnerAddress: this._pendingSweep.burnerAddress,
      poolBalance: this._pendingSweep.poolBalance,
      timestamp: this._pendingSweep.timestamp,
    };
  }

  async recoverPendingSweep(rpcUrl?: string): Promise<string> {
    if (!this._pendingSweep) {
      throw new Error("No pending sweep to recover");
    }
    if (!this._shadowireBurner) {
      throw new Error("Shadowire burner not available");
    }
    if (!this._walletPubkey) {
      throw new Error(
        "Wallet pubkey not available - call initFromSignature first",
      );
    }

    console.log(
      `Recovery: Attempting to recover sweep for nonce index ${this._pendingSweep.burnerNonceIndex}...`,
    );

    const recoveryNonce = await nonceService.generateNonceAtIndex(
      this._pendingSweep.burnerNonceIndex,
      this._walletPubkey,
    );
    const recoveryBurner =
      await burnerService.deriveBurnerFromNonce(recoveryNonce);

    if (recoveryBurner.address !== this._pendingSweep.burnerAddress) {
      console.warn(
        `Recovery: Derived address ${recoveryBurner.address} doesn't match expected ${this._pendingSweep.burnerAddress}`,
      );
    }

    try {
      // TODO: implement with new provider
      const transferSig = "dummy_recovery_transfer_sig";

      // Clear pending state (burner cleanup happens in finally)
      this._pendingSweep = null;

      // Rotate nonce/burner
      await this.consumeAndGenerateNew();

      return transferSig;
    } finally {
      burnerService.clearBurner(recoveryBurner);
    }
  }

  // ============ SHADOWIRE BALANCE & WITHDRAW ============

  async getShadowireBalance(rpcUrl?: string): Promise<{
    available: number; // SOL amount (human readable)
    availableLamports: number; // Raw lamports
    poolAddress: string;
  }> {
    if (!this._shadowireBurner) {
      throw new Error(
        "Shadowire Address not derived. Call initFromSignature first.",
      );
    }

    console.log(
      `getShadowireBalance: Querying balance for address: ${this._shadowireBurner.address}`,
    );

    // TODO: implement with new provider
    const balance = {
      available: 0,
      availableLamports: 0,
      poolAddress: "dummy_pool",
    };

    return balance;
  }

  async getCurrentBurnerShieldedBalance(rpcUrl?: string): Promise<{
    available: number;
    availableLamports: number;
    poolAddress: string;
  } | null> {
    if (!this._currentBurner) return null;

    // TODO: implement with new provider
    return {
      available: 0,
      availableLamports: 0,
      poolAddress: "dummy_pool",
    };
  }

  async withdrawToWallet(
    destinationAddress: string,
    amountInSol: number | "all",
    rpcUrl?: string,
  ): Promise<{ signature: string; amount: number }> {
    if (!this._shadowireBurner) {
      throw new Error(
        "Shadowire Address not derived. Call initFromSignature first.",
      );
    }

    // TODO: implement with new provider
    let withdrawAmount: number = amountInSol === "all" ? 0 : amountInSol;

    const signature = "dummy_withdraw_sig";

    return {
      signature,
      amount: withdrawAmount,
    };
  }

  // ============ CLEANUP ============
  destroy(): void {
    if (this._currentBurner) {
      burnerService.clearBurner(this._currentBurner);
    }
    if (this._shadowireBurner) {
      burnerService.clearBurner(this._shadowireBurner);
    }

    nonceService.destroy();
    burnerService.destroy();
    this._initialized = false;
    this._currentNonce = null;
    this._currentBurner = null;
    this._shadowireBurner = null;
    this._walletPubkey = null;
    this._currentBlobId = null;
    this._pendingSweep = null;
    this._isNewUser = false;
  }
}

// ============ SINGLETON EXPORT ============
export const shredrClient = new ShredrClient();
