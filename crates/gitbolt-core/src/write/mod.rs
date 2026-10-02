//! Writes (spec #2 §3). Every write goes through `run_write`, one sequence the core owns:
//! 1 queue and lock, 2 preflight (read-only), 3 journal write-ahead, 4 snapshot, 5 autostash,
//! 6 run, 7 verify, 8 restore, 9 journal finalize, 10 events and caches. Reads never build a
//! write invocation (`WriteToken`).

pub(crate) mod hooks;
pub(crate) mod index_lock;
pub(crate) mod precheck;
pub(crate) mod queue;
pub(crate) mod refs;
#[cfg(any(test, feature = "testing"))]
pub mod test_intents;
#[cfg(test)]
mod tests;
mod token;
pub mod types;

pub(crate) use token::WriteToken;

use crate::api::{blocking, Api, RepoHandle};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{AppEvent, ChangeKind, EventBus, OpKind, OpOutcome};
use crate::git::{GitInvocation, GitOutput};
use crate::journal::snapshot::{self, SnapshotCx};
use crate::journal::{HeadState, NewEntry, RefMove, Snapshot, UndoKind};
use crate::ops::OpEntry;
use crate::write::queue::RepoWrites;
use crate::write::types::{Expect, StagingUndoState, WipListsPayload, WriteResult};
use gix::bstr::ByteSlice;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Queued writes run one at a time in click order. Immediate ones (stage, discards, …) act on
/// what's on screen: they take the lock directly, waiting at most for the running item's local
/// phase (§3.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteClass {
    Queued,
    #[cfg_attr(not(any(test, feature = "testing")), allow(dead_code))] // the app's first: 2B's stage and discards
    Immediate,
}

/// What a write needs before it runs, from its read-only `plan`.
#[derive(Debug, Default)]
pub(crate) struct Plan {
    /// Snapshot these first (§5.2): `(paths, the untracked ones the op deletes)`. A directory
    /// stands for its files; the snapshot's own `paths` are what `run` acts on.
    pub snapshot: Option<(Vec<String>, Vec<String>)>,
    /// Autostash before running (§6.1), decided by preflight.
    pub autostash: Option<crate::journal::autostash::AutostashSpec>,
}

/// What preflight read (§3.2 step 2).
#[derive(Debug, Clone)]
pub(crate) struct Before {
    pub head: HeadState,
    /// `expect`'s refs, the intent's `refs()` and HEAD's branch, as they are now.
    pub refs: BTreeMap<String, Option<String>>,
    #[allow(dead_code)] // first readers: 2D's in-progress intents (continue, abort)
    pub in_progress: Option<&'static str>,
}

/// An intent's view during `plan` (read-only).
#[allow(dead_code)] // `h` and `expect`: first readers 2B's intents
pub(crate) struct Pre<'a> {
    pub api: &'a Api,
    pub h: &'a Arc<RepoHandle>,
    pub root: &'a Path,
    pub expect: &'a Expect,
    pub before: &'a Before,
}

