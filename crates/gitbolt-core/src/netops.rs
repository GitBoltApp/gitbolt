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
use gix::bstr::ByteSlice;
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
    /// The action queue is busy, or a user op cancelled this background fetch.
    Busy,
    /// A GitBolt-started fetch needed credentials; the next user-started op prompts.
    AuthRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum FetchOutcome {
    Done {
        changed: bool,
        /// Its `remote:` lines, counted for the toast (spec #2 §12.4).
        server: crate::write::remote_output::RemoteSummary,
        /// The op, so the toast's "Server output" link opens its Activity entry.
        #[ts(type = "number")]
        op: u64,
    },
    Skipped { reason: SkipReason },
}

/// The host of a git URL or scp-like address, without any userinfo (a token never reaches a reason).
fn url_host(url: &str) -> Option<String> {
    if crate::remotes::is_local_on_windows(url) {
        return None;
    }
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("");
    (!host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))).then(|| host.to_string())
}

/// A short plain reason for one remote's stderr block.
fn fetch_reason(block: &str) -> String {
    use crate::error::{classify_stderr, GbErrorKind};
    if classify_stderr(block) == GbErrorKind::AuthFailed {
        return "authentication failed".into();
    }
    if block.contains("does not appear to be a git repository") || block.contains("not found") {
        return "repository not found".into();
    }
    let host = block.lines().find_map(|l| {
        if let Some(h) = l.split("Could not resolve host: ").nth(1).or_else(|| l.split("Could not resolve hostname ").nth(1)) {
            return url_host(h.split([':', ' ']).next().unwrap_or(""));
        }
        let u = l.split("unable to access '").nth(1)?.split('\'').next()?;
        url_host(u)
    });
    match host {
        Some(h) => format!("couldn't reach {h}"),
        None => "couldn't reach the remote".into(),
    }
}

