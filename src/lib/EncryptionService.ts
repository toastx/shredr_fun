/**
 * EncryptionService - Handles wallet-based encryption/decryption for privacy-preserving burner addresses
 *
 * Flow:
 * 1. Derive encryption key from main wallet signature
 * 2. Generate burner nonces and encrypt them
 * 3. Store encrypted nonces on backend (backend doesn't know ownership)
 * 4. Recovery: fetch all nonces, try decrypt each, success = your nonce
 */

import { Keypair } from '@solana/web3.js';
import { 
    zeroMemory, 
    uint8ArrayToBase64, 
    base64ToUint8Array, 
    getArrayBuffer,
    generateRandomBytes 
} from './utils';
import { 
    ALGORITHM, 
    IV_LENGTH,
    KEY_LENGTH,
    PBKDF2_ITERATIONS,
    DOMAIN_BURNER_SEED, 
    DOMAIN_BURNER, 
    CONSECUTIVE_EMPTY_THRESHOLD,
    LOCAL_STORAGE_NONCES_KEY
} from './constants';
import type { 
    GeneratedNonce,
    BurnerKeyPair,
    EncryptionKeyMaterial,
    ConsumeNonceResult,
    EncryptedNonce,
    LocalNonceData,
    NonceDestructionProof
} from './types';

// ============ ENCRYPTION SERVICE ============

export class EncryptionService {
    private _burnerSeed: Uint8Array | null = null;

    /**
     * Initialize EncryptionService with wallet signature
     * Derives burner seed from signature with domain separation
     */
    async initFromSignature(signature: Uint8Array): Promise<void> {
        const suffix = new TextEncoder().encode(DOMAIN_BURNER_SEED);
        const input = new Uint8Array(signature.length + suffix.length);
        input.set(signature, 0);
        input.set(suffix, signature.length);
        
        const seedBuffer = await crypto.subtle.digest('SHA-256', input);
        zeroMemory(input);
        
        this._burnerSeed = new Uint8Array(seedBuffer);
    }

    /**
     * Check if service is initialized
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
            throw new Error('EncryptionService not initialized. Call initFromSignature first.');
        }
        
        const burnerMarker = new TextEncoder().encode(DOMAIN_BURNER);
        
        const combined = new Uint8Array(this._burnerSeed.length + nonce.nonce.length + burnerMarker.length);
        combined.set(this._burnerSeed, 0);
        combined.set(nonce.nonce, this._burnerSeed.length);
        combined.set(burnerMarker, this._burnerSeed.length + nonce.nonce.length);
        
        const seedBuffer = await crypto.subtle.digest('SHA-256', combined);
        const seed = new Uint8Array(seedBuffer);
        
        // Zero intermediate
        zeroMemory(combined);
        
        // Generate ed25519 keypair from seed
        const keypair = Keypair.fromSeed(seed);
        
        // Zero seed after use
        zeroMemory(seed);
        
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
        zeroMemory(burner.secretKey);
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
            throw new Error('EncryptionService not initialized. Call initFromSignature first.');
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

    /**
     * Save nonce to localStorage (client-side storage)
     */
    saveNonceToLocal(data: LocalNonceData): void {
        const existing = this.getLocalNonces();
        existing.push(data);
        localStorage.setItem(LOCAL_STORAGE_NONCES_KEY, JSON.stringify(existing));
    }

    /**
     * Get all local nonces
     */
    getLocalNonces(): LocalNonceData[] {
        const stored = localStorage.getItem(LOCAL_STORAGE_NONCES_KEY);
        return stored ? JSON.parse(stored) : [];
    }

    /**
     * Remove nonce from local storage
     */
    removeLocalNonce(index: number): void {
        const existing = this.getLocalNonces();
        const filtered = existing.filter(n => n.index !== index);
        localStorage.setItem(LOCAL_STORAGE_NONCES_KEY, JSON.stringify(filtered));
    }

    /**
     * Clear all local nonces
     */
    clearLocalNonces(): void {
        localStorage.removeItem(LOCAL_STORAGE_NONCES_KEY);
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
        const timestamp = Date.now();
        const message = new TextEncoder().encode(`DESTROY_NONCE:${nonceId}:${timestamp}`);
        const signature = await signMessage(message);
        
        return {
            nonceId,
            destructionSignature: uint8ArrayToBase64(signature),
            timestamp
        };
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
        try {
            const proof = await this.createDestructionProof(nonceId, signMessage);
            const result = await this.requestNonceDestruction(proof);
            
            if (result.success) {
                this.removeLocalNonce(localIndex);
            }
            
            return result;
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    /**
     * Clear burner seed from memory
     */
    clearBurnerSeed(): void {
        if (this._burnerSeed) {
            zeroMemory(this._burnerSeed);
            this._burnerSeed = null;
        }
    }

    /**
     * Import raw key bytes as CryptoKey
     */
    async importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
        return crypto.subtle.importKey(
            'raw',
            getArrayBuffer(keyBytes),
            { name: ALGORITHM },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Derive key using PBKDF2
     */
    async deriveKeyPBKDF2(
        password: Uint8Array,
        salt: Uint8Array,
        iterations: number = PBKDF2_ITERATIONS
    ): Promise<CryptoKey> {
        const baseKey = await crypto.subtle.importKey(
            'raw',
            getArrayBuffer(password),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: getArrayBuffer(salt),
                iterations,
                hash: 'SHA-256'
            },
            baseKey,
            { name: ALGORITHM, length: KEY_LENGTH },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Encrypt data with AES-GCM
     */
    async encrypt(data: Uint8Array, key: CryptoKey): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
        const iv = generateRandomBytes(IV_LENGTH);
        const ciphertext = await crypto.subtle.encrypt(
            { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
            key,
            getArrayBuffer(data)
        );
        return { ciphertext: new Uint8Array(ciphertext), iv };
    }

    /**
     * Decrypt data with AES-GCM
     */
    async decrypt(ciphertext: Uint8Array, iv: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
        const decrypted = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv: getArrayBuffer(iv) },
            key,
            getArrayBuffer(ciphertext)
        );
        return new Uint8Array(decrypted);
    }
}

// ============ SINGLETON EXPORT ============

export const encryptionService = new EncryptionService();
