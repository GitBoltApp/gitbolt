//! SemVer as the releases use it (`scripts/version.py`): `X.Y.Z`, `X.Y.Z-<pre-release>`, and a
//! local build's `X.Y.Z+<stamp>.<sha>` (`scripts/package-version.sh`). Build metadata never
//! counts in a comparison, so a stamped build of 0.2.0 is 0.2.0, and the 0.2.0 release isn't
//! offered to it as an update.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Word(String),
}

#[derive(Debug, Clone)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<Ident>,
    /// `+…`, without the `+`.
    build: Option<String>,
}

impl Version {
    /// `1.2.3`, `v1.2.3-rc.1`, `1.2.3+202610051325.ab4dbf9e`. `None` for anything else.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        let (rest, build) = match s.split_once('+') {
            Some((r, b)) if !b.is_empty() && b.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')) => (r, Some(b.to_string())),
            Some(_) => return None,
            None => (s, None),
        };
        let (core, pre) = match rest.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (rest, None),
        };
        let mut nums = core.split('.').map(number);
        let (major, minor, patch) = (nums.next()??, nums.next()??, nums.next()??);
        if nums.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(p) => p.split('.').map(ident).collect::<Option<Vec<_>>>()?,
        };
        Some(Self { major, minor, patch, pre, build })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }

    /// The build metadata (`202610051325.ab4dbf9e`), if any.
    pub fn build(&self) -> Option<&str> {
        self.build.as_deref()
    }

    /// The version without its build metadata: `0.2.0`, `0.3.0-rc.1`.
    pub fn without_build(&self) -> String {
        let core = format!("{}.{}.{}", self.major, self.minor, self.patch);
        if self.pre.is_empty() {
            return core;
        }
        let pre: Vec<String> = self.pre.iter().map(|i| match i {
            Ident::Num(n) => n.to_string(),
            Ident::Word(w) => w.clone(),
        }).collect();
        format!("{core}-{}", pre.join("."))
    }
}

/// A number without leading zeros (SemVer).
fn number(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    s.parse().ok()
}

fn ident(s: &str) -> Option<Ident> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    if s.bytes().all(|b| b.is_ascii_digit()) { number(s).map(Ident::Num) } else { Some(Ident::Word(s.to_string())) }
}

impl Ord for Ident {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
            (Ident::Num(_), Ident::Word(_)) => Ordering::Less,
            (Ident::Word(_), Ident::Num(_)) => Ordering::Greater,
            (Ident::Word(a), Ident::Word(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Ident {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            // A pre-release comes before its release.
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => self.pre.cmp(&other.pre),
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Equal when they sort equal: the build metadata doesn't count.
impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Version {}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("{s} parses"))
    }

    #[test]
    fn orders_releases_and_pre_releases_as_semver_does() {
        let order = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.10", "0.1.0-beta", "0.1.0-beta.1", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0-rc.1", "0.2.0", "0.10.0", "1.0.0"];
        for pair in order.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn a_dev_build_is_its_version_and_keeps_its_stamp() {
        let dev = v("0.2.0+202610072046.d1d4d7d");
        assert_eq!(dev, v("0.2.0"));
        assert!(dev < v("0.2.1"));
        assert!(dev > v("0.2.0-rc.1"));
        assert_eq!(dev.build(), Some("202610072046.d1d4d7d"));
        assert_eq!(dev.without_build(), "0.2.0");
        assert!(!dev.is_prerelease());
    }

    #[test]
    fn tags_parse_with_their_v_and_pre_releases_say_so() {
        let rc = v("v0.3.0-rc.1");
        assert!(rc.is_prerelease());
        assert_eq!(rc.without_build(), "0.3.0-rc.1");
        assert_eq!(v("v1.2.3").without_build(), "1.2.3");
    }

    #[test]
    fn refuses_what_isnt_semver() {
        for bad in ["", "1", "1.2", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3-rc..1", "1.2.3+", "1.2.x", "latest", "1.2.3-01"] {
            assert!(Version::parse(bad).is_none(), "{bad:?}");
        }
    }
}
