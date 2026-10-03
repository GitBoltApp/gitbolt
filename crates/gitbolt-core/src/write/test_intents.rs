//! The test-only intent set (spec #2 §18 2A): every pipeline step, driven end to end before
//! 2B–2D bring the user-facing writes. Compiled only for tests and the harness (the `testing`
//! feature); the app never accepts `testWrite`.

use crate::api::Api;
use crate::error::{short_ref, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{snapshot, RefMove, UndoKind};
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, NetCx, Plan, Pre, WriteClass, WriteCx, WriteIntent};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum TestIntent {
    /// CAS-moves `name` from where preflight saw it to `to` (`None` deletes it): MoveRefs undo.
    MoveRef { name: String, to: Option<String> },
    /// `git commit -q -F -`: git moves the branch; hooks and signing are git's. MoveRefs undo.
    Commit {
        message: String,
        #[serde(default)]
        allow_empty: bool,
    },
    /// Snapshots `paths`, puts their tracked files back from the index and deletes the
    /// untracked ones: an immediate write, Restore undo.
    Discard { paths: Vec<String> },
    /// `git merge --ff-only <target>` on the checked-out branch: Rewind undo.
    FastForward { target: String },
    /// `git switch --no-guess <branch>`, autostashing on overlap (§6.1); with `create`,
    /// `git switch --no-guess -c <branch>` (a ref the redo must create before switching,
    /// Deviation 9). Switch undo.
    Switch {
        branch: String,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
        // --- 2C T1 ---
        /// Optional in TypeScript: 2A's specs send a switch without it.
        #[serde(default)]
        #[ts(as = "Option<bool>", optional)]
        create: bool,
        // --- end 2C T1 ---
    },
    /// A journal barrier, push's stand-in: nothing runs.
    Barrier { label: String },
    /// Waits `ms` in its run phase (cancellable), then fails if `fail`: the queue tests.
    Sleep {
        label: String,
        #[ts(type = "number")]
        ms: u64,
        #[serde(default)]
        fail: bool,
    },
    // --- 2C T1: config replay ---
    /// Sets (or unsets) `branch.<branch>.<key>`, recording the change, with an optional note:
    /// MoveRefs undo with no refs, so only the config replay undoes it.
    BranchConfig {
        branch: String,
        key: String,
        value: Option<String>,
        #[serde(default)]
        note: Option<String>,
    },
    // --- end 2C T1 ---
    // --- 2D T1 (2C T1's network step uses it too) ---
    /// A network stand-in: sends the Activity line "transferring", then waits `ms` (cancellable)
    /// with no write lock and no watcher hold: before the lock (`first`, pull's fetch) or
    /// mid-run (push's transfer).
    Transfer {
        label: String,
        #[ts(type = "number")]
        ms: u64,
        #[serde(default)]
        first: bool,
    },
    // --- end 2D T1 ---
    // --- 2D T2 ---
    /// `git merge --no-edit <target>`, autostashing any tracked change (§6.1); on conflicts it
    /// pauses (§13.2): Rewind undo.
    MergeStop { target: String },
    /// `git commit -q -F -`, allowed mid-merge: the commit that completes one (2B's Commit).
    CommitMerge { message: String },
    // --- end 2D T2 ---
}

fn nul_list<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for p in paths {
        bytes.extend_from_slice(p.as_bytes());
        bytes.push(0);
    }
    bytes
}

struct MoveRef {
    name: String,
    to: Option<String>,
}

impl WriteIntent for MoveRef {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        match &self.to {
            Some(to) => format!("move {} to {}", short_ref(&self.name), &to[..to.len().min(7)]),
            None => format!("delete {}", short_ref(&self.name)),
        }
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    fn refs(&self) -> Vec<String> {
        vec![self.name.clone()]
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let old = cx.before.refs.get(&self.name).cloned().flatten();
        let message = format!("gitbolt: {}", self.label());
        cx.cas(&[RefMove { name: self.name.clone(), old, new: self.to.clone() }], &message).await
    }
}

struct Commit {
    message: String,
    allow_empty: bool,
}

impl WriteIntent for Commit {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        format!("commit \"{}\"", self.message.lines().next().unwrap_or_default())
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let mut args = vec!["commit", "-q", "-F", "-"];
        if self.allow_empty {
            args.push("--allow-empty");
        }
        let inv = cx.git(args).stdin(self.message.clone().into_bytes());
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Index);
        Ok(())
    }
}

struct Discard {
    paths: Vec<String>,
}

