//! Cherry-pick and revert (spec #3 §3.7): git's own sequencer, one write each. A cherry-pick
//! applies its commits oldest first, a revert newest first; the request's `oids` come newest
//! first, as the graph lists them.
//! - Committing: one `git cherry-pick <oids…>` / `git revert --no-edit <oids…>`, an AnyTracked
//!   autostash, a Rewind undo. A stop (conflicts, a failing hook or signer, an empty pick) pauses
//!   (2D T2): the commit panel's Continue, Skip and Abort (`PickControl`) settle it.
//! - Without committing (T2): see `run_no_commit`.

use crate::api::{blocking, Api};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::in_progress::InProgress;
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{PausedKind, UndoKind};
use crate::write::integrate::{head_branch, BranchLabel};
use crate::write::types::{Confirm, Expect, WriteResult};
use crate::write::{run_write, Pause, Plan, Pre, WriteCx, WriteIntent};
use gix::ObjectId;
use std::collections::BTreeSet;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SequenceKind {
    CherryPick,
    Revert,
}

impl SequenceKind {
    /// The command, as git names it.
    pub(crate) fn git(self) -> &'static str {
        match self {
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }

    fn paused(self) -> PausedKind {
        match self {
            Self::CherryPick => PausedKind::CherryPick,
            Self::Revert => PausedKind::Revert,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum SequenceOutcome {
    /// Every commit applied: `commits` new commits, or (`committed: false`) staged changes.
    Done { commits: u32, committed: bool },
    /// Stopped at `at` (the commit being applied) with `files` conflicted, after `applied` of them
    /// went in. Committing: paused, for Continue / Skip / Abort. Without committing: nothing is in
    /// progress; the conflicted files wait in the Conflicted section.
    Stopped {
        files: u32,
        at: Option<String>,
        applied: u32,
        committed: bool,
        /// UX R1 C.1: a committing stop with no conflicts: git's error (the commit failed: a
        /// hook, the signer, an empty pick). The changes wait staged, paused.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
    },
}

/// How labels and the pause name the commits: `a1b2c3d` for one, `3 commits` for more.
pub(crate) fn what(oids: &[String]) -> String {
    match oids {
        [one] => one.chars().take(7).collect(),
        many => format!("{} commits", many.len()),
    }
}

/// A commit this can apply: it exists, and isn't a merge (spec #3 §3.7, §8: "pick a parent" is
/// out of scope).
fn pickable(repo: &gix::Repository, hex: &str) -> Result<ObjectId, GbError> {
    let short: String = hex.chars().take(7).collect();
    let id = ObjectId::from_hex(hex.as_bytes()).map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {hex}")))?;
    let commit = repo.find_commit(id).map_err(|_| GbError::new(GbErrorKind::NotFound, format!("{short} isn't a commit in this repository")))?;
    if commit.parent_ids().count() > 1 {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{short} is a merge commit: GitBolt doesn't cherry-pick or revert merges")));
    }
    Ok(id)
}

pub(crate) struct SequenceIntent {
    pub kind: SequenceKind,
    /// Newest first, as the graph lists them.
    pub oids: Vec<String>,
    pub no_commit: bool,
    pub confirm: Confirm,
    pub label: BranchLabel,
}

impl SequenceIntent {
    /// The order git applies them in: oldest first for a cherry-pick, newest first for a revert.
    fn applied_order(&self) -> Vec<String> {
        match self.kind {
            SequenceKind::CherryPick => self.oids.iter().rev().cloned().collect(),
            SequenceKind::Revert => self.oids.clone(),
        }
    }

    /// "Without committing": one `git <kind> --no-commit <oid>` per commit, in git's order, so
    /// a stop knows which commit stopped it and how many went in, and no sequencer state is made.
    /// After each, `--quit` forgets whatever git left in progress (`revert --no-commit` leaves
    /// REVERT_HEAD for a later `git commit`), keeping the index and the files: nothing blocks the
    /// next write or the Undo. A conflict stops it with the conflicted files in the index (the
    /// Conflicted section, the merge tool); there's nothing to Continue.
    async fn run_no_commit(&self, cx: &mut WriteCx<'_>) -> Result<SequenceOutcome, GbError> {
        // T2 fix round 1 (E): what's dirty outside P now, before any pick, is the user's.
        let before = crate::write::precheck::dirty(&cx.api.cli, cx.root).await?;
        let before_dirty: BTreeSet<String> = before.tracked.into_iter().chain(before.untracked).collect();
        let mut attempted = BTreeSet::new();
        let mut applied = 0u32;
        for oid in self.applied_order() {
            let root = cx.root.to_path_buf();
            let hex = oid.clone();
            let paths = blocking(move || commit_paths(&gix::open(&root).map_err(gix_err)?, &hex)).await?;
            let inv = cx.git([self.kind.git(), "--no-commit", oid.as_str()]);
            let res = cx.run_git(inv).await;
            for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::State] {
                cx.touch(k);
            }
            if let Err(e) = res {
                // Fix round 2 (3): nothing here hides the error that stopped it.
                let files = crate::write::precheck::dirty(&cx.api.cli, cx.root).await.map_or(0, |d| d.conflicted);
                if files == 0 {
                    // 3B final fix (2): a failure without conflicts (a file in the way) changed
                    // nothing of its own. Before anything else changed, there's no entry; after
                    // an earlier commit went in (or should the failed step have left a change),
                    // the entry is a stopped one over what the run changed: its Undo discards
                    // exactly that, never stashing the run's own changes as the user's.
                    let changed = self.widen(cx, &before_dirty).await;
                    if applied > 0 || !changed.is_empty() {
                        cx.partial = true;
                        attempted.extend(changed);
                        self.mark_stopped(cx, self.kind.git(), &attempted);
                    }
                    if let Err(q) = self.quit_in_progress(cx).await {
                        tracing::warn!(target: "gitbolt_core::write", "dropping the failed {}: {q}", self.kind.git());
                    }
                    return Err(e);
                }
                // A conflict changed the index and the files: the entry stays, whatever follows.
                cx.partial = true;
                attempted.extend(paths);
                // No `after` snapshot: an unmerged index can't be snapshotted (Deviation 6). The
                // entry is marked first (fix rounds 1 H, 2), before anything that can fail: its
                // Undo asks, then discards what the run changed, unmerged paths included; the
                // rest of P (commits never applied) is left alone (D).
                let op = self.kind.git().to_string();
                self.mark_stopped(cx, &op, &attempted);
                // Fix round 2 (1): all of P was clean before the run, so what's dirty now and
                // wasn't then is exactly what the run changed, a rename-followed change landing
                // on a path of a commit that never ran included.
                let changed = self.widen(cx, &before_dirty).await;
                if !changed.is_empty() {
                    attempted.extend(changed);
                    self.mark_stopped(cx, &op, &attempted);
                }
                self.quit_in_progress(cx).await?;
                return Ok(SequenceOutcome::Stopped { files, at: Some(oid), applied, committed: false, error: None });
            }
            // From the first commit in, the index and the files changed: a later failure keeps
            // the entry.
            cx.partial = true;
            attempted.extend(paths);
            self.quit_in_progress(cx).await?;
            applied += 1;
        }
        self.widen(cx, &before_dirty).await;
        let snap = cx.snapshot.clone().ok_or_else(|| GbError::other("the pick has no snapshot"))?;
        cx.after = Some(crate::journal::snapshot::create(&cx.snapshots(), &self.label(), &snap.paths, &snap.untracked).await?);
        Ok(SequenceOutcome::Done { commits: applied, committed: false })
    }

    /// `--quit` whatever git left in progress (REVERT_HEAD, CHERRY_PICK_HEAD), keeping the
    /// index and the files.
    async fn quit_in_progress(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        if matches!(crate::in_progress::read(cx.root).ok().flatten(), Some(InProgress::CherryPick { .. } | InProgress::Revert { .. })) {
            uncancellable(cx, [self.kind.git(), "--quit"]).await?;
        }
        Ok(())
    }

    /// The entry's `StoppedPick` marker, over `paths`. Best effort (fix round 2): a journal
    /// failure is logged, and the caller still quits what git left in progress.
    fn mark_stopped(&self, cx: &mut WriteCx<'_>, op: &str, paths: &BTreeSet<String>) {
        let stopped = crate::journal::StoppedPick { op: op.to_string(), paths: paths.iter().cloned().collect() };
        if let Err(e) = cx.edit_entry(|e| e.stopped_pick = Some(stopped)) {
            tracing::warn!(target: "gitbolt_core::write", "marking the stopped {op}: {e}");
        }
    }

    /// T2 fix round 1 (E): P follows the commits' own paths, but git follows renames on HEAD's
    /// side (a change to x.txt lands in y.txt, which HEAD renamed it to). Every path the run
    /// changed outside P (dirty now, and not before it) joins P: in the `before` snapshot (whose
    /// trees hold HEAD's state there, which it was in: git refuses to touch a dirty path) and in
    /// the `after` one. Returns every path the run changed (dirty now and not before), P's
    /// included. Best effort (fix round 2): a failure is logged, and nothing is widened.
    async fn widen(&self, cx: &mut WriteCx<'_>, before_dirty: &BTreeSet<String>) -> Vec<String> {
        let now = match crate::write::precheck::dirty(&cx.api.cli, cx.root).await {
            Ok(now) => now,
            Err(e) => {
                tracing::warn!(target: "gitbolt_core::write", "reading what the {} changed: {e}", self.kind.git());
                return Vec::new();
            }
        };
        let changed: BTreeSet<String> = now.tracked.into_iter().chain(now.untracked).chain(now.unmerged).filter(|p| !before_dirty.contains(p)).collect();
        let Some(snap) = cx.snapshot.as_mut() else { return changed.into_iter().collect() };
        let extra: Vec<String> = changed.iter().filter(|p| !snap.paths.contains(p)).cloned().collect();
        if !extra.is_empty() {
            snap.paths.extend(extra.iter().cloned());
            if let Err(e) = cx.edit_entry(|e| {
                if let Some(b) = e.before.as_mut() {
                    b.paths.extend(extra);
                }
            }) {
                tracing::warn!(target: "gitbolt_core::write", "widening the {}'s snapshot: {e}", self.kind.git());
            }
        }
        changed.into_iter().collect()
    }
}

/// The paths `hex` changes against its first parent (a root commit: its whole tree).
fn commit_paths(repo: &gix::Repository, hex: &str) -> Result<BTreeSet<String>, GbError> {
    let id = ObjectId::from_hex(hex.as_bytes()).map_err(gix_err)?;
    let parent = repo.find_commit(id).map_err(gix_err)?.parent_ids().next().map(|p| p.detach()).unwrap_or_else(|| repo.empty_tree().id);
    crate::write::precheck::tree_diff_paths(repo, parent, id)
}

impl WriteIntent for SequenceIntent {
    type Outcome = SequenceOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        self.label.get()
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(if self.no_commit { UndoKind::Restore } else { UndoKind::Rewind })
    }
    /// Its commits run `prepare-commit-msg`, `commit-msg` and `post-commit`, and may sign.
    fn runs_hooks(&self) -> bool {
        true
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let refuse = |m: &str| GbError::new(GbErrorKind::InvalidInput, m);
        let branch = pre.before.head.branch.as_deref().ok_or_else(|| {
            refuse(match self.kind {
                SequenceKind::CherryPick => "Check out a branch to cherry-pick onto it",
                SequenceKind::Revert => "Check out a branch to make the revert on",
            })
        })?;
        self.label.settle(branch);
        // Fix round 1: an unborn branch has no commit to pick onto (git would make a root commit
        // of the pick, and Undo would have no tip to rewind to).
        if pre.before.head.oid.is_none() {
            return Err(refuse("Make a first commit first"));
        }
        if self.oids.is_empty() {
            return Err(refuse(match self.kind {
                SequenceKind::CherryPick => "Nothing to cherry-pick",
                SequenceKind::Revert => "Nothing to revert",
            }));
        }
        let repo = gix::open(pre.root).map_err(gix_err)?;
        for hex in &self.oids {
            pickable(&repo, hex)?;
        }
        // P: every path the commits change (a root commit: its whole tree).
        let mut paths = BTreeSet::new();
        for hex in &self.oids {
            paths.extend(commit_paths(&repo, hex)?);
        }
        if self.no_commit {
            // The snapshot over P is the Undo; the user's own changes there would be mixed in, so
            // they refuse.
            let dirty = crate::write::precheck::dirty(&pre.api.cli, pre.root).await?;
            if let Some(p) = dirty.tracked.iter().chain(&dirty.untracked).find(|p| paths.contains(*p)) {
                return Err(GbError::new(GbErrorKind::DirtyWorktree, format!("Commit or stash your changes to {p} first: the {} changes it too", self.kind.git())));
            }
            return Ok(Plan { snapshot: Some((paths.into_iter().collect(), Vec::new())), ..Plan::default() });
        }
        // Fix round 1: P is what the picks touch, so an untracked file there is stashed too.
        Ok(Plan { autostash: Some(AutostashSpec { rule: AutostashRule::Touching(paths.into_iter().collect()), target: None, op: self.label.get(), target_name: Some(what(&self.oids)) }), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<SequenceOutcome, GbError> {
        if self.no_commit {
            return self.run_no_commit(cx).await;
        }
        run_sequence(cx, self.kind, &self.applied_order(), &what(&self.oids)).await
    }
}

// --- 3B T1 fix round 1: the sequencer's leftover ---
/// `.git/sequencer/` (the worktree's own git dir).
pub(crate) async fn sequencer_dir(root: &std::path::Path) -> Result<std::path::PathBuf, GbError> {
    let root = root.to_path_buf();
    blocking(move || Ok(gix::open(&root).map_err(gix_err)?.git_dir().join("sequencer"))).await
}

/// A sequence that failed part-way on something other than a stop (an untracked file in the
/// way, a failed checkout, a Cancel) leaves `.git/sequencer/` with nothing in progress: GitBolt
/// can't see it, and every later cherry-pick or revert fails on it. `--quit` drops it and keeps
/// the commits that went in. True when there was one and it went.
/// Fix round 2: its own invocation, without the op's cancel token (after a Cancel it has fired,
/// as for the rebase's abort), and never an error of its own: a failure is logged, and the
/// caller reports the error that stopped the sequence.
pub(crate) async fn quit_leftover_sequencer(cx: &mut WriteCx<'_>, what: &str) -> bool {
    if crate::in_progress::read(cx.root).ok().flatten().is_some() {
        return false;
    }
    match sequencer_dir(cx.root).await {
        Ok(dir) if dir.exists() => {}
        Ok(_) => return false,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "looking for a {what}'s leftover sequencer: {e}");
            return false;
        }
    }
    match uncancellable(cx, [what, "--quit"]).await {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "dropping a {what}'s leftover sequencer: {e}");
            false
        }
    }
}

