//! The pinned trunk (spec §8.2): which refs lead lanes 0 and 1, by default or by the pin setting,
//! and whether the repository is a fork (moved from the core's snapshot.rs).

use crate::input::{ForkFacts, RefKind, RefsIn};
use crate::payload::{ForkDetection, ForkPayload, HostKind};
use crate::walk::CommitMeta;
use crate::Oid;
use std::collections::HashMap;

/// The default pin (the pin setting `auto`), the ref leading lane 0 first.
///
/// In a fork (`fork_of`) whose original project's trunk `T` is fetched (`upstream/main`): `T`
/// then its local counterpart (see 2. below), so a local `main` tracking your fork's `main`
/// still pins with `upstream/main`. `T` first: diverged, it leads lane 0 and main's own commits
/// take lane 1. Your fork's own trunk is never pinned by default: changes for the original
/// project start from its trunk, not from your fork's.
///
/// Otherwise the local counterpart of the main remote's default branch, with its pair (`pin_pair`):
/// 1. The remote trunk `T`: per remote, its HEAD's target, else its main, master, dev or develop.
///    Remotes in order: roots first (a remote whose project forks another remote's, by the
///    forge's cached data, comes after it), then by convention `upstream` (GitHub's fork
///    workflow: `origin` is your fork, `upstream` the original), `origin`, the others by name.
/// 2. Its local counterpart: a local branch whose upstream is `T` (the one named like `T`'s
///    branch first, then by name); else the local branch named like `T`'s branch, whatever its
///    upstream; else `T` itself.
/// 3. No remote trunk at all (a local-only repo): the local main, master, dev or develop.
pub(crate) fn default_pair(refs: &RefsIn, fork: Option<&Fork>, fork_parents: &HashMap<String, String>) -> Vec<String> {
    if let Some(f) = fork
        && let Some((t, branch)) = trunk_of(refs, &f.original)
    {
        let local = local_counterpart(refs, &t, &branch);
        return std::iter::once(t).chain(local).collect();
    }
    let chosen = match remote_trunk(refs, fork_parents) {
        Some((t, branch)) => Some(local_counterpart(refs, &t, &branch).unwrap_or(t)),
        None => ["main", "master", "dev", "develop"].into_iter().map(|b| format!("refs/heads/{b}")).find(|n| refs.refs.iter().any(|r| &r.full_name == n)),
    };
    chosen.map(|c| pin_pair(refs, &c)).unwrap_or_default()
}

/// A fork's remotes (`fork_of`).
pub(crate) struct Fork {
    pub(crate) fork: String,
    pub(crate) original: String,
    pub(crate) by: ForkDetection,
}

/// Whether the repository is a fork, and of what: by the forge's cached data, a remote whose
/// project is a fork of another remote's, and which is yours: `origin`, or a remote the
/// original's local trunk branch tracks or pushes to (`origin` first, then by name). A
/// maintainer with a contributor's fork as a remote isn't in a fork. Else by convention, a
/// remote named `upstream` next to `origin`, unless the forge can tell (an account covers
/// origin's host), knows origin's project isn't a fork, or both remotes are the same project.
pub(crate) fn fork_of(refs: &RefsIn, facts: &ForkFacts) -> Option<Fork> {
    let known = |r: &str| refs.remote_hosts.contains_key(r);
    let yours = |r: &str, original: &str| r == "origin" || trunk_branch_remotes(refs, original).iter().any(|x| x == r);
    let mut forks: Vec<(&String, &String)> = facts.parents.iter().filter(|(r, p)| r != p && known(r) && known(p) && yours(r, p)).collect();
    forks.sort_by_key(|(r, _)| (r.as_str() != "origin", r.as_str()));
    if let Some((fork, original)) = forks.first() {
        return Some(Fork { fork: fork.to_string(), original: original.to_string(), by: ForkDetection::Forge });
    }
    let same_project = refs.remote_ids.get("origin").is_some_and(|o| refs.remote_ids.get("upstream") == Some(o));
    let convention = known("origin") && known("upstream") && !facts.covered.contains("origin") && !facts.roots.contains("origin") && !same_project;
    convention.then(|| Fork { fork: "origin".into(), original: "upstream".into(), by: ForkDetection::UpstreamRemote })
}

/// The remotes the local trunk branch for `original` (its trunk's local counterpart) tracks or
/// pushes to.
pub(crate) fn trunk_branch_remotes(refs: &RefsIn, original: &str) -> Vec<String> {
    let Some(local) = trunk_of(refs, original).and_then(|(t, branch)| local_counterpart(refs, &t, &branch)) else { return vec![] };
    let Some(r) = refs.refs.iter().find(|r| r.full_name == local) else { return vec![] };
    let tracked = r.upstream.as_ref().and_then(|u| match &refs.refs.iter().find(|x| &x.full_name == u)?.kind {
        RefKind::Remote { remote } => Some(remote.clone()),
        _ => None,
    });
    tracked.into_iter().chain(refs.push_remotes.get(&local).cloned()).collect()
}

/// The payload's account of a fork: its trunks, and the local branches standing for them.
pub(crate) fn fork_payload(refs: &RefsIn, f: &Fork) -> ForkPayload {
    let trunk = trunk_of(refs, &f.original);
    let fork_trunk = trunk_of(refs, &f.fork).map(|(t, _)| t);
    let mut trunk_branches: Vec<String> = trunk.as_ref().and_then(|(t, branch)| local_counterpart(refs, t, branch)).into_iter().collect();
    if let Some(ft) = &fork_trunk {
        trunk_branches.extend(refs.refs.iter().filter(|r| r.kind == RefKind::Local && r.upstream.as_ref() == Some(ft)).map(|r| r.full_name.clone()));
    }
    trunk_branches.sort();
    trunk_branches.dedup();
    ForkPayload {
        fork: f.fork.clone(),
        original: f.original.clone(),
        host: refs.remote_host_names.get(&f.original).cloned(),
        host_kind: refs.remote_hosts.get(&f.original).copied().unwrap_or(HostKind::Generic),
        detected_by: f.by,
        trunk: trunk.map(|(t, _)| t),
        fork_trunk,
        trunk_branches,
    }
}

