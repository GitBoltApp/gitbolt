//! Markdown images (spec #5 §4.2): which addresses a forge serves itself (its allowlist), how they
//! are fetched (the token only to the account's own API host, redirects re-checked, the image
//! size cap and the disk cache), and a clicked image's token-less fetch.

use crate::avatar_cache::{payload_of, DiskAvatarCache, Lookup};
use crate::http::{under, ClientConfig, HttpClient, ImageFetch};
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::{avatar_url_is_clean, image_host, ForgeImage, ForgeProject};
use std::time::Duration;

/// Where to fetch an image and what the disk cache calls it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRoute {
    pub url: String,
    pub cache_key: String,
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
    Some(ImageRoute { url: url.to_string(), cache_key })
}

fn is_secret(s: &str) -> bool {
    (10..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// GitLab: `url` under the account's web host with a clean shape. A project upload
/// (`<web>/<project>/uploads/<secret>/<file>` or `<web>/-/project/<id>/uploads/<secret>/<file>`)
/// is read through the API (`GET /projects/:id/uploads/:secret/:filename`, `api_url` builds it);
/// any other address on the web host is fetched as it is.
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
    let target = match rest.and_then(|r| r.split_once('/')) {
        Some((secret, file)) if is_secret(secret) && !file.is_empty() && !file.contains('/') => api_url(&format!("/projects/{}/uploads/{secret}/{file}", project.id)),
        _ => url.to_string(),
    };
    Some(ImageRoute { url: target, cache_key: url.to_string() })
}

fn found(p: gitbolt_core::avatar::AvatarPayload) -> ForgeImage {
    ForgeImage::Found { mime: p.mime, base64: p.base64 }
}

/// `route` through the host's disk cache (found 7 days, missing 1 day; `Expired` and `Ask` are
/// never cached) and `get_image_within`.
pub async fn fetch(http: &HttpClient, cache: Option<&DiskAvatarCache>, route: &ImageRoute, own_origin: &str, allowed: &(dyn Fn(&str) -> bool + Sync)) -> Result<ForgeImage, GbError> {
    let key = format!("img:{}", route.cache_key);
    if let Some(c) = cache {
        match c.lookup_exact(&key) {
            Lookup::Found(p) => return Ok(found(p)),
            Lookup::Missing => return Ok(ForgeImage::Missing),
            Lookup::Unknown => {}
        }
    }
    Ok(match http.get_image_within(&route.url, own_origin, allowed).await? {
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
            p.map_or(ForgeImage::Missing, found)
        }
        ImageFetch::Missing => {
            if let Some(c) = cache {
                c.store_missing_exact(&key);
            }
            ForgeImage::Missing
        }
        ImageFetch::Forbidden => ForgeImage::Expired,
        ImageFetch::Elsewhere(host) => ForgeImage::Ask { host },
    })
}

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
        ImageFetch::Found { content_type, bytes } => payload_of(&content_type, &bytes).map_or(ForgeImage::Missing, found),
        ImageFetch::Missing | ImageFetch::Forbidden | ImageFetch::Elsewhere(_) => ForgeImage::Missing,
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
        let by_id = format!("https://gitlab.example.com/-/project/42/uploads/{SECRET}/a.png");
        assert_eq!(gitlab_route(&by_id, web, &p, api).unwrap().url, format!("https://gitlab.example.com/api/v4/projects/42/uploads/{SECRET}/a.png"));
        let upper = format!("https://gitlab.example.com/Group/Project/uploads/{SECRET}/a.png");
        assert!(gitlab_route(&upper, web, &p, api).unwrap().url.contains("/api/v4/projects/42/uploads/"), "GitLab paths ignore case");
        let raw = "https://gitlab.example.com/group/project/-/raw/main/a.png";
        assert_eq!(gitlab_route(raw, web, &p, api).unwrap().url, raw);
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
        let route = |u: String| ImageRoute { cache_key: u.clone(), url: u };
        let upper = route(format!("{}/o/r/main/Shot.png", s.base));
        let lower = route(format!("{}/o/r/main/shot.png", s.base));
        assert!(matches!(fetch(&http, Some(&cache), &upper, "", &anywhere).await.unwrap(), ForgeImage::Found { .. }));
        assert_eq!(fetch(&http, Some(&cache), &lower, "", &anywhere).await.unwrap(), ForgeImage::Missing, "asked, not the other's cached copy");
        assert!(matches!(fetch(&http, Some(&cache), &upper, "", &anywhere).await.unwrap(), ForgeImage::Found { .. }), "still cached as found");
        assert_eq!(s.hits(), 2);
    }
    // --- end 5A T3 ---

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
