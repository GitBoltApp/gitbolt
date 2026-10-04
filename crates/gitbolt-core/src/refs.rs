//! Refs, HEAD and stashes, read in-process with gix.

use crate::error::{gix_err, GbError};
use crate::payload::TagAnnotation;
use crate::reflog::read_reflog;
use crate::remotes::{host_kind, parse_remote_url, remote_url, HostKind};
use gix::remote::Direction;
use gix::bstr::ByteSlice;
use gix::ObjectId;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefKind {
    Local,
    Remote { remote: String },
    Tag,
}

#[derive(Debug, Clone)]
pub struct RefInfo {
    pub full_name: String,
    pub short_name: String,
    pub kind: RefKind,
    pub target: ObjectId,
    pub upstream: Option<String>,
    /// A local branch's upstream short name when its branch name differs (`upstream_mismatch`).
    pub upstream_mismatch: Option<String>,
    /// An annotated tag's message and tagger.
    pub annotation: Option<TagAnnotation>,
}

#[derive(Debug, Clone, Default)]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub target: Option<ObjectId>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Clone)]
pub struct StashEntry {
    pub index: usize,
    pub id: ObjectId,
    pub message: String,
    pub time: i64,
}

#[derive(Debug, Clone, Default)]
pub struct RepoRefs {
    pub head: HeadInfo,
    pub refs: Vec<RefInfo>,
    pub remote_heads: HashMap<String, String>,
    pub remote_hosts: HashMap<String, HostKind>,
    /// Each remote's host name (the UI applies the profile's host-type overrides by host).
    pub remote_host_names: HashMap<String, String>,
    pub stashes: Vec<StashEntry>,
}

pub fn read_refs(repo: &gix::Repository) -> Result<RepoRefs, GbError> {
    let snapshot = repo.config_snapshot();
    // The repository's own config file, read now: the handle's snapshot is from when it opened,
    // so a branch's upstream set since (Set upstream, a push -u, the CLI) shows at the next
    // refresh. The snapshot only when that file can't be read.
    let fresh = gix::config::File::from_path_no_includes(repo.common_dir().join("config"), gix::config::Source::Local).ok();
    let config = fresh.as_ref().unwrap_or(snapshot.plumbing());
    let remotes: Vec<String> = repo.remote_names().into_iter().map(|n| n.to_str_lossy().into_owned()).collect();
    let parsed: Vec<(String, Option<String>)> =
        remotes.iter().map(|r| (r.clone(), remote_url(repo, r, Direction::Fetch).and_then(|u| parse_remote_url(&u)).map(|u| u.host))).collect();
    let remote_hosts = parsed.iter().map(|(r, h)| (r.clone(), h.as_deref().map(host_kind).unwrap_or(HostKind::Generic))).collect();
    let remote_host_names = parsed.into_iter().filter_map(|(r, h)| h.map(|h| (r, h))).collect();

    let mut refs = Vec::new();
    let mut remote_heads = HashMap::new();
    let platform = repo.references().map_err(gix_err)?;
    for reference in platform.all().map_err(gix_err)? {
        let mut reference = match reference {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("skipping unreadable ref: {e}");
                continue;
            }
        };
        let full = reference.name().as_bstr().to_str_lossy().into_owned();
        if let gix::refs::TargetRef::Symbolic(target) = reference.target() {
            if let Some(remote) = full.strip_prefix("refs/remotes/").and_then(|s| s.strip_suffix("/HEAD")) {
                remote_heads.insert(remote.to_string(), target.as_bstr().to_str_lossy().into_owned());
            }
            continue;
        }
        let (kind, short) = if let Some(s) = full.strip_prefix("refs/heads/") {
            (RefKind::Local, s.to_string())
        } else if let Some(rest) = full.strip_prefix("refs/remotes/") {
            match remote_for(rest, &remotes) {
                Some(remote) => (RefKind::Remote { remote }, rest.to_string()),
                None => continue,
            }
        } else if let Some(s) = full.strip_prefix("refs/tags/") {
            (RefKind::Tag, s.to_string())
        } else {
            continue;
        };
        let mut annotation = None;
        let target = if kind == RefKind::Tag {
            // Only tags of commits; an annotated one's message comes with it (cached by object).
            let Some(direct) = reference.try_id().map(|id| id.detach()) else { continue };
            let Some(tag) = read_tag(repo, direct) else { continue };
            annotation = tag.annotation;
            tag.commit
        } else {
            match reference.peel_to_id() {
                Ok(id) => id.detach(),
                Err(_) => continue,
            }
        };
        let (upstream, upstream_mismatch) = if kind == RefKind::Local { (upstream_of(config, &short), upstream_mismatch(config, &short)) } else { (None, None) };
        refs.push(RefInfo { full_name: full, short_name: short, kind, target, upstream, upstream_mismatch, annotation });
    }

    Ok(RepoRefs { head: read_head(repo)?, refs, remote_heads, remote_hosts, remote_host_names, stashes: read_stashes(repo)? })
}

