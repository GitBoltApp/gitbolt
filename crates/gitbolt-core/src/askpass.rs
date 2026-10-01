//! Askpass (spec §5.4). Git and ssh run the GitBolt binary itself as `GIT_ASKPASS`/`SSH_ASKPASS`
//! with the prompt as its argument. In that mode (`run_client_from_env`) the process connects to
//! the running app's per-session Unix socket (path and a random token in its environment), asks,
//! and prints the answer on stdout. The app shows a modal for interactive ops; GitBolt-started
//! (background) ops are denied at once, never prompting.
//!
//! Security: the socket is `0600` in `$XDG_RUNTIME_DIR` (per-user, `0700`), a connecting peer
//! must be this user (`SO_PEERCRED`), and every request must carry the session's 32-hex token
//! (compared in constant time). A request for an op that isn't running, or for op `0` (a git
//! command outside any network op), is denied without reaching the UI.

use crate::error::{GbError, GbErrorKind};
use crate::events::{AppEvent, EventBus};
use crate::ops::{OpId, OpRegistry};
use crate::random::random_hex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

pub const ENV_SOCKET: &str = "GITBOLT_ASKPASS_SOCKET";
pub const ENV_TOKEN: &str = "GITBOLT_ASKPASS_TOKEN";
pub const ENV_OP: &str = "GITBOLT_ASKPASS_OP";
/// The longest request line read (a prompt is one short line; this only bounds a bad client).
const MAX_LINE: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
struct ClientRequest {
    token: String,
    op: u64,
    prompt: String,
}

#[derive(Serialize, Deserialize, Default)]
struct ServerReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    cancel: bool,
}

/// Username prompts and ssh yes/no questions aren't secret; passwords, passphrases, PINs are.
pub fn is_secret(prompt: &str) -> bool {
    let p = prompt.trim().to_ascii_lowercase();
    !p.starts_with("username") && ["password", "passphrase", "pin", "token"].iter().any(|w| p.contains(w))
}

/// Call first thing in `main`: `Some(exit code)` when this process was started as askpass.
pub fn run_client_from_env() -> Option<i32> {
    let socket = std::env::var_os(ENV_SOCKET)?;
    let token = std::env::var(ENV_TOKEN).unwrap_or_default();
    let op = std::env::var(ENV_OP).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let mut stdout = std::io::stdout().lock();
    Some(client(Path::new(&socket), &token, op, &prompt, &mut stdout))
}

/// One request: `0` with the answer (and a newline) on `out`, or `1` (denied, cancelled, or the
/// app isn't there), which git and ssh read as "no credentials".
fn client(socket: &Path, token: &str, op: u64, prompt: &str, out: &mut dyn Write) -> i32 {
    let run = || -> std::io::Result<Option<String>> {
        let mut stream = std::os::unix::net::UnixStream::connect(socket)?;
        let req = serde_json::to_string(&ClientRequest { token: token.into(), op, prompt: prompt.into() })?;
        stream.write_all(req.as_bytes())?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        std::io::BufReader::new(stream).read_line(&mut line)?;
        let reply: ServerReply = serde_json::from_str(line.trim()).unwrap_or_default();
        Ok(reply.answer.filter(|_| !reply.cancel))
    };
    match run() {
        Ok(Some(answer)) => {
            let ok = writeln!(out, "{answer}").and_then(|_| out.flush());
            if ok.is_ok() { 0 } else { 1 }
        }
        _ => 1,
    }
}

/// A connection is answered only when its peer (`SO_PEERCRED`) is known to be `own`, this user.
fn peer_allowed(peer_uid: Option<u32>, own: u32) -> bool {
    peer_uid == Some(own)
}

