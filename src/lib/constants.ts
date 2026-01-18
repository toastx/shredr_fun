/**
 * Shared constants for SHREDR cryptographic operations
 */

// ============ CRYPTO CONSTANTS ============

/** AES-GCM encryption algorithm */
export const ALGORITHM = 'AES-GCM';

/** IV length for AES-GCM (12 bytes recommended by NIST) */
export const IV_LENGTH = 12;

// ============ STORAGE CONSTANTS ============

/** IndexedDB database name */
export const DB_NAME = 'shredr_secure_storage';

/** IndexedDB database version */
export const DB_VERSION = 1;

/** IndexedDB object store name */
export const STORE_NAME = 'nonce_state';

// ============ NONCE CONSTANTS ============

/** Wallet hash length for collision resistance (16 chars = ~96 bits) */
export const WALLET_HASH_LENGTH = 16;

/** Maximum valid nonce index (2^32 - 1) */
export const MAX_NONCE_INDEX = 0xFFFFFFFF;

/** Message prefix for wallet signature - change for your own deployment */
export const MASTER_MESSAGE = 'SHREDR_V1';

/** Domain separation suffixes for key derivation */
export const DOMAIN_NONCE_SEED = 'SHREDR_NONCE_SEED';
export const DOMAIN_ENCRYPT_KEY = 'SHREDR_ENCRYPT_KEY';
