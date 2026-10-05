//! Push (spec #2 §12.3) and pull (§12.2). The push transfer holds only the queue's running slot
//! (§3.5): `WriteCx::network` drops the write lock around `git push`. Pull's fetch runs before
//! the lock (`transfer_first`), so it never runs with an autostash out.

use crate::api::Api;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::UndoKind;
use crate::write::remote_output::{self, RemoteSummary};
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, WriteCx, WriteIntent};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
// --- 2D T14: pull ---
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{PausedKind, RefMove};
use crate::write::integrate::{self, BranchLabel, IntegrateOutcome};
use crate::write::rebase::RebaseIntent;
use crate::write::refs::read_ref;
use crate::write::types::Confirm;
use crate::write::{NetCx, Plan, Pre};
use std::sync::{Mutex, OnceLock};
// --- end 2D T14 ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PushTarget {
    pub remote: String,
    pub branch: String,
}

/// A force push's lease: the remote-tracking oid the user saw (`None`: it must not exist). Never
/// carried forward by the queue (§3.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Lease {
    pub oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PushOutcome {
    /// The op, so the toast's "Server output" link opens its Activity entry.
    #[ts(type = "number")]
    pub op: u64,
    pub branch: String,
    pub remote: String,
    pub dst: String,
    pub up_to_date: bool,
    pub server: RemoteSummary,
    /// It force-pushed with a rewrite mark's lease, without asking (§12.3): what rewrote it.
    pub forced: Option<crate::write::rewrites::RewriteKind>,
}

fn config(repo: &gix::Repository, key: &str) -> Option<String> {
    repo.config_snapshot().string(key).map(|v| v.to_string()).filter(|v| !v.is_empty())
}

/// §12.3: with `branch.<b>.pushRemote` or `remote.pushDefault`, that remote and the same branch
/// name (git's triangular setup); else the upstream; else none.
pub(crate) fn push_target(repo: &gix::Repository, branch: &str) -> Option<PushTarget> {
    if let Some(remote) = config(repo, &format!("branch.{branch}.pushRemote")).or_else(|| config(repo, "remote.pushDefault")) {
        return Some(PushTarget { remote, branch: branch.to_string() });
    }
    let remote = config(repo, &format!("branch.{branch}.remote")).filter(|r| r != ".")?;
    let merge = config(repo, &format!("branch.{branch}.merge"))?;
    Some(PushTarget { remote, branch: merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string() })
}

pub(crate) struct PushIntent {
    pub branch: String,
    /// The no-upstream dialog's choice; `None`: resolve when it runs (§3.6).
    pub target: Option<PushTarget>,
    pub set_upstream: bool,
    pub lease: Option<Lease>,
    /// For the label: the target as resolved at the click.
    pub shown: Option<PushTarget>,
    /// The worktree, so `refs()` resolves the target at run time, under the lock (§3.6).
    pub root: std::path::PathBuf,
}

impl WriteIntent for PushIntent {
    type Outcome = PushOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Push
    }
    fn label(&self) -> String {
        match &self.shown {
            Some(t) => format!("push {} to {}/{}", self.branch, t.remote, t.branch),
            None => format!("push {}", self.branch),
        }
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Barrier)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn refs(&self) -> Vec<String> {
        let mut refs = vec![format!("refs/heads/{}", self.branch)];
        let now = self.target.clone().or_else(|| gix::open(&self.root).ok().and_then(|r| push_target(&r, &self.branch)));
        if let Some(t) = &now {
            refs.push(format!("refs/remotes/{}/{}", t.remote, t.branch));
        }
        refs
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<PushOutcome, GbError> {
        let (root, branch, given) = (cx.root.to_path_buf(), self.branch.clone(), self.target.clone());
        let (data, common, explicit) = (cx.api.data_dir.clone(), cx.h.common_dir.clone(), self.lease.is_some());
        let (target, mark) = crate::api::blocking(move || {
            let repo = gix::open(&root).map_err(gix_err)?;
            let Some(target) = given.or_else(|| push_target(&repo, &branch)) else { return Ok((None, None)) };
            // §12.3: a branch GitBolt rewrote since its last push forces with the lease recorded
            // then, when a plain push would be rejected. An explicit force keeps its own lease.
            let mark = if explicit { None } else { crate::write::rewrites::lease_for(&data, &common, &repo, &branch, &target)? };
            Ok::<_, GbError>((Some(target), mark))
        })
        .await?;
        let target = target.ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("{} has no upstream; set one from Push ▾", self.branch)))?;
        let mut args = vec!["push".to_string(), "--progress".into()];
        if self.set_upstream {
            args.push("-u".into());
        }
        // --- 3B T4: "Push tags with branches" (spec #3 §3.9) ---
        if cx.api.store.state().settings.push_follow_tags {
            args.push("--follow-tags".into());
        }
        // --- end 3B T4 ---
        if let Some(lease) = &self.lease {
            args.push(format!("--force-with-lease=refs/heads/{}:{}", target.branch, lease.oid.clone().unwrap_or_default()));
        }
        // Never a force without a lease: the mark's is the remote-tracking oid at rewrite time,
        // never the one a later fetch left (that would overwrite commits the user never saw).
        // (`--force-if-includes` does nothing beside an explicit lease oid, so it isn't passed.)
        if let Some((m, _)) = &mark {
            args.push(format!("--force-with-lease=refs/heads/{}:{}", target.branch, m.lease_oid));
        }
        args.push(target.remote.clone());
        // The forced push sends the tip `lease_for` checked, not whatever the branch is by then.
        let src = match &mark {
            Some((_, tip)) if !self.set_upstream => tip.to_string(),
            _ => format!("refs/heads/{}", self.branch),
        };
        args.push(format!("{src}:refs/heads/{}", target.branch));
        let inv = cx.net_git(args);
        // §3.5: the transfer runs outside the write lock; `network` also captures server output.
        let res = cx.network(inv).await;
        cx.touch(ChangeKind::Refs);
        if self.set_upstream {
            cx.touch(ChangeKind::Config);
        }
        let out = res.map_err(|mut e| {
            // The mark's lease failed (someone pushed since the rewrite): today's rejected push,
            // so the user picks Pull or Force push.
            // Only git's lease rejection: a ref-lock failure keeps its own error.
            let stale = [e.stderr.as_deref(), Some(e.message.as_str())].into_iter().flatten().any(|t| t.contains("(stale info)"));
            if mark.is_some() && e.kind == GbErrorKind::RefMoved && stale {
                e.kind = GbErrorKind::NonFastForward;
            }
            // The spec's words for a rejected non-fast-forward push (§12.3).
            if e.kind == GbErrorKind::NonFastForward {
                e.message = format!("{}/{} has commits {} doesn't have", target.remote, target.branch, self.branch);
            }
            e
        })?;
        crate::write::rewrites::pushed(&cx.api.data_dir, &cx.h.common_dir, &self.branch);
        // `network` already emitted `opRemote`; the toast's count comes from the same lines.
        let server = remote_output::summarize(&remote_output::parse(&out.stderr));
        let forced = mark.map(|(m, _)| m.kind);
        Ok(PushOutcome { op: cx.op.id, branch: self.branch.clone(), remote: target.remote, dst: target.branch, up_to_date: out.stderr.contains("Everything up-to-date"), server, forced })
    }
}

