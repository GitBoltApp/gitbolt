//! The test-only intent set (spec #2 §18 2A): every pipeline step, driven end to end before
//! 2B–2D bring the user-facing writes. Compiled only for tests and the harness (the `testing`
//! feature); the app never accepts `testWrite`.

use crate::api::Api;
use crate::error::{short_ref, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::{snapshot, RefMove, UndoKind};
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, Plan, Pre, WriteClass, WriteCx, WriteIntent};
use serde::{Deserialize, Serialize};
use std::path::Path;
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
    /// `git switch --no-guess <branch>`, autostashing on overlap (§6.1): Switch undo.
    Switch {
        branch: String,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
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
}

fn nul_list<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for p in paths {
        bytes.extend_from_slice(p.as_bytes());
        bytes.push(0);
    }
    bytes
}

/// The untracked (not ignored) ones among `paths`: a read, with the never-write environment.
async fn untracked_among(api: &Api, root: &Path, paths: &[String]) -> Result<Vec<String>, GbError> {
    let args = ["ls-files", "-z", "--others", "--exclude-standard", "--"].into_iter().map(String::from).chain(paths.iter().cloned());
    let out = api.cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
    Ok(out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
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
        let untracked = untracked_among(pre.api, pre.root, &self.paths).await?;
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
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let name = format!("refs/heads/{}", self.branch);
        let target = crate::write::refs::read_ref(&gix::open(pre.root).map_err(crate::error::gix_err)?, &name)?.ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("no branch {}", self.branch)))?;
        let target = gix::ObjectId::from_hex(target.as_bytes()).map_err(crate::error::gix_err)?;
        let spec = crate::journal::autostash::AutostashSpec { rule: crate::journal::autostash::AutostashRule::Overlap, target: Some(target), op: self.label(), target_name: Some(self.branch.clone()) };
        Ok(Plan { autostash: Some(spec), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["switch", "--no-guess", self.branch.as_str()]);
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

fn json<T: Serialize>(r: WriteResult<T>) -> Result<serde_json::Value, GbError> {
    serde_json::to_value(r).map_err(|e| GbError::other(format!("serialize: {e}")))
}

pub(crate) async fn run(api: &Api, repo: u32, worktree: &str, expect: Expect, intent: TestIntent) -> Result<serde_json::Value, GbError> {
    match intent {
        TestIntent::MoveRef { name, to } => json(run_write(api, repo, worktree, expect, MoveRef { name, to }).await?),
        TestIntent::Commit { message, allow_empty } => json(run_write(api, repo, worktree, expect, Commit { message, allow_empty }).await?),
        TestIntent::Discard { paths } => json(run_write(api, repo, worktree, expect, Discard { paths }).await?),
        TestIntent::FastForward { target } => json(run_write(api, repo, worktree, expect, FastForward { target }).await?),
        TestIntent::Switch { branch, confirm } => json(run_write(api, repo, worktree, expect, Switch { branch, confirm }).await?),
        TestIntent::Barrier { label } => json(run_write(api, repo, worktree, expect, Barrier { label }).await?),
        TestIntent::Sleep { label, ms, fail } => json(run_write(api, repo, worktree, expect, Sleep { label, ms, fail }).await?),
    }
}
