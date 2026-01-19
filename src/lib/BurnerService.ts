/**
 * BurnerService - Handles burner wallet derivation from nonces
 *
 * Responsibilities:
 * - Derive deterministic burner keypairs from nonces
 * - Recover burners by scanning on-chain activity
 * - Secure memory handling for secret keys
 *
 * Note: Nonce management is handled by NonceService
 */

import { Keypair } from '@solana/web3.js';
import { zeroMemory } from './utils';
import { 
    DOMAIN_BURNER_MASTER,
    CONSECUTIVE_EMPTY_THRESHOLD,
} from './constants';
import type { 
    GeneratedNonce,
    BurnerKeyPair,
} from './types';

// ============ BURNER SERVICE ============

export class BurnerService {
    private _burnerSeed: Uint8Array | null = null;

    /**
     * Initialize BurnerService with wallet signature
     * Derives burner seed from signature with domain separation
     */
    async initFromSignature(signature: Uint8Array): Promise<void> {
        const suffix = new TextEncoder().encode(DOMAIN_BURNER_MASTER);
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
            throw new Error('BurnerService not initialized. Call initFromSignature first.');
        }
        
        // Combine burnerSeed + nonce for unique keypair derivation
        const combined = new Uint8Array(this._burnerSeed.length + nonce.nonce.length);
        combined.set(this._burnerSeed, 0);
        combined.set(nonce.nonce, this._burnerSeed.length);
        
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
            throw new Error('BurnerService not initialized. Call initFromSignature first.');
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
     * Clear burner seed from memory
     */
    clearBurnerSeed(): void {
        if (this._burnerSeed) {
            zeroMemory(this._burnerSeed);
            this._burnerSeed = null;
        }
    }

    /**
     * Full cleanup
     */
    destroy(): void {
        this.clearBurnerSeed();
    }
}

// ============ SINGLETON EXPORT ============

export const burnerService = new BurnerService();
