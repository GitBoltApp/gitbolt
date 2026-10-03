//! Autostash (spec #2 §6).
//!
//! Autostash is automatic, when an operation needs a clean tree, and only on overlap: untouched
//! files keep their mtimes, so editors and build watchers see nothing change. It's
//! `git stash push --include-untracked`, restored with `apply --index` so the staged/unstaged
//! split comes back, and never left on the stack without a banner: every stash GitBolt makes is
//! in the journal's own list (`Journal::kept`), written ahead of the push, until it's applied
//! cleanly or the user dismisses its banner.

use crate::api::Api;
use crate::error::{gix_err, ErrorDetail, GbError, GbErrorKind};
use crate::events::{AppEvent, ChangeKind, OpKind, StashStep};
use crate::git::GitInvocation;
use crate::journal::{snapshot, JournalState, KeptReason, KeptStash, Snapshot, StashPhase};
use crate::write::precheck;
use crate::write::refs::read_ref;
use crate::write::types::{Confirm, Expect};
use crate::write::{run_write, Plan, Pre, WriteCx, WriteIntent};
use gix::ObjectId;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

/// The hard limit on one autostash step (push, apply, drop): generous, since a whole-worktree
/// `-u` stash can be slow, but a hung filter can't hold the queue forever (review N3).
pub(crate) const AUTOSTASH_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// §6.1's table.
#[derive(Debug, Clone)]
pub(crate) enum AutostashRule {
    /// Checkout, fast-forward, undo/redo Switch and Rewind: only when `dirty ∩ touched ≠ ∅`
    /// (git would refuse); otherwise git carries the changes.
    Overlap,
    /// Merge, rebase, pull (2D): any tracked change, or `untracked ∩ touched`.
    #[allow(dead_code)] // its 3B user (cherry-pick, revert) moved to `Touching` in T1 fix round 1
    AnyTracked,
    // --- 2D T14: a merge's prediction ---
    /// `AnyTracked` for a merge or rebase of `target` into HEAD: the worktree ends at their
    /// three-way merge, not at `target`, so `touched` and the prediction use that merge
    /// (`integrate::merge_result`). Diffing against `target` itself would flag every dirty file
    /// HEAD's side changed since the merge base.
    Merged,
    /// `Merged` for a rebase: git first checks out `target` itself, so an untracked file on a
    /// path HEAD→`target` changes is stashed too (re-review m1: a path the local commits deleted
    /// that the target still has), while the prediction stays on the merge.
    Rebased,
    // --- end 2D T14 ---
    /// A snapshot restore over P (undo/redo of a discard or reset, a recovery's Restore):
    /// `dirty ∩ P`, ignored paths of P included, and only those paths are stashed (review I6,
    /// n5). The restore overwrites them, so the warning always asks first.
    Paths(Vec<String>),
    // --- 2C repo-safety ---
    /// The base rule (Overlap, Merged or Rebased), where the move also sweeps a directory away
    /// (safety review M1, M2): its index entries count as touched, and its ignored files go in
    /// the stash too (`--all`, naming every path the stash takes, so nothing else ignored comes
    /// along). Built by `precheck::MoveCheck::rule_over`.
    With(Box<AutostashRule>, Swept),
    // --- end 2C repo-safety ---
    // --- 3B T1 fix ---
    /// `AnyTracked` where `touched` is given, not diffed against a target: the paths a
    /// cherry-pick's or revert's commits change. An untracked file there would stop git part-way
    /// ("would be overwritten"), so it's stashed too.
    Touching(Vec<String>),
    // --- end 3B T1 fix ---
}

// --- 2C repo-safety ---
/// What a move takes with a directory it replaces by a file (`precheck::MoveCheck`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Swept {
    pub swept: Vec<String>,
    pub ignored: Vec<String>,
}
// --- end 2C repo-safety ---

