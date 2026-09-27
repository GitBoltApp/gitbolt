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
