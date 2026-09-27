//! The single command surface shared by the Tauri app and the test harness.

use crate::avatar::{AvatarPayload, AvatarProvider};
use crate::blob::{diff_contents, safe_join, working_tree_encoding, Side};
use crate::commit::{parse_commit, parse_oid, read_commit_message};
use crate::details::{commit_details, read_commit, remotes};
use crate::diff::{file_list, DiffSpec};
use crate::error::{GbError, GbErrorKind};
use crate::git::GitCli;
use crate::links::{validate_web_url, UrlOpener};
use crate::log::CommandLog;
use crate::payload::{BlobSource, RepoSummary, SignatureKind, SignaturePayload};
use crate::signature::signature_status;
use crate::snapshot::{build_graph, BuildOptions};
use crate::tree::tree_files;
use crate::worktree::list_worktrees;
use gix::ObjectId;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    /// The details panel's header: parents, author, committer, co-authors, signed (spec §9.1).
    CommitDetails { repo: u32, id: String },
    /// Every remote's parsed host and path, `origin` first (for forge links, spec §14.4).
    Remotes { repo: u32 },
    /// The changed-file list for a commit, a compare, a worktree diff or WIP (spec §9.3, §9.4, §8.6).
    FileList { repo: u32, spec: DiffSpec },
    /// Both sides of one file diff, decoded for the viewer (spec §10.2, §10.4).
    DiffContents { repo: u32, path: String, old: BlobSource, new: BlobSource, force: bool },
    /// Every file at a commit, sorted bytewise ("View all files", spec §9.3; the palette, §11.2).
    TreeFiles { repo: u32, id: String },
    /// The commit's signature status, verified through the user's own gpg/ssh config and cached
    /// per repository and commit id for the process lifetime (spec §9.1).
    Signature { repo: u32, id: String },
    /// A cached avatar for an email, or `null` (the UI shows initials; spec §14.3).
    Avatar { email: String },
    /// Opens an `http(s)` link in the default browser (spec §14.4); returns `null`.
    OpenUrl { url: String },
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
    /// Signature verdicts, keyed by (the repository's git directory, commit id), for the process
    /// lifetime (spec §9.1). Keyed on the repository too, not just the commit: the signature
    /// bytes never change, but git's verdict depends on the keyring, trust database and
    /// repo-local config (`gpg.ssh.allowedSignersFile`, `gpg.program`), which differ per
    /// repository. Only a definitive verdict is cached (verified, unverified, bad, expired):
    /// `unknownKey` means "couldn't verify with what's configured right now" (a missing key, or
    /// `gpg.ssh.allowedSignersFile` not set yet) and must be re-checked every time, since the
    /// user can fix their configuration between calls without the commit changing at all.
    signatures: Mutex<HashMap<(PathBuf, ObjectId), SignaturePayload>>,
    avatars: Option<Arc<dyn AvatarProvider>>,
    url_opener: Option<UrlOpener>,
}

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, GbError> {
    serde_json::to_value(v).map_err(|e| GbError::other(format!("serialize: {e}")))
}

/// Runs gix work on the blocking pool. A `gix::Repository` is `!Sync`, so it must never be held
/// across an `.await` in `dispatch` (whose future has to be `Send`).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, GbError> + Send + 'static) -> Result<T, GbError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| GbError::other(format!("task failed: {e}")))?
}

impl Api {
    pub fn new(cli: GitCli, launch_repo: Option<String>) -> Self {
        Self {
            cli,
            launch_repo: launch_repo.filter(|p| !p.is_empty()),
            repos: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            version_ok: OnceCell::new(),
            signatures: Mutex::new(HashMap::new()),
            avatars: None,
            url_opener: None,
        }
    }

    pub fn with_avatars(mut self, provider: Arc<dyn AvatarProvider>) -> Self {
        self.avatars = Some(provider);
        self
    }

