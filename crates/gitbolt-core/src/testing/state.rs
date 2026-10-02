//! A repository's whole observable state, for the undo round trips (spec #2 §17.1): after an
//! undo it must equal its value before the operation, and after a redo its value after.

use super::{isolated_git_env, TestRepo};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoState {
    /// `refs/heads/main <oid>`, or `HEAD <oid>` when detached.
    pub head: String,
    /// Every ref and its oid.
    pub refs: String,
    /// The index as a tree (`write-tree` on a copy: the real index isn't touched).
    pub index: String,
    /// Every worktree file's bytes (`.git` excluded).
    pub files: BTreeMap<String, Vec<u8>>,
    /// Every worktree file's mode bits (2C T6: an exec-bit change must round-trip too).
    pub modes: BTreeMap<String, u32>,
    pub untracked: String,
    pub stashes: String,
    pub branch_config: String,
}

fn files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>, modes: &mut BTreeMap<String, u32>) {
    use std::os::unix::fs::PermissionsExt;
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("read dir").flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.file_name().is_some_and(|n| n == ".git") {
            continue;
        }
        if p.is_dir() {
            files(root, &p, out, modes);
        } else {
            let rel = p.strip_prefix(root).expect("inside").display().to_string();
            modes.insert(rel.clone(), std::fs::symlink_metadata(&p).expect("stat file").permissions().mode());
            out.insert(rel, std::fs::read(&p).expect("read file"));
        }
    }
}

impl RepoState {
    pub fn capture(r: &TestRepo) -> Self {
        Self::capture_at(r, r.path())
    }

    pub fn capture_at(r: &TestRepo, wt: &Path) -> Self {
        // 2B T4: an unborn HEAD is `refs/heads/main ` (no oid), and a missing index the empty one.
        let name = r.try_git_in(wt, &["symbolic-ref", "-q", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
        let head = format!("{name} {}", r.try_git_in(wt, &["rev-parse", "-q", "--verify", "HEAD"]).unwrap_or_default());
        let index_file = wt.join(r.git_in(wt, &["rev-parse", "--git-path", "index"]));
        let copy = tempfile::NamedTempFile::new().expect("temp index");
        if index_file.exists() {
            std::fs::copy(&index_file, copy.path()).expect("copy index");
        } else {
            std::fs::remove_file(copy.path()).expect("no index");
        }
        let tree = std::process::Command::new("git").current_dir(wt).envs(isolated_git_env()).env("GIT_INDEX_FILE", copy.path()).arg("write-tree").output().expect("write-tree");
        let (mut all, mut modes) = (BTreeMap::new(), BTreeMap::new());
        files(wt, wt, &mut all, &mut modes);
        RepoState {
            head,
            refs: r.git_in(wt, &["for-each-ref", "--format=%(refname) %(objectname)"]),
            index: String::from_utf8_lossy(&tree.stdout).trim().to_string(),
            files: all,
            modes,
            untracked: r.git_in(wt, &["ls-files", "--others", "--exclude-standard"]),
            stashes: r.git_in(wt, &["stash", "list", "--format=%H %gs"]),
            branch_config: r.try_git_in(wt, &["config", "--get-regexp", "^branch\\."]).unwrap_or_default(),
        }
    }
}
