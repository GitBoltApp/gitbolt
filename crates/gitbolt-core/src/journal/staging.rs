//! The staging undo log (spec #2 §7.6): stage and unstage get their own undo stack, separate from
//! the journal, so a misstaged hunk can be undone without pushing real operations out of the
//! journal's 50-entry window. Per worktree, the last 100 steps, in memory only: a restart clears it.
//! A conflict resolution is a step too (ux round 2): one path's stages and file, byte for byte.

use crate::api::Api;
use crate::error::{gix_err, GbError};
use crate::events::{ChangeKind, OpKind};
use crate::journal::resolve_step::{self, PathState};
use crate::journal::{HeadState, UndoKind};
use crate::write::stage::nul_list;
use crate::write::types::{Expect, StagingUndoState, WriteResult};
use crate::write::{run_write, Staging, WriteClass, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const STAGING_CAP: usize = 100;
/// While files are conflicted with nothing to undo: stage and unstage aren't recorded then.
pub const CONFLICTED_OFF: &str = "Stage and unstage can't be undone while files are conflicted.";
pub const OUTSIDE: &str = "The index changed outside staging; staging history was cleared.";
/// A resolution's undo after its merge or rebase stop ended (or HEAD moved).
pub const RESOLVE_ENDED: &str = "The merge or rebase moved on since then; staging history was cleared.";

/// One stage or unstage, or one resolution (§7.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagingStep {
    pub label: String,
    /// HEAD when it ran (Deviation 3).
    pub head: Option<String>,
    pub change: Change,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Change {
    /// A stage or unstage: the index as a tree before and after it, and its intent-to-add
    /// paths, which trees don't carry.
    Tree { before: String, after: String, ita_before: Vec<String>, ita_after: Vec<String> },
    /// A conflict resolution: the path's stages 1/2/3 and file before, its stage 0 (or nothing)
    /// and file after, under the operation stop it was made in (`resolve_step::operation`).
    Resolve { path: String, before: PathState, after: PathState, op: Option<String> },
}

impl StagingStep {
    fn is_resolve(&self) -> bool {
        matches!(self.change, Change::Resolve { .. })
    }
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

    /// Only the resolutions stay: a tree step can't be checked while files are conflicted
    /// (`write-tree` refuses), while a resolution checks its own path.
    pub(crate) fn keep_resolves(&mut self) {
        self.undo.retain(StagingStep::is_resolve);
        self.redo.retain(StagingStep::is_resolve);
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
                (Some(b), Some(a)) if b != a => log.record(StagingStep { label: label.to_string(), head: head.oid.clone(), change: Change::Tree { before: b.tree, after: a.tree, ita_before: b.ita, ita_after: a.ita } }),
                (Some(_), Some(_)) => {} // it changed nothing
                // Conflicted, or the tree couldn't be read: not recorded, and only the
                // resolutions, which check their own path, stay undoable.
                _ => {
                    log.keep_resolves();
                    log.redo.clear();
                }
            });
        }
        Staging::Clear => cx.api.staging.with(&root, StagingLog::clear),
        Staging::Step | Staging::Keep | Staging::Own => {}
    }
}

/// `WriteResult.staging` (§3.1). In a conflicted worktree only resolutions stay in the log (its
/// stage steps are from before the conflict); with none, the buttons say why they're off.
pub(crate) fn state(api: &Api, root: &Path, conflicted: bool) -> StagingUndoState {
    api.staging.with(root, |log| {
        if !conflicted {
            return log.state(None);
        }
        log.keep_resolves();
        if log.undo.is_empty() && log.redo.is_empty() {
            log.state(Some(CONFLICTED_OFF))
        } else {
            log.state(None)
        }
    })
}

/// A resolution ran (`ResolveIntent`, which owns its staging part): `before` and `after` are its
/// path as `resolve_step::capture` kept them. Not restorable (a folder came or went): not
/// recorded, and redo goes as for any new action. The stage steps go too: they're from before
/// the conflict.
pub(crate) fn record_resolve(cx: &WriteCx<'_>, label: String, path: &str, before: PathState, after: PathState) {
    let op = resolve_step::operation(cx.root);
    cx.api.staging.with(cx.root, |log| {
        log.keep_resolves();
        if before.conflicted() && !before.same(&after) && resolve_step::restorable(&before, &after) {
            log.record(StagingStep { label, head: cx.before.head.oid.clone(), change: Change::Resolve { path: path.to_string(), before, after, op } });
        } else {
            log.redo.clear();
        }
    });
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
        match &step.change {
            Change::Tree { before, after, ita_before, ita_after } => {
                let (want, to, ita) = match self.dir {
                    Dir::Undo => (after, before, ita_before),
                    Dir::Redo => (before, after, ita_after),
                };
                self.tree(cx, &step, want, to, ita).await?;
            }
            Change::Resolve { path, before, after, op } => {
                let (want, to) = match self.dir {
                    Dir::Undo => (after, before),
                    Dir::Redo => (before, after),
                };
                self.resolve(cx, &step, path, want, to, op).await?;
            }
        }
        cx.api.staging.with(&root, |l| l.shift(self.dir == Dir::Undo));
        Ok(())
    }
}