/// One write operation (spec §3.1: one request per operation; TypeScript only asks).
pub(crate) trait WriteIntent: Send + Sync {
    type Outcome: Serialize + Send;
    fn kind(&self) -> OpKind;
    /// The journal and Activity label (`commit "Fix x"`, `checkout feature/x`, …, §5.5).
    fn label(&self) -> String;
    fn class(&self) -> WriteClass {
        WriteClass::Queued
    }
    /// How it's undone; `None` = not journaled (§5.3 "Not journaled").
    fn undo(&self) -> Option<UndoKind>;
    /// It may run hooks, sign or reach the network: no timeout, cancellable, trace2 (§3.3).
    fn runs_hooks(&self) -> bool {
        false
    }
    /// It may run during a merge or rebase (2D: stage, discard per file, save, resolve).
    fn allowed_in_progress(&self) -> bool {
        false
    }
    /// Refs it may move besides HEAD's branch; verify compares them (§3.2 step 7).
    fn refs(&self) -> Vec<String> {
        Vec::new()
    }
    /// What the user already confirmed (the clean-restore warning).
    fn confirm(&self) -> crate::write::types::Confirm {
        Default::default()
    }
    fn plan(&self, _pre: &Pre<'_>) -> impl Future<Output = Result<Plan, GbError>> + Send {
        async { Ok(Plan::default()) }
    }
    fn run(&self, cx: &mut WriteCx<'_>) -> impl Future<Output = Result<Self::Outcome, GbError>> + Send;
}

/// What an intent's `run` works with.
pub(crate) struct WriteCx<'a> {
    pub api: &'a Api,
    pub h: &'a Arc<RepoHandle>,
    /// The worktree (canonical).
    pub root: &'a Path,
    /// As the user saw it, carried forward by the queue (§3.6).
    #[allow(dead_code)] // first readers: 2B's intents
    pub expect: &'a Expect,
    pub before: &'a Before,
    pub token: WriteToken,
    pub op: &'a OpEntry,
    /// The data dir's `tmp/` (0700).
    pub tmp: PathBuf,
    out: mpsc::UnboundedSender<String>,
    /// The intent `runs_hooks`: no timeout (§3.3).
    hooks: bool,
    trace: Option<hooks::Trace2>,
    kinds: BTreeSet<ChangeKind>,
    /// Refs the write moved itself, with the value its CAS required them to have before.
    touched: BTreeMap<String, Option<String>>,
    /// The `before` snapshot step 4 took (the plan's paths). A destructive intent deletes only
    /// what it holds, never a path that appeared since.
    pub snapshot: Option<Snapshot>,
    /// The `after` snapshot (discards, §5.3), kept only when the run succeeds.
    pub after: Option<Snapshot>,
    /// The run may have changed the working tree before it failed: a failed write keeps its
    /// entry (and `before` snapshot) only then, or when a ref or HEAD moved.
    pub partial: bool,
    /// The intent changed the journal itself (undo, redo, banners): announce it.
    pub journal_changed: bool,
}

impl WriteCx<'_> {
    /// A write in this worktree: cancellable, detached, with askpass, its stderr streamed to
    /// Activity. Hook-running intents get no timeout and a trace2 file (§3.3).
    pub(crate) fn git<I, S>(&self, args: I) -> GitInvocation
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let mut inv = GitInvocation::write(&self.token, self.root, args).cancel(self.op.cancel.clone()).detach_terminal().stream_stderr(self.out.clone()).envs(self.api.net_env(self.op.id));
        if self.hooks {
            inv = inv.timeout(None);
        }
        if let Some(t) = &self.trace {
            inv = inv.envs(t.env());
        }
        inv
    }

    /// An autostash step's invocation (push, apply, drop): `run_stash_step` runs it.
    pub(crate) fn git_stash<I, S>(&self, args: I) -> GitInvocation
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        GitInvocation::write(&self.token, self.root, args).detach_terminal().stream_stderr(self.out.clone())
    }

    /// Runs an autostash step. A Cancel of the op doesn't stop it (review I4: the user's changes
    /// are restored whatever the run did), but a Cancel pressed while it runs is a Stop, and
    /// `api.autostash_timeout` (15 minutes) is a hard limit: both stop git's whole process group
    /// (SIGTERM, then SIGKILL), filters included. `true`: it was stopped.
    pub(crate) async fn run_stash_step(&mut self, step: crate::events::StashStep, message: &str, inv: GitInvocation) -> (Result<GitOutput, GbError>, bool) {
        let (api, op) = (self.api, self.op);
        let limit = api.autostash_timeout;
        let stop = tokio_util::sync::CancellationToken::new();
        let pressed = op.stop_requested.notified();
        tokio::pin!(pressed);
        pressed.as_mut().enable();
        api.bus.emit(AppEvent::OpStashStep { op: op.id, step: Some(step), message: message.to_string() });
        let started = std::time::Instant::now();
        let run = api.cli.run(inv.cancel(stop.clone()).timeout(Some(limit)));
        tokio::pin!(run);
        let res = loop {
            tokio::select! {
                r = &mut run => break r,
                _ = &mut pressed, if !stop.is_cancelled() => stop.cancel(),
            }
        };
        api.bus.emit(AppEvent::OpStashStep { op: op.id, step: None, message: message.to_string() });
        let stopped = res.is_err() && (stop.is_cancelled() || started.elapsed() >= limit);
        (res, stopped)
    }

    /// Runs it; a hook that exited non-zero makes the failure `HookFailed { hook }`.
    pub(crate) async fn run_git(&mut self, inv: GitInvocation) -> Result<GitOutput, GbError> {
        let res = self.api.cli.run(inv).await;
        res.map_err(|e| match &self.trace {
            Some(t) => hooks::hook_error(e, t),
            None => e,
        })
    }

    /// A ref CAS (§4); verify records what really moved.
    pub(crate) async fn cas(&mut self, moves: &[RefMove], message: &str) -> Result<(), GbError> {
        for m in moves {
            self.touched.entry(m.name.clone()).or_insert_with(|| m.old.clone());
        }
        refs::cas(&self.api.cli, &self.token, &self.h.repo, self.root, moves, message).await
    }

    pub(crate) fn snapshots(&self) -> SnapshotCx<'_> {
        SnapshotCx { cli: &self.api.cli, token: &self.token, root: self.root, tmp: &self.tmp }
    }

    pub(crate) fn touch(&mut self, kind: ChangeKind) {
        self.kinds.insert(kind);
    }
}

