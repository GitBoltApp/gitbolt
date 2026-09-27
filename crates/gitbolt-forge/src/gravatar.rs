//! Gravatar avatars with a disk cache (spec §14.3): `<dir>/<sha256(email)>.<ext>` plus
//! `<dir>/index.json` recording when each key was fetched. Found avatars stay fresh for 7 days,
//! "not found" answers for 1 day. Network errors are never cached.
//!
//! Privacy (plan 1B amendment 6): a request carries only the SHA-256 key in its URL and the
//! generic `USER_AGENT`; never the email itself.

use base64::Engine as _;
use gitbolt_core::avatar::{AvatarFuture, AvatarPayload, AvatarProvider};
use gitbolt_core::error::GbError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

pub const FOUND_TTL_SECS: i64 = 7 * 24 * 3600;
pub const MISSING_TTL_SECS: i64 = 24 * 3600;
pub const DEFAULT_BASE_URL: &str = "https://gravatar.com/avatar";
/// Generic on purpose (amendment 6): identifies the app and version, nothing about the user.
pub const USER_AGENT: &str = concat!("GitBolt/", env!("CARGO_PKG_VERSION"));
const MAX_AVATAR_BYTES: u64 = 1024 * 1024;
const PARALLEL_REQUESTS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct IndexEntry {
    /// The cached image's extension, or `None` for a cached "not found".
    ext: Option<String>,
    fetched: i64,
}

pub fn email_key(email: &str) -> String {
    Sha256::digest(email.trim().to_lowercase().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

/// The cache extension for an image content type. `None` for anything else (for example a
/// captive portal's HTML page), which is a transient failure and never cached.
fn ext_for(content_type: &str) -> Option<&'static str> {
    match content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        _ => None,
    }
}

/// Writes a temp file, then renames it, so a crash never leaves a half-written file. The temp
/// name is unique per call (`.<name>.<pid>.<counter>.tmp`), so concurrent writers of the same
/// path never share, truncate or steal each other's temp file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let written = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

fn payload(ext: &str, bytes: &[u8]) -> AvatarPayload {
    AvatarPayload { mime: mime_for(ext).into(), base64: base64::engine::general_purpose::STANDARD.encode(bytes) }
}

pub struct GravatarCache {
    dir: PathBuf,
    base_url: String,
    agent: ureq::Agent,
    index: Mutex<Option<HashMap<String, IndexEntry>>>,
}

impl GravatarCache {
    pub fn new(dir: PathBuf, base_url: impl Into<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .build()
            .into();
        Self { dir, base_url: base_url.into(), agent, index: Mutex::new(None) }
    }