/// 3B final fix (5): `.git/sequencer/todo` still lists commits, as after a `git commit` in a
/// terminal that concluded one pick of a sequence: `git cherry-pick --continue` there goes on
/// with the rest, so it isn't a leftover to drop.
pub(crate) async fn sequencer_has_todo(root: &std::path::Path) -> bool {
    let Ok(dir) = sequencer_dir(root).await else { return false };
    std::fs::read_to_string(dir.join("todo")).is_ok_and(|t| {
        t.lines().any(|l| {
            let l = l.trim();
            !l.is_empty() && !l.starts_with('#')
        })
    })
}

/// A cleanup step's own invocation, without the op's cancel token (after a Cancel it has
/// fired), as the rebase's abort after a Cancel.
async fn uncancellable<const N: usize>(cx: &mut WriteCx<'_>, args: [&str; N]) -> Result<(), GbError> {
    let inv = crate::git::GitInvocation::write(&cx.token, cx.root, args).detach_terminal().stream_stderr(cx.output());
    let res = cx.api.cli.run(inv).await;
    for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Head, ChangeKind::Refs, ChangeKind::State] {
        cx.touch(k);
    }
    res.map(|_| ())
}
// --- end 3B T1 fix round 1 ---

/// One `git cherry-pick` / `git revert --no-edit` over `oids` (in the order git applies them).
/// Stopped with the operation still in progress, it pauses with `what` as the banner's target.
async fn run_sequence(cx: &mut WriteCx<'_>, kind: SequenceKind, oids: &[String], what: &str) -> Result<SequenceOutcome, GbError> {
    let old = cx.before.head.oid.clone().unwrap_or_default();
    // One there already isn't this run's to drop (git refuses to start over it anyway).
    let had_sequencer = sequencer_dir(cx.root).await?.exists();
    let mut args = vec![kind.git().to_string()];
    if kind == SequenceKind::Revert {
        args.push("--no-edit".into());
    }
    args.extend(oids.iter().cloned());
    let inv = cx.git(args);
    let res = cx.run_git(inv).await;
    for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Head, ChangeKind::Refs, ChangeKind::State] {
        cx.touch(k);
    }
    let cancelled = |e: &GbError, cx: &WriteCx<'_>| e.kind == GbErrorKind::Cancelled || cx.op.cancel.is_cancelled();
    // --- 3B T1 fix round 2 (A) ---
    // A Cancel aborts the sequence it started, as a cancelled rebase does (2D review M2): git was
    // killed mid-pick (CHERRY_PICK_HEAD after the commit, in a hook or the signer) or between
    // picks (the sequencer alone). `--abort` puts the branch back and drops both. Its own
    // invocation: the op's cancel token has fired. Should it fail, what's left pauses or quits
    // below.
    if let Err(e) = &res
        && cancelled(e, cx)
        && !had_sequencer
        && (crate::in_progress::read(cx.root).ok().flatten().is_some() || sequencer_dir(cx.root).await.is_ok_and(|d| d.exists()))
    {
        match uncancellable(cx, [kind.git(), "--abort"]).await {
            Ok(()) => {
                // Killed after a commit, before git recorded it (in post-commit, say), git "won't
                // rewind": it keeps the commits and CHERRY_PICK_HEAD. `--quit` drops that; what
                // went in stays, and the entry's Undo takes it back. Should the quit fail, it's
                // still in progress: it pauses below (fix round 2, 4).
                let dropped = if crate::in_progress::read(cx.root).ok().flatten().is_some() {
                    match uncancellable(cx, [kind.git(), "--quit"]).await {
                        Ok(()) => true,
                        Err(q) => {
                            tracing::warn!(target: "gitbolt_core::write", "dropping the cancelled {}: {q}", kind.git());
                            false
                        }
                    }
                } else {
                    true
                };
                if dropped {
                    let mut e = e.clone();
                    let n = applied(cx, &old).await;
                    if n > 0 {
                        e.message = format!("{} ({n} of {} applied, the rest weren't)", e.message.trim_end(), oids.len());
                    }
                    return Err(e);
                }
            }
            Err(a) => tracing::warn!(target: "gitbolt_core::write", "aborting the cancelled {}: {a}", kind.git()),
        }
    }
    // --- end 3B T1 fix round 2 ---
    match res {
        Ok(_) => Ok(SequenceOutcome::Done { commits: applied(cx, &old).await, committed: true }),
        Err(e) => match crate::in_progress::read(cx.root).ok().flatten() {
            Some(InProgress::CherryPick { conflicted, head, .. } | InProgress::Revert { conflicted, head, .. }) => {
                cx.paused = Some(Pause { kind: kind.paused(), target: what.to_string(), target_oid: None, put_back: Vec::new(), picked: oids.to_vec(), irebase: None });
                // A Cancel whose abort failed leaves it paused where git stopped.
                if cancelled(&e, cx) {
                    return Err(e);
                }
                // UX R1 C.1: no conflicts, so the commit itself failed: its error goes with it.
                let error = Some(e.message.trim().to_string()).filter(|m| conflicted == 0 && !m.is_empty());
                Ok(SequenceOutcome::Stopped { files: conflicted, at: head, applied: applied(cx, &old).await, committed: true, error })
            }
            _ => {
                // Fix round 1: failed part-way with nothing in progress. The commits that went in
                // stay (the entry's Undo takes them back); the sequencer's leftover goes.
                if !had_sequencer && quit_leftover_sequencer(cx, kind.git()).await {
                    let n = applied(cx, &old).await;
                    let mut e = e;
                    e.message = format!("{} ({n} of {} applied, the rest weren't)", e.message.trim_end(), oids.len());
                    return Err(e);
                }
                Err(e)
            }
        },
    }
}

