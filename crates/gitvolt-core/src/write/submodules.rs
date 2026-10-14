//! Submodule commands (the palette's "Submodules: …" and a submodule row's menu), each the git
//! command a terminal would run:
//! - Update: `git submodule update --init --recursive [-- <path>]`. It clones and fetches inside
//!   the submodules, so it runs as a network command (askpass, cancellable, no timeout, progress
//!   as a fetch's), outside the write lock like a push.
//! - Sync URLs: `git submodule sync --recursive`, which copies `.gitmodules`' URLs into the config.
//!
//! Neither is journaled (spec #2 §5.3 "Not journaled"): they move no ref of the superproject and
//! don't touch its index, and what they change inside a submodule is that submodule's own.

use crate::error::{ErrorDetail, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::UndoKind;
use crate::write::{Plan, Pre, Staging, WriteCx, WriteIntent};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmoduleOutcome {
    /// The git command that ran, as a terminal would show it.
    pub command: String,
}

pub(crate) struct UpdateSubmodules {
    /// One submodule (its path in the worktree), or all of them.
    pub path: Option<String>,
    /// The user confirmed leaving commits on no branch behind (`SubmoduleOrphans`).
    pub confirm: bool,
}

/// A repository checked out at `path` in `root`: `gix::open` of that folder alone (never a
/// discovery up to the superproject), and never through a symlink.
fn checkout_head(root: &Path, path: &str) -> Option<String> {
    let dir = crate::blob::safe_join(root, path).ok()?;
    if !std::fs::symlink_metadata(&dir).ok()?.is_dir() {
        return None;
    }
    gix::open(&dir).ok()?.head_id().ok().map(|id| id.to_string())
}

/// The submodules `only` names (or all) that an update would move, checked out at another commit
/// than the one recorded, whose HEAD has commits on no branch, tag or remote branch: each path
/// with how many. A checkout of the recorded commit leaves those behind (in the reflog only).
/// Top-level submodules only: a nested one's are its parent's business.
async fn orphaned(api: &crate::api::Api, root: &Path, only: Option<&str>) -> Result<Vec<(String, u32)>, GbError> {
    let r = root.to_path_buf();
    let links = crate::api::blocking(move || crate::submodules::gitlinks(&r)).await?;
    let mut out = Vec::new();
    for (path, recorded) in links.into_iter().filter(|(p, _)| only.is_none_or(|o| o == p)) {
        let (r, p) = (root.to_path_buf(), path.clone());
        let head = crate::api::blocking(move || Ok(checkout_head(&r, &p))).await?;
        if head.is_none_or(|h| h == recorded) {
            continue;
        }
        let args = ["rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes"];
        let n = api.cli.run(GitInvocation::new(root.join(&path), args)).await?;
        let n: u32 = String::from_utf8_lossy(&n.stdout).trim().parse().unwrap_or(0);
        if n > 0 {
            out.push((path, n));
        }
    }
    Ok(out)
}

/// "Update vendor/parser? Its 2 commits not on any branch will be left behind (still in its
/// reflog)", or the same of several submodules.
fn orphans_question(orphans: &[(String, u32)]) -> String {
    let commits = |n: u32| if n == 1 { "1 commit".to_string() } else { format!("{n} commits") };
    match orphans {
        [(path, n)] => format!("Update {path}? Its {} not on any branch will be left behind (still in its reflog)", commits(*n)),
        _ => {
            let total = orphans.iter().map(|(_, n)| n).sum();
            let paths: Vec<&str> = orphans.iter().map(|(p, _)| p.as_str()).collect();
            let (last, rest) = paths.split_last().expect("several");
            format!("Update the submodules? {} not on any branch in {} and {last} will be left behind (still in their reflogs)", commits(total), rest.join(", "))
        }
    }
}

impl UpdateSubmodules {
    /// `progress`: git's progress lines too (what runs; the command shown leaves it out).
    fn args(&self, progress: bool) -> Vec<&str> {
        let mut args = vec!["submodule", "update", "--init", "--recursive"];
        if progress {
            args.push("--progress");
        }
        if let Some(p) = &self.path {
            args.extend(["--", p.as_str()]);
        }
        args
    }
}


impl WriteIntent for UpdateSubmodules {
    type Outcome = SubmoduleOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Submodule
    }
    fn label(&self) -> String {
        match &self.path {
            Some(p) => format!("update submodule {p}"),
            None => "update submodules".into(),
        }
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(path) = &self.path {
            crate::blob::check_relative(path)?;
            let root = pre.root.to_path_buf();
            let links = crate::api::blocking(move || crate::submodules::gitlinks(&root)).await?;
            if !links.iter().any(|(p, _)| p == path) {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} isn't a submodule")));
            }
        }
        // Commits made in a submodule on no branch: asked first, as a hard reset's losses.
        if !self.confirm {
            let orphans = orphaned(pre.api, pre.root, self.path.as_deref()).await?;
            if !orphans.is_empty() {
                let commits = orphans.iter().map(|(_, n)| n).sum();
                let paths = orphans.iter().map(|(p, _)| p.clone()).collect();
                return Err(GbError::new(GbErrorKind::DirtyWorktree, orphans_question(&orphans)).with_detail(ErrorDetail::SubmoduleOrphans { paths, commits }));
            }
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<SubmoduleOutcome, GbError> {
        let command = crate::netops::display_command(&self.args(false));
        // Git's progress lines are `opProgress`, as a fetch's, and Activity's output too.
        let (tx, progress) = crate::netops::forward_progress_to(cx.api.bus.clone(), cx.op.id, Some(cx.output()));
        let inv = cx.net_git(self.args(true)).stream_stderr(tx);
        let res = cx.network(inv).await;
        let _ = progress.await;
        // `--init` writes the submodules' URLs to the config; a checkout changes the worktree.
        cx.touch(ChangeKind::Worktree);
        cx.touch(ChangeKind::Config);
        res?;
        Ok(SubmoduleOutcome { command })
    }
}

pub(crate) struct SyncSubmodules;

impl WriteIntent for SyncSubmodules {
    type Outcome = SubmoduleOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Submodule
    }
    fn label(&self) -> String {
        "sync submodule URLs".into()
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<SubmoduleOutcome, GbError> {
        let args = ["submodule", "sync", "--recursive"];
        let inv = cx.git(args);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Config);
        Ok(SubmoduleOutcome { command: crate::netops::display_command(&args) })
    }
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::events::{AppEvent, OpKind, OpOutcome};
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use crate::write::test_support::{call, open, wt};
    use serde_json::json;
    use std::ffi::OsString;

    /// The test API, which may clone the fixture's local submodule sources: git refuses a local
    /// submodule URL unless `protocol.file.allow` says so (a user's own config would).
    fn api(data: &std::path::Path) -> crate::api::Api {
        api_with(data, &[])
    }

    /// `api`, with more config for every git it runs (the submodules' own included).
    fn api_with(data: &std::path::Path, config: &[(&str, &str)]) -> crate::api::Api {
        let mut env = isolated_git_env();
        let all: Vec<(&str, &str)> = [("protocol.file.allow", "always")].into_iter().chain(config.iter().copied()).collect();
        env.push(("GIT_CONFIG_COUNT".into(), all.len().to_string().into()));
        for (i, (k, v)) in all.iter().enumerate() {
            env.push((OsString::from(format!("GIT_CONFIG_KEY_{i}")), OsString::from(*k)));
            env.push((OsString::from(format!("GIT_CONFIG_VALUE_{i}")), OsString::from(*v)));
        }
        let cli = crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(500))).with_env(env);
        crate::api::Api::new(cli, None).with_data_dir(data.to_path_buf())
    }

    fn head_in(r: &TestRepo, sub: &str) -> Option<String> {
        r.try_git_in(&r.path().join(sub), &["rev-parse", "HEAD"]).ok()
    }

    #[tokio::test]
    async fn update_initialises_and_checks_out_the_recorded_commits() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        let recorded = r.git(&["rev-parse", "HEAD:vendor/theme"]);
        // The parser moved ahead of what's recorded.
        let parser = r.path().join("vendor/parser");
        let parser_recorded = r.git(&["rev-parse", "HEAD:vendor/parser"]);
        r.git_in(&parser, &["checkout", "-q", "HEAD~1"]);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let done = call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert_eq!(done["outcome"]["command"], "git submodule update --init --recursive");
        assert_eq!(done["journal"]["undo"], serde_json::Value::Null, "not journaled");
        assert_eq!(head_in(&r, "vendor/theme").as_deref(), Some(recorded.as_str()));
        assert_eq!(head_in(&r, "vendor/parser").as_deref(), Some(parser_recorded.as_str()));
        assert_eq!(r.git(&["status", "--porcelain"]), "", "nothing left to show");
    }

    #[tokio::test]
    async fn update_of_one_submodule_leaves_the_others() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        let parser = r.path().join("vendor/parser");
        r.git_in(&parser, &["checkout", "-q", "HEAD~1"]);
        let moved = head_in(&r, "vendor/parser");
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let done = call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path()), "path": "vendor/theme"})).await.unwrap();
        assert_eq!(done["outcome"]["command"], "git submodule update --init --recursive -- vendor/theme");
        assert!(head_in(&r, "vendor/theme").is_some(), "initialised");
        assert_eq!(head_in(&r, "vendor/parser"), moved, "the parser stays where it was");
        // A path that isn't a submodule is refused before git runs.
        for bad in ["README.md", "../x", "-x"] {
            let err = call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path()), "path": bad})).await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad}: {err:?}");
        }
    }

    /// Commits made in a submodule on no branch: Update asks first (arming in place), and only
    /// the confirmed one leaves them behind.
    #[tokio::test]
    async fn update_asks_before_leaving_commits_on_no_branch_behind() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        let parser = r.path().join("vendor/parser");
        r.git_in(&parser, &["checkout", "-q", "--detach"]);
        for n in ["one", "two"] {
            std::fs::write(parser.join(format!("{n}.txt")), "x\n").unwrap();
            r.git_in(&parser, &["add", "-A"]);
            r.git_in(&parser, &["commit", "-q", "-m", n]);
        }
        let detached = head_in(&r, "vendor/parser");
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        for path in [None, Some("vendor/parser")] {
            let mut params = json!({"repo": id, "worktree": wt(r.path())});
            if let Some(p) = path {
                params["path"] = json!(p);
            }
            let err = call(&api, "submoduleUpdate", params).await.unwrap_err();
            assert_eq!(err.message, "Update vendor/parser? Its 2 commits not on any branch will be left behind (still in its reflog)");
            assert_eq!(serde_json::to_value(&err.detail).unwrap(), json!({"kind": "submoduleOrphans", "paths": ["vendor/parser"], "commits": 2}));
            assert_eq!(head_in(&r, "vendor/parser"), detached, "nothing ran");
        }
        // The other submodule alone doesn't ask.
        call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path()), "path": "vendor/theme"})).await.unwrap();
        call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path()), "confirm": true})).await.unwrap();
        assert_eq!(head_in(&r, "vendor/parser").as_deref(), Some(r.git(&["rev-parse", "HEAD:vendor/parser"]).as_str()));
        assert_eq!(r.git_in(&parser, &["rev-parse", "HEAD@{1}"]), detached.unwrap(), "still in its reflog");
    }

    #[test]
    fn the_question_names_every_submodule() {
        let q = super::orphans_question(&[("vendor/a".into(), 1), ("vendor/b".into(), 2), ("vendor/c".into(), 1)]);
        assert_eq!(q, "Update the submodules? 4 commits not on any branch in vendor/a, vendor/b and vendor/c will be left behind (still in their reflogs)");
        assert_eq!(super::orphans_question(&[("vendor/a".into(), 1)]), "Update vendor/a? Its 1 commit not on any branch will be left behind (still in its reflog)");
    }

    #[tokio::test]
    async fn a_failed_update_says_why() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        std::fs::remove_dir_all(r.root().join("theme-src")).unwrap();
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap_err();
        assert_ne!(err.kind, GbErrorKind::Cancelled);
        assert!(err.stderr.as_deref().is_some_and(|s| s.contains("Failed to clone 'vendor/theme'")), "git's own words: {err:?}");
        assert!(head_in(&r, "vendor/theme").is_none() || head_in(&r, "vendor/theme") == Some(r.git(&["rev-parse", "HEAD"])), "nothing checked out there");
        assert!(!r.path().join(".git/modules/vendor/theme").join("HEAD").exists(), "no half clone left");
    }

    /// Git's progress lines are `opProgress`, as a fetch's (a `file://` URL takes the transport,
    /// which reports them).
    #[tokio::test]
    async fn update_reports_progress_as_a_fetch_does() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        let url = format!("file://{}", crate::platform::fs::to_git_path(r.root().join("theme-src")));
        r.git(&["config", "-f", ".gitmodules", "submodule.vendor/theme.url", &url]);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        call(&api, "submoduleUpdate", json!({"repo": id, "worktree": wt(r.path()), "path": "vendor/theme"})).await.unwrap();
        let mut events = Vec::new();
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }
        let op = events.iter().find_map(|e| match e {
            AppEvent::OpStarted { op, kind: OpKind::Submodule, label, .. } if label == "update submodule vendor/theme" => Some(*op),
            _ => None,
        });
        let op = op.unwrap_or_else(|| panic!("no Submodule op: {events:?}"));
        assert!(events.iter().any(|e| matches!(e, AppEvent::OpProgress { op: o, percent: Some(_), .. } if *o == op)), "progress: {events:?}");
        assert!(events.iter().any(|e| matches!(e, AppEvent::OpFinished { op: o, outcome: OpOutcome::Ok, .. } if *o == op)));
    }

    /// Cancel stops git (and the submodule's own hook it waits on), and says Cancelled.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_update_stops() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        r.git_in(&r.path().join("vendor/parser"), &["checkout", "-q", "HEAD~1"]);
        let hooks = r.root().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let started = r.root().join("checkout-started");
        let hook = hooks.join("post-checkout");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nsleep 30\n", crate::platform::fs::to_git_path(&started))).unwrap();
        crate::platform::fs::set_mode(&hook, 0o755).unwrap();
        let data = tempfile::tempdir().unwrap();
        let api = std::sync::Arc::new(api_with(data.path(), &[("core.hooksPath", hooks.to_str().unwrap())]));
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let (a2, w) = (api.clone(), wt(r.path()));
        let update = tokio::spawn(async move { call(&a2, "submoduleUpdate", json!({"repo": id, "worktree": w, "path": "vendor/parser"})).await });
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the update reached the submodule's checkout");
        let op = std::iter::from_fn(|| rx.try_recv().ok()).find_map(|e| match e {
            AppEvent::OpStarted { op, kind: OpKind::Submodule, .. } => Some(op),
            _ => None,
        });
        api.ops().cancel(op.expect("the op started"));
        let err = tokio::time::timeout(std::time::Duration::from_secs(10), update).await.expect("stopped promptly").unwrap().unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled, "{err:?}");
    }

    #[tokio::test]
    async fn sync_copies_the_gitmodules_urls_into_the_config() {
        let r = TestRepo::new();
        fixtures::submodules(&r);
        let moved = r.root().join("parser-moved");
        std::fs::rename(r.root().join("parser-src"), &moved).unwrap();
        r.git(&["config", "-f", ".gitmodules", "submodule.vendor/parser.url", &moved.display().to_string()]);
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let done = call(&api, "submoduleSync", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert_eq!(done["outcome"]["command"], "git submodule sync --recursive");
        assert_eq!(r.git(&["config", "submodule.vendor/parser.url"]), moved.display().to_string());
        assert_eq!(r.git_in(&r.path().join("vendor/parser"), &["config", "remote.origin.url"]), moved.display().to_string());
    }
}
