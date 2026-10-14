//! Branches (spec #2 §9.1): create (a gix CAS, the upstream per `branch.autoSetupMerge`, then an
//! optional switch), rename (always `git branch -m`, which keeps the reflog and moves
//! `branch.<name>`), and set upstream (not journaled).

use crate::error::{gix_err, short_ref, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{RefMove, UndoKind};
use crate::write::names::branch_name_error;
use crate::write::types::Confirm;
use crate::write::{config, Plan, Pre, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use serde::Deserialize;
use ts_rs::TS;

fn heads(name: &str) -> String {
    format!("refs/heads/{name}")
}

fn parse_oid(oid: &str) -> Result<gix::ObjectId, GbError> {
    gix::ObjectId::from_hex(oid.as_bytes()).map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {oid}")))
}

/// `branch.autoSetupMerge` (a read): `true` or unset tracks remote-tracking starts, `always`
/// local ones too, `false` never (§9.1).
async fn upstream_for(cx: &WriteCx<'_>, start_ref: Option<&str>) -> Result<Option<String>, GbError> {
    let Some(start) = start_ref else { return Ok(None) };
    let out = cx.api.cli.run(GitInvocation::new(cx.root, ["config", "--get", "branch.autoSetupMerge"])).await;
    let setting = out.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_ascii_lowercase()).unwrap_or_default();
    let tracks = match setting.as_str() {
        "false" => false,
        "always" => start.starts_with("refs/remotes/") || start.starts_with("refs/heads/"),
        _ => start.starts_with("refs/remotes/"),
    };
    Ok(tracks.then(|| start.to_string()))
}

pub(crate) struct CreateBranch {
    pub name: String,
    /// The commit it starts at (full oid).
    pub start: String,
    /// The branch it starts from (a branch label's menu): decides the upstream and the reflog's
    /// "Created from".
    pub start_ref: Option<String>,
    pub checkout: bool,
    pub confirm: Confirm,
}

impl WriteIntent for CreateBranch {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("create branch {}", self.name)
    }
    /// Checked out: undo switches back, then deletes it (§5.3's checkout row).
    fn undo(&self) -> Option<UndoKind> {
        Some(if self.checkout { UndoKind::Switch } else { UndoKind::MoveRefs })
    }
    /// `post-checkout`.
    fn runs_hooks(&self) -> bool {
        self.checkout
    }
    fn refs(&self) -> Vec<String> {
        // An invalid name isn't readable as a ref: `plan` refuses it with the reason.
        if branch_name_error(&self.name).is_some() {
            return Vec::new();
        }
        vec![heads(&self.name)]
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(why) = branch_name_error(&self.name) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        if pre.before.refs.get(&heads(&self.name)).cloned().flatten().is_some() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("A branch named {} already exists", self.name)));
        }
        let target = parse_oid(&self.start)?;
        let repo = gix::open(pre.root).map_err(gix_err)?;
        if !repo.find_object(target).is_ok_and(|o| o.kind == gix::object::Kind::Commit) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} isn't a commit in this repository", self.start)));
        }
        // §6.1: a checkout that moves the worktree autostashes on overlap.
        let moves_tree = self.checkout && pre.before.head.oid.as_deref() != Some(self.start.as_str());
        // --- 2C repo-safety ---
        // The `git switch` is a two-way move from HEAD to the start: one that writes a file where
        // a populated submodule or an embedded clone sits deletes it whole (safety review 2 N1),
        // refused first; the same check says what the move sweeps away (M1, M2).
        let mut rule = AutostashRule::Overlap;
        if moves_tree && let Some(head) = pre.before.head.oid.as_deref().and_then(|h| gix::ObjectId::from_hex(h.as_bytes()).ok()) {
            rule = crate::write::precheck::refuse_repos_in_the_way(&pre.api.cli, pre.root, head, target, "checkout").await?.rule();
        }
        // --- end 2C repo-safety ---
        let autostash = moves_tree.then(|| AutostashSpec { rule, target: Some(target), op: format!("checkout {}", self.name), target_name: Some(self.name.clone()) });
        Ok(Plan { autostash, ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let from = match &self.start_ref {
            Some(r) => short_ref(r).to_string(),
            None => self.start[..self.start.len().min(7)].to_string(),
        };
        cx.cas(&[RefMove { name: heads(&self.name), old: None, new: Some(self.start.clone()) }], &format!("branch: Created from {from}")).await?;
        if let Some(up) = upstream_for(cx, self.start_ref.as_deref()).await? {
            let before = config::branch_config(&cx.api.cli, cx.root, &self.name).await?;
            let inv = cx.git(["branch", &format!("--set-upstream-to={up}"), self.name.as_str()]);
            cx.run_git(inv).await?;
            let after = config::branch_config(&cx.api.cli, cx.root, &self.name).await?;
            cx.record_config(config::changes(&before, &after))?;
        }
        if self.checkout {
            let inv = cx.git(["switch", "--no-guess", self.name.as_str()]);
            let res = cx.run_git(inv).await;
            for k in [ChangeKind::Head, ChangeKind::Index, ChangeKind::Worktree] {
                cx.touch(k);
            }
            // A failed or cancelled switch puts back the files it rewrote, as a checkout's does
            // (2C final I2), so the autostash comes back onto the tree the user left.
            crate::write::checkout::failed_move(cx, res, &self.start).await?;
        }
        Ok(())
    }
}

