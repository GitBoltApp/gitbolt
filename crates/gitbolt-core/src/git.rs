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

pub const MIN_GIT: (u32, u32, u32) = (2, 40, 0);
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
    /// Built by `GitInvocation::write`: git's normal locks (no `GIT_OPTIONAL_LOCKS=0`).
    write: bool,
    /// Fed to git's stdin, then closed; `None` = `/dev/null`.
    stdin: Option<Vec<u8>>,
    /// On cancel or timeout: SIGTERM, then SIGKILL after this (writes); `None` = SIGKILL at once.
    term_grace: Option<Duration>,
    /// Exit codes besides 0 that count as success (`ok_exit`).
    ok_exit: Vec<i32>,
    /// Keep at most this many bytes of stdout (`stdout_limit`).
    stdout_limit: Option<u64>,
}

/// How long a cancelled or timed-out write has to exit after SIGTERM before SIGKILL (spec #2 §3.3).
pub const WRITE_TERM_GRACE: Duration = Duration::from_secs(2);

impl GitInvocation {
    /// A write (spec #2 §3.3): no `GIT_OPTIONAL_LOCKS=0` (git's normal locks), never an editor
    /// (`GIT_EDITOR=true`, `GIT_MERGE_AUTOEDIT=no`), and a cancel that lets git clean up its
    /// `.lock` files first. Only `crate::write` can make the token (Deviation 1).
    pub(crate) fn write<I, S>(proof: &crate::write::WriteToken, cwd: impl Into<PathBuf>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        // --- 2C repo-safety ---
        // `submodule.recurse=false`: with the user's `submodule.recurse=true`, a `reset --hard`,
        // a `restore` or a `switch` would run inside every submodule too, discarding its
        // uncommitted work, which no snapshot carries (safety review I3). GitBolt never recurses
        // on a write that moves the worktree; a read is unaffected.
        // --- end 2C repo-safety ---
        Self::writer(proof, cwd, &["-c", "submodule.recurse=false"], args)
    }

    /// A network write (a push, a remote branch delete, a pull's fetch): `write` without the
    /// `submodule.recurse=false` pin. That pin also overrides `push.recurseSubmodules`, which
    /// defaults to `submodule.recurse`, and would silently drop the user's own push guard
    /// (`check`, `on-demand`) (2C final I4). None of these touch the worktree.
    pub(crate) fn network_write<I, S>(proof: &crate::write::WriteToken, cwd: impl Into<PathBuf>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self::writer(proof, cwd, &[], args)
    }

    fn writer<I, S>(_proof: &crate::write::WriteToken, cwd: impl Into<PathBuf>, pins: &[&str], args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        // No editor can open in any write: the env beats config for the sequence editor, and
        // the `-c` pairs cover `core.editor`/`sequence.editor` from the user's config. A caller
        // that needs a real rebase todo sets its own `GIT_SEQUENCE_EDITOR` with `.env` after.
        let mut inv = Self::new(cwd, ["-c", "core.editor=true", "-c", "sequence.editor=true"].into_iter().chain(pins.iter().copied()))
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            // UX F: a signing commit (`commit.gpgsign`) asks gpg-agent for the key's passphrase,
            // and the agent shows its pinentry on the terminal gpg names in `GPG_TTY` (else the
            // one the agent was started from). A TTY pinentry there waits on a terminal nobody
            // looks at, forever. `/dev/null` is no terminal: a TTY pinentry fails at once with
            // gpg's error, while a GUI one (DISPLAY, WAYLAND_DISPLAY) still asks.
            .env("GPG_TTY", "/dev/null");
        inv.args.extend(args.into_iter().map(Into::into));
        inv.write = true;
        inv.term_grace = Some(WRITE_TERM_GRACE);
        inv
    }

    /// Bytes for git's stdin (`commit -F -`, `update-index -z --index-info`, `--pathspec-from-file=-`):
    /// paths never go on argv when there can be many.
    pub fn stdin(mut self, bytes: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(bytes.into());
        self
    }

