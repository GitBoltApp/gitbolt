//! Built fixtures, cached on disk: a test copies a repo instead of running the dozens of git
//! commands that build it (about 20 ms each on Windows).
//!
//! Each test is its own process (nextest), so the cache lives in the target dir,
//! `<target>/fixture-cache/<fixture>-<key>/`, found from the running binary (the folder with
//! cargo's `CACHEDIR.TAG`). Not `CARGO_TARGET_TMPDIR`: cargo sets it only for integration tests,
//! not for the unit tests or the harness's `fixture` command. `cargo clean` clears it.
//!
//! The key hashes the `testing` module's source (embedded at build time) and `git --version`, so
//! a changed fixture or git never reuses a stale entry. A fixture taking parameters would have
//! to put them in its name. An entry is built once, under a file lock, into a temp folder that's
//! then renamed into place: concurrent tests wait on the lock, never on a half-built entry.
//!
//! `GITBOLT_FIXTURE_CACHE=0` builds every fixture fresh (to debug one).

use super::{TestRepo, BASE_TIME};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::OnceLock;

/// What a fixture's result depends on besides git: this whole module.
const SOURCES: [&str; 5] = [include_str!("mod.rs"), include_str!("fixtures.rs"), include_str!("cache.rs"), include_str!("state.rs"), include_str!("write.rs")];

/// Larger files are copied as is: only git's small metadata files hold absolute paths.
const REWRITE_MAX: u64 = 1 << 20;

/// Makes `r` (just initialised, untouched) a copy of fixture `name`, building the cached entry
/// with `build` first when there's none. `false` when `r` should build it itself: the cache is
/// off or unavailable, `r` isn't fresh, or `r` is the cache's own build.
pub(super) fn restore(r: &TestRepo, name: &str, build: fn(&TestRepo)) -> bool {
    if r.building || !enabled() || !fresh(r) {
        return false;
    }
    let Some(dir) = cache_dir() else { return false };
    let entry = entry(&dir, name, build);
    let state = std::fs::read_to_string(entry.join("state")).expect("read the fixture's cached state");
    let mut lines = state.lines();
    let (Some(built_root), Some(clock), Some(counter)) = (lines.next(), lines.next(), lines.next()) else { panic!("bad fixture cache state in {}", entry.display()) };
    let to = std::path::absolute(&r.root).expect("absolute fixture root");
    let rewrites = rewrites(Path::new(built_root), &to);
    std::fs::remove_dir_all(&r.path).expect("remove the fresh repo");
    let mut work_trees = Vec::new();
    copy_tree(&entry.join("root"), &r.root, &rewrites, &mut work_trees).expect("copy the cached fixture");
    // The copy's files have new inodes and ctimes, which git would see as stat-dirty: refresh
    // each index once, as a fresh build's would be. Exit 1 only says some file really differs.
    for wt in &work_trees {
        let _ = r.try_git_in(wt, &["update-index", "-q", "--unmerged", "--ignore-missing", "--refresh"]);
    }
    r.clock.store(clock.parse().expect("cached clock"), Ordering::SeqCst);
    r.counter.store(counter.parse().expect("cached counter"), Ordering::SeqCst);
    true
}

fn enabled() -> bool {
    std::env::var_os("GITBOLT_FIXTURE_CACHE").is_none_or(|v| v != "0")
}

/// Fresh from `init_at`: one git call, no commit, and nothing else in its folders.
fn fresh(r: &TestRepo) -> bool {
    let only = |dir: &Path, name: &str| std::fs::read_dir(dir).is_ok_and(|d| d.map(|e| e.map(|e| e.file_name())).collect::<Result<Vec<_>, _>>().is_ok_and(|n| n == [name]));
    r.clock.load(Ordering::SeqCst) == BASE_TIME + 60 && r.counter.load(Ordering::SeqCst) == 0 && only(&r.root, "repo") && only(&r.path, ".git")
}

/// `<target>/fixture-cache`, or `None` outside a cargo target dir.
fn cache_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let target = exe.ancestors().find(|d| d.join("CACHEDIR.TAG").is_file())?;
        let dir = target.join("fixture-cache");
        std::fs::create_dir_all(&dir).ok()?;
        crate::platform::fs::canonicalize(dir).ok()
    })
    .clone()
}

