//! Merge, rebase and fast-forward (spec #2 §13.1): the Integrate request and what it answers.

use crate::api::{blocking, Api};
use crate::error::{gix_err, short_ref, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{PausedKind, RefMove, UndoKind};
use crate::write::is_ancestor;
use crate::write::rebase::RebaseIntent;
use crate::write::run_write;
use crate::write::types::{Confirm, Expect, WriteResult};
use crate::write::{Pause, Plan, Pre, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use gix::ObjectId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum IntegrateKind {
    Rebase,
    Merge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum IntegrateOutcome {
    /// `commits` rebased (or merged in); `fast_forward`: git fast-forwarded the branch.
    Done {
        commits: u32,
        fast_forward: bool,
        /// 3C fix round 1 (R1): it completed, but something after it didn't (a chip marked
        /// delete that moved meanwhile is kept): the toast says so.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        warning: Option<String>,
        /// 3C final fix (M4): a reword of an older commit (spec #3 §3.6): the reworded commit's
        /// new oid, for the details panel to select.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rewritten: Option<String>,
    },
    /// Nothing to do ("Current branch main is up to date", "Already up to date").
    UpToDate {
        /// As `Done`'s.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        warning: Option<String>,
    },
    /// Stopped on conflicts (§13.2): the banner and the Conflicted section take over.
    Stopped {
        kind: PausedKind,
        files: u32,
        /// 3C final fix (M1, M2): something GitBolt meant to do at the stop didn't happen (a
        /// commit-msg hook refused a new message): the toast says so.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        warning: Option<String>,
    },
    /// Abort ran: the branch is back where it was.
    Aborted {
        /// 3C fix round 1 (I2): the work done at an interactive rebase's stop, kept as a stash
        /// (its oid) before the abort reset it: "Your work from the stop is in a stash".
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stash: Option<String>,
        /// Fix round 2: the branch the commits made at the stop were kept on.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        branch: Option<String>,
        /// Fix round 2: a conflict stop: how many files' changes the abort discarded (fix round
        /// 3: the conflicted files and the user's unstaged edits; not what git merged cleanly).
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        discarded: Option<u32>,
    },
}

impl IntegrateOutcome {
    pub(crate) const UP_TO_DATE: IntegrateOutcome = IntegrateOutcome::UpToDate { warning: None };
    pub(crate) const ABORTED: IntegrateOutcome = IntegrateOutcome::Aborted { stash: None, branch: None, discarded: None };
    pub(crate) fn done(commits: u32, fast_forward: bool) -> IntegrateOutcome {
        IntegrateOutcome::Done { commits, fast_forward, warning: None, rewritten: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StackedBranch {
    /// Short name (`feature/a`).
    pub name: String,
    /// Checked out in another worktree: git doesn't move it, and the dialog says so (§13.1).
    pub worktree: Option<String>,
}

/// HEAD's branch (short name), or `None` when detached or unborn.
pub(crate) fn head_branch(repo: &gix::Repository) -> Option<String> {
    repo.head_name().ok().flatten().and_then(|n| n.as_bstr().to_str().ok()?.strip_prefix("refs/heads/").map(str::to_string))
}

/// Every local branch's full name.
pub(crate) fn local_branches(repo: &gix::Repository) -> Result<Vec<String>, GbError> {
    let refs = repo.references().map_err(gix_err)?;
    Ok(refs.local_branches().map_err(gix_err)?.filter_map(Result::ok).map(|r| r.name().as_bstr().to_string()).collect())
}

/// The local branches (other than `x`) with tips in `y..x`, as `--update-refs` sees them.
pub(crate) struct BranchSets {
    /// Tips on `x`'s first-parent chain: the stacked branches, which `--update-refs` moves along.
    pub stacked: Vec<(String, ObjectId)>,
    /// Tips reachable only through a merge's second or later parent: branches merged into `x`.
    /// Never stacked: `--update-refs` would move them too, so the rebase keeps them in place
    /// (2D T9 review I2).
    pub merged_in: Vec<(String, ObjectId)>,
}

/// `x`'s branches in `y..x` (full names, sorted), split by how `x` reaches them.
pub(crate) fn branch_sets(repo: &gix::Repository, x: &str, y: ObjectId) -> Result<BranchSets, GbError> {
    let x_full = format!("refs/heads/{x}");
    let x_tip = repo.find_reference(x_full.as_str()).map_err(gix_err)?.peel_to_id().map_err(gix_err)?.detach();
    let mut range = std::collections::HashSet::new();
    for info in repo.rev_walk([x_tip]).with_hidden([y]).all().map_err(gix_err)? {
        range.insert(info.map_err(gix_err)?.id);
    }
    let mut chain = std::collections::HashSet::new();
    let mut at = Some(x_tip);
    while let Some(id) = at.filter(|id| range.contains(id)) {
        chain.insert(id);
        at = repo.find_commit(id).map_err(gix_err)?.parent_ids().next().map(|p| p.detach());
    }
    let mut sets = BranchSets { stacked: Vec::new(), merged_in: Vec::new() };
    let mut names = local_branches(repo)?;
    names.sort();
    for name in names {
        if name == x_full {
            continue;
        }
        let Ok(mut r) = repo.find_reference(name.as_str()) else { continue };
        let Ok(tip) = r.peel_to_id() else { continue };
        let tip = tip.detach();
        if chain.contains(&tip) {
            sets.stacked.push((name, tip));
        } else if range.contains(&tip) {
            sets.merged_in.push((name, tip));
        }
    }
    Ok(sets)
}

/// §13.1: the stacked branches, the local branches other than `x` whose tips are on `x`'s
/// first-parent chain in `y..x`: the ones `--update-refs` moves along. A branch merged into `x`
/// isn't one (review I2). `elsewhere`: full branch name → the other worktree it's checked out in.
pub(crate) fn stacked_branches(repo: &gix::Repository, x: &str, y: ObjectId, elsewhere: &HashMap<String, String>) -> Result<Vec<StackedBranch>, GbError> {
    let mut out: Vec<StackedBranch> = branch_sets(repo, x, y)?.stacked.into_iter().map(|(name, _)| StackedBranch { name: short_ref(&name).to_string(), worktree: elsewhere.get(&name).cloned() }).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The first merge commit in `y..x` that git can't recreate as it is, as `abc1234 Merge side`:
/// its tree isn't the clean merge of its parents (a conflict resolution, or a change made in the
/// merge itself). `--rebase-merges` remerges each one from its rewritten parents, so it would
/// drop that change (review I2). In memory: nothing is written.
pub(crate) async fn lossy_merge(cli: &crate::git::GitCli, root: &std::path::Path, x_tip: ObjectId, y: ObjectId) -> Result<Option<String>, GbError> {
    let merges = merges_in(cli, root, x_tip, y).await?;
    let root = root.to_path_buf();
    blocking(move || lossy_among(&gix::open(&root).map_err(gix_err)?, &merges)).await
}

/// The merge commits in `y..x`: one `rev-list --min-parents=2` (a read), which walks the range
/// faster than anything here can, so a linear range (the usual rebase) costs one short git
/// process and no more (review P1). Non-empty: the rebase needs `--rebase-merges` (a linear one
/// doesn't, and its counter stays the commits' own, with no `label`/`reset` steps).
pub(crate) async fn merges_in(cli: &crate::git::GitCli, root: &std::path::Path, x_tip: ObjectId, y: ObjectId) -> Result<Vec<ObjectId>, GbError> {
    let (tip, not) = (x_tip.to_string(), format!("^{y}"));
    let out = cli.run(crate::git::GitInvocation::new(root, ["rev-list", "--min-parents=2", tip.as_str(), not.as_str(), "--"])).await?;
    String::from_utf8_lossy(&out.stdout).lines().map(|l| ObjectId::from_hex(l.trim().as_bytes()).map_err(gix_err)).collect()
}

/// `lossy_merge`'s check, on merges already found.
pub(crate) fn lossy_among(repo: &gix::Repository, merges: &[ObjectId]) -> Result<Option<String>, GbError> {
    if merges.is_empty() {
        return Ok(None);
    }
    let mem = repo.clone().with_object_memory();
    for &id in merges {
        let c = repo.find_commit(id).map_err(gix_err)?;
        let parents: Vec<ObjectId> = c.parent_ids().map(|p| p.detach()).collect();
        let tree = c.tree_id().map_err(gix_err)?.detach();
        let same = parents.len() == 2
            && match mem.tree_merge_options().map_err(gix_err).and_then(|o| mem.merge_commits(parents[0], parents[1], Default::default(), o.into()).map_err(gix_err)) {
                Ok(mut out) => !out.tree_merge.has_unresolved_conflicts(gix::merge::tree::TreatAsUnresolved::git()) && out.tree_merge.tree.write().ok().map(|t| t.detach()) == Some(tree),
                Err(_) => false,
            };
        if !same {
            let summary = c.message_raw_sloppy().lines().next().map(|l| l.to_str_lossy().to_string()).unwrap_or_default();
            return Ok(Some(format!("{} {summary}", id.to_hex_with_len(7))));
        }
    }
    Ok(None)
}

/// The refusal for a lossy merge (review I2), shared by the rebase and the preview (N4).
pub(crate) fn lossy_message(branch: &str, merge: &str, target: &str) -> String {
    format!("{branch} has a merge commit with changes of its own ({merge}); a rebase would drop them. Merge {} into {branch} instead", short_ref(target))
}

/// A label naming HEAD's branch, settled when the op runs (§3.6): a queued checkout ahead of it
/// changes which branch it acts on. Until then, the branch the request saw.
pub(crate) struct BranchLabel {
    make: Box<dyn Fn(&str) -> String + Send + Sync>,
    seen: String,
    at_run: std::sync::OnceLock<String>,
}

impl BranchLabel {
    pub(crate) fn new(seen: Option<String>, make: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
        Self { seen: make(seen.as_deref().unwrap_or("HEAD")), make: Box::new(make), at_run: std::sync::OnceLock::new() }
    }

    /// A label that names no branch (pull's own).
    pub(crate) fn fixed(label: String) -> Self {
        Self { make: Box::new(|_| String::new()), seen: label.clone(), at_run: std::sync::OnceLock::from(label) }
    }

    pub(crate) fn get(&self) -> String {
        self.at_run.get().cloned().unwrap_or_else(|| self.seen.clone())
    }

    /// From `plan`, under the lock: HEAD's branch as the op finds it.
    pub(crate) fn settle(&self, branch: &str) {
        let _ = self.at_run.set((self.make)(branch));
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn integrate(api: &Api, repo: u32, worktree: &str, kind: IntegrateKind, target: String, update_refs: Option<bool>, expect: Expect, confirm: Confirm) -> Result<WriteResult<IntegrateOutcome>, GbError> {
    // For the queue's label only: the branch, the label and the refs settle when the op runs,
    // under the lock (review M5), and `run_write` checks the worktree. A guess needs no `worktree
    // list` of its own (review P1).
    let root = std::path::PathBuf::from(worktree);
    let seen = blocking(move || Ok(gix::open(&root).ok().and_then(|r| head_branch(&r)))).await?;
    let short = short_ref(&target).to_string();
    match kind {
        IntegrateKind::Rebase => {
            let label = BranchLabel::new(seen, move |b| format!("rebase {b} onto {short}"));
            run_write(api, repo, worktree, expect, RebaseIntent { target, update_refs, fork_point: false, confirm, label, planned: Default::default() }).await
        }
        IntegrateKind::Merge => {
            let label = BranchLabel::new(seen, move |b| format!("merge {short} into {b}"));
            run_write(api, repo, worktree, expect, MergeIntent { target, confirm, label }).await
        }
    }
}

// --- 2D T10: merge, fast-forward, merge abort, the preview ---
/// `(ahead, behind)`: commits in `a` not in `b`, and in `b` not in `a`.
pub(crate) fn relation(repo: &gix::Repository, a: ObjectId, b: ObjectId) -> Result<(u32, u32), GbError> {
    let count = |from: ObjectId, hide: ObjectId| -> Result<u32, GbError> { Ok(repo.rev_walk([from]).with_hidden([hide]).all().map_err(gix_err)?.filter(Result::is_ok).count() as u32) };
    Ok((count(a, b)?, count(b, a)?))
}

pub(crate) struct MergeIntent {
    pub target: String,
    pub confirm: Confirm,
    pub label: BranchLabel,
}

impl WriteIntent for MergeIntent {
    type Outcome = IntegrateOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Merge
    }
    fn label(&self) -> String {
        self.label.get()
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Rewind)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let branch = pre.before.head.branch.as_deref().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Check out a branch to merge into it"))?;
        self.label.settle(branch);
        let repo = gix::open(pre.root).map_err(gix_err)?;
        let target = repo.rev_parse_single(self.target.as_str()).map_err(|e| GbError::new(GbErrorKind::NotFound, format!("{}: {e}", self.target)))?.detach();
        // --- 2C repo-safety ---
        // The merge checks its result out as a two-way move: a file of the target written where
        // a populated submodule or an embedded clone sits deletes it whole (safety review 2 N2),
        // refused first; the same check says what the move sweeps away (M1, M2).
        let mut rule = AutostashRule::Merged;
        if let Some(head) = pre.before.head.oid.as_deref().and_then(|h| gix::ObjectId::from_hex(h.as_bytes()).ok()) {
            rule = crate::write::precheck::refuse_repos_in_the_way_of_merge(&pre.api.cli, pre.root, head, target, "merge").await?.rule_over(rule);
        }
        // --- end 2C repo-safety ---
        Ok(Plan { autostash: Some(AutostashSpec { rule, target: Some(target), op: format!("merge {}", self.target), target_name: Some(self.target.clone()) }), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<IntegrateOutcome, GbError> {
        run_merge(cx, &self.target, &self.target).await
    }
}

/// `git merge --no-edit <target>` (§13.1; pull's merge, T14). Stopped on conflicts, it pauses
/// with `label` as the banner's target, and `MERGE_HEAD` as the target's oid.
pub(crate) async fn run_merge(cx: &mut WriteCx<'_>, target: &str, label: &str) -> Result<IntegrateOutcome, GbError> {
    let repo = gix::open(cx.root).map_err(gix_err)?;
    let theirs = repo.rev_parse_single(target).map_err(gix_err)?.detach();
    let before = repo.head_id().map_err(gix_err)?.detach();
    let inv = cx.git(["merge", "--no-edit", target]);
    let res = cx.run_git(inv).await;
    for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Refs, ChangeKind::State] {
        cx.touch(k);
    }
    if let Err(e) = res {
        return match crate::in_progress::read(cx.root).ok().flatten() {
            Some(crate::in_progress::InProgress::Merge { conflicted, merge_head, .. }) => {
                cx.paused = Some(Pause { kind: PausedKind::Merge, target: label.to_string(), target_oid: Some(merge_head).filter(|m| !m.is_empty()), put_back: Vec::new(), picked: Vec::new(), irebase: None });
                Ok(IntegrateOutcome::Stopped { kind: PausedKind::Merge, files: conflicted, warning: None })
            }
            _ => Err(e),
        };
    }
    let after = gix::open(cx.root).map_err(gix_err)?.head_id().map_err(gix_err)?.detach();
    if after == before {
        return Ok(IntegrateOutcome::UP_TO_DATE);
    }
    let (commits, _) = relation(&repo, after, before)?;
    Ok(IntegrateOutcome::done(commits, after == theirs))
}

pub(crate) struct FastForwardIntent {
    pub branch: String,
    pub to: String,
}

impl WriteIntent for FastForwardIntent {
    type Outcome = IntegrateOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("fast-forward {} to {}", self.branch, short_ref(&self.to))
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    fn refs(&self) -> Vec<String> {
        vec![format!("refs/heads/{}", self.branch)]
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<IntegrateOutcome, GbError> {
        let name = format!("refs/heads/{}", self.branch);
        let worktrees = crate::worktree::list_worktrees(&cx.api.cli, cx.root).await?;
        if let Some(w) = worktrees.iter().find(|w| w.branch.as_deref() == Some(name.as_str())) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is checked out in {}", self.branch, w.path.display())));
        }
        let repo = gix::open(cx.root).map_err(gix_err)?;
        let to = repo.rev_parse_single(self.to.as_str()).map_err(gix_err)?.detach();
        let old = cx.before.refs.get(&name).cloned().flatten().ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("{} doesn't exist", self.branch)))?;
        let old_id = ObjectId::from_hex(old.as_bytes()).map_err(gix_err)?;
        // Review M6: already there.
        if old_id == to {
            return Ok(IntegrateOutcome::UP_TO_DATE);
        }
        if !is_ancestor(&repo, old_id, to) {
            return Err(GbError::new(GbErrorKind::NonFastForward, format!("{} has commits {} doesn't have", self.branch, short_ref(&self.to))));
        }
        let (commits, _) = relation(&repo, to, old_id)?;
        cx.cas(&[RefMove { name, old: Some(old), new: Some(to.to_string()) }], &format!("merge {}: Fast-forward", self.to)).await?;
        cx.touch(ChangeKind::Refs);
        Ok(IntegrateOutcome::done(commits, true))
    }
}

/// The commit panel's Abort merge (§13.2). Not journaled: step 7b drops the paused entry.
pub(crate) struct MergeAbortIntent;

impl WriteIntent for MergeAbortIntent {
    type Outcome = IntegrateOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Merge
    }
    fn label(&self) -> String {
        "abort the merge".into()
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<IntegrateOutcome, GbError> {
        if cx.before.in_progress != Some("merge") {
            return Err(GbError::new(GbErrorKind::InvalidInput, "No merge is in progress"));
        }
        let inv = cx.git(["merge", "--abort"]);
        cx.run_git(inv).await?;
        for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::State] {
            cx.touch(k);
        }
        Ok(IntegrateOutcome::ABORTED)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IntegratePreviewPayload {
    /// HEAD's commits not in the target, and the target's not in HEAD.
    pub ahead: u32,
    pub behind: u32,
    /// The target is already in HEAD: "Merge Y into X" isn't offered (§13.1).
    pub merged: bool,
    /// Paths a merge of HEAD and the target would conflict in (gix, in memory). For a rebase it's
    /// the same three-way preview, an approximation (Deviation 9).
    pub conflicts: Vec<String>,
    /// Rebase only: the branches `--update-refs` would move.
    pub stacked: Vec<StackedBranch>,
    /// The checkbox's default: ticked unless `rebase.updateRefs=false`.
    pub update_refs_default: bool,
    /// Rebase only: why it would be refused, before the user presses Rebase (review N4): a merge
    /// commit with changes of its own, which a rebase would drop.
    pub lossy_merge: Option<String>,
}

/// The paths a merge of `ours` and `theirs` would leave unresolved, as git would. Objects go to
/// memory only: the preview never writes to the repository. Unrelated histories (no merge base)
/// predict nothing: the dialog still opens, with every commit counted (review M4).
pub(crate) fn predicted_conflicts(repo: &gix::Repository, ours: ObjectId, theirs: ObjectId) -> Result<Vec<String>, GbError> {
    if repo.merge_base(ours, theirs).is_err() {
        return Ok(Vec::new());
    }
    let repo = repo.clone().with_object_memory();
    let options = repo.tree_merge_options().map_err(gix_err)?;
    let out = repo.merge_commits(ours, theirs, Default::default(), options.into()).map_err(gix_err)?;
    let how = gix::merge::tree::TreatAsUnresolved::git();
    let mut paths: Vec<String> = out.tree_merge.conflicts.iter().filter(|c| c.is_unresolved(how)).map(|c| c.ours.location().to_string()).collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

// --- 2D T14: the autostash's target for a merge or rebase ---
/// The tree of the three-way merge of `ours` and `theirs`: what the worktree holds after the
/// merge, and approximately after a rebase (Deviation 9). `AutostashRule::Merged` predicts
/// against it (§6.2): against `theirs` itself, every dirty file `ours` changed since the merge
/// base would look like a conflict. Only the tree and its blobs are written, as loose objects
/// with no ref and no commit: a merge then writes the same ones itself; a rebase's (and a
/// cancelled pull's) stay unreferenced until gc prunes them. `None` when there's no merge base
/// or the merge can't be computed.
pub(crate) fn merge_result(repo: &gix::Repository, ours: ObjectId, theirs: ObjectId) -> Option<ObjectId> {
    repo.merge_base(ours, theirs).ok()?;
    let options = repo.tree_merge_options().ok()?;
    let mut out = repo.merge_commits(ours, theirs, Default::default(), options.into()).ok()?;
    out.tree_merge.tree.write().ok().map(|id| id.detach())
}
// --- end 2D T14 ---

pub(crate) async fn preview(api: &Api, repo: u32, worktree: &str, kind: IntegrateKind, target: String) -> Result<IntegratePreviewPayload, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let here = root.canonicalize().unwrap_or_else(|_| root.clone());
    let elsewhere: HashMap<String, String> = crate::worktree::list_worktrees(&api.cli, &root)
        .await?
        .into_iter()
        .filter(|w| w.path.canonicalize().unwrap_or_else(|_| w.path.clone()) != here)
        .filter_map(|w| Some((w.branch?, w.path.display().to_string())))
        .collect();
    let (rt, tn) = (root.clone(), target.clone());
    let (mut payload, rebasing) = blocking(move || {
        let r = gix::open(&rt).map_err(gix_err)?;
        let head = r.head_id().map_err(gix_err)?.detach();
        let y = r.rev_parse_single(tn.as_str()).map_err(|e| GbError::new(GbErrorKind::NotFound, format!("{tn}: {e}")))?.detach();
        let (ahead, behind) = relation(&r, head, y)?;
        let (stacked, rebasing) = match (kind, head_branch(&r)) {
            (IntegrateKind::Rebase, Some(x)) => (stacked_branches(&r, &x, y, &elsewhere)?, Some((x, head, y))),
            _ => (Vec::new(), None),
        };
        let update_refs_default = r.config_snapshot().boolean("rebase.updateRefs") != Some(false);
        let conflicts = if behind == 0 { Vec::new() } else { predicted_conflicts(&r, head, y)? };
        Ok((IntegratePreviewPayload { ahead, behind, merged: behind == 0, conflicts, stacked, update_refs_default, lossy_merge: None }, rebasing))
    })
    .await?;
    if let Some((x, head, y)) = rebasing {
        payload.lossy_merge = lossy_merge(&api.cli, &root, head, y).await?.map(|m| lossy_message(&x, &m, &target));
    }
    Ok(payload)
}
// --- end 2D T10 ---

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::api::Request;
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

    async fn merge(api: &Api, id: u32, r: &Path, target: &str) -> Result<serde_json::Value, GbError> {
        api.dispatch(Request::Integrate { repo: id, worktree: wt(r), kind: IntegrateKind::Merge, target: target.into(), update_refs: None, expect: Default::default(), confirm: Default::default() }).await
    }

    async fn preview(api: &Api, id: u32, r: &Path, kind: IntegrateKind, target: &str) -> serde_json::Value {
        api.dispatch(Request::IntegratePreview { repo: id, worktree: wt(r), kind, target: target.into() }).await.unwrap()
    }

    #[tokio::test]
    async fn a_clean_merge_makes_a_merge_commit_and_undo_rewinds_it() {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        let before = r.git(&["rev-parse", "main"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = merge(&api, id, r.path(), "clean").await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 2, "fastForward": false}));
        assert_eq!(res["journal"]["undo"]["label"], "merge clean into main");
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), before);
    }

    #[tokio::test]
    async fn a_merge_that_git_fast_forwards_says_so_and_an_old_one_is_up_to_date() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.switch("feature/a");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = merge(&api, id, r.path(), "feature/c").await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 2, "fastForward": true}));
        assert_eq!(merge(&api, id, r.path(), "feature/b").await.unwrap()["outcome"]["status"], "upToDate");
    }

    #[tokio::test]
    async fn a_conflicted_merge_pauses_and_abort_restores_everything() {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        let before = r.git(&["rev-parse", "main"]);
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        let res = merge(&api, id, r.path(), "feature/x").await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "stopped", "kind": "merge", "files": 3}));
        let res = api.dispatch(Request::MergeAbort { repo: id, worktree: wt(r.path()) }).await.unwrap();
        assert_eq!(res["outcome"]["status"], "aborted");
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(r.git(&["rev-parse", "HEAD"]), before);
        let git_dir = r.path().join(".git").canonicalize().unwrap();
        assert!(crate::journal::JournalStore::new(data.path(), &git_dir, &r.path().canonicalize().unwrap()).load().unwrap().undo.is_empty());
    }

    #[tokio::test]
    async fn fast_forward_moves_a_branch_that_isnt_checked_out_and_refuses_otherwise() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let a = r.git(&["rev-parse", "feature/a"]);
        let ff = |branch: &str, to: &str| Request::FastForward { repo: id, worktree: wt(r.path()), branch: branch.into(), to: to.into(), expect: Default::default() };
        let res = api.dispatch(ff("feature/a", "feature/c")).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "feature/a"]), r.git(&["rev-parse", "feature/c"]));
        assert_eq!(res["journal"]["undo"]["label"], "fast-forward feature/a to feature/c");
        assert!(r.git(&["reflog", "-1", "feature/a"]).contains("merge feature/c: Fast-forward"));
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "feature/a"]), a);
        assert_eq!(api.dispatch(ff("feature/c", "main")).await.unwrap_err().kind, GbErrorKind::InvalidInput, "checked out here");
        assert_eq!(api.dispatch(ff("feature/b", "main")).await.unwrap_err().kind, GbErrorKind::NonFastForward, "has commits main doesn't");
        // Review M6: already there.
        let res = api.dispatch(ff("feature/a", "feature/a")).await.unwrap();
        assert_eq!(res["outcome"]["status"], "upToDate");
        assert_eq!(r.git(&["rev-parse", "feature/a"]), a);
    }

    /// Review M4 (scenario s9): an unrelated history has no merge base; the preview still
    /// answers, with every commit counted and no conflicts predicted.
    #[tokio::test]
    async fn the_preview_of_an_unrelated_history_opens() {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        r.git(&["switch", "-q", "--orphan", "lonely"]);
        r.write("z.txt", "z\n");
        r.git(&["add", "z.txt"]);
        r.git(&["commit", "-q", "-m", "lonely"]);
        r.switch("main");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let p = preview(&api, id, r.path(), IntegrateKind::Rebase, "lonely").await;
        assert_eq!(p["conflicts"], serde_json::json!([]));
        assert_eq!((p["ahead"].as_u64(), p["behind"].as_u64(), p["merged"].as_bool()), (Some(2), Some(1), Some(false)));
    }

    /// §13.1's previews, read-only: relation, the gix conflict count, the stack, the default.
    #[tokio::test]
    async fn the_preview_counts_conflicts_lists_the_stack_and_writes_nothing() {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let objects = || r.git(&["count-objects", "-v"]);
        let before = objects();
        let p = preview(&api, id, r.path(), IntegrateKind::Merge, "feature/x").await;
        assert_eq!(p["conflicts"], serde_json::json!(["a.txt", "gone.txt", "logo.bin"]));
        assert_eq!((p["ahead"].as_u64(), p["behind"].as_u64(), p["merged"].as_bool()), (Some(1), Some(1), Some(false)));
        assert_eq!(preview(&api, id, r.path(), IntegrateKind::Merge, "clean").await["conflicts"], serde_json::json!([]));
        assert_eq!(objects(), before, "the preview wrote no object");

        let s = TestRepo::new();
        fixtures::stack(&s);
        let elsewhere = s.add_worktree("a", "feature/a");
        let id = open(&api, s.path()).await;
        let p = preview(&api, id, s.path(), IntegrateKind::Rebase, "main").await;
        assert_eq!(p["stacked"][0]["name"], "feature/a");
        assert_eq!(p["stacked"][0]["worktree"].as_str().map(|w| std::path::Path::new(w).canonicalize().unwrap()), Some(elsewhere.canonicalize().unwrap()));
        assert_eq!(p["stacked"][1], serde_json::json!({"name": "feature/b", "worktree": null}));
        assert_eq!(p["updateRefsDefault"], true);
        s.git(&["config", "rebase.updateRefs", "false"]);
        assert_eq!(preview(&api, id, s.path(), IntegrateKind::Rebase, "main").await["updateRefsDefault"], false);
    }

    /// 2D T14 re-review m3: `Merged` predicts against the merge. A dirty line next to a change
    /// only the local side made isn't a conflict (it was, against the target itself); one next
    /// to the upstream's change is.
    #[tokio::test]
    async fn the_merged_prediction_flags_only_the_upstreams_neighbours() {
        let r = TestRepo::new();
        let lines = |first: &str, second: &str| format!("{first}\n{second}\nthree\nfour\nfive\n");
        r.write("local.txt", &lines("one", "two"));
        r.write("up.txt", &lines("one", "two"));
        r.git(&["add", "local.txt", "up.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("up");
        r.write("up.txt", &lines("UP ONE", "two"));
        r.git(&["commit", "-q", "-am", "Upstream change"]);
        r.switch("main");
        r.write("local.txt", &lines("LOCAL ONE", "two"));
        r.git(&["commit", "-q", "-am", "Local change"]);
        r.write("local.txt", &lines("LOCAL ONE", "dirty two"));
        r.write("up.txt", &lines("one", "dirty two"));
        let (api, _data) = api();
        let up = gix::ObjectId::from_hex(r.git(&["rev-parse", "up"]).as_bytes()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let predict = |rule: AutostashRule| {
            let spec = AutostashSpec { rule, target: Some(up), op: "merge up".into(), target_name: Some("up".into()) };
            let (api, root, tmp) = (&api, r.path().canonicalize().unwrap(), tmp.path().to_path_buf());
            async move { crate::journal::autostash::plan(api, &root, &tmp, &spec).await.unwrap().expect("a stash").conflicts }
        };
        assert_eq!(predict(AutostashRule::Merged).await, vec!["up.txt".to_string()]);
        assert_eq!(predict(AutostashRule::AnyTracked).await, vec!["local.txt".to_string(), "up.txt".to_string()], "against the target itself, the local side's neighbour looks like a conflict");
    }

    // --- 2C repo-safety (safety review 2 N2) ---

    /// `git clone` of a one-commit repository at `at`, with a local-only branch (what the user
    /// would lose).
    pub(crate) fn embed_clone(r: &TestRepo, at: &str) -> TestRepo {
        let sub = TestRepo::new();
        sub.write("s.txt", "s\n");
        sub.git(&["add", "."]);
        sub.git(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "s"]);
        r.git(&["clone", "-q", &sub.path().display().to_string(), at]);
        let sm = r.path().join(at);
        for args in [&["config", "user.name", "Ada Lovelace"][..], &["config", "user.email", "ada@example.com"], &["switch", "-q", "-c", "feat"]] {
            r.git_in(&sm, args);
        }
        std::fs::write(sm.join("local.txt"), "local\n").unwrap();
        r.git_in(&sm, &["add", "local.txt"]);
        r.git_in(&sm, &["commit", "-q", "-m", "local-only"]);
        r.git_in(&sm, &["switch", "-q", "main"]);
        sub
    }

    /// main: `x` and the gitlink `sm` (a populated clone); `up`: `sm` replaced by a file, and
    /// one more commit on main after the fork, so the merge isn't a fast-forward.
    pub(crate) fn gitlink_to_file_repo() -> (TestRepo, TestRepo) {
        let r = TestRepo::new();
        r.write("x", "x\n");
        let sub = embed_clone(&r, "sm");
        r.git(&["add", "x", "sm"]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.git(&["switch", "-q", "-c", "up"]);
        r.git(&["rm", "-q", "--cached", "sm"]);
        let aside = r.root().join("sm-aside");
        std::fs::rename(r.path().join("sm"), &aside).unwrap();
        r.write("sm", "file\n");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "file"]);
        r.git(&["switch", "-q", "main"]);
        let _ = std::fs::remove_dir(r.path().join("sm"));
        std::fs::rename(&aside, r.path().join("sm")).unwrap();
        r.write("y", "y\n");
        r.git(&["add", "y"]);
        r.git(&["commit", "-q", "-m", "local"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean");
        (r, sub)
    }

    /// R6c: `up` replaced the clean populated gitlink `sm` by a file; the merge's checkout
    /// would delete the clone whole: refused, nothing changed.
    #[tokio::test]
    async fn a_merge_never_deletes_a_populated_submodule_the_target_replaces_by_a_file() {
        let (r, _sub) = gitlink_to_file_repo();
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let e = merge(&api, id, r.path(), "up").await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "sm is a repository in the way of the merge: move it first"));
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        assert!(r.path().join("sm/.git").is_dir());
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// R6d: the gitlink is dirty (` M sm`), and the user confirms the autostash: still refused,
    /// since the stash would hold only the gitlink and the merge would delete the clone.
    #[tokio::test]
    async fn a_merge_over_a_dirty_submodule_the_target_replaces_is_refused_even_when_confirmed() {
        let (r, _sub) = gitlink_to_file_repo();
        std::fs::write(r.path().join("sm/wip.txt"), "wip\n").unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), " M sm");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let confirmed = Request::Integrate { repo: id, worktree: wt(r.path()), kind: IntegrateKind::Merge, target: "up".into(), update_refs: None, expect: Default::default(), confirm: crate::write::types::Confirm { autostash: true } };
        let e = api.dispatch(confirmed).await.unwrap_err();
        assert_eq!(e.message, "sm is a repository in the way of the merge: move it first");
        assert!(r.path().join("sm/.git").is_dir());
        assert_eq!(std::fs::read_to_string(r.path().join("sm/wip.txt")).unwrap(), "wip\n");
        assert_eq!(r.git(&["stash", "list"]), "", "nothing was stashed");
    }

    /// R8: an ignored clone at `lib/inner`, where `up` adds the file `lib`: git would delete it
    /// without a word: refused.
    #[tokio::test]
    async fn a_merge_never_deletes_an_ignored_clone_under_a_folder_the_target_replaces() {
        let r = TestRepo::new();
        r.write("x", "x\n");
        r.write(".gitignore", "lib/\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.git(&["switch", "-q", "-c", "up"]);
        r.write("lib", "file\n");
        r.git(&["add", "lib"]);
        r.git(&["commit", "-q", "-m", "lib"]);
        r.git(&["switch", "-q", "main"]);
        let _sub = embed_clone(&r, "lib/inner");
        r.write("y", "y\n");
        r.git(&["add", "y"]);
        r.git(&["commit", "-q", "-m", "local"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "the clone is ignored");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let e = merge(&api, id, r.path(), "up").await.unwrap_err();
        assert_eq!(e.message, "lib/inner is a repository in the way of the merge: move it first");
        assert!(r.path().join("lib/inner/.git").is_dir());
    }
    // --- end 2C repo-safety ---
}
