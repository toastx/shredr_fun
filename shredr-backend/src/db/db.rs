use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Maximum blob size in bytes (2KB - actual blobs are ~200 bytes)
pub const MAX_BLOB_SIZE: usize = 2048;

#[derive(Clone)]
pub struct DbHandler {
    pool: PgPool,
}

impl DbHandler {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Initialize the database schema
    pub async fn init_schema(&self) -> Result<(), String> {
        // Create the table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS nonce_blobs (
                id UUID PRIMARY KEY,
                encrypted_blob TEXT NOT NULL,
                created_at BIGINT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to create table: {}", e))?;

        // Create the index
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_nonce_blobs_created_at ON nonce_blobs(created_at)
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to create index: {}", e))?;

        Ok(())
    }

    /// Create a new nonce blob
    /// Returns the created blob with its ID
    pub async fn create_blob(&self, encrypted_blob: &str) -> Result<NonceBlob, String> {
        // Size check to prevent spam
        if encrypted_blob.len() > MAX_BLOB_SIZE {
            return Err(format!(
                "Blob too large: {} bytes (max {} bytes)",
                encrypted_blob.len(),
                MAX_BLOB_SIZE
            ));
        }

        let id = Uuid::new_v4();
        let created_at = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            r#"
            INSERT INTO nonce_blobs (id, encrypted_blob, created_at)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(id)
        .bind(encrypted_blob)
        .bind(created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to create blob: {}", e))?;

        Ok(NonceBlob {
            id: id.to_string(),
            encrypted_blob: encrypted_blob.to_string(),
            created_at,
        })
    }

    /// Delete a blob by ID
    pub async fn delete_blob(&self, id: &str) -> Result<bool, String> {
        let uuid = Uuid::parse_str(id).map_err(|e| format!("Invalid UUID: {}", e))?;

        let result = sqlx::query(
            r#"
            DELETE FROM nonce_blobs WHERE id = $1
            "#,
        )
        .bind(uuid)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to delete blob: {}", e))?;

        Ok(result.rows_affected() > 0)
    }

    /// Get a blob by ID
    pub async fn get_blob(&self, id: &str) -> Result<NonceBlob, String> {
        let uuid = Uuid::parse_str(id).map_err(|e| format!("Invalid UUID: {}", e))?;

        let row = sqlx::query(
            r#"
            SELECT id, encrypted_blob, created_at
            FROM nonce_blobs
            WHERE id = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("Failed to fetch blob: {}", e))?;

        match row {
            Some(row) => {
                let id: Uuid = row.get("id");
                let encrypted_blob: String = row.get("encrypted_blob");
                let created_at: i64 = row.get("created_at");

                Ok(NonceBlob {
                    id: id.to_string(),
                    encrypted_blob,
                    created_at,
                })
            }
            None => Err("Blob not found".to_string()),
        }
    }

    /// List all blobs (for frontend to try decrypting each)
    pub async fn list_blobs(&self, limit: i64, offset: i64) -> Result<Vec<NonceBlob>, String> {
        let rows = sqlx::query(
            r#"
            SELECT id, encrypted_blob, created_at
            FROM nonce_blobs
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
            "#,
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("Failed to list blobs: {}", e))?;

        let blobs = rows
            .iter()
            .map(|row| {
                let id: Uuid = row.get("id");
                let encrypted_blob: String = row.get("encrypted_blob");
                let created_at: i64 = row.get("created_at");

                NonceBlob {
                    id: id.to_string(),
                    encrypted_blob,
                    created_at,
                }
            })
            .collect();

        Ok(blobs)
    }
}

/// NonceBlob matches frontend's expected interface
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonceBlob {
    pub id: String,
    pub encrypted_blob: String,
    pub created_at: i64,
}

/// Request to create a new blob
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBlobRequest {
    pub encrypted_blob: String,
}