/// What an intent asks for (`Plan::autostash`).
#[derive(Debug, Clone)]
pub(crate) struct AutostashSpec {
    pub rule: AutostashRule,
    /// The commit (or tree, 2D T14) the worktree moves to (`touched` is HEAD's tree vs its tree).
    pub target: Option<ObjectId>,
    /// The message's `<op> [<target>]`: "checkout feature/x", "undo commit \"x\"".
    pub op: String,
    /// What the changes would conflict with, for the warning and the banner.
    pub target_name: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct AutostashPlan {
    pub message: String,
    pub target: Option<String>,
    /// Paths whose restore is predicted to conflict (§6.2): non-empty asks first.
    pub conflicts: Vec<String>,
    /// Stash only these (`Paths`); `None`: the whole worktree.
    pub pathspec: Option<Vec<String>>,
    /// Ignored files among them: `--all`, not `--include-untracked`.
    pub all: bool,
}

pub(crate) async fn plan(api: &Api, root: &Path, tmp: &Path, spec: &AutostashSpec) -> Result<Option<AutostashPlan>, GbError> {
    let dirty = precheck::dirty(&api.cli, root).await?;
    // --- 2C repo-safety (safety review M1, M2) ---
    // What the move sweeps away with a directory (the caller's `precheck::MoveCheck`): index
    // entries there count as touched; ignored files there need the stash even on a clean tree.
    // `base` is the rule proper; `With` wraps it.
    let (base, swept, ignored) = match &spec.rule {
        AutostashRule::With(b, s) => ((**b).clone(), s.swept.clone(), s.ignored.clone()),
        r => (r.clone(), Vec::new(), Vec::new()),
    };
    // --- end 2C repo-safety ---
    // --- 2D T9 review P1: a clean worktree needs no stash, so no tree diff either ---
    if !matches!(base, AutostashRule::Paths(_)) && dirty.tracked.is_empty() && dirty.untracked.is_empty() && ignored.is_empty() {
        return Ok(None);
    }
    // --- end 2D T9 ---
    // --- 2D T14: a merge's prediction runs against the merge (only now: the worktree is dirty) ---
    let target = match (&base, spec.target) {
        (AutostashRule::Merged | AutostashRule::Rebased, Some(t)) => {
            let root = root.to_path_buf();
            Some(crate::api::blocking(move || {
                let repo = gix::open(&root).map_err(gix_err)?;
                Ok(repo.head_id().ok().and_then(|h| crate::write::integrate::merge_result(&repo, h.detach(), t)).unwrap_or(t))
            })
            .await?)
        }
        (_, t) => t,
    };
    // --- end 2D T14 ---
    let mut touched: BTreeSet<String> = match (&base, target) {
        (AutostashRule::Paths(p), _) | (AutostashRule::Touching(p), _) => p.iter().cloned().collect(),
        (_, Some(target)) => {
            let repo = gix::open(root).map_err(gix_err)?;
            match repo.head_id() {
                Ok(head) => precheck::tree_diff_paths(&repo, head.detach(), target)?,
                Err(_) => BTreeSet::new(),
            }
        }
        (_, None) => BTreeSet::new(),
    };
    touched.extend(swept); // 2C repo-safety (M1)
    // --- 3B T1 fix round 2 ---
    // `Touching`: an untracked path where a pick puts a directory (`d` against `d/x`), or under
    // a path where it puts a file (`d/y` against `d`), stops git as surely as one at the path.
    if matches!(base, AutostashRule::Touching(_)) {
        let collide = |u: &str| {
            let u = u.trim_end_matches('/');
            touched.iter().any(|t| t.starts_with(&format!("{u}/")) || u.starts_with(&format!("{t}/")))
        };
        let more: Vec<String> = dirty.untracked.iter().filter(|u| !touched.contains(*u) && collide(u)).cloned().collect();
        touched.extend(more);
    }
    // --- end 3B T1 fix round 2 ---
    // --- 2D T14: a rebase checks out its target first ---
    let checkout_touched: BTreeSet<String> = match (&base, spec.target) {
        (AutostashRule::Rebased, Some(t)) => {
            let repo = gix::open(root).map_err(gix_err)?;
            match repo.head_id() {
                Ok(head) => precheck::tree_diff_paths(&repo, head.detach(), t)?,
                Err(_) => BTreeSet::new(),
            }
        }
        _ => BTreeSet::new(),
    };
    // --- end 2D T14 ---
    let mut overlap: Vec<String> = dirty.tracked.iter().chain(&dirty.untracked).filter(|p| touched.contains(*p)).cloned().collect();
    let mut all = false;
    if let AutostashRule::Paths(p) = &base {
        let ignored = precheck::ignored_among(&api.cli, root, p).await?;
        all = !ignored.is_empty();
        overlap.extend(ignored);
        overlap.sort();
        overlap.dedup();
    }
    // 2C repo-safety: ignored files the move sweeps away need the stash whatever else is dirty.
    let needed = match base {
        AutostashRule::Overlap | AutostashRule::Paths(_) | AutostashRule::With(..) => !overlap.is_empty() || !ignored.is_empty(),
        AutostashRule::AnyTracked | AutostashRule::Merged | AutostashRule::Rebased | AutostashRule::Touching(_) => !dirty.tracked.is_empty() || dirty.untracked.iter().any(|p| touched.contains(p) || checkout_touched.contains(p)) || !ignored.is_empty(),
    };
    if !needed {
        return Ok(None);
    }
    let (conflicts, mut pathspec) = match (&base, target) {
        (AutostashRule::Paths(_), _) => (overlap.clone(), Some(overlap)),
        (_, Some(target)) => (precheck::predict_conflicts(&api.cli, root, tmp, target, &overlap).await?, None),
        (_, None) => (Vec::new(), None),
    };
    // --- 2C repo-safety ---
    // C1: the stash's own `reset --hard` writes HEAD's file over a directory at a dirty tracked
    // path, deleting a repository in it: refused before anything runs.
    if let Some(p) = precheck::stash_push_in_the_way(&api.cli, root, &dirty.tracked, pathspec.as_deref()).await?.first() {
        return Err(precheck::repository_in_the_way(p, "stash"));
    }
    // M2: ignored files the move would delete go in the stash with `--all`, which must then
    // name its paths: every dirty one (what the whole-worktree stash took), plus them.
    if pathspec.is_none() && !ignored.is_empty() {
        let mut paths: Vec<String> = dirty.tracked.iter().chain(&dirty.untracked).cloned().collect();
        paths.extend(ignored);
        paths.sort();
        paths.dedup();
        pathspec = Some(paths);
        all = true;
    }
    // --- end 2C repo-safety ---
    Ok(Some(AutostashPlan { message: format!("autostash before {}", spec.op), target: spec.target_name.clone(), conflicts, pathspec, all }))
}

/// `refs/stash` now: gix, else `git rev-parse` (review n1). An error means "unknown".
pub(crate) async fn stash_oid(api: &Api, root: &Path) -> Result<Option<String>, GbError> {
    let read = gix::open(root).map_err(gix_err).and_then(|r| read_ref(&r, "refs/stash"));
    match read {
        Ok(oid) => Ok(oid),
        Err(first) => match api.cli.run(GitInvocation::new(root, ["rev-parse", "--verify", "-q", "refs/stash"])).await {
            Ok(out) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())),
            // `-q`: a missing ref fails silently.
            Err(e) if e.stderr.as_deref().is_none_or(|s| s.trim().is_empty()) => Ok(None),
            Err(_) => Err(first),
        },
    }
}

fn nul_list<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for p in paths {
        bytes.extend_from_slice(p.as_bytes());
        bytes.push(0);
    }
    bytes
}

/// The configured filters (`filter.<name>.*`), to name a likely culprit for a stopped push.
async fn filter_names(api: &Api, root: &Path) -> Vec<String> {
    let Ok(out) = api.cli.run(GitInvocation::new(root, ["config", "--name-only", "--get-regexp", r"^filter\."])).await else { return Vec::new() };
    let mut names: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.strip_prefix("filter.")?.rsplit_once('.').map(|(n, _)| n.to_string())).collect();
    names.dedup();
    names
}

/// A stash step 5 made, until step 8 settles it.
#[derive(Debug, Clone)]
pub(crate) struct Stashed {
    /// Its `Journal::kept` id.
    pub id: u64,
    pub oid: String,
    pub message: String,
    pub label: String,
    pub target: Option<String>,
    /// Step 8 restores it (not after a stopped push).
    pub restore: bool,
}

fn update_kept(api: &Api, root: &Path, id: u64, f: impl FnOnce(&mut KeptStash)) {
    let res = api.journal(root).and_then(|s| {
        s.update(|j| {
            if let Some(k) = j.kept_mut(id) {
                f(k);
            }
        })
    });
    if let Err(e) = res {
        tracing::error!(target: "gitbolt_core::write", "kept stash {id} couldn't be updated: {e}");
    }
}

