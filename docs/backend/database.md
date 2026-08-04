---
description: "The single table, its queries, and what it deliberately does not store."
icon: table
---

# Database

PostgreSQL via SQLx. One table.

## Schema

Created automatically on startup by `DbHandler::init_schema()`:

```sql
CREATE TABLE IF NOT EXISTS nonce_blobs (
    id             UUID PRIMARY KEY,
    encrypted_blob TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    is_consumed    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_nonce_blobs_created_at ON nonce_blobs(created_at);
```

There is also an idempotent migration for databases created before `is_consumed` existed:

```sql
ALTER TABLE nonce_blobs ADD COLUMN IF NOT EXISTS is_consumed BOOLEAN NOT NULL DEFAULT FALSE
```

Its result is deliberately ignored (`let _ = ...`), so it is harmless on an already-migrated database.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | Generated server-side with `Uuid::new_v4()` |
| `encrypted_blob` | `TEXT` | Base64 of `IV ‖ AES-GCM ciphertext`. Opaque to the server |
| `created_at` | `BIGINT` | Unix **milliseconds** |
| `is_consumed` | `BOOLEAN` | Soft-delete flag |

{% hint style="info" %}
`created_at` is a `BIGINT` of milliseconds rather than a `TIMESTAMPTZ`. It matches the JavaScript `Date.now()` representation the frontend uses, and it is what the keyset cursor compares against.
{% endhint %}

## What is deliberately absent

| Not stored | Why |
|---|---|
| Wallet address | Would let the operator identify and group users |
| User ID | There are no accounts |
| Session or auth token | There is no authentication |
| Decryption key | Derived from a signature that never leaves the browser |
| IP address | Not persisted (though the rate limiter sees it in memory) |

The result: a table of anonymous encrypted strings. Recovery works by downloading blobs and trying to decrypt each — only yours succeeds.

→ [The privacy model](../concepts/privacy-model.md)

## Queries

### Create

```rust
pub async fn create_blob(&self, encrypted_blob: &str) -> Result<NonceBlob, AppError> {
    if encrypted_blob.len() > MAX_BLOB_SIZE {
        return Err(AppError::BlobTooLarge { size: encrypted_blob.len(), max: MAX_BLOB_SIZE });
    }

    let id = Uuid::new_v4();
    let created_at = chrono::Utc::now().timestamp_millis();

    sqlx::query("INSERT INTO nonce_blobs (id, encrypted_blob, created_at, is_consumed) VALUES ($1, $2, $3, FALSE)")
        .bind(id).bind(encrypted_blob).bind(created_at)
        .execute(&self.pool).await?;
    // ...
}
```

`MAX_BLOB_SIZE = 2048` bytes. Real blobs are around 200 — the cap is anti-spam headroom.

### Delete (soft)

```rust
sqlx::query("UPDATE nonce_blobs SET is_consumed = TRUE WHERE id = $1")
```

Returns `true` if `rows_affected() > 0`, which the handler turns into a `404` when false.

{% hint style="warning" %}
**Rows are never removed.** Every blob a user has ever created remains in the database, encrypted, indefinitely.

They are excluded from list results so recovery ignores them, and they are unreadable without the user's key. But if you operate a deployment, you are accumulating data forever — plan a retention policy.
{% endhint %}

### Get

```rust
sqlx::query("SELECT id, encrypted_blob, created_at, is_consumed FROM nonce_blobs WHERE id = $1")
    .fetch_optional(&self.pool).await?
```

Returns consumed blobs too. `None` maps to `AppError::NotFound`.

### List

Two variants depending on whether a cursor was supplied:

{% tabs %}
{% tab title="First page" %}
```sql
SELECT id, encrypted_blob, created_at, is_consumed
FROM nonce_blobs
WHERE is_consumed = FALSE
ORDER BY created_at DESC
LIMIT $1
```
{% endtab %}

{% tab title="With cursor" %}
```sql
SELECT id, encrypted_blob, created_at, is_consumed
FROM nonce_blobs
WHERE is_consumed = FALSE AND created_at < $1
ORDER BY created_at DESC
LIMIT $2
```
{% endtab %}
{% endtabs %}

**Keyset pagination**, not offset. It stays fast at any depth and does not skip or duplicate rows when data is inserted concurrently — both real problems with `OFFSET`.

The index on `created_at` serves both the ordering and the cursor comparison.

Limit is clamped in the handler:

```rust
let limit = query.limit.clamp(1, 100);
```

## Connection pool

```rust
PgPoolOptions::new()
    .max_connections(10)
    .acquire_timeout(Duration::from_secs(30))
    .connect(&database_url)
    .await
```

The URL is assembled from four environment variables:

```rust
format!("postgres://{}:{}@{}/{}?sslmode=require", user, password, host, database)
```

`sslmode=require` is always appended.

→ [Configuration and deployment](configuration.md)

## Rust types

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonceBlob {
    pub id: String,
    pub encrypted_blob: String,
    pub created_at: i64,
    pub is_consumed: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBlobRequest {
    pub encrypted_blob: String,
}
```

`rename_all = "camelCase"` makes the JSON match the frontend's `NonceBlob` interface exactly, so no mapping layer is needed.

## Tests

`cargo test` runs two tests covering blob size validation. They use a **lazy** connection pool pointed at a fake database, so no live PostgreSQL is needed:

```rust
let pool = PgPoolOptions::new()
    .connect_lazy("postgres://fake:fake@localhost:5432/fake")
    .expect("Failed to create pool");
```

* An oversized blob must fail with `BlobTooLarge` before any query runs.
* A valid-size blob must fail with `Database` — proving validation passed and the failure came from the (fake) connection.

Query correctness is not covered by tests.

## Operational notes

<details>
<summary><strong>Growth</strong></summary>

Every burner rotation creates a blob and consumes the previous one. Rows accumulate at roughly one per payment received, per user, forever.

At ~250 bytes per row this is slow growth, but it is unbounded. A cleanup job deleting rows where `is_consumed = TRUE AND created_at < <cutoff>` would be safe — consumed blobs are never read.
</details>

<details>
<summary><strong>Backups</strong></summary>

Losing this database does not lose funds. Users fall back to IndexedDB, and to on-chain scanning where that is missing. It is a convenience layer.
</details>

<details>
<summary><strong>Scaling</strong></summary>

The list query is the hot path and it is well-indexed. The real scaling problem is architectural rather than database-level: recovery requires clients to download and trial-decrypt blobs, which grows with total user count.

Fixing it means adding a lookup key — but any such key would let the operator group blobs by user, weakening the privacy property. It is a genuine trade-off, not an oversight.
</details>

## Next

* [API reference](api-reference.md)
* [State sync and recovery](../concepts/state-sync-and-recovery.md)
