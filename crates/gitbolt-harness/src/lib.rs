//! Serves `Api::dispatch` over a WebSocket so Playwright can drive the real backend.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::{GbError, GbErrorKind};
use std::sync::Arc;

pub async fn serve(listener: tokio::net::TcpListener, api: Arc<Api>) {
    let app = Router::new().route("/health", get(|| async { "ok" })).route("/ws", get(ws)).with_state(api);
    axum::serve(listener, app).await.expect("harness server failed");
}

async fn ws(State(api): State<Arc<Api>>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    // Browsers always send Origin on a WebSocket upgrade, so this stops any other web page from
    // driving the backend through the socket. Non-browser clients (the Rust tests) send none.
    if let Some(origin) = headers.get(header::ORIGIN)
        && !origin.to_str().is_ok_and(origin_allowed)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade.on_upgrade(move |socket| handle(socket, api)).into_response()
}

/// `http://localhost[:port]`, `http://127.0.0.1[:port]` (the Vite dev server and the harness
/// itself) or any `tauri://` origin.
fn origin_allowed(origin: &str) -> bool {
    if origin.starts_with("tauri://") {
        return true;
    }
    ["http://localhost", "http://127.0.0.1"].iter().any(|host| {
        origin.strip_prefix(host).is_some_and(|rest| {
            rest.is_empty() || rest.strip_prefix(':').is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        })
    })
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
