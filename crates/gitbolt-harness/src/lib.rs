//! Serves `Api::dispatch` over a WebSocket so Playwright can drive the real backend, and
//! forwards the backend's event bus on the same socket as `{"event": …}` frames.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use gitbolt_core::api::{Api, Request, WriteGuard, FIXTURE_ONLY};
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::events::AppEvent;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_core::openers::{ArgStyle, ExecArg, LaunchCommand, Opener, OpenerKind};
use gitbolt_core::settings::SettingsStore;
use gitbolt_core::testing::{isolated_git_env, FIXTURE_MARKER};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::error::RecvError;
use axum::serve::ListenerExt;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

pub mod fake_forge;
use gitbolt_forge::{connector::{Forge, ForgeConfig}, endpoints::HostEndpoints, tokens::FileTokenStore};

/// The "Open in…" launches the harness recorded instead of running anything (tests never start
/// a real application). Served as JSON at `GET /launches`: `[{program, args}]`, oldest first.
#[derive(Default)]
pub struct Launches(Mutex<Vec<serde_json::Value>>);

impl Launches {
    pub fn record(&self, c: &LaunchCommand) {
        let args: Vec<String> = c.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        self.0.lock().expect("launches poisoned").push(serde_json::json!({"program": c.program.to_string_lossy(), "args": args}));
    }

    pub fn all(&self) -> Vec<serde_json::Value> {
        self.0.lock().expect("launches poisoned").clone()
    }

    pub fn clear(&self) {
        self.0.lock().expect("launches poisoned").clear();
    }
}

/// The update installer's commands, recorded in `/launches` and never run: `run` answers "not
/// found" (the dialog then shows the command to run by hand), and a quit is recorded as the
/// program `quit`.
struct RecordingRunner(Arc<Launches>);

impl RecordingRunner {
    fn record(&self, c: &gitbolt_core::updates::install::InstallCommand) {
        self.0.record(&LaunchCommand { program: c.program.clone().into(), args: c.args.iter().map(Into::into).collect() });
    }
}

impl gitbolt_core::updates::UpdateRunner for RecordingRunner {
    fn run<'a>(&'a self, cmd: &'a gitbolt_core::updates::install::InstallCommand) -> gitbolt_core::updates::RunFuture<'a> {
        self.record(cmd);
        Box::pin(async { Err(std::io::Error::new(std::io::ErrorKind::NotFound, "the harness never installs")) })
    }
    fn spawn(&self, cmd: &gitbolt_core::updates::install::InstallCommand) -> std::io::Result<()> {
        self.record(cmd);
        Ok(())
    }
    fn quit(&self) {
        self.0.record(&LaunchCommand { program: "quit".into(), args: Vec::new() });
    }
}

/// What `/launches` names "Other…" (the Open With chooser) by, in place of a program.
pub const CHOOSER_PROGRAM: &str = "open-with-chooser";

/// A fixed opener list (one of each style; the programs don't exist) plus "Other…", whose
/// launches `launches` records.
pub fn with_fake_openers(api: Api, launches: Arc<Launches>) -> Api {
    let chosen = launches.clone();
    api.with_chooser(Arc::new(move |file: &std::path::Path| {
        chosen.record(&LaunchCommand { program: CHOOSER_PROGRAM.into(), args: vec![file.into()] });
        Ok(())
    }))
    .with_openers(
        Arc::new(|| {
            vec![
                Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/bin/code", ArgStyle::VsCode),
                Opener::new("jetbrains-phpstorm", "PhpStorm", OpenerKind::Editor, "/fake/bin/phpstorm", ArgStyle::JetBrains),
                Opener::new("text-editor", "Text Editor", OpenerKind::Editor, "/fake/bin/gnome-text-editor", ArgStyle::Exec(vec![ExecArg::File])),
                Opener::new("file-manager", "Files", OpenerKind::FileManager, "/fake/bin/nautilus", ArgStyle::Exec(vec![ExecArg::Literal("--new-window".into()), ExecArg::File])),
            ]
        }),
        Arc::new(move |c: &LaunchCommand| {
            launches.record(c);
            Ok(())
        }),
    )
}