/// Constant-time equality (the token must not leak through timing).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct AskpassServer {
    path: PathBuf,
    pub(crate) token: String,
    exe: PathBuf,
    /// The socket's owner (this user): the only peer uid accepted.
    uid: u32,
    next_prompt: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    ops: Arc<OpRegistry>,
    bus: EventBus,
    accept: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AskpassServer {
    /// Binds `dir/gitbolt-askpass-<pid>-<rand>.sock` (mode `0600`) and starts answering it.
    /// `exe` is the binary git runs as askpass (this one, in `run_client_from_env` mode).
    pub async fn start(dir: &Path, exe: PathBuf, ops: Arc<OpRegistry>, bus: EventBus) -> std::io::Result<Arc<Self>> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("gitbolt-askpass-{}-{}.sock", std::process::id(), random_hex(4)));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let uid = std::fs::metadata(&path)?.uid();
        let server = Arc::new(Self {
            path,
            token: random_hex(16),
            exe,
            uid,
            next_prompt: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            ops,
            bus,
            accept: Mutex::new(None),
        });
        let weak = Arc::downgrade(&server);
        let task = tokio::spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream,
                    Err(e) => {
                        // EMFILE and friends: back off rather than spin; the listener stays up.
                        tracing::warn!("askpass accept failed: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let Some(server) = weak.upgrade() else { break };
                tokio::spawn(async move { server.handle(stream).await });
            }
        });
        *server.accept_task() = Some(task);
        Ok(server)
    }

    fn accept_task(&self) -> MutexGuard<'_, Option<tokio::task::JoinHandle<()>>> {
        self.accept.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<u64, oneshot::Sender<Option<String>>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn socket_path(&self) -> &Path {
        &self.path
    }

    /// Environment for a git command. `op` is the network op this command belongs to; a command
    /// without one (`0`) is denied if it ever prompts.
    pub fn env_for(&self, op: Option<OpId>) -> Vec<(OsString, OsString)> {
        vec![
            ("GIT_ASKPASS".into(), self.exe.clone().into_os_string()),
            ("SSH_ASKPASS".into(), self.exe.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE".into(), "prefer".into()),
            (ENV_SOCKET.into(), self.path.clone().into_os_string()),
            (ENV_TOKEN.into(), self.token.clone().into()),
            (ENV_OP.into(), op.unwrap_or(0).to_string().into()),
        ]
    }

    /// The user's answer to prompt `prompt` (`authAnswer`); `None` cancels it.
    pub fn answer(&self, prompt: u64, answer: Option<String>) -> Result<(), GbError> {
        let tx = self.pending().remove(&prompt);
        match tx {
            Some(tx) => {
                let _ = tx.send(answer);
                Ok(())
            }
            None => Err(GbError::new(GbErrorKind::InvalidInput, format!("no pending prompt {prompt}"))),
        }
    }

    /// Stops answering and removes the socket (at app exit; also on drop).
    pub fn close(&self) {
        if let Some(task) = self.accept_task().take() {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.path);
    }

    async fn handle(&self, stream: UnixStream) {
        if !peer_allowed(stream.peer_cred().ok().map(|c| c.uid()), self.uid) {
            tracing::warn!("askpass: refused a connection from another user");
            return;
        }
        let (read, mut write) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read.take(MAX_LINE));
        let mut line = String::new();
        if reader.read_line(&mut line).await.is_err() {
            return;
        }
        let answer = match serde_json::from_str::<ClientRequest>(line.trim()) {
            Ok(req) if same(&req.token, &self.token) => {
                // If the client goes away (git killed), stop waiting for the user.
                let hangup = async {
                    let mut buf = [0u8; 1];
                    let _ = reader.read(&mut buf).await;
                };
                tokio::select! {
                    a = self.prompt(req.op, req.prompt) => a,
                    _ = hangup => None,
                }
            }
            _ => None,
        };
        let reply = match answer {
            Some(a) => ServerReply { answer: Some(a), cancel: false },
            None => ServerReply { answer: None, cancel: true },
        };
        let mut text = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"cancel\":true}".into());
        text.push('\n');
        let _ = write.write_all(text.as_bytes()).await;
    }

    async fn prompt(&self, op: OpId, text: String) -> Option<String> {
        let entry = self.ops.get(op)?;
        if !entry.interactive {
            entry.deny_auth();
            return None;
        }
        if entry.cancel.is_cancelled() {
            return None;
        }
        let id = self.next_prompt.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);
        self.bus.emit(AppEvent::AuthWaiting { prompt: id, op, repo: entry.repo, secret: is_secret(&text), text });
        // Also runs if this future is dropped (the client hung up): the modal always closes.
        let _resolved = Resolved { server: self, id };
        tokio::select! {
            a = rx => {
                let a = a.ok().flatten();
                if a.is_none() {
                    entry.note_prompt_cancelled();
                }
                a
            }
            _ = entry.cancel.cancelled() => None,
        }
    }
}