pub(crate) struct RenameBranch {
    pub from: String,
    pub to: String,
}

impl WriteIntent for RenameBranch {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("rename branch {} to {}", self.from, self.to)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Rename)
    }
    /// Verify records both: the old name's delete and the new name's create (the undo's names).
    fn refs(&self) -> Vec<String> {
        if branch_name_error(&self.to).is_some() || branch_name_error(&self.from).is_some() {
            return Vec::new();
        }
        vec![heads(&self.from), heads(&self.to)]
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(why) = branch_name_error(&self.to) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        if pre.before.refs.get(&heads(&self.from)).cloned().flatten().is_none() {
            return Err(GbError::new(GbErrorKind::NotFound, format!("No branch {}", self.from)));
        }
        if pre.before.refs.get(&heads(&self.to)).cloned().flatten().is_some() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("A branch named {} already exists", self.to)));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        rename(cx, &self.from, &self.to).await
    }
}

/// `git branch -m <from> <to>`: the reflog, `branch.<from>` and every worktree HEAD naming it move.
pub(crate) async fn rename(cx: &mut WriteCx<'_>, from: &str, to: &str) -> Result<(), GbError> {
    let inv = cx.git(["branch", "-m", from, to]);
    cx.run_git(inv).await?;
    for k in [ChangeKind::Refs, ChangeKind::Config, ChangeKind::Head] {
        cx.touch(k);
    }
    Ok(())
}

