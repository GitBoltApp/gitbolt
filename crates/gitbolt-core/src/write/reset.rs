//! Reset (spec #2 §9.4): `git reset --soft|--mixed|--hard <oid>` after the preflight check; git
//! moves the branch (or a detached HEAD). Mixed and hard snapshot every changed tracked path
//! first; hard also snapshots every untracked or ignored file git would delete in the way of
//! the target's files (other untracked files are left alone by git and the snapshot). Hard asks
//! first when there's anything to discard, and refuses when a repository (a submodule, an
//! embedded clone) is in the way: no snapshot can carry one. Undo per §5.3:
//! - soft: the branch (or HEAD) back;
//! - mixed: the two-way `git read-tree -m -i <now> <old>`, the index part of `before`, then
//!   back (P's entries staged since the reset are autostashed first, which asks);
//! - hard: Rewind (`read-tree -m -u <new> <old>`, then the CAS), then Restore `before`.
//!
//! Redo re-runs the reset behind the same check, snapshotting again.

use crate::api::blocking;
use crate::error::{gix_err, ErrorDetail, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{snapshot, JournalEntry, RefMove, UndoKind};
use crate::write::{precheck, refs, Plan, Pre, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl ResetMode {
    fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        }
    }

    fn word(self) -> &'static str {
        &self.flag()[2..]
    }

    pub(crate) fn undo_kind(self) -> UndoKind {
        match self {
            ResetMode::Soft => UndoKind::ResetSoft,
            ResetMode::Mixed => UndoKind::ResetMixed,
            ResetMode::Hard => UndoKind::ResetHard,
        }
    }

    fn of(kind: UndoKind) -> Option<Self> {
        match kind {
            UndoKind::ResetSoft => Some(ResetMode::Soft),
            UndoKind::ResetMixed => Some(ResetMode::Mixed),
            UndoKind::ResetHard => Some(ResetMode::Hard),
            _ => None,
        }
    }
}

pub(crate) struct Reset {
    pub to: String,
    pub mode: ResetMode,
    pub discard: bool,
    /// `X`: the worktree's branch, or `HEAD` when detached (read by the request before the run).
    pub x: String,
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

/// What a mixed or hard reset snapshots: the changed tracked paths (staged or not) and, for
/// hard, the files outside the index that it deletes ([`overwritten`]).
async fn at_risk(api: &crate::api::Api, root: &Path, mode: ResetMode, to: &str) -> Result<(Vec<String>, Vec<String>), GbError> {
    let tracked = precheck::dirty(&api.cli, root).await?.tracked;
    let overwritten = if mode == ResetMode::Hard { overwritten(&api.cli, root, to, &tracked).await? } else { Vec::new() };
    Ok((tracked.into_iter().collect(), overwritten))
}

/// The files outside the index (untracked or ignored) that `git reset --hard <to>` deletes:
/// git writes every target file that differs from HEAD or from the worktree, and replaces
/// whatever is in its way without asking (review C1):
/// - a file at the path itself;
/// - a directory at the path: every file under it that isn't in the index;
/// - a file at one of its leading directories (the target has `e/f`, the disk a file `e`).
///
/// A path already in `tracked` isn't one of them (review I2): the tracked snapshot carries it,
/// a staged deletion included.
///
/// A repository in the way (a submodule, an embedded clone) is refused: git deletes it whole
/// and no snapshot can carry it (review C2, [`precheck::repos_at`]). The reset works from the
/// index, so the check runs over the candidates, `tree_diff(HEAD, to) ∪ tracked`, not the tree
/// diff alone: a staged gitlink at a path where HEAD and the target hold the same blob is in
/// its way too (re-review 3 C4).
async fn overwritten(cli: &crate::git::GitCli, root: &Path, to: &str, tracked: &BTreeSet<String>) -> Result<Vec<String>, GbError> {
    let (root_buf, to, written) = (root.to_path_buf(), to.to_string(), tracked.clone());
    let (mut files, dirs) = blocking(move || {
        let root = root_buf;
        let repo = gix::open(&root).map_err(gix_err)?;
        let Ok(head) = repo.head_id() else { return Ok((BTreeSet::new(), Vec::new())) };
        let to = gix::ObjectId::from_hex(to.as_bytes()).map_err(gix_err)?;
        let target = repo.find_commit(to).map_err(gix_err)?.tree().map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let indexed: BTreeSet<String> = index.entries().iter().map(|e| e.path(&index).to_str_lossy().into_owned()).collect();
        // --- 2C repo-safety ---
        let diff = precheck::tree_diff(&repo, head.detach(), to)?;
        let gitlinks = precheck::gitlinks(&index, &diff);
        // The target's files: the diff's own, plus the dirty paths outside it that it holds as
        // a file (one lookup each).
        let mut files = diff.to_files.clone();
        files.extend(precheck::files_in(&target, written.iter().filter(|p| !diff.paths.contains(*p)))?);
        let mut candidates = diff.paths;
        candidates.extend(written);
        // The directories in the way of a target file (a gitlink only makes its directory,
        // review M6; an unpopulated gitlink's empty directory lists nothing, M8) come from the
        // same scan; a nested repository in one is refused below, from the `ls-files` read.
        let scan = precheck::repos_at(&root, &gitlinks, files.iter().map(|p| p.as_bstr()));
        if let Some(p) = scan.repos.first() {
            return Err(precheck::repository_in_the_way(p, "reset"));
        }
        let (mut files, dirs) = (BTreeSet::new(), scan.dirs);
        // --- end 2C repo-safety ---
        for p in candidates {
            if target.lookup_entry_by_path(p.as_str()).map_err(gix_err)?.filter(|e| !e.mode().is_tree()).is_none() {
                continue;
            }
            match root.join(&p).symlink_metadata() {
                Ok(m) if m.is_dir() => {}
                Ok(_) if !indexed.contains(&p) => {
                    files.insert(p.clone());
                }
                _ => {}
            }
            // A leading directory that is a file (or a symlink) on disk: git replaces it.
            let mut q = String::new();
            for part in p.split('/').take(p.split('/').count() - 1) {
                if !q.is_empty() {
                    q.push('/');
                }
                q.push_str(part);
                match root.join(&q).symlink_metadata() {
                    Ok(m) if m.is_dir() => continue,
                    Ok(_) => {
                        if !indexed.contains(&q) {
                            files.insert(q.clone());
                        }
                        break;
                    }
                    Err(_) => break,
                }
            }
        }
        Ok((files, dirs))
    })
    .await?;
    // Every file under a directory in the way that isn't in the index, ignored ones included.
    // A nested repository there: the snapshot can't carry it, and git would delete it.
    let (repos, others) = precheck::others_under(cli, root, &dirs).await?;
    if let Some(r) = repos.first() {
        return Err(precheck::repository_in_the_way(r, "reset"));
    }
    files.extend(others);
    files.retain(|f| !tracked.contains(f));
    Ok(files.into_iter().collect())
}

/// What the mixed reset's undo would lose or be refused over: the paths of P ∪ the tree diff
/// `now..old` staged since the reset (an index entry no longer `now`'s tree entry). P's would be
/// overwritten from `before`; the diff's make the two-way read-tree refuse ("would be
/// overwritten by merge", review I3). They're autostashed first, which asks (§6.1, review I1).
pub(crate) fn staged_since(root: &Path, now: &str, old: &str, before: Option<&crate::journal::Snapshot>) -> Result<Vec<String>, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let (now, old) = (gix::ObjectId::from_hex(now.as_bytes()).map_err(gix_err)?, gix::ObjectId::from_hex(old.as_bytes()).map_err(gix_err)?);
    let tree = repo.find_commit(now).map_err(gix_err)?.tree().map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let mut paths = precheck::tree_diff_paths(&repo, now, old)?;
    if let Some(snap) = before {
        paths.extend(snap.paths.iter().filter(|p| !snap.untracked.contains(p)).cloned());
    }
    let mut out = Vec::new();
    for p in &paths {
        let staged = index.entry_by_path(p.as_bytes().as_bstr()).map(|e| (e.mode.bits(), e.id));
        let committed = tree.lookup_entry_by_path(p.as_str()).map_err(gix_err)?.filter(|e| !e.mode().is_tree()).map(|e| (u32::from(e.mode().value()), e.object_id()));
        if staged != committed {
            out.push(p.clone());
        }
    }
    Ok(out)
}

