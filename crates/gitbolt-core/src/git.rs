//! The single runner for every git CLI invocation.

use crate::error::{classify_stderr, GbError, GbErrorKind};
use crate::log::{truncate_utf8, CommandLog, CommandLogEntry, STDERR_LOG_LIMIT};
use crate::redact::redact;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub use tokio_util::sync::CancellationToken;

pub const MIN_GIT: (u32, u32, u32) = (2, 30, 0);
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct GitCli {
    bin: PathBuf,
    env: Arc<Vec<(OsString, OsString)>>,
    hook: Option<CommandHook>,
    log: Arc<CommandLog>,
}

/// Adjusts every command just before it starts, after the runner's own environment: the app
/// uses it to give children the session's values of what it changed for itself.
pub type CommandHook = Arc<dyn Fn(&mut std::process::Command) + Send + Sync>;

pub struct GitInvocation {
    cwd: PathBuf,
    args: Vec<OsString>,
    timeout: Option<Duration>,
    cancel: Option<CancellationToken>,
}

impl GitInvocation {
    pub fn new<I, S>(cwd: impl Into<PathBuf>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self { cwd: cwd.into(), args: args.into_iter().map(Into::into).collect(), timeout: Some(LOCAL_TIMEOUT), cancel: None }
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
}

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub command_id: u64,
}

enum Outcome {
    Done(std::io::Result<std::process::Output>),
    Cancelled,
    TimedOut(Duration),
}

impl GitCli {
    pub fn new(log: Arc<CommandLog>) -> Self {
        Self { bin: PathBuf::from("git"), env: Arc::new(Vec::new()), hook: None, log }
    }

    /// Extra environment for every command (e.g. the captured login-shell env, or test isolation).
    pub fn with_env(mut self, env: Vec<(OsString, OsString)>) -> Self {
        self.env = Arc::new(env);
        self
    }

    /// See [`CommandHook`].
    pub fn with_command_hook(mut self, hook: CommandHook) -> Self {
        self.hook = Some(hook);
        self
    }

    pub fn log(&self) -> &Arc<CommandLog> {
        &self.log
    }

    pub async fn run(&self, inv: GitInvocation) -> Result<GitOutput, GbError> {
        let id = self.log.next_id();
        let started = Instant::now();
        let started_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);

        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.current_dir(&inv.cwd)
            .arg("--no-pager")
            .args(["-c", "core.quotepath=false"])
            .args(&inv.args)
            .envs(self.env.iter().map(|(k, v)| (k, v)))
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
        if let Some(hook) = &self.hook {
            hook(cmd.as_std_mut());
        }

        // Set process group for Unix platforms
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().process_group(0);
        }

        let child = match cmd.spawn() {
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
                return Err(GbError { kind: GbErrorKind::Io, message: err_msg, command_id: Some(id), stderr: Some(redacted_err) });
            }
        };

        let pid = child.id();
        let cancel = inv.cancel.clone();
        let outcome = tokio::select! {
            r = child.wait_with_output() => Outcome::Done(r),
            _ = async { match &cancel { Some(t) => t.cancelled().await, None => std::future::pending().await } } => Outcome::Cancelled,
            _ = async { match inv.timeout { Some(d) => tokio::time::sleep(d).await, None => std::future::pending().await } } => Outcome::TimedOut(inv.timeout.unwrap_or_default()),
        };
        if !matches!(outcome, Outcome::Done(_)) {
            kill_group(pid);
        }

        let (exit_code, stderr_text, result) = match outcome {
            Outcome::Done(Ok(out)) => {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                let redacted_stderr = redact(&stderr);
                let code = out.status.code();
                if out.status.success() {
                    (code, stderr.clone(), Ok(GitOutput { stdout: out.stdout, stderr: redacted_stderr, command_id: id }))
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
    GbError { command_id: Some(id), ..GbError::new(GbErrorKind::Io, format!("git failed: {e}")) }
}

fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGKILL);
    }
}

fn first_message_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("hint:"))
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
}
