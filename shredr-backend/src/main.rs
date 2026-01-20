mod db;
mod routes;
mod webhook;
mod websocket;

use std::sync::Arc;

use axum::{
    routing::{delete, get, post},
    Router,
};
use shuttle_axum::ShuttleAxum;
use tokio::sync::{watch, Mutex};
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use db::DbHandler;
use routes::AppState;
use webhook::WebhookState;
use websocket::{WebSocketMessage, WebSocketState};

#[shuttle_runtime::main]
async fn main() -> ShuttleAxum {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "shredr_backend=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting Shredr Backend...");

    // Initialize AWS S3 client
    let aws_config = aws_config::load_from_env().await;
    let s3_client = aws_sdk_s3::Client::new(&aws_config);

    // Get bucket name from environment or use default
    let bucket_name =
        std::env::var("S3_BUCKET_NAME").unwrap_or_else(|_| "shredr-blobs".to_string());

    tracing::info!("Using S3 bucket: {}", bucket_name);

    // Initialize database handler
    let db_handler = DbHandler::new(s3_client, bucket_name);

    // Create WebSocket broadcast channel
    let initial_message = WebSocketMessage::Status {
        clients_count: 0,
        timestamp: chrono::Utc::now(),
    };
    let (tx, rx) = watch::channel(initial_message);

    // Create application state for routes
    let app_state = Arc::new(AppState { db: db_handler });

    // Create WebSocket state
    let ws_state = Arc::new(WebSocketState {
        clients_count: Arc::new(Mutex::new(0)),
        rx,
    });

    // Create webhook state (shares the same tx channel)
    let webhook_state = Arc::new(WebhookState { tx });

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let router = Router::new()
        // Blob endpoints
        .route("/api/blob/upload", post(routes::upload_blob_handler))
        .route("/api/blob/:key", delete(routes::delete_blob_handler))
        .with_state(app_state)
        // WebSocket endpoint
        .route("/ws", get(websocket::websocket_handler))
        .with_state(ws_state)
        // Helius webhook endpoint
        .route("/webhook/helius", post(webhook::helius_webhook_handler))
        .with_state(webhook_state)
        // Health check
        .route("/health", get(health_check))
        .layer(cors);

    tracing::info!("Server configured successfully");
    tracing::info!("Endpoints:");
    tracing::info!("  POST   /api/blob/upload");
    tracing::info!("  DELETE /api/blob/:key");
    tracing::info!("  GET    /ws (WebSocket)");
    tracing::info!("  POST   /webhook/helius");
    tracing::info!("  GET    /health");

    Ok(router.into())
}

async fn health_check() -> &'static str {
    "OK"
}