    fn with_index<T>(&self, f: impl FnOnce(&mut HashMap<String, IndexEntry>) -> T) -> T {
        let mut guard = self.index.lock().expect("avatar index poisoned");
        let index = guard.get_or_insert_with(|| std::fs::read(self.dir.join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
        f(index)
    }

    /// Records a fetch and saves the index. The file is written while the index lock is held,
    /// so snapshots reach the disk in the order they were taken: an older one never overwrites
    /// a newer one.
    fn remember(&self, key: &str, ext: Option<&str>) {
        let saved = self.with_index(|index| {
            index.insert(key.to_string(), IndexEntry { ext: ext.map(str::to_string), fetched: now() });
            let json = serde_json::to_vec(index).expect("index serializes");
            std::fs::create_dir_all(&self.dir).and_then(|_| write_atomic(&self.dir.join("index.json"), &json))
        });
        if let Err(e) = saved {
            tracing::warn!("avatar index not saved: {e}");
        }
    }

    /// Blocking: call it from `spawn_blocking`. `Ok(None)` means no avatar.
    pub fn get_blocking(&self, email: &str) -> Result<Option<AvatarPayload>, String> {
        if email.trim().is_empty() {
            return Ok(None);
        }
        let key = email_key(email);
        if let Some(entry) = self.with_index(|index| index.get(&key).cloned()) {
            let ttl = if entry.ext.is_some() { FOUND_TTL_SECS } else { MISSING_TTL_SECS };
            if now() - entry.fetched < ttl {
                match entry.ext {
                    None => return Ok(None),
                    Some(ext) => {
                        if let Ok(bytes) = std::fs::read(self.dir.join(format!("{key}.{ext}"))) {
                            return Ok(Some(payload(&ext, &bytes)));
                        }
                    }
                }
            }
        }
        self.fetch(&key)
    }

    fn fetch(&self, key: &str) -> Result<Option<AvatarPayload>, String> {
        let url = format!("{}/{key}?s=80&d=404", self.base_url.trim_end_matches('/'));
        let mut resp = self.agent.get(&url).call().map_err(|e| format!("avatar request failed: {e}"))?;
        match resp.status().as_u16() {
            200 => {
                let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
                let ext = ext_for(content_type).ok_or_else(|| format!("avatar server answered a non-image ({content_type:?})"))?;
                let bytes = resp.body_mut().with_config().limit(MAX_AVATAR_BYTES).read_to_vec().map_err(|e| format!("avatar body: {e}"))?;
                std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
                write_atomic(&self.dir.join(format!("{key}.{ext}")), &bytes).map_err(|e| e.to_string())?;
                self.remember(key, Some(ext));
                Ok(Some(payload(ext, &bytes)))
            }
            404 => {
                self.remember(key, None);
                Ok(None)
            }
            other => Err(format!("avatar server answered HTTP {other}")),
        }
    }
}

/// The `AvatarProvider`: at most 4 requests at a time, and network failures show initials
/// rather than error toasts.
pub struct Gravatar {
    cache: Arc<GravatarCache>,
    enabled: AtomicBool,
    permits: Semaphore,
}

impl Gravatar {
    pub fn new(dir: PathBuf, base_url: impl Into<String>) -> Self {
        Self { cache: Arc::new(GravatarCache::new(dir, base_url)), enabled: AtomicBool::new(true), permits: Semaphore::new(PARALLEL_REQUESTS) }
    }

    /// The "Gravatar on/off" setting (spec §14.1; plan 1C wires it).
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }
}

impl AvatarProvider for Gravatar {
    fn avatar<'a>(&'a self, email: &'a str) -> AvatarFuture<'a> {
        Box::pin(async move {
            if !self.enabled.load(Ordering::Relaxed) {
                return Ok(None);
            }
            let _permit = self.permits.acquire().await.map_err(|e| GbError::other(e.to_string()))?;
            let cache = self.cache.clone();
            let email = email.to_string();
            match tokio::task::spawn_blocking(move || cache.get_blocking(&email)).await {
                Ok(Ok(found)) => Ok(found),
                Ok(Err(e)) => {
                    tracing::warn!("{e}");
                    Ok(None)
                }
                Err(e) => Err(GbError::other(format!("avatar task failed: {e}"))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    const EXPECTED_UA: &str = concat!("GitBolt/", env!("CARGO_PKG_VERSION"));

    /// Answers `/avatar/<key>` with a PNG for found@example.com, an HTML page for
    /// html@example.com and 404 otherwise; counts hits and records each request's head (request
    /// line plus headers). Each connection gets its own thread, so concurrent fetches overlap.
    fn serve() -> (String, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/avatar", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let heads = Arc::new(Mutex::new(Vec::new()));
        let (counter, log) = (hits.clone(), heads.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let (counter, log) = (counter.clone(), log.clone());
                std::thread::spawn(move || answer(stream.unwrap(), &counter, &log));
            }
        });
        (base, hits, heads)
    }

    fn answer(mut stream: std::net::TcpStream, counter: &AtomicUsize, log: &Mutex<Vec<String>>) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut head = line.clone();
        let mut agent = None;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header == "\r\n" || header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.eq_ignore_ascii_case("user-agent")
            {
                agent = Some(value.trim().to_string());
            }
            head.push_str(&header);
        }
        // Amendment 6: a generic User-Agent, never anything personal. A failed assertion drops
        // the connection, so the client side of the test fails too.
        assert_eq!(agent.as_deref(), Some(EXPECTED_UA), "{head}");
        assert!(!head.contains('@'), "no email in the request: {head}");
        log.lock().unwrap().push(head);
        counter.fetch_add(1, Ordering::SeqCst);
        let ok = |content_type: &str, body: &[u8]| {
            let mut r = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
            r.extend_from_slice(body);
            r
        };
        let reply = if line.contains(&email_key("found@example.com")) {
            ok("image/png", b"\x89PNGfake")
        } else if line.contains(&email_key("html@example.com")) {
            ok("text/html; charset=utf-8", b"<html>captive portal</html>")
        } else {
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        };
        stream.write_all(&reply).unwrap();
    }

    /// A base URL on a port nothing listens on: bind an ephemeral port, then release it.
    fn closed_base() -> String {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        format!("http://127.0.0.1:{port}/avatar")
    }

    fn server() -> (String, Arc<AtomicUsize>) {
        let (base, hits, _) = serve();
        (base, hits)
    }

    #[test]
    fn fetches_caches_on_disk_and_remembers_misses() {
        let (base, hits) = server();
        let dir = tempfile::tempdir().unwrap();
        let cache = GravatarCache::new(dir.path().to_path_buf(), &base);
        let a = cache.get_blocking(" Found@Example.com ").unwrap().unwrap();
        assert_eq!(a.mime, "image/png");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&a.base64).unwrap(), b"\x89PNGfake");
        assert!(dir.path().join(format!("{}.png", email_key("found@example.com"))).exists());
        assert_eq!(cache.get_blocking("nobody@example.com").unwrap(), None);
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        let again = GravatarCache::new(dir.path().to_path_buf(), &base);
        assert_eq!(again.get_blocking("found@example.com").unwrap(), Some(a));
        assert_eq!(again.get_blocking("nobody@example.com").unwrap(), None);
        assert_eq!(hits.load(Ordering::SeqCst), 2, "a fresh instance answers both from disk");
        assert_eq!(cache.get_blocking("").unwrap(), None);
    }

