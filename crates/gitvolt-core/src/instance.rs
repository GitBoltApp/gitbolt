//! Single-instance guard (1D ruling R19; the 1C final review's I2 follow-up: two instances on one
//! config dir would each write its settings over the other's).
//!
//! One GitVolt runs per config dir. The first to start holds an exclusive `flock` on
//! `<runtime dir>/gitvolt-instance-<key>.lock` for its whole life and listens on
//! `<runtime dir>/gitvolt-instance-<key>.sock` (mode `0600`), where `<key>` is a hash of
//! [`paths::config_dir`](crate::paths::config_dir). A later launch on the same config dir finds
//! the lock taken, sends its launch path (argv or `GITVOLT_OPEN`, made absolute against its own
//! working directory) over the socket and exits 0; the first one opens that path in a tab and
//! brings its window to the front. An instance with a throwaway `XDG_CONFIG_HOME` (the askpass
//! test in `docs/dev-setup.md`, verification runs) has its own key, so it still starts.
//!
//! The kernel drops the lock when its holder dies, however it dies, so a socket file left
//! behind by a crashed instance is stale exactly when the lock is free: the next launch takes
//! the lock, removes it and binds its own. The lock file itself is never removed (removing a
//! `flock`ed file lets two processes each lock a different inode).
//!
//! `GITVOLT_MULTI_INSTANCE=1` turns the guard off. If the guard can't be set up (no runtime dir,
//! an unbindable socket, a holder that never answers) the app runs unguarded rather than not at
//! all.
//!
//! GitBolt (the app's name before 0.7.0) had the same guard under its own names
//! (`legacy::INSTANCE_NAME`, keyed by its own config folder). While it runs, its folders can't
//! move to GitVolt's, so [`claim_from_env`] first hands the launch to a running GitBolt; one that
//! holds its lock but doesn't answer stops the launch ([`Claim::Refused`]).
//!
//! The socket is distinct from the askpass one (`gitvolt-askpass-<pid>-<rand>.sock`), and the
//! check runs after `askpass::run_client_from_env` in `main`, so git running GitVolt as its
//! askpass never reaches it.
//!
//! Windows: the "socket" is the named pipe `\\.\pipe\gitvolt-instance-<key>.sock`, private to
//! this user (see [`crate::platform::ipc`]); the lock is a `LockFileEx` lock on the same file.
//! A pipe goes away with its last handle, so a crash leaves nothing stale behind.

use crate::platform::ipc;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

/// Set (to anything but `0` or empty) to run without the guard, and without the check for a
/// running GitBolt (that start moves no folders: `migrate::run` is for guarded starts). An unguarded instance isn't
/// seen by a guarded start's folder move: a retry may set its folder aside while it runs.
pub const ENV_MULTI: &str = "GITVOLT_MULTI_INSTANCE";
/// How long a later launch keeps trying while the lock is held but nothing answers yet: the
/// holder is between taking the lock and binding (microseconds), or is exiting (it removes its
/// socket first, then the lock goes with the process).
const CONNECT_PATIENCE: Duration = Duration::from_secs(3);
const RETRY: Duration = Duration::from_millis(25);
/// How long a launch waits for a GitBolt that holds its lock and doesn't answer: it may be
/// quitting (Chromium's shutdown after Restart, or after it started the installer).
const LEGACY_PATIENCE: Duration = Duration::from_secs(10);
/// How long a forwarding launch waits for the first instance's acknowledgement. The request is
/// already queued in the socket by then, so a slow (still starting) first instance gets it anyway.
const ACK_WAIT: Duration = Duration::from_secs(2);
/// The longest request line read (one path; this only bounds a bad client).
const MAX_LINE: u64 = 64 * 1024;
const ACCEPT_BACKOFF_MIN: Duration = Duration::from_millis(100);
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(5);

/// What a later launch sends: its launch path, absolute, if it had one.
#[derive(Debug, Serialize, Deserialize)]
struct OpenRequest {
    path: Option<String>,
}

