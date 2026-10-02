//! gix `Repository::state()` for one worktree, plus what the banner (§13.2) and the merge tool's
//! labels (§13.3) need, read from that worktree's git dir. Read-only.

use crate::error::{gix_err, GbError};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum InProgress {
    /// `MERGE_HEAD` exists. `message`: `MERGE_MSG`, line endings normalised (§8.2).
    Merge { merge_head: String, message: String, conflicted: u32 },
    /// `rebase-merge/` (or `rebase-apply/`). `onto` and `stopped_at` are oids; `head_name` is the
    /// branch being rebased (`refs/heads/main`).
    Rebase { onto: String, head_name: String, step: u32, total: u32, stopped_at: Option<String>, conflicted: u32 },
    /// Started outside GitBolt; #3 adds its actions.
    Other { what: String },
}

fn unmerged_paths(repo: &gix::Repository) -> u32 {
    let Ok(index) = repo.index_or_empty() else { return 0 };
    let mut paths: Vec<&gix::bstr::BStr> = index.entries().iter().filter(|e| e.stage_raw() != 0).map(|e| e.path(&index)).collect();
    paths.dedup();
    paths.len() as u32
}

pub fn read(root: &Path) -> Result<Option<InProgress>, GbError> {
    use gix::state::InProgress as S;
    let repo = gix::open(root).map_err(gix_err)?;
    let Some(state) = repo.state() else { return Ok(None) };
    let git_dir = repo.git_dir().to_path_buf();
    let text = |name: &str| std::fs::read_to_string(git_dir.join(name)).ok().map(|s| s.trim().to_string());
    let conflicted = unmerged_paths(&repo);
    Ok(Some(match state {
        S::Merge => InProgress::Merge {
            merge_head: text("MERGE_HEAD").unwrap_or_default().lines().next().unwrap_or_default().to_string(),
            message: std::fs::read_to_string(git_dir.join("MERGE_MSG")).unwrap_or_default().replace("\r\n", "\n").replace('\r', "\n"),
            conflicted,
        },
        S::Rebase | S::RebaseInteractive | S::ApplyMailboxRebase => {
            let merge = git_dir.join("rebase-merge").is_dir();
            let dir = if merge { "rebase-merge" } else { "rebase-apply" };
            let f = |n: &str| text(&format!("{dir}/{n}"));
            let num = |n: &str| f(n).and_then(|s| s.parse().ok()).unwrap_or(0);
            let (step, total) = if merge { (num("msgnum"), num("end")) } else { (num("next"), num("last")) };
            InProgress::Rebase { onto: f("onto").unwrap_or_default(), head_name: f("head-name").unwrap_or_default(), step, total, stopped_at: f("stopped-sha").or_else(|| text("REBASE_HEAD")), conflicted }
        }
        S::CherryPick | S::CherryPickSequence => InProgress::Other { what: "cherry-pick".into() },
        S::Revert | S::RevertSequence => InProgress::Other { what: "revert".into() },
        S::ApplyMailbox => InProgress::Other { what: "am".into() },
        S::Bisect => return Ok(None),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestRepo;

    fn two_sides(r: &TestRepo) {
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
    }

    #[test]
    fn nothing_in_progress() {
        let r = TestRepo::new();
        r.commit("c");
        assert_eq!(read(r.path()).unwrap(), None);
    }

    #[test]
    fn a_conflicted_merge() {
        let r = TestRepo::new();
        two_sides(&r);
        assert!(r.try_git(&["merge", "--no-edit", "feature"]).is_err());
        match read(r.path()).unwrap() {
            Some(InProgress::Merge { merge_head, message, conflicted }) => {
                assert_eq!(merge_head, r.git(&["rev-parse", "feature"]));
                assert!(message.starts_with("Merge branch 'feature'"), "{message}");
                assert_eq!(conflicted, 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_stopped_rebase() {
        let r = TestRepo::new();
        two_sides(&r);
        r.switch("feature");
        assert!(r.try_git(&["rebase", "main"]).is_err());
        match read(r.path()).unwrap() {
            Some(InProgress::Rebase { onto, head_name, step, total, stopped_at, conflicted }) => {
                assert_eq!(onto, r.git(&["rev-parse", "main"]));
                assert_eq!(head_name, "refs/heads/feature");
                assert_eq!((step, total, conflicted), (1, 1, 1));
                assert!(stopped_at.is_some());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_cherry_pick_is_other() {
        let r = TestRepo::new();
        two_sides(&r);
        assert!(r.try_git(&["cherry-pick", "feature"]).is_err());
        assert_eq!(read(r.path()).unwrap(), Some(InProgress::Other { what: "cherry-pick".into() }));
    }
}
