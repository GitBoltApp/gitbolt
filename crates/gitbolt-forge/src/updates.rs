//! GitBolt's own releases on GitHub (core's `UpdateSource`): the list from the REST API, and the
//! assets from the release download URLs, through the forge clients' `HttpClient`, with no token.
//!
//! A download may start only under `<web>/<repo>/releases/download/`, and follow redirects only
//! to GitHub's asset storage hosts (`objects.githubusercontent.com`, and
//! `release-assets.githubusercontent.com`, where GitHub moved them in 2025); all https.

use crate::http::{under, ClientConfig, DownloadTo, HttpClient, REQUEST_TIMEOUT};
use gitbolt_core::forge::ForgeFuture;
use gitbolt_core::updates::release::GhRelease;
use gitbolt_core::updates::{DownloadProgress, UpdateSource, RELEASES_REPO};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// GitHub's API, web and asset storage.
pub const GITHUB_API: &str = "https://api.github.com";
pub const GITHUB_WEB: &str = "https://github.com";
pub const ASSET_HOSTS: [&str; 2] = ["https://objects.githubusercontent.com", "https://release-assets.githubusercontent.com"];
/// The largest package GitBolt downloads.
pub const MAX_PACKAGE: u64 = 1024 * 1024 * 1024;
/// `SHA256SUMS` at most.
pub const MAX_SUMS: u64 = 64 * 1024;
/// Releases listed per check (the newest first).
const PER_PAGE: u32 = 30;

pub struct GitHubReleases {
    http: HttpClient,
    repo: String,
    /// Where a download may go: the release downloads and the asset storage hosts.
    download_bases: Vec<String>,
}

impl GitHubReleases {
    /// github.com's.
    pub fn github() -> Self {
        Self::new(GITHUB_API, GITHUB_WEB, ASSET_HOSTS.iter().map(|h| h.to_string()).collect())
    }

    /// At other endpoints (the harness's fake GitHub); `asset_hosts`: where downloads may redirect.
    pub fn new(api: &str, web: &str, asset_hosts: Vec<String>) -> Self {
        let http = HttpClient::new(ClientConfig { host: "github.com".into(), api_base: api.trim_end_matches('/').into(), token: None, headers: crate::github::GITHUB_HEADERS.to_vec(), timeout: REQUEST_TIMEOUT })
            // Every check asks (a cheap 304 when nothing changed): never a moments-old answer.
            .with_fresh_window(std::time::Duration::ZERO);
        let mut download_bases = vec![format!("{}/{RELEASES_REPO}/releases/download", web.trim_end_matches('/'))];
        download_bases.extend(asset_hosts.into_iter().map(|h| h.trim_end_matches('/').to_string()));
        Self { http, repo: RELEASES_REPO.into(), download_bases }
    }

    fn allowed(&self, url: &str) -> bool {
        self.download_bases.iter().any(|b| under(url, b))
    }
}