/// The outcome of [`claim`].
#[derive(Debug)]
pub enum Claim {
    /// This process is the instance for its config dir: keep it for the process's life and
    /// [`Primary::serve`] it once there's an async runtime.
    Primary(Primary),
    /// The running instance has this launch's path: exit 0.
    Forwarded,
    /// Run without the guard: the escape hatch (`None`), or why the guard couldn't be set up.
    Unguarded(Option<String>),
    /// GitBolt holds its folders but doesn't answer: don't start. Why.
    Refused(String),
}

/// The lock (held while this lives) and the bound socket of the first instance.
#[derive(Debug)]
pub struct Primary {
    _lock: File,
    socket: PathBuf,
    listener: Mutex<Option<ipc::Listener>>,
    accept: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The lock and socket's name: `gitvolt-instance-<key>`.
const NAME: &str = "gitvolt-instance";

/// `<dir>/gitvolt-instance-<key>.lock` and `.sock`, `<key>` the 64-bit FNV-1a hash of
/// `config_dir`'s components (so `a//b/` and `a/b` are one key) as 16 hex digits. Not a
/// security boundary (the runtime dir is this user's, `0700`): only a short, stable name. On
/// Windows, whose paths are case-insensitive, ASCII case doesn't change the key either, and the
/// `.sock` is a pipe name ([`ipc::endpoint`]).
pub fn instance_paths(runtime_dir: &Path, config_dir: &Path) -> (PathBuf, PathBuf) {
    instance_paths_named(NAME, runtime_dir, config_dir)
}

/// [`instance_paths`] under another name (GitBolt's: `legacy::INSTANCE_NAME`).
fn instance_paths_named(name: &str, runtime_dir: &Path, config_dir: &Path) -> (PathBuf, PathBuf) {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for comp in config_dir.components() {
        for b in comp.as_os_str().as_encoded_bytes().iter().chain(b"/") {
            let b = if cfg!(windows) { b.to_ascii_lowercase() } else { *b };
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    let stem = format!("{name}-{hash:016x}");
    (runtime_dir.join(format!("{stem}.lock")), ipc::endpoint(runtime_dir, &format!("{stem}.sock")))
}

/// [`claim`] for this process: first a running GitBolt takes the launch ([`forward_to_legacy`];
/// skipped when [`ENV_MULTI`] is set, since that start moves no folders either); then the guard is
/// off when [`ENV_MULTI`] is set; otherwise it's keyed by
/// [`paths::config_dir`](crate::paths::config_dir) in [`paths::runtime_dir`](crate::paths::runtime_dir).
/// A refusal is also written to [`refused_file`], since a dock or menu launch has no stderr.
pub fn claim_from_env(launch: Option<&str>) -> Claim {
    let multi = std::env::var_os(ENV_MULTI);
    let off = multi.as_deref().is_some_and(|v| !v.is_empty() && v != "0");
    if let Some(claim) = legacy_gate(&crate::legacy::runtime_dir(), &crate::legacy::config_dir(), launch, LEGACY_PATIENCE, &refused_file(), off) {
        return claim;
    }
    guard(multi.as_deref(), crate::paths::runtime_dir, &crate::paths::config_dir(), launch)
}

/// Why the last start was refused, overwritten each time and removed by the next start that isn't.
/// In the temp dir, not GitVolt's folders: creating one of those would stop `migrate` moving
/// GitBolt's.
pub fn refused_file() -> PathBuf {
    std::env::temp_dir().join(format!("gitvolt-refused-start-{}.txt", crate::platform::fs::user_tag()))
}

/// What GitBolt's guard says about this start: `Some` when it ends here. `off`: no check.
fn legacy_gate(runtime_dir: &Path, legacy_config_dir: &Path, launch: Option<&str>, patience: Duration, refused: &Path, off: bool) -> Option<Claim> {
    if off {
        return None;
    }
    match forward_to_legacy(runtime_dir, legacy_config_dir, launch, patience) {
        found @ (Legacy::NotRunning | Legacy::Forwarded) => {
            if refused.exists() {
                let _ = std::fs::remove_file(refused);
            }
            (found == Legacy::Forwarded).then_some(Claim::Forwarded)
        }
        Legacy::Unreachable(why) => {
            if let Err(e) = write_private(refused, &why) {
                tracing::warn!("couldn't write {}: {e}", refused.display());
            }
            Some(Claim::Refused(why))
        }
    }
}

/// `text` in a new private file at `path`: an old one (or a link planted there) is removed first.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut f = crate::platform::fs::private_file(std::fs::OpenOptions::new().write(true).create_new(true)).open(path)?;
    writeln!(f, "{text}")
}

/// The escape hatch, then [`claim`] in the runtime dir `runtime_dir()` names.
fn guard(multi: Option<&OsStr>, runtime_dir: impl FnOnce() -> std::io::Result<PathBuf>, config_dir: &Path, launch: Option<&str>) -> Claim {
    if multi.is_some_and(|v| !v.is_empty() && v != "0") {
        return Claim::Unguarded(None);
    }
    match runtime_dir() {
        Ok(dir) => claim(&dir, config_dir, launch),
        Err(e) => Claim::Unguarded(Some(format!("no runtime dir: {e}"))),
    }
}

/// Becomes the instance for `config_dir` (lock + socket in `runtime_dir`), or hands `launch`
/// (made absolute against this process's working directory) to the one that already is. A
/// launch "path" that looks like a flag (`-…`) isn't forwarded: that launch only focuses.
pub fn claim(runtime_dir: &Path, config_dir: &Path, launch: Option<&str>) -> Claim {
    claim_within(runtime_dir, config_dir, launch, CONNECT_PATIENCE)
}

/// [`claim`], waiting at most `patience` for a lock holder to answer.
fn claim_within(runtime_dir: &Path, config_dir: &Path, launch: Option<&str>, patience: Duration) -> Claim {
    claim_named(NAME, runtime_dir, config_dir, launch, patience)
}

/// [`claim_within`] under another name (a test plays GitBolt with it).
fn claim_named(name: &str, runtime_dir: &Path, config_dir: &Path, launch: Option<&str>, patience: Duration) -> Claim {
    let (lock_path, socket) = instance_paths_named(name, runtime_dir, config_dir);
    let lock = match open_lock(&lock_path) {
        Ok(f) => f,
        Err(e) => return Claim::Unguarded(Some(format!("can't open {}: {e}", lock_path.display()))),
    };
    let path = absolute_launch(launch);
    let deadline = Instant::now() + patience;
    loop {
        match lock.try_lock() {
            Ok(()) => return become_primary(lock, socket),
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(e)) => return Claim::Unguarded(Some(format!("can't lock {}: {e}", lock_path.display()))),
        }
        if let Ok(stream) = ipc::connect(&socket) {
            forward(stream, &OpenRequest { path: path.clone() });
            return Claim::Forwarded;
        }
        if Instant::now() >= deadline {
            return Claim::Unguarded(Some(format!("another instance holds {} but doesn't answer on {}", lock_path.display(), socket.display())));
        }
        std::thread::sleep(RETRY);
    }
}

/// A launch path made absolute against this process's working directory; none for a flag (`-…`).
fn absolute_launch(launch: Option<&str>) -> Option<String> {
    launch.filter(|p| !p.is_empty() && !p.starts_with('-')).map(|p| std::path::absolute(p).map(|a| a.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string()))
}

/// What GitBolt's own guard says about it.
#[derive(Debug, PartialEq, Eq)]
pub enum Legacy {
    NotRunning,
    /// It runs and has this launch's path.
    Forwarded,
    /// It holds its lock but doesn't answer. Why, for the user.
    Unreachable(String),
}

/// GitBolt running on `legacy_config_dir` (its lock in `runtime_dir` held): `launch` goes to it,
/// as to a running GitVolt. Its lock file is only opened, never created, so a machine that never
/// ran GitBolt gets nothing new; a free lock is taken for a moment and let go.
pub fn forward_to_legacy(runtime_dir: &Path, legacy_config_dir: &Path, launch: Option<&str>, patience: Duration) -> Legacy {
    let (lock_path, socket) = instance_paths_named(crate::legacy::INSTANCE_NAME, runtime_dir, legacy_config_dir);
    let Ok(lock) = std::fs::OpenOptions::new().read(true).write(true).open(&lock_path) else { return Legacy::NotRunning };
    let path = absolute_launch(launch);
    let deadline = Instant::now() + patience;
    loop {
        match lock.try_lock() {
            Ok(()) => return Legacy::NotRunning,
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(_)) => return Legacy::NotRunning,
        }
        if let Ok(stream) = ipc::connect(&socket) {
            forward(stream, &OpenRequest { path: path.clone() });
            return Legacy::Forwarded;
        }
        if Instant::now() >= deadline {
            return Legacy::Unreachable(format!("GitBolt is running (it holds {}) but doesn't answer: quit it, then start GitVolt again", lock_path.display()));
        }
        std::thread::sleep(RETRY);
    }
}

