#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gitbolt_core::api::{Api, Request};
use gitbolt_core::avatar::AvatarProvider;
use gitbolt_core::error::GbError;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_core::openers::chooser::system_chooser;
use gitbolt_core::open_copy;
use gitbolt_core::openers::{detect_system, spawn_detached_with, system_url_opener, ChildEnvHook, LaunchCommand, Launcher};
use gitbolt_forge::gravatar::{Gravatar, DEFAULT_BASE_URL};
use std::sync::Arc;
use tauri::WebviewWindowBuilder;
use tauri_runtime_cef::Cef;

mod desktop;

#[tauri::command]
async fn api(state: tauri::State<'_, Arc<Api>>, req: Request) -> Result<serde_json::Value, GbError> {
    state.dispatch(req).await
}

/// The app's `Api`: links open in the default browser, "Open in…" launches the editors and file
/// manager found on this machine (detached, argv only), and avatars come from Gravatar with a
/// disk cache in `~/.cache/gitbolt/avatars` (none when there's no cache directory). Old versions
/// opened in an editor are copied under `~/.cache/gitbolt/open` (spec §14.5).
///
/// `child_env` adjusts every child it starts: git, each opener launch, the chooser's `xdg-open`
/// fallback and the URL opener (`desktop::restore_child_env` in the app).
fn build_api(cli: GitCli, launch: Option<String>, child_env: ChildEnvHook) -> Api {
    // `system_url_opener` (I2) routes through the same argv-only, detached launch and
    // `child_env` hook as an opener launch, so the browser gets the session's own
    // `GDK_BACKEND`/`IBUS_ENABLE_SYNC_MODE` back and never sees `CHROME_DEVEL_SANDBOX`.
    // `tauri_plugin_opener::open_url` (which bypasses that hook entirely) is only the fallback
    // for a platform `system_url_opener` doesn't cover yet.
    let url_opener = system_url_opener(child_env.clone()).unwrap_or_else(|| {
        Arc::new(|url: &str| tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| GbError::other(format!("couldn't open {url}: {e}"))))
    });
    let api = Api::new(cli.with_command_hook(child_env.clone()), launch)
        .with_url_opener(url_opener)
        .with_openers(Arc::new(detect_system), launcher(child_env.clone()));
    let api = match system_chooser(child_env) {
        Some(chooser) => api.with_chooser(chooser),
        None => api,
    };
    match dirs::cache_dir() {
        Some(cache) => api
            .with_open_cache(cache.join("gitbolt").join("open"))
            .with_avatars(Arc::new(Gravatar::new(cache.join("gitbolt").join("avatars"), DEFAULT_BASE_URL)) as Arc<dyn AvatarProvider>),
        None => api,
    }
}

/// "Open in…"'s launcher: detached, argv only, with `child_env`'s environment (so an editor
/// doesn't start under XWayland or with the app's IBus sync mode).
fn launcher(child_env: ChildEnvHook) -> Launcher {
    Arc::new(move |c: &LaunchCommand| spawn_detached_with(c, &*child_env))
}

/// Every CEF app is also its own renderer/GPU/utility process: this attribute runs the helper
/// side for any process Chromium launched with `--type=` and returns before the Tauri app is
/// built (required by `tauri-runtime-cef`; see its `examples/cef/src-tauri/src/main.rs`).
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    // First, before any thread and before GTK: the window's desktop identity (dock icon) and
    // the input method's key handling (Ctrl+C and friends reach the page). See desktop.rs.
    desktop::init();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .init();
    let launch = std::env::args().nth(1).or_else(|| std::env::var("GITBOLT_OPEN").ok());
    // Every child (git, the editors, the file manager, xdg-open) gets the session's own
    // IBUS_ENABLE_SYNC_MODE / GDK_BACKEND, not the app's (desktop.rs).
    let cli = GitCli::new(Arc::new(CommandLog::new(1000)));
    let backend = Arc::new(build_api(cli, launch, Arc::new(desktop::restore_child_env)));
    let warm = backend.clone();
    tauri::Builder::default()
        // Never in caret-browsing mode, even if "Turn on" was once clicked in Chrome's F7
        // dialog (Chrome keeps it in the profile). The F7 command itself is blocked in the
        // vendored runtime (vendor/tauri-runtime-cef/GITBOLT-PATCH.md). Not `show_dialog=false`:
        // without the dialog, F7 would silently turn caret browsing on.
        .runtime(Cef::default().profile_preference("settings.a11y.caretbrowsing.enabled", false))
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(backend)
        .invoke_handler(tauri::generate_handler![api])
        // The CEF runtime's window isn't created from `tauri.conf.json`'s `app.windows` the way
        // wry's is; `tauri.conf.json` sets `create: false` on the main window, and it's built
        // here from that same config (matches the CEF spike's `src-tauri/src/main.rs`).
        .setup(move |app| {
            let cfg = app.config().app.windows[0].clone();
            WebviewWindowBuilder::from_config(app.handle(), &cfg)?.build()?;
            // Here, after the runtime's `set_var` (its SAFETY note: no other thread may read the
            // environment before it): detect the "Open in…" editors off the UI's path, so the first
            // `listOpeners` answers from the cache, and drop week-old copies of old versions.
            tauri::async_runtime::spawn(async move {
                let _ = warm.dispatch(Request::ListOpeners).await;
            });
            if let Some(cache) = dirs::cache_dir() {
                std::thread::spawn(move || open_copy::clean(&cache.join("gitbolt").join("open"), open_copy::MAX_AGE));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GitBolt");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    /// I2 regression: `OpenUrl` must go through `child_env`, the same hook an opener launch
    /// uses — not bypass it via `tauri_plugin_opener::open_url`, which left the browser with the
    /// app's own `GDK_BACKEND=x11`/`IBUS_ENABLE_SYNC_MODE`. `build_api` prefers
    /// `system_url_opener` (routed through the hook) over that fallback whenever `xdg-open` is on
    /// `PATH`, so a fake one here proves the wiring end to end through `Api::dispatch`.
    #[tokio::test]
    async fn open_url_goes_through_the_child_env_hook() {
        let dir = std::env::temp_dir().join(format!("gitbolt-app-openurl-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let out = bin.join("out");
        std::fs::write(bin.join("xdg-open"), format!("#!/bin/sh\nprintf '%s|%s' \"$1\" \"${{GDK_BACKEND-unset}}\" > '{}'\n", out.display())).unwrap();
        std::fs::set_permissions(bin.join("xdg-open"), std::fs::Permissions::from_mode(0o755)).unwrap();

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
        let api = build_api(GitCli::new(Arc::new(CommandLog::new(10))), None, hook);
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
        launcher(hook)(&LaunchCommand { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()] }).unwrap();
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
}
