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
        if top != Some(self.entry.id) || !matches!(self.head_moved(head), Ok(None)) {
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

    /// Not an entry of its own: it moves one between the stacks (§5.4).
    fn undo(&self) -> Option<UndoKind> {
        None
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
                    let mut paths = match self.left() {
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
        Ok(crate::write::Plan { autostash: spec, ..Default::default() })
    }

    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<UndoOutcome, GbError> {
        let store = cx.api.journal(cx.root)?;
        let (id, now) = (self.entry.id, cx.api.now());
        // Expiry is checked before every undo (§5.1); this entry must still be on top.
        let top = store.update(|j| {
            j.expire(now);
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
            return Ok(UndoOutcome::Moved { label: self.entry.label.clone(), refs: moved });
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
        crate::write::config::apply(cx, &self.entry.config, self.dir == Direction::Undo).await?;
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
    run_write(api, repo, worktree, Expect::default(), UndoIntent { dir, entry, confirm, autostash_ok, without_index, confirm_discard }).await
}

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
}
