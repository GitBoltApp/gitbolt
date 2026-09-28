use futures_util::{SinkExt, StreamExt};
use gitbolt_core::api::Api;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_core::testing::{fixtures, isolated_git_env, TestRepo};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn open_and_graph_over_websocket() {
    let r = TestRepo::new();
    fixtures::basic(&r);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let api = Arc::new(Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None));
    tokio::spawn(gitbolt_harness::serve(listener, api));

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    let send = serde_json::json!({"id": 1, "req": {"method": "openRepo", "params": {"path": r.path()}}});
    ws.send(Message::Text(send.to_string().into())).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["id"], 1);
    let repo_id = reply["ok"]["id"].clone();

    let send = serde_json::json!({"id": 2, "req": {"method": "graph", "params": {"repo": repo_id, "limit": null}}});
    ws.send(Message::Text(send.to_string().into())).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["ok"]["rows"].as_array().unwrap().len(), 10);

    let send = serde_json::json!({"id": 3, "req": {"method": "graph", "params": {"repo": 999, "limit": null}}});
    ws.send(Message::Text(send.to_string().into())).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["err"]["kind"], "InvalidInput");
}

async fn upgrade_status(origin: Option<&str>) -> u16 {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let api = Arc::new(Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None));
    tokio::spawn(gitbolt_harness::serve(listener, api));
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let api = Arc::new(Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None));
    tokio::spawn(gitbolt_harness::serve(listener, api));

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    let send = serde_json::json!({"id": 7, "req": {"method": "notAMethod"}});
    ws.send(Message::Text(send.to_string().into())).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["err"]["kind"], "InvalidInput");
}

#[tokio::test]
async fn commit_message_over_websocket() {
    let r = TestRepo::new();
    fixtures::long_labels(&r);
    let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let api = Arc::new(Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None));
    tokio::spawn(gitbolt_harness::serve(listener, api));

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    let send = serde_json::json!({"id": 1, "req": {"method": "openRepo", "params": {"path": r.path()}}});
    ws.send(Message::Text(send.to_string().into())).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    let repo_id = reply["ok"]["id"].clone();

    let send = serde_json::json!({"id": 2, "req": {"method": "commitMessage", "params": {"repo": repo_id, "id": root}}});
    ws.send(Message::Text(send.to_string().into())).await.unwrap();
    let reply: serde_json::Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(reply["id"], 2);
    assert_eq!(reply["ok"]["summary"], "Initial commit");
    assert_eq!(reply["ok"]["body"], "With a body line\n\nA second paragraph,\nwrapped over two lines.");
}

/// A raw HTTP/1.1 GET (the harness's plain routes), returning the body.
async fn http_get(addr: std::net::SocketAddr, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    out.split_once("\r\n\r\n").unwrap().1.to_string()
}

/// The harness lists fake openers and records "Open in…" launches instead of running anything;
/// e2e reads them back from `/launches`.
#[tokio::test]
async fn open_in_is_recorded_not_launched() {
    let r = TestRepo::new();
    fixtures::details(&r);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let launches = Arc::new(gitbolt_harness::Launches::default());
    let api = Arc::new(gitbolt_harness::with_fake_openers(Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None), launches.clone()));
    tokio::spawn(gitbolt_harness::serve_with_launches(listener, api, launches));

    assert_eq!(http_get(addr, "/launches").await, "[]");
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    let mut call = async |id: u32, req: serde_json::Value| {
        ws.send(Message::Text(serde_json::json!({"id": id, "req": req}).to_string().into())).await.unwrap();
        serde_json::from_str::<serde_json::Value>(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
    };
    let list = call(1, serde_json::json!({"method": "listOpeners"})).await;
    let ids: Vec<&str> = list["ok"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["vscode", "jetbrains-phpstorm", "text-editor", "file-manager", "other"]);
    let repo = call(2, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["ok"]["id"].clone();
    let wt = r.path().canonicalize().unwrap();
    let reply = call(3, serde_json::json!({"method": "openIn", "params": {"repo": repo, "worktree": wt, "path": "src/app.php", "line": 4, "opener": "vscode"}})).await;
    assert!(reply["ok"].is_null(), "{reply}");
    // "Other…" is recorded too, as the chooser it would have shown.
    let reply = call(4, serde_json::json!({"method": "openIn", "params": {"repo": repo, "worktree": wt, "path": "src/app.php", "line": 4, "opener": "other"}})).await;
    assert!(reply["ok"].is_null(), "{reply}");
    let file = wt.join("src/app.php").display().to_string();
    let got: serde_json::Value = serde_json::from_str(&http_get(addr, "/launches").await).unwrap();
    assert_eq!(got, serde_json::json!([
        {"program": "/fake/bin/code", "args": ["-g", format!("{file}:4")]},
        {"program": gitbolt_harness::CHOOSER_PROGRAM, "args": [file]},
    ]));
}
