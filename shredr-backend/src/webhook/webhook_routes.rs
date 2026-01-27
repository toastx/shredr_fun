use axum::{routing::post, Router};
use std::sync::Arc;

use super::webhook::{
    add_address_handler, create_webhook_handler, remove_address_handler,
    WebhookState,
};

/// Build webhook router
pub fn router(state: Arc<WebhookState>) -> Router {
    Router::new()
        // .route("/webhook/helius", post(helius_webhook_handler))
        .route("/webhook/create", post(create_webhook_handler))
        .route(
            "/webhook/address",
            post(add_address_handler).delete(remove_address_handler),
        )
        .with_state(state)
}
