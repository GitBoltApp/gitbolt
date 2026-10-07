//! Undo and redo (spec #2 §5.3, §5.4).
//!
//! Undo and redo are themselves writes (§3.2): locked, queued, with events. The undone entry
//! moves to the redo stack, and a redo moves it back. Redo replays the recorded forward effect
//! (the CAS, the `after` snapshot, the switch); it never re-runs the original command, so no hook
//! or signer runs again.

use crate::api::Api;
use crate::error::{gix_err, short_ref, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::{snapshot, HeadState, JournalEntry, RefMove, UndoKind};
use crate::write::refs::read_ref;
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, WriteCx, WriteIntent};
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Undo,
    Redo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum UndoOutcome {
    /// Done: the toast says "Undid <label>", plus " (<note>)" when the entry has one (§5.5;
    /// the note: 2C T1).
    Done {
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        note: Option<String>,
    },
    /// A ref moved since the operation (§5.4): nothing changed. The UI asks, then sends again
    /// with `confirm` (each ref at the `actual` it showed).
    Moved { label: String, refs: Vec<MovedRef> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MovedRef {
    pub name: String,
    /// Where the operation left it.
    pub expected: Option<String>,
    /// Where it is now.
    pub actual: Option<String>,
    /// Where the undo moves it (`None`: deletes it).
    pub target: Option<String>,
    /// Commits made since (`expected..actual`) that the move drops from it.
    pub dropped: u32,
    /// The undo leaves it where it is (`target` = `actual`): a snapshot restore over a moved
    /// HEAD restores the files over it (2B final I1). For HEAD, `expected`/`actual` are
    /// `refs/heads/<branch>` when the branch changed, else commit ids.
    pub stays: bool,
}

pub(crate) struct UndoIntent {
    pub(crate) dir: Direction,
    pub(crate) entry: JournalEntry,
    pub(crate) confirm: BTreeMap<String, Option<String>>,
    /// The clean-restore warning (§6.2) was confirmed.
    pub(crate) autostash_ok: bool,
    // --- 2C T7 ---
    /// "Apply without restoring what was staged?" was confirmed (a stash's apply, 2C T7 M2).
    pub(crate) without_index: bool,
    // --- end 2C T7 ---
    // --- 3B T2 ---
    /// "Undo the stopped cherry-pick?" was confirmed: its changes are discarded.
    pub(crate) confirm_discard: bool,
    // --- end 3B T2 ---
    // --- UX Y ---
    /// An older entry, undone from the Undo dropdown out of order (`journal::history`): it needs
    /// no Redo; its undo is a new entry that takes its place in the stack.
    pub(crate) out_of_order: bool,
    // --- end UX Y ---
}

// --- 3B T2 fix round 1 (D) ---
/// `snap` over `paths` alone (a stopped pick's attempted commits' paths): what its Undo restores.
fn only(snap: &crate::journal::Snapshot, paths: &[String]) -> crate::journal::Snapshot {
    let keep = |p: &String| paths.contains(p);
    crate::journal::Snapshot {
        commit: snap.commit.clone(),
        paths: snap.paths.iter().filter(|p| keep(p)).cloned().collect(),
        untracked: snap.untracked.iter().filter(|p| keep(p)).cloned().collect(),
        modes: snap.modes.iter().filter(|(p, _)| keep(p)).map(|(p, m)| (p.clone(), *m)).collect(),
    }
}
// --- end 3B T2 fix round 1 ---

impl UndoIntent {
    // --- 3B T2 ---
    /// The undo of a "without committing" pick that stopped on conflicts: `cherry-pick` or
    /// `revert`. It discards P, unmerged paths included, after its own question.
    fn stopped_pick(&self) -> Option<&crate::journal::StoppedPick> {
        self.entry.stopped_pick.as_ref().filter(|_| self.dir == Direction::Undo && self.entry.undo == UndoKind::Restore)
    }
    // --- end 3B T2 ---

    fn verb(&self) -> &'static str {
        match self.dir {
            Direction::Undo => "undo",
            Direction::Redo => "redo",
        }
    }

    /// A recorded move's (from, to) in this direction.
    fn ends<'m>(&self, m: &'m RefMove) -> (&'m Option<String>, &'m Option<String>) {
        match self.dir {
            Direction::Undo => (&m.new, &m.old),
            Direction::Redo => (&m.old, &m.new),
        }
    }

    /// The snapshot this direction restores, if any.
    fn snapshot(&self) -> Option<&crate::journal::Snapshot> {
        match self.dir {
            Direction::Undo => self.entry.before.as_ref(),
            Direction::Redo => self.entry.after.as_ref(),
        }
    }

    /// The snapshot of the state this direction starts from: what the operation left (undo), or
    /// what its undo restored (redo).
    fn left(&self) -> Option<&crate::journal::Snapshot> {
        match self.dir {
            Direction::Undo => self.entry.after.as_ref(),
            Direction::Redo => self.entry.before.as_ref(),
        }
    }

    /// A Switch's HEAD: where it must be now (the op's result, or its undo's), and where it goes.
    fn head_ends(&self) -> (&HeadState, &HeadState) {
        match self.dir {
            Direction::Undo => (&self.entry.head_after, &self.entry.head_before),
            Direction::Redo => (&self.entry.head_before, &self.entry.head_after),
        }
    }

    // --- 2C T6: reset kinds ---
    /// A reset of a detached HEAD: its undo and redo move HEAD itself (Deviation 3).
    fn detached_reset(&self) -> bool {
        matches!(self.entry.undo, UndoKind::ResetSoft | UndoKind::ResetMixed | UndoKind::ResetHard) && self.entry.head_before.branch.is_none()
    }
    // --- end 2C T6 ---

    /// A Switch whose HEAD was moved since (an outside `git switch`) asks first, like a moved
    /// ref (§5.4, review m9); "Undo anyway" carries HEAD as the prompt showed it. So does a
    /// detached HEAD's commit (MoveHead, 2B Deviation 9), but only while HEAD is still detached:
    /// on a branch now, moving HEAD alone would leave that branch's index and worktree under
    /// another commit, so it's refused with no override. (The prompt's `dropped` is counted in
    /// `run`.) A detached reset moves HEAD itself too, and is checked as MoveHead (2C T6).
    fn head_moved(&self, now: &HeadState) -> Result<Option<MovedRef>, GbError> {
        // --- 2B T4: a snapshot restore over a moved HEAD asks too (review M1) ---
        // A discard's or a pop's snapshot was taken against HEAD as it was: restored over another
        // commit, its index entries read as a staged reversal of what was committed since. It
        // asks, never refuses ("Undo anyway" is sometimes exactly what's wanted).
        let snapshot_restore = self.entry.undo == UndoKind::Restore || (self.entry.undo == UndoKind::Stash && self.snapshot().is_some());
        if snapshot_restore {
            // UX Y: out of order, the plan checked HEAD path by path (`out_of_order_check`).
            if self.out_of_order {
                return Ok(None);
            }
            // HEAD's commit (a commit on the branch moves it), or its branch. Restore never moves
            // HEAD: it stays where it is now, and the files are restored over it (2B final I1).
            // A branch switch is shown by branch, so the prompt never reads "at X, not X".
            let (from, _) = self.head_ends();
            if from.oid == now.oid && from.branch == now.branch {
                return Ok(None);
            }
            let (want, have) = if from.branch == now.branch { (from.oid.clone(), now.oid.clone()) } else { (head_value(from), head_value(now)) };
            return match self.confirm.get("HEAD") {
                Some(shown) if *shown == have => Ok(None),
                Some(_) => Err(GbError::ref_moved("HEAD")),
                None => Ok(Some(MovedRef { name: "HEAD".into(), expected: want, target: have.clone(), actual: have, dropped: 0, stays: true })),
            };
        }
        // --- end 2B T4 ---
        // --- 2C T6: a detached reset's HEAD ---
        let moves_head = self.entry.undo == UndoKind::MoveHead || self.detached_reset();
        if self.entry.undo != UndoKind::Switch && !moves_head {
            return Ok(None);
        }
        let (from, to) = self.head_ends();
        let (want, have) = (head_value(from), head_value(now));
        if want == have {
            return Ok(None);
        }
        if moves_head && let Some(branch) = &now.branch {
            // Retrying can't help; switching back to the detached commit does (2B final I2).
            let back = from.oid.as_deref().map_or("the detached commit", |o| &o[..o.len().min(7)]);
            let verb = match self.dir {
                Direction::Undo => "undo",
                Direction::Redo => "redo",
            };
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("HEAD is on {branch} now: switch back to {back} to {verb} {}", self.entry.label)));
        }
        // --- end 2C T6 ---
        match self.confirm.get("HEAD") {
            Some(shown) if *shown == have => Ok(None),
            Some(_) => Err(GbError::ref_moved("HEAD")),
            None => Ok(Some(MovedRef { name: "HEAD".into(), expected: want, actual: have, target: head_value(to), dropped: 0, stays: false })),
        }
    }

    /// `run` will change nothing: the entry is no longer on top or has expired (stale), a ref
    /// or HEAD moved and isn't confirmed (it asks, §5.4), or the snapshot is gone. Nothing is
    /// autostashed for it.
    fn changes_nothing(&self, api: &Api, root: &std::path::Path, head: &HeadState) -> Result<bool, GbError> {
        let mut j = api.journal(root)?.load()?;
        j.expire(api.now());
        let top = match self.dir {
            Direction::Undo => j.undo_top().map(|e| e.id),
            Direction::Redo => j.redo_top().map(|e| e.id),
        };
        if (!self.out_of_order && top != Some(self.entry.id)) || !matches!(self.head_moved(head), Ok(None)) {
            return Ok(true);
        }
        if self.snapshot().is_some_and(|s| !snapshot::exists(root, s)) {
            return Ok(true);
        }
        let repo = gix::open(root).map_err(gix_err)?;
        for m in &self.entry.refs {
            let now = read_ref(&repo, &m.name)?;
            if now != *self.ends(m).0 && self.confirm.get(&m.name) != Some(&now) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn reflog(&self) -> String {
        format!("gitbolt: {} {}", self.verb(), self.entry.label)
    }

    /// "Stage all & commit" (§5.3, Deviation 8): the two-way read-tree's (from, to). Undo goes
    /// from the op's index (the commit's tree, or `index_after`) to `index_before`, the
    /// pre-commit split; redo goes back. `None` unless HEAD is where this step starts: on another
    /// branch, or moved since ("Undo anyway"), the index isn't this op's, and the undo is a plain
    /// MoveRefs like a Commit's.
    fn index_trees(&self, now: &HeadState) -> Option<(String, String)> {
        let before = self.entry.index_before.clone()?;
        if now != self.head_ends().0 {
            return None;
        }
        let after = self.entry.index_after.clone().or_else(|| Some(format!("{}^{{tree}}", self.entry.head_after.oid.as_ref()?)))?;
        Some(match self.dir {
            Direction::Undo => (after, before),
            Direction::Redo => (before, after),
        })
    }

    /// `read-tree -m -i <from> <to>`, two-way: only entries still as `from` has them change,
    /// so whatever was staged since stays staged, and an entry changed both ways refuses ("would
    /// be overwritten by merge"). `-i`: only the index; the worktree isn't compared or touched.
    async fn read_index(cx: &mut WriteCx<'_>, from: &str, to: &str) -> Result<(), GbError> {
        let inv = cx.git(["read-tree", "-m", "-i", from, to]);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Index);
        Ok(())
    }

    /// MoveHead (Deviation 9): `update-ref --no-deref HEAD <to> <old>`, `old` being where the
    /// op left HEAD, or the value "Undo anyway" was shown (§5.4: the CAS runs against it).
    async fn move_head(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let (from, to) = self.head_ends();
        let old = match self.confirm.get("HEAD") {
            Some(Some(shown)) => Some(shown.clone()),
            _ => from.oid.clone(),
        };
        let (Some(old), Some(to)) = (old, to.oid.clone()) else { return Err(GbError::other("nothing to move HEAD to")) };
        let inv = cx.git(["update-ref".to_string(), "--no-deref".into(), "-m".into(), self.reflog(), "HEAD".into(), to, old]);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Head);
        Ok(())
    }

    /// Rewind (§5.3): a two-way `read-tree -m -u <from> <to>` carries local changes and refuses
    /// on overlap; then the CAS. If the CAS fails, the reverse read-tree runs and it's RefMoved.
    async fn rewind(&self, cx: &mut WriteCx<'_>, moves: &[RefMove]) -> Result<(), GbError> {
        let checked = cx.before.head.branch.as_ref().map(|b| format!("refs/heads/{b}"));
        let tree = moves.iter().find(|m| Some(&m.name) == checked.as_ref()).and_then(|m| Some((m.old.clone()?, m.new.clone()?)));
        let Some((from, to)) = tree else { return cx.cas(moves, &self.reflog()).await };
        refresh_index(cx).await;
        let inv = cx.git(["read-tree", "-m", "-u", from.as_str(), to.as_str()]);
        // --- 2C T5: the put-back after an interrupted move (review I1) ---
        // A read-tree that failed or was cancelled part-way puts back what it rewrote, so step 8
        // restores the autostash onto the tree as it was; the reverse one is a repair step (the
        // op's Cancel doesn't stop it, a Stop does).
        let res = cx.run_git(inv).await;
        cx.touch(ChangeKind::Worktree);
        cx.touch(ChangeKind::Index);
        if let Err(e) = res {
            return Err(crate::write::checkout::put_back(cx, &to, e).await);
        }
        if let Err(e) = cx.cas(moves, &self.reflog()).await {
            let refresh = cx.git_repair(["update-index", "-q", "--refresh"]);
            let _ = cx.run_repair(refresh).await;
            let back = cx.git_repair(["read-tree", "-m", "-u", to.as_str(), from.as_str()]);
            if cx.run_repair(back).await.is_err() {
                return Err(crate::write::checkout::put_back(cx, &to, e).await);
            }
            return Err(e);
        }
        // --- end 2C T5 ---
        Ok(())
    }

    /// Switch (§5.3): `git switch` back, then the CAS of the refs it created or moved; redo
    /// moves them first, then switches (Deviation 9, 2C T1).
    async fn switch(&self, cx: &mut WriteCx<'_>, moves: &[RefMove]) -> Result<(), GbError> {
        let head = match self.dir {
            Direction::Undo => &self.entry.head_before,
            Direction::Redo => &self.entry.head_after,
        };
        let args: Vec<String> = match (&head.branch, &head.oid) {
            (Some(b), _) => vec!["switch".into(), "--no-guess".into(), b.clone()],
            (None, Some(oid)) => vec!["switch".into(), "--detach".into(), oid.clone()],
            (None, None) => return Err(GbError::other("nothing to switch to")),
        };
        // --- 2C T1: the Switch redo order ---
        // Redo: a branch the checkout created (or fast-forwarded) must be there before the
        // switch lands on it. Undo: leave it first, then delete or rewind it.
        if self.dir == Direction::Redo {
            cx.cas(moves, &self.reflog()).await?;
        }
        let inv = cx.git(args);
        if let Err(mut e) = cx.run_git(inv).await {
            // Redo: the switch failed after the refs moved (a refused overlap, a hook): put them
            // back, each a CAS on the value just set, as `rewind` reverses its read-tree. Not
            // when HEAD did land (a post-checkout hook's failure): the branch is checked out.
            let landed = gix::open(cx.root).ok().and_then(|r| crate::write::head_state(&r).ok()).is_some_and(|now| now.branch.is_some() && now.branch == head.branch);
            // --- 2C T5: the put-back after an interrupted move (review I1) ---
            // The paths a failed or cancelled switch rewrote go back first (a no-op when HEAD
            // moved), so step 8 restores the autostash onto the tree as it was.
            if let Some(to) = head.oid.clone() {
                e = crate::write::checkout::put_back(cx, &to, e).await;
            }
            // --- end 2C T5 ---
            if self.dir == Direction::Redo && !landed && !cx.repair_stopped() {
                let back: Vec<RefMove> = moves.iter().map(|m| RefMove { name: m.name.clone(), old: m.new.clone(), new: m.old.clone() }).collect();
                if let Err(b) = cx.cas(&back, &self.reflog()).await {
                    tracing::warn!(target: "gitbolt_core::write", "putting back the refs of a failed {}: {b}", self.label());
                }
            }
            return Err(e);
        }
        for k in [ChangeKind::Head, ChangeKind::Index, ChangeKind::Worktree] {
            cx.touch(k);
        }
        if self.dir == Direction::Undo {
            cx.cas(moves, &self.reflog()).await?;
        }
        // --- end 2C T1 ---
        Ok(())
    }
}

