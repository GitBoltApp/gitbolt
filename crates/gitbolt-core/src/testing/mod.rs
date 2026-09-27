//! Deterministic throwaway git repositories for tests and harness fixtures.

pub mod fixtures;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};

/// 2026-01-01T00:00:00Z. Every git call advances the clock by 60 s.
pub const BASE_TIME: i64 = 1_767_225_600;

/// Environment that isolates git from the developer's configuration.
pub fn isolated_git_env() -> Vec<(OsString, OsString)> {
    [
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_AUTHOR_NAME", "Ada Lovelace"),
        ("GIT_AUTHOR_EMAIL", "ada@example.com"),
        ("GIT_COMMITTER_NAME", "Ada Lovelace"),
        ("GIT_COMMITTER_EMAIL", "ada@example.com"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("LC_ALL", "C"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}

pub struct TestRepo {
    _tmp: Option<tempfile::TempDir>,
    root: PathBuf,
    path: PathBuf,
    clock: AtomicI64,
    counter: AtomicI64,
}

impl TestRepo {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut repo = Self::init_at(tmp.path());
        repo._tmp = Some(tmp);
        repo
    }

    pub fn init_at(root: &Path) -> Self {
        let path = root.join("repo");
        std::fs::create_dir_all(&path).expect("create repo dir");
        let repo = TestRepo {
            _tmp: None,
            root: root.to_path_buf(),
            path,
            clock: AtomicI64::new(BASE_TIME),
            counter: AtomicI64::new(0),
        };
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn set_clock(&self, unix: i64) {
        self.clock.store(unix, Ordering::SeqCst);
    }

    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.path, args)
    }

    pub fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        match self.run(dir, args) {
            Ok(out) => out,
            Err(e) => panic!("git {args:?} failed: {e}"),
        }
    }

    pub fn try_git(&self, args: &[&str]) -> Result<String, String> {
        self.run(&self.path, args)
    }

    fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let t = self.clock.fetch_add(60, Ordering::SeqCst);
        let date = format!("@{t} +0000");
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
            .args(args)
            .envs(isolated_git_env())
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }

    pub fn write(&self, rel: &str, content: &str) {
        self.write_bytes(rel, content.as_bytes());
    }

    pub fn write_bytes(&self, rel: &str, bytes: &[u8]) {
        let p = self.path.join(rel);
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).expect("create parent dir");
        }
        std::fs::write(p, bytes).expect("write file");
    }

    pub fn commit(&self, msg: &str) -> String {
        self.commit_as(msg, "Ada Lovelace", "ada@example.com")
    }

    pub fn commit_as(&self, msg: &str, name: &str, email: &str) -> String {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        let file = format!("file_{n}.txt");
        self.write(&file, &format!("content {n}\n"));
        self.git(&["add", "--", &file]);
        let author = format!("{name} <{email}>");
        self.git(&["commit", "-q", "--author", &author, "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }

    pub fn switch_new(&self, branch: &str) {
        self.git(&["switch", "-q", "-c", branch]);
    }

    pub fn switch(&self, branch: &str) {
        self.git(&["switch", "-q", branch]);
    }

    pub fn merge(&self, branch: &str, msg: &str) -> String {
        self.git(&["merge", "-q", "--no-ff", "-m", msg, branch]);
        self.git(&["rev-parse", "HEAD"])
    }

    pub fn tag(&self, name: &str, target: &str) {
        self.git(&["tag", "-a", "-m", name, name, target]);
    }

    pub fn add_origin(&self) -> PathBuf {
        let origin = self.root.join("origin.git");
        let origin_s = origin.to_str().expect("utf-8 path");
        self.git_in(&self.root, &["init", "-q", "--bare", "-b", "main", origin_s]);
        self.git(&["remote", "add", "origin", origin_s]);
        origin
    }

    pub fn push(&self, branch: &str) {
        self.git(&["push", "-q", "-u", "origin", branch]);
    }

    /// Modifies the tracked `file_0.txt` and stashes it (requires at least one commit).
    pub fn stash(&self, msg: &str) {
        self.write("file_0.txt", "stashed change\n");
        self.git(&["stash", "push", "-q", "-m", msg]);
    }

    pub fn add_worktree(&self, name: &str, branch: &str) -> PathBuf {
        let p = self.root.join(format!("wt-{name}"));
        self.git(&["worktree", "add", "-q", p.to_str().expect("utf-8 path"), branch]);
        p
    }
}

impl Default for TestRepo {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_returns_full_sha() {
        let r = TestRepo::new();
        let sha = r.commit("first");
        assert_eq!(sha.len(), 40);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn histories_are_reproducible() {
        let a = TestRepo::new();
        let b = TestRepo::new();
        for r in [&a, &b] {
            r.commit("one");
            r.commit_as("two", "Grace Hopper", "grace@example.com");
        }
        assert_eq!(a.git(&["rev-parse", "HEAD"]), b.git(&["rev-parse", "HEAD"]));
    }

    #[test]
    fn basic_fixture_builds() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert!(r.root().join("wt-hotfix").is_dir());
        assert_eq!(r.git(&["stash", "list"]).lines().count(), 1);
        assert_eq!(r.git(&["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
    }
}
