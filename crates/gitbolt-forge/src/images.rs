//! Markdown images (spec #5 §4.2): which addresses a forge serves itself (its allowlist), how they
//! are fetched (the token only to the account's own API host, redirects re-checked, the image
//! size cap and the disk cache), and a clicked image's token-less fetch.

use crate::avatar_cache::{payload_of, DiskAvatarCache, Lookup};
use crate::http::{under, ClientConfig, HttpClient, ImageFetch, MAX_IMAGE, MAX_VIDEO};
use base64::Engine;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::{avatar_url_is_clean, image_host, ForgeImage, ForgeProject};
use std::time::Duration;

/// Where to fetch an image and what the disk cache calls it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRoute {
    pub url: String,
    pub cache_key: String,
    /// Asked when `url` answers 404: a GitLab upload's web address, for a GitLab without the
    /// uploads API (before 17.4).
    pub fallback: Option<String>,
    /// A 401/403 means the address's signature ran out (GitHub's attachments): `Expired`, which
    /// fetches the bodies again. Otherwise the forge refused it.
    pub signed: bool,
}

/// github.com and GitHub's image hosts (`avatars` is the account's avatar base).
pub fn default_github_image_bases(web: &str, avatars: &str) -> Vec<String> {
    vec![
        web.trim_end_matches('/').to_string(),
        "https://user-images.githubusercontent.com".into(),
        "https://private-user-images.githubusercontent.com".into(),
        "https://raw.githubusercontent.com".into(),
        avatars.trim_end_matches('/').to_string(),
    ]
}

fn https(url: &str) -> bool {
    url.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://"))
}

fn http(url: &str) -> bool {
    url.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("http://"))
}

/// GitHub: `url` under one of `bases`, with a clean shape (`avatar_url_is_clean`), https unless
/// its base is plain http (the harness). A signed URL's query (its `jwt`) isn't part of the cache
/// key: a re-signed URL is the same picture, and no signature reaches the disk index.
pub fn github_route(url: &str, bases: &[String]) -> Option<ImageRoute> {
    let url = url.trim();
    if !avatar_url_is_clean(url) {
        return None;
    }
    let base = bases.iter().find(|b| under(url, b))?;
    if !https(url) && !http(base) {
        return None;
    }
    let cache_key = if url.contains("jwt=") { url.split('?').next().unwrap_or(url).to_string() } else { url.to_string() };
    Some(ImageRoute { url: url.to_string(), cache_key, fallback: None, signed: true })
}

