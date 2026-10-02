//! A WIP file's hunks, from git (spec #2 §7.3): the hunk and line buttons sit at what gets
//! applied, never at Monaco's own diff. Read-only, with the never-write environment.

use crate::blob::{check_relative, safe_join, worktree_id};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// The old-side numbers of its `-` lines (Deviation 2).
    pub del: Vec<u32>,
    /// The new-side numbers of its `+` lines.
    pub add: Vec<u32>,
}

/// The blobs a diff was computed from: HEAD's and the index's ids, and the worktree file's bytes
/// as a blob id (no filters). A stage, unstage or discard whose base no longer matches is `Stale`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct WipBase {
    pub head: Option<String>,
    pub index: Option<String>,
    pub worktree: Option<String>,
}

impl WipBase {
    /// The parts a diff of that side depends on: unstaged = index → worktree, staged = HEAD → index.
    pub fn matches(&self, now: &WipBase, staged: bool) -> bool {
        if staged {
            self.head == now.head && self.index == now.index
        } else {
            self.index == now.index && self.worktree == now.worktree
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HunksPayload {
    pub base: WipBase,
    pub hunks: Vec<Hunk>,
    /// git said "Binary files … differ": no hunk or line actions.
    pub binary: bool,
    /// Why this file can't be staged by hunk or line ("Binary file: stage the whole file",
    /// "Resolve the conflict first", …): `hunks` is then empty.
    pub refused: Option<String>,
}

/// Past this many bytes (the worktree file, or git's diff), no hunks: the hunk and line
/// buttons give way to "stage the whole file".
pub(crate) const HUNKS_LIMIT: u64 = 5 * 1024 * 1024;

pub(crate) const TOO_LARGE: &str = "Too large for line staging; stage the whole file";

/// The path's current base (gix only). A file gone from the worktree (its folder too) has no
/// worktree id.
pub(crate) fn base_of(root: &Path, path: &str) -> Result<WipBase, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let head = match repo.head_commit() {
        Ok(c) => c.tree().ok().and_then(|t| t.lookup_entry_by_path(path).ok().flatten()).filter(|e| !e.mode().is_tree()).map(|e| e.object_id().to_string()),
        Err(_) => None,
    };
    let index = repo.index_or_empty().map_err(gix_err)?;
    let index = index.entry_by_path_and_stage(path.into(), gix::index::entry::Stage::Unconflicted).map(|e| e.id.to_string());
    let file = match safe_join(root, path) {
        Ok(f) => Some(f),
        Err(e) if e.kind == GbErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let worktree = match file.as_ref().map(|f| (f, std::fs::symlink_metadata(f))) {
        Some((f, Ok(m))) if m.file_type().is_symlink() => std::fs::read_link(f).ok().map(|t| worktree_id(t.as_os_str().as_encoded_bytes())),
        Some((f, Ok(m))) if m.is_file() => Some(worktree_id(&std::fs::read(f)?)),
        _ => None,
    };
    Ok(WipBase { head, index, worktree })
}

/// What the index and HEAD say about a path, before any diff.
struct PathFacts {
    /// In the index at any stage (a conflicted one is tracked too).
    in_index: bool,
    /// In the index, but only at stages 1–3.
    conflicted: bool,
    /// A folder (in HEAD, the index or the worktree), not a submodule.
    folder: bool,
    /// Nothing at this path in HEAD, the index or the worktree.
    missing: bool,
    /// The worktree file's size, when it's a regular file.
    size: Option<u64>,
}

fn path_facts(root: &Path, path: &str) -> Result<PathFacts, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let head = match repo.head_commit() {
        Ok(c) => c.tree().ok().and_then(|t| t.lookup_entry_by_path(path).ok().flatten()).map(|e| e.mode()),
        Err(_) => None,
    };
    let index = repo.index_or_empty().map_err(gix_err)?;
    let at_path: Vec<_> = index.entry_range(path.into()).map(|r| index.entries()[r].to_vec()).unwrap_or_default();
    let gitlink = at_path.iter().any(|e| e.mode == gix::index::entry::Mode::COMMIT) || head.is_some_and(|m| m.is_commit());
    let meta = match safe_join(root, path) {
        Ok(f) => std::fs::symlink_metadata(f).ok(),
        Err(e) if e.kind == GbErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let folder = !gitlink && (head.is_some_and(|m| m.is_tree()) || (at_path.is_empty() && index.path_is_directory(path.into())) || meta.as_ref().is_some_and(|m| m.is_dir()));
    Ok(PathFacts {
        in_index: !at_path.is_empty(),
        conflicted: !at_path.is_empty() && at_path.iter().all(|e| e.stage_raw() != 0),
        folder,
        missing: head.is_none() && at_path.is_empty() && meta.is_none(),
        size: meta.filter(|m| m.is_file()).map(|m| m.len()),
    })
}

/// `git diff` of one path, as the patch builder takes it. Unstaged and not in the index:
/// untracked, so it's diffed against /dev/null (`--no-index` exits 1 on a difference). The
/// prefixes are pinned so a user's `diff.noprefix` or `diff.mnemonicPrefix` can't change the
/// paths `git apply` reads, and `--submodule=short` so a user's `diff.submodule=diff` can't
/// inline a submodule's own files.
async fn diff_text(cli: &GitCli, root: &Path, path: &str, staged: bool, in_index: bool) -> Result<Vec<u8>, GbError> {
    let base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short"];
    if !staged && !in_index {
        let inv = GitInvocation::new(root, base.iter().copied().chain(["--no-index", "--", "/dev/null", path])).ok_exit(1);
        let out = cli.run(inv).await?;
        // Exit 1 is also how `--no-index` fails ("Could not access …"): no diff, only stderr.
        if let Some(line) = out.stdout.is_empty().then(|| out.stderr.lines().map(str::trim).find(|l| !l.is_empty())).flatten() {
            return Err(GbError { command_id: Some(out.command_id), stderr: Some(out.stderr.clone()), ..GbError::other(line.trim_start_matches("error: ").to_string()) });
        }
        return Ok(out.stdout);
    }
    let side: &[&str] = if staged { &["--cached", "--", path] } else { &["--", path] };
    let inv = GitInvocation::new(root, base.iter().chain(side).copied()).env("GIT_LITERAL_PATHSPECS", "1");
    Ok(cli.run(inv).await?.stdout)
}

/// One path's diff, as the patch builder takes it, or why it can't be staged by hunk or line
/// (`Err` inside). A folder or a path that's nowhere is refused outright: a diff of a folder
/// would stage one file's hunk into another.
pub(crate) async fn wip_diff(cli: &GitCli, root: &Path, path: &str, staged: bool) -> Result<Result<Vec<u8>, String>, GbError> {
    check_relative(path)?;
    let facts = {
        let (root, path) = (root.to_path_buf(), path.to_string());
        crate::api::blocking(move || path_facts(&root, &path)).await?
    };
    if facts.folder {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is not a file")));
    }
    if facts.missing {
        return Err(GbError::new(GbErrorKind::NotFound, format!("{path} not found")));
    }
    if facts.conflicted {
        return Ok(Err("Resolve the conflict first".into()));
    }
    if !staged && facts.size.is_some_and(|n| n > HUNKS_LIMIT) {
        return Ok(Err(TOO_LARGE.into()));
    }
    let diff = diff_text(cli, root, path, staged, facts.in_index).await?;
    if diff.len() as u64 > HUNKS_LIMIT {
        return Ok(Err(TOO_LARGE.into()));
    }
    match crate::write::patch::parse(&diff).refusal() {
        Some(why) => Ok(Err(why.into())),
        None => Ok(Ok(diff)),
    }
}

/// The base is read before the diff: a file that changes while git diffs it then fails the
/// write's base check (`Stale`) rather than pass it with hunks the user never saw.
pub async fn wip_hunks(cli: &GitCli, root: &Path, path: &str, staged: bool) -> Result<HunksPayload, GbError> {
    check_relative(path)?;
    let base = base_of(root, path)?;
    let (diff, refused) = match wip_diff(cli, root, path, staged).await? {
        Ok(diff) => (diff, None),
        Err(why) => (Vec::new(), Some(why)),
    };
    let parsed = crate::write::patch::parse(&diff);
    let binary = parsed.binary || refused.as_deref() == Some(crate::write::patch::BINARY);
    Ok(HunksPayload { base, hunks: parsed.hunks.iter().map(|h| h.summary()).collect(), binary, refused })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::write::test_support::repo;

    fn cli() -> GitCli {
        GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(50))).with_env(crate::testing::isolated_git_env())
    }

    #[tokio::test]
    async fn hunks_and_bases_for_each_side() {
        let r = repo();
        r.write("a.txt", "A\n");
        r.git(&["add", "a.txt"]);
        r.write("a.txt", "A\nmore\n");
        r.write("n.txt", "one\ntwo\n");
        let staged = wip_hunks(&cli(), r.path(), "a.txt", true).await.unwrap();
        assert_eq!(staged.hunks.len(), 1);
        assert_eq!((staged.hunks[0].del.clone(), staged.hunks[0].add.clone()), (vec![1], vec![1]));
        let unstaged = wip_hunks(&cli(), r.path(), "a.txt", false).await.unwrap();
        assert_eq!(unstaged.hunks[0].add, [2]);
        assert_eq!(unstaged.base.worktree.as_deref(), Some(worktree_id(b"A\nmore\n").as_str()));
        assert_eq!(unstaged.base.index, staged.base.index);
        let untracked = wip_hunks(&cli(), r.path(), "n.txt", false).await.unwrap();
        assert_eq!((untracked.hunks[0].new_start, untracked.hunks[0].new_lines, untracked.base.index.clone()), (1, 2, None));
        let staged_base = staged.base.clone();
        r.write("a.txt", "edited again\n");
        let now = base_of(r.path(), "a.txt").unwrap();
        assert!(staged_base.matches(&now, true), "a worktree edit doesn't stale the staged side");
        assert!(!unstaged.base.matches(&now, false));
    }

    #[tokio::test]
    async fn a_user_noprefix_config_keeps_the_a_b_prefixes() {
        let r = repo();
        r.git(&["config", "diff.noprefix", "true"]);
        r.write("a.txt", "b\n");
        let diff = String::from_utf8(wip_diff(&cli(), r.path(), "a.txt", false).await.unwrap().unwrap()).unwrap();
        assert!(diff.contains("--- a/a.txt\n+++ b/a.txt\n"), "{diff}");
    }

    #[tokio::test]
    async fn a_file_gone_with_its_folder_has_no_worktree_id() {
        let r = repo();
        r.write("sub/f.txt", "f\n");
        r.git(&["add", "sub/f.txt"]);
        std::fs::remove_dir_all(r.path().join("sub")).unwrap();
        let h = wip_hunks(&cli(), r.path(), "sub/f.txt", false).await.unwrap();
        assert_eq!((h.base.worktree, h.hunks.len()), (None, 1));
        assert_eq!(h.hunks[0].del, [1]);
    }

    #[tokio::test]
    async fn a_binary_file_has_no_hunks() {
        let r = repo();
        r.write_bytes("b.bin", b"\0\x01\x02");
        r.git(&["add", "b.bin"]);
        r.write_bytes("b.bin", b"\0\x01\x03");
        let h = wip_hunks(&cli(), r.path(), "b.bin", false).await.unwrap();
        assert!(h.binary && h.hunks.is_empty(), "{h:?}");
        assert_eq!(h.refused.as_deref(), Some(crate::write::patch::BINARY));
    }

    /// Review I2: a folder's diff has one section per file; its hunks are never offered.
    #[tokio::test]
    async fn a_folder_path_is_refused() {
        let r = repo();
        r.write("d/a", "x\ny\n");
        r.write("d/b", "x\ny\n");
        r.git(&["add", "d"]);
        r.git(&["commit", "-q", "-m", "d"]);
        r.write("d/a", "x\nY\n");
        r.write("d/b", "x\ny\nz\n");
        for staged in [false, true] {
            let err = wip_hunks(&cli(), r.path(), "d", staged).await.unwrap_err();
            assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "d is not a file"));
        }
        // Gone from the worktree, the folder is still one in the index and HEAD.
        std::fs::remove_dir_all(r.path().join("d")).unwrap();
        assert_eq!(wip_hunks(&cli(), r.path(), "d", false).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(wip_hunks(&cli(), r.path(), "nowhere.txt", false).await.unwrap_err().kind, GbErrorKind::NotFound);
    }

