//! The local endpoint askpass and the single-instance guard listen on: one line in, one line
//! back, from this user's processes only.
//!
//! Unix: a socket file, mode `0600` (in a `0700` runtime dir), and every peer's uid is checked
//! (`SO_PEERCRED`). Windows: a named pipe `\\.\pipe\<name>` with a DACL that grants this user
//! alone (the default one also lets Everyone read), remote clients refused, the name claimed
//! with `FILE_FLAG_FIRST_PIPE_INSTANCE` (a squatter makes the bind fail), and every client
//! process's token user checked. A pipe has no file to remove; it goes with its last handle.
//! Clients connect anonymously (`SECURITY_ANONYMOUS`), so a pipe server can't act as them.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

/// The endpoint named `name` (`gitbolt-askpass-….sock`): that socket file in `dir` on Unix, the
/// pipe `\\.\pipe\<name>` on Windows (pipes have their own namespace; `dir` isn't used).
pub fn endpoint(dir: &Path, name: &str) -> PathBuf {
    imp::endpoint(dir, name)
}

/// Removes what a dead process left at `endpoint` (a socket file); nothing to do on Windows.
pub fn remove(endpoint: &Path) {
    imp::remove(endpoint);
}

/// A bound endpoint. Clients can connect (and write) before it's [served](Listener::into_async):
/// their requests wait for it.
#[derive(Debug)]
pub struct Listener(imp::Listener);

impl Listener {
    pub fn bind(endpoint: &Path) -> io::Result<Self> {
        imp::Listener::bind(endpoint).map(Self)
    }

    /// Starts accepting; call inside a tokio runtime.
    pub fn into_async(self) -> io::Result<AsyncListener> {
        self.0.into_async().map(AsyncListener)
    }
}

pub struct AsyncListener(imp::AsyncListener);

impl AsyncListener {
    pub async fn accept(&mut self) -> io::Result<Stream> {
        self.0.accept().await.map(Stream)
    }
}

/// An accepted connection.
pub struct Stream(imp::Stream);

impl Stream {
    /// Whether the peer runs as this user.
    pub fn from_this_user(&self) -> bool {
        imp::from_this_user(&self.0)
    }

    pub fn into_split(self) -> (impl AsyncRead + Unpin + Send + 'static, impl AsyncWrite + Unpin + Send + 'static) {
        imp::split(self.0)
    }
}

/// A client's connection (blocking).
#[derive(Debug)]
pub struct Client(imp::Client);

/// Connects to `endpoint`. A Windows pipe whose instances are all busy is retried for a moment.
pub fn connect(endpoint: &Path) -> io::Result<Client> {
    imp::connect(endpoint).map(Client)
}

impl Client {
    /// Reads the reply line, waiting at most `timeout` (`None`: as long as it takes).
    pub fn read_line_within(self, timeout: Option<Duration>) -> io::Result<String> {
        imp::read_line_within(self.0, timeout)
    }
}

impl Write for Client {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Read for Client {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

#[cfg(unix)]
mod imp {
    use std::io::{self, BufRead};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    pub type Client = std::os::unix::net::UnixStream;
    pub type Stream = tokio::net::UnixStream;

    pub fn endpoint(dir: &Path, name: &str) -> PathBuf {
        dir.join(name)
    }

    pub fn remove(endpoint: &Path) {
        let _ = std::fs::remove_file(endpoint);
    }

    #[derive(Debug)]
    pub struct Listener(std::os::unix::net::UnixListener);

    impl Listener {
        pub fn bind(endpoint: &Path) -> io::Result<Self> {
            let listener = std::os::unix::net::UnixListener::bind(endpoint)?;
            std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }

        pub fn into_async(self) -> io::Result<AsyncListener> {
            self.0.set_nonblocking(true)?;
            tokio::net::UnixListener::from_std(self.0).map(AsyncListener)
        }
    }

    pub struct AsyncListener(tokio::net::UnixListener);

    impl AsyncListener {
        pub async fn accept(&mut self) -> io::Result<Stream> {
            self.0.accept().await.map(|(s, _)| s)
        }
    }

    /// A connection is answered only when its peer (`SO_PEERCRED`) is known to be `own`.
    pub(super) fn uid_allowed(peer_uid: Option<u32>, own: u32) -> bool {
        peer_uid == Some(own)
    }

    pub fn from_this_user(stream: &Stream) -> bool {
        uid_allowed(stream.peer_cred().ok().map(|c| c.uid()), nix::unistd::geteuid().as_raw())
    }

    pub fn split(stream: Stream) -> (tokio::net::unix::OwnedReadHalf, tokio::net::unix::OwnedWriteHalf) {
        stream.into_split()
    }

    pub fn connect(endpoint: &Path) -> io::Result<Client> {
        Client::connect(endpoint)
    }