/// Step 5. The record is written ahead (`Pending`, no oid), then `git stash push
/// --include-untracked -m "autostash before <op>" [-- <paths>]` runs, and `refs/stash` is read
/// again whatever git said (it stores the stash before it cleans the worktree, review I3).
/// Returns the stash git stored, if any, and whether the op may run.
pub(crate) async fn save(cx: &mut WriteCx<'_>, plan: &AutostashPlan, label: &str) -> (Option<Stashed>, Result<(), GbError>) {
    if cx.op.cancel.is_cancelled() {
        return (None, Err(GbError::new(GbErrorKind::Cancelled, "Cancelled")));
    }
    let (api, root) = (cx.api, cx.root);
    let before = match stash_oid(api, root).await {
        Ok(b) => b,
        Err(e) => return (None, Err(e)),
    };
    let record = KeptStash { id: 0, oid: None, stash_before: before.clone(), message: plan.message.clone(), label: label.to_string(), target: plan.target.clone(), reason: KeptReason::Pending, created_ms: api.now(), owner: None };
    let id = match api.owner().and_then(|owner| api.journal(root)?.update(|j| j.keep(KeptStash { owner: Some(owner), ..record }))) {
        Ok(id) => id,
        // Nothing is stashed without its record.
        Err(e) => return (None, Err(e)),
    };
    let mut args = vec!["stash", "push", if plan.all { "--all" } else { "--include-untracked" }, "-m", plan.message.as_str()];
    if plan.pathspec.is_some() {
        args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    }
    let mut inv = cx.git_stash(args);
    if let Some(paths) = &plan.pathspec {
        inv = inv.env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(paths));
    }
    let (pushed, stopped) = cx.run_stash_step(StashStep::Saving, &plan.message, inv).await;
    cx.touch(ChangeKind::Stash);
    let after = match stash_oid(api, root).await {
        Ok(a) => a,
        Err(e) => {
            // Unknown whether git stored it: the op doesn't run, and the record waits for the
            // next start's recovery to find the stash by its message (or drop the record).
            update_kept(api, root, id, |k| {
                k.reason = KeptReason::Interrupted;
                k.owner = None;
            });
            return (None, Err(GbError::other(format!("Couldn't check the stash after saving your changes: {}", e.message))));
        }
    };
    let Some(oid) = after.filter(|a| Some(a) != before.as_ref()) else {
        // git stored nothing (nothing to save, or it failed first): no record, no stash.
        if let Err(e) = api.journal(root).and_then(|s| s.update(|j| j.kept.retain(|k| k.id != id))) {
            tracing::warn!(target: "gitbolt_core::write", "an empty autostash record stays: {e}");
        }
        if stopped {
            let filters = filter_names(api, root).await;
            let hint = if filters.is_empty() { String::new() } else { format!(" A slow filter may be the cause: {}.", filters.join(", ")) };
            return (None, Err(GbError::other(format!("Stopped saving your changes; nothing was stashed or changed.{hint}"))));
        }
        return (None, pushed.map(drop));
    };
    update_kept(api, root, id, |k| k.oid = Some(oid.clone()));
    let st = Stashed { id, oid, message: plan.message.clone(), label: label.to_string(), target: plan.target.clone(), restore: !stopped };
    if stopped {
        // The same filter would hang the restore: the stash stays, with its banner.
        update_kept(api, root, id, |k| {
            k.reason = KeptReason::Stopped { phase: StashPhase::Push };
            k.owner = None;
        });
        return (Some(st), Err(GbError::other(format!("Stopped saving your changes; they're in stash \"{}\"", plan.message))));
    }
    (Some(st), pushed.map(drop))
}

/// `git stash drop -q stash@{n}`, `n` found by oid in `git stash list` (a read) under the lock,
/// and checked again just before the drop (the stack is shared: review n6). `true`: stopped.
pub(crate) async fn drop_by_oid(cx: &mut WriteCx<'_>, oid: &str, message: &str) -> Result<bool, GbError> {
    let list = cx.api.cli.run(GitInvocation::new(cx.root, ["stash", "list", "--format=%H"])).await?;
    let n = String::from_utf8_lossy(&list.stdout).lines().position(|l| l.trim() == oid).ok_or_else(|| GbError::new(GbErrorKind::NotFound, "That stash is gone"))?;
    let at = format!("stash@{{{n}}}");
    let now = cx.api.cli.run(GitInvocation::new(cx.root, ["rev-parse", "--verify", "-q", at.as_str()])).await?;
    if String::from_utf8_lossy(&now.stdout).trim() != oid {
        return Err(GbError::stale("The stash list changed; nothing was dropped"));
    }
    let inv = cx.git_stash(["stash", "drop", "-q", at.as_str()]);
    let (res, stopped) = cx.run_stash_step(StashStep::Restoring, message, inv).await;
    cx.touch(ChangeKind::Stash);
    if stopped {
        return Ok(true);
    }
    res.map(|_| false)
}

/// What `git stash apply` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Applied {
    /// Applied cleanly, and dropped.
    Restored,
    /// Applied cleanly, but a Stop (or the limit) interrupted its drop: still listed.
    RestoredDropStopped,
    /// Nothing changed. `index`: git refused only the staged part ("Conflicts in index").
    Refused { index: bool, message: String },
    /// Applied, with `files` conflicted files (`binary`: some are binary).
    Conflicts { files: u32, binary: bool },
    /// The tracked changes applied, the untracked ones didn't come back (review N1).
    PartialRestore,
    /// A Stop (or the limit) interrupted the apply: partly restored.
    Stopped,
}

/// Whether the stash's changes to `paths` include a binary file (`--numstat` says `-`).
async fn binary_among(api: &Api, root: &Path, oid: &str, paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let base = format!("{oid}^1");
    let args = ["diff", "--numstat", base.as_str(), oid, "--"].into_iter().map(String::from).chain(paths.iter().cloned());
    match api.cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).lines().any(|l| l.starts_with("-\t-\t")),
        Err(_) => false,
    }
}

/// §6.3: `git stash apply [--index] <oid>`. Clean: dropped. Content conflicts: the files land in
/// Conflicted, and the stash is kept. git refused: nothing changed, kept.
pub(crate) async fn restore(cx: &mut WriteCx<'_>, oid: &str, message: &str, with_index: bool) -> Result<Applied, GbError> {
    let mut args = vec!["stash", "apply"];
    if with_index {
        args.push("--index");
    }
    args.push(oid);
    // git prints a merge's CONFLICT lines on stdout, which a failure doesn't keep: conflicts are
    // the unmerged paths the apply added.
    let unmerged_before = precheck::dirty(&cx.api.cli, cx.root).await?.conflicted;
    let inv = cx.git_stash(args);
    let (res, stopped) = cx.run_stash_step(StashStep::Restoring, message, inv).await;
    for k in [ChangeKind::Worktree, ChangeKind::Index] {
        cx.touch(k);
    }
    if stopped {
        return Ok(Applied::Stopped);
    }
    let e = match res {
        Ok(_) => {
            return Ok(match drop_by_oid(cx, oid, message).await {
                Ok(false) => Applied::Restored,
                Ok(true) => Applied::RestoredDropStopped,
                // Applied: a stash that won't drop is only a leftover entry, not lost changes.
                Err(e) => {
                    tracing::warn!(target: "gitbolt_core::write", "applied the autostash {oid}, but it's still in the stash list: {e}");
                    Applied::Restored
                }
            });
        }
        Err(e) => e,
    };
    let stderr = e.stderr.clone().unwrap_or_default();
    // git restores untracked files after the tracked merge: their failure is a partial apply,
    // where the stash holds the only copy of them.
    if stderr.contains("could not restore untracked files") || stderr.contains("already exists, no checkout") {
        return Ok(Applied::PartialRestore);
    }
    let after = precheck::dirty(&cx.api.cli, cx.root).await.ok();
    let files = after.as_ref().map(|d| d.conflicted).unwrap_or(unmerged_before);
    if files > unmerged_before || stderr.contains("CONFLICT (") {
        let unmerged = after.map(|d| d.unmerged).unwrap_or_default();
        return Ok(Applied::Conflicts { files, binary: binary_among(cx.api, cx.root, oid, &unmerged).await });
    }
    Ok(Applied::Refused { index: stderr.contains("Conflicts in index") || stderr.contains("without --index"), message: e.message })
}

