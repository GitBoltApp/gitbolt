#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gitbolt_core::api::{Api, Request};
use gitbolt_core::avatar::AvatarProvider;
use gitbolt_core::error::GbError;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_forge::gravatar::{Gravatar, DEFAULT_BASE_URL};
use std::sync::Arc;
use tauri::WebviewWindowBuilder;
use tauri_runtime_cef::Cef;

#[tauri::command]
async fn api(state: tauri::State<'_, Arc<Api>>, req: Request) -> Result<serde_json::Value, GbError> {
    state.dispatch(req).await
}

/// The app's `Api`: links open in the default browser, and avatars come from Gravatar with a
/// disk cache in `~/.cache/gitbolt/avatars` (none when there's no cache directory).
fn build_api(cli: GitCli, launch: Option<String>) -> Api {
    let api = Api::new(cli, launch).with_url_opener(Arc::new(|url: &str| {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| GbError::other(format!("couldn't open {url}: {e}")))
    }));
    match dirs::cache_dir() {
        Some(cache) => api.with_avatars(Arc::new(Gravatar::new(cache.join("gitbolt").join("avatars"), DEFAULT_BASE_URL)) as Arc<dyn AvatarProvider>),
        None => api,
    }
}

/// Every CEF app is also its own renderer/GPU/utility process: this attribute runs the helper
/// side for any process Chromium launched with `--type=` and returns before the Tauri app is
/// built (required by `tauri-runtime-cef`; see its `examples/cef/src-tauri/src/main.rs`).
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .init();
    let launch = std::env::args().nth(1).or_else(|| std::env::var("GITBOLT_OPEN").ok());
    let cli = GitCli::new(Arc::new(CommandLog::new(1000)));
    tauri::Builder::default()
        .runtime(Cef::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(build_api(cli, launch)))
        .invoke_handler(tauri::generate_handler![api])
        // The CEF runtime's window isn't created from `tauri.conf.json`'s `app.windows` the way
        // wry's is; `tauri.conf.json` sets `create: false` on the main window, and it's built
        // here from that same config (matches the CEF spike's `src-tauri/src/main.rs`).
        .setup(|app| {
            let cfg = app.config().app.windows[0].clone();
            WebviewWindowBuilder::from_config(app.handle(), &cfg)?.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GitBolt");
}
