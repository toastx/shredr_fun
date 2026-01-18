/**
 * EncryptionClient - Handles wallet-based encryption/decryption for privacy-preserving burner addresses
 *
 * Flow:
 * 1. Derive encryption key from main wallet signature
 * 2. Generate burner nonces and encrypt them
 * 3. Store encrypted nonces on backend (backend doesn't know ownership)
 * 4. Recovery: fetch all nonces, try decrypt each, success = your nonce
 */

import { Keypair } from '@solana/web3.js';
import type { GeneratedNonce } from './NonceManager';

// ============ CONSTANTS ============

/** Domain separation for burner seed derivation */
const DOMAIN_BURNER_SEED = 'BURNER_SEED';

/** Domain separation for burner derivation */
const DOMAIN_BURNER = 'BURNER';

/** Number of consecutive empty addresses before stopping recovery scan */
const CONSECUTIVE_EMPTY_THRESHOLD = 10;

/** Message prefix for wallet signature */
const SIGN_MESSAGE_PREFIX = 'SHREDR_V1';

// ============ TYPES ============

export interface EncryptedNonce {
    id: string;
    ciphertext: string;      // Base64 encoded encrypted data
    iv: string;              // Base64 encoded initialization vector
    salt: string;            // Base64 encoded salt for key derivation
    createdAt: number;
    consumed: boolean;       // True if nonce has been used (one-time use)
    consumedAt?: number;     // Timestamp when consumed
}

export interface DecryptedNonce {
    nonce: Uint8Array;
    index: number;           // Burner index for HD derivation
    timestamp: number;
}

export interface BurnerKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    address: string;
    nonce: Uint8Array;
    nonceIndex: number;
}

export interface EncryptionKeyMaterial {
    key: CryptoKey;
    salt: Uint8Array;
}

export interface RecoveryResult {
    success: boolean;
    burners: BurnerKeyPair[];
    failedAttempts: number;
}

export interface ConsumeNonceResult {
    success: boolean;
    nonceId: string;
    consumedAt: number;
    error?: string;
}

export interface LocalNonceData {
    nonce: string;           // Base64 encoded nonce
    index: number;
    createdAt: number;
    burnerPublicKey: string; // For reference
}

export interface NonceDestructionProof {
    nonceId: string;
    destructionSignature: string;  // Signed by wallet to prove ownership
    timestamp: number;
}

// ============ ENCRYPTION CLIENT ============

export class EncryptionClient {
    private static readonly ALGORITHM = 'AES-GCM';
    private static readonly KEY_LENGTH = 256;
    private static readonly SALT_LENGTH = 16;
    private static readonly IV_LENGTH = 12;

    private _burnerSeed: Uint8Array | null = null;

    /**
     * Initialize EncryptionClient with wallet signature
     * Derives burner seed from signature with domain separation
     */
    async initFromSignature(signature: Uint8Array): Promise<void> {
        const suffix = new TextEncoder().encode(DOMAIN_BURNER_SEED);
        const input = new Uint8Array(signature.length + suffix.length);
        input.set(signature, 0);
        input.set(suffix, signature.length);
        
        const seedBuffer = await crypto.subtle.digest('SHA-256', input);
        this.zeroMemory(input);
        
        this._burnerSeed = new Uint8Array(seedBuffer);
    }

    /**
     * Check if client is initialized
     */
    get isInitialized(): boolean {
        return this._burnerSeed !== null;
    }