/// The snapshot `Plan` wants for these paths: P is both lists, `untracked` the overwritten ones.
fn snapshot_of(tracked: Vec<String>, overwritten: Vec<String>) -> Option<(Vec<String>, Vec<String>)> {
    let mut paths = tracked;
    paths.extend(overwritten.iter().cloned());
    (!paths.is_empty()).then_some((paths, overwritten))
}

impl WriteIntent for Reset {
    type Outcome = ();

    fn kind(&self) -> OpKind {
        OpKind::Reset
    }

    fn label(&self) -> String {
        format!("reset {} to {} ({})", self.x, short(&self.to), self.mode.word())
    }

    fn undo(&self) -> Option<UndoKind> {
        Some(self.mode.undo_kind())
    }

    /// Under the lock (Deviation 6): a hard reset over changes asks first, from what's dirty now.
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if self.to.len() < 40 || gix::ObjectId::from_hex(self.to.as_bytes()).is_err() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {}", self.to)));
        }
        if pre.before.head.oid.is_none() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("Nothing is committed on {} yet", self.x)));
        }
        if self.mode == ResetMode::Soft {
            return Ok(Plan::default());
        }
        let (tracked, overwritten) = at_risk(pre.api, pre.root, self.mode, &self.to).await?;
        let files = (tracked.len() + overwritten.len()) as u32;
        if self.mode == ResetMode::Hard && files > 0 && !self.discard {
            let noun = if files == 1 { "file" } else { "files" };
            let msg = format!("Reset {} to {} and discard changes to {files} {noun}? You can undo this.", self.x, short(&self.to));
            return Err(GbError::new(GbErrorKind::DirtyWorktree, msg).with_detail(ErrorDetail::ResetDiscards { branch: self.x.as_str().into(), to: short(&self.to).into(), files }));
        }
        Ok(Plan { snapshot: snapshot_of(tracked, overwritten), ..Plan::default() })
    }

    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        cx.partial = self.mode != ResetMode::Soft;
        run_reset(cx, self.mode, &self.to).await
    }
}

async fn run_reset(cx: &mut WriteCx<'_>, mode: ResetMode, to: &str) -> Result<(), GbError> {
    let inv = cx.git(["reset", "-q", mode.flag(), to]);
    cx.run_git(inv).await?;
    cx.touch(ChangeKind::Head);
    cx.touch(ChangeKind::Index);
    if mode == ResetMode::Hard {
        cx.touch(ChangeKind::Worktree);
    }
    Ok(())
}

/// HEAD's oid before the reset and the oid it reset to.
fn ends(entry: &JournalEntry) -> Result<(String, String), GbError> {
    match (&entry.head_before.oid, &entry.head_after.oid) {
        (Some(a), Some(b)) => Ok((a.clone(), b.clone())),
        _ => Err(GbError::other("the reset's HEAD isn't recorded")),
    }
}

/// Moves the reset's branch by CAS (`moves`, from the moved-ref check), or a detached HEAD
/// itself (Deviation 3) from `from`, where HEAD is now.
async fn move_head(cx: &mut WriteCx<'_>, entry: &JournalEntry, moves: &[RefMove], from: &str, to: &str, message: &str) -> Result<(), GbError> {
    if entry.head_before.branch.is_some() {
        cx.cas(moves, message).await
    } else {
        refs::cas_detached_head(&cx.api.cli, &cx.token, cx.root, from, to, message).await?;
        cx.touch(ChangeKind::Head);
        Ok(())
    }
}

