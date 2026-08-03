---
description: "Managing Helius webhooks for address monitoring — and what shredr actually uses instead."
icon: bell
---

# Helius webhooks

The backend exposes three endpoints wrapping the [Helius](https://www.helius.dev/) webhook API, letting you register addresses for transaction monitoring.

{% hint style="info" %}
**The frontend does not use these.** `WebSocketClient` connects directly to Helius over WebSocket and uses Solana's standard `accountSubscribe` RPC, which needs no server-side registration.

These endpoints are infrastructure for a webhook-based design that was built but not adopted. They work; nothing calls them.
{% endhint %}

## Setup

The Helius client is constructed at startup:

```rust
let helius_api_key = std::env::var("HELIUS_API_KEY").expect("HELIUS_API_KEY required");
let helius = Arc::new(
    Helius::new(&helius_api_key, Cluster::MainnetBeta).expect("Helius init failed")
);
```

{% hint style="warning" %}
Two things to note:

1. **`HELIUS_API_KEY` is mandatory.** The backend panics on startup without it, even though nothing calls the webhook endpoints.
2. **The cluster is hardcoded to `MainnetBeta`**, while the rest of shredr targets **devnet**. Any webhook created through these endpoints would monitor mainnet addresses.
{% endhint %}

## Endpoints

### Create a webhook

```
POST /webhook/create
Content-Type: application/json
```

```json
{
  "webhook_url": "https://your-domain.com/webhook/helius",
  "transaction_types": ["TRANSFER"],
  "account_addresses": ["BurnerAddress1..."],
  "webhook_type": "enhanced",
  "encoding": "jsonParsed",
  "txn_status": "all"
}
```

Fields map onto the `helius` crate's `CreateWebhookRequest`. `auth_header` is always `None`.

**`200 OK`** — `{ "message": "Webhook created: Some(\"<id>\")" }`

**`500`** — `{ "message": "Failed to create webhook: <error>" }`

Save the webhook ID — the address endpoints need it.

### Add addresses

```
POST /webhook/address
```

```json
{ "webhook_id": "...", "addresses": ["Address1...", "Address2..."] }
```

Calls `append_addresses_to_webhook`. **`200 OK`** — `{ "message": "Addresses added successfully" }`

### Remove addresses

```
DELETE /webhook/address
```

Same body. Calls `remove_addresses_from_webhook`. **`200 OK`** — `{ "message": "Addresses removed successfully" }`

Both routes are registered on the same path with different methods.

## The missing receiver

There is no endpoint to *receive* webhook callbacks. The handler exists in `webhook.rs` but is fully commented out:

```rust
// pub async fn helius_webhook_handler(
//     State(state): State<Arc<WebhookState>>,
//     Json(payload): Json<HeliusWebhookPayload>,
// ) -> impl IntoResponse {
//     let ws_message = WebSocketMessage::Transaction { data: payload.data, timestamp: ... };
//     match state.tx.send(ws_message) { ... }
// }
```

So is its route:

```rust
// .route("/webhook/helius", post(helius_webhook_handler))
```

The intended architecture was:

```
Solana ──▶ Helius ──▶ POST /webhook/helius ──▶ backend broadcast ──▶ /ws ──▶ browser
```

Which required the WebSocket module — also commented out in `main.rs`.

## What shredr does instead

```
Solana ──▶ Helius WSS ──accountSubscribe──▶ browser
```

The browser subscribes directly:

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "accountSubscribe",
  "params": ["<burner address>", { "encoding": "jsonParsed", "commitment": "confirmed" }]
}
```

→ [ApiClient and WebSocketClient](../frontend/api-and-websocket.md)

### Why direct subscription won

| | Direct `accountSubscribe` | Webhook + backend WS |
|---|---|---|
| Server-side registration | None | Required per address |
| Backend involvement | None | Receives and fans out |
| Backend learns your addresses | **No** | **Yes** |
| Moving parts | One connection | Helius + backend + WS |
| Works if the backend is down | **Yes** | No |

The privacy row is the decisive one. Registering burner addresses with the backend would tell the operator which addresses belong to one user — exactly what shredr's blob design goes out of its way to avoid.

→ [The privacy model](../concepts/privacy-model.md)

## If you want to re-enable it

{% stepper %}
{% step %}
### Uncomment the WebSocket module

`mod websocket;` in `main.rs`, plus its state construction and router merge.
{% endstep %}

{% step %}
### Uncomment the receiver

`helius_webhook_handler` in `webhook.rs` and its route in `webhook_routes.rs`. Restore the `tx: watch::Sender<WebSocketMessage>` field on `WebhookState`.
{% endstep %}

{% step %}
### Fix the cluster

Change `Cluster::MainnetBeta` to match your target network.
{% endstep %}

{% step %}
### Point the frontend at the backend

Change `WebSocketClient` to connect to `ws://your-backend/ws` instead of `HELIUS_WSS_URL`, and update the message handling — the backend broadcasts a different shape than raw `accountNotification`.
{% endstep %}

{% step %}
### Register addresses on rotation

Call `POST /webhook/address` whenever a burner rotates, and `DELETE` for retired ones.
{% endstep %}
{% endstepper %}

{% hint style="warning" %}
Understand the privacy cost first: the backend would learn which addresses a single user is watching, which lets it group burners by user. That is a meaningful weakening of the current design, not just a plumbing change.
{% endhint %}

## Rate limiting

Webhook endpoints get their own tier: burst 5, refill every 12 seconds, keyed by client IP.

## Next

* [API reference](api-reference.md)
* [Configuration and deployment](configuration.md)
