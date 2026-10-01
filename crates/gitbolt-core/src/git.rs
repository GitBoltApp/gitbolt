//! The single runner for every git CLI invocation.

use crate::error::{classify_stderr, GbError, GbErrorKind};
use crate::log::{truncate_utf8, CommandLog, CommandLogEntry, STDERR_LOG_LIMIT};
use crate::redact::redact;
use crate::shellenv::{EnvVars, ShellEnv};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc::UnboundedSender;
pub use tokio_util::sync::CancellationToken;

pub const MIN_GIT: (u32, u32, u32) = (2, 30, 0);
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
/// How much of a command's stderr is kept in memory (a long clone's progress can be large).
const STDERR_KEEP: usize = 1 << 20;
/// The longest streamed stderr line: a stream with no `\r`/`\n` is flushed in pieces this size.
const PENDING_MAX: usize = 64 * 1024;
/// How long the output pipes may stay open after git exits (a background process it left
/// behind still holding them) before the run gives up on them.
const PIPE_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct GitCli {
    bin: PathBuf,
    env: Arc<Vec<(OsString, OsString)>>,
    hook: Option<CommandHook>,
    log: Arc<CommandLog>,
    shell_env: Option<Arc<ShellEnv>>,
    include: Arc<RwLock<Option<PathBuf>>>,
}

/// Adjusts every command just before it starts, after the runner's own environment: the app
/// uses it to give children the session's values of what it changed for itself.
pub type CommandHook = Arc<dyn Fn(&mut std::process::Command) + Send + Sync>;

pub struct GitInvocation {
    cwd: PathBuf,
    args: Vec<OsString>,
    timeout: Option<Duration>,
    cancel: Option<CancellationToken>,
    envs: Vec<(OsString, OsString)>,
    stderr_lines: Option<UnboundedSender<String>>,
    detach: bool,
}

impl GitInvocation {
    pub fn new<I, S>(cwd: impl Into<PathBuf>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self { cwd: cwd.into(), args: args.into_iter().map(Into::into).collect(), timeout: Some(LOCAL_TIMEOUT), cancel: None, envs: Vec::new(), stderr_lines: None, detach: false }
    }

    /// `None` = no timeout (network operations).
    pub fn timeout(mut self, t: Option<Duration>) -> Self {
        self.timeout = t;
        self
    }

    pub fn cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// An environment variable for this command only (over `with_env`, under the fixed ones).
    pub fn env(mut self, k: impl Into<OsString>, v: impl Into<OsString>) -> Self {
        self.envs.push((k.into(), v.into()));
        self
    }

    /// [`Self::env`] for several variables.
    pub fn envs(mut self, vars: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        self.envs.extend(vars);
        self
    }

    /// Streams stderr as it arrives: one redacted, trimmed, non-empty line per `\r` or `\n`
    /// (git progress rewrites its line with `\r`). The full stderr is still collected.
    pub fn stream_stderr(mut self, tx: UnboundedSender<String>) -> Self {
        self.stderr_lines = Some(tx);
        self
    }

    /// Runs git in a new session (`setsid`), with no controlling terminal (network ops, K96):
    /// ssh, a credential helper or git itself then can't open `/dev/tty` to prompt, so a prompt
    /// either reaches askpass or fails at once. Without this, an app started from a shell leaves
    /// its terminal to them, and a read from it (by a background process group) stops the
    /// command for good. Cancel still kills the whole group: the session leader's.
    pub fn detach_terminal(mut self) -> Self {
        self.detach = true;
        self
    }
}

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub command_id: u64,
}

enum Outcome {
    Done(std::io::Result<std::process::ExitStatus>),
    Cancelled,
    TimedOut(Duration),
}

impl GitCli {
    pub fn new(log: Arc<CommandLog>) -> Self {
        Self { bin: PathBuf::from("git"), env: Arc::new(Vec::new()), hook: None, log, shell_env: None, include: Arc::new(RwLock::new(None)) }
    }

    /// Extra environment for every command (test isolation), over the captured login-shell env.
    pub fn with_env(mut self, env: Vec<(OsString, OsString)>) -> Self {
        self.env = Arc::new(env);
        self
    }

    /// See [`CommandHook`].
    pub fn with_command_hook(mut self, hook: CommandHook) -> Self {
        self.hook = Some(hook);
        self
    }

