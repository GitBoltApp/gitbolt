//! The single command surface shared by the Tauri app and the test harness.

use crate::error::{GbError, GbErrorKind};
use crate::git::GitCli;
use crate::log::CommandLog;
use crate::payload::RepoSummary;
use crate::snapshot::{build_graph, BuildOptions};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
#[ts(export)]
pub enum Request {
    OpenRepo { path: String },
    Graph { repo: u32, limit: Option<u32> },
    CommandLog,
    LaunchRepo,
    /// The full message of one commit (read-only, via gix): loaded lazily by the graph's
    /// full-message tooltip and the details panel, instead of shipping every body with the graph.
    CommitMessage { repo: u32, id: String },
}

struct RepoHandle {
    repo: gix::ThreadSafeRepository,
    workdir: PathBuf,
}

pub struct Api {
    cli: GitCli,
    launch_repo: Option<String>,
    repos: Mutex<HashMap<u32, Arc<RepoHandle>>>,
    next_id: AtomicU32,
    version_ok: OnceCell<()>,
}

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, GbError> {
    serde_json::to_value(v).map_err(|e| GbError::other(format!("serialize: {e}")))
}

impl Api {
    pub fn new(cli: GitCli, launch_repo: Option<String>) -> Self {
        Self { cli, launch_repo: launch_repo.filter(|p| !p.is_empty()), repos: Mutex::new(HashMap::new()), next_id: AtomicU32::new(1), version_ok: OnceCell::new() }
    }

    pub fn command_log(&self) -> &Arc<CommandLog> {
        self.cli.log()
    }

    pub async fn dispatch(&self, req: Request) -> Result<serde_json::Value, GbError> {
        match req {
            Request::OpenRepo { path } => to_json(self.open_repo(&path).await?),
            Request::Graph { repo, limit } => {
                let h = self.handle(repo)?;
                let opts = BuildOptions { limit: limit.map(|l| l as usize).unwrap_or(crate::snapshot::DEFAULT_COMMIT_LIMIT), ..Default::default() };
                to_json(build_graph(h.repo.clone(), h.workdir.clone(), self.cli.clone(), opts).await?)
            }
            Request::CommandLog => to_json(self.cli.log().entries()),
            Request::LaunchRepo => to_json(&self.launch_repo),
            Request::CommitMessage { repo, id } => {
                let h = self.handle(repo)?;
                let msg = tokio::task::spawn_blocking(move || crate::commit::read_commit_message(&h.repo.to_thread_local(), &id))
                    .await
                    .map_err(|e| GbError::other(format!("commit message task: {e}")))??;
                to_json(msg)
            }
        }
    }

    fn handle(&self, id: u32) -> Result<Arc<RepoHandle>, GbError> {
        self.repos
            .lock()
            .expect("repos poisoned")
            .get(&id)
            .cloned()
            .ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("no open repository with id {id}")))
    }

    async fn open_repo(&self, path: &str) -> Result<RepoSummary, GbError> {
        self.version_ok.get_or_try_init(|| async { self.cli.check_version().await.map(|_| ()) }).await?;
        let repo = gix::ThreadSafeRepository::discover(path)
            .map_err(|_| GbError::new(GbErrorKind::NotFound, format!("Not a git repository: {path}")))?;
        let workdir = repo
            .work_dir()
            .map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()))
            .ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Bare repositories are not supported"))?;
        let name = workdir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| workdir.display().to_string());
        let mut repos = self.repos.lock().expect("repos poisoned");
        if let Some((&id, _)) = repos.iter().find(|(_, h)| h.workdir == workdir) {
            return Ok(RepoSummary { id, path: workdir.display().to_string(), name });
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        repos.insert(id, Arc::new(RepoHandle { repo, workdir: workdir.clone() }));
        Ok(RepoSummary { id, path: workdir.display().to_string(), name })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};

    fn api() -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), Some("/launch/path".into()))
    }

    fn req(json: serde_json::Value) -> Request {
        serde_json::from_value(json).unwrap()
    }

    #[tokio::test]
    async fn open_then_graph() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let opened = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap();
        assert_eq!(opened["name"], "repo");
        let id = opened["id"].as_u64().unwrap();
        let sub = r.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let again = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": sub}}))).await.unwrap();
        assert_eq!(again["id"].as_u64().unwrap(), id, "same repo reuses its id");
        let graph = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert_eq!(graph["rows"].as_array().unwrap().len(), 10);
        assert_eq!(graph["rows"][0]["kind"], "stash");
    }

    #[tokio::test]
    async fn not_a_repo_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = api().dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": dir.path()}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
        assert!(err.message.starts_with("Not a git repository"));
    }

    #[tokio::test]
    async fn bare_repo_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(dir.path())
            .envs(isolated_git_env())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let err = api().dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": dir.path()}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn unknown_repo_id_is_invalid_input() {
        let err = api().dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": 99, "limit": null}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn launch_repo_and_command_log() {
        let api = api();
        assert_eq!(api.dispatch(req(serde_json::json!({"method": "launchRepo"}))).await.unwrap(), "/launch/path");
        assert!(api.dispatch(req(serde_json::json!({"method": "commandLog"}))).await.unwrap().is_array());
    }

    #[tokio::test]
    async fn commit_message_is_loaded_on_demand() {
        let r = TestRepo::new();
        fixtures::long_labels(&r);
        let api = api();
        let id = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap()["id"].as_u64().unwrap();
        let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
        let m = api.dispatch(req(serde_json::json!({"method": "commitMessage", "params": {"repo": id, "id": root}}))).await.unwrap();
        assert_eq!(m, serde_json::json!({"id": root, "summary": "Initial commit", "body": "With a body line\n\nA second paragraph,\nwrapped over two lines."}));
        let graph = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert!(graph["rows"][0].get("body").is_none(), "graph rows don't carry full bodies");
        let err = api.dispatch(req(serde_json::json!({"method": "commitMessage", "params": {"repo": id, "id": "1".repeat(40)}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
    }
}
