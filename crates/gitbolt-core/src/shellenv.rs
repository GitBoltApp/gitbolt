//! Login-shell environment capture (spec §5.3). Apps started from the desktop menu miss what the
//! user's shell setup adds (`SSH_AUTH_SOCK`, `PATH` entries, ...). We run
//! `$SHELL -l -i -c '<script>'` once, in the background, with a 5 s timeout, and use the result
//! for every git command and every editor we launch. Output before a marker line is shell noise
//! (motd, rc echo) and is ignored.
//!
//! The capture shell is a child like any other (`openers::launch_command`): GitBolt's own
//! variables (`openers::PRIVATE_ENV`) are removed and the app's [`ChildEnvHook`] runs on it, so
//! the session's values of what the app changed for itself (`GDK_BACKEND`, ...) are what the
//! shell sees and what the capture returns. `PRIVATE_ENV` is also dropped from the result, in
//! case the user's shell setup exports one itself.
//!
//! macOS: an app started from Finder or the Dock gets launchd's bare `PATH` (no Homebrew), which
//! is exactly what the capture fixes; the shell is `$SHELL` (zsh by default), else the account's
//! own login shell.
//!
//! Windows has no login shell to ask: an app started from the Start menu already has the user's
//! environment, so nothing is captured and git inherits the process environment.

use crate::openers::{ChildEnvHook, PRIVATE_ENV};
use crate::platform::process::{own_session, Group};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::OnceCell;

pub const ENV_MARKER: &str = "__GITBOLT_ENV_START__";
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// After the shell exits, how long its output may take to finish arriving.
const OUTPUT_GRACE: Duration = Duration::from_millis(300);
const SCRIPT: &str = "printf '%s\\n' __GITBOLT_ENV_START__; env -0";
const SKIP: [&[u8]; 4] = [b"PWD", b"OLDPWD", b"SHLVL", b"_"];

/// A captured environment, shared by every git command and launch that uses it.
pub type EnvVars = Arc<Vec<(OsString, OsString)>>;

pub struct ShellEnv {
    shell: Option<PathBuf>,
    timeout: Duration,
    hook: Option<ChildEnvHook>,
    cell: OnceCell<Option<EnvVars>>,
}

impl ShellEnv {
    /// `$SHELL`, or no capture at all if it isn't set.
    pub fn from_login_shell() -> Arc<Self> {
        Self::login_shell(None)
    }

    /// [`Self::from_login_shell`], with the shell started through the app's child-env hook
    /// (`desktop::restore_child_env`), so it sees the session's environment, not CEF's.
    pub fn from_login_shell_with_hook(hook: ChildEnvHook) -> Arc<Self> {
        Self::login_shell(Some(hook))
    }

    fn login_shell(hook: Option<ChildEnvHook>) -> Arc<Self> {
        // Windows: no capture (see the module docs), even with a `SHELL` from Git Bash or MSYS.
        let shell = if cfg!(unix) { std::env::var_os("SHELL").map(PathBuf::from) } else { None };
        #[cfg(target_os = "macos")]
        let shell = shell.or_else(account_shell);
        Arc::new(Self { shell, timeout: CAPTURE_TIMEOUT, hook, cell: OnceCell::new() })
    }

    pub fn with_shell(shell: PathBuf, timeout: Duration) -> Arc<Self> {
        Arc::new(Self { shell: Some(shell), timeout, hook: None, cell: OnceCell::new() })
    }

    /// [`Self::with_shell`], started through `hook` (see [`Self::from_login_shell_with_hook`]).
    pub fn with_shell_and_hook(shell: PathBuf, timeout: Duration, hook: ChildEnvHook) -> Arc<Self> {
        Arc::new(Self { shell: Some(shell), timeout, hook: Some(hook), cell: OnceCell::new() })
    }

    /// An already-known environment (tests).
    pub fn fixed(vars: Vec<(OsString, OsString)>) -> Arc<Self> {
        Arc::new(Self { shell: None, timeout: CAPTURE_TIMEOUT, hook: None, cell: OnceCell::new_with(Some(Some(Arc::new(vars)))) })
    }

