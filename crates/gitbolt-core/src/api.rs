//! The single command surface shared by the Tauri app and the test harness.

use crate::avatar::{AvatarPayload, AvatarProvider};
use crate::blob::{diff_contents, is_dotgit, safe_join, working_tree_encoding, Side};
use crate::commit::{parse_commit, parse_oid, read_commit_message};
use crate::details::{commit_details, read_commit, remotes};
use crate::diff::{file_list, DiffSpec};
use crate::error::{GbError, GbErrorKind};
use crate::git::GitCli;
use crate::links::{validate_web_url, UrlOpener};
use crate::log::CommandLog;
use crate::openers::chooser::Chooser;
use crate::openers::{Launcher, Opener, OpenerKind, OpenerPayload, CHOOSER_ID};
use crate::payload::{BlobSource, RepoSummary, SignatureKind, SignaturePayload};
use crate::signature::signature_status;
use crate::snapshot::{build_graph, BuildOptions};
use crate::tree::tree_files;
use crate::worktree::list_worktrees;
use gix::ObjectId;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
    /// The detected external editors and the file manager, for "Open in…" (spec §14.5, H9).
    ListOpeners,
    /// Opens `path` (relative to `worktree`, one of this repo's worktrees) in the opener `id`d by
    /// `opener` (or `"other"`, the Open With chooser), at `line` when it supports one. `source` is
    /// the version shown: the working-tree file (`worktree`, or none), or a stored one (`object`,
    /// `atCommit`), which opens as a read-only copy (spec §14.5). The file manager shows the
    /// working-tree folder (its nearest existing parent if it's gone). Returns `null`.
    OpenIn {
        repo: u32,
        worktree: String,
        path: String,
        line: Option<u32>,
        opener: String,
        #[serde(default)]
        source: Option<BlobSource>,
        /// A WIP file's stored version, opened (as a copy) when the working-tree file is gone.
        #[serde(default)]
        fallback: Option<BlobSource>,
    },
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
    openers: Option<Arc<OpenerSource>>,
    /// "Other…" (H32): the system's Open With chooser; listed only when set.
    chooser: Option<Chooser>,
    /// How long a detection answers `listOpeners` before the next one re-detects (the menu asks
    /// each time it opens, so a newly installed editor shows up without a restart).
    opener_refresh: Duration,
    /// Old versions' read-only copies (spec §14.5).
    open_cache: Option<PathBuf>,
}

/// "Open in…": how to find the openers and how to launch one (the app spawns; the harness and
/// tests record). `found` is the last successful detection and when it ran: a failed one (a
/// panic) is never cached, so the next call retries. The lock is held only to read or store it,
/// never while detecting; `refreshing` keeps one background re-detection at a time.
struct OpenerSource {
    detect: Arc<dyn Fn() -> Vec<Opener> + Send + Sync>,
    launcher: Launcher,
    found: Mutex<Option<(Instant, Arc<Vec<Opener>>)>>,
    refreshing: std::sync::atomic::AtomicBool,
}

impl OpenerSource {
    /// Detects now, on the blocking pool, and caches the result.
    async fn detect_now(&self) -> Result<Arc<Vec<Opener>>, GbError> {
        let detect = self.detect.clone();
        let list = Arc::new(tokio::task::spawn_blocking(move || detect()).await.map_err(|e| GbError::other(format!("couldn't look for editors: {e}")))?);
        *self.found.lock().expect("openers poisoned") = Some((Instant::now(), list.clone()));
        Ok(list)
    }
}