/// `update-index -q --refresh` before a `read-tree -m -u` (2A final I2): read-tree checks each
/// path it touches by stat, so a file saved with the same bytes (an editor, a formatter, a
/// `touch`) would be "not uptodate" and block the Rewind. GitBolt's reads never refresh the
/// index. Its exit status says only that some files differ, which read-tree then judges.
/// (2C T6: the hard reset's undo reuses it.)
pub(crate) async fn refresh_index(cx: &mut WriteCx<'_>) {
    let inv = cx.git(["update-index", "-q", "--refresh"]);
    let _ = cx.run_git(inv).await;
    cx.touch(ChangeKind::Index);
}

/// HEAD as a Switch's prompt shows it: its branch's full name, or the detached oid.
fn head_value(h: &HeadState) -> Option<String> {
    h.branch.as_ref().map(|b| format!("refs/heads/{b}")).or_else(|| h.oid.clone())
}

/// `from..now`, counted (a read).
async fn dropped(api: &Api, root: &std::path::Path, from: &Option<String>, now: &Option<String>) -> u32 {
    let (Some(from), Some(now)) = (from, now) else { return 0 };
    let range = format!("{from}..{now}");
    let out = api.cli.run(GitInvocation::new(root, ["rev-list", "--count", range.as_str()])).await;
    out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
}

impl WriteIntent for UndoIntent {
    type Outcome = UndoOutcome;

    fn kind(&self) -> OpKind {
        match self.dir {
            Direction::Undo => OpKind::Undo,
            Direction::Redo => OpKind::Redo,
        }
    }

    fn label(&self) -> String {
        format!("{} {}", self.verb(), self.entry.label)
    }

    /// Not an entry of its own: it moves one between the stacks (§5.4). UX Y: an out-of-order
    /// undo is one (its `before` is the entry's `after`, and the reverse), so it can be undone.
    fn undo(&self) -> Option<UndoKind> {
        self.out_of_order.then_some(self.entry.undo)
    }

    /// `git switch` runs post-checkout.
    fn runs_hooks(&self) -> bool {
        self.entry.undo == UndoKind::Switch
    }

    fn refs(&self) -> Vec<String> {
        self.entry.refs.iter().map(|m| m.name.clone()).collect()
    }

    fn confirm(&self) -> crate::write::types::Confirm {
        crate::write::types::Confirm { autostash: self.autostash_ok }
    }

