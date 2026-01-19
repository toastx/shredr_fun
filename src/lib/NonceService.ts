/**
 * NonceService - Handles DETERMINISTIC nonce generation and state management
 *
 * Key Insight: Nonces must be fully deterministic from (wallet signature + index)
 * This enables wallet recovery - re-derive any nonce by signing same message
 *
 * Security Features:
 * - IndexedDB with encryption for state storage (XSS resistant)
 * - Atomic operations with mutex for race condition prevention
 * - Sensitive memory zeroing after use
 * - Proper error handling with typed exceptions
 *
 * Note: Burner wallet derivation is handled by EncryptionService
 */

import { StorageService } from './StorageService';
import { 
    ALGORITHM, 
    IV_LENGTH, 
    WALLET_HASH_LENGTH, 
    MAX_NONCE_INDEX,
    DOMAIN_NONCE_MASTER,
    DOMAIN_STORAGE_KEY
} from './constants';
import { 
    uint8ArrayToBase64, 
    base64ToUint8Array, 
    zeroMemory,
    getArrayBuffer,
    deriveWalletHash
} from './utils';
import { 
    DecryptionError, 
    type NonceState, 
    type GeneratedNonce, 
    type EncryptedNoncePayload,
    type NonceBlob,
    type CreateBlobRequest
} from './types';

// ============ NONCE SERVICE CLASS ============

export class NonceService {
    private storage = new StorageService();
    private initialized = false;
    private _masterSeed: Uint8Array | null = null;
    private _currentNonce: Uint8Array | null = null;
    private _currentIndex: number = 0;
    private _walletHash: string | null = null;

    async init(encryptionKey: CryptoKey): Promise<void> {
        await this.storage.init(encryptionKey);
        this.initialized = true;
    }

    /**
     * Initialize NonceService with wallet signature
     * Derives master seed and encryption key from signature
     * @param signature - Signature from wallet.signMessage()
     */
    async initFromSignature(signature: Uint8Array): Promise<void> {
        // Derive master seed for nonce generation
        const nonceSuffix = new TextEncoder().encode(DOMAIN_NONCE_MASTER);
        const nonceInput = new Uint8Array(signature.length + nonceSuffix.length);
        nonceInput.set(signature, 0);
        nonceInput.set(nonceSuffix, signature.length);
        const masterSeedBuffer = await crypto.subtle.digest('SHA-256', nonceInput);
        this._masterSeed = new Uint8Array(masterSeedBuffer);
        
        // Derive encryption key for IndexedDB storage
        const encryptSuffix = new TextEncoder().encode(DOMAIN_STORAGE_KEY);
        const encryptInput = new Uint8Array(signature.length + encryptSuffix.length);
        encryptInput.set(signature, 0);
        encryptInput.set(encryptSuffix, signature.length);
        const encryptKeyBuffer = await crypto.subtle.digest('SHA-256', encryptInput);
        
        // Zero intermediate buffers
        zeroMemory(nonceInput);
        zeroMemory(encryptInput);
        
        const encryptionKey = await crypto.subtle.importKey(
            'raw',
            encryptKeyBuffer,
            { name: ALGORITHM },
            false,
            ['encrypt', 'decrypt']
        );
        
        // Initialize secure storage with derived key
        await this.init(encryptionKey);
    }

    /**
     * Get the encryption key (for use by EncryptionService if needed)
     */
    getEncryptionKey(): CryptoKey | null {
        return this.initialized ? this.storage.getEncryptionKey() : null;
    }

    /**
     * Clear master seed from memory when done
     */
    clearMasterSeed(): void {
        if (this._masterSeed) {
            zeroMemory(this._masterSeed);
            this._masterSeed = null;
        }
    }

    /**
     * Load current nonce from storage (for returning users)
     * Call after initFromSignature
     */
    async loadCurrentNonce(walletPublicKey: Uint8Array): Promise<GeneratedNonce | null> {
        if (!this.initialized) {
            throw new Error('NonceService not initialized. Call initFromSignature first.');
        }
        
        this._walletHash = await deriveWalletHash(walletPublicKey, WALLET_HASH_LENGTH);
        const stored = await this.storage.getCurrentNonce(this._walletHash);
        
        if (stored) {
            this._currentNonce = stored.nonce;
            this._currentIndex = stored.index;
            return {
                nonce: stored.nonce,
                index: stored.index,
                walletPubkeyHash: this._walletHash
            };
        }
        
        return null;
    }

