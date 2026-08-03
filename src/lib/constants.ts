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

/** Domain separation for main burner derivation (persistent, controls main PDA) */
export const DOMAIN_MAIN_BURNER = "SHREDR_MAIN_BURNER";

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
  "https://devnet.helius-rpc.com/?api-key=1ab08206-1c39-410d-b578-58445eed25ed";
/** HELIUS WSS URL */
export const HELIUS_WSS_URL = "wss://devnet.helius-rpc.com/?api-key=1ab08206-1c39-410d-b578-58445eed25ed";
/** API Base URL */
export const API_BASE_URL = "http://localhost:8000";

// ============ DOCUMENTATION ============

/**
 * Public documentation URL, linked from the navbar.
 *
 * The docs live in `docs/` as a GitBook Git-Sync repo. Until that site is
 * published, this points at the rendered markdown on GitHub — swap it for the
 * GitBook hostname once the site is live.
 */
export const DOCS_URL =
  "https://github.com/toastx/shredr_fun/tree/main/docs";

/** Transaction fee buffer for sweep operations (covering deposit + transfer) */
export const SWEEP_FEE_BUFFER_LAMPORTS = 25000;

/** Minimum balance threshold before triggering sweep (0.1 SOL) */
export const SWEEP_THRESHOLD_LAMPORTS = 0.1 * 1e9; // 100,000,000 lamports

// ============ KORA RELAYER ============

/**
 * Kora paymaster/relayer endpoint.
 * Kora signs transactions as the fee payer (and as the on-chain `relayer` account
 * for InitializeAndDelegate / CommitAndUndelegate instructions).
 *
 * Override at deploy time as needed.
 */
export const KORA_RELAYER_URL = "http://localhost:8080";

/** Kora's relayer pubkey (the fee payer account that Kora signs as).
 *  Set this to the actual Kora-managed pubkey at deploy time, or provide it
 *  through VITE_KORA_RELAYER_PUBKEY / KORA_RELAYER_PUBKEY. If omitted,
 *  the client will try to fetch it from the Kora service via getConfig.
 */
export const KORA_RELAYER_PUBKEY = "shredrWUYk1famp42neAhaJb9PAB69WoSTDhMUdcbjS";

// ============ MAGICBLOCK ROLLUP ============

/** MagicBlock ephemeral rollup RPC URL.
 *  Used to send PrivateTransfer instructions inside the rollup
 *  (as opposed to the base layer Solana RPC).
 */
export const MAGICBLOCK_RPC_URL = "https://devnet.magicblock.app";
export const MAGICBLOCK_WSS_URL = "wss://devnet.magicblock.app";

/** MagicBlock delegation program ID (base layer). */
export const MAGIC_BLOCK_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSS";

/** MagicBlock context account (singleton, static). */
export const MAGIC_CONTEXT = "MagicContext1111111111111111111111111111111";

/** ACL Permission program ID (used by InitializeAndDelegate). */
export const PERMISSION_PROGRAM_ID = "EPHpaA1tt7nJpEgAjRwkPx5tWHiV6cfKZjPPDDZxFKa9";

// ============ SHREDR DENOMINATIONS ============

/** Allowed normalized denominations (SOL) for amount-correlation resistance. */
export const NORMALIZED_DENOMINATIONS_SOL = [1, 10, 100, 1000] as const;
export type NormalizedDenomination = (typeof NORMALIZED_DENOMINATIONS_SOL)[number];

/** Default user-preferred denomination (SOL). */
export const DEFAULT_DENOMINATION_SOL: NormalizedDenomination = 1;

/** Random commit-delay window (seconds). 6h..48h. */
export const COMMIT_DELAY_MIN_SECS = 6 * 60 * 60;
export const COMMIT_DELAY_MAX_SECS = 48 * 60 * 60;

/** How long to wait for a committed stealth PDA to settle back on the base
 *  layer (commit → delegation program → `UndelegationCallback`). */
export const UNDELEGATION_TIMEOUT_MS = 120_000;

/** Poll interval while waiting for undelegation. */
export const UNDELEGATION_POLL_INTERVAL_MS = 2_000;

/** Maximum index for pending-UTXO scanning. */
export const MAX_UTXO_SCAN_INDEX = 64;

/** Number of consecutive empty stealth-PDAs before stopping the UTXO scan. */
export const UTXO_SCAN_EMPTY_THRESHOLD = 5;
