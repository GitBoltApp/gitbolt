use futures_util::{SinkExt, StreamExt};
use gitbolt_core::api::Api;
use gitbolt_core::events::AppEvent;
use gitbolt_core::testing::{fixtures, TestRepo};
use gitbolt_harness::{serve, Harness, HarnessOptions};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> (SocketAddr, Arc<Api>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let harness = Harness::for_tests().await;
    let api = harness.api.clone();
    tokio::spawn(serve(listener, harness));
    (addr, api)
}

/// Nagle off, as a browser's WebSocket has it: otherwise a second small frame waits for the
/// first one's (delayed) ACK, up to 40 ms, and two requests can't be in flight together.
async fn connect(addr: SocketAddr) -> Ws {
    tokio_tungstenite::connect_async_with_config(format!("ws://{addr}/ws"), None, true).await.unwrap().0
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

async fn next_json(ws: &mut Ws) -> Value {
    serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
}

/// One request, one reply (no events are emitted in these tests, so the next frame is it).
async fn call(ws: &mut Ws, id: u32, req: Value) -> Value {
    send(ws, json!({"id": id, "req": req})).await;
    let reply = next_json(ws).await;
    assert_eq!(reply["id"], id, "{reply}");
    reply
}

#[tokio::test]
async fn open_and_graph_over_websocket() {
    let r = TestRepo::new();
    fixtures::basic(&r);
    let (addr, _) = start().await;
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"id": 1, "req": {"method": "openRepo", "params": {"path": r.path()}}})).await;
    let reply = next_json(&mut ws).await;
    assert_eq!(reply["id"], 1);
    let repo_id = reply["ok"]["id"].clone();
    send(&mut ws, json!({"id": 2, "req": {"method": "graph", "params": {"repo": repo_id, "limit": null}}})).await;
    let reply = next_json(&mut ws).await;
    assert_eq!(reply["ok"]["rows"].as_array().unwrap().len(), 10);
    send(&mut ws, json!({"id": 3, "req": {"method": "graph", "params": {"repo": 999, "limit": null}}})).await;
    let reply = next_json(&mut ws).await;
    assert_eq!(reply["err"]["kind"], "InvalidInput");
}

/// Requests run concurrently: a fast one sent after a slow one overtakes it, and each reply
/// carries its own id. (Handled one at a time, the graph would always answer first.)
#[tokio::test]
async fn a_fast_request_overtakes_a_slow_one() {
    let r = TestRepo::new();
    fixtures::long_history(&r);
    let (addr, _) = start().await;
    let mut ws = connect(addr).await;
    let repo = call(&mut ws, 1, json!({"method": "openRepo", "params": {"path": r.path()}})).await["ok"]["id"].clone();
    // The graph runs git (status, worktrees) and walks the history; launchRepo answers at once.
    send(&mut ws, json!({"id": 2, "req": {"method": "graph", "params": {"repo": repo, "limit": null}}})).await;
    send(&mut ws, json!({"id": 3, "req": {"method": "launchRepo"}})).await;
    let first = next_json(&mut ws).await;
    assert_eq!(first, json!({"id": 3, "ok": null}));
    let second = next_json(&mut ws).await;
    assert_eq!(second["id"], 2);
    assert_eq!(second["ok"]["rows"].as_array().unwrap().len(), 60, "{second}");
}

async fn upgrade_status(origin: Option<&str>) -> u16 {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let (addr, _) = start().await;
    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(req).await {
        Ok((_, resp)) => resp.status().as_u16(),
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => resp.status().as_u16(),
        Err(e) => panic!("unexpected connect error: {e}"),
    }
}

#[tokio::test]
async fn a_foreign_origin_is_refused() {
    // A web page on any other origin must not be able to drive the backend over the socket.
    for origin in ["http://evil.example", "http://localhost.evil.example:1420", "https://localhost:1420", "http://localhost:1420x", "null"] {
        assert_eq!(upgrade_status(Some(origin)).await, 403, "origin {origin}");
    }
}

