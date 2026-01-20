use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::watch;

use crate::websocket::WebSocketMessage;

#[derive(Clone)]
pub struct WebhookState {
    pub tx: watch::Sender<WebSocketMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct HeliusWebhookPayload {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Serialize)]
pub struct WebhookResponse {
    pub message: String,
}

/// Helius webhook handler - receives Solana transaction notifications
pub async fn helius_webhook_handler(
    State(state): State<Arc<WebhookState>>,
    Json(payload): Json<HeliusWebhookPayload>,
) -> impl IntoResponse {
    tracing::info!("Received Helius webhook: {:?}", payload);

    // Create WebSocket message from webhook data
    let ws_message = WebSocketMessage::Transaction {
        data: payload.data,
        timestamp: chrono::Utc::now(),
    };

    // Broadcast to all connected WebSocket clients
    match state.tx.send(ws_message) {
        Ok(_) => {
            tracing::info!("Successfully broadcast transaction to WebSocket clients");
            (
                StatusCode::OK,
                Json(WebhookResponse {
                    message: "Webhook received and broadcast".to_string(),
                }),
            )
        }
        Err(e) => {
            tracing::error!("Failed to broadcast to WebSocket clients: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(WebhookResponse {
                    message: format!("Failed to broadcast: {}", e),
                }),
            )
        }
    }
}
