//! Remove stale lock (spec #2 §14).
//!
//! An immediate write (Deviation 9): under the repository's write lock and the write guard, it
//! unlinks a worktree's `index.lock` only if it's still the file the error saw (same mtime,
//! inode and device) and no git process is running in the repository.

use crate::api::Api;
use crate::error::{GbError, GbErrorKind};
use crate::platform::fs::FileId;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The pid of a live process that may own the lock, if any: one with `lock` open (this also
/// catches libgit2-based tools), or a `git`/`git-*` process whose cwd or `GIT_DIR` is inside
/// `common_dir` or one of its worktrees. Reads `/proc`; a process we can't read (another user's)
/// is skipped, so this can't see those: the mtime/inode check and the user's confirmation remain.
/// macOS has no `/proc`: `lsof` answers the same questions, except `GIT_DIR`.
fn live_git_process(lock: &Path, common_dir: &Path) -> Option<u32> {
    let me = std::process::id();
    let worktrees = linked_worktree_roots(common_dir);
    let main_root = common_dir.parent().map(Path::to_path_buf);
    let inside = |p: &Path| p.starts_with(common_dir) || main_root.as_ref().is_some_and(|m| p.starts_with(m)) || worktrees.iter().any(|w| p.starts_with(w));
    #[cfg(target_os = "macos")]
    return lsof_git_process(lock, me, &inside);
    #[cfg(not(target_os = "macos"))]
    proc_git_process(lock, me, &inside)
}

#[cfg(not(target_os = "macos"))]
fn proc_git_process(lock: &Path, me: u32, inside: &dyn Fn(&Path) -> bool) -> Option<u32> {
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        if pid == me {
            continue;
        }
        let proc = entry.path();
        if let Ok(fds) = std::fs::read_dir(proc.join("fd")) {
            for fd in fds.flatten() {
                if std::fs::read_link(fd.path()).is_ok_and(|t| t == lock) {
                    return Some(pid);
                }
            }
        }
        let name = std::fs::read_to_string(proc.join("comm")).unwrap_or_default();
        let name = name.trim();
        if name != "git" && !name.starts_with("git-") {
            continue;
        }
        if std::fs::read_link(proc.join("cwd")).is_ok_and(|c| inside(&c)) {
            return Some(pid);
        }
        let env = std::fs::read(proc.join("environ")).unwrap_or_default();
        if env.split(|b| *b == 0).any(|kv| kv.strip_prefix(b"GIT_DIR=").is_some_and(|v| inside(Path::new(std::str::from_utf8(v).unwrap_or(""))))) {
            return Some(pid);
        }
    }
    None
}

/// `live_git_process` through `lsof`: a process with `lock` open, then a `git`/`git-*` process
/// whose cwd is inside the repository. No answer (no `lsof`, or it fails) is no process.
#[cfg(target_os = "macos")]
fn lsof_git_process(lock: &Path, me: u32, inside: &dyn Fn(&Path) -> bool) -> Option<u32> {
    let lsof = |args: &[&std::ffi::OsStr]| std::process::Command::new("/usr/sbin/lsof").args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    let holders = lsof(&["-w".as_ref(), "-t".as_ref(), "--".as_ref(), lock.as_os_str()]).unwrap_or_default();
    if let Some(pid) = holders.lines().filter_map(|l| l.trim().parse::<u32>().ok()).find(|p| *p != me) {
        return Some(pid);
    }
    // `-F pcn`: a `p<pid>` line, then its `c<command>` and its cwd's `n<path>`.
    let cwds = lsof(&["-w", "-a", "-c", "git", "-d", "cwd", "-F", "pcn"].map(std::ffi::OsStr::new)).unwrap_or_default();
    let (mut pid, mut git) = (None, false);
    for line in cwds.lines() {
        match line.split_at_checked(1) {
            Some(("p", v)) => (pid, git) = (v.parse::<u32>().ok().filter(|p| *p != me), false),
            Some(("c", v)) => git = v == "git" || v.starts_with("git-"),
            Some(("n", v)) if git && inside(Path::new(v)) => return pid,
            _ => {}
        }
    }
    None
}

/// The working directories of the linked worktrees (`<common>/worktrees/*/gitdir` names each `.git` file).
fn linked_worktree_roots(common_dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(common_dir.join("worktrees")) else { return Vec::new() };
    rd.flatten()
        .filter_map(|e| std::fs::read_to_string(e.path().join("gitdir")).ok())
        .filter_map(|g| Path::new(g.trim()).parent().map(Path::to_path_buf))
        .collect()
}