/// HEAD as the journal records it.
pub(crate) fn head_state(repo: &gix::Repository) -> Result<HeadState, GbError> {
    let head = repo.head().map_err(gix_err)?;
    let branch = head.referent_name().and_then(|n| n.as_bstr().to_str().ok()?.strip_prefix("refs/heads/").map(str::to_string));
    Ok(HeadState { branch, oid: head.id().map(|id| id.to_string()) })
}

/// The operations that block writes (§5.4, §13.2); a bisect doesn't.
pub(crate) fn in_progress_name(s: gix::state::InProgress) -> Option<&'static str> {
    use gix::state::InProgress::*;
    match s {
        ApplyMailbox | ApplyMailboxRebase => Some("am"),
        CherryPick | CherryPickSequence => Some("cherry-pick"),
        Merge => Some("merge"),
        Rebase | RebaseInteractive => Some("rebase"),
        Revert | RevertSequence => Some("revert"),
        Bisect => None,
    }
}

fn read_all(repo: &gix::Repository, names: &BTreeSet<String>) -> Result<BTreeMap<String, Option<String>>, GbError> {
    names.iter().map(|n| Ok((n.clone(), refs::read_ref(repo, n)?))).collect()
}

/// §3.2 step 2, with gix only (no git process, so nothing can write).
async fn preflight(root: &Path, expect: &Expect, extra: Vec<String>, allowed_in_progress: bool) -> Result<Before, GbError> {
    let (root, expect) = (root.to_path_buf(), expect.clone());
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let in_progress = repo.state().and_then(in_progress_name);
        if let Some(what) = in_progress
            && !allowed_in_progress
        {
            return Err(GbError::in_progress(what));
        }
        let head = head_state(&repo)?;
        if expect.head.is_some() && head.oid != expect.head {
            return Err(GbError::ref_moved("HEAD"));
        }
        let mut names: BTreeSet<String> = expect.refs.keys().cloned().collect();
        names.extend(extra);
        if let Some(b) = &head.branch {
            names.insert(format!("refs/heads/{b}"));
        }
        let refs = read_all(&repo, &names)?;
        for (name, want) in &expect.refs {
            if refs.get(name) != Some(want) {
                return Err(GbError::ref_moved(name));
            }
        }
        Ok(Before { head, refs, in_progress })
    })
    .await
}

/// §3.2 step 7: HEAD and the given refs (plus HEAD's branch) as they are now.
async fn observe(root: &Path, mut names: BTreeSet<String>) -> Result<(HeadState, BTreeMap<String, Option<String>>), GbError> {
    let root = root.to_path_buf();
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let head = head_state(&repo)?;
        if let Some(b) = &head.branch {
            names.insert(format!("refs/heads/{b}"));
        }
        Ok((head, read_all(&repo, &names)?))
    })
    .await
}

fn forward_output(bus: EventBus, op: u64) -> (mpsc::UnboundedSender<String>, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            bus.emit(AppEvent::OpOutput { op, line: crate::redact::redact(&line) });
        }
    });
    (tx, task)
}