/// The kept reason after an apply; `None`: restored, the record goes.
fn kept_reason(applied: &Applied) -> Option<KeptReason> {
    match applied {
        Applied::Restored | Applied::RestoredDropStopped => None,
        Applied::Refused { .. } => Some(KeptReason::Refused),
        Applied::Conflicts { files, binary } => Some(KeptReason::Conflicts { files: *files, binary: *binary }),
        Applied::PartialRestore => Some(KeptReason::PartialRestore),
        Applied::Stopped => Some(KeptReason::Stopped { phase: StashPhase::Apply }),
    }
}

/// A Stop fails the write (the queue behind it stops; review N3), even after the restore.
pub(crate) fn stop_error(applied: &Applied, message: &str) -> Option<GbError> {
    match applied {
        Applied::Stopped => Some(GbError::other(format!("Stopped restoring your changes; the stash \"{message}\" still has everything"))),
        Applied::RestoredDropStopped => Some(GbError::other(format!("Stopped after restoring your changes; the stash \"{message}\" is still listed"))),
        _ => None,
    }
}

/// Step 8: restored, it leaves the list; otherwise its banner shows, with what happened.
pub(crate) fn settle(api: &Api, root: &Path, st: &Stashed, applied: &Applied) {
    let reason = kept_reason(applied);
    let res = api.journal(root).and_then(|store| {
        store.update(|j| match reason {
            None => j.kept.retain(|k| k.id != st.id),
            Some(reason) => match j.kept_mut(st.id) {
                Some(k) => {
                    k.reason = reason;
                    k.owner = None;
                }
                // Dismissed while the write ran: a stash still kept gets its banner back.
                None => drop(j.keep(KeptStash { id: 0, oid: Some(st.oid.clone()), stash_before: None, message: st.message.clone(), label: st.label.clone(), target: st.target.clone(), reason, created_ms: api.now(), owner: None })),
            },
        })
    });
    if let Err(e) = res {
        tracing::error!(target: "gitbolt_core::write", "the kept stash {} ({}) couldn't be recorded: {e}", st.oid, st.message);
    }
}

// --- 2D T2: the pause ---
/// Step 8 for a paused op (§13.2): its autostash waits for the completion or the abort.
pub(crate) fn keep_paused(api: &Api, root: &Path, st: &Stashed) {
    update_kept(api, root, st.id, |k| {
        k.reason = KeptReason::Paused;
        k.owner = None;
    });
}

/// The paused op ended: restores its autostash `k`, which the settle claimed (`Pending`, owned
/// by this instance, so another instance can't apply it too and a crash before the restore
/// raises its banner). `settle` then drops it (clean) or keeps it with its banner. Returns the
/// error a Stop makes, if any.
pub(crate) async fn restore_paused(cx: &mut WriteCx<'_>, k: KeptStash) -> Option<GbError> {
    let Some(oid) = k.oid else {
        update_kept(cx.api, cx.root, k.id, |k| {
            k.reason = KeptReason::Interrupted;
            k.owner = None;
        });
        return None;
    };
    let st = Stashed { id: k.id, oid, message: k.message, label: k.label, target: k.target, restore: true };
    let applied = match restore(cx, &st.oid, &st.message, true).await {
        Ok(a) => a,
        Err(e) => Applied::Refused { index: false, message: e.message },
    };
    settle(cx.api, cx.root, &st, &applied);
    stop_error(&applied, &st.message)
}
// --- end 2D T2 ---

/// A kept record a banner may act on: not one whose write is still running (review n2), nor a
/// paused merge or rebase's (it waits for the op to end; 2D T2).
fn actionable(k: &KeptStash) -> Result<String, GbError> {
    match (&k.oid, k.reason) {
        (_, KeptReason::Paused) => Err(GbError::new(GbErrorKind::InvalidInput, "That stash waits for the merge or rebase to finish")),
        (_, KeptReason::Pending | KeptReason::AbortRunning) | (None, _) => Err(GbError::new(GbErrorKind::InvalidInput, "That stash's operation is still running")),
        (Some(oid), _) => Ok(oid.clone()),
    }
}

/// A banner's Apply (a kept stash), or a recovery banner's Restore (its `before` snapshot) (§6.4, §5.1).
pub(crate) struct ApplyKept {
    pub entry: u64,
    pub label: String,
    pub without_index: bool,
    /// The clean-restore warning was confirmed (a Restore over paths changed since).
    pub confirm_autostash: bool,
    /// A recovery entry's snapshot: Restore, not Apply.
    pub recovery: Option<Snapshot>,
}

