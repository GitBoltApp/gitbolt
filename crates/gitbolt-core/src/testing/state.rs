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
    pub untracked: String,
    pub stashes: String,
    pub branch_config: String,
}

fn files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("read dir").flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.file_name().is_some_and(|n| n == ".git") {
            continue;
        }
        if p.is_dir() {
            files(root, &p, out);
        } else {
            out.insert(p.strip_prefix(root).expect("inside").display().to_string(), std::fs::read(&p).expect("read file"));
        }
    }
}

impl RepoState {
    pub fn capture(r: &TestRepo) -> Self {
        Self::capture_at(r, r.path())
    }

    pub fn capture_at(r: &TestRepo, wt: &Path) -> Self {
        let head = format!("{} {}", r.git_in(wt, &["rev-parse", "--symbolic-full-name", "HEAD"]), r.git_in(wt, &["rev-parse", "HEAD"]));
        let index_file = wt.join(r.git_in(wt, &["rev-parse", "--git-path", "index"]));
        let copy = tempfile::NamedTempFile::new().expect("temp index");
        std::fs::copy(&index_file, copy.path()).expect("copy index");
        let tree = std::process::Command::new("git").current_dir(wt).envs(isolated_git_env()).env("GIT_INDEX_FILE", copy.path()).arg("write-tree").output().expect("write-tree");
        let mut all = BTreeMap::new();
        files(wt, wt, &mut all);
        RepoState {
            head,
            refs: r.git_in(wt, &["for-each-ref", "--format=%(refname) %(objectname)"]),
            index: String::from_utf8_lossy(&tree.stdout).trim().to_string(),
            files: all,
            untracked: r.git_in(wt, &["ls-files", "--others", "--exclude-standard"]),
            stashes: r.git_in(wt, &["stash", "list", "--format=%H %gs"]),
            branch_config: r.try_git_in(wt, &["config", "--get-regexp", "^branch\\."]).unwrap_or_default(),
        }
    }
}
