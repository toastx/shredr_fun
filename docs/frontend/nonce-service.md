---
description: "The nonce hash chain, AES-GCM encryption, and backend blob sync."
icon: link
---

# NonceService

`src/lib/NonceService.ts` — owns the nonce chain that produces burner addresses, the encryption used for local and synced state, and the blob logic that makes cross-device recovery work.

```typescript
import { nonceService } from './lib';
```

## Initialization

```typescript
await nonceService.initFromSignature(signature);
```

Derives two things from the signature, with domain separation:

```
masterSeed = SHA256( signature ‖ "SHREDR_NONCE_MASTER" )
storageKey = SHA256( signature ‖ "SHREDR_STORAGE_KEY"  )
```

The storage key is imported as a **non-extractable** AES-GCM `CryptoKey` and handed to `StorageService`. Intermediate buffers are zeroed immediately.

```typescript
nonceService.getEncryptionKey();  // CryptoKey | null
```

## The chain

```
nonce[0] = SHA256(masterSeed)
nonce[N] = SHA256(nonce[N-1])      for N > 0
```

Forward-only: a later nonce never reveals an earlier one. Maximum index is `2^32 - 1` (`MAX_NONCE_INDEX`).

### Stateful methods

```typescript
await nonceService.generateBaseNonce(walletPubkey);  // index 0, sets + persists
await nonceService.incrementNonce();                 // advance one, persists
nonceService.getCurrentNonce();                      // read, no change
await nonceService.setCurrentState(nonce);           // adopt external state
```

`generateBaseNonce()` computes `SHA256(masterSeed)`, sets it as current, and writes to IndexedDB. `incrementNonce()` hashes the current nonce, bumps the index, and persists. It throws on overflow past `MAX_NONCE_INDEX`.

### Side-effect-free derivation

```typescript
const nonce = await nonceService.generateNonceAtIndex(7, walletPubkey);
```

Walks the chain from the base to the requested index and returns it **without touching stored state**. Purely computational.

This is what makes UTXO scanning and recovery possible — shredr can regenerate any historical burner without disturbing the current position.

{% hint style="info" %}
`generateNonceAtIndex(0)` and `generateBaseNonce()` produce the **same value**. The difference is entirely in the side effects: the first touches nothing, the second sets state and persists it.
{% endhint %}

Invalid indices (`< 0` or `> MAX_NONCE_INDEX`) throw.

## Loading persisted state

```typescript
const nonce = await nonceService.loadCurrentNonce(walletPubkey);  // null if none
```

Derives the wallet hash (`SHA256(pubkey)` → base58 → first 16 chars) and looks up the IndexedDB record.

If the record exists but cannot be decrypted — typically after switching wallets — it catches the `DecryptionError`, warns, and returns `null` so the caller treats it as a new user. Other errors re-throw.

## Encryption

```typescript
const payload = await nonceService.encryptNonce(nonce, key);
const nonce   = await nonceService.decryptNonce(payload, key);
```

Format:

```
plaintext  = JSON { nonce: base64, index: number, walletPubkeyHash: string }
iv         = 12 random bytes
blob       = base64( iv ‖ AES-GCM(plaintext) )
```

A fresh random IV per encryption; `IV_LENGTH = 12` as NIST recommends for GCM.

### Error classification

`decryptNonce` maps failures to a typed `DecryptionError`:

| `reason` | Cause |
|---|---|
| `wrong_key` | GCM auth tag mismatch — not your blob, or the wallet changed |
| `corrupted` | Bad base64, blob shorter than the IV, invalid JSON, or wrong payload shape |
| `unknown` | Anything else |

This distinction is what makes blind blob-scanning work: `wrong_key` simply means "next blob", while `corrupted` signals genuine data damage.

## Blob sync

### Creating

```typescript
const blobData = await nonceService.createBlobData(nonce);
// { encryptedBlob: "base64..." }
```

Ready to `POST` to the backend.

### Finding yours

```typescript
const { found, blobId, nonce } = await nonceService.tryDecryptBlobs(blobs);
```

Tries to decrypt every blob and returns the one with the **highest nonce index**:

```typescript
if (!bestMatch || decrypted.index > bestMatch.nonce.index) {
  bestMatch = { blobId: blob.id, nonce: decrypted };
}
```

{% hint style="warning" %}
**Highest index, not first match.** Old blobs can survive if a delete failed during a previous rotation. Taking the first successful decryption could rewind you to an already-used burner.
{% endhint %}

### Consuming

```typescript
const { consumedNonce, newNonce, newBlobData } = await nonceService.consumeNonce();
```

Increments (persisting locally) and prepares the new blob. It does **not** touch the network — the caller (`ShredrClient.consumeAndGenerateNew()`) uploads the new blob and deletes the old one.

## Cleanup

```typescript
nonceService.clearMasterSeed();  // zero the master seed only
nonceService.destroy();          // full teardown
```

`destroy()` zeroes the master seed and current nonce, closes the IndexedDB connection, and resets all state.

## API summary

| Method | Side effects | Purpose |
|---|---|---|
| `initFromSignature(sig)` | Sets seeds, opens storage | Bootstrap |
| `getEncryptionKey()` | None | Access the AES key |
| `loadCurrentNonce(pubkey)` | Sets state on success | Load from IndexedDB |
| `generateBaseNonce(pubkey)` | Sets + persists | Start a new chain |
| `incrementNonce()` | Sets + persists | Advance one |
| `getCurrentNonce()` | None | Read current |
| `generateNonceAtIndex(i, pubkey)` | **None** | Derive any index |
| `setCurrentState(nonce)` | Sets + persists | Adopt remote state |
| `encryptNonce` / `decryptNonce` | None | AES-GCM round-trip |
| `tryDecryptBlobs(blobs)` | None | Find your blob |
| `createBlobData(nonce)` | None | Prepare an upload |
| `consumeNonce()` | Increments + persists | Rotate |
| `clearMasterSeed()` | Zeroes seed | Partial cleanup |
| `destroy()` | Full teardown | Cleanup |

## Types

```typescript
interface GeneratedNonce {
  nonce: Uint8Array;
  index: number;
  walletPubkeyHash: string;
}

interface EncryptedNoncePayload {
  encryptedBlob: string;   // base64(IV ‖ ciphertext)
  version: number;
}

interface NonceBlob {
  id: string;
  encryptedBlob: string;
  createdAt: number;
}
```

## Next

* [BurnerService](burner-service.md) — turning nonces into keypairs
* [StorageService](storage-service.md) — the IndexedDB layer
* [State sync and recovery](../concepts/state-sync-and-recovery.md) — the wider picture