/// Resolves the click's target (refusing when there is none), then pushes.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn push(api: &Api, repo: u32, worktree: &str, branch: String, target: Option<PushTarget>, set_upstream: bool, lease: Option<Lease>, expect: Expect) -> Result<WriteResult<PushOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let (b, t, wroot) = (branch.clone(), target.clone(), root.clone());
    let shown = crate::api::blocking(move || Ok::<_, GbError>(t.or_else(|| gix::open(&root).ok().and_then(|r| push_target(&r, &b))))).await?;
    if shown.is_none() {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{branch} has no upstream; set one from Push ▾")));
    }
    run_write(api, repo, worktree, expect, PushIntent { branch, target, set_upstream, lease, shown, root: wroot }).await
}

// --- 2D T14: pull ---
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PullMode {
    FfOnly,
    FfOrMerge,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum PullResult {
    /// "main is up to date" (or "… 2 ahead: push").
    UpToDate { ahead: u32 },
    FastForward { commits: u32 },
    Merged { commits: u32 },
    Rebased { commits: u32 },
    /// FfOnly only: the diverged dialog (§12.2). `conflicts`: a merge's predicted count.
    Diverged { ahead: u32, behind: u32, conflicts: u32 },
    Stopped {
        kind: PausedKind,
        files: u32,
        /// UX F: a stop with no conflict: why git stopped (the signer, a hook).
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        warning: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PullOutcome {
    #[ts(type = "number")]
    pub op: u64,
    pub branch: String,
    /// `origin/main`.
    pub upstream: String,
    pub server: RemoteSummary,
    pub result: PullResult,
}

/// What `plan` found under the lock, after the fetch, for `run`.
#[derive(Debug, Clone, Copy)]
struct PullPlan {
    /// The branch is HEAD's when the op runs (§3.6: a queued checkout ahead may change that).
    checked_out: bool,
    local: gix::ObjectId,
    upstream: gix::ObjectId,
    ahead: u32,
    behind: u32,
}

pub(crate) struct PullIntent {
    pub branch: String,
    pub mode: PullMode,
    pub remote: String,
    /// `refs/remotes/origin/main`.
    pub upstream_ref: String,
    /// `origin/main`.
    pub upstream: String,
    pub confirm: Confirm,
    /// At the click: the branch was HEAD's (the undo kind until `plan` settles it).
    pub checked_out: bool,
    planned: OnceLock<PullPlan>,
    /// The diverged Rebase: T9's engine (`--fork-point`, the lossy-merge refusal, stacks).
    rebase: RebaseIntent,
    server: Mutex<RemoteSummary>,
}

impl PullIntent {
    fn new(branch: String, mode: PullMode, remote: String, short: &str, confirm: Confirm, checked_out: bool) -> Self {
        let upstream_ref = format!("refs/remotes/{remote}/{short}");
        let label = BranchLabel::fixed(format!("pull {branch}"));
        let rebase = RebaseIntent { target: upstream_ref.clone(), update_refs: None, fork_point: true, confirm, label, planned: Default::default() };
        Self { upstream: format!("{remote}/{short}"), upstream_ref, remote, branch, mode, confirm, checked_out, planned: OnceLock::new(), rebase, server: Mutex::default() }
    }

    fn local(&self) -> String {
        format!("refs/heads/{}", self.branch)
    }

    fn autostash(&self, rule: AutostashRule, upstream: gix::ObjectId) -> AutostashSpec {
        AutostashSpec { rule, target: Some(upstream), op: format!("pull {}", self.upstream), target_name: Some(self.upstream.clone()) }
    }
}

/// `branch` checked out in a worktree other than `root`: its path.
async fn checked_out_elsewhere(api: &Api, root: &std::path::Path, branch: &str) -> Result<Option<std::path::PathBuf>, GbError> {
    let full = format!("refs/heads/{branch}");
    let here = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    Ok(crate::worktree::list_worktrees(&api.cli, root)
        .await?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(full.as_str()) && w.path.canonicalize().unwrap_or_else(|_| w.path.clone()) != here)
        .map(|w| w.path))
}

/// Deviation 13: a branch that isn't checked out only fast-forwards.
fn check_out_first(branch: &str) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, format!("Check out {branch} first"))
}

fn elsewhere_error(branch: &str, path: &std::path::Path) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, format!("{branch} is checked out in {}", path.display()))
}

