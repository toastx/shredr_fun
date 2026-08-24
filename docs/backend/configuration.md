---
description: "Environment variables, startup behaviour, Docker, and production checklist."
icon: gear
---

# Configuration and deployment

## Environment variables

{% hint style="danger" %}
**`shredr-backend/.env.example` is stale.** It lists a single `DATABASE_URL`. The current `main.rs` builds the connection string from four separate `PG*` variables and **panics on startup** if any is missing.

Use the table below, not the example file.
{% endhint %}

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PGHOST` | **Yes** | — | Host (with port, e.g. `localhost:5432`) |
| `PGUSER` | **Yes** | — | Database user |
| `PGPASSWORD` | **Yes** | — | Database password |
| `PGDATABASE` | **Yes** | — | Database name |
| `HELIUS_API_KEY` | **Yes** | — | Helius client — panics without it |
| `ENVIRONMENT` | No | *(treated as `development`)* | `development` enables permissive CORS |
| `PORT` | No | `8000` | Listen port |
| `RUST_LOG` | No | — | Tracing filter |

A `.env` file is loaded via `dotenvy` if present.

{% hint style="warning" %}
`HELIUS_API_KEY` is required even though nothing calls the webhook endpoints — the Helius client is constructed unconditionally at startup.
{% endhint %}

## The connection string

```rust
fn build_database_url() -> String {
    let host     = std::env::var("PGHOST").expect("DATABASE_HOST is required");
    let user     = std::env::var("PGUSER").expect("DATABASE_USER is required");
    let password = std::env::var("PGPASSWORD").expect("DATABASE_PASSWORD is required");
    let database = std::env::var("PGDATABASE").expect("DATABASE_NAME is required");

    format!("postgres://{}:{}@{}/{}?sslmode=require", user, password, host, database)
}
```

Two gotchas:

* **`PGHOST` must include the port** if it is not 5432 — it is interpolated directly as the authority.
* **`sslmode=require` is always appended.** A plain local PostgreSQL without TLS will refuse the connection. Either enable SSL on the server or adjust this function for local work.

The panic messages say `DATABASE_HOST`, `DATABASE_USER`, etc. — the *old* names. If you see one, set the corresponding `PG*` variable.

## Startup sequence

{% stepper %}
{% step %}
### Initialize tracing

`tracing_subscriber::fmt::init()`, then load `.env`.
{% endstep %}

{% step %}
### Read config

`HELIUS_API_KEY` and `ENVIRONMENT`. Panics if the API key is missing.
{% endstep %}

{% step %}
### Connect to PostgreSQL

Pool with max 10 connections and a 30-second acquire timeout. Panics on failure.
{% endstep %}

{% step %}
### Initialize the schema

`CREATE TABLE IF NOT EXISTS`, the idempotent `ALTER TABLE`, and the index. Panics on failure.
{% endstep %}

{% step %}
### Build state and middleware

`AppState`, `WebhookState`, three rate-limit tiers, and the CORS layer.
{% endstep %}

{% step %}
### Serve

Binds `0.0.0.0:$PORT`.
{% endstep %}
{% endstepper %}

Every failure in this sequence is a panic — the service either starts fully working or not at all.

## CORS

```rust
let is_development = std::env::var("ENVIRONMENT")
    .map(|e| e == "development")
    .unwrap_or(true);      // ← defaults to development
```

| Mode | Behaviour |
|---|---|
| Development (default) | `allow_origin(Any)` |
| Production | Only `https://shredr.fun` and `https://www.shredr.fun` |

{% hint style="danger" %}
**Forgetting `ENVIRONMENT` in production leaves CORS wide open to any origin.** Set it explicitly.

If you deploy under a different domain you must also edit the allowlist in `main.rs` — it is hardcoded.
{% endhint %}

## Rate limiting

Three tiers via `tower_governor`, keyed by client IP:

