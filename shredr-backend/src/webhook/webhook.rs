use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use helius::types::{
    AccountWebhookEncoding, CreateWebhookRequest, TransactionStatus, TransactionType, WebhookType,
};
use helius::Helius;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::watch;

// use crate::websocket::WebSocketMessage;

#[derive(Clone)]
pub struct WebhookState {
    // pub tx: watch::Sender<WebSocketMessage>,
    pub helius: Arc<Helius>,
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

#[derive(Deserialize)]
pub struct CreateWebhookPayload {
    pub webhook_url: String,
    pub transaction_types: Vec<TransactionType>,
    pub account_addresses: Vec<String>,
    pub webhook_type: WebhookType,
    pub encoding: AccountWebhookEncoding,
    pub txn_status: TransactionStatus,
}

#[derive(Deserialize)]
pub struct AddAddressRequest {
    pub webhook_id: String,
    pub addresses: Vec<String>,
}

#[derive(Deserialize)]
pub struct RemoveAddressRequest {
    pub webhook_id: String,
    pub addresses: Vec<String>,
}

pub async fn create_webhook_handler(
    State(state): State<Arc<WebhookState>>,
    Json(payload): Json<CreateWebhookPayload>,
) -> impl IntoResponse {
    let request = CreateWebhookRequest {
        webhook_url: payload.webhook_url,
        transaction_types: payload.transaction_types,
        account_addresses: payload.account_addresses,
        webhook_type: payload.webhook_type,
        auth_header: None,
        encoding: payload.encoding,
        txn_status: payload.txn_status,
    };

    match state.helius.create_webhook(request).await {
        Ok(webhook) => (
            StatusCode::OK,
            Json(WebhookResponse {
                message: format!("Webhook created: {:?}", webhook.webhook_id),
            }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(WebhookResponse {
                message: format!("Failed to create webhook: {}", e),
            }),
        ),
    }
}

pub async fn add_address_handler(
    State(state): State<Arc<WebhookState>>,
    Json(payload): Json<AddAddressRequest>,
) -> impl IntoResponse {
    match state
        .helius
        .append_addresses_to_webhook(&payload.webhook_id, &payload.addresses)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(WebhookResponse {
                message: "Addresses added successfully".to_string(),
            }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(WebhookResponse {
                message: format!("Failed to add addresses: {}", e),
            }),
        ),
    }
}

pub async fn remove_address_handler(
    State(state): State<Arc<WebhookState>>,
    Json(payload): Json<RemoveAddressRequest>,
) -> impl IntoResponse {
    match state
        .helius
        .remove_addresses_from_webhook(&payload.webhook_id, &payload.addresses)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(WebhookResponse {
                message: "Addresses removed successfully".to_string(),
            }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(WebhookResponse {
                message: format!("Failed to remove addresses: {}", e),
            }),
        ),
    }
}

// Helius webhook handler - receives Solana transaction notifications
// pub async fn helius_webhook_handler(
//     State(state): State<Arc<WebhookState>>,
//     Json(payload): Json<HeliusWebhookPayload>,
// ) -> impl IntoResponse {
//     tracing::info!("Received Helius webhook: {:?}", payload);

//     // Create WebSocket message from webhook data
//     let ws_message = WebSocketMessage::Transaction {
//         data: payload.data,
//         timestamp: chrono::Utc::now(),
//     };

//     // Broadcast to all connected WebSocket clients
//     match state.tx.send(ws_message) {
//         Ok(_) => {
//             tracing::info!("Successfully broadcast transaction to WebSocket clients");
//             (
//                 StatusCode::OK,
//                 Json(WebhookResponse {
//                     message: "Webhook received and broadcast".to_string(),
//                 }),
//             )
//         }
//         Err(e) => {
//             tracing::error!("Failed to broadcast to WebSocket clients: {}", e);
//             (
//                 StatusCode::INTERNAL_SERVER_ERROR,
//                 Json(WebhookResponse {
//                     message: format!("Failed to broadcast: {}", e),
//                 }),
//             )
//         }
//     }
// }