fn is_secret(s: &str) -> bool {
    (10..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// GitLab: `url` under the account's web host with a clean shape. A project upload
/// (`<web>/<project>/uploads/<secret>/<file>` or `<web>/-/project/<id>/uploads/<secret>/<file>`)
/// is read through the API (`GET /projects/:id/uploads/:secret/:filename`, `api_url` builds it),
/// falling back to `url` itself on a 404 (a GitLab before 17.4 has no such route); any other
/// address on the web host is fetched as it is.
pub fn gitlab_route(url: &str, web: &str, project: &ForgeProject, api_url: impl Fn(&str) -> String) -> Option<ImageRoute> {
    let url = url.trim();
    let web = web.trim_end_matches('/');
    if !avatar_url_is_clean(url) || !under(url, web) {
        return None;
    }
    let path = url[web.len()..].split('?').next().unwrap_or("");
    let lower = path.to_ascii_lowercase();
    let own = format!("/{}/uploads/", project.path.to_ascii_lowercase());
    let by_id = format!("/-/project/{}/uploads/", project.id);
    let rest = if lower.starts_with(&own) {
        Some(&path[own.len()..])
    } else if lower.starts_with(&by_id) {
        Some(&path[by_id.len()..])
    } else {
        None
    };
    let (target, fallback) = match rest.and_then(|r| r.split_once('/')) {
        Some((secret, file)) if is_secret(secret) && !file.is_empty() && !file.contains('/') => (api_url(&format!("/projects/{}/uploads/{secret}/{file}", project.id)), Some(url.to_string())),
        _ => (url.to_string(), None),
    };
    Some(ImageRoute { url: target, cache_key: url.to_string(), fallback, signed: false })
}

fn found(p: gitbolt_core::avatar::AvatarPayload) -> ForgeImage {
    ForgeImage::Found { mime: p.mime, base64: p.base64 }
}

fn missing(reason: impl Into<String>) -> ForgeImage {
    ForgeImage::Missing { reason: reason.into() }
}

fn not_an_image(content_type: &str) -> ForgeImage {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    missing(if ct.is_empty() { "not an image GitBolt shows".to_string() } else { format!("not an image GitBolt shows ({ct})") })
}

/// `route` through the host's disk cache (found 7 days, missing 1 day; `Expired`, `Ask`, a refusal
/// and a sign-in page are never cached) and `get_image_within`.
pub async fn fetch(http: &HttpClient, cache: Option<&DiskAvatarCache>, route: &ImageRoute, own_origin: &str, allowed: &(dyn Fn(&str) -> bool + Sync)) -> Result<ForgeImage, GbError> {
    let key = format!("img:{}", route.cache_key);
    if let Some(c) = cache {
        match c.lookup_exact(&key) {
            Lookup::Found(p) => return Ok(found(p)),
            Lookup::Missing => return Ok(missing("not found or not an image (remembered for a day)")),
            Lookup::Unknown => {}
        }
    }
    let mut got = http.get_image_within(&route.url, own_origin, allowed).await?;
    if let (ImageFetch::Missing(_), Some(web)) = (&got, &route.fallback) {
        got = http.get_image_within(web, own_origin, allowed).await?;
    }
    Ok(match got {
        ImageFetch::Found { content_type, bytes } => {
            let p = match cache {
                Some(c) => {
                    let p = c.store_found_exact(&key, &content_type, &bytes);
                    if p.is_none() {
                        c.store_missing_exact(&key);
                    }
                    p
                }
                None => payload_of(&content_type, &bytes),
            };
            p.map_or_else(|| not_an_image(&content_type), found)
        }
        ImageFetch::Missing(status) => {
            if let Some(c) = cache {
                c.store_missing_exact(&key);
            }
            missing(status.to_string())
        }
        other => not_found(other, route.signed, MAX_IMAGE),
    })
}

/// Every answer but a found file: why it isn't shown.
fn not_found(got: ImageFetch, signed: bool, limit: u64) -> ForgeImage {
    match got {
        ImageFetch::Found { .. } => missing("not shown"),
        ImageFetch::Missing(status) => missing(status.to_string()),
        ImageFetch::Forbidden(_) if signed => ForgeImage::Expired,
        ImageFetch::Forbidden(status) => missing(format!("no access ({status})")),
        ImageFetch::SignIn => missing("needs sign-in"),
        ImageFetch::Elsewhere(host) => ForgeImage::Ask { host },
        ImageFetch::TooLarge => missing(format!("larger than {} MB", limit / (1024 * 1024))),
    }
}

// --- videos (GitLab renders `![clip](/uploads/…/clip.webm)` as a video) ---
/// A video's type, from its `Content-Type` or, for a generic binary type (GitLab's uploads API),
/// its first bytes: WebM/Matroska, MP4 (`ftyp`, QuickTime's `qt  ` brand apart) or Ogg.
pub fn video_mime(content_type: &str, bytes: &[u8]) -> Option<&'static str> {
    let base = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match base.as_str() {
        "video/webm" => return Some("video/webm"),
        "video/mp4" | "video/x-m4v" => return Some("video/mp4"),
        "video/quicktime" => return Some("video/quicktime"),
        "video/ogg" => return Some("video/ogg"),
        "" | "application/octet-stream" | "binary/octet-stream" => {}
        _ => return None,
    }
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        Some("video/webm")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        Some(if &bytes[8..12] == b"qt  " { "video/quicktime" } else { "video/mp4" })
    } else if bytes.starts_with(b"OggS") {
        Some("video/ogg")
    } else {
        None
    }
}

fn video_found(content_type: &str, bytes: &[u8]) -> ForgeImage {
    match video_mime(content_type, bytes) {
        Some(mime) => ForgeImage::Found { mime: mime.into(), base64: base64::engine::general_purpose::STANDARD.encode(bytes) },
        None => {
            let ct = content_type.split(';').next().unwrap_or("").trim();
            missing(if ct.is_empty() { "not a video GitBolt plays".to_string() } else { format!("not a video GitBolt plays ({ct})") })
        }
    }
}