/// The refs a chosen pin (the default trunk or an explicit one) pins, local first: a local
/// branch with its upstream (when that ref exists); a remote branch with the local branch
/// tracking it (the one named like its branch first, then by name); else the ref alone.
pub(crate) fn pin_pair(refs: &RefsIn, chosen: &str) -> Vec<String> {
    let alone = || vec![chosen.to_string()];
    let Some(r) = refs.refs.iter().find(|r| r.full_name == chosen) else { return alone() };
    match &r.kind {
        RefKind::Local => {
            let upstream = r.upstream.clone().filter(|u| refs.refs.iter().any(|x| &x.full_name == u));
            std::iter::once(chosen.to_string()).chain(upstream).collect()
        }
        RefKind::Remote { remote } => match tracking_local(refs, chosen, &r.short_name[remote.len() + 1..]) {
            Some(local) => vec![local, chosen.to_string()],
            None => alone(),
        },
        RefKind::Tag => alone(),
    }
}

/// The local branch tracking the remote branch `t` (`branch`: its branch part): the one named
/// like it first, then the first by name.
pub(crate) fn tracking_local(refs: &RefsIn, t: &str, branch: &str) -> Option<String> {
    let mut tracking: Vec<_> = refs.refs.iter().filter(|r| r.kind == RefKind::Local && r.upstream.as_deref() == Some(t)).collect();
    tracking.sort_by_key(|r| (r.short_name != branch, r.short_name.as_str()));
    tracking.first().map(|r| r.full_name.clone())
}

/// `T` and its branch part (`main` for `refs/remotes/origin/main`).
pub(crate) fn remote_trunk(refs: &RefsIn, fork_parents: &HashMap<String, String>) -> Option<(String, String)> {
    // A parent that isn't a configured remote says nothing about the order.
    let is_fork = |r: &str| fork_parents.get(r).is_some_and(|p| p != r && refs.remote_hosts.contains_key(p));
    let convention = |r: &str| match r {
        "upstream" => 0,
        "origin" => 1,
        _ => 2,
    };
    let mut remotes: Vec<&String> = refs.remote_hosts.keys().collect();
    remotes.sort_by_key(|r| (is_fork(r), convention(r), r.as_str()));
    remotes.into_iter().find_map(|r| trunk_of(refs, r))
}

/// One remote's trunk and its branch part: its HEAD's target, else its main, master, dev or
/// develop.
pub(crate) fn trunk_of(refs: &RefsIn, remote: &str) -> Option<(String, String)> {
    let exists = |n: &str| refs.refs.iter().any(|r| r.full_name == n);
    let prefix = format!("refs/remotes/{remote}/");
    if let Some(t) = refs.remote_heads.get(remote)
        && exists(t)
        && let Some(branch) = t.strip_prefix(&prefix)
    {
        return Some((t.clone(), branch.to_string()));
    }
    ["main", "master", "dev", "develop"].into_iter().map(|b| (format!("{prefix}{b}"), b.to_string())).find(|(n, _)| exists(n))
}

/// The local branch standing for the remote trunk `t` (see `default_pair`).
pub(crate) fn local_counterpart(refs: &RefsIn, t: &str, branch: &str) -> Option<String> {
    tracking_local(refs, t, branch).or_else(|| refs.refs.iter().find(|r| r.kind == RefKind::Local && r.short_name == branch).map(|r| r.full_name.clone()))
}

/// The pinned commits (commit index → pinned lane) of the pinned pair whose tips are `tips`
/// (commit indexes, the one leading lane 0 first: the local branch, or in a fork the original's
/// trunk), and each pinned lane's tip:
/// - one tip, or two on one first-parent chain (one behind or ahead of the other, or equal):
///   one chain from the newer tip, through the older one, in lane 0;
/// - two diverged tips: the first's chain in lane 0, the second's own commits in lane 1, down to
///   where its first-parent chain meets lane 0's (their shared history stays in lane 0).
pub(crate) fn pinned_chains(commits: &[CommitMeta], index: &HashMap<Oid, usize>, tips: &[usize]) -> (HashMap<usize, u16>, Vec<usize>) {
    let mut pinned = HashMap::new();
    let mut lane_tips = Vec::new();
    let chain = |tip: usize, pinned: &mut HashMap<usize, u16>, lane: u16| {
        let mut cur = Some(tip);
        while let Some(i) = cur {
            if pinned.contains_key(&i) {
                break;
            }
            pinned.insert(i, lane);
            cur = commits[i].parents.first().and_then(|p| index.get(p)).copied();
        }
    };
    let Some(&first) = tips.first() else { return (pinned, lane_tips) };
    chain(first, &mut pinned, 0);
    lane_tips.push(first);
    // A second tip on the first's chain (or the same commit) is pinned already.
    if let Some(&second) = tips.get(1).filter(|t| !pinned.contains_key(t)) {
        let mut theirs = HashMap::new();
        chain(second, &mut theirs, 0);
        if theirs.contains_key(&first) {
            // The first is on the second's chain: the second, newer, leads lane 0.
            pinned = theirs;
            lane_tips[0] = second;
        } else {
            chain(second, &mut pinned, 1);
            lane_tips.push(second);
        }
    }
    (pinned, lane_tips)
}
