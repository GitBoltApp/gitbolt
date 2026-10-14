//! `GraphPayload` from plain data: the walk's tips, the rows' order (WIP placement), the pins, the
//! lane layout and the labels. Moved from the core's snapshot.rs, which now reads the repository
//! and calls `assemble`.

use crate::input::{GraphInput, GraphRequest, HeadIn, RefsIn, WorktreeIn};
use crate::labels::build_labels;
use crate::layout::{layout, LayoutNode, NodeKind, Parent};
use crate::payload::{GraphPayload, GraphWorktree, HeadPayload, InProgress, RowPayload, WipPayload};
use crate::pins::{default_pair, fork_of, fork_payload, pin_pair, pinned_chains};
use crate::walk::{walk, walk_by_date, CommitMeta, WalkOptions, WalkResult};
use crate::Oid;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The commits the graph walks from, deduplicated, in order: HEAD, every ref, every worktree's
/// HEAD, then the stashes and the MR heads Compare fetched. Find's `locateCommit` walks from the
/// same tips, so the window it computes is the one the graph then loads.
///
/// The tips come from the handle's own HEAD (`refs.head`), whichever worktree is active: the
/// active one's HEAD is among the worktrees' anyway, and the same tips keep the core's walk cache
/// valid across a switch.
pub fn graph_tips(refs: &RefsIn, worktrees: &[WorktreeIn]) -> Vec<Oid> {
    let mut tips = Vec::new();
    let mut seen = HashSet::new();
    let candidates = refs.head.target.into_iter().chain(refs.refs.iter().map(|r| r.target)).chain(worktrees.iter().filter_map(|w| w.head)).chain(refs.stashes.iter().map(|s| s.id)).chain(refs.compare_heads.iter().copied());
    for id in candidates {
        if seen.insert(id) {
            tips.push(id);
        }
    }
    tips
}

enum Entry {
    Commit(usize),
    Wip(usize),
}

