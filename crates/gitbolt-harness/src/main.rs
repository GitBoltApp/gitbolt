use gitbolt_core::api::Api;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_core::testing::{fixtures, isolated_git_env, TestRepo};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

/// Written into a fixture's root directory once it has been built, so a later
/// run recognizes the directory as safe to blow away and rebuild.
const FIXTURE_MARKER: &str = ".gitbolt-fixture";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => {
            let port: u16 = args.iter().position(|a| a == "--port").and_then(|i| args.get(i + 1)).and_then(|p| p.parse().ok()).unwrap_or(7433);
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind harness port");
            eprintln!("gitbolt-harness listening on ws://127.0.0.1:{port}/ws");
            // No avatar provider (tests never touch the network) and a URL opener that only
            // logs: the UI's link buttons are checked by their data-url attribute instead.
            // "Open in…" lists fake openers and records launches (GET /launches) without
            // running anything.
            // Old versions are copied into a temporary directory that lives as long as the server.
            let launches = Arc::new(gitbolt_harness::Launches::default());
            let open_cache = tempfile::tempdir().expect("open-in cache");
            let api = Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None)
                .with_url_opener(Arc::new(|url: &str| {
                    tracing::info!("openUrl {url}");
                    Ok(())
                }))
                .with_open_cache(open_cache.path().to_path_buf());
            let api = Arc::new(gitbolt_harness::with_fake_openers(api, launches.clone()));
            gitbolt_harness::serve_with_launches(listener, api, launches).await;
        }
        Some("fixture") if args.len() == 3 => {
            let root = PathBuf::from(&args[2]);
            if let Err(e) = prepare_fixture_root(&root) {
                eprintln!("{e}");
                std::process::exit(2);
            }
            let repo = TestRepo::init_at(&root);
            match args[1].as_str() {
                "basic" => fixtures::basic(&repo),
                "unborn" => fixtures::unborn(&repo),
                "long_labels" => fixtures::long_labels(&repo),
                "wide" => fixtures::wide(&repo),
                "details" => fixtures::details(&repo),
                "long_history" => fixtures::long_history(&repo),
                "diff_view" => fixtures::diff_view(&repo),
                other => panic!("unknown fixture {other}"),
            }
            std::fs::write(root.join(FIXTURE_MARKER), "").expect("write fixture marker");
            println!("{}", repo.path().display());
        }
        _ => {
            eprintln!("usage: gitbolt-harness serve [--port N] | gitbolt-harness fixture <basic|unborn|long_labels|wide|details|long_history|diff_view> <dir>");
            std::process::exit(2);
        }
    }
}

/// Makes `root` safe to (re)build a fixture into: leaves it alone if it
/// doesn't exist or is empty, wipes it if a previous fixture run marked it,
/// and otherwise refuses so we never `rm -rf` an unrelated directory.
fn prepare_fixture_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let mut entries = std::fs::read_dir(root).map_err(|e| format!("cannot read {}: {e}", root.display()))?;
    if entries.next().is_none() {
        return Ok(());
    }
    if root.join(FIXTURE_MARKER).exists() {
        return std::fs::remove_dir_all(root).map_err(|e| format!("cannot clear {}: {e}", root.display()));
    }
    Err(format!("refusing to clear {}: not empty and missing the {FIXTURE_MARKER} marker from a previous fixture run", root.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_directory_is_fine() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("does-not-exist-yet");
        assert!(prepare_fixture_root(&root).is_ok());
    }

    #[test]
    fn empty_directory_is_fine() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(prepare_fixture_root(tmp.path()).is_ok());
    }

    #[test]
    fn marked_directory_is_cleared() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(FIXTURE_MARKER), "").unwrap();
        std::fs::write(tmp.path().join("repo"), "leftover").unwrap();
        assert!(prepare_fixture_root(tmp.path()).is_ok());
        assert!(!tmp.path().exists(), "marked root should have been removed");
    }

    #[test]
    fn unmarked_nonempty_directory_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("important.txt"), "do not delete me").unwrap();
        let err = prepare_fixture_root(tmp.path()).unwrap_err();
        assert!(err.contains(FIXTURE_MARKER), "{err}");
        assert!(tmp.path().join("important.txt").exists(), "refusal must not touch the directory");
    }
}
