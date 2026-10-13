//! Collects up to `limit` commits newest-first, then fixes any clock-skew inversions with a
//! date-priority topological sort (Kahn) so that children always precede parents. The caller
//! loads each commit (gix in the core, a store of commits in the demo).

use crate::message::split_message;
use crate::message_refs::parse_message_refs;
use crate::Oid;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMeta {
    pub id: Oid,
    pub parents: Vec<Oid>,
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

impl CommitMeta {
    /// A walked commit from its headers and its full message, decoded (`split_message` normalizes it).
    pub fn from_message(id: Oid, parents: Vec<Oid>, author_name: String, author_email: String, author_time: i64, committer_time: i64, message: &str) -> CommitMeta {
        let (message, summary, body) = split_message(message);
        CommitMeta { id, parents, author_name, author_email, author_time, committer_time, mr_refs: parse_message_refs(&message), summary, body }
    }
}

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    pub limit: usize,
    /// Commits whose extra parents must not be followed or reported (stash commits).
    pub first_parent_only: HashSet<Oid>,
}

#[derive(Debug, Clone)]
pub struct WalkResult {
    pub commits: Vec<CommitMeta>,
    pub truncated: bool,
}

/// `load`: the commit `id` names, `None` when there's no such commit (a shallow clone's missing
/// parent, or an id that isn't a commit).
pub fn walk<E>(tips: &[Oid], opts: &WalkOptions, load: impl FnMut(Oid) -> Result<Option<CommitMeta>, E>) -> Result<WalkResult, E> {
    let (collected, truncated) = walk_by_date(tips, opts, load)?;
    Ok(WalkResult { commits: topo_by_date(collected), truncated })
}