#[derive(Debug, Default, Clone)]
pub struct HarnessOptions {
    /// Settings directory (used from Task 2). `None` means a fresh temp dir, never `~/.config`.
    pub config_dir: Option<PathBuf>,
    /// Binary git runs as GIT_ASKPASS. `None` means the harness binary (this one, or the one cargo
    /// built next to a test binary).
    pub askpass_exe: Option<PathBuf>,
    /// Writes are allowed only to marked fixture repositories under this directory (spec #2 §17.2).
    /// `None` = the system temp dir, where `just e2e`'s global setup and `freshFixture` build them.
    pub fixture_root: Option<PathBuf>,
}

/// The harness's write guard (spec #2 §17.2): allowed only for a repository whose common dir sits
/// under `root` and inside a directory holding `FIXTURE_MARKER`, which only
/// `gitbolt-harness fixture` and `TestRepo::mark_fixture` write. Paths are canonical, so a
/// symlink out of the root doesn't count.
pub fn fixture_guard(root: PathBuf) -> WriteGuard {
    let root = gitbolt_core::platform::fs::canonicalize(&root).unwrap_or(root);
    Arc::new(move |common_dir: &std::path::Path| {
        let refused = || GbError::new(GbErrorKind::InvalidInput, FIXTURE_ONLY);
        let dir = gitbolt_core::platform::fs::canonicalize(common_dir).map_err(|_| refused())?;
        // Strictly below the root: a stray marker in the root itself (e.g. /tmp) must not
        // authorise every repository under it (T4 review).
        let marked = dir.starts_with(&root) && dir.ancestors().take_while(|a| a.starts_with(&root) && *a != root.as_path()).any(|a| a.join(FIXTURE_MARKER).is_file());
        if marked {
            Ok(())
        } else {
            Err(refused())
        }
    })
}

/// Everything one harness server owns: the `Api` it serves, its settings store and the
/// launches it recorded.
pub struct Harness {
    pub api: Arc<Api>,
    pub store: Arc<SettingsStore>,
    pub launches: Arc<Launches>,
    // --- 4A T4 ---
    /// The fake GitLab and GitHub (spec #4 §7); T10 points the providers at it.
    pub forge: Arc<fake_forge::FakeForge>,
    // --- end 4A T4 ---
    // --- 4A T10 ---
    /// Forge tokens: a file in the harness's temp dir, never the keyring (storage `file`).
    pub tokens: Arc<FileTokenStore>,
    tokens_path: std::path::PathBuf,
    // --- end 4A T10 ---
    /// The settings directory when none was given; lives as long as the harness.
    _config_tmp: Option<tempfile::TempDir>,
    /// Old versions opened "in an editor" are copied here; lives as long as the harness.
    _open_cache: tempfile::TempDir,
    /// What the folder picker answers next (`POST /test/next-pick`).
    pub picks: Arc<Picks>,
    /// The harness's own (empty) home, `<runtime tmp>/home`: never the user's.
    home: PathBuf,
    /// The askpass socket's directory (the app's `$XDG_RUNTIME_DIR`) and the home; lives as long
    /// as the harness.
    _runtime_tmp: tempfile::TempDir,
}

/// The folder picker's queued answers, oldest first: each `pickFolder` takes the next one, and
/// answers `null` (cancelled) when there's none.
#[derive(Default)]
pub struct Picks(Mutex<std::collections::VecDeque<Option<PathBuf>>>);

impl Picks {
    pub fn push(&self, pick: Option<PathBuf>) {
        self.0.lock().expect("picks poisoned").push_back(pick);
    }

    pub fn next(&self) -> Option<PathBuf> {
        self.0.lock().expect("picks poisoned").pop_front().flatten()
    }

    pub fn clear(&self) {
        self.0.lock().expect("picks poisoned").clear();
    }
}

/// The binary git runs as askpass by default: the harness binary. That's this process when it
/// is one (`gitbolt-harness serve`); from a test binary (`target/<profile>/deps/<test>-<hash>`),
/// the `gitbolt-harness` that cargo built next to it, one folder up.
fn harness_exe() -> PathBuf {
    let me = std::env::current_exe().expect("current exe");
    let name = format!("gitbolt-harness{}", std::env::consts::EXE_SUFFIX);
    if me.file_name().is_some_and(|n| *n == *name) {
        return me;
    }
    me.ancestors().skip(1).take(2).map(|d| d.join(&name)).find(|p| p.is_file()).unwrap_or(me)
}