    pub fn is_write(&self) -> bool {
        self.write
    }

    /// A write's cancel for a command that isn't a write (a fetch, a clone): SIGTERM, then
    /// SIGKILL after `grace`, so git can remove the ref locks it holds (`refs/remotes/…lock`,
    /// `packed-refs.lock`). The environment stays a read's (`GIT_OPTIONAL_LOCKS=0`).
    pub(crate) fn term_grace(mut self, grace: Duration) -> Self {
        self.term_grace = Some(grace);
        self
    }
}

impl GitInvocation {
    pub fn new<I, S>(cwd: impl Into<PathBuf>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self { cwd: cwd.into(), args: args.into_iter().map(Into::into).collect(), timeout: Some(LOCAL_TIMEOUT), cancel: None, envs: Vec::new(), stderr_lines: None, detach: false, write: false, stdin: None, term_grace: None, ok_exit: Vec::new(), stdout_limit: None }
    }

    /// `None` = no timeout (network operations).
    pub fn timeout(mut self, t: Option<Duration>) -> Self {
        self.timeout = t;
        self
    }

    /// An exit code that counts as success besides 0 (`diff --no-index` exits 1 on a difference).
    pub fn ok_exit(mut self, code: i32) -> Self {
        self.ok_exit.push(code);
        self
    }

    /// Keeps only the first `n` bytes of stdout (the head of a large blob: a hex dump, a binary
    /// sniff). Once `n` bytes are in, git is stopped (a read: SIGKILL) and the run succeeds with
    /// them, so neither memory nor time grows with the rest of the output.
    pub fn stdout_limit(mut self, n: u64) -> Self {
        self.stdout_limit = Some(n);
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
    /// `stdout_limit` bytes are in: git was stopped, and the run succeeds with them.
    Capped,
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

    pub async fn run(&self, mut inv: GitInvocation) -> Result<GitOutput, GbError> {
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
            .env("LC_ALL", "C");
        if !inv.write {
            // Reads only (the never-write invariant, core §5.2): this disables *optional* locks
            // (the stat refresh `git status` writes back into `.git/index`). Writes
            // (`GitInvocation::write`) take git's normal locks.
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        } else {
            // An inherited `GIT_OPTIONAL_LOCKS=0` (login-shell or process env) must not survive.
            cmd.env_remove("GIT_OPTIONAL_LOCKS");
        }
        let input = inv.stdin.take();
        cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // A write dropped mid-run must get SIGTERM first (git removes its locks), so its
            // stop is `DropStop`'s alone; a read may die at once.
            .kill_on_drop(inv.term_grace.is_none());
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
                return Err(GbError { kind: GbErrorKind::Io, message: redacted_err.clone(), command_id: Some(id), stderr: Some(redacted_err), detail: None });
            }
        };

