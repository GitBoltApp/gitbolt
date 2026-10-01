//! Network operations (spec §13 clone, §15 fetch). Both run with no timeout, stream progress
//! as `opProgress`, can be cancelled (`cancelOp`: git is killed as a process group), and use
//! askpass (spec §5.4). They run detached from any terminal (K96), so every prompt reaches
//! askpass or fails at once: nothing waits on a tty.
//!
//! Amendment 2: fetch is allowed. It writes remote-tracking refs and objects, never the working
//! tree, the index, local branches or config; `--no-prune-tags` keeps a `fetch.pruneTags`
//! config from deleting local tags behind the user's back.

use crate::api::Api;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{AppEvent, EventBus, OpKind, OpOutcome};
use crate::git::GitInvocation;
use crate::ops::{OpEntry, OpId};
use crate::payload::RepoSummary;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub phase: String,
    pub percent: Option<u8>,
}

/// One git progress line (`Receiving objects:  45% (450/1000), ...`, `Fetching origin`).
pub fn parse_progress(line: &str) -> Option<Progress> {
    let line = line.trim();
    let line = line.strip_prefix("remote:").map(str::trim).unwrap_or(line);
    if let Some((phase, rest)) = line.split_once(':') {
        let rest = rest.trim_start();
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let is_phase = !phase.is_empty() && phase.chars().all(|c| c.is_ascii_alphabetic() || c == ' ');
        if is_phase && !digits.is_empty() && rest[digits.len()..].starts_with('%') {
            let percent = digits.parse::<u8>().ok().map(|p| p.min(100));
            return Some(Progress { phase: phase.trim().to_string(), percent });
        }
    }
    line.starts_with("Fetching ").then(|| Progress { phase: line.to_string(), percent: None })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SkipReason {
    /// Another network operation on this repo is running.
    Busy,
    /// A GitBolt-started fetch needed credentials; the next user-started op prompts.
    AuthRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum FetchOutcome {
    Done { changed: bool },
    Skipped { reason: SkipReason },
}

/// Every ref and what it points at, to tell whether a fetch moved anything.
fn ref_state(repo: &gix::ThreadSafeRepository) -> Result<BTreeMap<String, String>, GbError> {
    let repo = repo.to_thread_local();
    let mut out = BTreeMap::new();
    for r in repo.references().map_err(gix_err)?.all().map_err(gix_err)? {
        let Ok(r) = r else { continue };
        let target = match r.target() {
            gix::refs::TargetRef::Object(id) => id.to_string(),
            gix::refs::TargetRef::Symbolic(name) => format!("ref: {}", name.as_bstr()),
        };
        out.insert(r.name().as_bstr().to_string(), target);
    }
    Ok(out)
}

async fn ref_state_async(repo: gix::ThreadSafeRepository) -> Result<BTreeMap<String, String>, GbError> {
    tokio::task::spawn_blocking(move || ref_state(&repo)).await.map_err(|e| GbError::other(format!("ref snapshot failed: {e}")))?
}

/// Forwards progress lines as `opProgress` events, only when the phase or percent changes,
/// until the sender is dropped.
fn forward_progress(bus: EventBus, op: OpId) -> (mpsc::UnboundedSender<String>, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let task = tokio::spawn(async move {
        let mut last: Option<(String, Option<u8>)> = None;
        while let Some(line) = rx.recv().await {
            if let Some(p) = parse_progress(&line) {
                let key = (p.phase.clone(), p.percent);
                if last.as_ref() != Some(&key) {
                    bus.emit(AppEvent::OpProgress { op, phase: p.phase, percent: p.percent });
                    last = Some(key);
                }
            }
        }
    });
    (tx, task)
}

fn is_empty_dir(p: &Path) -> bool {
    std::fs::read_dir(p).map(|mut d| d.next().is_none()).unwrap_or(false)
}

/// The outermost directory on the way to `dest` (itself included) that doesn't exist yet: what a
/// failed clone must remove to leave nothing behind. `None` when `dest` already exists.
fn first_missing(dest: &Path) -> Option<PathBuf> {
    let mut missing = None;
    for a in dest.ancestors() {
        if a.exists() {
            break;
        }
        missing = Some(a.to_path_buf());
    }
    missing
}

/// After a failed or cancelled clone: removes `dest` (the clone's own folder), then each folder
/// the clone created on the way to it, up to `top`, only while it's empty, so anything someone
/// else put there meanwhile (a file, another clone) survives. `top: None` means `dest` already
/// existed (empty): it's emptied again, not removed.
fn remove_failed_clone(dest: &Path, top: Option<&Path>) {
    let Some(top) = top else {
        for entry in std::fs::read_dir(dest).into_iter().flatten().flatten() {
            let p = entry.path();
            let _ = if entry.file_type().is_ok_and(|t| t.is_dir()) { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        }
        return;
    };
    let _ = std::fs::remove_dir_all(dest);
    for dir in dest.ancestors().skip(1) {
        if !dir.starts_with(top) || std::fs::remove_dir(dir).is_err() {
            break;
        }
    }
}

/// A clone or fetch whose credential prompt the user cancelled fails with an auth error; it's
/// reported as cancelled.
fn user_cancelled(e: GbError, op: &OpEntry) -> GbError {
    if e.kind != GbErrorKind::Cancelled && op.prompt_cancelled() {
        GbError { kind: GbErrorKind::Cancelled, message: "Cancelled".into(), ..e }
    } else {
        e
    }
}

/// Never the `ext::` transport (it runs an arbitrary command), whatever the config says.
const NO_EXT: [&str; 2] = ["-c", "protocol.ext.allow=never"];

/// K28: a fetch never starts upkeep in the user's repo. Without these, every fetch spawns
/// `git maintenance run --auto` (which may gc or repack) and, with `fetch.writeCommitGraph`,
/// rewrites the commit-graph: that's the user's own git's job, not a viewer's.
const NO_UPKEEP: [&str; 2] = ["--no-auto-maintenance", "--no-write-commit-graph"];

/// The command as the activity log shows it (K101): `git` and its argv (no environment), through
/// the redactor so a URL's credentials never reach the log.
fn display_command(args: &[&str]) -> String {
    crate::redact::redact(&format!("git {}", args.join(" ")))
}

impl Api {
    /// `git fetch --all` for repo `id` (spec §15), with no upkeep after it (`NO_UPKEEP`). `background` fetches are GitBolt-started: they
    /// never prompt, and a credential prompt makes them `skipped: authRequired`.
    pub(crate) async fn fetch(&self, id: u32, background: bool) -> Result<FetchOutcome, GbError> {
        let h = self.handle(id)?;
        let Ok(_net) = h.net_lock.try_lock() else {
            return Ok(FetchOutcome::Skipped { reason: SkipReason::Busy });
        };
        let op = self.ops.begin(OpKind::Fetch, Some(id), !background);
        self.bus.emit(AppEvent::OpStarted { op: op.id, kind: OpKind::Fetch, repo: Some(id), label: h.name.clone(), interactive: op.interactive });
        let mut command = None;
        let res = async {
            let before = ref_state_async(h.repo.clone()).await?;
            let prune = if self.store.state().settings.prune { "--prune" } else { "--no-prune" };
            let (tx, progress) = forward_progress(self.bus.clone(), op.id);
            let args: Vec<&str> = ["fetch", "--all", prune, "--no-prune-tags"].into_iter().chain(NO_UPKEEP).chain(["--progress"]).collect();
            command = Some(display_command(&args));
            let inv = GitInvocation::new(&h.workdir, NO_EXT.into_iter().chain(args))
                .timeout(None)
                .cancel(op.cancel.clone())
                .detach_terminal()
                .stream_stderr(tx)
                .envs(self.net_env(op.id))
                .env("GIT_NO_LAZY_FETCH", "0"); // a network op may lazy-fetch (a clone's checkout needs it)
            let out = self.cli.run(inv).await;
            let _ = progress.await;
            out?;
            Ok::<bool, GbError>(ref_state_async(h.repo.clone()).await? != before)
        }
        .await;
        let (outcome, result) = match res {
            Ok(changed) => {
                if changed {
                    self.bus.emit(AppEvent::RefsUpdated { repo: id });
                }
                (OpOutcome::Ok, Ok(FetchOutcome::Done { changed }))
            }
            Err(e) if e.kind == GbErrorKind::Cancelled || op.prompt_cancelled() => (OpOutcome::Cancelled, Err(user_cancelled(e, &op))),
            Err(_) if op.auth_denied() => (OpOutcome::Skipped, Ok(FetchOutcome::Skipped { reason: SkipReason::AuthRequired })),
            Err(e) => (OpOutcome::Failed, Err(e)),
        };
        let message = result.as_ref().err().map(|e| e.message.clone());
        self.bus.emit(AppEvent::OpFinished { op: op.id, kind: OpKind::Fetch, repo: Some(id), outcome, message, command });
        result
    }

    /// `git clone` into `dest` (spec §13), then opens it. `dest` must be absolute and must not
    /// exist, or be an empty directory. A failed or cancelled clone removes every folder it
    /// created (an existing empty one is emptied again, not removed).
    pub(crate) async fn clone_repo(&self, url: String, dest: String) -> Result<RepoSummary, GbError> {
        let dest_path = PathBuf::from(&dest);
        if !dest_path.is_absolute() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "The destination must be an absolute path"));
        }
        let created = first_missing(&dest_path);
        if created.is_none() && !is_empty_dir(&dest_path) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{dest} already exists and isn't an empty folder")));
        }
        let parent = dest_path.parent().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "The destination has no parent folder"))?;
        std::fs::create_dir_all(parent)?;
        // git runs from `/`, never from a folder a clone created: a concurrent clone's cleanup may
        // remove one while it's still empty, and git can't work from a deleted cwd ("Unable to
        // read current working directory"). The URL and `dest` are absolute (the UI only takes
        // absolute ones), so the cwd changes nothing else.
        let cwd = PathBuf::from("/");
        let op = self.ops.begin(OpKind::Clone, None, true);
        self.bus.emit(AppEvent::OpStarted { op: op.id, kind: OpKind::Clone, repo: None, label: dest.clone(), interactive: op.interactive });
        let (tx, progress) = forward_progress(self.bus.clone(), op.id);
        let args = ["clone", "--progress", "--", url.as_str(), dest.as_str()];
        let command = Some(display_command(&args));
        let inv = GitInvocation::new(cwd, NO_EXT.into_iter().chain(args))
            .timeout(None)
            .cancel(op.cancel.clone())
            .detach_terminal()
            .stream_stderr(tx)
            .envs(self.net_env(op.id))
            .env("GIT_NO_LAZY_FETCH", "0"); // a network op may lazy-fetch (a clone's checkout needs it)
        let res = self.cli.run(inv).await;
        let _ = progress.await;
        let (outcome, message) = match &res {
            Ok(_) => (OpOutcome::Ok, None),
            Err(e) if e.kind == GbErrorKind::Cancelled || op.prompt_cancelled() => (OpOutcome::Cancelled, Some("Cancelled".to_string())),
            Err(e) => (OpOutcome::Failed, Some(e.message.clone())),
        };
        if res.is_err() {
            remove_failed_clone(&dest_path, created.as_deref());
        }
        self.bus.emit(AppEvent::OpFinished { op: op.id, kind: OpKind::Clone, repo: None, outcome, message, command });
        res.map_err(|e| user_cancelled(e, &op))?;
        self.open_repo(&dest).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Api, Request};
    use crate::events::AppEvent;
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn api() -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), None)
    }

    async fn open(api: &Api, r: &TestRepo) -> u32 {
        let v = api.dispatch(serde_json::from_value::<Request>(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).unwrap()).await.unwrap();
        v["id"].as_u64().unwrap() as u32
    }

    /// Pushes a new branch to the fixture's origin from a second clone.
    fn push_from_elsewhere(r: &TestRepo, branch: &str) {
        let other = r.root().join(format!("other-{branch}"));
        let origin = r.root().join("origin.git");
        r.git_in(r.root(), &["clone", "-q", origin.to_str().unwrap(), other.to_str().unwrap()]);
        r.git_in(&other, &["switch", "-q", "-c", branch]);
        std::fs::write(other.join("new.txt"), "new\n").unwrap();
        r.git_in(&other, &["add", "new.txt"]);
        r.git_in(&other, &["commit", "-q", "-m", "elsewhere"]);
        r.git_in(&other, &["push", "-q", "origin", branch]);
    }

    fn drain(rx: &mut tokio::sync::broadcast::Receiver<AppEvent>) -> Vec<AppEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        out
    }

    #[test]
    fn parses_git_progress_lines() {
        let p = parse_progress("Receiving objects:  45% (450/1000), 1.20 MiB | 1.00 MiB/s").unwrap();
        assert_eq!((p.phase.as_str(), p.percent), ("Receiving objects", Some(45)));
        let p = parse_progress("remote: Counting objects: 100% (5/5), done.").unwrap();
        assert_eq!((p.phase.as_str(), p.percent), ("Counting objects", Some(100)));
        let p = parse_progress("Fetching origin").unwrap();
        assert_eq!((p.phase.as_str(), p.percent), ("Fetching origin", None));
        assert!(parse_progress("From /tmp/origin").is_none());
        assert!(parse_progress(" * [new branch]      x -> origin/x").is_none());
        assert!(parse_progress("fatal: unable to access 'x': 50% nonsense").is_none(), "not a progress phase");
    }

    #[tokio::test]
    async fn fetch_reports_changes_and_emits_refs_updated_only_when_something_moved() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        push_from_elsewhere(&r, "from-elsewhere");
        assert_eq!(api.fetch(id, false).await.unwrap(), FetchOutcome::Done { changed: true });
        let kinds = drain(&mut rx);
        assert!(kinds.iter().any(|e| matches!(e, AppEvent::OpStarted { kind: crate::events::OpKind::Fetch, repo: Some(rid), label, .. } if *rid == id && label == "repo")));
        assert!(kinds.contains(&AppEvent::RefsUpdated { repo: id }));
        assert!(kinds.iter().any(|e| matches!(e, AppEvent::OpFinished { outcome: crate::events::OpOutcome::Ok, .. })));
        assert!(r.git(&["rev-parse", "--verify", "refs/remotes/origin/from-elsewhere"]).len() == 40);
        assert!(api.ops().get(1).is_none(), "the op is unregistered once it's done");

        assert_eq!(api.fetch(id, true).await.unwrap(), FetchOutcome::Done { changed: false });
        for ev in drain(&mut rx) {
            assert_ne!(ev, AppEvent::RefsUpdated { repo: id }, "nothing moved, so no refsUpdated");
        }
    }

    /// Amendment 2: fetch writes remote-tracking refs and objects, never the working tree, the
    /// index, local branches or config.
    #[tokio::test]
    async fn fetch_never_touches_the_worktree_index_local_branches_or_config() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.write("dirty.txt", "uncommitted\n");
        let api = api();
        let id = open(&api, &r).await;
        push_from_elsewhere(&r, "moved");
        let git_dir = r.path().join(".git");
        let snapshot = || {
            (
                r.git(&["for-each-ref", "refs/heads", "--format=%(refname) %(objectname)"]),
                std::fs::read(git_dir.join("HEAD")).unwrap(),
                std::fs::read(git_dir.join("index")).unwrap(),
                std::fs::read(git_dir.join("config")).unwrap(),
                r.git(&["status", "--porcelain=v1", "-uall"]),
            )
        };
        let before = snapshot();
        assert_eq!(api.fetch(id, true).await.unwrap(), FetchOutcome::Done { changed: true });
        assert_eq!(snapshot(), before);
    }

    /// K28: GitBolt's fetch never starts upkeep in the user's repo (`git maintenance run --auto`,
    /// which may gc). Seen through git's own trace: a plain fetch does spawn it.
    #[tokio::test]
    async fn fetch_never_starts_maintenance_or_gc() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["config", "gc.auto", "1"]);
        let trace = r.root().join("trace2.json");
        let mut env = isolated_git_env();
        env.push(("GIT_TRACE2_EVENT".into(), trace.clone().into_os_string()));
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(env), None);
        let id = open(&api, &r).await;
        push_from_elsewhere(&r, "lands");
        let spawned_maintenance = || std::fs::read_to_string(&trace).unwrap_or_default().lines().any(|l| l.contains("\"child_start\"") && l.contains("\"maintenance\""));
        let _ = std::fs::remove_file(&trace);
        assert_eq!(api.fetch(id, true).await.unwrap(), FetchOutcome::Done { changed: true });
        assert!(!spawned_maintenance(), "GitBolt's fetch started maintenance");
        let args = api.cli.log().entries().into_iter().find(|e| e.args.iter().any(|a| a == "fetch")).unwrap().args;
        assert!(args.contains(&"--no-auto-maintenance".to_string()) && args.contains(&"--no-write-commit-graph".to_string()), "{args:?}");
        // The check can see it: the same fetch without the flags does start it.
        let _ = std::fs::remove_file(&trace);
        let mut cmd = std::process::Command::new("git");
        cmd.current_dir(r.path()).args(["fetch", "-q", "origin"]).envs(isolated_git_env()).env("GIT_TRACE2_EVENT", &trace);
        assert!(cmd.status().unwrap().success());
        assert!(spawned_maintenance(), "a plain fetch starts maintenance, so the check above means something");
    }

    /// K30: `opStarted` says whether the op is the user's, so the UI can keep background ops out
    /// of sight (activity log only).
    #[tokio::test]
    async fn op_started_says_whether_the_op_is_interactive() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        api.fetch(id, true).await.unwrap();
        api.fetch(id, false).await.unwrap();
        let flags: Vec<bool> = drain(&mut rx).into_iter().filter_map(|e| match e { AppEvent::OpStarted { interactive, .. } => Some(interactive), _ => None }).collect();
        assert_eq!(flags, vec![false, true]);
    }

    #[tokio::test]
    async fn a_fetch_while_another_network_op_runs_is_skipped() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let h = api.handle(id).unwrap();
        let busy = h.net_lock.lock().await;
        assert_eq!(api.fetch(id, true).await.unwrap(), FetchOutcome::Skipped { reason: SkipReason::Busy });
        assert!(drain(&mut rx).is_empty(), "a skipped fetch never starts an op");
        drop(busy);
        assert!(matches!(api.fetch(id, true).await.unwrap(), FetchOutcome::Done { .. }));
    }

    #[tokio::test]
    async fn prune_setting_controls_prune() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        r.git_in(&r.root().join("origin.git"), &["branch", "-D", "feature/login"]);
        let mut s = api.store().state().settings;
        s.prune = false;
        api.store().save_settings(s.clone());
        api.fetch(id, false).await.unwrap();
        assert!(r.try_git(&["rev-parse", "--verify", "refs/remotes/origin/feature/login"]).is_ok(), "--no-prune keeps it");
        s.prune = true;
        api.store().save_settings(s);
        assert_eq!(api.fetch(id, false).await.unwrap(), FetchOutcome::Done { changed: true });
        assert!(r.try_git(&["rev-parse", "--verify", "refs/remotes/origin/feature/login"]).is_err(), "--prune removes it");
    }

    #[tokio::test]
    async fn a_failing_fetch_is_an_error_and_finishes_its_op_as_failed() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["remote", "add", "origin", r.root().join("missing.git").to_str().unwrap()]);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        assert!(api.fetch(id, true).await.is_err());
        assert!(drain(&mut rx).iter().any(|e| matches!(e, AppEvent::OpFinished { outcome: crate::events::OpOutcome::Failed, message: Some(_), .. })));
    }

    /// `scripts/fake-ssh` (K96): an ssh stand-in that fails like a dead agent, asks a passphrase
    /// through SSH_ASKPASS, or hangs.
    fn fake_ssh() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/fake-ssh").to_string()
    }

    /// Points the fixture's `origin` at an ssh URL served by `ssh_command` (its bare origin).
    fn ssh_origin(r: &TestRepo, ssh_command: &str) {
        let origin = r.root().join("origin.git");
        r.git(&["remote", "set-url", "origin", &format!("ssh://fake{}", origin.display())]);
        r.git(&["config", "core.sshCommand", ssh_command]);
        r.git(&["config", "ssh.variant", "simple"]);
    }

    /// K96: what ssh gets from a fetch: our askpass for every prompt (`SSH_ASKPASS_REQUIRE=force`,
    /// whatever DISPLAY says), git's askpass, git's own terminal prompt off, and no controlling
    /// terminal (its own session), so nothing can wait on a tty.
    #[tokio::test]
    async fn ssh_runs_with_our_askpass_forced_and_no_terminal() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let dump = r.root().join("ssh-env");
        let script = r.root().join("env-ssh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\n{{ env; echo SID=$(cut -d' ' -f6 /proc/$$/stat); }} > '{}'\necho \"$1: Permission denied (publickey).\" >&2\nexit 255\n", dump.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        ssh_origin(&r, script.to_str().unwrap());
        // No display at all: DISPLAY and WAYLAND_DISPLAY unset (not just empty), after everything else.
        let no_display: crate::git::CommandHook = Arc::new(|c| {
            c.env_remove("DISPLAY").env_remove("WAYLAND_DISPLAY");
        });
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()).with_command_hook(no_display), None);
        let dir = tempfile::tempdir().unwrap();
        api.start_askpass(dir.path(), "/bin/false".into()).await.unwrap();
        let id = open(&api, &r).await;
        let err = api.fetch(id, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::AuthFailed, "{err:?}");
        let seen = std::fs::read_to_string(&dump).unwrap();
        let get = |k: &str| seen.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).map(str::to_string);
        assert_eq!((get("DISPLAY"), get("WAYLAND_DISPLAY")), (None, None), "ssh sees no display");
        assert_eq!(get("SSH_ASKPASS").as_deref(), Some("/bin/false"));
        assert_eq!(get("GIT_ASKPASS").as_deref(), Some("/bin/false"));
        assert_eq!(get("SSH_ASKPASS_REQUIRE").as_deref(), Some("force"));
        assert_eq!(get("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert!(get(crate::askpass::ENV_OP).is_some_and(|op| op != "0"), "the prompt is tied to the fetch's op");
        // The session id comes from /proc (Linux only).
        #[cfg(target_os = "linux")]
        assert_ne!(get("SID"), Some(nix::unistd::getsid(None).unwrap().as_raw().to_string()), "ssh runs in its own session");
    }

    /// K96: a fetch whose ssh can't authenticate (the agent is gone) is an `AuthFailed` error
    /// carrying ssh's own line, even with several remotes (git prints "Fetching <remote>" first),
    /// and its op finishes as failed with that message, for the activity log.
    #[tokio::test]
    async fn a_dead_agent_fetch_fails_with_sshs_message() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        ssh_origin(&r, &format!("{} --dead-agent", fake_ssh()));
        let origin = r.root().join("origin.git");
        r.git(&["remote", "add", "second", &format!("ssh://fake{}", origin.display())]);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let err = api.fetch(id, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::AuthFailed, "{err:?}");
        assert_eq!(err.message, "fake: Permission denied (publickey).");
        let finished = drain(&mut rx).into_iter().find_map(|e| match e { AppEvent::OpFinished { outcome, message, .. } => Some((outcome, message)), _ => None });
        assert_eq!(finished, Some((crate::events::OpOutcome::Failed, Some("fake: Permission denied (publickey).".into()))));
    }

    /// K96 review: what a failed fetch carries to the toast (its error) and to the activity log
    /// (`opFinished`'s message) never has a URL's password, ssh included.
    #[tokio::test]
    async fn a_failed_fetchs_error_and_activity_message_are_redacted() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let script = r.root().join("leaky-ssh");
        std::fs::write(&script, "#!/bin/sh\necho \"fatal: repository 'ssh://ada:hunter2@fake/x' not found\" >&2\nexit 128\n").unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        ssh_origin(&r, script.to_str().unwrap());
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let err = api.fetch(id, false).await.unwrap_err();
        assert_eq!(err.message, "repository 'ssh://***@fake/x' not found");
        assert!(!err.stderr.unwrap_or_default().contains("hunter2"));
        let messages: Vec<String> = drain(&mut rx).into_iter().filter_map(|e| match e { AppEvent::OpFinished { message, .. } => message, _ => None }).collect();
        assert_eq!(messages, vec!["repository 'ssh://***@fake/x' not found".to_string()]);
    }

    /// K101: a finished fetch carries the git command that ran, and a credentialed URL in a clone's is redacted.
    #[tokio::test]
    async fn an_op_records_its_command_redacted() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        api.fetch(id, false).await.unwrap();
        let cmds: Vec<Option<String>> = drain(&mut rx).into_iter().filter_map(|e| match e { AppEvent::OpFinished { command, .. } => Some(command), _ => None }).collect();
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].as_deref().unwrap().starts_with("git fetch --all"), "{cmds:?}");
        let dest = r.root().join("clone-dest");
        let _ = api.clone_repo("ssh://ada:hunter2@127.0.0.1:1/x".into(), dest.to_str().unwrap().into()).await;
        let cmds: Vec<Option<String>> = drain(&mut rx).into_iter().filter_map(|e| match e { AppEvent::OpFinished { command, .. } => Some(command), _ => None }).collect();
        let c = cmds[0].clone().unwrap();
        assert!(c.starts_with("git clone") && !c.contains("hunter2"), "{c}");
    }

    /// K96: a fetch stuck on a remote that never answers runs until cancelled, and a cancel
    /// kills it (ssh included) at once.
    #[tokio::test]
    async fn a_stuck_fetch_is_cancelled() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        ssh_origin(&r, &format!("{} --hang", fake_ssh()));
        let api = Arc::new(api());
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let a2 = api.clone();
        let fetch = tokio::spawn(async move { a2.fetch(id, false).await });
        let op = loop {
            if let AppEvent::OpStarted { op, .. } = rx.recv().await.unwrap() {
                break op;
            }
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!fetch.is_finished(), "a stuck remote has no timeout of its own");
        api.ops().cancel(op);
        let err = tokio::time::timeout(std::time::Duration::from_secs(5), fetch).await.unwrap().unwrap().unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn clone_opens_the_new_repo_and_reports_progress() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let mut rx = api.subscribe();
        let dest = r.root().join("clones").join("fresh");
        let url = format!("file://{}", r.root().join("origin.git").display());
        let summary = api.clone_repo(url, dest.display().to_string()).await.unwrap();
        assert_eq!(summary.name, "fresh");
        assert!(dest.join(".git").is_dir());
        let events = drain(&mut rx);
        assert!(events.iter().any(|e| matches!(e, AppEvent::OpStarted { label, .. } if *label == dest.display().to_string())));
        assert!(events.iter().any(|e| matches!(e, AppEvent::OpProgress { .. })), "{events:?}");
        assert!(events.iter().any(|e| matches!(e, AppEvent::OpFinished { outcome: crate::events::OpOutcome::Ok, .. })));
        // An empty existing directory is fine too.
        let empty = r.root().join("empty");
        std::fs::create_dir(&empty).unwrap();
        let url = format!("file://{}", r.root().join("origin.git").display());
        assert_eq!(api.clone_repo(url, empty.display().to_string()).await.unwrap().name, "empty");
    }

    #[tokio::test]
    async fn clone_refuses_a_non_empty_destination_and_cleans_up_after_failure() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let busy = r.root().join("busy");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("keep.txt"), "mine").unwrap();
        let err = api.clone_repo("file:///nonexistent.git".into(), busy.display().to_string()).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
        assert!(busy.join("keep.txt").exists(), "never touches an existing directory");

        let fresh = r.root().join("will-fail");
        let err = api.clone_repo("file:///nonexistent/repo.git".into(), fresh.display().to_string()).await.unwrap_err();
        assert_ne!(err.kind, GbErrorKind::InvalidInput);
        assert!(!fresh.exists(), "a failed clone leaves nothing behind");
        // The folders it made on the way are removed too; an empty directory that was there stays.
        let deep = r.root().join("made").join("on").join("the-way");
        api.clone_repo("file:///nonexistent/repo.git".into(), deep.display().to_string()).await.unwrap_err();
        assert!(!r.root().join("made").exists(), "every folder the clone created is gone");
        let empty = r.root().join("was-empty");
        std::fs::create_dir(&empty).unwrap();
        api.clone_repo("file:///nonexistent/repo.git".into(), empty.display().to_string()).await.unwrap_err();
        assert!(empty.is_dir() && std::fs::read_dir(&empty).unwrap().next().is_none(), "an existing empty folder is kept, empty");

        // Only folders the clone made, and only while empty: another clone next to it survives.
        let shared = r.root().join("shared");
        let origin = format!("file://{}", r.root().join("origin.git").display());
        let (failed, ok) = tokio::join!(
            api.clone_repo("file:///nonexistent/repo.git".into(), shared.join("fails").display().to_string()),
            api.clone_repo(origin, shared.join("works").display().to_string()),
        );
        assert!(failed.is_err());
        let ok = ok.unwrap_or_else(|e| panic!("the concurrent clone failed: {e:?}"));
        assert!(shared.join("works/.git").is_dir(), "the concurrent clone's folder survives the other's cleanup: {ok:?}");
        assert!(!shared.join("fails").exists());

        assert_eq!(api.clone_repo("u".into(), "relative/path".into()).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        let file = r.root().join("a-file");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(api.clone_repo("u".into(), file.display().to_string()).await.unwrap_err().kind, GbErrorKind::InvalidInput);
    }

    /// The cleanup removes the clone's own folder, then only the (now empty) folders it created
    /// on the way: a file or another clone that appeared under one of them meanwhile survives.
    #[test]
    fn a_failed_clones_cleanup_spares_what_others_put_in_its_folders() {
        let root = tempfile::tempdir().unwrap();
        let top = root.path().join("made");
        let dest = top.join("on").join("the-way");
        std::fs::create_dir_all(dest.join("partial/.git")).unwrap();
        std::fs::write(top.join("user.txt"), "mine").unwrap();
        std::fs::create_dir_all(top.join("on").join("sibling-clone")).unwrap();
        remove_failed_clone(&dest, Some(&top));
        assert!(!dest.exists());
        assert!(top.join("user.txt").exists(), "a user's file is kept");
        assert!(top.join("on/sibling-clone").is_dir(), "a sibling clone is kept");
        // With nothing else there, every folder it made goes.
        std::fs::remove_dir_all(top.join("on/sibling-clone")).unwrap();
        std::fs::remove_file(top.join("user.txt")).unwrap();
        std::fs::create_dir_all(dest.join("x")).unwrap();
        remove_failed_clone(&dest, Some(&top));
        assert!(!top.exists());
        assert!(root.path().is_dir(), "never above what it made");
        // An empty folder that was already there is emptied, not removed.
        let existing = root.path().join("existing");
        std::fs::create_dir_all(existing.join("partial")).unwrap();
        std::fs::write(existing.join("f"), "x").unwrap();
        remove_failed_clone(&existing, None);
        assert!(existing.is_dir() && std::fs::read_dir(&existing).unwrap().next().is_none());
    }

    /// `ext::` runs an arbitrary command; fetch and clone refuse it even where config allows it.
    #[tokio::test]
    async fn the_ext_transport_is_never_allowed() {
        let r = TestRepo::new();
        r.commit("a");
        let mut env = isolated_git_env();
        env.extend([("GIT_CONFIG_COUNT".into(), "1".into()), ("GIT_CONFIG_KEY_0".into(), "protocol.ext.allow".into()), ("GIT_CONFIG_VALUE_0".into(), "always".into())]);
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(env), None);
        let marker = r.root().join("ran");
        let url = format!("ext::sh -c touch% {}", marker.display());
        r.git(&["remote", "add", "evil", &url]);
        let id = open(&api, &r).await;
        assert!(api.fetch(id, false).await.is_err());
        assert!(api.clone_repo(url, r.root().join("clone").display().to_string()).await.is_err());
        assert!(!marker.exists(), "the ext:: command never ran");
    }
}
