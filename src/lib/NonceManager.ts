/**
 * NonceManager - Handles DETERMINISTIC nonce generation for burner wallets
 * 
 * Key Insight: Nonces must be fully deterministic from (wallet signature + index)
 * This enables wallet recovery - re-derive any nonce by signing same message
 * 
 * Nonce Generation (DETERMINISTIC):
 * 1. Sign deterministic message to get master seed
 * 2. nonce[index] = SHA-256(seed || index)
 * 3. Same wallet + same index = same nonce ALWAYS
 * 
 * State Management:
 * - localStorage tracks: nextIndex (next unused index)
 * - consumedIndices: set of used indices
 * - Recovery: iterate indices 0..N, derive each burner, check on-chain
 */

// ============ TYPES ============

export interface NonceState {
    nextIndex: number;           // Next index to use
    consumedIndices: number[];   // List of used indices (for tracking)
    walletPubkeyHash: string;    // First 8 chars to identify wallet
}

export interface GeneratedNonce {
    nonce: Uint8Array;          // 32 bytes raw nonce (deterministic!)
    index: number;
    walletPubkeyHash: string;
}

export interface EncryptedNoncePayload {
    ciphertext: string;         // Base64
    iv: string;                 // Base64  
    version: number;            // For future upgrades
}

export interface BurnerDerivationParams {
    nonce: GeneratedNonce;
    walletPublicKey: Uint8Array;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface DerivedBurner {
    publicKey: Uint8Array;
    secretKey: Uint8Array;      // 64 bytes ed25519 keypair
    address: string;            // Base58 address
    nonceIndex: number;
}

// ============ CONSTANTS ============

const MASTER_MESSAGE = 'SHREDR_V1'; // Single message, derive everything from this
const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;

// ============ DERIVED KEYS ============

export interface DerivedKeys {
    masterSeed: Uint8Array;      // For nonce generation
    encryptionKey: CryptoKey;    // For encrypting nonces
}

// ============ NONCE MANAGER CLASS ============

export class NonceManager {
    
    // ========== SINGLE SIGNATURE → MULTIPLE KEYS ==========

    /**
     * Derive ALL keys from ONE signature (SAFE via domain separation)
     * 
     * User signs: "SHREDR_V1:{pubkey_base58}"
     * Then derive:
     *   - masterSeed = SHA-256(signature || "NONCE_SEED")
     *   - encryptionKey = SHA-256(signature || "ENCRYPT_KEY")
     * 
     * This is safe because:
     * 1. Different suffixes = cryptographically independent outputs
     * 2. Same as HKDF domain separation principle
     * 3. Pubkey in message makes it wallet-specific (extra safety)
     */
    async deriveAllKeys(
        walletPublicKey: Uint8Array,
        signMessage: (message: Uint8Array) => Promise<Uint8Array>
    ): Promise<DerivedKeys> {
        // Single signature with pubkey in message
        const pubkeyBase58 = this.uint8ArrayToBase58(walletPublicKey);
        const message = new TextEncoder().encode(`${MASTER_MESSAGE}:${pubkeyBase58}`);
        const signature = await signMessage(message);
        
        // Derive master seed (for nonces)
        const nonceSuffix = new TextEncoder().encode('NONCE_SEED');
        const nonceInput = new Uint8Array(signature.length + nonceSuffix.length);
        nonceInput.set(signature, 0);
        nonceInput.set(nonceSuffix, signature.length);
        const masterSeedBuffer = await crypto.subtle.digest('SHA-256', nonceInput);
        
        // Derive encryption key (for backend storage)
        const encryptSuffix = new TextEncoder().encode('ENCRYPT_KEY');
        const encryptInput = new Uint8Array(signature.length + encryptSuffix.length);
        encryptInput.set(signature, 0);
        encryptInput.set(encryptSuffix, signature.length);
        const encryptKeyBuffer = await crypto.subtle.digest('SHA-256', encryptInput);
        
        const encryptionKey = await crypto.subtle.importKey(
            'raw',
            encryptKeyBuffer,
            { name: ALGORITHM },
            false,
            ['encrypt', 'decrypt']
        );
        
        return {
            masterSeed: new Uint8Array(masterSeedBuffer),
            encryptionKey
        };
    }

    // ========== DETERMINISTIC NONCE GENERATION ==========

    /**
     * Generate nonce for a specific index (DETERMINISTIC)
     * nonce = SHA-256(masterSeed || index)
     * 
     * Same masterSeed + same index = SAME nonce every time
     * This enables recovery!
     */
    async generateNonceAtIndex(
        masterSeed: Uint8Array,
        index: number,
        walletPublicKey: Uint8Array
    ): Promise<GeneratedNonce> {
        // Combine seed with index
        const indexBytes = new Uint8Array(4);
        new DataView(indexBytes.buffer).setUint32(0, index, true);
        
        const combined = new Uint8Array(masterSeed.length + indexBytes.length);
        combined.set(masterSeed, 0);
        combined.set(indexBytes, masterSeed.length);
        
        const nonceBuffer = await crypto.subtle.digest('SHA-256', combined);
        
        return {
            nonce: new Uint8Array(nonceBuffer),
            index,
            walletPubkeyHash: this.uint8ArrayToBase58(walletPublicKey).slice(0, 8)
        };
    }

    /**
     * Generate the next available nonce and increment state
     */
    async generateNextNonce(
        masterSeed: Uint8Array,
        walletPublicKey: Uint8Array
    ): Promise<GeneratedNonce> {
        const state = this.getState(walletPublicKey);
        const nonce = await this.generateNonceAtIndex(masterSeed, state.nextIndex, walletPublicKey);
        
        // Increment for next use
        state.nextIndex++;
        this.saveState(state);
        
        return nonce;
    }