impl WriteIntent for PullIntent {
    type Outcome = PullOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Pull
    }
    fn label(&self) -> String {
        format!("pull {}", self.branch)
    }
    fn undo(&self) -> Option<UndoKind> {
        let checked_out = self.planned.get().map_or(self.checked_out, |p| p.checked_out);
        Some(if checked_out { UndoKind::Rewind } else { UndoKind::MoveRefs })
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn traces_hooks(&self) -> bool {
        // As T9's rebase (review P1): a rebase writes no trace2 events.
        self.mode != PullMode::Rebase
    }
    fn refs(&self) -> Vec<String> {
        // Only the local branch: the fetched remote-tracking refs aren't journaled, and a
        // rebase's stacked branches are watched by the rebase itself (`watch_refs`).
        vec![self.local()]
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    /// 1. Fetch the upstream's remote only (§12.2), holding only the queue slot: it runs before
    ///    the lock, so never with an autostash out.
    ///    Its progress is `opProgress`, as a fetch's. When it moved refs, every tab of the repo
    ///    hears `refsUpdated` now: the write's own announce lists only the local refs it moved, and
    ///    its watcher absorb takes the fetched refs as the new baseline (review I1).
    async fn transfer_first(&self, net: &mut NetCx<'_>) -> Result<(), GbError> {
        let before = crate::netops::ref_state_async(net.h.repo.clone()).await?;
        let prune = if net.api.store.state().settings.prune { "--prune" } else { "--no-prune" };
        let args = ["fetch", self.remote.as_str(), prune, "--no-prune-tags"].into_iter().chain(crate::netops::NO_UPKEEP).chain(["--progress"]);
        let (tx, progress) = crate::netops::forward_progress_to(net.api.bus.clone(), net.op.id, Some(net.output()));
        let inv = net.git(args).stream_stderr(tx);
        let mut res = net.api.cli.run(inv).await;
        let _ = progress.await;
        *self.server.lock().unwrap_or_else(|e| e.into_inner()) = remote_output::capture(net.api, net.op.id, &mut res);
        // Even a failed fetch may have moved some.
        if crate::netops::ref_state_async(net.h.repo.clone()).await.is_ok_and(|after| after != before) {
            for id in net.api.repo_writes(net.h).ids() {
                net.api.bus.emit(crate::events::AppEvent::RefsUpdated { repo: id });
            }
        }
        // A cancelled credential prompt is a Cancel, as for a fetch.
        res.map(|_| ()).map_err(|e| crate::netops::user_cancelled(e, net.op))
    }
    /// 2. The relation (gix, under the lock), then §6.1's autostash: a fast-forward only on
    ///    overlap; a merge or rebase on any tracked change; up to date, or diverged and FfOnly,
    ///    none.
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let checked_out = pre.before.head.branch.as_deref() == Some(self.branch.as_str());
        if !checked_out {
            if self.mode != PullMode::FfOnly {
                return Err(check_out_first(&self.branch));
            }
            if let Some(path) = checked_out_elsewhere(pre.api, pre.root, &self.branch).await? {
                return Err(elsewhere_error(&self.branch, &path));
            }
        }
        let (local, upstream, ahead, behind) = {
            let repo = gix::open(pre.root).map_err(gix_err)?;
            let oid = |name: &str| -> Result<gix::ObjectId, GbError> {
                let hex = read_ref(&repo, name)?.ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("{} doesn't exist", crate::error::short_ref(name))))?;
                gix::ObjectId::from_hex(hex.as_bytes()).map_err(gix_err)
            };
            let (local, upstream) = (oid(&self.local())?, oid(&self.upstream_ref)?);
            let (ahead, behind) = integrate::relation(&repo, local, upstream)?;
            (local, upstream, ahead, behind)
        };
        let _ = self.planned.set(PullPlan { checked_out, local, upstream, ahead, behind });
        if !checked_out || behind == 0 {
            return Ok(Plan::default());
        }
        // --- 2C repo-safety ---
        // Each way the pull moves the worktree (the fast-forward, the merge's checkout, the
        // rebase's checkout of the upstream) is a two-way move that deletes a populated submodule
        // or an embedded clone whole where it writes a file (safety review 2 N2): refused first;
        // the check also says what the move sweeps away (M1, M2), carried by the rule.
        use crate::write::precheck::{refuse_repos_in_the_way, refuse_repos_in_the_way_of_merge};
        // --- end 2C repo-safety ---
        match (ahead, self.mode) {
            (0, _) => {
                let rule = refuse_repos_in_the_way(&pre.api.cli, pre.root, local, upstream, "pull").await?.rule();
                Ok(Plan { autostash: Some(self.autostash(rule, upstream)), ..Plan::default() })
            }
            (_, PullMode::FfOnly) => Ok(Plan::default()),
            // `Merged`: the prediction runs against the merge, so a dirty file only the local
            // side changed isn't a predicted conflict.
            (_, PullMode::FfOrMerge) => {
                let rule = refuse_repos_in_the_way_of_merge(&pre.api.cli, pre.root, local, upstream, "pull").await?.rule_over(AutostashRule::Merged);
                Ok(Plan { autostash: Some(self.autostash(rule, upstream)), ..Plan::default() })
            }
            (_, PullMode::Rebase) => {
                // T9's checks (the lossy-merge refusal, `--rebase-merges`, the repository in the
                // way of the upstream's checkout), with pull's stash.
                let mut plan = self.rebase.plan(pre).await?;
                let rule = refuse_repos_in_the_way(&pre.api.cli, pre.root, local, upstream, "pull").await?.rule_over(AutostashRule::Rebased);
                plan.autostash = Some(self.autostash(rule, upstream));
                Ok(plan)
            }
        }
    }
    /// 3. The integrate step, by §12.2's table.
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<PullOutcome, GbError> {
        let PullPlan { checked_out, local, upstream, ahead, behind } = *self.planned.get().ok_or_else(|| GbError::new(GbErrorKind::Other, "pull ran without its plan"))?;
        let result = match (ahead, behind) {
            (_, 0) => PullResult::UpToDate { ahead },
            // Deviation 13: the Sync row on a branch that isn't checked out: a CAS.
            (0, _) if !checked_out => {
                let msg = format!("pull {}: Fast-forward", self.upstream);
                cx.cas(&[RefMove { name: self.local(), old: Some(local.to_string()), new: Some(upstream.to_string()) }], &msg).await?;
                cx.touch(ChangeKind::Refs);
                PullResult::FastForward { commits: behind }
            }
            (0, _) => {
                let inv = cx.git(["merge", "--ff-only", self.upstream_ref.as_str()]);
                let res = cx.run_git(inv).await;
                for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Refs] {
                    cx.touch(k);
                }
                res?;
                PullResult::FastForward { commits: behind }
            }
            _ if !checked_out || self.mode == PullMode::FfOnly => {
                let root = cx.root.to_path_buf();
                let conflicts = crate::api::blocking(move || Ok(integrate::predicted_conflicts(&gix::open(&root).map_err(gix_err)?, local, upstream)?.len() as u32)).await?;
                PullResult::Diverged { ahead, behind, conflicts }
            }
            _ => {
                let done = match self.mode {
                    PullMode::Rebase => {
                        let out = self.rebase.run(cx).await;
                        // The banner names the upstream as the user knows it.
                        if let Some(pause) = cx.paused.as_mut() {
                            pause.target = self.upstream.clone();
                        }
                        out?
                    }
                    _ => integrate::run_merge(cx, &self.upstream_ref, &self.upstream, false).await?,
                };
                match done {
                    IntegrateOutcome::Stopped { kind, files, warning } => PullResult::Stopped { kind, files, warning },
                    IntegrateOutcome::Done { commits, .. } if self.mode == PullMode::Rebase => PullResult::Rebased { commits },
                    IntegrateOutcome::Done { commits, .. } => PullResult::Merged { commits },
                    IntegrateOutcome::UpToDate { .. } | IntegrateOutcome::Aborted { .. } => PullResult::UpToDate { ahead },
                }
            }
        };
        let server = self.server.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Ok(PullOutcome { op: cx.op.id, branch: self.branch.clone(), upstream: self.upstream.clone(), server, result })
    }
}