/// GitBolt is running on `legacy_config_dir`: its lock in `runtime_dir` exists and is held. Only
/// looked at: the lock file is opened, never created, and a free one is let go at once.
pub fn legacy_running_at(runtime_dir: &Path, legacy_config_dir: &Path) -> bool {
    let (lock_path, _) = instance_paths_named(crate::legacy::INSTANCE_NAME, runtime_dir, legacy_config_dir);
    let Ok(lock) = std::fs::OpenOptions::new().read(true).write(true).open(lock_path) else { return false };
    matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

/// [`legacy_running_at`] for GitBolt's own folders.
pub fn legacy_running() -> bool {
    legacy_running_at(&crate::legacy::runtime_dir(), &crate::legacy::config_dir())
}

fn open_lock(path: &Path) -> std::io::Result<File> {
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("/")))?;
    crate::platform::fs::private_file(std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)).open(path)
}

/// With the lock held, any socket file there is a dead instance's: replace it with ours.
fn become_primary(lock: File, socket: PathBuf) -> Claim {
    ipc::remove(&socket);
    match ipc::Listener::bind(&socket) {
        Ok(listener) => Claim::Primary(Primary { _lock: lock, socket, listener: Mutex::new(Some(listener)), accept: Mutex::new(None) }),
        Err(e) => Claim::Unguarded(Some(format!("can't listen on {}: {e}", socket.display()))),
    }
}