| Tier | Endpoints | Limit |
|---|---|---|
| `db_config` | `POST /api/blobs`, `DELETE /api/blobs/{id}` | Burst 5, refill every 10s |
| `general_config` | `GET /api/blobs`, `GET /api/blobs/{id}` | 30/sec, burst 60 |
| `webhook_config` | `/webhook/*` | Burst 5, refill every 12s |

### IP extraction

```rust
impl KeyExtractor for ForwardedIpKeyExtractor {
    fn extract<B>(&self, req: &Request<B>) -> Result<Self::Key, GovernorError> {
        // X-Forwarded-For (LAST entry) → X-Real-IP → socket peer address
    }
}
```

Taking the **last** `X-Forwarded-For` entry is right when a trusted proxy appends the real client IP.

{% hint style="warning" %}
Without a proxy that **overwrites** the header, a client can spoof `X-Forwarded-For` and evade rate limiting entirely. Verify your ingress does this.
{% endhint %}

## Docker

`shredr-backend/Dockerfile` builds the service. The `PORT` variable makes it work on platforms that assign one — Koyeb, Fly, Railway, Render.

```bash
docker build -t shredr-backend ./shredr-backend

docker run -p 8000:8000 \
  -e PGHOST=host.docker.internal:5432 \
  -e PGUSER=postgres \
  -e PGPASSWORD=password \
  -e PGDATABASE=shredr_db \
  -e HELIUS_API_KEY=your_key \
  -e ENVIRONMENT=production \
  shredr-backend
```

There is also a `Dockerfile` and `.dockerignore` at the repository root for the frontend.

## Production checklist

<details>
<summary><strong>Required</strong></summary>

* [ ] Set `ENVIRONMENT` to something other than `development` (CORS)
* [ ] Update the CORS allowlist in `main.rs` if your domain differs
* [ ] Set all four `PG*` variables
* [ ] Set `HELIUS_API_KEY`
* [ ] Ensure PostgreSQL accepts TLS (`sslmode=require` is not optional)
* [ ] Verify your proxy overwrites `X-Forwarded-For`
* [ ] Serve over HTTPS
</details>

<details>
<summary><strong>Recommended</strong></summary>

* [ ] Set `RUST_LOG` to something quieter than `debug`
* [ ] Health checks pointed at `GET /health`
* [ ] Database backups (not fund-critical, but a nicer user experience)
* [ ] A retention job for consumed blobs — rows are never deleted
* [ ] Monitoring on 429 and 500 rates
</details>

<details>
<summary><strong>Frontend side</strong></summary>

* [ ] Update `API_BASE_URL` in `src/lib/constants.ts` — `VITE_API_BASE_URL` is **not** read
* [ ] Rotate the committed Helius API key and move it behind `import.meta.env`
* [ ] Point `KORA_RELAYER_URL` at your relayer
* [ ] Set `VITE_KORA_RELAYER_PUBKEY` to your relayer's actual key

→ [Constants and configuration](../frontend/configuration.md)
</details>

## Logging

`tracing` with `tracing_subscriber::fmt`. Startup logs cover database connection, schema readiness, CORS mode, and the listen address.

Database errors are logged in full but returned to clients as a generic `Internal database error`, so query details never leak.

## Scaling notes

<details>
<summary><strong>Stateless</strong></summary>

The service holds no session state, so you can run as many instances as you like behind a load balancer. Rate limiting is per-instance, though — N instances means roughly N times the effective limit per client.
</details>

<details>
<summary><strong>Connection pool</strong></summary>

10 connections per instance. Multiply by instance count when sizing PostgreSQL's `max_connections`.
</details>

<details>
<summary><strong>The real bottleneck</strong></summary>

Not the database — it is the recovery model. Clients download and trial-decrypt blobs to find their own, which grows with total user count. The frontend pages through the full set, so recovery is correct, but the work per login still scales with adoption.

Fixing it well is a design question, not a capacity one: any lookup key would let the operator group blobs by user.

→ [Limitations](../reference/limitations.md)
</details>

## Next

* [API reference](api-reference.md)
* [Database](database.md)
