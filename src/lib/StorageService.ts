/**
 * StorageService - IndexedDB with AES-GCM encryption
 * 
 * Provides encrypted persistent storage with mutex-based concurrency control.
 * Used by NonceService for secure nonce state persistence.
 */

import { ALGORITHM, IV_LENGTH, DB_NAME, DB_VERSION, STORE_NAME } from './constants';
import { uint8ArrayToBase64, base64ToUint8Array } from './utils';
import { DecryptionError, type NonceState } from './types';

// ============ STORAGE SERVICE CLASS ============

export class StorageService {
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
        const previousLock = this.lockQueue.get(key) ?? Promise.resolve();
        
        let releaseLock: () => void;
        const currentLock = new Promise<void>(resolve => { releaseLock = resolve; });
        this.lockQueue.set(key, currentLock);
        
        try {
            await previousLock;
            return await fn();
        } finally {
            releaseLock!();
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
