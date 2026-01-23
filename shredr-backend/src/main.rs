mod db;
mod webhook;
mod websocket;

use std::{sync::Arc, time::Duration};
use axum::{routing::get, Router};
use helius::{types::Cluster, Helius};
use shuttle_axum::ShuttleAxum;
use sqlx::PgPool;
use tokio::sync::{watch, Mutex};
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use db::{db_routes, AppState, DbHandler};
use webhook::{webhook_routes, WebhookState};
use websocket::{websocket_routes, WebSocketMessage, WebSocketState};

#[shuttle_runtime::main]
async fn main(
    #[shuttle_runtime::Secrets] secrets: shuttle_runtime::SecretStore,
    #[shuttle_shared_db::Postgres] pool: PgPool,
) -> ShuttleAxum {
    tracing::info!("Starting Shredr Backend...");

    // Config
    let helius_api_key = secrets.get("HELIUS_API_KEY").expect("HELIUS_API_KEY required");

    // Database (Shuttle-provisioned PostgreSQL)
    let db_handler = DbHandler::new(pool);
    db_handler.init_schema().await.expect("Schema init failed");
    tracing::info!("Database ready");

    // State
    let (tx, rx) = watch::channel(WebSocketMessage::Status {
        clients_count: 0,
        timestamp: chrono::Utc::now(),
    });
    let app_state = Arc::new(AppState { db: db_handler });
    let ws_state = Arc::new(WebSocketState { clients_count: Arc::new(Mutex::new(0)), rx });
    let helius = Arc::new(Helius::new(&helius_api_key, Cluster::MainnetBeta).expect("Helius init failed"));
    let webhook_state = Arc::new(WebhookState { tx, helius });

    // Rate limits
    let general_limit = GovernorLayer::new(
        GovernorConfigBuilder::default().per_second(2).burst_size(30).finish().unwrap()
    );
    let db_limit = GovernorLayer::new(
        GovernorConfigBuilder::default().period(Duration::from_secs(6)).burst_size(10).finish().unwrap()
    );
    let webhook_limit = GovernorLayer::new(
        GovernorConfigBuilder::default().period(Duration::from_secs(12)).burst_size(5).finish().unwrap()
    );

    // CORS
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "https://shredr.fun".parse().unwrap(),
            "https://www.shredr.fun".parse().unwrap(),
            "http://localhost:5173".parse().unwrap(),
            "http://localhost:3000".parse().unwrap(),
        ]))
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let router = Router::new()
        .merge(db_routes::create_router(app_state.clone()).layer(db_limit))
        .merge(db_routes::read_router(app_state).layer(general_limit))
        .merge(webhook_routes::router(webhook_state).layer(webhook_limit))
        .merge(websocket_routes::router(ws_state))
        .route("/health", get(|| async { "OK" }))
        .layer(cors);

    tracing::info!("Server ready");
    Ok(router.into())
}
