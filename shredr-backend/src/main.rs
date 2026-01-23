mod db;
mod webhook;
mod websocket;

use std::sync::Arc;
use std::time::Duration;
use axum::{http::Request, routing::get, Router};
use helius::{types::Cluster, Helius};
use shuttle_axum::ShuttleAxum;
use sqlx::PgPool;
use tokio::sync::{watch, Mutex};
use tower_governor::{
    governor::GovernorConfigBuilder,
    key_extractor::KeyExtractor,
    GovernorError, GovernorLayer,
};
use tower_http::cors::{Any, CorsLayer};

use db::{db_routes, AppState, DbHandler};
use webhook::{webhook_routes, WebhookState};
use websocket::{websocket_routes, WebSocketMessage, WebSocketState};

/// Custom key extractor that reads client IP from X-Forwarded-For header
#[derive(Clone, Debug)]
pub struct ForwardedIpKeyExtractor;

impl KeyExtractor for ForwardedIpKeyExtractor {
    type Key = String;

    fn extract<B>(&self, req: &Request<B>) -> Result<Self::Key, GovernorError> {
        let ip = req.headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim().to_string())
            .or_else(|| {
                req.headers()
                    .get("x-real-ip")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.trim().to_string())
            })
            .unwrap_or_else(|| "unknown".to_string());
        
        Ok(ip)
    }

}


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
    let general_config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(30)
            .burst_size(60)
            .key_extractor(ForwardedIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let db_config = Arc::new(
        GovernorConfigBuilder::default()
            .period(Duration::from_secs(10))
            .burst_size(5)
            .key_extractor(ForwardedIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let webhook_config = Arc::new(
        GovernorConfigBuilder::default()
            .period(Duration::from_secs(12))
            .burst_size(5)
            .key_extractor(ForwardedIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    // CORS - permissive for development
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let router = Router::new()
        .merge(db_routes::create_router(app_state.clone()).layer(GovernorLayer::new(db_config)))
        .merge(db_routes::read_router(app_state).layer(GovernorLayer::new(general_config)))
        .merge(webhook_routes::router(webhook_state).layer(GovernorLayer::new(webhook_config)))
        .merge(websocket_routes::router(ws_state))
        .route("/health", get(|| async { "OK" }))
        .layer(cors);

    tracing::info!("Server ready");
    Ok(router.into())
}