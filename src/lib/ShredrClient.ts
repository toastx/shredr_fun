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
    signingMode: SigningMode;
    currentBlobId: string | null;
}
// ============ SHREDR CLIENT ============
export class ShredrClient {
    private _initialized = false;
    private _currentNonce: GeneratedNonce | null = null;
    private _currentBurner: BurnerKeyPair | null = null;
    private _signingMode: SigningMode = 'auto';
    private _currentBlobId: string | null = null;
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
    get signingMode(): SigningMode {
        return this._signingMode;
    }
    get state(): ShredrState {
        return {
            initialized: this._initialized,
            currentNonce: this._currentNonce,
            currentBurner: this._currentBurner,
            signingMode: this._signingMode,
            currentBlobId: this._currentBlobId,
        };
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
        fetchBlobsFn?: () => Promise<Array<{ id: string; encryptedBlob: string; createdAt: number }>>,
        createBlobFn?: (data: CreateBlobRequest) => Promise<{ id: string }>
    ): Promise<void> {
        // 1. Initialize both services
        await nonceService.initFromSignature(signature);
        await burnerService.initFromSignature(signature);
        
        // Store wallet pubkey for potential future use
        // 2. Try local storage first
        let nonce = await nonceService.loadCurrentNonce(walletPubkey);
        if (!nonce) {
            // 3. Try remote backend if fetch function provided
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
            // 4. New user - generate base nonce
            nonce = await nonceService.generateBaseNonce(walletPubkey);
            
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
        }
        this._currentNonce = nonce;
        // 5. Derive burner from nonce
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
        createBlobFn?: (data: CreateBlobRequest) => Promise<{ id: string }>,
        deleteBlobFn?: (id: string) => Promise<void>
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
    // ============ CLEANUP ============
    /**
     * Clean up all resources
     */
    destroy(): void {
        if (this._currentBurner) {
            burnerService.clearBurner(this._currentBurner);
        }
        
        nonceService.destroy();
        burnerService.destroy();
        this._initialized = false;
        this._currentNonce = null;
        this._currentBurner = null;
        this._currentBlobId = null;
    }
}
// ============ SINGLETON EXPORT ============
export const shredrClient = new ShredrClient();