/// The real providers, pointed at the fake forge; no other host is reachable.
fn fake_connector(forge: &fake_forge::FakeForge) -> Forge {
    let overrides = std::collections::HashMap::from([
        (fake_forge::GITLAB_HOST.to_string(), HostEndpoints { api: forge.gitlab_api(), web: forge.gitlab_web(), avatars: None }),
        (fake_forge::GITHUB_HOST.to_string(), HostEndpoints { api: forge.github_api(), web: forge.github_web(), avatars: Some(forge.github_avatars()) }),
    ]);
    Forge::new(ForgeConfig { overrides, only_overrides: true, avatar_dir: None })
        // --- 5A T3: GitHub's Markdown image hosts are the fake's (no test reaches a real one) ---
        .with_image_bases(fake_forge::GITHUB_HOST, vec![forge.github_web(), forge.github_images(), forge.github_avatars()])
        // A test that reseeds the fake sees it at once (no `FRESH_SECS` answer from before).
        .with_change_counter(forge.change_counter())
}

/// Tests opt into background fetch explicitly: a fresh (or reset) harness never fetches on its
/// own, so it never touches a repo's refs behind a test's back.
fn harness_defaults(store: &Arc<SettingsStore>) {
    let mut s = store.state().settings;
    s.fetch_interval_secs = 0;
    store.save_settings(s);
}

