//! The staging undo log (spec #2 §7.6): stage and unstage get their own undo stack, separate from
//! the journal, so a misstaged hunk can be undone without pushing real operations out of the
//! journal's 50-entry window. Per worktree, the last 100 steps, in memory only: a restart clears it.

use crate::api::Api;
use crate::error::{gix_err, GbError};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{HeadState, UndoKind};
use crate::write::stage::nul_list;
use crate::write::types::{Expect, StagingUndoState, WriteResult};
use crate::write::{run_write, Staging, WriteClass, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const STAGING_CAP: usize = 100;
pub const CONFLICTED_OFF: &str = "Staging undo is off while files are conflicted.";
pub const OUTSIDE: &str = "The index changed outside staging; staging history was cleared.";

/// One stage or unstage (§7.6): the index as a tree before and after it, and its intent-to-add
/// paths, which trees don't carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagingStep {
    pub label: String,
    pub before: String,
    pub after: String,
    pub ita_before: Vec<String>,
    pub ita_after: Vec<String>,
    /// HEAD when it ran (Deviation 3).
    pub head: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct StagingLog {
    pub(crate) undo: Vec<StagingStep>,
    pub(crate) redo: Vec<StagingStep>,
}

impl StagingLog {
    pub(crate) fn record(&mut self, step: StagingStep) {
        self.redo.clear();
        self.undo.push(step);
        if self.undo.len() > STAGING_CAP {
            self.undo.remove(0);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    /// Moves the top step to the other stack: undo → redo (`to_redo`), or back.
    pub(crate) fn shift(&mut self, to_redo: bool) {
        let (from, to) = if to_redo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        if let Some(s) = from.pop() {
            to.push(s);
        }
    }

    pub(crate) fn state(&self, off: Option<&str>) -> StagingUndoState {
        match off {
            Some(why) => StagingUndoState { undo: None, redo: None, off: Some(why.to_string()) },
            None => StagingUndoState { undo: self.undo.last().map(|s| s.label.clone()), redo: self.redo.last().map(|s| s.label.clone()), off: None },
        }
    }
}

/// Every worktree's log, by canonical worktree path (`Api.staging`).
#[derive(Debug, Default)]
pub(crate) struct StagingLogs(Mutex<HashMap<PathBuf, StagingLog>>);

impl StagingLogs {
    pub(crate) fn with<T>(&self, root: &Path, f: impl FnOnce(&mut StagingLog) -> T) -> T {
        let mut all = self.0.lock().expect("staging logs poisoned");
        f(all.entry(root.to_path_buf()).or_default())
    }
}

/// The index as a tree, and its intent-to-add paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Captured {
    pub tree: String,
    pub ita: Vec<String>,
}

/// Whether the index has unmerged entries, and its intent-to-add paths (gix, no git process).
fn index_flags(root: &Path) -> Result<(bool, Vec<String>), GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let mut conflicted = false;
    let mut ita = Vec::new();
    for e in index.entries() {
        conflicted |= e.stage_raw() != 0;
        if e.flags.contains(gix::index::entry::Flags::INTENT_TO_ADD) {
            ita.push(e.path(&index).to_str_lossy().into_owned());
        }
    }
    Ok((conflicted, ita))
}

/// `git write-tree` (it writes only tree objects, dangling like snapshots) and the i-t-a paths.
/// `None` while files are conflicted: `write-tree` refuses unmerged entries, so no step is
/// recorded then (§7.6).
pub(crate) async fn capture(cx: &WriteCx<'_>) -> Result<Option<Captured>, GbError> {
    let (conflicted, ita) = index_flags(cx.root)?;
    if conflicted {
        return Ok(None);
    }
    let out = cx.api.cli.run(cx.git(["write-tree"])).await?;
    Ok(Some(Captured { tree: String::from_utf8_lossy(&out.stdout).trim().to_string(), ita }))
}

/// After a write ran (§3.2 step 6): a `Step` is recorded, a `Clear` empties the log.
pub(crate) async fn after_run(cx: &WriteCx<'_>, effect: Staging, label: &str, before: Option<Captured>, ok: bool, head: &HeadState) {
    let root = cx.root.to_path_buf();
    match effect {
        Staging::Step if ok => {
            let after = capture(cx).await.ok().flatten();
            cx.api.staging.with(&root, |log| match (before, after) {
                (Some(b), Some(a)) if b != a => log.record(StagingStep { label: label.to_string(), before: b.tree, after: a.tree, ita_before: b.ita, ita_after: a.ita, head: head.oid.clone() }),
                (Some(_), Some(_)) => {} // it changed nothing
                _ => log.clear(),        // conflicted, or the tree couldn't be read
            });
        }
        Staging::Clear => cx.api.staging.with(&root, StagingLog::clear),
        Staging::Step | Staging::Keep | Staging::Own => {}
    }
}

/// `WriteResult.staging` (§3.1). A conflicted worktree turns staging undo off and clears the log
/// ("the log is cleared when the conflict starts").
pub(crate) fn state(api: &Api, root: &Path, conflicted: bool) -> StagingUndoState {
    api.staging.with(root, |log| {
        if conflicted {
            log.clear();
            log.state(Some(CONFLICTED_OFF))
        } else {
            log.state(None)
        }
    })
}

/// `stagingState`: the same, reading the conflicts from the index.
pub(crate) fn read_state(api: &Api, root: &Path) -> Result<StagingUndoState, GbError> {
    Ok(state(api, root, index_flags(root)?.0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dir {
    Undo,
    Redo,
}

/// Staging Undo / Redo (§7.6): `git write-tree` must still give the step's far side, then
/// `git read-tree --reset <tree>` (like a one-tree `-m`, it keeps the stat info of unchanged entries, so the
/// next status doesn't re-hash the repo; the working tree is never touched; plain `-m` refuses
/// with "not uptodate" when a staged file differs from the index entry), then the i-t-a
/// paths go back with `git add -N`.
struct StagingUndo {
    dir: Dir,
    label: String,
}

impl WriteIntent for StagingUndo {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stage // Deviation 18: kept out of Activity with stage/unstage
    }
    fn label(&self) -> String {
        match self.dir {
            Dir::Undo => format!("undo {}", self.label),
            Dir::Redo => format!("redo {}", self.label),
        }
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    fn staging(&self) -> Staging {
        Staging::Own
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let root = cx.root.to_path_buf();
        let top = cx.api.staging.with(&root, |l| match self.dir {
            Dir::Undo => l.undo.last().cloned(),
            Dir::Redo => l.redo.last().cloned(),
        });
        let Some(step) = top else { return Err(GbError::stale("Nothing to undo in staging")) };
        let (want, to, ita) = match self.dir {
            Dir::Undo => (&step.after, &step.before, &step.ita_before),
            Dir::Redo => (&step.before, &step.after, &step.ita_after),
        };
        let now = capture(cx).await?;
        let outside = now.as_ref().is_none_or(|c| &c.tree != want) || cx.before.head.oid != step.head;
        if outside {
            cx.api.staging.with(&root, StagingLog::clear);
            return Err(GbError::stale(OUTSIDE));
        }
        let inv = cx.git(["read-tree", "--reset", to.as_str()]);
        cx.run_git(inv).await?;
        let present: Vec<&String> = ita.iter().filter(|p| root.join(p).symlink_metadata().is_ok()).collect();
        if !present.is_empty() {
            let inv = cx.git(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(present));
            cx.run_git(inv).await?;
        }
        cx.touch(ChangeKind::Index);
        cx.api.staging.with(&root, |l| l.shift(self.dir == Dir::Undo));
        Ok(())
    }
}

pub(crate) async fn staging_undo(api: &Api, repo: u32, worktree: &str, dir: Dir) -> Result<WriteResult<()>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let label = api.staging.with(&root, |l| match dir {
        Dir::Undo => l.undo.last().map(|s| s.label.clone()),
        Dir::Redo => l.redo.last().map(|s| s.label.clone()),
    });
    let Some(label) = label else {
        return Err(GbError::stale(if dir == Dir::Undo { "Nothing to undo in staging" } else { "Nothing to redo in staging" }));
    };
    run_write(api, repo, worktree, Expect::default(), StagingUndo { dir, label }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Api;
    use crate::testing::state::RepoState;
    use crate::testing::TestRepo;
    use crate::write::test_intents::{self, TestIntent};
    use crate::write::test_support::{api, call, open, repo, wt};
    use crate::write::types::Expect;
    use serde_json::{json, Value};

    fn step(label: &str, n: usize) -> StagingStep {
        StagingStep { label: label.into(), before: format!("b{n}"), after: format!("a{n}"), ita_before: vec![], ita_after: vec![], head: None }
    }

    #[test]
    fn the_log_keeps_the_last_100_steps_and_a_new_step_clears_redo() {
        let mut log = StagingLog::default();
        for n in 0..=STAGING_CAP {
            log.record(step("stage a.txt", n));
        }
        assert_eq!(log.undo.len(), STAGING_CAP);
        assert_eq!(log.undo[0].before, "b1", "the oldest went first");
        log.shift(true);
        assert_eq!(log.state(None).redo.as_deref(), Some("stage a.txt"));
        log.record(step("unstage a.txt", 200));
        assert!(log.redo.is_empty());
        assert_eq!(log.state(Some(CONFLICTED_OFF)), crate::write::types::StagingUndoState { undo: None, redo: None, off: Some(CONFLICTED_OFF.into()) });
    }

    async fn req(api: &Api, method: &str, id: u32, r: &TestRepo) -> Result<Value, crate::error::GbError> {
        call(api, method, json!({ "repo": id, "worktree": wt(r.path()), "paths": ["a.txt"] })).await
    }

    async fn staging(api: &Api, method: &str, id: u32, r: &TestRepo) -> Result<Value, crate::error::GbError> {
        call(api, method, json!({ "repo": id, "worktree": wt(r.path()) })).await
    }

    /// §17.1: the index tree equals `before` after undo and `after` after redo; worktree bytes untouched.
    #[tokio::test]
    async fn a_file_stage_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.write("b.txt", "untracked\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = RepoState::capture(&r);
        let res = req(&api, "stage", id, &r).await.unwrap();
        assert_eq!(res["staging"]["undo"], "stage a.txt");
        let after = RepoState::capture(&r);
        let res = staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(RepoState::capture(&r), before);
        assert_eq!(res["staging"]["redo"], "stage a.txt");
        assert!(res["journal"]["undo"].is_null(), "not in the main journal");
        staging(&api, "stagingRedo", id, &r).await.unwrap();
        assert_eq!(RepoState::capture(&r), after);
    }

    #[tokio::test]
    async fn stage_all_and_unstage_all_round_trip() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.write("dir/n.txt", "n\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let s0 = RepoState::capture(&r);
        staging(&api, "stageAll", id, &r).await.unwrap();
        let s1 = RepoState::capture(&r);
        let res = staging(&api, "unstageAll", id, &r).await.unwrap();
        assert_eq!(res["staging"]["undo"], "unstage all");
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(RepoState::capture(&r), s1);
        let res = staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(RepoState::capture(&r), s0);
        assert_eq!(res["staging"]["redo"], "stage all");
    }

    /// §7.6: intent-to-add entries aren't in trees; the step puts them back.
    #[tokio::test]
    async fn intent_to_add_paths_come_back() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.write("n.txt", "intent\n");
        r.git(&["add", "-N", "n.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        req(&api, "stage", id, &r).await.unwrap();
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        let status = r.git(&["status", "--porcelain"]);
        assert!(status.lines().any(|l| l == " A n.txt"), "{status}");
        assert!(status.lines().any(|l| l == " M a.txt"), "{status}");
    }

    #[tokio::test]
    async fn conflicted_entries_turn_staging_undo_off() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::wip_conflict(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "stage", json!({ "repo": id, "worktree": wt(r.path()), "paths": ["side.txt"] })).await.unwrap();
        assert_eq!(res["staging"]["off"], CONFLICTED_OFF);
        assert!(res["staging"]["undo"].is_null());
        assert!(staging(&api, "stagingUndo", id, &r).await.is_err());
        let state = staging(&api, "stagingState", id, &r).await.unwrap();
        assert_eq!(state["off"], CONFLICTED_OFF);
    }

    #[tokio::test]
    async fn an_outside_git_add_is_detected_and_clears_the_log() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.write("b.txt", "b\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        req(&api, "stage", id, &r).await.unwrap();
        r.git(&["add", "b.txt"]);
        let err = staging(&api, "stagingUndo", id, &r).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
        assert_eq!(err.message, OUTSIDE);
        assert!(staging(&api, "stagingState", id, &r).await.unwrap()["undo"].is_null());
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt\nb.txt", "nothing was read back");
    }

    /// Review Focus 4: a commit in a terminal leaves the index tree as it was, but HEAD moved.
    #[tokio::test]
    async fn an_outside_commit_clears_the_staging_log() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        req(&api, "stage", id, &r).await.unwrap();
        r.git(&["commit", "-q", "-m", "outside"]);
        let err = staging(&api, "stagingUndo", id, &r).await.unwrap_err();
        assert_eq!(err.message, OUTSIDE);
        assert_eq!(r.git(&["diff", "--cached"]), "", "the index wasn't touched");
    }

    /// §7.6: commit and checkout clear the log (any write whose `staging()` is `Clear`).
    #[tokio::test]
    async fn a_commit_and_a_checkout_clear_the_log() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["branch", "side"]);
        r.write("a.txt", "a2\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        req(&api, "stage", id, &r).await.unwrap();
        let res = test_intents::run(&api, id, &wt(r.path()), Expect::default(), TestIntent::Commit { message: "c".into(), allow_empty: false }).await.unwrap();
        assert!(res["staging"]["undo"].is_null(), "{res}");
        r.write("a.txt", "a3\n");
        req(&api, "stage", id, &r).await.unwrap();
        r.git(&["commit", "-q", "-m", "c2"]);
        let res = test_intents::run(&api, id, &wt(r.path()), Expect::default(), TestIntent::Switch { branch: "side".into(), confirm: Default::default(), create: false }).await.unwrap();
        assert!(res["staging"]["undo"].is_null(), "{res}");
    }
}
