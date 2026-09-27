//! Remote URL parsing and forge host detection (no network).

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
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
}
