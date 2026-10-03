//! A cherry-pick or revert in progress (ux round 1): the commit panel's Continue, Skip and Abort
//! for one started outside GitBolt. Not journaled, like the rebase's controls (§13.2).
//! - Continue: `git cherry-pick --continue` (or `revert`). git commits with `MERGE_MSG`, so the
//!   panel's edited message goes there first.
//! - Skip, Abort: `--skip`, `--abort`.

use crate::api::{blocking, Api};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::in_progress::InProgress;
use crate::journal::UndoKind;
use crate::write::rebase::RebaseAction;
use crate::write::types::WriteResult;
use crate::write::{run_write, WriteCx, WriteIntent};
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum PickOutcome {
    /// The pick (or the rest of the sequence) is committed.
    Done,
    /// The next pick of a sequence stopped on conflicts.
    Stopped { files: u32 },
    Aborted,
}

struct PickControl {
    /// `cherry-pick` or `revert`, as git names it.
    what: &'static str,
    action: RebaseAction,
    message: Option<String>,
}

impl WriteIntent for PickControl {
    type Outcome = PickOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        let step = match self.action {
            RebaseAction::Continue => "continue",
            RebaseAction::Skip => "skip a commit of",
            RebaseAction::Abort => "abort",
        };
        format!("{step} the {}", self.what)
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<PickOutcome, GbError> {
        if cx.before.in_progress != Some(self.what) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("No {} is in progress", self.what)));
        }
        let flag = match self.action {
            RebaseAction::Continue => "--continue",
            RebaseAction::Skip => "--skip",
            RebaseAction::Abort => "--abort",
        };
        if self.action == RebaseAction::Continue
            && let Some(InProgress::CherryPick { conflicted, .. } | InProgress::Revert { conflicted, .. }) = crate::in_progress::read(cx.root)?
            && conflicted > 0
        {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("Resolve {conflicted} conflicted {} first", if conflicted == 1 { "file" } else { "files" })));
        }
        if let Some(m) = self.message.as_deref().filter(|m| self.action == RebaseAction::Continue && !m.trim().is_empty()) {
            let root = cx.root.to_path_buf();
            let git_dir = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.git_dir().to_path_buf())).await?;
            // Only while a pick waits for its commit: between picks there's nothing to commit.
            // An unchanged message touches nothing.
            let file = git_dir.join("MERGE_MSG");
            if let Ok(old) = std::fs::read_to_string(&file)
                && old.replace("\r\n", "\n").trim_end() != m.trim_end()
            {
                std::fs::write(&file, format!("{}\n", m.trim_end())).map_err(|e| GbError::new(GbErrorKind::Io, format!("{}: {e}", file.display())))?;
            }
        }
        let inv = cx.git([self.what, flag]);
        let res = cx.run_git(inv).await;
        for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Head, ChangeKind::State] {
            cx.touch(k);
        }
        match res {
            Ok(_) if self.action == RebaseAction::Abort => Ok(PickOutcome::Aborted),
            Ok(_) => Ok(PickOutcome::Done),
            Err(e) => match crate::in_progress::read(cx.root).ok().flatten() {
                Some(InProgress::CherryPick { conflicted, .. } | InProgress::Revert { conflicted, .. }) if conflicted > 0 && self.action != RebaseAction::Abort => Ok(PickOutcome::Stopped { files: conflicted }),
                // --- 3B T1 fix round 1 ---
                // A Continue or Skip that failed on the next commit with nothing in progress (an
                // untracked file in the way) leaves `.git/sequencer/`: dropped, the commits stay.
                None if self.action != RebaseAction::Abort && crate::write::sequence::quit_leftover_sequencer(cx, self.what).await => {
                    let mut e = e;
                    e.message = format!("{} (the rest of the {} wasn't applied)", e.message.trim_end(), self.what);
                    Err(e)
                }
                // --- end 3B T1 fix round 1 ---
                _ => Err(e),
            },
        }
    }
}

pub(crate) async fn control(api: &Api, repo: u32, worktree: &str, action: RebaseAction, message: Option<String>) -> Result<WriteResult<PickOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let what = match crate::in_progress::read(&root)? {
        Some(InProgress::CherryPick { .. }) => "cherry-pick",
        Some(InProgress::Revert { .. }) => "revert",
        _ => return Err(GbError::new(GbErrorKind::InvalidInput, "No cherry-pick or revert is in progress")),
    };
    run_write(api, repo, worktree, Default::default(), PickControl { what, action, message }).await
}

#[cfg(test)]
mod tests {
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, open, repo, wt};
    use serde_json::json;

    /// main and feature both change c.txt; HEAD: main.
    fn two_sides() -> TestRepo {
        let r = repo();
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        r
    }

    #[tokio::test]
    async fn a_stopped_cherry_pick_continues_with_the_edited_message() {
        let data = tempfile::tempdir().unwrap();
        let r = two_sides();
        assert!(r.try_git(&["cherry-pick", "feature"]).is_err());
        let api = api(data.path());
        let id = open(&api, &r).await;
        let params = json!({ "repo": id, "worktree": wt(r.path()), "action": "continue", "message": "Fix x, picked\n\nBody." });
        let refused = call(&api, "pickControl", params.clone()).await;
        assert!(refused.is_err(), "conflicts remain: git refuses");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = call(&api, "pickControl", params).await.unwrap();
        assert_eq!(res["outcome"], json!({ "status": "done" }));
        assert_eq!(r.git(&["log", "-1", "--format=%B"]).trim_end(), "Fix x, picked\n\nBody.");
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
    }

    #[tokio::test]
    async fn a_stopped_revert_aborts() {
        let data = tempfile::tempdir().unwrap();
        let r = two_sides();
        r.write("c.txt", "again\n");
        r.git(&["commit", "-q", "-am", "again"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        assert!(r.try_git(&["revert", "--no-edit", "HEAD~1"]).is_err());
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "pickControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "abort" })).await.unwrap();
        assert_eq!(res["outcome"], json!({ "status": "aborted" }));
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
    }
}
