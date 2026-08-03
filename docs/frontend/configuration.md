---
description: "Every constant, what it controls, and which ones are actually wired to the environment."
icon: sliders
---

# Constants and configuration

All frontend configuration lives in `src/lib/constants.ts`. This page documents every value and — importantly — which ones you can actually change without editing code.

## The environment variable situation

{% hint style="danger" %}
**`.env.example` is aspirational.** Of the seven `VITE_*` variables it lists, only **one** is read at runtime:

| Variable | Actually read? |
|---|---|
| `VITE_KORA_RELAYER_PUBKEY` | ✅ Yes, via `getEnvironmentRelayerPubkey()` in `KoraRelayer.ts` |
| `VITE_KORA_RELAYER_URL` | ❌ No — `KORA_RELAYER_URL` is hardcoded |
| `VITE_HELIUS_RPC_URL` | ❌ No — hardcoded, **including an API key** |
| `VITE_HELIUS_WSS_URL` | ❌ No — hardcoded, including the same key |
| `VITE_MAGICBLOCK_RPC_URL` | ❌ No — hardcoded |
| `VITE_MAGICBLOCK_WSS_URL` | ❌ No — hardcoded, and unused entirely |
| `VITE_API_BASE_URL` | ❌ No — hardcoded |

To change any of them today, **edit `src/lib/constants.ts`**. Setting the environment variable has no effect.
{% endhint %}

There is also a **committed Helius API key** in `constants.ts`. It ships in the client bundle, so it is public by construction — but it should be rotated and moved behind `import.meta.env` before any real deployment.

Wiring the rest up is a small change:

```typescript
export const HELIUS_RPC_URL =
  import.meta.env.VITE_HELIUS_RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=...";
```

## Crypto

| Constant | Value | Purpose |
|---|---|---|
| `ALGORITHM` | `"AES-GCM"` | Symmetric cipher for all encryption |
| `IV_LENGTH` | `12` | GCM IV size (NIST recommendation) |
| `KEY_LENGTH` | `256` | AES key size — **declared, unused** |
| `SALT_LENGTH` | `16` | **Declared, unused** |
| `PBKDF2_ITERATIONS` | `100000` | **Declared, unused** — keys come from SHA-256 of the signature, not PBKDF2 |

## Storage

| Constant | Value |
|---|---|
| `DB_NAME` | `shredr_secure_storage` |
| `DB_VERSION` | `1` |
| `STORE_NAME` | `nonce_state` |
| `WALLET_HASH_LENGTH` | `16` — base58 chars of the truncated hash (~96 bits) |
| `LOCAL_STORAGE_NONCES_KEY` | `shredr_nonces` — **declared, unused** |

## Domain separation

Appended to the signature before hashing, so each derivation is independent:

| Constant | Value | Derives |
|---|---|---|
| `MASTER_MESSAGE` | `"SHREDR_V1"` | The message you sign (as `SHREDR_V1:<wallet>`) |
| `DOMAIN_NONCE_MASTER` | `"SHREDR_NONCE_MASTER"` | Nonce chain master seed |
| `DOMAIN_STORAGE_KEY` | `"SHREDR_STORAGE_KEY"` | AES key for IndexedDB and blobs |
| `DOMAIN_BURNER_MASTER` | `"SHREDR_BURNER_MASTER"` | Burner keypair seed |
| `DOMAIN_MAIN_BURNER` | `"SHREDR_MAIN_BURNER"` | Permanent main burner |

{% hint style="danger" %}
**Changing any of these breaks every existing user.** Different tags mean different seeds, which means different burners and a storage key that cannot decrypt existing state. Funds on old burners would be unreachable through the app.

If you fork shredr for your own deployment, change `MASTER_MESSAGE` **before** anyone uses it — that is what the "change for your own deployment" comment in the source refers to.
{% endhint %}

## Nonce chain

| Constant | Value | Purpose |
|---|---|---|
| `MAX_NONCE_INDEX` | `0xffffffff` | Chain length cap (2³² − 1) |
| `CONSECUTIVE_EMPTY_THRESHOLD` | `10` | Stop `recoverBurners()` after this many misses |
| `MAX_UTXO_SCAN_INDEX` | `64` | Highest index `scanPendingUtxos()` checks |
| `UTXO_SCAN_EMPTY_THRESHOLD` | `5` | Stop the UTXO scan after this many consecutive empties |