        let pid = child.id();
        // If this future is dropped before the end (an app quit, an aborted task), the group
        // still stops: SIGTERM then SIGKILL for a write, SIGKILL for a read.
        let mut drop_stop = DropStop { pid, grace: inv.term_grace, armed: true };
        let stdin_task = match (input, child.stdin.take()) {
            (Some(bytes), Some(mut pipe)) => Some(tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                // git may exit without reading it all (an error): a closed pipe isn't our failure.
                let _ = pipe.write_all(&bytes).await;
                let _ = pipe.shutdown().await;
            })),
            _ => None,
        };
        // stdout and stderr are read concurrently with the wait, so neither pipe can fill up and
        // stall git, and stderr can stream line by line (progress) while git runs.
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let limit = inv.stdout_limit;
        // Told when `stdout_limit` bytes are in (never sent otherwise: a dropped sender isn't "full").
        let (full_tx, mut full_rx) = tokio::sync::oneshot::channel::<()>();
        let mut out_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            match limit {
                None => drop(stdout.read_to_end(&mut buf).await),
                Some(n) => {
                    let _ = (&mut stdout).take(n).read_to_end(&mut buf).await;
                    if buf.len() as u64 >= n {
                        let _ = full_tx.send(());
                    }
                }
            }
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
            _ = async { if (&mut full_rx).await.is_err() { std::future::pending::<()>().await } } => Outcome::Capped,
            _ = async { match inv.timeout { Some(d) => tokio::time::sleep(d).await, None => std::future::pending().await } } => Outcome::TimedOut(inv.timeout.unwrap_or_default()),
        };
        if !matches!(outcome, Outcome::Done(_)) {
            stop_group(pid, &mut child, inv.term_grace).await;
        }
        if let Some(t) = stdin_task {
            t.abort();
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
        drop_stop.armed = false;
        let stdout_bytes = stdout_bytes.ok().and_then(Result::ok).unwrap_or_default();
        let stderr_bytes = stderr_bytes.ok().and_then(Result::ok).unwrap_or_default();

        let (exit_code, stderr_text, result) = match outcome {
            Outcome::Done(Ok(status)) if (status.success() || status.code().is_some_and(|c| inv.ok_exit.contains(&c))) && !pipes_closed => {
                let msg = format!("git exited, but its output stayed open for {}s (a background process holding it); output incomplete", PIPE_GRACE.as_secs());
                (status.code(), msg.clone(), Err(GbError { command_id: Some(id), ..GbError::new(GbErrorKind::Io, msg) }))
            }
            Outcome::Done(Ok(status)) => {
                let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
                let redacted_stderr = redact(&stderr);
                let code = status.code();
                if status.success() || code.is_some_and(|c| inv.ok_exit.contains(&c)) {
                    (code, stderr.clone(), Ok(GitOutput { stdout: stdout_bytes, stderr: redacted_stderr, command_id: id }))
                } else {
                    let kind = classify_stderr(&stderr);
                    let detail = if kind == GbErrorKind::IndexLocked { index_lock_detail(&stderr) } else { None };
                    let err = GbError {
                        kind,
                        message: signing_failure(&redacted_stderr).or_else(|| first_message_line(&redacted_stderr)).unwrap_or_else(|| format!("git exited with status {}", code.unwrap_or(-1))),
                        command_id: Some(id),
                        stderr: Some(redacted_stderr),
                        detail,
                    };
                    (code, stderr, Err(err))
                }
            }
            Outcome::Done(Err(e)) => (None, e.to_string(), Err(wait_failed(id, &e))),
            Outcome::Capped => (None, String::new(), Ok(GitOutput { stdout: stdout_bytes, stderr: String::new(), command_id: id })),
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
        require_min(v)
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
fn signal_group(pid: Option<u32>, signal: nix::sys::signal::Signal) {
    if let Some(pid) = pid {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), signal);
    }
}

fn kill_group(pid: Option<u32>) {
    signal_group(pid, nix::sys::signal::Signal::SIGKILL);
}

/// Stops the process group of a run whose future was dropped unfinished. A write gets SIGTERM,
/// then SIGKILL after its grace, from a detached thread (the runtime may be going away); a read
/// gets SIGKILL at once.
struct DropStop {
    pid: Option<u32>,
    grace: Option<Duration>,
    armed: bool,
}

impl Drop for DropStop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pid = self.pid;
        match self.grace {
            Some(grace) => {
                signal_group(pid, nix::sys::signal::Signal::SIGTERM);
                let _ = std::thread::Builder::new().name("git-drop-stop".into()).spawn(move || {
                    std::thread::sleep(grace);
                    kill_group(pid);
                });
            }
            None => kill_group(pid),
        }
    }
}