    // ========== STATE MANAGEMENT ==========

    private static readonly STATE_KEY = 'shredr_nonce_state';

    /**
     * Get current nonce state for wallet
     */
    getState(walletPublicKey: Uint8Array): NonceState {
        const pubkeyHash = this.uint8ArrayToBase58(walletPublicKey).slice(0, 8);
        const stored = localStorage.getItem(NonceManager.STATE_KEY);
        const allStates: Record<string, NonceState> = stored ? JSON.parse(stored) : {};
        
        return allStates[pubkeyHash] || {
            nextIndex: 0,
            consumedIndices: [],
            walletPubkeyHash: pubkeyHash
        };
    }

    /**
     * Save nonce state
     */
    saveState(state: NonceState): void {
        const stored = localStorage.getItem(NonceManager.STATE_KEY);
        const allStates: Record<string, NonceState> = stored ? JSON.parse(stored) : {};
        allStates[state.walletPubkeyHash] = state;
        localStorage.setItem(NonceManager.STATE_KEY, JSON.stringify(allStates));
    }

    /**
     * Mark a nonce index as consumed (used for generation)
     */
    consumeNonceIndex(walletPublicKey: Uint8Array, index: number): void {
        const state = this.getState(walletPublicKey);
        if (!state.consumedIndices.includes(index)) {
            state.consumedIndices.push(index);
            this.saveState(state);
        }
    }

    /**
     * Check if a nonce index has been consumed
     */
    isIndexConsumed(walletPublicKey: Uint8Array, index: number): boolean {
        const state = this.getState(walletPublicKey);
        return state.consumedIndices.includes(index);
    }

    // ========== ENCRYPTION (for backend storage) ==========

    /**
     * Encrypt nonce for backend storage
     * Backend stores encrypted nonces but can't read them
     */
    async encryptNonce(
        nonce: GeneratedNonce,
        encryptionKey: CryptoKey
    ): Promise<EncryptedNoncePayload> {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        
        const payload = JSON.stringify({
            nonce: this.uint8ArrayToBase64(nonce.nonce),
            index: nonce.index,
            walletPubkeyHash: nonce.walletPubkeyHash
        });
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: ALGORITHM, iv },
            encryptionKey,
            new TextEncoder().encode(payload)
        );
        
        return {
            ciphertext: this.uint8ArrayToBase64(new Uint8Array(ciphertext)),
            iv: this.uint8ArrayToBase64(iv),
            version: 1
        };
    }

    /**
     * Decrypt nonce from backend
     * Returns null if wrong key (not our nonce)
     */
    async decryptNonce(
        encrypted: EncryptedNoncePayload,
        encryptionKey: CryptoKey
    ): Promise<GeneratedNonce | null> {
        try {
            const ciphertext = this.base64ToUint8Array(encrypted.ciphertext);
            const iv = this.base64ToUint8Array(encrypted.iv);
            
            const decrypted = await crypto.subtle.decrypt(
                { name: ALGORITHM, iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
                encryptionKey,
                ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
            );
            
            const payload = JSON.parse(new TextDecoder().decode(decrypted));
            
            return {
                nonce: this.base64ToUint8Array(payload.nonce),
                index: payload.index,
                walletPubkeyHash: payload.walletPubkeyHash
            };
        } catch {
            return null;
        }
    }

    // ========== BURNER DERIVATION ==========

    /**
     * Derive burner keypair from nonce (DETERMINISTIC)
     * seed = SHA-256(masterSeed || nonce || "BURNER")
     * keypair = ed25519_from_seed(seed)
     */
    async deriveBurner(
        masterSeed: Uint8Array,
        nonce: GeneratedNonce
    ): Promise<DerivedBurner> {
        const burnerMarker = new TextEncoder().encode('BURNER');
        
        const combined = new Uint8Array(masterSeed.length + nonce.nonce.length + burnerMarker.length);
        combined.set(masterSeed, 0);
        combined.set(nonce.nonce, masterSeed.length);
        combined.set(burnerMarker, masterSeed.length + nonce.nonce.length);
        
        const seedBuffer = await crypto.subtle.digest('SHA-256', combined);
        const seed = new Uint8Array(seedBuffer);
        
        // TODO: Use @solana/web3.js Keypair.fromSeed(seed) 
        // or tweetnacl: nacl.sign.keyPair.fromSeed(seed)
        throw new Error('Implement with ed25519 library - use Keypair.fromSeed(seed)');
    }

    // ========== RECOVERY ==========

    /**
     * Recover all burners by iterating through indices
     * For each index 0..maxIndex:
     *   1. Derive nonce[i]
     *   2. Derive burner[i]
     *   3. Check if burner has any on-chain activity
     */
    async recoverBurners(
        masterSeed: Uint8Array,
        walletPublicKey: Uint8Array,
        maxIndex: number = 100
    ): Promise<{ burners: GeneratedNonce[]; recoveredIndices: number[] }> {
        const burners: GeneratedNonce[] = [];
        const recoveredIndices: number[] = [];
        
        for (let i = 0; i < maxIndex; i++) {
            const nonce = await this.generateNonceAtIndex(masterSeed, i, walletPublicKey);
            burners.push(nonce);
            recoveredIndices.push(i);
            
            // TODO: Actually derive burner and check on-chain
            // const burner = await this.deriveBurner(masterSeed, nonce);
            // const hasActivity = await checkOnChainActivity(burner.address);
            // if (hasActivity) { ... }
        }
        
        return { burners, recoveredIndices };
    }

    // ========== HELPER METHODS ==========

    private uint8ArrayToBase64(bytes: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private base64ToUint8Array(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    private uint8ArrayToBase58(bytes: Uint8Array): string {
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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
}

// ============ SINGLETON EXPORT ============

export const nonceManager = new NonceManager();
