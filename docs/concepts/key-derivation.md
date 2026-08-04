---
description: "How one wallet signature becomes every key in the system."
icon: key
---

# Key derivation

Everything in shredr — every burner, every encryption key, your consolidation account — comes from a **single wallet signature**. This page shows exactly how, and why it is safe.

## The starting point

You sign this message with your wallet:

```
SHREDR_V1:<your wallet address in base58>
```

The prefix `SHREDR_V1` is `MASTER_MESSAGE` in `src/lib/constants.ts`. Appending your own address means two different wallets never produce the same signature even in the impossible case of identical keys.

The wallet returns a 64-byte ed25519 signature. That signature is the root secret. It never leaves your browser and is never stored.

{% hint style="info" %}
**Why a signature works as a seed.** Ed25519 signing is deterministic: the same key over the same message always yields exactly the same bytes. So the "seed" can be reproduced on demand from the wallet, rather than stored anywhere.
{% endhint %}

## Domain separation

The signature is used four separate ways. Feeding it directly into all four would mean a leak in one context compromises the others, so each derivation appends a distinct **domain tag** before hashing:

```
masterSeed(nonce)   = SHA256( signature ‖ "SHREDR_NONCE_MASTER" )
storageKey          = SHA256( signature ‖ "SHREDR_STORAGE_KEY"  )
burnerSeed          = SHA256( signature ‖ "SHREDR_BURNER_MASTER")
mainBurnerSeed      = SHA256( signature ‖ "SHREDR_MAIN_BURNER"  )
```

Four different tags, four unrelated 32-byte outputs. Because SHA-256 is one-way, recovering any one of them tells an attacker nothing about the other three or about the signature itself.

The tags are the `DOMAIN_*` constants in `src/lib/constants.ts`.

## The full tree

```
                    Wallet signature (64 bytes)
                              │
        ┌─────────────┬───────┴───────┬─────────────────┐
        │             │               │                 │
 "NONCE_MASTER" "STORAGE_KEY"  "BURNER_MASTER"   "MAIN_BURNER"
        │             │               │                 │
        ▼             ▼               ▼                 ▼
   masterSeed    storageKey      burnerSeed      mainBurnerSeed
        │             │               │                 │
        │             │               │                 ▼
        │             ▼               │          Keypair.fromSeed
        │      AES-GCM key for        │                 │
        │      IndexedDB + blobs      │                 ▼
        │                             │           Main burner
        ▼                             │                 │
   nonce[0] = SHA256(masterSeed)      │                 ▼
   nonce[1] = SHA256(nonce[0])        │        PDA(["shredr_stealth_address",
   nonce[2] = SHA256(nonce[1])        │              mainBurner.pubkey])
        ⋮                             │                 │
        │                             │                 ▼
        └──────────┬──────────────────┘             Main PDA
                   │
                   ▼
    burnerSeed_N = SHA256( burnerSeed ‖ nonce[N] )
                   │
                   ▼
            Keypair.fromSeed
                   │
                   ▼
              Burner #N
                   │
                   ▼
      PDA(["shredr_stealth_address", burner_N.pubkey])
                   │
                   ▼
            Stealth PDA #N
```

## The nonce chain

Burner addresses come from a hash chain, built by `NonceService`:

```
nonce[0] = SHA256(masterSeed)
nonce[N] = SHA256(nonce[N-1])      for N > 0
```

Index `0` is reserved. New users generate the base nonce and immediately increment to index `1`, so the first usable burner is `nonce[1]`.

### Why a chain rather than a counter

You could derive burner `N` as `SHA256(seed ‖ N)`. The chain is chosen instead because it is **forward-only**.

| Attacker learns | Can compute | Cannot compute |
|---|---|---|
| `nonce[5]` | `nonce[6]`, `nonce[7]`, … | `nonce[4]`, `nonce[3]`, … |

Reversing a link would mean inverting SHA-256. So a compromised nonce exposes only *future* receive addresses, never past ones — and past ones are where money has already been.

{% hint style="info" %}
This limits the blast radius but does not eliminate it. If a leaked nonce lets an attacker predict your next receive address, they learn about incoming payments before you rotate past that point. Rotate by shredding, which advances the chain.
{% endhint %}

### Deriving any index directly

`generateNonceAtIndex(index, walletPubkey)` walks the chain from the base nonce to the requested index and returns the result **without touching stored state**. It is purely computational.

This is what makes recovery scanning possible: shredr can regenerate burner #1 through #64 to look for unswept deposits without disturbing the current position.

```typescript
// Side-effect free — does not change the current nonce
const nonce = await nonceService.generateNonceAtIndex(7, walletPubkey);
const burner = await burnerService.deriveBurnerFromNonce(nonce);
```

Compare `generateBaseNonce()`, which computes the same value for index 0 **and** sets it as the current state and persists it.

