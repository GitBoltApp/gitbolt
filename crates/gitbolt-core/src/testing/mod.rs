//! Deterministic throwaway git repositories for tests and harness fixtures.

pub mod fixtures;
pub mod state;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};

/// 2026-01-01T00:00:00Z. Every git call advances the clock by 60 s.
pub const BASE_TIME: i64 = 1_767_225_600;

/// Environment that isolates git from the developer's configuration. This also covers SSH: a
/// test that signs or verifies an SSH signature (`ssh-keygen -Y sign`/`git`'s own verification)
/// must never reach the developer's real `ssh-agent`, so `SSH_AUTH_SOCK`/`SSH_AGENT_PID` are
/// overridden to a socket path that can't exist. `Command::envs` overrides an inherited variable
/// of the same name, so this is enough even though the child process still inherits everything
/// else from this one.
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
        ("SSH_AUTH_SOCK", "/nonexistent/gitbolt-test-no-ssh-agent"),
        ("SSH_AGENT_PID", ""),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}

/// `None` if this machine can actually verify SSH-signed commits: `ssh-keygen` supports `-Y sign`
/// (OpenSSH 8.2+, what git's own SSH signing uses) and git is new enough to understand
/// `gpg.format = ssh` (2.34+). Otherwise `Some(reason)`, to print before skipping a test cleanly
/// rather than failing it. Probed with obviously-missing files: an unsupported `-Y` is rejected by
/// getopt before it ever looks at them, while a supported one fails later, on the missing
/// key/file, so no real key is needed just to tell those two cases apart.
pub fn ssh_signing_unavailable() -> Option<&'static str> {
    if std::process::Command::new("ssh-keygen").arg("-?").output().is_err() {
        return Some("ssh-keygen not installed");
    }
    let probe = std::process::Command::new("ssh-keygen")
        .args(["-Y", "sign", "-f", "/nonexistent-gitbolt-probe-key", "-n", "git", "/nonexistent-gitbolt-probe-file"])
        .output();
    let unsupported_flag = match &probe {
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
            ["unknown option", "illegal option", "invalid option", "unknown command"].iter().any(|n| stderr.contains(n))
        }
        Err(_) => true,
    };
    if unsupported_flag {
        return Some("ssh-keygen doesn't support `-Y sign` (needs OpenSSH 8.2+)");
    }
    let git_new_enough = std::process::Command::new("git")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| crate::git::parse_version(&s))
        .is_some_and(|v| v >= (2, 34, 0));
    if !git_new_enough {
        return Some("git is too old for SSH commit signing (needs 2.34+)");
    }
    None
}