    pub fn with_url_opener(mut self, opener: UrlOpener) -> Self {
        self.url_opener = Some(opener);
        self
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
                to_json(blocking(move || read_commit_message(&h.repo.to_thread_local(), &id)).await?)
            }
            Request::CommitDetails { repo, id } => {
                let h = self.handle(repo)?;
                let id = parse_oid(&id)?;
                to_json(blocking(move || commit_details(&h.repo.to_thread_local(), id)).await?)
            }
            Request::Remotes { repo } => {
                let h = self.handle(repo)?;
                to_json(remotes(&h.repo.to_thread_local()))
            }
            Request::FileList { repo, spec } => {
                let h = self.handle(repo)?;
                let wt = match &spec {
                    DiffSpec::Worktree { worktree, .. } | DiffSpec::Wip { worktree, .. } => Some(self.worktree_dir(&h, worktree).await?),
                    DiffSpec::Commit { .. } | DiffSpec::Compare { .. } => None,
                };
                to_json(file_list(&h.repo, &self.cli, &h.workdir, &spec, wt.as_deref()).await?)
            }
            Request::DiffContents { repo, path, old, new, force } => {
                let h = self.handle(repo)?;
                let old = self.resolve_side(&h, &path, old).await?;
                let new = self.resolve_side(&h, &path, new).await?;
                to_json(blocking(move || diff_contents(&h.repo.to_thread_local(), &path, &old, &new, force)).await?)
            }
            Request::TreeFiles { repo, id } => {
                let h = self.handle(repo)?;
                let id = parse_oid(&id)?;
                to_json(blocking(move || tree_files(&h.repo.to_thread_local(), id)).await?)
            }
            Request::Signature { repo, id } => {
                let h = self.handle(repo)?;
                let id = parse_oid(&id)?;
                let cache_key = (h.repo.git_dir().to_path_buf(), id);
                if let Some(s) = self.signatures.lock().expect("signatures poisoned").get(&cache_key).cloned() {
                    return to_json(s);
                }
                let signed = parse_commit(&read_commit(&h.repo.to_thread_local(), id)?)?.signed;
                let s = signature_status(&self.cli, &h.workdir, id, signed).await?;
                if s.kind != SignatureKind::UnknownKey {
                    self.signatures.lock().expect("signatures poisoned").insert(cache_key, s.clone());
                }
                to_json(s)
            }
            Request::Avatar { email } => match &self.avatars {
                Some(p) => to_json(p.avatar(&email).await?),
                None => to_json(Option::<AvatarPayload>::None),
            },
            Request::OpenUrl { url } => {
                validate_web_url(&url)?;
                let opener = self.url_opener.as_ref().ok_or_else(|| GbError::other("opening links isn't available here"))?;
                opener(&url)?;
                to_json(())
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

    /// The canonical path of `worktree`, if it's one of this repository's usable worktrees. Every
    /// request that reads a worktree goes through this, so a UI bug or a crafted request can't
    /// point GitBolt at an arbitrary directory.
    async fn worktree_dir(&self, h: &RepoHandle, worktree: &str) -> Result<PathBuf, GbError> {
        let invalid = || GbError::new(GbErrorKind::InvalidInput, format!("{worktree} is not a worktree of this repository"));
        let wanted = Path::new(worktree).canonicalize().map_err(|_| invalid())?;
        list_worktrees(&self.cli, &h.workdir)
            .await?
            .into_iter()
            .filter(|w| !w.bare && !w.prunable)
            .map(|w| w.path.canonicalize().unwrap_or(w.path))
            .find(|p| *p == wanted)
            .ok_or_else(invalid)
    }

    /// Validates a UI-supplied blob source: object ids must be full hex, and a worktree must be
    /// one of this repo's (plus its declared `working-tree-encoding` for `path`).
    async fn resolve_side(&self, h: &RepoHandle, path: &str, src: BlobSource) -> Result<Side, GbError> {
        Ok(match src {
            BlobSource::Absent => Side::Absent,
            BlobSource::Object { oid } => Side::Object(parse_oid(&oid)?),
            BlobSource::Submodule { oid } => Side::Submodule(parse_oid(&oid)?.to_string()),
            BlobSource::AtCommit { commit } => Side::AtCommit(parse_oid(&commit)?),
            BlobSource::Worktree { worktree } => {
                let root = self.worktree_dir(h, &worktree).await?;
                // Reject escaping paths before git sees them (`check-attr` would fail with a
                // generic error); `diff_contents` joins the path again when it reads the file.
                safe_join(&root, path)?;
                let encoding = working_tree_encoding(&self.cli, &root, path).await?;
                Side::Worktree { root, encoding }
            }
        })
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

    async fn open(api: &Api, r: &TestRepo) -> u64 {
        api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap()["id"].as_u64().unwrap()
    }

    #[tokio::test]
    async fn commit_details_and_remotes_dispatch() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let rename = r.git(&["rev-parse", "HEAD^1"]);
        let d = api.dispatch(req(serde_json::json!({"method": "commitDetails", "params": {"repo": id, "id": rename}}))).await.unwrap();
        assert_eq!(d["coAuthors"][0]["name"], "Margaret Hamilton");
        assert_eq!(d["committer"]["name"], "Ada Lovelace");
        assert!(d.get("summary").is_none() && d.get("body").is_none(), "the message itself comes from commitMessage");
        let bad = api.dispatch(req(serde_json::json!({"method": "commitDetails", "params": {"repo": id, "id": "HEAD"}}))).await.unwrap_err();
        assert_eq!(bad.kind, GbErrorKind::InvalidInput);
        let remotes = api.dispatch(req(serde_json::json!({"method": "remotes", "params": {"repo": id}}))).await.unwrap();
        assert_eq!(remotes[0]["hostKind"], "gitlab");
        assert_eq!(remotes[0]["path"], "group/project");
    }

    #[tokio::test]
    async fn file_list_dispatch_and_worktree_validation() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let list = api.dispatch(req(serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "commit", "id": head, "parent": 1}}}))).await.unwrap();
        assert_eq!(list["files"].as_array().unwrap().len(), 10);
        let wt = r.path().to_string_lossy().into_owned();
        let wip = api.dispatch(req(serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": wt, "staged": false}}}))).await.unwrap();
        assert_eq!(wip["files"][1]["new"]["kind"], "worktree");
        let elsewhere = tempfile::tempdir().unwrap();
        let err = api
            .dispatch(req(serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": elsewhere.path(), "staged": false}}})))
            .await
            .unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn diff_contents_dispatch_and_worktree_validation() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let old = r.git(&["rev-parse", "HEAD^1^1:crlf.txt"]);
        let new = r.git(&["rev-parse", "HEAD^1:crlf.txt"]);
        let c = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "crlf.txt", "old": {"kind": "object", "oid": old}, "new": {"kind": "object", "oid": new}, "force": false}})))
            .await
            .unwrap();
        assert_eq!(c["eolOnly"], true);
        assert_eq!(c["old"]["eol"], "crlf");
        let wt = r.path().to_string_lossy().into_owned();
        let w = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "notes.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}, "force": false}})))
            .await
            .unwrap();
        assert_eq!(w["new"]["text"], "untracked notes\n");
        let escape = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "../outside.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}, "force": false}})))
            .await
            .unwrap_err();
        assert_eq!(escape.kind, GbErrorKind::InvalidInput, "the path is checked before git sees it");
        let err = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "x", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": "/"}, "force": false}})))
            .await
            .unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn tree_files_and_signature_dispatch() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let files = api.dispatch(req(serde_json::json!({"method": "treeFiles", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(files.as_array().unwrap().len(), 12);
        let before = api.command_log().entries().len();
        let sig = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(sig["kind"], "unsigned");
        assert_eq!(api.command_log().entries().len(), before);
    }

    /// An `unknownKey` verdict (no allowed-signers file configured yet) must never be cached,
    /// since it only means "couldn't verify with what's configured right now"; a `verified`
    /// verdict, once git can actually check it, is definitive and is served from the cache.
    #[tokio::test]
    async fn signature_cache_never_holds_unknown_key_but_caches_a_verified_result() {
        if let Some(reason) = crate::testing::ssh_signing_unavailable() {
            eprintln!("{reason}; skipping");
            return;
        }
        let r = TestRepo::new();
        r.commit("base");
        r.git(&["config", "gpg.format", "ssh"]);
        let key = r.root().join("key");
        let out = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "trusted", "-f"]).arg(&key).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        r.git(&["config", "user.signingkey", key.to_str().unwrap()]);
        r.write("signed.txt", "signed\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-S", "-m", "signed"]);
        let head = r.git(&["rev-parse", "HEAD"]);

        let api = api();
        let id = open(&api, &r).await;

        let before = api.command_log().entries().len();
        let unknown = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(unknown["kind"], "unknownKey");
        let after_first = api.command_log().entries().len();
        assert!(after_first > before, "git ran to try to verify");

        // Queried again with nothing changed: still not cached, so git runs again.
        let unknown_again = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(unknown_again["kind"], "unknownKey");
        let after_second = api.command_log().entries().len();
        assert!(after_second > after_first, "an unknownKey verdict is never cached");

        // Now the user fixes their config; the very next call must re-verify rather than serve a
        // stale unknownKey from a cache, and this time it succeeds.
        let allowed = r.root().join("allowed_signers");
        std::fs::write(&allowed, format!("ada@example.com {}", std::fs::read_to_string(key.with_extension("pub")).unwrap())).unwrap();
        r.git(&["config", "gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()]);
        let verified = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(verified["kind"], "verified");
        let after_third = api.command_log().entries().len();
        assert!(after_third > after_second, "verified re-queries git; the prior unknownKey wasn't cached");

        // A definitive verdict, once reached, is cached: no further git invocation.
        let before_cached = api.command_log().entries().len();
        let cached = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(cached["kind"], "verified");
        assert_eq!(api.command_log().entries().len(), before_cached, "a verified verdict is served from the cache");
    }

    // Avatars and URL opening (plan 1B Task 5).
    struct FakeAvatars;
    impl crate::avatar::AvatarProvider for FakeAvatars {
        fn avatar<'a>(&'a self, email: &'a str) -> crate::avatar::AvatarFuture<'a> {
            Box::pin(async move { Ok((email == "ada@example.com").then(|| crate::avatar::AvatarPayload { mime: "image/png".into(), base64: "iVBO".into() })) })
        }
    }

    #[tokio::test]
    async fn avatars_come_from_the_injected_provider() {
        let plain = api();
        assert!(plain.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": "ada@example.com"}}))).await.unwrap().is_null());
        let with = api().with_avatars(Arc::new(FakeAvatars));
        let a = with.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": "ada@example.com"}}))).await.unwrap();
        assert_eq!(a["mime"], "image/png");
        assert!(with.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": "x@y"}}))).await.unwrap().is_null());
    }

    #[tokio::test]
    async fn open_url_accepts_web_links_only() {
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = opened.clone();
        let api = api().with_url_opener(Arc::new(move |u: &str| {
            sink.lock().unwrap().push(u.to_string());
            Ok(())
        }));
        api.dispatch(req(serde_json::json!({"method": "openUrl", "params": {"url": "https://gitlab.example.com/group/project/-/merge_requests/42"}}))).await.unwrap();
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "https://x y"] {
            let err = api.dispatch(req(serde_json::json!({"method": "openUrl", "params": {"url": bad}}))).await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad}");
        }
        assert_eq!(*opened.lock().unwrap(), vec!["https://gitlab.example.com/group/project/-/merge_requests/42"]);
        let none = super::Api::new(GitCli::new(Arc::new(CommandLog::new(10))), None);
        assert!(none.dispatch(req(serde_json::json!({"method": "openUrl", "params": {"url": "https://x"}}))).await.is_err(), "no opener configured");
    }
}
