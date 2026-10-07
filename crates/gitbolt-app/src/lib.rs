
use gitbolt_core::api::{Api, Request};
use gitbolt_core::avatar::AvatarProvider;
use gitbolt_core::error::GbError;
use gitbolt_core::events::TAURI_EVENT;
use gitbolt_core::git::GitCli;
use gitbolt_core::instance::{self, Claim};
use gitbolt_core::log::CommandLog;
use gitbolt_core::openers::chooser::system_chooser;
use gitbolt_core::openers::folder_picker::system_folder_picker;
use gitbolt_core::open_copy;
use gitbolt_core::paths;
use gitbolt_core::settings::SettingsStore;
use gitbolt_core::shellenv::ShellEnv;
use gitbolt_core::openers::{detect_system, spawn_detached_with, system_url_opener, ChildEnvHook, LaunchCommand, Launcher};
use gitbolt_forge::gravatar::{Gravatar, DEFAULT_BASE_URL};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, WebviewWindowBuilder};
use tauri_runtime_cef::Cef;
use tokio::sync::broadcast::error::RecvError;

mod desktop;
mod window_state;

#[tauri::command]
async fn api(state: tauri::State<'_, Arc<Api>>, req: Request) -> Result<serde_json::Value, GbError> {
    state.dispatch(req).await
}

// A release build of the app never contains the test-only API. `gitbolt-core`'s `testing`
// feature is the harness's, but a `cargo build --workspace --release` would unify it into this
// crate too: that build fails here instead of producing a binary with `/test/*` routes. Debug
// workspace builds (clippy, tests) are unaffected, and `just package` builds this crate alone.
const _: () = assert!(cfg!(debug_assertions) || !gitbolt_core::TESTING, "gitbolt-core's `testing` feature is on in a release build of gitbolt-app: build it alone (`cargo build -p gitbolt-app --release`, or `just package`)");

/// The app's `Api`: links open in the default browser, "Open in…" launches the editors and file
/// manager found on this machine (detached, argv only), and avatars come from Gravatar with a
/// disk cache in `~/.cache/gitbolt/avatars` (none when there's no cache directory). Old versions
/// opened in an editor are copied under `~/.cache/gitbolt/open` (spec §14.5).
///
/// `child_env` adjusts every child it starts: git, each opener launch, the chooser's `xdg-open`
/// fallback and the URL opener (`desktop::restore_child_env` in the app). An opener launch also
/// gets the login shell's environment, when `cli` has one captured (spec §5.3).
/// This build's version: a `just package` build's stamped one (`GITBOLT_BUILD_VERSION`,
/// `0.2.0+202610072046.d1d4d7d`), else Cargo.toml's.
const APP_VERSION: &str = match option_env!("GITBOLT_BUILD_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

/// Quits the app once the window exists (set in `setup`): what an installer that replaces the
/// app, or Restart GitBolt, needs.
type QuitSlot = Arc<OnceLock<Box<dyn Fn() + Send + Sync>>>;

/// Updates from GitHub Releases (`gitbolt_core::updates`): downloads in the cache's `updates`
/// folder, the install kind from the `install-kind` file each package puts beside the binary
/// (`GitBolt.exe` on Windows, which loads this DLL); none: a build from source.
fn update_config(child_env: ChildEnvHook, quit: QuitSlot) -> gitbolt_core::updates::UpdateConfig {
    use gitbolt_core::updates::install::detect_install_kind;
    let exe = std::env::current_exe().ok();
    let kind = detect_install_kind(exe.as_deref().and_then(Path::parent));
    gitbolt_core::updates::UpdateConfig {
        source: Arc::new(gitbolt_forge::updates::GitHubReleases::github()),
        runner: Arc::new(gitbolt_core::updates::SystemRunner {
            hook: child_env,
            quit: Arc::new(move || match quit.get() {
                Some(quit) => quit(),
                None => tracing::warn!("asked to quit before the window exists"),
            }),
        }),
        dir: paths::cache_dir().join("updates"),
        kind,
        exe,
    }
}

fn build_api(cli: GitCli, launch: Option<String>, child_env: ChildEnvHook, quit: QuitSlot) -> Api {
    let shell_env = cli.shell_env().cloned();
    // `system_url_opener` (I2) routes through the same argv-only, detached launch and
    // `child_env` hook as an opener launch, so the browser gets the session's own
    // `GDK_BACKEND`/`IBUS_ENABLE_SYNC_MODE` back and never sees `CHROME_DEVEL_SANDBOX`.
    // `tauri_plugin_opener::open_url` (which bypasses that hook entirely) is only the fallback
    // for a platform `system_url_opener` doesn't cover yet.
    let url_opener = system_url_opener(child_env.clone()).unwrap_or_else(|| {
        Arc::new(|url: &str| tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| GbError::other(format!("couldn't open {url}: {e}"))))
    });
    let api = Api::new(cli.with_command_hook(child_env.clone()), launch)
        .with_app_version(APP_VERSION)
        .with_updates(update_config(child_env.clone(), quit))
        .with_data_dir(paths::data_dir())
        .with_url_opener(url_opener)
        .with_openers(Arc::new(detect_system), launcher(child_env.clone(), shell_env));
    let api = match system_chooser(child_env) {
        Some(chooser) => api.with_chooser(chooser),
        None => api,
    };
    match paths::cache_base() {
        Some(cache) => api
            .with_open_cache(cache.join("gitbolt").join("open"))
            .with_avatars(Arc::new(Gravatar::new(cache.join("gitbolt").join("avatars"), DEFAULT_BASE_URL)) as Arc<dyn AvatarProvider>)
            // --- 4A T10: forge accounts (spec #4 §3.2): the system keyring, else the 0600 file ---
            .with_forge(
                Arc::new(gitbolt_forge::connector::Forge::new(gitbolt_forge::connector::ForgeConfig { overrides: Default::default(), only_overrides: false, avatar_dir: Some(cache.join("gitbolt").join("forge-avatars")) })),
                Arc::new(gitbolt_forge::tokens::SystemTokenStore::system(paths::data_dir().join("forge-tokens"))),
            ),
            // --- end 4A T10 ---
        None => api.with_forge(
            Arc::new(gitbolt_forge::connector::Forge::new(gitbolt_forge::connector::ForgeConfig { overrides: Default::default(), only_overrides: false, avatar_dir: None })),
            Arc::new(gitbolt_forge::tokens::SystemTokenStore::system(paths::data_dir().join("forge-tokens"))),
        ),
    }
}

