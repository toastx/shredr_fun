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
use sqlx::PgPool;
use tokio::sync::{watch, Mutex};
use tower_http::cors::{Any, CorsLayer};

use db::DbHandler;
use routes::AppState;
use webhook::WebhookState;
use websocket::{WebSocketMessage, WebSocketState};

#[shuttle_runtime::main]
async fn main(#[shuttle_runtime::Secrets] secrets: shuttle_runtime::SecretStore) -> ShuttleAxum {
    // Note: Shuttle automatically sets up tracing, don't initialize it again
    
    tracing::info!("Starting Shredr Backend...");

    // Get database URL from secrets or environment
    let database_url = secrets.get("DATABASE_URL").unwrap_or_else(|| {
        std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set in Secrets.toml or environment")
    });

    // Create database connection pool
    let pool = PgPool::connect(&database_url)
        .await
        .expect("Failed to connect to database");

    tracing::info!("Connected to database");

    // Initialize database handler
    let db_handler = DbHandler::new(pool);

    // Initialize database schema
    if let Err(e) = db_handler.init_schema().await {
        tracing::error!("Failed to initialize database schema: {}", e);
        panic!("Database initialization failed");
    }

    tracing::info!("Database initialized successfully");

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

    // Build router with API endpoints matching frontend expectations:
    // 
    // Frontend API (from SKILL.md):
    //   fetchAllBlobs(): Promise<NonceBlob[]>  -> GET  /api/blobs
    //   createBlob(data): Promise<NonceBlob>   -> POST /api/blobs
    //   deleteBlob(id): Promise<boolean>       -> DELETE /api/blobs/:id
    //
    let router = Router::new()
        // Blob endpoints (matching NonceBlobAPI interface)
        .route("/api/blobs", post(routes::create_blob_handler))
        .route("/api/blobs", get(routes::list_blobs_handler))
        .route("/api/blobs/{id}", get(routes::get_blob_handler))
        .route("/api/blobs/{id}", delete(routes::delete_blob_handler))
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
    tracing::info!("  POST   /api/blobs       - Create blob");
    tracing::info!("  GET    /api/blobs       - List all blobs");
    tracing::info!("  GET    /api/blobs/:id   - Get blob by ID");
    tracing::info!("  DELETE /api/blobs/:id   - Delete blob by ID");
    tracing::info!("  GET    /ws              - WebSocket");
    tracing::info!("  POST   /webhook/helius  - Helius webhook");
    tracing::info!("  GET    /health          - Health check");

    Ok(router.into())
}

async fn health_check() -> &'static str {
    "OK"
}