impl Harness {
    /// The backend the e2e suite drives: git with an isolated environment, settings in
    /// `config_dir` or a fresh temp dir (never `~/.config`), and no Gravatar. Forge accounts reach
    /// only the fake forge, with their tokens in a file in the temp dir. The URL opener only logs
    /// (the UI's link buttons are checked by their data-url attribute instead), and fake openers
    /// record "Open in…" launches (`GET /launches`) instead of running them.
    pub async fn new(opts: HarnessOptions) -> Self {
        let (store, config_tmp) = match opts.config_dir {
            Some(dir) => (SettingsStore::open(dir), None),
            None => {
                let tmp = tempfile::tempdir().expect("temp config dir");
                (SettingsStore::open(tmp.path()), Some(tmp))
            }
        };
        harness_defaults(&store);
        let launches = Arc::new(Launches::default());
        let picks = Arc::new(Picks::default());
        let open_cache = tempfile::tempdir().expect("open-in cache");
        let runtime_tmp = tempfile::tempdir().expect("temp runtime dir");
        let home = runtime_tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("harness home");
        // "Your repos" and the repos-folder suggestion read <home>/repos: one sample repo there
        // (<home>/repos/sample/repo, two levels deep as the scan expects).
        let sample = gitbolt_core::testing::TestRepo::init_at(&home.join("repos").join("sample"));
        sample.commit("Sample commit");
        // <home>/more: 40 bare-bones repos (a `.git/HEAD` each) so a test can fill "Your repos" past the
        // screen without paying for 40 commits. Not scanned until a test adds the folder.
        for n in 0..40 {
            let dot = home.join("more").join(format!("bulk-{n:02}")).join(".git");
            std::fs::create_dir_all(&dot).expect("bulk repo dir");
            std::fs::write(dot.join("HEAD"), "ref: refs/heads/bulk\n").expect("bulk HEAD");
        }
        let forge = fake_forge::FakeForge::start().await;
        // --- 4A T10: the real providers, pointed at the fake forge; no other host is reachable ---
        let tokens_path = runtime_tmp.path().join("forge-tokens");
        let tokens = Arc::new(FileTokenStore::new(tokens_path.clone()));
        let connector = Arc::new(fake_connector(&forge));
        // --- end 4A T10 ---
        let next_pick = picks.clone();
        // Updates: the fake GitHub's releases (none until a test seeds some), a .deb install,
        // downloads in the temp dir, and installs only recorded.
        let updates = gitbolt_core::updates::UpdateConfig {
            source: Arc::new(gitbolt_forge::updates::GitHubReleases::new(&forge.github_api(), &forge.github_releases(), vec![forge.github_objects()])),
            runner: Arc::new(RecordingRunner(launches.clone())),
            dir: runtime_tmp.path().join("updates"),
            kind: gitbolt_core::updates::install::InstallKind::Deb,
            exe: Some("/fake/bin/gitbolt".into()),
        };
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None)
            .with_updates(updates)
            // The journal and temp index files: the harness's own, never ~/.local/share.
            .with_data_dir(runtime_tmp.path().join("data"))
            .with_forge(connector, tokens.clone())
            .with_url_opener(Arc::new(|url: &str| {
                tracing::info!("openUrl {url}");
                Ok(())
            }))
            .with_open_cache(open_cache.path().to_path_buf())
            .with_folder_picker(Arc::new(move |_start: Option<&std::path::Path>| next_pick.next()))
            .with_home(Some(home.clone()))
            .with_store(store.clone())
            .with_write_guard(fixture_guard(opts.fixture_root.clone().unwrap_or_else(std::env::temp_dir)));
        let api = Arc::new(with_fake_openers(api, launches.clone()));
        // Askpass (spec §5.4), in the private temp dir: git runs `askpass_exe` (the harness binary
        // itself unless a test names one), which asks this server over its socket.
        let exe = opts.askpass_exe.unwrap_or_else(harness_exe);
        api.start_askpass(runtime_tmp.path(), exe).await.expect("askpass socket");
        Self { forge, tokens, tokens_path, api, store, launches, picks, home, _config_tmp: config_tmp, _open_cache: open_cache, _runtime_tmp: runtime_tmp }
    }

    /// Where the harness keeps forge tokens (tests check its mode).
    pub fn tokens_path(&self) -> &std::path::Path {
        &self.tokens_path
    }

    /// The app's data dir (journals, the MR/PR cache): the harness's own temp dir.
    pub fn data_dir(&self) -> std::path::PathBuf {
        self._runtime_tmp.path().join("data")
    }

    /// The harness's home (`suggestReposFolder` looks for `repos` in it).
    pub fn home(&self) -> &std::path::Path {
        &self.home
    }

    pub async fn for_tests() -> Self {
        Self::new(HarnessOptions::default()).await
    }

    /// The app launched again: a new `Api` (a new forge hub, nothing in memory) on this harness's
    /// settings, tokens, data dir and fake forge (the MR/PR cache across restarts).
    pub fn relaunch(&self) -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None)
            .with_data_dir(self._runtime_tmp.path().join("data"))
            .with_forge(Arc::new(fake_connector(&self.forge)), self.tokens.clone())
            .with_home(Some(self.home.clone()))
            .with_store(self.store.clone())
    }

    /// `POST /test/reset`: the state a fresh app launch would see (default settings, with
    /// background fetch off, and one default profile), no recorded launches, no queued picks, no
    /// cached repo scans, no file watchers, no queued writes or journals, and no forwarded paths
    /// waiting.
    pub fn reset(&self) {
        self.api.unwatch_all();
        self.api.reset_writes();
        self.store.reset();
        harness_defaults(&self.store);
        self.launches.clear();
        self.picks.clear();
        self.api.forget_scans();
        self.api.take_open_requests();
        self.forge.reset();
        self.tokens.clear();
        self.api.forge_reset();
        self.api.reset_updates();
    }
}