The maximum index is `2^32 - 1` (`MAX_NONCE_INDEX`).

## From nonce to keypair

`BurnerService` turns a nonce into a real Solana keypair:

```
seed    = SHA256( burnerSeed ‖ nonce )      // 32 bytes
keypair = Keypair.fromSeed(seed)            // ed25519
```

The hash mixes in `burnerSeed`, so knowing a nonce is not enough — an attacker needs the burner master seed too, which requires the original signature.

Intermediate buffers are zeroed immediately (`zeroMemory` overwrites with random bytes, then fills with zeros), and the returned `secretKey` is a **copy**, so the caller owns that memory and can clear it independently with `clearBurner()`.

## The main burner

Your consolidation account's key is derived **directly from the signature**, bypassing the nonce chain entirely:

```
mainBurnerSeed = SHA256( signature ‖ "SHREDR_MAIN_BURNER" )
mainBurner     = Keypair.fromSeed(mainBurnerSeed)
mainPda        = PDA(["shredr_stealth_address", mainBurner.pubkey])
```

This is deliberate. It means:

* the main burner **never rotates** — your consolidation address is stable across every session and device,
* it is **independent of the nonce chain**, so a leaked nonce can never lead to it,
* it is derivable from the signature alone, so recovery needs nothing else.

It is marked with a sentinel `nonceIndex` of `-1` and an empty `nonce` to distinguish it from rotating burners.

## The storage key

```
storageKey = SHA256( signature ‖ "SHREDR_STORAGE_KEY" )
```

Imported as a non-extractable AES-GCM key via `crypto.subtle.importKey`, and used for both:

* IndexedDB records (via `StorageService`),
* the encrypted blobs synced to the backend (via `NonceService.encryptNonce`).

Non-extractable means the browser will not hand the raw key bytes back to JavaScript, even to the code that created it.

Each encryption generates a fresh random 12-byte IV, prepended to the ciphertext:

```
blob = base64( IV(12 bytes) ‖ AES-GCM ciphertext+tag )
```

AES-GCM is authenticated, so a wrong key or tampered bytes fail loudly rather than producing garbage plaintext. `NonceService` distinguishes the cases:

| `DecryptionError.reason` | Meaning |
|---|---|
| `wrong_key` | GCM auth tag mismatch — not your blob, or the wallet changed |
| `corrupted` | Malformed base64, blob shorter than the IV, or invalid JSON after decrypt |
| `unknown` | Anything else |

This is what makes blind blob-scanning recovery work: try every blob, and `wrong_key` simply means "next".

## Why this is safe

<details>
<summary><strong>Determinism does not weaken the keys</strong></summary>

Every derived key traces back to a 64-byte ed25519 signature that only your wallet's private key can produce. An attacker cannot forge it, and SHA-256 gives no path backwards from a derived seed to the signature.

Determinism buys recoverability at no cost to secrecy.
</details>

<details>
<summary><strong>No key is ever transmitted</strong></summary>

The signature, the master seeds, and every derived keypair exist only in browser memory. What goes over the network is an AES-GCM blob and signed transactions — nothing from which a key can be extracted.
</details>

<details>
<summary><strong>Secrets are cleared after use</strong></summary>

`zeroMemory()` overwrites a buffer with random bytes and then zeros it, which is applied to intermediate hash inputs, derived seeds, and burner secret keys once they are no longer needed. `destroy()` on the client clears the whole chain of services.

This reduces the window in which a memory-inspection attack finds anything useful. It is not a defense against an attacker who is live in the page.
</details>

<details>
<summary><strong>The wallet is the backup</strong></summary>

There is no seed phrase to lose, because there is nothing to store. Reproducing the signature reproduces everything. Losing your wallet loses your shredr funds — the same failure mode as losing the wallet itself, no worse.
</details>

## Where to find it in the code

| Derivation | File |
|---|---|
| Message format | `src/lib/constants.ts` (`MASTER_MESSAGE`), used in `GeneratorPage.tsx` / `ClaimPage.tsx` |
| Domain tags | `src/lib/constants.ts` (`DOMAIN_*`) |
| Nonce master seed and storage key | `NonceService.initFromSignature()` |
| Nonce chain | `NonceService.generateBaseNonce()`, `incrementNonce()`, `generateNonceAtIndex()` |
| Burner seed and keypairs | `BurnerService.initFromSignature()`, `deriveBurnerFromNonce()` |
| Main burner | `BurnerService.deriveMainBurner()` |
| Memory zeroing | `src/lib/utils.ts` (`zeroMemory`) |

## Next

* [Burners and stealth PDAs](burners-and-stealth-pdas.md) — what the keys are actually used for
* [State sync and recovery](state-sync-and-recovery.md) — how the derived state persists
