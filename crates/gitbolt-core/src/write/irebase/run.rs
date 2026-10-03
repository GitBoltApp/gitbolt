//! The interactive rebase (spec #3 §3.1, §3.3, §3.4): one native `git rebase -i <base>` whose
//! todo is the plan, written verbatim by the sequence editor (`cp <todo>`). Messages go through
//! guarded exec scripts, and chips through `update-ref` lines. Deleted chips go once it
//! completes, in the same journal entry, so one Undo restores every ref it touched and the
//! autostash.

use super::plan::{read_range, Range, MAX_ROWS};
use super::todo::{build, sh_quote, PlannedRow, Todo, TodoPlan};
use super::types::{ChipAt, ChipPlan, RebaseRow};
use crate::api::Api;
use crate::error::{short_ref, GbError, GbErrorKind};
use crate::events::OpKind;
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{ConfigChange, IrebaseState, RefMove, UndoKind};
use crate::write::integrate::IntegrateOutcome;
use crate::write::rebase::run_rebase_stop;
use crate::write::types::{Confirm, Expect, WriteResult};
use crate::write::{run_write, Plan, Pre, WriteCx, WriteIntent};
use gix::ObjectId;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Review Focus 2: the user's rebase settings can't change the plan. The todo is verbatim, its
/// comments are `#`, and nothing is added, moved or abbreviated.
#[rustfmt::skip]
pub(crate) const GIT_PINS: [&str; 12] = [
    "-c", "core.commentChar=#",
    "-c", "rebase.missingCommitsCheck=ignore",
    "-c", "rebase.abbreviateCommands=false",
    "-c", "rebase.autoSquash=false",
    "-c", "rebase.updateRefs=false",
    "-c", "rebase.rebaseMerges=false",
];

pub(crate) enum Source {
    /// The editor's Start: its rows and chips.
    Plan { rows: Vec<RebaseRow>, chips: Vec<ChipPlan> },
    /// "Edit message" on an older commit (spec #3 §3.6).
    Reword { oid: String, message: String },
}

/// What `plan` found, for `run`.
pub(crate) struct Planned {
    pub base: ObjectId,
    pub todo: Todo,
    pub dir: PathBuf,
    /// Full ref → its value now, for each branch an `update-ref` line moves (`None`: created).
    pub watch: Vec<(String, Option<String>)>,
    /// Full ref → tip: deleted once the rebase completes.
    pub deletes: Vec<(String, String)>,
    /// A reword of an older commit (M4): how many commits are above it, so the reworded one is
    /// HEAD's first-parent ancestor that many back once it completes.
    pub reword_depth: Option<usize>,
}

pub(crate) struct IrebaseIntent {
    pub branch: String,
    pub base: String,
    pub source: Source,
    pub confirm: Confirm,
    pub label: String,
    pub planned: OnceLock<Planned>,
}

fn invalid(m: impl Into<String>) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, m)
}

/// A fresh session directory's path (`<data>/irebase/<random>`); `run` creates it.
pub(crate) fn session_dir(api: &Api) -> PathBuf {
    api.data_dir.join("irebase").join(crate::random::random_hex(8))
}

/// The session directory, its message files and scripts, and the todo. A failure part-way
/// removes what it wrote: nothing is left behind for a rebase that never ran.
fn write_session(dir: &Path, todo: &Todo) -> Result<PathBuf, GbError> {
    let io = |p: &Path, e: std::io::Error| GbError::new(GbErrorKind::Io, format!("{}: {e}", p.display()));
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
        crate::paths::private_dir(parent).map_err(|e| io(parent, e))?;
    }
    let write = || -> Result<PathBuf, GbError> {
        crate::paths::private_dir(dir).map_err(|e| io(dir, e))?;
        for (path, text) in &todo.files {
            std::fs::write(path, text).map_err(|e| io(path, e))?;
        }
        let path = dir.join("todo");
        std::fs::write(&path, &todo.text).map_err(|e| io(&path, e))?;
        Ok(path)
    };
    write().inspect_err(|_| remove_session(dir))
}

pub(crate) fn remove_session(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(target: "gitbolt_core::write", "removing {}: {e}", dir.display());
    }
}

/// Where a chip delete's config changes are journaled.
#[derive(Clone, Copy)]
pub(crate) enum RecordIn {
    /// The write's own entry (the Start that completed).
    Entry,
    /// The paused entry (a Continue or Skip: `RebaseControl` isn't journaled), which the
    /// step-7b settle then closes with the deletes in it.
    Paused,
}

/// Chips marked delete (§3.3): each through the normal branch delete, after the rebase
/// completed. Each delete is journaled as soon as it's done (its config changes; on the paused
/// entry its ref move too), so one that fails later keeps the earlier ones undoable.
/// - M5: a chip the user deleted meanwhile is skipped, and nothing is recorded for it.
/// - R1: one that can't be deleted (it moved meanwhile) is kept, and the rebase still succeeds:
///   the returned warning names it.
pub(crate) async fn delete_chips(cx: &mut WriteCx<'_>, deletes: &[(String, String)], into: RecordIn) -> Option<String> {
    let mut kept = Vec::new();
    let mut unrecorded = Vec::new();
    for (full, tip) in deletes {
        let short = short_ref(full).to_string();
        match ref_now(cx.root, full).await {
            Ok(None) => continue,
            Ok(Some(_)) => {}
            Err(e) => {
                tracing::warn!(target: "gitbolt_core::write", "the rebase completed, but {short} couldn't be read: {e}");
                kept.push(short);
                continue;
            }
        }
        let gone = RefMove { name: full.clone(), old: Some(tip.clone()), new: None };
        let recorded = match crate::write::branch_delete::delete_local_branch(cx, &short, Some(tip.clone())).await {
            Ok(changes) => match into {
                RecordIn::Entry => cx.record_config(changes),
                RecordIn::Paused => record_on_paused(cx, vec![gone], changes),
            },
            Err(e) => {
                tracing::warn!(target: "gitbolt_core::write", "the rebase completed, but {short} wasn't deleted: {e}");
                // The ref went before its config could: the move is ours all the same.
                if !matches!(ref_now(cx.root, full).await, Ok(None)) {
                    kept.push(short);
                    continue;
                }
                match into {
                    RecordIn::Paused => record_on_paused(cx, vec![gone], Vec::new()),
                    RecordIn::Entry => Ok(()),
                }
            }
        };
        if let Err(e) = recorded {
            tracing::warn!(target: "gitbolt_core::write", "{short} was deleted, but the journal couldn't record it: {e}");
            unrecorded.push(short);
        }
    }
    let mut warnings = Vec::new();
    match kept.as_slice() {
        [] => {}
        [one] => warnings.push(format!("{one} wasn't deleted: it changed during the rebase")),
        many => warnings.push(format!("{} weren't deleted: they changed during the rebase", many.join(", "))),
    }
    if !unrecorded.is_empty() {
        warnings.push(format!("Undo won't bring back {}: the journal couldn't record the delete", unrecorded.join(", ")));
    }
    (!warnings.is_empty()).then(|| warnings.join(". "))
}

async fn ref_now(root: &Path, full: &str) -> Result<Option<String>, GbError> {
    let (root, full) = (root.to_path_buf(), full.to_string());
    crate::api::blocking(move || crate::write::refs::read_ref(&gix::open(&root).map_err(crate::error::gix_err)?, &full)).await
}

/// On the paused entry, as they happen: ref moves (`IrebaseState::moved`, which settle keeps in
/// either verdict) and config changes.
fn record_on_paused(cx: &mut WriteCx<'_>, moves: Vec<RefMove>, changes: Vec<ConfigChange>) -> Result<(), GbError> {
    if moves.is_empty() && changes.is_empty() {
        return Ok(());
    }
    if !changes.is_empty() {
        cx.touch(crate::events::ChangeKind::Config);
    }
    cx.api.journal(cx.root)?.update(|j| {
        if let Some(id) = j.paused().map(|e| e.id)
            && let Some(e) = j.entry_mut(id)
        {
            e.config.extend(changes);
            if let Some(s) = e.paused.as_mut().and_then(|p| p.irebase.as_mut()) {
                s.moved.extend(moves);
            }
        }
    })?;
    cx.journal_changed = true;
    Ok(())
}