/// Rename's undo (`UndoKind::Rename`): `git branch -m` back (undo) or again (redo). The recorded
/// moves are the old name's delete (`new: None`) and the new name's create (`old: None`); the
/// moved-ref check before this already saw the source at its oid and the target absent.
pub(crate) async fn undo_rename(cx: &mut WriteCx<'_>, entry: &crate::journal::JournalEntry, undo: bool) -> Result<(), GbError> {
    let name = |want_deleted: bool| entry.refs.iter().find(|m| if want_deleted { m.new.is_none() } else { m.old.is_none() }).and_then(|m| m.name.strip_prefix("refs/heads/")).map(str::to_string);
    let (Some(old), Some(new)) = (name(true), name(false)) else { return Err(GbError::other("the rename's names aren't recorded")) };
    if undo { rename(cx, &new, &old).await } else { rename(cx, &old, &new).await }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpstreamTarget {
    pub remote: String,
    pub branch: String,
}

pub(crate) struct SetUpstream {
    pub branch: String,
    pub upstream: Option<UpstreamTarget>,
}

impl WriteIntent for SetUpstream {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("set upstream of {}", self.branch)
    }
    /// §5.3 "Not journaled".
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    /// Every name is checked before it reaches argv or the config: branch names by the branch
    /// rules, the remote by its existence (so a leading `-` or an unknown remote is refused).
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(why) = branch_name_error(&self.branch) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        let repo = gix::open(pre.root).map_err(gix_err)?;
        if crate::write::refs::read_ref(&repo, &heads(&self.branch))?.is_none() {
            return Err(GbError::new(GbErrorKind::NotFound, format!("No branch {}", self.branch)));
        }
        if let Some(up) = &self.upstream {
            if let Some(why) = branch_name_error(&up.branch) {
                return Err(GbError::new(GbErrorKind::InvalidInput, why));
            }
            if up.remote.starts_with('-') || !repo.remote_names().iter().any(|n| n.to_str_lossy() == up.remote.as_str()) {
                return Err(GbError::new(GbErrorKind::NotFound, format!("No remote {}", up.remote)));
            }
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        cx.touch(ChangeKind::Config);
        let Some(up) = &self.upstream else {
            let inv = cx.git(["branch", "--unset-upstream", "--", self.branch.as_str()]);
            return match cx.run_git(inv).await {
                Ok(_) => Ok(()),
                // "has no upstream information": already none.
                Err(e) if e.stderr.as_deref().is_some_and(|s| s.contains("no upstream")) => Ok(()),
                Err(e) => Err(e),
            };
        };
        let tracking = format!("refs/remotes/{}/{}", up.remote, up.branch);
        let exists = crate::write::refs::read_ref(&gix::open(cx.root).map_err(gix_err)?, &tracking)?.is_some();
        if exists {
            let inv = cx.git(["branch", &format!("--set-upstream-to={tracking}"), "--", self.branch.as_str()]);
            cx.run_git(inv).await?;
        } else {
            // A branch the next push creates (§9.1).
            let (remote_key, merge_key) = (format!("branch.{}.remote", self.branch), format!("branch.{}.merge", self.branch));
            let merge = format!("refs/heads/{}", up.branch);
            let inv = cx.git(["config", "--local", remote_key.as_str(), up.remote.as_str()]);
            cx.run_git(inv).await?;
            let inv = cx.git(["config", "--local", merge_key.as_str(), merge.as_str()]);
            cx.run_git(inv).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
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
        r.switch_new("feature/login");
        r.commit("login");
        r.push("feature/login");
        r.switch("main");
        r
    }

    fn oid(r: &TestRepo, rev: &str) -> String {
        r.git(&["rev-parse", rev])
    }

    async fn undo_top(api: &crate::api::Api, id: u32, r: &TestRepo) -> serde_json::Value {
        let state = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(r), "entry": state["undo"]["entry"]}})).await.unwrap()
    }

    async fn redo_top(api: &crate::api::Api, id: u32, r: &TestRepo) -> serde_json::Value {
        let state = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(r), "entry": state["redo"]["entry"]}})).await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_from_a_remote_branch_tracks_it_and_round_trips() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let start = oid(&r, "origin/feature/login");
        send(&env.api, json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": "release.1/ü-x", "start": start, "startRef": "refs/remotes/origin/feature/login", "checkout": false, "expect": {"refs": {"refs/heads/release.1/ü-x": null}}}})).await.unwrap();
        assert_eq!(oid(&r, "release.1/ü-x"), start);
        assert_eq!(r.git(&["config", "branch.release.1/ü-x.merge"]), "refs/heads/feature/login", "autoSetupMerge (unset = true) tracks a remote start");
        assert!(r.git(&["reflog", "show", "--format=%gs", "release.1/ü-x"]).contains("branch: Created from origin/feature/login"));
        let after = RepoState::capture(&r);
        undo_top(&env.api, id, &r).await;
        assert_eq!(RepoState::capture(&r), before, "undo deletes the branch and its config");
        redo_top(&env.api, id, &r).await;
        let redone = RepoState::capture(&r);
        // Git's own order: remote before merge.
        assert_eq!((redone.refs, redone.branch_config), (after.refs, after.branch_config));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn auto_setup_merge_decides_the_upstream() {
        for (setting, from_remote, from_local) in [(None, true, false), (Some("always"), true, true), (Some("false"), false, false)] {
            let env = WriteEnv::new();
            let r = repo();
            if let Some(s) = setting {
                r.git(&["config", "branch.autoSetupMerge", s]);
            }
            let id = open(&env.api, &r).await;
            let create = |name: &str, start_ref: &str| json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": name, "start": oid(&r, "main"), "startRef": start_ref, "checkout": false}});
            send(&env.api, create("r", "refs/remotes/origin/main")).await.unwrap();
            send(&env.api, create("l", "refs/heads/main")).await.unwrap();
            assert_eq!(r.try_git(&["config", "branch.r.merge"]).is_ok(), from_remote, "{setting:?} remote");
            assert_eq!(r.try_git(&["config", "branch.l.merge"]).is_ok(), from_local, "{setting:?} local");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_and_check_out_switches_and_undo_switches_back() {
        let env = WriteEnv::new();
        let r = repo();
        r.write("file_0.txt", "dirty, carried\n");
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        send(&env.api, json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": "topic", "start": oid(&r, "HEAD"), "checkout": true}})).await.unwrap();
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
        assert_eq!(std::fs::read_to_string(r.path().join("file_0.txt")).unwrap(), "dirty, carried\n");
        let after = RepoState::capture(&r);
        undo_top(&env.api, id, &r).await;
        assert_eq!(RepoState::capture(&r), before);
        redo_top(&env.api, id, &r).await;
        assert_eq!(RepoState::capture(&r), after);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_invalid_or_taken_name_changes_nothing() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": "a..b", "start": oid(&r, "HEAD"), "checkout": false}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
        let e = send(&env.api, json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": "feature/login", "start": oid(&r, "HEAD"), "checkout": false}})).await.unwrap_err();
        assert_eq!(e.message, "A branch named feature/login already exists");
        assert_eq!(RepoState::capture(&r), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rename_keeps_the_reflog_and_config_and_round_trips() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["branch", "--set-upstream-to=origin/feature/login", "feature/login"]);
        let id = open(&env.api, &r).await;
        let tip = oid(&r, "feature/login");
        let before = RepoState::capture(&r);
        let old_log = r.git(&["reflog", "show", "--format=%H %gs", "feature/login"]);
        send(&env.api, json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt(&r), "from": "feature/login", "to": "feature/signin", "expect": {"refs": {"refs/heads/feature/login": tip, "refs/heads/feature/signin": null}}}})).await.unwrap();
        let new_log = r.git(&["reflog", "show", "--format=%H %gs", "feature/signin"]);
        assert!(new_log.ends_with(&old_log), "the old entries are kept:\n{new_log}");
        assert_eq!(r.git(&["config", "branch.feature/signin.merge"]), "refs/heads/feature/login");
        let after = RepoState::capture(&r);
        undo_top(&env.api, id, &r).await;
        let undone = RepoState::capture(&r);
        assert_eq!((undone.refs, undone.branch_config), (before.refs.clone(), before.branch_config.clone()));
        redo_top(&env.api, id, &r).await;
        assert_eq!(RepoState::capture(&r).refs, after.refs);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn renaming_onto_an_existing_branch_changes_nothing() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt(&r), "from": "feature/login", "to": "main"}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
        assert_eq!(RepoState::capture(&r), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn set_upstream_existing_new_and_none() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["branch", "topic"]);
        let id = open(&env.api, &r).await;
        let set = |up: serde_json::Value| json!({"method": "setUpstream", "params": {"repo": id, "worktree": wt(&r), "branch": "topic", "upstream": up}});
        send(&env.api, set(json!({"remote": "origin", "branch": "feature/login"}))).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "origin/feature/login");
        send(&env.api, set(json!({"remote": "origin", "branch": "topic-new"}))).await.unwrap();
        assert_eq!((r.git(&["config", "branch.topic.remote"]), r.git(&["config", "branch.topic.merge"])), ("origin".into(), "refs/heads/topic-new".into()), "a branch the next push creates");
        send(&env.api, set(json!(null))).await.unwrap();
        assert!(r.try_git(&["config", "branch.topic.merge"]).is_err());
        send(&env.api, set(json!(null))).await.unwrap(); // already none: not an error
        let state = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        assert!(state["undo"].is_null(), "set upstream isn't journaled");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn set_upstream_refuses_what_it_cannot_name() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let set = |branch: &str, up: serde_json::Value| json!({"method": "setUpstream", "params": {"repo": id, "worktree": wt(&r), "branch": branch, "upstream": up}});
        for (branch, up) in [("-D", json!(null)), ("main", json!({"remote": "-x", "branch": "a"})), ("main", json!({"remote": "origin", "branch": "--bad"})), ("main", json!({"remote": "origin", "branch": "a..b"}))] {
            let e = send(&env.api, set(branch, up.clone())).await.unwrap_err();
            assert!(matches!(e.kind, crate::error::GbErrorKind::InvalidInput | crate::error::GbErrorKind::NotFound), "{branch} {up}: {e:?}");
        }
        let e = send(&env.api, set("nope", json!(null))).await.unwrap_err();
        assert_eq!(e.message, "No branch nope");
        let e = send(&env.api, set("main", json!({"remote": "nowhere", "branch": "main"}))).await.unwrap_err();
        assert_eq!(e.message, "No remote nowhere");
        assert_eq!(RepoState::capture(&r), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_refuses_a_start_that_is_not_a_commit() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": "x", "start": "1234567890123456789012345678901234567890", "checkout": false}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
        assert_eq!(RepoState::capture(&r), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reused_name_refuses_undo_and_redo() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        send(&env.api, json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt(&r), "from": "feature/login", "to": "feature/signin"}})).await.unwrap();
        // The old name is taken again: undo refuses (no "Undo anyway").
        r.git(&["branch", "feature/login", "main"]);
        let state = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        let e = send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": state["undo"]["entry"]}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::Stale, "{e:?}");
        assert_eq!(r.git(&["rev-parse", "feature/login"]), oid(&r, "main"));
        // The new name moved elsewhere: undo refuses too.
        r.git(&["branch", "-D", "feature/login"]);
        r.git(&["branch", "-f", "feature/signin", "main"]);
        let e = send(&env.api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(&r), "entry": state["undo"]["entry"]}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::Stale, "{e:?}");
        assert_eq!(r.git(&["rev-parse", "feature/signin"]), oid(&r, "main"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn renaming_the_checked_out_branch_keeps_head_on_it() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        send(&env.api, json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt(&r), "from": "main", "to": "trunk"}})).await.unwrap();
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/trunk");
        undo_top(&env.api, id, &r).await;
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn renaming_a_branch_checked_out_in_another_worktree_moves_its_head() {
        let env = WriteEnv::new();
        let r = repo();
        let other = r.path().join("..").join(format!("{}-other", r.path().file_name().unwrap().to_string_lossy()));
        r.git(&["worktree", "add", other.to_str().unwrap(), "feature/login"]);
        let id = open(&env.api, &r).await;
        send(&env.api, json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt(&r), "from": "feature/login", "to": "feature/signin"}})).await.unwrap();
        let head = r.try_git_in(&other, &["symbolic-ref", "HEAD"]).unwrap();
        assert_eq!(head, "refs/heads/feature/signin");
        let _ = std::fs::remove_dir_all(&other);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rename_keeps_push_remote() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["config", "branch.feature/login.pushRemote", "origin"]);
        let id = open(&env.api, &r).await;
        send(&env.api, json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt(&r), "from": "feature/login", "to": "feature/signin"}})).await.unwrap();
        assert_eq!(r.git(&["config", "branch.feature/signin.pushRemote"]), "origin");
        assert!(r.try_git(&["config", "branch.feature/login.pushRemote"]).is_err());
    }

    // --- 2C repo-safety (safety review 2 N1) ---

    /// A repository to clone from, with one commit.
    fn upstream() -> TestRepo {
        let s = TestRepo::new();
        identity(&s);
        s.write("s.txt", "s\n");
        s.git(&["add", "."]);
        s.git(&["commit", "-q", "-m", "s"]);
        s
    }

    /// `git clone` of `from` at `at`, with a local-only branch (what the user would lose).
    fn embed(r: &TestRepo, from: &TestRepo, at: &str) {
        r.git(&["clone", "-q", &from.path().display().to_string(), at]);
        let sm = r.path().join(at);
        for args in [&["config", "user.name", "Ada Lovelace"][..], &["config", "user.email", "ada@example.com"], &["switch", "-q", "-c", "feat"]] {
            r.git_in(&sm, args);
        }
        std::fs::write(sm.join("local.txt"), "local\n").unwrap();
        r.git_in(&sm, &["add", "local.txt"]);
        r.git_in(&sm, &["commit", "-q", "-m", "local-only"]);
        r.git_in(&sm, &["switch", "-q", "main"]);
    }

    fn create_checked_out(id: u32, r: &TestRepo, name: &str, start: &str) -> serde_json::Value {
        json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(r), "name": name, "start": start, "checkout": true, "expect": {"refs": {format!("refs/heads/{name}"): null}}}})
    }

    /// R5: on `b`, whose gitlink `sm` is a clean populated clone, creating `c` from `a` (the
    /// file `sm`) and checking it out would delete the clone whole: refused, nothing changed.
    #[tokio::test(flavor = "multi_thread")]
    async fn create_with_checkout_never_deletes_a_clean_submodule_where_the_start_has_a_file() {
        let sub = upstream();
        let r = TestRepo::new();
        identity(&r);
        r.write("x", "x\n");
        r.git(&["add", "x"]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.switch_new("a");
        r.write("sm", "file\n");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "file"]);
        r.git(&["switch", "-q", "-c", "b", "main"]);
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "gitlink"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, create_checked_out(id, &r, "c", &oid(&r, "a"))).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (crate::error::GbErrorKind::InvalidInput, "sm is a repository in the way of the checkout: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
        assert!(r.try_git(&["rev-parse", "--verify", "refs/heads/c"]).is_err(), "no branch was made");
    }

    /// R5d: an ignored clone at `lib/inner`, where the start commit has the file `lib`: git
    /// would delete it without a word (ignored files are expendable to it): refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn create_with_checkout_never_deletes_an_ignored_clone_under_a_folder_the_start_replaces() {
        let sub = upstream();
        let r = TestRepo::new();
        identity(&r);
        r.write("x", "x\n");
        r.git(&["add", "x"]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.switch_new("a");
        r.write("lib", "file\n");
        r.git(&["add", "lib"]);
        r.git(&["commit", "-q", "-m", "file"]);
        r.switch("main");
        std::fs::write(r.path().join(".git/info/exclude"), "lib/\n").unwrap();
        embed(&r, &sub, "lib/inner");
        assert_eq!(r.git(&["status", "--porcelain"]), "", "the clone is ignored");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, create_checked_out(id, &r, "c", &oid(&r, "a"))).await.unwrap_err();
        assert_eq!(e.message, "lib/inner is a repository in the way of the checkout: move it first");
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("lib/inner/.git").is_dir());
    }
    // --- end 2C repo-safety ---
}