/// The commits `walk` collects, in the order it collects them (newest committer date first),
/// before the topological fix-up; and whether more were left. A walk with a smaller `limit`
/// collects a prefix of this order, so a commit at position `i` here is in every window of
/// `limit > i` (find's outside-window hashes, spec §8.7).
pub fn walk_by_date<E>(tips: &[Oid], opts: &WalkOptions, mut load: impl FnMut(Oid) -> Result<Option<CommitMeta>, E>) -> Result<(Vec<CommitMeta>, bool), E> {
    let mut heap: BinaryHeap<(i64, Reverse<u64>, Oid)> = BinaryHeap::new();
    let mut loaded: HashMap<Oid, CommitMeta> = HashMap::new();
    let mut seen: HashSet<Oid> = HashSet::new();
    let mut seq = 0u64;
    let mut enqueue = |id: Oid, heap: &mut BinaryHeap<_>, loaded: &mut HashMap<_, _>| -> Result<(), E> {
        if seen.insert(id)
            && let Some(mut c) = load(id)?
        {
            if opts.first_parent_only.contains(&id) {
                c.parents.truncate(1);
            }
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
    Ok((collected, !heap.is_empty()))
}

/// Kahn's algorithm restricted to the collected set; ties are broken by committer time, then by
/// original (newest-first) position.
fn topo_by_date(commits: Vec<CommitMeta>) -> Vec<CommitMeta> {
    let index: HashMap<Oid, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();
    let mut children = vec![0usize; commits.len()];
    for c in &commits {
        for p in &c.parents {
            if let Some(&pi) = index.get(p) {
                children[pi] += 1;
            }
        }
    }
    let mut ready: BinaryHeap<(i64, Reverse<usize>)> = (0..commits.len()).filter(|&i| children[i] == 0).map(|i| (commits[i].committer_time, Reverse(i))).collect();
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
    use std::convert::Infallible;

    fn id(n: u8) -> Oid {
        Oid([n; 20])
    }

    fn commit(n: u8, parents: &[u8], time: i64, message: &str) -> CommitMeta {
        CommitMeta::from_message(id(n), parents.iter().map(|&p| id(p)).collect(), "Mara Quill".into(), "mara@example.com".into(), time, time, message)
    }

    fn run(commits: &[CommitMeta], tips: &[u8], limit: usize, first_parent_only: &[u8]) -> WalkResult {
        let store: HashMap<Oid, CommitMeta> = commits.iter().map(|c| (c.id, c.clone())).collect();
        let opts = WalkOptions { limit, first_parent_only: first_parent_only.iter().map(|&n| id(n)).collect() };
        let tips: Vec<Oid> = tips.iter().map(|&n| id(n)).collect();
        walk(&tips, &opts, |i| Ok::<_, Infallible>(store.get(&i).cloned())).unwrap()
    }

    fn summaries(r: &WalkResult) -> Vec<&str> {
        r.commits.iter().map(|c| c.summary.as_str()).collect()
    }

    #[test]
    fn child_before_parent_despite_clock_skew() {
        let r = run(&[commit(1, &[], 2_000, "parent (clock ahead)"), commit(2, &[1], 1_000, "child (clock behind)")], &[2], 10, &[]);
        assert_eq!(summaries(&r), ["child (clock behind)", "parent (clock ahead)"]);
        assert!(!r.truncated);
    }

    #[test]
    fn respects_the_limit_and_reports_truncation() {
        let cs: Vec<CommitMeta> = (1..=5)
            .map(|n| {
                let parents: Vec<u8> = if n == 1 { vec![] } else { vec![n - 1] };
                commit(n, &parents, i64::from(n) * 100, &format!("c{n}"))
            })
            .collect();
        let r = run(&cs, &[5], 3, &[]);
        assert_eq!(summaries(&r), ["c5", "c4", "c3"]);
        assert!(r.truncated);
    }

    /// Two children of M, one older than M: the walk collects M before that child, the
    /// topological order puts the child first (the core's `collection_order_sizes_the_window…`).
    #[test]
    fn collection_order_is_by_date_and_the_final_order_topological() {
        let cs = [commit(1, &[], 2_000, "M"), commit(2, &[1], 3_000, "C1"), commit(3, &[1], 1_000, "C2 (clock behind M)")];
        let store: HashMap<Oid, CommitMeta> = cs.iter().map(|c| (c.id, c.clone())).collect();
        let opts = WalkOptions { limit: 10, first_parent_only: HashSet::new() };
        let (collected, truncated) = walk_by_date(&[id(2), id(3), id(1)], &opts, |i| Ok::<_, Infallible>(store.get(&i).cloned())).unwrap();
        assert!(!truncated);
        assert_eq!(collected.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), ["C1", "M", "C2 (clock behind M)"]);
        assert_eq!(summaries(&run(&cs, &[2, 3, 1], 10, &[])), ["C1", "C2 (clock behind M)", "M"]);
    }

    #[test]
    fn first_parent_only_hides_a_stashs_other_parents() {
        let r = run(&[commit(1, &[], 100, "base"), commit(2, &[1], 150, "index on main"), commit(3, &[1, 2], 200, "On main: wip")], &[3], 10, &[3]);
        assert_eq!(summaries(&r), ["On main: wip", "base"]);
        assert_eq!(r.commits[0].parents, [id(1)]);
    }

    #[test]
    fn a_missing_parent_is_kept_but_not_walked() {
        let r = run(&[commit(2, &[1], 100, "shallow tip")], &[2], 10, &[]);
        assert_eq!(summaries(&r), ["shallow tip"]);
        assert_eq!(r.commits[0].parents, [id(1)]);
    }

    #[test]
    fn a_loader_error_stops_the_walk() {
        let opts = WalkOptions { limit: 10, first_parent_only: HashSet::new() };
        assert_eq!(walk(&[id(1)], &opts, |_| Err::<Option<CommitMeta>, _>("unreadable")).unwrap_err(), "unreadable");
    }

    #[test]
    fn from_message_splits_the_message_and_finds_its_references() {
        let c = commit(1, &[], 1, "Fix the thing\r\n\r\nLonger explanation\nsee !7\n\n");
        assert_eq!((c.summary.as_str(), c.body.as_str()), ("Fix the thing", "Longer explanation\nsee !7"));
        assert_eq!(c.mr_refs, ["!7"]);
        let c = commit(2, &[], 1, "Summary line\nsecond line names #3");
        assert_eq!((c.summary.as_str(), c.body.as_str()), ("Summary line", ""));
        assert_eq!(c.mr_refs, ["#3"], "lines after the summary without a blank line count too");
    }
}