/// After a Continue that completed: the chips the todo's `update-ref` lines moved or created,
/// each one that's now in the rebased history (one moved elsewhere during the pause is someone
/// else's), as moves for the paused entry.
async fn update_ref_moves(cx: &WriteCx<'_>, refs: &[(String, Option<String>)]) -> Result<Vec<RefMove>, GbError> {
    let (root, refs) = (cx.root.to_path_buf(), refs.to_vec());
    crate::api::blocking(move || {
        let repo = gix::open(&root).map_err(crate::error::gix_err)?;
        let tip = repo.head_id().map_err(crate::error::gix_err)?.detach();
        let mut out = Vec::new();
        for (name, before) in refs {
            let now = crate::write::refs::read_ref(&repo, &name)?;
            let ours = now.as_deref().and_then(|n| ObjectId::from_hex(n.as_bytes()).ok()).is_some_and(|n| crate::write::is_ancestor(&repo, n, tip));
            if now != before && ours {
                out.push(RefMove { name, old: before, new: now });
            }
        }
        Ok(out)
    })
    .await
}

impl Planned {
    fn state(&self) -> IrebaseState {
        IrebaseState {
            dir: self.dir.display().to_string(),
            delete_after: self.deletes.clone(),
            edit_messages: self.todo.edit_messages.iter().map(|(o, p)| (o.clone(), p.display().to_string())).collect(),
            made: Vec::new(),
            update_refs: self.watch.clone(),
            moved: Vec::new(),
        }
    }
}

/// What a hook said, on one line: git's stderr without its own lines (progress, `Executing:`,
/// the failed `exec`'s advice). `None`: it said nothing.
pub(crate) fn hook_text(stderr: &str) -> Option<String> {
    // UX F: a signer that failed (the amend signs) says so, not as a hook.
    if let Some(s) = crate::git::signing_failure(stderr) {
        return Some(s);
    }
    let lines: Vec<&str> = stderr.split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()).collect();
    let end = lines.iter().position(|l| l.starts_with("warning: execution failed:") || l.starts_with("error: execution failed:")).unwrap_or(lines.len());
    let start = lines[..end].iter().rposition(|l| l.starts_with("Executing: ")).map_or(0, |i| i + 1);
    let said: Vec<&str> = lines[start..end].iter().copied().filter(|l| !l.starts_with("Rebasing (") && !l.starts_with("hint:")).map(|l| l.trim_start_matches("error: ").trim_start_matches("fatal: ")).collect();
    (!said.is_empty()).then(|| said.join(" "))
}

/// "The new message wasn't applied: <why>. Type it again to retry, or Continue to keep the old one." (M1, M2)
fn not_applied(why: &str) -> String {
    format!("The new message wasn't applied: {}. Type it again to retry, or Continue to keep the old one.", why.trim_end_matches('.'))
}

/// A stop of GitBolt's interactive rebase: what its plan asked of it (3C final fix: the stop's
/// note, never fatal to the stop: a failure is logged, and its warning is the outcome's).
/// - UX L: at an `edit` stop, while HEAD is still the commit git made (nothing done there yet),
///   the stop becomes "about to commit" (`edit::stage_edit_stop`): HEAD on its parent, its changes
///   staged, and the Edit row's new message (Ruling 4), once per stop, the box's.
/// - At an Edit row's conflict (I1: git won't stop for the Edit again), its new message is git's
///   message file, which Continue commits with and the panel prefills; once per stop, never over
///   a message typed there since.
/// - A reword script that failed (M2, `failed`: git's error): why, for the panel.
///
/// The returned warning: the new message wasn't applied (M1, M2).
pub(crate) async fn at_stop(cx: &mut WriteCx<'_>, s: &IrebaseState, failed: Option<&GbError>) -> Option<String> {
    use crate::in_progress::{last_done, stop_note, write_stop_note, InProgress, MESSAGE_APPLIED, MESSAGE_FAILED, REFUSED};
    let root = cx.root.to_path_buf();
    let read = move || -> Result<(Option<InProgress>, PathBuf, String), GbError> {
        let repo = gix::open(&root).map_err(crate::error::gix_err)?;
        let head = repo.head_id().map_err(crate::error::gix_err)?.to_string();
        Ok((crate::in_progress::read(&root)?, repo.git_dir().to_path_buf(), head))
    };
    let (state, git_dir, head) = match read() {
        Ok(x) => x,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "reading the interactive rebase's stop: {e}");
            return None;
        }
    };
    let Some(InProgress::Rebase { edit_stop, edit_conflict, stopped_at, .. }) = state else { return None };
    let at = last_done(&git_dir)?;
    let note = |name: &str, text: &str| {
        if let Err(e) = write_stop_note(&git_dir, name, &at, text) {
            tracing::warn!(target: "gitbolt_core::write", "noting the interactive rebase's stop ({name}): {e}");
        }
    };
    // M2: one of this session's reword scripts failed (a commit-msg hook refused the message).
    // Only the exec's own failure: a later Continue that fails at the same stop (unstaged
    // changes) isn't a refusal (re-review).
    let fresh = stop_note(&git_dir, MESSAGE_FAILED, &at).is_none() && stop_note(&git_dir, MESSAGE_APPLIED, &at).is_none();
    if let Some(e) = failed.filter(|_| fresh && at.starts_with("exec sh ") && at.contains(".sh")) {
        let why = e.stderr.as_deref().and_then(hook_text).unwrap_or_else(|| "a hook refused it".to_string());
        tracing::warn!(target: "gitbolt_core::write", "a reword of the interactive rebase failed: {why}");
        // The script `<dir>/<n>.sh` amends with `<dir>/<n>.msg`; HEAD is its target (its guard).
        let n = at.rsplit('/').next().and_then(|f| f.split(".sh").next()).unwrap_or_default();
        match std::fs::read_to_string(Path::new(&s.dir).join(format!("{n}.msg"))) {
            Ok(m) => note(REFUSED, &format!("{head}\n{m}")),
            Err(e) => tracing::warn!(target: "gitbolt_core::write", "reading the refused message: {e}"),
        }
        note(MESSAGE_FAILED, &why);
        return Some(not_applied(&why));
    }
    let row = at.split_whitespace().nth(1).map(str::to_string);
    let is = |oid: &str| [row.as_deref(), stopped_at.as_deref()].into_iter().flatten().any(|x| x.len() >= 7 && oid.starts_with(x));
    // The Edit row's new message, once per stop: never over a message typed there since.
    let file = if stop_note(&git_dir, MESSAGE_APPLIED, &at).is_some() { None } else { s.edit_messages.iter().find(|(oid, _)| is(oid)).map(|(_, f)| f.clone()) };
    match edit_stop {
        // UX L: git's own Edit stop, nothing done there yet: "about to commit", the row's new
        // message in the box.
        Some(made) if made == head && matches!(at.split_whitespace().next(), Some("edit" | "e")) => {
            if file.is_some() {
                note(MESSAGE_APPLIED, "");
            }
            super::edit::stage_edit_stop(cx, &git_dir, &at, &made, file.as_deref()).await;
            None
        }
        None if edit_conflict => {
            let file = file?;
            let path = git_dir.join("rebase-merge/message");
            let res = std::fs::copy(&file, &path);
            note(MESSAGE_APPLIED, "");
            let why = format!("{}: {}", path.display(), res.err()?);
            // M1: the stop stands; the commit keeps git's message, and the panel says so.
            tracing::warn!(target: "gitbolt_core::write", "applying an Edit row's new message: {why}");
            if let Ok(m) = std::fs::read_to_string(&file) {
                note(REFUSED, &format!("{head}\n{m}"));
            }
            note(MESSAGE_FAILED, &why);
            Some(not_applied(&why))
        }
        _ => None,
    }
}

/// A message typed at a refused reword's stop was amended in (the 3C final ruling): the stop's
/// refusal notes go, and `MESSAGE_APPLIED` keeps a later failure there from reading as one.
pub(crate) fn refused_message_applied(git_dir: &Path) {
    use crate::in_progress::{last_done, write_stop_note, MESSAGE_APPLIED, MESSAGE_FAILED, REFUSED};
    for name in [MESSAGE_FAILED, REFUSED] {
        if let Err(e) = std::fs::remove_file(git_dir.join(name))
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(target: "gitbolt_core::write", "removing {name}: {e}");
        }
    }
    if let Some(at) = last_done(git_dir)
        && let Err(e) = write_stop_note(git_dir, MESSAGE_APPLIED, &at, "")
    {
        tracing::warn!(target: "gitbolt_core::write", "noting the applied message: {e}");
    }
}