    #[test]
    fn expired_entries_are_refetched() {
        let (base, hits) = server();
        let dir = tempfile::tempdir().unwrap();
        let stale = serde_json::json!({ email_key("nobody@example.com"): { "ext": null, "fetched": now() - MISSING_TTL_SECS - 1 } });
        std::fs::write(dir.path().join("index.json"), stale.to_string()).unwrap();
        let cache = GravatarCache::new(dir.path().to_path_buf(), &base);
        assert_eq!(cache.get_blocking("nobody@example.com").unwrap(), None);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unreachable_server_is_an_error_and_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let cache = GravatarCache::new(dir.path().to_path_buf(), closed_base());
        assert!(cache.get_blocking("x@example.com").is_err());
        assert!(!dir.path().join("index.json").exists());
    }

    /// Amendment 6 (F10): the only identifying data sent is the SHA-256 key in the URL, and the
    /// User-Agent is the generic `GitBolt/<version>`.
    #[test]
    fn sends_only_the_hash_and_a_generic_user_agent() {
        let (base, hits, heads) = serve();
        let dir = tempfile::tempdir().unwrap();
        let cache = GravatarCache::new(dir.path().to_path_buf(), &base);
        assert!(cache.get_blocking("found@example.com").unwrap().is_some());
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let heads = heads.lock().unwrap();
        let head = &heads[0];
        let request_line = head.lines().next().unwrap();
        assert_eq!(request_line, format!("GET /avatar/{}?s=80&d=404 HTTP/1.1", email_key("found@example.com")));
        let agent = head.lines().find_map(|l| l.split_once(':').filter(|(n, _)| n.eq_ignore_ascii_case("user-agent")).map(|(_, v)| v.trim()));
        assert_eq!(agent, Some(EXPECTED_UA));
        assert_eq!(USER_AGENT, EXPECTED_UA);
        assert!(!head.contains('@') && !head.to_ascii_lowercase().contains("example.com"), "{head}");
    }