/// Stops a cancelled or timed-out command's process group. A read is killed at once; a write
/// gets SIGTERM, so git removes its `.lock` files, then SIGKILL after `grace` (spec #2 §3.3).
async fn stop_group(pid: Option<u32>, child: &mut tokio::process::Child, grace: Option<Duration>) {
    if let Some(grace) = grace {
        signal_group(pid, nix::sys::signal::Signal::SIGTERM);
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            // The leader is gone, but a TERM-ignoring straggler in its group could still hold a lock.
            kill_group(pid);
            return;
        }
    }
    kill_group(pid);
    let _ = child.wait().await;
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
        .find(|l| !l.is_empty() && !l.starts_with("hint:") && !l.starts_with("From ") && !l.starts_with("Cloning into ") && !is_rebase_step(l) && crate::netops::parse_progress(l).is_none())
        .map(|l| l.trim_start_matches("fatal: ").trim_start_matches("error: ").to_string())
}

/// A rebase's `Rebasing (2/5)` counter line.
fn is_rebase_step(l: &str) -> bool {
    l.strip_prefix("Rebasing (").and_then(|r| r.strip_suffix(')')).and_then(|r| r.split_once('/')).is_some_and(|(n, m)| n.parse::<u32>().is_ok() && m.parse::<u32>().is_ok())
}