/// "Open in…"'s launcher: detached, argv only, with `child_env`'s environment (so an editor
/// doesn't start under XWayland or with the app's IBus sync mode). With a captured login-shell
/// environment (spec §5.3: `SSH_AUTH_SOCK`, `PATH` additions), the editor starts from that one
/// instead of the app's, and `child_env` still runs last. The API awaits the capture before an
/// editor launch, so `captured()` has it by then (or it failed, and the app's own env is used).
fn launcher(child_env: ChildEnvHook, shell_env: Option<Arc<ShellEnv>>) -> Launcher {
    Arc::new(move |c: &LaunchCommand| {
        let captured = shell_env.as_ref().and_then(|s| s.captured());
        spawn_detached_with(c, &|cmd: &mut std::process::Command| {
            // The capture already left GitBolt's own variables (`PRIVATE_ENV`) out.
            if let Some(vars) = &captured {
                cmd.env_clear().envs(vars.iter().map(|(k, v)| (k, v)));
            }
            child_env(cmd);
        })
    })
}

/// The main window as the folder-picker portal's parent: `x11:<xid>` (the CEF runtime's window is
/// always X11), or `""` (no parent) if it has no X11 handle.
#[cfg(target_os = "linux")]
fn portal_parent<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> String {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().map(|h| h.as_raw()) {
        Ok(RawWindowHandle::Xlib(h)) => format!("x11:{:x}", h.window),
        Ok(RawWindowHandle::Xcb(h)) => format!("x11:{:x}", h.window.get()),
        _ => String::new(),
    }
}

/// The main window as the folder dialog's owner: `win32:<hwnd>` in hex, or `""` (no owner).
#[cfg(windows)]
fn portal_parent<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> String {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().map(|h| h.as_raw()) {
        Ok(RawWindowHandle::Win32(h)) => format!("win32:{:x}", h.hwnd.get()),
        _ => String::new(),
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn portal_parent<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> String {
    String::new()
}

/// Where the folder picker finds its parent window: set once the window exists.
type ParentWindow = Arc<OnceLock<Box<dyn Fn() -> String + Send + Sync>>>;

/// The process's early exits, in order (the CEF `--type=` helpers have already been sent away by
/// `main`'s attribute): git or ssh running this binary as askpass (`askpass`, `Some(exit code)`)
/// never reaches the single-instance check; then `claim` (R19): a later launch on the same
/// config dir has forwarded its path and exits 0. `Ok`: run, as the guarded first instance
/// (`Primary`), or unguarded (`GITBOLT_MULTI_INSTANCE`, or the guard couldn't be set up: the
/// reason, logged once logging is up).
fn startup(askpass: impl FnOnce() -> Option<i32>, claim: impl FnOnce() -> Claim) -> Result<Claim, i32> {
    if let Some(code) = askpass() {
        return Err(code);
    }
    match claim() {
        Claim::Forwarded => Err(0),
        run => Ok(run),
    }
}

/// A later launch's request (R19), after its path went to the UI (`openRequested`,
/// `ui/src/app/instance.ts`): the window comes back from the taskbar and to the front.
/// `set_focus` asks the window manager the way a pager does (the CEF runtime's `activate`), which
/// focus-stealing prevention lets through.
fn bring_to_front<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    for (what, done) in [("unminimize", window.unminimize()), ("show", window.show()), ("focus", window.set_focus())] {
        if let Err(e) = done {
            tracing::warn!("couldn't {what} the window for another launch: {e}");
        }
    }
}

/// The spell-check dictionary: Chromium's own en-US one, under the name Chromium 152 looks for
/// (docs/licensing.md has its source and license).
const DICTIONARY: &str = "en-US-10-1.bdic";

/// Where the dictionary is: `dictionaries/` beside the binary, where the packages install it
/// (`/usr/share/GitBolt/dictionaries/`, tauri.conf.json), or, in a debug build, this crate's
/// copy. None (a release build run from `target/`) leaves Chromium without one: no spell check.
fn bundled_dictionary(exe_dir: Option<&Path>) -> Option<PathBuf> {
    let beside = exe_dir.map(|dir| dir.join("dictionaries").join(DICTIONARY));
    let ours = cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("dictionaries").join(DICTIONARY));
    beside.into_iter().chain(ours).find(|path| path.is_file())
}

