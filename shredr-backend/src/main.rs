mod db;
mod webhook;
// mod websocket;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use axum::{http::Request, routing::get, Router};
use helius::{types::Cluster, Helius};
use sqlx::postgres::PgPoolOptions;
// use tokio::sync::{watch, Mutex};
use tower_governor::{
    governor::GovernorConfigBuilder,
    key_extractor::{KeyExtractor, PeerIpKeyExtractor},
    GovernorError, GovernorLayer,
};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use db::{db_routes, AppState, DbHandler};
use webhook::{webhook_routes, WebhookState};
// use websocket::{websocket_routes, WebSocketMessage, WebSocketState};

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

/// Build the PostgreSQL connection string from environment variables
fn build_database_url() -> String {
    let host = std::env::var("DATABASE_HOST").expect("DATABASE_HOST is required");
    let user = std::env::var("DATABASE_USER").expect("DATABASE_USER is required");
    let password = std::env::var("DATABASE_PASSWORD").expect("DATABASE_PASSWORD is required");
    let database = std::env::var("DATABASE_NAME").expect("DATABASE_NAME is required");
    
    // Default to SSL mode for production (Koyeb, etc.)
    format!(
        "postgres://{}:{}@{}/{}?sslmode=require",
        user, password, host, database
    )
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();
    
    tracing::info!("Starting Shredr Backend...");

    // Load environment variables from .env file
    dotenvy::dotenv().ok();

    // Config
    let helius_api_key = std::env::var("HELIUS_API_KEY").expect("HELIUS_API_KEY required");
    let is_development = std::env::var("ENVIRONMENT")
        .map(|e| e == "development")
        .unwrap_or(true);

    // Build database connection URL
    let database_url = build_database_url();
    tracing::info!("Connecting to database...");

    // Create PostgreSQL connection pool
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(30))
        .connect(&database_url)
        .await
        .expect("Failed to connect to database");

    tracing::info!("Database connection established");

    // Database handler
    let db_handler = DbHandler::new(pool);
    db_handler.init_schema().await.expect("Schema init failed");
    tracing::info!("Database ready");

    // State
    // let (tx, rx) = watch::channel(WebSocketMessage::Status {
    //     clients_count: 0,
    //     timestamp: chrono::Utc::now(),
    // });
    let app_state = Arc::new(AppState { db: db_handler });
    // let ws_state = Arc::new(WebSocketState { clients_count: Arc::new(Mutex::new(0)), rx });
    let helius = Arc::new(Helius::new(&helius_api_key, Cluster::MainnetBeta).expect("Helius init failed"));
    let webhook_state = Arc::new(WebhookState { helius });

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
        .merge(db_routes::write_router(app_state.clone()).layer(GovernorLayer::new(db_config)))
        .merge(db_routes::read_router(app_state).layer(GovernorLayer::new(general_config)))
        .merge(webhook_routes::router(webhook_state).layer(GovernorLayer::new(webhook_config)))
        // .merge(websocket_routes::router(ws_state))
        .route("/health", get(|| async { "OK" }))
        .layer(cors);

    // Get port from environment or default to 8000
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8000);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Server listening on http://{}", addr);

    // Start the server
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");

    axum::serve(listener, router)
        .await
        .expect("Server error");
}