//! `git status --porcelain=v2 -z` parsing (see git-status(1), "Porcelain Format Version 2").

use crate::error::GbError;
use crate::git::{GitCli, GitInvocation};
use std::path::Path;

pub use gitvolt_graph::WipCounts;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Ordinary,
    Renamed,
    Unmerged,
    Untracked,
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub index: char,
    pub worktree: char,
    pub kind: EntryKind,
    /// A submodule's own state (porcelain v2's `S<c><m><u>` field); `None` for any other path.
    pub submodule: Option<SubmoduleFlags>,
}

/// What `git status` says about a submodule: `S<c><m><u>`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SubmoduleFlags {
    /// `C`: checked out at another commit than the index records ("new commits").
    pub commit: bool,
    /// `M`: tracked changes inside it ("modified content").
    pub modified: bool,
    /// `U`: untracked files inside it ("untracked content").
    pub untracked: bool,
}

/// `S<c><m><u>` as flags; `N...` (not a submodule) is `None`.
fn submodule_flags(field: &str) -> Option<SubmoduleFlags> {
    let b = field.as_bytes();
    (b.len() == 4 && b[0] == b'S').then(|| SubmoduleFlags { commit: b[1] == b'C', modified: b[2] == b'M', untracked: b[3] == b'U' })
}

fn xy(field: &str) -> (char, char) {
    let mut c = field.chars();
    (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
}

pub fn parse_porcelain_v2(out: &[u8]) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let mut tokens = out.split(|b| *b == 0);
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(tok);
        let entry = match tok[0] {
            b'1' => {
                let f: Vec<&str> = line.splitn(9, ' ').collect();
                (f.len() == 9).then(|| {
                    let (x, y) = xy(f[1]);
                    StatusEntry { path: f[8].to_string(), orig_path: None, index: x, worktree: y, kind: EntryKind::Ordinary, submodule: submodule_flags(f[2]) }
                })
            }
            b'2' => {
                let f: Vec<&str> = line.splitn(10, ' ').collect();
                let orig = tokens.next().map(|o| String::from_utf8_lossy(o).into_owned());
                (f.len() == 10).then(|| {
                    let (x, y) = xy(f[1]);
                    StatusEntry { path: f[9].to_string(), orig_path: orig, index: x, worktree: y, kind: EntryKind::Renamed, submodule: submodule_flags(f[2]) }
                })
            }
            b'u' => {
                let f: Vec<&str> = line.splitn(11, ' ').collect();
                (f.len() == 11).then(|| {
                    let (x, y) = xy(f[1]);
                    StatusEntry { path: f[10].to_string(), orig_path: None, index: x, worktree: y, kind: EntryKind::Unmerged, submodule: submodule_flags(f[2]) }
                })
            }
            b'?' => Some(StatusEntry { path: line[2..].to_string(), orig_path: None, index: '?', worktree: '?', kind: EntryKind::Untracked, submodule: None }),
            b'!' => Some(StatusEntry { path: line[2..].to_string(), orig_path: None, index: '!', worktree: '!', kind: EntryKind::Ignored, submodule: None }),
            _ => None, // `# ...` headers
        };
        entries.extend(entry);
    }
    entries
}

/// Raw `git status --porcelain=v2 -z --untracked-files=all` output (the watcher digests it).
pub async fn status_raw(cli: &GitCli, worktree: &Path) -> Result<Vec<u8>, GbError> {
    let out = cli
        .run(GitInvocation::new(worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))
        .await?;
    Ok(out.stdout)
}

/// The git dir of a linked worktree (its `.git` is a file); `None` for the main one.
fn linked_git_dir(worktree: &Path) -> Option<std::path::PathBuf> {
    let dot = worktree.join(".git");
    if dot.is_dir() {
        return None;
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let dir = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim)?;
    Some(worktree.join(dir))
}

/// A linked worktree whose checkout is still being written (`git worktree add`): its index
/// isn't there yet, so a status now would call every HEAD file deleted and every file already on
/// disk untracked. Such a worktree has no counts yet; its index appearing (watched in its git
/// dir) triggers the read.
pub fn checkout_pending(worktree: &Path) -> bool {
    linked_git_dir(worktree).is_some_and(|g| !g.join("index").exists() && gix::open(worktree).is_ok_and(|r| r.head_id().is_ok()))
}

/// A linked worktree's index is locked (a git command is writing it, often briefly): its counts
/// are left as they were, and the index's rename when the lock goes triggers the read.
pub fn index_locked(worktree: &Path) -> bool {
    linked_git_dir(worktree).is_some_and(|g| g.join("index.lock").exists())
}

pub async fn status(cli: &GitCli, worktree: &Path) -> Result<Vec<StatusEntry>, GbError> {
    Ok(parse_porcelain_v2(&status_raw(cli, worktree).await?))
}

