//! The graph's walk over gix: `gitvolt_graph::walk`'s order (newest committer date first, then a
//! date-priority topological fix-up), each commit read and parsed in process.

use crate::commit::parse_commit;
use crate::error::{gix_err, GbError};
use crate::graph::{to_gix, to_oid};
use crate::message_refs::parse_message_refs;
pub use gitvolt_graph::{CommitMeta, Oid, WalkOptions, WalkResult};

fn load(repo: &gix::Repository, id: Oid) -> Result<Option<CommitMeta>, GbError> {
    let gid = to_gix(id);
    if !repo.has_object(gid) {
        return Ok(None);
    }
    let obj = repo.find_object(gid).map_err(gix_err)?;
    if obj.kind != gix::object::Kind::Commit {
        return Ok(None);
    }
    let c = parse_commit(&obj.data)?;
    Ok(Some(CommitMeta {
        id,
        parents: c.parents.into_iter().map(to_oid).collect(),
        author_name: c.author.name,
        author_email: c.author.email,
        author_time: c.author.time,
        committer_time: c.committer.time,
        mr_refs: parse_message_refs(&c.message),
        summary: c.summary,
        body: c.body,
    }))
}

pub fn walk(repo: &gix::Repository, tips: &[Oid], opts: &WalkOptions) -> Result<WalkResult, GbError> {
    gitvolt_graph::walk(tips, opts, |id| load(repo, id))
}

/// `gitvolt_graph::walk_by_date` over this repository: the collection order find sizes windows by.
pub fn walk_by_date(repo: &gix::Repository, tips: &[Oid], opts: &WalkOptions) -> Result<(Vec<CommitMeta>, bool), GbError> {
    gitvolt_graph::walk_by_date(tips, opts, |id| load(repo, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};
    use std::collections::{HashMap, HashSet};

    fn oid(s: &str) -> Oid {
        Oid::from_hex(s).unwrap()
    }

    fn all_tips(r: &TestRepo) -> Vec<Oid> {
        r.git(&["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"])
            .lines()
            .map(|l| {
                let peeled = r.git(&["rev-parse", &format!("{l}^{{commit}}")]);
                oid(&peeled)
            })
            .collect()
    }

    fn assert_children_first(commits: &[CommitMeta]) {
        let pos: HashMap<Oid, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();
        for (i, c) in commits.iter().enumerate() {
            for p in &c.parents {
                if let Some(&pi) = pos.get(p) {
                    assert!(pi > i, "parent {p} at {pi} is above child {} at {i}", c.id);
                }
            }
        }
    }

    #[test]
    fn walks_fixture_in_date_order_children_first() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let repo = gix::open(r.path()).unwrap();
        let res = walk(&repo, &all_tips(&r), &WalkOptions { limit: 100, first_parent_only: HashSet::new() }).unwrap();
        let summaries: Vec<&str> = res.commits.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["Hotfix: null check", "Merge branch 'feature/login'", "Fix typo", "Login validation", "Login form", "Add readme", "Initial commit"]);
        assert!(!res.truncated);
        assert_children_first(&res.commits);
        assert_eq!(res.commits[1].parents.len(), 2);
        assert_eq!(res.commits[0].author_name, "Grace Hopper");
    }

    #[test]
    fn respects_limit_and_reports_truncation() {
        let r = TestRepo::new();
        for i in 0..5 {
            r.commit(&format!("c{i}"));
        }
        let repo = gix::open(r.path()).unwrap();
        let head = oid(&r.git(&["rev-parse", "HEAD"]));
        let res = walk(&repo, &[head], &WalkOptions { limit: 3, first_parent_only: HashSet::new() }).unwrap();
        assert_eq!(res.commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), vec!["c4", "c3", "c2"]);
        assert!(res.truncated);
    }

    #[test]
    fn child_before_parent_despite_clock_skew() {
        let r = TestRepo::new();
        r.set_clock(2_000_000_000);
        r.commit("parent (clock ahead)");
        r.set_clock(1_000_000_000);
        r.commit("child (clock behind)");
        let repo = gix::open(r.path()).unwrap();
        let head = oid(&r.git(&["rev-parse", "HEAD"]));
        let res = walk(&repo, &[head], &WalkOptions { limit: 10, first_parent_only: HashSet::new() }).unwrap();
        assert_eq!(res.commits[0].summary, "child (clock behind)");
        assert_children_first(&res.commits);
    }

    /// Two children of M, one older than M (skew): the walk collects M before that child, while
    /// the topological order puts the child first. A window must be sized by collection order.
    #[test]
    fn collection_order_sizes_the_window_under_clock_skew() {
        let r = TestRepo::new();
        r.set_clock(2_000_000_000);
        r.commit("M");
        r.switch_new("b1");
        r.set_clock(3_000_000_000);
        r.commit("C1");
        r.switch("main");
        r.switch_new("b2");
        r.set_clock(1_000_000_000);
        r.commit("C2 (clock behind M)");
        let repo = gix::open(r.path()).unwrap();
        let tips = all_tips(&r);
        let opts = |limit| WalkOptions { limit, first_parent_only: HashSet::new() };
        let (collected, truncated) = walk_by_date(&repo, &tips, &opts(10)).unwrap();
        assert!(!truncated);
        assert_eq!(collected.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), vec!["C1", "M", "C2 (clock behind M)"]);
        let topo = walk(&repo, &tips, &opts(10)).unwrap();
        assert_eq!(topo.commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), vec!["C1", "C2 (clock behind M)", "M"]);
        // C2 sits at 1 in the topological order, but a window of 2 doesn't hold it; one of 3 does.
        let has_c2 = |limit| walk(&repo, &tips, &opts(limit)).unwrap().commits.iter().any(|c| c.summary.starts_with("C2"));
        assert!(!has_c2(2));
        assert!(has_c2(3));
        // Every smaller limit collects a prefix of the same order.
        for limit in 1..=3 {
            assert_eq!(walk_by_date(&repo, &tips, &opts(limit)).unwrap().0, collected[..limit].to_vec());
        }
    }

    #[test]
    fn shallow_clone_walks_without_error() {
        let r = TestRepo::new();
        for i in 0..4 {
            r.commit(&format!("c{i}"));
        }
        let shallow = r.root().join("shallow");
        let src = format!("file://{}", r.path().display());
        r.git_in(r.root(), &["clone", "-q", "--depth", "2", &src, shallow.to_str().unwrap()]);
        let repo = gix::open(&shallow).unwrap();
        let head = to_oid(repo.head_id().unwrap().detach());
        let res = walk(&repo, &[head], &WalkOptions { limit: 10, first_parent_only: HashSet::new() }).unwrap();
        assert_eq!(res.commits.len(), 2);
        assert_eq!(res.commits[1].parents.len(), 1, "missing parent id is kept");
        assert!(!res.commits.iter().any(|c| c.id == res.commits[1].parents[0]));
    }

    #[test]
    fn first_parent_only_hides_stash_internals() {
        let r = TestRepo::new();
        r.commit("base");
        r.stash("wip");
        let repo = gix::open(r.path()).unwrap();
        let stash = oid(&r.git(&["rev-parse", "stash@{0}"]));
        let res = walk(&repo, &[stash], &WalkOptions { limit: 10, first_parent_only: HashSet::from([stash]) }).unwrap();
        let summaries: Vec<&str> = res.commits.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["On main: wip", "base"], "the stash index commit must not appear");
        assert_eq!(res.commits[0].parents.len(), 1);
    }
}
