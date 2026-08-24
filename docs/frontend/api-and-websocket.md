---
description: "Backend blob sync and real-time deposit notifications."
icon: satellite-dish
---

# ApiClient and WebSocketClient

Two small networking modules: one for syncing encrypted state with the backend, one for knowing the instant a deposit lands.

## ApiClient

`src/lib/ApiClient.ts` — blob CRUD against the backend. Implements the `NonceBlobAPI` interface.

```typescript
import { apiClient } from './lib';
```

### Methods

```typescript
await apiClient.fetchAllBlobs();          // NonceBlob[]
await apiClient.createBlob({ encryptedBlob });  // NonceBlob
await apiClient.deleteBlob(id);           // boolean
```

| Method | Request | Notes |
|---|---|---|
| `fetchAllBlobs` | `GET /api/blobs?limit=100&cursor=…`, paged | **Never throws** — returns whatever pages it collected |
| `fetchBlobPages` | same, as an async generator | Lets callers stop early instead of walking every page |
| `createBlob` | `POST /api/blobs` with JSON `{ encryptedBlob }` | Throws on failure |
| `deleteBlob` | `DELETE /api/blobs/{id}` | Returns `false` on error; the backend soft-deletes |

### Failure behaviour

`fetchAllBlobs` swallowing errors is deliberate — a down backend should not block a user whose state is already in IndexedDB:

```typescript
catch (error) {
  console.error("APIClient: fetchAllBlobs failed", error);
  return [];   // app continues offline/fresh
}
```

{% hint style="warning" %}
The trade-off: if IndexedDB is *also* empty and the backend is down, you are silently treated as a new user and advanced to a fresh chain position. Funds on earlier burners are not lost — `scanPendingUtxos()` scans from index 1 regardless — but the app gives no indication that sync failed.
{% endhint %}

### Pagination

Blobs carry no user identifier, so recovery means downloading blobs and trying to decrypt each one. `limit` therefore caps the *global* set, not a per-user one — a flat single-page request meant that past ~100 total blobs a returning user's blob was simply absent from the response and they were treated as new.

`fetchAllBlobs` now walks the keyset pages: each page's oldest `createdAt` becomes the next `cursor`, and the walk ends on a short page. Three guards keep it bounded — ids are deduped across pages, the cursor must strictly decrease (a server ignoring `cursor` would otherwise return the newest page forever), and `BLOB_MAX_PAGES` caps the walk regardless.

`fetchBlobPages` exposes the same walk as an async generator. `UtxoService.loadRemote` uses it to stop at the first tree blob it can decrypt: pages are newest-first and the service always writes a new blob before deleting the old one, so the first readable tree is the current one. `NonceService.tryDecryptBlobs` must still see everything — it selects the highest nonce index, which is not guaranteed to track `createdAt` order.

{% hint style="warning" %}
Pagination fixes correctness, not scale. Trial decryption is still O(total blobs across all users), so login cost grows with adoption instead of being silently truncated. Bucketing by an opaque, wallet-unlinkable tag is the real fix.
{% endhint %}

### Configuration

```typescript
const client = new ApiClient("https://api.example.com");
```

Defaults to `API_BASE_URL`, which `constants.ts` reads from `VITE_API_BASE_URL`. There is no hardcoded fallback — if the variable is unset at build time the client is constructed with an empty base URL and every request fails.

→ [Backend API reference](../backend/api-reference.md)

## WebSocketClient

`src/lib/WebSocketClient.ts` — real-time balance notifications for your current burner.

```typescript
import { webSocketClient } from './lib';
```

{% hint style="info" %}
**It connects directly to Helius, not to the shredr backend.** It opens `HELIUS_WSS_URL` and uses Solana's standard `accountSubscribe` RPC. The backend's own WebSocket module exists in the source but is commented out in `main.rs`.

→ [Backend overview](../backend/README.md)
{% endhint %}

### Usage

```typescript
webSocketClient.subscribeToAccount(burnerAddress);  // auto-connects

webSocketClient.onMessage((msg) => {
  if (msg.type === 'accountUpdate') {
    console.log('New balance:', msg.lamports);
  }
});

webSocketClient.onConnectionChange((connected) => { /* ... */ });
webSocketClient.disconnect();
```

`subscribeToAccount` connects first if needed and queues the subscription until the socket opens, so callers do not have to sequence it themselves.

### The subscription

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "accountSubscribe",
  "params": ["<address>", { "encoding": "jsonParsed", "commitment": "confirmed" }]
}
```

Incoming `accountNotification` messages are translated into a simplified shape before reaching handlers:

```typescript
{ type: 'accountUpdate', lamports: number, account: number /* slot */ }
```

Raw Solana notifications are **not** forwarded — only the normalized form.

### Reconnection

Exponential backoff on close: `1s, 2s, 4s, 8s, 16s`, up to 5 attempts. The counter resets on a successful open. A deliberate `disconnect()` uses close code 1000 and resets the counter, so it does not trigger a reconnect.

### Log sanitization

```typescript
private sanitizeForLog(input: unknown): string {
    let str = typeof input === 'object' && input !== null ? JSON.stringify(input) : `${input}`;
    return str.replace(/[\r\n]/g, '');
}
```

Strips CR/LF from anything logged, preventing log-injection via crafted RPC responses.

### Known gaps

{% hint style="warning" %}
**Subscriptions are never torn down.** `subscribeToAccount` is called on every burner rotation, but there is no `accountUnsubscribe`. Over a long session the socket accumulates subscriptions to retired burners.

`GeneratorPage` compensates by re-checking the balance on-chain before acting on any notification, rather than trusting it:

```typescript
const lamports = await refreshBalance(address);
if (lamports <= 0) return;
```
{% endhint %}

There is also no ping/keepalive, so an idle connection dropped by an intermediary is only noticed via the `onclose` handler.

## How the pages use them

`GeneratorPage`:

1. Subscribes to the burner after initialization
2. Registers one message handler for the session, reading the current address from a ref (the handler outlives any single address)
3. On `accountUpdate`: confirm the balance, shred, rotate, subscribe to the new burner
4. On unmount or disconnect: remove the handler and disconnect **before** `shredrClient.destroy()`

Ordering matters in step 4 — tearing down the client first would let a late callback run against a half-destroyed client.

## Next

* [Backend API reference](../backend/api-reference.md) — the endpoints being called
* [UI components and pages](ui.md) — where these are wired up