/// The graph of `input`'s repository over `walked` (the walk from `graph_tips`). `Err` only when
/// the `testing` feature's continuity check finds a broken line.
pub fn assemble(input: &GraphInput, walked: &WalkResult) -> Result<GraphPayload, String> {
    let refs = &input.refs;
    let worktrees = &input.worktrees;
    let wip = &input.wip;
    let commits = &walked.commits;
    let stash_ids: HashSet<Oid> = refs.stashes.iter().map(|s| s.id).collect();

    // The active worktree's HEAD replaces the handle's.
    let active = input.active.as_deref();
    let head = match active.and_then(|a| worktrees.iter().find(|w| w.canonical == a)) {
        Some(w) => HeadIn { branch: w.branch.clone(), target: w.head, detached: w.branch.is_none() && w.head.is_some(), unborn: w.head.is_none() },
        None => refs.head.clone(),
    };
    let index: HashMap<Oid, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();

    let fork = fork_of(refs, &input.forks);
    let names = match (&input.pinned_ref, input.no_pin) {
        (_, true) => vec![],
        (Some(name), false) => pin_pair(refs, name),
        (None, false) => default_pair(refs, fork.as_ref(), &input.forks.parents),
    };
    let pair: Vec<(String, Oid)> = names
        .into_iter()
        .filter_map(|n| {
            let target = refs.refs.iter().find(|r| r.full_name == n)?.target;
            Some((n, target))
        })
        .collect();
    // Lane 0 is the trunk's whenever a pinned ref resolves, even if this window was cut above its
    // tip: the window then lays out exactly as the prefix of a longer one (spec §8.2).
    let reserve_trunk = !pair.is_empty();
    // Don't report a pinned name whose target isn't actually in the walked window (an invalid
    // override, or a ref whose commit got truncated out): that would show a name with nothing
    // pinned to it.
    let pair: Vec<(String, usize)> = pair.into_iter().filter_map(|(n, id)| Some((n, *index.get(&id)?))).collect();
    let pinned_refs: Vec<String> = pair.iter().map(|(n, _)| n.clone()).collect();
    let (pinned, pinned_tips) = pinned_chains(commits, &index, &pair.iter().map(|&(_, i)| i).collect::<Vec<_>>());

    // WIP placement (spec §8.6): the open worktree's WIP is "now", row 0, whatever the dates of
    // the commits below it; every other worktree's WIP docks directly above its HEAD commit,
    // several on one commit stacked by worktree name.
    let here: &str = active.unwrap_or(&input.workdir);
    let mut current_wip = None;
    let mut wip_by_head: HashMap<usize, Vec<usize>> = HashMap::new();
    // An unborn worktree (no HEAD yet) has changes but no commit to dock above: its WIP row has
    // no parent and sits at the top, so the first commit is reachable.
    let mut unborn_wip: Vec<usize> = vec![];
    for (k, (wt, _)) in wip.iter().enumerate() {
        let w = &worktrees[*wt];
        if w.head.is_none() {
            if current_wip.is_none() && w.canonical == here {
                current_wip = Some(k);
            } else {
                unborn_wip.push(k);
            }
            continue;
        }
        let Some(&ci) = w.head.and_then(|h| index.get(&h)) else { continue };
        if current_wip.is_none() && w.canonical == here {
            current_wip = Some(k);
        } else {
            wip_by_head.entry(ci).or_default().push(k);
        }
    }
    for stack in wip_by_head.values_mut() {
        stack.sort_by_cached_key(|&k| {
            let p = Path::new(&worktrees[wip[k].0].path);
            (p.file_name().map(|f| f.to_os_string()), p.to_path_buf())
        });
    }
    let mut entries = Vec::with_capacity(commits.len() + wip.len());
    entries.extend(current_wip.map(Entry::Wip));
    entries.extend(unborn_wip.into_iter().map(Entry::Wip));
    let mut row_of_commit = vec![0u32; commits.len()];
    for (ci, slot) in row_of_commit.iter_mut().enumerate() {
        for &k in wip_by_head.get(&ci).map(Vec::as_slice).unwrap_or(&[]) {
            entries.push(Entry::Wip(k));
        }
        *slot = entries.len() as u32;
        entries.push(Entry::Commit(ci));
    }

    // The topmost WIP on a pinned lane's tip rides that lane: nothing else is pinned above the
    // tip, so its dashed line runs down the lane into the tip (any other WIP on that commit
    // takes its own lane).
    let head_of = |k: usize| worktrees[wip[k].0].head.map(|h| index[&h]);
    let pinned_wip: HashMap<usize, u16> = pinned_tips
        .iter()
        .enumerate()
        .filter_map(|(lane, &tip)| {
            let k = entries.iter().find_map(|e| match *e {
                Entry::Wip(k) if head_of(k) == Some(tip) => Some(k),
                _ => None,
            })?;
            Some((k, lane as u16))
        })
        .collect();
    // Lane 0 for the whole window; a diverged pair's lane 1 through its chain's last row.
    let reserved: Vec<u32> = reserve_trunk.then_some(u32::MAX).into_iter().chain(pinned.iter().filter(|&(_, &lane)| lane == 1).map(|(&ci, _)| row_of_commit[ci]).max()).collect();
    let nodes: Vec<LayoutNode> = entries
        .iter()
        .map(|e| match e {
            Entry::Commit(ci) => {
                let c = &commits[*ci];
                LayoutNode {
                    parents: c.parents.iter().map(|p| index.get(p).map(|&pi| Parent::Row(row_of_commit[pi])).unwrap_or(Parent::Outside(*p))).collect(),
                    kind: if stash_ids.contains(&c.id) { NodeKind::Stash } else if c.parents.len() > 1 { NodeKind::Merge } else { NodeKind::Commit },
                    pinned: pinned.get(ci).copied(),
                    time: c.committer_time,
                }
            }
            Entry::Wip(k) => LayoutNode { parents: head_of(*k).map(|h| Parent::Row(row_of_commit[h])).into_iter().collect(), kind: NodeKind::Wip, pinned: pinned_wip.get(k).copied(), time: i64::MAX },
        })
        .collect();
    let lay = layout(&nodes, &reserved);
    // Unit tests and the harness (and so the e2e suite, including the opt-in real-repo spec)
    // verify every graph they build; a violation surfaces as an ordinary error, not a panic.
    #[cfg(any(test, feature = "testing"))]
    crate::check_continuity(&lay, &nodes)?;

    let main_path = worktrees.iter().find(|w| w.is_main).map(|w| w.path.clone());
    let rows = entries
        .iter()
        .zip(&lay.rows)
        .zip(&nodes)
        .map(|((e, g), n)| {
            let segments = g.segments.iter().map(|s| s.pack()).collect();
            match e {
                Entry::Commit(ci) => {
                    let c = &commits[*ci];
                    RowPayload {
                        id: c.id.to_string(),
                        kind: n.kind,
                        lane: g.lane,
                        color: g.color,
                        segments,
                        summary: c.summary.clone(),
                        body_first_line: c.body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string(),
                        author_name: c.author_name.clone(),
                        author_email: c.author_email.clone(),
                        author_time: c.author_time,
                        committer_time: c.committer_time,
                        parents: c.parents.iter().map(Oid::to_string).collect(),
                        // Parsed by the walk from the full message: no second object lookup.
                        mr_refs: c.mr_refs.clone(),
                        wip: None,
                    }
                }
                Entry::Wip(k) => {
                    let (wt_idx, counts) = wip[*k];
                    let wt = &worktrees[wt_idx];
                    let is_main = main_path.as_ref() == Some(&wt.path);
                    RowPayload {
                        id: format!("wip:{}", wt.path),
                        kind: NodeKind::Wip,
                        lane: g.lane,
                        color: g.color,
                        segments,
                        summary: "// WIP".into(),
                        body_first_line: String::new(),
                        author_name: String::new(),
                        author_email: String::new(),
                        author_time: 0,
                        committer_time: 0,
                        parents: wt.head.map(|h| h.to_string()).into_iter().collect(),
                        mr_refs: vec![],
                        wip: Some(WipPayload {
                            worktree_path: wt.path.clone(),
                            worktree_name: (!is_main).then(|| Path::new(&wt.path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()),
                            modified: counts.modified,
                            added: counts.added,
                            deleted: counts.deleted,
                            renamed: counts.renamed,
                            conflicted: counts.conflicted,
                        }),
                    }
                }
            }
        })
        .collect();

    let in_progress = input.in_progress.clone();
    let worktrees_out: Vec<GraphWorktree> = worktrees
        .iter()
        .filter(|w| !w.bare && !w.prunable)
        .map(|w| {
            let in_progress = in_progress.get(&w.path).map(|s| match s {
                InProgress::Merge { .. } => "merge".to_string(),
                InProgress::Rebase { .. } => "rebase".to_string(),
                InProgress::CherryPick { .. } => "cherry-pick".to_string(),
                InProgress::Revert { .. } => "revert".to_string(),
                InProgress::Other { what } => what.clone(),
            });
            GraphWorktree { path: w.path.clone(), branch: w.branch.clone(), head: w.head.map(|h| h.to_string()), is_main: w.is_main, locked: w.locked, in_progress }
        })
        .collect();
    Ok(GraphPayload {
        fork: fork.as_ref().map(|f| fork_payload(refs, f)),
        rows,
        labels: build_labels(refs, &head, worktrees, here, &index, &row_of_commit),
        max_lanes: lay.max_lanes,
        pinned_refs,
        head: HeadPayload { branch: head.branch.clone(), target: head.target.map(|t| t.to_string()), detached: head.detached, unborn: head.unborn },
        truncated: walked.truncated,
        open_worktree: worktrees.iter().find(|w| !w.bare && !w.prunable && w.canonical == here).map(|w| w.path.clone()),
        worktrees: worktrees_out,
        in_progress,
    })
}

/// The whole pipeline over commits already in memory (the website demo's): walk `limit` commits
/// from `graph_tips`, then `assemble`.
pub fn build(request: &GraphRequest, commits: &HashMap<Oid, CommitMeta>) -> Result<GraphPayload, String> {
    let input = &request.input;
    let tips = graph_tips(&input.refs, &input.worktrees);
    let opts = WalkOptions { limit: request.limit, first_parent_only: input.refs.stashes.iter().map(|s| s.id).collect() };
    let walked = match walk(&tips, &opts, |id| Ok::<_, std::convert::Infallible>(commits.get(&id).cloned())) {
        Ok(w) => w,
        Err(never) => match never {},
    };
    assemble(input, &walked)
}

/// The order `build`'s walk collects commits in (newest committer date first, before the
/// topological fix-up): a window of `i + 1` commits holds the `i`th, which is what find's
/// `locateCommit` sizes a window by (the core's `walk_by_date` over `graph_tips`).
pub fn walk_order(request: &GraphRequest, commits: &HashMap<Oid, CommitMeta>) -> Vec<Oid> {
    let input = &request.input;
    let tips = graph_tips(&input.refs, &input.worktrees);
    let opts = WalkOptions { limit: request.limit, first_parent_only: input.refs.stashes.iter().map(|s| s.id).collect() };
    match walk_by_date(&tips, &opts, |id| Ok::<_, std::convert::Infallible>(commits.get(&id).cloned())) {
        Ok((collected, _)) => collected.into_iter().map(|c| c.id).collect(),
        Err(never) => match never {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{GraphInput, GraphRequest, HeadIn, RefIn, RefKind, RefsIn, StashIn, WorktreeIn};
    use crate::payload::WipCounts;
    use crate::NodeKind;

    fn id(n: u8) -> Oid {
        Oid([n; 20])
    }

    fn commit(n: u8, parents: &[u8], time: i64, message: &str) -> CommitMeta {
        CommitMeta::from_message(id(n), parents.iter().map(|&p| id(p)).collect(), "Mara Quill".into(), "mara@example.com".into(), time, time, message)
    }

    fn local(name: &str, n: u8) -> RefIn {
        RefIn { full_name: format!("refs/heads/{name}"), short_name: name.into(), kind: RefKind::Local, target: id(n), upstream: None, upstream_mismatch: None, annotation: None }
    }

    fn worktree(path: &str, head: u8, branch: &str, is_main: bool) -> WorktreeIn {
        WorktreeIn { path: path.into(), canonical: path.into(), head: Some(id(head)), branch: Some(format!("refs/heads/{branch}")), is_main, bare: false, prunable: false, locked: false }
    }

    /// main: 1 ← 2 ← 4 (merging 3); feature: 1 ← 3.
    fn history() -> (GraphRequest, HashMap<Oid, CommitMeta>) {
        let commits = [commit(1, &[], 100, "Initial commit"), commit(2, &[1], 200, "Fix typo"), commit(3, &[1], 300, "Login form"), commit(4, &[2, 3], 400, "Merge branch 'feature'\n\nSee !12")];
        let input = GraphInput {
            refs: RefsIn { head: HeadIn { branch: Some("refs/heads/main".into()), target: Some(id(4)), detached: false, unborn: false }, refs: vec![local("feature", 3), local("main", 4)], ..Default::default() },
            worktrees: vec![worktree("/demo/x", 4, "main", true)],
            workdir: "/demo/x".into(),
            ..Default::default()
        };
        (GraphRequest { input, limit: 100 }, commits.into_iter().map(|c| (c.id, c)).collect())
    }

    fn summaries(g: &GraphPayload) -> Vec<&str> {
        g.rows.iter().map(|r| r.summary.as_str()).collect()
    }

    #[test]
    fn rows_children_first_with_the_local_main_pinned_at_the_left() {
        let (req, commits) = history();
        let g = build(&req, &commits).unwrap();
        assert_eq!(summaries(&g), ["Merge branch 'feature'", "Login form", "Fix typo", "Initial commit"]);
        assert_eq!(g.pinned_refs, ["refs/heads/main"]);
        assert_eq!(g.rows.iter().map(|r| r.lane).collect::<Vec<_>>(), [0, 1, 0, 0]);
        assert_eq!(g.rows[0].kind, NodeKind::Merge);
        assert_eq!((g.rows[0].body_first_line.as_str(), g.rows[0].mr_refs.clone()), ("See !12", vec!["!12".to_string()]));
        assert_eq!(g.rows[0].parents, [id(2).to_string(), id(3).to_string()]);
        assert!(!g.truncated);
        assert_eq!(g.head.branch.as_deref(), Some("refs/heads/main"));
        assert_eq!(g.open_worktree.as_deref(), Some("/demo/x"));
        let main = g.labels.iter().find(|l| l.name == "main").unwrap();
        assert_eq!((main.row, main.is_head), (0, true));
        assert_eq!(g.labels.iter().find(|l| l.name == "feature").unwrap().row, 1);
    }

    #[test]
    fn a_dirty_open_worktree_gets_the_top_row() {
        let (mut req, commits) = history();
        req.input.wip = vec![(0, WipCounts { modified: 2, ..Default::default() })];
        let g = build(&req, &commits).unwrap();
        let w = &g.rows[0];
        assert_eq!((w.id.as_str(), w.kind, w.summary.as_str()), ("wip:/demo/x", NodeKind::Wip, "// WIP"));
        let p = w.wip.as_ref().unwrap();
        assert_eq!((p.worktree_path.as_str(), p.worktree_name.clone(), p.modified), ("/demo/x", None, 2));
        assert_eq!(w.parents, [id(4).to_string()]);
        assert_eq!(g.labels.iter().find(|l| l.name == "main").unwrap().row, 1, "labels follow their commit down a row");
    }

    #[test]
    fn the_limit_truncates() {
        let (mut req, commits) = history();
        req.limit = 2;
        let g = build(&req, &commits).unwrap();
        assert_eq!(g.rows.len(), 2);
        assert!(g.truncated);
    }

    #[test]
    fn the_active_worktree_takes_head_and_the_open_worktree() {
        let (mut req, commits) = history();
        req.input.worktrees.push(worktree("/demo/.extra/x/wt", 3, "feature", false));
        req.input.active = Some("/demo/.extra/x/wt".into());
        let g = build(&req, &commits).unwrap();
        assert_eq!(g.head.branch.as_deref(), Some("refs/heads/feature"));
        assert_eq!(g.open_worktree.as_deref(), Some("/demo/.extra/x/wt"));
        let feature = g.labels.iter().find(|l| l.name == "feature").unwrap();
        assert!(feature.is_head);
        assert_eq!(g.labels.iter().find(|l| l.name == "main").unwrap().worktree.as_deref(), Some("/demo/x"), "main is checked out elsewhere");
        assert_eq!(g.worktrees.len(), 2);
    }

    #[test]
    fn pin_off_pins_nothing_and_an_explicit_pin_pins_that_ref() {
        let (mut req, commits) = history();
        req.input.no_pin = true;
        assert!(build(&req, &commits).unwrap().pinned_refs.is_empty());
        req.input.no_pin = false;
        req.input.pinned_ref = Some("refs/heads/feature".into());
        let g = build(&req, &commits).unwrap();
        assert_eq!(g.pinned_refs, ["refs/heads/feature"]);
        assert_eq!(g.rows[1].lane, 0, "Login form leads lane 0");
    }

    #[test]
    fn a_stash_is_a_stash_row_whose_other_parents_are_hidden() {
        let (mut req, mut commits) = history();
        for c in [commit(5, &[4], 450, "index on main: Merge"), commit(6, &[4, 5], 500, "On main: Experiment")] {
            commits.insert(c.id, c);
        }
        req.input.refs.stashes = vec![StashIn { index: 0, id: id(6), message: "On main: Experiment".into(), time: 500 }];
        let g = build(&req, &commits).unwrap();
        assert_eq!(g.rows[0].kind, NodeKind::Stash);
        assert!(!summaries(&g).contains(&"index on main: Merge"));
    }

    #[test]
    fn a_worktrees_operation_in_progress_is_named_by_its_path() {
        let (mut req, commits) = history();
        req.input.worktrees.push(worktree("/demo/.extra/x/wt", 3, "feature", false));
        let rebase = InProgress::Rebase {
            onto: id(1).to_string(),
            head_name: "refs/heads/feature".into(),
            step: 1,
            total: 2,
            stopped_at: Some(id(3).to_string()),
            edit_stop: None,
            edit_base: None,
            edit_added: vec![],
            edit_changed: false,
            edit_conflict: false,
            message_failed: None,
            gitvolt: false,
            conflicted: 1,
            message: "Login form".into(),
        };
        req.input.in_progress = [("/demo/.extra/x/wt".to_string(), rebase.clone())].into();
        let g = build(&req, &commits).unwrap();
        let kinds: Vec<(&str, Option<&str>)> = g.worktrees.iter().map(|w| (w.path.as_str(), w.in_progress.as_deref())).collect();
        assert_eq!(kinds, [("/demo/x", None), ("/demo/.extra/x/wt", Some("rebase"))]);
        assert_eq!(g.in_progress.get("/demo/.extra/x/wt"), Some(&rebase), "the map is the payload's as given");
    }

    #[test]
    fn tips_are_head_refs_worktrees_stashes_then_compare_heads_once_each() {
        let refs = RefsIn {
            head: HeadIn { target: Some(id(4)), ..Default::default() },
            refs: vec![local("feature", 3), local("main", 4)],
            stashes: vec![StashIn { index: 0, id: id(6), message: String::new(), time: 0 }],
            compare_heads: vec![id(7), id(3)],
            ..Default::default()
        };
        assert_eq!(graph_tips(&refs, &[worktree("/demo/.extra/x/wt", 5, "wt", false)]), [id(4), id(3), id(5), id(6), id(7)]);
    }

    #[test]
    fn walk_order_is_the_collection_order_not_the_layouts() {
        // C2's clock is behind M's: collected after M, laid out before it.
        let cs = [commit(1, &[], 2_000, "M"), commit(2, &[1], 3_000, "C1"), commit(3, &[1], 1_000, "C2")];
        let input = GraphInput { refs: RefsIn { refs: vec![local("b1", 2), local("b2", 3)], ..Default::default() }, workdir: "/demo/x".into(), ..Default::default() };
        let req = GraphRequest { input, limit: 10 };
        let commits: HashMap<Oid, CommitMeta> = cs.into_iter().map(|c| (c.id, c)).collect();
        assert_eq!(walk_order(&req, &commits), [id(2), id(1), id(3)]);
        assert_eq!(summaries(&build(&req, &commits).unwrap()), ["C1", "C2", "M"]);
    }
}