    /// The captured environment, or `None` (use the app's own). The first caller runs the
    /// capture; callers that arrive meanwhile wait for it (bounded by the timeout).
    pub async fn get(&self) -> Option<Arc<Vec<(OsString, OsString)>>> {
        self.cell
            .get_or_init(|| async {
                let shell = self.shell.as_deref()?;
                let vars = capture(shell, self.timeout, self.hook.as_ref()).await;
                if vars.is_none() {
                    tracing::warn!("login shell environment not captured; git runs with GitBolt's own environment");
                }
                vars.map(Arc::new)
            })
            .await
            .clone()
    }

    /// The captured environment if the capture has finished, without waiting or starting it:
    /// for synchronous callers (the app's editor launcher) after something awaited [`Self::get`].
    pub fn captured(&self) -> Option<EnvVars> {
        self.cell.get().cloned().flatten()
    }

    /// Starts the capture in the background at startup.
    pub async fn warm(self: Arc<Self>) {
        let _ = self.get().await;
    }
}

/// The account's login shell (its directory record), for an app launched without `$SHELL`.
#[cfg(target_os = "macos")]
fn account_shell() -> Option<PathBuf> {
    nix::unistd::User::from_uid(nix::unistd::getuid()).ok().flatten().map(|u| u.shell).filter(|s| s.is_absolute())
}

async fn capture(shell: &Path, timeout: Duration, hook: Option<&ChildEnvHook>) -> Option<Vec<(OsString, OsString)>> {
    let mut cmd = tokio::process::Command::new(shell);
    cmd.args(["-l", "-i", "-c", SCRIPT]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    for var in PRIVATE_ENV {
        cmd.env_remove(var);
    }
    if let Some(hook) = hook {
        hook(cmd.as_std_mut());
    }
    // A new session, not just a process group: the shell has no controlling terminal. In a
    // background group of a terminal's session (a dev run), `-i` would make it touch the tty and
    // stop on SIGTTIN/SIGTTOU until the timeout. As a session leader its pgid is its pid, so
    // `killpg` below still reaches everything it started.
    own_session(cmd.as_std_mut());
    let mut child = match spawn(&mut cmd).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("cannot run {}: {e}", shell.display());
            return None;
        }
    };
    let group = Group::of(&child);
    let buf = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut reader = {
        let buf = buf.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            while let Ok(n @ 1..) = stdout.read(&mut chunk).await {
                buf.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
            }
        })
    };
    // Wait for the shell itself, then give its output a short grace: a background job the rc
    // files started may keep the pipe open long after the shell (and its `env -0`) are done.
    let waited = tokio::time::timeout(timeout, child.wait()).await;
    if matches!(waited, Ok(Ok(_))) {
        let _ = tokio::time::timeout(OUTPUT_GRACE, &mut reader).await;
    }
    // Dropping a JoinHandle would leave the reader running; stop it (a no-op once it's done).
    reader.abort();
    let out = std::mem::take(&mut *buf.lock().unwrap_or_else(|e| e.into_inner()));
    match waited {
        Ok(Ok(_)) => parse_env_output(&out).map(|vars| vars.into_iter().filter(|(k, _)| !PRIVATE_ENV.iter().any(|p| k == p)).collect()),
        Ok(Err(e)) => {
            tracing::warn!("login shell failed: {e}");
            None
        }
        Err(_) => {
            group.kill();
            tracing::warn!("login shell environment capture timed out after {timeout:?}");
            None
        }
    }
}

/// `cmd.spawn()`, retried briefly on `ETXTBSY`: a shell binary that was just written (an update
/// in progress, or a test's fake shell) stays "busy" while any other thread's fork still holds
/// the writer's descriptor, until that child execs.
async fn spawn(cmd: &mut tokio::process::Command) -> std::io::Result<tokio::process::Child> {
    let mut attempts = 0;
    loop {
        match cmd.spawn() {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 5 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            r => return r,
        }
    }
}

