use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::db::DbHandler;

#[derive(Clone)]
pub struct AppState {
    pub db: DbHandler,
}

#[derive(Serialize)]
pub struct UploadResponse {
    pub key: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Deserialize)]
pub struct DeleteRequest {
    pub key: String,
}

/// Upload blob endpoint - accepts multipart form data
pub async fn upload_blob_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    // Extract file from multipart
    let mut file_data: Option<Bytes> = None;
    let mut filename: Option<String> = None;

    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        let name = field.name().unwrap_or("").to_string();

        if name == "file" {
            filename = field.file_name().map(|s| s.to_string());
            let data = match field.bytes().await {
                Ok(bytes) => bytes,
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: format!("Failed to read file: {}", e),
                        }),
                    )
                        .into_response();
                }
            };
            file_data = Some(data);
        }
    }

    let data = match file_data {
        Some(d) => d,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "No file provided".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Generate unique key
    let key = format!(
        "{}-{}",
        Uuid::new_v4(),
        filename.unwrap_or_else(|| "blob".to_string())
    );

    // Upload to database
    match state.db.upload_blob(&key, data).await {
        Ok(url) => (StatusCode::OK, Json(UploadResponse { key, url })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
            .into_response(),
    }
}

/// Delete blob endpoint
pub async fn delete_blob_handler(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_blob(&key).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "message": "Blob deleted successfully" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
            .into_response(),
    }
}