#[tokio::test]
async fn local_and_tauri_origins_and_no_origin_are_allowed() {
    for origin in [None, Some("http://localhost:1420"), Some("http://127.0.0.1:7433"), Some("http://localhost"), Some("tauri://localhost")] {
        assert_eq!(upgrade_status(origin).await, 101, "origin {origin:?}");
    }
}

#[tokio::test]
async fn unknown_method_keeps_the_request_id() {
    let (addr, _) = start().await;
    let mut ws = connect(addr).await;
    send(&mut ws, json!({"id": 7, "req": {"method": "notAMethod"}})).await;
    let reply = next_json(&mut ws).await;
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["err"]["kind"], "InvalidInput");
}

#[tokio::test]
async fn commit_message_over_websocket() {
    let r = TestRepo::new();
    fixtures::long_labels(&r);
    let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let (addr, _) = start().await;
    let mut ws = connect(addr).await;
    let repo_id = call(&mut ws, 1, json!({"method": "openRepo", "params": {"path": r.path()}})).await["ok"]["id"].clone();
    let reply = call(&mut ws, 2, json!({"method": "commitMessage", "params": {"repo": repo_id, "id": root}})).await;
    assert_eq!(reply["ok"]["summary"], "Initial commit");
    assert_eq!(reply["ok"]["body"], "With a body line\n\nA second paragraph,\nwrapped over two lines.");
}

#[tokio::test]
async fn events_are_forwarded_over_websocket() {
    let (addr, api) = start().await;
    let mut ws = connect(addr).await;
    // One round trip first: the connection subscribes to the bus before it reads requests.
    send(&mut ws, json!({"id": 1, "req": {"method": "commandLog"}})).await;
    assert_eq!(next_json(&mut ws).await["id"], 1);
    api.events().emit(AppEvent::RefsUpdated { repo: 7 });
    assert_eq!(next_json(&mut ws).await, json!({"event": {"type": "refsUpdated", "repo": 7}}));
}