    /// §6.1: Switch and Rewind autostash on overlap with the commit they move the worktree to;
    /// Restore on `dirty ∩ P`.
    async fn plan(&self, pre: &crate::write::Pre<'_>) -> Result<crate::write::Plan, GbError> {
        use crate::journal::autostash::{AutostashRule, AutostashSpec};
        // UX Y: every refusal of an out-of-order undo comes here, before anything is written.
        if self.out_of_order {
            self.out_of_order_check(pre).await?;
        }
        if let Some(removed) = &self.entry.removed_remote {
            crate::write::remotes::check_removed_remote(&pre.api.cli, pre.root, removed, &self.entry.config, self.dir == Direction::Undo).await?;
        }
        if self.changes_nothing(pre.api, pre.root, &pre.before.head)? {
            return Ok(crate::write::Plan::default());
        }
        let to_oid = |oid: &Option<String>| oid.as_deref().and_then(|o| gix::ObjectId::from_hex(o.as_bytes()).ok());
        // --- 2C T6: repositories in the way ---
        // A switch or rewind (`read-tree -m -u`) that writes a file where a submodule or an
        // embedded repository sits deletes it whole: refused (2C T6 review C3).
        // The check also says what the move sweeps away with a directory (safety review M1,
        // M2): the autostash rule, or the hard undo's paths, carry it.
        let in_the_way = async |to: Option<gix::ObjectId>| -> Result<crate::write::precheck::MoveCheck, GbError> {
            match (to_oid(&pre.before.head.oid), to) {
                (Some(from), Some(to)) => crate::write::precheck::refuse_repos_in_the_way(&pre.api.cli, pre.root, from, to, self.verb()).await,
                _ => Ok(Default::default()),
            }
        };
        // --- end 2C T6 ---
        // --- 2C repo-safety ---
        // A restore that writes a file of the snapshot where the disk has a directory now
        // deletes the directory whole (re-review 3 C5): a repository in it is refused, and the
        // untracked files in it join `dirty ∩ P`, so they're autostashed after the question.
        // What the direction's other snapshot holds is the operation's own doing (a file it
        // deleted where a folder goes back, or the reverse): not in the way, carried by it.
        let restore_in_the_way = async |snap: &crate::journal::Snapshot| -> Result<Vec<String>, GbError> {
            let d = Box::pin(snapshot::dirs_in_the_way(&pre.api.cli, pre.root, snap)).await?;
            match d.repos.first() {
                Some(p) => Err(crate::write::precheck::repository_in_the_way(p, self.verb())),
                None => Ok(d.untracked.into_iter().filter(|p| !self.left().is_some_and(|l| l.paths.contains(p))).collect()),
            }
        };
        // --- end 2C repo-safety ---
        let spec = match self.entry.undo {
            UndoKind::Switch => {
                let head = match self.dir {
                    Direction::Undo => &self.entry.head_before,
                    Direction::Redo => &self.entry.head_after,
                };
                let rule = in_the_way(to_oid(&head.oid)).await?.rule(); // 2C T6, repo-safety
                Some(AutostashSpec { rule, target: to_oid(&head.oid), op: self.label(), target_name: head.branch.clone().or_else(|| head.oid.clone()) })
            }
            UndoKind::Rewind => {
                let checked = pre.before.head.branch.as_ref().map(|b| format!("refs/heads/{b}"));
                let mv = self.entry.refs.iter().find(|m| Some(&m.name) == checked.as_ref());
                match mv {
                    Some(m) => {
                        let rule = in_the_way(to_oid(self.ends(m).1)).await?.rule(); // 2C T6, repo-safety
                        Some(AutostashSpec { rule, target: to_oid(self.ends(m).1), op: self.label(), target_name: pre.before.head.branch.clone() })
                    }
                    None => None,
                }
            }
            // `dirty ∩ P`, dirty meaning changed since the operation (or its undo) left P:
            // the restore overwrites only P, and P as that snapshot holds it loses nothing.
            UndoKind::Restore => match self.snapshot() {
                // --- 3B T2: a stopped pick asks, and its changes (P) aren't autostashed ---
                Some(s) if self.stopped_pick().is_some() => {
                    let stopped = self.stopped_pick().cloned().unwrap_or_default();
                    let op = stopped.op.as_str();
                    if !self.confirm_discard {
                        return Err(GbError::new(GbErrorKind::Conflict, format!("Undo the stopped {op}? Its changes are discarded, including anything you resolved since.")).with_detail(crate::error::ErrorDetail::UndoStoppedPick { op: op.into(), arm: format!("Click again to undo: discards the stopped {op}'s changes").into() }));
                    }
                    // Only the attempted commits' paths are restored (fix round 1, D): the rest of
                    // P belongs to commits that never ran, so whatever is there now is the user's,
                    // and it's left alone. What's in the way is still stashed (a repository
                    // refuses; untracked files where a file goes back).
                    let paths = restore_in_the_way(&only(s, &stopped.paths)).await?;
                    (!paths.is_empty()).then(|| AutostashSpec { rule: AutostashRule::Paths(paths), target: None, op: self.label(), target_name: Some(self.label()) })
                }
                // --- end 3B T2 ---
                Some(s) => {
                    // 3B T2 fix round 1 (G): a conflicted path of P can't be stashed or restored
                    // over (only a stopped pick's Undo does that): refused in words up front.
                    let unmerged = crate::write::precheck::dirty(&pre.api.cli, pre.root).await?.unmerged;
                    if let Some(p) = unmerged.iter().find(|p| s.paths.contains(*p)) {
                        return Err(GbError::new(GbErrorKind::InProgress, format!("{p} has merge conflicts: resolve conflicts first")));
                    }
                    // UX Y: out of order, a change to P is refused (`out_of_order_check`, and again
                    // just before the restore), never stashed: only what's in the way is.
                    let mut paths = match self.left() {
                        _ if self.out_of_order => Vec::new(),
                        Some(left) => crate::write::precheck::changed_since(&pre.api.cli, pre.root, left).await?,
                        None => s.paths.clone(),
                    };
                    paths.extend(restore_in_the_way(s).await?); // 2C repo-safety
                    (!paths.is_empty()).then(|| AutostashSpec { rule: AutostashRule::Paths(paths), target: None, op: self.label(), target_name: Some(self.label()) })
                }
                None => None,
            },
            UndoKind::MoveRefs | UndoKind::MoveHead | UndoKind::Barrier | UndoKind::Rename => None,
            // --- 2C T6: reset kinds ---
            // Undo of a hard reset rewinds the worktree and restores `before` over P: the paths
            // either touches that changed since (`dirty ∩ P`, P ∪ the tree diff). Only when the
            // reset's branch is checked out here; elsewhere `run` refuses.
            UndoKind::ResetHard if self.dir == Direction::Undo && pre.before.head.branch == self.entry.head_before.branch => {
                let mut paths: Vec<String> = self.entry.before.as_ref().map(|s| s.paths.clone()).unwrap_or_default();
                if let (Some(old), Some(new)) = (to_oid(&self.entry.head_before.oid), to_oid(&pre.before.head.oid)) {
                    // The rewind to `old` mustn't delete a repository (review C3); what it
                    // sweeps away with a directory is stashed too (safety review M1, M2).
                    let check = in_the_way(Some(old)).await?;
                    paths.extend(check.swept);
                    paths.extend(check.ignored);
                    let repo = gix::open(pre.root).map_err(gix_err)?;
                    paths.extend(crate::write::precheck::tree_diff_paths(&repo, new, old)?);
                }
                // --- 2C repo-safety ---
                if let Some(b) = &self.entry.before {
                    paths.extend(restore_in_the_way(b).await?);
                }
                // --- end 2C repo-safety ---
                paths.sort();
                paths.dedup();
                (!paths.is_empty()).then(|| AutostashSpec { rule: AutostashRule::Paths(paths), target: None, op: self.label(), target_name: Some(self.label()) })
            }
            // Undo of a mixed reset reads the index back over P ∪ the tree diff: the entries
            // staged there since the reset (`dirty ∩ P` on the index side) are autostashed, which
            // asks (§6.1), with or without a `before`.
            UndoKind::ResetMixed if self.dir == Direction::Undo && pre.before.head.branch == self.entry.head_before.branch => match (&pre.before.head.oid, &self.entry.head_before.oid) {
                (Some(now), Some(old)) => {
                    let paths = crate::write::reset::staged_since(pre.root, now, old, self.entry.before.as_ref())?;
                    (!paths.is_empty()).then(|| AutostashSpec { rule: AutostashRule::Paths(paths), target: None, op: self.label(), target_name: Some(self.label()) })
                }
                _ => None,
            },
            UndoKind::ResetSoft | UndoKind::ResetMixed | UndoKind::ResetHard => None,
            // --- end 2C T6 ---
            // --- 2C T7: stashes ---
            // A pop's undo restores `before` over P, like Restore: what changed since the pop
            // left P (its `after`) is autostashed. A conflicting pop has no `after`: as Restore
            // without one, every path of P that's dirty now asks first (review I2), and nothing
            // is restored over unmerged paths.
            UndoKind::Stash => match (self.dir, &self.entry.before, &self.entry.after) {
                // --- 2C repo-safety (safety review C1, C2) ---
                // The undo of a push applies the stash; its redo pushes again; the redo of a pop
                // applies the dropped stash: each a move over the worktree, checked first.
                (Direction::Undo, None, _) => {
                    if let Some(m) = self.entry.stashes.first().filter(|m| m.created) {
                        crate::write::stash::refuse_stash_apply_in_the_way(pre, &m.oid, "undo").await?;
                    }
                    None
                }
                (Direction::Redo, before, _) => {
                    match self.entry.stashes.first() {
                        Some(m) if m.created => crate::write::stash::refuse_stash_push_in_the_way(pre, "redo").await?,
                        Some(m) if before.is_some() => crate::write::stash::refuse_stash_apply_in_the_way(pre, &m.oid, "redo").await?,
                        _ => {}
                    }
                    None
                }
                // --- end 2C repo-safety ---
                (Direction::Undo, Some(s), left) => {
                    let mut paths = match left {
                        Some(left) => crate::write::precheck::changed_since(&pre.api.cli, pre.root, left).await?,
                        None => {
                            if crate::write::precheck::dirty(&pre.api.cli, pre.root).await?.conflicted > 0 {
                                return Err(GbError::new(GbErrorKind::InvalidInput, "Resolve or abort the conflicts first"));
                            }
                            s.paths.clone()
                        }
                    };
                    paths.extend(restore_in_the_way(s).await?); // 2C repo-safety
                    (!paths.is_empty()).then(|| AutostashSpec { rule: AutostashRule::Paths(paths), target: None, op: self.label(), target_name: Some(self.label()) })
                }
            },
            // --- end 2C T7 ---
        };
        // UX Y review 2: an out-of-order restore's entry snapshots P first, as any destructive
        // write does: its `before` is its own objects.
        let snapshot = match (&self.entry.before, &self.entry.after) {
            (Some(b), Some(a)) if self.out_of_order && self.entry.undo == UndoKind::Restore => {
                let paths: Vec<String> = b.paths.iter().chain(&a.paths).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
                let untracked = untracked_files(pre.api, pre.root, &paths).await?;
                Some((paths, untracked))
            }
            _ => None,
        };
        Ok(crate::write::Plan { autostash: spec, snapshot })
    }

    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<UndoOutcome, GbError> {
        let store = cx.api.journal(cx.root)?;
        let (id, now) = (self.entry.id, cx.api.now());
        // Expiry is checked before every undo (§5.1); this entry must still be on top.
        // UX Y: out of order, it must still be independent of everything after it (its own new
        // entry, written ahead, aside), and unchanged.
        let own = cx.entry().map(|(_, own)| own);
        let top = store.update(|j| {
            j.expire(now);
            if self.out_of_order {
                return j.out_of_order(id, own).ok().filter(|e| **e == self.entry).map(|e| e.id);
            }
            match self.dir {
                Direction::Undo => j.undo_top().map(|e| e.id),
                Direction::Redo => j.redo_top().map(|e| e.id),
            }
        })?;
        cx.journal_changed = true;
        if top != Some(id) {
            return Err(GbError::stale("The undo history changed; refreshed"));
        }
        if self.entry.undo == UndoKind::Barrier {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Push can't be undone"));
        }
        if let Some(why) = &self.entry.blocked {
            return Err(GbError::new(GbErrorKind::InvalidInput, why.clone()));
        }
        let snap = self.snapshot();
        if let Some(s) = snap
            && !snapshot::exists(cx.root, s)
        {
            store.update(|j| match self.dir {
                Direction::Undo => drop(j.drop_through(id)),
                Direction::Redo => j.redo.clear(),
            })?;
            return Err(GbError::new(GbErrorKind::NotFound, format!("Undo information for {} is missing: git has garbage-collected it.", self.entry.label)));
        }
        // §5.4: a ref that isn't where the operation left it asks first.
        let current: Vec<Option<String>> = {
            let repo = gix::open(cx.root).map_err(gix_err)?;
            self.entry.refs.iter().map(|m| read_ref(&repo, &m.name)).collect::<Result<_, _>>()?
        };
        let (mut moves, mut moved) = (Vec::new(), Vec::new());
        for (m, now) in self.entry.refs.iter().zip(current) {
            let (from, to) = self.ends(m);
            // A rename isn't confirmable (`Undo anyway` would move whatever holds the name now):
            // either name reused since refuses.
            if self.entry.undo == UndoKind::Rename && now != *from {
                let verb = if self.dir == Direction::Undo { "undone" } else { "redone" };
                return Err(GbError::stale(format!("{} can't be {verb}: {} has changed since", self.entry.label, short_ref(&m.name))));
            }
            if now != *from {
                match self.confirm.get(&m.name) {
                    Some(shown) if *shown == now => {}
                    Some(_) => return Err(GbError::ref_moved(&m.name)),
                    None => {
                        let dropped = dropped(cx.api, cx.root, from, &now).await;
                        moved.push(MovedRef { name: m.name.clone(), expected: from.clone(), actual: now, target: to.clone(), dropped, stays: false });
                        continue;
                    }
                }
            }
            moves.push(RefMove { name: m.name.clone(), old: now, new: to.clone() });
        }
        if let Some(mut m) = self.head_moved(&cx.before.head)? {
            // 2C T6: a detached reset's prompt counts what it drops, as MoveHead's.
            if self.entry.undo == UndoKind::MoveHead || self.detached_reset() {
                m.dropped = dropped(cx.api, cx.root, &m.expected, &m.actual).await;
            }
            moved.push(m);
        }
        if !moved.is_empty() {
            // UX Y: out of order, nothing is undone "anyway" (the plan refused already).
            if self.out_of_order {
                return Err(GbError::stale(format!("{} moved since {}; it can't be undone out of order", short_ref(&moved[0].name), self.entry.label)));
            }
            return Ok(UndoOutcome::Moved { label: self.entry.label.clone(), refs: moved });
        }
        // UX Y: the new entry's `before` is its own snapshot of P, taken at step 4 (the plan's), so
        // a crash leaves a Restore banner. Review 5: P is checked again just before the restore
        // (an editor's autosave since the plan is refused, with nothing changed); review 1: from
        // there on the worktree may change, so a failure or a Stop keeps the entry.
        if self.out_of_order && self.entry.undo == UndoKind::Restore {
            if let Some(after) = &self.entry.after
                && let Some(p) = crate::write::precheck::changed_since(&cx.api.cli, cx.root, after).await?.first()
            {
                return Err(GbError::stale(format!("{p} changed since {}; it can't be undone out of order", self.entry.label)));
            }
            cx.partial = true;
        }
        // "Stage all & commit": the index first, so a refusal changes nothing; if the ref move
        // then fails, it's read back (as Rewind does).
        let index = self.index_trees(&cx.before.head);
        if let Some((from, to)) = &index {
            Self::read_index(cx, from, to).await?;
        }
        // Each kind's undo is boxed: inline, this future (and its debug-build frame) would hold
        // every kind's at once.
        let moved_refs = match self.entry.undo {
            UndoKind::MoveRefs => cx.cas(&moves, &self.reflog()).await,
            UndoKind::MoveHead => Box::pin(self.move_head(cx)).await,
            UndoKind::Rewind => Box::pin(self.rewind(cx, &moves)).await,
            UndoKind::Switch => Box::pin(self.switch(cx, &moves)).await,
            // --- 2C T3 ---
            UndoKind::Rename => Box::pin(crate::write::branch::undo_rename(cx, &self.entry, self.dir == Direction::Undo)).await,
            // --- end 2C T3 ---
            UndoKind::Restore => match snap {
                Some(snap) => match Box::pin(snapshot::restore_with(&cx.snapshots(), &self.stopped_pick().map_or_else(|| snap.clone(), |st| only(snap, &st.paths)), self.stopped_pick().is_some())).await {
                    Ok(()) => {
                        cx.touch(ChangeKind::Worktree);
                        cx.touch(ChangeKind::Index);
                        cx.cas(&moves, &self.reflog()).await
                    }
                    Err(e) => Err(e),
                },
                None => Err(GbError::other("nothing to restore")),
            },
            UndoKind::Barrier => Err(GbError::new(GbErrorKind::InvalidInput, "Push can't be undone")),
            // --- 2C T7: stashes ---
            UndoKind::Stash => Box::pin(crate::write::stash::undo_stash(cx, &self.entry, self.dir == Direction::Undo, &self.entry.label, self.without_index)).await,
            // --- end 2C T7 ---
            // --- 2C T6: reset kinds ---
            UndoKind::ResetSoft | UndoKind::ResetMixed | UndoKind::ResetHard => crate::write::reset::undo_reset(cx, &self.entry, &moves, self.dir == Direction::Undo, &self.reflog()).await,
            // --- end 2C T6 ---
        };
        if let Err(e) = moved_refs {
            if let Some((from, to)) = &index
                && let Err(back) = Self::read_index(cx, to, from).await
            {
                tracing::warn!(target: "gitbolt_core::write", "reading the index back after a failed {}: {back}", self.verb());
            }
            return Err(e);
        }
        // --- 2C T1: config replay, the note ---
        // Every kind replays the entry's `branch.<name>.*` changes (Deviation 10).
        if self.out_of_order {
            let back = self.entry.config.iter().map(|c| crate::journal::ConfigChange { key: c.key.clone(), old: c.new.clone(), new: c.old.clone() }).collect();
            cx.record_config(back)?;
        }
        crate::write::config::apply(cx, &self.entry.config, self.dir == Direction::Undo).await?;
        if let Some(removed) = &self.entry.removed_remote {
            crate::write::remotes::replay_symrefs(cx, removed, self.dir == Direction::Undo).await?;
        }
        // UX Y: the undone entry leaves the stack (no Redo); its undo's entry takes its place, so
        // the entries after it stay Undo's, in order. The Redo stack stays when every redo entry
        // is independent of it (review 7). That entry's `after` is a fresh snapshot of P (review
        // 2: its objects are its own, with its own lifetime).
        if self.out_of_order {
            cx.keep_redo = store.update(|j| {
                let keep = j.redo_survives(&self.entry);
                if let Some(at) = j.undo.iter().position(|e| e.id == id) {
                    j.undo.remove(at);
                    if let Some(n) = own.and_then(|own| j.undo.iter().position(|e| e.id == own)) {
                        let e = j.undo.remove(n);
                        j.undo.insert(at.min(j.undo.len()), e);
                    }
                }
                keep
            })?;
            if let Some(p) = &cx.snapshot {
                let paths = p.paths.clone();
                let untracked = untracked_files(cx.api, cx.root, &paths).await?;
                cx.after = Some(snapshot::create(&cx.snapshots(), &self.label(), &paths, &untracked).await?);
            }
            return Ok(UndoOutcome::Done { label: self.entry.label.clone(), note: self.entry.note.clone() });
        }
        // 3B T2 fix round 1 (F): an undone stopped pick has no `after` to redo to: it goes.
        let gone = self.stopped_pick().is_some();
        store.update(|j| {
            j.shift(id, self.dir == Direction::Undo);
            if gone {
                j.drop_entry(id);
            }
        })?;
        Ok(UndoOutcome::Done { label: self.entry.label.clone(), note: self.entry.note.clone() })
        // --- end 2C T1 ---
    }
}

