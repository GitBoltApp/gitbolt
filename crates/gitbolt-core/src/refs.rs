//! Refs, HEAD and stashes, read in-process with gix.

use crate::error::{gix_err, GbError};
use crate::reflog::read_reflog;
use crate::remotes::{host_kind, parse_remote_url, remote_url, HostKind};
use gix::remote::Direction;
use gix::bstr::ByteSlice;
use gix::ObjectId;
use std::collections::HashMap;

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
    pub stashes: Vec<StashEntry>,
}

pub fn read_refs(repo: &gix::Repository) -> Result<RepoRefs, GbError> {
    let config = repo.config_snapshot();
    let remotes: Vec<String> = repo.remote_names().into_iter().map(|n| n.to_str_lossy().into_owned()).collect();
    let remote_hosts = remotes
        .iter()
        .map(|r| {
            let kind = remote_url(repo, r, Direction::Fetch).and_then(|u| parse_remote_url(&u)).map(|u| host_kind(&u.host)).unwrap_or(HostKind::Generic);
            (r.clone(), kind)
        })
        .collect();

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
        let target = match reference.peel_to_id() {
            Ok(id) => id.detach(),
            Err(_) => continue,
        };
        if kind == RefKind::Tag && !is_commit(repo, target) {
            continue;
        }
        let upstream = if kind == RefKind::Local { upstream_of(&config, &short) } else { None };
        refs.push(RefInfo { full_name: full, short_name: short, kind, target, upstream });
    }

    Ok(RepoRefs { head: read_head(repo)?, refs, remote_heads, remote_hosts, stashes: read_stashes(repo)? })
}

/// Longest remote name that prefixes `rest` (remote names may contain `/`).
pub(crate) fn remote_for(rest: &str, remotes: &[String]) -> Option<String> {
    remotes
        .iter()
        .filter(|r| rest.len() > r.len() && rest.starts_with(r.as_str()) && rest.as_bytes()[r.len()] == b'/')
        .max_by_key(|r| r.len())
        .cloned()
}

fn is_commit(repo: &gix::Repository, id: ObjectId) -> bool {
    repo.find_object(id).map(|o| o.kind == gix::object::Kind::Commit).unwrap_or(false)
}

fn upstream_of(config: &gix::config::Snapshot<'_>, branch: &str) -> Option<String> {
    let remote = config.string(format!("branch.{branch}.remote").as_str())?;
    let merge = config.string(format!("branch.{branch}.merge").as_str())?;
    if remote.to_str_lossy() == "." {
        return None;
    }
    let merge = merge.to_str_lossy();
    let name = merge.strip_prefix("refs/heads/")?;
    Some(format!("refs/remotes/{}/{}", remote.to_str_lossy(), name))
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
}