impl WriteIntent for ApplyKept {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stash
    }
    fn label(&self) -> String {
        format!("restore changes from {}", self.label)
    }
    fn undo(&self) -> Option<crate::journal::UndoKind> {
        None
    }
    fn confirm(&self) -> Confirm {
        Confirm { autostash: self.confirm_autostash }
    }

    /// A Restore overwrites P: what changed there since (edits after the restart) is
    /// autostashed first, with the warning (review C1).
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let Some(snap) = &self.recovery else {
            // --- 2C repo-safety ---
            // A kept stash's Apply: a file of the stash written over a repository (C2).
            if let Some(oid) = pre.api.journal(pre.root)?.load()?.kept_mut(self.entry).and_then(|k| k.oid.clone()) {
                crate::write::stash::refuse_stash_apply_in_the_way(pre, &oid, "apply").await?;
            }
            // --- end 2C repo-safety ---
            return Ok(Plan::default());
        };
        let mut changed = precheck::changed_since(&pre.api.cli, pre.root, snap).await?;
        // --- 2C repo-safety ---
        // A directory now standing where a file of the snapshot goes back: a repository in it
        // refuses, its untracked files are autostashed too (2C T6 re-review 3 C5).
        let dirs = snapshot::dirs_in_the_way(&pre.api.cli, pre.root, snap).await?;
        if let Some(p) = dirs.repos.first() {
            return Err(precheck::repository_in_the_way(p, "restore"));
        }
        changed.extend(dirs.untracked);
        // --- end 2C repo-safety ---
        let spec = (!changed.is_empty()).then(|| AutostashSpec { rule: AutostashRule::Paths(changed), target: None, op: self.label(), target_name: Some(self.label.clone()) });
        Ok(Plan { autostash: spec, ..Plan::default() })
    }

    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let store = cx.api.journal(cx.root)?;
        let id = self.entry;
        cx.journal_changed = true;
        if let Some(snap) = &self.recovery {
            snapshot::restore(&cx.snapshots(), snap).await?;
            cx.touch(ChangeKind::Worktree);
            cx.touch(ChangeKind::Index);
            store.update(|j| j.recovery.retain(|e| e.id != id))?;
            return Ok(());
        }
        let kept = store.load()?.kept_mut(id).cloned().ok_or_else(|| GbError::stale("That notice is gone; refreshed"))?;
        let oid = actionable(&kept)?;
        let applied = restore(cx, &oid, &kept.message, !self.without_index).await?;
        if let Applied::Refused { index: true, .. } = applied
            && !self.without_index
        {
            return Err(GbError::new(GbErrorKind::Conflict, "git couldn't restore what was staged").with_detail(ErrorDetail::ApplyWithoutIndex));
        }
        let reason = kept_reason(&applied);
        store.update(|j| match reason {
            None => j.kept.retain(|k| k.id != id),
            Some(r) => {
                if let Some(k) = j.kept_mut(id) {
                    k.reason = r;
                }
            }
        })?;
        if let Some(e) = stop_error(&applied, &kept.message) {
            return Err(e);
        }
        match applied {
            Applied::Refused { message, .. } => Err(GbError::new(GbErrorKind::DirtyWorktree, message)),
            _ => Ok(()),
        }
    }
}

/// A conflicts banner's Drop stash.
struct DropKept {
    entry: u64,
}

impl WriteIntent for DropKept {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stash
    }
    fn label(&self) -> String {
        "drop the kept stash".into()
    }
    fn undo(&self) -> Option<crate::journal::UndoKind> {
        None
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let store = cx.api.journal(cx.root)?;
        let kept = store.load()?.kept_mut(self.entry).cloned().ok_or_else(|| GbError::stale("That notice is gone; refreshed"))?;
        let oid = actionable(&kept)?;
        // Only after content conflicts are its changes in the worktree: a refused, partial,
        // stopped or interrupted stash holds the only copy of some (review m7, N1).
        if !kept.reason.droppable() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Apply the stash first: it holds the only copy of some of those changes"));
        }
        if drop_by_oid(cx, &oid, &kept.message).await? {
            return Err(GbError::other(format!("Stopped dropping the stash \"{}\"; it may still be listed", kept.message)));
        }
        let id = self.entry;
        store.update(|j| j.kept.retain(|k| k.id != id))?;
        cx.journal_changed = true;
        Ok(())
    }
}

/// `ApplyKeptStash`: a kept stash's Apply, or a recovery entry's Restore.
pub(crate) async fn apply_kept(api: &Api, repo: u32, worktree: &str, entry: u64, without_index: bool, confirm_autostash: bool) -> Result<crate::write::types::WriteResult<()>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let mut j = api.journal(&root)?.load()?;
    let (label, recovery) = match j.kept_mut(entry) {
        Some(k) => {
            actionable(k)?;
            (k.label.clone(), None)
        }
        None => {
            let e = j.recovery.iter().find(|e| e.id == entry).ok_or_else(|| GbError::stale("That notice is gone; refreshed"))?;
            let snap = e.before.clone().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Nothing to restore for that notice"))?;
            (e.label.clone(), Some(snap))
        }
    };
    run_write(api, repo, worktree, Expect::default(), ApplyKept { entry, label, without_index, confirm_autostash, recovery }).await
}