    /**
     * Derive burner keypair from nonce (DETERMINISTIC)
     * IMPORTANT: Call clearBurner() when done to zero the secretKey from memory
     */
    async deriveBurnerFromNonce(nonce: GeneratedNonce): Promise<BurnerKeyPair> {
        if (!this._burnerSeed) {
            throw new Error('EncryptionClient not initialized. Call initFromSignature first.');
        }
        
        const burnerMarker = new TextEncoder().encode(DOMAIN_BURNER);
        
        const combined = new Uint8Array(this._burnerSeed.length + nonce.nonce.length + burnerMarker.length);
        combined.set(this._burnerSeed, 0);
        combined.set(nonce.nonce, this._burnerSeed.length);
        combined.set(burnerMarker, this._burnerSeed.length + nonce.nonce.length);
        
        const seedBuffer = await crypto.subtle.digest('SHA-256', combined);
        const seed = new Uint8Array(seedBuffer);
        
        // Zero intermediate
        this.zeroMemory(combined);
        
        // Generate ed25519 keypair from seed
        const keypair = Keypair.fromSeed(seed);
        
        // Zero seed after use
        this.zeroMemory(seed);
        
        // Copy secretKey to ensure caller owns the memory for clearing
        const secretKeyCopy = new Uint8Array(keypair.secretKey);
        
        return {
            publicKey: keypair.publicKey.toBytes(),
            secretKey: secretKeyCopy,
            address: keypair.publicKey.toBase58(),
            nonce: nonce.nonce,
            nonceIndex: nonce.index
        };
    }

    /**
     * Clear burner secret key from memory when no longer needed
     */
    clearBurner(burner: BurnerKeyPair): void {
        this.zeroMemory(burner.secretKey);
    }

    /**
     * Recover burners with early termination on consecutive empty addresses
     */
    async recoverBurners(
        generateNonceAtIndex: (index: number) => Promise<GeneratedNonce>,
        checkOnChainActivity: (address: string) => Promise<boolean>,
        maxIndex: number = 1000
    ): Promise<{ burners: BurnerKeyPair[]; recoveredIndices: number[] }> {
        if (!this._burnerSeed) {
            throw new Error('EncryptionClient not initialized. Call initFromSignature first.');
        }
        
        const burners: BurnerKeyPair[] = [];
        const recoveredIndices: number[] = [];
        let consecutiveEmpty = 0;
        
        for (let i = 0; i < maxIndex; i++) {
            const nonce = await generateNonceAtIndex(i);
            const burner = await this.deriveBurnerFromNonce(nonce);
            
            const hasActivity = await checkOnChainActivity(burner.address);
            
            if (hasActivity) {
                burners.push(burner);
                recoveredIndices.push(i);
                consecutiveEmpty = 0;
            } else {
                // Clean up unused burner
                this.clearBurner(burner);
                consecutiveEmpty++;
                
                // Stop after N consecutive empty addresses
                if (consecutiveEmpty >= CONSECUTIVE_EMPTY_THRESHOLD) {
                    break;
                }
            }
        }
        
        return { burners, recoveredIndices };
    }

    /**
     * Mark a nonce as consumed (one-time use)
     * Called after burner wallet generation is complete
     * Backend should verify and mark nonce as used
     */
    async consumeNonce(
        nonceId: string,
        keyMaterial: EncryptionKeyMaterial
    ): Promise<ConsumeNonceResult> {
        // TODO: Implement
        // 1. Verify we can decrypt the nonce (proves ownership)
        // 2. Send consume request to backend with proof
        // 3. Backend marks nonce as consumed
        // 4. Return result
        throw new Error('Not implemented');
    }

    /**
     * Check if a nonce has been consumed
     */
    async isNonceConsumed(nonceId: string): Promise<boolean> {
        // TODO: Implement - query backend for nonce status
        throw new Error('Not implemented');
    }

    /**
     * Validate nonce before use - ensure not already consumed
     */
    async validateNonceForUse(
        encrypted: EncryptedNonce,
        keyMaterial: EncryptionKeyMaterial
    ): Promise<{ valid: boolean; reason?: string }> {
        // TODO: Implement
        // 1. Check if nonce is consumed
        // 2. Try to decrypt to verify ownership
        // 3. Return validation result
        throw new Error('Not implemented');
    }

    // ============ LOCAL STORAGE METHODS ============

    private static readonly STORAGE_KEY = 'shredr_nonces';

    /**
     * Save nonce to localStorage (client-side storage)
     */
    saveNonceToLocal(data: LocalNonceData): void {
        const existing = this.getLocalNonces();
        existing.push(data);
        localStorage.setItem(EncryptionClient.STORAGE_KEY, JSON.stringify(existing));
    }

