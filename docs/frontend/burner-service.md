---
description: "Deriving ed25519 keypairs from nonces, and handling secrets safely."
icon: fingerprint
---

# BurnerService

`src/lib/BurnerService.ts` — turns nonces into real Solana keypairs, derives the permanent main burner, and takes memory hygiene seriously.

```typescript
import { burnerService } from './lib';
```

## Initialization

```typescript
await burnerService.initFromSignature(signature);
burnerService.isInitialized;  // boolean
```

Derives the burner master seed with its own domain tag:

```
burnerSeed = SHA256( signature ‖ "SHREDR_BURNER_MASTER" )
```

Separate from the nonce master seed, so a compromise of one does not imply the other.

## Deriving a burner

```typescript
const burner = await burnerService.deriveBurnerFromNonce(nonce);
```

```
seed    = SHA256( burnerSeed ‖ nonce )     // 32 bytes
keypair = Keypair.fromSeed(seed)           // ed25519
```

Returns:

```typescript
interface BurnerKeyPair {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 64 bytes — a COPY the caller owns
  address: string;         // base58 pubkey
  nonce: Uint8Array;
  nonceIndex: number;
}
```

Two things happen for safety:

* The `combined` buffer and the derived `seed` are zeroed immediately after use.
* `secretKey` is a **copy** of the keypair's bytes, so the caller can zero it independently without affecting the underlying object.

{% hint style="warning" %}
**Always call `clearBurner()` when you are done.** Every code path in `ShredrClient` does — including `scanPendingUtxos()`, which clears even the burners that turned out to be empty, and `shredPendingDeposits()`, which clears in a `finally` block so a failed shred still wipes the key.
{% endhint %}

## The main burner

```typescript
const mainBurner = await burnerService.deriveMainBurner(signature);
```

```
seed = SHA256( signature ‖ "SHREDR_MAIN_BURNER" )
```

Derived **directly from the signature**, bypassing the nonce chain. That gives it three properties the rotating burners do not have:

* it never changes across sessions or devices,
* a leaked nonce can never lead to it,
* it is recoverable from the signature alone, with no state needed.

It is marked with `nonceIndex: -1` and an empty `nonce` as a sentinel.

This keypair signs `Withdraw`, and its pubkey is what the program verifies as the owner of your main PDA.

{% hint style="info" %}
Your connected wallet **never appears on-chain**. The main burner stands in for it, sharing only the signature — a secret that exists solely in your browser's memory.
{% endhint %}

## Memory hygiene

```typescript
burnerService.clearBurner(burner);   // zero one burner's secretKey
burnerService.clearBurnerSeed();     // zero the master seed
burnerService.destroy();             // full cleanup
```

`zeroMemory()` from `src/lib/utils.ts`:

```typescript
export function zeroMemory(arr: Uint8Array): void {
    crypto.getRandomValues(arr);   // overwrite with random
    arr.fill(0);                   // then zero
}
```

The random pass first makes the original bytes harder to recover from residual memory effects than a plain zero-fill would.

{% hint style="danger" %}
This limits the *window* of exposure, not the exposure itself. An attacker with live access to the page can read secrets before they are cleared. JavaScript also gives no guarantee that the runtime has not copied a buffer elsewhere — garbage collection and JIT optimizations are outside your control.
{% endhint %}

## Recovery scanning

```typescript
const { burners, recoveredIndices } = await burnerService.recoverBurners(
  (i) => nonceService.generateNonceAtIndex(i, walletPubkey),
  async (address) => (await connection.getBalance(new PublicKey(address))) > 0,
  1000,   // maxIndex
);
```

Walks indices from 0, deriving each burner and testing it with the supplied activity check. Stops after `CONSECUTIVE_EMPTY_THRESHOLD` (10) consecutive misses. Burners that fail the check are cleared immediately; the ones returned are the caller's to clear.

Both callbacks are injected, which makes the method trivially testable without a chain.

{% hint style="info" %}
Covered by tests but **not currently used by the app** — `ShredrClient.scanPendingUtxos()` implements its own scan with different parameters (max 64, threshold 5) because it needs to inspect stealth PDA state, not just balances.
{% endhint %}

## Deprecated

```typescript
await burnerService.deriveShadowireAddress(baseNonce);
```

An older concept where burner index 0 was a stable receive address. It just calls `deriveBurnerFromNonce()` and warns if the index is not 0. Nothing uses it. Use `deriveMainBurner()` instead.

## API summary

| Method | Purpose |
|---|---|
| `initFromSignature(sig)` | Derive the burner master seed |
| `isInitialized` | Getter |
| `deriveBurnerFromNonce(nonce)` | Nonce → keypair |
| `deriveMainBurner(sig)` | Signature → permanent keypair |
| `clearBurner(burner)` | Zero one secret key |
| `recoverBurners(...)` | Scan for active burners |
| `clearBurnerSeed()` | Zero the master seed |
| `destroy()` | Full cleanup |
| `deriveShadowireAddress(n)` | **Deprecated** |

## Next

* [Key derivation](../concepts/key-derivation.md) — the full derivation tree
* [ShredrProgram](shredr-program.md) — turning burners into instructions