    #[test]
    fn concurrent_atomic_writes_to_one_path_never_fail_or_tear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.json");
        let threads: Vec<_> = (0..8u8)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        write_atomic(&path, &vec![b'a' + t; 64 * 1024]).expect("every write succeeds");
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 64 * 1024);
        assert!(bytes.iter().all(|&b| b == bytes[0]), "one writer's complete payload");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("index.json")], "no temp files left behind");
    }

    /// Up to 4 fetches of different emails run at once in one process (the provider's
    /// permits); each rewrites the whole index. A large seeded index widens the write window.
    #[test]
    fn concurrent_fetches_leave_a_complete_index() {
        const SEEDED: usize = 500;
        const N: usize = 16;
        let (base, hits) = server();
        let dir = tempfile::tempdir().unwrap();
        let seeded: HashMap<String, IndexEntry> = (0..SEEDED).map(|i| (email_key(&format!("seed{i}@example.com")), IndexEntry { ext: None, fetched: now() })).collect();
        std::fs::write(dir.path().join("index.json"), serde_json::to_vec(&seeded).unwrap()).unwrap();
        for round in 0..3 {
            let cache = Arc::new(GravatarCache::new(dir.path().to_path_buf(), &base));
            let barrier = Arc::new(std::sync::Barrier::new(N));
            let threads: Vec<_> = (0..N)
                .map(|i| {
                    let (cache, barrier) = (cache.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        cache.get_blocking(&format!("user{round}-{i}@example.com")).unwrap()
                    })
                })
                .collect();
            for t in threads {
                assert_eq!(t.join().unwrap(), None);
            }
            let index: HashMap<String, IndexEntry> = serde_json::from_slice(&std::fs::read(dir.path().join("index.json")).unwrap()).expect("a complete, parseable index");
            assert_eq!(index.len(), SEEDED + (round + 1) * N, "round {round}: every entry persisted");
            for i in 0..N {
                assert_eq!(index[&email_key(&format!("user{round}-{i}@example.com"))].ext, None);
            }
        }
        assert_eq!(hits.load(Ordering::SeqCst), 3 * N);
        let again = GravatarCache::new(dir.path().to_path_buf(), &base);
        assert_eq!(again.get_blocking("user0-0@example.com").unwrap(), None);
        assert_eq!(hits.load(Ordering::SeqCst), 3 * N, "a fresh instance answers from disk");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).filter(|n| n != "index.json").collect();
        assert!(leftovers.is_empty(), "no temp files left behind: {leftovers:?}");
    }

    #[tokio::test]
    async fn a_non_image_200_is_transient_and_not_cached() {
        let (base, hits) = server();
        let dir = tempfile::tempdir().unwrap();
        let cache = GravatarCache::new(dir.path().to_path_buf(), &base);
        assert!(cache.get_blocking("html@example.com").is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "nothing cached");
        let g = Gravatar::new(dir.path().to_path_buf(), &base);
        assert_eq!(g.avatar("html@example.com").await.unwrap(), None, "the UI shows initials");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "asked again: the failure wasn't remembered");
    }

    #[tokio::test]
    async fn provider_hides_network_errors_and_respects_the_off_switch() {
        let (base, hits) = server();
        let dir = tempfile::tempdir().unwrap();
        let g = Gravatar::new(dir.path().to_path_buf(), &base);
        assert!(g.avatar("found@example.com").await.unwrap().is_some());
        g.set_enabled(false);
        assert_eq!(g.avatar("other@example.com").await.unwrap(), None);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "disabled: no request");
        let offline = Gravatar::new(dir.path().join("x"), closed_base());
        assert_eq!(offline.avatar("x@example.com").await.unwrap(), None, "offline shows initials, not an error");
    }
}
