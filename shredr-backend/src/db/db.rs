use sqlx::{PgPool, Row};
use uuid::Uuid;
use crate::error::AppError;

/// Maximum blob size in bytes (2KB - actual blobs are ~200 bytes)
/// encoded bytes limit
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
    pub async fn init_schema(&self) -> Result<(), AppError> {
        // Create the table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS nonce_blobs (
                id UUID PRIMARY KEY,
                encrypted_blob TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                is_consumed BOOLEAN NOT NULL DEFAULT FALSE
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Try to add the column if it doesn't exist (for existing databases)
        let _ = sqlx::query(
            r#"
            ALTER TABLE nonce_blobs ADD COLUMN IF NOT EXISTS is_consumed BOOLEAN NOT NULL DEFAULT FALSE
            "#,
        )
        .execute(&self.pool)
        .await;

        // Create the index
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_nonce_blobs_created_at ON nonce_blobs(created_at)
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Create a new nonce blob
    /// Returns the created blob with its ID
    pub async fn create_blob(&self, encrypted_blob: &str) -> Result<NonceBlob, AppError> {
        // Size check to prevent spam
        if encrypted_blob.len() > MAX_BLOB_SIZE {
            return Err(AppError::BlobTooLarge {
                size: encrypted_blob.len(),
                max: MAX_BLOB_SIZE,
            });
        }

        let id = Uuid::new_v4();
        let created_at = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            r#"
            INSERT INTO nonce_blobs (id, encrypted_blob, created_at, is_consumed)
            VALUES ($1, $2, $3, FALSE)
            "#,
        )
        .bind(id)
        .bind(encrypted_blob)
        .bind(created_at)
        .execute(&self.pool)
        .await?;

        Ok(NonceBlob {
            id: id.to_string(),
            encrypted_blob: encrypted_blob.to_string(),
            created_at,
            is_consumed: false,
        })
    }

    /// Delete a blob by ID (Now marks it as consumed instead of deleting to keep history)
    pub async fn delete_blob(&self, id: &str) -> Result<bool, AppError> {
        let uuid = Uuid::parse_str(id)?;

        let result = sqlx::query(
            r#"
            UPDATE nonce_blobs SET is_consumed = TRUE WHERE id = $1
            "#,
        )
        .bind(uuid)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Get a blob by ID
    pub async fn get_blob(&self, id: &str) -> Result<NonceBlob, AppError> {
        let uuid = Uuid::parse_str(id)?;

        let row = sqlx::query(
            r#"
            SELECT id, encrypted_blob, created_at, is_consumed
            FROM nonce_blobs
            WHERE id = $1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => {
                let id: Uuid = row.get("id");
                let encrypted_blob: String = row.get("encrypted_blob");
                let created_at: i64 = row.get("created_at");
                let is_consumed: bool = row.get("is_consumed");

                Ok(NonceBlob {
                    id: id.to_string(),
                    encrypted_blob,
                    created_at,
                    is_consumed,
                })
            }
            None => Err(AppError::NotFound),
        }
    }

    /// List all blobs using keyset pagination
    pub async fn list_blobs(&self, limit: i64, cursor: Option<i64>) -> Result<Vec<NonceBlob>, AppError> {
        let query_str = match cursor {
            Some(_) => {
                r#"
                SELECT id, encrypted_blob, created_at, is_consumed
                FROM nonce_blobs
                WHERE is_consumed = FALSE AND created_at < $1
                ORDER BY created_at DESC
                LIMIT $2
                "#
            }
            None => {
                r#"
                SELECT id, encrypted_blob, created_at, is_consumed
                FROM nonce_blobs
                WHERE is_consumed = FALSE
                ORDER BY created_at DESC
                LIMIT $1
                "#
            }
        };

        let mut query = sqlx::query(query_str);

        if let Some(c) = cursor {
            query = query.bind(c).bind(limit);
        } else {
            query = query.bind(limit);
        }

        let rows = query.fetch_all(&self.pool).await?;

        let blobs = rows
            .iter()
            .map(|row| {
                let id: Uuid = row.get("id");
                let encrypted_blob: String = row.get("encrypted_blob");
                let created_at: i64 = row.get("created_at");
                let is_consumed: bool = row.get("is_consumed");

                NonceBlob {
                    id: id.to_string(),
                    encrypted_blob,
                    created_at,
                    is_consumed,
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
    pub is_consumed: bool,
}

/// Request to create a new blob
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBlobRequest {
    pub encrypted_blob: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    #[tokio::test]
    async fn test_create_blob_too_large() {
        // Use a lazy connection so we don't need a real DB for validation logic
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://fake:fake@localhost:5432/fake")
            .expect("Failed to create pool");
        
        let db = DbHandler::new(pool);
        
        let huge_blob = "a".repeat(MAX_BLOB_SIZE + 1);
        let result = db.create_blob(&huge_blob).await;
        
        assert!(result.is_err());
        if let Err(AppError::BlobTooLarge { .. }) = result {
            // expected
        } else {
            panic!("Expected BlobTooLarge error");
        }
    }

    #[tokio::test]
    async fn test_create_blob_valid_size() {
         // Use a lazy connection so we don't need a real DB for validation logic
         // This test will fail at the DB step, but it confirms validation passed
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://fake:fake@localhost:5432/fake")
            .expect("Failed to create pool");
        
        let db = DbHandler::new(pool);
        
        let valid_blob = "a".repeat(MAX_BLOB_SIZE);
        let result = db.create_blob(&valid_blob).await;
        
        // Should be Err because DB connection fails, not "Blob too large"
        assert!(result.is_err());
        match result {
            Err(AppError::Database(_)) => {
                // Expected, since DB is fake
            },
            Err(e) => panic!("Expected Database error, got: {:?}", e),
            Ok(_) => panic!("Expected error"),
        }
    }
}