use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{watch, Mutex};

#[derive(Clone)]
pub struct WebSocketState {
    pub clients_count: Arc<Mutex<usize>>,
    pub rx: watch::Receiver<WebSocketMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WebSocketMessage {
    #[serde(rename = "transaction")]
    Transaction {
        data: serde_json::Value,
        timestamp: DateTime<Utc>,
    },
    #[serde(rename = "status")]
    Status {
        clients_count: usize,
        timestamp: DateTime<Utc>,
    },
}

impl WebSocketMessage {
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<WebSocketState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| websocket(socket, state))
}

async fn websocket(stream: WebSocket, state: Arc<WebSocketState>) {
    // Split the socket into sender and receiver
    let (mut sender, mut receiver) = stream.split();

    // Increment client count
    {
        let mut count = state.clients_count.lock().await;
        *count += 1;
        tracing::info!("WebSocket client connected. Total clients: {}", *count);
    }

    // Clone the receiver for this client
    let mut rx = state.rx.clone();

    // Task to send messages to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(()) = rx.changed().await {
            let msg = rx.borrow().clone();
            let text = msg.to_text();

            if sender.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Task to receive messages from this client
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    tracing::debug!("Received message from client: {}", text);
                }
                Message::Close(_) => {
                    tracing::info!("Client requested close");
                    break;
                }
                _ => {}
            }
        }
    });

    // If any task exits, abort the other
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    // Decrement client count
    {
        let mut count = state.clients_count.lock().await;
        *count -= 1;
        tracing::info!("WebSocket client disconnected. Total clients: {}", *count);
    }
}
