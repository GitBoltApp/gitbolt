//! Worktrees (spec #2 §11.1): add and remove, neither journaled. The suggested folder is
//! `<main worktree's parent>/<repo>-<branch>`, every `/` turned into `-` (never nested
//! folders), then `-2`, `-3`… when taken.

use crate::error::{GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::UndoKind;
use crate::write::precheck::display_worktree;
use crate::write::{Plan, Pre, WriteCx, WriteIntent};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

pub(crate) fn suggest_worktree_path(main_root: &Path, branch: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let parent = main_root.parent().unwrap_or(main_root);
    let repo = main_root.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let base = format!("{repo}-{}", branch.replace('/', "-"));
    let first = parent.join(&base);
    if !taken(&first) {
        return first;
    }
    (2..).map(|n| parent.join(format!("{base}-{n}"))).find(|p| !taken(p)).expect("an unused number")
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum WorktreeBranch {
    /// A local branch not checked out anywhere.
    Existing { name: String },
    /// A new branch at the commit `at`.
    New { name: String, at: String },
    /// A new tracking branch from `<remote>/<branch>`.
    Remote { remote: String, branch: String, name: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorktreeAdded {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum WorktreeRemoveOutcome {
    Removed,
    /// git refused: uncommitted or untracked changes. The UI asks again, then sends `force`.
    NeedsForce { reason: String },
}

async fn main_root(pre_cli: &crate::git::GitCli, root: &Path) -> Result<PathBuf, GbError> {
    let list = crate::worktree::list_worktrees(pre_cli, root).await?;
    Ok(list.into_iter().find(|w| w.is_main).map(|w| w.path).unwrap_or_else(|| root.to_path_buf()))
}

fn valid_name(name: &str) -> Result<(), GbError> {
    match crate::write::names::branch_name_error(name) {
        Some(why) => Err(GbError::new(GbErrorKind::InvalidInput, why)),
        None => Ok(()),
    }
}

pub(crate) struct WorktreeAdd {
    pub path: PathBuf,
    pub branch: WorktreeBranch,
    /// How the label names it (`../shop-x`), from the request.
    pub shown: String,
}

impl WriteIntent for WorktreeAdd {
    type Outcome = WorktreeAdded;
    fn kind(&self) -> OpKind {
        OpKind::Worktree
    }
    fn label(&self) -> String {
        format!("add worktree {}", self.shown)
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    /// `post-checkout`.
    fn runs_hooks(&self) -> bool {
        true
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if !self.path.is_absolute() || !self.path.parent().is_some_and(Path::is_dir) {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Pick a folder in an existing folder"));
        }
        if self.path.exists() && std::fs::read_dir(&self.path).map(|mut d| d.next().is_some()).unwrap_or(true) {
            return Err(GbError::new(GbErrorKind::InvalidInput, "That folder isn't empty"));
        }
        let (WorktreeBranch::Existing { name } | WorktreeBranch::New { name, .. } | WorktreeBranch::Remote { name, .. }) = &self.branch;
        // Read before any await: a gix repository isn't `Send`.
        let exists = {
            let repo = gix::open(pre.root).map_err(crate::error::gix_err)?;
            crate::write::refs::read_ref(&repo, &format!("refs/heads/{name}")).ok().flatten().is_some()
        };
        match &self.branch {
            WorktreeBranch::Existing { name } => {
                if !exists {
                    return Err(GbError::new(GbErrorKind::NotFound, format!("No branch {name}")));
                }
                let list = crate::worktree::list_worktrees(&pre.api.cli, pre.root).await?;
                let full = format!("refs/heads/{name}");
                if let Some(w) = list.iter().find(|w| w.branch.as_deref() == Some(full.as_str())) {
                    let main = list.iter().find(|m| m.is_main).map(|m| m.path.clone()).unwrap_or_else(|| pre.h.workdir.clone());
                    return Err(GbError::checked_out_elsewhere(name, &display_worktree(&main, &w.path)));
                }
            }
            WorktreeBranch::New { name, .. } | WorktreeBranch::Remote { name, .. } => {
                valid_name(name)?;
                if exists {
                    return Err(GbError::new(GbErrorKind::InvalidInput, format!("A branch named {name} already exists")));
                }
            }
        }
        let extra: Vec<&str> = match &self.branch {
            WorktreeBranch::Existing { .. } => Vec::new(),
            WorktreeBranch::New { at, .. } => vec![at.as_str()],
            WorktreeBranch::Remote { remote, branch, .. } => vec![remote.as_str(), branch.as_str()],
        };
        if name.starts_with('-') || extra.iter().any(|v| v.starts_with('-')) {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Names can't start with a dash"));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<WorktreeAdded, GbError> {
        let path = self.path.display().to_string();
        let args: Vec<String> = match &self.branch {
            WorktreeBranch::Existing { name } => vec!["worktree".into(), "add".into(), "--".into(), path.clone(), name.clone()],
            WorktreeBranch::New { name, at } => vec!["worktree".into(), "add".into(), "-b".into(), name.clone(), "--".into(), path.clone(), at.clone()],
            WorktreeBranch::Remote { remote, branch, name } => vec!["worktree".into(), "add".into(), "--track".into(), "-b".into(), name.clone(), "--".into(), path.clone(), format!("refs/remotes/{remote}/{branch}")],
        };
        let inv = cx.git(args);
        cx.run_git(inv).await?;
        for k in [ChangeKind::Head, ChangeKind::Refs, ChangeKind::Config] {
            cx.touch(k);
        }
        Ok(WorktreeAdded { path: self.path.canonicalize().unwrap_or_else(|_| self.path.clone()).display().to_string() })
    }
}

pub(crate) struct WorktreeRemove {
    pub path: PathBuf,
    pub force: bool,
    pub shown: String,
}

impl WriteIntent for WorktreeRemove {
    type Outcome = WorktreeRemoveOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Worktree
    }
    fn label(&self) -> String {
        format!("remove worktree {}", self.shown)
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let list = crate::worktree::list_worktrees(&pre.api.cli, pre.root).await?;
        let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        let Some(w) = list.iter().find(|w| canonical(&w.path) == canonical(&self.path)) else {
            return Err(GbError::new(GbErrorKind::NotFound, "That isn't a worktree of this repository"));
        };
        if w.is_main {
            return Err(GbError::new(GbErrorKind::InvalidInput, "The main worktree can't be removed"));
        }
        if w.locked {
            return Err(GbError::new(GbErrorKind::InvalidInput, "This worktree is locked; unlock it first"));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<WorktreeRemoveOutcome, GbError> {
        let path = self.path.display().to_string();
        let mut args = vec!["worktree", "remove"];
        if self.force {
            args.push("--force");
        }
        args.push("--");
        args.push(path.as_str());
        let inv = cx.git(args);
        cx.touch(ChangeKind::Head);
        match cx.run_git(inv).await {
            Ok(_) => Ok(WorktreeRemoveOutcome::Removed),
            Err(e) if !self.force && e.stderr.as_deref().is_some_and(|s| s.contains("contains modified or untracked files")) => Ok(WorktreeRemoveOutcome::NeedsForce { reason: "It has changes that aren't committed".into() }),
            Err(e) => Err(e),
        }
    }
}

/// Where a remove runs: the main worktree (never the one going away).
pub(crate) async fn remove_cwd(cli: &crate::git::GitCli, root: &Path) -> Result<PathBuf, GbError> {
    main_root(cli, root).await
}

/// `SuggestWorktreePath` (a read): the folder the create dialog proposes.
pub(crate) async fn suggest(cli: &crate::git::GitCli, root: &Path, branch: &str) -> Result<String, GbError> {
    let main = main_root(cli, root).await?;
    let main = main.canonicalize().unwrap_or(main);
    Ok(suggest_worktree_path(&main, branch, Path::exists).display().to_string())
}

/// How the label shows `path`.
pub(crate) async fn shown(cli: &crate::git::GitCli, root: &Path, path: &Path) -> String {
    match main_root(cli, root).await {
        Ok(main) => display_worktree(&main, path),
        Err(_) => path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::suggest_worktree_path;
    use crate::error::GbErrorKind;
    use crate::testing::write::{identity, open, send, wt, WriteEnv};
    use crate::testing::TestRepo;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    /// Review Focus 2; spec §17.1 "Worktree paths".
    #[test]
    fn suggested_paths_dash_slashes_and_number_collisions() {
        let main = Path::new("/r/shop");
        assert_eq!(suggest_worktree_path(main, "feature/x", |_| false), PathBuf::from("/r/shop-feature-x"));
        assert_eq!(suggest_worktree_path(main, "release.1/ü-x", |_| false), PathBuf::from("/r/shop-release.1-ü-x"));
        let taken = |p: &Path| p == Path::new("/r/shop-feature-x") || p == Path::new("/r/shop-feature-x-2");
        assert_eq!(suggest_worktree_path(main, "feature/x", taken), PathBuf::from("/r/shop-feature-x-3"));
    }

    fn repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.commit("one");
        r.add_origin();
        r.push("main");
        r.git(&["branch", "topic"]);
        r.git(&["push", "-q", "origin", "main:refs/heads/remote-only"]);
        r.git(&["fetch", "-q", "origin"]);
        r
    }

    fn add(id: u32, r: &TestRepo, path: &Path, branch: serde_json::Value) -> serde_json::Value {
        json!({"method": "worktreeAdd", "params": {"repo": id, "worktree": wt(r), "path": path, "branch": branch}})
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn add_an_existing_a_new_and_a_remote_branch() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let (a, b, c) = (r.root().join("repo-topic"), r.root().join("repo-new"), r.root().join("repo-remote-only"));
        let out = send(&env.api, add(id, &r, &a, json!({"kind": "existing", "name": "topic"}))).await.unwrap();
        assert_eq!(out["outcome"]["path"].as_str(), Some(a.canonicalize().unwrap().display().to_string().as_str()));
        send(&env.api, add(id, &r, &b, json!({"kind": "new", "name": "made/here", "at": head}))).await.unwrap();
        send(&env.api, add(id, &r, &c, json!({"kind": "remote", "remote": "origin", "branch": "remote-only", "name": "remote-only"}))).await.unwrap();
        assert_eq!(r.git_in(&a, &["symbolic-ref", "HEAD"]), "refs/heads/topic");
        assert_eq!(r.git_in(&b, &["symbolic-ref", "HEAD"]), "refs/heads/made/here");
        assert_eq!(r.git_in(&c, &["rev-parse", "--abbrev-ref", "remote-only@{upstream}"]), "origin/remote-only");
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        assert!(s["undo"].is_null(), "worktree operations aren't journaled");
    }

    /// 2C final I3: the remote form starts from `refs/remotes/<remote>/<branch>`, never a DWIM
    /// name: a local branch spelled `origin/remote-only` (which DWIM picks first) changes
    /// neither the start nor the upstream.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_branch_worktree_starts_from_the_remote_ref_not_a_lookalike() {
        let env = WriteEnv::new();
        let r = repo();
        let remote = r.git(&["rev-parse", "refs/remotes/origin/remote-only"]);
        r.commit("two");
        r.git(&["branch", "origin/remote-only"]);
        assert_ne!(r.git(&["rev-parse", "refs/heads/origin/remote-only"]), remote);
        let id = open(&env.api, &r).await;
        let c = r.root().join("repo-remote-only");
        send(&env.api, add(id, &r, &c, json!({"kind": "remote", "remote": "origin", "branch": "remote-only", "name": "remote-only"}))).await.unwrap();
        assert_eq!(r.git_in(&c, &["rev-parse", "HEAD"]), remote);
        assert_eq!(r.git_in(&c, &["rev-parse", "--symbolic-full-name", "remote-only@{upstream}"]), "refs/remotes/origin/remote-only");
        assert_eq!((r.git(&["config", "branch.remote-only.remote"]), r.git(&["config", "branch.remote-only.merge"])), ("origin".to_string(), "refs/heads/remote-only".to_string()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn adding_a_branch_checked_out_elsewhere_or_into_a_used_folder_is_refused() {
        let env = WriteEnv::new();
        let r = repo();
        r.add_worktree("t", "topic");
        let id = open(&env.api, &r).await;
        let e = send(&env.api, add(id, &r, &r.root().join("again"), json!({"kind": "existing", "name": "topic"}))).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"], json!({"kind": "checkedOutElsewhere", "branch": "topic", "worktree": "../wt-t"}));
        let used = r.root().join("used");
        std::fs::create_dir_all(used.join("x")).unwrap();
        let e = send(&env.api, add(id, &r, &used, json!({"kind": "new", "name": "n", "at": r.git(&["rev-parse", "HEAD"])}))).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "That folder isn't empty"));
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/n"]).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn remove_asks_for_force_when_dirty_and_refuses_main_and_locked() {
        let env = WriteEnv::new();
        let r = repo();
        let p = r.add_worktree("t", "topic");
        std::fs::write(p.join("dirty.txt"), "x\n").unwrap();
        let id = open(&env.api, &r).await;
        let remove = |path: &Path, force: bool| json!({"method": "worktreeRemove", "params": {"repo": id, "worktree": wt(&r), "path": path, "force": force}});
        let out = send(&env.api, remove(&p, false)).await.unwrap();
        assert_eq!(out["outcome"]["status"], "needsForce");
        assert!(p.exists());
        send(&env.api, remove(&p, true)).await.unwrap();
        assert!(!p.exists());
        assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/topic"]).is_ok(), "the branch stays");
        let e = send(&env.api, remove(r.path(), true)).await.unwrap_err();
        assert_eq!(e.message, "The main worktree can't be removed");
        let l = r.add_worktree("l", "main~0");
        r.git(&["worktree", "lock", l.to_str().unwrap()]);
        let e = send(&env.api, remove(&l, true)).await.unwrap_err();
        assert_eq!(e.message, "This worktree is locked; unlock it first");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn option_like_values_and_non_worktrees_are_refused() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let dest = r.root().join("dashed");
        for b in [
            json!({"kind": "new", "name": "ok", "at": "--detach"}),
            json!({"kind": "remote", "remote": "--x", "branch": "remote-only", "name": "ok2"}),
            json!({"kind": "remote", "remote": "origin", "branch": "-b", "name": "ok3"}),
        ] {
            let e = send(&env.api, add(id, &r, &dest, b)).await.unwrap_err();
            assert_eq!(e.kind, GbErrorKind::InvalidInput);
        }
        assert!(!dest.exists());
        let remove = json!({"method": "worktreeRemove", "params": {"repo": id, "worktree": wt(&r), "path": r.root().join("nope"), "force": true}});
        let e = send(&env.api, remove).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "That isn't a worktree of this repository"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_suggestion_request_names_a_free_folder_beside_the_main_worktree() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        std::fs::create_dir_all(r.root().join("repo-feature-x")).unwrap();
        let v = send(&env.api, json!({"method": "suggestWorktreePath", "params": {"repo": id, "branch": "feature/x"}})).await.unwrap();
        assert_eq!(v.as_str(), Some(r.root().canonicalize().unwrap().join("repo-feature-x-2").display().to_string().as_str()));
    }
}