/// Drop guard: forgets the pending prompt and tells the UI it's resolved.
struct Resolved<'a> {
    server: &'a AskpassServer,
    id: u64,
}

impl Drop for Resolved<'_> {
    fn drop(&mut self) {
        self.server.pending().remove(&self.id);
        self.server.bus.emit(AppEvent::AuthResolved { prompt: self.id });
    }
}

impl Drop for AskpassServer {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::OpKind;

    async fn server() -> (tempfile::TempDir, Arc<AskpassServer>, Arc<OpRegistry>, EventBus) {
        let dir = tempfile::tempdir().unwrap();
        let ops = Arc::new(OpRegistry::default());
        let bus = EventBus::new();
        let s = AskpassServer::start(dir.path(), "/bin/false".into(), ops.clone(), bus.clone()).await.unwrap();
        (dir, s, ops, bus)
    }

    async fn ask(s: &AskpassServer, token: &str, op: u64, prompt: &str) -> i32 {
        let (path, token, prompt) = (s.socket_path().to_path_buf(), token.to_string(), prompt.to_string());
        tokio::task::spawn_blocking(move || client(&path, &token, op, &prompt, &mut Vec::new())).await.unwrap()
    }

    #[test]
    fn classifies_secret_prompts() {
        assert!(!is_secret("Username for 'https://gitlab.example.com': "));
        assert!(is_secret("Password for 'https://ada@gitlab.example.com': "));
        assert!(is_secret("Enter passphrase for key '/home/ada/.ssh/id_ed25519': "));
        assert!(!is_secret("Are you sure you want to continue connecting (yes/no/[fingerprint])? "));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn socket_is_private_and_env_names_it() {
        let (_d, s, _ops, _bus) = server().await;
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(s.socket_path()).unwrap().permissions().mode() & 0o777, 0o600);
        let name = s.socket_path().file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(&format!("gitbolt-askpass-{}-", std::process::id())) && name.ends_with(".sock"), "{name}");
        let env = s.env_for(Some(7));
        let get = |k: &str| env.iter().find(|(a, _)| a == k).map(|(_, v)| v.to_string_lossy().into_owned());
        assert_eq!(get("GIT_ASKPASS").as_deref(), Some("/bin/false"));
        assert_eq!(get("SSH_ASKPASS").as_deref(), Some("/bin/false"));
        assert_eq!(get("SSH_ASKPASS_REQUIRE").as_deref(), Some("prefer"));
        assert_eq!(get(ENV_SOCKET).as_deref(), Some(s.socket_path().to_str().unwrap()));
        assert_eq!(get(ENV_OP).as_deref(), Some("7"));
        let token = get(ENV_TOKEN).unwrap();
        assert!(token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()), "{token}");
        assert_eq!(s.env_for(None).iter().find(|(k, _)| k == ENV_OP).unwrap().1, "0");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn wrong_token_and_unknown_op_are_denied() {
        let (_d, s, ops, bus) = server().await;
        let mut rx = bus.subscribe();
        let op = ops.begin(OpKind::Fetch, None, true);
        assert_eq!(ask(&s, "wrong", op.id, "Password: ").await, 1);
        assert_eq!(ask(&s, &s.token[..31], op.id, "Password: ").await, 1, "a prefix isn't the token");
        assert_eq!(ask(&s, &s.token, 999, "Password: ").await, 1);
        assert_eq!(ask(&s, &s.token, 0, "Password: ").await, 1, "a command outside any op never prompts");
        assert!(rx.try_recv().is_err(), "none of them reached the UI");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn background_op_is_denied_without_prompt() {
        let (_d, s, ops, bus) = server().await;
        let mut rx = bus.subscribe();
        let op = ops.begin(OpKind::Fetch, Some(1), false);
        assert_eq!(ask(&s, &s.token, op.id, "Username for 'https://h': ").await, 1);
        assert!(op.auth_denied());
        assert!(rx.try_recv().is_err(), "a background op never emits authWaiting");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn interactive_prompt_round_trip() {
        let (_d, s, ops, bus) = server().await;
        let mut rx = bus.subscribe();
        let op = ops.begin(OpKind::Clone, None, true);
        let s2 = s.clone();
        let answering = tokio::spawn(async move {
            let AppEvent::AuthWaiting { prompt, text, secret, op: op_id, .. } = rx.recv().await.unwrap() else { panic!("expected authWaiting") };
            assert_eq!(text, "Password for 'https://ada@h': ");
            assert!(secret);
            s2.answer(prompt, Some("s3cret".into())).unwrap();
            assert_eq!(rx.recv().await.unwrap(), AppEvent::AuthResolved { prompt });
            op_id
        });
        let (path, token, op_id) = (s.socket_path().to_path_buf(), s.token.clone(), op.id);
        let (code, out) = tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            let code = client(&path, &token, op_id, "Password for 'https://ada@h': ", &mut out);
            (code, out)
        })
        .await
        .unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, b"s3cret\n");
        assert_eq!(answering.await.unwrap(), op.id);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_prompt_exits_1() {
        let (_d, s, ops, bus) = server().await;
        let mut rx = bus.subscribe();
        let op = ops.begin(OpKind::Clone, None, true);
        let s2 = s.clone();
        tokio::spawn(async move {
            if let Ok(AppEvent::AuthWaiting { prompt, .. }) = rx.recv().await {
                s2.answer(prompt, None).unwrap();
            }
        });
        assert_eq!(ask(&s, &s.token, op.id, "Password: ").await, 1);
        assert!(op.prompt_cancelled(), "the op knows the user cancelled, so it reports cancelled");
    }

    #[test]
    fn only_this_users_peers_are_accepted() {
        assert!(peer_allowed(Some(1000), 1000));
        assert!(!peer_allowed(Some(1001), 1000), "another user");
        assert!(!peer_allowed(Some(0), 1000), "even root");
        assert!(!peer_allowed(None, 1000), "unknown credentials");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancelling_the_op_cancels_its_prompt() {
        let (_d, s, ops, bus) = server().await;
        let mut rx = bus.subscribe();
        let op = ops.begin(OpKind::Fetch, Some(2), true);
        let ops2 = ops.clone();
        tokio::spawn(async move {
            if let Ok(AppEvent::AuthWaiting { op, .. }) = rx.recv().await {
                ops2.cancel(op);
            }
        });
        assert_eq!(ask(&s, &s.token, op.id, "Username for 'https://h': ").await, 1);
        assert!(!op.prompt_cancelled(), "the op was cancelled, not its prompt by the user");
        assert!(s.answer(12345, None).is_err(), "unknown prompt ids are rejected");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_hanging_up_resolves_its_prompt() {
        use std::io::Write as _;
        let (_d, s, ops, bus) = server().await;
        let mut rx = bus.subscribe();
        let op = ops.begin(OpKind::Fetch, None, true);
        let req = serde_json::json!({"token": s.token, "op": op.id, "prompt": "Password: "}).to_string();
        let path = s.socket_path().to_path_buf();
        let mut stream = tokio::task::spawn_blocking(move || {
            let mut st = std::os::unix::net::UnixStream::connect(&path).unwrap();
            st.write_all(format!("{req}\n").as_bytes()).unwrap();
            st
        })
        .await
        .unwrap();
        let AppEvent::AuthWaiting { prompt, .. } = rx.recv().await.unwrap() else { panic!("expected authWaiting") };
        stream.flush().unwrap();
        drop(stream);
        let resolved = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert_eq!(resolved, AppEvent::AuthResolved { prompt });
        assert!(s.answer(prompt, Some("late".into())).is_err(), "the prompt is gone");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_removes_the_socket() {
        let (_d, s, _ops, _bus) = server().await;
        let path = s.socket_path().to_path_buf();
        assert!(path.exists());
        s.close();
        assert!(!path.exists());
        assert_eq!(ask(&s, &s.token.clone(), 1, "Password: ").await, 1, "nothing answers any more");
    }
}