    /// Review I2: a file replaced by a symlink is a delete section and an add section.
    #[tokio::test]
    async fn a_typechange_is_refused() {
        let r = repo();
        r.write("f", "one\ntwo\nthree\n");
        r.git(&["add", "f"]);
        r.git(&["commit", "-q", "-m", "f"]);
        std::fs::remove_file(r.path().join("f")).unwrap();
        std::os::unix::fs::symlink("target", r.path().join("f")).unwrap();
        let typechange = Some("The file's type changed: stage the whole file");
        let h = wip_hunks(&cli(), r.path(), "f", false).await.unwrap();
        assert_eq!((h.hunks.len(), h.refused.as_deref()), (0, typechange), "{h:?}");
        r.git(&["add", "f"]);
        let h = wip_hunks(&cli(), r.path(), "f", true).await.unwrap();
        assert_eq!((h.hunks.len(), h.refused.as_deref()), (0, typechange), "{h:?}");
    }

    /// Review I3: a symlink's target and a submodule's commit are whole-file changes only.
    #[tokio::test]
    async fn symlinks_and_submodules_are_refused() {
        let r = repo();
        std::os::unix::fs::symlink("old", r.path().join("l")).unwrap();
        let sm = r.path().join("sm");
        std::fs::create_dir(&sm).unwrap();
        r.git_in(&sm, &["init", "-q"]);
        std::fs::write(sm.join("s.txt"), "s\n").unwrap();
        r.git_in(&sm, &["add", "s.txt"]);
        r.git_in(&sm, &["commit", "-q", "-m", "s"]);
        r.git(&["add", "l", "sm"]);
        r.git(&["commit", "-q", "-m", "links"]);
        std::fs::remove_file(r.path().join("l")).unwrap();
        std::os::unix::fs::symlink("new", r.path().join("l")).unwrap();
        // A user's `diff.submodule=diff` would inline the submodule's own files.
        r.git(&["config", "diff.submodule", "diff"]);
        std::fs::write(sm.join("s.txt"), "s2\n").unwrap();
        r.git_in(&sm, &["commit", "-q", "-am", "s2"]);
        let h = wip_hunks(&cli(), r.path(), "l", false).await.unwrap();
        assert_eq!((h.hunks.len(), h.refused.as_deref()), (0, Some("Symlink: stage the whole file")), "{h:?}");
        let h = wip_hunks(&cli(), r.path(), "sm", false).await.unwrap();
        assert_eq!((h.hunks.len(), h.refused.as_deref()), (0, Some("Submodule: stage the whole file")), "{h:?}");
    }

