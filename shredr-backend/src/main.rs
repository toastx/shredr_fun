mod db;
mod webhook;
mod websocket;

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use axum::{http::Request, routing::get, Router};
use helius::{types::Cluster, Helius};
use shuttle_axum::ShuttleAxum;
use sqlx::PgPool;
use tokio::sync::{watch, Mutex};
use tower_governor::{
    governor::GovernorConfigBuilder,
    key_extractor::{KeyExtractor, PeerIpKeyExtractor},
    GovernorError, GovernorLayer,
};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use db::{db_routes, AppState, DbHandler};
use webhook::{webhook_routes, WebhookState};
use websocket::{websocket_routes, WebSocketMessage, WebSocketState};

/// Custom key extractor that reads client IP from forwarding headers,
/// falling back to the default PeerIpKeyExtractor when none are present.
#[derive(Clone, Debug)]
pub struct ForwardedIpKeyExtractor {
    fallback: PeerIpKeyExtractor,
}

impl Default for ForwardedIpKeyExtractor {
    fn default() -> Self {
        Self {
            fallback: PeerIpKeyExtractor,
        }
    }
}

impl KeyExtractor for ForwardedIpKeyExtractor {
    type Key = IpAddr;

    fn extract<B>(&self, req: &Request<B>) -> Result<Self::Key, GovernorError> {
        // Try X-Forwarded-For / X-Real-IP first
        let forwarded_ip = req.headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim())
            .and_then(|s| s.parse::<IpAddr>().ok())
            .or_else(|| {
                req.headers()
                    .get("x-real-ip")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.trim())
                    .and_then(|s| s.parse::<IpAddr>().ok())
            });

        if let Some(ip) = forwarded_ip {
            return Ok(ip);
        }

        // Fallback to the default peer IP extractor (e.g., socket address)
        self.fallback.extract(req)
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
    let is_development = secrets.get("ENVIRONMENT").map(|e| e == "development").unwrap_or(true);

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
            .key_extractor(ForwardedIpKeyExtractor::default())
            .finish()
            .unwrap(),
    );
    let db_config = Arc::new(
        GovernorConfigBuilder::default()
            .period(Duration::from_secs(10))
            .burst_size(5)
            .key_extractor(ForwardedIpKeyExtractor::default())
            .finish()
            .unwrap(),
    );
    let webhook_config = Arc::new(
        GovernorConfigBuilder::default()
            .period(Duration::from_secs(12))
            .burst_size(5)
            .key_extractor(ForwardedIpKeyExtractor::default())
            .finish()
            .unwrap(),
    );

    // CORS - permissive for development, restricted for production
    let cors = if is_development {
        tracing::info!("CORS: Development mode - allowing any origin");
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        tracing::info!("CORS: Production mode - restricting origins");
        CorsLayer::new()
            .allow_origin(AllowOrigin::list([
                "https://shredr.fun".parse().unwrap(),
                "https://www.shredr.fun".parse().unwrap(),
            ]))
            .allow_methods(Any)
            .allow_headers(Any)
    };

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