/// `Undo` / `Redo`: the entry the toolbar showed must still be the top one.
#[allow(clippy::too_many_arguments)] // 2C T7: `without_index`
pub(crate) async fn undo_or_redo(api: &Api, repo: u32, worktree: &str, dir: Direction, entry: u64, confirm: BTreeMap<String, Option<String>>, autostash_ok: bool, without_index: bool, confirm_discard: bool) -> Result<WriteResult<UndoOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let journal = api.journal(&root)?.load()?;
    let top = match dir {
        Direction::Undo => journal.undo_top(),
        Direction::Redo => journal.redo_top(),
    };
    let entry = top.filter(|e| e.id == entry).cloned().ok_or_else(|| GbError::stale("The undo history changed; refreshed"))?;
    let remotes_change = entry.removed_remote.is_some();
    let done = run_write(api, repo, worktree, Expect::default(), UndoIntent { dir, entry, confirm, autostash_ok, without_index, confirm_discard, out_of_order: false }).await;
    // The handle's config snapshot predates the remote coming back or going again (`reopen_repo`).
    // A failed reopen is logged: the undo itself happened.
    if remotes_change && let Err(e) = api.reopen_repo(repo) {
        tracing::warn!(target: "gitbolt_core::write", "reopening the repository after undoing a remote's removal: {e}");
    }
    done
}

// --- UX Y: out-of-order undo ---
/// Why an out-of-order undo is refused: the history changed (Stale), or a later action depends
/// on it (the dropdown's reason).
fn dependent(why: String) -> GbError {
    if why.starts_with("The undo history changed") { GbError::stale(why) } else { GbError::new(GbErrorKind::InvalidInput, why) }
}

/// The untracked files among `paths` themselves (a folder standing at one of them doesn't list
/// its files: what's in the way is the autostash's). A read.
async fn untracked_files(api: &Api, root: &std::path::Path, paths: &[String]) -> Result<Vec<String>, GbError> {
    let mut found = crate::write::precheck::untracked_among(&api.cli, root, paths).await?;
    found.retain(|u| paths.contains(u));
    Ok(found)
}