/// Routes: `GET /health`, `GET /launches`, `GET /ws` (requests, replies and event frames),
/// `POST /test/emit` (a JSON `AppEvent`, put on the bus; `openRequested` is also queued for
/// `takeOpenRequests`, as the app's single-instance guard does), `POST /test/reset`,
/// `POST /test/next-pick` (`{"path": string | null}`: the folder picker's next answer),
/// `GET /test/watched` (the ids of the repos with a live file watcher, sorted),
/// `POST /test/write` (a test-only write intent, behind the fixture guard),
/// `ANY /test/auth/*` (a git remote that always answers 401), and the fake forge's controls
/// `GET|POST /test/forge/seed`, `POST /test/forge/script`, `GET /test/forge/requests`, `POST /test/forge/account`.
pub async fn serve(listener: tokio::net::TcpListener, harness: Harness) {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/launches", get(launches))
        .route("/ws", get(ws))
        .route("/test/emit", post(test_emit))
        .route("/test/reset", post(test_reset))
        .route("/test/next-pick", post(test_next_pick))
        .route("/test/auth/{*rest}", any(test_auth))
        .route("/test/watched", get(test_watched))
        .route("/test/write", post(test_write))
        .route("/test/forge/seed", get(test_forge_seed_get).post(test_forge_seed))
        .route("/test/forge/script", post(test_forge_script))
        .route("/test/forge/requests", get(test_forge_requests))
        // --- 4B T16 ---
        .route("/test/forge/account", post(test_forge_account))
        // --- end 4B T16 ---
        .with_state(Arc::new(harness));
    // Small frames go out at once (no Nagle wait for the previous frame's delayed ACK).
    let listener = listener.tap_io(|tcp| {
        if let Err(e) = tcp.set_nodelay(true) {
            tracing::warn!("harness: couldn't set TCP_NODELAY: {e}");
        }
    });
    axum::serve(listener, app).await.expect("harness server failed");
}

async fn test_reset(State(h): State<Arc<Harness>>, headers: HeaderMap) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Removing the settings files is blocking I/O (and takes the store's writer lock): off the
    // async workers.
    match tokio::task::spawn_blocking(move || h.reset()).await {
        Ok(()) => "ok".into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("reset failed: {e}")).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct NextPick {
    path: Option<String>,
}

async fn test_next_pick(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(p): Json<NextPick>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    h.picks.push(p.path.map(PathBuf::from));
    "ok".into_response()
}

/// A smart-HTTP remote that always demands credentials and rejects whatever it gets. Git asks
/// askpass for a username and password, retries, and fails with "Authentication failed". It has
/// no state and reveals nothing, so it needs no Origin check.
async fn test_auth() -> impl IntoResponse {
    (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Basic realm=\"gitbolt-test\"")], "authentication required")
}

/// Browsers always send Origin on a WebSocket upgrade and on a cross-origin POST, so refusing
/// foreign ones stops any other web page from driving the backend. Non-browser clients (the Rust
/// tests, Playwright's request context) send none.
fn foreign_origin(headers: &HeaderMap) -> bool {
    headers.get(header::ORIGIN).is_some_and(|origin| !origin.to_str().is_ok_and(origin_allowed))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestWriteBody {
    path: String,
    #[serde(default)]
    worktree: Option<String>,
    #[serde(default)]
    expect: gitbolt_core::write::types::Expect,
    intent: gitbolt_core::write::test_intents::TestIntent,
}

// --- 4A T4: the fake forge's controls (Playwright scripts it through the harness port) ---
async fn test_forge_seed_get(State(h): State<Arc<Harness>>, headers: HeaderMap) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(h.forge.current_seed()).into_response()
}

async fn test_forge_seed(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(seed): Json<fake_forge::ForgeSeed>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    h.forge.seed(seed);
    "ok".into_response()
}

async fn test_forge_script(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(s): Json<fake_forge::Scripted>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    h.forge.script(s);
    "ok".into_response()
}

async fn test_forge_requests(State(h): State<Arc<Harness>>, headers: HeaderMap) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(h.forge.requests()).into_response()
}
// --- end 4A T4 ---

/// `POST /test/write`: a test-only write intent (spec #2 §18 2A) on the repository at `path`
/// (opened if it isn't), in `worktree` (default: `path`). Answers `{ok}` or `{err}` like the
/// socket. The write guard applies: only marked fixtures under the fixture root.
async fn test_write(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(b): Json<TestWriteBody>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let reply = async {
        let opened = h.api.dispatch(Request::OpenRepo { path: b.path.clone() }).await?;
        let repo = opened["id"].as_u64().unwrap_or_default() as u32;
        let worktree = b.worktree.unwrap_or_else(|| opened["path"].as_str().unwrap_or(&b.path).to_string());
        h.api.dispatch(Request::TestWrite { repo, worktree, expect: b.expect, intent: b.intent }).await
    }
    .await;
    match reply {
        Ok(v) => Json(serde_json::json!({ "ok": v })).into_response(),
        Err(e) => Json(serde_json::json!({ "err": e })).into_response(),
    }
}

