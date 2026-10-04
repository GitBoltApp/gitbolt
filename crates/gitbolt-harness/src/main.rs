use gitbolt_core::testing::{fixtures, TestRepo, FIXTURE_MARKER};
use std::path::{Path, PathBuf};
use tracing_subscriber::EnvFilter;

fn main() {
    // First: when git runs this binary as GIT_ASKPASS (spec §5.4), it only asks the running
    // harness over its socket and exits, before any runtime or logging starts.
    if let Some(code) = gitbolt_core::askpass::run_client_from_env() {
        std::process::exit(code);
    }
    harness_main();
}

#[tokio::main]
async fn harness_main() {
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
            // See `Harness::new`: fake openers, recorded launches, a logging URL opener, no
            // avatars, a temporary open-in cache.
            let config_dir = args.iter().position(|a| a == "--config-dir").and_then(|i| args.get(i + 1)).map(PathBuf::from);
            let fixture_root = args.iter().position(|a| a == "--fixture-root").and_then(|i| args.get(i + 1)).map(PathBuf::from);
            let harness = gitbolt_harness::Harness::new(gitbolt_harness::HarnessOptions { config_dir, fixture_root, ..Default::default() }).await;
            gitbolt_harness::serve(listener, harness).await;
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
                "merge_lock" => fixtures::merge_lock(&repo),
                "wip_staging" => fixtures::wip_staging(&repo),
                "wip_conflict" => fixtures::wip_conflict(&repo),
                "sync" => fixtures::sync(&repo),
                "conflicts" => fixtures::conflicts(&repo),
                "stack" => fixtures::stack(&repo),
                "rebase60" => fixtures::rebase60(&repo),
                "worktrees" => fixtures::worktrees(&repo),
                "irebase" => fixtures::irebase(&repo),
                "rebase_lab" => fixtures::rebase_lab(&repo),
                "file_history" => fixtures::file_history(&repo),
                other => panic!("unknown fixture {other}"),
            }
            std::fs::write(root.join(FIXTURE_MARKER), "").expect("write fixture marker");
            println!("{}", repo.path().display());
        }
        _ => {
            eprintln!("usage: gitbolt-harness serve [--port N] [--config-dir DIR] [--fixture-root DIR] | gitbolt-harness fixture <basic|unborn|long_labels|wide|details|long_history|diff_view|merge_lock|wip_staging|wip_conflict|sync|conflicts|stack|rebase60|worktrees|irebase|rebase_lab|file_history> <dir>");
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
