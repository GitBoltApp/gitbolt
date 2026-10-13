//! GitBolt's own releases on GitHub (core's `UpdateSource`): the list from the REST API, and the
//! assets from the release download URLs, through the forge clients' `HttpClient`, with no token.
//!
//! The list comes from the project under its new name (`GitVoltApp/gitvolt`), or from its old one
//! (`GitBoltApp/gitbolt`) when the new one answers 404 (it doesn't exist yet) or has no releases.
//! A download may start only under `<web>/<owner>/<repo>/releases/download/` of either (owner and
//! repo in any case, as GitHub takes them), and follow redirects only
//! to GitHub's asset storage hosts (`objects.githubusercontent.com`, and
//! `release-assets.githubusercontent.com`, where GitHub moved them in 2025); all https.

use crate::http::{under, ClientConfig, DownloadTo, HttpClient, REQUEST_TIMEOUT};
use gitbolt_core::forge::ForgeFuture;
use gitbolt_core::error::GbErrorKind;
use gitbolt_core::updates::release::GhRelease;
use gitbolt_core::updates::{DownloadProgress, UpdateSource, RELEASES_REPOS};
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
    /// Asked in turn while one answers 404 or lists nothing: the new name's, then the old one's.
    /// A download may start under their release downloads.
    repos: Vec<String>,
    web: String,
    /// Where a download may redirect: the asset storage hosts.
    asset_hosts: Vec<String>,
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
        let asset_hosts = asset_hosts.into_iter().map(|h| h.trim_end_matches('/').to_string()).collect();
        Self { http, repos: RELEASES_REPOS.iter().map(|r| r.to_string()).collect(), web: web.trim_end_matches('/').into(), asset_hosts }
    }

    fn allowed(&self, url: &str) -> bool {
        self.release_download(url) || self.asset_hosts.iter().any(|b| under(url, b))
    }

    /// `<web>/<owner>/<repo>/releases/download/<…>` of one of the repos: the scheme, host and
    /// `/releases/download/` exactly, the owner and repo in any case. Never a path with `.` or `..`
    /// in it, or an encoded `/`, `\` or `.`, which could lead elsewhere once a server decodes it.
    fn release_download(&self, url: &str) -> bool {
        let Some(rest) = url.strip_prefix(&format!("{}/", self.web)).filter(|_| under(url, &self.web)) else { return false };
        let path = rest.split(['?', '#']).next().unwrap_or_default();
        let lower = path.to_ascii_lowercase();
        if path.split('/').any(|p| p == "." || p == "..") || path.contains('\\') || ["%2f", "%5c", "%2e", "%25"].iter().any(|e| lower.contains(e)) {
            return false;
        }
        let mut parts = path.splitn(3, '/');
        let (Some(owner), Some(repo), Some(rest)) = (parts.next(), parts.next(), parts.next()) else { return false };
        let repo = format!("{owner}/{repo}");
        rest.strip_prefix("releases/download/").is_some_and(|r| !r.is_empty()) && self.repos.iter().any(|r| r.eq_ignore_ascii_case(&repo))
    }
}

impl UpdateSource for GitHubReleases {
    fn releases(&self) -> ForgeFuture<'_, Vec<GhRelease>> {
        Box::pin(async move {
            // A repository with no releases yet (made ahead of the move) counts as missing, but
            // its empty list beats the last one missing too.
            let mut empty = None;
            let mut missing = None;
            for repo in &self.repos {
                match self.http.get(&format!("/repos/{repo}/releases?per_page={PER_PAGE}")).await {
                    Err(e) if e.kind == GbErrorKind::NotFound => missing = Some(e),
                    answer => {
                        let list: Vec<GhRelease> = answer?.json(self.http.host())?;
                        if !list.is_empty() {
                            return Ok(list);
                        }
                        empty = Some(list);
                    }
                }
            }
            empty.ok_or_else(|| missing.expect("a releases repository"))
        })
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
    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;

    fn releases_at(s: &TestServer) -> GitHubReleases {
        GitHubReleases::new(&format!("{}/api", s.base), &format!("{}/web", s.base), vec![format!("{}/objects", s.base)])
    }

    const LIST: &str = r#"[{"tag_name":"v0.3.0","draft":false,"prerelease":false,"html_url":"h","body":"notes","assets":[{"name":"SHA256SUMS","size":10,"browser_download_url":"u"}]}]"#;

    #[tokio::test]
    async fn lists_the_releases_under_the_new_name_in_one_request_without_a_token() {
        let s = TestServer::start(|_, _| Canned::json(200, LIST));
        let list = releases_at(&s).releases().await.unwrap();
        assert_eq!((list[0].tag_name.as_str(), list[0].assets[0].name.as_str()), ("v0.3.0", "SHA256SUMS"));
        let heads = s.heads.lock().unwrap().clone();
        assert_eq!(heads.len(), 1, "{heads:?}");
        assert!(heads[0].starts_with("get /api/repos/gitvoltapp/gitvolt/releases?per_page=30 http/1.1"), "{heads:?}");
        assert!(!heads[0].contains("authorization"), "{heads:?}");
        assert!(heads[0].contains("user-agent: gitbolt/"), "{heads:?}");
    }

