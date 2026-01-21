use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::db::{CreateBlobRequest, DbHandler};

#[derive(Clone)]
pub struct AppState {
    pub db: DbHandler,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    100 // Higher default for blob listing (frontend needs to try decrypt each)
}

/// Create blob endpoint - matches frontend's createBlob(data: CreateBlobRequest): Promise<NonceBlob>
///
/// POST /api/blobs
/// Body: { "encryptedBlob": "base64..." }
/// Returns: NonceBlob { id, encryptedBlob, createdAt }
pub async fn create_blob_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateBlobRequest>,
) -> impl IntoResponse {
    match state.db.create_blob(&request.encrypted_blob).await {
        Ok(blob) => (StatusCode::CREATED, Json(blob)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
            .into_response(),
    }
}

/// Delete blob endpoint - matches frontend's deleteBlob(id: string): Promise<boolean>
///
/// DELETE /api/blobs/:id
/// Returns: { "success": true } or 404 if not found
pub async fn delete_blob_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_blob(&id).await {
        Ok(deleted) => {
            if deleted {
                (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response()
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "Blob not found".to_string(),
                    }),
                )
                    .into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
            .into_response(),
    }
}

/// Get blob endpoint - returns a single blob by ID
///
/// GET /api/blobs/:id
/// Returns: NonceBlob
pub async fn get_blob_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.get_blob(&id).await {
        Ok(blob) => (StatusCode::OK, Json(blob)).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(ErrorResponse { error: e })).into_response(),
    }
}

/// List blobs endpoint - matches frontend's fetchAllBlobs(): Promise<NonceBlob[]>
///
/// GET /api/blobs
/// Returns: NonceBlob[]
pub async fn list_blobs_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> impl IntoResponse {
    match state.db.list_blobs(query.limit, query.offset).await {
        Ok(blobs) => (StatusCode::OK, Json(blobs)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
            .into_response(),
    }
}