/// A video at `route`, as `fetch` an image (the same hosts, token and redirect rules), up to
/// `MAX_VIDEO`; never kept on disk.
pub async fn fetch_video(http: &HttpClient, route: &ImageRoute, own_origin: &str, allowed: &(dyn Fn(&str) -> bool + Sync)) -> Result<ForgeImage, GbError> {
    fetch_video_within(http, route, own_origin, allowed, MAX_VIDEO).await
}

async fn fetch_video_within(http: &HttpClient, route: &ImageRoute, own_origin: &str, allowed: &(dyn Fn(&str) -> bool + Sync), limit: u64) -> Result<ForgeImage, GbError> {
    let mut got = http.get_media_within(&route.url, own_origin, allowed, limit).await?;
    if let (ImageFetch::Missing(_), Some(web)) = (&got, &route.fallback) {
        got = http.get_media_within(web, own_origin, allowed, limit).await?;
    }
    Ok(match got {
        ImageFetch::Found { content_type, bytes } => video_found(&content_type, &bytes),
        other => not_found(other, route.signed, limit),
    })
}

/// A clicked video ("Load video from <host>"): `fetch_public`'s rules, the video size cap.
pub async fn fetch_public_video(url: &str, allow_http: bool) -> Result<ForgeImage, GbError> {
    let url = url.trim();
    if !(https(url) || (allow_http && http(url))) || !avatar_url_is_clean(url) {
        return Err(GbError::new(GbErrorKind::InvalidInput, "GitBolt loads videos over https only"));
    }
    let client = HttpClient::new(ClientConfig { host: image_host(url), api_base: "https://api.invalid".into(), token: None, headers: Vec::new(), timeout: Duration::from_secs(120) });
    let allowed = |next: &str| https(next) || allow_http;
    Ok(match client.get_media_within(url, "", &allowed, MAX_VIDEO).await? {
        ImageFetch::Found { content_type, bytes } => video_found(&content_type, &bytes),
        ImageFetch::Elsewhere(host) => missing(format!("redirected to {host}")),
        other => not_found(other, false, MAX_VIDEO),
    })
}
// --- end videos ---

