//! The single command surface shared by the Tauri app and the test harness.

use crate::askpass::AskpassServer;
use crate::avatar::{AvatarPayload, AvatarProvider};
use crate::blob::{diff_contents, is_dotgit, safe_join, working_tree_encoding, Side};
use crate::commit::{parse_commit, parse_oid, read_commit_message};
use crate::details::{commit_details, read_commit, remotes};
use crate::diff::{file_list, DiffSpec};
use crate::error::{GbError, GbErrorKind};
use crate::events::{AppEvent, EventBus};
use crate::git::GitCli;
use crate::links::{validate_web_url, UrlOpener};
use crate::log::CommandLog;
use crate::openers::chooser::Chooser;
use crate::openers::folder_picker::FolderPicker;
use crate::ops::{OpId, OpRegistry};
use crate::openers::{template_opener, DetectEnv, Launcher, Opener, OpenerKind, OpenerPayload, CHOOSER_ID, CUSTOM_ID};
use crate::payload::{BlobSource, RepoSummary, SignatureKind, SignaturePayload};
use crate::scan::ScannedRepo;
use crate::settings::{AppSettings, EditorChoice, PinSetting, Profile, SettingsStore};
use crate::signature::signature_status;
use crate::snapshot::{build_graph_with_text, BuildOptions};
use crate::tree::tree_files;
use crate::worktree::list_worktrees;
use gix::ObjectId;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, OnceCell};
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(tag = "method", content = "params", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum Request {
    OpenRepo { path: String },
    /// The graph snapshot. `pin` (the repo's pin setting): `auto` or absent is the default
    /// trunk, `off` no trunk, `ref` that ref (spec §8.3).
    /// `rescan`: run status for every worktree instead of reusing the cached counts (tab
    /// activation, spec §4.4). The counts are only reused while the repo is watched; an
    /// unwatched repo always re-reads status.
    Graph {
        repo: u32,
        limit: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        pin: Option<PinSetting>,
        #[serde(default)]
        #[ts(optional)]
        rescan: Option<bool>,
    },
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
    /// `ListOpeners` for one repository: the `custom` entry is listed only when that
    /// repository's effective editor (its own setting, else the profile's) is a Custom command.
    ListOpenersFor { repo: u32 },
    /// Checks a custom editor command template the way an open would build it (the shell-code
    /// guard, then the program lookup), so the settings can show a refusal inline. Returns `null`
    /// when the template would open, else the error.
    ValidateEditorTemplate { template: String },
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
    /// App settings, the active profile and the profile list (spec §14.1): `StatePayload`.
    LoadState,
    /// Replaces the app settings (written debounced); returns `null`.
    SaveSettings { settings: AppSettings },
    /// Replaces one existing profile (written debounced); returns `null`.
    SaveProfile { profile: Profile },
    /// A new, empty profile: `ProfileMeta`.
    CreateProfile { name: String, color: String },
    /// Makes `id` the active profile: the new `StatePayload`.
    SwitchProfile { id: String },
    /// Deletes an inactive profile: the remaining `ProfileMeta[]`.
    DeleteProfile { id: String },
    /// The user's answer to a credential prompt (`authWaiting`); `null` cancels it. Returns `null`.
    AuthAnswer {
        #[ts(type = "number")]
        prompt: u64,
        answer: Option<String>,
    },
    /// Cancels a running network operation; unknown ids are ignored. Returns `null`.
    CancelOp {
        #[ts(type = "number")]
        op: u64,
    },
    /// `git fetch --all` (spec §15): `FetchOutcome`. `background` = GitBolt-started (never prompts).
    Fetch { repo: u32, background: bool },
    /// Clones `url` into the absolute `dest` (spec §13) and opens it: `RepoSummary`.
    Clone { url: String, dest: String },
    /// Every remote with its redacted URL, and the main worktree of a linked one: `RepoInfoPayload`.
    RepoInfo { repo: u32 },
    /// Branches, remotes, worktrees, stashes and tags (spec §6.4): `SidebarPayload`.
    Sidebar { repo: u32 },
    /// When a remote-tracking ref was last pushed (or else last fetched): `LastPushPayload | null`.
    LastPush { repo: u32, remote_ref: String },
    /// GitBolt's and git's versions (spec §6.5): `AppInfoPayload`.
    AppInfo,
    /// The system folder picker, starting in `start`: the picked folder, or `null` (cancelled,
    /// or no picker on this desktop: the UI falls back to a typed path).
    PickFolder { start: Option<String> },
    /// The repositories in `root` (absolute), two levels deep, newest first: `ScannedRepo[]`.
    /// Cached per root; `refresh` rescans.
    ScanRepos { root: String, refresh: bool },
    /// `ScanRepos` over several folders in parallel, merged and de-duplicated by path:
    /// `ScannedRepo[]`. Each folder is cached on its own; a folder that fails to scan is skipped.
    ScanFolders { roots: Vec<String>, refresh: bool },
    /// `~/repos` when it exists, else `null`.
    SuggestReposFolder,
    /// Starts the file watcher for this repo (the active tab's, spec §4.4); idempotent. `null`.
    WatchRepo { repo: u32 },
    /// Stops this repo's watcher; `null`.
    UnwatchRepo { repo: u32 },
    /// Stops every watcher (the UI's startup reset: none survive a reload); `null`.
    UnwatchAll,
    /// Find (spec §8.7): the loaded window's commits whose message contains `query`
    /// (case-insensitive), or, for 4+ hex characters, whose id starts with it: `string[]`.
    FindText { repo: u32, query: String },
    /// The loaded window's commits that touched a path containing `query` (case-insensitive;
    /// `[]` under 2 characters). The first call per window builds the path index: `string[]`.
    FindPaths { repo: u32, query: String },
    /// Whether `sha` is in the first 10,000 commits, and the window that would include it:
    /// `LocateResult`. Not a commit: `notFound`.
    LocateCommit { repo: u32, sha: String },
    /// "Search older history": commits outside the window whose message or paths match `query`,
    /// newest first: `HistoryHit[]`.
    SearchHistory { repo: u32, query: String },
}

pub(crate) struct RepoHandle {
    pub(crate) repo: gix::ThreadSafeRepository,
    pub(crate) workdir: PathBuf,
    /// The working directory's folder name (the fetch op's label).
    pub(crate) name: String,
    /// Held for the duration of any network operation: spec §15 "never overlaps".
    pub(crate) net_lock: tokio::sync::Mutex<()>,
    /// Each worktree's last status (the watcher keeps it fresh while the tab is active).
    pub(crate) wip: Arc<crate::snapshot::WipCache>,
    /// The last `graph` window's find state (spec §8.7); `None` until the first graph.
    pub(crate) snapshot: Mutex<Option<Arc<crate::find::FindSnapshot>>>,
}

pub struct Api {
    pub(crate) cli: GitCli,
    pub(crate) launch_repo: Option<String>,
    pub(crate) repos: Mutex<HashMap<u32, Arc<RepoHandle>>>,
    pub(crate) next_id: AtomicU32,
    /// git's version, checked (and cached) by the first `openRepo` (or `appInfo`).
    pub(crate) version: OnceCell<(u32, u32, u32)>,
    /// Signature verdicts, keyed by (the repository's git directory, commit id), for the process
    /// lifetime (spec §9.1). Keyed on the repository too, not just the commit: the signature
    /// bytes never change, but git's verdict depends on the keyring, trust database and
    /// repo-local config (`gpg.ssh.allowedSignersFile`, `gpg.program`), which differ per
    /// repository. Only a definitive verdict is cached (verified, unverified, bad, expired):
    /// `unknownKey` means "couldn't verify with what's configured right now" (a missing key, or
    /// `gpg.ssh.allowedSignersFile` not set yet) and must be re-checked every time, since the
    /// user can fix their configuration between calls without the commit changing at all.
    pub(crate) signatures: Mutex<HashMap<(PathBuf, ObjectId), SignaturePayload>>,
    pub(crate) avatars: Option<Arc<dyn AvatarProvider>>,
    pub(crate) url_opener: Option<UrlOpener>,
    pub(crate) openers: Option<Arc<OpenerSource>>,
    /// "Other…" (H32): the system's Open With chooser; listed only when set.
    pub(crate) chooser: Option<Chooser>,
    /// How long a detection answers `listOpeners` before the next one re-detects (the menu asks
    /// each time it opens, so a newly installed editor shows up without a restart).
    pub(crate) opener_refresh: Duration,
    /// Old versions' read-only copies (spec §14.5).
    pub(crate) open_cache: Option<PathBuf>,
    /// Backend → frontend events (spec §4.3), forwarded by the app and the harness.
    pub(crate) bus: EventBus,
    /// Settings and profiles (spec §14.3); in memory unless `with_store` gives it a directory.
    pub(crate) store: Arc<SettingsStore>,
    /// Running network operations (fetch, clone): ids, cancellation, may they prompt.
    pub(crate) ops: Arc<OpRegistry>,
    /// The per-session askpass socket (spec §5.4), once `start_askpass` ran.
    pub(crate) askpass: std::sync::OnceLock<Arc<AskpassServer>>,
    /// The system folder picker (spec §13); `pickFolder` answers `null` without one.
    pub(crate) folder_picker: Option<FolderPicker>,
    /// The user's home, for the suggested repos folder (`~/repos`).
    pub(crate) home: Option<PathBuf>,
    /// `scanRepos` results per root, until a `refresh`.
    pub(crate) scans: Mutex<HashMap<String, Vec<ScannedRepo>>>,
    /// The live file watchers by repo id: only the active tab's (spec §4.4).
    pub(crate) watchers: Mutex<HashMap<u32, crate::watch::RepoWatcher>>,
}

/// "Open in…": how to find the openers and how to launch one (the app spawns; the harness and
/// tests record). `found` is the last successful detection and when it ran: a failed one (a
/// panic) is never cached, so the next call retries. The lock is held only to read or store it,
/// never while detecting; `refreshing` keeps one background re-detection at a time.
pub(crate) struct OpenerSource {
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

/// Signature statuses kept per process; past this the cache starts over.
const SIGNATURE_CACHE_MAX: usize = 4096;

/// Whether a signature status may be remembered for the process lifetime. An unknown key and an
/// unverified signature both change when the user trusts the key (or adds it to the allowed
/// signers), so neither is cached: the badge follows the next look.
fn cacheable(kind: SignatureKind) -> bool {
    !matches!(kind, SignatureKind::UnknownKey | SignatureKind::Unverified)
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
            version: OnceCell::new(),
            signatures: Mutex::new(HashMap::new()),
            avatars: None,
            url_opener: None,
            openers: None,
            chooser: None,
            opener_refresh: OPENER_REFRESH,
            open_cache: None,
            bus: EventBus::new(),
            store: SettingsStore::in_memory(),
            ops: Arc::new(OpRegistry::default()),
            askpass: std::sync::OnceLock::new(),
            folder_picker: None,
            home: crate::paths::home_dir(),
            scans: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_folder_picker(mut self, picker: FolderPicker) -> Self {
        self.folder_picker = Some(picker);
        self
    }

    /// The home `suggestReposFolder` looks in (the user's own unless changed; the harness's is
    /// a temp dir).
    pub fn with_home(mut self, home: Option<PathBuf>) -> Self {
        self.home = home;
        self
    }

    /// Drops every cached `scanRepos` result (the harness's reset).
    pub fn forget_scans(&self) {
        self.scans.lock().expect("scans poisoned").clear();
    }

    /// One folder's scan: absolute roots only, cached per root unless `refresh`.
    async fn scan_root(&self, root: String, refresh: bool) -> Result<Vec<ScannedRepo>, GbError> {
        if !Path::new(&root).is_absolute() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("not an absolute folder: {root}")));
        }
        if !refresh && let Some(hit) = self.scans.lock().expect("scans poisoned").get(&root).cloned() {
            return Ok(hit);
        }
        let dir = PathBuf::from(&root);
        let found = blocking(move || Ok(crate::scan::scan_repos(&dir))).await?;
        self.scans.lock().expect("scans poisoned").insert(root, found.clone());
        Ok(found)
    }

    /// git's version, checked against `MIN_GIT` once and cached for the process lifetime.
    pub(crate) async fn git_version(&self) -> Result<(u32, u32, u32), GbError> {
        self.version.get_or_try_init(|| self.cli.check_version()).await.copied()
    }

    /// The custom editor (R5: the settings' Custom command, the repo's own over the profile's),
    /// built for the worktree `root` (its `{repo}`). Its program is looked up on the login
    /// shell's `PATH` when that's been captured (spec §5.3), else the app's.
    async fn custom_opener(&self, h: &RepoHandle, root: &Path) -> Result<Opener, GbError> {
        let profile = self.store.active_profile();
        let own = profile.repos.get(&h.workdir.display().to_string()).and_then(|r| r.editor.clone());
        let Some(EditorChoice::Custom { template }) = own.or(profile.editor) else {
            return Err(GbError::new(GbErrorKind::InvalidInput, "no custom editor command is set"));
        };
        let captured = self.cli.child_env().await;
        let root = root.to_path_buf();
        blocking(move || {
            let mut env = DetectEnv::from_system();
            if let Some(path) = captured.as_ref().and_then(|vars| vars.iter().find(|(k, _)| k == "PATH")).map(|(_, v)| v.clone()) {
                env.path = std::env::split_paths(&path).filter(|d| d.is_absolute()).collect();
            }
            template_opener(CUSTOM_ID, "Custom", &template, root, &env)
        })
        .await
    }

    /// The "Open in…" list. The `custom` entry is in it only when the Custom editor is the
    /// effective setting: the repository's own at `workdir`, else the profile's.
    async fn list_openers(&self, workdir: Option<String>) -> Result<serde_json::Value, GbError> {
        let mut list: Vec<OpenerPayload> = self.openers(false).await?.iter().map(Opener::payload).collect();
        let profile = self.store.active_profile();
        let own = workdir.and_then(|w| profile.repos.get(&w).and_then(|r| r.editor.clone()));
        if matches!(own.or(profile.editor), Some(EditorChoice::Custom { .. })) {
            let at = list.iter().position(|o| o.kind != OpenerKind::Editor).unwrap_or(list.len());
            list.insert(at, OpenerPayload { id: CUSTOM_ID.into(), name: "Custom".into(), kind: OpenerKind::Editor });
        }
        if self.chooser.is_some() {
            list.push(OpenerPayload { id: CHOOSER_ID.into(), name: "Other…".into(), kind: OpenerKind::Chooser });
        }
        to_json(list)
    }

    /// Pushes the Gravatar on/off setting to the avatar provider (spec §14.1).
    fn apply_avatar_setting(&self, on: bool) {
        if let Some(p) = &self.avatars {
            p.set_enabled(on);
        }
    }

    pub fn ops(&self) -> &Arc<OpRegistry> {
        &self.ops
    }

    pub fn askpass(&self) -> Option<&Arc<AskpassServer>> {
        self.askpass.get()
    }

    /// Starts the askpass socket in `dir` (spec §5.4). `exe` is the binary git runs as askpass.
    /// A second call keeps the first server.
    pub async fn start_askpass(&self, dir: &Path, exe: PathBuf) -> std::io::Result<()> {
        if self.askpass.get().is_some() {
            return Ok(());
        }
        let server = AskpassServer::start(dir, exe, self.ops.clone(), self.bus.clone()).await?;
        if let Err(extra) = self.askpass.set(server) {
            extra.close();
        }
        Ok(())
    }

    /// Environment for a network command belonging to `op`: askpass's (none if askpass isn't
    /// running: git then fails a prompt at once, `GIT_TERMINAL_PROMPT=0`), and for a GitBolt-started
    /// (non-interactive) op, `GCM_INTERACTIVE=never` too, so Git Credential Manager never shows
    /// its own prompt for a background fetch either.
    pub(crate) fn net_env(&self, op: OpId) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        let mut env = self.askpass.get().map(|s| s.env_for(Some(op))).unwrap_or_default();
        if self.ops.get(op).is_some_and(|e| !e.interactive) {
            env.push(("GCM_INTERACTIVE".into(), "never".into()));
        }
        env
    }

    pub fn with_store(mut self, store: Arc<SettingsStore>) -> Self {
        self.store = store;
        self.apply_profile_git_config();
        self
    }

    /// Applies the active profile's extra gitconfig (spec §14.2) to every git command: after
    /// loading the store, and whenever the profile (or which one is active) changes.
    fn apply_profile_git_config(&self) {
        let inc = self.store.active_profile().extra_gitconfig.filter(|p| !p.trim().is_empty()).map(PathBuf::from);
        self.cli.set_include_path(inc);
    }

    pub fn store(&self) -> &Arc<SettingsStore> {
        &self.store
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

    pub fn events(&self) -> &EventBus {
        &self.bus
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.bus.subscribe()
    }

    pub fn command_log(&self) -> &Arc<CommandLog> {
        self.cli.log()
    }

    pub async fn dispatch(&self, req: Request) -> Result<serde_json::Value, GbError> {
        match req {
            Request::OpenRepo { path } => to_json(self.open_repo(&path).await?),
            Request::Graph { repo, limit, pin, rescan } => {
                let h = self.handle(repo)?;
                let (pinned_ref, no_pin) = match pin {
                    Some(PinSetting::Off) => (None, true),
                    Some(PinSetting::Ref { name }) => (Some(name), false),
                    Some(PinSetting::Auto) | None => (None, false),
                };
                let opts = BuildOptions {
                    limit: limit.map(|l| l as usize).unwrap_or(crate::snapshot::DEFAULT_COMMIT_LIMIT),
                    pinned_ref,
                    no_pin,
                    wip_cache: Some(h.wip.clone()),
                    rescan: rescan.unwrap_or(false) || !self.status_is_watched(repo),
                };
                let (payload, texts) = build_graph_with_text(h.repo.clone(), h.workdir.clone(), self.cli.clone(), opts).await?;
                {
                    // Find searches this window now; the path index carries over (find.rs).
                    let mut snapshot = h.snapshot.lock().expect("snapshot poisoned");
                    let next = crate::find::FindSnapshot::new(texts, snapshot.as_deref());
                    *snapshot = Some(Arc::new(next));
                }
                to_json(payload)
            }
            Request::FindText { repo, query } => to_json(self.find_text(repo, &query)?),
            Request::FindPaths { repo, query } => to_json(self.find_paths(repo, &query).await?),
            Request::LocateCommit { repo, sha } => to_json(self.locate_commit(repo, &sha).await?),
            Request::SearchHistory { repo, query } => to_json(self.search_history(repo, &query).await?),
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
                // The active tab's watcher keeps its worktrees' WIP lists (K44): no git process,
                // and no worktree lookup either (only a watched worktree's lists are kept). A
                // covered worktree's first read computes and keeps them.
                if let DiffSpec::Wip { worktree, staged } = &spec
                    && self.status_is_watched(repo)
                    && h.wip.covered(Path::new(worktree))
                {
                    let lists = match h.wip.fresh_lists(Path::new(worktree)) {
                        Some(l) => l,
                        None => crate::watch::read_and_keep_lists(&h.repo, &self.cli, &h.wip, &Path::new(worktree).canonicalize()?).await?,
                    };
                    return to_json(if *staged { &*lists.staged } else { &*lists.unstaged });
                }
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
                if cacheable(s.kind) {
                    let mut cache = self.signatures.lock().expect("signatures poisoned");
                    if cache.len() >= SIGNATURE_CACHE_MAX {
                        cache.clear();
                    }
                    cache.insert(cache_key, s.clone());
                }
                to_json(s)
            }
            Request::Avatar { email } => match &self.avatars {
                Some(p) => to_json(p.avatar(&email).await?),
                None => to_json(Option::<AvatarPayload>::None),
            },
            Request::ListOpeners => self.list_openers(None).await,
            Request::ListOpenersFor { repo } => {
                let workdir = self.handle(repo)?.workdir.display().to_string();
                self.list_openers(Some(workdir)).await
            }
            Request::ValidateEditorTemplate { template } => {
                let captured = self.cli.child_env().await;
                blocking(move || {
                    let mut env = DetectEnv::from_system();
                    if let Some(path) = captured.as_ref().and_then(|vars| vars.iter().find(|(k, _)| k == "PATH")).map(|(_, v)| v.clone()) {
                        env.path = std::env::split_paths(&path).filter(|d| d.is_absolute()).collect();
                    }
                    template_opener(CUSTOM_ID, "Custom", &template, "/", &env).map(|_| ())
                })
                .await?;
                to_json(())
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
                let root = self.worktree_dir(&h, &worktree).await?;
                let o = if opener == CUSTOM_ID {
                    self.custom_opener(&h, &root).await?
                } else {
                    // An id the cached list doesn't have (installed since): detect again once.
                    let find = |list: &[Opener]| list.iter().find(|o| o.id == opener).cloned();
                    match find(&self.openers(false).await?) {
                        Some(o) => o,
                        None => find(&self.openers(true).await?).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("no opener {opener:?} on this machine")))?,
                    }
                };
                let target = match o.kind {
                    OpenerKind::FileManager => folder_target(&root, &path)?,
                    OpenerKind::Editor | OpenerKind::Chooser => self.open_in_file(&h, &root, &path, source, fallback).await?,
                };
                if o.kind == OpenerKind::Editor {
                    // Spec §5.3: editors start with the login shell's environment, which the
                    // launcher reads once captured; wait for the capture (bounded, and at most once).
                    let _ = self.cli.child_env().await;
                }
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
            Request::LoadState => {
                self.apply_profile_git_config();
                let mut state = self.store.state();
                state.profile.migrate_repos_folders(self.home.as_deref());
                self.apply_avatar_setting(state.settings.gravatar);
                to_json(state)
            }
            Request::SaveSettings { settings } => {
                self.apply_avatar_setting(settings.gravatar);
                self.store.save_settings(settings);
                to_json(())
            }
            Request::SaveProfile { profile } => {
                self.store.save_profile(profile)?;
                self.apply_profile_git_config();
                to_json(())
            }
            Request::CreateProfile { name, color } => to_json(self.store.create_profile(&name, &color)?),
            Request::SwitchProfile { id } => {
                let mut st = self.store.switch_profile(&id)?;
                st.profile.migrate_repos_folders(self.home.as_deref());
                self.apply_profile_git_config();
                to_json(st)
            }
            Request::DeleteProfile { id } => to_json(self.store.delete_profile(&id)?),
            Request::AuthAnswer { prompt, answer } => {
                let server = self.askpass.get().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "askpass is not running"))?;
                server.answer(prompt, answer)?;
                to_json(())
            }
            Request::CancelOp { op } => {
                self.ops.cancel(op);
                to_json(())
            }
            Request::Fetch { repo, background } => to_json(self.fetch(repo, background).await?),
            Request::Clone { url, dest } => to_json(self.clone_repo(url, dest).await?),
            Request::RepoInfo { repo } => {
                let h = self.handle(repo)?;
                to_json(crate::shelldata::repo_info(&self.cli, &h.repo, &h.workdir).await?)
            }
            Request::Sidebar { repo } => {
                let h = self.handle(repo)?;
                to_json(crate::shelldata::sidebar(&self.cli, &h.repo, &h.workdir).await?)
            }
            Request::LastPush { repo, remote_ref } => {
                let h = self.handle(repo)?;
                to_json(blocking(move || crate::shelldata::last_push(&h.repo, &remote_ref)).await?)
            }
            Request::AppInfo => to_json(crate::shelldata::app_info_payload(self.git_version().await?)),
            Request::PickFolder { start } => {
                let Some(picker) = self.folder_picker.clone() else { return to_json(Option::<String>::None) };
                let start = start.map(PathBuf::from).filter(|p| p.is_absolute());
                let picked = blocking(move || Ok(picker(start.as_deref()))).await?;
                to_json(picked.map(|p| p.display().to_string()))
            }
            Request::ScanRepos { root, refresh } => to_json(self.scan_root(root, refresh).await?),
            Request::ScanFolders { roots, refresh } => {
                let mut seen = std::collections::HashSet::new();
                let roots: Vec<String> = roots.into_iter().filter(|r| seen.insert(r.clone())).collect();
                let scans = futures_util::future::join_all(roots.into_iter().map(|r| self.scan_root(r, refresh))).await;
                to_json(crate::scan::merge_scans(scans.into_iter().filter_map(Result::ok)))
            }
            Request::SuggestReposFolder => to_json(crate::scan::suggest_repos_folder(self.home.as_deref())),
            Request::WatchRepo { repo } => {
                self.watch_repo(repo).await?;
                to_json(())
            }
            Request::UnwatchRepo { repo } => {
                self.unwatch_repo(repo);
                to_json(())
            }
            Request::UnwatchAll => {
                self.unwatch_all();
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

    pub(crate) fn handle(&self, id: u32) -> Result<Arc<RepoHandle>, GbError> {
        self.repos
            .lock()
            .expect("repos poisoned")
            .get(&id)
            .cloned()
            .ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("no open repository with id {id}")))
    }

    pub(crate) async fn open_repo(&self, path: &str) -> Result<RepoSummary, GbError> {
        self.git_version().await?;
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
        repos.insert(id, Arc::new(RepoHandle {
            repo,
            workdir: workdir.clone(),
            name: name.clone(),
            net_lock: tokio::sync::Mutex::new(()),
            wip: Arc::new(crate::snapshot::WipCache::watched_only()),
            snapshot: Mutex::new(None),
        }));
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

    /// An unverified signature (a good one from a key that isn't trusted yet) is looked at again
    /// next time, as an unknown key is, so trusting the key shows without a restart.
    #[test]
    fn only_settled_signature_statuses_are_cached() {
        for kind in [SignatureKind::Verified, SignatureKind::Bad, SignatureKind::Expired, SignatureKind::Unsigned] {
            assert!(cacheable(kind), "{kind:?}");
        }
        for kind in [SignatureKind::Unverified, SignatureKind::UnknownKey] {
            assert!(!cacheable(kind), "{kind:?}");
        }
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
        assert_eq!(graph["rows"][0]["kind"], "wip", "the open worktree's WIP is row 0");
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
    async fn state_round_trips_through_dispatch() {
        let api = api();
        let st = api.dispatch(req(serde_json::json!({"method": "loadState"}))).await.unwrap();
        assert_eq!(st["profile"]["id"], "default");
        let mut profile = st["profile"].clone();
        profile["tabs"] = serde_json::json!([{"id": "t1", "kind": "repo", "path": "/r", "alias": null}]);
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": profile}}))).await.unwrap();
        let st = api.dispatch(req(serde_json::json!({"method": "loadState"}))).await.unwrap();
        assert_eq!(st["profile"]["tabs"][0]["path"], "/r");
        let mut settings = st["settings"].clone();
        settings["fetchIntervalSecs"] = serde_json::json!(0);
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": settings}}))).await.unwrap();
        assert_eq!(api.store().state().settings.fetch_interval_secs, 0);
        let made = api.dispatch(req(serde_json::json!({"method": "createProfile", "params": {"name": "Work", "color": "#f00"}}))).await.unwrap();
        let switched = api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": made["id"]}}))).await.unwrap();
        assert_eq!(switched["profile"]["name"], "Work");
        assert_eq!(switched["profiles"].as_array().unwrap().len(), 2);
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": "default"}}))).await.unwrap();
        let left = api.dispatch(req(serde_json::json!({"method": "deleteProfile", "params": {"id": made["id"]}}))).await.unwrap();
        assert_eq!(left, serde_json::json!([{"id": "default", "name": "Default", "color": "#4d88ff"}]));
    }

    #[tokio::test]
    async fn profile_extra_gitconfig_reaches_git_commands() {
        let r = TestRepo::new();
        r.commit("a");
        let inc = r.root().join("work.gitconfig");
        std::fs::write(&inc, "[gitbolt]\n\tprobe = work\n").unwrap();
        let api = api();
        let mut p = api.store().active_profile();
        p.extra_gitconfig = Some(inc.display().to_string());
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": p}}))).await.unwrap();
        let out = api.cli.run(crate::git::GitInvocation::new(r.path(), ["config", "gitbolt.probe"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "work");
        // A blank path is no include at all; switching to a profile without one drops it.
        p.extra_gitconfig = Some("  ".into());
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": p}}))).await.unwrap();
        assert_eq!(api.cli.include_path(), None);
        p.extra_gitconfig = Some(inc.display().to_string());
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": p}}))).await.unwrap();
        let made = api.dispatch(req(serde_json::json!({"method": "createProfile", "params": {"name": "Plain", "color": "#0f0"}}))).await.unwrap();
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": made["id"]}}))).await.unwrap();
        assert!(api.cli.run(crate::git::GitInvocation::new(r.path(), ["config", "gitbolt.probe"])).await.is_err());
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": "default"}}))).await.unwrap();
        assert_eq!(api.cli.include_path(), Some(inc.clone()));
        // A store opened with an active profile that has one applies it at once.
        let other = super::Api::new(GitCli::new(Arc::new(CommandLog::new(10))), None).with_store(api.store().clone());
        assert_eq!(other.cli.include_path(), Some(inc));
    }

    #[tokio::test]
    async fn shell_data_requests_dispatch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let s = api.dispatch(req(serde_json::json!({"method": "sidebar", "params": {"repo": id}}))).await.unwrap();
        assert!(s["locals"].as_array().unwrap().iter().any(|b| b["name"] == "main" && b["isHead"] == true));
        assert_eq!(s["remotes"][0]["name"], "origin");
        let lp = api.dispatch(req(serde_json::json!({"method": "lastPush", "params": {"repo": id, "remoteRef": "refs/remotes/origin/main"}}))).await.unwrap();
        assert_eq!(lp["kind"], "push");
        let bad = api.dispatch(req(serde_json::json!({"method": "lastPush", "params": {"repo": id, "remoteRef": "../../etc/passwd"}}))).await.unwrap_err();
        assert_eq!(bad.kind, GbErrorKind::InvalidInput);
        let info = api.dispatch(req(serde_json::json!({"method": "repoInfo", "params": {"repo": id}}))).await.unwrap();
        assert_eq!(info["remotes"][0]["name"], "origin");
        assert!(info["mainWorktree"].is_null());
        let before = api.command_log().entries().len();
        let app = api.dispatch(req(serde_json::json!({"method": "appInfo"}))).await.unwrap();
        assert_eq!(app["appVersion"], env!("CARGO_PKG_VERSION"));
        assert!(app["gitVersion"].as_str().unwrap().starts_with('2'));
        assert_eq!(api.command_log().entries().len(), before, "the git version is the one openRepo cached");
    }

    #[tokio::test]
    async fn graph_accepts_a_pin_choice() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let graph = |pin: serde_json::Value| req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "pin": pin}}));
        let auto = api.dispatch(graph(serde_json::json!({"kind": "auto"}))).await.unwrap();
        assert!(auto["pinnedRef"].is_string());
        assert!(api.dispatch(graph(serde_json::json!({"kind": "off"}))).await.unwrap()["pinnedRef"].is_null());
        let hotfix = api.dispatch(graph(serde_json::json!({"kind": "ref", "name": "refs/heads/hotfix"}))).await.unwrap();
        assert_eq!(hotfix["pinnedRef"], "refs/heads/hotfix");
        let absent = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert_eq!(absent["pinnedRef"], auto["pinnedRef"], "no pin is the default trunk");
    }

    #[tokio::test]
    async fn pick_folder_scan_repos_and_suggest_repos_folder_dispatch() {
        let api = api();
        assert!(api.dispatch(req(serde_json::json!({"method": "pickFolder", "params": {"start": null}}))).await.unwrap().is_null(), "no picker: nothing picked");
        let asked: Arc<Mutex<Vec<Option<PathBuf>>>> = Arc::default();
        let sink = asked.clone();
        let api = api.with_folder_picker(Arc::new(move |start: Option<&Path>| {
            sink.lock().unwrap().push(start.map(Path::to_path_buf));
            Some(PathBuf::from("/picked/here"))
        }));
        let picked = api.dispatch(req(serde_json::json!({"method": "pickFolder", "params": {"start": "/start"}}))).await.unwrap();
        assert_eq!(picked, "/picked/here");
        assert_eq!(*asked.lock().unwrap(), [Some(PathBuf::from("/start"))]);

        let home = tempfile::tempdir().unwrap();
        let api = api.with_home(Some(home.path().to_path_buf()));
        let suggest = || req(serde_json::json!({"method": "suggestReposFolder"}));
        assert!(api.dispatch(suggest()).await.unwrap().is_null(), "no ~/repos yet");
        let repos = home.path().join("repos");
        TestRepo::init_at(&repos.join("one")).commit("a");
        assert_eq!(api.dispatch(suggest()).await.unwrap(), repos.display().to_string());

        let scan = |refresh: bool| req(serde_json::json!({"method": "scanRepos", "params": {"root": repos, "refresh": refresh}}));
        assert_eq!(api.dispatch(scan(false)).await.unwrap().as_array().unwrap().len(), 1);
        TestRepo::init_at(&repos.join("two")).commit("b");
        assert_eq!(api.dispatch(scan(false)).await.unwrap().as_array().unwrap().len(), 1, "cached per root");
        assert_eq!(api.dispatch(scan(true)).await.unwrap().as_array().unwrap().len(), 2, "refresh rescans");
        let rel = api.dispatch(req(serde_json::json!({"method": "scanRepos", "params": {"root": "relative", "refresh": false}}))).await.unwrap_err();
        assert_eq!(rel.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn scan_folders_merges_dedupes_and_skips_bad_folders() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        TestRepo::init_at(&a.path().join("one")).commit("a");
        TestRepo::init_at(&b.path().join("two")).commit("b");
        let api = api();
        let scan = |roots: serde_json::Value| req(serde_json::json!({"method": "scanFolders", "params": {"roots": roots, "refresh": false}}));
        let got = api.dispatch(scan(serde_json::json!([a.path(), b.path(), a.path(), "relative", "/no/such/dir"]))).await.unwrap();
        assert_eq!(got.as_array().unwrap().len(), 2, "{got}");
        assert!(api.dispatch(scan(serde_json::json!([]))).await.unwrap().as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_custom_editor_template_opens_through_the_launcher() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (api, launches) = with_openers(api());
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let open_custom = |line: Option<u32>| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": line, "opener": "custom"}}));
        assert_eq!(api.dispatch(open_custom(None)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "no custom command set");
        let mut p = api.store().active_profile();
        p.editor = Some(crate::settings::EditorChoice::Custom { template: "/bin/echo --goto {file}:{line} --project {repo}".into() });
        api.store().save_profile(p.clone()).unwrap();
        api.dispatch(open_custom(Some(7))).await.unwrap();
        let file = wt.join("src/app.php").display().to_string();
        assert_eq!(argv(launches.lock().unwrap().last().unwrap()), ["/bin/echo", "--goto", &format!("{file}:7"), "--project", &wt.display().to_string()]);
        // The repo's own editor wins over the profile's.
        p.repos.insert(wt.display().to_string(), crate::settings::RepoSettings { editor: Some(crate::settings::EditorChoice::Custom { template: "/bin/echo {file}".into() }), ..Default::default() });
        api.store().save_profile(p.clone()).unwrap();
        api.dispatch(open_custom(None)).await.unwrap();
        assert_eq!(argv(launches.lock().unwrap().last().unwrap()), ["/bin/echo", &file]);
        // The same path checks as any editor, and the template guard.
        let escape = req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "../x", "line": null, "opener": "custom"}}));
        assert_eq!(api.dispatch(escape).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        p.repos.clear();
        p.editor = Some(crate::settings::EditorChoice::Custom { template: "/bin/sh -c 'vim {file}'".into() });
        api.store().save_profile(p.clone()).unwrap();
        assert_eq!(api.dispatch(open_custom(None)).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        p.editor = Some(crate::settings::EditorChoice::Opener { id: "vscode".into() });
        api.store().save_profile(p).unwrap();
        assert_eq!(api.dispatch(open_custom(None)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "the editor is an opener, not a custom command");
        assert_eq!(launches.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn auth_answer_and_cancel_op_dispatch() {
        let api = api();
        let answer = |prompt: u64| req(serde_json::json!({"method": "authAnswer", "params": {"prompt": prompt, "answer": "x"}}));
        assert_eq!(api.dispatch(answer(1)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "no askpass yet");
        assert!(api.dispatch(req(serde_json::json!({"method": "cancelOp", "params": {"op": 42}}))).await.unwrap().is_null(), "unknown ids are ignored");
        let op = api.ops().begin(crate::events::OpKind::Fetch, None, true);
        api.dispatch(req(serde_json::json!({"method": "cancelOp", "params": {"op": op.id}}))).await.unwrap();
        assert!(op.cancel.is_cancelled());
        assert!(api.net_env(op.id).is_empty(), "no askpass: no askpass environment");
        let dir = tempfile::tempdir().unwrap();
        api.start_askpass(dir.path(), "/bin/false".into()).await.unwrap();
        let first = api.askpass().unwrap().socket_path().to_path_buf();
        api.start_askpass(dir.path(), "/bin/true".into()).await.unwrap();
        assert_eq!(api.askpass().unwrap().socket_path(), first, "started once");
        assert_eq!(api.dispatch(answer(1)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "no such prompt");
        let env = api.net_env(op.id);
        assert!(env.iter().any(|(k, v)| k == crate::askpass::ENV_OP && *v == *op.id.to_string()));
        assert!(!env.iter().any(|(k, _)| k == "GCM_INTERACTIVE"), "a user-started op may prompt through a credential manager");
        // A GitBolt-started op never prompts, not even through Git Credential Manager's own UI.
        let background = api.ops().begin(crate::events::OpKind::Fetch, Some(1), false);
        let env = api.net_env(background.id);
        assert!(env.iter().any(|(k, v)| k == "GCM_INTERACTIVE" && v == "never"), "{env:?}");
        assert!(super::Api::new(GitCli::new(Arc::new(CommandLog::new(10))), None).net_env(background.id).is_empty(), "an op this Api doesn't know");
        let plain = super::tests::api();
        let bg = plain.ops().begin(crate::events::OpKind::Fetch, Some(1), false);
        assert_eq!(plain.net_env(bg.id), vec![("GCM_INTERACTIVE".into(), "never".into())], "even without askpass");
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
    async fn the_gravatar_setting_reaches_the_provider() {
        struct Flag(std::sync::atomic::AtomicBool);
        impl crate::avatar::AvatarProvider for Flag {
            fn avatar<'a>(&'a self, _: &'a str) -> crate::avatar::AvatarFuture<'a> {
                Box::pin(async { Ok(None) })
            }
            fn set_enabled(&self, on: bool) {
                self.0.store(on, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let flag = Arc::new(Flag(std::sync::atomic::AtomicBool::new(true)));
        let api = api().with_avatars(flag.clone());
        let mut s = serde_json::to_value(crate::settings::AppSettings::default()).unwrap();
        s["gravatar"] = false.into();
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": s}}))).await.unwrap();
        assert!(!flag.0.load(std::sync::atomic::Ordering::SeqCst));
        s["gravatar"] = true.into();
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": s}}))).await.unwrap();
        assert!(flag.0.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn editor_templates_are_validated_with_the_guards_message() {
        let api = api();
        let check = |t: &str| req(serde_json::json!({"method": "validateEditorTemplate", "params": {"template": t}}));
        assert!(api.dispatch(check("/bin/echo {file}")).await.unwrap().is_null());
        let refused = api.dispatch(check(r#"sh -c "geany {file}""#)).await.unwrap_err();
        assert_eq!(refused.kind, GbErrorKind::InvalidInput);
        assert!(refused.message.contains("can't contain"), "{}", refused.message);
        assert_eq!(api.dispatch(check("no-such-editor-xyz {file}")).await.unwrap_err().kind, GbErrorKind::NotFound);
    }

    #[tokio::test]
    async fn the_custom_editor_is_listed_only_for_a_repo_whose_effective_editor_is_custom() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (api, _launches) = with_openers(api());
        let id = open(&api, &r).await;
        let workdir = api.handle(id as u32).unwrap().workdir.display().to_string();
        let ids = |v: serde_json::Value| v.as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let global = || req(serde_json::json!({"method": "listOpeners"}));
        let for_repo = || req(serde_json::json!({"method": "listOpenersFor", "params": {"repo": id}}));
        let custom = "custom".to_string();
        assert!(!ids(api.dispatch(global()).await.unwrap()).contains(&custom));
        assert!(!ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom));

        let mut p = api.store().active_profile();
        p.editor = Some(EditorChoice::Custom { template: "/bin/echo {file}".into() });
        api.store().save_profile(p.clone()).unwrap();
        assert!(ids(api.dispatch(global()).await.unwrap()).contains(&custom));
        assert!(ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom), "the profile's Custom applies to the repo");

        // The repo's own detected-editor choice overrides the profile's Custom: no entry.
        p.repos.insert(workdir.clone(), crate::settings::RepoSettings { editor: Some(EditorChoice::Opener { id: "vscode".into() }), ..Default::default() });
        api.store().save_profile(p.clone()).unwrap();
        assert!(!ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom));

        // Custom on one repo only: not listed for a repo (or the profile) without it.
        p.editor = None;
        p.repos.insert(workdir, crate::settings::RepoSettings { editor: Some(EditorChoice::Custom { template: "/bin/echo {file}".into() }), ..Default::default() });
        api.store().save_profile(p).unwrap();
        assert!(ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom));
        assert!(!ids(api.dispatch(global()).await.unwrap()).contains(&custom), "other repos don't see it");
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