/// Longest remote name that prefixes `rest` (remote names may contain `/`).
pub(crate) fn remote_for(rest: &str, remotes: &[String]) -> Option<String> {
    remotes
        .iter()
        .filter(|r| rest.len() > r.len() && rest.starts_with(r.as_str()) && rest.as_bytes()[r.len()] == b'/')
        .max_by_key(|r| r.len())
        .cloned()
}

/// How many lines of an annotated tag's message the tooltips get (UX round 3, M.2).
pub const TAG_MESSAGE_LINES: usize = 10;
/// And at most this many characters of them.
const TAG_MESSAGE_CHARS: usize = 2000;
/// `read_tag`'s cache bound: past it, the cache starts over.
const TAG_CACHE_MAX: usize = 20_000;

/// A tag ref's object, read (`read_tag`).
#[derive(Debug, Clone)]
pub struct TagTarget {
    /// The commit it peels to.
    pub commit: ObjectId,
    /// Set when it's an annotated tag.
    pub annotation: Option<TagAnnotation>,
}

/// Tag objects already read, by object id. Objects never change, so an entry stays right for
/// every repository holding that object: every refresh reads each tag object once, ever.
static TAGS: OnceLock<Mutex<HashMap<ObjectId, TagTarget>>> = OnceLock::new();

/// What the tag ref naming `id` points at: the commit it peels to and, for an annotated tag
/// (`id` a tag object), its message and tagger. `None` when it doesn't peel to a commit (a tag
/// of a tree or blob) or can't be read.
pub fn read_tag(repo: &gix::Repository, id: ObjectId) -> Option<TagTarget> {
    let cache = TAGS.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(&id).cloned()) {
        return Some(hit);
    }
    let obj = repo.find_object(id).ok()?;
    let read = match obj.kind {
        gix::object::Kind::Commit => TagTarget { commit: id, annotation: None },
        gix::object::Kind::Tag => {
            let annotation = obj.try_to_tag_ref().ok().map(|t| annotation_of(&t));
            TagTarget { commit: obj.peel_to_kind(gix::object::Kind::Commit).ok()?.id, annotation }
        }
        _ => return None,
    };
    if let Ok(mut c) = cache.lock() {
        if c.len() >= TAG_CACHE_MAX {
            c.clear();
        }
        c.insert(id, read.clone());
    }
    Some(read)
}

fn annotation_of(tag: &gix::objs::TagRef<'_>) -> TagAnnotation {
    let text = tag.message.to_str_lossy();
    let text = text.trim();
    let mut lines = text.lines();
    let mut message = lines.by_ref().take(TAG_MESSAGE_LINES).collect::<Vec<_>>().join("\n").trim_end().to_string();
    let mut truncated = lines.any(|l| !l.trim().is_empty());
    if message.chars().count() > TAG_MESSAGE_CHARS {
        message = message.chars().take(TAG_MESSAGE_CHARS).collect();
        truncated = true;
    }
    let tagger = tag.tagger().ok().flatten();
    TagAnnotation {
        message,
        truncated,
        tagger: tagger.map(|t| t.name.to_str_lossy().trim().to_string()).filter(|n| !n.is_empty()),
        time: tagger.map_or(0, |t| t.seconds()),
    }
}

/// `branch`'s configured upstream as (remote, branch name); `None` without one, or when it's a
/// local branch (`remote = .`).
fn upstream_parts(config: &gix::config::File, branch: &str) -> Option<(String, String)> {
    let remote = config.string(format!("branch.{branch}.remote").as_str())?;
    let merge = config.string(format!("branch.{branch}.merge").as_str())?;
    if remote.to_str_lossy() == "." {
        return None;
    }
    let merge = merge.to_str_lossy();
    let name = merge.strip_prefix("refs/heads/")?;
    Some((remote.to_str_lossy().into_owned(), name.to_string()))
}

fn upstream_of(config: &gix::config::File, branch: &str) -> Option<String> {
    upstream_parts(config, branch).map(|(remote, name)| format!("refs/remotes/{remote}/{name}"))
}