/// The reset kinds' undo and redo (§5.3). `moves` are the moved-ref check's CAS requests for
/// this direction; `undo` is the direction.
///
/// Anything beyond a soft undo acts on this worktree's HEAD, index and files, so it needs the
/// reset's branch checked out here (a detached reset's HEAD is checked by `head_moved`): a
/// `git reset` elsewhere would move another branch.
pub(crate) async fn undo_reset(cx: &mut WriteCx<'_>, entry: &JournalEntry, moves: &[RefMove], undo: bool, message: &str) -> Result<(), GbError> {
    let mode = ResetMode::of(entry.undo).ok_or_else(|| GbError::other("not a reset"))?;
    let (old, new) = ends(entry)?;
    let here = cx.before.head.branch == entry.head_before.branch;
    if !here && (!undo || mode != ResetMode::Soft) {
        let b = entry.head_before.branch.as_deref().unwrap_or("HEAD");
        let verb = if undo { "undo" } else { "redo" };
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("Check out {b} again to {verb} this reset")));
    }
    // Where HEAD is now: the reset's result, or the value "Undo anyway" was shown.
    let now = cx.before.head.oid.clone().unwrap_or_else(|| new.clone());
    if !undo {
        // Redo re-runs the reset behind the CAS check (§5.3), with a fresh `before` for mixed
        // and hard, which the next undo restores.
        if mode != ResetMode::Soft {
            let (tracked, overwritten) = at_risk(cx.api, cx.root, mode, &new).await?;
            let snap = match snapshot_of(tracked, overwritten) {
                Some((paths, untracked)) => Some(snapshot::create(&cx.snapshots(), message, &paths, &untracked).await?),
                None => None,
            };
            // The undo intent has no entry of its own: the redone one is edited in the store.
            let id = entry.id;
            cx.api.journal(cx.root)?.update(|j| {
                if let Some(e) = j.entry_mut(id) {
                    e.before = snap;
                }
            })?;
        }
        return run_reset(cx, mode, &new).await;
    }
    match mode {
        ResetMode::Soft => move_head(cx, entry, moves, &now, &old, message).await,
        ResetMode::Mixed => {
            // The index first, so a refusal changes nothing; if a later step fails, it's read
            // back. A two-way read (as "Stage all & commit"'s undo, review I1): only entries
            // still as `now` has them change, so what was staged since stays staged, and an entry
            // changed both ways refuses. `-i`: the worktree isn't compared or touched. P's
            // entries staged since were autostashed by `plan` (they'd be overwritten next).
            if let Some(b) = &entry.before {
                snapshot::check_restore(cx.root, b)?;
            }
            let inv = cx.git(["read-tree", "-m", "-i", now.as_str(), old.as_str()]);
            cx.run_git(inv).await?;
            cx.touch(ChangeKind::Index);
            let mut res = match &entry.before {
                Some(b) => snapshot::restore_index(&cx.snapshots(), b).await,
                None => Ok(()),
            };
            if res.is_ok() {
                res = move_head(cx, entry, moves, &now, &old, message).await;
            }
            if res.is_err() {
                let back = cx.git(["read-tree", "-m", "-i", old.as_str(), now.as_str()]);
                if let Err(e) = cx.run_git(back).await {
                    tracing::warn!(target: "gitbolt_core::write", "reading the index back after a failed reset undo: {e}");
                }
            }
            res
        }
        ResetMode::Hard => {
            // Rewind, then Restore `before`. The restore's read-only checks run first (review
            // M1); if the restore still fails after the move, the move and the rewind go back.
            if let Some(b) = &entry.before {
                snapshot::check_restore(cx.root, b)?;
            }
            crate::journal::undo::refresh_index(cx).await;
            let inv = cx.git(["read-tree", "-m", "-u", now.as_str(), old.as_str()]);
            cx.run_git(inv).await?;
            cx.touch(ChangeKind::Worktree);
            cx.touch(ChangeKind::Index);
            let mut moved = false;
            let mut res = move_head(cx, entry, moves, &now, &old, message).await;
            if res.is_ok() {
                moved = true;
                if let Some(b) = &entry.before {
                    res = snapshot::restore(&cx.snapshots(), b).await;
                }
            }
            if let Err(e) = res {
                if moved {
                    let back: Vec<RefMove> = moves.iter().map(|m| RefMove { name: m.name.clone(), old: m.new.clone(), new: m.old.clone() }).collect();
                    if let Err(b) = move_head(cx, entry, &back, &old, &now, message).await {
                        tracing::warn!(target: "gitbolt_core::write", "moving back after a failed reset undo: {b}");
                    }
                }
                crate::journal::undo::refresh_index(cx).await;
                let back = cx.git(["read-tree", "-m", "-u", old.as_str(), now.as_str()]);
                if let Err(b) = cx.run_git(back).await {
                    tracing::warn!(target: "gitbolt_core::write", "rewinding back after a failed reset undo: {b}");
                }
                return Err(e);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::state::RepoState;
    use crate::testing::write::{identity, open, send, wt, WriteEnv};
    use crate::testing::TestRepo;
    use serde_json::json;

    /// Three commits on main; HEAD~1 is the reset target.
    fn repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.write("a.txt", "a v1\n");
        r.write("b.txt", "b v1\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.write("a.txt", "a v2\n");
        r.git(&["commit", "-q", "-am", "two"]);
        r.write("b.txt", "b v3\n");
        r.git(&["commit", "-q", "-am", "three"]);
        r
    }

    fn reset(id: u32, r: &TestRepo, mode: &str, discard: bool) -> serde_json::Value {
        reset_to(id, r, mode, discard, "HEAD~1")
    }

    fn reset_to(id: u32, r: &TestRepo, mode: &str, discard: bool, rev: &str) -> serde_json::Value {
        let to = r.git(&["rev-parse", rev]);
        let head = r.git(&["rev-parse", "HEAD"]);
        json!({"method": "reset", "params": {"repo": id, "worktree": wt(r), "to": to, "mode": mode, "discard": discard, "expect": {"head": head}}})
    }

    async fn round_trip(api: &crate::api::Api, id: u32, r: &TestRepo, before: &RepoState, after: &RepoState) {
        let s = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(r), "entry": s["undo"]["entry"]}})).await.unwrap();
        assert_eq!(&RepoState::capture(r), before, "undo");
        let s = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(r), "entry": s["redo"]["entry"]}})).await.unwrap();
        assert_eq!(&RepoState::capture(r), after, "redo");
    }

    /// A staged change, an unstaged one and an untracked file: the split every mode must keep
    /// or bring back.
    fn dirty(r: &TestRepo) {
        r.write("a.txt", "a staged\n");
        r.git(&["add", "a.txt"]);
        r.write("b.txt", "b unstaged\n");
        r.write("u.txt", "untracked\n");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn soft_mixed_and_hard_round_trip_through_undo_and_redo() {
        for (mode, label) in [("soft", "(soft)"), ("mixed", "(mixed)"), ("hard", "(hard)")] {
            let env = WriteEnv::new();
            let r = repo();
            dirty(&r);
            let id = open(&env.api, &r).await;
            let before = RepoState::capture(&r);
            send(&env.api, reset(id, &r, mode, true)).await.unwrap();
            assert_eq!(r.git(&["rev-parse", "HEAD"]), r.git(&["rev-parse", "HEAD@{1}~1"]), "{mode}");
            let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
            assert!(s["undo"]["label"].as_str().unwrap().starts_with("reset main to ") && s["undo"]["label"].as_str().unwrap().ends_with(label));
            let after = RepoState::capture(&r);
            if mode == "hard" {
                assert_eq!(std::fs::read_to_string(r.path().join("u.txt")).unwrap(), "untracked\n", "hard leaves untracked files alone");
            }
            round_trip(&env.api, id, &r, &before, &after).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mixed_undo_brings_back_the_pre_reset_staged_split() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        let (cached, unstaged) = (r.git(&["diff", "--cached"]), r.git(&["diff"]));
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "mixed", false)).await.unwrap();
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap();
        assert_eq!((r.git(&["diff", "--cached"]), r.git(&["diff"])), (cached, unstaged));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn hard_over_changes_asks_first_and_soft_mixed_never_do() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, reset(id, &r, "hard", false)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::DirtyWorktree);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["detail"]["kind"], "resetDiscards");
        assert_eq!((v["detail"]["branch"].as_str(), v["detail"]["files"].as_u64()), (Some("main"), Some(2)), "a and b; the untracked file doesn't count");
        assert_eq!(e.message, format!("Reset main to {} and discard changes to 2 files? You can undo this.", r.git(&["rev-parse", "--short=7", "HEAD~1"])));
        assert_eq!(RepoState::capture(&r), before);
        for mode in ["soft", "mixed"] {
            let other = repo();
            dirty(&other);
            let oid = open(&env.api, &other).await;
            send(&env.api, reset(oid, &other, mode, false)).await.unwrap_or_else(|e| panic!("{mode} never asks: {e}"));
        }
        let clean = repo();
        let cid = open(&env.api, &clean).await;
        send(&env.api, reset(cid, &clean, "hard", false)).await.expect("a clean hard reset doesn't ask");
    }

    /// git's hard reset replaces an untracked file at a path the target has: it's counted,
    /// snapshotted, and back on undo.
    #[tokio::test(flavor = "multi_thread")]
    async fn hard_snapshots_an_untracked_file_it_overwrites() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["rm", "-q", "a.txt"]);
        r.git(&["commit", "-q", "-m", "drop a"]);
        r.write("a.txt", "mine\n");
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, reset(id, &r, "hard", false)).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["files"], 1);
        send(&env.api, reset(id, &r, "hard", true)).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a v2\n");
        let after = RepoState::capture(&r);
        round_trip(&env.api, id, &r, &before, &after).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_detached_reset_moves_head_and_undo_moves_it_back() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["switch", "-q", "--detach", "HEAD"]);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        send(&env.api, reset(id, &r, "soft", false)).await.unwrap();
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        assert!(s["undo"]["label"].as_str().unwrap().starts_with("reset HEAD to "));
        let after = RepoState::capture(&r);
        round_trip(&env.api, id, &r, &before, &after).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reset_during_a_merge_is_refused() {
        let env = WriteEnv::new();
        let r = repo();
        let head = r.git(&["rev-parse", "HEAD"]);
        std::fs::write(r.path().join(".git/MERGE_HEAD"), format!("{head}\n")).unwrap();
        let id = open(&env.api, &r).await;
        let e = send(&env.api, reset(id, &r, "mixed", false)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InProgress);
    }

    /// A redo on another branch would `git reset` that branch: refused, nothing changed.
    #[tokio::test(flavor = "multi_thread")]
    async fn redo_on_another_branch_is_refused() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "mixed", false)).await.unwrap();
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap();
        r.git(&["switch", "-q", "-c", "other"]);
        let before = RepoState::capture(&r);
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        let e = send(&env.api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(&r), "entry": s["redo"]["entry"]}})).await.unwrap_err();
        assert_eq!(e.message, "Check out main again to redo this reset");
        assert_eq!(RepoState::capture(&r), before);
    }

    // --- Review round 1 ---

    async fn undo_top(api: &crate::api::Api, id: u32, r: &TestRepo, confirm: bool) -> Result<serde_json::Value, crate::error::GbError> {
        let s = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(r), "entry": s["undo"]["entry"], "confirmAutostash": confirm}})).await
    }

    /// The one banner's kind and the stash count, after an undo whose autostash wasn't restored.
    async fn kept(api: &crate::api::Api, id: u32, r: &TestRepo) -> (String, usize) {
        let s = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        let banners = s["banners"].as_array().unwrap();
        assert_eq!(banners.len(), 1, "{s}");
        (banners[0]["kind"].as_str().unwrap().to_string(), r.git(&["stash", "list"]).lines().count())
    }

    fn files_asked(e: &crate::error::GbError) -> u64 {
        assert_eq!(e.kind, GbErrorKind::DirtyWorktree, "{e:?}");
        serde_json::to_value(e).unwrap()["detail"]["files"].as_u64().unwrap()
    }

    /// Two commits: `one` and then `two`, made by `second` (HEAD~1 is `one`, the target).
    fn two_commits<R>(first: &[(&str, &str)], second: impl FnOnce(&TestRepo) -> R) -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        for (p, c) in first {
            r.write(p, c);
        }
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        second(&r);
        r.git(&["commit", "-q", "-m", "two"]);
        r
    }

    /// A hard reset asks about `files` files on a tree that is otherwise clean, then round-trips
    /// every byte and mode through undo (where `undone` checks the restored worktree as well)
    /// and redo.
    async fn hard_round_trip(r: &TestRepo, files: u64, undone: impl Fn(&TestRepo)) {
        let env = WriteEnv::new();
        let id = open(&env.api, r).await;
        let before = RepoState::capture(r);
        let e = send(&env.api, reset(id, r, "hard", false)).await.unwrap_err();
        assert_eq!(files_asked(&e), files);
        assert_eq!(RepoState::capture(r), before, "asking changes nothing");
        send(&env.api, reset(id, r, "hard", true)).await.unwrap();
        let after = RepoState::capture(r);
        assert_ne!((&after.files, &after.modes), (&before.files, &before.modes), "the reset destroyed what the test protects");
        undo_top(&env.api, id, r, false).await.unwrap();
        assert_eq!(RepoState::capture(r), before, "undo");
        undone(r);
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(&env.api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(r), "entry": s["redo"]["entry"]}})).await.unwrap();
        assert_eq!(RepoState::capture(r), after, "redo");
    }

    fn read(r: &TestRepo, p: &str) -> String {
        std::fs::read_to_string(r.path().join(p)).unwrap()
    }

    /// C1 (a): an untracked directory, with an ignored file and a nested one, where the target
    /// has a file.
    #[tokio::test(flavor = "multi_thread")]
    async fn hard_asks_and_restores_a_directory_where_the_target_has_a_file() {
        let r = two_commits(&[("d", "d1\n"), ("x", "x\n")], |r| r.git(&["rm", "-q", "d"]));
        std::fs::write(r.path().join(".git/info/exclude"), "*.log\n").unwrap();
        r.write("d/inner.txt", "precious\n");
        r.write("d/sub/deep.txt", "deep\n");
        r.write("d/keep.log", "ignored\n");
        hard_round_trip(&r, 3, |r| assert_eq!((read(r, "d/inner.txt"), read(r, "d/sub/deep.txt"), read(r, "d/keep.log")), ("precious\n".into(), "deep\n".into(), "ignored\n".into()))).await;
    }

    /// C1 (b): an untracked file where the target has a directory.
    #[tokio::test(flavor = "multi_thread")]
    async fn hard_asks_and_restores_a_file_where_the_target_has_a_directory() {
        let r = two_commits(&[("e/f", "ef\n"), ("x", "x\n")], |r| r.git(&["rm", "-q", "-r", "e"]));
        r.write("e", "precious\n");
        hard_round_trip(&r, 1, |r| assert_eq!(read(r, "e"), "precious\n")).await;
    }

    /// C1 (c): a tracked file deleted and replaced by an untracked directory.
    #[tokio::test(flavor = "multi_thread")]
    async fn hard_asks_and_restores_a_directory_in_place_of_a_tracked_file() {
        let r = two_commits(&[("t", "t1\n"), ("x", "x\n")], |r| {
            r.write("x", "x2\n");
            r.git(&["add", "x"]);
        });
        std::fs::remove_file(r.path().join("t")).unwrap();
        r.write("t/inner", "precious\n");
        hard_round_trip(&r, 2, |r| assert_eq!(read(r, "t/inner"), "precious\n")).await;
    }

    /// I2: a `git rm --cached` file is one file, and undo brings back the staged deletion and
    /// the untracked file.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_staged_deletion_kept_on_disk_counts_once_and_comes_back_staged() {
        let r = repo();
        r.git(&["rm", "-q", "--cached", "b.txt"]);
        let status = r.git(&["status", "--porcelain"]);
        assert_eq!(status, "D  b.txt\n?? b.txt");
        hard_round_trip(&r, 1, |r| assert_eq!(r.git(&["status", "--porcelain"]), status)).await;
    }

    /// An ignored file at a path the target has is asked about and restored; one elsewhere is
    /// neither counted nor touched.
    #[tokio::test(flavor = "multi_thread")]
    async fn hard_asks_and_restores_an_ignored_file_it_overwrites() {
        let r = two_commits(&[("build.log", "committed\n"), ("x", "x\n")], |r| r.git(&["rm", "-q", "build.log"]));
        std::fs::write(r.path().join(".git/info/exclude"), "*.log\n").unwrap();
        r.write("build.log", "local build\n");
        r.write("other.log", "untouched\n");
        hard_round_trip(&r, 1, |r| assert_eq!(read(r, "build.log"), "local build\n")).await;
        assert_eq!(read(&r, "other.log"), "untouched\n");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn hard_undo_brings_back_an_exec_bit_change() {
        use std::os::unix::fs::PermissionsExt;
        let r = repo();
        // `chmod +x`, as the umask left it (git checks files out the same way).
        let mode = std::fs::metadata(r.path().join("a.txt")).unwrap().permissions().mode();
        std::fs::set_permissions(r.path().join("a.txt"), std::fs::Permissions::from_mode(mode | 0o111)).unwrap();
        hard_round_trip(&r, 1, |r| assert_eq!(std::fs::metadata(r.path().join("a.txt")).unwrap().permissions().mode() & 0o111, 0o111)).await;
    }

    /// I1: what was staged after a mixed reset, outside P, stays staged through its undo.
    #[tokio::test(flavor = "multi_thread")]
    async fn mixed_undo_keeps_what_was_staged_since_the_reset() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        let status = r.git(&["status", "--porcelain"]);
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "mixed", false)).await.unwrap();
        r.write("n.txt", "new\n");
        r.git(&["add", "n.txt"]);
        undo_top(&env.api, id, &r, false).await.unwrap();
        assert_eq!(status, "M  a.txt\n M b.txt\n?? u.txt");
        assert_eq!(r.git(&["status", "--porcelain"]), "M  a.txt\n M b.txt\nA  n.txt\n?? u.txt");
    }

    /// I1: a path of P staged since the reset would lose that staging: undo asks first, and
    /// when confirmed autostashes it, so nothing is lost.
    #[tokio::test(flavor = "multi_thread")]
    async fn mixed_undo_asks_before_overwriting_a_path_staged_since() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        let id = open(&env.api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        send(&env.api, reset(id, &r, "mixed", false)).await.unwrap();
        r.write("b.txt", "b staged since\n");
        r.git(&["add", "b.txt"]);
        let shown = RepoState::capture(&r);
        let e = undo_top(&env.api, id, &r, false).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Conflict, "{e:?}");
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        undo_top(&env.api, id, &r, true).await.unwrap();
        // `apply --index` refuses ("conflicts in index"): the stash is kept, with the staging.
        assert_eq!(kept(&env.api, id, &r).await, ("autostashRefused".to_string(), 1));
        assert_eq!(r.git(&["show", "stash@{0}^2:b.txt"]), "b staged since");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
    }

    /// An edit after a hard reset: undo asks first; confirmed, the edit survives.
    #[tokio::test(flavor = "multi_thread")]
    async fn hard_undo_asks_about_an_edit_since_and_keeps_it() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        send(&env.api, reset(id, &r, "hard", true)).await.unwrap();
        r.write("b.txt", "edited since\n");
        let shown = RepoState::capture(&r);
        let e = undo_top(&env.api, id, &r, false).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Conflict, "{e:?}");
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        undo_top(&env.api, id, &r, true).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD"]), before.head.split(' ').nth(1).unwrap());
        assert_eq!(kept(&env.api, id, &r).await, ("autostashRefused".to_string(), 1));
        assert_eq!(r.git(&["show", "stash@{0}:b.txt"]), "edited since");
    }

    // --- Review round 2 ---

    /// A repository to clone from, with one commit.
    fn upstream() -> TestRepo {
        let s = TestRepo::new();
        identity(&s);
        s.write("s.txt", "s\n");
        s.git(&["add", "."]);
        s.git(&["commit", "-q", "-m", "s"]);
        s
    }

    /// `git clone` of `from` at `at`, with an identity and a local-only commit.
    fn embed(r: &TestRepo, from: &TestRepo, at: &str) {
        r.git(&["clone", "-q", &from.path().display().to_string(), at]);
        let sm = r.path().join(at);
        for args in [&["config", "user.name", "Ada Lovelace"][..], &["config", "user.email", "ada@example.com"]] {
            r.git_in(&sm, args);
        }
        std::fs::write(sm.join("local.txt"), "local\n").unwrap();
        r.git_in(&sm, &["add", "local.txt"]);
        r.git_in(&sm, &["commit", "-q", "-m", "local-only"]);
    }

    /// C2: a clean embedded repository (a gitlink in the index) where the target has a file:
    /// git would delete it whole, `.git` and a local-only commit included. Refused, discard or
    /// not, with nothing changed and no "You can undo this".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_reset_never_deletes_an_embedded_repository() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n")], |r| {
            r.write("sm", "sm\n");
            r.git(&["add", "sm"]);
        });
        r.git(&["rm", "-q", "sm"]);
        r.git(&["commit", "-q", "-m", "rm"]);
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "embedded"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        for discard in [false, true] {
            let e = send(&env.api, reset_to(id, &r, "hard", discard, "HEAD~2")).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "sm is a repository in the way of the reset: move it first"));
        }
        assert_eq!(RepoState::capture(&r), before);
        assert!(r.path().join("sm/.git").is_dir());
    }

    /// C2: a submodule under a directory the target has as a file goes with it: refused too.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_reset_never_deletes_a_submodule_under_a_replaced_directory() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n"), ("lib", "lib\n")], |r| {
            r.git(&["rm", "-q", "lib"]);
        });
        embed(&r, &sub, "lib/sm");
        r.git(&["add", "lib/sm"]);
        r.git(&["commit", "-q", "-m", "submodule"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let e = send(&env.api, reset_to(id, &r, "hard", true, "HEAD~2")).await.unwrap_err();
        assert_eq!(e.message, "lib/sm is a repository in the way of the reset: move it first");
        assert!(r.path().join("lib/sm/.git").is_dir());
    }

    /// M6: the target adds a gitlink where an untracked clone sits: git only makes the
    /// directory, so nothing is asked or refused, and the clone's files stay.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_target_gitlink_over_an_untracked_clone_is_not_refused() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n")], |r| {
            embed(r, &sub, "sm");
            r.git(&["add", "sm"]);
        });
        r.git(&["rm", "-q", "--cached", "sm"]);
        r.git(&["commit", "-q", "-m", "rm-sub"]);
        std::fs::write(r.path().join("sm/mine.txt"), "mine\n").unwrap();
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", false)).await.expect("no question, no refusal");
        assert_eq!(read(&r, "sm/mine.txt"), "mine\n");
        // The submodule is dirty now (its untracked file): undo asks, then keeps the clone.
        undo_top(&env.api, id, &r, true).await.unwrap();
        assert_eq!(read(&r, "sm/mine.txt"), "mine\n");
        assert!(r.path().join("sm/.git").is_dir());
    }

    /// I3: splitting a commit from a clean tree: mixed reset, then a file the reset commit
    /// changed is staged again. Undo asks first (no raw "would be overwritten"); confirmed, it
    /// autostashes and goes back, losing nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn mixed_undo_after_restaging_a_file_of_the_reset_commit_asks_first() {
        let r = two_commits(&[("c.txt", "a\nb\n"), ("x", "x\n")], |r| {
            r.write("c.txt", "a\nb\nc\n");
            r.write("y", "y\n");
            r.git(&["add", "."]);
        });
        let head = r.git(&["rev-parse", "HEAD"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "mixed", false)).await.unwrap();
        r.write("c.txt", "a\nb\nSTAGED\n");
        r.git(&["add", "c.txt"]);
        r.write("c.txt", "a\nb\nc\n");
        r.git(&["add", "y"]);
        let shown = RepoState::capture(&r);
        let e = undo_top(&env.api, id, &r, false).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Conflict, "{e:?}");
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["kind"], "autostashConflict");
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        undo_top(&env.api, id, &r, true).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        // `apply --index` refuses ("conflicts in index"): the stash is kept, with the staging.
        assert_eq!(kept(&env.api, id, &r).await, ("autostashRefused".to_string(), 1));
        assert_eq!(r.git(&["show", "stash@{0}^2:c.txt"]), "a\nb\nSTAGED");
    }

    /// M7: a hard undo whose restore fails after the move puts the ref and the rewind back:
    /// the repository is as the reset left it, and the entry can still be undone.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_undo_whose_restore_fails_rolls_back() {
        use std::os::unix::fs::PermissionsExt;
        let r = two_commits(&[("dir/f.txt", "f1\n"), ("a.txt", "a1\n")], |r| {
            r.write("a.txt", "a2\n");
            r.git(&["add", "a.txt"]);
        });
        r.write("dir/f.txt", "f dirty\n");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", true)).await.unwrap();
        let after = RepoState::capture(&r);
        // The restore writes dir/f.txt back; a read-only dir makes it fail after the CAS.
        let dir = r.path().join("dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::write(dir.join("probe"), "").is_ok();
        let res = if writable { None } else { Some(undo_top(&env.api, id, &r, false).await) };
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let Some(res) = res else {
            // Running as root: permissions don't stop the restore; nothing to test here.
            return;
        };
        assert!(res.is_err(), "{res:?}");
        assert_eq!(RepoState::capture(&r), after, "the move and the rewind went back");
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        assert!(s["undo"]["label"].as_str().unwrap().starts_with("reset main to "), "{s}");
        undo_top(&env.api, id, &r, false).await.unwrap();
        assert_eq!(read(&r, "dir/f.txt"), "f dirty\n");
    }

    // --- Review round 3 ---

    fn rm_rf(r: &TestRepo, p: &str) {
        std::fs::remove_dir_all(r.path().join(p)).unwrap();
    }

    /// `one` has the file `sm`; `two` (HEAD~1) has a gitlink there instead; `three` (HEAD) the
    /// file again. The worktree is clean at HEAD.
    fn file_gitlink_file(sub: &TestRepo) -> TestRepo {
        let r = two_commits(&[("x", "x\n")], |r| {
            embed(r, sub, "sm");
            r.git(&["add", "sm"]);
        });
        r.git(&["rm", "-q", "--cached", "sm"]);
        rm_rf(&r, "sm");
        r.write("sm", "file\n");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "file"]);
        r
    }

    /// C3: the hard reset's undo would rewind `sm` from a gitlink to a file, deleting the clone
    /// put there since (and its local-only commit): refused, nothing changed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_undo_never_deletes_a_repository_put_in_place_of_a_file() {
        let sub = upstream();
        let r = file_gitlink_file(&sub);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", false)).await.unwrap();
        std::fs::remove_dir(r.path().join("sm")).unwrap();
        embed(&r, &sub, "sm");
        let shown = RepoState::capture(&r);
        for confirm in [false, true] {
            let e = undo_top(&env.api, id, &r, confirm).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "sm is a repository in the way of the undo: move it first"));
        }
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
    }

    /// M8: an unpopulated gitlink (an empty directory) is no repository: the undo puts the file
    /// back over it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_undo_over_an_unpopulated_gitlink_goes_through() {
        let sub = upstream();
        let r = file_gitlink_file(&sub);
        let before = RepoState::capture(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", false)).await.unwrap();
        assert!(r.path().join("sm").is_dir(), "git made the gitlink's empty directory");
        undo_top(&env.api, id, &r, false).await.unwrap();
        assert_eq!(RepoState::capture(&r), before);
    }

    /// M8: forward, an unpopulated submodule where the target has a file isn't refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_reset_over_an_unpopulated_gitlink_goes_through() {
        let sub = upstream();
        let link = format!("160000,{},sm", sub.git(&["rev-parse", "HEAD"]));
        let r = two_commits(&[("x", "x\n"), ("sm", "f\n")], |r| {
            r.git(&["rm", "-q", "sm"]);
            r.git(&["update-index", "--add", "--cacheinfo", &link]);
            std::fs::create_dir(r.path().join("sm")).unwrap();
        });
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", false)).await.expect("no question, no refusal");
        assert_eq!(read(&r, "sm"), "f\n");
    }

    /// C3, Switch: undoing a checkout onto the branch with the file `sm` would delete the clone
    /// put at the gitlink since: refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_switch_undo_never_deletes_a_repository() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n")], |r| {
            r.git(&["switch", "-q", "-c", "a"]);
            r.write("sm", "file\n");
            r.git(&["add", "sm"]);
        });
        r.git(&["switch", "-q", "-c", "b", "main"]);
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "gitlink"]);
        rm_rf(&r, "sm");
        r.git(&["switch", "-q", "-f", "a"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, json!({"method": "checkout", "params": {"repo": id, "worktree": wt(&r), "target": {"kind": "branch", "name": "b"}}})).await.unwrap();
        std::fs::remove_dir(r.path().join("sm")).unwrap();
        embed(&r, &sub, "sm");
        let shown = RepoState::capture(&r);
        let e = undo_top(&env.api, id, &r, true).await.unwrap_err();
        assert_eq!(e.message, "sm is a repository in the way of the undo: move it first");
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
    }

    /// C3, Rewind: undoing a fast-forward that turned the file `sm` into a gitlink, with a clone
    /// there since: refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_rewind_undo_never_deletes_a_repository() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n"), ("sm", "file\n")], |r| {
            r.git(&["switch", "-q", "-c", "g"]);
            r.git(&["rm", "-q", "--cached", "sm"]);
            std::fs::remove_file(r.path().join("sm")).unwrap();
            embed(r, &sub, "sm");
            r.git(&["add", "sm"]);
        });
        rm_rf(&r, "sm");
        r.git(&["switch", "-q", "-f", "main"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let intent: crate::write::test_intents::TestIntent = serde_json::from_value(json!({"op": "fastForward", "target": "g"})).unwrap();
        crate::write::test_intents::run(&env.api, id, &wt(&r), Default::default(), intent).await.unwrap();
        assert!(r.path().join("sm").is_dir());
        std::fs::remove_dir(r.path().join("sm")).unwrap();
        embed(&r, &sub, "sm");
        let shown = RepoState::capture(&r);
        let e = undo_top(&env.api, id, &r, true).await.unwrap_err();
        assert_eq!(e.message, "sm is a repository in the way of the undo: move it first");
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
    }

    // --- Review round 4 (repo-safety) ---

    /// C4 (R1): HEAD and the target hold the same blob `sm`; the index has a staged clone there.
    /// `reset --hard` works from the index and would delete it: refused, discard or not.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_reset_never_deletes_a_staged_clone_where_the_trees_agree() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n"), ("sm", "f\n")], |r| {
            r.write("y", "y\n");
            r.git(&["add", "y"]);
        });
        r.git(&["rm", "-q", "--cached", "sm"]);
        std::fs::remove_file(r.path().join("sm")).unwrap();
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        assert_eq!(r.git(&["diff", "--name-only", "HEAD", "HEAD~1"]), "y", "sm isn't in the tree diff");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        for discard in [false, true] {
            let e = send(&env.api, reset(id, &r, "hard", discard)).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "sm is a repository in the way of the reset: move it first"));
        }
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
    }

    /// C4 (R1b): the same, nested: both trees hold the blob `lib`; the index has a staged clone
    /// at `lib/sm`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_reset_never_deletes_a_staged_clone_under_an_unchanged_file() {
        let sub = upstream();
        let r = two_commits(&[("x", "x\n"), ("lib", "f\n")], |r| {
            r.write("y", "y\n");
            r.git(&["add", "y"]);
        });
        r.git(&["rm", "-q", "--cached", "lib"]);
        std::fs::remove_file(r.path().join("lib")).unwrap();
        embed(&r, &sub, "lib/sm");
        r.git(&["add", "lib/sm"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, reset(id, &r, "hard", true)).await.unwrap_err();
        assert_eq!(e.message, "lib/sm is a repository in the way of the reset: move it first");
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("lib/sm/.git").is_dir());
    }

    /// C5's repository: `one` has `vendor/x`, HEAD doesn't; an untracked file `vendor` is
    /// snapshotted by the reset, which makes `vendor/`. A clone made at `vendor/lib` since would
    /// go with the directory when the undo's restore writes the file back: refused, nothing
    /// changed.
    fn vendor_repo() -> TestRepo {
        let r = two_commits(&[("x", "x\n"), ("vendor/x", "vx\n")], |r| r.git(&["rm", "-q", "vendor/x"]));
        r.write("vendor", "untracked\n");
        r
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_undo_never_deletes_a_repository_cloned_into_a_restored_files_directory() {
        let sub = upstream();
        let r = vendor_repo();
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", true)).await.unwrap();
        assert_eq!(read(&r, "vendor/x"), "vx\n");
        embed(&r, &sub, "vendor/lib");
        let shown = RepoState::capture(&r);
        for confirm in [false, true] {
            let e = undo_top(&env.api, id, &r, confirm).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "vendor/lib is a repository in the way of the undo: move it first"));
        }
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("vendor/lib/.git").is_dir());
    }

    /// C5's untracked files: a plain file made in that directory since is asked about, then
    /// autostashed; the snapshot's file comes back and the stash keeps the new one.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hard_undo_asks_before_deleting_untracked_files_in_a_restored_files_directory() {
        let r = vendor_repo();
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, reset(id, &r, "hard", true)).await.unwrap();
        r.write("vendor/notes.txt", "precious\n");
        let shown = RepoState::capture(&r);
        let e = undo_top(&env.api, id, &r, false).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Conflict, "{e:?}");
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["paths"], json!(["vendor/notes.txt"]));
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        undo_top(&env.api, id, &r, true).await.unwrap();
        assert_eq!(read(&r, "vendor"), "untracked\n", "the snapshot is back");
        assert_eq!(kept(&env.api, id, &r).await.1, 1);
        assert_eq!(r.git(&["show", "stash@{0}^3:vendor/notes.txt"]), "precious");
    }

    /// Safety review I3: with the user's `submodule.recurse=true`, git's `reset --hard` and
    /// `restore` would run inside the submodule too and discard its uncommitted work, which the
    /// snapshot (a gitlink) can't bring back. GitBolt's writes never recurse.
    #[tokio::test(flavor = "multi_thread")]
    async fn with_submodule_recurse_a_hard_reset_and_discard_all_leave_the_submodules_work_alone() {
        let sub = upstream();
        let r = TestRepo::new();
        identity(&r);
        r.write("x", "x\n");
        r.git(&["add", "x"]);
        r.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", &sub.path().display().to_string(), "sm"]);
        r.git(&["commit", "-q", "-m", "one"]);
        let sm = r.path().join("sm");
        for args in [&["config", "user.name", "Ada Lovelace"][..], &["config", "user.email", "ada@example.com"]] {
            r.git_in(&sm, args);
        }
        std::fs::write(sm.join("s.txt"), "s2\n").unwrap();
        r.git_in(&sm, &["commit", "-q", "-am", "s2"]);
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "two"]);
        r.git(&["config", "submodule.recurse", "true"]);
        std::fs::write(sm.join("s.txt"), "WIP in submodule\n").unwrap();
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        // S3a: the reset moves the submodule's commit.
        send(&env.api, reset(id, &r, "hard", true)).await.unwrap();
        assert_eq!(read(&r, "sm/s.txt"), "WIP in submodule\n", "the hard reset didn't recurse");
        // S3e: Discard all beside a dirty submodule.
        r.write("x", "x edited\n");
        send(&env.api, json!({"method": "discard", "params": {"repo": id, "worktree": wt(&r), "scope": {"kind": "all"}}})).await.unwrap();
        assert_eq!(read(&r, "x"), "x\n");
        assert_eq!(read(&r, "sm/s.txt"), "WIP in submodule\n", "Discard all didn't recurse");
    }
}
