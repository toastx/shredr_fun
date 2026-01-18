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

// ============ CONSTANTS ============

/** Wallet hash length for collision resistance (16 chars = ~96 bits) */
export const WALLET_HASH_LENGTH = 16;

/** Maximum valid nonce index (2^32 - 1) */
export const MAX_NONCE_INDEX = 0xFFFFFFFF;

// ============ TYPES ============

export interface NonceState {
    currentNonce: string;  // Base64 encoded current nonce
    currentIndex: number;
    walletPubkeyHash: string;
}

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

// ============ ERROR TYPES ============

export class DecryptionError extends Error {
    readonly cause: 'wrong_key' | 'corrupted' | 'unknown';
    
    constructor(cause: 'wrong_key' | 'corrupted' | 'unknown', message: string) {
        super(message);
        this.name = 'DecryptionError';
        this.cause = cause;
    }
}

// ============ CONSTANTS ============
// Exported for configurability in open-source deployments

/** Message prefix for wallet signature - change for your own deployment */
export const MASTER_MESSAGE = 'SHREDR_V1';

/** AES-GCM encryption algorithm */
export const ALGORITHM = 'AES-GCM';

/** IV length for AES-GCM (12 bytes recommended) */
export const IV_LENGTH = 12;

/** IndexedDB database name */
export const DB_NAME = 'shredr_secure_storage';

/** IndexedDB database version */
export const DB_VERSION = 1;

/** IndexedDB object store name */
export const STORE_NAME = 'nonce_state';

/** Domain separation suffixes for key derivation */
export const DOMAIN_NONCE_SEED = 'SHREDR_NONCE_SEED';
export const DOMAIN_ENCRYPT_KEY = 'SHREDR_ENCRYPT_KEY';

// ============ SECURE STORAGE (IndexedDB + Encryption) ============

class SecureStorage {
    private db: IDBDatabase | null = null;
    private encryptionKey: CryptoKey | null = null;
    private lockQueue = new Map<string, Promise<void>>();

    async init(encryptionKey: CryptoKey): Promise<void> {
        this.encryptionKey = encryptionKey;
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = () => reject(new Error('Failed to open IndexedDB'));
            
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
        });
    }

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        // Queue-based mutex to prevent race conditions
        const previousLock = this.lockQueue.get(key) ?? Promise.resolve();
        
        let releaseLock: () => void;
        const currentLock = new Promise<void>(resolve => { releaseLock = resolve; });
        this.lockQueue.set(key, currentLock);
        
        try {
            await previousLock;
            return await fn();
        } finally {
            releaseLock!();
            // Clean up if this is the last lock in the queue
            if (this.lockQueue.get(key) === currentLock) {
                this.lockQueue.delete(key);
            }
        }
    }

    private async encrypt(data: string): Promise<{ ciphertext: string; iv: string }> {
        if (!this.encryptionKey) throw new Error('Storage not initialized');
        
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encoded = new TextEncoder().encode(data);
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
            this.encryptionKey,
            encoded
        );
        
        return {
            ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
            iv: uint8ArrayToBase64(iv)
        };
    }

    private async decrypt(encrypted: { ciphertext: string; iv: string }): Promise<string> {
        if (!this.encryptionKey) throw new Error('Storage not initialized');
        
        const ciphertext = base64ToUint8Array(encrypted.ciphertext);
        const iv = base64ToUint8Array(encrypted.iv);
        
        const decrypted = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
            this.encryptionKey,
            ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
        );
        
        return new TextDecoder().decode(decrypted);
    }

    async getState(walletHash: string): Promise<NonceState | null> {
        return this.withLock(walletHash, async () => {
            if (!this.db) throw new Error('Storage not initialized');
            
            return new Promise((resolve, reject) => {
                const tx = this.db!.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.get(walletHash);
                
                request.onerror = () => reject(new Error('Failed to read state'));
                request.onsuccess = async () => {
                    if (!request.result) {
                        resolve(null);
                        return;
                    }
                    try {
                        const decrypted = await this.decrypt(request.result.data);
                        resolve(JSON.parse(decrypted));
                    } catch (e) {
                        if (e instanceof DecryptionError) {
                            reject(e);
                        } else {
                            reject(new DecryptionError('corrupted', `Failed to parse state: ${e}`));
                        }
                    }
                };
                
                tx.onerror = () => reject(new Error('Transaction failed'));
            });
        });
    }

    async saveState(walletHash: string, state: NonceState): Promise<void> {
        return this.withLock(walletHash, async () => {
            if (!this.db) throw new Error('Storage not initialized');
            
            const encrypted = await this.encrypt(JSON.stringify(state));
            
            return new Promise((resolve, reject) => {
                const tx = this.db!.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const request = store.put({ id: walletHash, data: encrypted });
                
                request.onerror = () => reject(new Error('Failed to save state'));
                request.onsuccess = () => resolve();
            });
        });
    }

    async getCurrentNonce(walletHash: string): Promise<{ nonce: Uint8Array; index: number } | null> {
        const state = await this.getState(walletHash);
        if (!state) return null;
        return {
            nonce: base64ToUint8Array(state.currentNonce),
            index: state.currentIndex
        };
    }

    async saveCurrentNonce(walletHash: string, nonce: Uint8Array, index: number): Promise<void> {
        const state: NonceState = {
            currentNonce: uint8ArrayToBase64(nonce),
            currentIndex: index,
            walletPubkeyHash: walletHash
        };
        await this.saveState(walletHash, state);
    }

    private async getStateUnsafe(walletHash: string): Promise<NonceState | null> {
        if (!this.db) throw new Error('Storage not initialized');
        
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(walletHash);
            
            request.onerror = () => reject(new Error('Failed to read state'));
            request.onsuccess = async () => {
                if (!request.result) {
                    resolve(null);
                    return;
                }
                try {
                    const decrypted = await this.decrypt(request.result.data);
                    resolve(JSON.parse(decrypted));
                } catch (e) {
                    if (e instanceof DecryptionError) {
                        reject(e);
                    } else {
                        reject(new DecryptionError('corrupted', `Failed to parse state: ${e}`));
                    }
                }
            };
            
            tx.onerror = () => reject(new Error('Transaction failed'));
        });
    }

    private async saveStateUnsafe(walletHash: string, state: NonceState): Promise<void> {
        if (!this.db) throw new Error('Storage not initialized');
        
        const encrypted = await this.encrypt(JSON.stringify(state));
        
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.put({ id: walletHash, data: encrypted });
            
            request.onerror = () => reject(new Error('Failed to save state'));
            request.onsuccess = () => resolve();
            tx.onerror = () => reject(new Error('Transaction failed'));
        });
    }
}

// ============ MEMORY CLEARING UTILITIES ============

function zeroMemory(arr: Uint8Array): void {
    crypto.getRandomValues(arr); // Overwrite with random
    arr.fill(0); // Then zero
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function uint8ArrayToBase58(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    if (bytes.length === 0) return '';
    
    let result = '';
    let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
    while (num > 0) {
        result = ALPHABET[Number(num % 58n)] + result;
        num = num / 58n;
    }
    for (const byte of bytes) {
        if (byte === 0) result = '1' + result;
        else break;
    }
    return result || '1';
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
        return this.initialized ? this.storage['encryptionKey'] : null;
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
        } catch (e) {
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
        
        return {
            nonce: base64ToUint8Array(payload.nonce),
            index: payload.index,
            walletPubkeyHash: payload.walletPubkeyHash
        };
    }
}

// ============ SINGLETON EXPORT ============

export const nonceManager = new NonceManager();