    pub fn read_line_within(client: Client, timeout: Option<Duration>) -> io::Result<String> {
        client.set_read_timeout(timeout)?;
        let mut line = String::new();
        io::BufReader::new(client).read_line(&mut line)?;
        Ok(line)
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::{self, BufRead};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use tokio::net::windows::named_pipe::NamedPipeServer;
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_PIPE_BUSY, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{GetLengthSid, GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, SECURITY_ANONYMOUS};
    use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    pub type Client = File;
    pub type Stream = NamedPipeServer;

    /// Pipe instances waiting for a client at any time: up to this many clients connect (and
    /// queue their request) before the server first accepts, as a socket's backlog would.
    const PENDING: usize = 16;
    const BUFFER: u32 = 64 * 1024;
    /// How long a client keeps retrying while every instance is busy.
    const BUSY_PATIENCE: Duration = Duration::from_secs(2);

    pub fn endpoint(_dir: &Path, name: &str) -> PathBuf {
        PathBuf::from(format!(r"\\.\pipe\{name}"))
    }

    pub fn remove(_endpoint: &Path) {}

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }

    /// The SID of the user `process` runs as, as bytes.
    fn user_sid(process: HANDLE) -> io::Result<Vec<u8>> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: a valid process handle and an out-pointer.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the fresh token handle is ours to close.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut buf = vec![0u8; 256];
        let mut len = 0u32;
        // SAFETY: the buffer is `buf.len()` bytes; `len` gets the size used (or needed).
        while unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, buf.as_mut_ptr().cast(), buf.len() as u32, &mut len) } == 0 {
            if len as usize <= buf.len() {
                return Err(io::Error::last_os_error());
            }
            buf.resize(len as usize, 0);
        }
        // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points inside it.
        let sid = unsafe { (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let n = unsafe { GetLengthSid(sid) } as usize;
        Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), n) }.to_vec())
    }

    fn own_sid() -> io::Result<Vec<u8>> {
        // SAFETY: the pseudo handle needs no closing.
        user_sid(unsafe { GetCurrentProcess() })
    }

    /// A security descriptor granting this user alone full access (`D:P(A;;GA;;;<SID>)`).
    struct UserOnly(PSECURITY_DESCRIPTOR);

    impl UserOnly {
        fn new() -> io::Result<Self> {
            let mut sid = own_sid()?;
            let mut text: *mut u16 = std::ptr::null_mut();
            // SAFETY: `sid` holds a valid SID; the string is LocalFree'd below.
            if unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut text) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let sid_text = {
                // SAFETY: a NUL-terminated UTF-16 string from the API.
                let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
            };
            unsafe { LocalFree(text.cast()) };
            let sddl = wide(OsStr::new(&format!("D:P(A;;GA;;;{sid_text})")));
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: a NUL-terminated SDDL string; the descriptor is LocalFree'd on drop.
            if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(sd))
        }
    }

    impl Drop for UserOnly {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(self.0.cast()) };
        }
    }

    /// One pipe instance, overlapped (tokio drives it), private to this user, local only.
    fn create(name: &[u16], first: bool) -> io::Result<OwnedHandle> {
        let sd = UserOnly::new()?;
        let attrs = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: 0 };
        let open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        // SAFETY: a NUL-terminated name and valid security attributes, alive for the call.
        let h = unsafe { CreateNamedPipeW(name.as_ptr(), open, mode, PIPE_UNLIMITED_INSTANCES, BUFFER, BUFFER, 0, &attrs) };
        if h == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh valid handle nothing else owns.
        Ok(unsafe { OwnedHandle::from_raw_handle(h) })
    }

    #[derive(Debug)]
    pub struct Listener {
        name: Vec<u16>,
        pending: Vec<OwnedHandle>,
    }

    impl Listener {
        pub fn bind(endpoint: &Path) -> io::Result<Self> {
            let name = wide(endpoint.as_os_str());
            let mut pending = vec![create(&name, true)?];
            for _ in 1..PENDING {
                pending.push(create(&name, false)?);
            }
            Ok(Self { name, pending })
        }

        pub fn into_async(self) -> io::Result<AsyncListener> {
            let (tx, rx) = tokio::sync::mpsc::channel(PENDING);
            let mut tasks = Vec::with_capacity(PENDING);
            for handle in self.pending {
                // SAFETY: an overlapped pipe handle we own, handed over to tokio.
                let mut server = unsafe { NamedPipeServer::from_raw_handle(handle.into_raw_handle())? };
                let (tx, name) = (tx.clone(), self.name.clone());
                tasks.push(tokio::spawn(async move {
                    // Each slot: wait for a client, put a fresh instance in its place, hand the
                    // connected one over.
                    loop {
                        let connected = server.connect().await;
                        let next = create(&name, false).and_then(|h| unsafe { NamedPipeServer::from_raw_handle(h.into_raw_handle()) });
                        let next = match next {
                            Ok(n) => n,
                            Err(e) => {
                                let _ = tx.send(Err(e)).await;
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                continue;
                            }
                        };
                        let done = std::mem::replace(&mut server, next);
                        // A client that left before we saw it: drop that instance quietly.
                        if connected.is_ok() && tx.send(Ok(done)).await.is_err() {
                            return;
                        }
                    }
                }));
            }
            Ok(AsyncListener { rx, tasks })
        }
    }

    pub struct AsyncListener {
        rx: tokio::sync::mpsc::Receiver<io::Result<NamedPipeServer>>,
        tasks: Vec<tokio::task::JoinHandle<()>>,
    }

    impl AsyncListener {
        pub async fn accept(&mut self) -> io::Result<Stream> {
            self.rx.recv().await.unwrap_or_else(|| Err(io::Error::other("pipe listener stopped")))
        }
    }

    impl Drop for AsyncListener {
        fn drop(&mut self) {
            for t in &self.tasks {
                t.abort();
            }
        }
    }

    pub fn from_this_user(stream: &Stream) -> bool {
        let mut pid = 0u32;
        // SAFETY: a valid pipe handle and an out-pointer.
        if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle(), &mut pid) } == 0 {
            return false;
        }
        // SAFETY: query-only access; the handle is checked, then owned.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        match (user_sid(process.as_raw_handle()), own_sid()) {
            (Ok(peer), Ok(own)) => peer == own,
            _ => false,
        }
    }

    pub fn split(stream: Stream) -> (tokio::io::ReadHalf<Stream>, tokio::io::WriteHalf<Stream>) {
        tokio::io::split(stream)
    }

    pub fn connect(endpoint: &Path) -> io::Result<Client> {
        let deadline = Instant::now() + BUSY_PATIENCE;
        loop {
            match std::fs::OpenOptions::new().read(true).write(true).security_qos_flags(SECURITY_ANONYMOUS).open(endpoint) {
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                r => return r,
            }
        }
    }

    /// A pipe opened as a file has no read timeout: the read runs on a thread, abandoned if it
    /// takes too long (it ends when the pipe closes, or with the process).
    pub fn read_line_within(client: Client, timeout: Option<Duration>) -> io::Result<String> {
        let read = move || {
            let mut line = String::new();
            io::BufReader::new(client).read_line(&mut line).map(|_| line)
        };
        let Some(timeout) = timeout else { return read() };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(read());
        });
        rx.recv_timeout(timeout).unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "no reply")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    fn name() -> String {
        format!("gitbolt-ipc-test-{}-{}.sock", std::process::id(), crate::random::random_hex(4))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_line_goes_in_and_one_comes_back_even_when_sent_before_serving() {
        let dir = tempfile::tempdir().unwrap();
        let at = endpoint(dir.path(), &name());
        let listener = Listener::bind(&at).unwrap();
        // Connected and written before anything accepts: it waits for the server.
        let client = {
            let at = at.clone();
            tokio::task::spawn_blocking(move || {
                let mut c = connect(&at).unwrap();
                c.write_all(b"ping\n").unwrap();
                c
            })
            .await
            .unwrap()
        };
        let mut listener = listener.into_async().unwrap();
        let stream = listener.accept().await.unwrap();
        assert!(stream.from_this_user());
        let (read, mut write) = stream.into_split();
        let mut line = String::new();
        tokio::io::BufReader::new(read).read_line(&mut line).await.unwrap();
        assert_eq!(line, "ping\n");
        write.write_all(b"pong\n").await.unwrap();
        let reply = tokio::task::spawn_blocking(move || client.read_line_within(Some(Duration::from_secs(5)))).await.unwrap().unwrap();
        assert_eq!(reply, "pong\n");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_that_never_comes_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let at = endpoint(dir.path(), &name());
        let _listener = Listener::bind(&at).unwrap();
        let got = tokio::task::spawn_blocking(move || connect(&at).unwrap().read_line_within(Some(Duration::from_millis(200)))).await.unwrap();
        assert!(got.is_err());
    }

    #[test]
    fn nothing_listening_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(connect(&endpoint(dir.path(), &name())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let at = endpoint(dir.path(), &name());
        let _l = Listener::bind(&at).unwrap();
        assert_eq!(std::fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn only_this_users_peers_are_accepted() {
        use super::imp::uid_allowed;
        assert!(uid_allowed(Some(1000), 1000));
        assert!(!uid_allowed(Some(1001), 1000), "another user");
        assert!(!uid_allowed(Some(0), 1000), "even root");
        assert!(!uid_allowed(None, 1000), "unknown credentials");
    }

    #[cfg(windows)]
    #[test]
    fn a_second_bind_on_a_taken_name_fails() {
        let dir = tempfile::tempdir().unwrap();
        let at = endpoint(dir.path(), &name());
        let _first = Listener::bind(&at).unwrap();
        assert!(Listener::bind(&at).is_err(), "FILE_FLAG_FIRST_PIPE_INSTANCE: a squatter can't share the name");
    }
}
