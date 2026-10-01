//! Serves `Api::dispatch` over a WebSocket so Playwright can drive the real backend, and
//! forwards the backend's event bus on the same socket as `{"event": …}` frames.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::events::AppEvent;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_core::openers::{ArgStyle, ExecArg, LaunchCommand, Opener, OpenerKind};
use gitbolt_core::settings::SettingsStore;
use gitbolt_core::testing::isolated_git_env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::error::RecvError;
use axum::serve::ListenerExt;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

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
}

/// Everything one harness server owns: the `Api` it serves, its settings store and the
/// launches it recorded.
pub struct Harness {
    pub api: Arc<Api>,
    pub store: Arc<SettingsStore>,
    pub launches: Arc<Launches>,
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
    if me.file_name().is_some_and(|n| n == "gitbolt-harness") {
        return me;
    }
    me.ancestors().skip(1).take(2).map(|d| d.join("gitbolt-harness")).find(|p| p.is_file()).unwrap_or(me)
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
    /// `config_dir` or a fresh temp dir (never `~/.config`), no avatar provider (tests never
    /// touch the network), a URL opener that only logs (the UI's link buttons are checked by
    /// their data-url attribute instead), and fake openers whose "Open in…" launches are
    /// recorded (`GET /launches`) instead of run.
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
        let next_pick = picks.clone();
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None)
            .with_url_opener(Arc::new(|url: &str| {
                tracing::info!("openUrl {url}");
                Ok(())
            }))
            .with_open_cache(open_cache.path().to_path_buf())
            .with_folder_picker(Arc::new(move |_start: Option<&std::path::Path>| next_pick.next()))
            .with_home(Some(home.clone()))
            .with_store(store.clone());
        let api = Arc::new(with_fake_openers(api, launches.clone()));
        // Askpass (spec §5.4), in the private temp dir: git runs `askpass_exe` (the harness binary
        // itself unless a test names one), which asks this server over its socket.
        let exe = opts.askpass_exe.unwrap_or_else(harness_exe);
        api.start_askpass(runtime_tmp.path(), exe).await.expect("askpass socket");
        Self { api, store, launches, picks, home, _config_tmp: config_tmp, _open_cache: open_cache, _runtime_tmp: runtime_tmp }
    }

    /// The harness's home (`suggestReposFolder` looks for `repos` in it).
    pub fn home(&self) -> &std::path::Path {
        &self.home
    }

    pub async fn for_tests() -> Self {
        Self::new(HarnessOptions::default()).await
    }

    /// `POST /test/reset`: the state a fresh app launch would see (default settings, with
    /// background fetch off, and one default profile), no recorded launches, no queued picks, no
    /// cached repo scans and no file watchers.
    pub fn reset(&self) {
        self.api.unwatch_all();
        self.store.reset();
        harness_defaults(&self.store);
        self.launches.clear();
        self.picks.clear();
        self.api.forget_scans();
    }
}

/// Routes: `GET /health`, `GET /launches`, `GET /ws` (requests, replies and event frames),
/// `POST /test/emit` (a JSON `AppEvent`, put on the bus), `POST /test/reset`,
/// `POST /test/next-pick` (`{"path": string | null}`: the folder picker's next answer),
/// `GET /test/watched` (the ids of the repos with a live file watcher, sorted), and
/// `ANY /test/auth/*` (a git remote that always answers 401).
pub async fn serve(listener: tokio::net::TcpListener, harness: Harness) {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/launches", get(|State(h): State<Arc<Harness>>| async move { Json(h.launches.all()) }))
        .route("/ws", get(ws))
        .route("/test/emit", post(test_emit))
        .route("/test/reset", post(test_reset))
        .route("/test/next-pick", post(test_next_pick))
        .route("/test/auth/{*rest}", any(test_auth))
        .route("/test/watched", get(test_watched))
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

async fn test_watched(State(h): State<Arc<Harness>>) -> Json<Vec<u32>> {
    Json(h.api.watched_repos())
}

async fn test_emit(State(h): State<Arc<Harness>>, headers: HeaderMap, Json(ev): Json<AppEvent>) -> Response {
    if foreign_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    h.api.events().emit(ev);
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
