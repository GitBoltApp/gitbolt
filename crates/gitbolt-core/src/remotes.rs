//! Remote URL parsing and forge host detection (no network).

use gix::bstr::ByteSlice;
use gix::remote::Direction;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

// `Deserialize` and `Ord`: the profile's host-type overrides are a map keyed by host (§14.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum HostKind {
    GitLab,
    GitHub,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteUrl {
    pub host: String,
    pub path: String,
}

/// git for Windows reads `C:…` (a drive) and a path with `\` as local paths, never `host:path`
/// (`has_dos_drive_prefix`); elsewhere `c:path` is host `c`.
pub(crate) fn is_local_on_windows(url: &str) -> bool {
    let b = url.as_bytes();
    cfg!(windows) && ((b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || url.split(':').next().is_some_and(|l| l.contains('\\')))
}

pub fn parse_remote_url(url: &str) -> Option<RemoteUrl> {
    let url = url.trim();
    let (host_part, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        (host.split(':').next()?.to_string(), path)
    } else {
        // scp-like: [user@]host:path — but not a local path
        if url.starts_with('/') || url.starts_with('.') || is_local_on_windows(url) {
            return None;
        }
        let (left, path) = url.split_once(':')?;
        if left.contains('/') {
            return None;
        }
        (left.rsplit('@').next()?.to_string(), path)
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).to_string();
    if host_part.is_empty() || path.is_empty() {
        return None;
    }
    Some(RemoteUrl { host: host_part.to_ascii_lowercase(), path })
}

/// The host a forge account for `url` is named by (spec #4 §3.3): `parse_remote_url`'s, plus an
/// http(s) URL's non-default port (`gitlab.example.com:8443`), since the web and API are there.
/// An SSH or scp-style URL's port says nothing about the web's: it's dropped.
pub fn forge_host(url: &str) -> Option<String> {
    let host = parse_remote_url(url)?.host;
    let Some((scheme, rest)) = url.trim().split_once("://") else { return Some(host) };
    let default = match scheme.to_ascii_lowercase().as_str() {
        "https" => "443",
        "http" => "80",
        _ => return Some(host),
    };
    let authority = rest.split('/').next().unwrap_or("");
    let port = authority.rsplit('@').next().and_then(|h| h.split_once(':')).map(|(_, p)| p).filter(|p| !p.is_empty() && *p != default && p.chars().all(|c| c.is_ascii_digit()));
    Some(match port {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
}

/// `remote`'s effective URL for `direction`, with `url.<base>.insteadOf`/`pushInsteadOf` rewrites
/// applied (gix's `Remote::url`, via `find_remote`). Reading `remote.<name>.url` straight out of
/// the config, as the rest of this codebase used to, silently skips a rewritten alias (e.g. `gh:`
/// standing in for `https://github.com/`), so that remote gets no forge links (deferred Rust minor
/// #13). `None` when the remote doesn't exist, or has no URL for that direction.
pub fn remote_url(repo: &gix::Repository, remote: &str, direction: Direction) -> Option<String> {
    let remote = repo.find_remote(remote).ok()?;
    remote.url(direction).map(|u| u.to_bstring().to_str_lossy().into_owned())
}

pub fn host_kind(host: &str) -> HostKind {
    let host = host.to_ascii_lowercase();
    if host == "github.com" || host.ends_with(".github.com") {
        HostKind::GitHub
    } else if host == "gitlab.com" || host.split('.').any(|label| label.contains("gitlab")) {
        HostKind::GitLab
    } else {
        HostKind::Generic
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(url: &str) -> Option<(String, String)> {
        parse_remote_url(url).map(|u| (u.host, u.path))
    }

    #[test]
    fn parses_common_remote_url_shapes() {
        assert_eq!(p("https://gitlab.example.com/Acme/shop.git"), Some(("gitlab.example.com".into(), "Acme/shop".into())));
        assert_eq!(p("git@github.com:owner/repo.git"), Some(("github.com".into(), "owner/repo".into())));
        assert_eq!(p("ssh://git@gitlab.com:2222/a/b/c.git"), Some(("gitlab.com".into(), "a/b/c".into())));
        assert_eq!(p("https://user:tok@github.com/o/r/"), Some(("github.com".into(), "o/r".into())));
        assert_eq!(p("/tmp/origin.git"), None);
        assert_eq!(p("file:///tmp/origin.git"), None);
    }

    /// A drive letter is a local path on Windows, as git for Windows reads it; elsewhere git
    /// reads `c:path` as scp-like host `c`.
    #[test]
    fn a_drive_letter_is_a_local_path_on_windows_only() {
        let drive = p("C:/Users/ada/origin.git");
        let backslash = p(r"C:\Users\ada\origin.git");
        if cfg!(windows) {
            assert_eq!((drive, backslash), (None, None));
        } else {
            assert_eq!(drive, Some(("c".into(), "Users/ada/origin".into())));
        }
        assert_eq!(p("git@github.com:owner/repo.git"), Some(("github.com".into(), "owner/repo".into())), "a host is still a host");
    }

    #[test]
    fn an_https_remote_keeps_its_port_for_forge_matching_and_ssh_drops_it() {
        assert_eq!(forge_host("https://gitlab.example.com:8443/group/project.git").as_deref(), Some("gitlab.example.com:8443"));
        assert_eq!(forge_host("https://user:tok@GitLab.example.com:8443/group/project.git").as_deref(), Some("gitlab.example.com:8443"));
        assert_eq!(forge_host("https://gitlab.example.com:443/group/project.git").as_deref(), Some("gitlab.example.com"));
        assert_eq!(forge_host("http://gitlab.example.com:8080/group/project.git").as_deref(), Some("gitlab.example.com:8080"));
        assert_eq!(forge_host("ssh://git@gitlab.example.com:2222/group/project.git").as_deref(), Some("gitlab.example.com"));
        assert_eq!(forge_host("git@gitlab.example.com:group/project.git").as_deref(), Some("gitlab.example.com"));
        assert_eq!(forge_host("/tmp/origin.git"), None);
        // Everyone else still sees the host alone.
        assert_eq!(parse_remote_url("https://gitlab.example.com:8443/group/project.git").unwrap().host, "gitlab.example.com");
    }

    #[test]
    fn detects_host_kinds() {
        assert_eq!(host_kind("github.com"), HostKind::GitHub);
        assert_eq!(host_kind("gitlab.com"), HostKind::GitLab);
        assert_eq!(host_kind("gitlab.example.com"), HostKind::GitLab);
        assert_eq!(host_kind("code.example.com"), HostKind::Generic);
    }

    /// Deferred Rust minor #13: a raw `remote.<name>.url` read skips `url.*.insteadOf`, so a
    /// remote configured through a rewritten alias gets no forge links at all.
    #[test]
    fn remote_url_applies_instead_of_and_push_instead_of_rewrites() {
        let r = crate::testing::TestRepo::new();
        r.commit("a");
        // `insteadOf`: the configured URL itself is an alias, rewritten for both directions.
        r.git(&["config", "url.https://github.com/.insteadOf", "gh:"]);
        r.git(&["remote", "add", "origin", "gh:owner/repo.git"]);
        // `pushInsteadOf`: only the push direction is rewritten; fetch is untouched.
        r.git(&["config", "url.git@internal.example.com:.pushInsteadOf", "https://github.com/"]);
        r.git(&["remote", "add", "backup", "https://github.com/owner/other.git"]);
        let repo = gix::open(r.path()).unwrap();
        assert_eq!(remote_url(&repo, "origin", Direction::Fetch).as_deref(), Some("https://github.com/owner/repo.git"));
        assert_eq!(remote_url(&repo, "origin", Direction::Push).as_deref(), Some("https://github.com/owner/repo.git"), "no pushInsteadOf here: push falls back to the fetch URL");
        assert_eq!(remote_url(&repo, "backup", Direction::Fetch).as_deref(), Some("https://github.com/owner/other.git"));
        assert_eq!(remote_url(&repo, "backup", Direction::Push).as_deref(), Some("git@internal.example.com:owner/other.git"));
        assert_eq!(remote_url(&repo, "nope", Direction::Fetch), None);
    }
}
