//! Serves `Api::dispatch` over a WebSocket so Playwright can drive the real backend.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::{GbError, GbErrorKind};
use std::sync::Arc;

pub async fn serve(listener: tokio::net::TcpListener, api: Arc<Api>) {
    let app = Router::new().route("/health", get(|| async { "ok" })).route("/ws", get(ws)).with_state(api);
    axum::serve(listener, app).await.expect("harness server failed");
}

async fn ws(State(api): State<Arc<Api>>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle(socket, api))
}

async fn handle(mut socket: WebSocket, api: Arc<Api>) {
    while let Some(Ok(msg)) = socket.recv().await {
        let Message::Text(text) = msg else { continue };
        let reply = respond(&api, &text).await;
        if socket.send(Message::Text(reply.to_string().into())).await.is_err() {
            break;
        }
    }
}

/// Parses the envelope as a bare JSON value first so a malformed or unknown
/// `req` still carries back the caller's `id`, then decodes `req` into a
/// `Request`.
async fn respond(api: &Api, text: &str) -> serde_json::Value {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return error_reply(serde_json::Value::Null, format!("invalid message: {e}")),
    };
    let id = value.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let req = value.get("req").cloned().unwrap_or(serde_json::Value::Null);
    match serde_json::from_value::<Request>(req) {
        Ok(req) => match api.dispatch(req).await {
            Ok(v) => serde_json::json!({"id": id, "ok": v}),
            Err(e) => serde_json::json!({"id": id, "err": e}),
        },
        Err(e) => error_reply(id, format!("invalid request: {e}")),
    }
}

fn error_reply(id: serde_json::Value, message: String) -> serde_json::Value {
    let err = GbError::new(GbErrorKind::InvalidInput, message);
    serde_json::json!({"id": id, "err": err})
}