/// UX F: a commit whose signer failed. git says `gpg failed to sign the data:`, then the
/// signer's own lines: the message is both, with the signer's last line (its reason) and without
/// gpg's `[GNUPG:]` status lines. `None`: not a signing failure.
pub(crate) fn signing_failure(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr.split(['\r', '\n']).map(str::trim).collect();
    let at = lines.iter().position(|l| l.trim_end_matches(':').ends_with("failed to sign the data"))?;
    let head = lines[at].trim_start_matches("error: ").trim_end_matches(':');
    let why = lines[at + 1..].iter().take_while(|l| !l.is_empty() && !["error:", "fatal:", "hint:"].iter().any(|p| l.starts_with(p))).filter(|l| !l.starts_with("[GNUPG:]")).last();
    Some(match why {
        Some(w) => format!("{head}: {w}"),
        None => head.to_string(),
    })
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let v = s.trim().strip_prefix("git version ")?;
    let mut parts = v.split('.').map(|p| p.parse::<u32>().ok());
    let major = parts.next()??;
    let minor = parts.next()??;
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

/// `v` against the minimum (spec #3 §5: 2.40, for `update-ref` todo lines and `merge-tree
/// --write-tree --merge-base`): `GitTooOld` below it, which the UI's blocking screen shows.
pub fn require_min(v: (u32, u32, u32)) -> Result<(u32, u32, u32), GbError> {
    if v < MIN_GIT {
        return Err(GbError::new(GbErrorKind::GitTooOld, format!("git {}.{}.{} is too old; GitBolt needs {}.{} or newer", v.0, v.1, v.2, MIN_GIT.0, MIN_GIT.1)));
    }
    Ok(v)
}

/// An `index.lock` failure's lock file and its mtime now, for Remove stale lock (spec #2 §14).
/// The parse relies on English stderr: every run sets `LC_ALL=C`.
/// Other locks (`HEAD.lock`, a ref's) get no detail: only the index lock is offered.
fn index_lock_detail(stderr: &str) -> Option<crate::error::ErrorDetail> {
    const START: &str = "Unable to create '";
    let at = stderr.find(START)? + START.len();
    let end = at + stderr[at..].find("': File exists")?;
    let path = &stderr[at..end];
    if !path.ends_with("/index.lock") {
        return None;
    }
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    Some(crate::error::ErrorDetail::IndexLock { path: path.into(), mtime_ms, ino: meta.ino(), dev: meta.dev() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GbErrorKind;
    use crate::testing::{isolated_git_env, TestRepo};
    use crate::write::WriteToken;
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
        assert_eq!(first_message_line("Rebasing (1/2)\rerror: could not apply abc\n").as_deref(), Some("could not apply abc"), "a rebase's counter isn't the message");
    }

    /// UX F: a signer's failure names gpg's reason, without its status lines.
    #[test]
    fn a_signing_failure_says_why() {
        let gpg = "Rebasing (1/2)\rerror: gpg failed to sign the data:\ngpg: skipped \"ABC\": No secret key\n[GNUPG:] INV_SGNR 9 ABC\ngpg: signing failed: No secret key\n\nerror: failed to write commit object\nhint: Could not execute the todo command\n";
        assert_eq!(signing_failure(gpg).as_deref(), Some("gpg failed to sign the data: gpg: signing failed: No secret key"));
        assert_eq!(signing_failure("error: gpg failed to sign the data\nfatal: failed to write commit object\n").as_deref(), Some("gpg failed to sign the data"));
        assert_eq!(signing_failure("error: boom\n"), None);
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

    /// Spec #3 §5, §7: the startup check refuses git older than 2.40 (the old minimum, 2.30,
    /// included) with `GitTooOld`, whose message the blocking screen shows.
    #[test]
    fn refuses_git_older_than_2_40() {
        let err = require_min((2, 39, 9)).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::GitTooOld);
        assert_eq!(err.message, "git 2.39.9 is too old; GitBolt needs 2.40 or newer");
        assert!(require_min((2, 30, 0)).is_err(), "the old minimum is refused now");
        assert!(require_min((2, 38, 0)).is_err(), "2.38 lacks merge-tree --merge-base");
        assert_eq!(require_min((2, 40, 0)).unwrap(), (2, 40, 0));
        assert_eq!(require_min((3, 0, 0)).unwrap(), (3, 0, 0));
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

    /// Spec #2 §3.3: a write takes git's normal locks and never waits on an editor; a read keeps
    /// the never-write `GIT_OPTIONAL_LOCKS=0`.
    #[tokio::test]
    async fn a_write_takes_normal_locks_and_never_waits_on_an_editor() {
        let r = TestRepo::new();
        let alias = "alias.env=!printf '%s|%s|%s' \"${GIT_OPTIONAL_LOCKS-unset}\" \"$GIT_EDITOR\" \"$GIT_MERGE_AUTOEDIT\"";
        let out = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", alias, "env"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "unset|true|no");
        // An inherited GIT_OPTIONAL_LOCKS=0 doesn't survive in a write.
        let inherited = GitCli::new(Arc::new(CommandLog::new(10))).with_env([isolated_git_env(), vec![("GIT_OPTIONAL_LOCKS".into(), "0".into())]].concat());
        let out = inherited.run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", alias, "env"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "unset|true|no");
        let read = cli().run(GitInvocation::new(r.path(), ["-c", alias, "env"])).await.unwrap();
        assert!(String::from_utf8_lossy(&read.stdout).starts_with("0|"), "reads keep GIT_OPTIONAL_LOCKS=0");
        assert!(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["status"]).is_write());
        assert!(!GitInvocation::new(r.path(), ["status"]).is_write());
    }

    #[tokio::test]
    async fn stdin_reaches_git() {
        let r = TestRepo::new();
        let out = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["hash-object", "--stdin"]).stdin(b"hello\n".to_vec())).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    /// A cancelled write gets SIGTERM first, so git can remove its own `.lock` files (§3.3).
    #[tokio::test]
    async fn a_cancelled_write_gets_sigterm_first() {
        let r = TestRepo::new();
        let marker = r.root().join("got-term");
        let alias = format!("alias.slow=!trap 'touch {}; exit 143' TERM; sleep 5 & wait", marker.display());
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            t2.cancel();
        });
        let started = Instant::now();
        let err = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", alias.as_str(), "slow"]).cancel(token)).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled);
        assert!(marker.exists(), "the write's process group got SIGTERM");
        assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
    }

    /// One that ignores SIGTERM is killed anyway, after the grace.
    #[tokio::test]
    async fn a_write_that_ignores_sigterm_is_killed_after_the_grace() {
        let r = TestRepo::new();
        let marker = r.root().join("survived");
        let alias = format!("alias.stubborn=!trap '' TERM; sleep 4; touch {}", marker.display());
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            t2.cancel();
        });
        let started = Instant::now();
        let err = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", alias.as_str(), "stubborn"]).cancel(token)).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Cancelled);
        let took = started.elapsed();
        assert!(took >= WRITE_TERM_GRACE && took < Duration::from_millis(3800), "{took:?}");
        tokio::time::sleep(Duration::from_millis(4200)).await;
        assert!(!marker.exists(), "SIGKILL ended the group");
    }

    /// A write whose future is dropped mid-run (an app quit, an aborted task) still stops its
    /// whole group: SIGTERM first (git removes its locks), then SIGKILL after the grace.
    #[tokio::test]
    async fn a_dropped_write_gets_sigterm_then_sigkill() {
        let r = TestRepo::new();
        let termed = r.root().join("got-term");
        let survived = r.root().join("survived");
        let polite = format!("alias.slow=!trap 'touch {}; exit 143' TERM; sleep 5 & wait", termed.display());
        let stubborn = format!("alias.stubborn=!trap '' TERM; sleep 4; touch {}", survived.display());
        let cli = cli();
        let a = cli.run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", polite.as_str(), "slow"]));
        let b = cli.run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", stubborn.as_str(), "stubborn"]));
        assert!(tokio::time::timeout(Duration::from_millis(300), async { tokio::join!(a, b) }).await.is_err(), "both still running");
        let deadline = Instant::now() + Duration::from_secs(1);
        while !termed.exists() {
            assert!(Instant::now() < deadline, "the dropped write's group never got SIGTERM");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(4500)).await;
        assert!(!survived.exists(), "SIGKILL ended the TERM-ignoring group after the grace");
    }

    /// No editor in any write: `sequence.editor` / `core.editor` from the user's config (here an
    /// inherited GIT_SEQUENCE_EDITOR and a repo config) can't open one.
    #[tokio::test]
    async fn a_write_never_opens_a_sequence_editor() {
        let r = TestRepo::new();
        let alias = "alias.seq=!printf '%s|%s' \"$GIT_SEQUENCE_EDITOR\" \"$GIT_EDITOR\"";
        let vim = GitCli::new(Arc::new(CommandLog::new(10))).with_env([isolated_git_env(), vec![("GIT_SEQUENCE_EDITOR".into(), "vim".into())]].concat());
        let out = vim.run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", alias, "seq"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "true|true");
        let out = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", "sequence.editor=vim", "config", "sequence.editor"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "vim", "a later -c still shows; the earlier pair is the default");
        let out = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["config", "--get-all", "sequence.editor"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "true");
    }

    /// Spec #2 §14: an IndexLocked failure carries the lock and its mtime, for Remove stale lock.
    #[tokio::test]
    async fn an_index_lock_failure_names_the_lock_and_its_mtime() {
        let r = TestRepo::new();
        r.commit("c");
        let lock = r.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let err = cli().run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["update-index", "--refresh"])).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::IndexLocked);
        let mtime = std::fs::metadata(&lock).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        match err.detail {
            Some(crate::error::ErrorDetail::IndexLock { path, mtime_ms, ino, dev }) => {
                use std::os::unix::fs::MetadataExt;
                let m = std::fs::metadata(&lock).unwrap();
                assert_eq!((ino, dev), (m.ino(), m.dev()));
                assert_eq!(std::path::Path::new(&*path).canonicalize().unwrap(), lock.canonicalize().unwrap());
                assert_eq!(mtime_ms, mtime);
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn an_ok_exit_code_counts_as_success() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x"), "x\n").unwrap();
        let args = ["diff", "--no-index", "--", "/dev/null", "x"];
        assert!(cli().run(GitInvocation::new(dir.path(), args)).await.is_err(), "exit 1 is a failure by default");
        let out = cli().run(GitInvocation::new(dir.path(), args).ok_exit(1)).await.unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("+x"));
    }
}