## Network endpoints

| Constant | Value |
|---|---|
| `HELIUS_RPC_URL` | `https://devnet.helius-rpc.com/?api-key=<committed key>` |
| `HELIUS_WSS_URL` | `wss://devnet.helius-rpc.com/?api-key=<committed key>` |
| `API_BASE_URL` | `http://localhost:8000` |
| `KORA_RELAYER_URL` | `http://localhost:8080` |
| `MAGICBLOCK_RPC_URL` | `https://devnet.magicblock.app` |
| `MAGICBLOCK_WSS_URL` | `wss://devnet.magicblock.app` — **declared, unused** |

## Program IDs

| Constant | Value |
|---|---|
| `KORA_RELAYER_PUBKEY` | `shredrWUYk1famp42neAhaJb9PAB69WoSTDhMUdcbjS` |
| `MAGIC_BLOCK_PROGRAM_ID` | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSS` |
| `MAGIC_CONTEXT` | `MagicContext1111111111111111111111111111111` |
| `PERMISSION_PROGRAM_ID` | `EPHpaA1tt7nJpEgAjRwkPx5tWHiV6cfKZjPPDDZxFKa9` |

The shredr program ID itself comes from the generated client (`SHREDR_PROGRAM_PROGRAM_ADDRESS`), not from `constants.ts`.

## Timing

| Constant | Value | Purpose |
|---|---|---|
| `UNDELEGATION_TIMEOUT_MS` | `120_000` | Max wait for a commit to settle back |
| `UNDELEGATION_POLL_INTERVAL_MS` | `2_000` | Poll interval while waiting |

## Declared but not implemented

{% hint style="info" %}
These constants are defined but not wired into any code path. They exist in both `src/lib/constants.ts` and `shredr-program/src/constants.rs` and are referenced nowhere else.
{% endhint %}

| Constant | Value | Intent |
|---|---|---|
| `NORMALIZED_DENOMINATIONS_SOL` | `[1, 10, 100, 1000]` | The standard payment sizes to use |
| `DEFAULT_DENOMINATION_SOL` | `1` | Default of the above |
| `COMMIT_DELAY_MIN_SECS` | `6 * 60 * 60` (6h) | Lower bound of a randomized commit delay |
| `COMMIT_DELAY_MAX_SECS` | `48 * 60 * 60` (48h) | Upper bound |
| `SWEEP_FEE_BUFFER_LAMPORTS` | `25000` | Fee headroom for sweeps |
| `SWEEP_THRESHOLD_LAMPORTS` | `0.1 * 1e9` | Minimum balance before sweeping |

`ShredrClient` does expose `preferredDenomination` and `setPreferredDenomination()`, and carries the value in its state — but nothing reads it when building transactions, so choosing a normalized amount is currently up to the user.

→ [Limitations](../reference/limitations.md) · [The privacy model](../concepts/privacy-model.md)

## Keeping TS and Rust in sync

`shredr-program/src/constants.rs` mirrors several values and says so explicitly:

> **NOTE**: Values here must remain consistent with the canonical client-side constants in `src/lib/constants.ts`. The TypeScript file is the source of truth — update it first, then mirror here.

Mirrored: PDA seeds, denominations, commit delays, the fixed salt, and the MagicBlock/ACL program IDs.

{% hint style="warning" %}
The mirroring is manual — nothing enforces it. A change on one side that is not copied to the other will not fail to compile.

The one automated guard is `tests/ShredrProgram.test.ts`, which pins instruction discriminators, PDA seeds, account metas, and data layouts against the generated client, so *wire format* drift is caught by `npm test`.
{% endhint %}

## Build configuration

| File | Purpose |
|---|---|
| `vite.config.ts` | Vite + React plugin |
| `tsconfig.json` / `.app.json` / `.node.json` | Project-references TypeScript setup |
| `eslint.config.js` | Flat ESLint config with React hooks and refresh plugins |
| `.mocharc.json` | Mocha config (loads `tests/setup.ts`) |
| `scripts/generate-client.mjs` | Codama client generation |

## Next

* [Local development](../getting-started/local-development.md) — running with these settings
* [Limitations](../reference/limitations.md) — what the unused constants imply
