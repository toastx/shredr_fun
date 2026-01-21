/**
 * ShredrClient - Main orchestrator for SHREDR privacy wallet
 * 
 * Coordinates NonceService and BurnerService to provide:
 * - Initialization from wallet signature
 * - Burner address generation
 * - Transaction sweeping (auto/manual mode)
 * - State management
 */
import { nonceService } from './NonceService';
import { burnerService } from './BurnerService';
import { apiClient } from './ApiClient';
import { ShadowWireClient } from './ShadowWireClient';
import { Keypair } from '@solana/web3.js';
import type { GeneratedNonce, BurnerKeyPair, CreateBlobRequest } from './types';
// ============ TYPES ============
export type SigningMode = 'auto' | 'manual';
export interface PendingTransaction {
    amount: number;       // SOL amount (lamports)
    signature: string;    // Transaction signature
    from: string;         // Sender address
    timestamp: number;    // Unix timestamp
}
export interface ShredrState {
    initialized: boolean;
    currentNonce: GeneratedNonce | null;
    currentBurner: BurnerKeyPair | null;
    shadowireAddress: string | null;          // The stable receiving address (burner[0])
    signingMode: SigningMode;
    currentBlobId: string | null;
}
// ============ SHREDR CLIENT ============
export class ShredrClient {
    private _initialized = false;
    private _currentNonce: GeneratedNonce | null = null;
    private _currentBurner: BurnerKeyPair | null = null;
    private _shadowireBurner: BurnerKeyPair | null = null;  // burner[0] - stable receiving address
    private _walletPubkey: Uint8Array | null = null;
    private _signingMode: SigningMode = 'auto';
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
        fetchBlobsFn: () => Promise<Array<{ id: string; encryptedBlob: string; createdAt: number }>> = () => apiClient.fetchAllBlobs()
    ): Promise<boolean> {
        // Initialize nonce service to enable storage access
        await nonceService.initFromSignature(signature);

        // Try local storage first
        let nonce = await nonceService.loadCurrentNonce(walletPubkey);
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
                console.warn('Failed to fetch blobs from backend:', err);
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
        fetchBlobsFn: () => Promise<Array<{ id: string; encryptedBlob: string; createdAt: number }>> = () => apiClient.fetchAllBlobs(),
        createBlobFn: (data: CreateBlobRequest) => Promise<{ id: string }> = (data) => apiClient.createBlob(data)
    ): Promise<void> {
        // 1. Initialize both services
        await nonceService.initFromSignature(signature);
        await burnerService.initFromSignature(signature);
        
        // Store wallet pubkey for Shadowire Address derivation
        this._walletPubkey = walletPubkey;
        
        // 2. Derive the Shadowire Address (burner[0]) - always same for this wallet
        const baseNonce = await nonceService.generateNonceAtIndex(0, walletPubkey);
        this._shadowireBurner = await burnerService.deriveShadowireAddress(baseNonce);
        
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
                    console.warn('Failed to fetch blobs from backend:', err);
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
                    console.warn('Failed to upload blob to backend:', err);
                }
            }
        } else {
            this._isNewUser = false;
        }
        
        // Safety check: ensure current nonce is not the same as burner[0] nonce
        // This protects burner[0] from being used for receiving public SOL
        const isSameAsBaseNonce = nonce.nonce.length === baseNonce.nonce.length &&
            nonce.nonce.every((byte, i) => byte === baseNonce.nonce[i]);
        
        if (isSameAsBaseNonce) {
            console.warn('Current nonce matches burner[0] - incrementing to protect Shadowire Address');
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
        createBlobFn: (data: CreateBlobRequest) => Promise<{ id: string }> = (data) => apiClient.createBlob(data),
        deleteBlobFn: (id: string) => Promise<boolean> = (id) => apiClient.deleteBlob(id)
    ): Promise<BurnerKeyPair> {
        if (!this._initialized || !this._currentNonce) {
            throw new Error('ShredrClient not initialized');
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
                console.warn('Failed to upload new blob:', err);
            }
        }
        if (deleteBlobFn && oldBlobId) {
            try {
                await deleteBlobFn(oldBlobId);
            } catch (err) {
                console.warn('Failed to delete old blob:', err);
            }
        }
        this._currentNonce = newNonce;
        // Derive new burner
        this._currentBurner = await burnerService.deriveBurnerFromNonce(newNonce);
        return this._currentBurner;
    }
    // ============ TRANSACTION HANDLING ============
    /**
     * Handle incoming transaction to burner address
     * In auto mode, sweeps immediately
     * In manual mode, returns the transaction for approval
     */
    async handleIncomingTransaction(
        tx: PendingTransaction,
        sweepFn: (burner: BurnerKeyPair, amount: number) => Promise<string>
    ): Promise<{ swept: boolean; sweepSignature?: string }> {
        if (!this._currentBurner) {
            throw new Error('No current burner');
        }
        if (this._signingMode === 'auto') {
            // Auto mode - sweep immediately
            const sweepSig = await sweepFn(this._currentBurner, tx.amount);
            return { swept: true, sweepSignature: sweepSig };
        } else {
            // Manual mode - return for approval
            return { swept: false };
        }
    }
    /**
     * Approve and execute a pending transaction (for manual mode)
     */
    async approveAndSweep(
        tx: PendingTransaction,
        sweepFn: (burner: BurnerKeyPair, amount: number) => Promise<string>
    ): Promise<string> {
        if (!this._currentBurner) {
            throw new Error('No current burner');
        }
        return await sweepFn(this._currentBurner, tx.amount);
    }
    // ============ SHADOWIRE BALANCE & WITHDRAW ============

    /**
     * Get the balance at the Shadowire Address (burner[0])
     * This is the user's "private" balance available for withdrawal.
     * 
     * @param rpcUrl - Solana RPC URL (defaults to mainnet)
     */
    async getShadowireBalance(rpcUrl?: string): Promise<{
        available: number;         // SOL amount (human readable)
        availableLamports: number; // Raw lamports
        poolAddress: string;
    }> {
        if (!this._shadowireBurner) {
            throw new Error('Shadowire Address not derived. Call initFromSignature first.');
        }

        // Create a temporary ShadowWire client to check balance
        const client = new ShadowWireClient(rpcUrl);
        return client.getBalanceForAddress(this._shadowireBurner.address);
    }

    /**
     * Withdraw funds from Shadowire Address to a destination wallet.
     * Uses external transfer (sender anonymous, amount visible).
     * 
     * @param destinationAddress - The wallet address to send funds to
     * @param amountInSol - Amount to withdraw in SOL (use 'all' to withdraw everything)
     * @param rpcUrl - Solana RPC URL (defaults to mainnet)
     */
    async withdrawToWallet(
        destinationAddress: string,
        amountInSol: number | 'all',
        rpcUrl?: string
    ): Promise<{ signature: string; amount: number }> {
        if (!this._shadowireBurner) {
            throw new Error('Shadowire Address not derived. Call initFromSignature first.');
        }

        // Create ShadowWire client with the burner keypair
        const client = new ShadowWireClient(rpcUrl);
        const keypair = Keypair.fromSecretKey(this._shadowireBurner.secretKey);
        client.setKeypair(keypair);

        // Get balance if withdrawing all
        let withdrawAmount: number;
        if (amountInSol === 'all') {
            const balance = await client.getBalance();
            if (balance.available <= 0) {
                throw new Error('No balance to withdraw');
            }
            withdrawAmount = balance.available;
        } else {
            withdrawAmount = amountInSol;
        }

        // Perform external transfer from burner[0] to destination
        const signature = await client.transferExternal(destinationAddress, withdrawAmount);

        return {
            signature,
            amount: withdrawAmount
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
    }
}
// ============ SINGLETON EXPORT ============
export const shredrClient = new ShredrClient();