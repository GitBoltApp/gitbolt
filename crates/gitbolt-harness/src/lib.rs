//! Serves `Api::dispatch` over a WebSocket so Playwright can drive the real backend.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::openers::{ArgStyle, ExecArg, LaunchCommand, Opener, OpenerKind};
use std::sync::{Arc, Mutex};

/// The "Open in…" launches the harness recorded instead of running anything (tests never start
/// a real application). Served as JSON at `GET /launches`: `[{program, args}]`, oldest first.
#[derive(Default)]
pub struct Launches(Mutex<Vec<serde_json::Value>>);

impl Launches {
    pub fn record(&self, c: &LaunchCommand) {
        let args: Vec<String> = c.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        self.0.lock().expect("launches poisoned").push(serde_json::json!({"program": c.program.to_string_lossy(), "args": args}));
    }

    pub fn all(&self) -> Vec<serde_json::Value> {
        self.0.lock().expect("launches poisoned").clone()
    }
}

/// What `/launches` names "Other…" (the Open With chooser) by, in place of a program.
pub const CHOOSER_PROGRAM: &str = "open-with-chooser";

/// A fixed opener list (one of each style; the programs don't exist) plus "Other…", whose
/// launches `launches` records.
pub fn with_fake_openers(api: Api, launches: Arc<Launches>) -> Api {
    let chosen = launches.clone();
    api.with_chooser(Arc::new(move |file: &std::path::Path| {
        chosen.record(&LaunchCommand { program: CHOOSER_PROGRAM.into(), args: vec![file.into()] });
        Ok(())
    }))
    .with_openers(
        Arc::new(|| {
            vec![
                Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/bin/code", ArgStyle::VsCode),
                Opener::new("jetbrains-phpstorm", "PhpStorm", OpenerKind::Editor, "/fake/bin/phpstorm", ArgStyle::JetBrains),
                Opener::new("text-editor", "Text Editor", OpenerKind::Editor, "/fake/bin/gnome-text-editor", ArgStyle::Exec(vec![ExecArg::File])),
                Opener::new("file-manager", "Files", OpenerKind::FileManager, "/fake/bin/nautilus", ArgStyle::Exec(vec![ExecArg::Literal("--new-window".into()), ExecArg::File])),
            ]
        }),
        Arc::new(move |c: &LaunchCommand| {
            launches.record(c);
            Ok(())
        }),
    )
}

pub async fn serve(listener: tokio::net::TcpListener, api: Arc<Api>) {
    serve_with_launches(listener, api, Arc::default()).await;
}

pub async fn serve_with_launches(listener: tokio::net::TcpListener, api: Arc<Api>, launches: Arc<Launches>) {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/launches", get(move || async move { axum::Json(launches.all()) }))
        .route("/ws", get(ws))
        .with_state(api);
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