impl StagingUndo {
    async fn tree(&self, cx: &mut WriteCx<'_>, step: &StagingStep, want: &str, to: &str, ita: &[String]) -> Result<(), GbError> {
        let root = cx.root.to_path_buf();
        let now = capture(cx).await?;
        let outside = now.as_ref().is_none_or(|c| c.tree != want) || cx.before.head.oid != step.head;
        if outside {
            cx.api.staging.with(&root, StagingLog::clear);
            return Err(GbError::stale(OUTSIDE));
        }
        let inv = cx.git(["read-tree", "--reset", to]);
        cx.run_git(inv).await?;
        let present: Vec<&String> = ita.iter().filter(|p| root.join(p).symlink_metadata().is_ok()).collect();
        if !present.is_empty() {
            let inv = cx.git(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(present));
            cx.run_git(inv).await?;
        }
        cx.touch(ChangeKind::Index);
        Ok(())
    }

    /// A resolution's undo (or redo): the path must still be as the step left it, under the same
    /// HEAD and operation stop, or nothing is touched and the log is cleared (as an outside
    /// `git add` clears it). Then its entries go back (`update-index --index-info`, every stage
    /// out first), then its file, byte for byte, with its permission bits.
    async fn resolve(&self, cx: &mut WriteCx<'_>, step: &StagingStep, path: &str, want: &PathState, to: &PathState, op: &Option<String>) -> Result<(), GbError> {
        let root = cx.root.to_path_buf();
        let refuse = |why: String| {
            cx.api.staging.with(&root, StagingLog::clear);
            Err(GbError::stale(why))
        };
        if cx.before.head.oid != step.head || resolve_step::operation(&root) != *op {
            return refuse(RESOLVE_ENDED.to_string());
        }
        let now = resolve_step::read(&root, path).await?;
        if !now.same(want) {
            let since = if self.dir == Dir::Undo { "it was resolved" } else { "its resolution was undone" };
            return refuse(format!("{path} changed since {since}; staging history was cleared."));
        }
        // Nothing is touched until both sides' bytes are loaded and the folders checked: a pruned
        // blob or a symlink in the way fails here, with the index and the file as they were.
        let kind = resolve_step::hash_kind(&root)?;
        let write = !now.disk.same(&to.disk);
        let ready = if write {
            let (r, p, d, b) = (root.clone(), path.to_string(), to.disk.clone(), now.disk.clone());
            Some(crate::api::blocking(move || Ok((resolve_step::prepare(&r, &p, &d)?, resolve_step::prepare(&r, &p, &b)?))).await?)
        } else {
            None
        };
        // The file first (temp file, then one rename, over the bytes just checked), then the index.
        if let Some((forward, _)) = &ready {
            let (r, p, f, over) = (root.clone(), path.to_string(), forward.clone(), now.disk.clone());
            crate::api::blocking(move || resolve_step::write_disk(kind, &r, &p, &f, &over)).await?;
            cx.touch(ChangeKind::Worktree);
        }
        let oid_len = to.entries.iter().chain(&want.entries).map(|e| e.oid.len()).next().unwrap_or(40);
        let inv = cx.git(["update-index", "-z", "--index-info"]).stdin(resolve_step::index_info(path, &to.entries, oid_len));
        if let Err(e) = cx.run_git(inv).await {
            // The index is as it was: the file goes back too.
            if let Some((_, back)) = ready {
                let (r, p, over) = (root.clone(), path.to_string(), to.disk.clone());
                if let Err(re) = crate::api::blocking(move || resolve_step::write_disk(kind, &r, &p, &back, &over)).await {
                    tracing::error!(target: "gitbolt_core::write", "{path}: the index update failed ({e}) and the file couldn't be put back: {re}");
                }
            }
            return Err(e);
        }
        cx.touch(ChangeKind::Index);
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
        StagingStep { label: label.into(), head: None, change: Change::Tree { before: format!("b{n}"), after: format!("a{n}"), ita_before: vec![], ita_after: vec![] } }
    }

