//! Collects up to `limit` commits newest-first, then fixes any clock-skew inversions with a
//! date-priority topological sort (Kahn) so that children always precede parents.

use crate::commit::parse_commit;
use crate::error::{gix_err, GbError};
use crate::message_refs::parse_message_refs;
use gix::ObjectId;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMeta {
    pub id: ObjectId,
    pub parents: Vec<ObjectId>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub summary: String,
    pub body: String,
    /// MR/PR/issue references in the full message (`message_refs`), parsed from the same
    /// decoded commit: it includes lines 2+ of the first paragraph, which `summary`/`body` drop.
    pub mr_refs: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    pub limit: usize,
    /// Commits whose extra parents must not be followed or reported (stash commits).
    pub first_parent_only: HashSet<ObjectId>,
}

#[derive(Debug, Clone)]
pub struct WalkResult {
    pub commits: Vec<CommitMeta>,
    pub truncated: bool,
}

fn load(repo: &gix::Repository, id: ObjectId, opts: &WalkOptions) -> Result<Option<CommitMeta>, GbError> {
    if !repo.has_object(id) {
        return Ok(None);
    }
    let obj = repo.find_object(id).map_err(gix_err)?;
    if obj.kind != gix::object::Kind::Commit {
        return Ok(None);
    }
    let c = parse_commit(&obj.data)?;
    let mut parents = c.parents;
    if opts.first_parent_only.contains(&id) {
        parents.truncate(1);
    }
    Ok(Some(CommitMeta {
        id,
        parents,
        author_name: c.author.name,
        author_email: c.author.email,
        author_time: c.author.time,
        committer_time: c.committer.time,
        mr_refs: parse_message_refs(&c.message),
        summary: c.summary,
        body: c.body,
    }))
}

pub fn walk(repo: &gix::Repository, tips: &[ObjectId], opts: &WalkOptions) -> Result<WalkResult, GbError> {
    let mut heap: BinaryHeap<(i64, Reverse<u64>, ObjectId)> = BinaryHeap::new();
    let mut loaded: HashMap<ObjectId, CommitMeta> = HashMap::new();
    let mut seen: HashSet<ObjectId> = HashSet::new();
    let mut seq = 0u64;
    let mut enqueue = |id: ObjectId, heap: &mut BinaryHeap<_>, loaded: &mut HashMap<_, _>| -> Result<(), GbError> {
        if seen.insert(id) && let Some(c) = load(repo, id, opts)? {
            heap.push((c.committer_time, Reverse(seq), id));
            seq += 1;
            loaded.insert(id, c);
        }
        Ok(())
    };
    for &t in tips {
        enqueue(t, &mut heap, &mut loaded)?;
    }
    let mut collected = Vec::new();
    while collected.len() < opts.limit {
        let Some((_, _, id)) = heap.pop() else { break };
        let c = loaded.remove(&id).expect("enqueued commit is loaded");
        for &p in &c.parents {
            enqueue(p, &mut heap, &mut loaded)?;
        }
        collected.push(c);
    }
    let truncated = !heap.is_empty();
    Ok(WalkResult { commits: topo_by_date(collected), truncated })
}

/// Kahn's algorithm restricted to the collected set; ties are broken by committer time, then by
/// original (newest-first) position.
fn topo_by_date(commits: Vec<CommitMeta>) -> Vec<CommitMeta> {
    let index: HashMap<ObjectId, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();
    let mut children = vec![0usize; commits.len()];
    for c in &commits {
        for p in &c.parents {
            if let Some(&pi) = index.get(p) {
                children[pi] += 1;
            }
        }
    }
    let mut ready: BinaryHeap<(i64, Reverse<usize>)> =
        (0..commits.len()).filter(|&i| children[i] == 0).map(|i| (commits[i].committer_time, Reverse(i))).collect();
    let mut order = Vec::with_capacity(commits.len());
    while let Some((_, Reverse(i))) = ready.pop() {
        order.push(i);
        for p in &commits[i].parents {
            if let Some(&pi) = index.get(p) {
                children[pi] -= 1;
                if children[pi] == 0 {
                    ready.push((commits[pi].committer_time, Reverse(pi)));
                }
            }
        }
    }
    let mut slots: Vec<Option<CommitMeta>> = commits.into_iter().map(Some).collect();
    order.into_iter().map(|i| slots[i].take().expect("each commit emitted once")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};

    fn oid(s: &str) -> ObjectId {
        ObjectId::from_hex(s.as_bytes()).unwrap()
    }

    fn all_tips(r: &TestRepo) -> Vec<ObjectId> {
        r.git(&["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"])
            .lines()
            .map(|l| {
                let peeled = r.git(&["rev-parse", &format!("{l}^{{commit}}")]);
                oid(&peeled)
            })
            .collect()
    }

    fn assert_children_first(commits: &[CommitMeta]) {
        let pos: HashMap<ObjectId, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();
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
        let head = repo.head_id().unwrap().detach();
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
