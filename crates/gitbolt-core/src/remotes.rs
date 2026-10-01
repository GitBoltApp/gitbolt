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
        if url.starts_with('/') || url.starts_with('.') {
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
