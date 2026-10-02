//! Shared helpers for 2B's write tests. Tasks 1, 5 and 6 each create this file with exactly this
//! content (plan 2B, W1), so their merges take one copy.

use crate::api::{Api, Request};
use crate::error::GbError;
use crate::git::GitCli;
use crate::log::CommandLog;
use crate::testing::{isolated_git_env, TestRepo};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

pub(crate) fn api(data: &Path) -> Api {
    Api::new(GitCli::new(Arc::new(CommandLog::new(500))).with_env(isolated_git_env()), None).with_data_dir(data.to_path_buf())
}

/// A repository with an identity and one commit of `a.txt` ("a\n").
pub(crate) fn repo() -> TestRepo {
    let r = TestRepo::new();
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
    r.write("a.txt", "a\n");
    r.git(&["add", "a.txt"]);
    r.git(&["commit", "-q", "-m", "one"]);
    r
}

pub(crate) async fn open(api: &Api, r: &TestRepo) -> u32 {
    open_at(api, r.path()).await
}

pub(crate) async fn open_at(api: &Api, dir: &Path) -> u32 {
    api.dispatch(Request::OpenRepo { path: dir.display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32
}

/// The worktree as requests name it (canonical).
pub(crate) fn wt(dir: &Path) -> String {
    dir.canonicalize().unwrap().display().to_string()
}

/// One request, written as the UI sends it, so the serde names are pinned too.
pub(crate) async fn call(api: &Api, method: &str, params: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(json!({ "method": method, "params": params })).unwrap_or_else(|e| panic!("{method}: {e}"));
    // Boxed, as `testing::write::send`: the dispatch future is the whole write pipeline.
    Box::pin(api.dispatch(req)).await
}

/// Undoes (`"undo"`) or redoes (`"redo"`) the worktree's newest journal entry.
pub(crate) async fn journal_step(api: &Api, id: u32, dir: &Path, method: &str) -> Result<Value, GbError> {
    let state = call(api, "journalState", json!({ "repo": id, "worktree": wt(dir) })).await?;
    let top = if method == "undo" { &state["undo"] } else { &state["redo"] };
    let entry = top["entry"].as_u64().unwrap_or_else(|| panic!("nothing to {method}: {state}"));
    call(api, method, json!({ "repo": id, "worktree": wt(dir), "entry": entry })).await
}

/// `git diff --cached` and `git diff`: the staged and unstaged halves of the worktree.
pub(crate) fn halves(r: &TestRepo) -> (String, String) {
    (r.git(&["diff", "--cached"]), r.git(&["diff"]))
}
