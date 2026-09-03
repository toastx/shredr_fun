use axum::{extract::State, response::IntoResponse, routing::post, Json, Router};
use std::sync::Arc;

use super::kyt::{KytState, ScreenRequest};
use crate::error::AppError;

/// Screen a depositor and return a signed attestation.
///
/// Deliberately not logged, at any level. A line pairing a depositor with a
/// burner is the correlation the whole design exists to prevent, and an access
/// log with a source IP next to it is worse. The audit trail this service is
/// supposed to produce belongs in a separate store with its own access control
/// — see `docs/concepts/rpc-opsec.md`.
pub async fn screen_handler(
    State(state): State<Arc<KytState>>,
    Json(request): Json<ScreenRequest>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(state.screen(&request)?))
}

pub fn router(state: Arc<KytState>) -> Router {
    Router::new()
        .route("/api/kyt/screen", post(screen_handler))
        .with_state(state)
}
