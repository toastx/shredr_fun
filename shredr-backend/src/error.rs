use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    
    #[error("Invalid UUID: {0}")]
    InvalidUuid(#[from] uuid::Error),
    
    #[error("Blob not found")]
    NotFound,
    
    #[error("Blob too large: {size} bytes (max {max} bytes)")]
    BlobTooLarge { size: usize, max: usize },
    
    #[error("Internal server error: {0}")]
    Internal(String),
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message) = match &self {
            AppError::Database(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal database error".to_string(),
            ),
            AppError::InvalidUuid(e) => (StatusCode::BAD_REQUEST, format!("Invalid UUID: {}", e)),
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::BlobTooLarge { .. } => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
        };

        let body = Json(ErrorResponse {
            error: error_message,
        });

        (status, body).into_response()
    }
}
