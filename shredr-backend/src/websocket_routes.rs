use axum::{routing::get, Router};
use std::sync::Arc;

use crate::websocket::{websocket_handler, WebSocketState};

/// Build WebSocket router
pub fn router(state: Arc<WebSocketState>) -> Router {
    Router::new()
        .route("/ws", get(websocket_handler))
        .with_state(state)
}