    #[tokio::test]
    async fn a_conflicted_file_is_refused_on_both_sides() {
        let r = repo();
        r.git(&["checkout", "-q", "-b", "side"]);
        r.write("a.txt", "side\n");
        r.git(&["commit", "-q", "-am", "side"]);
        r.git(&["checkout", "-q", "-"]);
        r.write("a.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        assert!(r.try_git(&["merge", "-q", "side"]).is_err(), "a conflict");
        for staged in [false, true] {
            let h = wip_hunks(&cli(), r.path(), "a.txt", staged).await.unwrap();
            assert_eq!((h.hunks.len(), h.refused.as_deref()), (0, Some("Resolve the conflict first")), "{h:?}");
        }
    }

    /// Review m6: past the cap, no diff is read and no hunks are offered.
    #[tokio::test]
    async fn a_file_past_the_cap_is_too_large() {
        let r = repo();
        r.write_bytes("big.txt", &b"line\n".repeat(HUNKS_LIMIT as usize / 5 + 1));
        let h = wip_hunks(&cli(), r.path(), "big.txt", false).await.unwrap();
        assert_eq!((h.hunks.len(), h.refused.as_deref()), (0, Some(TOO_LARGE)));
    }

    /// Review m2: exit 1 is also how `--no-index` fails; that's an error, not an empty diff.
    #[tokio::test]
    async fn a_no_index_failure_is_an_error() {
        let r = repo();
        let err = diff_text(&cli(), r.path(), "gone.txt", false, false).await.unwrap_err();
        assert!(err.message.contains("Could not access"), "{err:?}");
    }

    #[tokio::test]
    async fn a_mode_only_change_has_no_hunks_and_no_refusal() {
        let r = repo();
        r.git(&["update-index", "--chmod=+x", "a.txt"]);
        let h = wip_hunks(&cli(), r.path(), "a.txt", true).await.unwrap();
        assert_eq!((h.hunks.len(), h.refused), (0, None));
    }
}