impl WriteIntent for Discard {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Discard
    }
    fn label(&self) -> String {
        match self.paths.as_slice() {
            [one] => format!("discard {one}"),
            many => format!("discard {} files", many.len()),
        }
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Restore)
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let untracked = crate::write::precheck::untracked_among(&pre.api.cli, pre.root, &self.paths).await?;
        Ok(Plan { snapshot: Some((self.paths.clone(), untracked)), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        // Only the untracked files the snapshot holds are deleted: one that appeared since the
        // plan is left alone (it has no copy to restore).
        // The snapshot's P is files only (a directory expanded), and the `after` one takes it.
        let (paths, untracked) = cx.snapshot.as_ref().map(|s| (s.paths.clone(), s.untracked.clone())).unwrap_or_default();
        let tracked: Vec<&String> = paths.iter().filter(|p| !untracked.contains(p)).collect();
        // From here the working tree may change, even if a step fails.
        cx.partial = true;
        if !tracked.is_empty() {
            let inv = cx.git(["checkout", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(tracked));
            cx.run_git(inv).await?;
        }
        for p in &untracked {
            match std::fs::remove_file(cx.root.join(p)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        cx.after = Some(snapshot::create(&cx.snapshots(), &self.label(), &paths, &[]).await?);
        cx.touch(ChangeKind::Worktree);
        Ok(())
    }
}

struct FastForward {
    target: String,
}

impl WriteIntent for FastForward {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Merge
    }
    fn label(&self) -> String {
        format!("fast-forward to {}", short_ref(&self.target))
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Rewind)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["merge", "--ff-only", "-q", self.target.as_str()]);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Index);
        Ok(())
    }
}

struct Switch {
    branch: String,
    confirm: crate::write::types::Confirm,
    create: bool,
}

impl WriteIntent for Switch {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Checkout
    }
    fn label(&self) -> String {
        format!("checkout {}", self.branch)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Switch)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn confirm(&self) -> crate::write::types::Confirm {
        self.confirm
    }
    /// A created branch is read before (as absent), so verify records its creation.
    fn refs(&self) -> Vec<String> {
        if self.create { vec![format!("refs/heads/{}", self.branch)] } else { Vec::new() }
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        // A new branch at HEAD: the worktree doesn't move.
        if self.create {
            return Ok(Plan::default());
        }
        let name = format!("refs/heads/{}", self.branch);
        let target = crate::write::refs::read_ref(&gix::open(pre.root).map_err(crate::error::gix_err)?, &name)?.ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("no branch {}", self.branch)))?;
        let target = gix::ObjectId::from_hex(target.as_bytes()).map_err(crate::error::gix_err)?;
        let spec = crate::journal::autostash::AutostashSpec { rule: crate::journal::autostash::AutostashRule::Overlap, target: Some(target), op: self.label(), target_name: Some(self.branch.clone()) };
        Ok(Plan { autostash: Some(spec), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = match self.create {
            true => cx.git(["switch", "--no-guess", "-c", self.branch.as_str()]),
            false => cx.git(["switch", "--no-guess", self.branch.as_str()]),
        };
        cx.run_git(inv).await?;
        for k in [ChangeKind::Head, ChangeKind::Index, ChangeKind::Worktree] {
            cx.touch(k);
        }
        Ok(())
    }
}

struct Barrier {
    label: String,
}

impl WriteIntent for Barrier {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Push
    }
    fn label(&self) -> String {
        self.label.clone()
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Barrier)
    }
    async fn run(&self, _cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        Ok(())
    }
}

struct Sleep {
    label: String,
    ms: u64,
    fail: bool,
}

impl WriteIntent for Sleep {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        self.label.clone()
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(self.ms)) => {}
            _ = cx.op.cancel.cancelled() => return Err(GbError::new(GbErrorKind::Cancelled, "Cancelled")),
        }
        if self.fail {
            return Err(GbError::other(format!("{} failed", self.label)));
        }
        Ok(())
    }
}

// --- 2C T1: config replay ---
struct BranchConfig {
    branch: String,
    key: String,
    value: Option<String>,
    note: Option<String>,
}

impl WriteIntent for BranchConfig {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("set branch.{}.{}", self.branch, self.key)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let before = crate::write::config::branch_config(&cx.api.cli, cx.root, &self.branch).await?;
        let key = format!("branch.{}.{}", self.branch, self.key);
        let args: Vec<String> = match &self.value {
            Some(v) => vec!["config".into(), "--local".into(), key, v.clone()],
            None => vec!["config".into(), "--local".into(), "--unset-all".into(), key],
        };
        let inv = cx.git(args);
        cx.run_git(inv).await?;
        let after = crate::write::config::branch_config(&cx.api.cli, cx.root, &self.branch).await?;
        cx.record_config(crate::write::config::changes(&before, &after))?;
        if let Some(n) = &self.note {
            cx.set_note(n.clone())?;
        }
        Ok(())
    }
}
// --- end 2C T1 ---