/// A raw HTTP/1.1 request to the harness's plain routes: the status code and the body.
async fn http(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let extra: String = headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
    let head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n", body.len());
    s.write_all(head.as_bytes()).await.unwrap();
    s.write_all(body.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or_else(|| panic!("{out}"));
    (status, out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

async fn http_get(addr: SocketAddr, path: &str) -> String {
    let (status, body) = http(addr, "GET", path, &[], "").await;
    assert_eq!(status, 200, "{body}");
    body
}

/// `POST /test/emit` puts a JSON `AppEvent` on the bus, so e2e can drive the UI's event paths.
#[tokio::test]
async fn test_emit_reaches_every_socket() {
    let (addr, _) = start().await;
    let mut a = connect(addr).await;
    let mut b = connect(addr).await;
    for ws in [&mut a, &mut b] {
        call(ws, 1, json!({"method": "commandLog"})).await;
    }
    let (status, _) = http(addr, "POST", "/test/emit", &[("Content-Type", "application/json")], r#"{"type":"refsUpdated","repo":2}"#).await;
    assert_eq!(status, 200);
    for ws in [&mut a, &mut b] {
        assert_eq!(next_json(ws).await, json!({"event": {"type": "refsUpdated", "repo": 2}}));
    }
}

/// The `/test/*` routes change state, so a web page on another origin can't call them either
/// (a no-body POST needs no CORS preflight). Playwright's request context sends no Origin.
#[tokio::test]
async fn test_routes_refuse_a_foreign_origin() {
    let (addr, _) = start().await;
    let json_ct = ("Content-Type", "application/json");
    let body = r#"{"type":"refsUpdated","repo":2}"#;
    let (status, _) = http(addr, "POST", "/test/emit", &[("Origin", "http://evil.example"), json_ct], body).await;
    assert_eq!(status, 403);
    let (status, _) = http(addr, "POST", "/test/emit", &[("Origin", "http://localhost:1420"), json_ct], body).await;
    assert_eq!(status, 200);
    let (status, _) = http(addr, "POST", "/test/reset", &[("Origin", "http://evil.example")], "").await;
    assert_eq!(status, 403);
    let (status, _) = http(addr, "POST", "/test/reset", &[("Origin", "http://localhost:1420")], "").await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn reset_restores_default_state() {
    let harness = Harness::for_tests().await;
    harness.store.create_profile("Extra", "#abc").unwrap();
    harness.reset();
    assert_eq!(harness.store.state().profiles.len(), 1);
}

/// Settings live in the harness's own directory (a temp one by default), never `~/.config`.
#[tokio::test]
async fn settings_go_to_the_config_dir() {
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness::new(HarnessOptions { config_dir: Some(dir.path().into()), ..Default::default() }).await;
    harness.store.create_profile("Work", "#abc").unwrap();
    harness.store.flush_now().unwrap();
    assert!(dir.path().join("settings.json").exists());
    assert_eq!(std::fs::read_dir(dir.path().join("profiles")).unwrap().count(), 2);
}

/// The harness lists fake openers and records "Open in…" launches instead of running anything;
/// e2e reads them back from `/launches`.
#[tokio::test]
async fn open_in_is_recorded_not_launched() {
    let r = TestRepo::new();
    fixtures::details(&r);
    let (addr, _) = start().await;

    assert_eq!(http_get(addr, "/launches").await, "[]");
    let mut ws = connect(addr).await;
    let list = call(&mut ws, 1, json!({"method": "listOpeners"})).await;
    let ids: Vec<&str> = list["ok"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["vscode", "jetbrains-phpstorm", "text-editor", "file-manager", "other"]);
    let repo = call(&mut ws, 2, json!({"method": "openRepo", "params": {"path": r.path()}})).await["ok"]["id"].clone();
    let wt = r.path().canonicalize().unwrap();
    let reply = call(&mut ws, 3, json!({"method": "openIn", "params": {"repo": repo, "worktree": wt, "path": "src/app.php", "line": 4, "opener": "vscode"}})).await;
    assert!(reply["ok"].is_null(), "{reply}");
    // "Other…" is recorded too, as the chooser it would have shown.
    let reply = call(&mut ws, 4, json!({"method": "openIn", "params": {"repo": repo, "worktree": wt, "path": "src/app.php", "line": 4, "opener": "other"}})).await;
    assert!(reply["ok"].is_null(), "{reply}");
    let file = wt.join("src/app.php").display().to_string();
    let got: Value = serde_json::from_str(&http_get(addr, "/launches").await).unwrap();
    assert_eq!(got, json!([
        {"program": "/fake/bin/code", "args": ["-g", format!("{file}:4")]},
        {"program": gitbolt_harness::CHOOSER_PROGRAM, "args": [file]},
    ]));
    // `/test/reset` forgets them, along with every setting and profile.
    let made = call(&mut ws, 5, json!({"method": "createProfile", "params": {"name": "Temp", "color": "#123"}})).await;
    assert!(made["ok"]["id"].is_string(), "{made}");
    let (status, _) = http(addr, "POST", "/test/reset", &[], "").await;
    assert_eq!(status, 200);
    assert_eq!(http_get(addr, "/launches").await, "[]");
    let st = call(&mut ws, 6, json!({"method": "loadState"})).await;
    assert_eq!(st["ok"]["profiles"].as_array().unwrap().len(), 1, "{st}");
}

/// `POST /test/next-pick` queues what the folder picker answers next (`null` = cancelled); with
/// nothing queued, it answers `null`. Reset forgets the queue.
#[tokio::test]
async fn folder_picks_come_from_the_queue() {
    let (addr, _) = start().await;
    let mut ws = connect(addr).await;
    let pick = json!({"method": "pickFolder", "params": {"start": null}});
    assert!(call(&mut ws, 1, pick.clone()).await["ok"].is_null(), "nothing queued");
    let json_ct = ("Content-Type", "application/json");
    for body in [r#"{"path":"/picked/one"}"#, r#"{"path":null}"#, r#"{"path":"/picked/two"}"#] {
        let (status, _) = http(addr, "POST", "/test/next-pick", &[json_ct], body).await;
        assert_eq!(status, 200);
    }
    assert_eq!(call(&mut ws, 2, pick.clone()).await["ok"], "/picked/one");
    assert!(call(&mut ws, 3, pick.clone()).await["ok"].is_null(), "a queued cancel");
    assert_eq!(call(&mut ws, 4, pick.clone()).await["ok"], "/picked/two");
    http(addr, "POST", "/test/next-pick", &[json_ct], r#"{"path":"/stale"}"#).await;
    http(addr, "POST", "/test/reset", &[], "").await;
    assert!(call(&mut ws, 5, pick).await["ok"].is_null(), "reset empties the queue");
    let (status, _) = http(addr, "POST", "/test/next-pick", &[("Origin", "http://evil.example"), json_ct], r#"{"path":"/x"}"#).await;
    assert_eq!(status, 403);
}

/// The harness has its own empty home (never the user's), and never fetches on its own: a fresh
/// or reset harness has background fetch off.
#[tokio::test]
async fn a_temp_home_and_background_fetch_off() {
    let harness = Harness::for_tests().await;
    assert_eq!(harness.store.state().settings.fetch_interval_secs, 0);
    let home = harness.home().to_path_buf();
    assert!(home.is_dir() && std::fs::read_dir(&home).unwrap().next().is_none(), "an empty home");
    assert_ne!(Some(home.clone()), gitbolt_core::paths::home_dir());
    let suggest = || serde_json::from_value(json!({"method": "suggestReposFolder"})).unwrap();
    assert!(harness.api.dispatch(suggest()).await.unwrap().is_null());
    std::fs::create_dir(home.join("repos")).unwrap();
    assert_eq!(harness.api.dispatch(suggest()).await.unwrap(), home.join("repos").display().to_string());
    let mut s = harness.store.state().settings;
    s.fetch_interval_secs = 60;
    harness.store.save_settings(s);
    harness.reset();
    assert_eq!(harness.store.state().settings.fetch_interval_secs, 0, "reset keeps fetch off");
}

/// `GET /test/watched` lists the repos with a live file watcher (e2e checks that only the
/// active tab's repo is watched); `/test/reset` stops them all.
#[tokio::test(flavor = "multi_thread")]
async fn watched_repos_are_listed_and_reset_unwatches_them() {
    let r = TestRepo::new();
    fixtures::basic(&r);
    let (addr, _) = start().await;
    let mut ws = connect(addr).await;
    let repo = call(&mut ws, 1, json!({"method": "openRepo", "params": {"path": r.path()}})).await["ok"]["id"].clone();
    assert_eq!(http_get(addr, "/test/watched").await, "[]");
    let reply = call(&mut ws, 2, json!({"method": "watchRepo", "params": {"repo": repo}})).await;
    assert!(reply["ok"].is_null(), "{reply}");
    assert_eq!(http_get(addr, "/test/watched").await, format!("[{repo}]"));
    let (status, _) = http(addr, "POST", "/test/reset", &[], "").await;
    assert_eq!(status, 200);
    assert_eq!(http_get(addr, "/test/watched").await, "[]");
    call(&mut ws, 3, json!({"method": "watchRepo", "params": {"repo": repo}})).await;
    call(&mut ws, 4, json!({"method": "unwatchRepo", "params": {"repo": repo}})).await;
    assert_eq!(http_get(addr, "/test/watched").await, "[]");
}