    /**
     * Get all local nonces
     */
    getLocalNonces(): LocalNonceData[] {
        const stored = localStorage.getItem(EncryptionClient.STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    }

    /**
     * Remove nonce from local storage
     */
    removeLocalNonce(index: number): void {
        const existing = this.getLocalNonces();
        const filtered = existing.filter(n => n.index !== index);
        localStorage.setItem(EncryptionClient.STORAGE_KEY, JSON.stringify(filtered));
    }

    /**
     * Clear all local nonces
     */
    clearLocalNonces(): void {
        localStorage.removeItem(EncryptionClient.STORAGE_KEY);
    }

    // ============ BACKEND DESTRUCTION METHODS ============

    /**
     * Create a signed proof that we own this nonce and want it destroyed
     * Backend verifies signature before deleting
     */
    async createDestructionProof(
        nonceId: string,
        signMessage: (message: Uint8Array) => Promise<Uint8Array>
    ): Promise<NonceDestructionProof> {
        // TODO: Implement
        // 1. Create message: "DESTROY_NONCE:{nonceId}:{timestamp}"
        // 2. Sign with wallet
        // 3. Return proof
        throw new Error('Not implemented');
    }

    /**
     * Request backend to destroy an encrypted nonce
     * Must provide proof of ownership (signature)
     */
    async requestNonceDestruction(
        proof: NonceDestructionProof
    ): Promise<{ success: boolean; error?: string }> {
        // TODO: Implement
        // 1. Send destruction proof to backend
        // 2. Backend verifies signature
        // 3. Backend deletes encrypted nonce
        // 4. Return result
        throw new Error('Not implemented');
    }

    /**
     * Full consumption flow: destroy on backend + remove locally
     */
    async fullyConsumeNonce(
        nonceId: string,
        localIndex: number,
        signMessage: (message: Uint8Array) => Promise<Uint8Array>
    ): Promise<{ success: boolean; error?: string }> {
        // TODO: Implement
        // 1. Create destruction proof
        // 2. Request backend destruction
        // 3. Remove from localStorage
        // 4. Return result
        throw new Error('Not implemented');
    }

    // ============ HELPER METHODS ============

    /**
     * Convert ArrayBuffer to base64 string
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Convert base64 string to Uint8Array
     */
    private base64ToUint8Array(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Generate cryptographically secure random bytes
     */
    private generateRandomBytes(length: number): Uint8Array {
        return crypto.getRandomValues(new Uint8Array(length));
    }

    /**
     * Zero memory for security
     */
    private zeroMemory(arr: Uint8Array): void {
        crypto.getRandomValues(arr); // Overwrite with random
        arr.fill(0); // Then zero
    }

    /**
     * Clear burner seed from memory
     */
    clearBurnerSeed(): void {
        if (this._burnerSeed) {
            this.zeroMemory(this._burnerSeed);
            this._burnerSeed = null;
        }
    }

    /**
     * Convert Uint8Array to Base58
     */
    private uint8ArrayToBase58(bytes: Uint8Array): string {
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

    /**
     * Import raw key bytes as CryptoKey
     */
    private async importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
        return crypto.subtle.importKey(
            'raw',
            keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
            { name: EncryptionClient.ALGORITHM },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Derive key using PBKDF2
     */
    private async deriveKeyPBKDF2(
        password: Uint8Array,
        salt: Uint8Array,
        iterations: number = 100000
    ): Promise<CryptoKey> {
        const baseKey = await crypto.subtle.importKey(
            'raw',
            password.buffer.slice(password.byteOffset, password.byteOffset + password.byteLength) as ArrayBuffer,
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
                iterations,
                hash: 'SHA-256'
            },
            baseKey,
            { name: EncryptionClient.ALGORITHM, length: EncryptionClient.KEY_LENGTH },
            false,
            ['encrypt', 'decrypt']
        );
    }
}

// ============ SINGLETON EXPORT ============

export const encryptionClient = new EncryptionClient();
