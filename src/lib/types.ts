/**
 * Shared types for SHREDR services
 */

// ============ STORAGE TYPES ============

export interface NonceState {
    currentNonce: string;  // Base64 encoded current nonce
    currentIndex: number;
    walletPubkeyHash: string;
}

// ============ NONCE TYPES ============

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

// ============ ENCRYPTION TYPES ============

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

// ============ ERROR TYPES ============

export class DecryptionError extends Error {
    readonly reason: 'wrong_key' | 'corrupted' | 'unknown';
    
    constructor(reason: 'wrong_key' | 'corrupted' | 'unknown', message: string) {
        super(message);
        this.name = 'DecryptionError';
        this.reason = reason;
    }
}
