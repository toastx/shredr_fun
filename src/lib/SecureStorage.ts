/**
 * SecureStorage - IndexedDB with AES-GCM encryption
 * 
 * Provides encrypted persistent storage with mutex-based concurrency control.
 * Used by NonceManager for secure nonce state persistence.
 */

// ============ CONSTANTS ============

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

// ============ TYPES ============

export interface NonceState {
    currentNonce: string;  // Base64 encoded current nonce
    currentIndex: number;
    walletPubkeyHash: string;
}

// ============ ERROR TYPES ============

export class DecryptionError extends Error {
    readonly reason: 'wrong_key' | 'corrupted' | 'unknown';
    
    constructor(reason: 'wrong_key' | 'corrupted' | 'unknown', message: string) {
        super(message);
        this.name = 'DecryptionError';
        this.reason = reason;
    }
}

// ============ UTILITY FUNCTIONS ============

export function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function uint8ArrayToBase58(bytes: Uint8Array): string {
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

export function zeroMemory(arr: Uint8Array): void {
    crypto.getRandomValues(arr); // Overwrite with random
    arr.fill(0); // Then zero
}

// ============ SECURE STORAGE CLASS ============

export class SecureStorage {
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

    getEncryptionKey(): CryptoKey | null {
        return this.encryptionKey;
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

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.encryptionKey = null;
        this.lockQueue.clear();
    }
}
