//! Helpers for the 2C write tests: an `Api` with a private data dir, a repository opened in it,
//! and a request sent the way the UI sends it (JSON, through `dispatch`), so every test also
//! checks the request's serde shape.

use super::{isolated_git_env, TestRepo};
use crate::api::{Api, Request};
use crate::error::GbError;
use crate::git::GitCli;
use crate::log::CommandLog;
use std::path::Path;
use std::sync::Arc;

pub struct WriteEnv {
    pub api: Api,
    data: tempfile::TempDir,
}

impl WriteEnv {
    pub fn new() -> Self {
        let data = tempfile::tempdir().expect("data dir");
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(500))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
        Self { api, data }
    }

    /// For tests that share the `Api` across tasks: keep the dir alive as long as the `Api`.
    pub fn into_parts(self) -> (Api, tempfile::TempDir) {
        (self.api, self.data)
    }
}

impl Default for WriteEnv {
    fn default() -> Self {
        Self::new()
    }
}

/// A committer identity in the repo's own config (the isolated env has none).
pub fn identity(r: &TestRepo) {
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
}

pub async fn open(api: &Api, r: &TestRepo) -> u32 {
    let v = api.dispatch(Request::OpenRepo { path: r.path().display().to_string() }).await.expect("open");
    v["id"].as_u64().expect("id") as u32
}

/// The canonical worktree path, as the backend spells it.
pub fn wt(r: &TestRepo) -> String {
    wt_at(r.path())
}

pub fn wt_at(p: &Path) -> String {
    p.canonicalize().expect("canonical").display().to_string()
}

/// One request as JSON (`{"method": …, "params": …}`).
pub async fn send(api: &Api, v: serde_json::Value) -> Result<serde_json::Value, GbError> {
    let req: Request = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"));
    // Boxed: the dispatch future holds the whole write pipeline, and a debug build builds it on
    // the test thread's stack before moving it; a test nesting a few sends overflowed 2 MiB.
    Box::pin(api.dispatch(req)).await
}