    /**
     * Generate the base nonce (index 0) - only for new users
     */
    async generateBaseNonce(walletPublicKey: Uint8Array): Promise<GeneratedNonce> {
        if (!this._masterSeed) {
            throw new Error('NonceService not initialized. Call initFromSignature first.');
        }
        
        this._walletHash = await deriveWalletHash(walletPublicKey, WALLET_HASH_LENGTH);
        this._currentIndex = 0;
        
        // Base nonce is just the master seed hashed
        const nonceBuffer = await crypto.subtle.digest('SHA-256', getArrayBuffer(this._masterSeed));
        this._currentNonce = new Uint8Array(nonceBuffer);
        
        // Persist to storage
        await this.storage.saveCurrentNonce(this._walletHash, this._currentNonce, this._currentIndex);
        
        return {
            nonce: this._currentNonce,
            index: this._currentIndex,
            walletPubkeyHash: this._walletHash
        };
    }

    /**
     * Increment the current nonce - hash(currentNonce) becomes the new nonce
     */
    async incrementNonce(): Promise<GeneratedNonce> {
        if (!this._currentNonce || !this._walletHash) {
            throw new Error('No current nonce. Call loadCurrentNonce or generateBaseNonce first.');
        }
        
        if (this._currentIndex >= MAX_NONCE_INDEX) {
            throw new Error('Nonce index overflow - maximum reached');
        }
        
        // New nonce = SHA256(current nonce)
        const newNonceBuffer = await crypto.subtle.digest('SHA-256', getArrayBuffer(this._currentNonce));
        this._currentNonce = new Uint8Array(newNonceBuffer);
        this._currentIndex++;
        
        // Persist to storage
        await this.storage.saveCurrentNonce(this._walletHash, this._currentNonce, this._currentIndex);
        
        return {
            nonce: this._currentNonce,
            index: this._currentIndex,
            walletPubkeyHash: this._walletHash
        };
    }

    /**
     * Get current nonce without incrementing
     */
    getCurrentNonce(): GeneratedNonce | null {
        if (!this._currentNonce || !this._walletHash) {
            return null;
        }
        return {
            nonce: this._currentNonce,
            index: this._currentIndex,
            walletPubkeyHash: this._walletHash
        };
    }

    /**
     * Encrypt nonce for backend storage
     */
    async encryptNonce(
        nonce: GeneratedNonce,
        encryptionKey: CryptoKey
    ): Promise<EncryptedNoncePayload> {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        
        const payload = JSON.stringify({
            nonce: uint8ArrayToBase64(nonce.nonce),
            index: nonce.index,
            walletPubkeyHash: nonce.walletPubkeyHash
        });
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
            encryptionKey,
            new TextEncoder().encode(payload)
        );
        