    /// The login-shell environment (spec §5.3). It replaces the inherited process env for every
    /// git command (`env_clear` first); commands that start before the capture is done wait for
    /// it (bounded by its timeout). `PRIVATE_ENV` removal and the hook still apply over it.
    pub fn with_shell_env(mut self, env: Arc<ShellEnv>) -> Self {
        self.shell_env = Some(env);
        self
    }

    pub fn shell_env(&self) -> Option<&Arc<ShellEnv>> {
        self.shell_env.as_ref()
    }

    /// The environment for non-git children (editors): the captured shell env, else `None`
    /// (inherit). The app composes it with its child-env hook, which runs after it.
    pub async fn child_env(&self) -> Option<EnvVars> {
        match &self.shell_env {
            Some(s) => s.get().await,
            None => None,
        }
    }

    /// The profile's extra gitconfig (spec §14.2), passed as `-c include.path=<p>` to every
    /// command. Shared by every clone of this runner.
    pub fn set_include_path(&self, path: Option<PathBuf>) {
        *self.include.write().unwrap_or_else(|e| e.into_inner()) = path;
    }

    pub fn include_path(&self) -> Option<PathBuf> {
        self.include.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn log(&self) -> &Arc<CommandLog> {
        &self.log
    }

    pub async fn run(&self, inv: GitInvocation) -> Result<GitOutput, GbError> {
        let id = self.log.next_id();
        let started = Instant::now();
        let started_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);

        // Environment, lowest to highest: the captured login-shell env (replacing the inherited
        // one) or the inherited one, `with_env`, the invocation's `envs`, the fixed variables
        // below, then `PRIVATE_ENV` removal, then the hook.
        let mut cmd = tokio::process::Command::new(&self.bin);
        if let Some(shell) = &self.shell_env
            && let Some(vars) = shell.get().await
        {
            cmd.env_clear().envs(vars.iter().map(|(k, v)| (k, v)));
        }
        // The profile include comes first, so GitBolt's fixed `-c` values after it win.
        cmd.current_dir(&inv.cwd).arg("--no-pager");
        if let Some(inc) = self.include_path() {
            let mut arg = OsString::from("include.path=");
            arg.push(&inc);
            cmd.arg("-c").arg(arg);
        }
        cmd.args(["-c", "core.quotepath=false"])
            .args(&inv.args)
            // A partial clone must never fetch missing objects behind the user's back from a
            // read (status, log, numstat, the watcher's lists). Network ops override it
            // (netops.rs), as a clone's checkout needs the lazy fetch.
            .env("GIT_NO_LAZY_FETCH", "1")
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .envs(inv.envs.iter().map(|(k, v)| (k, v)))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            // GitBolt only reads: this disables *optional* locks (e.g. the stat-info refresh a
            // plain `git status` writes back into `.git/index`), not the locking real write
            // operations (checkout, commit, ...) still need and will keep taking in later plans.
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // GitBolt's own environment (openers::PRIVATE_ENV) must never leak into a child, the
        // same guarantee `openers::launch_command` gives an opener/chooser/URL-open launch, and
        // regardless of whether a command hook is installed.
        for var in crate::openers::PRIVATE_ENV {
            cmd.as_std_mut().env_remove(var);
        }
        if let Some(hook) = &self.hook {
            hook(cmd.as_std_mut());
        }

        // Its own process group (cancel kills git's children too). A detached command gets its
        // own session instead, whose group it leads (`setsid` fails in a group leader, so it's
        // one or the other).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            if inv.detach {
                // SAFETY: `setsid` is async-signal-safe and the closure touches nothing else.
                unsafe {
                    cmd.as_std_mut().pre_exec(|| nix::unistd::setsid().map(drop).map_err(std::io::Error::from));
                }
            } else {
                cmd.as_std_mut().process_group(0);
            }
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err_msg = format!("failed to run git: {e}");
                let redacted_err = redact(&err_msg);
                self.log.push(CommandLogEntry {
                    id,
                    args: inv.args.iter().map(|a| redact(&a.to_string_lossy())).collect(),
                    cwd: inv.cwd.display().to_string(),
                    started_ms,
                    duration_ms: started.elapsed().as_millis() as u64,
                    exit_code: None,
                    stderr: truncate_utf8(&redacted_err, STDERR_LOG_LIMIT).to_string(),
                });
                return Err(GbError { kind: GbErrorKind::Io, message: redacted_err.clone(), command_id: Some(id), stderr: Some(redacted_err) });
            }
        };

        let pid = child.id();
        // stdout and stderr are read concurrently with the wait, so neither pipe can fill up and
        // stall git, and stderr can stream line by line (progress) while git runs.
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let mut out_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf).await;
            buf
        });
        let mut err_task = tokio::spawn(read_stderr(stderr, inv.stderr_lines.clone()));
        let cancel = inv.cancel.clone();
        // `biased`, cancel first: once the user cancelled, report Cancelled even if git exited in
        // the same instant (e.g. askpass answered "cancel" and git bailed out with an auth error).
        let outcome = tokio::select! {
            biased;
            _ = async { match &cancel { Some(t) => t.cancelled().await, None => std::future::pending().await } } => Outcome::Cancelled,
            r = child.wait() => Outcome::Done(r),
            _ = async { match inv.timeout { Some(d) => tokio::time::sleep(d).await, None => std::future::pending().await } } => Outcome::TimedOut(inv.timeout.unwrap_or_default()),
        };
        if !matches!(outcome, Outcome::Done(_)) {
            kill_group(pid);
            let _ = child.wait().await;
        }
        // A background process git left behind that still holds a pipe must not hang us: one
        // shared grace, then the readers are aborted and the straggler (in git's process group)
        // is killed. Output cut short that way is never reported as a success.
        let deadline = tokio::time::Instant::now() + PIPE_GRACE;
        let stdout_bytes = tokio::time::timeout_at(deadline, &mut out_task).await;
        let stderr_bytes = tokio::time::timeout_at(deadline, &mut err_task).await;
        let pipes_closed = stdout_bytes.is_ok() && stderr_bytes.is_ok();
        if !pipes_closed {
            out_task.abort();
            err_task.abort();
            kill_group(pid);
        }
        let stdout_bytes = stdout_bytes.ok().and_then(Result::ok).unwrap_or_default();
        let stderr_bytes = stderr_bytes.ok().and_then(Result::ok).unwrap_or_default();

        let (exit_code, stderr_text, result) = match outcome {
            Outcome::Done(Ok(status)) if status.success() && !pipes_closed => {
                let msg = format!("git exited, but its output stayed open for {}s (a background process holding it); output incomplete", PIPE_GRACE.as_secs());
                (status.code(), msg.clone(), Err(GbError { command_id: Some(id), ..GbError::new(GbErrorKind::Io, msg) }))
            }
            Outcome::Done(Ok(status)) => {
                let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
                let redacted_stderr = redact(&stderr);
                let code = status.code();
                if status.success() {
                    (code, stderr.clone(), Ok(GitOutput { stdout: stdout_bytes, stderr: redacted_stderr, command_id: id }))
                } else {
                    let err = GbError {
                        kind: classify_stderr(&stderr),
                        message: first_message_line(&redacted_stderr).unwrap_or_else(|| format!("git exited with status {}", code.unwrap_or(-1))),
                        command_id: Some(id),
                        stderr: Some(redacted_stderr),
                    };
                    (code, stderr, Err(err))
                }
            }
            Outcome::Done(Err(e)) => (None, e.to_string(), Err(wait_failed(id, &e))),
            Outcome::Cancelled => (None, String::new(), Err(GbError { command_id: Some(id), ..GbError::new(GbErrorKind::Cancelled, "Cancelled") })),
            Outcome::TimedOut(d) => (None, String::new(), Err(GbError { command_id: Some(id), ..GbError::other(format!("git timed out after {}s", d.as_secs_f32())) })),
        };

        self.log.push(CommandLogEntry {
            id,
            args: inv.args.iter().map(|a| redact(&a.to_string_lossy())).collect(),
            cwd: inv.cwd.display().to_string(),
            started_ms,
            duration_ms: started.elapsed().as_millis() as u64,
            exit_code,
            stderr: truncate_utf8(&redact(&stderr_text), STDERR_LOG_LIMIT).to_string(),
        });
        result
    }

    pub async fn check_version(&self) -> Result<(u32, u32, u32), GbError> {
        let out = self.run(GitInvocation::new(std::env::temp_dir(), ["--version"])).await?;
        let text = String::from_utf8_lossy(&out.stdout);
        let v = parse_version(&text).ok_or_else(|| GbError::other(format!("unrecognized git version: {text}")))?;
        if v < MIN_GIT {
            return Err(GbError::new(GbErrorKind::GitTooOld, format!("git {}.{}.{} is too old; GitBolt needs {}.{} or newer", v.0, v.1, v.2, MIN_GIT.0, MIN_GIT.1)));
        }
        Ok(v)
    }
}