/// Pull (§12.2): `branch` (default HEAD's) from its upstream. Refused before anything runs when
/// there is none, and (Deviation 13) when a branch that isn't checked out would need more than a
/// fast-forward, or is checked out in another worktree.
pub(crate) async fn pull(api: &Api, repo: u32, worktree: &str, branch: Option<String>, mode: PullMode, expect: Expect, confirm: Confirm) -> Result<WriteResult<PullOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let r = root.clone();
    let (head, branch, upstream) = crate::api::blocking(move || {
        let g = gix::open(&r).map_err(gix_err)?;
        // Review M2: preflight refuses this too, but only after the fetch (a network round trip,
        // perhaps a credential prompt).
        if let Some(what) = g.state().and_then(crate::write::in_progress_name) {
            return Err(GbError::in_progress(what));
        }
        let head = integrate::head_branch(&g);
        let name = branch.or_else(|| head.clone());
        let up = name.as_deref().and_then(|b| Some((config(&g, &format!("branch.{b}.remote")).filter(|x| x != ".")?, config(&g, &format!("branch.{b}.merge"))?)));
        Ok::<_, GbError>((head, name, up))
    })
    .await?;
    let branch = branch.ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "HEAD is detached; check out a branch to pull"))?;
    let (remote, merge) = upstream.ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("{branch} has no upstream; set one from Push ▾")))?;
    let checked_out = head.as_deref() == Some(branch.as_str());
    if !checked_out {
        if mode != PullMode::FfOnly {
            return Err(check_out_first(&branch));
        }
        if let Some(path) = checked_out_elsewhere(api, &root, &branch).await? {
            return Err(elsewhere_error(&branch, &path));
        }
    }
    let short = merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string();
    run_write(api, repo, worktree, expect, PullIntent::new(branch, mode, remote, &short, confirm, checked_out)).await
}
// --- end 2D T14 ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Api, Request};
    use crate::error::GbErrorKind;
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::path::Path;
    use std::sync::Arc;

    fn api() -> (Api, tempfile::TempDir) {
        let data = tempfile::tempdir().unwrap();
        (Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf()), data)
    }

    async fn open(api: &Api, path: &Path) -> u32 {
        api.dispatch(Request::OpenRepo { path: path.display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32
    }

    fn wt(p: &Path) -> String {
        p.canonicalize().unwrap().display().to_string()
    }

    fn push(id: u32, r: &TestRepo, branch: &str) -> Request {
        Request::Push { repo: id, worktree: wt(r.path()), branch: branch.into(), target: None, set_upstream: None, lease: None, expect: Default::default() }
    }

    /// §12.3, §12.4: the push reaches its upstream; the server's lines are counted; it's a
    /// barrier ("Push can't be undone").
    #[tokio::test]
    async fn a_push_reaches_its_upstream_with_server_output_and_is_a_barrier() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        r.commit("more dev");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(push(id, &r, "dev")).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "origin/dev"]), r.git(&["rev-parse", "dev"]));
        assert_eq!((res["outcome"]["remote"].as_str(), res["outcome"]["dst"].as_str()), (Some("origin"), Some("dev")));
        assert_eq!(res["outcome"]["server"], serde_json::json!({"lines": 2, "warning": "integration: rebase onto dev failed: conflict in a.txt"}));
        assert_eq!(res["journal"]["undoBlocked"], "Push can't be undone");
    }

    /// 2C final I4: the worktree writes' `submodule.recurse=false` pin stays off the push, so
    /// the user's `push.recurseSubmodules=check` still refuses a push whose submodule commit
    /// isn't on any of the submodule's remotes, as plain `git push` does.
    #[tokio::test]
    async fn a_push_honours_push_recurse_submodules_check() {
        let sub = TestRepo::new();
        sub.commit("s1");
        let r = TestRepo::new();
        r.commit("one");
        r.add_origin();
        r.push("main");
        r.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", &sub.path().display().to_string(), "sm"]);
        r.git(&["commit", "-q", "-m", "add sm"]);
        let sm = r.path().join("sm");
        std::fs::write(sm.join("s.txt"), "unpushed\n").unwrap();
        r.git_in(&sm, &["add", "s.txt"]);
        r.git_in(&sm, &["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-q", "-m", "unpushed"]);
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "bump sm"]);
        r.git(&["config", "push.recurseSubmodules", "check"]);
        let pushed = r.git(&["rev-parse", "origin/main"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let err = api.dispatch(push(id, &r, "main")).await.unwrap_err();
        assert!(format!("{} {:?}", err.message, err.stderr).contains("submodule"), "{err:?}");
        let origin = r.root().join("origin.git");
        assert_eq!(r.git_in(&origin, &["rev-parse", "main"]), pushed, "nothing reached the remote");
        // The check was the only obstacle: without it, the same push goes through.
        r.git(&["config", "--unset", "push.recurseSubmodules"]);
        api.dispatch(push(id, &r, "main")).await.unwrap();
        assert_eq!(r.git_in(&origin, &["rev-parse", "main"]), r.git(&["rev-parse", "main"]));
    }

    #[tokio::test]
    async fn set_upstream_pushes_and_tracks() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let req = Request::Push { repo: id, worktree: wt(r.path()), branch: "feature/new".into(), target: Some(PushTarget { remote: "origin".into(), branch: "feature/new".into() }), set_upstream: Some(true), lease: None, expect: Default::default() };
        api.dispatch(req).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "feature/new@{upstream}"]), "origin/feature/new");
    }

    #[tokio::test]
    async fn no_upstream_and_no_target_is_refused_before_anything_runs() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let err = api.dispatch(push(id, &r, "feature/new")).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "feature/new has no upstream; set one from Push ▾"));
    }

    /// §12.3 triangular: `remote.pushDefault` names the remote; the branch keeps its name.
    #[test]
    fn the_target_follows_push_remote_settings() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        let repo = gix::open(r.path()).unwrap();
        assert_eq!(push_target(&repo, "dev"), Some(PushTarget { remote: "origin".into(), branch: "dev".into() }));
        assert_eq!(push_target(&repo, "feature/new"), None);
        r.git(&["config", "branch.dev.merge", "refs/heads/develop"]);
        assert_eq!(push_target(&gix::open(r.path()).unwrap(), "dev"), Some(PushTarget { remote: "origin".into(), branch: "develop".into() }));
        r.git(&["config", "remote.pushDefault", "fork"]);
        assert_eq!(push_target(&gix::open(r.path()).unwrap(), "dev"), Some(PushTarget { remote: "fork".into(), branch: "dev".into() }));
        r.git(&["config", "branch.dev.pushRemote", "mine"]);
        assert_eq!(push_target(&gix::open(r.path()).unwrap(), "dev"), Some(PushTarget { remote: "mine".into(), branch: "dev".into() }));
    }

    /// §12.3, §17.1 ref safety: behind → NonFastForward; a force with the lease shown works; one
    /// whose lease went stale (someone pushed since) is RefMoved, and the remote is untouched.
    #[tokio::test]
    async fn force_with_lease_uses_the_oid_shown() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.git(&["fetch", "-q", "origin"]);
        r.commit("local only");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let rejected = api.dispatch(push(id, &r, "main")).await.unwrap_err();
        assert_eq!((rejected.kind, rejected.message.as_str()), (GbErrorKind::NonFastForward, "origin/main has commits main doesn't have"));
        let shown = r.git(&["rev-parse", "origin/main"]);
        r.push_from_clone("main", "late.txt", "late\n", "Pushed meanwhile");
        let force = |oid: &str| Request::Push { repo: id, worktree: wt(r.path()), branch: "main".into(), target: None, set_upstream: None, lease: Some(Lease { oid: Some(oid.into()) }), expect: Default::default() };
        assert_eq!(api.dispatch(force(&shown)).await.unwrap_err().kind, GbErrorKind::RefMoved, "the lease is stale");
        let origin = r.root().join("origin.git");
        assert_ne!(r.git_in(&origin, &["rev-parse", "main"]), r.git(&["rev-parse", "main"]));
        r.git(&["fetch", "-q", "origin"]);
        api.dispatch(force(&r.git(&["rev-parse", "origin/main"]))).await.unwrap();
        assert_eq!(r.git_in(&origin, &["rev-parse", "main"]), r.git(&["rev-parse", "main"]));
    }

    /// A server-side rejection: its `remote:` lines lead the error's Details.
    #[tokio::test]
    async fn a_server_rejection_puts_the_remote_lines_first() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        r.commit("more");
        r.origin_hook("pre-receive", "#!/bin/sh\necho 'Branch dev is protected'\nexit 1\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let err = api.dispatch(push(id, &r, "dev")).await.unwrap_err();
        assert!(err.stderr.as_deref().unwrap_or("").starts_with("remote: Branch dev is protected"), "{:?}", err.stderr);
    }

    #[tokio::test]
    async fn a_rejecting_pre_push_is_hook_failed() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        r.commit("more");
        r.hook("pre-push", "#!/bin/sh\necho 'no pushes on Friday' >&2\nexit 1\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let err = api.dispatch(push(id, &r, "dev")).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::HookFailed);
    }

    /// §3.5 with a real push: a discard runs while the push waits in its `pre-push` hook.
    #[tokio::test]
    async fn a_discard_runs_during_a_push() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        r.commit("more");
        let go = r.root().join("go");
        r.hook("pre-push", &format!("#!/bin/sh\nwhile [ ! -f '{}' ]; do sleep 0.05; done\n", go.display()));
        r.write("file_0.txt", "dirty\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let (pushed, ()) = tokio::join!(api.dispatch(push(id, &r, "dev")), async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let discard = crate::write::test_intents::TestIntent::Discard { paths: vec!["file_0.txt".into()] };
            crate::write::test_intents::run(&api, id, &wt(r.path()), Default::default(), discard).await.unwrap();
            std::fs::write(&go, "").unwrap();
        });
        pushed.unwrap();
        assert_eq!(r.git(&["rev-parse", "origin/dev"]), r.git(&["rev-parse", "dev"]));
    }

    // --- ux round 2: rewrite marks (§12.3) ---
    /// `dev` (pushed, tracking origin/dev) rebased in GitBolt onto a new local `main` commit.
    async fn rebased_dev() -> (TestRepo, Api, tempfile::TempDir, u32, String) {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.commit("Main moves on");
        r.switch("dev");
        let pushed = r.git(&["rev-parse", "origin/dev"]);
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        let req = Request::Integrate { repo: id, worktree: wt(r.path()), kind: crate::write::integrate::IntegrateKind::Rebase, target: "main".into(), update_refs: None, expect: Default::default(), ff_only: None, confirm: Default::default() };
        api.dispatch(req).await.unwrap();
        assert_ne!(r.git(&["rev-parse", "dev"]), pushed, "dev was rewritten");
        (r, api, data, id, pushed)
    }

    fn origin(r: &TestRepo, branch: &str) -> String {
        r.git_in(&r.root().join("origin.git"), &["rev-parse", branch])
    }

    /// The sidebar's `rewritten` for `branch`.
    async fn rewritten(api: &Api, id: u32, branch: &str) -> serde_json::Value {
        let s = api.dispatch(Request::Sidebar { repo: id }).await.unwrap();
        let b = s["locals"].as_array().unwrap().iter().find(|b| b["name"] == branch).unwrap()["rewritten"].clone();
        if !b.is_null() {
            assert_eq!(b["remote"], "origin");
        }
        b["kind"].clone()
    }

    #[tokio::test]
    async fn a_rebased_pushed_branch_force_pushes_with_its_lease_without_asking() {
        let (r, api, _data, id, _) = rebased_dev().await;
        assert_eq!(rewritten(&api, id, "dev").await, "rebase");
        let res = api.dispatch(push(id, &r, "dev")).await.unwrap();
        assert_eq!(res["outcome"]["forced"], "rebase");
        assert_eq!(origin(&r, "dev"), r.git(&["rev-parse", "dev"]));
        assert_eq!(rewritten(&api, id, "dev").await, serde_json::Value::Null, "the push spent the mark");
    }

    #[tokio::test]
    async fn the_lease_fails_when_someone_pushed_since_the_rebase() {
        let (r, api, _data, id, _) = rebased_dev().await;
        r.push_from_clone("dev", "theirs.txt", "theirs\n", "Pushed meanwhile");
        let theirs = origin(&r, "dev");
        let err = api.dispatch(push(id, &r, "dev")).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::NonFastForward, "origin/dev has commits dev doesn't have"), "today's rejected push");
        assert_eq!(origin(&r, "dev"), theirs, "the remote is untouched");
    }

    /// The lease is the oid recorded at the rebase, not the one a later fetch left.
    #[tokio::test]
    async fn a_fetch_after_the_rebase_doesnt_widen_the_lease() {
        let (r, api, _data, id, pushed) = rebased_dev().await;
        r.push_from_clone("dev", "theirs.txt", "theirs\n", "Pushed meanwhile");
        r.git(&["fetch", "-q", "origin"]);
        let theirs = r.git(&["rev-parse", "origin/dev"]);
        assert_ne!(theirs, pushed);
        assert_eq!(api.dispatch(push(id, &r, "dev")).await.unwrap_err().kind, GbErrorKind::NonFastForward);
        assert_eq!(origin(&r, "dev"), theirs, "the remote is untouched");
        let line = api.cli.log().entries().into_iter().rev().find(|e| e.args.iter().any(|a| a.contains("force-with-lease"))).expect("a lease push ran");
        assert!(line.args.iter().any(|a| a == &format!("--force-with-lease=refs/heads/dev:{pushed}")), "{:?}", line.args);
    }

    #[tokio::test]
    async fn an_amended_pushed_commit_force_pushes_with_its_lease() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let amend = Request::Commit { repo: id, worktree: wt(r.path()), summary: "Dev work, reworded".into(), description: String::new(), amend: true, stage_all: false, expect: Default::default() };
        api.dispatch(amend).await.unwrap();
        assert_eq!(rewritten(&api, id, "dev").await, "amend");
        let res = api.dispatch(push(id, &r, "dev")).await.unwrap();
        assert_eq!(res["outcome"]["forced"], "amend");
        assert_eq!(origin(&r, "dev"), r.git(&["rev-parse", "dev"]));
    }

    /// Review round 1 (a): a reset never forces silently, so the confirmation shows what it loses.
    #[tokio::test]
    async fn a_reset_of_a_pushed_branch_records_no_mark() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        let pushed = r.git(&["rev-parse", "dev"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let reset = Request::Reset { repo: id, worktree: wt(r.path()), to: r.git(&["rev-parse", "dev~1"]), mode: crate::write::reset::ResetMode::Soft, expect: Default::default(), discard: None };
        api.dispatch(reset).await.unwrap();
        assert_eq!(rewritten(&api, id, "dev").await, serde_json::Value::Null);
        assert_eq!(api.dispatch(push(id, &r, "dev")).await.unwrap_err().kind, GbErrorKind::NonFastForward, "today's rejected push");
        assert_eq!(origin(&r, "dev"), pushed);
    }

    /// Review round 1 (b): a rebase that replaces a colleague's commit asks as today.
    #[tokio::test]
    async fn a_rebase_over_a_colleagues_commit_records_no_mark() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch_new("shared");
        r.commit_as("Colleague's work", "Grace Hopper", "grace@example.com");
        r.commit("My work");
        r.push("shared");
        r.switch("main");
        r.commit("Main moves on");
        r.switch("shared");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let req = Request::Integrate { repo: id, worktree: wt(r.path()), kind: crate::write::integrate::IntegrateKind::Rebase, target: "main".into(), update_refs: None, expect: Default::default(), ff_only: None, confirm: Default::default() };
        api.dispatch(req).await.unwrap();
        assert_eq!(rewritten(&api, id, "shared").await, serde_json::Value::Null);
        assert_eq!(api.dispatch(push(id, &r, "shared")).await.unwrap_err().kind, GbErrorKind::NonFastForward);
    }

    /// Review round 1 (c): the remote's default branch never force-pushes silently, own commits
    /// or not; with no `refs/remotes/<r>/HEAD`, main, master and trunk count as default.
    #[tokio::test]
    async fn a_rebase_of_the_default_branch_records_no_mark() {
        let r = TestRepo::new();
        r.commit("one");
        r.add_origin();
        r.push("main");
        r.git(&["remote", "set-head", "origin", "main"]);
        r.switch_new("side");
        r.commit("side");
        r.switch("main");
        r.commit("two");
        r.push("main");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let req = Request::Integrate { repo: id, worktree: wt(r.path()), kind: crate::write::integrate::IntegrateKind::Rebase, target: "side".into(), update_refs: None, expect: Default::default(), ff_only: None, confirm: Default::default() };
        api.dispatch(req).await.unwrap();
        assert_eq!(rewritten(&api, id, "main").await, serde_json::Value::Null);
        let repo = gix::open(r.path()).unwrap();
        assert!(crate::write::rewrites::is_default_branch(&repo, "origin", "main"));
        assert!(!crate::write::rewrites::is_default_branch(&repo, "origin", "trunk"), "the remote's HEAD decides");
        r.git(&["remote", "set-head", "origin", "-d"]);
        let repo = gix::open(r.path()).unwrap();
        assert!(crate::write::rewrites::is_default_branch(&repo, "origin", "trunk") && !crate::write::rewrites::is_default_branch(&repo, "origin", "side"));
    }

    /// Review round 1 (low 3): after a fetch moved the remote-tracking ref off the lease, the
    /// sidebar doesn't promise a force (the push would be refused).
    #[tokio::test]
    async fn the_sidebar_drops_the_promise_when_the_tracking_ref_left_the_lease() {
        let (r, api, _data, id, _) = rebased_dev().await;
        r.push_from_clone("dev", "theirs.txt", "theirs\n", "Pushed meanwhile");
        r.git(&["fetch", "-q", "origin"]);
        assert_eq!(rewritten(&api, id, "dev").await, serde_json::Value::Null);
    }

    /// Review round 1 (low 5): a mark the sidebar sees dead is dropped, so it can't come back.
    #[tokio::test]
    async fn a_dead_mark_doesnt_come_back() {
        let (r, api, data, id, _) = rebased_dev().await;
        let tip = r.git(&["rev-parse", "dev"]);
        r.git(&["reset", "-q", "--hard", "main"]);
        assert_eq!(rewritten(&api, id, "dev").await, serde_json::Value::Null);
        r.git(&["reset", "-q", "--hard", &tip]);
        assert_eq!(rewritten(&api, id, "dev").await, serde_json::Value::Null);
        assert!(crate::write::rewrites::RewriteStore::new(data.path(), &r.path().join(".git")).peek().is_empty());
    }

    /// Committing more after a rebase is normal: the mark still applies.
    #[tokio::test]
    async fn more_commits_after_the_rebase_keep_the_mark() {
        let (r, api, _data, id, _) = rebased_dev().await;
        r.commit("More after the rebase");
        assert_eq!(rewritten(&api, id, "dev").await, "rebase");
        let res = api.dispatch(push(id, &r, "dev")).await.unwrap();
        assert_eq!(res["outcome"]["forced"], "rebase");
        assert_eq!(origin(&r, "dev"), r.git(&["rev-parse", "dev"]));
    }

    /// A reset outside GitBolt to somewhere else ends the mark: Push asks again.
    #[tokio::test]
    async fn an_outside_reset_elsewhere_drops_the_mark() {
        let (r, api, _data, id, pushed) = rebased_dev().await;
        r.git(&["reset", "-q", "--hard", "main"]);
        assert_eq!(rewritten(&api, id, "dev").await, serde_json::Value::Null);
        assert_eq!(api.dispatch(push(id, &r, "dev")).await.unwrap_err().kind, GbErrorKind::NonFastForward);
        assert_eq!(origin(&r, "dev"), pushed, "nothing was forced");
    }

    #[tokio::test]
    async fn undoing_the_rebase_drops_the_mark() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.commit("Main moves on");
        r.switch("dev");
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        let req = Request::Integrate { repo: id, worktree: wt(r.path()), kind: crate::write::integrate::IntegrateKind::Rebase, target: "main".into(), update_refs: None, expect: Default::default(), ff_only: None, confirm: Default::default() };
        let res = api.dispatch(req).await.unwrap();
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "dev"]), r.git(&["rev-parse", "origin/dev"]));
        let store = crate::write::rewrites::RewriteStore::new(data.path(), &r.path().join(".git"));
        assert!(store.peek().is_empty(), "the undo dropped it, not just hid it");
    }

    /// A rebase over commits on the remote the branch never had records nothing: those are never
    /// leased away.
    #[tokio::test]
    async fn no_mark_when_the_remote_had_commits_the_branch_didnt() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.git(&["fetch", "-q", "origin"]);
        r.commit("Main moves on");
        r.switch("diverged");
        let before = r.git(&["rev-parse", "diverged"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let req = Request::Integrate { repo: id, worktree: wt(r.path()), kind: crate::write::integrate::IntegrateKind::Rebase, target: "main".into(), update_refs: None, expect: Default::default(), ff_only: None, confirm: Default::default() };
        api.dispatch(req).await.unwrap();
        assert_ne!(r.git(&["rev-parse", "diverged"]), before, "it was rebased");
        assert_eq!(rewritten(&api, id, "diverged").await, serde_json::Value::Null);
    }
    // --- end ux round 2 ---

    // --- 2D T14: pull ---
    fn pull(id: u32, r: &TestRepo, branch: Option<&str>, mode: PullMode) -> Request {
        Request::Pull { repo: id, worktree: wt(r.path()), branch: branch.map(str::to_string), mode, expect: Default::default(), confirm: Default::default() }
    }

    /// §12.2: fast-forward; undo rewinds main and keeps the fetched origin/main.
    #[tokio::test]
    async fn a_fast_forward_pull_and_its_undo() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        let before = r.git(&["rev-parse", "main"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(pull(id, &r, None, PullMode::FfOnly)).await.unwrap();
        assert_eq!(res["outcome"]["result"], serde_json::json!({"status": "fastForward", "commits": 1}));
        assert_eq!(res["outcome"]["upstream"], "origin/main");
        assert_eq!(r.git(&["rev-parse", "main"]), r.git(&["rev-parse", "origin/main"]));
        assert_eq!(res["journal"]["undo"]["label"], "pull main");
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
        assert_ne!(r.git(&["rev-parse", "origin/main"]), before, "the fetched remote branch stays");
    }

    /// §12.2's table, diverged: FfOnly asks (nothing changes locally); FfOrMerge merges;
    /// Rebase rebases (`--fork-point`).
    #[tokio::test]
    async fn a_diverged_pull_by_mode() {
        for mode in [PullMode::FfOnly, PullMode::FfOrMerge, PullMode::Rebase] {
            let r = TestRepo::new();
            fixtures::sync(&r);
            r.switch("diverged");
            let tip = r.git(&["rev-parse", "diverged"]);
            let (api, data) = api();
            let id = open(&api, r.path()).await;
            let res = api.dispatch(pull(id, &r, None, mode)).await.unwrap();
            match mode {
                PullMode::FfOnly => {
                    assert_eq!(res["outcome"]["result"], serde_json::json!({"status": "diverged", "ahead": 1, "behind": 1, "conflicts": 0}));
                    assert_eq!(r.git(&["rev-parse", "diverged"]), tip);
                    let git_dir = r.path().join(".git").canonicalize().unwrap();
                    assert!(crate::journal::JournalStore::new(data.path(), &git_dir, &r.path().canonicalize().unwrap()).load().unwrap().undo.is_empty());
                }
                PullMode::FfOrMerge => {
                    assert_eq!(res["outcome"]["result"]["status"], "merged");
                    assert_eq!(r.git(&["rev-list", "--count", "--merges", "-1", "diverged"]), "1");
                }
                PullMode::Rebase => {
                    assert_eq!(res["outcome"]["result"]["status"], "rebased");
                    assert_eq!(r.git(&["rev-list", "--count", "--merges", "origin/diverged..diverged"]), "0");
                    assert_eq!(r.git(&["rev-list", "--count", "origin/diverged..diverged"]), "1");
                }
            }
        }
    }

    #[tokio::test]
    async fn up_to_date_and_ahead_change_nothing() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        assert_eq!(api.dispatch(pull(id, &r, None, PullMode::FfOnly)).await.unwrap()["outcome"]["result"], serde_json::json!({"status": "upToDate", "ahead": 0}));
        r.commit("ahead");
        assert_eq!(api.dispatch(pull(id, &r, None, PullMode::FfOnly)).await.unwrap()["outcome"]["result"], serde_json::json!({"status": "upToDate", "ahead": 1}));
    }

    /// Deviation 13: the Sync row on a branch that isn't checked out: ff-only, as a CAS.
    #[tokio::test]
    async fn pulling_a_branch_that_isnt_checked_out() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(pull(id, &r, Some("main"), PullMode::FfOnly)).await.unwrap();
        assert_eq!(res["outcome"]["result"]["status"], "fastForward");
        assert_eq!(r.git(&["rev-parse", "main"]), r.git(&["rev-parse", "origin/main"]));
        assert_eq!(r.git(&["branch", "--show-current"]), "dev");
        let err = api.dispatch(pull(id, &r, Some("diverged"), PullMode::Rebase)).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "Check out diverged first"));
    }

    /// §17.1: a pull that autostashes keeps the staged/unstaged split byte for byte.
    #[tokio::test]
    async fn an_autostashed_pull_keeps_the_staged_split() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("diverged");
        r.write("a.txt", "staged whole\n");
        r.git(&["add", "a.txt"]);
        r.write("local.txt", "staged\n");
        r.git(&["add", "local.txt"]);
        r.write("local.txt", "staged\nthen more, unstaged\n");
        r.write("c.txt", "untracked\n");
        let (cached, plain) = (r.git(&["diff", "--cached"]), r.git(&["diff"]));
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        api.dispatch(pull(id, &r, None, PullMode::FfOrMerge)).await.unwrap();
        assert_eq!((r.git(&["diff", "--cached"]), r.git(&["diff"])), (cached, plain));
        assert_eq!(std::fs::read_to_string(r.path().join("c.txt")).unwrap(), "untracked\n");
    }

    /// §13.2: a conflicted pull stops and waits, its banner naming the upstream as shown.
    #[tokio::test]
    async fn a_conflicted_pull_pauses_on_the_upstream() {
        for (mode, kind) in [(PullMode::FfOrMerge, "merge"), (PullMode::Rebase, "rebase")] {
            let r = TestRepo::new();
            fixtures::sync(&r);
            r.switch("diverged");
            r.write("remote-side.txt", "local\n");
            r.git(&["add", "remote-side.txt"]);
            r.git(&["commit", "-q", "-m", "Clash"]);
            let (api, data) = api();
            let id = open(&api, r.path()).await;
            let res = api.dispatch(pull(id, &r, None, mode)).await.unwrap();
            assert_eq!(res["outcome"]["result"], serde_json::json!({"status": "stopped", "kind": kind, "files": 1}));
            let git_dir = r.path().join(".git").canonicalize().unwrap();
            let journal = crate::journal::JournalStore::new(data.path(), &git_dir, &r.path().canonicalize().unwrap()).load().unwrap();
            let paused = journal.paused().and_then(|e| e.paused.clone()).expect("paused");
            assert_eq!(paused.target, "origin/diverged");
        }
    }

    /// Review I1: a pull that moves no local branch still announces the refs its fetch moved.
    #[tokio::test]
    async fn a_pull_announces_the_fetched_refs_even_when_nothing_local_moves() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("diverged");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let mut rx = api.subscribe();
        let res = api.dispatch(pull(id, &r, None, PullMode::FfOnly)).await.unwrap();
        assert_eq!(res["outcome"]["result"]["status"], "diverged");
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            events.push(ev);
        }
        assert!(events.contains(&crate::events::AppEvent::RefsUpdated { repo: id }), "{events:?}");
        assert!(events.iter().any(|e| matches!(e, crate::events::AppEvent::OpProgress { percent: Some(_), .. })), "the fetch's progress: {events:?}");
    }

    fn dirty_split(r: &TestRepo) -> (String, String) {
        r.write("a.txt", "staged whole\n");
        r.git(&["add", "a.txt"]);
        r.write("local.txt", "staged\n");
        r.git(&["add", "local.txt"]);
        r.write("local.txt", "staged\nthen more, unstaged\n");
        (r.git(&["diff", "--cached"]), r.git(&["diff"]))
    }

    /// Review M6: a rebase-mode pull over a dirty worktree rebases, then restores the split.
    #[tokio::test]
    async fn a_rebase_pull_over_a_dirty_worktree_keeps_the_split() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("diverged");
        let split = dirty_split(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(pull(id, &r, None, PullMode::Rebase)).await.unwrap();
        assert_eq!(res["outcome"]["result"]["status"], "rebased");
        assert_eq!((r.git(&["diff", "--cached"]), r.git(&["diff"])), split);
    }

    /// Review M6: a pull's autostash waits through the pause, then comes back with the split.
    #[tokio::test]
    async fn a_paused_pulls_autostash_comes_back_with_the_split() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("diverged");
        r.write("remote-side.txt", "local\n");
        r.git(&["add", "remote-side.txt"]);
        r.git(&["commit", "-q", "-m", "Clash"]);
        let split = dirty_split(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(pull(id, &r, None, PullMode::FfOrMerge)).await.unwrap();
        assert_eq!(res["outcome"]["result"]["status"], "stopped");
        assert!(!r.path().join("a.txt").exists(), "stashed while paused");
        api.dispatch(Request::MergeAbort { repo: id, worktree: wt(r.path()) }).await.unwrap();
        assert_eq!((r.git(&["diff", "--cached"]), r.git(&["diff"])), split);
    }

    /// Review M6: undo of a branch that isn't checked out (MoveRefs) puts it back.
    #[tokio::test]
    async fn undo_of_a_pull_of_a_branch_that_isnt_checked_out() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        let before = r.git(&["rev-parse", "main"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(pull(id, &r, Some("main"), PullMode::FfOnly)).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "pull main");
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
        assert_eq!(r.git(&["branch", "--show-current"]), "dev");
    }

    /// Review M2: a paused merge refuses a pull before its fetch.
    #[tokio::test]
    async fn a_pull_during_a_merge_is_refused_before_the_fetch() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("diverged");
        r.write("remote-side.txt", "local\n");
        r.git(&["add", "remote-side.txt"]);
        r.git(&["commit", "-q", "-m", "Clash"]);
        r.git(&["fetch", "-q", "origin"]);
        assert!(r.try_git(&["merge", "origin/diverged"]).is_err());
        let fetched = r.git(&["rev-parse", "origin/main"]);
        r.push_from_clone("main", "later.txt", "later\n", "Later");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        assert_eq!(api.dispatch(pull(id, &r, None, PullMode::FfOrMerge)).await.unwrap_err().kind, GbErrorKind::InProgress);
        assert_eq!(r.git(&["rev-parse", "origin/main"]), fetched, "no fetch ran");
    }

    #[tokio::test]
    async fn no_upstream_is_refused() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("feature/new");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let err = api.dispatch(pull(id, &r, None, PullMode::FfOnly)).await.unwrap_err();
        assert_eq!(err.message, "feature/new has no upstream; set one from Push ▾");
    }
    // --- end 2D T14 ---

    // --- 3B T4 ---
    /// Spec #3 §3.9: "Push tags with branches" (`--follow-tags`), off by default: an annotated tag
    /// on the pushed commits goes along only when it's on.
    #[tokio::test]
    async fn follow_tags_sends_the_branchs_annotated_tags_only_when_set() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch("dev");
        r.commit("more dev");
        r.tag("v-dev", "HEAD");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let origin = r.root().join("origin.git");
        api.dispatch(push(id, &r, "dev")).await.unwrap();
        assert!(r.try_git_in(&origin, &["rev-parse", "--verify", "-q", "refs/tags/v-dev"]).is_err(), "off by default");
        r.commit("again");
        let mut s = api.store().state().settings;
        s.push_follow_tags = true;
        api.store().save_settings(s);
        api.dispatch(push(id, &r, "dev")).await.unwrap();
        assert_eq!(r.git_in(&origin, &["rev-parse", "refs/tags/v-dev"]), r.git(&["rev-parse", "refs/tags/v-dev"]));
    }
    // --- end 3B T4 ---
}