/// Sends the request and waits (briefly) for the acknowledgement. Errors are ignored: the
/// request is queued in the socket once written, and a dead peer can't be helped either way.
fn forward(mut stream: ipc::Client, req: &OpenRequest) {
    let send = || -> std::io::Result<()> {
        let mut line = serde_json::to_string(req)?;
        line.push('\n');
        stream.write_all(line.as_bytes())?;
        stream.read_line_within(Some(ACK_WAIT))?;
        Ok(())
    };
    if let Err(e) = send() {
        eprintln!("gitvolt: forwarding to the running instance: {e}");
    }
}

impl Primary {
    /// The socket later launches connect to.
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// Starts answering later launches (call once, inside a tokio runtime): each one's launch
    /// path (absolute, `None` if it had none) goes to `on_request`, which runs on the runtime.
    /// Only this user's processes are answered (`SO_PEERCRED`; the socket is `0600` anyway).
    pub fn serve(&self, on_request: impl Fn(Option<String>) + Send + Sync + 'static) -> std::io::Result<()> {
        let Some(listener) = self.listener.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return Err(std::io::Error::other("already serving"));
        };
        let mut listener = listener.into_async()?;
        let on_request = std::sync::Arc::new(on_request);
        let task = tokio::spawn(async move {
            // EMFILE and friends: back off (100 ms, doubling up to 5 s) rather than spin or flood
            // the log; the listener stays up, and the first success resets it.
            let mut backoff = ACCEPT_BACKOFF_MIN;
            loop {
                let stream = match listener.accept().await {
                    Ok(stream) => {
                        backoff = ACCEPT_BACKOFF_MIN;
                        stream
                    }
                    Err(e) => {
                        tracing::warn!("instance socket accept failed: {e}; retrying in {backoff:?}");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(ACCEPT_BACKOFF_MAX);
                        continue;
                    }
                };
                let on_request = on_request.clone();
                tokio::spawn(async move {
                    if !stream.from_this_user() {
                        tracing::warn!("instance socket: refused a connection from another user");
                        return;
                    }
                    let (read, mut write) = stream.into_split();
                    let mut line = String::new();
                    if tokio::io::BufReader::new(read.take(MAX_LINE)).read_line(&mut line).await.is_err() {
                        return;
                    }
                    match serde_json::from_str::<OpenRequest>(line.trim()) {
                        Ok(req) => {
                            on_request(req.path);
                            let _ = write.write_all(b"{\"ok\":true}\n").await;
                        }
                        Err(e) => tracing::warn!("instance socket: bad request: {e}"),
                    }
                });
            }
        });
        *self.accept.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        Ok(())
    }

    /// Stops answering and removes the socket (at app exit; also on drop). The lock stays held
    /// until the process (or this value) goes, so a launch in between waits for it to free up
    /// and then becomes the instance itself.
    pub fn close(&self) {
        if let Some(task) = self.accept.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
        self.listener.lock().unwrap_or_else(|e| e.into_inner()).take();
        ipc::remove(&self.socket);
    }
}