/// HEAD's first-parent ancestor `n` back (M4: the reworded commit); `None`, logged, if it can't
/// be read: the reword itself completed.
async fn first_parent_back(root: &Path, n: usize) -> Option<String> {
    let root = root.to_path_buf();
    let res = crate::api::blocking(move || {
        let repo = gix::open(&root).map_err(crate::error::gix_err)?;
        let mut at = repo.head_id().map_err(crate::error::gix_err)?.detach();
        for _ in 0..n {
            let c = repo.find_commit(at).map_err(crate::error::gix_err)?;
            at = c.parent_ids().next().ok_or_else(|| GbError::other("the reworded commit's history is shorter than its range"))?.detach();
        }
        Ok(at.to_string())
    })
    .await;
    res.inspect_err(|e| tracing::warn!(target: "gitbolt_core::write", "finding the reworded commit: {e}")).ok()
}

/// `InProgress::Rebase.gitbolt`: the session's mark in git's `rebase-merge/` (fix round 2).
fn mark_gitbolt(root: &Path, dir: &Path) {
    let res = gix::open(root).map_err(|e| e.to_string()).and_then(|r| std::fs::write(r.git_dir().join(crate::in_progress::GITBOLT_MARKER), format!("{}\n", dir.display())).map_err(|e| e.to_string()));
    if let Err(e) = res {
        tracing::warn!(target: "gitbolt_core::write", "marking the interactive rebase as GitBolt's: {e}");
    }
}

/// The interactive rebase session of the worktree's paused entry, if any (read under the lock).
pub(crate) fn session_of_pause(cx: &WriteCx<'_>) -> Result<Option<IrebaseState>, GbError> {
    let journal = cx.api.journal(cx.root)?.load()?;
    Ok(journal.paused().and_then(|e| e.paused.as_ref()).and_then(|p| p.irebase.clone()))
}

/// After a Continue or Skip of a paused interactive rebase (`RebaseControl`). Completed: the
/// moves the todo's `update-ref` lines made, then the chips marked delete, all recorded on the
/// paused entry as they happen (I1); a chip that couldn't be deleted is the outcome's warning
/// (R1). Stopped again: the next stop's Edit message.
pub(crate) async fn after_step(cx: &mut WriteCx<'_>, s: &IrebaseState, out: IntegrateOutcome, failed: Option<&GbError>) -> Result<IntegrateOutcome, GbError> {
    match out {
        IntegrateOutcome::Done { commits, fast_forward, rewritten, .. } => {
            let warning = completed_step(cx, s).await;
            Ok(IntegrateOutcome::Done { commits, fast_forward, warning, rewritten })
        }
        IntegrateOutcome::UpToDate { .. } => {
            let warning = completed_step(cx, s).await;
            Ok(IntegrateOutcome::UpToDate { warning })
        }
        IntegrateOutcome::Stopped { kind, files, warning } => {
            let warning = at_stop(cx, s, failed).await.or(warning);
            Ok(IntegrateOutcome::Stopped { kind, files, warning })
        }
        o => Ok(o),
    }
}

/// Fix round 2 (minor): the rebase completed, so nothing here fails it: a ref that can't be
/// read or a move the journal can't record is logged, and the outcome's warning says so.
async fn completed_step(cx: &mut WriteCx<'_>, s: &IrebaseState) -> Option<String> {
    let mut warnings = Vec::new();
    let recorded = match update_ref_moves(cx, &s.update_refs).await {
        Ok(moved) => record_on_paused(cx, moved, Vec::new()),
        Err(e) => Err(e),
    };
    if let Err(e) = recorded {
        tracing::warn!(target: "gitbolt_core::write", "recording the moved branches of the completed rebase: {e}");
        warnings.push("Undo may not put every moved branch back: the journal couldn't record them".to_string());
    }
    warnings.extend(delete_chips(cx, &s.delete_after, RecordIn::Paused).await);
    (!warnings.is_empty()).then(|| warnings.join(". "))
}

/// The refs the plan was made against, rebuilt from the range as it is now: the branch, every
/// chip's branch, and the base's ref with its own (unpeeled) value, never the commit it peels to.
/// Each must be in the request's `expect` with that value, so a branch or base that moved, or
/// one the request didn't vouch for, never reaches git.
fn check_expect(branch: &str, range: &Range, expect: &Expect) -> Result<(), GbError> {
    let mut need = vec![(format!("refs/heads/{branch}"), Some(range.head.to_string()))];
    need.extend(range.chips.iter().map(|c| (format!("refs/heads/{}", c.branch), range.tips.get(&c.branch).cloned())));
    if let (Some(r), Some(at)) = (&range.base_ref, range.base_ref_target) {
        need.push((r.clone(), Some(at.to_string())));
    }
    for (name, now) in need {
        match expect.refs.get(&name) {
            None => return Err(invalid(format!("The plan doesn't say where {} was: reload it", short_ref(&name)))),
            Some(want) if *want != now => return Err(GbError::ref_moved(&name)),
            Some(_) => {}
        }
    }
    Ok(())
}

/// The chips reach `build` as the request sent them. Every chip of the range must be there (one
/// left out would stay on the old commits), and only the range's chips move or go: any other
/// existing branch is refused rather than moved.
fn check_chips(branch: &str, range: &Range, chips: &[ChipPlan]) -> Result<(), GbError> {
    let ours: HashSet<&str> = range.chips.iter().map(|c| c.branch.as_str()).collect();
    for c in chips {
        // `build` keeps the rebased branch on top, and refuses a new chip whose name exists.
        if c.branch == branch || matches!(c.at, ChipAt::New(_)) {
            continue;
        }
        if !ours.contains(c.branch.as_str()) {
            return Err(invalid(format!("{} isn't one of {branch}'s branches: reload the plan", c.branch)));
        }
    }
    let sent: HashSet<&str> = chips.iter().map(|c| c.branch.as_str()).collect();
    if let Some(c) = range.chips.iter().find(|c| !sent.contains(c.branch.as_str())) {
        return Err(invalid(format!("The plan doesn't match {branch}'s branches any more ({} is missing): reload it", c.branch)));
    }
    Ok(())
}

