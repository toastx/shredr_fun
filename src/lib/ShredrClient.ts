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
import { ShadowWireClient } from "./ShadowWireClient";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SWEEP_FEE_BUFFER_LAMPORTS, SWEEP_THRESHOLD_LAMPORTS } from "./constants";
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
    // Initialize nonce service to enable storage access
    await nonceService.initFromSignature(signature);

    // Try local storage first
    const nonce = await nonceService.loadCurrentNonce(walletPubkey);
    if (nonce) {
      return false;
    }

    // Try remote backend if fetch function provided
    if (fetchBlobsFn) {
      try {
        const blobs = await fetchBlobsFn();
        const result = await nonceService.tryDecryptBlobs(blobs);
        if (result.found && result.nonce) {
          return false;
        }
      } catch (err) {
        console.warn("Failed to fetch blobs from backend:", err);
      }
    }

    // No nonce found - new user
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
    // 1. Initialize both services
    await nonceService.initFromSignature(signature);
    await burnerService.initFromSignature(signature);

    // Store wallet pubkey for Shadowire Address derivation
    this._walletPubkey = walletPubkey;

    // 2. Derive the Shadowire Address (burner[0]) - always same for this wallet
    // IMPORTANT: Use generateNonceAtIndex(0) here, NOT generateBaseNonce().
    // Both produce identical nonces for index 0: SHA256(masterSeed)
    // But generateNonceAtIndex() is SIDE-EFFECT FREE - it doesn't modify
    // the current state or save to storage. This is critical because we
    // need to check for existing state in step 3/4 before setting up new user state.
    const baseNonce = await nonceService.generateNonceAtIndex(0, walletPubkey);
    this._shadowireBurner =
      await burnerService.deriveShadowireAddress(baseNonce);

    // 3. Try local storage first for current spending nonce
    let nonce = await nonceService.loadCurrentNonce(walletPubkey);
    if (!nonce) {
      // 4. Try remote backend if fetch function provided
      if (fetchBlobsFn) {
        try {
          const blobs = await fetchBlobsFn();
          const result = await nonceService.tryDecryptBlobs(blobs);

          if (result.found && result.nonce) {
            // Found in remote - sync to local
            await nonceService.setCurrentState(result.nonce);
            nonce = result.nonce;
            this._currentBlobId = result.blobId ?? null;
          }
        } catch (err) {
          console.warn("Failed to fetch blobs from backend:", err);
        }
      }
    }
    if (!nonce) {
      // 5. New user - generate base nonce (index 0), then increment to index 1
      // burner[0] is RESERVED for Shadowire Address (pool accumulator)
      // burner[1+] are spending burners for receiving public SOL
      await nonceService.generateBaseNonce(walletPubkey);
      nonce = await nonceService.incrementNonce(); // Move to index 1
      this._isNewUser = true;

      // Upload to backend if function provided
      if (createBlobFn) {
        try {
          const blobData = await nonceService.createBlobData(nonce);
          const newBlob = await createBlobFn(blobData);
          this._currentBlobId = newBlob.id;
        } catch (err) {
          console.warn("Failed to upload blob to backend:", err);
        }
      }
    } else {
      this._isNewUser = false;
    }

    // Safety check: ensure current nonce is not the same as burner[0] nonce
    // This protects burner[0] from being used for receiving public SOL
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
  /**
   * Set signing mode (auto or manual)
   */
  setSigningMode(mode: SigningMode): void {
    this._signingMode = mode;
  }
  // ============ BURNER MANAGEMENT ============
  /**
   * Consume current nonce and generate new burner
   * Call this after a burner has been used (funds swept)
   */
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

  /**
   * Check if the current burner has funds in the ShadowWire pool that haven't
   * been transferred to burner[0] yet. This can happen if:
   * - A previous deposit succeeded but internal transfer failed
   * - The user disconnected/refreshed mid-sweep
   * 
   * @param rpcUrl - Optional Solana RPC URL
   * @returns Object with hasPending flag and balance info
   */
  async checkPendingPoolBalance(rpcUrl?: string): Promise<{
    hasPending: boolean;
    poolBalanceSol: number;
    poolBalanceLamports: number;
  }> {
    if (!this._initialized || !this._currentBurner) {
      return { hasPending: false, poolBalanceSol: 0, poolBalanceLamports: 0 };
    }

    const client = new ShadowWireClient(rpcUrl);
    const balance = await client.getBalanceForAddress(this._currentBurner.address);

    return {
      hasPending: balance.available > 0,
      poolBalanceSol: balance.available,
      poolBalanceLamports: balance.availableLamports,
    };
  }

  /**
   * Complete a pending pool transfer - transfers any funds in the current
   * burner's pool to burner[0] (Shadowire Address).
   * 
   * @param rpcUrl - Optional Solana RPC URL
   * @returns The internal transfer signature, or null if no funds to transfer
   */
  async completePendingPoolTransfer(rpcUrl?: string): Promise<string | null> {
    if (!this._initialized || !this._currentBurner) {
      throw new Error("ShredrClient not initialized");
    }
    if (!this._shadowireBurner) {
      throw new Error("Shadowire burner not available");
    }

    // Check pool balance
    const { hasPending, poolBalanceSol } = await this.checkPendingPoolBalance(rpcUrl);

    if (!hasPending || poolBalanceSol <= 0) {
      console.log("No pending pool balance to transfer");
      return null;
    }

    console.log(`Found ${poolBalanceSol} SOL in burner pool - completing transfer...`);

    // Create client with current burner
    const shadowWireClient = new ShadowWireClient(rpcUrl);
    const burnerKeypair = Keypair.fromSecretKey(this._currentBurner.secretKey);
    shadowWireClient.setKeypair(burnerKeypair);

    // Transfer to burner[0]
    const shadowireAddress = this._shadowireBurner.address;
    console.log(`Transferring ${poolBalanceSol} SOL to Shadowire Address: ${shadowireAddress}...`);

    const transferSig = await shadowWireClient.transferInternal(
      shadowireAddress,
      poolBalanceSol,
    );
    console.log(`Pool transfer completed: ${transferSig}`);

    // Rotate to new burner after successful transfer
    await this.consumeAndGenerateNew();

    return transferSig;
  }
  // ============ TRANSACTION HANDLING ============

  /**
   * Handle incoming transaction when balance exceeds threshold
   * Called when burner balance is detected above MIN_SWEEP_THRESHOLD
   *
   * In auto mode: executes sweep immediately
   * In manual mode: returns pending transaction for UI approval
   *
   * @param balanceLamports - Current burner balance in lamports
   * @returns IncomingTxResult with approval status and optional sweep signature
   */
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
      // Auto mode - sweep immediately
      // Use trustBalance since we got the balance from WebSocket
      console.log(
        `Auto-sweep triggered: ${balanceLamports / LAMPORTS_PER_SOL} SOL`,
      );
      const sweepSig = await this.executeSweep(balanceLamports, undefined, true);
      return { needsApproval: false, sweepSignature: sweepSig };
    } else {
      // Manual mode - return for approval
      return { needsApproval: true, pendingTx };
    }
  }

  /**
   * Approve and execute sweep for a pending transaction (manual mode)
   * @param pendingTx - The pending transaction to approve
   * @returns The sweep signature
   */
  async approveSweep(pendingTx: PendingTransaction): Promise<string> {
    if (!this._initialized || !this._currentBurner) {
      throw new Error("ShredrClient not initialized");
    }
    return await this.executeSweep(pendingTx.amount);
  }

  /**
   * Execute sweep by transferring internally to the shadowwire burner address (burner[0])
   *
   * Flow:
   * 1. Deposit public SOL into ShadowWire pool
   * 2. Query actual pool balance (accounts for tx fees)
   * 3. Internal transfer FULL pool balance to burner[0]
   * 4. Rotate to new burner
   *
   * @param amountInLamports - Amount to sweep in lamports
   * @param rpcUrl - Optional Solana RPC URL
   * @param trustBalance - If true, skip RPC balance verification (use when WebSocket already confirmed balance)
   * @returns The internal transfer signature
   */
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

    // Create ShadowWire client with the current burner's keypair
    const shadowWireClient = new ShadowWireClient(rpcUrl);
    const burnerKeypair = Keypair.fromSecretKey(this._currentBurner.secretKey);
    shadowWireClient.setKeypair(burnerKeypair);
    
    console.log(`Sweep: Using burner address ${this._currentBurner.address}`);

    let amountToDeposit: number;
    
    if (trustBalance) {
      // Trust the caller's balance (from WebSocket) - just subtract fee buffer
      amountToDeposit = amountInLamports - SWEEP_FEE_BUFFER_LAMPORTS;
      console.log(`Sweep: Trusting WebSocket balance: ${amountInLamports}, depositing: ${amountToDeposit}`);
    } else {
      // Verify with RPC (may have propagation delay)
      const walletBalance = await shadowWireClient.getWalletBalance();
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

    // Step 1: Deposit funds into ShadowWire pool (shielding) with retry
    const MAX_DEPOSIT_RETRIES = 3;
    const DEPOSIT_RETRY_DELAY = 2000;
    let depositResult: { signature: string; userBalancePda: string } | null = null;
    let depositAmountToUse = amountToDeposit;

    for (let attempt = 1; attempt <= MAX_DEPOSIT_RETRIES; attempt++) {
      try {
        const amountToDepositSol = depositAmountToUse / LAMPORTS_PER_SOL;
        console.log(
          `Sweep Step 1: Depositing ${amountToDepositSol} SOL (Attempt ${attempt}/${MAX_DEPOSIT_RETRIES})...`,
        );
        
        depositResult = await shadowWireClient.deposit(amountToDepositSol);
        console.log(`Sweep: Deposit successful: ${depositResult.signature}`);
        break; // Success
      } catch (err) {
        console.error(`Sweep: Deposit attempt ${attempt} failed:`, err);
        
        // If we failed due to insufficient funds in simulation, re-query balance
        const errorMsg = String(err);
        if (errorMsg.includes("insufficient lamports") || errorMsg.includes("0x1")) {
          console.log("Sweep: Simulation failed with insufficient funds. Re-querying wallet balance...");
          const freshWalletBalance = await shadowWireClient.getWalletBalance();
          depositAmountToUse = freshWalletBalance - SWEEP_FEE_BUFFER_LAMPORTS;
          
          // Throw immediately if fresh balance is still insufficient
          if (depositAmountToUse <= 0) {
            throw new Error(
              `Insufficient funds after re-query: wallet has ${freshWalletBalance} lamports, need > ${SWEEP_FEE_BUFFER_LAMPORTS} for fees.`
            );
          }
        }

        if (attempt === MAX_DEPOSIT_RETRIES) {
          throw err; // Re-throw if last attempt fails
        }
        
        console.log(`Sweep: Retrying deposit in ${DEPOSIT_RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, DEPOSIT_RETRY_DELAY));
      }
    }

    if (!depositResult) throw new Error("Deposit failed after retries");

    // Wait for PDA initialization on first deposit
    console.log(`Sweep: Waiting for PDA initialization...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 2: Query pool balance with retry (PDA may take time to reflect)
    console.log(`Sweep Step 2: Checking pool balance after deposit...`);
    
    const MAX_BALANCE_RETRIES = 3;
    const BALANCE_RETRY_DELAY = 2000;
    let actualPoolBalanceSol = 0;
    
    for (let attempt = 1; attempt <= MAX_BALANCE_RETRIES; attempt++) {
      const poolBalance = await shadowWireClient.getBalance();
      actualPoolBalanceSol = poolBalance.available;
      console.log(`Sweep: Pool balance check attempt ${attempt}: ${actualPoolBalanceSol} SOL`);
      
      if (actualPoolBalanceSol > 0) {
        break;
      }
      
      if (attempt < MAX_BALANCE_RETRIES) {
        console.log(`Sweep: Balance is 0, retrying in ${BALANCE_RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, BALANCE_RETRY_DELAY));
      }
    }

    if (actualPoolBalanceSol <= 0) {
      throw new Error(
        `Pool balance is 0 after deposit. Deposit may have failed or fees consumed everything.`,
      );
    }

    // Step 3: Internal transfer with retry logic
    console.log(
      `Sweep Step 3: Transferring ${actualPoolBalanceSol} SOL internally to Shadowire Address: ${shadowireAddress}...`,
    );

    const MAX_TRANSFER_RETRIES = 3;
    const TRANSFER_RETRY_DELAY = 3000;
    const TRANSFER_TIMEOUT_MS = 30000; // 30 second total timeout
    const transferStartTime = Date.now();
    let transferSig: string | null = null;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= MAX_TRANSFER_RETRIES; attempt++) {
      // Check timeout to prevent infinite waiting
      if (Date.now() - transferStartTime > TRANSFER_TIMEOUT_MS) {
        lastError = new Error(`Transfer timeout exceeded (${TRANSFER_TIMEOUT_MS}ms)`);
        console.error("Sweep: Transfer timeout exceeded");
        break;
      }
      
      try {
        console.log(`Sweep: Internal transfer attempt ${attempt}...`);
        
        // Re-check pool balance before each attempt (it may have updated)
        if (attempt > 1) {
          const freshBalance = await shadowWireClient.getBalance();
          if (freshBalance.available > 0) {
            actualPoolBalanceSol = freshBalance.available;
            console.log(`Sweep: Fresh pool balance: ${actualPoolBalanceSol} SOL`);
          } else {
            // Balance is now 0 - throw early instead of continuing
            throw new Error("Pool balance is now 0 - cannot proceed with transfer");
          }
        }
        
        transferSig = await shadowWireClient.transferInternal(
          shadowireAddress,
          actualPoolBalanceSol,
        );
        console.log(`Sweep: Internal transfer successful: ${transferSig}`);
        break; // Success!
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`Sweep: Internal transfer attempt ${attempt} failed:`, lastError.message);
        
        if (attempt < MAX_TRANSFER_RETRIES) {
          console.log(`Sweep: Retrying in ${TRANSFER_RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, TRANSFER_RETRY_DELAY));
        }
      }
    }
    
    if (!transferSig) {
      // All retries failed - save state for manual recovery
      console.error("Sweep: All internal transfer attempts failed!");
      console.log(
        `Recovery: Funds deposited but not transferred. Pool has ${actualPoolBalanceSol} SOL.`,
      );

      // Store pending sweep info for recovery (no secret key - use nonce index instead)
      // SECURITY: We intentionally do NOT store the secret key to minimize exposure
      this._pendingSweep = {
        burnerAddress: this._currentBurner.address,
        burnerNonceIndex: this._currentNonce?.index ?? -1,
        poolBalance: actualPoolBalanceSol,
        timestamp: Date.now(),
      };

      throw new Error(
        `Internal transfer failed after ${MAX_TRANSFER_RETRIES} attempts. Funds are safe in pool. Error: ${lastError?.message}`,
      );
    }

    // Clear any pending sweep state since we succeeded
    this._pendingSweep = null;

    // Step 4: Rotate nonce/burner after successful sweep
    await this.consumeAndGenerateNew();

    return transferSig;
  }

  // Pending sweep state for recovery
  // SECURITY: We store nonce index instead of secret key to minimize key exposure in memory
  private _pendingSweep: {
    burnerAddress: string;
    burnerNonceIndex: number; // Used to re-derive the burner keypair for recovery
    poolBalance: number;
    timestamp: number;
  } | null = null;

  /**
   * Check if there's a pending sweep that needs recovery
   */
  get hasPendingSweep(): boolean {
    return this._pendingSweep !== null;
  }

  /**
   * Get info about pending sweep (if any)
   */
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

  /**
   * Recover a pending sweep by retrying the internal transfer
   * Use this after executeSweep failed at the internal transfer step
   */
  async recoverPendingSweep(rpcUrl?: string): Promise<string> {
    if (!this._pendingSweep) {
      throw new Error("No pending sweep to recover");
    }
    if (!this._shadowireBurner) {
      throw new Error("Shadowire burner not available");
    }
    if (!this._walletPubkey) {
      throw new Error("Wallet pubkey not available - call initFromSignature first");
    }

    console.log(`Recovery: Attempting to recover sweep for nonce index ${this._pendingSweep.burnerNonceIndex}...`);

    // Re-derive the burner keypair from the stored nonce index
    // SECURITY: This avoids keeping the secret key in memory long-term
    const recoveryNonce = await nonceService.generateNonceAtIndex(
      this._pendingSweep.burnerNonceIndex,
      this._walletPubkey
    );
    const recoveryBurner = await burnerService.deriveBurnerFromNonce(recoveryNonce);
    
    // Verify address matches what we expected
    if (recoveryBurner.address !== this._pendingSweep.burnerAddress) {
      console.warn(
        `Recovery: Derived address ${recoveryBurner.address} doesn't match expected ${this._pendingSweep.burnerAddress}`
      );
    }

    // Create client with the re-derived burner keypair
    const shadowWireClient = new ShadowWireClient(rpcUrl);
    const burnerKeypair = Keypair.fromSecretKey(recoveryBurner.secretKey);
    shadowWireClient.setKeypair(burnerKeypair);

    // Check current pool balance (it may have changed)
    const poolBalance = await shadowWireClient.getBalance();
    const currentPoolBalanceSol = poolBalance.available;
    console.log(`Recovery: Current pool balance: ${currentPoolBalanceSol} SOL`);

    if (currentPoolBalanceSol <= 0) {
      // Clear the recovery burner before clearing pending state
      burnerService.clearBurner(recoveryBurner);
      this._pendingSweep = null;
      throw new Error("Pool balance is 0 - nothing to recover");
    }

    // Retry internal transfer
    const shadowireAddress = this._shadowireBurner.address;
    console.log(
      `Recovery: Retrying internal transfer of ${currentPoolBalanceSol} SOL to ${shadowireAddress}...`,
    );

    try {
      const transferSig = await shadowWireClient.transferInternal(
        shadowireAddress,
        currentPoolBalanceSol,
      );
      console.log(`Recovery: Internal transfer successful: ${transferSig}`);

      // Clear pending state and zero out recovery keypair
      burnerService.clearBurner(recoveryBurner);
      this._pendingSweep = null;

      // Rotate nonce/burner
      await this.consumeAndGenerateNew();

      return transferSig;
    } finally {
      // SECURITY: Always zero out the recovery keypair, even on failure
      burnerService.clearBurner(recoveryBurner);
    }
  }

  // ============ SHADOWIRE BALANCE & WITHDRAW ============

  /**
   * Get the balance at the Shadowire Address (burner[0])
   * This is the user's "private" balance available for withdrawal.
   *
   * @param rpcUrl - Solana RPC URL (defaults to HELIUS_RPC_URL env var or mainnet)
   */
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

    console.log(`getShadowireBalance: Querying balance for address: ${this._shadowireBurner.address}`);
    
    // Create a temporary ShadowWire client to check balance
    const client = new ShadowWireClient(rpcUrl);
    const balance = await client.getBalanceForAddress(this._shadowireBurner.address);
    
    console.log(`getShadowireBalance: Result:`, {
      available: balance.available,
      availableLamports: balance.availableLamports,
      poolAddress: balance.poolAddress
    });
    
    return balance;
  }

  /**
   * Get the shielded balance of the current burner (post-deposit, pre-sweep)
   */
  async getCurrentBurnerShieldedBalance(rpcUrl?: string): Promise<{
    available: number;
    availableLamports: number;
    poolAddress: string;
  } | null> {
    if (!this._currentBurner) return null;

    const client = new ShadowWireClient(rpcUrl);
    return client.getBalanceForAddress(this._currentBurner.address);
  }

  /**
   * Withdraw funds from Shadowire Address to a destination wallet.
   * Uses external transfer (sender anonymous, amount visible).
   *
   * @param destinationAddress - The wallet address to send funds to
   * @param amountInSol - Amount to withdraw in SOL (use 'all' to withdraw everything)
   * @param rpcUrl - Solana RPC URL (defaults to _RPC_URL env var or mainnet)
   */ async withdrawToWallet(
    destinationAddress: string,
    amountInSol: number | "all",
    rpcUrl?: string,
  ): Promise<{ signature: string; amount: number }> {
    if (!this._shadowireBurner) {
      throw new Error(
        "Shadowire Address not derived. Call initFromSignature first.",
      );
    }

    // Create ShadowWire client with the burner keypair
    const client = new ShadowWireClient(rpcUrl);
    const keypair = Keypair.fromSecretKey(this._shadowireBurner.secretKey);
    
    // Get balance if withdrawing all (check BEFORE setting keypair to be consistent with UI)
    let withdrawAmount: number;
    if (amountInSol === "all") {
      const balance = await client.getBalanceForAddress(this._shadowireBurner.address);
      console.log(`Withdraw: Shadowire balance check: ${balance.available} SOL (${balance.availableLamports} lamports)`);
      if (balance.available <= 0) {
        throw new Error(`No balance to withdraw from Shadowire pool. Pool balance: ${balance.availableLamports} lamports`);
      }
      withdrawAmount = balance.available;
    } else {
      withdrawAmount = amountInSol;
    }
    
    // Set keypair for the actual transfer
    client.setKeypair(keypair);
    console.log(`Withdraw: Using keypair ${keypair.publicKey.toString()}`)

    // Perform external transfer from burner[0] to destination
    const signature = await client.transferExternal(
      destinationAddress,
      withdrawAmount,
    );

    return {
      signature,
      amount: withdrawAmount,
    };
  }

  // ============ CLEANUP ============
  /**
   * Clean up all resources
   */
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