/// `git config --local --get-all <key>`: its values, in order (unset: none). A read.
async fn config_values(api: &Api, root: &std::path::Path, key: &str) -> Result<Vec<String>, GbError> {
    match api.cli.run(GitInvocation::new(root, ["config", "--local", "--null", "--get-all", key])).await {
        Ok(out) => Ok(out.stdout.split(|b| *b == 0).filter(|v| !v.is_empty()).map(|v| String::from_utf8_lossy(v).into_owned()).collect()),
        Err(e) if e.stderr.as_deref().is_some_and(|s| s.trim().is_empty()) => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

impl UndoIntent {
    /// The out-of-order undo's CAS (refuse rather than guess), under the write lock and before
    /// anything is written: the entry is still independent of every later one and unchanged, and
    /// what it changed is still as it left it: its paths as its `after` snapshot holds them (index
    /// and worktree), its refs and config keys at their new values, HEAD where it left it. A
    /// branch it moves mustn't be checked out in another worktree, nor deleted while checked out.
    async fn out_of_order_check(&self, pre: &crate::write::Pre<'_>) -> Result<(), GbError> {
        let e = &self.entry;
        let mut j = pre.api.journal(pre.root)?.load()?;
        j.expire(pre.api.now());
        let stored = j.out_of_order(e.id, None).map_err(dependent)?;
        if stored != e {
            return Err(GbError::stale("The undo history changed; refreshed"));
        }
        for s in [&e.before, &e.after].into_iter().flatten() {
            if !snapshot::exists(pre.root, s) {
                return Err(GbError::new(GbErrorKind::NotFound, format!("Undo information for {} is missing: git has garbage-collected it.", e.label)));
            }
        }
        let changed = |what: &str| GbError::stale(format!("{what} changed since {}; it can't be undone out of order", e.label));
        // HEAD may have moved since (a later commit of other files): its tree must hold each of
        // the entry's paths as it did, as the snapshot's index entries were taken against it.
        if e.undo == UndoKind::Restore && pre.before.head.oid != e.head_after.oid {
            let (Some(then), Some(now)) = (e.head_after.oid.as_deref(), pre.before.head.oid.as_deref()) else { return Err(changed("HEAD")) };
            let repo = gix::open(pre.root).map_err(gix_err)?;
            let id = |s: &str| gix::ObjectId::from_hex(s.as_bytes()).map_err(|_| changed("HEAD"));
            let moved = crate::write::precheck::tree_diff_paths(&repo, id(then)?, id(now)?)?;
            let paths: std::collections::BTreeSet<&str> = e.after.iter().chain(&e.before).flat_map(|s| s.paths.iter().map(String::as_str)).collect();
            let moved: std::collections::BTreeSet<&str> = moved.iter().map(String::as_str).collect();
            if let Some(p) = crate::journal::history::first_overlap(&paths, &moved) {
                return Err(GbError::stale(format!("HEAD changed {p} since {}; it can't be undone out of order", e.label)));
            }
        }
        if let Some(after) = &e.after
            && let Some(p) = crate::write::precheck::changed_since(&pre.api.cli, pre.root, after).await?.first()
        {
            return Err(changed(p));
        }
        {
            let repo = gix::open(pre.root).map_err(gix_err)?;
            for m in &e.refs {
                if read_ref(&repo, &m.name)? != m.new {
                    return Err(changed(short_ref(&m.name)));
                }
            }
        }
        for c in &e.config {
            if config_values(pre.api, pre.root, &c.key).await? != c.new {
                return Err(changed(&c.key));
            }
        }
        let branches: Vec<&RefMove> = e.refs.iter().filter(|m| m.name.starts_with("refs/heads/")).collect();
        if !branches.is_empty() {
            let here = pre.root.canonicalize().unwrap_or_else(|_| pre.root.to_path_buf());
            let trees = crate::worktree::list_worktrees(pre.root).await?;
            for m in branches {
                let name = short_ref(&m.name);
                for w in trees.iter().filter(|w| w.branch.as_deref() == Some(m.name.as_str())) {
                    if w.path.canonicalize().unwrap_or_else(|_| w.path.clone()) != here {
                        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{name} is checked out in {}", w.path.display())));
                    }
                    if m.old.is_none() {
                        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{name} is checked out: switch away from it to undo {}", e.label)));
                    }
                }
            }
        }
        Ok(())
    }
}

/// The Undo dropdown's rows (UX Y): undoes `entry` out of order, when it's independent of every
/// later entry. The newest one is the toolbar's own Undo.
pub(crate) async fn undo_out_of_order(api: &Api, repo: u32, worktree: &str, entry: u64, autostash_ok: bool) -> Result<WriteResult<UndoOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let journal = api.journal(&root)?.load()?;
    if journal.undo_top().map(|e| e.id) == Some(entry) {
        return undo_or_redo(api, repo, worktree, Direction::Undo, entry, BTreeMap::new(), autostash_ok, false, false).await;
    }
    let found = journal.out_of_order(entry, None).map_err(dependent)?.clone();
    run_write(api, repo, worktree, Expect::default(), UndoIntent { dir: Direction::Undo, entry: found, confirm: BTreeMap::new(), autostash_ok, without_index: false, confirm_discard: false, out_of_order: true }).await
}
// --- end UX Y ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Request;
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::state::RepoState;
    use crate::testing::{isolated_git_env, TestRepo};
    use crate::write::test_intents::{self, TestIntent};
    use crate::write::types::Confirm;
    use std::path::Path;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    fn api(data: &Path) -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(500))).with_env(isolated_git_env()), None).with_data_dir(data.to_path_buf())
    }

    fn repo() -> TestRepo {
        let r = TestRepo::new();
        r.git(&["config", "user.name", "Ada Lovelace"]);
        r.git(&["config", "user.email", "ada@example.com"]);
        r.commit("one");
        r.commit("two");
        r
    }

    /// d.txt (8 lines); `other` changes its last line.
    fn d_lines(last: Option<&str>) -> String {
        let mut s: String = (1..8).map(|i| format!("line {i}\n")).collect();
        s.push_str(&format!("{}\n", last.unwrap_or("line 8")));
        s
    }

    fn side_repo() -> TestRepo {
        let r = repo();
        r.write("d.txt", &d_lines(None));
        r.git(&["add", "d.txt"]);
        r.git(&["commit", "-q", "-m", "d"]);
        r.switch_new("other");
        r.write("d.txt", &d_lines(Some("other")));
        r.git(&["commit", "-q", "-am", "other edits d"]);
        r.switch("main");
        r
    }

    async fn open(api: &Api, r: &TestRepo) -> u32 {
        api.dispatch(Request::OpenRepo { path: r.path().display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32
    }

    fn wt(r: &TestRepo) -> String {
        r.path().canonicalize().unwrap().display().to_string()
    }

    fn expect_ref(name: &str, oid: Option<&str>) -> Expect {
        Expect { head: None, refs: [(name.to_string(), oid.map(str::to_string))].into() }
    }

    /// Runs a journaled test intent; its entry id.
    async fn op(api: &Api, id: u32, r: &TestRepo, expect: Expect, intent: TestIntent) -> u64 {
        let res = test_intents::run(api, id, &wt(r), expect, intent).await.unwrap();
        res["journal"]["undo"]["entry"].as_u64().expect("journaled")
    }

    async fn undo(api: &Api, id: u32, r: &TestRepo, entry: u64, confirm: Option<BTreeMap<String, Option<String>>>) -> Result<serde_json::Value, GbError> {
        api.dispatch(Request::Undo { repo: id, worktree: wt(r), entry, confirm, confirm_autostash: None, without_index: None, confirm_discard: None }).await
    }

    async fn redo(api: &Api, id: u32, r: &TestRepo, entry: u64) -> Result<serde_json::Value, GbError> {
        api.dispatch(Request::Redo { repo: id, worktree: wt(r), entry, confirm_autostash: None, without_index: None }).await
    }

    async fn journal(api: &Api, id: u32, r: &TestRepo) -> serde_json::Value {
        api.dispatch(Request::JournalState { repo: id, worktree: wt(r) }).await.unwrap()
    }

    fn done(v: &serde_json::Value) -> bool {
        v["outcome"]["status"] == "done"
    }

    /// §17.1: after undo, everything equals its value before the op; after redo, after it.
    async fn round_trip(api: &Api, id: u32, r: &TestRepo, expect: Expect, intent: TestIntent) {
        let before = RepoState::capture(r);
        let entry = op(api, id, r, expect, intent).await;
        let after = RepoState::capture(r);
        assert_ne!(before, after, "the op changed something");
        assert!(done(&undo(api, id, r, entry, None).await.unwrap()));
        assert_eq!(RepoState::capture(r), before, "undo gives back the state before");
        assert!(done(&redo(api, id, r, entry).await.unwrap()));
        assert_eq!(RepoState::capture(r), after, "redo gives back the state after");
    }

    #[tokio::test]
    async fn ref_creates_moves_and_deletes_round_trip() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let (c1, c2) = (r.git(&["rev-parse", "HEAD~1"]), r.git(&["rev-parse", "HEAD"]));
        round_trip(&api, id, &r, expect_ref("refs/heads/x", None), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c1.clone()) }).await;
        round_trip(&api, id, &r, expect_ref("refs/heads/x", Some(&c1)), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c2.clone()) }).await;
        round_trip(&api, id, &r, expect_ref("refs/heads/x", Some(&c2)), TestIntent::MoveRef { name: "refs/heads/x".into(), to: None }).await;
    }

    /// §5.3 Commit: the changes come back staged; redo replays the ref move, so no hook runs again.
    #[tokio::test]
    async fn a_commit_round_trips_and_redo_runs_no_hook() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "new\n");
        r.git(&["add", "a.txt"]);
        let count = r.root().join("post-commit-count");
        r.hook("post-commit", &format!("#!/bin/sh\necho x >> {}\n", count.display()));
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, Expect::default(), TestIntent::Commit { message: "Add a".into(), allow_empty: false }).await;
        assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    }

    #[tokio::test]
    async fn a_discard_round_trips_through_both_snapshots() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "staged\n");
        r.git(&["add", "file_0.txt"]);
        r.write("file_0.txt", "staged then more\n");
        r.write("new.txt", "untracked\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into(), "new.txt".into()] }).await;
    }

    /// Rewind carries local changes that don't overlap (`read-tree -m -u`).
    #[tokio::test]
    async fn a_fast_forward_rewinds_and_keeps_unrelated_local_changes() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("ahead");
        r.commit("three");
        r.switch("main");
        r.write("file_0.txt", "local change\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, Expect::default(), TestIntent::FastForward { target: "ahead".into() }).await;
        assert_eq!(std::fs::read_to_string(r.path().join("file_0.txt")).unwrap(), "local change\n");
    }

    /// 2A final I2: a file the fast-forward changed, saved since with the same bytes (only its
    /// stat changed), doesn't block the undo, nor the redo after it.
    #[tokio::test]
    async fn a_stat_only_change_doesnt_block_a_rewind() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("ahead");
        r.write("file_0.txt", "changed on ahead\n");
        r.git(&["commit", "-q", "-am", "change file_0"]);
        r.switch("main");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::FastForward { target: "ahead".into() }).await;
        let touch = || {
            let f = std::fs::File::options().write(true).open(r.path().join("file_0.txt")).unwrap();
            f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(86_400)).unwrap();
        };
        touch();
        assert!(done(&undo(&api, id, &r, entry, None).await.unwrap()), "a touch isn't a change");
        assert_eq!(r.git(&["rev-parse", "main"]), r.git(&["rev-parse", "ahead~1"]), "rewound");
        assert!(r.git(&["stash", "list"]).is_empty(), "nothing to stash");
        touch();
        assert!(done(&redo(&api, id, &r, entry).await.unwrap()));
        assert_eq!(std::fs::read_to_string(r.path().join("file_0.txt")).unwrap(), "changed on ahead\n");
    }

    /// §6.1: an undo whose Rewind overlaps local changes autostashes them; one predicted to
    /// conflict asks first (§6.2), then keeps the stash with a banner.
    #[tokio::test]
    async fn a_rewind_over_overlapping_changes_autostashes_them() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("ahead");
        r.commit("three"); // adds file_2.txt
        r.switch("main");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::FastForward { target: "ahead".into() }).await;
        r.write("file_2.txt", "edited after the fast-forward\n");
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["file_2.txt".into()], target: "main".into() }), "the undo deletes a file you changed: ask");
        let res = api.dispatch(Request::Undo { repo: id, worktree: wt(&r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await.unwrap();
        assert!(done(&res));
        assert_eq!(r.git(&["rev-parse", "main"]), r.git(&["rev-parse", "ahead~1"]), "rewound");
        assert!(r.git(&["stash", "list", "--format=%gs"]).contains("autostash before undo fast-forward to ahead"));
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashConflicts");
    }

    /// §6.1 Restore: a file of P changed since the discard is autostashed, after the warning,
    /// and only that path (review I6): an unrelated change keeps its bytes and mtime. git won't
    /// apply the stash over the restored file, so it's kept, with its banner.
    #[tokio::test]
    async fn undoing_a_discard_autostashes_what_changed_since() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty\n");
        r.write("file_1.txt", "unrelated\n");
        r.write("untracked.txt", "unrelated too\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.write("file_0.txt", "edited after the discard\n");
        let mtime = |f: &str| std::fs::metadata(r.path().join(f)).unwrap().modified().unwrap();
        let (m1, m2) = (mtime("file_1.txt"), mtime("untracked.txt"));
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["file_0.txt".into()], target: "undo discard file_0.txt".into() }));
        let res = api.dispatch(Request::Undo { repo: id, worktree: wt(&r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await.unwrap();
        assert!(done(&res));
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]), "On main: autostash before undo discard file_0.txt");
        assert_eq!(r.git(&["stash", "show", "--include-untracked", "--name-only", "stash@{0}"]), "file_0.txt", "only the path the restore overwrites");
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashRefused");
        assert_eq!(std::fs::read_to_string(r.path().join("file_0.txt")).unwrap(), "dirty\n", "the snapshot is back");
        assert_eq!((mtime("file_1.txt"), mtime("untracked.txt")), (m1, m2), "unrelated files untouched");
    }

    /// 2A final I3: a discarded directory is snapshotted file by file, so a file edited inside
    /// it after the discard is autostashed (and kept) by the undo, never overwritten.
    #[tokio::test]
    async fn undoing_a_directory_discard_stashes_a_file_edited_inside_it() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("dir/a.txt", "untracked a\n");
        r.write("dir/sub/b.txt", "untracked b\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["dir".into()] }).await;
        assert!(!r.path().join("dir/a.txt").exists(), "discarded");
        r.write("dir/a.txt", "edited after the discard\n");
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Conflict, "the restore overwrites a file you changed: ask");
        let res = api.dispatch(Request::Undo { repo: id, worktree: wt(&r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await.unwrap();
        assert!(done(&res));
        assert_eq!(r.git(&["stash", "show", "--include-untracked", "--name-only", "stash@{0}"]), "dir/a.txt", "only the edited file");
        assert_eq!(r.git(&["show", "stash@{0}^3:dir/a.txt"]), "edited after the discard", "the edit is kept in the stash");
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashPartial", "git won't apply the stash over the restored file: it's kept, with its banner");
        assert_eq!(std::fs::read_to_string(r.path().join("dir/a.txt")).unwrap(), "untracked a\n", "the snapshot is back");
        assert_eq!(std::fs::read_to_string(r.path().join("dir/sub/b.txt")).unwrap(), "untracked b\n");
    }

    /// Review m1: a mode change made since counts as a change.
    #[tokio::test]
    async fn a_mode_change_since_a_discard_asks_first() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        std::fs::set_permissions(r.path().join("file_0.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Conflict);
    }

    /// Review I7: with `eol=crlf`, the worktree's CRLF bytes are what the snapshot holds once
    /// cleaned: redo redoes the discard, with no autostash.
    #[tokio::test]
    async fn a_crlf_discard_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write(".gitattributes", "*.txt text eol=crlf\n");
        r.git(&["add", ".gitattributes"]);
        r.git(&["commit", "-q", "-m", "crlf"]);
        r.git(&["rm", "-q", "--cached", "-r", "."]);
        r.git(&["reset", "-q", "--hard"]);
        r.write("file_0.txt", "dirty\r\nlines\r\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    /// Review I1: an undo's own autostash is kept beside an older kept stash; both banners show.
    #[tokio::test]
    async fn an_undo_autostash_beside_another_kept_stash_keeps_both_banners() {
        let data = tempfile::tempdir().unwrap();
        let r = side_repo();
        r.write("d.txt", &d_lines(Some("mine")));
        r.git(&["add", "d.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = test_intents::run(&api, id, &wt(&r), Expect::default(), TestIntent::Switch { branch: "other".into(), confirm: Confirm { autostash: true }, create: false }).await.unwrap();
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashRefused");
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        r.write("d.txt", &d_lines(Some("again")));
        let res = api.dispatch(Request::Undo { repo: id, worktree: wt(&r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await.unwrap();
        assert!(done(&res));
        let kinds: Vec<&str> = res["journal"]["banners"].as_array().unwrap().iter().map(|b| b["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["autostashRefused", "autostashConflicts"]);
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]).lines().count(), 2);
    }

    /// Review I2: undoing the op shifts it to redo, and a new op clears redo: the banner stays.
    #[tokio::test]
    async fn a_kept_banner_survives_an_undo_and_a_new_op() {
        let data = tempfile::tempdir().unwrap();
        let r = side_repo();
        let c1 = r.git(&["rev-parse", "HEAD~1"]);
        r.write("d.txt", &d_lines(Some("mine")));
        r.git(&["add", "d.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = test_intents::run(&api, id, &wt(&r), Expect::default(), TestIntent::Switch { branch: "other".into(), confirm: Confirm { autostash: true }, create: false }).await.unwrap();
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        assert!(done(&undo(&api, id, &r, entry, None).await.unwrap()));
        op(&api, id, &r, expect_ref("refs/heads/n", None), TestIntent::MoveRef { name: "refs/heads/n".into(), to: Some(c1) }).await;
        let state = journal(&api, id, &r).await;
        assert!(state["redo"].is_null());
        assert_eq!(state["banners"][0]["kind"], "autostashRefused");
    }

    /// Review m13: a Switch undo whose overlap restores cleanly.
    #[tokio::test]
    async fn a_switch_undo_autostashes_on_overlap() {
        let data = tempfile::tempdir().unwrap();
        let r = side_repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Switch { branch: "other".into(), confirm: Default::default(), create: false }).await;
        let mut edited = d_lines(Some("other"));
        edited.replace_range(..5, "mine\n");
        r.write("d.txt", &edited);
        assert!(done(&undo(&api, id, &r, entry, None).await.unwrap()));
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), {
            let mut want = d_lines(None);
            want.replace_range(..5, "mine\n");
            want
        });
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    /// Review m9: HEAD switched outside GitBolt since: undoing the checkout asks first.
    #[tokio::test]
    async fn a_switch_undo_after_an_outside_switch_asks() {
        let data = tempfile::tempdir().unwrap();
        let r = side_repo();
        r.git(&["branch", "third"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Switch { branch: "other".into(), confirm: Default::default(), create: false }).await;
        r.switch("third");
        let asked = undo(&api, id, &r, entry, None).await.unwrap();
        assert_eq!(asked["outcome"]["status"], "moved");
        assert_eq!((asked["outcome"]["refs"][0]["name"].as_str(), asked["outcome"]["refs"][0]["actual"].as_str()), (Some("HEAD"), Some("refs/heads/third")));
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "third");
        let shown: BTreeMap<String, Option<String>> = [("HEAD".to_string(), Some("refs/heads/third".to_string()))].into();
        assert!(done(&undo(&api, id, &r, entry, Some(shown)).await.unwrap()));
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    }

    /// Review n5: an ignored file the Restore would overwrite (the discard deleted it; it was
    /// made again and ignored since) is stashed first, after the warning.
    #[tokio::test]
    async fn an_ignored_file_a_restore_overwrites_is_stashed_first() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("new.txt", "untracked, discarded\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["new.txt".into()] }).await;
        r.write("new.txt", "made again, then ignored\n");
        std::fs::write(r.path().join(".git/info/exclude"), "new.txt\n").unwrap();
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["new.txt".into()], target: "undo discard new.txt".into() }));
        let res = api.dispatch(Request::Undo { repo: id, worktree: wt(&r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await.unwrap();
        assert!(done(&res));
        assert_eq!(std::fs::read_to_string(r.path().join("new.txt")).unwrap(), "untracked, discarded\n", "the snapshot is back");
        assert_eq!(r.git(&["show", "stash@{0}^3:new.txt"]), "made again, then ignored", "the ignored file is in the stash");
    }

    /// Review m8: an undo of an entry that expired while it waited stashes nothing.
    #[tokio::test]
    async fn an_expired_undo_stashes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty\n");
        let now = Arc::new(AtomicI64::new(1_000));
        let clock = now.clone();
        let api = api(data.path()).with_clock(Arc::new(move || clock.load(Ordering::SeqCst)));
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.write("file_0.txt", "edited since\n");
        now.store(1_000 + crate::journal::SNAPSHOT_TTL_MS + 1, Ordering::SeqCst);
        let res = api.dispatch(Request::Undo { repo: id, worktree: wt(&r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await;
        assert_eq!(res.unwrap_err().kind, GbErrorKind::Stale);
        assert_eq!(r.git(&["stash", "list"]), "");
        assert_eq!(std::fs::read_to_string(r.path().join("file_0.txt")).unwrap(), "edited since\n");
    }

    #[tokio::test]
    async fn a_switch_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("side");
        r.commit("on side");
        r.switch("main");
        r.write("file_0.txt", "local, untouched by the switch\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, Expect::default(), TestIntent::Switch { branch: "side".into(), confirm: Default::default(), create: false }).await;
    }

    /// §5.4: a branch that moved since asks first; "Undo anyway" uses the value it showed.
    #[tokio::test]
    async fn an_outside_move_asks_then_undo_anyway_uses_the_value_shown() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let (c1, c2) = (r.git(&["rev-parse", "HEAD~1"]), r.git(&["rev-parse", "HEAD"]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, expect_ref("refs/heads/x", None), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c1.clone()) }).await;
        r.git(&["update-ref", "refs/heads/x", &c2]);
        let before = RepoState::capture(&r);
        let asked = undo(&api, id, &r, entry, None).await.unwrap();
        assert_eq!(asked["outcome"]["status"], "moved");
        let m = &asked["outcome"]["refs"][0];
        assert_eq!((m["name"].as_str(), m["expected"].as_str(), m["actual"].as_str(), m["target"].clone(), m["dropped"].as_u64()), (Some("refs/heads/x"), Some(c1.as_str()), Some(c2.as_str()), serde_json::Value::Null, Some(1)));
        assert_eq!(RepoState::capture(&r), before, "asking changes nothing");
        // The prompt showed c2; something moved it again meanwhile: RefMoved.
        r.git(&["update-ref", "refs/heads/x", &c1]);
        r.git(&["update-ref", "refs/heads/x", &c2]);
        let shown: BTreeMap<String, Option<String>> = [("refs/heads/x".to_string(), Some(c1.clone()))].into();
        assert_eq!(undo(&api, id, &r, entry, Some(shown)).await.unwrap_err().kind, GbErrorKind::RefMoved);
        let shown: BTreeMap<String, Option<String>> = [("refs/heads/x".to_string(), Some(c2.clone()))].into();
        assert!(done(&undo(&api, id, &r, entry, Some(shown)).await.unwrap()));
        assert_eq!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/x"]).ok(), None, "undone: the create is deleted");
    }

    #[tokio::test]
    async fn a_push_barrier_blocks_undo_but_newer_entries_are_undoable() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let c1 = r.git(&["rev-parse", "HEAD~1"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let barrier = op(&api, id, &r, Expect::default(), TestIntent::Barrier { label: "push main to origin/main".into() }).await;
        assert_eq!(journal(&api, id, &r).await["undoBlocked"], "Push can't be undone");
        let err = undo(&api, id, &r, barrier, None).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "Push can't be undone"));
        let newer = op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(c1) }).await;
        assert!(done(&undo(&api, id, &r, newer, None).await.unwrap()));
        assert_eq!(journal(&api, id, &r).await["undoBlocked"], "Push can't be undone", "nothing older than the push can be undone");
    }

    #[tokio::test]
    async fn undo_is_refused_mid_rebase() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let c1 = r.git(&["rev-parse", "HEAD~1"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, expect_ref("refs/heads/side", None), TestIntent::MoveRef { name: "refs/heads/side".into(), to: Some(c1) }).await;
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "c base"]);
        r.switch_new("other");
        r.write("c.txt", "other\n");
        r.git(&["commit", "-q", "-am", "other"]);
        r.switch("main");
        r.write("c.txt", "mine\n");
        r.git(&["commit", "-q", "-am", "mine"]);
        assert!(r.try_git(&["rebase", "other"]).is_err(), "the rebase stops on a conflict");
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InProgress, "A rebase is in progress"));
        assert_eq!(journal(&api, id, &r).await["undoBlocked"], "Finish or abort the rebase first");
    }

    #[tokio::test]
    async fn a_snapshot_git_garbage_collected_says_so_and_drops_older_entries_too() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let c1 = r.git(&["rev-parse", "HEAD~1"]);
        r.write("file_0.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        op(&api, id, &r, expect_ref("refs/heads/z", None), TestIntent::MoveRef { name: "refs/heads/z".into(), to: Some(c1) }).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.git(&["gc", "-q", "--prune=now"]);
        let err = undo(&api, id, &r, discard, None).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::NotFound, "Undo information for discard file_0.txt is missing: git has garbage-collected it."));
        assert_eq!(journal(&api, id, &r).await["undoBlocked"], "Nothing to undo", "the entry and every older one are dropped");
    }

    #[tokio::test]
    async fn a_new_operation_clears_redo() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let (c1, c2) = (r.git(&["rev-parse", "HEAD~1"]), r.git(&["rev-parse", "HEAD"]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, expect_ref("refs/heads/a", None), TestIntent::MoveRef { name: "refs/heads/a".into(), to: Some(c1) }).await;
        undo(&api, id, &r, entry, None).await.unwrap();
        assert!(journal(&api, id, &r).await["redo"].is_object());
        op(&api, id, &r, expect_ref("refs/heads/b", None), TestIntent::MoveRef { name: "refs/heads/b".into(), to: Some(c2) }).await;
        assert!(journal(&api, id, &r).await["redo"].is_null());
    }

    /// §5.1: expiry is checked at load and before every undo (an injected clock).
    #[tokio::test]
    async fn an_expired_snapshot_entry_is_gone() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty\n");
        let now = Arc::new(AtomicI64::new(1_000));
        let clock = now.clone();
        let api = api(data.path()).with_clock(Arc::new(move || clock.load(Ordering::SeqCst)));
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        now.store(1_000 + crate::journal::SNAPSHOT_TTL_MS + 1, Ordering::SeqCst);
        assert_eq!(journal(&api, id, &r).await["undoBlocked"], "Nothing to undo");
        assert_eq!(undo(&api, id, &r, entry, None).await.unwrap_err().kind, GbErrorKind::Stale);
    }

    #[tokio::test]
    async fn the_journal_survives_an_api_restart() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let c1 = r.git(&["rev-parse", "HEAD~1"]);
        let first = api(data.path());
        let id = open(&first, &r).await;
        let entry = op(&first, id, &r, expect_ref("refs/heads/k", None), TestIntent::MoveRef { name: "refs/heads/k".into(), to: Some(c1) }).await;
        drop(first);
        let second = api(data.path());
        let id = open(&second, &r).await;
        assert_eq!(journal(&second, id, &r).await["undo"]["entry"].as_u64(), Some(entry));
        assert!(done(&undo(&second, id, &r, entry, None).await.unwrap()));
    }

    // --- 2C T1: config replay, the Switch redo order, the note ---
    #[tokio::test(flavor = "multi_thread")]
    async fn undo_and_redo_replay_branch_config() {
        let env = crate::testing::write::WriteEnv::new();
        let r = repo();
        r.git(&["config", "branch.main.remote", "origin"]);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let entry = op(&env.api, id, &r, Expect::default(), TestIntent::BranchConfig { branch: "main".into(), key: "remote".into(), value: Some("up".into()), note: None }).await;
        let after = RepoState::capture(&r);
        assert_ne!(before.branch_config, after.branch_config);
        undo(&env.api, id, &r, entry, None).await.unwrap();
        assert_eq!(RepoState::capture(&r), before);
        redo(&env.api, id, &r, entry).await.unwrap();
        assert_eq!(RepoState::capture(&r), after);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn redo_of_a_switch_that_created_a_branch_creates_it_before_switching() {
        let env = crate::testing::write::WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let entry = op(&env.api, id, &r, Expect::default(), TestIntent::Switch { branch: "made".into(), confirm: Confirm::default(), create: true }).await;
        let after = RepoState::capture(&r);
        assert!(after.head.starts_with("refs/heads/made "));
        undo(&env.api, id, &r, entry, None).await.unwrap();
        assert_eq!(RepoState::capture(&r), before, "switched back, then the created branch deleted");
        redo(&env.api, id, &r, entry).await.unwrap();
        assert_eq!(RepoState::capture(&r), after, "created first, then switched to");
    }

    /// Review M2: a redo whose switch then fails puts the branch it created back (deletes it),
    /// so nothing is left half-redone.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_redo_whose_switch_fails_deletes_the_branch_it_created() {
        let env = crate::testing::write::WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let entry = op(&env.api, id, &r, Expect::default(), TestIntent::Switch { branch: "made".into(), confirm: Confirm::default(), create: true }).await;
        undo(&env.api, id, &r, entry, None).await.unwrap();
        let before = RepoState::capture(&r);
        let lock = r.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let res = redo(&env.api, id, &r, entry).await;
        std::fs::remove_file(&lock).unwrap();
        assert!(res.is_err(), "{res:?}");
        assert_eq!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/made"]).ok(), None, "the created branch is gone again");
        assert_eq!(RepoState::capture(&r), before);
        assert!(done(&redo(&env.api, id, &r, entry).await.unwrap()), "still redoable");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_entry_note_reaches_the_undo_outcome() {
        let env = crate::testing::write::WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let note = Some("origin/x stays deleted".to_string());
        let entry = op(&env.api, id, &r, Expect::default(), TestIntent::BranchConfig { branch: "main".into(), key: "remote".into(), value: Some("x".into()), note }).await;
        let out = undo(&env.api, id, &r, entry, None).await.unwrap();
        assert_eq!(out["outcome"], serde_json::json!({"status": "done", "label": "set branch.main.remote", "note": "origin/x stays deleted"}));
    }
    // --- end 2C T1 ---

    #[tokio::test]
    async fn an_undo_of_an_entry_that_isnt_on_top_is_stale() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = undo(&api, id, &r, 42, None).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::Stale, "The undo history changed; refreshed"));
    }

    // --- 2C repo-safety ---
    /// 2B T4 re-review N5: a repository standing at a discarded path refuses the undo in words
    /// (not as an autostash conflict), before anything runs.
    #[tokio::test]
    async fn undoing_a_discard_over_a_repository_at_the_path_is_refused_in_words() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        std::fs::remove_file(r.path().join("file_0.txt")).unwrap();
        std::fs::create_dir(r.path().join("file_0.txt")).unwrap();
        r.git_in(&r.path().join("file_0.txt"), &["init", "-q"]);
        let shown = RepoState::capture(&r);
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "file_0.txt is a repository in the way of the undo: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("file_0.txt/.git").is_dir());
    }

    async fn undo_confirmed(api: &Api, id: u32, r: &TestRepo, entry: u64) -> serde_json::Value {
        api.dispatch(Request::Undo { repo: id, worktree: wt(r), entry, confirm: None, confirm_autostash: Some(true), without_index: None, confirm_discard: None }).await.unwrap()
    }

    /// Safety review I1: a discarded folder's undo writes `notes/a.txt` back, and `checkout-index
    /// -f` would unlink the untracked file `notes` made since: it asks, then stashes it.
    #[tokio::test]
    async fn undoing_a_folder_discard_asks_about_a_file_now_standing_at_its_path() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("notes/a.txt", "discarded a\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["notes".into()] }).await;
        let _ = std::fs::remove_dir(r.path().join("notes")); // the emptied folder, if git left it
        r.write("notes", "my new notes, never committed\n");
        let shown = RepoState::capture(&r);
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["notes".into()], target: "undo discard notes".into() }));
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        assert!(done(&undo_confirmed(&api, id, &r, entry).await));
        assert_eq!(std::fs::read_to_string(r.path().join("notes/a.txt")).unwrap(), "discarded a\n");
        assert_eq!(r.git(&["show", "stash@{0}^3:notes"]), "my new notes, never committed", "the file is in the stash");
    }

    /// Safety review I2: the file `notes` goes back where a folder now holds a staged file with
    /// an unstaged edit (`AM`). The restore would remove the folder and leave `AD` behind: it
    /// asks, then stashes the entry, both halves.
    #[tokio::test]
    async fn undoing_a_discard_asks_about_index_entries_under_a_folder_in_its_way() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("notes", "discarded notes\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let entry = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["notes".into()] }).await;
        r.write("notes/a.txt", "staged\n");
        r.git(&["add", "notes/a.txt"]);
        r.write("notes/a.txt", "staged\nunstaged edit\n");
        assert_eq!(r.git(&["status", "--porcelain"]), "AM notes/a.txt");
        let shown = RepoState::capture(&r);
        let err = undo(&api, id, &r, entry, None).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["notes/a.txt".into()], target: "undo discard notes".into() }));
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        assert!(done(&undo_confirmed(&api, id, &r, entry).await));
        assert_eq!(std::fs::read_to_string(r.path().join("notes")).unwrap(), "discarded notes\n");
        assert_eq!(r.git(&["status", "--porcelain"]), "?? notes", "no AD left behind");
        assert_eq!(r.git(&["show", "stash@{0}^2:notes/a.txt"]), "staged", "the staged half");
        assert_eq!(r.git(&["show", "stash@{0}:notes/a.txt"]), "staged\nunstaged edit", "the unstaged half");
    }
    // --- end 2C repo-safety ---

    // --- UX Y: out-of-order undo ---
    async fn undo_entry(api: &Api, id: u32, r: &TestRepo, entry: u64) -> Result<serde_json::Value, GbError> {
        api.dispatch(Request::UndoEntry { repo: id, worktree: wt(r), entry, confirm_autostash: None }).await
    }

    async fn save(api: &Api, id: u32, r: &TestRepo, path: &str, text: &str) -> u64 {
        let base = crate::blob::worktree_id(&std::fs::read(r.path().join(path)).unwrap());
        let res = api.dispatch(Request::WriteWorktreeFile { repo: id, worktree: wt(r), path: path.into(), text: text.into(), base }).await.unwrap();
        res["journal"]["undo"]["entry"].as_u64().unwrap()
    }

    fn read(r: &TestRepo, path: &str) -> String {
        std::fs::read_to_string(r.path().join(path)).unwrap()
    }

    /// The dropdown's rows (`journalHistory`).
    async fn history(api: &Api, id: u32, r: &TestRepo) -> serde_json::Value {
        api.dispatch(Request::JournalHistory { repo: id, worktree: wt(r) }).await.unwrap()
    }

    /// Y.3: discard A, edit B, undo the discard from the dropdown: A is back, B's edit stays,
    /// and Undo then undoes B's save. The out-of-order undo is an entry of its own, in the
    /// discard's place: undoing it discards A again.
    #[tokio::test]
    async fn undoing_an_older_discard_keeps_a_later_edit_and_undo_order() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty A\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        let b_before = read(&r, "file_1.txt");
        let saved = save(&api, id, &r, "file_1.txt", "edited B\n").await;
        let s = history(&api, id, &r).await;
        let rows = s.as_array().unwrap();
        assert_eq!(rows.len(), 2, "{s}");
        assert_eq!((rows[0]["entry"].as_u64(), rows[1]["entry"].as_u64()), (Some(saved), Some(discard)));
        assert!(rows[1]["blocked"].is_null(), "independent: {s}");
        assert_eq!(rows[1]["touched"], serde_json::json!(["file_0.txt"]));
        let res = undo_entry(&api, id, &r, discard).await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "label": "discard file_0.txt"}));
        assert_eq!(read(&r, "file_0.txt"), "dirty A\n", "A is back");
        assert_eq!(read(&r, "file_1.txt"), "edited B\n", "B's edit is intact");
        assert_eq!(res["journal"]["undo"]["entry"].as_u64(), Some(saved), "Undo is B's save");
        assert!(res["journal"]["redo"].is_null(), "no Redo for it");
        let rows = history(&api, id, &r).await.as_array().unwrap().clone();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["label"], "undo discard file_0.txt", "its undo took the discard's place");
        assert!(done(&undo(&api, id, &r, saved, None).await.unwrap()));
        assert_eq!(read(&r, "file_1.txt"), b_before, "Undo undid B's save");
        assert_eq!(read(&r, "file_0.txt"), "dirty A\n");
        let s = journal(&api, id, &r).await;
        let back = s["undo"]["entry"].as_u64().unwrap();
        assert_eq!(s["undo"]["label"], "undo discard file_0.txt");
        assert!(done(&undo(&api, id, &r, back, None).await.unwrap()));
        assert_eq!(r.git(&["status", "--porcelain"]), "", "undoing the undo discards A again");
    }

    /// A later action on the same path: refused before anything is written, with the reason.
    #[tokio::test]
    async fn a_dependent_entry_is_refused_and_nothing_changes() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "first\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let first = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.write("file_0.txt", "second\n");
        op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        assert_eq!(history(&api, id, &r).await[1]["blocked"], "A later action changed file_0.txt");
        let (state, file) = (RepoState::capture(&r), std::fs::read(api.journal(&r.path().canonicalize().unwrap()).unwrap().path()).unwrap());
        let err = undo_entry(&api, id, &r, first).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "A later action changed file_0.txt"));
        assert_eq!(RepoState::capture(&r), state, "nothing changed");
        assert_eq!(std::fs::read(api.journal(&r.path().canonicalize().unwrap()).unwrap().path()).unwrap(), file, "the journal is untouched");
    }

    /// The CAS at run time: a path the entry restores changed since (outside GitBolt), though
    /// the journal still calls it independent: refused, nothing changed, nothing stashed.
    #[tokio::test]
    async fn a_cas_mismatch_at_run_time_refuses_with_nothing_changed() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty A\n");
        r.write("file_1.txt", "dirty B\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let a = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_1.txt".into()] }).await;
        r.write("file_0.txt", "edited outside\n");
        let s = history(&api, id, &r).await;
        assert!(s[1]["blocked"].is_null(), "the journal can't see it: {s}");
        let jpath = api.journal(&r.path().canonicalize().unwrap()).unwrap().path().to_path_buf();
        let (state, file) = (RepoState::capture(&r), std::fs::read(&jpath).unwrap());
        let err = undo_entry(&api, id, &r, a).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale);
        assert_eq!(err.message, "file_0.txt changed since discard file_0.txt; it can't be undone out of order");
        assert_eq!(RepoState::capture(&r), state, "nothing changed");
        assert_eq!(std::fs::read(&jpath).unwrap(), file, "no entry was written");
        // Staged since, the file as the discard left it (the index side of the CAS): refused too.
        r.write("file_0.txt", "staged\n");
        r.git(&["add", "file_0.txt"]);
        r.git(&["restore", "--source=HEAD", "--worktree", "--", "file_0.txt"]);
        let state = RepoState::capture(&r);
        let err = undo_entry(&api, id, &r, a).await.unwrap_err();
        assert_eq!(err.message, "file_0.txt changed since discard file_0.txt; it can't be undone out of order");
        assert_eq!(RepoState::capture(&r), state, "nothing changed");
        r.git(&["reset", "-q"]);
        assert!(done(&undo_entry(&api, id, &r, a).await.unwrap()), "back as the discard left it: allowed");
        assert_eq!(read(&r, "file_0.txt"), "dirty A\n");
    }

    /// A ref move out of order: a branch created earlier is deleted past a later discard, as an
    /// entry of its own; a branch moved since refuses.
    #[tokio::test]
    async fn a_created_branch_undoes_out_of_order_and_refuses_once_moved() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let (c1, c2) = (r.git(&["rev-parse", "HEAD~1"]), r.git(&["rev-parse", "HEAD"]));
        let x = op(&api, id, &r, expect_ref("refs/heads/x", None), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c1.clone()) }).await;
        let y = op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(c1.clone()) }).await;
        op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.git(&["update-ref", "refs/heads/y", &c2]);
        let state = RepoState::capture(&r);
        let err = undo_entry(&api, id, &r, y).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale);
        assert!(err.message.starts_with("y changed since ") && err.message.ends_with("; it can't be undone out of order"), "{}", err.message);
        assert_eq!(RepoState::capture(&r), state);
        assert!(done(&undo_entry(&api, id, &r, x).await.unwrap()));
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/x"]).is_err(), "x is gone");
        assert_eq!(r.git(&["status", "--porcelain"]), "", "the discard stays");
        let s = history(&api, id, &r).await;
        let n = s.as_array().unwrap().iter().find(|row| row["label"].as_str().is_some_and(|l| l.starts_with("undo "))).unwrap()["entry"].as_u64().unwrap();
        assert!(done(&undo_entry(&api, id, &r, n).await.unwrap()), "its undo is undoable in turn");
        assert_eq!(r.git(&["rev-parse", "refs/heads/x"]), c1);
    }

    /// A commit touches only the paths it changed: a discard of another file stays undoable past
    /// it (over the moved HEAD), and the commit is left as it is; a commit of the discarded file
    /// makes the discard dependent.
    #[tokio::test]
    async fn a_commit_of_other_files_leaves_an_earlier_discard_undoable() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty A\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.write("file_1.txt", "B committed\n");
        r.git(&["add", "file_1.txt"]);
        op(&api, id, &r, Expect::default(), TestIntent::Commit { message: "Commit B".into(), allow_empty: false }).await;
        let tip = r.git(&["rev-parse", "HEAD"]);
        let s = history(&api, id, &r).await;
        assert_eq!(s[0]["touched"], serde_json::json!(["file_1.txt", "main"]), "{s}");
        assert!(s[1]["blocked"].is_null(), "{s}");
        assert!(done(&undo_entry(&api, id, &r, discard).await.unwrap()));
        assert_eq!(read(&r, "file_0.txt"), "dirty A\n", "A is back");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), tip, "B's commit is intact");
        assert_eq!(r.git(&["show", "HEAD:file_1.txt"]), "B committed");
        assert_eq!(r.git(&["status", "--porcelain"]), " M file_0.txt");
    }

    #[tokio::test]
    async fn a_commit_of_the_discarded_file_makes_the_discard_dependent() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty A\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        r.write("file_0.txt", "A again\n");
        r.git(&["add", "file_0.txt"]);
        op(&api, id, &r, Expect::default(), TestIntent::Commit { message: "Commit A".into(), allow_empty: false }).await;
        let state = RepoState::capture(&r);
        let err = undo_entry(&api, id, &r, discard).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "A later action changed file_0.txt"));
        assert_eq!(RepoState::capture(&r), state, "nothing changed");
    }

    /// An outside commit of the discarded file (no entry of its own): the HEAD check, path by
    /// path, refuses.
    #[tokio::test]
    async fn an_outside_commit_of_the_file_refuses_at_run_time() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty A\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(r.git(&["rev-parse", "HEAD"])) }).await;
        // HEAD's file_0.txt changes; its index entry and file stay as the discard left them.
        r.write("file_0.txt", "committed outside\n");
        r.git(&["commit", "-q", "-am", "outside"]);
        r.git(&["reset", "-q", "HEAD~1", "--", "file_0.txt"]);
        r.git(&["checkout", "--", "file_0.txt"]);
        let state = RepoState::capture(&r);
        let err = undo_entry(&api, id, &r, discard).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale);
        assert!(err.message.contains("file_0.txt"), "{}", err.message);
        assert_eq!(RepoState::capture(&r), state, "nothing changed");
    }

    /// Review 2: the new entry snapshots P itself, before and after the restore: its objects are
    /// its own, so a 13-day-old target gives an entry that lives its full 14 days.
    #[tokio::test]
    async fn the_undos_entry_has_its_own_snapshots_and_a_full_term() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("file_0.txt", "dirty A\n");
        let now = Arc::new(AtomicI64::new(1_000));
        let clock = now.clone();
        let api = api(data.path()).with_clock(Arc::new(move || clock.load(Ordering::SeqCst)));
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        let store = api.journal(&r.path().canonicalize().unwrap()).unwrap();
        let original = store.load().unwrap().undo[0].clone();
        let day = 24 * 60 * 60 * 1000;
        let undone_at = 1_000 + 13 * day;
        now.store(undone_at, Ordering::SeqCst);
        let y = op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(r.git(&["rev-parse", "HEAD"])) }).await;
        assert!(done(&undo_entry(&api, id, &r, discard).await.unwrap()));
        let n = store.load().unwrap().undo[0].clone();
        assert_eq!(n.at_ms, undone_at);
        let (nb, na) = (n.before.clone().unwrap(), n.after.clone().unwrap());
        assert_ne!(Some(&nb.commit), original.after.as_ref().map(|s| &s.commit), "its own before");
        assert_ne!(Some(&na.commit), original.before.as_ref().map(|s| &s.commit), "its own after");
        assert_eq!(r.git(&["show", &format!("{}:file_0.txt", na.commit)]), "dirty A", "after: A as restored");
        // Past the target's term: it stays, and stays undoable.
        now.store(1_000 + crate::journal::SNAPSHOT_TTL_MS + 1, Ordering::SeqCst);
        let rows: Vec<u64> = history(&api, id, &r).await.as_array().unwrap().iter().map(|r| r["entry"].as_u64().unwrap()).collect();
        assert_eq!(rows, vec![y, n.id], "its full term");
        // Past its own: gone.
        now.store(undone_at + crate::journal::SNAPSHOT_TTL_MS + 1, Ordering::SeqCst);
        let rows: Vec<u64> = history(&api, id, &r).await.as_array().unwrap().iter().map(|r| r["entry"].as_u64().unwrap()).collect();
        assert_eq!(rows, vec![y]);
    }

    /// Review 1: the restore fails between its worktree step and its index step (a smudge filter
    /// takes the index lock): the worktree changed, so the new entry stays, undoable, with its
    /// `before`; the undone entry is still there.
    #[tokio::test]
    async fn a_restore_failing_midway_keeps_the_new_entry() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write(".gitattributes", "t.lock filter=locker\n");
        r.write("t.lock", "base\n");
        r.git(&["add", ".gitattributes", "t.lock"]);
        r.git(&["commit", "-q", "-m", "lock filter"]);
        r.write("t.lock", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["t.lock".into()] }).await;
        op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(r.git(&["rev-parse", "HEAD"])) }).await;
        let lock = r.path().join(".git/index.lock");
        r.git(&["config", "filter.locker.smudge", &format!("sh -c 'touch {}; cat'", lock.display())]);
        r.git(&["config", "filter.locker.clean", "cat"]);
        assert!(undo_entry(&api, id, &r, discard).await.is_err(), "update-index meets the lock");
        assert!(lock.exists());
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(read(&r, "t.lock"), "dirty\n", "the worktree step ran");
        let j = api.journal(&r.path().canonicalize().unwrap()).unwrap().load().unwrap();
        let n = j.undo.iter().find(|e| e.label == "undo discard t.lock").expect("the new entry stays");
        assert_eq!(n.state, crate::journal::EntryState::Done);
        assert!(n.before.is_some(), "its before: P as it was");
        assert!(j.undo.iter().any(|e| e.id == discard), "the undone entry stays too");
        assert_eq!(j.undo_top().map(|e| e.id), Some(n.id), "Undo puts P back");
    }

    /// Review 1: a Stop while the autostash is restored, after the restore ran: the write fails,
    /// and the new entry (in the undone one's place) stays.
    #[tokio::test]
    async fn a_stop_restoring_the_autostash_keeps_the_new_entry() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write(".gitattributes", "notes filter=toucher\n*.slow filter=slow\n");
        r.write("t.slow", "slow\n");
        r.git(&["add", ".gitattributes", "t.slow"]);
        r.git(&["commit", "-q", "-m", "filters"]);
        r.write("notes", "my notes\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["notes".into()] }).await;
        op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(r.git(&["rev-parse", "HEAD"])) }).await;
        r.write("notes/a.txt", "in the way\n");
        // The restore of `notes` makes t.slow stat-dirty; the stash apply's index refresh then
        // cleans it, and its clean filter hangs when `git stash apply` runs it, until the Stop.
        let t_slow = r.path().join("t.slow");
        r.git(&["config", "filter.toucher.smudge", &format!("touch -d 2001-01-01 {}; cat", t_slow.display())]);
        r.git(&["config", "filter.toucher.clean", "cat"]);
        r.git(&["config", "filter.slow.clean", "case \"$(tr '\\0' ' ' < /proc/$PPID/cmdline)\" in *\"stash apply\"*) sleep 30;; esac; cat"]);
        r.git(&["config", "filter.slow.smudge", "cat"]);
        let mut rx = api.subscribe();
        let stop = async {
            loop {
                let Ok(ev) = tokio::time::timeout(std::time::Duration::from_secs(20), rx.recv()).await else { return };
                if let Ok(crate::events::AppEvent::OpStashStep { op, step: Some(crate::events::StashStep::Restoring), .. }) = ev {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    api.dispatch(Request::CancelOp { op }).await.unwrap();
                    return;
                }
            }
        };
        let started = std::time::Instant::now();
        let run = api.dispatch(Request::UndoEntry { repo: id, worktree: wt(&r), entry: discard, confirm_autostash: Some(true) });
        let (res, ()) = tokio::join!(run, stop);
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "stopped: {res:?}");
        let err = res.unwrap_err();
        assert!(err.message.starts_with("Stopped restoring your changes"), "{}", err.message);
        assert_eq!(read(&r, "notes"), "my notes\n", "the restore ran");
        let j = api.journal(&r.path().canonicalize().unwrap()).unwrap().load().unwrap();
        assert!(j.undo.iter().any(|e| e.label == "undo discard notes" && e.before.is_some()), "the new entry stays: {:?}", j.undo.iter().map(|e| &e.label).collect::<Vec<_>>());
        assert!(!j.undo.iter().any(|e| e.id == discard), "in the undone entry's place");
        assert!(r.git(&["stash", "list", "--format=%gs"]).contains("autostash before undo discard notes"), "the stash is kept");
    }

    /// Review 5: a change to P between the plan's check and the restore (an editor's autosave)
    /// is refused just before the restore, with nothing changed.
    #[tokio::test]
    async fn a_change_after_the_plan_is_refused_before_the_restore() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write(".gitattributes", "b.flt filter=autosave\n");
        r.write("b.flt", "b\n");
        r.git(&["add", ".gitattributes", "b.flt"]);
        r.git(&["commit", "-q", "-m", "autosave filter"]);
        r.write("a.txt", "dirty a\n");
        r.git(&["add", "a.txt"]);
        r.git(&["commit", "-q", "-m", "a"]);
        r.write("a.txt", "dirty a, edited\n");
        r.write("b.flt", "dirty b\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let discard = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["a.txt".into(), "b.flt".into()] }).await;
        op(&api, id, &r, expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(r.git(&["rev-parse", "HEAD"])) }).await;
        // Hashing b.flt (after a.txt, in P's order) "autosaves" a.txt: the plan's check has read
        // a.txt by then; the check before the restore hasn't.
        let a = r.path().join("a.txt");
        r.git(&["config", "filter.autosave.clean", &format!("sh -c 'printf autosaved > {}; cat'", a.display())]);
        r.git(&["config", "filter.autosave.smudge", "cat"]);
        let jfile = api.journal(&r.path().canonicalize().unwrap()).unwrap();
        let err = undo_entry(&api, id, &r, discard).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale);
        assert_eq!(err.message, "a.txt changed since discard 2 files; it can't be undone out of order");
        assert_eq!(read(&r, "a.txt"), "autosaved", "the autosave stands");
        assert_eq!(read(&r, "b.flt"), "b\n", "nothing restored");
        let j = jfile.load().unwrap();
        assert!(j.undo.iter().any(|e| e.id == discard) && !j.undo.iter().any(|e| e.label.starts_with("undo ")), "no new entry");
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    /// Review 7: A, B, C, Undo C, then A from the dropdown: C's Redo stays (independent).
    #[tokio::test]
    async fn an_out_of_order_undo_keeps_an_independent_redo() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        for f in ["file_0.txt", "file_1.txt", "new.txt"] {
            r.write(f, &format!("dirty {f}\n"));
        }
        let api = api(data.path());
        let id = open(&api, &r).await;
        let a = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await;
        op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["file_1.txt".into()] }).await;
        let c = op(&api, id, &r, Expect::default(), TestIntent::Discard { paths: vec!["new.txt".into()] }).await;
        assert!(done(&undo(&api, id, &r, c, None).await.unwrap()));
        let res = undo_entry(&api, id, &r, a).await.unwrap();
        assert_eq!(res["journal"]["redo"]["entry"].as_u64(), Some(c), "C's Redo stays: {res}");
        assert!(done(&redo(&api, id, &r, c).await.unwrap()));
        assert!(!r.path().join("new.txt").exists(), "C redone");
        assert_eq!(read(&r, "file_0.txt"), "dirty file_0.txt\n");
    }
    // --- end UX Y ---
}
