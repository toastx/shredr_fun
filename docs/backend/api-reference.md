---
description: "Every endpoint the backend actually exposes, with request and response shapes."
icon: plug
---

# API reference

Base URL in development: `http://localhost:8000`

{% hint style="danger" %}
`shredr-backend/README.md` documents a **different, older API** — multipart uploads at `/api/blob/upload`, a `/ws` WebSocket, a `/webhook/helius` receiver. None of those exist in the current `main.rs`. This page reflects the code.
{% endhint %}

No authentication on any endpoint.

## Blobs

### Create a blob

```
POST /api/blobs
Content-Type: application/json
```

```json
{ "encryptedBlob": "base64-encoded-IV-plus-ciphertext" }
```

**`201 Created`**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "encryptedBlob": "base64...",
  "createdAt": 1735689600000,
  "isConsumed": false
}
```

`createdAt` is Unix **milliseconds**. Field names are camelCase (`#[serde(rename_all = "camelCase")]`).

**Errors**

| Status | Cause |
|---|---|
| `400` | Blob larger than `MAX_BLOB_SIZE` (2048 bytes) — `Blob too large: N bytes (max 2048 bytes)` |
| `500` | Database error |

```bash
curl -X POST http://localhost:8000/api/blobs \
  -H "Content-Type: application/json" \
  -d '{"encryptedBlob":"eyJub25jZSI6..."}'
```

{% hint style="info" %}
The 2048-byte cap is anti-spam. Real blobs are around 200 bytes — a nonce, an index, and a wallet hash, encrypted.
{% endhint %}

### List blobs

```
GET /api/blobs?limit=100&cursor=1735689600000
```

| Parameter | Default | Notes |
|---|---|---|
| `limit` | 100 | Clamped to 1–100 |
| `cursor` | none | Keyset pagination on `created_at` |

**`200 OK`** — an array, newest first:

```json
[
  { "id": "...", "encryptedBlob": "...", "createdAt": 1735689600000, "isConsumed": false }
]
```

Only **unconsumed** blobs are returned (`WHERE is_consumed = FALSE`).

Pagination is keyset-based, not offset-based:

```sql
WHERE is_consumed = FALSE AND created_at < $1
ORDER BY created_at DESC
LIMIT $2
```

Pass the `createdAt` of the last item you received as the next `cursor`.

```bash
curl "http://localhost:8000/api/blobs?limit=50"
```

{% hint style="info" %}
`ApiClient.fetchAllBlobs()` walks every page, passing the oldest `createdAt` of each page as the next `cursor` and stopping on a short page.

{% endhint %}

{% hint style="warning" %}
**Timestamp ties can skip blobs.** The keyset predicate is a strict `created_at < cursor` on milliseconds alone. If a page boundary falls inside a group of blobs sharing one millisecond, the rest of that group is never returned by any later page. A composite key — `(created_at, id) < (cursor_ts, cursor_id)` — would close this; clients cannot work around a row the server never sends.
{% endhint %}

### Get one blob

```
GET /api/blobs/{id}
```

**`200 OK`** — the same object shape. Returns consumed blobs too.

| Status | Cause |
|---|---|
| `400` | `id` is not a valid UUID |
| `404` | Not found |

Not used by the frontend; recovery goes through the list endpoint.

### Delete a blob

```
DELETE /api/blobs/{id}
```

**`200 OK`**

```json
{ "success": true }
```

| Status | Cause |
|---|---|
| `400` | Invalid UUID |
| `404` | Not found |

{% hint style="warning" %}
**This is a soft delete.** The row is not removed:

```sql
UPDATE nonce_blobs SET is_consumed = TRUE WHERE id = $1
```

Consumed blobs are excluded from list results, so recovery ignores them — but the operator retains every historical encrypted blob indefinitely. Worth knowing if you are reasoning about data retention.
{% endhint %}

## Webhooks

Thin proxies over the `helius` crate, used to manage address monitoring. Not called by the frontend today.

→ [Helius webhooks](webhooks.md)

### Create a webhook

```
POST /webhook/create
Content-Type: application/json
```

```json
{
  "webhook_url": "https://your-domain.com/webhook/helius",
  "transaction_types": ["TRANSFER"],
  "account_addresses": ["BurnerAddress1..."],
  "webhook_type": "enhanced",
  "encoding": "jsonParsed",
  "txn_status": "all"
}
```

Note these fields are **snake_case**, unlike the blob endpoints.

**`200 OK`**

```json
{ "message": "Webhook created: Some(\"webhook-id-here\")" }
```

On failure it returns **`500`** with the error in the same `message` field — the webhook endpoints do not use the structured `AppError` shape.

### Add addresses

```
POST /webhook/address
```

```json
{ "webhook_id": "...", "addresses": ["Address1...", "Address2..."] }
```

**`200 OK`** — `{ "message": "Addresses added successfully" }`