/// The commits HEAD gained since `old`. Fix round 1 (m3): counting never loses a pause or a
/// result; an unknown count reads 0.
async fn applied(cx: &WriteCx<'_>, old: &str) -> u32 {
    match crate::write::precheck::commits_not_in(&cx.api.cli, cx.root, "HEAD", old).await {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "counting the applied commits: {e}");
            0
        }
    }
}

/// `CherryPick` / `Revert` (spec #3 §3.7). The label names HEAD's branch as seen now, and settles
/// under the lock.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sequence(api: &Api, repo: u32, worktree: &str, kind: SequenceKind, oids: Vec<String>, no_commit: bool, expect: Expect, confirm: Confirm) -> Result<WriteResult<SequenceOutcome>, GbError> {
    let root = std::path::PathBuf::from(worktree);
    let seen = blocking(move || Ok(gix::open(&root).ok().and_then(|r| head_branch(&r)))).await?;
    let w = what(&oids);
    let suffix = if no_commit { " without committing" } else { "" };
    let label = match kind {
        SequenceKind::CherryPick => BranchLabel::new(seen, move |b| format!("cherry-pick {w} onto {b}{suffix}")),
        SequenceKind::Revert => BranchLabel::new(seen, move |_| format!("revert {w}{suffix}")),
    };
    run_write(api, repo, worktree, expect, SequenceIntent { kind, oids, no_commit, confirm, label }).await
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, journal_step, open, repo, wt};
    use serde_json::{json, Value};

    /// main: `one`; `feature` adds f1, f2, f3 in three commits. HEAD: main. Oids oldest first.
    fn three_on_feature() -> (TestRepo, Vec<String>) {
        let r = repo();
        r.switch_new("feature");
        let oids = ["f1", "f2", "f3"]
            .iter()
            .map(|n| {
                r.write(&format!("{n}.txt"), &format!("{n}\n"));
                r.git(&["add", &format!("{n}.txt")]);
                r.git(&["commit", "-q", "-m", &format!("Add {n}")]);
                r.git(&["rev-parse", "HEAD"])
            })
            .collect();
        r.switch("main");
        (r, oids)
    }

    /// main and feature both change c.txt from "base"; feature first adds n.txt (clean to pick).
    /// HEAD: main. Returns (repo, "Add n", "Fix x").
    pub(super) fn two_sides() -> (TestRepo, String, String) {
        let r = repo();
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("n.txt", "n\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Add n"]);
        let add_n = r.git(&["rev-parse", "HEAD"]);
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        let fix = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        (r, add_n, fix)
    }

    fn newest_first(oids: &[String]) -> Vec<String> {
        oids.iter().rev().cloned().collect()
    }

    fn req(id: u32, r: &TestRepo, oids: &[String], no_commit: bool) -> Value {
        json!({"repo": id, "worktree": wt(r.path()), "oids": oids, "noCommit": no_commit})
    }

    async fn state(api: &crate::api::Api, id: u32, r: &TestRepo) -> Value {
        call(api, "journalState", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap()
    }

    #[tokio::test]
    async fn cherry_picks_apply_oldest_first_and_undo_rewinds() {
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        let before = r.git(&["rev-parse", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &newest_first(&oids), false)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 3, "committed": true}));
        assert_eq!(r.git(&["log", "--format=%s", "-3"]), "Add f3\nAdd f2\nAdd f1");
        assert_eq!(res["journal"]["undo"]["label"], "cherry-pick 3 commits onto main");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    #[tokio::test]
    async fn reverts_apply_newest_first() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        for n in ["r1", "r2"] {
            r.write(&format!("{n}.txt"), "x\n");
            r.git(&["add", &format!("{n}.txt")]);
            r.git(&["commit", "-q", "-m", &format!("Add {n}")]);
        }
        let (r2, r1) = (r.git(&["rev-parse", "HEAD"]), r.git(&["rev-parse", "HEAD~1"]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "revert", req(id, &r, &[r2.clone(), r1.clone()], false)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 2, "committed": true}));
        assert_eq!(r.git(&["log", "--format=%s", "-2"]), "Revert \"Add r1\"\nRevert \"Add r2\"");
        assert!(!r.path().join("r1.txt").exists() && !r.path().join("r2.txt").exists());
        assert_eq!(res["journal"]["undo"]["label"], "revert 2 commits");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD"]), r2);
    }

    #[tokio::test]
    async fn merges_detached_heads_empty_requests_and_operations_in_progress_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("m");
        r.switch_new("side");
        r.commit("s");
        r.switch("m");
        r.commit("m1");
        let merge = r.merge("side", "Merge side");
        r.switch("main");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&merge), false)).await.unwrap_err();
        assert_eq!((e.kind, e.message), (GbErrorKind::InvalidInput, format!("{} is a merge commit: GitBolt doesn't cherry-pick or revert merges", &merge[..7])));
        let e = call(&api, "revert", req(id, &r, &[], false)).await.unwrap_err();
        assert_eq!(e.message, "Nothing to revert");
        r.git(&["switch", "-q", "--detach", "main"]);
        let e = call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&merge), false)).await.unwrap_err();
        assert_eq!(e.message, "Check out a branch to cherry-pick onto it");
        r.switch("main");
        let (s, _, fix) = two_sides();
        assert!(s.try_git(&["cherry-pick", &fix]).is_err(), "a conflict started outside GitBolt");
        let sid = open(&api, &s).await;
        let e = call(&api, "cherryPick", req(sid, &s, &[fix], false)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InProgress);
    }

    /// Review Focus 1: the autostash waits through the pause; Continue lands the pick and gives
    /// the changes back; Undo takes the pick back and leaves them alone.
    #[tokio::test]
    async fn a_paused_pick_keeps_the_autostash_until_continue() {
        let data = tempfile::tempdir().unwrap();
        let (r, _, fix) = two_sides();
        let before = r.git(&["rev-parse", "main"]);
        r.write("a.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&fix), false)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "stopped", "files": 1, "at": fix, "applied": 0, "committed": true}));
        assert_eq!((res["journal"]["paused"]["kind"].as_str(), res["journal"]["paused"]["target"].as_str()), (Some("cherryPick"), Some(&fix[..7])));
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a\n", "stashed while paused");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = call(&api, "pickControl", json!({"repo": id, "worktree": wt(r.path()), "action": "continue"})).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done"}));
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(res["journal"]["undo"]["label"], format!("cherry-pick {} onto main", &fix[..7]));
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "dirty\n", "given back at the end");
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Fix x");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "dirty\n");
    }

    /// Review Focus 3.
    #[tokio::test]
    async fn a_pick_aborted_in_a_terminal_settles_and_restores_the_autostash() {
        let data = tempfile::tempdir().unwrap();
        let (r, _, fix) = two_sides();
        r.write("a.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&fix), false)).await.unwrap();
        r.git(&["cherry-pick", "--abort"]);
        let res = call(&api, "settlePaused", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert!(res["journal"]["paused"].is_null());
        assert!(res["journal"]["undo"].is_null(), "an abort leaves nothing to undo");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "dirty\n");
    }

    /// §7: a revert's conflict pauses as a revert; the commit panel's Abort ends it.
    #[tokio::test]
    async fn a_revert_conflict_pauses_and_abort_drops_the_entry() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        for v in ["1", "2", "3"] {
            r.write("c.txt", &format!("{v}\n"));
            r.git(&["add", "c.txt"]);
            r.git(&["commit", "-q", "-m", &format!("c{v}")]);
        }
        let head = r.git(&["rev-parse", "HEAD"]);
        let two = r.git(&["rev-parse", "HEAD~1"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "revert", req(id, &r, std::slice::from_ref(&two), false)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped");
        assert_eq!(res["journal"]["paused"]["kind"], "revert");
        let res = call(&api, "pickControl", json!({"repo": id, "worktree": wt(r.path()), "action": "abort"})).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "aborted"}));
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        let s = state(&api, id, &r).await;
        assert!(s["paused"].is_null() && s["undo"].is_null());
    }

    /// Spec #3 §3.7's "without committing": the changes staged, HEAD where it was, one Undo.
    #[tokio::test]
    async fn without_committing_stages_the_changes_and_undo_restores() {
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        let head = r.git(&["rev-parse", "HEAD"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &newest_first(&oids), true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 3, "committed": false}));
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "f1.txt\nf2.txt\nf3.txt");
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
        assert_eq!(res["journal"]["undo"]["label"], "cherry-pick 3 commits onto main without committing");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "");
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "f1.txt\nf2.txt\nf3.txt");
    }

    /// UX R1 C.2: right after a no-commit pick that added a file (staged), Discard all removes
    /// it at the first try, index and file both.
    #[tokio::test]
    async fn discard_all_right_after_a_no_commit_pick_removes_the_added_file() {
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &oids[..1], true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 1, "committed": false}));
        assert_eq!(r.git(&["status", "--porcelain"]), "A  f1.txt");
        call(&api, "discard", json!({"repo": id, "worktree": wt(r.path()), "scope": {"kind": "all"}})).await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain", "--untracked-files=all"]), "");
        assert!(!r.path().join("f1.txt").exists());
    }

    /// UX R1 C.1: a normal pick commits at once; one whose commit fails (here the signer) stops
    /// paused, its changes staged, and says why (the toast names the commit error).
    #[tokio::test]
    async fn a_pick_whose_commit_fails_stops_with_the_error() {
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &oids[..1], false)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 1, "committed": true}));
        assert_eq!(r.git(&["status", "--porcelain"]), "");
        r.git(&["config", "commit.gpgsign", "true"]);
        r.git(&["config", "gpg.program", "false"]);
        let res = call(&api, "cherryPick", req(id, &r, &oids[1..2], false)).await.unwrap();
        let o = &res["outcome"];
        assert_eq!((&o["status"], &o["files"], &o["committed"]), (&json!("stopped"), &json!(0), &json!(true)), "{o}");
        assert!(o["error"].as_str().is_some_and(|m| m.contains("gpg") || m.contains("sign")), "{o}");
        assert_eq!(r.git(&["status", "--porcelain"]), "A  f2.txt");
        assert!(matches!(crate::in_progress::read(r.path()).unwrap(), Some(crate::in_progress::InProgress::CherryPick { .. })));
    }

    /// Review Focus 4: `revert --no-commit` leaves REVERT_HEAD for a later `git commit`;
    /// GitBolt's leaves nothing in progress, so the next write (Undo here) isn't refused.
    #[tokio::test]
    async fn a_revert_without_committing_leaves_nothing_in_progress() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("r1.txt", "r1\n");
        r.git(&["add", "r1.txt"]);
        r.git(&["commit", "-q", "-m", "Add r1"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "revert", req(id, &r, std::slice::from_ref(&head), true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 1, "committed": false}));
        assert_eq!(r.git(&["status", "--porcelain"]), "D  r1.txt");
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
        assert!(!r.path().join(".git/REVERT_HEAD").exists());
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
    }

    #[tokio::test]
    async fn without_committing_refuses_over_your_own_changes_to_the_same_files() {
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        r.write("f2.txt", "mine\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "cherryPick", req(id, &r, &newest_first(&oids), true)).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::DirtyWorktree, "Commit or stash your changes to f2.txt first: the cherry-pick changes it too"));
        assert_eq!(r.git(&["status", "--porcelain"]), "?? f2.txt");
        assert_eq!(std::fs::read_to_string(r.path().join("f2.txt")).unwrap(), "mine\n");
    }

    /// A conflict stops it: what applied stays staged, the conflicted file waits in the index,
    /// nothing is in progress (no Continue), and Undo puts it all back: after its question, with
    /// no autostash, the unmerged path included.
    #[tokio::test]
    async fn a_conflict_without_committing_stops_and_undo_restores() {
        let data = tempfile::tempdir().unwrap();
        let (r, add_n, fix) = two_sides();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &[fix.clone(), add_n], true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "stopped", "files": 1, "at": fix, "applied": 1, "committed": false}));
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "c.txt");
        assert!(r.git(&["diff", "--cached", "--name-only"]).contains("n.txt"));
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
        // The question first: nothing changes.
        let e = journal_step(&api, id, r.path(), "undo").await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::Conflict, "Undo the stopped cherry-pick? Its changes are discarded, including anything you resolved since."));
        assert_eq!(e.detail, Some(crate::error::ErrorDetail::UndoStoppedPick { op: "cherry-pick".into(), arm: "Click again to undo: discards the stopped cherry-pick's changes".into() }));
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "c.txt", "asked before anything is written");
        // Confirmed: P goes back as it was, the unmerged path included, and nothing is stashed.
        let entry = state(&api, id, &r).await["undo"]["entry"].clone();
        call(&api, "undo", json!({"repo": id, "worktree": wt(r.path()), "entry": entry, "confirmDiscard": true})).await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "");
        assert_eq!(std::fs::read_to_string(r.path().join("c.txt")).unwrap(), "main\n");
        assert_eq!(r.git(&["stash", "list"]), "", "no autostash");
        let s = state(&api, id, &r).await;
        assert!(s["redo"].is_null() && s["undo"].is_null(), "no dead Redo (fix round 1, F): {s}");
    }

    /// Only a stopped pick's entry restores over unmerged paths: any other Restore entry (a
    /// discard here) still refuses, `confirmDiscard` or not, and leaves the conflict as it is.
    #[tokio::test]
    async fn a_normal_entry_still_refuses_unmerged_paths() {
        let data = tempfile::tempdir().unwrap();
        let (r, _, _) = two_sides();
        r.write("c.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "discard", json!({"repo": id, "worktree": wt(r.path()), "scope": {"kind": "paths", "paths": ["c.txt"]}})).await.unwrap();
        // c.txt unmerged, with nothing in progress.
        assert!(r.try_git(&["merge", "feature"]).is_err());
        r.git(&["merge", "--quit"]);
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "c.txt");
        let entry = state(&api, id, &r).await["undo"]["entry"].clone();
        let e = call(&api, "undo", json!({"repo": id, "worktree": wt(r.path()), "entry": entry, "confirmDiscard": true, "confirmAutostash": true})).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InProgress, "c.txt has merge conflicts: resolve conflicts first"));
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "c.txt", "the conflict is left alone");
        assert_eq!(state(&api, id, &r).await["undo"]["entry"], entry, "still on the undo stack");
    }

    // --- 3B T1 fix round 1 ---

    /// `two_sides`, plus "Add m" (m.txt) on top of feature. Returns (repo, "Fix x", "Add m").
    fn conflict_then_clean() -> (TestRepo, String, String) {
        let (r, _, fix) = two_sides();
        r.switch("feature");
        r.write("m.txt", "m\n");
        r.git(&["add", "m.txt"]);
        r.git(&["commit", "-q", "-m", "Add m"]);
        let add_m = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        (r, fix, add_m)
    }

    fn sequencer(r: &TestRepo) -> bool {
        r.path().join(".git/sequencer").exists()
    }

    fn continue_pick(id: u32, r: &TestRepo) -> Value {
        json!({"repo": id, "worktree": wt(r.path()), "action": "continue"})
    }

    /// Finding 1: a pick aborted in a terminal, then other work committed there, is an abort:
    /// the entry goes, so its Undo can't take that work away.
    #[tokio::test]
    async fn work_committed_after_a_terminal_abort_is_never_taken_for_the_pick() {
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        // A cherry-pick.
        let (r, _, fix) = two_sides();
        let id = open(&api, &r).await;
        call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&fix), false)).await.unwrap();
        r.git(&["cherry-pick", "--abort"]);
        r.commit("my own work");
        let res = call(&api, "settlePaused", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert!(res["journal"]["paused"].is_null());
        assert!(res["journal"]["undo"].is_null(), "not the pick's commit: {}", res["journal"]);
        // A revert.
        let v = repo();
        for n in ["1", "2", "3"] {
            v.write("c.txt", &format!("{n}\n"));
            v.git(&["add", "c.txt"]);
            v.git(&["commit", "-q", "-m", &format!("c{n}")]);
        }
        let two = v.git(&["rev-parse", "HEAD~1"]);
        let vid = open(&api, &v).await;
        let res = call(&api, "revert", req(vid, &v, std::slice::from_ref(&two), false)).await.unwrap();
        assert_eq!(res["journal"]["paused"]["kind"], "revert");
        v.git(&["revert", "--abort"]);
        v.commit("my own work");
        let res = call(&api, "settlePaused", json!({"repo": vid, "worktree": wt(v.path())})).await.unwrap();
        assert!(res["journal"]["paused"].is_null() && res["journal"]["undo"].is_null());
    }

    /// Finding 2a: an untracked file on a path a later pick adds is stashed, so git doesn't stop
    /// part-way on it.
    #[tokio::test]
    async fn an_untracked_file_where_a_pick_adds_one_is_stashed_first() {
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        r.write("f2.txt", "mine\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", json!({"repo": id, "worktree": wt(r.path()), "oids": newest_first(&oids[..2]), "confirm": {"autostash": true}})).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 2, "committed": true}));
        assert!(!sequencer(&r));
        assert!(r.git(&["stash", "list", "--format=%gs"]).contains("autostash before cherry-pick 2 commits onto main"), "the file is kept in the stash");
    }

    /// Finding 2b: a pick that fails part-way with nothing in progress (here a post-commit hook
    /// puts an untracked file where the second pick adds one) keeps what went in, drops git's
    /// sequencer, and says so; the next pick isn't blocked.
    #[tokio::test]
    async fn a_failure_part_way_drops_the_sequencer_and_keeps_what_went_in() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        let before = r.git(&["rev-parse", "main"]);
        let hook = r.path().join(".git/hooks/post-commit");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\n[ -e f2.txt ] || echo hook > f2.txt\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "cherryPick", req(id, &r, &newest_first(&oids[..2]), false)).await.unwrap_err();
        assert!(e.message.ends_with("(1 of 2 applied, the rest weren't)"), "{e:?}");
        assert!(!sequencer(&r));
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Add f1");
        let s = state(&api, id, &r).await;
        assert_eq!(s["undo"]["label"], "cherry-pick 2 commits onto main", "what went in can be undone");
        std::fs::remove_file(&hook).unwrap();
        std::fs::remove_file(r.path().join("f2.txt")).unwrap();
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
        let res = call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&oids[2]), false)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done", "nothing left blocks the next pick");
    }

    /// Finding 2, PickControl: a Continue whose next pick fails with nothing in progress drops
    /// the sequencer too; the pause then settles with what went in.
    #[tokio::test]
    async fn a_continue_that_fails_part_way_drops_the_sequencer() {
        let data = tempfile::tempdir().unwrap();
        let (r, fix, add_m) = conflict_then_clean();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &[add_m, fix], false)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        r.write("m.txt", "mine\n");
        let e = call(&api, "pickControl", continue_pick(id, &r)).await.unwrap_err();
        assert!(e.message.ends_with("(the rest of the cherry-pick wasn't applied)"), "{e:?}");
        assert!(!sequencer(&r));
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Fix x");
        let res = call(&api, "settlePaused", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(res["journal"]["undo"]["label"], "cherry-pick 2 commits onto main");
    }

    /// Finding 4.
    #[tokio::test]
    async fn an_unborn_branch_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let one = r.git(&["rev-parse", "HEAD"]);
        r.git(&["switch", "-q", "--orphan", "fresh"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "cherryPick", req(id, &r, &[one], false)).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "Make a first commit first"));
    }

    /// Finding 6: a stop after some commits went in counts them.
    #[tokio::test]
    async fn a_stop_after_some_commits_counts_them() {
        let data = tempfile::tempdir().unwrap();
        let (r, add_n, fix) = two_sides();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &[fix.clone(), add_n], false)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "stopped", "files": 1, "at": fix, "applied": 1, "committed": true}));
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Add n");
        assert_eq!(res["journal"]["paused"]["target"], "2 commits");
    }

    /// Finding 6: a Continue that stops on the next commit stays paused; the last one completes
    /// it, and Undo takes both picks back.
    #[tokio::test]
    async fn a_continue_that_stops_again_stays_paused() {
        let data = tempfile::tempdir().unwrap();
        let (r, _, fix) = two_sides();
        let before = r.git(&["rev-parse", "main"]);
        r.switch("feature");
        r.write("c.txt", "feature 2\n");
        r.git(&["commit", "-q", "-am", "Fix y"]);
        let fix_y = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "cherryPick", req(id, &r, &[fix_y, fix], false)).await.unwrap();
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = call(&api, "pickControl", continue_pick(id, &r)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "stopped", "files": 1}));
        assert_eq!(res["journal"]["paused"]["kind"], "cherryPick");
        r.write("c.txt", "resolved 2\n");
        r.git(&["add", "c.txt"]);
        let res = call(&api, "pickControl", continue_pick(id, &r)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done"}));
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(res["journal"]["undo"]["label"], "cherry-pick 2 commits onto main");
        assert_eq!(r.git(&["log", "--format=%s", "-2"]), "Fix y\nFix x");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
    }

    /// Finding 6: Skip drops the stopped commit and applies the rest; that completes the pick.
    #[tokio::test]
    async fn skip_drops_the_stopped_commit_and_applies_the_rest() {
        let data = tempfile::tempdir().unwrap();
        let (r, fix, add_m) = conflict_then_clean();
        let before = r.git(&["rev-parse", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "cherryPick", req(id, &r, &[add_m, fix], false)).await.unwrap();
        let res = call(&api, "pickControl", json!({"repo": id, "worktree": wt(r.path()), "action": "skip"})).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done"}));
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(r.git(&["log", "--format=%s", "-2"]), "Add m\nmain");
        assert_eq!(res["journal"]["undo"]["label"], "cherry-pick 2 commits onto main");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
    }
    // --- end 3B T1 fix round 1 ---

    // --- 3B T1 fix round 2 ---

    /// Finding A: a Cancel mid-sequence (here while a post-commit hook sleeps) still drops git's
    /// sequencer: the quit doesn't run under the fired token.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_sequence_leaves_no_sequencer() {
        use crate::events::AppEvent;
        let data = tempfile::tempdir().unwrap();
        let (r, oids) = three_on_feature();
        let before = r.git(&["rev-parse", "main"]);
        r.hook("post-commit", "#!/bin/sh\nsleep 3\n");
        let api = std::sync::Arc::new(api(data.path()));
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let (a2, params) = (api.clone(), req(id, &r, &newest_first(&oids[..2]), false));
        let run = tokio::spawn(async move { call(&a2, "cherryPick", params).await });
        let op = loop {
            if let Ok(AppEvent::OpStarted { op, .. }) = rx.recv().await {
                break op;
            }
        };
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        call(&api, "cancelOp", json!({"op": op})).await.unwrap();
        let e = run.await.unwrap().unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Cancelled, "{e:?}");
        assert!(!sequencer(&r), "no sequencer left behind");
        assert!(crate::in_progress::read(r.path()).unwrap().is_none(), "aborted, not paused");
        let s = state(&api, id, &r).await;
        assert!(s["paused"].is_null());
        // Killed in post-commit, git keeps the commit it made ("won't rewind"): the entry's Undo
        // takes it back. Killed before, the abort put the branch back and nothing is recorded.
        if r.git(&["rev-parse", "main"]) != before {
            assert!(e.message.ends_with("(1 of 2 applied, the rest weren't)"), "{e:?}");
            assert_eq!(s["undo"]["label"], "cherry-pick 2 commits onto main");
            journal_step(&api, id, r.path(), "undo").await.unwrap();
            assert_eq!(r.git(&["rev-parse", "main"]), before);
        } else {
            assert!(s["undo"].is_null());
        }
        assert!(call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&oids[2]), false)).await.is_ok(), "nothing blocks the next pick");
    }

    /// Finding B: a revert's message may name the commit abbreviated (`revert.reference`).
    #[test]
    fn a_revert_naming_its_commit_abbreviated_counts() {
        let r = repo();
        r.write("x.txt", "x\n");
        r.git(&["add", "x.txt"]);
        r.git(&["commit", "-q", "-m", "Add x"]);
        let x = r.git(&["rev-parse", "HEAD"]);
        let base = x.clone();
        r.git(&["rm", "-q", "x.txt"]);
        r.git(&["commit", "-q", "-m", &format!("Revert \"Add x\"\n\nThis reverts commit {} (Add x, 2026-10-03).", &x[..9])]);
        let tip = r.git(&["rev-parse", "HEAD"]);
        let repo = gix::open(r.path()).unwrap();
        let id = |h: &str| gix::ObjectId::from_hex(h.as_bytes()).unwrap();
        assert!(crate::write::reverts_only(&repo, id(&tip), id(&base), std::slice::from_ref(&x)).unwrap());
        let other = r.git(&["rev-parse", "HEAD~2"]);
        assert!(!crate::write::reverts_only(&repo, id(&tip), id(&base), &[other]).unwrap(), "another commit's revert doesn't count");
        r.git(&["commit", "-q", "--allow-empty", "-m", &format!("This reverts commit {}", &x[..6])]);
        let short = r.git(&["rev-parse", "HEAD"]);
        assert!(!crate::write::reverts_only(&repo, id(&short), id(&tip), std::slice::from_ref(&x)).unwrap(), "6 digits are too few");
    }

    /// Finding C: an untracked file where a pick puts a directory is stashed too.
    #[tokio::test]
    async fn an_untracked_file_where_a_pick_puts_a_directory_is_stashed() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("feature");
        r.write("d/x.txt", "x\n");
        r.git(&["add", "d/x.txt"]);
        r.git(&["commit", "-q", "-m", "Add d/x"]);
        let add = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        r.write("d", "mine\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", json!({"repo": id, "worktree": wt(r.path()), "oids": [add], "confirm": {"autostash": true}})).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 1, "committed": true}));
        assert!(!sequencer(&r));
        assert!(r.git(&["stash", "list", "--format=%gs"]).contains("autostash before cherry-pick"), "the file is kept in the stash");
    }
    // --- end 3B T1 fix round 2 ---

    // --- 3B T2 fix round 1 ---

    /// Finding D: a stop on commit 2 of 3; the user then edits a file only commit 3 changes.
    /// The Undo discards what the attempted commits did, but that edit is the user's: it asks,
    /// and the edit survives.
    #[tokio::test]
    async fn a_stopped_pick_undo_keeps_edits_to_paths_of_commits_that_never_ran() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("c.txt", "base\n");
        r.write("z.txt", "z\n");
        r.git(&["add", "c.txt", "z.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("n.txt", "n\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Add n"]);
        let one = r.git(&["rev-parse", "HEAD"]);
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        let two = r.git(&["rev-parse", "HEAD"]);
        r.write("z.txt", "z feature\n");
        r.write("w.txt", "w\n");
        r.git(&["add", "z.txt", "w.txt"]);
        r.git(&["commit", "-q", "-m", "Change z, add w"]);
        let three = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &[three, two.clone(), one], true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "stopped", "files": 1, "at": two, "applied": 1, "committed": false}));
        r.write("z.txt", "mine\n");
        r.write("w.txt", "new\n");
        let entry = state(&api, id, &r).await["undo"]["entry"].clone();
        call(&api, "undo", json!({"repo": id, "worktree": wt(r.path()), "entry": entry, "confirmDiscard": true})).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("c.txt")).unwrap(), "main\n");
        assert!(!r.path().join("n.txt").exists());
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "");
        assert_eq!(std::fs::read_to_string(r.path().join("z.txt")).unwrap(), "mine\n", "the edit survives, in place");
        assert_eq!(std::fs::read_to_string(r.path().join("w.txt")).unwrap(), "new\n", "a new file where a commit that never ran adds one stays");
        assert_eq!(r.git(&["status", "--porcelain"]), " M z.txt\n?? w.txt");
        assert_eq!(r.git(&["stash", "list"]), "", "nothing needed a stash");
    }

    /// Finding E: git follows a rename on HEAD's side (x.txt → y.txt); the Undo covers y.txt,
    /// and the Redo brings the change back there.
    #[tokio::test]
    async fn without_committing_covers_a_rename_followed_path() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let body: String = (1..=8).map(|i| format!("line {i}\n")).collect();
        r.write("x.txt", &body);
        r.git(&["add", "x.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("x.txt", &body.replace("line 1\n", "line one\n"));
        r.git(&["commit", "-q", "-am", "Edit x"]);
        let edit = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        r.git(&["mv", "x.txt", "y.txt"]);
        r.git(&["commit", "-q", "-m", "Rename x to y"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&edit), true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done", "commits": 1, "committed": false}));
        assert!(std::fs::read_to_string(r.path().join("y.txt")).unwrap().starts_with("line one\n"), "git followed the rename");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "", "y.txt restored too");
        assert_eq!(std::fs::read_to_string(r.path().join("y.txt")).unwrap(), body);
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert!(std::fs::read_to_string(r.path().join("y.txt")).unwrap().starts_with("line one\n"));
    }

    /// Fix round 2 (1): a rename-followed change of an applied commit that lands on a path of a
    /// commit that never ran (y.txt: HEAD renamed x.txt there, and a later commit adds it) is
    /// the run's own: the stopped Undo restores it.
    #[tokio::test]
    async fn a_stopped_undo_covers_a_rename_followed_change_on_a_later_commits_path() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let body: String = (1..=8).map(|i| format!("line {i}\n")).collect();
        r.write("x.txt", &body);
        r.write("c.txt", "base\n");
        r.git(&["add", "x.txt", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("x.txt", &body.replace("line 1\n", "line one\n"));
        r.git(&["commit", "-q", "-am", "Edit x"]);
        let edit = r.git(&["rev-parse", "HEAD"]);
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        let fix = r.git(&["rev-parse", "HEAD"]);
        r.write("y.txt", "other\n");
        r.git(&["add", "y.txt"]);
        r.git(&["commit", "-q", "-m", "Add y"]);
        let add_y = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        r.git(&["mv", "x.txt", "y.txt"]);
        r.write("c.txt", "main\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "Rename x to y"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &[add_y, fix.clone(), edit], true)).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "stopped", "files": 1, "at": fix, "applied": 1, "committed": false}));
        assert!(std::fs::read_to_string(r.path().join("y.txt")).unwrap().starts_with("line one\n"), "git followed the rename");
        let entry = state(&api, id, &r).await["undo"]["entry"].clone();
        call(&api, "undo", json!({"repo": id, "worktree": wt(r.path()), "entry": entry, "confirmDiscard": true})).await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "", "y.txt restored too");
        assert_eq!(std::fs::read_to_string(r.path().join("y.txt")).unwrap(), body);
    }
    // --- end 3B T2 fix round 1 ---

    // --- 3B final fixes ---

    /// Final fix 1: a revert's message rewritten at Continue (its "This reverts commit" line
    /// gone) still completes it: one Undo takes both reverts back.
    #[tokio::test]
    async fn a_revert_continued_with_a_rewritten_message_keeps_its_undo() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("s.txt", "s\n");
        r.git(&["add", "s.txt"]);
        r.git(&["commit", "-q", "-m", "Add s"]);
        let add_s = r.git(&["rev-parse", "HEAD"]);
        r.write("c.txt", "2\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "c2"]);
        let c2 = r.git(&["rev-parse", "HEAD"]);
        r.write("c.txt", "3\n");
        r.git(&["commit", "-q", "-am", "c3"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        // Newest first: c2's revert conflicts with c3, then Add s's goes in cleanly.
        let res = call(&api, "revert", req(id, &r, &[c2, add_s], false)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let params = json!({"repo": id, "worktree": wt(r.path()), "action": "continue", "message": "Put c back\n\nRewritten."});
        let res = call(&api, "pickControl", params).await.unwrap();
        assert_eq!(res["outcome"], json!({"status": "done"}));
        assert_eq!(r.git(&["log", "--format=%s", "-2"]), "Revert \"Add s\"\nPut c back");
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(res["journal"]["undo"]["label"], "revert 2 commits");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// Final fix 2: main renamed x.txt to y.txt, and y.txt has your edit; feature adds n.txt,
    /// then edits x.txt (git follows the rename onto y.txt, and refuses: your edit is in the
    /// way). Returns (repo, "Add n", "Edit x").
    fn in_the_way_after_a_rename() -> (TestRepo, String, String) {
        let r = repo();
        let body: String = (1..=8).map(|i| format!("line {i}\n")).collect();
        r.write("x.txt", &body);
        r.git(&["add", "x.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("n.txt", "n\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Add n"]);
        let add_n = r.git(&["rev-parse", "HEAD"]);
        r.write("x.txt", &body.replace("line 1\n", "line one\n"));
        r.git(&["commit", "-q", "-am", "Edit x"]);
        let edit = r.git(&["rev-parse", "HEAD"]);
        r.switch("main");
        r.git(&["mv", "x.txt", "y.txt"]);
        r.git(&["commit", "-q", "-m", "Rename x to y"]);
        r.write("y.txt", &body.replace("line 8\n", "mine\n"));
        (r, add_n, edit)
    }

    /// Final fix 2 (A): the first commit fails without conflicts, before anything changed: no
    /// entry, so no Undo that does nothing.
    #[tokio::test]
    async fn without_committing_a_first_failure_leaves_no_entry() {
        let data = tempfile::tempdir().unwrap();
        let (r, _, edit) = in_the_way_after_a_rename();
        let api = api(data.path());
        let id = open(&api, &r).await;
        assert!(call(&api, "cherryPick", req(id, &r, std::slice::from_ref(&edit), true)).await.is_err());
        assert_eq!(r.git(&["status", "--porcelain"]), " M y.txt", "your edit stays, and nothing else changed");
        assert!(state(&api, id, &r).await["undo"].is_null());
    }

    /// Final fix 2 (B): the second commit fails without conflicts after the first went in. The
    /// Undo is a stopped one: it asks, discards the first commit's changes (never stashing them
    /// as yours), and leaves your edit alone.
    #[tokio::test]
    async fn without_committing_a_later_failure_undoes_only_what_went_in() {
        let data = tempfile::tempdir().unwrap();
        let (r, add_n, edit) = in_the_way_after_a_rename();
        let mine = std::fs::read_to_string(r.path().join("y.txt")).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        assert!(call(&api, "cherryPick", req(id, &r, &[edit, add_n], true)).await.is_err());
        assert_eq!(r.git(&["status", "--porcelain"]), "A  n.txt\n M y.txt");
        let e = journal_step(&api, id, r.path(), "undo").await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Conflict, "the stopped pick's question: {}", e.message);
        let entry = state(&api, id, &r).await["undo"]["entry"].clone();
        call(&api, "undo", json!({"repo": id, "worktree": wt(r.path()), "entry": entry, "confirmDiscard": true})).await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), " M y.txt");
        assert_eq!(std::fs::read_to_string(r.path().join("y.txt")).unwrap(), mine);
        assert_eq!(r.git(&["stash", "list"]), "", "nothing was stashed");
    }

    /// Final fix 5: the stopped pick committed in a terminal mid-sequence leaves the sequencer
    /// with the rest to do; a GitBolt write meanwhile leaves it, and `--continue` there goes on.
    #[tokio::test]
    async fn a_sequence_the_user_goes_on_with_in_a_terminal_keeps_its_sequencer() {
        let data = tempfile::tempdir().unwrap();
        let (r, fix, add_m) = conflict_then_clean();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "cherryPick", req(id, &r, &[add_m, fix], false)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "--no-edit"]);
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
        assert!(sequencer(&r));
        call(&api, "settlePaused", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert!(sequencer(&r), "the rest is still to do");
        r.git(&["cherry-pick", "--continue"]);
        assert_eq!(r.git(&["log", "--format=%s", "-2"]), "Add m\nFix x");
        assert!(!sequencer(&r));
    }
    // --- end 3B final fixes ---
}