async fn test_watched(State(h): State<Arc<Harness>>, headers: HeaderMap) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(h.api.watched_repos()).into_response()
}

async fn launches(State(h): State<Arc<Harness>>, headers: HeaderMap) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(h.launches.all()).into_response()
}

async fn test_emit(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(ev): Json<AppEvent>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match ev {
        // As the app's single-instance guard does it (R19): queued for `takeOpenRequests`, then announced.
        AppEvent::OpenRequested { path } => h.api.request_open(path),
        ev => h.api.events().emit(ev),
    }
    "ok".into_response()
}

async fn ws(State(h): State<Arc<Harness>>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let api = h.api.clone();
    upgrade.on_upgrade(move |socket| handle(socket, api)).into_response()
}

/// `http://localhost[:port]`, `http://127.0.0.1[:port]` (the Vite dev server and the harness
/// itself) or any `tauri://` origin.
fn origin_allowed(origin: &str) -> bool {
    if origin.starts_with("tauri://") {
        return true;
    }
    ["http://localhost", "http://127.0.0.1"].iter().any(|host| {
        origin.strip_prefix(host).is_some_and(|rest| {
            rest.is_empty() || rest.strip_prefix(':').is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        })
    })
}

/// Frames queued for one socket's writer. Events beyond it are dropped (and logged), like a
/// lagging bus receiver; replies wait for room.
const SOCKET_QUEUE: usize = 256;

/// One writer task owns the socket's sink. Replies (each request runs in its own task, so a slow
/// request never blocks the others, and replies may arrive out of order) and forwarded events
/// all go to it through one bounded channel.
async fn handle(socket: WebSocket, api: Arc<Api>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(SOCKET_QUEUE);
    // Subscribed before the first request is read: any event emitted after a reply reaches us.
    let mut events = api.subscribe();
    let ev_tx = tx.clone();
    let forward = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => match ev_tx.try_send(serde_json::json!({ "event": ev }).to_string()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => tracing::warn!("harness socket is {SOCKET_QUEUE} frames behind; dropped an event"),
                    Err(TrySendError::Closed(_)) => break,
                },
                Err(RecvError::Lagged(n)) => tracing::warn!("harness event forwarder lagged by {n} events"),
                Err(RecvError::Closed) => break,
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else { continue };
        let (api, tx, text) = (api.clone(), tx.clone(), text.to_string());
        tokio::spawn(async move {
            let _ = tx.send(respond(&api, &text).await.to_string()).await;
        });
    }
    forward.abort();
    writer.abort();
}

/// Parses the envelope as a bare JSON value first so a malformed or unknown
/// `req` still carries back the caller's `id`, then decodes `req` into a
/// `Request`.
async fn respond(api: &Api, text: &str) -> serde_json::Value {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return error_reply(serde_json::Value::Null, format!("invalid message: {e}")),
    };
    let id = value.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let req = value.get("req").cloned().unwrap_or(serde_json::Value::Null);
    match serde_json::from_value::<Request>(req) {
        Ok(req) => match api.dispatch(req).await {
            Ok(v) => serde_json::json!({"id": id, "ok": v}),
            Err(e) => serde_json::json!({"id": id, "err": e}),
        },
        Err(e) => error_reply(id, format!("invalid request: {e}")),
    }
}