pub fn summarize(entries: &[StatusEntry]) -> WipCounts {
    let mut c = WipCounts::default();
    for e in entries {
        match e.kind {
            EntryKind::Ignored => {}
            EntryKind::Unmerged => c.conflicted += 1,
            EntryKind::Untracked => c.added += 1,
            _ if e.index == 'D' || e.worktree == 'D' => c.deleted += 1,
            _ if e.index == 'A' => c.added += 1,
            EntryKind::Renamed if e.index == 'R' => c.renamed += 1,
            _ => c.modified += 1,
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> super::super::git::GitCli {
        super::super::git::GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env())
    }

    #[cfg(unix)] // file names Windows forbids (*, ?, :, newlines)
    #[tokio::test]
    async fn parses_weird_paths_and_renames() {
        let r = TestRepo::new();
        for i in 0..4 {
            r.commit(&format!("c{i}"));
        }
        r.write("file_0.txt", "changed\n");
        r.git(&["mv", "file_1.txt", "renamed file.txt"]);
        std::fs::remove_file(r.path().join("file_2.txt")).unwrap();
        r.write("dir with space/ünï.txt", "new\n");
        r.git(&["add", "dir with space/ünï.txt"]);
        r.write("a\nb.txt", "untracked\n");

        let mut entries = super::status(&cli(), r.path()).await.unwrap();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["a\nb.txt", "dir with space/ünï.txt", "file_0.txt", "file_2.txt", "renamed file.txt"]);

        let renamed = entries.iter().find(|e| e.path == "renamed file.txt").unwrap();
        assert_eq!(renamed.kind, super::EntryKind::Renamed);
        assert_eq!(renamed.orig_path.as_deref(), Some("file_1.txt"));
        assert_eq!(renamed.index, 'R');

        let untracked = entries.iter().find(|e| e.path == "a\nb.txt").unwrap();
        assert_eq!(untracked.kind, super::EntryKind::Untracked);

        assert_eq!(super::summarize(&entries), super::WipCounts { modified: 1, added: 2, deleted: 1, renamed: 1, conflicted: 0 });
    }

    #[tokio::test]
    async fn counts_conflicts() {
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("other");
        r.write("file_0.txt", "theirs\n");
        r.git(&["commit", "-qam", "theirs"]);
        r.switch("main");
        r.write("file_0.txt", "ours\n");
        r.git(&["commit", "-qam", "ours"]);
        assert!(r.try_git(&["merge", "-q", "other"]).is_err());
        let entries = super::status(&cli(), r.path()).await.unwrap();
        assert_eq!(super::summarize(&entries).conflicted, 1);
        assert_eq!(entries[0].kind, super::EntryKind::Unmerged);
    }

    #[tokio::test]
    async fn clean_tree_is_empty() {
        let r = TestRepo::new();
        r.commit("c");
        assert!(super::summarize(&super::status(&cli(), r.path()).await.unwrap()).is_empty());
    }

    /// A plain `git status` refreshes stat info and rewrites `.git/index` whenever it can take
    /// the (optional) lock, even though nothing tracked actually changed. `GitCli::run` disables
    /// optional locks (see git.rs), so `status()` here must leave the index file untouched byte
    /// for byte, not just logically unchanged.
    #[tokio::test]
    async fn status_does_not_rewrite_the_index() {
        let r = TestRepo::new();
        r.commit("c");
        let index_path = r.path().join(".git/index");
        let before_bytes = std::fs::read(&index_path).unwrap();
        let before_mtime = std::fs::metadata(&index_path).unwrap().modified().unwrap();

        // Touch a tracked file's mtime, without touching its content, far enough in the future
        // to defeat racy-git's same-second heuristic. A plain `git status` would re-stat it,
        // find the content unchanged, and still rewrite `.git/index` with the refreshed stat
        // info (a write GitVolt must never make).
        let tracked = r.path().join("file_0.txt");
        let f = std::fs::File::options().write(true).open(&tracked).unwrap();
        f.set_modified(before_mtime + std::time::Duration::from_secs(120)).unwrap();

        super::status(&cli(), r.path()).await.unwrap();

        let after_bytes = std::fs::read(&index_path).unwrap();
        let after_mtime = std::fs::metadata(&index_path).unwrap().modified().unwrap();
        assert_eq!(before_bytes, after_bytes, ".git/index bytes must be unchanged by status()");
        assert_eq!(before_mtime, after_mtime, ".git/index mtime must be unchanged by status()");
    }

    #[test]
    fn ignores_headers_and_handles_unmerged_record() {
        let h = "0".repeat(40);
        let raw = format!("# branch.oid {h}\0# branch.head main\0u UU N... 100644 100644 100644 100644 {h} {h} {h} x y.txt\0");
        let e = super::parse_porcelain_v2(raw.as_bytes());
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].path, "x y.txt");
        assert_eq!(e[0].kind, super::EntryKind::Unmerged);
        assert_eq!(e[0].submodule, None);
    }

    #[test]
    fn reads_a_submodules_state_field() {
        let h = "0".repeat(40);
        let raw = format!("1 .M SCMU 160000 160000 160000 {h} {h} vendor/lib\x001 .M S.M. 160000 160000 160000 {h} {h} vendor/other\x001 .M N... 100644 100644 100644 {h} {h} a.txt\0");
        let e = super::parse_porcelain_v2(raw.as_bytes());
        assert_eq!(e[0].submodule, Some(super::SubmoduleFlags { commit: true, modified: true, untracked: true }));
        assert_eq!(e[1].submodule, Some(super::SubmoduleFlags { commit: false, modified: true, untracked: false }));
        assert_eq!(e[2].submodule, None);
    }
}