/// A clicked image ("Load image from <host>"): a fresh token-less client, https only (plain http
/// only when `allow_http`: the harness), one https redirect, the image size cap.
pub async fn fetch_public(url: &str, allow_http: bool) -> Result<ForgeImage, GbError> {
    let url = url.trim();
    if !(https(url) || (allow_http && http(url))) || !avatar_url_is_clean(url) {
        return Err(GbError::new(GbErrorKind::InvalidInput, "GitBolt loads images over https only"));
    }
    let client = HttpClient::new(ClientConfig { host: image_host(url), api_base: "https://api.invalid".into(), token: None, headers: Vec::new(), timeout: Duration::from_secs(20) });
    let allowed = |next: &str| https(next) || allow_http;
    Ok(match client.get_image_within(url, "", &allowed).await? {
        ImageFetch::Found { content_type, bytes } => payload_of(&content_type, &bytes).map_or_else(|| not_an_image(&content_type), found),
        ImageFetch::Elsewhere(host) => missing(format!("redirected to {host}")),
        other => not_found(other, false, MAX_IMAGE),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{Canned, TestServer};
    use gitbolt_core::forge::{ForgeKind, ForgeProject};

    const UUID: &str = "1b2c3d4e-0000-4000-8000-00000000abcd";
    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn group_project() -> ForgeProject {
        ForgeProject {
            kind: ForgeKind::GitLab, id: 42, host: "gitlab.example.com".into(), path: "group/project".into(), name: "project".into(), owner: "group".into(),
            web_url: "https://gitlab.example.com/group/project".into(), default_branch: Some("main".into()), clone_https: String::new(), clone_ssh: String::new(),
            fork_of: None, updated_at: None, archived: false, owner_avatar_url: None,
        }
    }

    #[test]
    fn github_images_load_only_from_its_hosts_and_a_signature_never_keys_the_cache() {
        let bases = default_github_image_bases("https://github.com", "https://avatars.githubusercontent.com");
        let signed = format!("https://private-user-images.githubusercontent.com/1/2-{UUID}.png?jwt=eyJ.a.b");
        let r = github_route(&signed, &bases).unwrap();
        assert_eq!(r.url, signed);
        assert_eq!(r.cache_key, format!("https://private-user-images.githubusercontent.com/1/2-{UUID}.png"));
        for ok in [format!("https://github.com/user-attachments/assets/{UUID}"), "https://raw.githubusercontent.com/o/r/main/a.png".into(), "https://user-images.githubusercontent.com/1/a.png".into(), "https://avatars.githubusercontent.com/u/1".into()] {
            assert!(github_route(&ok, &bases).is_some(), "{ok}");
        }
        for no in ["http://github.com/a.png", "https://evil.example/a.png", "https://github.com.evil.example/a.png", "https://user@github.com/a.png", "https://raw.githubusercontent.com/o/../x.png", "https://raw.githubusercontent.com/a%2f..%2fb.png"] {
            assert!(github_route(no, &bases).is_none(), "{no}");
        }
    }

    #[test]
    fn gitlab_uploads_go_through_the_api_and_other_web_images_stay_on_the_web_host() {
        let p = group_project();
        let api = |path: &str| format!("https://gitlab.example.com/api/v4{path}");
        let web = "https://gitlab.example.com";
        let up = format!("https://gitlab.example.com/group/project/uploads/{SECRET}/shot%20one.png");
        let r = gitlab_route(&up, web, &p, api).unwrap();
        assert_eq!(r.url, format!("https://gitlab.example.com/api/v4/projects/42/uploads/{SECRET}/shot%20one.png"));
        assert_eq!(r.cache_key, up);
        assert_eq!(r.fallback.as_deref(), Some(up.as_str()), "a GitLab before 17.4 serves it at its web address");
        assert!(!r.signed);
        let by_id = format!("https://gitlab.example.com/-/project/42/uploads/{SECRET}/a.png");
        assert_eq!(gitlab_route(&by_id, web, &p, api).unwrap().url, format!("https://gitlab.example.com/api/v4/projects/42/uploads/{SECRET}/a.png"));
        let upper = format!("https://gitlab.example.com/Group/Project/uploads/{SECRET}/a.png");
        assert!(gitlab_route(&upper, web, &p, api).unwrap().url.contains("/api/v4/projects/42/uploads/"), "GitLab paths ignore case");
        let raw = "https://gitlab.example.com/group/project/-/raw/main/a.png";
        assert_eq!(gitlab_route(raw, web, &p, api).unwrap(), ImageRoute { url: raw.into(), cache_key: raw.into(), fallback: None, signed: false });
        let not_secret = "https://gitlab.example.com/group/project/uploads/zz/a.png";
        assert_eq!(gitlab_route(not_secret, web, &p, api).unwrap().url, not_secret, "not an upload: fetched as it is, on the web host");
        assert!(gitlab_route("https://cdn.example.org/a.png", web, &p, api).is_none());
        assert!(gitlab_route("http://gitlab.example.com/a.png", web, &p, api).is_none(), "the web host is https");
    }

    // --- 5A T3 ---
    #[tokio::test]
    async fn two_image_urls_differing_only_in_case_are_two_cache_entries() {
        let s = TestServer::start(|n, _| match n {
            0 => Canned { status: 200, headers: vec![("Content-Type".into(), "image/png".into())], body: b"\x89PNGq".to_vec() },
            _ => Canned::json(404, r#"{"message":"Not Found"}"#),
        });
        let http = HttpClient::new(ClientConfig { host: "github.com".into(), api_base: format!("{}/api", s.base), token: None, headers: vec![], timeout: Duration::from_secs(5) });
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskAvatarCache::new(dir.path().join("github.com"));
        let anywhere = |_: &str| true;
        let route = |u: String| ImageRoute { cache_key: u.clone(), url: u, fallback: None, signed: true };
        let upper = route(format!("{}/o/r/main/Shot.png", s.base));
        let lower = route(format!("{}/o/r/main/shot.png", s.base));
        assert!(matches!(fetch(&http, Some(&cache), &upper, "", &anywhere).await.unwrap(), ForgeImage::Found { .. }));
        assert_eq!(fetch(&http, Some(&cache), &lower, "", &anywhere).await.unwrap(), ForgeImage::Missing { reason: "404".into() }, "asked, not the other's cached copy");
        assert!(matches!(fetch(&http, Some(&cache), &upper, "", &anywhere).await.unwrap(), ForgeImage::Found { .. }), "still cached as found");
        assert_eq!(s.hits(), 2);
    }
    // --- end 5A T3 ---

    const WEBM: &[u8] = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01webm";

    #[test]
    fn a_video_is_known_by_its_type_or_by_its_first_bytes() {
        assert_eq!(video_mime("video/webm; codecs=vp9", b""), Some("video/webm"));
        assert_eq!(video_mime("application/octet-stream", WEBM), Some("video/webm"));
        assert_eq!(video_mime("application/octet-stream", b"\0\0\0\x20ftypisom\0\0\x02\0"), Some("video/mp4"));
        assert_eq!(video_mime("", b"\0\0\0\x14ftypqt  \0\0\0\0"), Some("video/quicktime"));
        assert_eq!(video_mime("binary/octet-stream", b"OggS\0\x02"), Some("video/ogg"));
        assert_eq!(video_mime("text/html", WEBM), None, "only a generic type is sniffed");
        assert_eq!(video_mime("application/octet-stream", b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(video_mime("image/png", b""), None);
    }

    #[tokio::test]
    async fn a_video_loads_through_the_api_up_to_its_cap_and_a_larger_one_says_so() {
        let s = TestServer::start(|n, _| match n {
            0 => Canned { status: 200, headers: vec![("Content-Type".into(), "application/octet-stream".into())], body: WEBM.to_vec() },
            1 => Canned { status: 200, headers: vec![("Content-Type".into(), "application/octet-stream".into())], body: vec![0x1a; 4096] },
            _ => Canned { status: 200, headers: vec![("Content-Type".into(), "text/html".into())], body: b"<!doctype html>".to_vec() },
        });
        let http = HttpClient::new(ClientConfig { host: "gitlab.example.com".into(), api_base: format!("{}/api/v4", s.base), token: None, headers: vec![], timeout: Duration::from_secs(5) });
        let route = ImageRoute { url: format!("{}/api/v4/projects/42/uploads/{SECRET}/clip.webm", s.base), cache_key: String::new(), fallback: None, signed: false };
        let anywhere = |_: &str| true;
        let got = fetch_video_within(&http, &route, "", &anywhere, 2048).await.unwrap();
        assert_eq!(got, ForgeImage::Found { mime: "video/webm".into(), base64: base64::engine::general_purpose::STANDARD.encode(WEBM) });
        assert_eq!(fetch_video_within(&http, &route, "", &anywhere, 2048).await.unwrap(), ForgeImage::Missing { reason: "larger than 0 MB".into() });
        assert_eq!(fetch_video_within(&http, &route, "", &anywhere, 2048).await.unwrap(), ForgeImage::Missing { reason: "not a video GitBolt plays (text/html)".into() });
        assert_eq!(not_found(ImageFetch::TooLarge, false, MAX_VIDEO), ForgeImage::Missing { reason: "larger than 100 MB".into() });
    }

    #[tokio::test]
    async fn a_clicked_image_has_no_token_and_is_https_only_unless_the_harness_allows_http() {
        let s = TestServer::start(|_, head| {
            assert!(!head.contains("authorization"), "{head}");
            Canned { status: 200, headers: vec![("Content-Type".into(), "image/png".into())], body: b"\x89PNGq".to_vec() }
        });
        let url = format!("{}/a.png", s.base);
        let e = fetch_public(&url, false).await.unwrap_err();
        assert_eq!(e.message, "GitBolt loads images over https only");
        assert!(matches!(fetch_public(&url, true).await.unwrap(), ForgeImage::Found { ref mime, .. } if mime == "image/png"));
        assert_eq!(fetch_public("https://user:pw@example.org/a.png", false).await.unwrap_err().message, "GitBolt loads images over https only");
    }
}