    #[test]
    fn the_log_keeps_the_last_100_steps_and_a_new_step_clears_redo() {
        let mut log = StagingLog::default();
        for n in 0..=STAGING_CAP {
            log.record(step("stage a.txt", n));
        }
        assert_eq!(log.undo.len(), STAGING_CAP);
        assert_eq!(log.undo[0], step("stage a.txt", 1), "the oldest went first");
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

    // --- ux round 2: resolutions are staging steps ---

    /// `fixtures::conflicts` merged into main, stopped on a.txt (text), logo.bin (binary) and
    /// gone.txt (deleted on main, modified on feature/x).
    async fn merging() -> (TestRepo, Api, u32, tempfile::TempDir) {
        let r = TestRepo::new();
        crate::testing::fixtures::conflicts(&r);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        test_intents::run(&api, id, &wt(r.path()), Expect::default(), TestIntent::MergeStop { target: "feature/x".into() }).await.unwrap();
        (r, api, id, data)
    }

    async fn resolve(api: &Api, id: u32, r: &TestRepo, path: &str, resolution: Value) -> Result<Value, crate::error::GbError> {
        call(api, "resolveFile", json!({ "repo": id, "worktree": wt(r.path()), "path": path, "resolution": resolution })).await
    }

    /// The path's index entries (`ls-files -s`, every stage), and its file's bytes and mode.
    fn path_state(r: &TestRepo, path: &str) -> (String, Option<(Vec<u8>, u32)>) {
        let file = r.path().join(path);
        let disk = std::fs::symlink_metadata(&file).ok().map(|m| (std::fs::read(&file).unwrap(), crate::platform::fs::mode(&m) & 0o7777));
        (r.git(&["ls-files", "-s", "--", path]), disk)
    }

    fn unmerged(r: &TestRepo) -> String {
        r.git(&["diff", "--name-only", "--diff-filter=U"])
    }

    /// Take incoming, then Undo: stages 1/2/3, the marker file and its exec bit come back byte
    /// for byte; Redo puts the resolution back as it was.
    #[tokio::test]
    async fn take_incoming_then_undo_restores_the_conflict_byte_exact() {
        let (r, api, id, _data) = merging().await;
        crate::platform::fs::set_mode(r.path().join("a.txt"), 0o755).unwrap();
        let conflicted = path_state(&r, "a.txt");
        assert_eq!(conflicted.0.lines().count(), 3, "{}", conflicted.0);
        assert!(String::from_utf8_lossy(&conflicted.1.as_ref().unwrap().0).contains("<<<<<<<"));
        let res = resolve(&api, id, &r, "a.txt", json!({ "kind": "incoming" })).await.unwrap();
        assert_eq!(res["staging"]["undo"], "resolve a.txt with incoming", "{res}");
        assert!(res["staging"]["off"].is_null(), "other files are still conflicted, but this one can be undone");
        assert!(res["journal"]["undo"].is_null(), "not in the main journal");
        let resolved = path_state(&r, "a.txt");
        assert!(resolved.0.starts_with("100644 ") && resolved.0.contains(" 0\t"), "{}", resolved.0);
        let res = staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "a.txt"), conflicted);
        assert!(unmerged(&r).lines().any(|l| l == "a.txt"), "back in Conflicted");
        assert_eq!(res["staging"]["redo"], "resolve a.txt with incoming");
        assert!(res["staging"]["off"].is_null());
        staging(&api, "stagingRedo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "a.txt"), resolved);
    }

