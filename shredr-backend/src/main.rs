mod db;
mod routes;
mod webhook;
mod websocket;

use std::sync::Arc;
use std::time::Duration;

use axum::{
    routing::{delete, get, post},
    Router,
};
use helius::{Helius, types::Cluster};
use shuttle_axum::ShuttleAxum;
use sqlx::PgPool;
use tokio::sync::{watch, Mutex};
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::{db::DbHandler, routes::AppState, webhook::WebhookState, websocket::{WebSocketMessage, WebSocketState}};


#[shuttle_runtime::main]
async fn main(#[shuttle_runtime::Secrets] secrets: shuttle_runtime::SecretStore) -> ShuttleAxum {
    // Note: Shuttle automatically sets up tracing, don't initialize it again

    tracing::info!("Starting Shredr Backend...");

    // Get database URL from secrets or environment
    let database_url = secrets.get("DATABASE_URL").unwrap_or_else(|| {
        std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set in Secrets.toml or environment")
    });

    // Get Helius API key
    let helius_api_key = secrets.get("HELIUS_API_KEY").unwrap_or_else(|| {
        std::env::var("HELIUS_API_KEY")
            .expect("HELIUS_API_KEY must be set in Secrets.toml or environment")
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

    // Initialize Helius client
    let helius = Arc::new(
        Helius::new(&helius_api_key, Cluster::MainnetBeta).expect("Failed to create Helius client"),
    );

    // Create webhook state (shares the same tx channel)
    let webhook_state = Arc::new(WebhookState { tx, helius });

    // ============ RATE LIMITING ============
    // General rate limit: 30 requests per minute per IP
    let general_governor_conf = GovernorConfigBuilder::default()
        .per_second(2)
        .burst_size(30)
        .finish()
        .unwrap();

    // Stricter rate limit for blob creation: 10 per minute per IP
    let blob_create_governor_conf = GovernorConfigBuilder::default()
        .period(Duration::from_secs(60))
        .per_millisecond(6000) // ~10 per minute
        .burst_size(10)
        .finish()
        .unwrap();

    // Very strict rate limit for webhook endpoints: 5 per minute per IP
    let webhook_governor_conf = GovernorConfigBuilder::default()
        .period(Duration::from_secs(60))
        .per_millisecond(12000) // ~5 per minute
        .burst_size(5)
        .finish()
        .unwrap();

    let general_rate_limit = GovernorLayer::new(general_governor_conf);
    let blob_create_rate_limit = GovernorLayer::new(blob_create_governor_conf);
    let webhook_rate_limit = GovernorLayer::new(webhook_governor_conf);

    // ============ CORS CONFIGURATION ============
    // Restrict to shredr.fun in production, allow localhost for dev
    let allowed_origins = [
        "https://shredr.fun".parse().unwrap(),
        "https://www.shredr.fun".parse().unwrap(),
        "http://localhost:5173".parse().unwrap(),
        "http://localhost:3000".parse().unwrap(),
        "http://127.0.0.1:5173".parse().unwrap(),
    ];

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods(Any)
        .allow_headers(Any);

    // ============ ROUTER SETUP ============
    // Build router with API endpoints matching frontend expectations:
    //
    // Frontend API (from SKILL.md):
    //   fetchAllBlobs(): Promise<NonceBlob[]>  -> GET  /api/blobs
    //   createBlob(data): Promise<NonceBlob>   -> POST /api/blobs
    //   deleteBlob(id): Promise<boolean>       -> DELETE /api/blobs/:id
    //

    // Blob creation with stricter rate limit
    let blob_create_router = Router::new()
        .route("/api/blobs", post(routes::create_blob_handler))
        .with_state(app_state.clone())
        .layer(blob_create_rate_limit);

    // Other blob routes with general rate limit
    let blob_read_router = Router::new()
        .route("/api/blobs", get(routes::list_blobs_handler))
        .route("/api/blobs/{id}", get(routes::get_blob_handler))
        .route("/api/blobs/{id}", delete(routes::delete_blob_handler))
        .with_state(app_state)
        .layer(general_rate_limit.clone());

    // Webhook routes with strict rate limit
    let webhook_router = Router::new()
        .route("/webhook/helius", post(webhook::helius_webhook_handler))
        .route("/webhook/create", post(webhook::create_webhook_handler))
        .route(
            "/webhook/address",
            post(webhook::add_address_handler).delete(webhook::remove_address_handler),
        )
        .with_state(webhook_state)
        .layer(webhook_rate_limit);

    // WebSocket (no rate limit - connection-based)
    let ws_router = Router::new()
        .route("/ws", get(websocket::websocket_handler))
        .with_state(ws_state);

    // Combine all routers
    let router = Router::new()
        .merge(blob_create_router)
        .merge(blob_read_router)
        .merge(webhook_router)
        .merge(ws_router)
        .route("/health", get(health_check))
        .layer(cors);

    tracing::info!("Server configured successfully");
    tracing::info!("Rate limits:");
    tracing::info!("  General:      30 req/min per IP");
    tracing::info!("  Blob create:  10 req/min per IP");
    tracing::info!("  Webhooks:     5 req/min per IP");
    tracing::info!("Endpoints:");
    tracing::info!("  POST   /api/blobs       - Create blob");
    tracing::info!("  GET    /api/blobs       - List all blobs");
    tracing::info!("  GET    /api/blobs/:id   - Get blob by ID");
    tracing::info!("  DELETE /api/blobs/:id   - Delete blob by ID");
    tracing::info!("  GET    /ws              - WebSocket");
    tracing::info!("  POST   /webhook/helius  - Helius webhook callback");
    tracing::info!("  POST   /webhook/create  - Create Helius webhook");
    tracing::info!("  POST   /webhook/address - Add address to webhook");
    tracing::info!("  DELETE /webhook/address - Remove address from webhook");
    tracing::info!("  GET    /health          - Health check");

    Ok(router.into())
}

async fn health_check() -> &'static str {
    "OK"
}