    #[tokio::test]
    async fn falls_back_to_the_old_name_while_the_new_one_is_missing() {
        let s = TestServer::start(|_, head| if head.contains("/repos/gitvoltapp/gitvolt/") { Canned::json(404, r#"{"message":"Not Found"}"#) } else { Canned::json(200, LIST) });
        let r = releases_at(&s);
        assert_eq!(r.releases().await.unwrap()[0].tag_name, "v0.3.0");
        let heads = s.heads.lock().unwrap().clone();
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(heads[0].starts_with("get /api/repos/gitvoltapp/gitvolt/releases?per_page=30 "), "{heads:?}");
        assert!(heads[1].starts_with("get /api/repos/gitboltapp/gitbolt/releases?per_page=30 "), "{heads:?}");
        assert!(heads.iter().all(|h| !h.contains("authorization")), "{heads:?}");
        // Each check asks the new name first again.
        r.releases().await.unwrap();
        assert!(s.heads.lock().unwrap()[2].starts_with("get /api/repos/gitvoltapp/gitvolt/"));
    }

    #[tokio::test]
    async fn only_a_404_falls_back_and_redirects_stay_on_the_api() {
        // Any other failure of the new name's list is the check's failure.
        let s = TestServer::start(|_, _| Canned::json(500, r#"{"message":"down"}"#));
        assert!(releases_at(&s).releases().await.unwrap_err().message.contains("HTTP 500"));
        assert_eq!(s.hits(), 1);
        // A redirect off the API isn't followed, nor taken for a missing repository.
        let s = TestServer::start(|_, _| Canned { status: 301, headers: vec![("Location".into(), "https://example.com/repos/x/releases".into())], body: vec![] });
        let e = releases_at(&s).releases().await.unwrap_err();
        assert!(e.message.contains("didn't follow it"), "{}", e.message);
        assert_eq!(s.hits(), 1);
        // The new name with no releases yet: the old one's.
        let s = TestServer::start(|_, head| Canned::json(200, if head.contains("/repos/gitvoltapp/gitvolt/") { "[]" } else { LIST }));
        assert_eq!(releases_at(&s).releases().await.unwrap()[0].tag_name, "v0.3.0");
        assert_eq!(s.hits(), 2);
        let s = TestServer::start(|_, _| Canned::json(200, "[]"));
        assert!(releases_at(&s).releases().await.unwrap().is_empty(), "neither has any");
        assert_eq!(s.hits(), 2);
        let s = TestServer::start(|_, head| if head.contains("/repos/gitvoltapp/gitvolt/") { Canned::json(200, "[]") } else { Canned::json(404, r#"{"message":"Not Found"}"#) });
        assert!(releases_at(&s).releases().await.unwrap().is_empty(), "no releases, rather than not found");
        // Both missing: not found.
        let s = TestServer::start(|_, _| Canned::json(404, r#"{"message":"Not Found"}"#));
        assert_eq!(releases_at(&s).releases().await.unwrap_err().kind, GbErrorKind::NotFound);
        assert_eq!(s.hits(), 2);
    }

    #[tokio::test]
    async fn an_unchanged_list_is_a_304_under_either_name() {
        let s = TestServer::start(|_, head| {
            if head.contains("/repos/gitvoltapp/gitvolt/") {
                Canned::json(404, r#"{"message":"Not Found"}"#)
            } else if head.contains("if-none-match: \"l1\"") {
                Canned { status: 304, headers: vec![], body: vec![] }
            } else {
                let mut c = Canned::json(200, LIST);
                c.headers.push(("ETag".into(), "\"l1\"".into()));
                c
            }
        });
        let r = releases_at(&s);
        let first = r.releases().await.unwrap();
        assert_eq!(r.releases().await.unwrap(), first, "from the cached copy");
        let heads = s.heads.lock().unwrap().clone();
        assert_eq!(heads.len(), 4, "{heads:?}");
        assert!(heads[3].contains("if-none-match: \"l1\""), "{heads:?}");
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
        // The same under the new name, and its SHA256SUMS.
        let url = format!("{}/web/GitVoltApp/gitvolt/releases/download/v0.7.0/GitVolt_0.7.0_amd64.deb", s.base);
        assert_eq!(r.download(&url, &dest, Arc::new(|_| {}), Arc::new(AtomicBool::new(false))).await.unwrap(), body.len() as u64);
        assert_eq!(s.heads.lock().unwrap()[3].split(' ').nth(1), Some("/objects/abc?sig=1"));
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
        // Nor anywhere else of the new name's owner, nor outside its release downloads.
        for path in ["GitVoltApp/other/releases/download/v1/p.deb", "GitVoltApp/gitvolt/archive/refs/tags/v1.tar.gz", "GitBoltApp/gitbolt/archive/refs/tags/v1.tar.gz"] {
            let e = r.download(&format!("{}/web/{path}", s.base), &dest, Arc::new(|_| {}), Arc::new(AtomicBool::new(false))).await.unwrap_err();
            assert!(e.message.contains("doesn't download updates from"), "{path}: {}", e.message);
            assert!(r.fetch(&format!("{}/web/{path}", s.base)).await.unwrap_err().message.contains("doesn't download updates from"), "{path}");
        }
        assert_eq!(s.hits(), 1);
        assert!(!dest.exists());
        let e = r.fetch("https://example.com/SHA256SUMS").await.unwrap_err();
        assert!(e.message.contains("doesn't download updates from"), "{}", e.message);
    }

    #[tokio::test]
    async fn sha256sums_come_from_either_names_release_downloads() {
        let s = TestServer::start(|_, _| Canned { status: 200, headers: vec![], body: b"sums".to_vec() });
        let r = releases_at(&s);
        for repo in ["GitVoltApp/gitvolt", "GitBoltApp/gitbolt"] {
            assert_eq!(r.fetch(&format!("{}/web/{repo}/releases/download/v0.7.0/SHA256SUMS", s.base)).await.unwrap(), b"sums", "{repo}");
        }
        assert_eq!(s.hits(), 2);
    }

    #[test]
    fn github_downloads_stay_on_https_and_githubs_hosts() {
        let r = GitHubReleases::github();
        assert!(r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/v0.7.0/GitVolt_0.7.0_amd64.deb"));
        assert!(r.allowed("https://github.com/GitBoltApp/gitbolt/releases/download/v0.3.0/GitBolt_0.3.0_amd64.deb"));
        assert!(r.allowed("https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz=1"));
        assert!(r.allowed("https://release-assets.githubusercontent.com/github-production-release-asset/1/2"));
        assert!(!r.allowed("http://github.com/GitBoltApp/gitbolt/releases/download/v0.3.0/x.deb"));
        assert!(!r.allowed("http://github.com/GitVoltApp/gitvolt/releases/download/v0.7.0/x.deb"));
        assert!(!r.allowed("https://github.com/someone/else/releases/download/v0.3.0/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/other/releases/download/v0.7.0/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/archive/refs/tags/v0.7.0.tar.gz"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download-evil/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt-fork/releases/download/v0.7.0/x.deb"));
        assert!(!r.allowed("https://objects.githubusercontent.com.evil.example/x"));
        // GitHub's owner and repo names are case-insensitive; the rest isn't.
        assert!(r.allowed("https://github.com/gitvoltapp/GitVolt/releases/download/v0.7.0/GitVolt_0.7.0_amd64.deb"));
        assert!(r.allowed("https://github.com/GITBOLTAPP/gitbolt/releases/download/v0.6.1/SHA256SUMS"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/Releases/Download/v0.7.0/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/../../../GitVoltApp/other/x"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/v1/../x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp%2Fgitvolt/releases/download/v0.7.0/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/v0.7.0%2f..%2F..%2Fother/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/%2e%2e/x.deb"));
        assert!(!r.allowed("https://github.com/GitVoltApp/gitvolt/releases/download/%252e%252e/x.deb"));
        assert!(!r.allowed("https://evil@github.com/GitVoltApp/gitvolt/releases/download/v0.7.0/x.deb"));
        // An asset host's signed URL keeps its encoded query.
        assert!(r.allowed("https://release-assets.githubusercontent.com/github-production-release-asset/1/2?X-Amz-Credential=a%2F20261013%2Fus-east-1"));
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

    /// A package GitBolt downloads itself carries no quarantine flag: macOS adds one only for
    /// sandboxed apps, or those whose Info.plist asks (`LSFileQuarantineEnabled`), and GitBolt is
    /// neither. So the `.dmg` update's GitBolt.app isn't translocated or re-checked by Gatekeeper.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_download_on_macos_carries_no_quarantine_flag() {
        let s = TestServer::start(|_, _| Canned { status: 200, headers: vec![("Content-Type".into(), "application/x-apple-diskimage".into())], body: b"a fictional disk image".to_vec() });
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("GitBolt_0.3.0_aarch64.dmg.1.part");
        let url = format!("{}/web/GitBoltApp/gitbolt/releases/download/v0.3.0/GitBolt_0.3.0_aarch64.dmg", s.base);
        releases_at(&s).download(&url, &part, Arc::new(|_| {}), Arc::new(AtomicBool::new(false))).await.unwrap();
        // As core keeps a verified download.
        let dmg = dir.path().join("GitBolt_0.3.0_aarch64.dmg");
        std::fs::rename(&part, &dmg).unwrap();
        let out = std::process::Command::new("xattr").arg("-l").arg(&dmg).output().unwrap();
        let attrs = String::from_utf8_lossy(&out.stdout);
        println!("xattr -l of the download: {attrs:?}");
        assert!(out.status.success());
        assert!(!attrs.contains("com.apple.quarantine"), "{attrs}");
    }
}