/// The error for a git process that started but couldn't be waited on. It carries the
/// command's log id like every other failure, so the UI can link it to the command log.
fn wait_failed(id: u64, e: &std::io::Error) -> GbError {
    GbError { command_id: Some(id), ..GbError::new(GbErrorKind::Io, redact(&format!("git failed: {e}"))) }
}

/// SIGKILLs the child's process group (the child leads its own group). Accepted risk (1C review
/// M7): if the leader was already reaped, its pid could in theory be reused and `killpg` would hit
/// a stranger's group. The window is tiny (we kill on timeout/cancel while the child is still
/// ours, before `wait` reaps it, and a zombie leader keeps its pid and group alive), so no extra
/// guard is added.
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGKILL);
    }
}

/// Collects stderr (up to `STDERR_KEEP`) and, with `lines`, streams it: see
/// [`GitInvocation::stream_stderr`].
async fn read_stderr(mut r: tokio::process::ChildStderr, lines: Option<UnboundedSender<String>>) -> Vec<u8> {
    let mut all = Vec::new();
    let mut pending = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let keep = n.min(STDERR_KEEP - all.len());
        all.extend_from_slice(&chunk[..keep]);
        if let Some(tx) = &lines {
            for &b in &chunk[..n] {
                if b == b'\r' || b == b'\n' {
                    flush_line(tx, &mut pending);
                } else {
                    pending.push(b);
                    if pending.len() >= PENDING_MAX {
                        flush_line(tx, &mut pending);
                    }
                }
            }
        }
    }
    if let Some(tx) = &lines {
        flush_line(tx, &mut pending);
    }
    all
}