/// `None` if this machine has `gpg` to make throwaway keys and verify with them; otherwise
/// `Some(reason)`, to print before skipping a test cleanly.
pub fn gpg_signing_unavailable() -> Option<&'static str> {
    match std::process::Command::new("gpg").arg("--version").output() {
        Ok(out) if out.status.success() => None,
        _ => Some("gpg not installed"),
    }
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

    pub fn try_git_in(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        self.run(dir, args)
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

    /// Stages everything (`git add -A`) and commits it as the given author.
    pub fn commit_all_as(&self, msg: &str, name: &str, email: &str) -> String {
        self.git(&["add", "-A"]);
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

/// Written into a fixture's root directory. The harness's write guard (spec #2 §17.2) allows
/// writes only to repositories inside a marked directory, and `gitbolt-harness fixture` clears
/// only a marked directory.
pub const FIXTURE_MARKER: &str = ".gitbolt-fixture";

impl TestRepo {
    /// An executable `.git/hooks/<name>` running `script` (give it its own `#!/bin/sh` line).
    pub fn hook(&self, name: &str, script: &str) -> &Self {
        use std::os::unix::fs::PermissionsExt;
        let p = self.path.join(".git/hooks").join(name);
        std::fs::create_dir_all(p.parent().expect("hooks dir")).expect("create hooks dir");
        std::fs::write(&p, script).expect("write hook");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod hook");
        self
    }

    /// SSH commit signing (spec #2 §17.1), in this repo's own config: a throwaway ed25519 key
    /// (`ssh-keygen -N ''`), `gpg.format=ssh`, `commit.gpgsign=true`, `user.signingkey`, an
    /// allowed-signers file, and `gpg.ssh.program` = a wrapper that counts each `-Y sign` in
    /// `<root>/sign-count`, then runs `ssh-keygen`. `false` (with the reason printed) when this
    /// machine can't sign. TestRepo's own commits stay unsigned (`-c commit.gpgsign=false`).
    pub fn signing_ssh(&self) -> bool {
        use std::os::unix::fs::PermissionsExt;
        if let Some(why) = ssh_signing_unavailable() {
            eprintln!("skipping SSH signing: {why}");
            return false;
        }
        let key = self.root.join("signing_key");
        let made = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "ada@example.com", "-f"]).arg(&key).status().expect("ssh-keygen");
        assert!(made.success(), "ssh-keygen failed");
        let public = std::fs::read_to_string(key.with_extension("pub")).expect("public key");
        let allowed = self.root.join("allowed_signers");
        std::fs::write(&allowed, format!("ada@example.com {public}")).expect("allowed signers");
        let wrapper = self.root.join("count-sign");
        let counter = self.root.join("sign-count");
        std::fs::write(&wrapper, format!("#!/bin/sh\ncase \"$*\" in *\"-Y sign\"*) echo sign >> '{}';; esac\nexec ssh-keygen \"$@\"\n", counter.display())).expect("wrapper");
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod wrapper");
        for (k, v) in [
            ("gpg.format", "ssh".to_string()),
            ("commit.gpgsign", "true".to_string()),
            ("user.signingkey", key.display().to_string()),
            ("gpg.ssh.allowedSignersFile", allowed.display().to_string()),
            ("gpg.ssh.program", wrapper.display().to_string()),
        ] {
            self.git(&["config", k, &v]);
        }
        true
    }

    /// How many times the `signing_ssh` wrapper was asked to sign.
    pub fn sign_count(&self) -> usize {
        std::fs::read_to_string(self.root.join("sign-count")).map(|s| s.lines().count()).unwrap_or(0)
    }

    /// Marks this repo's root as a fixture (the harness write guard, spec #2 §17.2).
    pub fn mark_fixture(&self) -> &Self {
        std::fs::write(self.root.join(FIXTURE_MARKER), "").expect("write fixture marker");
        self
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

    #[test]
    fn details_fixture_builds() {
        let r = TestRepo::new();
        fixtures::details(&r);
        assert_eq!(r.git(&["rev-list", "--count", "HEAD"]), "4");
        assert_eq!(r.git(&["rev-list", "--parents", "-n1", "HEAD"]).split(' ').count(), 3, "HEAD is a merge");
        let status = r.git(&["status", "--porcelain"]);
        assert!(status.contains("M  src/app.php"), "{status}");
        assert!(status.contains(" M docs/manual.txt"), "{status}");
        assert!(status.contains("?? notes.txt"), "{status}");
        assert_eq!(r.git(&["remote", "get-url", "origin"]), "https://gitlab.example.com/group/project.git");
        assert!(std::fs::metadata(r.path().join("big.txt")).unwrap().len() > 2 * 1024 * 1024);
    }

    #[test]
    fn long_history_fixture_builds() {
        let r = TestRepo::new();
        fixtures::long_history(&r);
        assert_eq!(r.git(&["rev-list", "--count", "--no-merges", "HEAD"]), "60");
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Commit 59");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "HEAD~59"]), "Commit 00");
    }

    #[test]
    fn diff_view_fixture_builds() {
        let r = TestRepo::new();
        fixtures::diff_view(&r);
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Edit far down");
        let diff = r.git(&["diff", "HEAD~1", "HEAD", "--", "long.txt"]);
        assert!(diff.contains("@@ -117,7 +117,7 @@"), "first change at line 120: {diff}");
        assert!(diff.contains("-line 150\n-line 151\n-line 152\n"), "{diff}");
        assert!(diff.contains("+inserted line"), "{diff}");
        let mixed = r.git(&["diff", "HEAD~1", "HEAD", "--", "mixed.txt"]);
        assert!(mixed.contains("-long 050 "), "long deleted lines: {mixed}");
        assert!(mixed.contains("-    row 120\n") && mixed.contains("+\trow 120\n"), "re-indented block: {mixed}");
        assert!(r.git(&["diff", "-w", "HEAD~1", "HEAD", "--", "mixed.txt"]).lines().all(|l| !l.contains("row 12")), "whitespace-only");
        assert!(mixed.contains("-    row 150\n") && mixed.contains("+\trow 153\n"), "second re-indented block: {mixed}");
        assert!(r.git(&["diff", "-w", "HEAD~1", "HEAD", "--", "mixed.txt"]).lines().all(|l| !l.contains("row 15")), "whitespace-only too");
        assert!(mixed.contains("+row 135 changed\n") && mixed.contains("+row 175 changed\n"), "real changes after each re-indent: {mixed}");
        assert!(std::fs::read_to_string(r.path().join("mixed.txt")).unwrap().starts_with(&format!("{}long 020 wrapping", (1..20).map(|i| format!("row {i:03}\n")).collect::<String>())), "a long unchanged line 20");
    }

    #[test]
    fn tiny_png_is_a_valid_png() {
        let png = fixtures::tiny_png(6, 4, [0, 0, 255, 255]);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 6);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 4);
        assert!(png.ends_with(&[0xAE, 0x42, 0x60, 0x82]), "IEND chunk CRC");
    }

    #[test]
    fn hooks_are_executable_and_run() {
        let r = TestRepo::new();
        r.commit("base");
        let marker = r.root().join("hook-ran");
        r.hook("post-commit", &format!("#!/bin/sh\ntouch {}\n", marker.display()));
        // TestRepo's own git runs no hooks (core.hooksPath=/dev/null); plain git does.
        std::process::Command::new("git").current_dir(r.path()).envs(isolated_git_env()).args(["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]).status().unwrap();
        assert!(marker.exists());
    }

    #[test]
    fn signing_ssh_signs_only_commits_that_ask_and_counts_them() {
        let r = TestRepo::new();
        r.commit("base");
        if !r.signing_ssh() {
            return;
        }
        assert_eq!(r.sign_count(), 0, "the fixture's own commits stay unsigned");
        let out = std::process::Command::new("git").current_dir(r.path()).envs(isolated_git_env()).args(["commit", "-q", "--allow-empty", "-m", "signed"]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(r.sign_count(), 1);
        let verdict = r.git(&["log", "-1", "--format=%G?"]);
        assert!(verdict == "G" || verdict == "U", "{verdict}");
        assert_eq!(r.sign_count(), 1, "verifying isn't signing");
    }

    #[test]
    fn mark_fixture_writes_the_marker_in_the_root() {
        let r = TestRepo::new();
        r.mark_fixture();
        assert!(r.root().join(FIXTURE_MARKER).is_file());
    }
}