/// The remotes a `git fetch --all` reported failing (`error: Could not fetch <name>`), each with
/// the reason from the stderr since its `Fetching <name>` line.
pub(crate) fn failed_remotes(stderr: &str) -> Vec<crate::error::FailedRemote> {
    let mut out = Vec::new();
    let mut block = String::new();
    for l in stderr.lines() {
        if l.starts_with("Fetching ") {
            block.clear();
        } else if let Some(name) = l.strip_prefix("error: Could not fetch ").or_else(|| l.strip_prefix("error: could not fetch ")) {
            out.push(crate::error::FailedRemote { name: name.trim().to_string(), reason: fetch_reason(&block) });
            block.clear();
        } else {
            block.push_str(l);
            block.push('\n');
        }
    }
    out
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

pub(crate) async fn ref_state_async(repo: gix::ThreadSafeRepository) -> Result<BTreeMap<String, String>, GbError> {
    tokio::task::spawn_blocking(move || ref_state(&repo)).await.map_err(|e| GbError::other(format!("ref snapshot failed: {e}")))?
}

/// Forwards progress lines as `opProgress` events, only when the phase or percent changes,
/// until the sender is dropped.
fn forward_progress(bus: EventBus, op: OpId) -> (mpsc::UnboundedSender<String>, tokio::task::JoinHandle<()>) {
    forward_progress_to(bus, op, None)
}

// --- 2D T14: pull's fetch ---
/// `forward_progress`, also passing every line on to `also` (a write's Activity output).
pub(crate) fn forward_progress_to(bus: EventBus, op: OpId, also: Option<mpsc::UnboundedSender<String>>) -> (mpsc::UnboundedSender<String>, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let task = tokio::spawn(async move {
        let mut last: Option<(String, Option<u8>)> = None;
        while let Some(line) = rx.recv().await {
            let progress = parse_progress(&line);
            if let Some(out) = &also {
                let _ = out.send(line);
            }
            if let Some(p) = progress {
                let key = (p.phase.clone(), p.percent);
                if last.as_ref() != Some(&key) {
                    bus.emit(AppEvent::OpProgress { op, phase: p.phase, percent: p.percent, step: None });
                    last = Some(key);
                }
            }
        }
    });
    (tx, task)
}
// --- end 2D T14 ---

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
/// reported as cancelled. Only an auth error (2D T14 re-review m2): a later failure (a second key
/// authenticated, then the push was rejected) shows as itself.
pub(crate) fn user_cancelled(e: GbError, op: &OpEntry) -> GbError {
    if prompt_dismissed(&e, op) {
        GbError { kind: GbErrorKind::Cancelled, message: "Cancelled".into(), ..e }
    } else {
        e
    }
}

/// `e` is the auth failure of a credential prompt the user dismissed.
fn prompt_dismissed(e: &GbError, op: &OpEntry) -> bool {
    e.kind == GbErrorKind::AuthFailed && op.prompt_cancelled()
}

/// Never the `ext::` transport (it runs an arbitrary command), whatever the config says.
pub(crate) const NO_EXT: [&str; 2] = ["-c", "protocol.ext.allow=never"];


/// The command as the activity log shows it (K101): `git` and its argv (no environment), through
/// the redactor so a URL's credentials never reach the log.
fn display_command(args: &[&str]) -> String {
    crate::redact::redact(&format!("git {}", args.join(" ")))
}

impl Api {
    /// `git fetch --all` for repo `id` (spec §15), with git's own upkeep after it, as a plain `git fetch` (`git maintenance run --auto` repacks only when
    /// git decides to; without it every fetch left one more pack behind; the user's call, 2026-10-05, over K28's
    /// hands-off rule). `background` fetches are GitBolt-started: they
    /// never prompt, and a credential prompt makes them `skipped: authRequired`.
    ///
    /// Not behind the harness's write guard (§17.2), like a clone (2A final M2): neither touches
    /// the worktree, the index or a local branch (a fetch writes remote-tracking refs, a clone
    /// only a folder of its own), and the e2e specs open and clone repositories outside the
    /// marked fixture root.
    #[cfg(test)] // the dispatch calls `fetch_remote`; tests keep the short form
    pub(crate) async fn fetch(&self, id: u32, background: bool) -> Result<FetchOutcome, GbError> {
        self.fetch_remote(id, background, None, None).await
    }

    /// `fetch`, of `remote` only when given (a remote just added, spec #4 §4 4A), else `--all`.
    pub(crate) async fn fetch_remote(&self, id: u32, background: bool, remote: Option<String>, mr_head: Option<crate::forge::MrHead>) -> Result<FetchOutcome, GbError> {
        let h = self.handle(id)?;
        // MR round 2: an MR/PR's head is fetched from a named remote only.
        let refspec = match (&remote, mr_head) {
            (Some(r), Some(m)) => Some(m.refspec(r)),
            (None, Some(_)) => return Err(GbError::new(GbErrorKind::InvalidInput, "Fetching a merge request's head needs its remote")),
            _ => None,
        };
        // --- 4A T7 ---
        if let Some(r) = &remote {
            // A fresh read of the config: a remote added outside GitBolt counts too.
            let fresh = gix::open(&h.workdir).map_err(gix_err)?;
            let known = fresh.remote_names().into_iter().any(|n| n.to_str_lossy() == r.as_str());
            if !known {
                return Err(GbError::new(GbErrorKind::NotFound, format!("No remote {r}")));
            }
        }
        // --- end 4A T7 ---
        let writes = self.repo_writes(&h);
        let op = self.ops.begin(OpKind::Fetch, Some(id), !background);
        // Spec #2 §3.6. A background fetch isn't a queue item: it runs only when the queue is
        // idle, and a user op cancels it. A user's fetch is one (Deviation 8): it holds the
        // running slot, never the write lock.
        let (_background, slot) = if background {
            match writes.queue.try_background(op.cancel.clone()) {
                Some(bg) => (Some(bg), None),
                None => return Ok(FetchOutcome::Skipped { reason: SkipReason::Busy }),
            }
        } else {
            // Cancelled while it waits (`cancelOp`, or the queue's ×), it leaves the queue at
            // once: `Cancelled`, which the UI keeps quiet, with no op started.
            let ticket = writes.queue.enqueue(&format!("fetch {}", h.name), OpKind::Fetch, op.id).cancel_on(op.cancel.clone());
            (None, Some(writes.queue.turn(ticket).await?))
        };
        self.bus.emit(AppEvent::OpStarted { op: op.id, kind: OpKind::Fetch, repo: Some(id), label: h.name.clone(), interactive: op.interactive });
        let mut command = None;
        let res = async {
            let before = ref_state_async(h.repo.clone()).await?;
            let prune = if self.store.state().settings.prune { "--prune" } else { "--no-prune" };
            let (tx, progress) = forward_progress(self.bus.clone(), op.id);
            // A background fetch leaves FETCH_HEAD alone: a `git fetch <remote> <branch>` the user
            // ran by hand (then `git merge FETCH_HEAD`) isn't replaced behind their back, and a
            // failed background fetch doesn't empty it (git ≥ 2.29; the minimum is 2.40).
            let fetch_head = background.then_some("--no-write-fetch-head");
            // 4A T7: one remote (named last, after the options), or every remote.
            let target: Vec<&str> = match &remote { Some(r) => ["--end-of-options", r.as_str()].into_iter().chain(refspec.as_deref()).collect(), None => vec!["--all"] };
            let args: Vec<&str> = ["fetch", prune, "--no-prune-tags"].into_iter().chain(fetch_head).chain(["--progress"]).chain(target).collect();
            command = Some(display_command(&args));
            let inv = GitInvocation::new(&h.workdir, NO_EXT.into_iter().chain(args))
                .timeout(None)
                .cancel(op.cancel.clone())
                .detach_terminal()
                .stream_stderr(tx)
                .envs(self.net_env(op.id))
                .env("GIT_NO_LAZY_FETCH", "0") // a network op may lazy-fetch (a clone's checkout needs it)
                // Every queued user op cancels a background fetch (spec #2 §3.6): SIGTERM first,
                // so git drops its ref locks rather than leaving them for the next fetch.
                .term_grace(crate::git::WRITE_TERM_GRACE);
            let mut out = self.cli.run(inv).await;
            let _ = progress.await;
            let server = crate::write::remote_output::capture(self, op.id, &mut out);
            out?;
            Ok::<(bool, _), GbError>((ref_state_async(h.repo.clone()).await? != before, server))
        }
        .await;
        let (outcome, result) = match res {
            Ok((changed, server)) => {
                if changed {
                    self.bus.emit(AppEvent::RefsUpdated { repo: id });
                }
                (OpOutcome::Ok, Ok(FetchOutcome::Done { changed, server, op: op.id }))
            }
            // Cancelled by a user op (spec #2 §3.6): the next interval retries; nothing to show.
            // Any other cancel of a background fetch (no UI offers one: it shows nowhere, K30)
            // reports the same, since the token can't tell who cancelled it.
            Err(e) if background && e.kind == GbErrorKind::Cancelled && !op.prompt_cancelled() => (OpOutcome::Skipped, Ok(FetchOutcome::Skipped { reason: SkipReason::Busy })),
            Err(e) if e.kind == GbErrorKind::Cancelled || prompt_dismissed(&e, &op) => (OpOutcome::Cancelled, Err(user_cancelled(e, &op))),
            Err(_) if op.auth_denied() => (OpOutcome::Skipped, Ok(FetchOutcome::Skipped { reason: SkipReason::AuthRequired })),
            Err(e) => {
                let remotes = e.stderr.as_deref().map(failed_remotes).unwrap_or_default();
                (OpOutcome::Failed, Err(if remotes.is_empty() { e } else { e.with_detail(crate::error::ErrorDetail::FetchFailed { remotes }) }))
            }
        };
        let message = result.as_ref().err().map(|e| e.message.clone());
        self.bus.emit(AppEvent::OpFinished { op: op.id, kind: OpKind::Fetch, repo: Some(id), outcome, message, command });
        if let Some(slot) = slot {
            slot.finish(result.as_ref().err(), &[]);
        }
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
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{dest} already exists and isn't an empty directory")));
        }
        let parent = dest_path.parent().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "The destination has no parent directory"))?;
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
            .env("GIT_NO_LAZY_FETCH", "0") // a network op may lazy-fetch (a clone's checkout needs it)
            .term_grace(crate::git::WRITE_TERM_GRACE); // git removes its own junk on SIGTERM
        let res = self.cli.run(inv).await;
        let _ = progress.await;
        let (outcome, message) = match &res {
            Ok(_) => (OpOutcome::Ok, None),
            Err(e) if e.kind == GbErrorKind::Cancelled || prompt_dismissed(e, &op) => (OpOutcome::Cancelled, Some("Cancelled".to_string())),
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
    use std::time::Duration;

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

    /// 2D T14 re-review m2: a dismissed prompt makes only the auth failure a Cancel; a later
    /// rejection (another key authenticated) shows as itself.
    #[test]
    fn only_an_auth_failure_after_a_dismissed_prompt_is_cancelled() {
        let api = api();
        let op = api.ops.begin(OpKind::Push, None, true);
        let auth = || GbError::new(GbErrorKind::AuthFailed, "Authentication failed");
        assert_eq!(user_cancelled(auth(), &op).kind, GbErrorKind::AuthFailed, "no prompt was dismissed");
        op.note_prompt_cancelled();
        assert_eq!(user_cancelled(auth(), &op).kind, GbErrorKind::Cancelled);
        assert_eq!(user_cancelled(GbError::new(GbErrorKind::NonFastForward, "rejected"), &op).kind, GbErrorKind::NonFastForward);
        assert_eq!(user_cancelled(GbError::new(GbErrorKind::HookFailed, "pre-receive"), &op).kind, GbErrorKind::HookFailed);
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

    // --- MR round 2 ---
    #[tokio::test]
    async fn an_mr_head_is_fetched_into_a_remote_tracking_ref_of_its_own() {
        use crate::forge::{ForgeKind, MrHead};
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        push_from_elsewhere(&r, "mr-work");
        let other = r.root().join("other-mr-work");
        r.git_in(&other, &["push", "-q", "origin", "HEAD:refs/merge-requests/7/head", "HEAD:refs/pull/8/head"]);
        r.git_in(&other, &["push", "-q", "origin", "--delete", "mr-work"]);
        let head = r.git_in(&other, &["rev-parse", "HEAD"]);
        let gitlab = MrHead { kind: ForgeKind::GitLab, number: 7 };
        api.fetch_remote(id, false, Some("origin".into()), Some(gitlab)).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "refs/remotes/origin/mr/7"]), head);
        api.fetch_remote(id, false, Some("origin".into()), Some(MrHead { kind: ForgeKind::GitHub, number: 8 })).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "refs/remotes/origin/pr/8"]), head);
        let e = api.fetch_remote(id, false, None, Some(gitlab)).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
    }
    // --- end MR round 2 ---

    #[tokio::test]
    async fn fetch_reports_changes_and_emits_refs_updated_only_when_something_moved() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        push_from_elsewhere(&r, "from-elsewhere");
        let out = api.fetch(id, false).await.unwrap();
        assert!(matches!(out, FetchOutcome::Done { changed: true, .. }), "{out:?}");
        let kinds = drain(&mut rx);
        assert!(kinds.iter().any(|e| matches!(e, AppEvent::OpStarted { kind: crate::events::OpKind::Fetch, repo: Some(rid), label, .. } if *rid == id && label == "repo")));
        assert!(kinds.contains(&AppEvent::RefsUpdated { repo: id }));
        assert!(kinds.iter().any(|e| matches!(e, AppEvent::OpFinished { outcome: crate::events::OpOutcome::Ok, .. })));
        assert!(r.git(&["rev-parse", "--verify", "refs/remotes/origin/from-elsewhere"]).len() == 40);
        assert!(api.ops().get(1).is_none(), "the op is unregistered once it's done");

        let out = api.fetch(id, true).await.unwrap();
        assert!(matches!(out, FetchOutcome::Done { changed: false, .. }), "{out:?}");
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
        let out = api.fetch(id, true).await.unwrap();
        assert!(matches!(out, FetchOutcome::Done { changed: true, .. }), "{out:?}");
        assert_eq!(snapshot(), before);
    }

    /// GitBolt's fetch runs git's own upkeep, as a plain fetch does (`git maintenance run --auto`,
    /// which may gc), so packs don't pile up. Seen through git's own trace.
    #[tokio::test]
    async fn fetch_runs_gits_own_maintenance() {
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
        let out = api.fetch(id, true).await.unwrap();
        assert!(matches!(out, FetchOutcome::Done { changed: true, .. }), "{out:?}");
        assert!(spawned_maintenance(), "GitBolt's fetch runs git's auto maintenance");
        let args = api.cli.log().entries().into_iter().find(|e| e.args.iter().any(|a| a == "fetch")).unwrap().args;
        assert!(!args.contains(&"--no-auto-maintenance".to_string()) && !args.contains(&"--no-write-commit-graph".to_string()), "{args:?}");
        assert!(args.contains(&"--no-write-fetch-head".to_string()), "a background fetch leaves FETCH_HEAD alone: {args:?}");
        assert!(!r.path().join(".git/FETCH_HEAD").exists(), "no FETCH_HEAD written by a background fetch");
    }

    #[test]
    fn failed_remotes_name_each_failing_remote_with_a_short_reason() {
        let err = "Fetching a\nfatal: unable to access 'https://tok:sekrit@git.example.com/x.git/': Could not resolve host: git.example.com\nerror: Could not fetch a\nFetching ok\nFetching b\nfatal: Authentication failed for 'https://h/x.git/'\nerror: Could not fetch b\n";
        let got = failed_remotes(err);
        assert_eq!(got.iter().map(|f| (f.name.as_str(), f.reason.as_str())).collect::<Vec<_>>(), [("a", "couldn't reach git.example.com"), ("b", "authentication failed")]);
        assert!(!format!("{got:?}").contains("sekrit"));
    }

    /// A remote that can't be reached fails the fetch with its name; the others still fetch.
    #[tokio::test]
    async fn a_failing_remote_is_named_in_the_error() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["remote", "add", "gone", r.root().join("nope.git").to_str().unwrap()]);
        let api = api();
        let id = open(&api, &r).await;
        let e = api.fetch(id, false).await.unwrap_err();
        assert!(matches!(&e.detail, Some(crate::error::ErrorDetail::FetchFailed { remotes }) if remotes.len() == 1 && remotes[0].name == "gone"), "{e:?}");
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
    async fn a_background_fetch_is_skipped_while_the_queue_is_busy() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let w = api.repo_writes(&api.handle(id).unwrap());
        let slot = w.queue.turn(w.queue.enqueue("commit", OpKind::Commit, 99)).await.unwrap();
        drain(&mut rx);
        assert_eq!(api.fetch(id, true).await.unwrap(), FetchOutcome::Skipped { reason: SkipReason::Busy });
        assert!(drain(&mut rx).is_empty(), "a skipped fetch never starts an op");
        slot.finish(None, &[]);
        assert!(matches!(api.fetch(id, true).await.unwrap(), FetchOutcome::Done { .. }));
    }

    /// Spec #2 §3.6: enqueuing a user op cancels a running background fetch, silently.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_user_op_cancels_a_running_background_fetch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["remote", "set-url", "origin", "ssh://fake/never.git"]);
        // The stand-in ssh marks that the fetch's transfer is running, then hangs.
        let started = r.root().join("ssh-started");
        r.git(&["config", "core.sshCommand", &format!("touch '{}'; sleep 10; false", crate::platform::fs::to_git_path(&started))]);
        let api = Arc::new(api());
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        let a2 = api.clone();
        let fetch = tokio::spawn(async move { a2.fetch(id, true).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the background fetch is running");
        let w = api.repo_writes(&api.handle(id).unwrap());
        let ticket = w.queue.enqueue("commit", OpKind::Commit, 99);
        let out = tokio::time::timeout(Duration::from_secs(3), fetch).await.expect("cancelled promptly").unwrap().unwrap();
        assert_eq!(out, FetchOutcome::Skipped { reason: SkipReason::Busy });
        let finished: Vec<OpOutcome> = drain(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                AppEvent::OpFinished { outcome, .. } => Some(outcome),
                _ => None,
            })
            .collect();
        assert_eq!(finished, [OpOutcome::Skipped]);
        w.queue.turn(ticket).await.unwrap().finish(None, &[]);
    }

    /// 2A final review I1: the cancel a user op sends a background fetch is a write's (SIGTERM,
    /// then SIGKILL), so a fetch stopped inside its ref transaction leaves no `.lock` behind.
    #[cfg(unix)] // SIGTERM (Windows kills git, which can leave a .lock)
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_fetch_leaves_no_ref_lock_behind() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        push_from_elsewhere(&r, "fresh");
        // The hook runs while git holds the ref locks ("prepared"): it marks that, then hangs.
        let hooks = r.root().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let started = r.root().join("tx-prepared");
        let hook = hooks.join("reference-transaction");
        std::fs::write(&hook, format!("#!/bin/sh\nif [ \"$1\" = prepared ]; then touch '{}'; sleep 30; fi\nexit 0\n", crate::platform::fs::to_git_path(&started))).unwrap();
        crate::platform::fs::set_mode(&hook, 0o755).unwrap();
        r.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
        let api = Arc::new(api());
        let id = open(&api, &r).await;
        let a2 = api.clone();
        let fetch = tokio::spawn(async move { a2.fetch(id, true).await });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the fetch reached its ref transaction");
        let locks = |dir: &std::path::Path| -> Vec<std::path::PathBuf> {
            let mut out = Vec::new();
            let mut stack = vec![dir.to_path_buf()];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().is_some_and(|x| x == "lock") {
                        out.push(p);
                    }
                }
            }
            out
        };
        let git_dir = r.path().join(".git");
        assert!(!locks(&git_dir).is_empty(), "the hook runs with the ref locks held");
        let w = api.repo_writes(&api.handle(id).unwrap());
        let ticket = w.queue.enqueue("commit", OpKind::Commit, 99);
        let out = tokio::time::timeout(Duration::from_secs(5), fetch).await.expect("stopped within the grace").unwrap().unwrap();
        assert_eq!(out, FetchOutcome::Skipped { reason: SkipReason::Busy });
        assert_eq!(locks(&git_dir), Vec::<std::path::PathBuf>::new(), "git removed its locks on SIGTERM");
        w.queue.turn(ticket).await.unwrap().finish(None, &[]);
    }

    /// A user's fetch cancelled while it waits leaves the queue at once, quietly: no op starts,
    /// and the running item and the later ones carry on.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_queued_fetch_cancelled_before_its_turn_leaves_the_queue_at_once() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = Arc::new(api());
        let id = open(&api, &r).await;
        let w = api.repo_writes(&api.handle(id).unwrap());
        let running = w.queue.turn(w.queue.enqueue("commit", OpKind::Commit, 99)).await.unwrap();
        let mut rx = api.subscribe();
        let a2 = api.clone();
        let fetch = tokio::spawn(async move { a2.fetch(id, false).await });
        let op = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(i) = w.queue.state().queued.first() {
                    return i.op;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the fetch is queued");
        let later = w.queue.enqueue("later", OpKind::Commit, 100);
        let cancel = serde_json::from_value::<Request>(serde_json::json!({"method": "cancelOp", "params": {"op": op}})).unwrap();
        api.dispatch(cancel).await.unwrap();
        let err = tokio::time::timeout(Duration::from_secs(3), fetch).await.expect("no waiting for the running op").unwrap().unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled);
        let s = w.queue.state();
        assert_eq!(s.queued.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["later"], "the fetch is gone");
        assert_eq!(s.running.map(|i| i.op), Some(99), "the running op carries on");
        assert!(s.stopped.is_none(), "the queue doesn't stop");
        assert!(!drain(&mut rx).iter().any(|e| matches!(e, AppEvent::OpStarted { .. } | AppEvent::OpFinished { .. })), "no op started");
        running.finish(None, &[]);
        w.queue.turn(later).await.unwrap().finish(None, &[]);
    }

    #[tokio::test]
    async fn a_users_fetch_is_a_queue_item() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let mut rx = api.subscribe();
        api.fetch(id, false).await.unwrap();
        let queued: Vec<String> = drain(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                AppEvent::QueueChanged { queued, .. } => queued.first().map(|i| i.label.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(queued.first().map(String::as_str), Some("fetch repo"));
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
        let out = api.fetch(id, false).await.unwrap();
        assert!(matches!(out, FetchOutcome::Done { changed: true, .. }), "{out:?}");
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

    /// A user's fetch that fails with nothing queued behind it leaves the queue open: no
    /// "Stopped" chip, and the retry runs at once.
    #[tokio::test]
    async fn a_failed_users_fetch_with_nothing_queued_doesnt_stop_the_queue() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["remote", "add", "origin", r.root().join("missing.git").to_str().unwrap()]);
        let api = api();
        let id = open(&api, &r).await;
        assert!(api.fetch(id, false).await.is_err());
        let w = api.repo_writes(&api.handle(id).unwrap());
        assert_eq!(w.queue.state(), crate::write::types::QueueStatePayload::default());
        let retry = tokio::time::timeout(Duration::from_secs(10), api.fetch(id, false)).await.expect("the retry runs at once");
        assert!(retry.is_err(), "and fails the same way");
    }

    /// `scripts/fake-ssh` (K96): an ssh stand-in that fails like a dead agent, asks a passphrase
    /// through SSH_ASKPASS, or hangs.
    fn fake_ssh() -> String {
        crate::platform::fs::to_git_path(concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/fake-ssh"))
    }

    /// `ssh://fake/<path>`: `/abs/path` on Unix, `/C:/abs/path` on Windows.
    fn ssh_url(path: &Path) -> String {
        let p = crate::platform::fs::to_git_path(path);
        if p.starts_with('/') { format!("ssh://fake{p}") } else { format!("ssh://fake/{p}") }
    }

    /// Points the fixture's `origin` at an ssh URL served by `ssh_command` (its bare origin).
    fn ssh_origin(r: &TestRepo, ssh_command: &str) {
        let origin = r.root().join("origin.git");
        r.git(&["remote", "set-url", "origin", &ssh_url(&origin)]);
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
            format!("#!/bin/sh\n{{ env; echo SID=$(cut -d' ' -f6 /proc/$$/stat); }} > '{}'\necho \"$1: Permission denied (publickey).\" >&2\nexit 255\n", crate::platform::fs::to_git_path(&dump)),
        )
        .unwrap();
        crate::platform::fs::set_mode(&script, 0o755).unwrap();
        ssh_origin(&r, &crate::platform::fs::to_git_path(&script));
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
        r.git(&["remote", "add", "second", &ssh_url(&origin)]);
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
        crate::platform::fs::set_mode(&script, 0o755).unwrap();
        ssh_origin(&r, &crate::platform::fs::to_git_path(&script));
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
        assert!(cmds[0].as_deref().unwrap().starts_with("git fetch --prune"), "{cmds:?}");
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
        let url = format!("ext::sh -c touch% {}", crate::platform::fs::to_git_path(&marker));
        r.git(&["remote", "add", "evil", &url]);
        let id = open(&api, &r).await;
        assert!(api.fetch(id, false).await.is_err());
        assert!(api.clone_repo(url, r.root().join("clone").display().to_string()).await.is_err());
        assert!(!marker.exists(), "the ext:: command never ran");
    }

    /// Spec #2 §12.4: a plain fetch's server lines are only git's pack meters: stored, not counted.
    #[tokio::test]
    async fn a_plain_fetch_counts_no_server_output() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        push_from_elsewhere(&r, "more");
        match api.fetch(id, false).await.unwrap() {
            FetchOutcome::Done { changed: true, server, op } => {
                assert_eq!(server, crate::write::remote_output::RemoteSummary::default());
                assert!(op > 0);
            }
            other => panic!("{other:?}"),
        }
    }

    /// The graph's rows, as the UI's refresh asks for them.
    async fn graph_rows(api: &Api, id: u32) -> Vec<serde_json::Value> {
        let g = api.dispatch(serde_json::from_value::<Request>(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}})).unwrap()).await.unwrap();
        g["rows"].as_array().unwrap().clone()
    }

    fn row_ids(rows: &[serde_json::Value]) -> std::collections::HashSet<&str> {
        rows.iter().filter_map(|row| row["id"].as_str()).collect()
    }

    /// A commit of a new file (`f<n>.txt`) in the clone `dir`; its id.
    fn commit_new_file(r: &TestRepo, dir: &Path, n: usize, msg: &str) -> String {
        std::fs::write(dir.join(format!("f{n}.txt")), msg).unwrap();
        r.git_in(dir, &["add", "-A"]);
        r.git_in(dir, &["commit", "-q", "-m", msg]);
        r.git_in(dir, &["rev-parse", "HEAD"])
    }

    /// The live graph after many fetches (the missing `origin/integration` and the dangling
    /// `origin/dev` lane): the repository opened once, then a busy repository's fetches each
    /// add a pack. Every fetched commit must reach the refreshed graph, connected to its
    /// parents: a remote branch whose tip is new (with a local branch of the same name further
    /// back), and one whose tip came loose while its parents came in packs. A leftover
    /// `tmp_pack_*` from an interrupted fetch sits in the pack directory throughout.
    #[tokio::test]
    async fn every_fetched_commit_reaches_the_live_graph_however_many_packs_arrive() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        // Every fetch writes a pack, as one bringing more than 100 objects does.
        r.git(&["config", "fetch.unpackLimit", "1"]);
        std::fs::write(r.path().join(".git/objects/pack/tmp_pack_q3aTdj"), b"interrupted").unwrap();
        r.git(&["branch", "integration", "main~1"]);
        let api = api();
        let id = open(&api, &r).await;
        let graph = || graph_rows(&api, id);
        graph().await;
        let other = r.clone_origin("elsewhere");
        let n = std::cell::Cell::new(0);
        let commit = |msg: &str| {
            n.set(n.get() + 1);
            commit_new_file(&r, &other, n.get(), msg)
        };
        r.git_in(&other, &["switch", "-q", "-c", "integration"]);
        for i in 0..40 {
            commit(&format!("integration {i}"));
            r.git_in(&other, &["push", "-q", "origin", "integration"]);
            api.fetch(id, true).await.unwrap();
            graph().await; // the refresh that follows each fetch's refsUpdated
        }
        let integration = r.git(&["rev-parse", "origin/integration"]);
        // dev: a grandparent and a parent in a pack, then the tip alone, loose.
        r.git_in(&other, &["switch", "-q", "-c", "dev", "origin/main"]);
        let grandparent = commit("dev grandparent");
        let parent = commit("dev parent");
        r.git_in(&other, &["push", "-q", "origin", "dev"]);
        api.fetch(id, true).await.unwrap();
        graph().await;
        r.git(&["config", "fetch.unpackLimit", "1000"]);
        let tip = commit("dev tip");
        r.git_in(&other, &["push", "-q", "origin", "dev"]);
        api.fetch(id, true).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "origin/dev"]), tip);

        let rows = graph().await;
        let ids = row_ids(&rows);
        for (c, what) in [(&tip, "tip"), (&parent, "parent"), (&grandparent, "grandparent")] {
            assert!(ids.contains(c.as_str()), "origin/dev's {what} {c} is in the graph");
        }
        assert!(ids.contains(integration.as_str()), "origin/integration's tip {integration} is in the graph");
        // Down to the old history: every commit's parents are rows (no lane runs into the void).
        for row in rows.iter().filter(|row| row["kind"] != "wip") {
            for p in row["parents"].as_array().unwrap() {
                assert!(ids.contains(p.as_str().unwrap()), "{}'s parent {p} is in the graph", row["summary"]);
            }
        }
    }

    /// A handle whose object store runs short of index slots is replaced before it hides a
    /// pack: here one opened with 8 slots, then 12 fetches that each add a pack, each followed
    /// by the graph's refresh, which must show the fetched tip every time.
    #[tokio::test]
    async fn a_handle_short_of_object_store_slots_is_reopened() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["config", "fetch.unpackLimit", "1"]);
        let api = api();
        let id = open(&api, &r).await;
        {
            let mut repos = api.repos.lock().unwrap();
            let h = repos[&id].clone();
            let few = gix::open::Options::default().object_store_slots(gix::odb::store::init::Slots::Given(8));
            let repo = gix::ThreadSafeRepository::open_opts(&h.workdir, few).unwrap();
            let short = crate::api::RepoHandle { repo, workdir: h.workdir.clone(), name: h.name.clone(), common_dir: h.common_dir.clone(), wip: h.wip.clone(), snapshot: Default::default(), walk: Default::default() };
            repos.insert(id, Arc::new(short));
        }
        let other = r.clone_origin("elsewhere");
        r.git_in(&other, &["switch", "-q", "-c", "busy"]);
        for i in 0..12 {
            let tip = commit_new_file(&r, &other, i, &format!("busy {i}"));
            r.git_in(&other, &["push", "-q", "origin", "busy"]);
            api.fetch(id, true).await.unwrap();
            assert!(row_ids(&graph_rows(&api, id).await).contains(tip.as_str()), "fetch {i}'s tip is in the graph");
        }
        assert!(!crate::api::odb_nearly_full(&api.handle(id).unwrap().repo));
    }
}
