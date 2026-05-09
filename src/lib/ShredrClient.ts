/**
 * ShredrClient - Main orchestrator for SHREDR privacy wallet
 *
 * Coordinates NonceService, BurnerService, and on-chain helpers to provide:
 * - Initialization from wallet signature
 * - Burner address generation
 * - Stealth (burner[0]) balance lookup
 * - Withdrawal from stealth address to any wallet
 * - State management
 */
import { nonceService } from "./NonceService";
import { burnerService } from "./BurnerService";
import { apiClient } from "./ApiClient";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { HELIUS_RPC_URL } from "./constants";
import type { GeneratedNonce, BurnerKeyPair, CreateBlobRequest } from "./types";

// ============ TYPES ============
export type SigningMode = "auto" | "manual";

export interface ShredrState {
  initialized: boolean;
  currentNonce: GeneratedNonce | null;
  currentBurner: BurnerKeyPair | null;
  stealthAddress: string | null; // The stable receiving address (burner[0])
  signingMode: SigningMode;
  currentBlobId: string | null;
}

// ============ SHREDR CLIENT ============
export class ShredrClient {
  private _initialized = false;
  private _currentNonce: GeneratedNonce | null = null;
  private _currentBurner: BurnerKeyPair | null = null;
  private _stealthBurner: BurnerKeyPair | null = null; // burner[0] - stable receiving address
  private _walletPubkey: Uint8Array | null = null;
  private _signingMode: SigningMode = "auto";
  private _currentBlobId: string | null = null;
  private _isNewUser = false;
  private _connection: Connection | null = null;

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
   * The user's stable stealth address - burner[0]
   * This is the address they share for receiving private payments.
   */
  get stealthAddress(): string | null {
    return this._stealthBurner?.address ?? null;
  }
  /** @deprecated Use stealthAddress instead */
  get shadowireAddress(): string | null {
    return this.stealthAddress;
  }
  /**
   * The full burner keypair for stealth address (needed for withdrawals)
   */
  get stealthBurner(): BurnerKeyPair | null {
    return this._stealthBurner;
  }
  /** @deprecated Use stealthBurner instead */
  get shadowireBurner(): BurnerKeyPair | null {
    return this.stealthBurner;
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
      stealthAddress: this._stealthBurner?.address ?? null,
      signingMode: this._signingMode,
      currentBlobId: this._currentBlobId,
    };
  }

  /** Get or create a Solana RPC connection */
  private getConnection(rpcUrl?: string): Connection {
    if (rpcUrl) return new Connection(rpcUrl, "confirmed");
    if (!this._connection) {
      this._connection = new Connection(HELIUS_RPC_URL, "confirmed");
    }
    return this._connection;
  }

  /** Build a Keypair from a BurnerKeyPair's secretKey */
  private burnerToKeypair(burner: BurnerKeyPair): Keypair {
    return Keypair.fromSecretKey(burner.secretKey);
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

    // Store wallet pubkey for stealth address derivation
    this._walletPubkey = walletPubkey;

    // 2. Derive the stealth address (burner[0]) - always same for this wallet
    const baseNonce = await nonceService.generateNonceAtIndex(0, walletPubkey);
    this._stealthBurner =
      await burnerService.deriveShadowireAddress(baseNonce);
    console.log(
      "[initFromSignature] Stealth address derived:",
      this._stealthBurner?.address,
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
        "Current nonce matches burner[0] - incrementing to protect stealth address",
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

  // ============ STEALTH BALANCE & WITHDRAW ============

  /**
   * Get balance of the stealth address (burner[0]).
   * Queries direct lamport balance on the stealth burner address.
   */
  async getStealthBalance(rpcUrl?: string): Promise<{
    available: number; // SOL amount (human readable)
    availableLamports: number; // Raw lamports
    address: string;
  }> {
    if (!this._stealthBurner) {
      throw new Error(
        "Stealth address not derived. Call initFromSignature first.",
      );
    }

    const connection = this.getConnection(rpcUrl);
    const stealthPubkey = new PublicKey(this._stealthBurner.publicKey);

    console.log(
      `getStealthBalance: Querying balance for address: ${this._stealthBurner.address}`,
    );

    const lamports = await connection.getBalance(stealthPubkey);

    return {
      available: lamports / LAMPORTS_PER_SOL,
      availableLamports: lamports,
      address: this._stealthBurner.address,
    };
  }

  /** @deprecated Use getStealthBalance instead */
  async getShadowireBalance(rpcUrl?: string) {
    const result = await this.getStealthBalance(rpcUrl);
    return {
      available: result.available,
      availableLamports: result.availableLamports,
      poolAddress: result.address,
    };
  }

  /**
   * Withdraw SOL from stealth address (burner[0]) to any destination wallet.
   *
   * This performs a standard SOL transfer from the stealth burner to the destination.
   */
  async withdrawToWallet(
    destinationAddress: string,
    amountInSol: number | "all",
    rpcUrl?: string,
  ): Promise<{ signature: string; amount: number }> {
    if (!this._stealthBurner) {
      throw new Error(
        "Stealth address not derived. Call initFromSignature first.",
      );
    }

    const connection = this.getConnection(rpcUrl);
    const stealthKeypair = this.burnerToKeypair(this._stealthBurner);
    const destination = new PublicKey(destinationAddress);

    // Get current balance
    const balance = await connection.getBalance(stealthKeypair.publicKey);

    let withdrawLamports: number;
    if (amountInSol === "all") {
      // Leave enough for tx fee
      withdrawLamports = balance - 5000;
    } else {
      withdrawLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
    }

    if (withdrawLamports <= 0) {
      throw new Error("Insufficient balance for withdrawal");
    }

    // Use SystemProgram transfer (simple SOL transfer from burner[0] to destination)
    const { SystemProgram } = await import("@solana/web3.js");
    const ix = SystemProgram.transfer({
      fromPubkey: stealthKeypair.publicKey,
      toPubkey: destination,
      lamports: withdrawLamports,
    });

    const tx = new Transaction().add(ix);
    const signature = await sendAndConfirmTransaction(
      connection,
      tx,
      [stealthKeypair],
      { commitment: "confirmed" },
    );

    return {
      signature,
      amount: withdrawLamports / LAMPORTS_PER_SOL,
    };
  }

  // ============ CLEANUP ============
  destroy(): void {
    if (this._currentBurner) {
      burnerService.clearBurner(this._currentBurner);
    }
    if (this._stealthBurner) {
      burnerService.clearBurner(this._stealthBurner);
    }

    nonceService.destroy();
    burnerService.destroy();
    this._initialized = false;
    this._currentNonce = null;
    this._currentBurner = null;
    this._stealthBurner = null;
    this._walletPubkey = null;
    this._currentBlobId = null;
    this._isNewUser = false;
    this._connection = null;
  }
}

// ============ SINGLETON EXPORT ============
export const shredrClient = new ShredrClient();
