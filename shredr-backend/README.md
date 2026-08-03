# Shredr Backend

A Rust/Axum service backing [shredr.fun](https://github.com/toastx/shredr_fun). It does two things:

1. Stores **encrypted state blobs** in PostgreSQL so users can recover their burner-chain position on any device.
2. Exposes thin wrappers over the **Helius webhook API** for address monitoring.

> **The backend never holds keys, never sees plaintext, and never touches funds.** Blobs are AES-GCM ciphertext encrypted with a key derived from a wallet signature that never leaves the user's browser. There is no authentication and no user table — blobs are anonymous rows. If this service disappeared, users could still recover everything from their wallet signature plus an on-chain scan.

## Architecture

```
┌──────────┐
│  Client  │
└────┬─────┘
     │
     ├──► POST   /api/blobs        create an encrypted blob
     ├──► GET    /api/blobs        list unconsumed blobs (keyset paginated)
     ├──► GET    /api/blobs/{id}   get one blob
     ├──► DELETE /api/blobs/{id}   mark consumed (soft delete)
     │
     ├──► POST   /webhook/create   create a Helius webhook
     ├──► POST   /webhook/address  add addresses to a webhook
     ├──► DELETE /webhook/address  remove addresses from a webhook
     │
     └──► GET    /health

┌──────────────────────────────────────────────┐
│              Shredr Backend                  │
│                                              │
│   db_routes ──► DbHandler ──► PostgreSQL     │
│   webhook_routes ──► Helius client           │
│                                              │
│   middleware: tower_governor (3 rate tiers)  │
│               tower_http CORS                │
└──────────────────────────────────────────────┘
```

## API

All blob responses use camelCase (`#[serde(rename_all = "camelCase")]`) to match the frontend's `NonceBlob` interface. No endpoint requires authentication.

### `POST /api/blobs`

Create an encrypted blob.

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

`createdAt` is Unix **milliseconds**. Blobs over `MAX_BLOB_SIZE` (2048 bytes) are rejected with `400`; real blobs are ~200 bytes.

```bash
curl -X POST http://localhost:8000/api/blobs \
  -H "Content-Type: application/json" \
  -d '{"encryptedBlob":"eyJub25jZSI6..."}'
```

### `GET /api/blobs`

List **unconsumed** blobs, newest first.

| Query param | Default | Notes |
|---|---|---|
| `limit` | 100 | Clamped to 1–100 |
| `cursor` | none | Keyset pagination on `created_at` |

Pagination is keyset-based, not offset-based — pass the `createdAt` of the last item you received as the next `cursor`:

```sql
WHERE is_consumed = FALSE AND created_at < $1
ORDER BY created_at DESC
LIMIT $2
```

```bash
curl "http://localhost:8000/api/blobs?limit=50"
```

> **Known gap:** the frontend's `ApiClient.fetchAllBlobs()` requests a flat `limit=100` with no cursor. Since blobs carry no user identifier, recovery means downloading and trial-decrypting each one — so past ~100 total unconsumed blobs, a returning user's blob may fall outside the response and recovery silently fails. The server supports the cursor; the client does not use it.

### `GET /api/blobs/{id}`

Returns one blob (including consumed ones). `400` on an invalid UUID, `404` if not found.

### `DELETE /api/blobs/{id}`

**`200 OK`** — `{ "success": true }`

> **This is a soft delete.** The row is not removed:
>
> ```sql
> UPDATE nonce_blobs SET is_consumed = TRUE WHERE id = $1
> ```
>
> Consumed blobs are excluded from list results, but every historical blob is retained indefinitely. Plan a retention policy if you operate a deployment.

### `POST /webhook/create`

Creates a Helius webhook. Note these fields are **snake_case**, unlike the blob endpoints.

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

**`200 OK`** — `{ "message": "Webhook created: Some(\"<id>\")" }`

### `POST` / `DELETE /webhook/address`

Add or remove addresses on an existing webhook.

```json
{ "webhook_id": "...", "addresses": ["Address1...", "Address2..."] }
```

### `GET /health`

Returns the plain-text body `OK`.

## What is *not* here

Two things exist in the source but are **disabled**, and the frontend does not use either:

- **The WebSocket module.** `mod websocket;` is commented out in `main.rs`, along with its state and router merge. The frontend's `WebSocketClient` connects directly to Helius over WSS and uses Solana's standard `accountSubscribe` — no server-side registration needed, and the backend never learns which addresses a user is watching.
- **The `/webhook/helius` receiver.** `helius_webhook_handler` in `webhook.rs` and its route are commented out. It was the counterpart to the WebSocket fan-out design that direct subscription replaced.

The webhook *management* endpoints above do work, but nothing currently calls them.

## Setup

### Prerequisites

- Rust 1.75+
- PostgreSQL 14+

### 1. Start PostgreSQL

```bash
docker run --name shredr-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=shredr_db \
  -p 5432:5432 \
  -d postgres:14
```

Or locally: `createdb shredr_db`

### 2. Configure

```bash
cp .env.example .env
```

The connection string is assembled from four separate variables:

```
postgres://{PGUSER}:{PGPASSWORD}@{PGHOST}/{PGDATABASE}?sslmode=require
```

> `PGHOST` must include the port if it is not 5432, and `sslmode=require` is **always** appended — a plain local Postgres without TLS will refuse the connection. Either enable SSL or adjust `build_database_url()` in `src/main.rs`.
>
> The startup panic messages name the old variable names (`DATABASE_HOST is required`, etc.). If you see one, set the corresponding `PG*` variable.

### 3. Run

```bash
cargo run
```

Listens on `0.0.0.0:8000` (or `$PORT`). The schema is created automatically on first run.

```bash
curl http://localhost:8000/health   # → OK
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PGHOST` | **Yes** | — | Host, with port if non-default |
| `PGUSER` | **Yes** | — | Database user |
| `PGPASSWORD` | **Yes** | — | Database password |
| `PGDATABASE` | **Yes** | — | Database name |
| `HELIUS_API_KEY` | **Yes** | — | Helius client — panics without it |
| `ENVIRONMENT` | No | *(treated as `development`)* | `development` enables permissive CORS |
| `PORT` | No | `8000` | Listen port |
| `RUST_LOG` | No | — | Tracing filter |

Every startup failure is a panic — the service either starts fully working or not at all.

### CORS

```rust
let is_development = std::env::var("ENVIRONMENT")
    .map(|e| e == "development")
    .unwrap_or(true);      // ← defaults to development
```

| Mode | Behaviour |
|---|---|
| Development (default) | `allow_origin(Any)` |
| Production | Only `https://shredr.fun` and `https://www.shredr.fun` |

> **Forgetting to set `ENVIRONMENT` in production leaves CORS open to any origin.** Set it explicitly. If you deploy under a different domain, edit the allowlist in `main.rs` — it is hardcoded.

### Rate limiting

Three `tower_governor` tiers, keyed by client IP:

| Tier | Endpoints | Limit |
|---|---|---|
| Blob writes | `POST /api/blobs`, `DELETE /api/blobs/{id}` | Burst 5, refill every 10s |
| Blob reads | `GET /api/blobs`, `GET /api/blobs/{id}` | 30/sec, burst 60 |
| Webhooks | `/webhook/*` | Burst 5, refill every 12s |

`ForwardedIpKeyExtractor` reads the IP from `X-Forwarded-For` (last entry) → `X-Real-IP` → socket peer address.

> Without a proxy that **overwrites** `X-Forwarded-For`, a client can spoof it to evade rate limiting. Verify your ingress does this.

Exceeding a limit returns `429`.

## Database

One table, created on startup by `DbHandler::init_schema()`:

```sql
CREATE TABLE IF NOT EXISTS nonce_blobs (
    id             UUID PRIMARY KEY,
    encrypted_blob TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    is_consumed    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_nonce_blobs_created_at ON nonce_blobs(created_at);
```

There is also an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS is_consumed` for databases predating that column; its result is deliberately ignored.

Connection pool: max 10 connections, 30-second acquire timeout.

Note what is **absent**: no wallet address, no user ID, no session, no auth token. That is deliberate — the operator cannot read blob contents, identify whose blob is whose, or group blobs by user.

## Project structure

```
src/
├── main.rs                  # Entry point, router, middleware, IP extractor
├── error.rs                 # AppError → HTTP responses
├── db/
│   ├── db.rs                # DbHandler, NonceBlob, CreateBlobRequest
│   ├── db_routes.rs         # Blob handlers and routers
│   └── mod.rs
├── webhook/
│   ├── webhook.rs           # Helius webhook management
│   ├── webhook_routes.rs
│   └── mod.rs
└── websocket/               # PRESENT BUT DISABLED (commented out in main.rs)
    ├── websocket.rs
    ├── websocket_routes.rs
    └── mod.rs
```

## Errors

Blob endpoints return a structured body:

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

Database errors are deliberately opaque to clients so query details never leak. Webhook endpoints return `{ "message": "..." }` instead, including on failure.

## Development

```bash
cargo test      # blob size validation (uses a lazy pool — no live DB needed)
cargo fmt
cargo clippy
```

Test coverage is currently limited to blob size validation. Query correctness is not covered.

## Docker

```bash
docker build -t shredr-backend .

docker run -p 8000:8000 \
  -e PGHOST=host.docker.internal:5432 \
  -e PGUSER=postgres \
  -e PGPASSWORD=password \
  -e PGDATABASE=shredr_db \
  -e HELIUS_API_KEY=your_key \
  -e ENVIRONMENT=production \
  shredr-backend
```

`PORT` is read from the environment, which suits platforms that assign one (Koyeb, Fly, Railway, Render).

## Production checklist

- [ ] Set `ENVIRONMENT` to something other than `development`
- [ ] Update the CORS allowlist in `main.rs` if your domain differs
- [ ] Set all four `PG*` variables and `HELIUS_API_KEY`
- [ ] Ensure PostgreSQL accepts TLS (`sslmode=require` is not optional)
- [ ] Verify your proxy overwrites `X-Forwarded-For`
- [ ] Serve over HTTPS
- [ ] Set `RUST_LOG` quieter than `debug`
- [ ] Health checks on `GET /health`
- [ ] A retention job for consumed blobs — rows are never deleted

## Further reading

Full documentation lives in [`docs/`](../docs/) at the repository root:

- [Backend overview](../docs/backend/README.md)
- [API reference](../docs/backend/api-reference.md)
- [Database](../docs/backend/database.md)
- [Helius webhooks](../docs/backend/webhooks.md)
- [Configuration and deployment](../docs/backend/configuration.md)

## License

MIT