struct Ran<O> {
    result: Result<O, GbError>,
    moves: Vec<RefMove>,
    head_before: HeadState,
    head_after: HeadState,
    kinds: BTreeSet<ChangeKind>,
    journal_changed: bool,
}

impl<O> Ran<O> {
    fn failed(e: GbError) -> Self {
        Self { result: Err(e), moves: Vec::new(), head_before: HeadState::default(), head_after: HeadState::default(), kinds: BTreeSet::new(), journal_changed: false }
    }
}

/// Steps 2–9, under the lock.
async fn steps<I: WriteIntent>(api: &Api, h: &Arc<RepoHandle>, root: &Path, expect: &Expect, intent: &I, op: &OpEntry, out: mpsc::UnboundedSender<String>) -> Ran<I::Outcome> {
    // 2. Preflight (read-only).
    let before = match preflight(root, expect, intent.refs(), intent.allowed_in_progress()).await {
        Ok(b) => b,
        Err(e) => return Ran::failed(e),
    };
    let tmp = match api.tmp_dir() {
        Ok(t) => t,
        Err(e) => return Ran::failed(e),
    };
    let plan = match intent.plan(&Pre { api, h, root, expect, before: &before }).await {
        Ok(p) => p,
        Err(e) => return Ran::failed(e),
    };
    // §6.1–6.2, before anything runs: the autostash plan, and the clean-restore warning.
    let stash_plan = match &plan.autostash {
        Some(spec) => match crate::journal::autostash::plan(api, root, &tmp, spec).await {
            Ok(p) => p,
            Err(e) => return Ran::failed(e),
        },
        None => None,
    };
    if let Some(p) = &stash_plan
        && !p.conflicts.is_empty()
        && !intent.confirm().autostash
    {
        let target = p.target.clone().unwrap_or_default();
        return Ran::failed(GbError::new(GbErrorKind::Conflict, format!("Your changes conflict with {target}")).with_detail(crate::error::ErrorDetail::AutostashConflict { paths: p.conflicts.clone(), target }));
    }
    // 3. Journal, write-ahead. (Pending entries are recovered once, at the first open, never here.)
    let store = match intent.undo() {
        Some(_) => match api.journal(root) {
            Ok(s) => Some(s),
            Err(e) => return Ran::failed(e),
        },
        None => None,
    };
    let entry = match (&store, intent.undo()) {
        (Some(s), Some(undo)) => {
            // Stamped with this instance, so another instance's recovery leaves it alone.
            let owner = match api.owner() {
                Ok(o) => o,
                Err(e) => return Ran::failed(e),
            };
            let begun = s.update(|j| {
                let id = j.begin(NewEntry { label: intent.label(), kind: intent.kind(), head_before: before.head.clone(), undo }, api.now());
                if let Some(e) = j.entry_mut(id) {
                    e.owner = Some(owner);
                }
                id
            });
            match begun {
                Ok(id) => Some(id),
                Err(e) => return Ran::failed(e),
            }
        }
        _ => None,
    };
    let trace = if intent.runs_hooks() { hooks::Trace2::new(&tmp).ok() } else { None };
    let mut cx = WriteCx {
        api,
        h,
        root,
        expect,
        before: &before,
        token: WriteToken::mint(),
        op,
        tmp,
        out,
        hooks: intent.runs_hooks(),
        trace,
        kinds: BTreeSet::new(),
        touched: BTreeMap::new(),
        snapshot: None,
        after: None,
        partial: false,
        journal_changed: false,
    };
    // 4. Snapshot, for working-tree-destructive intents.
    let mut ready = Ok(());
    if let Some((paths, untracked)) = &plan.snapshot {
        match snapshot::create(&cx.snapshots(), &intent.label(), paths, untracked).await {
            Ok(snap) => {
                if let (Some(s), Some(id)) = (&store, entry) {
                    let kept = snap.clone();
                    ready = s.update(|j| {
                        if let Some(e) = j.entry_mut(id) {
                            e.before = Some(kept);
                        }
                    });
                }
                cx.snapshot = Some(snap);
            }
            Err(e) => ready = Err(e),
        }
    }
    // 5. Autostash, written ahead (review N2): a `Pending` record (no oid yet) before the push,
    //    so a stash git stores is never without one. After the push: its oid, or the record
    //    goes. A stash git stored is restored at step 8 even when the push then failed (I3),
    //    unless a Stop interrupted the push (it stays, `Stopped`, and the op doesn't run).
    let mut stash = None;
    if ready.is_ok()
        && let Some(p) = &stash_plan
    {
        let (saved, res) = crate::journal::autostash::save(&mut cx, p, &intent.label()).await;
        stash = saved;
        if let Err(e) = res {
            ready = Err(e);
        }
        cx.journal_changed = true;
    }
    // 6. Run.
    let mut result = match ready {
        Ok(()) => intent.run(&mut cx).await,
        Err(e) => Err(e),
    };
    // 7. Verify: the observed old → new of each ref, never the intended one.
    let mut known = before.refs.clone();
    for (name, old) in &cx.touched {
        known.entry(name.clone()).or_insert_with(|| old.clone());
    }
    let (head_after, now) = match observe(root, known.keys().cloned().collect()).await {
        Ok(seen) => seen,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "verify failed: {e}");
            (before.head.clone(), known.clone())
        }
    };
    let moves: Vec<RefMove> = now
        .iter()
        .filter_map(|(name, new)| {
            let old = known.get(name)?.clone();
            (old != *new).then(|| RefMove { name: name.clone(), old, new: new.clone() })
        })
        .collect();
    // 8. Restore the autostash, whatever the run did (2D: unless a merge or rebase stopped on
    //    conflicts, which waits for Continue, Commit or Abort).
    //    A Cancel of the op doesn't stop it (review I4); a Stop does, and fails the write.
    if let Some(st) = stash.as_ref().filter(|s| s.restore) {
        let applied = match crate::journal::autostash::restore(&mut cx, &st.oid, &st.message, true).await {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(target: "gitbolt_core::write", "autostash restore failed: {e}");
                crate::journal::autostash::Applied::Refused { index: false, message: e.message }
            }
        };
        crate::journal::autostash::settle(api, root, st, &applied);
        if let Some(e) = crate::journal::autostash::stop_error(&applied, &st.message) {
            result = Err(e);
        }
    }
    // 9. Finalize: done, or dropped when nothing changed. A failure after a partial change still
    //    records what did change; one that changed nothing (no ref or HEAD moved, and the intent
    //    didn't flag a partial change) leaves no entry, not even a `before`-only or a barrier one.
    let after_snapshot = if result.is_ok() { cx.after.take() } else { None };
    // A kept autostash isn't a reason to keep the entry: it has its own banner (`Journal::kept`).
    let unchanged_failure = result.is_err() && moves.is_empty() && head_after == before.head && !cx.partial;
    let mut journal_changed = cx.journal_changed;
    if let (Some(s), Some(id)) = (&store, entry) {
        let finalized = s.update(|j| {
            if unchanged_failure {
                j.drop_entry(id);
                return false;
            }
            if let Some(e) = j.entry_mut(id) {
                e.head_after = head_after.clone();
                e.refs = moves.clone();
                e.after = after_snapshot;
                e.owner = None;
            }
            j.finalize(id)
        });
        journal_changed |= finalized.unwrap_or(false);
    }
    let kinds = std::mem::take(&mut cx.kinds);
    Ran { result, moves, head_before: before.head.clone(), head_after, kinds, journal_changed }
}