/// `opener_refresh` unless changed.
const OPENER_REFRESH: Duration = Duration::from_secs(30);

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
            openers: None,
            chooser: None,
            opener_refresh: OPENER_REFRESH,
            open_cache: None,
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

    pub fn with_openers(mut self, detect: Arc<dyn Fn() -> Vec<Opener> + Send + Sync>, launcher: Launcher) -> Self {
        self.openers = Some(Arc::new(OpenerSource { detect, launcher, found: Mutex::new(None), refreshing: std::sync::atomic::AtomicBool::new(false) }));
        self
    }

    pub fn with_chooser(mut self, chooser: Chooser) -> Self {
        self.chooser = Some(chooser);
        self
    }

    /// Where "Open in…" writes old versions (the app's `~/.cache/gitbolt/open`). Without one,
    /// only working-tree files can be opened.
    pub fn with_open_cache(mut self, dir: PathBuf) -> Self {
        self.open_cache = Some(dir);
        self
    }

    pub fn with_opener_refresh(mut self, every: Duration) -> Self {
        self.opener_refresh = every;
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
            Request::ListOpeners => {
                let mut list: Vec<OpenerPayload> = self.openers(false).await?.iter().map(Opener::payload).collect();
                if self.chooser.is_some() {
                    list.push(OpenerPayload { id: CHOOSER_ID.into(), name: "Other…".into(), kind: OpenerKind::Chooser });
                }
                to_json(list)
            }
            Request::OpenIn { repo, worktree, path, line, opener, source, fallback } => {
                let h = self.handle(repo)?;
                if line == Some(0) {
                    return Err(GbError::new(GbErrorKind::InvalidInput, "lines start at 1"));
                }
                let unavailable = || GbError::new(GbErrorKind::InvalidInput, "opening files isn't available here");
                if opener == CHOOSER_ID {
                    let chooser = self.chooser.clone().ok_or_else(unavailable)?;
                    let root = self.worktree_dir(&h, &worktree).await?;
                    let target = self.open_in_file(&h, &root, &path, source, fallback).await?;
                    blocking(move || chooser(&target)).await?;
                    return to_json(());
                }
                let launcher = self.openers.as_ref().ok_or_else(unavailable)?.launcher.clone();
                // An id the cached list doesn't have (installed since): detect again once.
                let find = |list: &[Opener]| list.iter().find(|o| o.id == opener).cloned();
                let o = match find(&self.openers(false).await?) {
                    Some(o) => o,
                    None => find(&self.openers(true).await?).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("no opener {opener:?} on this machine")))?,
                };
                let root = self.worktree_dir(&h, &worktree).await?;
                let target = match o.kind {
                    OpenerKind::FileManager => folder_target(&root, &path)?,
                    OpenerKind::Editor | OpenerKind::Chooser => self.open_in_file(&h, &root, &path, source, fallback).await?,
                };
                let cmd = o.command(&target, line);
                blocking(move || launcher(&cmd)).await?;
                to_json(())
            }
            Request::OpenUrl { url } => {
                validate_web_url(&url)?;
                let opener = self.url_opener.as_ref().ok_or_else(|| GbError::other("opening links isn't available here"))?;
                opener(&url)?;
                to_json(())
            }
        }
    }

    /// The detected openers. With a cached detection (and not `force`d), that one, at once; if
    /// it's `opener_refresh` old, a re-detection runs in the background (one at a time) for the
    /// next caller (fix round 2: nothing waits on it). Without one, or `force`d, a detection now.
    /// Detection runs on the blocking pool (it reads the disk and asks `xdg-mime`); one that
    /// panics is an error and isn't cached. Empty when none are configured.
    async fn openers(&self, force: bool) -> Result<Arc<Vec<Opener>>, GbError> {
        let Some(src) = self.openers.clone() else { return Ok(Arc::default()) };
        let cached = src.found.lock().expect("openers poisoned").clone();
        if let Some((at, list)) = cached.filter(|_| !force) {
            if at.elapsed() >= self.opener_refresh && !src.refreshing.swap(true, Ordering::SeqCst) {
                tokio::spawn(async move {
                    let _ = src.detect_now().await;
                    src.refreshing.store(false, Ordering::SeqCst);
                });
            }
            return Ok(list);
        }
        src.detect_now().await
    }

    /// The file an editor or the chooser opens for `path` in the worktree `root`: the working-tree
    /// file (`source` absent or a worktree), or a read-only copy of the stored version. A
    /// working-tree file that's gone (a WIP file staged, then deleted there) opens `fallback`,
    /// the version its list has, when there is one (fix round 2).
    async fn open_in_file(&self, h: &Arc<RepoHandle>, root: &Path, path: &str, source: Option<BlobSource>, fallback: Option<BlobSource>) -> Result<PathBuf, GbError> {
        match source {
            None | Some(BlobSource::Worktree { .. }) => match (worktree_file(root, path), fallback) {
                (Err(e), Some(stored @ (BlobSource::Object { .. } | BlobSource::AtCommit { .. }))) if e.kind == GbErrorKind::NotFound => self.stored_copy(h, path, stored).await,
                (found, _) => found,
            },
            Some(stored) => self.stored_copy(h, path, stored).await,
        }
    }

    /// A read-only copy of `path`'s stored version `source` (spec §14.5).
    async fn stored_copy(&self, h: &Arc<RepoHandle>, path: &str, source: BlobSource) -> Result<PathBuf, GbError> {
        let (side, oid) = match source {
            BlobSource::Worktree { .. } => return Err(GbError::new(GbErrorKind::InvalidInput, "not a stored version")),
            BlobSource::Object { oid } => {
                let oid = parse_oid(&oid)?;
                (Side::Object(oid), oid)
            }
            BlobSource::AtCommit { commit } => {
                let commit = parse_oid(&commit)?;
                (Side::AtCommit(commit), commit)
            }
            BlobSource::Absent | BlobSource::Submodule { .. } => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} has no file to open on that side"))),
        };
        crate::blob::check_relative(path)?;
        let cache = self.open_cache.clone().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "old versions can't be opened here"))?;
        let (h, path) = (h.clone(), path.to_string());
        blocking(move || {
            let bytes = crate::blob::side_bytes(&h.repo.to_thread_local(), &path, &side, crate::diff::MAX_FORCED_BYTES)?;
            crate::open_copy::write_copy(&cache, &oid.to_hex_with_len(12).to_string(), &path, &bytes)
        })
        .await
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