impl UpdateSource for GitHubReleases {
    fn releases(&self) -> ForgeFuture<'_, Vec<GhRelease>> {
        Box::pin(async move { self.http.get(&format!("/repos/{}/releases?per_page={PER_PAGE}", self.repo)).await?.json(self.http.host()) })
    }

    fn fetch<'a>(&'a self, url: &'a str) -> ForgeFuture<'a, Vec<u8>> {
        Box::pin(async move { self.http.fetch_within(url, &|u: &str| self.allowed(u), MAX_SUMS).await })
    }

    fn download<'a>(&'a self, url: &'a str, dest: &'a Path, progress: DownloadProgress, cancel: Arc<AtomicBool>) -> ForgeFuture<'a, u64> {
        Box::pin(async move {
            let report = move |n: u64| progress(n);
            self.http.download_within(url, &|u: &str| self.allowed(u), MAX_PACKAGE, DownloadTo { dest, progress: &report, cancel: &cancel }).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{Canned, TestServer};
    use gitbolt_core::error::GbErrorKind;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;

    fn releases_at(s: &TestServer) -> GitHubReleases {
        GitHubReleases::new(&format!("{}/api", s.base), &format!("{}/web", s.base), vec![format!("{}/objects", s.base)])
    }

    #[tokio::test]
    async fn lists_the_releases_without_a_token() {
        let s = TestServer::start(|_, _| Canned::json(200, r#"[{"tag_name":"v0.3.0","draft":false,"prerelease":false,"html_url":"h","body":"notes","assets":[{"name":"SHA256SUMS","size":10,"browser_download_url":"u"}]}]"#));
        let list = releases_at(&s).releases().await.unwrap();
        assert_eq!((list[0].tag_name.as_str(), list[0].assets[0].name.as_str()), ("v0.3.0", "SHA256SUMS"));
        let head = s.heads.lock().unwrap()[0].clone();
        assert!(head.starts_with("get /api/repos/gitboltapp/gitbolt/releases?per_page=30 http/1.1"), "{head}");
        assert!(!head.contains("authorization"), "{head}");
        assert!(head.contains("user-agent: gitbolt/"), "{head}");
    }

    #[tokio::test]
    async fn downloads_follow_the_release_redirect_to_the_asset_host_only() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let served = body.clone();
        let s = TestServer::start(move |_, head| {
            if head.starts_with("get /web/") {
                // GitHub's answer: a redirect to its storage, by absolute URL.
                let port = head.lines().find_map(|l| l.strip_prefix("host: ")).unwrap_or("").trim().to_string();
                Canned { status: 302, headers: vec![("Location".into(), format!("http://{port}/objects/abc?sig=1"))], body: vec![] }
            } else {
                Canned { status: 200, headers: vec![("Content-Type".into(), "application/octet-stream".into())], body: served.clone() }
            }
        });
        let r = releases_at(&s);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("GitBolt_0.3.0_amd64.deb.1.part");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let url = format!("{}/web/GitBoltApp/gitbolt/releases/download/v0.3.0/GitBolt_0.3.0_amd64.deb", s.base);
        let n = r.download(&url, &dest, Arc::new(move |n| log.lock().unwrap().push(n)), Arc::new(AtomicBool::new(false))).await.unwrap();
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(seen.lock().unwrap().last(), Some(&(body.len() as u64)));
        let heads = s.heads.lock().unwrap().clone();
        assert_eq!(heads.len(), 2);
        assert!(heads.iter().all(|h| !h.contains("authorization")), "{heads:?}");
        assert!(heads[1].starts_with("get /objects/abc?sig=1 "), "{heads:?}");
    }

    #[tokio::test]
    async fn a_download_elsewhere_is_refused_and_leaves_nothing() {
        let s = TestServer::start(|_, _| Canned { status: 302, headers: vec![("Location".into(), "http://127.0.0.1:9/evil/pkg.deb".into())], body: vec![] });
        let r = releases_at(&s);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("p.part");
        let url = format!("{}/web/GitBoltApp/gitbolt/releases/download/v0.3.0/p.deb", s.base);
        let e = r.download(&url, &dest, Arc::new(|_| {}), Arc::new(AtomicBool::new(false))).await.unwrap_err();
        assert_eq!(e.message, "The download was sent to 127.0.0.1:9, which GitBolt doesn't download updates from");
        // Not even the first request goes to an address outside the releases.
        let e = r.download(&format!("{}/web/someone/else/releases/download/v1/p.deb", s.base), &dest, Arc::new(|_| {}), Arc::new(AtomicBool::new(false))).await.unwrap_err();
        assert!(e.message.contains("doesn't download updates from"), "{}", e.message);
        assert_eq!(s.hits(), 1);
        assert!(!dest.exists());
        let e = r.fetch("https://example.com/SHA256SUMS").await.unwrap_err();
        assert!(e.message.contains("doesn't download updates from"), "{}", e.message);
    }

    #[test]
    fn github_downloads_stay_on_https_and_githubs_hosts() {
        let r = GitHubReleases::github();
        assert!(r.allowed("https://github.com/GitBoltApp/gitbolt/releases/download/v0.3.0/GitBolt_0.3.0_amd64.deb"));
        assert!(r.allowed("https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz=1"));
        assert!(r.allowed("https://release-assets.githubusercontent.com/github-production-release-asset/1/2"));
        assert!(!r.allowed("http://github.com/GitBoltApp/gitbolt/releases/download/v0.3.0/x.deb"));
        assert!(!r.allowed("https://github.com/someone/else/releases/download/v0.3.0/x.deb"));
        assert!(!r.allowed("https://objects.githubusercontent.com.evil.example/x"));
    }

    #[tokio::test]
    async fn a_cancel_stops_a_stalled_download_at_once_and_removes_the_file() {
        // Headers and some of the body, then nothing: the read waits on the server.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hold = Arc::new(Mutex::new(Vec::new()));
        let keep = hold.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                    line.clear();
                }
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n");
                let _ = stream.write_all(&[7u8; 70_000]);
                keep.lock().unwrap().push(stream);
            }
        });
        let r = GitHubReleases::new(&format!("{base}/api"), &format!("{base}/web"), vec![]);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("p.part");
        let cancel = Arc::new(AtomicBool::new(false));
        let (flag, at) = (cancel.clone(), Arc::new(std::sync::atomic::AtomicU64::new(0)));
        let got = at.clone();
        let url = format!("{base}/web/GitBoltApp/gitbolt/releases/download/v0.3.0/p.deb");
        let job = tokio::spawn({
            let dest = dest.clone();
            async move { r.download(&url, &dest, Arc::new(move |n| got.store(n, Ordering::SeqCst)), flag).await }
        });
        for _ in 0..200 {
            if at.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(at.load(Ordering::SeqCst) > 0, "some progress first");
        cancel.store(true, Ordering::SeqCst);
        let e = tokio::time::timeout(std::time::Duration::from_secs(2), job).await.expect("the cancel answers at once").unwrap().unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Cancelled);
        assert!(!dest.exists());
        // The server hangs up: the abandoned read ends (the runtime waits for it at the end).
        hold.lock().unwrap().clear();
    }
}
