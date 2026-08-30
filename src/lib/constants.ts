/**
 * Shared constants for SHREDR cryptographic operations
 */

// ============ ENVIRONMENT ============

/** True inside a Vite dev server build (`import.meta.env.DEV`). */
function isViteDevBuild(): boolean {
  return (
    typeof import.meta !== "undefined" &&
    Boolean(
      (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.DEV,
    )
  );
}

/** Raw lookup across Vite and node environments, in that order. */
function rawEnv(key: string): string | undefined {
  const viteEnv =
    typeof import.meta !== "undefined"
      ? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
      : undefined;

  const nodeEnv = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;

  return viteEnv?.[key] || nodeEnv?.[key] || undefined;
}

/**
 * Which set of secrets to read. `VITE_ENVIRONMENT=dev` selects the `VITE_DEV_*`
 * variables; anything else (or unset) uses the plain `VITE_*` ones.
 *
 * Deliberately defaults to production. A missing or misspelled value must not
 * silently hand a deployed build a developer's endpoints — the safe default is
 * the one you have to opt out of.
 */
export const ENVIRONMENT: "dev" | "prod" =
  (rawEnv("VITE_ENVIRONMENT") ?? rawEnv("ENVIRONMENT"))?.toLowerCase() === "dev"
    ? "dev"
    : "prod";

export const IS_DEV_ENVIRONMENT = ENVIRONMENT === "dev";

/**
 * Reads a deployment-configured value from the environment.
 *
 * In dev, `VITE_FOO` is looked up as `VITE_DEV_FOO` first. The plain variable
 * is still used as a fallback so a partial dev config works, but that path
 * warns loudly: falling through means a dev build is talking to whatever the
 * production variable points at, which for a system moving funds is worth
 * seeing rather than discovering later.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time; the `process.env`
 * fallback covers non-Vite consumers (node scripts, tests). Missing values
 * come back as `""` so callers fail loudly at the point of use rather than
 * silently talking to a stale hardcoded default.
 *
 * See `.env.example` for the full list.
 */
function env(key: string): string {
  if (IS_DEV_ENVIRONMENT) {
    const devKey = key.startsWith("VITE_")
      ? `VITE_DEV_${key.slice("VITE_".length)}`
      : `DEV_${key}`;

    const devValue = rawEnv(devKey);
    if (devValue) return devValue;

    if (rawEnv(key)) {
      console.warn(
        `[shredr] ${devKey} is unset — falling back to ${key}. ` +
          `This dev build is using the production value.`,
      );
    }
  }

  const value = rawEnv(key) ?? "";

  // Dev builds only, as before: a production console should not narrate its
  // own configuration on every missing value.
  if (!value && isViteDevBuild()) {
    console.warn(`[shredr] missing environment variable ${key} — see .env.example`);
  }

  return value;
}

// ============ CRYPTO CONSTANTS ============

/** AES-GCM encryption algorithm */
export const ALGORITHM = "AES-GCM";

/** IV length for AES-GCM (12 bytes recommended by NIST) */
export const IV_LENGTH = 12;

// ============ STORAGE CONSTANTS ============

/** IndexedDB database name */
export const DB_NAME = "shredr_secure_storage";

/** IndexedDB database version */
export const DB_VERSION = 2;

/** IndexedDB object store name */
export const STORE_NAME = "nonce_state";

/** Encrypted UTXO note tree, keyed by wallet hash. Added in DB_VERSION 2. */
export const NOTES_STORE_NAME = "utxo_notes";

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

// ============ AUDIT / VIEWING KEY CONSTANTS ============

/**
 * Domain separation for the audit master seed.
 *
 * A *sibling* of the burner branch, never a child: a viewing key must never be
 * derivable from burner material, and the audit tree has to survive being
 * re-rooted (shielded pool) without invalidating keys already disclosed.
 */
export const DOMAIN_AUDIT_MASTER = "SHREDR_AUDIT_MASTER";

/** HKDF `info` label for per-invoice viewing keys. */
export const LABEL_VIEWING_KEY = "SHREDR_VK_V1";

/** Prefix for the bytes a burner signs when attesting to an invoice. */
export const LABEL_ATTEST = "SHREDR_ATTEST_V1";

/** Commitment labels. Deposit and exit legs MUST use different ones — an equal
 *  commitment in two accounts is a public equality test that rebuilds the link
 *  the in-rollup hop exists to hide. */
export const LABEL_DEPOSIT_COMMITMENT = "SHREDR_DEP_V1";
export const LABEL_LEAF = "SHREDR_LEAF_V1";
export const LABEL_ROOT = "SHREDR_ROOT_V1";

/** Bytes of key material a single HKDF expansion yields: 32 key + 12 GCM IV. */
export const VIEWING_KEY_MATERIAL_BYTES = 44;

/** Width of an on-chain receipt commitment, and of the `salt` slot it occupies. */
export const COMMITMENT_BYTES = 32;

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

/** HELIUS RPC URL (env: VITE_HELIUS_RPC_URL) */
export const HELIUS_RPC_URL = env("VITE_HELIUS_RPC_URL");
/** HELIUS WSS URL (env: VITE_HELIUS_WSS_URL) */
export const HELIUS_WSS_URL = env("VITE_HELIUS_WSS_URL");
/** API Base URL (env: VITE_API_BASE_URL) */
export const API_BASE_URL = env("VITE_API_BASE_URL");

/**
 * Blobs requested per page. The backend clamps `limit` to 1–100
 * (`docs/backend/api-reference.md`), so 100 is the largest useful value.
 */
export const BLOB_PAGE_SIZE = 100;

/**
 * Hard ceiling on pages walked in one fetch.
 *
 * Blobs carry no user identifier, so recovery downloads the whole set and
 * trial-decrypts it — the walk is bounded only by total blobs across all users.
 * This caps worst-case login time, and stops a backend that ignores `cursor`
 * from spinning forever.
 */
export const BLOB_MAX_PAGES = 200;

/**
 * Backend's `MAX_BLOB_SIZE`, in bytes, measured on the base64 payload
 * (`docs/backend/database.md`). A larger blob is rejected with 400, so the
 * UTXO tree has to stay under it or it silently stops publishing.
 */
export const MAX_BLOB_BYTES = 2048;

// ============ DOCUMENTATION ============

/**
 * Public documentation URL, linked from the navbar.
 *
 * Published GitBook site, synced from the `docs/` directory in this repo.
 */
export const DOCS_URL = "https://toastx.gitbook.io/shredr";

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
 * env: VITE_KORA_RELAYER_URL
 */
export const KORA_RELAYER_URL = env("VITE_KORA_RELAYER_URL");

/** Kora instance whose RPC_URL is the MagicBlock ephemeral rollup.
 *
 *  Kora simulates every signTransaction against its own RPC, so a rollup
 *  transaction (built on a rollup blockhash, touching delegated PDAs) has to be
 *  signed by a Kora looking at the rollup — the base-layer instance rejects it
 *  with "Blockhash not found". Same signer, different RPC_URL.
 *
 *  env: VITE_KORA_ROLLUP_RELAYER_URL
 */
export const KORA_ROLLUP_RELAYER_URL = env("VITE_KORA_ROLLUP_RELAYER_URL");

/** Kora's relayer pubkey (the fee payer account that Kora signs as).
 *  env: VITE_KORA_RELAYER_PUBKEY. If unset, the client falls back to the other
 *  sources in `getEnvironmentRelayerPubkey()` and finally fetches it from the
 *  Kora service via getConfig.
 */
export const KORA_RELAYER_PUBKEY = env("VITE_KORA_RELAYER_PUBKEY");

// ============ MAGICBLOCK ROLLUP ============

/** MagicBlock ephemeral rollup RPC URL.
 *  Used to send PrivateTransfer instructions inside the rollup
 *  (as opposed to the base layer Solana RPC).
 *
 *  env: VITE_MAGICBLOCK_RPC_URL / VITE_MAGICBLOCK_WSS_URL
 */
export const MAGICBLOCK_RPC_URL = env("VITE_MAGICBLOCK_RPC_URL");
export const MAGICBLOCK_WSS_URL = env("VITE_MAGICBLOCK_WSS_URL");

/** MagicBlock delegation program ID (base layer).
 *  Matches `DELEGATION_PROGRAM_ID` in ephemeral-rollups-pinocchio. */
export const MAGIC_BLOCK_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

/** MagicBlock magic program ID — the rollup-side program that handles
 *  ScheduleCommit / ScheduleCommitAndUndelegate. This is the CPI target for
 *  CommitStealth and CommitAndUndelegateStealth, *not* the delegation program.
 *  Matches `MAGIC_PROGRAM_ID` in ephemeral-rollups-pinocchio. */
export const MAGIC_PROGRAM_ID = "Magic11111111111111111111111111111111111111";

/** MagicBlock context account (singleton, static). */
export const MAGIC_CONTEXT = "MagicContext1111111111111111111111111111111";

/** ACL Permission program ID (used by InitializeAndDelegate).
 *  Matches `acl::consts::PERMISSION_PROGRAM_ID` in ephemeral-rollups-pinocchio,
 *  which is what the program CPIs into — the client must derive the permission
 *  PDA under this same address. */
export const PERMISSION_PROGRAM_ID = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";

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