// --- 2D T1 ---
/// Waits `ms` unless the op is cancelled first.
async fn wait_or_cancel(op: &crate::ops::OpEntry, ms: u64) -> Result<(), GbError> {
    tokio::select! {
        () = tokio::time::sleep(Duration::from_millis(ms)) => Ok(()),
        () = op.cancel.cancelled() => Err(GbError::new(GbErrorKind::Cancelled, "Cancelled")),
    }
}

struct Transfer {
    label: String,
    ms: u64,
    first: bool,
}

impl WriteIntent for Transfer {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Push
    }
    fn label(&self) -> String {
        self.label.clone()
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    async fn transfer_first(&self, net: &mut NetCx<'_>) -> Result<(), GbError> {
        if !self.first {
            return Ok(());
        }
        let _ = net.output().send("transferring".into());
        wait_or_cancel(net.op, self.ms).await
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        if self.first {
            return Ok(());
        }
        cx.unlock();
        let _ = cx.output().send("transferring".into());
        let waited = wait_or_cancel(cx.op, self.ms).await;
        cx.relock().await;
        waited
    }
}
// --- end 2D T1 ---

// --- 2D T2 ---
struct MergeStop {
    target: String,
}

impl WriteIntent for MergeStop {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Merge
    }
    fn label(&self) -> String {
        format!("merge {} into main", self.target)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Rewind)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let repo = gix::open(pre.root).map_err(crate::error::gix_err)?;
        let target = repo.rev_parse_single(self.target.as_str()).map_err(crate::error::gix_err)?.detach();
        let spec = crate::journal::autostash::AutostashSpec { rule: crate::journal::autostash::AutostashRule::AnyTracked, target: Some(target), op: format!("merge {}", self.target), target_name: Some(self.target.clone()) };
        Ok(Plan { autostash: Some(spec), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["merge", "--no-edit", self.target.as_str()]);
        let res = cx.run_git(inv).await;
        cx.touch(ChangeKind::Worktree);
        cx.touch(ChangeKind::Index);
        if res.is_err()
            && let Ok(Some(crate::in_progress::InProgress::Merge { merge_head, .. })) = crate::in_progress::read(cx.root)
        {
            cx.paused = Some(crate::write::Pause { kind: crate::journal::PausedKind::Merge, target: self.target.clone(), target_oid: Some(merge_head), put_back: Vec::new(), picked: Vec::new(), irebase: None });
            return Ok(());
        }
        res.map(|_| ())
    }
}

struct CommitMerge {
    message: String,
}

impl WriteIntent for CommitMerge {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        format!("commit \"{}\"", self.message)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["commit", "-q", "-F", "-"]).stdin(self.message.clone().into_bytes());
        cx.run_git(inv).await.map(|_| ())
    }
}
// --- end 2D T2 ---

fn json<T: Serialize>(r: WriteResult<T>) -> Result<serde_json::Value, GbError> {
    serde_json::to_value(r).map_err(|e| GbError::other(format!("serialize: {e}")))
}

pub(crate) async fn run(api: &Api, repo: u32, worktree: &str, expect: Expect, intent: TestIntent) -> Result<serde_json::Value, GbError> {
    match intent {
        TestIntent::MoveRef { name, to } => json(run_write(api, repo, worktree, expect, MoveRef { name, to }).await?),
        TestIntent::Commit { message, allow_empty } => json(run_write(api, repo, worktree, expect, Commit { message, allow_empty }).await?),
        TestIntent::Discard { paths } => json(run_write(api, repo, worktree, expect, Discard { paths }).await?),
        TestIntent::FastForward { target } => json(run_write(api, repo, worktree, expect, FastForward { target }).await?),
        TestIntent::Switch { branch, confirm, create } => json(run_write(api, repo, worktree, expect, Switch { branch, confirm, create }).await?),
        TestIntent::Barrier { label } => json(run_write(api, repo, worktree, expect, Barrier { label }).await?),
        TestIntent::Sleep { label, ms, fail } => json(run_write(api, repo, worktree, expect, Sleep { label, ms, fail }).await?),
        TestIntent::BranchConfig { branch, key, value, note } => json(run_write(api, repo, worktree, expect, BranchConfig { branch, key, value, note }).await?),
        TestIntent::Transfer { label, ms, first } => json(run_write(api, repo, worktree, expect, Transfer { label, ms, first }).await?),
        TestIntent::MergeStop { target } => json(run_write(api, repo, worktree, expect, MergeStop { target }).await?),
        TestIntent::CommitMerge { message } => json(run_write(api, repo, worktree, expect, CommitMerge { message }).await?),
    }
}