/// The file "Open in…" hands an editor or the chooser: the working-tree file for a worktree
/// source (or none), which must exist and resolve inside the worktree, outside `.git` (a
/// committed symlink to `.git/config`, or out of the worktree entirely, is refused); for a stored
/// version, a read-only copy of its bytes (spec §14.5, `open_copy`). `safe_join` / `check_relative`
/// reject escaping, absolute and `.git` paths first, but only up to the leaf: `path`'s own last
/// component may be a symlink (that's what `safe_join` hands its other callers), so it's resolved
/// here and checked again — a symlinked leaf can point through `.git` even when no path segment
/// before it does.
fn worktree_file(root: &Path, path: &str) -> Result<PathBuf, GbError> {
    let escaped = || GbError::new(GbErrorKind::InvalidInput, format!("{path} points outside the worktree"));
    let joined = safe_join(root, path)?;
    let real = joined.canonicalize().map_err(|_| GbError::new(GbErrorKind::NotFound, format!("{path} isn't in the working tree")))?;
    let inside = real.strip_prefix(root).map_err(|_| escaped())?;
    if !inside.components().all(|c| matches!(c, Component::Normal(n) if !is_dotgit(&n.to_string_lossy()))) {
        return Err(escaped());
    }
    Ok(joined)
}

/// The file manager's folder: the file's working-tree folder, or its nearest existing parent
/// inside the worktree when it's gone (a deleted file's folder, a file at an old commit).
fn folder_target(root: &Path, path: &str) -> Result<PathBuf, GbError> {
    crate::blob::check_relative(path)?;
    let mut dir = root.join(path);
    while dir.pop() && dir.starts_with(root) {
        if let Ok(real) = dir.canonicalize()
            && real.is_dir()
            && real.starts_with(root)
        {
            return Ok(real);
        }
    }
    Ok(root.to_path_buf())
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
        let plain = super::tests::api();
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

    // "Open in…" (feedback H9).
    type Launches = Arc<Mutex<Vec<crate::openers::LaunchCommand>>>;

    fn with_openers(api: Api) -> (Api, Launches) {
        use crate::openers::ArgStyle;
        let launches: Launches = Arc::default();
        let sink = launches.clone();
        let api = api.with_openers(
            Arc::new(|| vec![
                Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", ArgStyle::VsCode),
                Opener::new("jetbrains-phpstorm", "PhpStorm", OpenerKind::Editor, "/fake/phpstorm", ArgStyle::JetBrains),
                Opener::new("file-manager", "Files", OpenerKind::FileManager, "/fake/nautilus", ArgStyle::Exec(vec![crate::openers::ExecArg::File])),
            ]),
            Arc::new(move |c: &crate::openers::LaunchCommand| {
                sink.lock().unwrap().push(c.clone());
                Ok(())
            }),
        );
        (api, launches)
    }

    fn argv(c: &crate::openers::LaunchCommand) -> Vec<String> {
        std::iter::once(c.program.to_string_lossy().into_owned()).chain(c.args.iter().map(|a| a.to_string_lossy().into_owned())).collect()
    }

    #[tokio::test]
    async fn list_openers_returns_the_detected_ones_and_none_without_detection() {
        assert_eq!(api().dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap(), serde_json::json!([]));
        let (api, _) = with_openers(api());
        let list = api.dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap();
        assert_eq!(list, serde_json::json!([
            {"id": "vscode", "name": "VS Code", "kind": "editor"},
            {"id": "jetbrains-phpstorm", "name": "PhpStorm", "kind": "editor"},
            {"id": "file-manager", "name": "Files", "kind": "fileManager"},
        ]));
    }

    #[tokio::test]
    async fn open_in_launches_the_opener_on_the_worktree_file() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (api, launches) = with_openers(api());
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let file = wt.join("src/app.php");
        let open_in = |path: &str, line: Option<u32>, opener: &str| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": line, "opener": opener}}));
        assert!(api.dispatch(open_in("src/app.php", Some(12), "vscode")).await.unwrap().is_null());
        api.dispatch(open_in("src/app.php", Some(3), "jetbrains-phpstorm")).await.unwrap();
        api.dispatch(open_in("src/app.php", None, "jetbrains-phpstorm")).await.unwrap();
        api.dispatch(open_in("src/app.php", Some(3), "file-manager")).await.unwrap();
        let got: Vec<Vec<String>> = launches.lock().unwrap().iter().map(argv).collect();
        let f = file.to_string_lossy().into_owned();
        assert_eq!(got, [
            vec!["/fake/code".to_string(), "-g".into(), format!("{f}:12")],
            vec!["/fake/phpstorm".into(), "--line".into(), "3".into(), f.clone()],
            vec!["/fake/phpstorm".into(), f.clone()],
            vec!["/fake/nautilus".into(), wt.join("src").to_string_lossy().into_owned()],
        ]);
    }

    #[tokio::test]
    async fn open_in_rejects_unknown_openers_escaping_paths_foreign_worktrees_and_missing_files() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), r.path().join("link.txt")).unwrap();
        // Rust triage #1: a committed symlink whose target is inside .git resolves, through
        // canonicalize, to a real path that still starts with the worktree root (.git lives
        // under it) — so the leaf must be checked for a .git component too, not just the dirs
        // safe_join already covers (a symlinked *directory*, `x -> .git`, tested elsewhere).
        std::os::unix::fs::symlink(".git/config", r.path().join("gitlink.txt")).unwrap();
        let (api, launches) = with_openers(api());
        let id = open(&api, &r).await;
        let wt = r.path().to_string_lossy().into_owned();
        let open_in = |worktree: &str, path: &str, line: Option<u32>, opener: &str| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": worktree, "path": path, "line": line, "opener": opener}}));
        let cases = [
            (open_in(&wt, "src/app.php", None, "/usr/bin/xterm"), GbErrorKind::InvalidInput, "an opener is an id, never a program"),
            (open_in(&wt, "src/app.php", None, "sublime"), GbErrorKind::InvalidInput, "not detected"),
            (open_in(&wt, "../outside.txt", None, "vscode"), GbErrorKind::InvalidInput, "escapes the worktree"),
            (open_in(&wt, "/etc/passwd", None, "vscode"), GbErrorKind::InvalidInput, "absolute"),
            (open_in(&wt, ".git/config", None, "vscode"), GbErrorKind::InvalidInput, "inside .git"),
            (open_in(&wt, "link.txt", None, "vscode"), GbErrorKind::InvalidInput, "a symlink out of the worktree"),
            (open_in(&wt, "gitlink.txt", None, "vscode"), GbErrorKind::InvalidInput, "a symlink into .git"),
            (open_in(&outside.path().to_string_lossy(), "secret.txt", None, "vscode"), GbErrorKind::InvalidInput, "not a worktree of this repo"),
            (open_in(&wt, "gone.txt", None, "vscode"), GbErrorKind::NotFound, "not in the working tree"),
            (open_in(&wt, "src/app.php", Some(0), "vscode"), GbErrorKind::InvalidInput, "lines start at 1"),
        ];
        for (request, kind, why) in cases {
            let err = api.dispatch(request).await.unwrap_err();
            assert_eq!(err.kind, kind, "{why}: {}", err.message);
        }
        assert!(launches.lock().unwrap().is_empty(), "nothing was launched");
        let plain = super::tests::api();
        let pid = open(&plain, &r).await;
        let none = plain.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": pid, "worktree": wt, "path": "src/app.php", "line": null, "opener": "vscode"}}))).await.unwrap_err();
        assert_eq!(none.kind, GbErrorKind::InvalidInput);
    }

    // Old versions (spec §14.5, fix round 1).
    fn launched_file(launches: &Launches) -> PathBuf {
        PathBuf::from(launches.lock().unwrap().last().unwrap().args.last().unwrap())
    }

    #[tokio::test]
    async fn a_file_at_an_old_commit_opens_as_a_read_only_copy_at_the_line() {
        use std::os::unix::fs::PermissionsExt;
        let r = TestRepo::new();
        fixtures::details(&r);
        let cache = tempfile::tempdir().unwrap();
        let (api, launches) = with_openers(api().with_open_cache(cache.path().to_path_buf()));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let open_in = |path: &str, line: Option<u32>, opener: &str, source: serde_json::Value| {
            req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": line, "opener": opener, "source": source}}))
        };
        // A blob (the file list's side): its bytes, under <cache>/<short oid>/<path>, 0444.
        let old = r.git(&["rev-parse", "HEAD^1^1:src/app.php"]);
        api.dispatch(open_in("src/app.php", Some(7), "jetbrains-phpstorm", serde_json::json!({"kind": "object", "oid": old}))).await.unwrap();
        let copy = launched_file(&launches);
        assert_eq!(copy, cache.path().canonicalize().unwrap().join(&old[..12]).join("src/app.php"));
        assert_eq!(std::fs::read_to_string(&copy).unwrap().trim_end(), r.git(&["show", "HEAD^1^1:src/app.php"]).trim_end());
        assert_eq!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o444);
        assert_eq!(launches.lock().unwrap().last().unwrap().args[..2], [std::ffi::OsString::from("--line"), std::ffi::OsString::from("7")], "the line is the shown version's");
        // The file at a commit (View all files).
        let head = r.git(&["rev-parse", "HEAD"]);
        api.dispatch(open_in("latin1.txt", None, "vscode", serde_json::json!({"kind": "atCommit", "commit": head}))).await.unwrap();
        assert_eq!(std::fs::read(launched_file(&launches)).unwrap(), b"caf\xe9 cr\xe8me br\xfbl\xe9e\n");
        // A deleted file opens its old blob (the UI sends the old side).
        let deleted = r.git(&["rev-parse", "HEAD^1^1:old.txt"]);
        api.dispatch(open_in("old.txt", None, "vscode", serde_json::json!({"kind": "object", "oid": deleted}))).await.unwrap();
        assert_eq!(std::fs::read_to_string(launched_file(&launches)).unwrap(), "to be deleted\n");
        // The worktree side (and no side) opens the working-tree file itself.
        api.dispatch(open_in("src/app.php", None, "vscode", serde_json::json!({"kind": "worktree", "worktree": wt}))).await.unwrap();
        assert_eq!(launched_file(&launches), wt.join("src/app.php"));
        // Refused: an escaping path (nothing is written), an absent or submodule side.
        let before = launches.lock().unwrap().len();
        for (path, source) in [("../x.txt", serde_json::json!({"kind": "object", "oid": old})), ("src/app.php", serde_json::json!({"kind": "absent"})), ("src/app.php", serde_json::json!({"kind": "submodule", "oid": old}))] {
            assert_eq!(api.dispatch(open_in(path, None, "vscode", source)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "{path}");
        }
        assert_eq!(launches.lock().unwrap().len(), before);
        assert!(!cache.path().join("x.txt").exists());
        // Without a cache directory, an old version can't be opened.
        let (plain, _) = with_openers(super::tests::api());
        let pid = open(&plain, &r).await;
        let err = plain.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": pid, "worktree": wt, "path": "src/app.php", "line": null, "opener": "vscode", "source": {"kind": "object", "oid": old}}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn the_file_manager_shows_the_working_tree_folder_or_its_nearest_existing_parent() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let cache = tempfile::tempdir().unwrap();
        let (api, launches) = with_openers(api().with_open_cache(cache.path().to_path_buf()));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let old = r.git(&["rev-parse", "HEAD^1^1:src/app.php"]);
        for (path, source, want) in [
            ("src/app.php", serde_json::json!({"kind": "object", "oid": old}), wt.join("src")),
            ("src/gone/deeper/x.php", serde_json::json!({"kind": "object", "oid": old}), wt.join("src")),
            ("gone/x.txt", serde_json::Value::Null, wt.clone()),
        ] {
            api.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": null, "opener": "file-manager", "source": source}}))).await.unwrap();
            assert_eq!(launched_file(&launches), want, "{path}");
        }
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0, "the file manager never makes a copy");
    }

    // "Other…" and detection refresh (feedback H32).
    #[tokio::test]
    async fn other_is_listed_last_and_hands_the_checked_file_to_the_chooser() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let chosen: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let sink = chosen.clone();
        let (api, launches) = with_openers(api());
        let api = api.with_chooser(Arc::new(move |p: &Path| {
            sink.lock().unwrap().push(p.to_path_buf());
            Ok(())
        }));
        let list = api.dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap();
        assert_eq!(list.as_array().unwrap().last().unwrap(), &serde_json::json!({"id": "other", "name": "Other…", "kind": "chooser"}));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let other = |path: &str| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": 3, "opener": "other"}}));
        api.dispatch(other("src/app.php")).await.unwrap();
        assert_eq!(*chosen.lock().unwrap(), [wt.join("src/app.php")]);
        assert_eq!(api.dispatch(other("../x")).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(api.dispatch(other("gone.txt")).await.unwrap_err().kind, GbErrorKind::NotFound);
        assert_eq!(chosen.lock().unwrap().len(), 1);
        assert!(launches.lock().unwrap().is_empty(), "the chooser isn't a launch");
        // Without a chooser there's no "Other…".
        let (plain, _) = with_openers(super::tests::api());
        let ids = plain.dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap();
        assert!(ids.as_array().unwrap().iter().all(|o| o["id"] != "other"));
    }

    fn counting_detect(calls: Arc<std::sync::atomic::AtomicUsize>) -> Arc<dyn Fn() -> Vec<Opener> + Send + Sync> {
        use crate::openers::ArgStyle;
        Arc::new(move || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            let mut v = vec![Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", ArgStyle::VsCode)];
            if n > 0 {
                v.push(Opener::new("zed", "Zed", OpenerKind::Editor, "/fake/zed", ArgStyle::PathColonLine));
            }
            v
        })
    }

    #[tokio::test]
    async fn detection_is_cached_briefly_and_redone_for_an_opener_it_hasnt_seen() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let api = api().with_openers(counting_detect(calls.clone()), Arc::new(|_: &crate::openers::LaunchCommand| Ok(())));
        let list = || req(serde_json::json!({"method": "listOpeners"}));
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 1);
        api.dispatch(list()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "cached within the refresh interval");
        // Zed was installed since: opening in it re-detects instead of refusing.
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        api.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": null, "opener": "zed"}}))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // Past the interval, a listing answers from the cache at once and re-detects behind it
        // (fix round 2): the next listing has the new result.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let api = super::tests::api().with_openers(counting_detect(calls.clone()), Arc::new(|_: &crate::openers::LaunchCommand| Ok(()))).with_opener_refresh(std::time::Duration::ZERO);
        api.dispatch(list()).await.unwrap();
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 1, "the stale list, at once");
        wait_until(|| calls.load(Ordering::SeqCst) == 2).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 2);
    }

    async fn wait_until(done: impl Fn() -> bool) {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Fix round 2: a slow re-detection never holds up a listing or an open.
    #[tokio::test]
    async fn a_slow_redetection_doesnt_hold_up_listing_or_opening() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let api = super::tests::api()
            .with_openers(
                Arc::new(move || {
                    if count.fetch_add(1, Ordering::SeqCst) > 0 {
                        let _ = gate.lock().unwrap().recv();
                    }
                    vec![Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", crate::openers::ArgStyle::VsCode)]
                }),
                Arc::new(|_: &crate::openers::LaunchCommand| Ok(())),
            )
            .with_opener_refresh(std::time::Duration::ZERO);
        let list = || req(serde_json::json!({"method": "listOpeners"}));
        api.dispatch(list()).await.unwrap();
        let quick = std::time::Duration::from_secs(2);
        tokio::time::timeout(quick, api.dispatch(list())).await.expect("listing waited on the re-detection").unwrap();
        wait_until(|| calls.load(Ordering::SeqCst) == 2).await;
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let open_in = req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": null, "opener": "vscode"}}));
        tokio::time::timeout(quick, api.dispatch(open_in)).await.expect("opening waited on the re-detection").unwrap();
        tokio::time::timeout(quick, api.dispatch(list())).await.expect("a second listing waited").unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one re-detection at a time");
        release.send(()).unwrap();
    }

    /// Fix round 2: a WIP file (staged too) opens the working-tree file; when it's gone from the
    /// working tree, a read-only copy of the version the list has (`fallback`).
    #[tokio::test]
    async fn a_wip_file_opens_from_the_working_tree_or_its_stored_version_when_gone() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let cache = tempfile::tempdir().unwrap();
        let (api, launches) = with_openers(api().with_open_cache(cache.path().to_path_buf()));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let staged = r.git(&["rev-parse", ":src/app.php"]);
        let open_in = |fallback: serde_json::Value| {
            req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": 2, "opener": "vscode", "source": {"kind": "worktree", "worktree": wt}, "fallback": fallback}}))
        };
        api.dispatch(open_in(serde_json::json!({"kind": "object", "oid": staged}))).await.unwrap();
        assert_eq!(launched_file(&launches), PathBuf::from(format!("{}:2", wt.join("src/app.php").display())));
        std::fs::remove_file(wt.join("src/app.php")).unwrap();
        api.dispatch(open_in(serde_json::json!({"kind": "object", "oid": staged}))).await.unwrap();
        let copy = launched_file(&launches).to_string_lossy().trim_end_matches(":2").to_string();
        assert!(copy.starts_with(&cache.path().canonicalize().unwrap().to_string_lossy().into_owned()), "{copy}");
        assert!(std::fs::read_to_string(&copy).unwrap().ends_with("// staged tweak\n"));
        // No fallback: the missing file is an error, as before.
        assert_eq!(api.dispatch(open_in(serde_json::Value::Null)).await.unwrap_err().kind, GbErrorKind::NotFound);
    }

    #[tokio::test]
    async fn a_detection_that_panics_isnt_cached() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let api = api().with_openers(
            Arc::new(move || {
                if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("a broken desktop entry");
                }
                vec![Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", crate::openers::ArgStyle::VsCode)]
            }),
            Arc::new(|_: &crate::openers::LaunchCommand| Ok(())),
        );
        let list = || req(serde_json::json!({"method": "listOpeners"}));
        assert!(api.dispatch(list()).await.is_err(), "a failed detection is an error, not an empty list");
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 1, "and the next call retries");
    }
}
