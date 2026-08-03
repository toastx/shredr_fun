---
description: "The Axum service that stores encrypted state blobs and manages Helius webhooks."
icon: server
---

# Backend overview

`shredr-backend/` — a small Rust service built on [Axum](https://github.com/tokio-rs/axum) with PostgreSQL. It does two things:

1. Stores **encrypted state blobs** so users can recover on any device.
2. Manages **Helius webhooks** for address monitoring.

{% hint style="info" %}
**The backend is a convenience, not a dependency.** It never holds keys, never sees plaintext, and never touches funds. If it disappeared entirely, users could still recover everything from their wallet signature plus an on-chain scan.

→ [State sync and recovery](../concepts/state-sync-and-recovery.md)
{% endhint %}

{% hint style="danger" %}
**`shredr-backend/README.md` is out of date.** It documents multipart blob uploads at `/api/blob/upload`, a `/ws` WebSocket, and a `/webhook/helius` receiver — none of which exist in the current `main.rs`. This section documents the code as it actually is.
{% endhint %}

## Stack

| Layer | Technology |
|---|---|
| Framework | Axum |
| Runtime | Tokio |
| Database | PostgreSQL via SQLx |
| Rate limiting | `tower_governor` |
| CORS | `tower_http` |
| Solana data | `helius` crate |
| Errors | `thiserror` |
| Logging | `tracing` + `tracing_subscriber` |

## Layout

```
shredr-backend/
├── src/
│   ├── main.rs                    # Entry point, router, middleware
│   ├── error.rs                   # AppError → HTTP responses
│   ├── db/
│   │   ├── db.rs                  # DbHandler, NonceBlob
│   │   └── db_routes.rs           # Blob endpoints
│   ├── webhook/
│   │   ├── webhook.rs             # Helius webhook management
│   │   └── webhook_routes.rs
│   └── websocket/                 # PRESENT BUT DISABLED
│       ├── websocket.rs
│       └── websocket_routes.rs
├── Dockerfile
└── README.md                      # stale — see the warning above
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/blobs` | Create an encrypted blob |
| `GET` | `/api/blobs` | List unconsumed blobs (paginated) |
| `GET` | `/api/blobs/{id}` | Get one blob |
| `DELETE` | `/api/blobs/{id}` | Mark a blob consumed (**soft delete**) |
| `POST` | `/webhook/create` | Create a Helius webhook |
| `POST` | `/webhook/address` | Add addresses to a webhook |
| `DELETE` | `/webhook/address` | Remove addresses from a webhook |
| `GET` | `/health` | Health check |

→ [API reference](api-reference.md)

## The WebSocket module is disabled

The `websocket` module exists in the source but is **commented out** in `main.rs`:

```rust
mod error;
mod db;
mod webhook;
// mod websocket;
```

Its router merge, its state construction, and the `/webhook/helius` receiver that would have broadcast to it are all commented out too.

{% hint style="info" %}
This is not a gap in functionality — the frontend does not use it. `WebSocketClient` connects **directly to Helius** (`HELIUS_WSS_URL`) and uses Solana's standard `accountSubscribe` RPC.

The backend WebSocket was an alternative design where Helius would POST to `/webhook/helius` and the backend would fan out to connected clients. The direct-subscription approach won.

→ [ApiClient and WebSocketClient](../frontend/api-and-websocket.md)
{% endhint %}

## What it knows about users

Nothing.

| Stored | Not stored |
|---|---|
| An opaque encrypted string | Any wallet address |
| A creation timestamp | Any decryption key |
| A consumed flag | Any user identifier |
| A UUID | Any session or auth token |

There is **no authentication and no user table**. Blobs are anonymous rows. Recovery works by downloading blobs and trying to decrypt each one — only yours succeeds.

This means the operator cannot read state, cannot identify whose state is whose, and cannot group blobs by user.

→ [The privacy model](../concepts/privacy-model.md)

## Middleware

### Rate limiting

Three `tower_governor` tiers, keyed by client IP:

| Tier | Applies to | Limit |
|---|---|---|
| Blob writes | `POST /api/blobs`, `DELETE /api/blobs/{id}` | Burst 5, refill every 10s |
| General reads | `GET /api/blobs`, `GET /api/blobs/{id}` | 30/sec, burst 60 |
| Webhooks | `/webhook/*` | Burst 5, refill every 12s |

`ForwardedIpKeyExtractor` reads the client IP from `X-Forwarded-For` (last entry) or `X-Real-IP`, falling back to the socket peer address — correct behaviour behind a reverse proxy.

{% hint style="warning" %}
Trusting `X-Forwarded-For` unconditionally means a client can spoof the header to evade rate limiting, **unless** a trusted proxy in front always overwrites it. Make sure your deployment does.
{% endhint %}

### CORS

```rust
let cors = if is_development {
    CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
} else {
    CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "https://shredr.fun".parse().unwrap(),
            "https://www.shredr.fun".parse().unwrap(),
        ]))
        .allow_methods(Any).allow_headers(Any)
};
```

`is_development` is `ENVIRONMENT == "development"`, and **defaults to `true`** when the variable is unset:

```rust
let is_development = std::env::var("ENVIRONMENT")
    .map(|e| e == "development")
    .unwrap_or(true);
```

{% hint style="danger" %}
**Forgetting to set `ENVIRONMENT` in production leaves CORS wide open.** Set it explicitly to something other than `development`.
{% endhint %}

## Database

One table, created automatically on startup:

```sql
CREATE TABLE IF NOT EXISTS nonce_blobs (
    id             UUID PRIMARY KEY,
    encrypted_blob TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    is_consumed    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_nonce_blobs_created_at ON nonce_blobs(created_at);
```

Connection pool: max 10 connections, 30-second acquire timeout.

→ [Database](database.md)

## Running it

```bash
cd shredr-backend
cargo run     # listens on 0.0.0.0:8000, or $PORT
```

Environment variables are documented in [Configuration and deployment](configuration.md).

{% hint style="warning" %}
`shredr-backend/.env.example` is also stale — it lists a single `DATABASE_URL`, but `main.rs` builds the connection string from four separate `PG*` variables and **panics on startup** if any is missing.
{% endhint %}

## Next

* [API reference](api-reference.md)
* [Database](database.md)
* [Helius webhooks](webhooks.md)
* [Configuration and deployment](configuration.md)
