/**
 * NonceManager - Handles DETERMINISTIC nonce generation and state management
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
 * Note: Burner wallet derivation is handled by EncryptionClient
 */

import { 
    SecureStorage, 
    ALGORITHM, 
    IV_LENGTH,
    uint8ArrayToBase64,
    base64ToUint8Array,
    uint8ArrayToBase58,
    zeroMemory,
    DecryptionError,
    type NonceState
} from './SecureStorage';

// Re-export for backward compatibility
export { DecryptionError, type NonceState };

// ============ CONSTANTS ============

/** Wallet hash length for collision resistance (16 chars = ~96 bits) */
export const WALLET_HASH_LENGTH = 16;

/** Maximum valid nonce index (2^32 - 1) */
export const MAX_NONCE_INDEX = 0xFFFFFFFF;

/** Message prefix for wallet signature - change for your own deployment */
export const MASTER_MESSAGE = 'SHREDR_V1';

/** Domain separation suffixes for key derivation */
export const DOMAIN_NONCE_SEED = 'SHREDR_NONCE_SEED';
export const DOMAIN_ENCRYPT_KEY = 'SHREDR_ENCRYPT_KEY';

// ============ TYPES ============

export interface GeneratedNonce {
    nonce: Uint8Array;
    index: number;
    walletPubkeyHash: string;
}

export interface EncryptedNoncePayload {
    ciphertext: string;
    iv: string;
    version: number;
}

export interface DerivedKeys {
    masterSeed: Uint8Array;
    encryptionKey: CryptoKey;
}

// ============ NONCE MANAGER CLASS ============

export class NonceManager {
    private storage = new SecureStorage();
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
     * Initialize NonceManager with wallet signature
     * Derives master seed and encryption key from signature
     * @param signature - Signature from wallet.signMessage()
     */
    async initFromSignature(signature: Uint8Array): Promise<void> {
        // Derive master seed for nonce generation
        const nonceSuffix = new TextEncoder().encode(DOMAIN_NONCE_SEED);
        const nonceInput = new Uint8Array(signature.length + nonceSuffix.length);
        nonceInput.set(signature, 0);
        nonceInput.set(nonceSuffix, signature.length);
        const masterSeedBuffer = await crypto.subtle.digest('SHA-256', nonceInput);
        this._masterSeed = new Uint8Array(masterSeedBuffer);
        
        // Derive encryption key for IndexedDB storage
        const encryptSuffix = new TextEncoder().encode(DOMAIN_ENCRYPT_KEY);
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
     * Get the encryption key (for use by EncryptionClient if needed)
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
            throw new Error('NonceManager not initialized. Call initFromSignature first.');
        }
        
        this._walletHash = uint8ArrayToBase58(walletPublicKey).slice(0, WALLET_HASH_LENGTH);
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
            throw new Error('NonceManager not initialized. Call initFromSignature first.');
        }
        
        this._walletHash = uint8ArrayToBase58(walletPublicKey).slice(0, WALLET_HASH_LENGTH);
        this._currentIndex = 0;
        
        // Base nonce is just the master seed hashed
        const nonceBuffer = await crypto.subtle.digest('SHA-256', this._masterSeed.buffer.slice(
            this._masterSeed.byteOffset,
            this._masterSeed.byteOffset + this._masterSeed.byteLength
        ) as ArrayBuffer);
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
        const newNonceBuffer = await crypto.subtle.digest('SHA-256', this._currentNonce.buffer.slice(
            this._currentNonce.byteOffset,
            this._currentNonce.byteOffset + this._currentNonce.byteLength
        ) as ArrayBuffer);
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
                { name: ALGORITHM, iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
                encryptionKey,
                ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
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

export const nonceManager = new NonceManager();
