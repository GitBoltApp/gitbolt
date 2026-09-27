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