impl Drop for Primary {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn primary(c: Claim) -> Primary {
        match c {
            Claim::Primary(p) => p,
            other => panic!("expected the first instance, got {other:?}"),
        }
    }

    /// Serves `p`, collecting every forwarded launch path.
    fn collect(p: &Primary) -> mpsc::UnboundedReceiver<Option<String>> {
        let (tx, rx) = mpsc::unbounded_channel();
        p.serve(move |path| {
            let _ = tx.send(path);
        })
        .unwrap();
        rx
    }

    /// `claim` blocks (it may wait for a starting holder), so tests run it off the runtime.
    async fn claim_async(rt: &Path, cfg: &Path, launch: Option<&str>) -> Claim {
        let (rt, cfg, launch) = (rt.to_path_buf(), cfg.to_path_buf(), launch.map(str::to_string));
        tokio::task::spawn_blocking(move || claim(&rt, &cfg, launch.as_deref())).await.unwrap()
    }

    /// An absolute launch path as the platform spells it (`/x` on Unix, `C:\x` on Windows).
    fn abs(p: &str) -> String {
        std::path::absolute(p).unwrap().to_string_lossy().into_owned()
    }

    async fn recv(rx: &mut mpsc::UnboundedReceiver<Option<String>>) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("a forwarded request").expect("channel open")
    }

    #[tokio::test]
    async fn the_first_instance_wins_and_a_second_forwards_its_path() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("config/gitvolt");
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        #[cfg(unix)]
        {
            assert_eq!(crate::platform::fs::mode(&std::fs::metadata(first.socket_path()).unwrap()) & 0o777, 0o600);
        }
        let mut got = collect(&first);
        assert!(matches!(claim_async(rt.path(), &cfg, Some(&abs("/some/repo"))).await, Claim::Forwarded));
        assert_eq!(recv(&mut got).await.as_deref(), Some(abs("/some/repo").as_str()));
        assert!(matches!(claim_async(rt.path(), &cfg, None).await, Claim::Forwarded), "a pathless launch only focuses");
        assert_eq!(recv(&mut got).await, None);
    }

    #[tokio::test]
    async fn a_relative_launch_path_is_made_absolute_by_the_launching_process() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        let mut got = collect(&first);
        assert!(matches!(claim_async(rt.path(), &cfg, Some("rel/repo")).await, Claim::Forwarded));
        let want = std::env::current_dir().unwrap().join("rel/repo");
        // As paths: Windows spells it with `\`.
        assert_eq!(recv(&mut got).await.as_deref().map(Path::new), Some(want.as_path()));
    }

    /// Not on macOS: its peer credentials (`LOCAL_PEERCRED`) are only readable while the peer is
    /// connected, and this one gave up waiting for its ack before the instance served, so the
    /// user check refuses it there.
    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn a_request_sent_before_the_first_instance_serves_is_answered_once_it_does() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        // The first instance is still starting (no `serve` yet): the request queues in the socket.
        assert!(matches!(claim_async(rt.path(), &cfg, Some(&abs("/early"))).await, Claim::Forwarded));
        let mut got = collect(&first);
        assert_eq!(recv(&mut got).await.as_deref(), Some(abs("/early").as_str()));
    }

    /// Unix only: a crashed instance's pipe goes with it on Windows; nothing stale is left.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_socket_from_a_crashed_instance_is_taken_over() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let (_, socket) = instance_paths(rt.path(), &cfg);
        // A crash leaves the socket file (nobody listening) and frees the lock.
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert!(socket.exists());
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        let mut got = collect(&first);
        assert!(matches!(claim_async(rt.path(), &cfg, Some("/r")).await, Claim::Forwarded));
        assert_eq!(recv(&mut got).await.as_deref(), Some("/r"));
    }

    #[tokio::test]
    async fn a_closed_instance_lets_the_next_launch_take_over() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        let socket = first.socket_path().to_path_buf();
        drop(first);
        assert!(!socket.exists(), "closing removes the socket");
        let _second = primary(claim_async(rt.path(), &cfg, None).await);
    }

    #[tokio::test]
    async fn different_config_dirs_dont_collide() {
        let rt = tempfile::tempdir().unwrap();
        let a = primary(claim_async(rt.path(), &rt.path().join("a/gitvolt"), None).await);
        let b = primary(claim_async(rt.path(), &rt.path().join("b/gitvolt"), None).await);
        assert_ne!(a.socket_path(), b.socket_path());
    }

    #[test]
    fn the_key_is_stable_and_ignores_spelling_differences() {
        let rt = Path::new("/run/user/1");
        let (lock, sock) = instance_paths(rt, Path::new("/home/u/.config/gitvolt"));
        assert_eq!(instance_paths(rt, Path::new("/home/u//.config/gitvolt/")), (lock.clone(), sock.clone()));
        assert_ne!(instance_paths(rt, Path::new("/tmp/x/gitvolt")).1, sock);
        let name = sock.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("gitvolt-instance-") && name.ends_with(".sock") && !name.contains("askpass"), "{name}");
        assert_eq!(lock.file_name().unwrap().to_str().unwrap(), name.replace(".sock", ".lock"));
        #[cfg(unix)]
        assert_eq!(lock.with_extension("sock"), sock);
    }

    /// Windows paths are case-insensitive: so is the key there.
    #[cfg(windows)]
    #[test]
    fn the_key_ignores_case_on_windows() {
        let rt = Path::new(r"C:\Users\u\AppData\Local\Temp\gitvolt-u");
        assert_eq!(instance_paths(rt, Path::new(r"C:\Users\U\AppData\Roaming\gitvolt")), instance_paths(rt, Path::new(r"c:\users\u\appdata\roaming\GitVolt")));
        assert_eq!(instance_paths(rt, Path::new(r"C:\Users\U\AppData\Roaming\gitvolt")), instance_paths(rt, Path::new("C:/Users/U/AppData/Roaming/gitvolt/")));
    }

    #[test]
    fn the_env_escape_hatch_turns_the_guard_off() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let never = || -> std::io::Result<PathBuf> { panic!("the runtime dir isn't even looked up") };
        assert!(matches!(guard(Some(OsStr::new("1")), never, &cfg, None), Claim::Unguarded(None)));
        let _first = primary(guard(None, || Ok(rt.path().to_path_buf()), &cfg, None));
        let _also = primary(guard(Some(OsStr::new("0")), || Ok(rt.path().to_path_buf()), &cfg.join("other"), None));
        assert!(matches!(guard(Some(OsStr::new("1")), || Ok(rt.path().to_path_buf()), &cfg, None), Claim::Unguarded(None)), "runs alongside the first");
        assert!(matches!(guard(None, || Err(std::io::Error::other("none")), &cfg, None), Claim::Unguarded(Some(_))));
    }

    #[test]
    fn a_holder_that_never_answers_leaves_the_launch_unguarded() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let (lock_path, _) = instance_paths(rt.path(), &cfg);
        let held = open_lock(&lock_path).unwrap();
        held.try_lock().unwrap();
        // Lock held, no socket at all: after its patience the launch runs on its own.
        assert!(matches!(claim_within(rt.path(), &cfg, None, Duration::from_millis(200)), Claim::Unguarded(Some(_))));
    }

    /// Unix only: a named pipe can't be deleted from under its server.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_serving_instance_whose_socket_was_deleted_leaves_later_launches_unguarded() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        let _got = collect(&first);
        std::fs::remove_file(first.socket_path()).unwrap(); // a tmp cleaner, a manual rm
        let (rtp, cfgp) = (rt.path().to_path_buf(), cfg.clone());
        let later = tokio::task::spawn_blocking(move || claim_within(&rtp, &cfgp, None, Duration::from_millis(200))).await.unwrap();
        assert!(matches!(later, Claim::Unguarded(Some(_))), "{later:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn simultaneous_first_launches_make_exactly_one_instance() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|i| {
                let (rt, cfg, barrier) = (rt.path().to_path_buf(), cfg.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    claim(&rt, &cfg, Some(&format!("/r{i}")))
                })
            })
            .collect();
        // Every claim has returned (the forwarders after their ack wait) before any is dropped,
        // so the one first instance holds the lock throughout.
        let claims: Vec<Claim> = launches.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(claims.iter().filter(|c| matches!(c, Claim::Primary(_))).count(), 1, "{claims:?}");
        assert_eq!(claims.iter().filter(|c| matches!(c, Claim::Forwarded)).count(), 7, "{claims:?}");
        // The forwarded paths are all waiting in the one instance's socket. (Not on macOS: their
        // senders are gone, and so are their peer credentials; see the test above.)
        #[cfg(not(target_os = "macos"))]
        {
            let first = claims.into_iter().find_map(|c| if let Claim::Primary(p) = c { Some(p) } else { None }).unwrap();
            let mut got = collect(&first);
            let mut paths = Vec::new();
            for _ in 0..7 {
                paths.push(recv(&mut got).await.unwrap());
            }
            assert_eq!(paths.len(), 7);
        }
    }

    #[tokio::test]
    async fn a_flag_like_argument_isnt_forwarded_as_a_path() {
        let rt = tempfile::tempdir().unwrap();
        let cfg = rt.path().join("cfg");
        let first = primary(claim_async(rt.path(), &cfg, None).await);
        let mut got = collect(&first);
        assert!(matches!(claim_async(rt.path(), &cfg, Some("--foo")).await, Claim::Forwarded));
        assert_eq!(recv(&mut got).await, None, "only focuses");
    }

    #[test]
    fn gitbolt_running_is_its_lock_being_held() {
        let (rt, old) = (tempfile::tempdir().unwrap(), std::path::PathBuf::from("/fake/gitbolt-config"));
        assert!(!legacy_running_at(rt.path(), &old), "no lock file");
        let (lock_path, _) = instance_paths_named(crate::legacy::INSTANCE_NAME, rt.path(), &old);
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path).unwrap();
        assert!(!legacy_running_at(rt.path(), &old), "a free lock");
        file.lock().unwrap();
        assert!(legacy_running_at(rt.path(), &old));
        drop(file);
        assert!(!legacy_running_at(rt.path(), &old), "it quit");
    }

    async fn legacy_async(rt: &Path, old: &Path, launch: Option<&str>) -> Legacy {
        let (rt, old, launch) = (rt.to_path_buf(), old.to_path_buf(), launch.map(str::to_string));
        tokio::task::spawn_blocking(move || forward_to_legacy(&rt, &old, launch.as_deref(), Duration::from_millis(500))).await.unwrap()
    }

    /// GitBolt (the old name) running on its config folder takes a GitVolt launch, so its
    /// folders never move under it; once it quits, nothing does.
    #[tokio::test]
    async fn a_running_gitbolt_takes_the_launch() {
        let rt = tempfile::tempdir().unwrap();
        let old = rt.path().join("config/gitbolt");
        let (lock, _) = instance_paths_named(crate::legacy::INSTANCE_NAME, rt.path(), &old);
        assert_eq!(legacy_async(rt.path(), &old, None).await, Legacy::NotRunning);
        assert!(!lock.exists(), "a machine that never ran GitBolt gets no lock file");
        let (rt2, old2) = (rt.path().to_path_buf(), old.clone());
        let gitbolt = primary(tokio::task::spawn_blocking(move || claim_named(crate::legacy::INSTANCE_NAME, &rt2, &old2, None, CONNECT_PATIENCE)).await.unwrap());
        let mut got = collect(&gitbolt);
        assert_eq!(legacy_async(rt.path(), &old, Some(&abs("/some/repo"))).await, Legacy::Forwarded);
        assert_eq!(recv(&mut got).await.as_deref(), Some(abs("/some/repo").as_str()));
        drop(gitbolt);
        assert_eq!(legacy_async(rt.path(), &old, None).await, Legacy::NotRunning, "it quit");
    }

    /// Unix only (a lock held with no socket bound): a GitBolt that holds its lock and never
    /// answers stops the launch rather than have its folders moved.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_gitbolt_that_doesnt_answer_stops_the_launch() {
        let rt = tempfile::tempdir().unwrap();
        let old = rt.path().join("config/gitbolt");
        let (lock_path, _) = instance_paths_named(crate::legacy::INSTANCE_NAME, rt.path(), &old);
        let held = open_lock(&lock_path).unwrap();
        held.try_lock().unwrap();
        let got = legacy_async(rt.path(), &old, None).await;
        assert!(matches!(&got, Legacy::Unreachable(why) if why.contains("GitBolt is running")), "{got:?}");
    }

    #[test]
    fn gitvolts_and_gitbolts_guards_have_their_own_names() {
        let rt = Path::new("/run/user/1");
        let cfg = Path::new("/home/u/.config/x");
        let (lock, _) = instance_paths(rt, cfg);
        let (old, _) = instance_paths_named(crate::legacy::INSTANCE_NAME, rt, cfg);
        assert!(lock.file_name().unwrap().to_string_lossy().starts_with("gitvolt-instance-"));
        assert!(old.file_name().unwrap().to_string_lossy().starts_with("gitbolt-instance-"));
    }

    /// A refused start writes its reason outside GitVolt's folders (a folder made there would stop
    /// `migrate` moving GitBolt's), a later start that isn't refused removes it, and ENV_MULTI
    /// skips the check.
    #[cfg(unix)]
    #[test]
    fn a_refused_start_leaves_gitvolts_folders_alone_and_the_next_one_clears_it() {
        let t = tempfile::tempdir().unwrap();
        let (rt, old) = (t.path().join("rt"), t.path().join("config/gitbolt"));
        let (cache, refused) = (t.path().join("cache"), t.path().join("tmp-refused.txt"));
        std::fs::create_dir_all(rt.clone()).unwrap();
        let (lock_path, _) = instance_paths_named(crate::legacy::INSTANCE_NAME, &rt, &old);
        let held = open_lock(&lock_path).unwrap();
        held.try_lock().unwrap();
        let gate = |off| legacy_gate(&rt, &old, None, Duration::from_millis(100), &refused, off);
        assert!(gate(true).is_none(), "ENV_MULTI: no check");
        assert!(!refused.exists());
        assert!(matches!(gate(false), Some(Claim::Refused(_))));
        assert!(std::fs::read_to_string(&refused).unwrap().contains("GitBolt is running"));
        assert_eq!(crate::platform::fs::mode(&std::fs::metadata(&refused).unwrap()) & 0o777, 0o600);
        assert!(!cache.exists(), "GitVolt's folders aren't made by a refusal");
        drop(held);
        assert!(gate(false).is_none());
        assert!(!refused.exists(), "a start that isn't refused clears it");
        // the cache move happens on that start
        std::fs::create_dir_all(cache.join("gitbolt")).unwrap();
        let m = crate::migrate::Move { from: cache.join("gitbolt"), to: cache.join("gitvolt"), transient: vec![] };
        assert_eq!(crate::migrate::move_dir(&m, &|a, b| std::fs::rename(a, b)), crate::migrate::Outcome::Moved);
    }
}