fn error_reply(id: serde_json::Value, message: String) -> serde_json::Value {
    let err = GbError::new(GbErrorKind::InvalidInput, message);
    serde_json::json!({"id": id, "err": err})
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitbolt_core::testing::{TestRepo, FIXTURE_MARKER};

    #[test]
    fn the_guard_allows_only_marked_repositories_under_the_root() {
        let root = tempfile::tempdir().unwrap();
        let guard = fixture_guard(root.path().to_path_buf());
        let marked = TestRepo::init_at(&root.path().join("basic"));
        marked.mark_fixture();
        assert!(guard(&marked.path().join(".git")).is_ok());
        let wt = marked.root().join("wt-x");
        marked.commit("c");
        marked.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "x"]);
        assert!(guard(&marked.path().join(".git")).is_ok(), "the common dir decides, whichever worktree writes");

        let unmarked = TestRepo::init_at(&root.path().join("plain"));
        let err = guard(&unmarked.path().join(".git")).unwrap_err();
        assert_eq!(err.message, gitbolt_core::api::FIXTURE_ONLY);

        let elsewhere = tempfile::tempdir().unwrap();
        let outside = TestRepo::init_at(elsewhere.path());
        outside.mark_fixture();
        assert!(guard(&outside.path().join(".git")).is_err(), "a marker outside the root doesn't count");

        // A symlink inside the root that points out of it doesn't count either. (Unix: a folder
        // symlink; Windows needs privileges for one.)
        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(outside.root(), &link).unwrap();
            assert!(guard(&link.join("repo/.git")).is_err());
        }
        assert!(!root.path().join(FIXTURE_MARKER).exists());

        // A stray marker in the root itself doesn't authorise everything under it.
        std::fs::write(root.path().join(FIXTURE_MARKER), "").unwrap();
        assert!(guard(&unmarked.path().join(".git")).is_err(), "the root's own marker doesn't count");
    }

    #[tokio::test]
    async fn test_writes_reach_marked_fixtures_only() {
        let h = Harness::for_tests().await;
        let plain = TestRepo::new();
        let c = plain.commit("c");
        let id = h.api.dispatch(Request::OpenRepo { path: plain.path().display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32;
        let intent = || gitbolt_core::write::test_intents::TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c.clone()) };
        let wt = gitbolt_core::platform::fs::canonicalize(plain.path()).unwrap().display().to_string();
        let err = h.api.dispatch(Request::TestWrite { repo: id, worktree: wt.clone(), expect: Default::default(), intent: intent() }).await.unwrap_err();
        assert_eq!(err.message, gitbolt_core::api::FIXTURE_ONLY);
        plain.mark_fixture();
        h.api.dispatch(Request::TestWrite { repo: id, worktree: wt, expect: Default::default(), intent: intent() }).await.unwrap();
        assert_eq!(plain.git(&["rev-parse", "x"]), c);
    }

    /// A reset leaves no journal behind: the next test starts with nothing to undo.
    #[tokio::test]
    async fn reset_clears_the_journals_and_queues() {
        let h = Harness::for_tests().await;
        let r = TestRepo::new();
        let c = r.commit("c");
        r.mark_fixture();
        let id = h.api.dispatch(Request::OpenRepo { path: r.path().display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32;
        let wt = gitbolt_core::platform::fs::canonicalize(r.path()).unwrap().display().to_string();
        let intent = gitbolt_core::write::test_intents::TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c) };
        let res = h.api.dispatch(Request::TestWrite { repo: id, worktree: wt.clone(), expect: Default::default(), intent }).await.unwrap();
        assert!(res["journal"]["undo"].is_object());
        h.reset();
        let noop = gitbolt_core::write::test_intents::TestIntent::Sleep { label: "noop".into(), ms: 0, fail: false };
        let res = h.api.dispatch(Request::TestWrite { repo: id, worktree: wt, expect: Default::default(), intent: noop }).await.unwrap();
        assert!(res["journal"]["undo"].is_null(), "{res}");
    }
}

// --- 4B T16: a forge account without the Settings form (4A's spec covers the form) ---
#[derive(serde::Deserialize)]
struct TestForgeAccount {
    host: String,
    kind: gitbolt_core::forge::ForgeKind,
    token: String,
}

impl Harness {
    /// The app's own `addForgeAccount` (tests only: the fake forge's tokens).
    pub async fn add_forge_account_for_test(&self, host: &str, kind: gitbolt_core::forge::ForgeKind, token: &str) -> Result<serde_json::Value, GbError> {
        self.api.dispatch(Request::AddForgeAccount { host: host.to_string(), kind, token: gitbolt_core::redact::Secret::new(token) }).await
    }
}

async fn test_forge_account(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(b): Json<TestForgeAccount>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match h.add_forge_account_for_test(&b.host, b.kind, &b.token).await {
        Ok(v) => Json(serde_json::json!({ "ok": v })).into_response(),
        Err(e) => Json(serde_json::json!({ "err": e })).into_response(),
    }
}
// --- end 4B T16 ---
