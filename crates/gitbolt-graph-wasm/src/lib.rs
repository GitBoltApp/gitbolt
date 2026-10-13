//! `gitbolt-graph` for the website demo, as WebAssembly (`just demo-wasm`): a store of commits and
//! the graph build, JSON in and out (`ui/src/demo/engine/graph.ts` wraps it). The functions under
//! `GraphEngine` are plain Rust, so they're tested natively.

use gitbolt_graph::{build, walk_order, CommitIn, CommitMeta, GraphRequest, Oid};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// Every commit the demo has read: commits never change, so they're added once.
#[derive(Default)]
pub struct Store {
    commits: HashMap<Oid, CommitMeta>,
}

impl Store {
    pub fn len(&self) -> usize {
        self.commits.len()
    }

    pub fn is_empty(&self) -> bool {
        self.commits.is_empty()
    }
}

/// Adds the commits in `json` (an array of `CommitIn`) the store doesn't hold yet: how many.
pub fn add_commits_json(store: &mut Store, json: &str) -> Result<u32, String> {
    let commits: Vec<CommitIn> = serde_json::from_str(json).map_err(|e| format!("bad commits: {e}"))?;
    let mut added = 0;
    for c in commits {
        if store.commits.contains_key(&c.id) {
            continue;
        }
        store.commits.insert(c.id, CommitMeta::from_message(c.id, c.parents, c.author_name, c.author_email, c.author_time, c.committer_time, &c.message));
        added += 1;
    }
    Ok(added)
}

/// The `GraphPayload` (JSON) of `json` (a `GraphRequest`) over the store's commits.
pub fn build_json(store: &Store, json: &str) -> Result<String, String> {
    let request: GraphRequest = serde_json::from_str(json).map_err(|e| format!("bad graph request: {e}"))?;
    let payload = build(&request, &store.commits)?;
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

/// `walk_order` (JSON: an array of ids) of `json` (a `GraphRequest`) over the store's commits.
pub fn walk_order_json(store: &Store, json: &str) -> Result<String, String> {
    let request: GraphRequest = serde_json::from_str(json).map_err(|e| format!("bad graph request: {e}"))?;
    serde_json::to_string(&walk_order(&request, &store.commits)).map_err(|e| e.to_string())
}

#[wasm_bindgen]
#[derive(Default)]
pub struct GraphEngine {
    store: Store,
}

#[wasm_bindgen]
impl GraphEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GraphEngine {
        GraphEngine::default()
    }

    #[wasm_bindgen(js_name = addCommits)]
    pub fn add_commits(&mut self, commits_json: &str) -> Result<u32, JsError> {
        add_commits_json(&mut self.store, commits_json).map_err(|e| JsError::new(&e))
    }

    pub fn build(&self, request_json: &str) -> Result<String, JsError> {
        build_json(&self.store, request_json).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = walkOrder)]
    pub fn walk_order(&self, request_json: &str) -> Result<String, JsError> {
        walk_order_json(&self.store, request_json).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.store.len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";

    fn commits() -> String {
        format!(
            r#"[{{"id":"{A}","parents":[],"authorName":"Mara Quill","authorEmail":"mara@example.com","authorTime":100,"committerTime":100,"message":"Root\n"}},
               {{"id":"{B}","parents":["{A}"],"authorName":"Mara Quill","authorEmail":"mara@example.com","authorTime":200,"committerTime":200,"message":"Second\n\nCloses #4\n"}}]"#
        )
    }

    fn request(limit: usize) -> String {
        format!(
            r#"{{"refs":{{"head":{{"branch":"refs/heads/main","target":"{B}","detached":false,"unborn":false}},
                 "refs":[{{"fullName":"refs/heads/main","shortName":"main","kind":{{"type":"local"}},"target":"{B}"}}]}},
                "worktrees":[{{"path":"/demo/x","canonical":"/demo/x","head":"{B}","branch":"refs/heads/main","isMain":true,"bare":false,"prunable":false,"locked":false}}],
                "wip":[[0,{{"modified":1}}]],"workdir":"/demo/x","limit":{limit}}}"#
        )
    }

    #[test]
    fn builds_the_payload_from_json() {
        let mut store = Store::default();
        assert_eq!(add_commits_json(&mut store, &commits()).unwrap(), 2);
        let out: serde_json::Value = serde_json::from_str(&build_json(&store, &request(10)).unwrap()).unwrap();
        assert_eq!(out["rows"][0]["id"], "wip:/demo/x");
        assert_eq!(out["rows"][1]["summary"], "Second");
        assert_eq!(out["rows"][1]["mrRefs"], serde_json::json!(["#4"]));
        assert_eq!(out["pinnedRefs"], serde_json::json!(["refs/heads/main"]));
        assert_eq!(out["truncated"], false);
    }

    #[test]
    fn a_commit_added_twice_counts_once() {
        let mut store = Store::default();
        add_commits_json(&mut store, &commits()).unwrap();
        assert_eq!(add_commits_json(&mut store, &commits()).unwrap(), 0);
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn bad_json_is_an_error_not_a_panic() {
        let mut store = Store::default();
        assert!(add_commits_json(&mut store, "[{").unwrap_err().starts_with("bad commits"));
        assert!(build_json(&store, r#"{"limit":"ten"}"#).unwrap_err().starts_with("bad graph request"));
    }

    #[test]
    fn walk_order_lists_the_collected_ids() {
        let mut store = Store::default();
        add_commits_json(&mut store, &commits()).unwrap();
        assert_eq!(walk_order_json(&store, &request(10)).unwrap(), format!(r#"["{B}","{A}"]"#));
    }
}