/// `env -0` output after the marker line: NUL-separated `KEY=VALUE` entries.
pub fn parse_env_output(out: &[u8]) -> Option<Vec<(OsString, OsString)>> {
    let marker = format!("{ENV_MARKER}\n");
    let start = out.windows(marker.len()).position(|w| w == marker.as_bytes())? + marker.len();
    let vars: Vec<(OsString, OsString)> = out[start..]
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let eq = entry.iter().position(|b| *b == b'=')?;
            if eq == 0 || SKIP.contains(&&entry[..eq]) {
                return None;
            }
            Some((crate::platform::osstr::from_vec(entry[..eq].to_vec()), crate::platform::osstr::from_vec(entry[eq + 1..].to_vec())))
        })
        .collect();
    (!vars.is_empty()).then_some(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)] // a #!/bin/sh fake shell
    fn fake_shell(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("fake-shell");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        crate::platform::fs::set_mode(&p, 0o755).unwrap();
        p
    }

    /// Windows: the login-shell environment is the process's own; nothing is captured, even
    /// with a `SHELL` set (Git Bash, MSYS).
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_captures_no_login_shell() {
        let env = ShellEnv::from_login_shell();
        assert!(env.get().await.is_none());
        assert!(env.captured().is_none());
    }

    fn get<'a>(vars: &'a [(OsString, OsString)], k: &str) -> Option<&'a OsString> {
        vars.iter().find(|(key, _)| key == k).map(|(_, v)| v)
    }

    #[test]
    fn parses_after_the_marker_and_drops_shell_noise() {
        let out = b"motd: welcome\nsome rc output\n__GITBOLT_ENV_START__\nA=1\0B=two\nlines\0PWD=/x\0SHLVL=3\0=bad\0";
        let vars = parse_env_output(out).unwrap();
        assert_eq!(get(&vars, "A").unwrap(), "1");
        assert_eq!(get(&vars, "B").unwrap(), "two\nlines");
        assert!(get(&vars, "PWD").is_none() && get(&vars, "SHLVL").is_none());
        assert_eq!(vars.len(), 2);
        assert!(parse_env_output(b"no marker at all").is_none());
    }

    #[cfg(unix)] // a #!/bin/sh fake shell
    #[tokio::test]
    async fn captures_from_a_shell() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "echo noise\nprintf '%s\\n' __GITBOLT_ENV_START__\nprintf 'SSH_AUTH_SOCK=/run/agent.sock\\0GB_X=y\\0'");
        let env = ShellEnv::with_shell(shell, Duration::from_secs(2));
        assert!(env.captured().is_none(), "nothing yet: the capture hasn't run");
        let vars = env.get().await.expect("captured");
        assert_eq!(get(&vars, "SSH_AUTH_SOCK").unwrap(), "/run/agent.sock");
        // Captured once: a second get returns the same Arc, and so does the non-waiting read.
        assert!(Arc::ptr_eq(&vars, &env.get().await.unwrap()));
        assert!(Arc::ptr_eq(&vars, &env.captured().unwrap()));
        assert!(ShellEnv::with_shell("/nonexistent/shell".into(), Duration::from_secs(1)).captured().is_none());
    }

    #[cfg(unix)] // a #!/bin/sh fake shell
    #[tokio::test]
    async fn a_hanging_shell_times_out_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "sleep 5");
        let started = std::time::Instant::now();
        assert!(ShellEnv::with_shell(shell, Duration::from_millis(200)).get().await.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn a_missing_shell_is_none() {
        assert!(ShellEnv::with_shell("/nonexistent/shell".into(), Duration::from_secs(1)).get().await.is_none());
    }

    /// The capture shell inherits the app's own environment, so it starts like any other child
    /// (`openers::launch_command`): the app's hook runs on it (the session's `GDK_BACKEND` and
    /// `IBUS_ENABLE_SYNC_MODE` back, not CEF's), and what it prints is what git and editors get.
    #[cfg(unix)] // a #!/bin/sh fake shell
    #[tokio::test]
    async fn the_capture_shell_starts_through_the_child_env_hook() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "printf '%s\\n' __GITBOLT_ENV_START__\nprintf 'GB_HOOKED=%s\\0GB_GONE=%s\\0' \"$GB_HOOKED\" \"${GB_GONE-unset}\"");
        let hook: ChildEnvHook = Arc::new(|cmd: &mut std::process::Command| {
            cmd.env("GB_HOOKED", "yes").env_remove("GB_GONE");
        });
        let vars = ShellEnv::with_shell_and_hook(shell, Duration::from_secs(2), hook).get().await.expect("captured");
        assert_eq!(get(&vars, "GB_HOOKED").unwrap(), "yes");
        assert_eq!(get(&vars, "GB_GONE").unwrap(), "unset");
    }

    /// I2: GitBolt's own variables (`openers::PRIVATE_ENV`) never come back through the captured
    /// env, even if the user's shell setup exports them itself: the captured env is what editors
    /// start with, after `launch_command` has already stripped them.
    #[cfg(unix)] // a #!/bin/sh fake shell
    #[tokio::test]
    async fn private_app_env_is_dropped_from_the_capture() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "printf '%s\\n' __GITBOLT_ENV_START__\nprintf 'CHROME_DEVEL_SANDBOX=/leak\\0GITBOLT_OPEN=/leak\\0GB_KEEP=1\\0'");
        let vars = ShellEnv::with_shell(shell, Duration::from_secs(2)).get().await.expect("captured");
        assert!(get(&vars, "CHROME_DEVEL_SANDBOX").is_none() && get(&vars, "GITBOLT_OPEN").is_none());
        assert_eq!(get(&vars, "GB_KEEP").unwrap(), "1");
    }

    /// The capture shell leads a new session, so it has no controlling terminal. Otherwise, in a
    /// dev run from a terminal, an interactive shell in a background process group gets SIGTTIN
    /// (or SIGTTOU) when it touches the tty and stops, and every git command waits the full
    /// timeout. CI has no controlling tty to reproduce that stop, so this checks the mechanism:
    /// the shell's session id is its own pid (`/proc/<pid>/stat` field 6).
    #[cfg(target_os = "linux")] // the session id from /proc
    #[tokio::test]
    async fn the_capture_shell_leads_its_own_session() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(
            dir.path(),
            "printf '%s\\n' __GITBOLT_ENV_START__\nprintf 'GB_PID=%s\\0GB_SID=%s\\0' \"$$\" \"$(awk '{print $6}' /proc/$$/stat)\"",
        );
        let vars = ShellEnv::with_shell(shell, Duration::from_secs(2)).get().await.expect("captured");
        assert_eq!(get(&vars, "GB_SID").unwrap(), get(&vars, "GB_PID").unwrap());
    }

    /// A real shell and the system's own `env -0` (BSD's on macOS): the capture parses.
    #[cfg(unix)]
    #[tokio::test]
    async fn captures_from_the_system_shell() {
        let vars = ShellEnv::with_shell("/bin/sh".into(), Duration::from_secs(5)).get().await.expect("captured");
        assert!(get(&vars, "PATH").is_some_and(|p| !p.is_empty()), "no PATH in the captured environment");
    }

    /// The account's own shell stands in for a missing `$SHELL` (an app started from the Dock).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_account_shell_is_known() {
        assert!(account_shell().is_some_and(|s| s.is_file()));
    }

    /// A background job the rc files started that keeps the shell's stdout open doesn't stall
    /// the capture: once the shell exits, its output is read with a short grace.
    #[cfg(unix)] // a #!/bin/sh fake shell
    #[tokio::test]
    async fn a_background_job_holding_stdout_does_not_stall_the_capture() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "sleep 3 &\nprintf '%s\\n' __GITBOLT_ENV_START__\nprintf 'GB_X=y\\0'");
        let started = std::time::Instant::now();
        let vars = ShellEnv::with_shell(shell, Duration::from_secs(2)).get().await.expect("captured");
        assert_eq!(get(&vars, "GB_X").unwrap(), "y");
        assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
    }

    /// Concurrent callers share the one capture.
    #[cfg(unix)] // a #!/bin/sh fake shell
    #[tokio::test]
    async fn concurrent_callers_wait_for_the_one_capture() {
        let dir = tempfile::tempdir().unwrap();
        let count = dir.path().join("runs");
        let shell = fake_shell(
            dir.path(),
            &format!("echo x >> '{}'\nsleep 0.2\nprintf '%s\\n' __GITBOLT_ENV_START__\nprintf 'GB_X=y\\0'", crate::platform::fs::to_git_path(&count)),
        );
        let env = ShellEnv::with_shell(shell, Duration::from_secs(2));
        let (a, b) = tokio::join!(env.get(), env.get());
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
        assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    }
}