/// §3.2 step 10: `repoChanged` with what the write touched (and the lists' version), and
/// `refsUpdated` when a ref moved, to every tab of the repository. Always sent, whatever the
/// outcome: it's the refresh after every write.
fn announce<O>(api: &Api, writes: &RepoWrites, root: &Path, ran: &Ran<O>, version: Option<&str>) {
    let mut kinds = ran.kinds.clone();
    kinds.extend([ChangeKind::Worktree, ChangeKind::Index]);
    if !ran.moves.is_empty() {
        kinds.insert(ChangeKind::Refs);
    }
    if ran.head_before != ran.head_after {
        kinds.insert(ChangeKind::Head);
    }
    let wt = root.display().to_string();
    let versions: BTreeMap<String, String> = version.map(|v| (wt.clone(), v.to_string())).into_iter().collect();
    for id in writes.ids() {
        api.bus.emit(AppEvent::RepoChanged { repo: id, kinds: kinds.iter().copied().collect(), worktrees: vec![wt.clone()], versions: versions.clone() });
        if !ran.moves.is_empty() {
            api.bus.emit(AppEvent::RefsUpdated { repo: id });
        }
    }
}

pub(crate) async fn run_write<I: WriteIntent>(api: &Api, repo: u32, worktree: &str, expect: Expect, intent: I) -> Result<WriteResult<I::Outcome>, GbError> {
    let h = api.handle(repo)?;
    let writes = api.repo_writes(&h);
    let (kind, label) = (intent.kind(), intent.label());
    let op = api.ops.begin(kind, Some(repo), true);
    // 1. Queue and lock. A queued write joins the queue before anything awaits, so the queue's
    //    order is the click order (§3.6). Cancelled while it waits, it leaves at once, quietly.
    let ticket = match intent.class() {
        WriteClass::Queued => Some(writes.queue.enqueue(&label, kind, op.id).cancel_on(op.cancel.clone())),
        WriteClass::Immediate => None,
    };
    // Then the worktree and the guard, before anything writes; an error drops the ticket, which
    // takes the item out of the queue.
    let root = api.worktree_dir(&h, worktree).await?;
    api.check_write(&h.common_dir)?;
    let slot = match ticket {
        Some(t) => Some(writes.queue.turn(t).await?),
        None => None,
    };
    let expect = match &slot {
        Some(s) => s.carry(&expect),
        None => expect,
    };
    let lock = writes.acquire().await;
    api.bus.emit(AppEvent::OpStarted { op: op.id, kind, repo: Some(repo), label: label.clone(), interactive: true });
    let holds = api.watch_holds(&h.common_dir);
    let (out, forward) = forward_output(api.bus.clone(), op.id);
    let ran = steps(api, &h, &root, &expect, &intent, &op, out).await;
    let _ = forward.await;
    // 10. The fresh lists, after the write's last git command; the watcher absorbs them (and
    //     the refs as the write left them), so its own pass finds nothing new.
    let lists = crate::watch::read_and_keep_lists(&h.repo, &api.cli, &h.wip, &root).await.ok();
    for hold in &holds {
        if let Some(l) = &lists {
            hold.absorb(root.clone(), l.digest);
        }
        hold.absorb_git();
    }
    drop(holds);
    drop(lock);
    if let Some(slot) = slot {
        let mut carried = ran.moves.clone();
        if ran.head_before.oid != ran.head_after.oid {
            carried.push(RefMove { name: "HEAD".into(), old: ran.head_before.oid.clone(), new: ran.head_after.oid.clone() });
        }
        // A failure stops only the items queued behind it; a Cancel stops nothing (T8).
        slot.finish(ran.result.as_ref().err(), &carried);
    }
    let wip = lists.map(|l| WipListsPayload { worktree: root.display().to_string(), version: l.version.clone(), staged: (*l.staged).clone(), unstaged: (*l.unstaged).clone() });
    announce(api, &writes, &root, &ran, wip.as_ref().map(|w| w.version.as_str()));
    // A write that ran is never reported as failed because the journal couldn't be read after it
    // (the user might retry a commit): the state falls back to an empty one.
    let journal = match api.journal_state(&root) {
        Ok(state) => {
            if ran.journal_changed {
                for id in writes.ids() {
                    api.bus.emit(AppEvent::JournalChanged { repo: id, worktree: root.display().to_string(), state: state.clone() });
                }
            }
            state
        }
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "journal state after {label}: {e}");
            crate::journal::Journal::empty(&root.display().to_string()).state(None)
        }
    };
    let (outcome, message) = match &ran.result {
        Ok(_) => (OpOutcome::Ok, None),
        Err(e) if e.kind == GbErrorKind::Cancelled => (OpOutcome::Cancelled, Some(e.message.clone())),
        Err(e) => (OpOutcome::Failed, Some(e.message.clone())),
    };
    api.bus.emit(AppEvent::OpFinished { op: op.id, kind, repo: Some(repo), outcome, message, command: None });
    Ok(WriteResult { outcome: ran.result?, journal, staging: StagingUndoState::default(), wip })
}