/// `DismissBanner`: × keeps the stash (an explicit choice, §6.4); Drop stash drops it.
pub(crate) async fn dismiss(api: &Api, repo: u32, worktree: &str, entry: u64, drop_stash: bool) -> Result<JournalState, GbError> {
    if drop_stash {
        return Ok(run_write(api, repo, worktree, Expect::default(), DropKept { entry }).await?.journal);
    }
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let store = api.journal(&root)?;
    if let Some(k) = store.load()?.kept_mut(entry) {
        actionable(k)?;
    }
    store.update(|j| {
        j.kept.retain(|k| k.id != entry);
        j.recovery.retain(|e| e.id != entry);
    })?;
    let state = api.journal_state(&root)?;
    for id in api.repo_writes(&h).ids() {
        api.bus.emit(AppEvent::JournalChanged { repo: id, worktree: root.display().to_string(), state: state.clone() });
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Request;
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use crate::write::test_intents::{self, TestIntent};
    use crate::write::types::{Confirm, Expect};
    use std::path::Path;
    use std::sync::Arc;

    fn api(data: &Path) -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(500))).with_env(isolated_git_env()), None).with_data_dir(data.to_path_buf())
    }

    fn lines(n: usize, edits: &[(usize, &str)]) -> String {
        (1..=n).map(|i| edits.iter().find(|(at, _)| *at == i).map(|(_, s)| format!("{s}\n")).unwrap_or_else(|| format!("line {i}\n"))).collect()
    }

    /// main: a, b (12 lines), d (20 lines). other: d's line 20 changed, and a.txt's first line.
    fn repo() -> TestRepo {
        let r = TestRepo::new();
        r.git(&["config", "user.name", "Ada Lovelace"]);
        r.git(&["config", "user.email", "ada@example.com"]);
        r.write("a.txt", "a\n");
        r.write("b.txt", &lines(12, &[]));
        r.write("d.txt", &lines(20, &[]));
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("other");
        r.write("d.txt", &lines(20, &[(20, "other")]));
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

    async fn switch(api: &Api, id: u32, r: &TestRepo, branch: &str, autostash: bool) -> Result<serde_json::Value, GbError> {
        test_intents::run(api, id, &wt(r), Expect::default(), TestIntent::Switch { branch: branch.into(), confirm: Confirm { autostash }, create: false }).await
    }

    fn stashes(r: &TestRepo) -> String {
        r.git(&["stash", "list", "--format=%gs"])
    }

    /// §17.1: a fully staged, b partly staged (line 1 staged, line 12 not), c untracked, d dirty
    /// where the target changed it too (the overlap). After the autostashed checkout, the
    /// staged/unstaged split is byte-identical.
    #[tokio::test]
    async fn the_staged_split_survives_an_autostashed_checkout() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a staged\n");
        r.git(&["add", "a.txt"]);
        r.write("b.txt", &lines(12, &[(1, "b staged")]));
        r.git(&["add", "b.txt"]);
        r.write("b.txt", &lines(12, &[(1, "b staged"), (12, "b unstaged")]));
        r.write("c.txt", "untracked\n");
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        let split = |r: &TestRepo| (r.git(&["diff", "--cached", "--", "a.txt", "b.txt"]), r.git(&["diff", "--", "a.txt", "b.txt"]));
        let before = split(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", false).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "other");
        assert_eq!(split(&r), before, "the staged/unstaged split comes back (--index)");
        assert_eq!(std::fs::read_to_string(r.path().join("c.txt")).unwrap(), "untracked\n");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), lines(20, &[(1, "mine"), (20, "other")]), "merged onto the target");
        assert_eq!(stashes(&r), "", "a clean restore drops the stash");
        assert!(res["journal"]["banners"].as_array().unwrap().is_empty());
    }

    /// §6.1: no overlap, no autostash: an untouched file keeps its mtime.
    #[tokio::test]
    async fn no_overlap_means_no_autostash() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("b.txt", &lines(12, &[(3, "mine")]));
        let mtime = std::fs::metadata(r.path().join("b.txt")).unwrap().modified().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        switch(&api, id, &r, "other", false).await.unwrap();
        assert_eq!(std::fs::metadata(r.path().join("b.txt")).unwrap().modified().unwrap(), mtime);
        let ran: Vec<String> = api.command_log().entries().iter().map(|c| c.args.join(" ")).collect();
        assert!(!ran.iter().any(|c| c.starts_with("stash")), "{ran:?}");
    }

    /// §6.2: a restore that would conflict asks first, before anything runs.
    #[tokio::test]
    async fn a_predicted_conflict_asks_first_and_changes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = switch(&api, id, &r, "other", false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Conflict);
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["d.txt".into()], target: "other".into() }));
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(stashes(&r), "");
    }

    /// §6.3–6.4: confirmed, the restore conflicts; the stash is kept, recorded, and the banner shows.
    #[tokio::test]
    async fn a_conflicting_restore_keeps_the_stash_and_shows_the_banner() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", true).await.unwrap();
        assert_eq!(stashes(&r), "On main: autostash before checkout other", "kept, with git's subject");
        let banner = &res["journal"]["banners"][0];
        assert_eq!(banner["kind"], "autostashConflicts");
        assert_eq!(banner["files"], 1);
        assert_eq!(banner["stashMessage"], "autostash before checkout other");
        assert_eq!(banner["target"], "other");
    }

    /// "Conflicts in index" refuses the restore: nothing changed, the stash is kept. Once the
    /// conflict is gone, Apply restores it and drops the stash.
    #[tokio::test]
    async fn a_refused_restore_is_applied_later_from_the_banner() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        r.git(&["add", "d.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", true).await.unwrap();
        let banner = res["journal"]["banners"][0].clone();
        assert_eq!(banner["kind"], "autostashRefused");
        let entry = banner["entry"].as_u64().unwrap();
        // Back where the stash came from (outside GitBolt), the stash applies cleanly.
        r.git(&["switch", "-q", "main"]);
        let applied = api.dispatch(Request::ApplyKeptStash { repo: id, worktree: wt(&r), entry, without_index: Some(false), confirm_autostash: None }).await.unwrap();
        assert!(applied["journal"]["banners"].as_array().unwrap().is_empty());
        assert_eq!(stashes(&r), "", "a clean apply drops it");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "d.txt", "with what was staged");
    }

    #[tokio::test]
    async fn apply_asks_before_dropping_what_was_staged() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        r.git(&["add", "d.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", true).await.unwrap();
        let entry = res["journal"]["banners"][0]["entry"].as_u64().unwrap();
        let err = api.dispatch(Request::ApplyKeptStash { repo: id, worktree: wt(&r), entry, without_index: Some(false), confirm_autostash: None }).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::ApplyWithoutIndex), "git refused the index again: ask");
        let res = api.dispatch(Request::ApplyKeptStash { repo: id, worktree: wt(&r), entry, without_index: Some(true), confirm_autostash: None }).await.unwrap();
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashConflicts", "applied without the index, with conflicts: the stash stays");
    }

    #[tokio::test]
    async fn dismiss_keeps_the_stash_and_drop_stash_drops_it() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", true).await.unwrap();
        let entry = res["journal"]["banners"][0]["entry"].as_u64().unwrap();
        let state = api.dispatch(Request::DismissBanner { repo: id, worktree: wt(&r), entry, drop_stash: Some(false) }).await.unwrap();
        assert!(state["banners"].as_array().unwrap().is_empty());
        assert_eq!(stashes(&r), "On main: autostash before checkout other", "× is explicit: the stash stays");
        // Another conflicted autostash; its Drop stash drops it.
        r.git(&["reset", "-q", "--hard"]);
        r.git(&["stash", "drop", "-q"]);
        r.switch("main");
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        let res = switch(&api, id, &r, "other", true).await.unwrap();
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashConflicts");
        let entry = res["journal"]["banners"][0]["entry"].as_u64().unwrap();
        let state = api.dispatch(Request::DismissBanner { repo: id, worktree: wt(&r), entry, drop_stash: Some(true) }).await.unwrap();
        assert!(state["banners"].as_array().unwrap().is_empty());
        assert_eq!(stashes(&r), "");
    }

    /// Review m7: a refused stash was never applied; dropping it would lose the only copy.
    #[tokio::test]
    async fn drop_stash_is_refused_for_a_stash_that_was_never_applied() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(20, "mine")]));
        r.git(&["add", "d.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", true).await.unwrap();
        assert_eq!(res["journal"]["banners"][0]["kind"], "autostashRefused");
        let entry = res["journal"]["banners"][0]["entry"].as_u64().unwrap();
        let err = api.dispatch(Request::DismissBanner { repo: id, worktree: wt(&r), entry, drop_stash: Some(true) }).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
        assert_eq!(stashes(&r), "On main: autostash before checkout other");
    }

    /// Review C1: GitBolt stopped mid-discard; after the restart the file is edited; Restore
    /// asks first, autostashes the edit (only that path), then puts the snapshot back.
    #[tokio::test]
    async fn a_recovery_restore_keeps_edits_made_after_the_restart() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "before the crash\n");
        r.write("b.txt", &lines(12, &[(1, "unrelated")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = test_intents::run(&api, id, &wt(&r), Expect::default(), TestIntent::Discard { paths: vec!["a.txt".into()] }).await.unwrap();
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        // As if GitBolt had stopped mid-operation: the entry waits in recovery.
        api.journal(&r.path().canonicalize().unwrap()).unwrap().update(|j| {
            let e = j.undo.pop().unwrap();
            j.recovery.push(e);
        }).unwrap();
        r.write("a.txt", "edited after the restart\n");
        let unrelated = std::fs::metadata(r.path().join("b.txt")).unwrap().modified().unwrap();
        let apply = |confirm| Request::ApplyKeptStash { repo: id, worktree: wt(&r), entry, without_index: None, confirm_autostash: confirm };
        let err = api.dispatch(apply(None)).await.unwrap_err();
        assert_eq!(err.detail, Some(crate::error::ErrorDetail::AutostashConflict { paths: vec!["a.txt".into()], target: "discard a.txt".into() }), "ask first");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "edited after the restart\n", "asking changes nothing");
        let res = api.dispatch(apply(Some(true))).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "before the crash\n", "the snapshot is back");
        assert_eq!(r.git(&["show", "stash@{0}:a.txt"]), "edited after the restart", "the edit is kept");
        assert_eq!(r.git(&["stash", "show", "--name-only", "stash@{0}"]), "a.txt", "only the restored path");
        assert_eq!(std::fs::metadata(r.path().join("b.txt")).unwrap().modified().unwrap(), unrelated);
        let banners = res["journal"]["banners"].as_array().unwrap();
        assert_eq!(banners.len(), 1, "{banners:?}");
        assert_eq!(banners[0]["kind"], "autostashRefused");
    }

    /// Review I3: git stored the stash, then failed cleaning the worktree. The stash is
    /// recorded, restored where it can be, and kept with a banner; the failed write leaves no
    /// journal entry (m10).
    #[tokio::test]
    async fn a_push_that_fails_after_git_stored_the_stash_is_kept() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        r.write("ro/u.txt", "untracked in a read-only dir\n");
        let ro = r.path().join("ro");
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "other", false).await;
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(res.is_err(), "{res:?}");
        assert_eq!(stashes(&r), "On main: autostash before checkout other", "git stored it");
        let state = api.dispatch(Request::JournalState { repo: id, worktree: wt(&r) }).await.unwrap();
        assert_eq!(state["banners"].as_array().unwrap().len(), 1, "{state}");
        assert!(state["undo"].is_null(), "the checkout that never happened isn't undoable");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), lines(20, &[(1, "mine")]));
    }

    /// Review I4: a Cancel stops the checkout (its slow hook), never the restore.
    #[tokio::test]
    async fn a_cancel_during_the_op_still_restores_the_autostash() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.hook("post-checkout", "#!/bin/sh\nsleep 5\n");
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        // Event-driven: once the save step ends the checkout runs (its hook sleeps 5 s), so a
        // Cancel then is the op's, never the save's (a Cancel during a stash step is a Stop).
        let cancel = async {
            loop {
                if let Ok(crate::events::AppEvent::OpStashStep { op, step: None, .. }) = rx.recv().await {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    api.dispatch(Request::CancelOp { op }).await.unwrap();
                    return;
                }
            }
        };
        let (res, ()) = tokio::join!(switch(&api, id, &r, "other", false), cancel);
        assert_eq!(res.unwrap_err().kind, GbErrorKind::Cancelled);
        assert_eq!(stashes(&r), "", "restored and dropped");
        assert!(std::fs::read_to_string(r.path().join("d.txt")).unwrap().starts_with("mine\n"), "the change is back");
        let state = api.dispatch(Request::JournalState { repo: id, worktree: wt(&r) }).await.unwrap();
        assert!(state["banners"].as_array().unwrap().is_empty());
    }

    /// Review m6/m13: the user's own stash on the stack is never the one dropped.
    #[tokio::test]
    async fn an_unrelated_stash_is_never_dropped() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "the user's stash\n");
        r.git(&["stash", "push", "-q", "-m", "mine"]);
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        switch(&api, id, &r, "other", false).await.unwrap();
        assert_eq!(stashes(&r), "On main: mine");
    }

    fn banners(v: &serde_json::Value) -> Vec<serde_json::Value> {
        v["banners"].as_array().cloned().unwrap_or_default()
    }

    async fn state(api: &Api, id: u32, r: &TestRepo) -> serde_json::Value {
        api.dispatch(Request::JournalState { repo: id, worktree: wt(r) }).await.unwrap()
    }

    /// Review N1, on real git: the target adds a file that's untracked here. The tracked change
    /// comes back, the untracked file can't: "partly restored", and Drop is refused.
    #[tokio::test]
    async fn a_partial_restore_keeps_the_stash_and_refuses_drop() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("adds");
        r.write("u.txt", "tracked on adds\n");
        r.git(&["add", "u.txt"]);
        r.git(&["commit", "-q", "-m", "adds u"]);
        r.switch("main");
        r.write("u.txt", "untracked here\n");
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "adds", true).await.unwrap();
        let b = &res["journal"]["banners"][0];
        assert_eq!((b["kind"].as_str(), b["canDrop"].as_bool()), (Some("autostashPartial"), Some(false)), "{b}");
        assert!(std::fs::read_to_string(r.path().join("d.txt")).unwrap().starts_with("mine\n"), "the tracked change came back");
        let entry = b["entry"].as_u64().unwrap();
        let err = api.dispatch(Request::DismissBanner { repo: id, worktree: wt(&r), entry, drop_stash: Some(true) }).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
        assert_eq!(r.git(&["show", "stash@{0}^3:u.txt"]), "untracked here", "the stash still has the only copy");
    }

    /// Review N1: a binary conflict keeps only the current version in the worktree; the banner
    /// says so, for the warning before Drop.
    #[tokio::test]
    async fn a_binary_conflict_is_flagged() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write_bytes("b.bin", b"\0base\0");
        r.git(&["add", "b.bin"]);
        r.git(&["commit", "-q", "-m", "bin"]);
        r.switch_new("bin2");
        r.write_bytes("b.bin", b"\0theirs\0");
        r.git(&["commit", "-q", "-am", "bin2"]);
        r.switch("main");
        r.write_bytes("b.bin", b"\0mine\0");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = switch(&api, id, &r, "bin2", true).await.unwrap();
        let b = &res["journal"]["banners"][0];
        assert_eq!((b["kind"].as_str(), b["binary"].as_bool(), b["canDrop"].as_bool()), (Some("autostashConflicts"), Some(true), Some(true)), "{b}");
    }

    /// Review N2: GitBolt died right after git stored the stash, before it heard back. The
    /// record written ahead finds the stash by its message at the next start; one whose push
    /// stored nothing goes.
    #[tokio::test]
    async fn a_crash_right_after_the_push_raises_the_banner_at_the_next_start() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let dead = crate::journal::Owner { pid: 1, start: 0, instance: u64::MAX };
        let record = |message: &str| KeptStash { id: 0, oid: None, stash_before: None, message: message.into(), label: "checkout other".into(), target: Some("other".into()), reason: KeptReason::Pending, created_ms: 1, owner: Some(dead.clone()) };
        let root = r.path().canonicalize().unwrap();
        let (found, gone) = {
            let first = api(data.path());
            let store = first.journal(&root).unwrap();
            store.update(|j| (j.keep(record("autostash before checkout other")), j.keep(record("autostash before checkout nothing")))).unwrap()
        };
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        r.git(&["stash", "push", "-q", "--include-untracked", "-m", "autostash before checkout other"]);
        let oid = r.git(&["rev-parse", "refs/stash"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let b = banners(&state(&api, id, &r).await);
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!((b[0]["kind"].as_str(), b[0]["entry"].as_u64(), b[0]["stash"].as_str()), (Some("recovery"), Some(found), Some(oid.as_str())));
        assert!(api.journal(&root).unwrap().load().unwrap().kept_mut(gone).is_none());
        // Its Apply brings the changes back.
        api.dispatch(Request::ApplyKeptStash { repo: id, worktree: wt(&r), entry: found, without_index: None, confirm_autostash: None }).await.unwrap();
        assert!(std::fs::read_to_string(r.path().join("d.txt")).unwrap().starts_with("mine\n"));
        assert_eq!(stashes(&r), "");
    }

    /// The `slow` filter: its smudge sleeps (only once `marker` exists, if given).
    fn slow_filter(r: &TestRepo, marker: Option<&Path>) {
        r.write(".gitattributes", "*.slow filter=slow\n");
        r.write("s.slow", "slow\n");
        r.git(&["add", ".gitattributes", "s.slow"]);
        r.git(&["commit", "-q", "-m", "slow"]);
        // `other` has it too: the switch doesn't touch it.
        r.switch("other");
        r.git(&["merge", "-q", "-m", "slow too", "main"]);
        r.switch("main");
        let smudge = match marker {
            Some(m) => format!("sh -c 'if [ -f {} ]; then sleep 30; fi; cat'", m.display()),
            None => "sh -c 'sleep 30; cat'".to_string(),
        };
        r.git(&["config", "filter.slow.smudge", &smudge]);
        r.git(&["config", "filter.slow.clean", "cat"]);
    }

    /// Review N3: a Cancel while the push runs is a Stop: git's process group is stopped, the
    /// stash git stored stays (`Stopped`), the op doesn't run, and nothing is restored.
    #[tokio::test]
    async fn a_stop_during_the_push_keeps_the_stash_and_skips_the_op() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        slow_filter(&r, None);
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        r.write("s.slow", "slow, edited\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let stop = async {
            loop {
                let Ok(ev) = tokio::time::timeout(std::time::Duration::from_secs(20), rx.recv()).await else { return };
                if let Ok(crate::events::AppEvent::OpStashStep { op, step: Some(crate::events::StashStep::Saving), .. }) = ev {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    api.dispatch(Request::CancelOp { op }).await.unwrap();
                    return;
                }
            }
        };
        let started = std::time::Instant::now();
        let (res, ()) = tokio::join!(switch(&api, id, &r, "other", false), stop);
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "the filter was stopped: {res:?}");
        let err = res.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Other, "a failure, so the queue behind it stops");
        assert!(err.message.starts_with("Stopped saving your changes"), "{}", err.message);
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main", "the op didn't run");
        assert_eq!(stashes(&r), "On main: autostash before checkout other");
        let b = banners(&state(&api, id, &r).await);
        assert_eq!((b[0]["kind"].as_str(), b[0]["canDrop"].as_bool()), (Some("autostashStopped"), Some(false)));
    }

    /// Review N3: the limit stops a hung apply: kept as `Stopped` (partly restored), the write
    /// fails, and Drop is refused.
    #[tokio::test]
    async fn the_limit_stops_a_hung_restore() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let marker = r.root().join("restore-hangs");
        slow_filter(&r, Some(&marker));
        r.hook("post-checkout", &format!("#!/bin/sh\ntouch {}\n", marker.display()));
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        r.write("s.slow", "slow, edited\n");
        let api = api(data.path()).with_autostash_timeout(std::time::Duration::from_secs(2));
        let id = open(&api, &r).await;
        let err = switch(&api, id, &r, "other", false).await.unwrap_err();
        assert!(err.message.starts_with("Stopped restoring your changes"), "{}", err.message);
        assert_eq!(stashes(&r), "On main: autostash before checkout other");
        let b = banners(&state(&api, id, &r).await);
        assert_eq!((b[0]["kind"].as_str(), b[0]["canDrop"].as_bool()), (Some("autostashPartial"), Some(false)));
        let entry = b[0]["entry"].as_u64().unwrap();
        assert_eq!(api.dispatch(Request::DismissBanner { repo: id, worktree: wt(&r), entry, drop_stash: Some(true) }).await.unwrap_err().kind, GbErrorKind::InvalidInput);
    }

    /// Review n2: a stash whose write is still running can't be applied or dismissed.
    #[tokio::test]
    async fn a_running_writes_stash_is_left_alone() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let owner = api.owner().unwrap();
        let entry = api
            .journal(&r.path().canonicalize().unwrap())
            .unwrap()
            .update(|j| j.keep(KeptStash { id: 0, oid: Some("a".repeat(40)), stash_before: None, message: "autostash before checkout x".into(), label: "checkout x".into(), target: None, reason: KeptReason::Pending, created_ms: 1, owner: Some(owner) }))
            .unwrap();
        let err = api.dispatch(Request::ApplyKeptStash { repo: id, worktree: wt(&r), entry, without_index: None, confirm_autostash: None }).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
        let err = api.dispatch(Request::DismissBanner { repo: id, worktree: wt(&r), entry, drop_stash: Some(false) }).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    /// §17.1 hooks: post-checkout output streams to Activity.
    #[tokio::test]
    async fn post_checkout_output_streams() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.hook("post-checkout", "#!/bin/sh\necho 'post-checkout ran'\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        switch(&api, id, &r, "other", false).await.unwrap();
        let mut lines = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let crate::events::AppEvent::OpOutput { line, .. } = ev {
                lines.push(line);
            }
        }
        assert!(lines.contains(&"post-checkout ran".to_string()), "{lines:?}");
    }

    #[tokio::test]
    async fn the_autostash_plumbing_never_signs() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        if !r.signing_ssh() {
            return;
        }
        r.write("d.txt", &lines(20, &[(1, "mine")]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        switch(&api, id, &r, "other", false).await.unwrap();
        assert_eq!(r.sign_count(), 0);
    }
}