/// Every CEF app is also its own renderer/GPU/utility process: this attribute runs the helper
/// side for any process Chromium launched with `--type=` and returns before the Tauri app is
/// built (required by `tauri-runtime-cef`; see its `examples/cef/src-tauri/src/main.rs`).
/// The CEF runtime, minus the per-profile tweaks documented where it is built in `main`.
fn cef_runtime() -> Cef {
    let cef = Cef::default()
        .profile_preference("settings.a11y.caretbrowsing.enabled", false)
        .component_updates(false)
        // No Chromium requests to Google services (PRIVACY.md, "The embedded Chromium", lists
        // what an idle run sent before these). The webview only loads the app's own bundle and
        // never navigates, so none of them takes anything it uses.
        .command_line_arg("--disable-background-networking", None::<String>)
        .safe_browsing(false)
        // No preconnects or DNS prefetches (they reached a local server on port 80 for
        // `tauri.localhost`).
        .profile_preference_value("net.network_prediction_options", 2)
        .disable_features([
            // The secure-time queries (clients2.google.com/time).
            "NetworkTimeServiceQuerying",
            // The Translate ranker's model download (www.gstatic.com).
            "TranslateRankerQuery",
            "TranslateRankerEnforcement",
        ])
        // Chromium itself resolves no host name but `localhost` (the dev server), so whatever
        // else it would fetch on its own fails before any DNS query or connection: the spelling
        // dictionary (redirector.gvt1.com), Google account sign-in (accounts.google.com), the
        // omnibox's AI Mode check (www.google.com), which no preference turned off. The UI needs
        // no network: its bundle and IPC are custom schemes, and every remote image, avatar and
        // forge request goes through the Rust core, whose own network is untouched.
        .command_line_arg("--host-resolver-rules", Some("MAP * ~NOTFOUND, EXCLUDE localhost"))
        // Spell check, offline: English (US) only, from the dictionary the packages ship, which
        // the runtime copies into the profile's `Dictionaries/` before Chromium would download
        // it. "Enhanced" spell check (Google's spelling service) stays off.
        .profile_preference("browser.enable_spellchecking", true)
        .profile_preference_value("spellcheck.dictionaries", vec!["en-US"])
        .profile_preference("spellcheck.use_spelling_service", false);
    let exe = std::env::current_exe().ok();
    let cef = match bundled_dictionary(exe.as_deref().and_then(Path::parent)) {
        Some(dictionary) => cef.bundled_dictionary(dictionary),
        None => cef,
    };
    // Never run Chromium unsandboxed (spec §18). `Auto` drops the sandbox, with only a warning,
    // in an AppImage on a system with neither the setuid helper nor unprivileged user
    // namespaces; `Required` refuses to start there instead. Windows sandboxes only under CEF's
    // bootstrap (`RunWinMain` below): a release build refuses to start without it, as the
    // packages always ship the bootstrap; a debug build stays on `Auto`, so a plain
    // `gitbolt.exe` from `cargo build` still runs, unsandboxed with a warning.
    #[cfg(any(target_os = "linux", all(windows, not(debug_assertions))))]
    let cef = cef.sandbox(tauri_runtime_cef::SandboxPolicy::Required);
    // A throwaway instance's Chromium profile goes with its other folders (`GITBOLT_DEV_DIRS`,
    // debug builds only; paths.rs).
    let cef = match paths::dev_dirs() {
        Some(_) => cef.root_cache_path(paths::cache_dir().join("cef")),
        None => cef,
    };
    // Debug builds only: drive a dev build over the DevTools protocol (Playwright's
    // `connectOverCDP`, through an SSH tunnel from another machine). Compiled out of release
    // builds, where the runtime keeps the protocol server refused (SECURITY.md).
    #[cfg(debug_assertions)]
    let cef = match dev_cdp_port(std::env::var_os(DEV_CDP_PORT).as_deref()) {
        Some(port) => cef.remote_debugging(tauri_runtime_cef::RemoteDebugging::Port { port, allowed_origins: Vec::new() }),
        None => cef,
    };
    cef
}

/// The variable naming a debug build's DevTools protocol port (Chromium listens on 127.0.0.1).
#[cfg(debug_assertions)]
const DEV_CDP_PORT: &str = "GITBOLT_DEV_CDP_PORT";

