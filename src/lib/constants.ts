/**
 * Shared constants for SHREDR cryptographic operations
 */

// ============ CRYPTO CONSTANTS ============

/** AES-GCM encryption algorithm */
export const ALGORITHM = "AES-GCM";

/** IV length for AES-GCM (12 bytes recommended by NIST) */
export const IV_LENGTH = 12;

// ============ STORAGE CONSTANTS ============

/** IndexedDB database name */
export const DB_NAME = "shredr_secure_storage";

/** IndexedDB database version */
export const DB_VERSION = 1;

/** IndexedDB object store name */
export const STORE_NAME = "nonce_state";

// ============ NONCE CONSTANTS ============

/** Wallet hash length for collision resistance (16 chars = ~96 bits) */
export const WALLET_HASH_LENGTH = 16;

/** Maximum valid nonce index (2^32 - 1) */
export const MAX_NONCE_INDEX = 0xffffffff;

/** Message prefix for wallet signature - change for your own deployment */
export const MASTER_MESSAGE = "SHREDR_V1";

/** Domain separation suffixes for key derivation */
export const DOMAIN_NONCE_MASTER = "SHREDR_NONCE_MASTER"; // Master seed for nonce chain
export const DOMAIN_STORAGE_KEY = "SHREDR_STORAGE_KEY"; // IndexedDB encryption key

// ============ ENCRYPTION SERVICE CONSTANTS ============

/** Domain separation for burner master seed derivation */
export const DOMAIN_BURNER_MASTER = "SHREDR_BURNER_MASTER"; // Master seed for burner derivation

/** Number of consecutive empty addresses before stopping recovery scan */
export const CONSECUTIVE_EMPTY_THRESHOLD = 10;

/** LocalStorage key for nonces */
export const LOCAL_STORAGE_NONCES_KEY = "shredr_nonces";

/** Key length for AES encryption (256 bits) */
export const KEY_LENGTH = 256;

/** Salt length for key derivation (16 bytes) */
export const SALT_LENGTH = 16;

/** PBKDF2 iteration count */
export const PBKDF2_ITERATIONS = 100000;

/** HELIUS RPC URL */
export const HELIUS_RPC_URL =
  "https://rpc-proxy.shredrmoney.workers.dev";
/** HELIUS WSS URL */
export const HELIUS_WSS_URL = "wss://rpc-proxy.shredrmoney.workers.dev";
/** API Base URL */
export const API_BASE_URL = "http://localhost:8000";

/** Transaction fee buffer for sweep operations (covering deposit + transfer) */
export const SWEEP_FEE_BUFFER_LAMPORTS = 25000;

/** Minimum balance threshold before triggering sweep (0.1 SOL) */
export const SWEEP_THRESHOLD_LAMPORTS = 0.1 * 1e9; // 100,000,000 lamports