fn flush_line(tx: &UnboundedSender<String>, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(pending).trim().to_string();
    pending.clear();
    if !line.is_empty() {
        let _ = tx.send(redact(&line));
    }
}

/// git's first real message line: not a hint, and not progress (`Fetching origin`, a
/// `\r`-rewritten percentage, `From <url>`), which a network command prints before it fails.
fn first_message_line(stderr: &str) -> Option<String> {
    stderr
        .split(['\r', '\n'])
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("hint:") && !l.starts_with("From ") && !l.starts_with("Cloning into ") && crate::netops::parse_progress(l).is_none())
        .map(|l| l.trim_start_matches("fatal: ").trim_start_matches("error: ").to_string())
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let v = s.trim().strip_prefix("git version ")?;
    let mut parts = v.split('.').map(|p| p.parse::<u32>().ok());
    let major = parts.next()??;
    let minor = parts.next()??;
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GbErrorKind;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::time::Instant;

    #[test]
    fn a_failed_wait_carries_the_command_id() {
        let err = wait_failed(42, &std::io::Error::other("boom"));
        assert_eq!(err.kind, GbErrorKind::Io);
        assert_eq!(err.command_id, Some(42));
        assert_eq!(err.message, "git failed: boom");
    }

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    #[tokio::test]
    async fn runs_and_logs() {
        let r = TestRepo::new();
        let cli = cli();
        let out = cli.run(GitInvocation::new(r.path(), ["rev-parse", "--is-inside-work-tree"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "true");
        let log = cli.log().entries();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].exit_code, Some(0));
        assert_eq!(log[0].args, vec!["rev-parse", "--is-inside-work-tree"]);
    }

    #[tokio::test]
    async fn failure_is_classified_and_carries_command_id() {
        let r = TestRepo::new();
        r.commit("c");
        let err = cli().run(GitInvocation::new(r.path(), ["rev-parse", "--verify", "nope^{commit}"])).await.unwrap_err();
        assert!(err.command_id.is_some());
        assert!(err.stderr.is_some());
        assert_ne!(err.kind, GbErrorKind::Cancelled);
    }

    /// The app's hook (gitbolt-app `desktop::restore_child_env`) runs last, over the inherited
    /// environment and `with_env`: it can put back or remove what the app set for itself.
    #[tokio::test]
    async fn the_command_hook_adjusts_every_commands_environment_last() {
        let r = TestRepo::new();
        let cli = cli()
            .with_env(vec![("GB_HOOK_SET".into(), "from with_env".into()), ("GB_HOOK_GONE".into(), "still here".into())])
            .with_command_hook(Arc::new(|cmd: &mut std::process::Command| {
                cmd.env("GB_HOOK_SET", "restored").env_remove("GB_HOOK_GONE");
            }));
        let out = cli
            .run(GitInvocation::new(r.path(), ["-c", "alias.env=!printf '%s|%s' \"$GB_HOOK_SET\" \"${GB_HOOK_GONE-unset}\"", "env"]))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "restored|unset");
    }

    /// I2: `CHROME_DEVEL_SANDBOX` and `GITBOLT_OPEN` (`openers::PRIVATE_ENV`) are GitBolt's own,
    /// never git's to inherit — the same guarantee `openers::launch_command` gives every opener,
    /// chooser and URL-open launch. `GitCli::run` is the other place a child process starts, so
    /// it must strip them too, even with no command hook installed (the app always installs one,
    /// but this must not depend on that).
    #[tokio::test]
    async fn private_app_env_never_reaches_a_child_even_without_a_hook() {
        let r = TestRepo::new();
        let cli = GitCli::new(Arc::new(CommandLog::new(10)))
            .with_env(vec![("CHROME_DEVEL_SANDBOX".into(), "/leaked/sandbox".into()), ("GITBOLT_OPEN".into(), "/leaked/repo".into())]);
        let out = cli
            .run(GitInvocation::new(r.path(), ["-c", "alias.env=!printf '%s|%s' \"${CHROME_DEVEL_SANDBOX-unset}\" \"${GITBOLT_OPEN-unset}\"", "env"]))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "unset|unset");
    }

    #[tokio::test]
    async fn sets_terminal_prompt_off_and_c_locale() {
        // No isolated env here: the runner itself must set both variables.
        let r = TestRepo::new();
        let out = GitCli::new(Arc::new(CommandLog::new(10)))
            .run(GitInvocation::new(r.path(), ["-c", "alias.env=!printf '%s %s %s' \"$GIT_TERMINAL_PROMPT\" \"$LC_ALL\" \"$GIT_OPTIONAL_LOCKS\"", "env"]))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "0 C 0");
    }

    /// K96: a failed `fetch --all --progress` starts with progress ("Fetching origin", `\r`-joined
    /// percentages): the message is git's (or ssh's) first real line, never a progress one.
    #[test]
    fn the_message_skips_progress_lines() {
        let multi = "Fetching origin\ngit@h: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\nerror: could not fetch origin\n";
        assert_eq!(first_message_line(multi).as_deref(), Some("git@h: Permission denied (publickey)."));
        let cut = "remote: Counting objects: 50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nReceiving objects:  10% (1/10)\rFrom /tmp/o\nfatal: early EOF\n";
        assert_eq!(first_message_line(cut).as_deref(), Some("early EOF"));
        assert_eq!(first_message_line("Fetching origin\n"), None, "nothing but progress: the caller says what exited");
        assert_eq!(first_message_line("Cloning into '/tmp/x'...\nfatal: repository '/nope' does not exist\n").as_deref(), Some("repository '/nope' does not exist"));
        assert_eq!(first_message_line("hint: x\nerror: boom\n").as_deref(), Some("boom"));
    }

    /// K96: a network command runs in its own session, with no controlling terminal: ssh (or a
    /// credential helper) can't open `/dev/tty`, so it can't stop on a terminal read and hang the
    /// op when GitBolt was started from a shell. Cancel still kills the whole group.
    #[cfg(target_os = "linux")] // reads the session id from /proc
    #[tokio::test]
    async fn a_detached_command_has_its_own_session_and_still_cancels_as_a_group() {
        let r = TestRepo::new();
        let alias = "alias.sid=!cut -d' ' -f6 /proc/$$/stat";
        let own = nix::unistd::getsid(None).unwrap().as_raw().to_string();
        let sid = |out: GitOutput| String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert_eq!(sid(cli().run(GitInvocation::new(r.path(), ["-c", alias, "sid"])).await.unwrap()), own, "a local command stays in the app's session");
        assert_ne!(sid(cli().run(GitInvocation::new(r.path(), ["-c", alias, "sid"]).detach_terminal()).await.unwrap()), own);

        let marker = r.root().join("marker-detached");
        let slow = format!("alias.slow=!sleep 1 && touch {}", marker.display());
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            t2.cancel();
        });
        let err = cli().run(GitInvocation::new(r.path(), ["-c", slow.as_str(), "slow"]).detach_terminal().cancel(token)).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled);
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(!marker.exists(), "grandchild survived cancellation");
    }

    #[tokio::test]
    async fn cancel_kills_the_whole_process_group() {
        let r = TestRepo::new();
        let marker = r.root().join("marker");
        let alias = format!("alias.slow=!sleep 1 && touch {}", marker.display());
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            t2.cancel();
        });
        let started = Instant::now();
        let err = cli().run(GitInvocation::new(r.path(), ["-c", alias.as_str(), "slow"]).cancel(token)).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_millis(900));
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(!marker.exists(), "grandchild survived cancellation");
    }

    #[tokio::test]
    async fn timeout_is_reported() {
        let r = TestRepo::new();
        let err = cli()
            .run(GitInvocation::new(r.path(), ["-c", "alias.slow=!sleep 2", "slow"]).timeout(Some(Duration::from_millis(200))))
            .await
            .unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Other);
        assert!(err.message.contains("timed out"), "{}", err.message);
    }

    /// K96 review: a failing command's message (what the toast shows), its stderr and its log entry
    /// never carry a URL's password, whatever the scheme.
    #[tokio::test]
    async fn a_failures_message_stderr_and_log_are_redacted() {
        let r = TestRepo::new();
        let cli = cli();
        let alias = "alias.boom=!echo \"fatal: repository 'ssh://ada:hunter2@h/x' not found\" >&2; exit 128";
        let err = cli.run(GitInvocation::new(r.path(), ["-c", alias, "boom"])).await.unwrap_err();
        assert_eq!(err.message, "repository 'ssh://***@h/x' not found");
        assert!(!err.stderr.unwrap().contains("hunter2"));
        let log = cli.log().entries();
        assert!(log.iter().all(|e| !e.stderr.contains("hunter2") && e.args.iter().all(|a| !a.contains("hunter2"))), "{log:?}");
    }

    #[tokio::test]
    async fn logged_args_are_redacted() {
        let r = TestRepo::new();
        let cli = cli();
        let _ = cli.run(GitInvocation::new(r.path(), ["ls-remote", "https://u:secret@127.0.0.1:1/x.git"]).timeout(Some(Duration::from_secs(5)))).await;
        assert_eq!(cli.log().entries()[0].args[1], "https://***@127.0.0.1:1/x.git");
    }

    #[tokio::test]
    async fn spawn_failure_is_logged_with_command_id() {
        let cli = cli();
        let bad_cwd = std::path::Path::new("/nonexistent/path/that/does/not/exist");
        let err = cli.run(GitInvocation::new(bad_cwd, ["rev-parse", "HEAD"])).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Io);
        assert!(err.command_id.is_some());
        let log = cli.log().entries();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].exit_code, None);
        assert!(!log[0].stderr.is_empty());
    }

    #[tokio::test]
    async fn successful_command_stderr_is_redacted() {
        let r = TestRepo::new();
        let cli = cli();
        let out = cli.run(GitInvocation::new(r.path(), ["-c", "alias.leak=!echo https://u:secret@h/x.git 1>&2", "leak"])).await.unwrap();
        assert!(out.stderr.contains("https://***@h/x.git"), "GitOutput.stderr should be redacted");
        assert!(!out.stderr.contains("secret"), "GitOutput.stderr should not contain credentials");
        let log = cli.log().entries();
        assert_eq!(log.len(), 1);
        assert!(log[0].stderr.contains("https://***@h/x.git"), "Log stderr should also be redacted");
        assert!(!log[0].stderr.contains("secret"), "Log stderr should not contain credentials");
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.53.0"), Some((2, 53, 0)));
        assert_eq!(parse_version("git version 2.39.2.windows.1"), Some((2, 39, 2)));
        assert_eq!(parse_version("git version 2.43"), Some((2, 43, 0)));
        assert_eq!(parse_version("nonsense"), None);
    }

    #[tokio::test]
    async fn system_git_meets_minimum() {
        let v = cli().check_version().await.unwrap();
        assert!(v >= MIN_GIT);
    }

    #[tokio::test]
    async fn per_invocation_env_reaches_git() {
        let r = TestRepo::new();
        let out = cli()
            .run(GitInvocation::new(r.path(), ["-c", "alias.probe=!printf '%s' \"$GB_PROBE\"", "probe"]).env("GB_PROBE", "hello"))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello");
    }

    #[tokio::test]
    async fn streams_stderr_lines_split_on_cr_and_lf() {
        let r = TestRepo::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let alias = "alias.prog=!printf 'Receiving objects:  50%%\\rReceiving objects: 100%%, done.\\nhttps://u:secret@h/x\\n' >&2";
        let out = cli().run(GitInvocation::new(r.path(), ["-c", alias, "prog"]).stream_stderr(tx)).await.unwrap();
        let mut lines = Vec::new();
        while let Ok(l) = rx.try_recv() {
            lines.push(l);
        }
        assert_eq!(lines, vec!["Receiving objects:  50%", "Receiving objects: 100%, done.", "https://***@h/x"]);
        assert!(out.stderr.contains("100%"), "full stderr is still collected");
    }

    /// A last line with no terminator is still streamed, and a failing command's streamed lines
    /// arrive too (the progress view shows what git said before it failed).
    #[tokio::test]
    async fn streams_an_unterminated_last_line_of_a_failing_command() {
        let r = TestRepo::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let alias = "alias.prog=!printf 'remote: counting\\n\\nfatal: gone' >&2; exit 3";
        let err = cli().run(GitInvocation::new(r.path(), ["-c", alias, "prog"]).stream_stderr(tx)).await.unwrap_err();
        let mut lines = Vec::new();
        while let Ok(l) = rx.try_recv() {
            lines.push(l);
        }
        assert_eq!(lines, vec!["remote: counting", "fatal: gone"]);
        assert!(err.stderr.unwrap().contains("fatal: gone"), "full stderr is still collected");
    }

    #[tokio::test]
    async fn include_path_is_applied_to_every_clone() {
        let r = TestRepo::new();
        let inc = r.root().join("extra.gitconfig");
        std::fs::write(&inc, "[gitbolt]\n\tprobe = from-include\n").unwrap();
        let cli = cli();
        let other = cli.clone();
        cli.set_include_path(Some(inc.clone()));
        assert_eq!(other.include_path(), Some(inc));
        let out = other.run(GitInvocation::new(r.path(), ["config", "gitbolt.probe"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "from-include");
        cli.set_include_path(None);
        assert!(other.run(GitInvocation::new(r.path(), ["config", "gitbolt.probe"])).await.is_err());
    }

    #[tokio::test]
    async fn captured_shell_env_replaces_the_process_env() {
        let r = TestRepo::new();
        let mut vars: Vec<(OsString, OsString)> = vec![("GB_FROM_SHELL".into(), "yes".into())];
        vars.push(("PATH".into(), std::env::var_os("PATH").unwrap()));
        vars.push(("HOME".into(), r.root().as_os_str().to_owned()));
        let cli = GitCli::new(Arc::new(CommandLog::new(10)))
            .with_shell_env(crate::shellenv::ShellEnv::fixed(vars))
            .with_env(isolated_git_env());
        let out = cli
            .run(GitInvocation::new(r.path(), ["-c", "alias.probe=!printf '%s|%s' \"$GB_FROM_SHELL\" \"$HOME\"", "probe"]))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), format!("yes|{}", r.root().display()));
    }

    /// Precedence, lowest to highest: the captured shell env (which replaces the process env),
    /// `with_env`, the invocation's own `envs`, the runner's fixed variables, then `PRIVATE_ENV`
    /// removal, then the app's hook (1B, I2): the hook still runs after `env_clear`.
    #[tokio::test]
    async fn env_precedence_with_a_captured_shell_env_ends_with_private_env_removal_and_the_hook() {
        let r = TestRepo::new();
        let shell: Vec<(OsString, OsString)> = [
            ("PATH", std::env::var_os("PATH").unwrap().into_string().unwrap().as_str()),
            ("HOME", r.root().to_str().unwrap()),
            ("GB_A", "shell"),
            ("GB_B", "shell"),
            ("GB_C", "shell"),
            ("GB_HOOK_GONE", "shell"),
            ("LC_ALL", "en_US.UTF-8"),
            ("CHROME_DEVEL_SANDBOX", "/leaked/sandbox"),
            ("GITBOLT_OPEN", "/leaked/repo"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let mut extras = isolated_git_env();
        extras.extend([("GB_B".into(), "with_env".into()), ("GB_C".into(), "with_env".into())]);
        let cli = GitCli::new(Arc::new(CommandLog::new(10)))
            .with_shell_env(crate::shellenv::ShellEnv::fixed(shell))
            .with_env(extras)
            .with_command_hook(Arc::new(|cmd: &mut std::process::Command| {
                cmd.env("GB_HOOK_SET", "hook").env_remove("GB_HOOK_GONE");
            }));
        let script = "!printf '%s|%s|%s|%s|%s|%s|%s|%s' \"$GB_A\" \"$GB_B\" \"$GB_C\" \"$LC_ALL\" \"${CHROME_DEVEL_SANDBOX-unset}\" \"${GITBOLT_OPEN-unset}\" \"$GB_HOOK_SET\" \"${GB_HOOK_GONE-unset}\"";
        let out = cli
            .run(GitInvocation::new(r.path(), ["-c", &format!("alias.probe={script}"), "probe"]).env("GB_C", "invocation").env("LC_ALL", "invocation"))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "shell|with_env|invocation|C|unset|unset|hook|unset");
    }

    /// GitBolt's fixed `-c` values come after the profile include, so the include can't undo
    /// them (a later `-c` wins).
    #[tokio::test]
    async fn the_profile_include_cannot_override_the_fixed_config() {
        let r = TestRepo::new();
        let inc = r.root().join("extra.gitconfig");
        std::fs::write(&inc, "[core]\n\tquotepath = true\n").unwrap();
        let cli = cli();
        cli.set_include_path(Some(inc));
        let out = cli.run(GitInvocation::new(r.path(), ["config", "--bool", "core.quotepath"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "false");
    }

    /// A background process git left behind that still holds stdout: after the grace, the run
    /// fails (never a silently truncated `Ok`) and the straggler, in git's group, is killed.
    #[tokio::test]
    async fn a_grandchild_holding_stdout_fails_the_run_after_the_grace() {
        let r = TestRepo::new();
        let marker = r.root().join("straggler-survived");
        let alias = format!("alias.bg=!printf partial; (sleep 4; touch '{}') &", marker.display());
        let started = Instant::now();
        let err = cli().run(GitInvocation::new(r.path(), ["-c", alias.as_str(), "bg"])).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(3500), "{:?}", started.elapsed());
        assert!(err.message.contains("output"), "{}", err.message);
        assert!(err.command_id.is_some());
        tokio::time::sleep(Duration::from_millis(3000)).await;
        assert!(!marker.exists(), "the straggler holding the pipe survived");
    }

    /// A stream with no line terminator is still cut into lines of at most `PENDING_MAX` bytes.
    #[tokio::test]
    async fn an_unterminated_stderr_stream_is_flushed_in_bounded_lines() {
        let r = TestRepo::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let alias = "alias.flood=!head -c 150000 /dev/zero | tr '\\0' a >&2";
        cli().run(GitInvocation::new(r.path(), ["-c", alias, "flood"]).stream_stderr(tx)).await.unwrap();
        let mut lines = Vec::new();
        while let Ok(l) = rx.try_recv() {
            lines.push(l);
        }
        assert_eq!(lines.iter().map(String::len).collect::<Vec<_>>(), vec![PENDING_MAX, PENDING_MAX, 150_000 - 2 * PENDING_MAX]);
    }

    #[tokio::test]
    async fn collected_stderr_is_capped_at_stderr_keep() {
        let r = TestRepo::new();
        let alias = format!("alias.flood=!head -c {} /dev/zero | tr '\\0' a >&2", STDERR_KEEP + 100_000);
        let out = cli().run(GitInvocation::new(r.path(), ["-c", alias.as_str(), "flood"])).await.unwrap();
        assert_eq!(out.stderr.len(), STDERR_KEEP);
    }

    /// Editors and other non-git children get the captured env; with none, they inherit.
    #[tokio::test]
    async fn child_env_is_the_captured_shell_env() {
        let log = Arc::new(CommandLog::new(10));
        assert!(GitCli::new(log.clone()).child_env().await.is_none());
        let vars = vec![("GB_X".into(), "y".into())];
        let cli = GitCli::new(log).with_shell_env(crate::shellenv::ShellEnv::fixed(vars.clone()));
        assert!(cli.shell_env().is_some());
        assert_eq!(*cli.child_env().await.unwrap(), vars);
    }
}
