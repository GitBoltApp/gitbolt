//! Stashes (spec #2 §10). Identity is the stash commit's oid, never a list position:
//! `stash@{n}` is found by oid in `git stash list` (a read) under the lock, just before each
//! command, and checked again (`rev-parse`) so a stack that shifted is never acted on blindly.
//! - Push: `git stash push --include-untracked -m <message>`; journaled (undo applies it with
//!   `--index` and drops it; redo pushes again and records the new oid).
//! - Apply: `git stash apply --index <oid>` (or without `--index` once confirmed); not journaled.
//! - Pop: snapshot `before`, apply, and drop on a clean apply; journaled (undo restores
//!   `before` and stores the stash back; redo pops again). A conflicting pop keeps the stash,
//!   as git's own does.
//! - Drop: journaled (undo `git stash store -m <subject> <oid>`; redo drops again).

use crate::api::{blocking, Api};
use crate::error::{gix_err, ErrorDetail, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::{GitCli, GitInvocation};
use crate::journal::{snapshot, JournalEntry, StashMove, UndoKind};
use crate::write::types::WriteResult;
use crate::write::{precheck, run_write, Plan, Pre, WriteCx, WriteIntent};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

/// `On main: Fix x` → `Fix x`; `WIP on main: 1a2b3c4 x` → `1a2b3c4 x` (Deviation 8).
pub(crate) fn user_message(subject: &str) -> &str {
    for prefix in ["On ", "WIP on "] {
        if let Some(rest) = subject.strip_prefix(prefix)
            && let Some((_, msg)) = rest.split_once(": ")
        {
            return msg;
        }
    }
    subject
}

fn gone() -> GbError {
    GbError::new(GbErrorKind::NotFound, "That stash is gone")
}

/// `(oid, reflog subject)` of every stash, newest first (a read).
pub(crate) async fn stash_list(cli: &GitCli, root: &Path) -> Result<Vec<(String, String)>, GbError> {
    let out = cli.run(GitInvocation::new(root, ["stash", "list", "--format=%H%x00%gs"])).await?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.split_once('\0').map(|(o, s)| (o.to_string(), s.to_string()))).collect())
}

/// The subject of the stash `oid` (its newest listing), or "That stash is gone".
async fn subject_of(cli: &GitCli, root: &Path, oid: &str) -> Result<String, GbError> {
    stash_list(cli, root).await?.into_iter().find(|(o, _)| o == oid).map(|(_, s)| s).ok_or_else(gone)
}