/// 16 hex digits of SHA-256 over the sources and `git --version`.
fn key() -> &'static str {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| {
        let git = std::process::Command::new("git").arg("--version").output().expect("git --version");
        let mut h = Sha256::new();
        for s in SOURCES {
            h.update(s.as_bytes());
            h.update([0]);
        }
        h.update(&git.stdout);
        h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
    })
}

/// The complete entry for `name`, built first if missing.
fn entry(dir: &Path, name: &str, build: fn(&TestRepo)) -> PathBuf {
    let entry = dir.join(format!("{name}-{}", key()));
    if entry.is_dir() {
        return entry;
    }
    let lock = std::fs::File::create(dir.join(format!("{name}.lock"))).expect("create the fixture cache lock");
    lock.lock().expect("lock the fixture cache");
    if !entry.is_dir() {
        let tmp = tempfile::Builder::new().prefix(".build-").tempdir_in(dir).expect("fixture build dir");
        let root = tmp.path().join("root");
        let mut repo = TestRepo::init_at(&root);
        repo.building = true;
        build(&repo);
        let state = format!("{}\n{}\n{}\n", root.display(), repo.clock.load(Ordering::SeqCst), repo.counter.load(Ordering::SeqCst));
        std::fs::write(tmp.path().join("state"), state).expect("write the fixture's state");
        std::fs::rename(tmp.keep(), &entry).expect("move the fixture into the cache");
        prune(dir, name, &entry);
    }
    entry
}

/// Removes `name`'s entries for other keys (an older source or git), best effort.
fn prune(dir: &Path, name: &str, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let file_name = e.file_name();
        let Some(rest) = file_name.to_str().and_then(|n| n.strip_prefix(name)).and_then(|n| n.strip_prefix('-')) else { continue };
        if rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_hexdigit()) && e.path() != keep {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// The spellings of the build's root that git may have written (remote URLs, a linked
/// worktree's `gitdir`, a clone's reflog), each paired with the copy's. On Windows git writes
/// `C:/x` in its own files and `C:\\x` in config values set from a native path.
fn rewrites(from: &Path, to: &Path) -> Vec<(Vec<u8>, Vec<u8>)> {
    let native = |p: &Path| p.to_str().expect("utf-8 fixture path").to_string();
    let (from_s, to_s) = (native(from), native(to));
    let mut pairs = vec![
        (from_s.replace('\\', "\\\\"), to_s.replace('\\', "\\\\")),
        (from_s, to_s),
        (crate::platform::fs::to_git_path(from), crate::platform::fs::to_git_path(to)),
    ];
    pairs.sort();
    pairs.dedup();
    pairs.into_iter().map(|(a, b)| (a.into_bytes(), b.into_bytes())).collect()
}

/// Copies `from` into `to` (merging into an existing folder), with `rewrites` applied to every
/// small file. Collects the work trees (folders with a `.git`).
fn copy_tree(from: &Path, to: &Path, rewrites: &[(Vec<u8>, Vec<u8>)], work_trees: &mut Vec<PathBuf>) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        let meta = e.metadata()?;
        if e.file_name() == ".git" {
            work_trees.push(to.to_path_buf());
        }
        if meta.is_dir() {
            copy_tree(&src, &dst, rewrites, work_trees)?;
        } else if meta.len() > REWRITE_MAX {
            std::fs::copy(&src, &dst)?;
        } else {
            let bytes = std::fs::read(&src)?;
            match rewrite(&bytes, rewrites) {
                Some(new) => {
                    std::fs::write(&dst, new)?;
                    std::fs::set_permissions(&dst, meta.permissions())?;
                }
                None => {
                    std::fs::copy(&src, &dst)?;
                }
            }
        }
    }
    Ok(())
}

