//! Delete a branch (spec #2 §9.2): the clicked control decides local, remote or both.
//! - Local: merged into its upstream (else HEAD), or confirmed and forced; a gix CAS delete,
//!   then `git config --remove-section branch.<name>`; journaled with the config.
//! - Remote: `git push --force-with-lease=refs/heads/<b>:<oid shown> <remote> --delete
//!   refs/heads/<b>`, a network op outside the write lock and a journal Barrier.
//! - Both: one confirmation (the UI's), the remote first, then the local branch (Deviation 4).

use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::{RefMove, UndoKind};
use crate::write::precheck::{commits_not_in, display_worktree};
use crate::write::refs::read_ref;
use crate::write::{config, Plan, Pre, WriteCx, WriteIntent};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteBranchRef {
    pub remote: String,
    pub branch: String,
    /// The remote-tracking oid the UI showed: the lease, never widened by a fetch since.
    pub lease: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum DeleteOutcome {
    Deleted,
    /// Nothing changed: the UI asks "<branch> has <commits> commits that aren't in <into>.
    /// Delete it anyway? You can undo this." and sends again with `force`.
    Unmerged { branch: String, into: String, commits: u32 },
}

pub(crate) struct DeleteBranch {
    pub branch: String,
    pub local: bool,
    pub remote: Option<RemoteBranchRef>,
    pub force: bool,
    /// Set by `plan`: the local branch isn't merged (and `force` isn't set).
    unmerged: OnceLock<(String, u32)>,
}

impl DeleteBranch {
    pub(crate) fn new(branch: String, local: bool, remote: Option<RemoteBranchRef>, force: bool) -> Self {
        Self { branch, local, remote, force, unmerged: OnceLock::new() }
    }

    fn full(&self) -> String {
        format!("refs/heads/{}", self.branch)
    }

    fn remote_label(&self) -> Option<String> {
        self.remote.as_ref().map(|r| format!("{}/{}", r.remote, r.branch))
    }
}

impl WriteIntent for DeleteBranch {
    type Outcome = DeleteOutcome;
    fn kind(&self) -> OpKind {
        if self.local { OpKind::Branch } else { OpKind::Push }
    }
    fn label(&self) -> String {
        match (self.local, self.remote_label()) {
            (true, Some(r)) => format!("delete branch {} and {r}", self.branch),
            (true, None) => format!("delete branch {}", self.branch),
            (false, Some(r)) => format!("delete {r}"),
            (false, None) => format!("delete branch {}", self.branch),
        }
    }
    /// A remote-only delete is a push: a Barrier. Otherwise the local part's MoveRefs (Both puts
    /// its Barrier below, Deviation 4).
    fn undo(&self) -> Option<UndoKind> {
        Some(if self.local { UndoKind::MoveRefs } else { UndoKind::Barrier })
    }
    /// The push runs `pre-push` and reaches the network.
    fn runs_hooks(&self) -> bool {
        self.remote.is_some()
    }
    fn refs(&self) -> Vec<String> {
        if self.local { vec![self.full()] } else { Vec::new() }
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if !self.local && self.remote.is_none() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Nothing to delete"));
        }
        if let Some(r) = &self.remote {
            let tracking = format!("refs/remotes/{}/{}", r.remote, r.branch);
            let now = read_ref(&gix::open(pre.root).map_err(gix_err)?, &tracking)?;
            if now.as_deref() != Some(r.lease.as_str()) {
                return Err(GbError::ref_moved(&tracking));
            }
        }
        if !self.local {
            return Ok(Plan::default());
        }
        if pre.before.refs.get(&self.full()).cloned().flatten().is_none() {
            return Err(GbError::new(GbErrorKind::NotFound, "No local branch"));
        }
        // Review Focus 1: never a branch some worktree has checked out.
        let worktrees = crate::worktree::list_worktrees(&pre.api.cli, pre.root).await?;
        if let Some(w) = worktrees.iter().find(|w| w.branch.as_deref() == Some(self.full().as_str())) {
            let here = w.path.canonicalize().unwrap_or(w.path.clone()) == pre.root;
            if here {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is checked out", self.branch)));
            }
            let main = worktrees.iter().find(|m| m.is_main).map(|m| m.path.clone()).unwrap_or_else(|| pre.h.workdir.clone());
            return Err(GbError::checked_out_elsewhere(&self.branch, &display_worktree(&main, &w.path)));
        }
        if !self.force {
            // Its upstream, unless that's being deleted too (Deviation 5); else HEAD.
            let upstream = format!("{}@{{upstream}}", self.branch);
            let up = match self.remote {
                Some(_) => None,
                None => pre.api.cli.run(GitInvocation::new(pre.root, ["rev-parse", "--verify", "-q", "--symbolic-full-name", upstream.as_str()])).await.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty()),
            };
            let into = up.unwrap_or_else(|| "HEAD".to_string());
            let commits = commits_not_in(&pre.api.cli, pre.root, &self.full(), &into).await?;
            if commits > 0 {
                let detached = || pre.before.head.oid.as_deref().map_or("HEAD".to_string(), |o| o.chars().take(7).collect());
                let shown = if into == "HEAD" { pre.before.head.branch.clone().unwrap_or_else(detached) } else { crate::error::short_ref(&into).to_string() };
                let _ = self.unmerged.set((shown, commits));
            }
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<DeleteOutcome, GbError> {
        if let Some((into, commits)) = self.unmerged.get() {
            return Ok(DeleteOutcome::Unmerged { branch: self.branch.clone(), into: into.clone(), commits: *commits });
        }
        if let Some(r) = &self.remote {
            let lease = format!("--force-with-lease=refs/heads/{}:{}", r.branch, r.lease);
            let target = format!("refs/heads/{}", r.branch);
            let inv = cx.net_git(["push", "--progress", lease.as_str(), r.remote.as_str(), "--delete", target.as_str()]);
            if let Err(mut e) = cx.network(inv).await {
                // The lease failed: the remote moved since the tracking ref was fetched.
                if e.kind == GbErrorKind::RefMoved {
                    e.message = format!("{}/{} changed on the server. Fetch, then try again.", r.remote, r.branch);
                }
                return Err(e);
            }
            cx.touch(ChangeKind::Refs);
            if self.local {
                let shown = self.remote_label().unwrap_or_default();
                cx.barrier_below(&format!("delete {shown}"), OpKind::Push)?;
                cx.set_note(format!("{shown} stays deleted"))?;
            }
        }
        if self.local {
            let done = self.delete_local(cx).await;
            if let (Err(e), Some(shown)) = (&done, self.remote_label()) {
                return Err(GbError { message: format!("Deleted {shown}; deleting the local branch failed: {}", e.message), ..e.clone() });
            }
            done?;
        }
        Ok(DeleteOutcome::Deleted)
    }
}

impl DeleteBranch {
    async fn delete_local(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let old = cx.before.refs.get(&self.full()).cloned().flatten();
        let changes = delete_local_branch(cx, &self.branch, old).await?;
        cx.record_config(changes)
    }
}

/// A local branch's delete (spec #2 §9.2): the CAS, then its `branch.<name>` section. Returns
/// the config changes for the caller's journal entry (a paused rebase records them on its own).
pub(crate) async fn delete_local_branch(cx: &mut WriteCx<'_>, branch: &str, old: Option<String>) -> Result<Vec<crate::journal::ConfigChange>, GbError> {
    let full = format!("refs/heads/{branch}");
    let before = config::branch_config(&cx.api.cli, cx.root, branch).await?;
    cx.cas(&[RefMove { name: full, old, new: None }], &format!("branch: deleted {branch}")).await?;
    cx.touch(ChangeKind::Refs);
    if before.is_empty() {
        return Ok(Vec::new());
    }
    let section = format!("branch.{branch}");
    let inv = cx.git(["config", "--local", "--remove-section", section.as_str()]);
    cx.run_git(inv).await?;
    Ok(config::changes(&before, &config::BranchConfig::new()))
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::state::RepoState;
    use crate::testing::write::{identity, open, send, wt, WriteEnv};
    use crate::testing::TestRepo;
    use serde_json::json;

    fn repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.commit("one");
        r.add_origin();
        r.push("main");
        r.switch_new("feature/x");
        r.commit("x1");
        r.push("feature/x");
        r.switch("main");
        r
    }

    /// Undo writes the keys back in key order, not the file's: the same keys and values.
    fn sorted(config: &str) -> Vec<String> {
        let mut lines: Vec<String> = config.lines().map(String::from).collect();
        lines.sort();
        lines
    }

    fn oid(r: &TestRepo, rev: &str) -> String {
        r.git(&["rev-parse", rev])
    }

    fn origin_has(r: &TestRepo, branch: &str) -> bool {
        r.try_git_in(&r.root().join("origin.git"), &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).is_ok()
    }

    async fn state(api: &crate::api::Api, id: u32, r: &TestRepo) -> serde_json::Value {
        send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap()
    }

    async fn undo_top(api: &crate::api::Api, id: u32, r: &TestRepo) -> serde_json::Value {
        let s = state(api, id, r).await;
        send(api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(r), "entry": s["undo"]["entry"]}})).await.unwrap()
    }

    fn delete(id: u32, r: &TestRepo, local: bool, remote: Option<(&str, &str)>, force: bool) -> serde_json::Value {
        let tip = oid(r, "feature/x");
        let remote = remote.map(|(name, branch)| json!({"remote": name, "branch": branch, "lease": oid(r, &format!("refs/remotes/{name}/{branch}"))}));
        let expect = if local { json!({"refs": {"refs/heads/feature/x": tip}}) } else { json!({}) };
        json!({"method": "deleteBranch", "params": {"repo": id, "worktree": wt(r), "branch": "feature/x", "local": local, "remote": remote, "force": force, "expect": expect}})
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_merged_local_delete_removes_ref_and_config_and_round_trips() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["branch", "--set-upstream-to=origin/feature/x", "feature/x"]);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let out = send(&env.api, delete(id, &r, true, None, false)).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "deleted"}));
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_err());
        assert!(r.try_git(&["config", "branch.feature/x.merge"]).is_err());
        undo_top(&env.api, id, &r).await;
        let undone = RepoState::capture(&r);
        assert_eq!((undone.refs, sorted(&undone.branch_config)), (before.refs, sorted(&before.branch_config)));
    }

    /// Review Focus 2.
    #[tokio::test(flavor = "multi_thread")]
    async fn deleting_a_dotted_branch_restores_its_config_on_undo() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["branch", "--track", "release.1/ü-x", "origin/feature/x"]);
        let id = open(&env.api, &r).await;
        let before = sorted(&RepoState::capture(&r).branch_config);
        let tip = oid(&r, "release.1/ü-x");
        send(&env.api, json!({"method": "deleteBranch", "params": {"repo": id, "worktree": wt(&r), "branch": "release.1/ü-x", "local": true, "remote": null, "force": false, "expect": {"refs": {"refs/heads/release.1/ü-x": tip}}}})).await.unwrap();
        assert!(!RepoState::capture(&r).branch_config.contains("release.1/ü-x"));
        undo_top(&env.api, id, &r).await;
        assert_eq!(sorted(&RepoState::capture(&r).branch_config), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unmerged_local_delete_asks_then_forces() {
        let env = WriteEnv::new();
        let r = repo();
        r.switch("feature/x");
        r.commit("x2");
        r.commit("x3");
        r.switch("main");
        r.git(&["branch", "--set-upstream-to=origin/feature/x", "feature/x"]);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let out = send(&env.api, delete(id, &r, true, None, false)).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "unmerged", "branch": "feature/x", "into": "origin/feature/x", "commits": 2}));
        assert_eq!(RepoState::capture(&r), before, "asked first: nothing changed");
        assert!(state(&env.api, id, &r).await["undo"].is_null());
        send(&env.api, delete(id, &r, true, None, true)).await.unwrap();
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_err());
    }

    /// Review Focus 1: gix's CAS would delete a checked-out branch; the intent refuses.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_branch_checked_out_anywhere_is_never_deleted() {
        let env = WriteEnv::new();
        let r = repo();
        r.add_worktree("x", "feature/x");
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, delete(id, &r, true, None, true)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert_eq!(e.message, "feature/x is checked out in ../wt-x.");
        let main = oid(&r, "main");
        let e = send(&env.api, json!({"method": "deleteBranch", "params": {"repo": id, "worktree": wt(&r), "branch": "main", "local": true, "remote": null, "force": true, "expect": {"refs": {"refs/heads/main": main}}}})).await.unwrap_err();
        assert_eq!(e.message, "main is checked out");
        assert_eq!(RepoState::capture(&r), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_delete_is_a_barrier() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        send(&env.api, delete(id, &r, false, Some(("origin", "feature/x")), false)).await.unwrap();
        assert!(!origin_has(&r, "feature/x"));
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/remotes/origin/feature/x"]).is_err(), "git drops the tracking ref");
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_ok(), "the local branch stays");
        let s = state(&env.api, id, &r).await;
        assert_eq!(s["undo"]["label"], "delete origin/feature/x");
        assert_eq!(s["undoBlocked"], "Push can't be undone");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn both_deletes_the_remote_first_and_undo_restores_only_the_local_branch() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let tip = oid(&r, "feature/x");
        // Deviation 5: Both checks against HEAD, and x1 isn't in main: asked first, nothing runs.
        let out = send(&env.api, delete(id, &r, true, Some(("origin", "feature/x")), false)).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "unmerged", "branch": "feature/x", "into": "main", "commits": 1}));
        assert!(origin_has(&r, "feature/x"));
        send(&env.api, delete(id, &r, true, Some(("origin", "feature/x")), true)).await.unwrap();
        assert!(!origin_has(&r, "feature/x"));
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_err());
        let out = undo_top(&env.api, id, &r).await;
        assert_eq!(out["outcome"], json!({"status": "done", "label": "delete branch feature/x and origin/feature/x", "note": "origin/feature/x stays deleted"}));
        assert_eq!(oid(&r, "feature/x"), tip);
        assert!(!origin_has(&r, "feature/x"));
        let s = state(&env.api, id, &r).await;
        assert_eq!((s["undo"]["label"].as_str(), s["undoBlocked"].as_str()), (Some("delete origin/feature/x"), Some("Push can't be undone")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_moved_remote_branch_fails_the_lease_and_nothing_changes() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let req = delete(id, &r, true, Some(("origin", "feature/x")), false);
        // Someone pushed since the UI showed it: the tracking ref moves on a fetch.
        let theirs = tempfile::tempdir().unwrap();
        let other = theirs.path().join("other");
        r.git_in(theirs.path(), &["clone", "-q", r.root().join("origin.git").to_str().unwrap(), "other"]);
        r.git_in(&other, &["switch", "-q", "feature/x"]);
        r.git_in(&other, &["commit", "-q", "--allow-empty", "-m", "theirs"]);
        r.git_in(&other, &["push", "-q", "origin", "feature/x"]);
        r.git(&["fetch", "-q", "origin"]);
        let before = RepoState::capture(&r);
        let e = send(&env.api, req).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::RefMoved);
        assert_eq!(RepoState::capture(&r), before);
        assert!(origin_has(&r, "feature/x"));
    }

    /// Review Focus 3.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_named_with_a_slash_deletes_the_right_branch() {
        let env = WriteEnv::new();
        let r = repo();
        let up = r.root().join("up.git");
        r.git_in(r.root(), &["init", "-q", "--bare", up.to_str().unwrap()]);
        r.git(&["remote", "add", "up/stream", up.to_str().unwrap()]);
        r.git(&["push", "-q", "up/stream", "feature/x", "main"]);
        r.git(&["fetch", "-q", "up/stream"]);
        let id = open(&env.api, &r).await;
        send(&env.api, delete(id, &r, false, Some(("up/stream", "feature/x")), false)).await.unwrap();
        assert!(r.try_git_in(&up, &["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_err());
        assert!(r.try_git_in(&up, &["rev-parse", "--verify", "-q", "refs/heads/main"]).is_ok());
        assert!(origin_has(&r, "feature/x"), "origin's is untouched");
    }

    /// §15 "Partial failures say what did happen": a `pre-push` hook moves the local branch
    /// while the push runs, so its CAS fails after the remote is gone.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_failure_after_the_remote_delete_says_what_happened() {
        let env = WriteEnv::new();
        let r = repo();
        r.hook("pre-push", "#!/bin/sh\ngit update-ref refs/heads/feature/x refs/heads/main\nexit 0\n");
        let id = open(&env.api, &r).await;
        let e = send(&env.api, delete(id, &r, true, Some(("origin", "feature/x")), true)).await.unwrap_err();
        assert!(e.message.starts_with("Deleted origin/feature/x; deleting the local branch failed: "), "{}", e.message);
        assert!(!origin_has(&r, "feature/x"), "the remote part did happen");
        assert_eq!(oid(&r, "feature/x"), oid(&r, "main"), "the local branch is where the hook left it");
    }

    /// The remote moved but the tracking ref is stale: git rejects the lease.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_tracking_ref_fails_the_lease_and_says_to_fetch() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let req = delete(id, &r, false, Some(("origin", "feature/x")), false);
        let theirs = tempfile::tempdir().unwrap();
        let other = theirs.path().join("other");
        r.git_in(theirs.path(), &["clone", "-q", r.root().join("origin.git").to_str().unwrap(), "other"]);
        r.git_in(&other, &["switch", "-q", "feature/x"]);
        r.git_in(&other, &["commit", "-q", "--allow-empty", "-m", "theirs"]);
        r.git_in(&other, &["push", "-q", "origin", "feature/x"]);
        let e = send(&env.api, req).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::RefMoved);
        assert_eq!(e.message, "origin/feature/x changed on the server. Fetch, then try again.");
        assert!(origin_has(&r, "feature/x"));
    }

    /// §12.4: a rejecting hook's `remote:` lines reach Activity and lead the Details.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_rejected_remote_delete_shows_the_servers_lines() {
        let env = WriteEnv::new();
        let r = repo();
        r.origin_hook("pre-receive", "#!/bin/sh\necho 'branch feature/x is protected' >&2\nexit 1\n");
        let id = open(&env.api, &r).await;
        let mut events = env.api.bus.subscribe();
        let e = send(&env.api, delete(id, &r, true, Some(("origin", "feature/x")), true)).await.unwrap_err();
        assert!(e.stderr.as_deref().unwrap_or_default().starts_with("remote: branch feature/x is protected"), "{:?}", e.stderr);
        assert!(origin_has(&r, "feature/x"));
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_ok(), "the local branch stays");
        let mut seen = false;
        while let Ok(ev) = events.try_recv() {
            if let crate::events::AppEvent::OpRemote { lines, .. } = ev {
                seen |= lines.iter().any(|l| l.text.contains("branch feature/x is protected"));
            }
        }
        assert!(seen, "an opRemote event carried the line");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_detached_worktree_names_the_commit_not_head() {
        let env = WriteEnv::new();
        let r = repo();
        r.try_git(&["branch", "--unset-upstream", "feature/x"]).ok();
        r.git(&["switch", "-q", "--detach", "main"]);
        let id = open(&env.api, &r).await;
        let out = send(&env.api, delete(id, &r, true, None, false)).await.unwrap();
        assert_eq!(out["outcome"]["into"], json!(oid(&r, "main")[..7]));
    }
}