        return {
            ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
            iv: uint8ArrayToBase64(iv),
            version: 1
        };
    }

    /**
     * Decrypt nonce from backend with proper error classification
     */
    async decryptNonce(
        encrypted: EncryptedNoncePayload,
        encryptionKey: CryptoKey
    ): Promise<GeneratedNonce> {
        let ciphertext: Uint8Array;
        let iv: Uint8Array;
        
        try {
            ciphertext = base64ToUint8Array(encrypted.ciphertext);
            iv = base64ToUint8Array(encrypted.iv);
        } catch {
            throw new DecryptionError('corrupted', 'Invalid base64 encoding in encrypted payload');
        }
        
        let decrypted: ArrayBuffer;
        try {
            decrypted = await crypto.subtle.decrypt(
                { name: ALGORITHM, iv: getArrayBuffer(iv) },
                encryptionKey,
                getArrayBuffer(ciphertext)
            );
        } catch (e) {
            // AES-GCM auth failure = wrong key or tampered data
            if (e instanceof DOMException && e.name === 'OperationError') {
                throw new DecryptionError('wrong_key', 'Decryption failed - wrong key or corrupted data');
            }
            throw new DecryptionError('unknown', `Decryption failed: ${e}`);
        }
        
        let payload: { nonce: string; index: number; walletPubkeyHash: string };
        try {
            payload = JSON.parse(new TextDecoder().decode(decrypted));
        } catch {
            throw new DecryptionError('corrupted', 'Decrypted data is not valid JSON');
        }
        
        if (typeof payload.nonce !== 'string' || typeof payload.index !== 'number' || typeof payload.walletPubkeyHash !== 'string') {
            throw new DecryptionError('corrupted', 'Invalid payload structure');
        }
        
        return {
            nonce: base64ToUint8Array(payload.nonce),
            index: payload.index,
            walletPubkeyHash: payload.walletPubkeyHash
        };
    }

    // ============ HELPER METHODS ============

    /**
     * Try to decrypt blobs to find user's blob
     * Returns decrypted nonce if found
     */
    async tryDecryptBlobs(blobs: NonceBlob[]): Promise<{
        found: boolean;
        blobId?: string;
        nonce?: GeneratedNonce;
    }> {
        const encKey = this.storage.getEncryptionKey();
        if (!encKey) {
            throw new Error('Encryption key not available');
        }

        for (const blob of blobs) {
            try {
                const encrypted: EncryptedNoncePayload = {
                    ciphertext: blob.encryptedData,
                    iv: blob.iv,
                    version: 1
                };
                const decrypted = await this.decryptNonce(encrypted, encKey);
                
                // Successfully decrypted = this is our blob!
                return {
                    found: true,
                    blobId: blob.id,
                    nonce: decrypted
                };
            } catch {
                // Couldn't decrypt - not our blob, try next
                continue;
            }
        }

        return { found: false };
    }

    /**
     * Create encrypted blob data for backend storage
     */
    async createBlobData(nonce: GeneratedNonce): Promise<CreateBlobRequest> {
        const encKey = this.storage.getEncryptionKey();
        if (!encKey) {
            throw new Error('Encryption key not available');
        }

        const encrypted = await this.encryptNonce(nonce, encKey);
        return {
            encryptedData: encrypted.ciphertext,
            iv: encrypted.iv
        };
    }

    /**
     * Set current state from external source (e.g., from decrypted remote blob)
     * Use when syncing from remote to local
     */
    async setCurrentState(nonce: GeneratedNonce): Promise<void> {
        if (!this.initialized) {
            throw new Error('NonceService not initialized');
        }
        
        this._currentNonce = nonce.nonce;
        this._currentIndex = nonce.index;
        this._walletHash = nonce.walletPubkeyHash;
        
        // Persist to local storage
        await this.storage.saveCurrentNonce(this._walletHash, this._currentNonce, this._currentIndex);
    }

    /**
     * Consume current nonce and move to next
     * Does local increment and prepares data for app to sync with backend
     * 
     * @returns Data for app to sync:
     *  - consumedNonce: The old nonce that was consumed
     *  - newNonce: The new current nonce
     *  - newBlobData: Encrypted data to upload to backend
     * 
     * App should then:
     *  1. Upload newBlobData to backend
     *  2. Delete old blob from backend
     */
    async consumeNonce(): Promise<{
        consumedNonce: GeneratedNonce;
        newNonce: GeneratedNonce;
        newBlobData: CreateBlobRequest;
    }> {
        const currentNonce = this.getCurrentNonce();
        if (!currentNonce) {
            throw new Error('No current nonce to consume');
        }

        // 1. Increment to new nonce (also updates local IndexedDB)
        const newNonce = await this.incrementNonce();

        // 2. Prepare encrypted blob for new nonce
        const newBlobData = await this.createBlobData(newNonce);

        return {
            consumedNonce: currentNonce,
            newNonce,
            newBlobData
        };
    }

    /**
     * Clean up resources
     */
    destroy(): void {
        this.clearMasterSeed();
        if (this._currentNonce) {
            zeroMemory(this._currentNonce);
            this._currentNonce = null;
        }
        this.storage.close();
        this.initialized = false;
        this._walletHash = null;
        this._currentIndex = 0;
    }
}

// ============ SINGLETON EXPORT ============

export const nonceService = new NonceService();