pub(crate) async fn remove_index_lock(api: &Api, repo: u32, path: &str, mtime_ms: i64, ino: u64, dev: u64) -> Result<(), GbError> {
    let h = api.handle(repo)?;
    api.check_write(&h.common_dir)?;
    let not_ours = || GbError::new(GbErrorKind::InvalidInput, "That isn't this repository's index lock");
    let lock = Path::new(path);
    if lock.file_name().is_none_or(|n| n != "index.lock") {
        return Err(not_ours());
    }
    let dir = match lock.parent().map(crate::platform::fs::canonicalize) {
        Some(Ok(d)) => d,
        // The directory is gone, so is the lock.
        Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        _ => return Err(not_ours()),
    };
    // Both sides canonical, so a symlinked repository path compares equal. The main worktree's
    // git dir is the common dir; a linked one's is `<common>/worktrees/<name>`.
    let common = crate::platform::fs::canonicalize(&h.common_dir).unwrap_or_else(|_| h.common_dir.clone());
    let ours = dir == common || dir.parent() == Some(common.join("worktrees").as_path());
    if !ours {
        return Err(not_ours());
    }
    let writes = api.repo_writes(&h);
    let _lock = writes.lock.lock().await;
    let lock = dir.join("index.lock");
    let meta = match std::fs::symlink_metadata(&lock) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let now = meta.modified()?.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(-1);
    if !meta.is_file() || now != mtime_ms || FileId::of_path(&lock).ok() != Some(FileId { dev, ino }) {
        return Err(GbError::stale("index.lock changed since the error; it wasn't removed"));
    }
    let (probe_lock, probe_common) = (lock.clone(), common.clone());
    let running = tokio::task::spawn_blocking(move || live_git_process(&probe_lock, &probe_common)).await.map_err(|e| GbError::other(e.to_string()))?;
    if let Some(pid) = running {
        return Err(GbError::new(GbErrorKind::IndexLocked, format!("a git process (pid {pid}) is still running in this repository")));
    }
    std::fs::remove_file(&lock)?;
    tracing::info!(target: "gitbolt_core::write", "removed a stale {}", lock.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Request;
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::sync::Arc;

    /// The lock's (mtime, ino, dev), as the error carries them.
    fn seen(p: &Path) -> (i64, u64, u64) {
        let m = std::fs::metadata(p).unwrap();
        let FileId { dev, ino } = FileId::of_path(p).unwrap();
        (m.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64, ino, dev)
    }

    fn new_api() -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None)
    }

    async fn open(api: &Api, path: &Path) -> u32 {
        api.dispatch(Request::OpenRepo { path: path.display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32
    }

    async fn setup() -> (TestRepo, Api, u32, PathBuf) {
        let r = TestRepo::new();
        r.commit("c");
        let api = new_api();
        let id = open(&api, r.path()).await;
        let lock = r.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        (r, api, id, lock)
    }

    async fn remove(api: &Api, id: u32, lock: &Path) -> Result<(), GbError> {
        let (m, i, d) = seen(lock);
        remove_index_lock(api, id, lock.to_str().unwrap(), m, i, d).await
    }

    #[tokio::test]
    async fn it_removes_the_lock_the_error_saw() {
        let (_r, api, id, lock) = setup().await;
        remove(&api, id, &lock).await.unwrap();
        assert!(!lock.exists());
        remove_index_lock(&api, id, lock.to_str().unwrap(), 0, 0, 0).await.unwrap();
    }

    #[tokio::test]
    async fn a_lock_that_changed_since_is_left_alone() {
        let (_r, api, id, lock) = setup().await;
        let (m, i, d) = seen(&lock);
        let err = remove_index_lock(&api, id, lock.to_str().unwrap(), m - 1000, i, d).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale);
        // Same mtime, another file (a replaced lock): also left alone.
        let err = remove_index_lock(&api, id, lock.to_str().unwrap(), m, i + 1, d).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale);
        assert!(lock.exists());
    }

    #[tokio::test]
    async fn only_this_repositorys_index_lock() {
        let (r, api, id, lock) = setup().await;
        let other = r.root().join("index.lock");
        std::fs::write(&other, "").unwrap();
        assert_eq!(remove(&api, id, &other).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        let head_lock = r.path().join(".git/HEAD.lock");
        std::fs::write(&head_lock, "").unwrap();
        assert_eq!(remove(&api, id, &head_lock).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert!(lock.exists() && other.exists() && head_lock.exists());
    }

    #[tokio::test]
    async fn the_write_guard_applies() {
        let (_r, api, id, lock) = setup().await;
        let api = api.with_write_guard(Arc::new(|_: &Path| Err(GbError::new(GbErrorKind::InvalidInput, crate::api::FIXTURE_ONLY))));
        assert!(remove(&api, id, &lock).await.is_err());
        assert!(lock.exists());
    }

    #[cfg(unix)] // finds lock holders through /proc (lsof on macOS)
    #[tokio::test]
    async fn a_process_holding_the_lock_open_blocks_removal() {
        let (_r, api, id, lock) = setup().await;
        let opened = lock.with_extension("opened");
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("exec 3<'{}'; : > '{}'; exec sleep 30", crate::platform::fs::to_git_path(&lock), crate::platform::fs::to_git_path(&opened)))
            .spawn()
            .unwrap();
        for _ in 0..200 {
            if opened.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let res = remove(&api, id, &lock).await;
        child.kill().unwrap();
        child.wait().unwrap();
        let err = res.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::IndexLocked);
        assert!(err.message.contains("is still running"), "{}", err.message);
        assert!(lock.exists());
        // With it gone, the lock goes.
        remove(&api, id, &lock).await.unwrap();
    }

    #[cfg(unix)] // a folder symlink
    #[tokio::test]
    async fn a_symlinked_repository_path_works() {
        let (r, _api, _id, lock) = setup().await;
        let link = r.root().join("link-to-repo");
        std::os::unix::fs::symlink(r.path(), &link).unwrap();
        let api = new_api();
        let id = open(&api, &link).await;
        remove(&api, id, &link.join(".git/index.lock")).await.unwrap();
        assert!(!lock.exists());
    }

    #[tokio::test]
    async fn a_linked_worktrees_index_lock() {
        let (r, api, id, _lock) = setup().await;
        let wt = r.root().join("wt");
        let out = std::process::Command::new("git").current_dir(r.path()).args(["worktree", "add", "-q", "-b", "side"]).arg(&wt).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let gitdir = std::fs::read_dir(r.path().join(".git/worktrees")).unwrap().next().unwrap().unwrap().path();
        let wlock = gitdir.join("index.lock");
        std::fs::write(&wlock, "").unwrap();
        remove(&api, id, &wlock).await.unwrap();
        assert!(!wlock.exists());
    }
}