fn upstream_mismatch(config: &gix::config::File, branch: &str) -> Option<String> {
    upstream_parts(config, branch).and_then(|(remote, name)| mismatched_upstream(branch, &remote, &name))
}

/// The upstream's short name (`origin/feature/b`) when its branch name (`merge`, with or without
/// `refs/heads/`) isn't `branch`'s own (`feature/a`): often a mistake, which the branch's chip
/// and sidebar row warn about (UX round 3, M.1). `None` when the names match, or without a remote
/// upstream (no `remote`, or `.`: a local branch).
pub fn mismatched_upstream(branch: &str, remote: &str, merge: &str) -> Option<String> {
    let name = merge.strip_prefix("refs/heads/").unwrap_or(merge);
    (!remote.is_empty() && remote != "." && !name.is_empty() && name != branch).then(|| format!("{remote}/{name}"))
}

fn read_head(repo: &gix::Repository) -> Result<HeadInfo, GbError> {
    let head = repo.head().map_err(gix_err)?;
    Ok(HeadInfo {
        branch: head.referent_name().map(|n| n.as_bstr().to_str_lossy().into_owned()),
        target: head.id().map(|id| id.detach()),
        detached: head.is_detached(),
        unborn: head.is_unborn(),
    })
}

fn read_stashes(repo: &gix::Repository) -> Result<Vec<StashEntry>, GbError> {
    Ok(read_reflog(repo.common_dir(), "refs/stash")?
        .into_iter()
        .enumerate()
        .map(|(index, e)| StashEntry { index, id: e.new, message: e.message, time: e.time })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};

    fn open(r: &TestRepo) -> gix::Repository {
        gix::open(r.path()).unwrap()
    }

    #[test]
    fn reads_branches_remotes_tags_and_upstreams() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let refs = read_refs(&open(&r)).unwrap();
        let find = |n: &str| refs.refs.iter().find(|x| x.full_name == n).unwrap_or_else(|| panic!("missing {n}"));

        let main = find("refs/heads/main");
        assert_eq!(main.kind, RefKind::Local);
        assert_eq!(main.short_name, "main");
        assert_eq!(main.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!(main.target, find("refs/remotes/origin/main").target);

        assert_eq!(find("refs/remotes/origin/feature/login").kind, RefKind::Remote { remote: "origin".into() });
        assert_eq!(find("refs/remotes/origin/feature/login").short_name, "origin/feature/login");
        assert_eq!(find("refs/heads/hotfix").upstream, None);

        let tag = find("refs/tags/v1.0");
        assert_eq!(tag.kind, RefKind::Tag);
        assert_eq!(tag.target.to_string(), r.git(&["rev-parse", "v1.0^{commit}"]), "annotated tag must peel to its commit");

        assert!(!refs.refs.iter().any(|x| x.full_name.ends_with("/HEAD")));
        assert_eq!(refs.remote_heads.get("origin").map(String::as_str), Some("refs/remotes/origin/main"));
        assert_eq!(refs.remote_hosts.get("origin"), Some(&HostKind::Generic));

        assert_eq!(refs.head.branch.as_deref(), Some("refs/heads/main"));
        assert!(!refs.head.detached && !refs.head.unborn);

        assert_eq!(refs.stashes.len(), 1);
        assert_eq!(refs.stashes[0].index, 0);
        assert_eq!(refs.stashes[0].message, "On main: Experiment");
        assert_eq!(refs.stashes[0].id.to_string(), r.git(&["rev-parse", "stash@{0}"]));
    }

    #[test]
    fn unborn_and_detached_heads() {
        let r = TestRepo::new();
        let refs = read_refs(&open(&r)).unwrap();
        assert!(refs.head.unborn);
        assert_eq!(refs.head.target, None);
        assert!(refs.refs.is_empty());

        r.commit("a");
        r.commit("b");
        r.git(&["switch", "-q", "--detach", "HEAD~1"]);
        let refs = read_refs(&open(&r)).unwrap();
        assert!(refs.head.detached);
        assert_eq!(refs.head.branch, None);
        assert_eq!(refs.head.target.unwrap().to_string(), r.git(&["rev-parse", "HEAD"]));
    }

    #[test]
    fn remote_host_kind_comes_from_url() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["remote", "add", "gl", "git@gitlab.example.com:Acme/shop.git"]);
        let refs = read_refs(&open(&r)).unwrap();
        assert_eq!(refs.remote_hosts.get("gl"), Some(&HostKind::GitLab));
    }

    /// UX round 3, M.1: a local branch tracking another branch name is flagged; one tracking its
    /// namesake, one without an upstream and one tracking a local branch aren't.
    #[test]
    fn flags_an_upstream_with_another_branch_name() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["branch", "feature/a", "main"]);
        r.git(&["branch", "--set-upstream-to=origin/feature/login", "feature/a"]);
        r.git(&["branch", "local-track", "main"]);
        r.git(&["config", "branch.local-track.remote", "."]);
        r.git(&["config", "branch.local-track.merge", "refs/heads/main"]);
        let repo = open(&r);
        let refs = read_refs(&repo).unwrap();
        let find = |n: &str| refs.refs.iter().find(|x| x.full_name == n).unwrap_or_else(|| panic!("missing {n}"));
        assert_eq!(find("refs/heads/feature/a").upstream_mismatch.as_deref(), Some("origin/feature/login"));
        assert_eq!(find("refs/heads/feature/a").upstream.as_deref(), Some("refs/remotes/origin/feature/login"));
        assert_eq!(find("refs/heads/main").upstream_mismatch, None, "same name");
        assert_eq!(find("refs/heads/hotfix").upstream_mismatch, None, "no upstream");
        assert_eq!(find("refs/heads/local-track").upstream_mismatch, None, "a local upstream");

        // The handle opened before: an upstream set since is still read (not its config snapshot).
        r.git(&["branch", "--set-upstream-to=origin/main", "feature/a"]);
        r.git(&["branch", "--set-upstream-to=origin/main", "hotfix"]);
        let again = read_refs(&repo).unwrap();
        let find = |n: &str| again.refs.iter().find(|x| x.full_name == n).unwrap();
        assert_eq!(find("refs/heads/feature/a").upstream_mismatch.as_deref(), Some("origin/main"));
        assert_eq!(find("refs/heads/hotfix").upstream.as_deref(), Some("refs/remotes/origin/main"));
    }

    #[test]
    fn mismatched_upstream_compares_branch_names() {
        assert_eq!(mismatched_upstream("feature/a", "origin", "refs/heads/feature/b").as_deref(), Some("origin/feature/b"));
        assert_eq!(mismatched_upstream("main", "origin", "refs/heads/develop").as_deref(), Some("origin/develop"));
        assert_eq!(mismatched_upstream("main", "my/fork", "refs/heads/main"), None);
        assert_eq!(mismatched_upstream("main", ".", "refs/heads/dev"), None, "a local upstream");
        assert_eq!(mismatched_upstream("main", "", ""), None, "no upstream");
    }

    /// UX round 3, M.2: an annotated tag carries its message's first lines and its tagger; a
    /// lightweight one carries nothing; a tag of a tree is still left out.
    #[test]
    fn annotated_tags_carry_their_message() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let long: Vec<String> = (1..=14).map(|i| format!("line {i}")).collect();
        r.git(&["tag", "-a", "-m", &long.join("\n"), "v2.0", "main"]);
        r.git(&["tag", "light", "main"]);
        let tree = r.git(&["rev-parse", "main^{tree}"]);
        r.git(&["tag", "-a", "-m", "a tree", "treetag", &tree]);
        let refs = read_refs(&open(&r)).unwrap();
        let find = |n: &str| refs.refs.iter().find(|x| x.full_name == n);

        let v1 = find("refs/tags/v1.0").unwrap().annotation.clone().expect("annotated");
        assert_eq!((v1.message.as_str(), v1.truncated), ("v1.0", false));
        assert!(v1.tagger.is_some() && v1.time > 0);

        let v2 = find("refs/tags/v2.0").unwrap();
        assert_eq!(v2.target.to_string(), r.git(&["rev-parse", "main"]), "peels to its commit");
        let a = v2.annotation.clone().unwrap();
        assert_eq!(a.message, long[..TAG_MESSAGE_LINES].join("\n"));
        assert!(a.truncated);

        let light = find("refs/tags/light").unwrap();
        assert_eq!(light.annotation, None);
        assert_eq!(light.target.to_string(), r.git(&["rev-parse", "main"]));
        assert!(find("refs/tags/treetag").is_none());

        // Read again (now from the cache): the same.
        let again = read_refs(&open(&r)).unwrap();
        assert_eq!(again.refs.iter().find(|x| x.full_name == "refs/tags/v2.0").unwrap().annotation, Some(a));
    }
}