/// [`DEV_CDP_PORT`]'s port: one Chromium accepts (1024 to 65535), else none.
#[cfg(debug_assertions)]
fn dev_cdp_port(value: Option<&std::ffi::OsStr>) -> Option<u16> {
    value?.to_str()?.trim().parse().ok().filter(|port| *port >= 1024)
}

/// The `gitbolt` binary's `main`; on Windows also the DLL entry points CEF's bootstrap calls
/// (`RunWinMain` below).
#[tauri_runtime_cef::cef_entry_point]
pub fn run() {
    // Very first (the attribute above has already sent CEF's own `--type=` helpers away): when
    // git or ssh runs this binary as GIT_ASKPASS/SSH_ASKPASS (spec §5.4), it only asks the
    // running app over the askpass socket and exits. Git passes the prompt, never `--type=`.
    // Then the single-instance guard (R19, keyed by the config dir): if GitBolt already runs on
    // it, this launch hands it its path and exits 0, before any thread, GTK or CEF.
    let launch = std::env::args().nth(1).or_else(|| std::env::var("GITBOLT_OPEN").ok());
    let (instance, unguarded) = match startup(gitbolt_core::askpass::run_client_from_env, || instance::claim_from_env(launch.as_deref())) {
        Ok(Claim::Primary(p)) => (Some(Arc::new(p)), None),
        Ok(Claim::Unguarded(why)) => (None, why),
        Ok(Claim::Forwarded) => unreachable!("startup exits on Forwarded"),
        Err(code) => std::process::exit(code),
    };
    let exit_instance = instance.clone();
    // First, before any thread and before GTK: the window's desktop identity (dock icon) and
    // the input method's key handling (Ctrl+C and friends reach the page). See desktop.rs.
    desktop::init();
    // Log files (spec §16.2): `~/.cache/gitbolt/logs`, daily, newest 7 kept; stderr too in debug builds.
    // A redacted copy on stdout in debug builds, and in any build run with RUST_LOG set.
    let console = cfg!(debug_assertions) || std::env::var_os("RUST_LOG").is_some_and(|v| !v.is_empty());
    let logging = gitbolt_core::logging::init(&gitbolt_core::logging::default_log_dir(), false, console);
    if let Err(e) = &logging {
        eprintln!("GitBolt: file logging unavailable: {e}");
        gitbolt_core::logging::init_console_fallback();
    }
    let (log_handle, log_guard) = match logging {
        Ok(l) => (Some(l.handle), Some(l.guard)),
        Err(_) => (None, None),
    };
    // Dropped on RunEvent::Exit so the last buffered lines reach the file.
    let log_guard = std::sync::Mutex::new(log_guard);
    if let Some(why) = unguarded {
        tracing::warn!("running without the single-instance guard: {why}");
    }
    // Every child (git, the editors, the file manager, xdg-open) gets the session's own
    // IBUS_ENABLE_SYNC_MODE / GDK_BACKEND, not the app's (desktop.rs).
    let child_env: ChildEnvHook = Arc::new(desktop::restore_child_env);
    // Spec §5.3: the login shell's environment, captured once (started in `setup`) through the
    // same hook, so the shell sees the session's variables, not CEF's. Git commands that start
    // before it's done wait for it (bounded by the 5 s capture timeout); so do editor launches.
    let shell_env = ShellEnv::from_login_shell_with_hook(child_env.clone());
    let cli = GitCli::new(Arc::new(CommandLog::new(1000))).with_shell_env(shell_env.clone());
    // Settings and profiles (spec §14.3): `~/.config/gitbolt`, written debounced and flushed
    // once more on exit.
    let store = SettingsStore::open(paths::config_dir());
    let exit_store = store.clone();
    // "Open Repository" (spec §13): the folder-picker portal, parented to the main window once
    // it exists (R2: no picker on a portal-less desktop; the UI falls back to a typed path).
    let parent: ParentWindow = Arc::default();
    let quit: QuitSlot = Arc::default();
    let quit_slot = quit.clone();
    let mut built = build_api(cli, launch, child_env, quit).with_runtime_info("tauri 3.0.0-alpha.4 · tauri-runtime-cef 3.0.0-alpha.5 (GitBolt patch: CEF #3002)");
    if let Some(h) = log_handle {
        built = built.with_log_handle(h);
    }
    let picker_parent = parent.clone();
    let built = match system_folder_picker(move || picker_parent.get().map(|f| f()).unwrap_or_default()) {
        Some(picker) => built.with_folder_picker(picker),
        None => built,
    };
    let window_store = store.clone();
    let backend = Arc::new(built.with_store(store));
    let warm = backend.clone();
    let forward = backend.clone();
    let exit_api = backend.clone();
    let exit_settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Tauri's own runtime (`tokio::runtime::Runtime::new()`), but with 8 MB worker stacks, not
    // 2 MB: a request's future is polled on a worker, and the write path's is deep in a debug
    // build. Leaked, as Tauri keeps its own for the process's life.
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(8 * 1024 * 1024).build().expect("the async runtime");
    tauri::async_runtime::set(Box::leak(Box::new(runtime)).handle().clone());
    tauri::Builder::default()
        // Never in caret-browsing mode, even if "Turn on" was once clicked in Chrome's F7
        // dialog (Chrome keeps it in the profile). The F7 command itself is blocked in the
        // vendored runtime (vendor/tauri-runtime-cef/GITBOLT-PATCH.md). Not `show_dialog=false`:
        // without the dialog, F7 would silently turn caret browsing on.
        //
        // K31: GitBolt never ships or checks for Chromium's own components (cert revocation
        // sets, CT log lists, download file-type policies) — it is a git client, not a browser,
        // and has no route to `update.googleapis.com` that matters to it. Left on, the updater
        // tries to memory-map a temp file every run and fails loudly under sandboxing
        // (`puffin/src/puffpatch.cc: Failed to create a temporary file for memory-mapping:
        // Operation not permitted`). `component_updates(false)` only adds
        // `--disable-component-update`; it doesn't touch any Chromium feature GitBolt's webview
        // uses (vendor/tauri-runtime-cef/GITBOLT-PATCH.md).
        .runtime(cef_runtime())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(backend)
        .invoke_handler(tauri::generate_handler![api])
        // The CEF runtime's window isn't created from `tauri.conf.json`'s `app.windows` the way
        // wry's is; `tauri.conf.json` sets `create: false` on the main window, and it's built
        // here from that same config (matches the CEF spike's `src-tauri/src/main.rs`).
        .setup(move |app| {
            // Every backend event goes to the webview as `gb:event` (spec §4.3).
            let handle = app.handle().clone();
            let mut events = forward.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(ev) => {
                            if let Err(e) = handle.emit(TAURI_EVENT, &ev) {
                                tracing::warn!("emit {TAURI_EVENT} failed: {e}");
                            }
                        }
                        Err(RecvError::Lagged(n)) => tracing::warn!("event forwarder lagged by {n} events"),
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            // Spec §5.4: the per-session askpass socket in $XDG_RUNTIME_DIR. Git runs this same
            // binary as askpass. Before the window exists, so no request can outrun it. Without
            // it the app still runs: a credential prompt then just fails (GIT_TERMINAL_PROMPT=0).
            let askpass = std::env::current_exe().and_then(|exe| Ok((paths::runtime_dir()?, exe)));
            match askpass {
                Ok((dir, exe)) => {
                    if let Err(e) = tauri::async_runtime::block_on(forward.start_askpass(&dir, exe)) {
                        tracing::warn!("askpass socket unavailable in {}: {e}; credential prompts will fail", dir.display());
                    }
                }
                Err(e) => tracing::warn!("askpass unavailable: {e}; credential prompts will fail"),
            }
            let cfg = app.config().app.windows[0].clone();
            // K46: the window opens where it was last (window_state.rs). The builder's position
            // and size are applied before the window is first mapped, so it never shows at the
            // default place first; maximizing waits until it's on screen, on the right monitor.
            let can_position = window_state::can_self_position_now();
            let saved = window_store.window();
            let available = app.available_monitors().unwrap_or_default();
            let primary = app.primary_monitor().ok().flatten();
            let (screens, primary) = window_state::screens(&available, primary.as_ref());
            let place = saved.as_ref().and_then(|g| window_state::placement(g, &screens, primary, can_position));
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
            if let Some(p) = &place {
                builder = builder.inner_size(p.size.0, p.size.1);
                if let Some((x, y)) = p.position {
                    builder = builder.position(x, y);
                }
            }
            let window = builder.build()?;
            if place.as_ref().is_some_and(|p| p.maximized)
                && let Err(e) = window.maximize()
            {
                tracing::warn!("couldn't maximize the restored window: {e}");
            }
            window_state::track(&window, window_store.clone(), can_position, (cfg.width, cfg.height));
            // R19: answer later launches now that there's a window to focus. One that came while
            // this instance was starting has been waiting in the socket, and is answered now
            // (and queued until the page takes it).
            if let Some(instance) = &instance {
                let (api, front) = (forward.clone(), window.clone());
                let serving = tauri::async_runtime::block_on(async move {
                    instance.serve(move |path| {
                        // Queued as well as announced, so a path forwarded before the page
                        // listens still opens (`takeOpenRequests` at boot). Only a folder: a
                        // stale or mistyped path just focuses the window.
                        match path {
                            Some(path) if std::path::Path::new(&path).is_dir() => api.request_open(path),
                            Some(path) => tracing::warn!("another launch asked to open {path:?}, which isn't a folder"),
                            None => {}
                        }
                        bring_to_front(&front);
                    })
                });
                if let Err(e) = serving {
                    tracing::warn!("single-instance socket unavailable: {e}; a later launch will wait, then start on its own");
                }
            }
            let _ = parent.set(Box::new(move || portal_parent(&window)));
            // An update's installer, or Restart GitBolt, quits the way closing the window does
            // (a running write gets its 3 s first).
            let exiting = app.handle().clone();
            let _ = quit_slot.set(Box::new(move || exiting.exit(0)));
            // The update check: shortly after startup, then daily (Settings › Updates).
            tauri::async_runtime::spawn(forward.update_checks());
            // Here, after the runtime's `set_var` (its SAFETY note: no other thread may read the
            // environment before it): capture the login shell's environment (spec §5.3), detect
            // the "Open in…" editors off the UI's path, so the first `listOpeners` answers from
            // the cache, and drop week-old copies of old versions.
            tauri::async_runtime::spawn(shell_env.clone().warm());
            tauri::async_runtime::spawn(async move {
                let _ = warm.dispatch(Request::ListOpeners).await;
            });
            if let Some(cache) = paths::cache_base() {
                std::thread::spawn(move || open_copy::clean(&cache.join("gitbolt").join("open"), open_copy::MAX_AGE));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building GitBolt")
        .run(move |app, event| {
            // A write still running at quit (a long hook, signing): up to 3 s to finish, then
            // it's cancelled (SIGTERM first, so git removes its locks) and the exit goes on.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event
                && !exit_settled.load(std::sync::atomic::Ordering::SeqCst)
                && exit_api.writes_running()
            {
                api.prevent_exit();
                let (backend, handle, settled) = (exit_api.clone(), app.clone(), exit_settled.clone());
                let code = code.unwrap_or(0);
                tauri::async_runtime::spawn(async move {
                    backend.settle_writes(std::time::Duration::from_secs(3)).await;
                    settled.store(true, std::sync::atomic::Ordering::SeqCst);
                    handle.exit(code);
                });
                return;
            }
            if let tauri::RunEvent::Exit = event {
                if let Err(e) = exit_store.flush_now() {
                    tracing::warn!("saving settings on exit failed: {e}");
                }
                // The socket file would otherwise stay behind in $XDG_RUNTIME_DIR.
                if let Some(askpass) = exit_api.askpass() {
                    askpass.close();
                }
                drop(log_guard.lock().expect("log guard poisoned").take());
                // Likewise the instance socket; the lock goes with the process.
                if let Some(instance) = &exit_instance {
                    instance.close();
                }
            }
        });
}

/// Windows' sandboxed build: CEF's `bootstrap.exe`, renamed `gitbolt.exe`, loads this crate
/// built as `gitbolt.dll` and calls this with the sandbox broker it made. Every process
/// (browser, renderers, GPU) starts here; the runtime passes the broker on to CEF.
///
/// # Safety
///
/// Called by the bootstrap only, with its own `sandbox_info`.
#[cfg(windows)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn RunWinMain(_instance: *mut std::ffi::c_void, _command_line: *const u16, _show: i32, sandbox_info: *mut std::ffi::c_void, _version: *const std::ffi::c_void) -> i32 {
    // SAFETY: the bootstrap's broker, valid for the life of the process.
    unsafe { tauri_runtime_cef::set_windows_sandbox_info(sandbox_info) };
    run();
    0
}

/// [`RunWinMain`] for `bootstrapc.exe`, the console host (a debug build's console output).
///
/// # Safety
///
/// Called by the bootstrap only, with its own `sandbox_info`.
#[cfg(windows)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn RunConsoleMain(_argc: i32, _argv: *const *const std::ffi::c_char, sandbox_info: *mut std::ffi::c_void, _version: *const std::ffi::c_void) -> i32 {
    // SAFETY: as in `RunWinMain`.
    unsafe { tauri_runtime_cef::set_windows_sandbox_info(sandbox_info) };
    run();
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::ffi::OsString;

    /// R19's order: an askpass invocation exits with the client's code and never reaches the
    /// instance check; a forwarding launch exits 0; unguarded (the escape hatch, or no guard
    /// possible) runs; the first instance runs guarded.
    #[test]
    fn askpass_comes_before_the_instance_check_and_a_forwarded_launch_exits_0() {
        let claimed = std::cell::Cell::new(false);
        let claim = || {
            claimed.set(true);
            Claim::Forwarded
        };
        assert_eq!(startup(|| Some(1), claim).err(), Some(1));
        assert!(!claimed.get(), "askpass mode never takes the instance check");
        assert_eq!(startup(|| None, claim).err(), Some(0));
        assert!(claimed.get());
        assert!(matches!(startup(|| None, || Claim::Unguarded(None)), Ok(Claim::Unguarded(None))));
        assert!(matches!(startup(|| None, || Claim::Unguarded(Some("no runtime dir".into()))), Ok(Claim::Unguarded(Some(_)))));
        let rt = std::env::temp_dir().join(format!("gitbolt-app-instance-{}", std::process::id()));
        std::fs::create_dir_all(&rt).unwrap();
        let first = startup(|| None, || instance::claim(&rt, &rt.join("cfg"), None));
        assert!(matches!(first, Ok(Claim::Primary(_))));
        drop(first);
        let _ = std::fs::remove_dir_all(&rt);
    }

    /// The embedded Chromium makes no requests to Google services of its own: what an idle run
    /// sent (secure time, the Translate ranker, preconnects) is off, it resolves no host name but
    /// `localhost` (which stops the spelling dictionary, account sign-in and AI Mode checks), and
    /// component updates, background networking and Safe Browsing are off. The webview only
    /// loads the app's own bundle.
    #[test]
    fn chromium_requests_to_google_services_are_off() {
        let cef = format!("{:?}", cef_runtime());
        for switch in ["\"--disable-component-update\", None", "\"--disable-background-networking\", None", "\"--host-resolver-rules\", Some(\"MAP * ~NOTFOUND, EXCLUDE localhost\")"] {
            assert!(cef.contains(switch), "{switch} in {cef}");
        }
        for pref in ["(\"safebrowsing.enabled\", Bool(false))", "(\"net.network_prediction_options\", Number(2))"] {
            assert!(cef.contains(pref), "{pref} in {cef}");
        }
        for feature in ["NetworkTimeServiceQuerying", "TranslateRankerQuery", "TranslateRankerEnforcement"] {
            assert!(cef.contains(&format!("\"{feature}\"")), "{feature} in {cef}");
        }
    }

    /// A debug build opens the DevTools protocol only on a valid port named by
    /// `GITBOLT_DEV_CDP_PORT`; without it, the runtime keeps the server refused.
    #[test]
    fn the_dev_cdp_port_needs_a_valid_port() {
        use std::ffi::OsStr;
        assert_eq!(dev_cdp_port(Some(OsStr::new("9333"))), Some(9333));
        assert_eq!(dev_cdp_port(Some(OsStr::new(" 9333\n"))), Some(9333));
        for bad in ["", "80", "0", "65536", "port", "-1"] {
            assert_eq!(dev_cdp_port(Some(OsStr::new(bad))), None, "{bad:?}");
        }
        assert_eq!(dev_cdp_port(None), None);
        let cef = format!("{:?}", cef_runtime());
        if std::env::var_os(DEV_CDP_PORT).is_none() {
            assert!(cef.contains("remote_debugging: Disabled"), "{cef}");
        }
    }

    /// Spell check works offline: the bundled en-US dictionary goes where Chromium looks for it
    /// (the runtime copies it before CEF starts), en-US is the language checked, and Chromium's
    /// "enhanced" spell check, which sends the text to Google, stays off.
    #[test]
    fn spell_check_uses_the_bundled_english_dictionary() {
        let cef = format!("{:?}", cef_runtime());
        let ours = Path::new(env!("CARGO_MANIFEST_DIR")).join("dictionaries").join(DICTIONARY);
        assert!(cef.contains(&format!("bundled_dictionaries: [{:?}]", ours)), "{ours:?} in {cef}");
        for pref in ["(\"spellcheck.dictionaries\", Array [String(\"en-US\")])", "(\"browser.enable_spellchecking\", Bool(true))", "(\"spellcheck.use_spelling_service\", Bool(false))"] {
            assert!(cef.contains(pref), "{pref} in {cef}");
        }
    }

    /// The file Chromium 152 asks for (`spellcheck_common.cc`: en-US is version 10-1), in its
    /// `.bdic` format.
    #[test]
    fn the_bundled_dictionary_is_chromiums_en_us_bdic() {
        assert_eq!(DICTIONARY, "en-US-10-1.bdic");
        let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("dictionaries").join(DICTIONARY)).unwrap();
        assert_eq!(&bytes[..4], b"BDic");
    }

    /// The packages put it in `dictionaries/` beside the binary (tauri.conf.json); a debug build
    /// falls back to this crate's copy, so `just dev` checks spelling too.
    #[test]
    fn the_dictionary_beside_the_binary_comes_first() {
        let dir = std::env::temp_dir().join(format!("gitbolt-app-dictionary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("dictionaries")).unwrap();
        let ours = Path::new(env!("CARGO_MANIFEST_DIR")).join("dictionaries").join(DICTIONARY);
        assert_eq!(bundled_dictionary(Some(&dir)), Some(ours.clone()), "none beside it: this crate's copy");
        assert_eq!(bundled_dictionary(None), Some(ours));
        std::fs::write(dir.join("dictionaries").join(DICTIONARY), b"BDic").unwrap();
        assert_eq!(bundled_dictionary(Some(&dir)), Some(dir.join("dictionaries").join(DICTIONARY)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// I2 regression: `OpenUrl` must go through `child_env`, the same hook an opener launch
    /// uses — not bypass it via `tauri_plugin_opener::open_url`, which left the browser with the
    /// app's own `GDK_BACKEND=x11`/`IBUS_ENABLE_SYNC_MODE`. `build_api` prefers
    /// `system_url_opener` (routed through the hook) over that fallback whenever `xdg-open` is on
    /// `PATH`, so a fake one here proves the wiring end to end through `Api::dispatch`.
    #[cfg(target_os = "linux")] // xdg-open, as a `#!/bin/sh` fake
    #[tokio::test]
    async fn open_url_goes_through_the_child_env_hook() {
        let dir = std::env::temp_dir().join(format!("gitbolt-app-openurl-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let out = bin.join("out");
        std::fs::write(bin.join("xdg-open"), format!("#!/bin/sh\nprintf '%s|%s' \"$1\" \"${{GDK_BACKEND-unset}}\" > '{}'\n", out.display())).unwrap();
        gitbolt_core::platform::fs::set_mode(bin.join("xdg-open"), 0o755).unwrap();

        let session = desktop::EnvSnapshot::capture(|k| (k == "GDK_BACKEND").then(|| OsString::from("wayland")));
        let hook: ChildEnvHook = Arc::new(move |c: &mut std::process::Command| {
            // What the app's own process has, which a child inherits unless the hook resets it.
            c.env("GDK_BACKEND", "x11").env("IBUS_ENABLE_SYNC_MODE", "1");
            session.apply(c);
        });

        let real_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![bin.clone()];
        paths.extend(std::env::split_paths(&real_path));
        let with_fake_xdg_open = std::env::join_paths(paths).unwrap();
        // SAFETY: single-threaded at this point in the test (no other test in this binary reads
        // or spawns a PATH-relative child concurrently); restored immediately below, before
        // `dispatch` runs anything.
        unsafe { std::env::set_var("PATH", &with_fake_xdg_open) };
        let api = build_api(GitCli::new(Arc::new(CommandLog::new(10))), None, hook, QuitSlot::default());
        unsafe { std::env::set_var("PATH", &real_path) };

        api.dispatch(Request::OpenUrl { url: "https://example.com/x".into() }).await.unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut got = String::new();
        while std::time::Instant::now() < deadline {
            got = std::fs::read_to_string(&out).unwrap_or_default();
            if got.contains('|') {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(got, "https://example.com/x|wayland", "the URL and the session's own GDK_BACKEND, not the app's x11");
    }

    /// A real launch through "Open in…"'s launcher runs with the hook's environment: here the
    /// session's `GDK_BACKEND=wayland` back and the app's `IBUS_ENABLE_SYNC_MODE` gone, as
    /// `desktop::restore_child_env` does after `desktop::init`.
    #[cfg(unix)] // /bin/sh as the launched program
    #[test]
    fn an_opener_launch_gets_the_sessions_own_environment_back() {
        let session = desktop::EnvSnapshot::capture(|k| (k == "GDK_BACKEND").then(|| OsString::from("wayland")));
        let hook: ChildEnvHook = Arc::new(move |c: &mut std::process::Command| {
            // What the app's own process has, which a child inherits unless the hook resets it.
            c.env("GDK_BACKEND", "x11").env("IBUS_ENABLE_SYNC_MODE", "1");
            session.apply(c);
        });
        let dir = std::env::temp_dir().join(format!("gitbolt-app-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("env");
        let script = format!("printf '%s|%s' \"${{GDK_BACKEND-unset}}\" \"${{IBUS_ENABLE_SYNC_MODE-unset}}\" > '{}'", out.display());
        launcher(hook, None)(&LaunchCommand { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()] }).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut got = String::new();
        while std::time::Instant::now() < deadline {
            got = std::fs::read_to_string(&out).unwrap_or_default();
            if got.contains('|') {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(got, "wayland|unset");
    }

    /// Spec §5.3: with a captured login-shell environment, an editor starts from it (the app's
    /// own variables are gone), and the hook still runs last (the session's `GDK_BACKEND`).
    #[cfg(unix)] // /bin/sh as the launched program
    #[tokio::test]
    async fn an_opener_launch_starts_from_the_login_shells_environment() {
        let session = desktop::EnvSnapshot::capture(|k| (k == "GDK_BACKEND").then(|| OsString::from("wayland")));
        let hook: ChildEnvHook = Arc::new(move |c: &mut std::process::Command| session.apply(c));
        let shell = ShellEnv::fixed(vec![
            ("GB_FROM_LOGIN".into(), "yes".into()),
            ("GDK_BACKEND".into(), "x11".into()),
            ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
        ]);
        // What an Api does before an editor launch: wait for the capture.
        assert!(shell.get().await.is_some());
        let dir = std::env::temp_dir().join(format!("gitbolt-app-login-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("env");
        let script = format!("printf '%s|%s|%s' \"${{GB_FROM_LOGIN-unset}}\" \"${{GDK_BACKEND-unset}}\" \"${{CARGO_PKG_NAME-unset}}\" > '{}'", out.display());
        launcher(hook, Some(shell))(&LaunchCommand { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()] }).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut got = String::new();
        while std::time::Instant::now() < deadline {
            got = std::fs::read_to_string(&out).unwrap_or_default();
            if got.matches('|').count() == 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(&dir);
        // CARGO_PKG_NAME is in this test's own environment (cargo sets it), not the login shell's.
        assert_eq!(got, "yes|wayland|unset");
    }
}
