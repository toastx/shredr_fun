---
description: "Encrypted IndexedDB persistence with a per-key mutex."
icon: database
---

# StorageService

`src/lib/StorageService.ts` — wraps IndexedDB with AES-GCM encryption and serializes concurrent access. Used by `NonceService`, which owns a private instance; you rarely touch it directly.

## Setup

```typescript
const storage = new StorageService();
await storage.init(encryptionKey);   // AES-GCM CryptoKey
```

| Setting | Value |
|---|---|
| Database | `shredr_secure_storage` |
| Version | `1` |
| Object store | `nonce_state` |
| Key path | `id` |

The object store is created in `onupgradeneeded` if missing.

## Records

Each record holds one wallet's chain position:

```typescript
interface NonceState {
  currentNonce: string;      // base64, 32 bytes
  currentIndex: number;
  walletPubkeyHash: string;
}
```

Serialized to JSON, encrypted with AES-GCM under a random 12-byte IV, and stored as `base64(IV ‖ ciphertext)`.

The record `id` is the wallet hash — never the wallet address.

## Why the key is a hash

```typescript
export async function deriveWalletHash(walletPublicKey: Uint8Array, length: number) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', getArrayBuffer(walletPublicKey));
    return uint8ArrayToBase58(new Uint8Array(hashBuffer)).slice(0, length);
}
```

The **full pubkey is hashed first**, then the *hash* is truncated to 16 base58 characters (~96 bits, `WALLET_HASH_LENGTH`).

Truncating the pubkey directly would leave a recognizable prefix of your address sitting in browser storage, readable by anything with access to IndexedDB. Truncating the hash identifies the record without revealing which wallet it belongs to.

## Concurrency

Multiple tabs can run shredr at once. Without coordination, two interleaved read-modify-write cycles could corrupt the chain position.

`withLock()` serializes operations per key with a promise chain:

```typescript
private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousLock = this.lockQueue.get(key) ?? Promise.resolve();

    let releaseLock: () => void;
    const currentLock = new Promise<void>(resolve => { releaseLock = resolve; });
    this.lockQueue.set(key, currentLock);

    try {
        await previousLock;
        return await fn();
    } finally {
        releaseLock!();
        if (this.lockQueue.get(key) === currentLock) {
            this.lockQueue.delete(key);
        }
    }
}
```

Each caller waits on the previous lock for that key, then runs. The `finally` releases even on failure, and the map entry is cleaned up only if it is still the current lock — so a later waiter is not clobbered.

{% hint style="warning" %}
This is a **within-tab** mutex. Each browser tab has its own `StorageService` instance and its own `lockQueue`, so it does not coordinate across tabs. Cross-tab races on the blob sync are handled instead by recovery's highest-index rule.
{% endhint %}

## Reading and writing

```typescript
await storage.saveCurrentNonce(walletHash, nonce, index);
const stored = await storage.getCurrentNonce(walletHash);  // { nonce, index } | null
storage.getEncryptionKey();  // CryptoKey | null
storage.close();
```

Reads throw a `DecryptionError` when the record cannot be decrypted — usually because a different wallet is connected. `NonceService.loadCurrentNonce()` catches this, warns, and returns `null` so the caller treats it as a new user rather than crashing.

## What this protects against

| Threat | Protected? |
|---|---|
| Casual inspection of IndexedDB via devtools | **Yes** — everything is ciphertext |
| Another site reading your storage | Yes — same-origin policy, plus encryption |
| A different wallet on the same browser | Yes — different key, decryption fails cleanly |
| Malware with live page access | **No** — the key is in memory |
| XSS in the app itself | **No** — attacker code runs with the key available |

{% hint style="info" %}
The encryption key is imported as **non-extractable**, so the browser refuses to hand its raw bytes back to JavaScript — even to the code that created it. That limits what an XSS payload can exfiltrate: it can *use* the key while the page is open, but cannot steal it for offline use.
{% endhint %}

## Testing

Tests polyfill IndexedDB with `fake-indexeddb` (installed in `tests/setup.ts`), so the storage layer runs unmodified under Node.

Each integration test uses a distinct mock wallet pubkey, which means a distinct wallet hash and a distinct record — no collisions across runs even though `fake-indexeddb` state can persist within a process.

## Next

* [NonceService](nonce-service.md) — the consumer
* [State sync and recovery](../concepts/state-sync-and-recovery.md) — where this fits in the three storage layers