/// What `stash@{n}` is now (a read).
async fn at(cli: &GitCli, root: &Path, n: usize) -> Option<String> {
    let at = format!("stash@{{{n}}}");
    let out = cli.run(GitInvocation::new(root, ["rev-parse", "--verify", "-q", at.as_str()])).await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git stash drop stash@{n}`, once `stash@{n}` is checked to be `oid` just before. git's
/// `Dropped stash@{n} (<oid>)` is checked after (review M1): another process's stash dropped
/// in between is stored back at once, and the drop refused. `cancellable: false`: the op's
/// Cancel can't stop it midway (the multi-line push's drop/store pair).
pub(crate) async fn drop_at(cx: &mut WriteCx<'_>, n: usize, oid: &str, cancellable: bool) -> Result<(), GbError> {
    if at(&cx.api.cli, cx.root, n).await.as_deref() != Some(oid) {
        return Err(GbError::stale("The stash list changed; nothing was dropped"));
    }
    let at = format!("stash@{{{n}}}");
    let args = ["stash", "drop", at.as_str()];
    let inv = if cancellable { cx.git(args) } else { cx.git_stash(args) };
    let out = cx.run_git(inv).await?;
    cx.touch(ChangeKind::Stash);
    match dropped_oid(&String::from_utf8_lossy(&out.stdout)) {
        Some(other) if other != oid => {
            // Its reflog line is gone with it: the commit's subject is the same line (`On x: …`).
            let subject = cx.api.cli.run(GitInvocation::new(cx.root, ["show", "-s", "--format=%s", other.as_str()])).await.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
            let inv = cx.git_stash(["stash", "store", "-m", subject.as_str(), other.as_str()]);
            if let Err(e) = cx.run_git(inv).await {
                tracing::warn!(target: "gitbolt_core::write", "storing back the stash {other} dropped by mistake: {e}");
            }
            Err(GbError::stale("The stash list changed; nothing was dropped"))
        }
        _ => Ok(()),
    }
}

/// `Dropped refs/stash@{0} (1a2b…)` → `1a2b…`.
fn dropped_oid(printed: &str) -> Option<String> {
    printed.lines().find(|l| l.starts_with("Dropped "))?.rsplit_once('(')?.1.split_once(')').map(|(o, _)| o.trim().to_string())
}

/// `git stash drop stash@{n}`, `n` found by oid and checked again just before.
pub(crate) async fn drop_oid(cx: &mut WriteCx<'_>, oid: &str) -> Result<(), GbError> {
    let n = stash_list(&cx.api.cli, cx.root).await?.iter().position(|(o, _)| o == oid).ok_or_else(gone)?;
    drop_at(cx, n, oid, true).await
}

/// A stash the user popped or dropped: a kept record for it (an autostash's banner, §6.4) would
/// now offer Apply of a stash that's gone (2C final I1), so it goes too. Best effort: the
/// banner is also hidden at read time while its stash isn't listed (`Api::journal_state`).
fn forget_kept(cx: &mut WriteCx<'_>, oid: &str) {
    match cx.api.journal(cx.root).and_then(|s| s.update(|j| j.forget_kept_stash(oid))) {
        Ok(gone) => cx.journal_changed |= gone,
        Err(e) => tracing::warn!(target: "gitbolt_core::write", "clearing the kept record of stash {oid}: {e}"),
    }
}

/// After a failed drop: the move recorded ahead goes when the stash is still listed (nothing
/// was dropped). `true`: it went.
async fn unrecord_if_listed(cx: &mut WriteCx<'_>, oid: &str) -> bool {
    if subject_of(&cx.api.cli, cx.root, oid).await.is_err() {
        return false;
    }
    if let Err(e) = cx.edit_entry(|e| e.stashes.retain(|m| m.oid != oid)) {
        tracing::warn!(target: "gitbolt_core::write", "unrecording the stash {oid}: {e}");
    }
    true
}

/// NUL-separated names from a read.
async fn names(cli: &GitCli, root: &Path, args: &[&str]) -> Result<Vec<String>, GbError> {
    let out = cli.run(GitInvocation::new(root, args.iter().copied())).await?;
    Ok(out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
}

// --- 2C repo-safety ---
/// Safety review C1: a whole-worktree `stash push -u` (the Stash button, the redo of one) is
/// refused where HEAD's file would be written over a repository (`precheck::stash_push_in_the_way`).
pub(crate) async fn refuse_stash_push_in_the_way(pre: &Pre<'_>, what: &str) -> Result<(), GbError> {
    let tracked = precheck::dirty(&pre.api.cli, pre.root).await?.tracked;
    match Box::pin(precheck::stash_push_in_the_way(&pre.api.cli, pre.root, &tracked, None)).await?.first() {
        Some(p) => Err(precheck::repository_in_the_way(p, what)),
        None => Ok(()),
    }
}

/// Safety review C2: an apply of `oid` (apply, pop, the undo of a push, the redo of a pop, a
/// kept stash's Apply) is refused where a file of the stash would be written over a repository
/// (`precheck::stash_apply_in_the_way`).
pub(crate) async fn refuse_stash_apply_in_the_way(pre: &Pre<'_>, oid: &str, what: &str) -> Result<(), GbError> {
    match Box::pin(precheck::stash_apply_in_the_way(&pre.api.cli, pre.root, oid)).await?.first() {
        Some(p) => Err(precheck::repository_in_the_way(p, what)),
        None => Ok(()),
    }
}
// --- end 2C repo-safety ---

/// The paths a stash's apply writes: its worktree and index changes, and its untracked files.
async fn stash_paths(cli: &GitCli, root: &Path, oid: &str) -> Result<Vec<String>, GbError> {
    let (base, index, third) = (format!("{oid}^1"), format!("{oid}^2"), format!("{oid}^3"));
    let mut paths = names(cli, root, &["diff", "--no-renames", "--name-only", "-z", &base, oid]).await?;
    paths.extend(names(cli, root, &["diff", "--no-renames", "--name-only", "-z", &base, &index]).await?);
    // `-q`: a stash without untracked files has no third parent.
    if cli.run(GitInvocation::new(root, ["rev-parse", "--verify", "-q", third.as_str()])).await.is_ok() {
        paths.extend(names(cli, root, &["ls-tree", "-r", "-z", "--name-only", &third]).await?);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum StashPushOutcome {
    Stashed { oid: String },
    /// git found nothing to stash: no entry, no stash; the toast says so.
    NothingToStash,
}

pub(crate) struct StashPush {
    /// The whole WIP draft, or `WIP on <branch>` (`(no branch)`) when it was empty.
    pub message: String,
}

impl StashPush {
    /// Fills the empty message from HEAD (spec §10), read before the run.
    pub(crate) fn new(message: String, branch: Option<&str>) -> Self {
        let message = if message.trim().is_empty() { format!("WIP on {}", branch.unwrap_or("(no branch)")) } else { message };
        Self { message }
    }
}

/// `git stash push --include-untracked -m <message>`: the new stash's `(oid, subject)`, or
/// `None` when git found nothing to stash. The caller records it before `relist` (review I1).
async fn push(cx: &mut WriteCx<'_>, message: &str) -> Result<Option<(String, String)>, GbError> {
    let before = crate::journal::autostash::stash_oid(cx.api, cx.root).await?;
    let inv = cx.git(["stash", "push", "--include-untracked", "-m", message]);
    cx.run_git(inv).await?;
    let after = crate::journal::autostash::stash_oid(cx.api, cx.root).await?;
    if after == before {
        return Ok(None);
    }
    cx.partial = true;
    for k in [ChangeKind::Stash, ChangeKind::Worktree, ChangeKind::Index] {
        cx.touch(k);
    }
    let oid = after.ok_or_else(|| GbError::other("the stash wasn't recorded"))?;
    let subject = subject_of(&cx.api.cli, cx.root, &oid).await?;
    Ok(Some((oid, subject)))
}

/// git folds a multi-line `-m` into one reflog line (`On main: Fix x the details`); the list
/// shows the summary only, so the stash is stored again under `On main: Fix x` and the folded
/// line dropped. The stash commit keeps the whole message. Returns its subject now.
///
/// A store of the oid already on top logs nothing, so it's a drop, then a store, neither
/// cancellable. A pending kept-stash record covers the gap between them: a crash raises its
/// Recovery banner, and so does a store that fails. The push succeeded whatever happens here:
/// when the stash isn't on top any more (another process pushed) or the drop is refused, the
/// folded line stays.
async fn relist(cx: &mut WriteCx<'_>, oid: &str, subject: &str, message: &str, label: &str) -> String {
    let summary = message.lines().next().unwrap_or_default().trim();
    let want = format!("{}{summary}", &subject[..subject.len() - user_message(subject).len()]);
    if !message.trim_end().contains('\n') || want == subject {
        return subject.to_string();
    }
    match stash_list(&cx.api.cli, cx.root).await {
        Ok(list) if list.first().is_some_and(|(o, _)| o == oid) => {}
        _ => return subject.to_string(),
    }
    let guard = match guard(cx, oid, summary, label) {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "the stash {oid} keeps its folded line: {e}");
            return subject.to_string();
        }
    };
    if let Err(e) = drop_at(cx, 0, oid, false).await {
        let listed = subject_of(&cx.api.cli, cx.root, oid).await;
        settle_guard(cx, guard, listed.is_ok());
        tracing::warn!(target: "gitbolt_core::write", "the stash {oid} keeps its folded line: {e}");
        return listed.unwrap_or_else(|_| subject.to_string());
    }
    let inv = cx.git_stash(["stash", "store", "-m", want.as_str(), oid]);
    let stored = cx.run_git(inv).await;
    cx.touch(ChangeKind::Stash);
    if let Err(e) = &stored {
        tracing::warn!(target: "gitbolt_core::write", "the stash {oid} couldn't be listed again: {e}");
    }
    let listed = subject_of(&cx.api.cli, cx.root, oid).await;
    settle_guard(cx, guard, listed.is_ok());
    listed.unwrap_or_else(|_| subject.to_string())
}

/// A `Pending` kept-stash record for `oid`, owned by this instance (no banner while it runs).
fn guard(cx: &mut WriteCx<'_>, oid: &str, message: &str, label: &str) -> Result<u64, GbError> {
    let owner = cx.api.owner()?;
    let k = crate::journal::KeptStash {
        id: 0,
        oid: Some(oid.to_string()),
        stash_before: None,
        message: message.to_string(),
        label: label.to_string(),
        target: None,
        reason: crate::journal::KeptReason::Pending,
        created_ms: cx.api.now(),
        owner: Some(owner),
    };
    cx.api.journal(cx.root)?.update(|j| j.keep(k))
}

/// The guard goes when the stash is listed again; otherwise its Recovery banner shows now.
fn settle_guard(cx: &mut WriteCx<'_>, id: u64, listed: bool) {
    let res = cx.api.journal(cx.root).and_then(|s| {
        s.update(|j| {
            if listed {
                j.kept.retain(|k| k.id != id);
            } else if let Some(k) = j.kept_mut(id) {
                k.reason = crate::journal::KeptReason::Interrupted;
                k.owner = None;
            }
        })
    });
    if let Err(e) = res {
        tracing::warn!(target: "gitbolt_core::write", "the stash record {id}: {e}");
    }
    cx.journal_changed = true;
}

impl WriteIntent for StashPush {
    type Outcome = StashPushOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Stash
    }
    fn label(&self) -> String {
        format!("stash \"{}\"", self.message.lines().next().unwrap_or_default().trim())
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Stash)
    }
    // --- 2C repo-safety ---
    /// `stash push -u` ends in a `reset --hard` that writes HEAD's file over a directory in its
    /// place, deleting a repository in it whole (safety review C1): refused first.
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        refuse_stash_push_in_the_way(pre, "stash").await?;
        Ok(Plan::default())
    }
    // --- end 2C repo-safety ---
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<StashPushOutcome, GbError> {
        let Some((oid, subject)) = push(cx, &self.message).await? else { return Ok(StashPushOutcome::NothingToStash) };
        // Written ahead of the relist's drop (review I1).
        cx.record_stash(StashMove { oid: oid.clone(), message: subject.clone(), created: true, without_index: false })?;
        let now = relist(cx, &oid, &subject, &self.message, &self.label()).await;
        if now != subject {
            cx.edit_entry(|e| {
                if let Some(m) = e.stashes.iter_mut().find(|m| m.oid == oid) {
                    m.message = now;
                }
            })?;
        }
        Ok(StashPushOutcome::Stashed { oid })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum StashApplyOutcome {
    Applied,
    /// The files land in Conflicted; the stash is kept.
    Conflicts { files: u32 },
}

/// `git stash apply [--index] <oid>`; `Ok(None)` on a clean apply, `Ok(Some(files))` with
/// content conflicts; git refusing the index is `ApplyWithoutIndex` (nothing changed).
async fn apply(cx: &mut WriteCx<'_>, oid: &str, with_index: bool) -> Result<Option<u32>, GbError> {
    // git prints a merge's CONFLICT lines on stdout, which a failure doesn't keep: conflicts are
    // the unmerged paths the apply added.
    let unmerged_before = precheck::dirty(&cx.api.cli, cx.root).await?.conflicted;
    let mut args = vec!["stash", "apply"];
    if with_index {
        args.push("--index");
    }
    args.push(oid);
    let inv = cx.git(args);
    let res = cx.run_git(inv).await;
    cx.touch(ChangeKind::Worktree);
    cx.touch(ChangeKind::Index);
    let e = match res {
        Ok(_) => {
            cx.partial = true;
            return Ok(None);
        }
        Err(e) => e,
    };
    let stderr = e.stderr.as_deref().unwrap_or_default();
    if with_index && (stderr.contains("Conflicts in index") || stderr.contains("without --index")) {
        return Err(GbError::new(GbErrorKind::Conflict, "git couldn't restore what was staged").with_detail(ErrorDetail::ApplyWithoutIndex));
    }
    // From here the apply may have written some of it.
    cx.partial = true;
    let now = precheck::dirty(&cx.api.cli, cx.root).await?.conflicted;
    if now > unmerged_before { Ok(Some(now - unmerged_before)) } else { Err(e) }
}

pub(crate) struct StashApply {
    pub oid: String,
    pub pop: bool,
    pub without_index: bool,
    /// The stash's subject, read by the request (the label).
    pub subject: String,
}

impl WriteIntent for StashApply {
    type Outcome = StashApplyOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Stash
    }
    fn label(&self) -> String {
        format!("{} stash \"{}\"", if self.pop { "pop" } else { "apply" }, user_message(&self.subject))
    }
    /// Apply isn't journaled (the stash is kept); pop is.
    fn undo(&self) -> Option<UndoKind> {
        self.pop.then_some(UndoKind::Stash)
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        subject_of(&pre.api.cli, pre.root, &self.oid).await?;
        refuse_stash_apply_in_the_way(pre, &self.oid, if self.pop { "pop" } else { "apply" }).await?; // 2C repo-safety (C2)
        if !self.pop {
            return Ok(Plan::default());
        }
        let paths = stash_paths(&pre.api.cli, pre.root, &self.oid).await?;
        let present_untracked = precheck::untracked_among(&pre.api.cli, pre.root, &paths).await?;
        Ok(Plan { snapshot: Some((paths, present_untracked)), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<StashApplyOutcome, GbError> {
        match apply(cx, &self.oid, !self.without_index).await? {
            Some(files) => Ok(StashApplyOutcome::Conflicts { files }),
            None => {
                if self.pop {
                    // Written ahead of the drop (review I1, M4).
                    cx.record_stash(StashMove { oid: self.oid.clone(), message: self.subject.clone(), created: false, without_index: self.without_index })?;
                    if let Err(e) = drop_oid(cx, &self.oid).await {
                        unrecord_if_listed(cx, &self.oid).await;
                        return Err(e);
                    }
                    forget_kept(cx, &self.oid);
                    // The pop is done: a failed `after` only costs its undo (review M5).
                    match after_snapshot(cx, &self.label()).await {
                        Ok(after) => cx.after = Some(after),
                        Err(e) => {
                            tracing::warn!(target: "gitbolt_core::write", "{}: the after snapshot failed: {e}", self.label());
                            cx.edit_entry(|e| e.blocked = Some(NO_AFTER.to_string()))?;
                        }
                    }
                }
                Ok(StashApplyOutcome::Applied)
            }
        }
    }
}

/// Why a pop whose `after` snapshot failed can't be undone (review M5).
const NO_AFTER: &str = "Can't be undone: GitBolt couldn't record what the pop left";

/// What a clean pop left in its `before` snapshot's paths: an undo autostashes only what
/// changed since (`changed_since`), as a Restore's does.
async fn after_snapshot(cx: &WriteCx<'_>, label: &str) -> Result<crate::journal::Snapshot, GbError> {
    let paths = cx.snapshot.as_ref().map(|s| s.paths.clone()).unwrap_or_default();
    snapshot::create(&cx.snapshots(), label, &paths, &[]).await
}

pub(crate) struct StashDrop {
    pub oid: String,
    pub subject: String,
}

impl WriteIntent for StashDrop {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stash
    }
    fn label(&self) -> String {
        format!("drop stash \"{}\"", user_message(&self.subject))
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Stash)
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        // Written ahead of the drop (review M4): a crash between them leaves a banner.
        cx.record_stash(StashMove { oid: self.oid.clone(), message: self.subject.clone(), created: false, without_index: false })?;
        if let Err(e) = drop_oid(cx, &self.oid).await {
            if unrecord_if_listed(cx, &self.oid).await {
                // Nothing changed: no entry.
                cx.partial = false;
            }
            return Err(e);
        }
        forget_kept(cx, &self.oid);
        Ok(())
    }
}

/// `git stash store -m <subject> <oid>`: the stash returns at the top of the list.
async fn store(cx: &mut WriteCx<'_>, m: &StashMove) -> Result<(), GbError> {
    let inv = cx.git(["stash", "store", "-m", m.message.as_str(), m.oid.as_str()]);
    cx.run_git(inv).await?;
    cx.touch(ChangeKind::Stash);
    Ok(())
}

/// Edits the entry being undone or redone (an undo is a write of its own, without an entry).
fn edit(cx: &mut WriteCx<'_>, id: u64, f: impl FnOnce(&mut JournalEntry)) -> Result<(), GbError> {
    cx.journal_changed = true;
    cx.api.journal(cx.root)?.update(|j| match j.entry_mut(id) {
        Some(e) => f(e),
        None => tracing::warn!(target: "gitbolt_core::write", "journal entry {id} is gone: this edit is lost"),
    })
}

/// `UndoKind::Stash` (§5.3's three stash rows), told apart by what the entry recorded:
/// - created: undo applies it (`--index`) and drops it; redo pushes again (the new oid);
/// - dropped, no `before`: undo stores it back; redo drops it;
/// - `before` (a pop): undo restores `before`, then stores the stash back if the pop dropped
///   it; redo pops again, snapshotting first.
///
/// `without_index`: "Apply without restoring what was staged?" was confirmed (review M2): the
/// push's undo and the pop's redo ask it as Apply does. A pop made without the index redoes
/// without it.
pub(crate) async fn undo_stash(cx: &mut WriteCx<'_>, entry: &JournalEntry, undo: bool, label: &str, without_index: bool) -> Result<(), GbError> {
    let moved = entry.stashes.first().cloned();
    match (moved, &entry.before) {
        (Some(m), _) if m.created => {
            if undo {
                subject_of(&cx.api.cli, cx.root, &m.oid).await?;
                if apply(cx, &m.oid, !without_index).await?.is_some() {
                    return Err(GbError::new(GbErrorKind::Conflict, "The stash's changes conflict; it was kept"));
                }
                drop_oid(cx, &m.oid).await
            } else {
                // The whole message (summary and description) from the old stash commit, which
                // is still there (dangling); the reflog subject is only its first line.
                let full = cx.api.cli.run(GitInvocation::new(cx.root, ["show", "-s", "--format=%B", m.oid.as_str()])).await.map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string()).unwrap_or_else(|_| m.message.clone());
                let message = user_message(&full).to_string();
                let Some((oid, subject)) = push(cx, &message).await? else { return Err(GbError::new(GbErrorKind::InvalidInput, "Nothing to stash")) };
                // Written ahead of the relist's drop (review I1).
                let new = |subject: String| StashMove { oid: oid.clone(), message: subject, created: true, without_index: false };
                edit(cx, entry.id, |e| {
                    if let Some(s) = e.stashes.first_mut() {
                        *s = new(subject.clone());
                    }
                })?;
                let now = relist(cx, &oid, &subject, &message, label).await;
                if now == subject {
                    return Ok(());
                }
                edit(cx, entry.id, |e| {
                    if let Some(s) = e.stashes.first_mut() {
                        *s = new(now);
                    }
                })
            }
        }
        (moved, Some(before)) => {
            if undo {
                // The stash goes back first, beyond a Cancel (re-review M-a): a restore that
                // then fails or is cancelled leaves the changes in the stash, never in neither.
                // Already listed (a retried undo): not stored twice.
                if let Some(m) = &moved
                    && subject_of(&cx.api.cli, cx.root, &m.oid).await.is_err()
                {
                    let inv = cx.git_stash(["stash", "store", "-m", m.message.as_str(), m.oid.as_str()]);
                    cx.run_git(inv).await?;
                    cx.touch(ChangeKind::Stash);
                }
                snapshot::restore(&cx.snapshots(), before).await?;
                cx.touch(ChangeKind::Worktree);
                cx.touch(ChangeKind::Index);
                Ok(())
            } else {
                let m = moved.ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "That pop kept its stash; nothing to redo"))?;
                let oid = m.oid.clone();
                let without = without_index || m.without_index;
                subject_of(&cx.api.cli, cx.root, &oid).await?;
                let paths = stash_paths(&cx.api.cli, cx.root, &oid).await?;
                let untracked = precheck::untracked_among(&cx.api.cli, cx.root, &paths).await?;
                let snap = snapshot::create(&cx.snapshots(), label, &paths, &untracked).await?;
                if apply(cx, &oid, !without).await?.is_some() {
                    edit(cx, entry.id, |e| e.before = Some(snap))?;
                    return Err(GbError::new(GbErrorKind::Conflict, "The stash's changes conflict; it was kept"));
                }
                drop_oid(cx, &oid).await?;
                let after = snapshot::create(&cx.snapshots(), label, &snap.paths, &[]).await;
                if let Err(e) = &after {
                    tracing::warn!(target: "gitbolt_core::write", "redo {label}: the after snapshot failed: {e}");
                }
                edit(cx, entry.id, |e| {
                    e.before = Some(snap);
                    e.blocked = after.is_err().then(|| NO_AFTER.to_string());
                    e.after = after.ok();
                    if let Some(s) = e.stashes.first_mut() {
                        s.without_index = without;
                    }
                })
            }
        }
        (Some(m), None) => {
            if undo {
                store(cx, &m).await
            } else {
                drop_oid(cx, &m.oid).await
            }
        }
        (None, None) => Ok(()),
    }
}

// --- The requests (spec #2 §10) ---

/// The subject of `oid` in `worktree`'s list, read before the write (its label).
async fn request_subject(api: &Api, repo: u32, worktree: &str, oid: &str) -> Result<String, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    subject_of(&api.cli, &root, oid).await
}

/// `stashPush`: an empty `message` names HEAD's branch, read first.
pub(crate) async fn stash_push(api: &Api, repo: u32, worktree: &str, message: String) -> Result<WriteResult<StashPushOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let branch = blocking(move || crate::write::head_state(&gix::open(&root).map_err(gix_err)?)).await?.branch;
    run_write(api, repo, worktree, Default::default(), StashPush::new(message, branch.as_deref())).await
}

/// `stashApply` (Apply, or Pop).
pub(crate) async fn stash_apply(api: &Api, repo: u32, worktree: &str, oid: String, pop: bool, without_index: bool) -> Result<WriteResult<StashApplyOutcome>, GbError> {
    let subject = request_subject(api, repo, worktree, &oid).await?;
    run_write(api, repo, worktree, Default::default(), StashApply { oid, pop, without_index, subject }).await
}

/// `stashDrop` (Delete).
pub(crate) async fn stash_drop(api: &Api, repo: u32, worktree: &str, oid: String) -> Result<WriteResult<()>, GbError> {
    let subject = request_subject(api, repo, worktree, &oid).await?;
    run_write(api, repo, worktree, Default::default(), StashDrop { oid, subject }).await
}

#[cfg(test)]
mod tests {
    use super::user_message;
    use crate::error::GbErrorKind;
    use crate::testing::state::RepoState;
    use crate::testing::write::{identity, open, send, wt, WriteEnv};
    use crate::testing::TestRepo;
    use serde_json::json;

    fn repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.write("a.txt", "a\n");
        r.write("b.txt", "b\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        r
    }

    /// a staged, b unstaged, c untracked.
    fn dirty(r: &TestRepo) {
        r.write("a.txt", "a staged\n");
        r.git(&["add", "a.txt"]);
        r.write("b.txt", "b unstaged\n");
        r.write("c.txt", "c untracked\n");
    }

    fn top(r: &TestRepo) -> String {
        r.git(&["rev-parse", "refs/stash"])
    }

    async fn journal(api: &crate::api::Api, id: u32, r: &TestRepo) -> serde_json::Value {
        send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap()
    }

    async fn undo_redo(api: &crate::api::Api, id: u32, r: &TestRepo, before: &RepoState, after_check: impl Fn(&RepoState)) {
        let s = journal(api, id, r).await;
        send(api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(r), "entry": s["undo"]["entry"]}})).await.unwrap();
        assert_eq!(&RepoState::capture(r), before, "undo");
        let s = journal(api, id, r).await;
        send(api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(r), "entry": s["redo"]["entry"]}})).await.unwrap();
        after_check(&RepoState::capture(r));
    }

    #[test]
    fn user_messages_drop_gits_prefix() {
        assert_eq!(user_message("On main: Fix x"), "Fix x");
        assert_eq!(user_message("WIP on feature/x: 1a2b3c4 Subject"), "1a2b3c4 Subject");
        assert_eq!(user_message("On (no branch): x"), "x");
        assert_eq!(user_message("plain"), "plain");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_named_stash_round_trips_with_its_split() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let out = send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": "Fix x\n\nthe details"}})).await.unwrap();
        assert_eq!(out["outcome"]["status"], "stashed");
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]), "On main: Fix x");
        assert_eq!(r.git(&["show", "-s", "--format=%B", "refs/stash"]), "On main: Fix x\n\nthe details", "the stash commit keeps the whole message");
        assert!(!r.path().join("c.txt").exists(), "untracked files are stashed too");
        assert_eq!(journal(&env.api, id, &r).await["undo"]["label"], "stash \"Fix x\"");
        undo_redo(&env.api, id, &r, &before, |after| {
            assert_eq!(after.stashes.lines().count(), 1, "re-pushed");
            assert!(after.stashes.ends_with("On main: Fix x"));
            assert!(after.untracked.is_empty());
        })
        .await;
        // Redo recorded the new oid: undo again applies that one.
        let s = journal(&env.api, id, &r).await;
        send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap();
        assert_eq!(RepoState::capture(&r), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_message_names_the_branch_and_nothing_to_stash_is_no_entry() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let out = send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": ""}})).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "nothingToStash"}));
        assert!(journal(&env.api, id, &r).await["undo"].is_null());
        dirty(&r);
        send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": "  "}})).await.unwrap();
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]), "On main: WIP on main");
        r.git(&["stash", "pop", "-q", "--index"]);
        r.git(&["switch", "-q", "--detach", "HEAD"]);
        send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": ""}})).await.unwrap();
        assert!(r.git(&["stash", "list", "-1", "--format=%gs"]).ends_with(": WIP on (no branch)"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn apply_keeps_the_stash_and_isnt_journaled() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        r.git(&["stash", "push", "-q", "--include-untracked", "-m", "keep me"]);
        let id = open(&env.api, &r).await;
        let oid = top(&r);
        let out = send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": oid, "pop": false}})).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "applied"}));
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt", "the index came back");
        assert_eq!(top(&r), oid, "kept");
        assert!(journal(&env.api, id, &r).await["undo"].is_null());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_index_asks_and_without_index_applies() {
        let env = WriteEnv::new();
        let r = repo();
        r.write("a.txt", "a staged\n");
        r.git(&["add", "a.txt"]);
        r.git(&["stash", "push", "-q", "-m", "s"]);
        // The index now conflicts with the stash's index part.
        r.write("a.txt", "a other\n");
        r.git(&["add", "a.txt"]);
        r.git(&["commit", "-q", "-m", "moves a"]);
        let id = open(&env.api, &r).await;
        let oid = top(&r);
        let apply = |without: bool| json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": oid, "pop": false, "withoutIndex": without}});
        let e = send(&env.api, apply(false)).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"], json!({"kind": "applyWithoutIndex"}));
        let out = send(&env.api, apply(true)).await.unwrap();
        assert_eq!(out["outcome"]["status"], "conflicts", "the content conflicts land in Conflicted");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pop_round_trips_and_a_conflicting_pop_keeps_the_stash() {
        pop_round_trip().await;
    }

    /// The stack guard: the pop round trip (a write, its undo and redo, each through `dispatch`)
    /// fits a 2 MB thread, a spawned thread's and a tokio worker's default, in a debug build and
    /// whatever RUST_MIN_STACK says. An overflow aborts the run: the write path's futures have
    /// grown inline again (see `run_write`, `dispatch`).
    #[test]
    fn the_pop_round_trip_fits_a_2_mb_stack() {
        const STACK: usize = 2 * 1024 * 1024;
        let run = || tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(STACK).build().unwrap().block_on(pop_round_trip());
        std::thread::Builder::new().stack_size(STACK).spawn(run).unwrap().join().unwrap();
    }

    async fn pop_round_trip() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        r.git(&["stash", "push", "-q", "--include-untracked", "-m", "to pop"]);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let oid = top(&r);
        send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": oid, "pop": true}})).await.unwrap();
        assert!(r.git(&["stash", "list"]).is_empty());
        assert_eq!(journal(&env.api, id, &r).await["undo"]["label"], "pop stash \"to pop\"");
        let after = RepoState::capture(&r);
        undo_redo(&env.api, id, &r, &before, |s| assert_eq!(s, &after)).await;

        let c = repo();
        c.write("a.txt", "a stashed\n");
        c.git(&["stash", "push", "-q", "-m", "conflicts"]);
        c.write("a.txt", "a committed\n");
        c.git(&["commit", "-q", "-am", "moves a"]);
        let cid = open(&env.api, &c).await;
        let coid = top(&c);
        let out = send(&env.api, json!({"method": "stashApply", "params": {"repo": cid, "worktree": wt(&c), "oid": coid, "pop": true, "withoutIndex": true}})).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "conflicts", "files": 1}));
        assert_eq!(top(&c), coid, "a conflicting pop keeps the stash, as git's own does");
    }

    /// A pop's undo overwrites P: an edit made since the pop asks first, as a Restore's does,
    /// and an edit outside P doesn't.
    #[tokio::test(flavor = "multi_thread")]
    async fn undoing_a_pop_asks_before_overwriting_an_edit_made_since() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        r.git(&["stash", "push", "-q", "--include-untracked", "-m", "to pop"]);
        let id = open(&env.api, &r).await;
        let oid = top(&r);
        send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": oid, "pop": true}})).await.unwrap();
        r.write("b.txt", "b edited since\n");
        let s = journal(&env.api, id, &r).await;
        let held = RepoState::capture(&r);
        let e = send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["kind"], "autostashConflict");
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["paths"], json!(["b.txt"]));
        assert_eq!(RepoState::capture(&r), held, "asking changes nothing");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drop_round_trips_with_the_list_line_unchanged() {
        let env = WriteEnv::new();
        let r = repo();
        for m in ["first", "second"] {
            r.write("a.txt", &format!("{m}\n"));
            r.git(&["stash", "push", "-q", "-m", m]);
        }
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let second = top(&r);
        send(&env.api, json!({"method": "stashDrop", "params": {"repo": id, "worktree": wt(&r), "oid": second}})).await.unwrap();
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]), "On main: first");
        assert_eq!(journal(&env.api, id, &r).await["undo"]["label"], "drop stash \"second\"");
        undo_redo(&env.api, id, &r, &before, |s| assert_eq!(s.stashes.lines().count(), 1)).await;
    }

    /// 2C final I1: a kept autostash's banner goes when the user pops or drops that stash from
    /// the stash menus (the record too), and doesn't show while its stash isn't listed.
    #[tokio::test(flavor = "multi_thread")]
    async fn popping_or_dropping_a_kept_autostash_clears_its_banner() {
        use crate::journal::{KeptReason, KeptStash};
        for method in ["pop", "drop", "outside"] {
            let env = WriteEnv::new();
            let r = repo();
            r.write("a.txt", "kept\n");
            r.git(&["stash", "push", "-q", "-m", "autostash before checkout x"]);
            let oid = top(&r);
            let root = r.path().canonicalize().unwrap();
            let store = env.api.journal(&root).unwrap();
            let record = KeptStash { id: 0, oid: Some(oid.clone()), stash_before: None, message: "autostash before checkout x".into(), label: "checkout x".into(), target: Some("x".into()), reason: KeptReason::Refused, created_ms: 0, owner: None };
            store.update(|j| j.keep(record.clone())).unwrap();
            let id = open(&env.api, &r).await;
            assert_eq!(journal(&env.api, id, &r).await["banners"][0]["stash"].as_str(), Some(oid.as_str()), "{method}");
            match method {
                "pop" => send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": oid, "pop": true}})).await.map(drop).unwrap(),
                "drop" => send(&env.api, json!({"method": "stashDrop", "params": {"repo": id, "worktree": wt(&r), "oid": oid}})).await.map(drop).unwrap(),
                _ => drop(r.git(&["stash", "drop", "-q"])),
            }
            assert_eq!(journal(&env.api, id, &r).await["banners"], json!([]), "{method}");
            let left = store.load().unwrap().kept.len();
            assert_eq!(left, usize::from(method == "outside"), "{method}: the menus clear the record; an outside drop only hides it");
        }
    }

    /// Review Focus 4.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_outside_stash_between_showing_and_dropping_drops_the_right_one() {
        let env = WriteEnv::new();
        let r = repo();
        r.write("a.txt", "shown\n");
        r.git(&["stash", "push", "-q", "-m", "shown"]);
        let id = open(&env.api, &r).await;
        let shown = top(&r);
        r.write("a.txt", "outside\n");
        r.git(&["stash", "push", "-q", "-m", "outside"]);
        send(&env.api, json!({"method": "stashDrop", "params": {"repo": id, "worktree": wt(&r), "oid": shown}})).await.unwrap();
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]), "On main: outside");
        let before = RepoState::capture(&r);
        let e = send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": shown, "pop": true}})).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "That stash is gone"));
        assert_eq!(RepoState::capture(&r), before);
    }

    // --- Fix round 1 ---

    #[test]
    fn the_dropped_oid_is_read_from_gits_line() {
        assert_eq!(super::dropped_oid("Dropped stash@{0} (ba3ceed98797445279ae20220118f8b396323d70)\n").as_deref(), Some("ba3ceed98797445279ae20220118f8b396323d70"));
        assert_eq!(super::dropped_oid(""), None);
    }

    /// Review I1: the drop/store pair of a multi-line push. A store that fails leaves the stash
    /// out of the list: the push still succeeded, and the stash's banner shows at once.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_relist_whose_store_fails_keeps_the_push_and_raises_a_banner() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        // The 3rd refs/stash transaction (push, drop, store) is refused.
        let count = r.path().join(".git/stash-tx");
        r.hook("reference-transaction", &format!("#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\ngrep -q ' refs/stash$' || exit 0\nn=$(cat {c} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {c}\n[ $n -ne 3 ]\n", c = count.display()));
        let id = open(&env.api, &r).await;
        let out = send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": "Fix x\n\nbody"}})).await.unwrap();
        assert_eq!(out["outcome"]["status"], "stashed");
        let oid = out["outcome"]["oid"].as_str().unwrap().to_string();
        assert_eq!(r.git(&["stash", "list"]), "", "the store was refused");
        let s = journal(&env.api, id, &r).await;
        assert_eq!(s["undo"]["label"], "stash \"Fix x\"");
        let b = s["banners"].as_array().unwrap();
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!((b[0]["kind"].as_str(), b[0]["stash"].as_str()), (Some("recovery"), Some(oid.as_str())));
        // Its Apply brings the changes back, split included.
        let entry = b[0]["entry"].as_u64().unwrap();
        send(&env.api, json!({"method": "applyKeptStash", "params": {"repo": id, "worktree": wt(&r), "entry": entry}})).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt");
        assert!(r.path().join("c.txt").exists());
    }

    /// Review I1, M4: a stash op that stopped after recording its stash. A recorded stash that's
    /// no longer listed but still exists gets a Recovery banner at the next start; one still
    /// listed gets none.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_crashed_stash_op_whose_stash_is_unlisted_raises_a_banner_at_the_next_start() {
        use crate::journal::{HeadState, NewEntry, Owner, StashMove, UndoKind};
        let (first, data) = WriteEnv::new().into_parts();
        let r = repo();
        dirty(&r);
        r.git(&["stash", "push", "-q", "--include-untracked", "-m", "lost"]);
        let lost = top(&r);
        r.git(&["stash", "drop", "-q"]);
        r.write("b.txt", "kept\n");
        r.git(&["stash", "push", "-q", "-m", "kept"]);
        let kept = top(&r);
        let root = r.path().canonicalize().unwrap();
        let dead = Owner { pid: 1, start: 0, instance: u64::MAX };
        let now = first.now();
        first
            .journal(&root)
            .unwrap()
            .update(|j| {
                for (oid, label, created) in [(lost.clone(), "stash \"lost\"", true), (kept.clone(), "drop stash \"kept\"", false)] {
                    let id = j.begin(NewEntry { label: label.into(), kind: crate::events::OpKind::Stash, head_before: HeadState::default(), undo: UndoKind::Stash }, now);
                    let e = j.entry_mut(id).unwrap();
                    e.owner = Some(dead.clone());
                    e.stashes.push(StashMove { oid, message: format!("On main: {}", &label[label.find('"').unwrap() + 1..label.len() - 1]), created, without_index: false });
                }
            })
            .unwrap();
        drop(first);
        let api = crate::api::Api::new(crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(10))).with_env(crate::testing::isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
        let id = open(&api, &r).await;
        let s = journal(&api, id, &r).await;
        let b = s["banners"].as_array().unwrap();
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!((b[0]["kind"].as_str(), b[0]["stash"].as_str(), b[0]["stashMessage"].as_str()), (Some("recovery"), Some(lost.as_str()), Some("lost")));
        assert!(s["undo"].is_null());
        r.git(&["stash", "drop", "-q"]);
        send(&api, json!({"method": "applyKeptStash", "params": {"repo": id, "worktree": wt(&r), "entry": b[0]["entry"]}})).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt", "the lost stash came back");
    }

    /// Review I2: a conflicting pop has no `after`. Its undo refuses while a path is unmerged,
    /// then asks before overwriting the user's resolution.
    #[tokio::test(flavor = "multi_thread")]
    async fn undoing_a_conflicting_pop_keeps_a_resolution_made_since() {
        let env = WriteEnv::new();
        let c = repo();
        c.write("a.txt", "a stashed\n");
        c.git(&["stash", "push", "-q", "-m", "conflicts"]);
        c.write("a.txt", "a committed\n");
        c.git(&["commit", "-q", "-am", "moves a"]);
        let id = open(&env.api, &c).await;
        let oid = top(&c);
        let out = send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&c), "oid": oid, "pop": true, "withoutIndex": true}})).await.unwrap();
        assert_eq!(out["outcome"]["status"], "conflicts");
        let undo = || json!({"method": "undo", "params": {"repo": id, "worktree": wt(&c), "entry": 0}});
        let entry = journal(&env.api, id, &c).await["undo"]["entry"].clone();
        let mut req = undo();
        req["params"]["entry"] = entry;
        let e = send(&env.api, req.clone()).await.unwrap_err();
        assert_eq!(e.message, "Resolve or abort the conflicts first");
        c.write("a.txt", "a resolved\n");
        c.git(&["add", "a.txt"]);
        let held = RepoState::capture(&c);
        let e = send(&env.api, req).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["kind"], "autostashConflict");
        assert_eq!(RepoState::capture(&c), held, "the resolution is kept");
    }

    /// A stash with line 1 staged, under a commit that changed line 4: git refuses its index
    /// part (the hunk's context moved), but its changes merge cleanly.
    fn refused_index_repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.write("a.txt", "one\n2\n3\n4\n5\n6\n7\n8\n");
        r.git(&["add", "a.txt"]);
        r
    }

    fn move_line_4(r: &TestRepo) {
        r.write("a.txt", "1\n2\n3\nfour\n5\n6\n7\n8\n");
        r.git(&["commit", "-q", "-am", "four"]);
    }

    /// Review M2: the undo of a push asks "Apply without restoring what was staged?" as Apply
    /// does, and applies without the index once confirmed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_pushs_undo_can_apply_without_the_index() {
        let env = WriteEnv::new();
        let r = refused_index_repo();
        let id = open(&env.api, &r).await;
        send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": "s"}})).await.unwrap();
        move_line_4(&r);
        let entry = journal(&env.api, id, &r).await["undo"]["entry"].clone();
        let undo = |without: bool| json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": entry, "withoutIndex": without}});
        let e = send(&env.api, undo(false)).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"], json!({"kind": "applyWithoutIndex"}));
        send(&env.api, undo(true)).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "one\n2\n3\nfour\n5\n6\n7\n8\n");
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    /// Review M2: a pop made without the index redoes without it, without asking again.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_pop_made_without_the_index_redoes_without_it() {
        let env = WriteEnv::new();
        let r = refused_index_repo();
        r.git(&["stash", "push", "-q", "-m", "s"]);
        move_line_4(&r);
        let id = open(&env.api, &r).await;
        let oid = top(&r);
        let pop = |without: bool| json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": oid, "pop": true, "withoutIndex": without}});
        let e = send(&env.api, pop(false)).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"], json!({"kind": "applyWithoutIndex"}));
        assert!(journal(&env.api, id, &r).await["undo"].is_null(), "a refused index leaves no entry");
        send(&env.api, pop(true)).await.unwrap();
        let after = RepoState::capture(&r);
        let s = journal(&env.api, id, &r).await;
        send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap();
        let s = journal(&env.api, id, &r).await;
        send(&env.api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(&r), "entry": s["redo"]["entry"]}})).await.unwrap();
        assert_eq!(RepoState::capture(&r), after);
    }

    // --- Fix round 2 ---

    /// Re-review M-b: a crashed pop keeps its Restore banner, and its stash banner is raised
    /// once: dismissed, it doesn't come back at the next start.
    #[test]
    fn a_resolved_stash_banner_isnt_raised_again() {
        use crate::journal::{HeadState, Journal, NewEntry, Snapshot, StashMove, UndoKind};
        let mut j = Journal::empty("/r");
        let id = j.begin(NewEntry { label: "pop stash \"x\"".into(), kind: crate::events::OpKind::Stash, head_before: HeadState::default(), undo: UndoKind::Stash }, 1);
        let e = j.entry_mut(id).unwrap();
        e.before = Some(Snapshot { commit: "c0ffee".into(), paths: vec!["a.txt".into()], untracked: Vec::new(), ..Default::default() });
        e.stashes.push(StashMove { oid: "1a2b".into(), message: "On main: x".into(), created: false, without_index: false });
        j.recover_unless(|_| false);
        j.resolve_stash_moves(&[], |_| true);
        assert_eq!(j.kept.len(), 1);
        assert_eq!(j.recovery.len(), 1, "the Restore banner stays");
        j.kept.clear();
        j.recover_unless(|_| false);
        j.resolve_stash_moves(&[], |_| true);
        assert!(j.kept.is_empty(), "dismissed: not raised again");
    }

    /// Re-review M-c: the redo of a multi-line push has no pending entry; its guard covers the
    /// drop/store pair. A refused store keeps the redo, records the new oid and shows its banner.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_redone_push_whose_relist_store_fails_raises_a_banner() {
        let env = WriteEnv::new();
        let r = repo();
        dirty(&r);
        // refs/stash transactions: push 1, drop 2, store 3; undo's drop 4; redo's push 5, drop 6,
        // store 7 (refused).
        let count = r.path().join(".git/stash-tx");
        r.hook("reference-transaction", &format!("#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\ngrep -q ' refs/stash$' || exit 0\nn=$(cat {c} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {c}\n[ $n -ne 7 ]\n", c = count.display()));
        let id = open(&env.api, &r).await;
        let out = send(&env.api, json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(&r), "message": "Fix x\n\nbody"}})).await.unwrap();
        assert_eq!(out["outcome"]["status"], "stashed");
        assert_eq!(r.git(&["stash", "list", "--format=%gs"]), "On main: Fix x");
        let s = journal(&env.api, id, &r).await;
        send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap();
        let s = journal(&env.api, id, &r).await;
        send(&env.api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(&r), "entry": s["redo"]["entry"]}})).await.unwrap();
        assert_eq!(std::fs::read_to_string(&count).unwrap().trim(), "7", "the store was the one refused");
        assert_eq!(r.git(&["stash", "list"]), "");
        let s = journal(&env.api, id, &r).await;
        assert_eq!(s["undo"]["label"], "stash \"Fix x\"");
        let b = s["banners"].as_array().unwrap();
        assert_eq!(b.len(), 1, "{b:?}");
        let again = b[0]["stash"].as_str().unwrap().to_string();
        assert_eq!(b[0]["kind"], "recovery");
        let root = r.path().canonicalize().unwrap();
        let entry = env.api.journal(&root).unwrap().load().unwrap().undo_top().cloned().unwrap();
        assert_eq!(entry.stashes[0].oid, again, "the entry records the redo's oid");
        send(&env.api, json!({"method": "applyKeptStash", "params": {"repo": id, "worktree": wt(&r), "entry": b[0]["entry"]}})).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt");
        assert!(r.path().join("c.txt").exists());
    }

    // --- 2C repo-safety (the safety review, C1 and C2) ---

    /// A repository to clone from, with one commit.
    fn upstream() -> TestRepo {
        let s = TestRepo::new();
        identity(&s);
        s.write("s.txt", "s\n");
        s.git(&["add", "."]);
        s.git(&["commit", "-q", "-m", "s"]);
        s
    }

    /// `git clone` of `from` at `at`, with a local-only commit (what the user would lose).
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

    fn stash_push(id: u32, r: &TestRepo, message: &str) -> serde_json::Value {
        json!({"method": "stashPush", "params": {"repo": id, "worktree": wt(r), "message": message}})
    }

    /// C1 (S6a): HEAD has the file `b.txt`; the user replaced it by a folder holding a clone.
    /// `stash push -u` skips the clone, then its `reset --hard` writes the file over the folder,
    /// clone and all: refused, nothing changed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stash_never_deletes_a_clone_in_place_of_a_tracked_file() {
        let sub = upstream();
        let r = repo();
        std::fs::remove_file(r.path().join("b.txt")).unwrap();
        embed(&r, &sub, "b.txt/lib");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, stash_push(id, &r, "s")).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "b.txt/lib is a repository in the way of the stash: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("b.txt/lib/.git").is_dir());
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    /// C2 (S2a): HEAD has a populated gitlink `sm`; the stash replaced it by the file `sm`.
    /// Popping it would write the file over the clone (a local-only commit inside): refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_pop_never_deletes_a_populated_submodule_where_the_stash_has_a_file() {
        let sub = upstream();
        let r = repo();
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "gitlink"]);
        r.git(&["rm", "-q", "--cached", "sm"]);
        let aside = r.root().join("sm-aside");
        std::fs::rename(r.path().join("sm"), &aside).unwrap();
        r.write("sm", "file\n");
        r.git(&["add", "sm"]);
        r.git(&["stash", "push", "-q", "-m", "s"]);
        let _ = std::fs::remove_dir(r.path().join("sm"));
        std::fs::rename(&aside, r.path().join("sm")).unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        for pop in [true, false] {
            let e = send(&env.api, json!({"method": "stashApply", "params": {"repo": id, "worktree": wt(&r), "oid": top(&r), "pop": pop}})).await.unwrap_err();
            let what = if pop { "pop" } else { "apply" };
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, format!("sm is a repository in the way of the {what}: move it first").as_str()));
        }
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
    }

    /// C2 (S2c): the stash turned the tracked folder `vendor/` into the file `vendor`; since the
    /// push, an ignored clone sits at `vendor/lib`. Undoing the push (an apply) would delete it,
    /// ignored or not: refused, and the stash stays.
    #[tokio::test(flavor = "multi_thread")]
    async fn undoing_a_push_never_deletes_an_ignored_clone_under_a_replaced_folder() {
        let sub = upstream();
        let r = repo();
        r.write("vendor/x", "vx\n");
        r.write(".gitignore", "vendor/lib/\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "vendor"]);
        r.git(&["rm", "-q", "-r", "vendor"]);
        r.write("vendor", "file\n");
        r.git(&["add", "vendor"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, stash_push(id, &r, "s")).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("vendor/x")).unwrap(), "vx\n");
        embed(&r, &sub, "vendor/lib");
        assert_eq!(r.git(&["status", "--porcelain"]), "", "the clone is ignored");
        let shown = RepoState::capture(&r);
        let s = journal(&env.api, id, &r).await;
        let e = send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": s["undo"]["entry"]}})).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "vendor/lib is a repository in the way of the undo: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("vendor/lib/.git").is_dir());
        assert_eq!(r.git(&["stash", "list"]).lines().count(), 1);
    }
}
