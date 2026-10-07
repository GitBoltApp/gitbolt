//! An autocrlf repository over the WebSocket, as the UI drives it: a CRLF worktree file whose
//! index copy is LF lists, diffs and stages as `git` sees it (one edited line), not as every line.

use futures_util::{SinkExt, StreamExt};
use gitbolt_core::testing::{fixtures, TestRepo};
use gitbolt_harness::{serve, Harness};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect() -> Ws {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(listener, Harness::for_tests().await));
    tokio_tungstenite::connect_async_with_config(format!("ws://{addr}/ws"), None, true).await.unwrap().0
}

/// One request's `ok`, skipping events.
async fn call(ws: &mut Ws, id: u32, method: &str, params: Value) -> Value {
    ws.send(Message::Text(json!({ "id": id, "req": { "method": method, "params": params } }).to_string().into())).await.unwrap();
    loop {
        let reply: Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        if reply.get("event").is_some() {
            continue;
        }
        assert_eq!(reply["id"], id, "{reply}");
        return reply.get("ok").cloned().unwrap_or_else(|| panic!("{method}: {reply}"));
    }
}

fn paths(list: &Value) -> Vec<&str> {
    list["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_autocrlf_file_lists_diffs_and_stages_as_its_one_edited_line() {
    let r = TestRepo::new();
    fixtures::wip_crlf(&r);
    r.mark_fixture();
    let wt = r.path().canonicalize().unwrap().display().to_string();
    let mut ws = connect().await;
    let repo = call(&mut ws, 1, "openRepo", json!({ "path": r.path() })).await["id"].clone();
    let unstaged = call(&mut ws, 2, "fileList", json!({ "repo": repo, "spec": { "kind": "wip", "worktree": wt, "staged": false } })).await;
    assert_eq!(paths(&unstaged), ["auto.txt", "raw.txt"], "same.txt differs by CRLF alone: git status doesn't list it");
    let row = unstaged["files"].as_array().unwrap().iter().find(|f| f["path"] == "auto.txt").unwrap().clone();
    assert_eq!((row["additions"].as_u64(), row["deletions"].as_u64()), (Some(1), Some(1)));

    // The sides the file list built, sent back unchanged (as the diff viewer does).
    let c = call(&mut ws, 3, "diffContents", json!({ "repo": repo, "path": "auto.txt", "old": row["old"], "new": row["new"], "force": false })).await;
    let (old, new) = (c["old"]["text"].as_str().unwrap(), c["new"]["text"].as_str().unwrap());
    let changed: Vec<(&str, &str)> = old.lines().zip(new.lines()).filter(|(a, b)| a != b).collect();
    assert_eq!(changed, [("line 05", "line 05 edited")]);
    assert_eq!((old.lines().count(), new.lines().count(), c["new"]["eol"].as_str()), (10, 10, Some("crlf")));

    let h = call(&mut ws, 4, "wipHunks", json!({ "repo": repo, "worktree": wt, "path": "auto.txt", "staged": false })).await;
    assert_eq!(h["hunks"].as_array().unwrap().len(), 1);
    assert_eq!((h["hunks"][0]["del"].clone(), h["hunks"][0]["add"].clone()), (json!([5]), json!([5])));
    call(&mut ws, 5, "stagePatch", json!({ "repo": repo, "worktree": wt, "path": "auto.txt", "staged": false, "selection": { "kind": "hunks", "hunks": [0] }, "base": h["base"] })).await;
    assert_eq!(r.git(&["show", ":auto.txt"]).lines().nth(4), Some("line 05 edited"));
    assert!(!r.git(&["show", ":auto.txt"]).contains('\r'), "staged clean, as `git add -p` would");
    let unstaged = call(&mut ws, 6, "fileList", json!({ "repo": repo, "spec": { "kind": "wip", "worktree": wt, "staged": false } })).await;
    assert_eq!(paths(&unstaged), ["raw.txt"], "nothing of auto.txt is left unstaged");
}