/// `bytes` with every `from` replaced by its `to`, or `None` when none occurs.
fn rewrite(bytes: &[u8], rewrites: &[(Vec<u8>, Vec<u8>)]) -> Option<Vec<u8>> {
    let mut out: Option<Vec<u8>> = None;
    for (from, to) in rewrites {
        let cur = out.as_deref().unwrap_or(bytes);
        let (mut next, mut rest) = (Vec::with_capacity(cur.len()), cur);
        while let Some(i) = rest.windows(from.len()).position(|w| w == from.as_slice()) {
            next.extend_from_slice(&rest[..i]);
            next.extend_from_slice(to);
            rest = &rest[i + from.len()..];
        }
        if rest.len() < cur.len() {
            next.extend_from_slice(rest);
            out = Some(next);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::fixtures;
    use crate::testing::state::RepoState;

    /// Everything a test could see of the fixture at `r`'s root, its own path spelled `<root>`:
    /// per work tree its stat-level changes (`diff-files`, before anything refreshes the index),
    /// status, config and state; every other repo's refs and config; TestRepo's clock and counter.
    fn observe(r: &TestRepo) -> Vec<String> {
        let root = r.root().display().to_string();
        let anon = |s: String| s.replace(&root.replace('\\', "\\\\"), "<root>").replace(&root, "<root>").replace(&crate::platform::fs::to_git_path(r.root()), "<root>");
        let mut seen = vec![format!("clock {} counter {}", r.clock.load(Ordering::SeqCst), r.counter.load(Ordering::SeqCst))];
        let worktrees = r.git(&["worktree", "list", "--porcelain"]);
        for wt in worktrees.lines().filter_map(|l| l.strip_prefix("worktree ")) {
            let wt = crate::platform::fs::from_git_path(wt);
            for args in [&["diff-files", "--name-status"][..], &["status", "--porcelain=v2", "--branch"], &["config", "--list", "--local"]] {
                seen.push(anon(r.try_git_in(&wt, args).unwrap_or_else(|e| e)));
            }
            seen.push(anon(format!("{:?}", RepoState::capture_at(r, &wt))));
        }
        seen.push(anon(worktrees));
        let mut top: Vec<_> = std::fs::read_dir(r.root()).unwrap().map(|e| e.unwrap().path()).collect();
        top.sort();
        for dir in top {
            seen.push(anon(dir.display().to_string()));
            if dir.join(".git").exists() || dir.join("HEAD").is_file() {
                seen.push(anon(r.git_in(&dir, &["for-each-ref"])));
                seen.push(anon(r.git_in(&dir, &["config", "--list", "--local"])));
            }
        }
        seen
    }

    /// A copy from the cache is what a fresh build makes.
    fn same_as_fresh(name: &str, build: fn(&TestRepo)) {
        let copy = TestRepo::new();
        if !restore(&copy, name, build) {
            assert!(!enabled() || cache_dir().is_none(), "{name} should come from the cache");
            return;
        }
        let mut fresh = TestRepo::new();
        fresh.building = true;
        build(&fresh);
        assert_eq!(observe(&copy), observe(&fresh), "{name}");
    }

    #[test]
    fn a_cached_basic_is_a_fresh_one_worktree_origin_and_stash_included() {
        same_as_fresh("basic", fixtures::basic);
    }

    #[test]
    fn a_cached_sync_is_a_fresh_one_clone_and_origin_hook_included() {
        same_as_fresh("sync", fixtures::sync);
    }

    #[test]
    fn a_cached_details_is_a_fresh_one_big_file_included() {
        same_as_fresh("details", fixtures::details);
    }

    #[test]
    fn a_cached_wip_conflict_is_still_mid_merge() {
        same_as_fresh("wip_conflict", fixtures::wip_conflict);
    }

    #[test]
    fn a_cached_wip_crlf_keeps_its_line_endings() {
        same_as_fresh("wip_crlf", fixtures::wip_crlf);
    }

    #[test]
    fn a_used_repo_builds_its_fixture_itself() {
        let r = TestRepo::new();
        r.git(&["config", "user.name", "Grace Hopper"]);
        assert!(!restore(&r, "basic", fixtures::basic));
    }

    #[test]
    fn rewrite_replaces_every_spelling_and_nothing_else() {
        let pairs = vec![(b"/old/root".to_vec(), b"/new/longer/root".to_vec()), (b"C:\\\\old".to_vec(), b"D:\\\\new".to_vec())];
        let text = b"gitdir: /old/root/repo/.git\nurl = C:\\\\old\\\\origin.git /old/root\n";
        assert_eq!(rewrite(text, &pairs).unwrap(), b"gitdir: /new/longer/root/repo/.git\nurl = D:\\\\new\\\\origin.git /new/longer/root\n");
        assert_eq!(rewrite(b"nothing here", &pairs), None);
    }
}
