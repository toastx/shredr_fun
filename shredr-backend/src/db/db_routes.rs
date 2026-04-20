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
use crate::error::AppError;

#[derive(Clone)]
pub struct AppState {
    pub db: DbHandler,
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub cursor: Option<i64>,
}

fn default_limit() -> i64 {
    100
}

pub async fn create_blob_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateBlobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let blob = state.db.create_blob(&request.encrypted_blob).await?;
    Ok((StatusCode::CREATED, Json(blob)))
}

pub async fn delete_blob_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let deleted = state.db.delete_blob(&id).await?;
    if deleted {
        Ok((StatusCode::OK, Json(serde_json::json!({ "success": true }))))
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn get_blob_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let blob = state.db.get_blob(&id).await?;
    Ok((StatusCode::OK, Json(blob)))
}

pub async fn list_blobs_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> Result<impl IntoResponse, AppError> {
    let limit = query.limit.clamp(1, 100);
    let blobs = state.db.list_blobs(limit, query.cursor).await?;
    Ok((StatusCode::OK, Json(blobs)))
}

/// Build blob write router (POST/DELETE /api/blobs)
pub fn write_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/blobs", post(create_blob_handler))
        .route("/api/blobs/{id}", delete(delete_blob_handler))
        .with_state(state)
}

/// Build blob read router (GET /api/blobs)
pub fn read_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/blobs", get(list_blobs_handler))
        .route("/api/blobs/{id}", get(get_blob_handler))
        .with_state(state)
}