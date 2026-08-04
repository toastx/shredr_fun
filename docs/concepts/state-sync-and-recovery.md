---
description: "How your position in the nonce chain survives a cleared browser, a new device, or a lost server."
icon: rotate
---

# State sync and recovery

shredr has almost no state to lose. Everything is derived from your wallet signature — the only thing worth remembering is **which burner you are currently on**.

This page covers how that one number is stored, synced, and recovered.

## What actually needs saving

| Derived on demand | Needs persisting |
|---|---|
| Master seeds | Current nonce value |
| Every burner keypair | Current nonce index |
| Main burner and main PDA | |
| Every stealth PDA address | |
| Storage encryption key | |

That is it. Everything else falls out of the signature.

And even the nonce is not strictly required — it can be recovered by scanning the chain on-chain. Persisting it just makes startup fast.

## Three layers

```
┌─────────────────────────────────────────────────────────┐
│  1. IndexedDB (encrypted)     — this browser, instant   │
├─────────────────────────────────────────────────────────┤
│  2. Backend blob (encrypted)  — any device, network     │
├─────────────────────────────────────────────────────────┤
│  3. On-chain scan             — always works, slowest   │
└─────────────────────────────────────────────────────────┘
```

Each is a fallback for the one above.

## Layer 1 — IndexedDB

`StorageService` wraps IndexedDB with AES-GCM encryption.

| Setting | Value |
|---|---|
| Database | `shredr_secure_storage` |
| Version | `1` |
| Object store | `nonce_state` |
| Key | `SHA256(walletPubkey)` → base58 → first 16 chars |

Records are `{ currentNonce (base64), currentIndex, walletPubkeyHash }`, encrypted with the storage key before being written.

### Why the wallet hash is hashed

The record key is not your wallet address. `deriveWalletHash()` hashes the **full** pubkey first, then truncates the *hash*:

```typescript
const hashBuffer = await crypto.subtle.digest('SHA-256', walletPublicKey);
return uint8ArrayToBase58(new Uint8Array(hashBuffer)).slice(0, length);
```

Truncating the pubkey directly would leave a recognizable prefix of your address sitting in browser storage. Truncating the hash leaves 16 base58 characters (~96 bits) that identify the record without revealing the wallet.

### Concurrency

`StorageService` serializes operations per key with a promise-chain mutex (`withLock`), so two browser tabs writing at once cannot interleave a read-modify-write and corrupt the chain position.

### When decryption fails

If stored data cannot be decrypted — usually because you switched wallets — `loadCurrentNonce()` catches the `DecryptionError`, logs a warning, and returns `null`. shredr then treats you as a new user rather than crashing.

→ [StorageService reference](../frontend/storage-service.md)

## Layer 2 — Backend blobs

IndexedDB is per-browser. Clear your site data or open the app on your phone and it is gone. That is what the blob is for.

### What a blob is

```json
{
  "nonce": "<base64, 32 bytes>",
  "index": 7,
  "walletPubkeyHash": "3Kf9..."
}
```

JSON-encoded, encrypted with AES-GCM under the storage key, prefixed with a random 12-byte IV, base64-encoded:

```
encryptedBlob = base64( IV(12) ‖ ciphertext ‖ GCM tag )
```

About 200 bytes. The backend caps blobs at 2048 bytes.

### What the backend stores

```sql
CREATE TABLE nonce_blobs (
    id            UUID PRIMARY KEY,
    encrypted_blob TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    is_consumed   BOOLEAN NOT NULL DEFAULT FALSE
);
```

Note what is **absent**: no wallet address, no user ID, no session, no auth. The server has no idea whose blob is whose.

This is deliberate. There is no account system to leak, and no way for the operator to group blobs by user.

### Recovery by blind decryption

Because blobs are unlabelled, finding yours means trying them all:

{% stepper %}
{% step %}
### Download every blob

`GET /api/blobs?limit=100` returns unconsumed blobs, newest first.
{% endstep %}

{% step %}
### Try to decrypt each one

Your storage key succeeds only on yours. AES-GCM's authentication tag makes a wrong key fail cleanly, surfaced as `DecryptionError('wrong_key')` — which the loop treats as "not mine, next".
{% endstep %}

{% step %}
### Take the highest index

**Not the first match.** Old blobs can linger if a delete failed during a previous rotation, so `tryDecryptBlobs()` checks all of them and keeps the one with the largest nonce index — your true latest position.
{% endstep %}

{% step %}
### Restore locally

`setCurrentState()` writes it into IndexedDB, and shredr carries on from there.
{% endstep %}
{% endstepper %}

{% hint style="warning" %}
This scales linearly with total blobs across all users. With `limit=100` and a busy server, your blob could fall outside the first page and recovery would silently fail — falling through to new-user state. The backend supports keyset pagination via a `cursor` parameter, but the client does not currently use it.

→ [Limitations](../reference/limitations.md)
{% endhint %}

### Rotation

When a burner is consumed, `consumeAndGenerateNew()`:

1. Increments the nonce locally and saves to IndexedDB,
2. Encrypts the new state and `POST`s it as a new blob,
3. Records the new blob ID,
4. `DELETE`s the old blob.

Both network calls are wrapped in try/catch and only warn on failure. Local state is already correct, so a failed sync degrades recovery convenience rather than breaking the app.

### Deletes are soft

`DELETE /api/blobs/{id}` does not delete:

```sql
UPDATE nonce_blobs SET is_consumed = TRUE WHERE id = $1
```

Consumed blobs are excluded from list results, so recovery ignores them, but the row remains. Worth knowing if you are reasoning about data retention — an operator retains every historical encrypted blob indefinitely.

→ [Database](../backend/database.md)

## Layer 3 — On-chain scanning

If both IndexedDB and the backend are unavailable, everything is still recoverable from the chain, because the burner sequence is deterministic.

`scanPendingUtxos()` walks indices 1 upward, re-deriving each burner and its PDA:

```typescript
for (let i = 1; i < MAX_UTXO_SCAN_INDEX; i++) {
  const nonce  = await nonceService.generateNonceAtIndex(i, walletPubkey);
  const burner = await burnerService.deriveBurnerFromNonce(nonce);
  const [pda]  = deriveStealthPDA(new PublicKey(burner.publicKey));

  const [burnerLamports, pdaInfo] = await Promise.all([
    connection.getBalance(burnerPub),
    connection.getAccountInfo(pda),
  ]);
  // ... classify, then zero the burner key
}
```

| Parameter | Value | Meaning |
|---|---|---|
| `MAX_UTXO_SCAN_INDEX` | 64 | Highest index checked |
| `UTXO_SCAN_EMPTY_THRESHOLD` | 5 | Stop after this many consecutive empty indices |

Each index is classified `empty` / `received` / `delegated` / `ready`, and every derived burner's secret key is zeroed before moving on — including the ones that turned out to be empty.

{% hint style="info" %}
Your **main PDA is not part of this scan**. It is derived directly from the signature, so it is always found immediately regardless of nonce state. Money that has already been shredded is safe even if the nonce chain position is completely lost.
{% endhint %}

`BurnerService.recoverBurners()` offers a more general version with a configurable `maxIndex` (default 1000), an injectable activity check, and a threshold of `CONSECUTIVE_EMPTY_THRESHOLD` (10). It is covered by tests but not currently wired into the app.

## The new-user path

`initFromSignature()` resolves state in a fixed order:

```
1. IndexedDB          →  found? use it
2. Backend blobs      →  decrypts? use highest index
3. Neither            →  new user
```

For a new user:

```typescript
await nonceService.generateBaseNonce(walletPubkey);   // index 0
nonce = await nonceService.incrementNonce();          // index 1
this._isNewUser = true;
// upload the first blob
```

Index 0 is reserved, so the first usable burner is index 1.

`checkIfNewUser()` runs the same check without any side effects, so the UI can branch before committing to anything.

## Failure scenarios

<details>
<summary><strong>Cleared browser data</strong></summary>

IndexedDB is gone. Sign in, blob downloads, decrypts, state restored. No user-visible impact.
</details>

<details>
<summary><strong>New device</strong></summary>

Same as above. Sign the same message, the blob is found and decrypted.
</details>

<details>
<summary><strong>Backend offline</strong></summary>

`fetchAllBlobs()` catches the error and returns `[]`. If IndexedDB has your state, everything works normally. If not, you are treated as a new user — **which advances you to a fresh chain position, potentially skipping past burners holding funds**.

Those funds are not lost: `scanPendingUtxos()` finds them, since it scans from index 1 regardless of current position.
</details>

<details>
<summary><strong>Backend loses its database</strong></summary>

Everyone falls back to IndexedDB, and to on-chain scanning where that is missing too. No funds are at risk — the backend never held anything that controls money.
</details>

<details>
<summary><strong>Wrong wallet connected</strong></summary>

A different signature means different seeds. IndexedDB decryption fails (`wrong_key`), no blob decrypts, and shredr treats you as a new user under the new wallet. The original wallet's state is untouched and returns when you reconnect it.
</details>

<details>
<summary><strong>Two tabs open</strong></summary>

`StorageService`'s per-key mutex keeps IndexedDB writes serialized within a tab. Across tabs the blob sync can race — two rotations could both upload, leaving an extra blob. Recovery's highest-index rule handles this correctly.
</details>

## Design summary

| Property | How |
|---|---|
| Server cannot read your state | AES-GCM under a key derived from a signature it never sees |
| Server cannot identify you | Blobs carry no user identifier; no auth, no accounts |
| Works on any device | Blob download + blind decryption |
| Survives total server loss | On-chain scanning from a deterministic chain |
| Survives cleared browser | Backend blob |
| No seed phrase | Wallet signature is the root secret |

## Next

* [NonceService](../frontend/nonce-service.md) — the encryption and chain implementation
* [Backend API reference](../backend/api-reference.md) — the blob endpoints