impl WriteIntent for IrebaseIntent {
    type Outcome = IntegrateOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Rebase
    }
    fn label(&self) -> String {
        self.label.clone()
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Rewind)
    }
    fn rewrite(&self) -> Option<crate::write::rewrites::RewriteKind> {
        Some(crate::write::rewrites::RewriteKind::Rebase)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn traces_hooks(&self) -> bool {
        false
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if pre.before.head.branch.as_deref() != Some(self.branch.as_str()) {
            return Err(invalid(format!("Check out {} to rebase it", self.branch)));
        }
        let range = read_range(&pre.api.cli, pre.root, &self.branch, &self.base, MAX_ROWS).await?;
        let (rows, chips) = match &self.source {
            Source::Plan { rows, chips } => {
                check_expect(&self.branch, &range, pre.expect)?;
                let want: HashSet<&str> = range.rows.iter().map(|r| r.oid.as_str()).collect();
                let got: HashSet<&str> = rows.iter().map(|r| r.oid.as_str()).collect();
                if rows.len() != range.rows.len() || want != got {
                    return Err(invalid(format!("The plan doesn't match {}'s commits any more: reload it", self.branch)));
                }
                check_chips(&self.branch, &range, chips)?;
                (rows.clone(), chips.clone())
            }
            // The rows and chips are the range's own, read under the lock: preflight's HEAD check
            // (`expect.head`) is what the request vouches for.
            Source::Reword { oid, message } => super::reword::rows_for(&range, &self.branch, oid, message)?,
        };
        let by_oid: HashMap<&str, &super::plan::RangeRow> = range.rows.iter().map(|r| (r.oid.as_str(), r)).collect();
        let planned_rows = rows
            .iter()
            .map(|r| {
                let c = by_oid[r.oid.as_str()];
                PlannedRow { oid: r.oid.clone(), action: r.action, message: r.message.clone(), original: c.message.clone(), guard: c.guard.clone() }
            })
            .collect();
        let dir = session_dir(pre.api);
        let todo = build(&TodoPlan { branch: self.branch.clone(), base: range.base.to_string(), rows: planned_rows, chips, tips: range.tips.clone(), locked: range.locked.clone(), dir: dir.clone() })?;
        let watch = todo.update_refs.iter().map(|b| (format!("refs/heads/{b}"), range.tips.get(b).cloned())).collect();
        let deletes = todo.deletes.iter().map(|b| (format!("refs/heads/{b}"), range.tips[b].clone())).collect();
        // 2C repo-safety, as RebaseIntent's: the rebase checks the base out first.
        let rule = crate::write::precheck::refuse_repos_in_the_way(&pre.api.cli, pre.root, range.head, range.base, "rebase").await?.rule_over(AutostashRule::Rebased);
        // A reword's range has no merges (`rows_for` refuses them): every row is a first parent.
        let reword_depth = match &self.source {
            Source::Reword { oid, .. } => range.rows.iter().position(|r| &r.oid == oid),
            Source::Plan { .. } => None,
        };
        let _ = self.planned.set(Planned { base: range.base, todo, dir, watch, deletes, reword_depth });
        // A full ref (3D's `refs/remotes/origin/main`) reads short in the autostash copy.
        let shown = short_ref(&self.base).to_string();
        Ok(Plan { autostash: Some(AutostashSpec { rule, target: Some(range.base), op: format!("rebase onto {shown}"), target_name: Some(shown) }), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<IntegrateOutcome, GbError> {
        let p = self.planned.get().ok_or_else(|| GbError::other("interactive rebase ran without its plan"))?;
        let todo = write_session(&p.dir, &p.todo)?;
        // Verify records exactly these besides HEAD's branch: the moved and created chips, the deleted ones.
        cx.watch_refs(p.watch.iter().cloned());
        cx.watch_refs(p.deletes.iter().map(|(n, o)| (n.clone(), Some(o.clone()))));
        let mut args: Vec<String> = GIT_PINS.iter().map(|s| s.to_string()).collect();
        // `--no-reschedule-failed-exec`: a message script that failed (a commit-msg hook) stops
        // the rebase once, and is never run again behind the user's back.
        args.extend(["rebase".to_string(), "-i".into(), "--empty=drop".into(), "--no-reschedule-failed-exec".into(), p.base.to_string()]);
        let editor = format!("cp {}", sh_quote(&todo.display().to_string()));
        // The pause banner names the base short, as the label does.
        let mut failed = None;
        let out = run_rebase_stop(cx, args, short_ref(&self.base), Some(p.base), vec![("GIT_SEQUENCE_EDITOR".into(), editor.into())], &mut failed).await;
        match out {
            Ok(IntegrateOutcome::Done { commits, fast_forward, .. }) => {
                remove_session(&p.dir);
                let warning = delete_chips(cx, &p.deletes, RecordIn::Entry).await;
                let rewritten = match p.reword_depth {
                    Some(n) => first_parent_back(cx.root, n).await,
                    None => None,
                };
                Ok(IntegrateOutcome::Done { commits, fast_forward, warning, rewritten })
            }
            Ok(IntegrateOutcome::UpToDate { .. }) => {
                remove_session(&p.dir);
                let warning = delete_chips(cx, &p.deletes, RecordIn::Entry).await;
                Ok(IntegrateOutcome::UpToDate { warning })
            }
            // T4: the pause carries the session (its messages, its deletes) to Continue.
            Ok(IntegrateOutcome::Stopped { kind, files, warning: stopped }) => {
                let state = p.state();
                if let Some(pause) = cx.paused.as_mut() {
                    pause.irebase = Some(state.clone());
                }
                mark_gitbolt(cx.root, &p.dir);
                // M1: the pause stands whatever happens to the stop's message.
                let warning = at_stop(cx, &state, failed.as_ref()).await.or(stopped);
                Ok(IntegrateOutcome::Stopped { kind, files, warning })
            }
            Ok(o) => {
                remove_session(&p.dir);
                Ok(o)
            }
            Err(e) => {
                if cx.paused.is_none() {
                    remove_session(&p.dir);
                }
                Err(e)
            }
        }
    }
}

#[allow(clippy::too_many_arguments)] // the request's fields, as dispatch passes them
pub(crate) async fn interactive_rebase(api: &Api, repo: u32, worktree: &str, branch: String, base: String, expect: BTreeMap<String, String>, rows: Vec<RebaseRow>, chips: Vec<ChipPlan>, confirm: Confirm) -> Result<WriteResult<IntegrateOutcome>, GbError> {
    let expect = Expect { head: None, refs: expect.into_iter().map(|(k, v)| (k, Some(v))).collect() };
    let label = format!("interactive rebase {branch} onto {}", short_ref(&base));
    run_write(api, repo, worktree, expect, IrebaseIntent { branch, base, source: Source::Plan { rows, chips }, confirm, label, planned: OnceLock::new() }).await
}

/// Shared with `split.rs`, `reword.rs` and `predict.rs`'s tests (`super::run::tests::*`).
#[cfg(test)]
pub(crate) mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::{fixtures, TestRepo};
    use crate::write::test_support::{api, call, journal_step, open, wt};
    use serde_json::{json, Value};

    pub(crate) async fn plan(api: &crate::api::Api, id: u32, r: &TestRepo) -> Value {
        call(api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main" })).await.unwrap()
    }

    /// The plan's oid for the row whose summary starts with `prefix` ("A3").
    pub(crate) fn oid(p: &Value, prefix: &str) -> String {
        p["rows"].as_array().unwrap().iter().find(|r| r["summary"].as_str().unwrap().starts_with(prefix)).unwrap_or_else(|| panic!("{prefix}"))["oid"].as_str().unwrap().to_string()
    }

    /// The plan's rows, newest first, every one Pick.
    pub(crate) fn picks(p: &Value) -> Vec<Value> {
        p["rows"].as_array().unwrap().iter().map(|r| json!({ "oid": r["oid"], "action": "pick" })).collect()
    }

    /// Rows in this order (summary prefixes, newest first), every one Pick.
    pub(crate) fn order(p: &Value, prefixes: &[&str]) -> Vec<Value> {
        prefixes.iter().map(|x| json!({ "oid": oid(p, x), "action": "pick" })).collect()
    }

    pub(crate) fn set(p: &Value, rows: &mut [Value], prefix: &str, action: &str, message: Option<&str>) {
        let o = oid(p, prefix);
        let r = rows.iter_mut().find(|r| r["oid"] == o.as_str()).unwrap();
        r["action"] = json!(action);
        if let Some(m) = message {
            r["message"] = json!(m);
        }
    }

    /// Every chip where the plan has it.
    pub(crate) fn stay(p: &Value) -> Vec<Value> {
        p["chips"].as_array().unwrap().iter().map(|c| json!({ "branch": c["branch"], "at": { "kind": "row", "oid": c["at"] } })).collect()
    }

    pub(crate) fn chip(chips: &mut Vec<Value>, branch: &str, at: Value) {
        chips.retain(|c| c["branch"] != branch);
        chips.push(json!({ "branch": branch, "at": at }));
    }

    pub(crate) async fn start(api: &crate::api::Api, id: u32, r: &TestRepo, p: &Value, rows: Vec<Value>, chips: Vec<Value>) -> Result<Value, crate::error::GbError> {
        call(api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main", "expect": p["expect"], "rows": rows, "chips": chips })).await
    }

    pub(crate) fn subjects(r: &TestRepo, range: &str) -> Vec<String> {
        r.git(&["log", "--format=%s", range]).lines().map(str::to_string).collect()
    }

    pub(crate) fn tips(r: &TestRepo) -> Vec<String> {
        ["feature/a", "feature/b", "feature/c"].iter().map(|b| r.git(&["rev-parse", b])).collect()
    }

    pub(crate) fn sessions_left(data: &std::path::Path) -> usize {
        std::fs::read_dir(data.join("irebase")).map(|d| d.count()).unwrap_or(0)
    }

    /// §3.3, §3.4: a reorder, a squash and a chip that follows its row into the squash group, in
    /// one rebase; merges flattened; one Undo puts all three branches back.
    #[tokio::test]
    async fn reorder_squash_and_a_moved_chip_in_one_rebase_and_one_undo() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = order(&p, &["C1", "C2", "B2", "S1", "B1", "A3", "A2", "A1"]);
        set(&p, &mut rows, "A3", "squash", None);
        let res = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(subjects(&r, "main..feature/c"), ["C1 Edit notes again", "C2 Polish", "B2 Refine lexer", "S1 Side work", "B1 Add lexer", "A2 Edit notes", "A1 Add parser"]);
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/a"]), "A2 Edit notes\n\nA3 Add tests", "the merged default; feature/a followed A3 into A2's group");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/b"]), "B2 Refine lexer");
        assert_eq!(r.git(&["rev-list", "--merges", "main..feature/c"]), "", "flattened");
        assert_eq!(res["journal"]["undo"]["label"], "interactive rebase feature/c onto main");
        assert_eq!(sessions_left(data.path()), 0, "the session directory is gone");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(tips(&r), before, "one Undo restores every branch");
        assert_eq!(r.git(&["branch", "--show-current"]), "feature/c");
    }

    /// Review Focus 3: a message with shell characters, and a data directory with a space; a new
    /// chip and a deleted one, both undone by the same Undo.
    #[tokio::test]
    async fn reword_with_quotes_and_a_new_and_a_deleted_chip() {
        let data = tempfile::Builder::new().prefix("gitbolt data ").tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let msg = "B1 'quoted' $(touch pwned) `touch pwned2`\n\nBody line";
        let mut rows = picks(&p);
        set(&p, &mut rows, "B1", "reword", Some(msg));
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
        chip(&mut chips, "feature/new", json!({ "kind": "new", "oid": oid(&p, "B1") }));
        let res = start(&api, id, &r, &p, rows, chips).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/new"]), msg);
        assert!(!r.path().join("pwned").exists() && !r.path().join("pwned2").exists(), "the message never ran");
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/a"]).is_err(), "feature/a deleted");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(tips(&r), before);
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/new"]).is_err(), "the new branch goes with the Undo");
    }

    /// Drop and Fixup; a dirty file is autostashed and restored.
    #[tokio::test]
    async fn drop_and_fixup_keep_the_targets_message_and_the_users_changes() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.write("lexer.txt", "dirty\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "C2", "drop", None);
        set(&p, &mut rows, "A3", "fixup", None);
        start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        let s = subjects(&r, "main..feature/c");
        assert_eq!(s.first().map(String::as_str), Some("C1 Edit notes again"));
        assert!(!s.iter().any(|x| x.starts_with("C2") || x.starts_with("A3")), "{s:?}");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/a"]), "A2 Edit notes");
        assert_eq!(std::fs::read_to_string(r.path().join("lexer.txt")).unwrap(), "dirty\n");
    }

    /// Review Focus 2: the user's rebase settings don't change the plan.
    #[tokio::test]
    async fn the_users_rebase_config_doesnt_change_the_plan() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        for (k, v) in [("rebase.missingCommitsCheck", "error"), ("core.commentChar", ";"), ("rebase.autoSquash", "true"), ("rebase.updateRefs", "true"), ("rebase.abbreviateCommands", "true")] {
            r.git(&["config", k, v]);
        }
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "C2", "drop", None);
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "row", "oid": oid(&p, "A2") }));
        let res = start(&api, id, &r, &p, rows, chips).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/c"]), "C1 Edit notes again");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/a"]), "A2 Edit notes", "moved down one row, as planned");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/b"]), "B2 Refine lexer");
    }

    /// Review Focus 5: a commit added in a terminal since the plan refuses the Start; nothing drops it.
    #[tokio::test]
    async fn a_moved_branch_refuses_with_ref_moved() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let added = r.commit("Terminal work");
        let e = start(&api, id, &r, &p, picks(&p), stay(&p)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::RefMoved);
        assert_eq!(r.git(&["rev-parse", "feature/c"]), added);
    }

    #[tokio::test]
    async fn rows_that_dont_match_the_range_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        rows.pop(); // A1 left out: git would drop it
        let e = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert!(e.message.contains("doesn't match"), "{}", e.message);
        assert_eq!(tips(&r), before);
    }

    /// §3.3 refusals: a chip checked out in another worktree can't move; on its own tip it stays.
    #[tokio::test]
    async fn a_chip_checked_out_elsewhere_stays_where_it_is() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.add_worktree("wt-a", "feature/a");
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "row", "oid": oid(&p, "A2") }));
        let e = start(&api, id, &r, &p, picks(&p), chips).await.unwrap_err();
        assert!(e.message.starts_with("feature/a can't move: checked out in"), "{}", e.message);
        let mut rows = picks(&p);
        set(&p, &mut rows, "C2", "drop", None);
        start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(tips(&r)[0], before[0], "feature/a stayed");
        assert_ne!(tips(&r)[2], before[2]);
    }

    /// The chips are checked before the todo is built: a branch outside the range can't be moved
    /// or deleted through it, and a range chip left out of the request refuses the Start.
    #[tokio::test]
    async fn chips_outside_the_range_or_left_out_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let main = r.git(&["rev-parse", "main"]);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        for at in [json!({ "kind": "row", "oid": oid(&p, "A1") }), json!({ "kind": "delete" })] {
            let mut chips = stay(&p);
            chip(&mut chips, "main", at);
            let e = start(&api, id, &r, &p, picks(&p), chips).await.unwrap_err();
            assert_eq!(e.kind, GbErrorKind::InvalidInput);
            assert_eq!(e.message, "main isn't one of feature/c's branches: reload the plan");
        }
        let chips: Vec<Value> = stay(&p).into_iter().filter(|c| c["branch"] != "feature/a").collect();
        let e = start(&api, id, &r, &p, picks(&p), chips).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert!(e.message.contains("(feature/a is missing)"), "{}", e.message);
        assert_eq!((tips(&r), r.git(&["rev-parse", "main"])), (before, main));
        assert_eq!(sessions_left(data.path()), 0);
    }

    /// The request's `expect` must vouch for every ref the plan was made against: one left out
    /// (here the base's) refuses the Start rather than going unchecked.
    #[tokio::test]
    async fn an_expect_without_the_base_ref_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let mut p = plan(&api, id, &r).await;
        p["expect"].as_object_mut().unwrap().remove("refs/heads/main");
        let e = start(&api, id, &r, &p, picks(&p), stay(&p)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert_eq!(e.message, "The plan doesn't say where main was: reload it");
        assert_eq!(tips(&r), before);
    }

    /// Ruling (3B T3 × 3C T1): an annotated tag as the base. `expect` holds the tag ref's own
    /// value (the tag object), which preflight's `read_ref` reads unpeeled, so the ref check
    /// passes and the rows replay onto the commit it peels to.
    #[tokio::test]
    async fn an_annotated_tag_base_passes_the_ref_check() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.git(&["tag", "-a", "v1.0", "-m", "Release 1.0", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "v1.0" })).await.unwrap();
        assert_ne!(p["expect"]["refs/tags/v1.0"], r.git(&["rev-parse", "main"]).as_str(), "the tag object, not the commit");
        let mut rows = picks(&p);
        set(&p, &mut rows, "C2", "drop", None);
        let res = call(&api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "v1.0", "expect": p["expect"], "rows": rows, "chips": stay(&p) })).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["merge-base", "feature/c", "main"]), r.git(&["rev-parse", "main"]), "onto the commit v1.0 peels to");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/c"]), "C1 Edit notes again");
        assert_eq!(res["journal"]["undo"]["label"], "interactive rebase feature/c onto v1.0");
    }

    /// Ruling F7: a full base ref (3D sends `refs/heads/main`) reads short in the label and the
    /// pause banner. C1 replayed before A2 conflicts on notes.txt.
    #[tokio::test]
    async fn a_full_base_ref_reads_short_in_the_pause_banner() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "refs/heads/main" })).await.unwrap();
        let rows = order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        let res = call(&api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "refs/heads/main", "expect": p["expect"], "rows": rows, "chips": stay(&p) })).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped", "{res}");
        assert_eq!(res["journal"]["paused"]["target"], "main");
        assert_eq!(res["journal"]["paused"]["label"], "interactive rebase feature/c onto main");
    }

    // --- 3C T4 ---
    pub(crate) async fn control(api: &crate::api::Api, id: u32, r: &TestRepo, action: &str) -> Value {
        call(api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": action })).await.unwrap()
    }

    fn in_progress(r: &TestRepo) -> crate::in_progress::InProgress {
        crate::in_progress::read(r.path()).unwrap().expect("a rebase in progress")
    }

    /// `branch.<b>` upstream config, as a pushed branch has it.
    fn upstream(r: &TestRepo, b: &str) {
        r.git(&["config", &format!("branch.{b}.remote"), "origin"]);
        r.git(&["config", &format!("branch.{b}.merge"), &format!("refs/heads/{b}")]);
    }

    fn remote_of(r: &TestRepo, b: &str) -> Option<String> {
        r.try_git(&["config", &format!("branch.{b}.remote")]).ok()
    }

    /// §3.3 Edit, UX L: the stop is "about to commit" (HEAD on the commit's parent, its changes
    /// staged) with the row's new message in the box (Ruling 4); Continue commits it with that
    /// message and finishes, and one Undo undoes it all.
    #[tokio::test]
    async fn an_edit_row_stops_with_its_new_message_and_continue_finishes() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", Some("B2 Refine the lexer\n\nReworded for the stop"));
        let res = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped");
        assert_eq!(res["journal"]["paused"]["kind"], "rebase");
        let head = r.git(&["rev-parse", "HEAD"]);
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "S1 Side work", "HEAD on B2's parent (S1, the merge flattened)");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "lexer.txt\nlexer_test.txt", "B2's changes staged");
        match in_progress(&r) {
            crate::in_progress::InProgress::Rebase { edit_stop, edit_base, message, conflicted, gitbolt, .. } => {
                assert!(gitbolt, "GitBolt's own interactive rebase (fix round 2)");
                let made = edit_stop.expect("git's amend file names the commit it made");
                assert_eq!(r.git(&["log", "-1", "--format=%s", &made]), "B2 Refine lexer", "not amended at the stop");
                assert_eq!(edit_base.as_deref(), Some(head.as_str()));
                assert_eq!(message.trim_end(), "B2 Refine the lexer\n\nReworded for the stop");
                assert_eq!(conflicted, 0);
            }
            other => panic!("{other:?}"),
        }
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/b"]), "B2 Refine the lexer", "feature/b followed its row");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(tips(&r), before);
        assert_eq!(sessions_left(data.path()), 0);
    }

    /// Review Focus 4: paused at an Edit stop with a chip delete and a new chip pending, GitBolt
    /// restarts (a fresh Api on the same data dir). Continue there completes the rebase and runs
    /// the delete, and one Undo restores all of it, the deleted chip's upstream config included.
    #[tokio::test]
    async fn a_paused_irebase_completes_after_a_restart_and_undoes_in_one_step() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        upstream(&r, "feature/a");
        let before = tips(&r);
        {
            // The first process: Start, then it stops at B1.
            let api = api(data.path());
            let id = open(&api, &r).await;
            let p = plan(&api, id, &r).await;
            let mut rows = picks(&p);
            set(&p, &mut rows, "B1", "edit", None);
            let mut chips = stay(&p);
            chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
            chip(&mut chips, "feature/new", json!({ "kind": "new", "oid": oid(&p, "C1") }));
            assert_eq!(start(&api, id, &r, &p, rows, chips).await.unwrap()["outcome"]["status"], "stopped");
        }
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/a"]).is_ok(), "nothing is deleted at a pause");
        assert_eq!(remote_of(&r, "feature/a").as_deref(), Some("origin"));
        assert_eq!(sessions_left(data.path()), 1, "the session waits with the pause");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done");
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/a"]).is_err(), "deleted once it completed");
        assert_eq!(remote_of(&r, "feature/a"), None, "its config went with it");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/new"]), "C1 Edit notes again");
        assert_eq!(sessions_left(data.path()), 0);
        assert_eq!(res["journal"]["undo"]["label"], "interactive rebase feature/c onto main");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(tips(&r), before, "one Undo: the rebase and the delete");
        assert_eq!(remote_of(&r, "feature/a").as_deref(), Some("origin"), "and the deleted chip's upstream");
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/new"]).is_err());
    }

    /// Review Focus 1: C1 is reworded and moved below A2, where it conflicts. A Skip there must
    /// not reword A1, the commit HEAD is left on.
    #[tokio::test]
    async fn a_skipped_reword_leaves_the_previous_message() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        set(&p, &mut rows, "C1", "reword", Some("C1, reworded"));
        let res = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped", "C1 conflicts onto A1");
        let res = control(&api, id, &r, "skip").await;
        assert_eq!(res["outcome"]["status"], "done");
        let all = r.git(&["log", "--format=%s", "main..feature/c"]);
        assert!(all.contains("A1 Add parser"), "{all}");
        assert!(!all.contains("C1, reworded"), "{all}");
    }

    /// Abort restores everything, and deletes nothing (§3.4).
    #[tokio::test]
    async fn abort_restores_everything_and_deletes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", None);
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
        start(&api, id, &r, &p, rows, chips).await.unwrap();
        let res = control(&api, id, &r, "abort").await;
        assert_eq!(res["outcome"]["status"], "aborted");
        assert!(res["outcome"]["stash"].is_null(), "no work at the stop, no stash: {res}");
        assert_eq!(tips(&r), before);
        assert!(crate::in_progress::read(r.path()).unwrap().is_none());
        assert_eq!(sessions_left(data.path()), 0, "the session goes with the abort");
    }

    /// Controller ruling (T3 review): Continue, Skip and Abort run with the Start's pins, under
    /// the user's `core.commentChar=;` here. Git strips the todo's `# dropped` lines once the
    /// sequence editor returns, so a Continue past a dropped row finishes; and at a conflict stop
    /// git's message carries `# Conflicts:` lines, which a Continue under `;` would keep.
    #[tokio::test]
    async fn continue_runs_with_the_pins_under_the_users_comment_char() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.git(&["config", "core.commentChar", ";"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        // An Edit stop before a dropped row.
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", None);
        set(&p, &mut rows, "C2", "drop", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        let s = subjects(&r, "main..feature/c");
        assert_eq!(s[0], "C1 Edit notes again");
        assert!(!s.iter().any(|x| x.starts_with("C2")), "{s:?}");
        // A conflict stop: C1 moved below A2.
        let p = plan(&api, id, &r).await;
        let rows = order(&p, &["B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        r.write("notes.txt", "one\ntwo, revised\nthree\n");
        r.git(&["add", "notes.txt"]);
        let res = control(&api, id, &r, "continue").await;
        assert_ne!(res["outcome"]["status"], "aborted", "{res}");
        let msg = r.git(&["log", "--format=%B", "--grep=^C1", "-1", "HEAD"]);
        assert_eq!(msg.trim_end(), "C1 Edit notes again", "no conflict comments kept");
    }

    /// A plan whose only change is a chip delete: git has nothing to replay (UpToDate), and the
    /// delete still runs, journaled with its config, so Undo restores the branch and its upstream.
    #[tokio::test]
    async fn a_chip_only_delete_runs_when_git_has_nothing_to_replay() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        upstream(&r, "feature/a");
        let a = r.git(&["rev-parse", "feature/a"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main~1" })).await.unwrap();
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
        let res = call(&api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main~1", "expect": p["expect"], "rows": picks(&p), "chips": chips })).await.unwrap();
        assert_eq!(res["outcome"]["status"], "upToDate", "{res}");
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/a"]).is_err());
        assert_eq!(remote_of(&r, "feature/a"), None);
        assert_eq!(sessions_left(data.path()), 0);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "feature/a"]), a);
        assert_eq!(remote_of(&r, "feature/a").as_deref(), Some("origin"), "Undo restores the upstream too");
    }
    // --- end 3C T4 ---

    // --- 3C fix round 1 ---
    /// The stack fixture's plan from `main~1` (Base): every row already on its base, so git
    /// fast-forwards each pick and the branch's tip stays where it was.
    async fn base_plan(api: &crate::api::Api, id: u32, r: &TestRepo) -> Value {
        call(api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main~1" })).await.unwrap()
    }

    async fn base_start(api: &crate::api::Api, id: u32, r: &TestRepo, p: &Value, rows: Vec<Value>, chips: Vec<Value>) -> Value {
        call(api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main~1", "expect": p["expect"], "rows": rows, "chips": chips })).await.unwrap()
    }

    /// I1: an Edit row and a Continue that changes nothing leave the branch's tip where it was,
    /// so settle's verdict is "not completed". The chip delete and the chip the todo created
    /// were still made, and the Undo restores both (the deleted branch's upstream too).
    #[tokio::test]
    async fn chip_moves_survive_a_completion_that_left_the_tip_unchanged() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        upstream(&r, "feature/a");
        let (a, c) = (r.git(&["rev-parse", "feature/a"]), r.git(&["rev-parse", "feature/c"]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = base_plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "Work on feature/c", "edit", None);
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
        chip(&mut chips, "feature/new", json!({ "kind": "new", "oid": oid(&p, "Work on feature/b") }));
        assert_eq!(base_start(&api, id, &r, &p, rows, chips).await["outcome"]["status"], "stopped");
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["rev-parse", "feature/c"]), c, "the tip didn't move");
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/a"]).is_err());
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/new"]).is_ok());
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "feature/a"]), a, "the deleted chip is back");
        assert_eq!(remote_of(&r, "feature/a").as_deref(), Some("origin"));
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/new"]).is_err(), "the created chip is gone");
    }

    /// R1: a delete-marked chip that moved during the pause can't be deleted: the rebase still
    /// succeeds, the outcome's warning names it, and it stays where the user put it.
    #[tokio::test]
    async fn a_chip_that_moved_during_the_pause_is_kept_with_a_warning() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", None);
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
        assert_eq!(start(&api, id, &r, &p, rows, chips).await.unwrap()["outcome"]["status"], "stopped");
        let elsewhere = r.git(&["rev-parse", "feature/a~1"]); // the old A2: not in the rebased history
        r.git(&["branch", "-f", "feature/a", &elsewhere]);
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(res["outcome"]["warning"], "feature/a wasn't deleted: it changed during the rebase");
        assert_eq!(r.git(&["rev-parse", "feature/a"]), elsewhere);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "feature/a"]), elsewhere, "the user's move isn't the rebase's to undo");
    }

    /// M5: a delete-marked chip the user deleted during the pause is skipped, with no warning,
    /// and the Undo doesn't bring back what the rebase didn't delete.
    #[tokio::test]
    async fn a_chip_the_user_deleted_during_the_pause_is_skipped() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", None);
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "delete" }));
        assert_eq!(start(&api, id, &r, &p, rows, chips).await.unwrap()["outcome"]["status"], "stopped");
        r.git(&["branch", "-D", "feature/a"]);
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert!(res["outcome"]["warning"].is_null(), "{res}");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/feature/a"]).is_err(), "the user's delete stays");
    }
    // --- end 3C fix round 1 ---

    // --- 3C fix round 2: ChipAt::Stay (3D's Rebase stack) ---
    /// A stack member already cherry-picked into the base (upstream by patch-id, not by
    /// ancestry) sent as Stay: it stays on its old commit, the others move, and the Undo leaves
    /// it alone too.
    #[tokio::test]
    async fn a_stay_chip_is_never_moved() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.switch("main");
        r.git(&["cherry-pick", "feature/a"]);
        r.switch("feature/c");
        let before: Vec<String> = ["feature/a", "feature/b", "feature/c"].iter().map(|b| r.git(&["rev-parse", b])).collect();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        assert_eq!(p["rows"].as_array().unwrap().iter().find(|x| x["summary"] == "Work on feature/a").unwrap()["upstream"], true);
        let mut chips = stay(&p);
        chip(&mut chips, "feature/a", json!({ "kind": "stay" }));
        let res = start(&api, id, &r, &p, picks(&p), chips).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["rev-parse", "feature/a"]), before[0], "feature/a stays");
        assert_ne!(r.git(&["rev-parse", "feature/b"]), before[1]);
        assert_ne!(r.git(&["rev-parse", "feature/c"]), before[2]);
        assert!(r.try_git(&["merge-base", "--is-ancestor", "main", "feature/b"]).is_ok(), "feature/b moved onto main");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        let after: Vec<String> = ["feature/a", "feature/b", "feature/c"].iter().map(|b| r.git(&["rev-parse", b])).collect();
        assert_eq!(after, before);
    }

    /// A branch in the range that isn't a stack member (a local main ahead of origin/main) sent
    /// as Stay stays, while its commit below the rebased branch is reworded.
    #[tokio::test]
    async fn a_non_member_branch_sent_as_stay_stays() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.commit("Base");
        r.add_origin();
        r.push("main");
        r.commit("Local main work");
        r.switch_new("feature/x");
        r.commit("X work");
        let main = r.git(&["rev-parse", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/x", "base": "origin/main" })).await.unwrap();
        assert!(p["chips"].as_array().unwrap().iter().any(|c| c["branch"] == "main"), "{p}");
        let mut rows = picks(&p);
        set(&p, &mut rows, "Local main work", "reword", Some("Local main work, reworded"));
        let mut chips = stay(&p);
        chip(&mut chips, "main", json!({ "kind": "stay" }));
        let res = call(&api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/x", "base": "origin/main", "expect": p["expect"], "rows": rows, "chips": chips })).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["rev-parse", "main"]), main, "main stays");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/x~1"]), "Local main work, reworded");
    }

    /// 3D review: a non-member checked out in another worktree is a locked chip; sent as Stay,
    /// it passes (no "can't move") and stays.
    #[tokio::test]
    async fn a_locked_non_member_sent_as_stay_stays() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.commit("Base");
        r.add_origin();
        r.push("main");
        r.commit("Local main work");
        r.switch_new("feature/x");
        r.commit("X work");
        r.add_worktree("wt-main", "main");
        let main = r.git(&["rev-parse", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/x", "base": "origin/main" })).await.unwrap();
        let locked = p["chips"].as_array().unwrap().iter().find(|c| c["branch"] == "main").cloned().unwrap_or_default();
        assert!(locked["locked"].as_str().is_some_and(|w| w.starts_with("checked out in")), "{p}");
        let mut rows = picks(&p);
        set(&p, &mut rows, "Local main work", "reword", Some("Local main work, reworded"));
        let mut chips = stay(&p);
        chip(&mut chips, "main", json!({ "kind": "stay" }));
        let res = call(&api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/x", "base": "origin/main", "expect": p["expect"], "rows": rows, "chips": chips })).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["rev-parse", "main"]), main, "main stays");
    }
    // --- end 3C fix round 2 ---

    // --- 3D T4: Rebase stack, composed from RebasePlan and InteractiveRebase ---
    /// The plan Rebase stack sends. Its source is 3D's `stackPlan` (ui/src/stacks/rebase.ts), and
    /// ui/src/stacks/rebase.test.ts is the real guard: these pin that composition over the core.
    /// Rows Pick, `upstream` rows Drop; every plan chip sent: a lower member whose tip row, or a
    /// row below it, is still replayed at its row, any other chip (a non-member included)
    /// `stay`; `expect` as the plan gives it (the base ref's from the unpeeled
    /// `Range::base_ref_target`, never from `base`).
    async fn stack_rebase(api: &crate::api::Api, id: u32, r: &TestRepo) {
        let lower = ["feature/a", "feature/b"];
        let p = call(api, "rebasePlan", json!({"repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main"})).await.unwrap();
        let rows = p["rows"].as_array().unwrap();
        let send: Vec<Value> = rows.iter().map(|x| json!({"oid": x["oid"], "action": if x["upstream"] == true { "drop" } else { "pick" }})).collect();
        let chips: Vec<Value> = p["chips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let at = rows.iter().position(|x| x["oid"] == c["at"]).unwrap();
                let member = lower.iter().any(|&m| c["branch"] == m);
                if member && rows[at..].iter().any(|x| x["upstream"] == false) {
                    json!({"branch": c["branch"], "at": {"kind": "row", "oid": c["at"]}})
                } else {
                    json!({"branch": c["branch"], "at": {"kind": "stay"}})
                }
            })
            .collect();
        call(api, "interactiveRebase", json!({"repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main", "expect": p["expect"], "rows": send, "chips": chips})).await.unwrap();
    }

    /// Spec #3 §3.11 over §3.3's update-ref todo: "Rebase stack" is one InteractiveRebase of the
    /// top. All three land on main in order; one Undo puts all three back (§3.4).
    #[tokio::test]
    async fn rebase_stack_moves_every_member_and_one_undo_restores_them() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let names = ["feature/a", "feature/b", "feature/c"];
        let tip = |b: &str| r.git(&["rev-parse", b]);
        let before: Vec<String> = names.iter().map(|&b| tip(b)).collect();
        stack_rebase(&api, id, &r).await;
        assert_eq!(tip("feature/a^"), tip("main"), "the bottom sits on main");
        assert_eq!(tip("feature/b^"), tip("feature/a"));
        assert_eq!(tip("feature/c^"), tip("feature/b"));
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        let after: Vec<String> = names.iter().map(|&b| tip(b)).collect();
        assert_eq!(after, before, "one undo restores every member");
    }

    /// 3D Review Focus 1: feature/a's commit was picked into main (a rebase merge upstream). Its
    /// row is dropped, as git's own todo would leave it out; feature/a's chip is sent as `stay`.
    #[tokio::test]
    async fn a_stack_member_already_in_the_base_stays_put() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.switch("main");
        r.git(&["cherry-pick", "feature/a"]);
        r.switch("feature/c");
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let tip = |b: &str| r.git(&["rev-parse", b]);
        let a = tip("feature/a");
        stack_rebase(&api, id, &r).await;
        assert_eq!(tip("feature/a"), a, "feature/a stays where it is");
        assert_eq!(tip("feature/b^"), tip("main"));
        assert_eq!(tip("feature/c^"), tip("feature/b"));
    }
    // --- end 3D T4 ---

    // --- 3C final fixes ---
    async fn control_with(api: &crate::api::Api, id: u32, r: &TestRepo, action: &str, message: &str) -> Value {
        call(api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": action, "message": message })).await.unwrap()
    }

    fn rebase_state(r: &TestRepo) -> (bool, Option<String>, u32, String) {
        match in_progress(r) {
            crate::in_progress::InProgress::Rebase { edit_conflict, message_failed, conflicted, message, .. } => (edit_conflict, message_failed, conflicted, message),
            other => panic!("{other:?}"),
        }
    }

    /// I1: an Edit row with a new message whose pick conflicts (C1 moved onto A1). Git won't stop
    /// for the Edit again, so the conflict stop is the Edit's: the new message is the one Continue
    /// commits with (and the panel's prefill), and a message typed there since isn't overwritten.
    #[tokio::test]
    async fn an_edit_row_that_conflicts_keeps_its_new_message() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        set(&p, &mut rows, "C1", "edit", Some("C1, edited at its conflict\n\nWhy."));
        let res = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped", "{res}");
        let (edit_conflict, failed, conflicted, message) = rebase_state(&r);
        assert!(edit_conflict && conflicted > 0 && failed.is_none());
        assert_eq!(message.trim_end(), "C1, edited at its conflict\n\nWhy.", "the panel prefills the new message");
        // A Continue with the conflict unresolved: the message typed there stays.
        let _ = call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "continue", "message": "C1, typed at the stop" })).await;
        assert_eq!(rebase_state(&r).3.trim_end(), "C1, typed at the stop", "never overwritten by the row's message");
        r.write("notes.txt", "one\ntwo, revised\nthree\n");
        r.git(&["add", "notes.txt"]);
        let res = control_with(&api, id, &r, "continue", "C1, edited at its conflict\n\nWhy.").await;
        assert_ne!(res["outcome"]["status"], "aborted", "{res}");
        assert_eq!(r.git(&["log", "--format=%B", "--grep=^C1", "-1", "HEAD"]).trim_end(), "C1, edited at its conflict\n\nWhy.");
    }

    /// I1, the message as the stop has it: resolve and Continue without touching the box.
    #[tokio::test]
    async fn an_edit_rows_conflict_resolved_and_continued_commits_the_new_message() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        set(&p, &mut rows, "C1", "edit", Some("C1, edited at its conflict"));
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        r.write("notes.txt", "one\ntwo, revised\nthree\n");
        r.git(&["add", "notes.txt"]);
        let res = control(&api, id, &r, "continue").await;
        assert_ne!(res["outcome"]["status"], "aborted", "{res}");
        assert_eq!(r.git(&["log", "--format=%B", "--grep=^C1", "-1", "HEAD"]).trim_end(), "C1, edited at its conflict");
    }

    /// I2: at an Edit stop, a staged fix and an edited message: Continue keeps both.
    #[tokio::test]
    async fn a_staged_fix_and_an_edited_message_at_an_edit_stop_both_reach_the_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        r.write("fix.txt", "the fix\n");
        r.git(&["add", "fix.txt"]);
        let res = control_with(&api, id, &r, "continue", "B2 Refine lexer, fixed\n\nWith the fix.").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/b"]), "B2 Refine lexer, fixed\n\nWith the fix.");
        assert_eq!(r.git(&["show", "feature/b:fix.txt"]), "the fix");
        assert_eq!(r.git(&["rev-list", "--count", "main..feature/c"]), p["rows"].as_array().unwrap().len().to_string(), "amended, not a commit of its own");
    }

    const REFUSE_BAD: &str = "#!/bin/sh\nif grep -q BAD \"$1\"; then echo 'Rejected: no BAD messages.' >&2; exit 1; fi\n";

    /// M2: a Reword row's script stopped by a commit-msg hook: the stop's warning and note say the
    /// new message wasn't applied, and why; Continue goes on with the old one.
    #[tokio::test]
    async fn a_reword_refused_by_a_hook_says_why() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.hook("commit-msg", REFUSE_BAD);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "C2", "reword", Some("C2 BAD"));
        let res = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped", "{res}");
        assert_eq!(res["outcome"]["warning"], "The new message wasn't applied: Rejected: no BAD messages. Type it again to retry, or Continue to keep the old one.");
        let (_, failed, conflicted, _) = rebase_state(&r);
        assert_eq!((failed.as_deref(), conflicted), (Some("Rejected: no BAD messages."), 0));
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/c"]), "C2 Polish");
    }

    /// The 3C final ruling: at a Reword row's refused stop the box prefills the refused message,
    /// and one the user types there and sends with Continue reaches the commit.
    #[tokio::test]
    async fn a_message_typed_at_a_refused_reword_stop_reaches_the_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.hook("commit-msg", REFUSE_BAD);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "reword", Some("B2 BAD lexer"));
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        assert_eq!(rebase_state(&r).3, "B2 BAD lexer\n", "the box prefills the refused message");
        let res = control_with(&api, id, &r, "continue", "B2 Refine the lexer\n\nRetried.").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/b"]), "B2 Refine the lexer\n\nRetried.");
        assert_eq!(r.git(&["rev-list", "--count", "main..feature/c"]), p["rows"].as_array().unwrap().len().to_string(), "amended, not a commit of its own");
    }

    /// A refused reword's stop with a reason already noted.
    async fn refused_stop(api: &crate::api::Api, id: u32, r: &TestRepo) {
        r.hook("commit-msg", REFUSE_BAD);
        let p = plan(api, id, r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "reword", Some("B2 BAD lexer"));
        assert_eq!(start(api, id, r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
    }

    /// UX F fix round 1 (item 1): at a refused reword's stop (a failed `exec`, no failed pick),
    /// a typed message amends the reworded commit, and no later pick is taken for a failed one
    /// (no stray Edit stop): the rebase finishes.
    #[tokio::test]
    async fn a_typed_message_at_a_refused_reword_stop_amends_that_commit_and_finishes() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        refused_stop(&api, id, &r).await;
        let res = control_with(&api, id, &r, "continue", "B2 Typed lexer").await;
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/b"]), "B2 Typed lexer");
        assert_eq!(subjects(&r, "feature/b..feature/c"), ["C2 Polish", "C1 Edit notes again"], "the rest as it was");
    }

    /// Re-review: at a refused reword's stop the typed message amends the message alone; staged
    /// changes stay staged (git then pauses for them: no refusal is reported for that).
    #[tokio::test]
    async fn a_retried_reword_message_leaves_staged_changes_staged() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        refused_stop(&api, id, &r).await;
        let head_tree = r.git(&["rev-parse", "HEAD^{tree}"]);
        r.write("fix.txt", "the fix\n");
        r.git(&["add", "fix.txt"]);
        let res = control_with(&api, id, &r, "continue", "B2 Retried").await;
        assert_eq!(res["outcome"]["status"], "stopped", "{res}");
        // UX F: git's own reason for the pause, never the refusal's.
        let why = res["outcome"]["warning"].as_str().unwrap_or_default();
        assert!(why.starts_with("The rebase stopped: ") && why.contains("staged changes") && !why.contains("wasn't applied"), "not a refusal: {res}");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "HEAD"]), "B2 Retried");
        assert_eq!(r.git(&["rev-parse", "HEAD^{tree}"]), head_tree, "the message alone");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "fix.txt", "still staged");
        assert_eq!(rebase_state(&r).1, None, "the refusal is gone with the retry");
    }

    /// Re-review: a later Continue failing at the refused stop (unstaged changes) isn't reported
    /// as the hook's refusal: the noted reason stays, and the warning is git's (UX F).
    #[tokio::test]
    async fn a_later_failure_at_a_refused_stop_isnt_a_refusal() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        refused_stop(&api, id, &r).await;
        r.write("lexer.txt", "unstaged\n");
        let res = control(&api, id, &r, "continue").await;
        assert_eq!(res["outcome"]["status"], "stopped", "{res}");
        // UX F: git's own reason for the pause, never the refusal's.
        let why = res["outcome"]["warning"].as_str().unwrap_or_default();
        assert_eq!(why, "The rebase stopped: it can't go on with unstaged changes. Stage or discard them, then Continue", "{res}");
        assert_eq!(rebase_state(&r).1.as_deref(), Some("Rejected: no BAD messages."));
    }
    // --- end 3C final fixes ---
}
