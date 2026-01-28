use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::db::{CreateBlobRequest, DbHandler};

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
    100
}

pub async fn create_blob_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateBlobRequest>,
) -> impl IntoResponse {
    match state.db.create_blob(&request.encrypted_blob).await {
        Ok(blob) => (StatusCode::CREATED, Json(blob)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: e })).into_response(),
    }
}

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
                        error: "Blob not found".into(),
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

pub async fn get_blob_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.get_blob(&id).await {
        Ok(blob) => (StatusCode::OK, Json(blob)).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(ErrorResponse { error: e })).into_response(),
    }
}

pub async fn list_blobs_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> impl IntoResponse {
    let limit = query.limit.clamp(1, 100);
    match state.db.list_blobs(limit, query.offset).await {
        Ok(blobs) => (StatusCode::OK, Json(blobs)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e }),
        )
            .into_response(),
    }
}

/// Build blob write router (POST/DELETE /api/blobs)
pub fn write_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/blobs", post(create_blob_handler))
        .route("/api/blobs/:id", delete(delete_blob_handler))
        .with_state(state)
}

/// Build blob read router (GET /api/blobs)
pub fn read_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/blobs", get(list_blobs_handler))
        .route("/api/blobs/:id", get(get_blob_handler))
        .with_state(state)
}