    /// The merge tool's save (Text), then Undo: the marker file comes back over the saved text.
    #[tokio::test]
    async fn a_merge_tool_save_is_undone() {
        let (r, api, id, _data) = merging().await;
        let conflicted = path_state(&r, "a.txt");
        let base = call(&api, "conflictFile", json!({ "repo": id, "worktree": wt(r.path()), "path": "a.txt" })).await.unwrap()["base"].clone();
        let res = call(&api, "resolveFile", json!({ "repo": id, "worktree": wt(r.path()), "path": "a.txt", "resolution": { "kind": "text", "text": "merged\n" }, "base": base })).await.unwrap();
        assert_eq!(res["staging"]["undo"], "resolve a.txt");
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "a.txt"), conflicted);
    }

    /// Mark resolved after a hand edit: Undo brings the stages back and keeps the hand edit.
    #[tokio::test]
    async fn mark_resolved_after_a_hand_edit_then_undo() {
        let (r, api, id, _data) = merging().await;
        r.write("a.txt", "fixed by hand\n");
        let edited = path_state(&r, "a.txt");
        let res = resolve(&api, id, &r, "a.txt", json!({ "kind": "asIs" })).await.unwrap();
        assert_eq!(res["staging"]["undo"], "mark a.txt resolved");
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "a.txt"), edited);
        assert!(unmerged(&r).lines().any(|l| l == "a.txt"));
    }

    /// A delete/modify conflict resolved by deleting the file, then Undo: the file and its
    /// stages 1 and 3 are back.
    #[tokio::test]
    async fn a_delete_resolution_is_undone() {
        let (r, api, id, _data) = merging().await;
        let conflicted = path_state(&r, "gone.txt");
        assert!(conflicted.1.is_some());
        let res = resolve(&api, id, &r, "gone.txt", json!({ "kind": "delete" })).await.unwrap();
        assert_eq!(res["staging"]["undo"], "resolve gone.txt by deleting it");
        assert_eq!(path_state(&r, "gone.txt"), (String::new(), None));
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "gone.txt"), conflicted);
        staging(&api, "stagingRedo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "gone.txt"), (String::new(), None));
    }

    /// The file changed after the resolution: Undo refuses, touches nothing and clears the log.
    #[tokio::test]
    async fn undo_is_refused_when_the_file_changed_since() {
        let (r, api, id, _data) = merging().await;
        resolve(&api, id, &r, "a.txt", json!({ "kind": "incoming" })).await.unwrap();
        r.write("a.txt", "edited after\n");
        let edited = path_state(&r, "a.txt");
        let err = staging(&api, "stagingUndo", id, &r).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
        assert_eq!(err.message, "a.txt changed since it was resolved; staging history was cleared.");
        assert_eq!(path_state(&r, "a.txt"), edited, "nothing was touched");
        assert!(staging(&api, "stagingState", id, &r).await.unwrap()["undo"].is_null());
    }

    /// Staging it again counts as a change too (the index side of the check).
    #[tokio::test]
    async fn undo_is_refused_when_the_resolved_file_was_restaged() {
        let (r, api, id, _data) = merging().await;
        resolve(&api, id, &r, "a.txt", json!({ "kind": "incoming" })).await.unwrap();
        r.write("a.txt", "edited after\n");
        req(&api, "stage", id, &r).await.unwrap();
        r.write("a.txt", "a\n");
        let err = staging(&api, "stagingUndo", id, &r).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
    }

    /// The merge ended outside GitBolt (`git merge --abort` in a terminal): HEAD didn't move,
    /// but the stop is gone, so Undo refuses.
    #[tokio::test]
    async fn undo_is_refused_once_the_merge_ended() {
        let (r, api, id, _data) = merging().await;
        resolve(&api, id, &r, "a.txt", json!({ "kind": "incoming" })).await.unwrap();
        r.git(&["merge", "--abort"]);
        let err = staging(&api, "stagingUndo", id, &r).await.unwrap_err();
        assert_eq!(err.message, RESOLVE_ENDED);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "nothing was touched");
    }

    /// Review 1: the file can't be written (a read-only folder): the undo fails before the index
    /// is touched, both stay as they were, and the step stays for a retry.
    #[cfg(unix)] // permission bits (a read-only folder, an unreadable file)
    #[tokio::test]
    async fn a_failed_file_write_leaves_the_index_and_the_file_as_they_were() {
        let (r, api, id, _data) = merging().await;
        let conflicted = path_state(&r, "a.txt");
        resolve(&api, id, &r, "a.txt", json!({ "kind": "incoming" })).await.unwrap();
        let resolved = path_state(&r, "a.txt");
        crate::platform::fs::set_mode(r.path(), 0o555).unwrap();
        let res = staging(&api, "stagingUndo", id, &r).await;
        crate::platform::fs::set_mode(r.path(), 0o755).unwrap();
        assert!(res.is_err(), "{res:?}");
        assert_eq!(path_state(&r, "a.txt"), resolved, "index and file untouched");
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "a.txt"), conflicted);
    }

    /// Review 1: the kept copy was pruned (`git gc --prune=now`): refused up front, nothing touched.
    #[tokio::test]
    async fn a_pruned_copy_fails_before_anything_is_touched() {
        let (r, api, id, _data) = merging().await;
        resolve(&api, id, &r, "a.txt", json!({ "kind": "incoming" })).await.unwrap();
        let resolved = path_state(&r, "a.txt");
        r.git(&["gc", "-q", "--prune=now"]);
        let err = staging(&api, "stagingUndo", id, &r).await.unwrap_err();
        assert!(err.message.contains("is gone"), "{}", err.message);
        assert_eq!(path_state(&r, "a.txt"), resolved);
    }

    /// Review 3: a file that can't be kept (unreadable) is still resolved, just not undoable.
    #[cfg(unix)] // permission bits (a read-only folder, an unreadable file)
    #[tokio::test]
    async fn a_resolution_goes_ahead_when_its_file_cant_be_kept() {
        let (r, api, id, _data) = merging().await;
        crate::platform::fs::set_mode(r.path().join("gone.txt"), 0o000).unwrap();
        let res = call(&api, "resolveFile", json!({ "repo": id, "worktree": wt(r.path()), "path": "gone.txt", "resolution": { "kind": "delete" }, "confirmDiscard": true })).await.unwrap();
        assert!(res["staging"]["undo"].is_null(), "{res}");
        assert!(!unmerged(&r).lines().any(|l| l == "gone.txt"));
        assert!(!r.path().join("gone.txt").exists());
    }

    /// Review 4: a symlink conflict: the link comes back (made under a temp name, renamed over).
    #[cfg(unix)] // symlinks (Windows: privileges, and core.symlinks=false there)
    #[tokio::test]
    async fn a_symlink_resolution_is_undone() {
        let r = TestRepo::new();
        let link = |target: &str| {
            let p = r.path().join("link");
            let _ = std::fs::remove_file(&p);
            std::os::unix::fs::symlink(target, &p).unwrap();
        };
        link("a");
        r.git(&["add", "link"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("other");
        link("b");
        r.git(&["commit", "-q", "-am", "Other"]);
        r.switch("main");
        link("c");
        r.git(&["commit", "-q", "-am", "Main"]);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        test_intents::run(&api, id, &wt(r.path()), Expect::default(), TestIntent::MergeStop { target: "other".into() }).await.unwrap();
        let state = || (r.git(&["ls-files", "-s", "--", "link"]), std::fs::read_link(r.path().join("link")).ok());
        let conflicted = state();
        assert_eq!(conflicted.0.lines().count(), 3, "{}", conflicted.0);
        resolve(&api, id, &r, "link", json!({ "kind": "incoming" })).await.unwrap();
        assert_eq!(state().1.as_deref(), Some(std::path::Path::new("b")));
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(state(), conflicted);
        let leftovers: Vec<_> = std::fs::read_dir(r.path()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(".gitbolt-undo-")).collect();
        assert!(leftovers.is_empty());
    }

    /// Review 6: a folder on the way became a symlink: what's beyond it isn't the path, so the
    /// redo (a removal) is refused and the file over there stays.
    #[cfg(unix)] // symlinks (Windows: privileges, and core.symlinks=false there)
    #[tokio::test]
    async fn a_symlinked_folder_on_the_way_is_never_followed() {
        let r = TestRepo::new();
        r.write("d/x.txt", "base\n");
        r.git(&["add", "d/x.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("other");
        r.write("d/x.txt", "theirs\n");
        r.git(&["commit", "-q", "-am", "Other"]);
        r.switch("main");
        r.write("d/x.txt", "ours\n");
        r.git(&["commit", "-q", "-am", "Main"]);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        test_intents::run(&api, id, &wt(r.path()), Expect::default(), TestIntent::MergeStop { target: "other".into() }).await.unwrap();
        resolve(&api, id, &r, "d/x.txt", json!({ "kind": "delete" })).await.unwrap();
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        let bytes = std::fs::read(r.path().join("d/x.txt")).unwrap();
        std::fs::rename(r.path().join("d"), r.path().join("e")).unwrap();
        std::os::unix::fs::symlink("e", r.path().join("d")).unwrap();
        let err = staging(&api, "stagingRedo", id, &r).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
        assert_eq!(std::fs::read(r.path().join("e/x.txt")).unwrap(), bytes, "the file beyond the link stays");
    }

    /// Stage steps from before the conflict don't survive it; resolutions survive a stage of
    /// another file meanwhile (they check their own path).
    #[tokio::test]
    async fn resolutions_outlive_unrecorded_stages_while_conflicted() {
        let (r, api, id, _data) = merging().await;
        let conflicted = path_state(&r, "a.txt");
        resolve(&api, id, &r, "a.txt", json!({ "kind": "current" })).await.unwrap();
        r.write("clean.txt", "edited\n");
        let res = call(&api, "stage", json!({ "repo": id, "worktree": wt(r.path()), "paths": ["clean.txt"] })).await.unwrap();
        assert_eq!(res["staging"]["undo"], "resolve a.txt with current", "{res}");
        staging(&api, "stagingUndo", id, &r).await.unwrap();
        assert_eq!(path_state(&r, "a.txt"), conflicted);
    }
}
