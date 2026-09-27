#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use std::sync::Arc;

#[tauri::command]
async fn api(state: tauri::State<'_, Arc<Api>>, req: Request) -> Result<serde_json::Value, GbError> {
    state.dispatch(req).await
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .init();
    let launch = std::env::args().nth(1).or_else(|| std::env::var("GITBOLT_OPEN").ok());
    let cli = GitCli::new(Arc::new(CommandLog::new(1000)));
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(Api::new(cli, launch)))
        .invoke_handler(tauri::generate_handler![api])
        .run(tauri::generate_context!())
        .expect("error while running GitBolt");
}