### Remove addresses

```
DELETE /webhook/address
```

Same body shape.

**`200 OK`** — `{ "message": "Addresses removed successfully" }`

## KYT screening

Screens a depositing wallet and returns a signed attestation the client turns
into an `Ed25519SigVerify` instruction. Without one, the program refuses the
deposit — see [KYT gating](../concepts/kyt-gating.md).

{% hint style="warning" %}
The compliance provider call is a **stub**. It clears everything except
`KYT_DENYLIST`. Everything around it — the message layout, the binding, the
signing, the expiry — is the production path, because that is what the on-chain
program parses byte by byte.
{% endhint %}

### Screen a depositor

```
POST /api/kyt/screen
Content-Type: application/json
```

```json
{
  "depositor": "base58 wallet being screened",
  "burner": "base58 one-time burner the deposit lands on",
  "maxAmount": "5000000000"
}
```

`maxAmount` is a **string** — JSON numbers cannot carry a `u64` without loss.

**`200 OK`**

```json
{
  "verdict": 1,
  "authority": "base58 pubkey that signed the message",
  "message": "base64, exactly 90 bytes",
  "signature": "base64, exactly 64 bytes",
  "expiresAt": 1735689900
}
```

A **refusal is also `200`**, with `"verdict": 0` and a `reason`. That is not an
oversight: "we screened you and said no" is final, "the relayer is unreachable"
is worth retrying, and a client that could not tell them apart would either
retry into a wall or give up on a transient outage. Only the second is an error
status.

`burner` and `maxAmount` are inside the signed message, not just the request. An
attestation that said only "this wallet is clean" would be a bearer token good
for every deposit that wallet ever makes.

**`503 Service Unavailable`** when `KYT_AUTHORITY_KEY` is unset.

```bash
curl -X POST http://localhost:8000/api/kyt/screen   -H 'Content-Type: application/json'   -d '{"depositor":"<wallet>","burner":"<burner>","maxAmount":"1000000000"}'
```

### What is deliberately not logged

Nothing about a screening request reaches the application log. A line pairing a
depositor with a burner is exactly the correlation the privacy design exists to
prevent, and an access log with a source IP beside it is worse.

The audit trail this service is meant to produce — `(depositor, burner, verdict,
provider response, signature)` — is a compliance requirement and a
deanonymisation set at the same time. It belongs in its own store, with its own
access control, on a host that never sees an IP address. See
[RPC operational security](../concepts/rpc-opsec.md).

## Health

```
GET /health
```

**`200 OK`** with the plain-text body `OK`.

```bash
curl http://localhost:8000/health
```

## Error format

Blob endpoints return a structured error via `AppError`:

```json
{ "error": "Blob not found" }
```

| `AppError` | Status | Message |
|---|---|---|
| `Database` | 500 | `Internal database error` (details logged, not exposed) |
| `InvalidUuid` | 400 | `Invalid UUID: <detail>` |
| `NotFound` | 404 | `Blob not found` |
| `BlobTooLarge` | 400 | `Blob too large: N bytes (max M bytes)` |
| `Internal` | 500 | The supplied message |
| `KytUnavailable` | 503 | `KYT screening unavailable: <detail>` |

Database errors are deliberately opaque to the client — the real error goes to the logs, not the response.

Webhook endpoints return `{ "message": "..." }` instead.

## Rate limits

Keyed by client IP (`X-Forwarded-For` last entry → `X-Real-IP` → socket peer):

| Endpoints | Limit |
|---|---|
| `POST /api/blobs`, `DELETE /api/blobs/{id}` | Burst 5, refill every 10s |
| `GET /api/blobs`, `GET /api/blobs/{id}` | 30/sec, burst 60 |
| `POST /api/kyt/screen` | Burst 5, refill every 10s |
| `/webhook/*` | Burst 5, refill every 12s |

Exceeding a limit returns `429 Too Many Requests`.

## Frontend usage

`ApiClient` uses three of these:

| Method | Call | Failure behaviour |
|---|---|---|
| `fetchAllBlobs()` | `GET /api/blobs?limit=100&cursor=…`, paged | Returns whatever pages it collected — app continues offline |
| `createBlob(data)` | `POST /api/blobs` | Throws |
| `deleteBlob(id)` | `DELETE /api/blobs/{id}` | Returns `false` |

→ [ApiClient and WebSocketClient](../frontend/api-and-websocket.md)

`KytService` uses the screening endpoint:

| Method | Call | Failure behaviour |
|---|---|---|
| `screen(...)` | `POST /api/kyt/screen` | Throws `KytUnavailableError` |
| `attest(...)` | Same, then builds the ed25519 instruction | Throws `KytRefusedError` on `verdict: 0` |

→ [KYT gating](../concepts/kyt-gating.md)

## Next

* [Database](database.md)
* [Configuration and deployment](configuration.md)
