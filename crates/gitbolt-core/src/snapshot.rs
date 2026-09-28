//! Builds the graph payload for one repository.

use crate::error::GbError;
use crate::git::GitCli;
use crate::graph::{layout, LayoutNode, NodeKind, Parent};
use crate::payload::{GraphPayload, HeadPayload, RefLabel, RemoteRefLabel, RowPayload, WipPayload};
use crate::refs::{read_refs, RefKind, RepoRefs};
use crate::remotes::HostKind;
use crate::status::{status, summarize, WipCounts};
use crate::walk::{walk, WalkOptions};
use crate::worktree::{list_worktrees, Worktree};
use gix::ObjectId;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const DEFAULT_COMMIT_LIMIT: usize = 2000;

#[derive(Debug, Clone)]
pub struct BuildOptions {
    pub limit: usize,
    pub pinned_ref: Option<String>,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self { limit: DEFAULT_COMMIT_LIMIT, pinned_ref: None }
    }
}

pub async fn build_graph(repo: gix::ThreadSafeRepository, workdir: PathBuf, cli: GitCli, opts: BuildOptions) -> Result<GraphPayload, GbError> {
    let worktrees = list_worktrees(&cli, &workdir).await?;
    let wip = collect_wip(&cli, &worktrees).await;
    tokio::task::spawn_blocking(move || assemble(&repo.to_thread_local(), &worktrees, &wip, &workdir, &opts))
        .await
        .map_err(|e| GbError::other(format!("graph task failed: {e}")))?
}

/// (index into `worktrees`, counts) for every dirty, usable worktree.
async fn collect_wip(cli: &GitCli, worktrees: &[Worktree]) -> Vec<(usize, WipCounts)> {
    let jobs = worktrees.iter().enumerate().filter(|(_, w)| !w.bare && !w.prunable && w.head.is_some() && w.path.is_dir()).map(|(i, w)| async move {
        match status(cli, &w.path).await {
            Ok(entries) => Some((i, summarize(&entries))),
            Err(e) => {
                tracing::warn!("status failed for worktree {}: {e}", w.path.display());
                None
            }
        }
    });
    futures_util::future::join_all(jobs).await.into_iter().flatten().filter(|(_, c)| !c.is_empty()).collect()
}

fn default_trunk(refs: &RepoRefs) -> Option<String> {
    let exists = |n: &str| refs.refs.iter().any(|r| r.full_name == n);
    let mut remotes: Vec<&String> = refs.remote_hosts.keys().collect();
    remotes.sort_by_key(|r| (r.as_str() != "origin", r.as_str()));
    for remote in &remotes {
        if let Some(t) = refs.remote_heads.get(*remote)
            && exists(t)
        {
            return Some(t.clone());
        }
    }
    for remote in &remotes {
        for b in ["main", "master", "dev", "develop"] {
            let name = format!("refs/remotes/{remote}/{b}");
            if exists(&name) {
                return Some(name);
            }
        }
    }
    None
}

enum Entry {
    Commit(usize),
    Wip(usize),
}

fn assemble(repo: &gix::Repository, worktrees: &[Worktree], wip: &[(usize, WipCounts)], workdir: &Path, opts: &BuildOptions) -> Result<GraphPayload, GbError> {
    let refs = read_refs(repo)?;
    let stash_ids: HashSet<ObjectId> = refs.stashes.iter().map(|s| s.id).collect();

    let mut tips = Vec::new();
    let mut seen = HashSet::new();
    let candidates = refs.head.target.into_iter()
        .chain(refs.refs.iter().map(|r| r.target))
        .chain(worktrees.iter().filter_map(|w| w.head))
        .chain(refs.stashes.iter().map(|s| s.id));
    for id in candidates {
        if seen.insert(id) {
            tips.push(id);
        }
    }
    let walked = walk(repo, &tips, &WalkOptions { limit: opts.limit, first_parent_only: stash_ids.clone() })?;
    let commits = &walked.commits;
    let index: HashMap<ObjectId, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();

    let pinned_ref_candidate = opts.pinned_ref.clone().or_else(|| default_trunk(&refs));
    let pinned_tip = pinned_ref_candidate
        .as_ref()
        .and_then(|n| refs.refs.iter().find(|r| &r.full_name == n))
        .map(|r| r.target)
        .filter(|id| index.contains_key(id));
    // Don't report a trunk name whose target isn't actually in the walked window (an invalid
    // override, or a ref whose commit got truncated out): that would show a name with nothing
    // pinned to it.
    let pinned_ref = if pinned_tip.is_some() { pinned_ref_candidate } else { None };
    let mut pinned: HashSet<usize> = HashSet::new();
    let mut cur = pinned_tip;
    while let Some(id) = cur {
        let Some(&i) = index.get(&id) else { break };
        if !pinned.insert(i) {
            break;
        }
        cur = commits[i].parents.first().copied();
    }

    let mut wip_by_head: HashMap<usize, Vec<usize>> = HashMap::new();
    for (k, (wt, _)) in wip.iter().enumerate() {
        if let Some(&ci) = worktrees[*wt].head.and_then(|h| index.get(&h)) {
            wip_by_head.entry(ci).or_default().push(k);
        }
    }
    let mut entries = Vec::with_capacity(commits.len() + wip.len());
    let mut row_of_commit = vec![0u32; commits.len()];
    for (ci, slot) in row_of_commit.iter_mut().enumerate() {
        for &k in wip_by_head.get(&ci).map(Vec::as_slice).unwrap_or(&[]) {
            entries.push(Entry::Wip(k));
        }
        *slot = entries.len() as u32;
        entries.push(Entry::Commit(ci));
    }

    let nodes: Vec<LayoutNode> = entries
        .iter()
        .enumerate()
        .map(|(row, e)| match e {
            Entry::Commit(ci) => {
                let c = &commits[*ci];
                LayoutNode {
                    parents: c.parents.iter().map(|p| index.get(p).map(|&pi| Parent::Row(row_of_commit[pi])).unwrap_or(Parent::Outside(*p))).collect(),
                    kind: if stash_ids.contains(&c.id) { NodeKind::Stash } else if c.parents.len() > 1 { NodeKind::Merge } else { NodeKind::Commit },
                    pinned: pinned.contains(ci),
                }
            }
            Entry::Wip(k) => {
                let head_ci = index[&worktrees[wip[*k].0].head.expect("filtered")];
                let directly_above = row_of_commit[head_ci] as usize == row + 1;
                LayoutNode {
                    parents: vec![Parent::Row(row_of_commit[head_ci])],
                    kind: NodeKind::Wip,
                    pinned: directly_above && Some(commits[head_ci].id) == pinned_tip && pinned.contains(&head_ci),
                }
            }
        })
        .collect();
    let lay = layout(&nodes);
    // Unit tests and the harness (and so the e2e suite, including the opt-in real-repo spec)
    // verify every graph they build; a violation surfaces as an ordinary error, not a panic.
    #[cfg(any(test, feature = "testing"))]
    crate::graph::check_continuity(&lay, &nodes).map_err(|e| GbError::other(format!("graph continuity violated: {e}")))?;

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
                        parents: c.parents.iter().map(ObjectId::to_string).collect(),
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
                        id: format!("wip:{}", wt.path.display()),
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
                        parents: vec![wt.head.expect("filtered").to_string()],
                        mr_refs: vec![],
                        wip: Some(WipPayload {
                            worktree_path: wt.path.display().to_string(),
                            worktree_name: (!is_main).then(|| wt.path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()),
                            modified: counts.modified,
                            added: counts.added,
                            deleted: counts.deleted,
                            conflicted: counts.conflicted,
                        }),
                    }
                }
            }
        })
        .collect();

    Ok(GraphPayload {
        rows,
        labels: build_labels(&refs, worktrees, workdir, &index, &row_of_commit),
        max_lanes: lay.max_lanes,
        pinned_ref,
        head: HeadPayload {
            branch: refs.head.branch.clone(),
            target: refs.head.target.map(|t| t.to_string()),
            detached: refs.head.detached,
            unborn: refs.head.unborn,
        },
        truncated: walked.truncated,
    })
}

fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn build_labels(refs: &RepoRefs, worktrees: &[Worktree], workdir: &Path, index: &HashMap<ObjectId, usize>, row_of_commit: &[u32]) -> Vec<RefLabel> {
    let here = canonical(workdir);
    let checked_out_elsewhere: HashMap<&str, String> = worktrees
        .iter()
        .filter(|w| canonical(&w.path) != here)
        .filter_map(|w| w.branch.as_deref().map(|b| (b, w.path.display().to_string())))
        .collect();
    let row_of = |id: &ObjectId| index.get(id).map(|&i| row_of_commit[i]);
    let host = |remote: &str| refs.remote_hosts.get(remote).copied().unwrap_or(HostKind::Generic);

    let mut labels = Vec::new();
    let mut merged: HashSet<&str> = HashSet::new();
    for local in refs.refs.iter().filter(|r| r.kind == RefKind::Local) {
        let Some(row) = row_of(&local.target) else { continue };
        let mut remotes = Vec::new();
        for rr in &refs.refs {
            let RefKind::Remote { remote } = &rr.kind else { continue };
            let branch_part = &rr.short_name[remote.len() + 1..];
            let is_counterpart = branch_part == local.short_name || local.upstream.as_deref() == Some(rr.full_name.as_str());
            if rr.target == local.target && is_counterpart {
                remotes.push(RemoteRefLabel { full_name: rr.full_name.clone(), remote: remote.clone(), host_kind: host(remote) });
                merged.insert(rr.full_name.as_str());
            }
        }
        labels.push(RefLabel {
            row,
            name: local.short_name.clone(),
            local: Some(local.full_name.clone()),
            remotes,
            tag: false,
            is_head: refs.head.branch.as_deref() == Some(local.full_name.as_str()),
            worktree: checked_out_elsewhere.get(local.full_name.as_str()).cloned(),
        });
    }
    // Remote-only refs: one label per (commit, branch name), so the same branch on several
    // remotes at the same commit is ONE chip with one icon per remote (§8.5).
    let mut remote_only: HashMap<(ObjectId, &str), usize> = HashMap::new();
    for rr in &refs.refs {
        let RefKind::Remote { remote } = &rr.kind else { continue };
        if merged.contains(rr.full_name.as_str()) {
            continue;
        }
        let Some(row) = row_of(&rr.target) else { continue };
        // Only the branch part (`p/janderson/foo`, not `origin/p/janderson/foo`): the remote
        // icons already mark it as remote, and `remotes[].full_name` keeps each full name for
        // the tooltip.
        let branch = &rr.short_name[remote.len() + 1..];
        let remote_label = RemoteRefLabel { full_name: rr.full_name.clone(), remote: remote.clone(), host_kind: host(remote) };
        match remote_only.get(&(rr.target, branch)) {
            Some(&i) => labels[i].remotes.push(remote_label),
            None => {
                remote_only.insert((rr.target, branch), labels.len());
                labels.push(RefLabel { row, name: branch.to_string(), local: None, remotes: vec![remote_label], tag: false, is_head: false, worktree: None });
            }
        }
    }
    for t in refs.refs.iter().filter(|r| r.kind == RefKind::Tag) {
        if let Some(row) = row_of(&t.target) {
            labels.push(RefLabel { row, name: t.short_name.clone(), local: None, remotes: vec![], tag: true, is_head: false, worktree: None });
        }
    }
    if refs.head.detached
        && let Some(row) = refs.head.target.as_ref().and_then(row_of)
    {
        labels.push(RefLabel { row, name: "HEAD".into(), local: None, remotes: vec![], tag: false, is_head: true, worktree: None });
    }
    let priority = |l: &RefLabel| if l.is_head { 0 } else if l.local.is_some() { 1 } else if !l.tag { 2 } else { 3 };
    labels.sort_by_key(|l| (l.row, priority(l)));
    labels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::NodeKind;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    async fn build(r: &TestRepo, opts: BuildOptions) -> GraphPayload {
        let repo = gix::ThreadSafeRepository::open(r.path()).unwrap();
        build_graph(repo, r.path().to_path_buf(), cli(), opts).await.unwrap()
    }

    #[tokio::test]
    async fn basic_fixture_rows_kinds_and_pinning() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;

        let kinds: Vec<NodeKind> = g.rows.iter().map(|x| x.kind).collect();
        use NodeKind::*;
        assert_eq!(kinds, vec![Stash, Wip, Commit, Wip, Merge, Commit, Commit, Commit, Commit, Commit]);
        let summaries: Vec<&str> = g.rows.iter().map(|x| x.summary.as_str()).collect();
        assert_eq!(summaries[0], "On main: Experiment");
        assert_eq!(summaries[2], "Hotfix: null check");
        assert_eq!(summaries[4], "Merge branch 'feature/login'");
        assert_eq!(g.pinned_ref.as_deref(), Some("refs/remotes/origin/main"));

        let lane = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap().lane;
        for s in ["Merge branch 'feature/login'", "Fix typo", "Add readme", "Initial commit"] {
            assert_eq!(lane(s), 0, "{s} is on the pinned trunk");
        }
        for s in ["Login form", "Login validation", "Hotfix: null check", "On main: Experiment"] {
            assert_ne!(lane(s), 0, "{s} is off-trunk");
        }
        assert_eq!(g.rows[3].lane, 0, "main's WIP row sits directly above the pinned tip");
        assert!(!g.truncated);
        assert!(g.head.branch.as_deref() == Some("refs/heads/main") && !g.head.unborn);
    }

    #[tokio::test]
    async fn wip_rows_carry_worktree_and_counts() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let hotfix = g.rows[1].wip.as_ref().unwrap();
        assert_eq!(hotfix.worktree_name.as_deref(), Some("wt-hotfix"));
        assert_eq!(hotfix.modified, 1);
        assert!(g.rows[1].id.starts_with("wip:"));
        assert_eq!(g.rows[1].parents, vec![g.rows[2].id.clone()]);
        let main = g.rows[3].wip.as_ref().unwrap();
        assert_eq!(main.worktree_name, None);
        assert_eq!(main.modified, 1);
        let out: Vec<_> = g.rows[1].segments.iter().map(|&s| crate::graph::Segment::unpack(s)).filter(|s| s.half == crate::graph::Half::Bottom).collect();
        assert!(!out.is_empty() && out.iter().all(|s| s.dashed), "WIP outgoing segments are dashed");
    }

    #[tokio::test]
    async fn labels_merge_local_and_remote() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let label = |name: &str| g.labels.iter().find(|l| l.name == name).unwrap_or_else(|| panic!("no label {name}"));

        let main = label("main");
        assert_eq!(main.row, 4);
        assert!(main.is_head);
        assert_eq!(main.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/origin/main"]);

        let login = label("feature/login");
        assert_eq!(g.rows[login.row as usize].summary, "Login validation");
        assert_eq!(login.remotes.len(), 1);

        let hotfix = label("hotfix");
        assert!(hotfix.remotes.is_empty());
        assert!(hotfix.worktree.as_deref().unwrap().ends_with("wt-hotfix"));

        let tag = label("v1.0");
        assert!(tag.tag);
        assert_eq!(g.rows[tag.row as usize].summary, "Add readme");

        assert!(!g.labels.iter().any(|l| l.name.starts_with("origin/")), "all remotes merged into local labels");
    }

    #[tokio::test]
    async fn unborn_repo_has_empty_graph() {
        let r = TestRepo::new();
        fixtures::unborn(&r);
        let g = build(&r, BuildOptions::default()).await;
        assert!(g.rows.is_empty());
        assert!(g.head.unborn);
        assert_eq!(g.pinned_ref, None);
    }

    #[tokio::test]
    async fn pinned_override_moves_trunk() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions { pinned_ref: Some("refs/heads/hotfix".into()), ..Default::default() }).await;
        let lane = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap().lane;
        assert_eq!(lane("Hotfix: null check"), 0);
        assert_eq!(lane("Merge branch 'feature/login'"), 0, "the hotfix chain includes the merge");
        assert_ne!(lane("On main: Experiment"), 0);
    }

    #[tokio::test]
    async fn missing_worktree_directory_is_skipped() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        std::fs::remove_dir_all(r.root().join("wt-hotfix")).unwrap();
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.rows.iter().filter(|x| x.kind == NodeKind::Wip).count(), 1);
    }

    #[tokio::test]
    async fn detached_head_gets_a_head_label() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["switch", "-q", "--detach", "HEAD~1"]);
        let g = build(&r, BuildOptions::default()).await;
        let head = g.labels.iter().find(|l| l.name == "HEAD").unwrap();
        assert!(head.is_head);
        assert_eq!(g.rows[head.row as usize].summary, "Fix typo");
    }

    #[tokio::test]
    async fn wide_fixture_holds_one_lane_per_branch() {
        let r = TestRepo::new();
        fixtures::wide(&r);
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.rows.len(), fixtures::WIDE_BRANCHES + 1);
        assert_eq!(usize::from(g.max_lanes), fixtures::WIDE_BRANCHES);
    }

    #[tokio::test]
    async fn limit_truncates() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions { limit: 3, ..Default::default() }).await;
        assert!(g.truncated);
        assert_eq!(g.rows.iter().filter(|x| x.kind != NodeKind::Wip).count(), 3);
    }

    #[tokio::test]
    async fn snapshot_basic_fixture() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        insta::assert_snapshot!(build(&r, BuildOptions::default()).await.ascii());
    }

    /// A second worktree, detached at main's HEAD (the pinned tip), with an uncommitted change.
    fn add_second_worktree_at_main_head(r: &TestRepo) -> std::path::PathBuf {
        let p = r.root().join("wt-second");
        r.git(&["worktree", "add", "-q", "--detach", p.to_str().unwrap(), "main"]);
        std::fs::write(p.join("file_2.txt"), "second worktree change\n").expect("write worktree file");
        p
    }

    #[tokio::test]
    async fn stacked_wip_rows_only_the_lowest_is_pinned() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        add_second_worktree_at_main_head(&r);

        let g = build(&r, BuildOptions::default()).await;
        let merge_idx = g.rows.iter().position(|x| x.summary == "Merge branch 'feature/login'").unwrap();
        assert!(merge_idx >= 2, "two WIP rows must stack above the merge");

        let upper = &g.rows[merge_idx - 2];
        let lower = &g.rows[merge_idx - 1];
        assert_eq!(upper.kind, NodeKind::Wip, "row directly above the lower WIP must also be a WIP");
        assert_eq!(lower.kind, NodeKind::Wip, "row directly above the merge must be a WIP");

        // One of the two stacked rows belongs to the new worktree, the other to the main one.
        let names = [upper.wip.as_ref().unwrap().worktree_name.as_deref(), lower.wip.as_ref().unwrap().worktree_name.as_deref()];
        assert!(names.contains(&Some("wt-second")));
        assert!(names.contains(&None));

        assert_eq!(lower.lane, 0, "the WIP directly above the pinned merge is pinned to lane 0");
        assert_ne!(upper.lane, 0, "the WIP one row further up is not directly above the pinned tip, so it isn't pinned");

        // The upper WIP's own dashed lane must pass through the lower WIP row as a continuous
        // (Full, dashed) segment: this is the ':' the ascii renderer draws.
        let passes_through = lower
            .segments
            .iter()
            .map(|&s| crate::graph::Segment::unpack(s))
            .any(|s| s.half == crate::graph::Half::Full && s.from_lane == upper.lane && s.dashed);
        assert!(passes_through, "the upper WIP's dashed lane must pass through the lower WIP row");
    }

    #[tokio::test]
    async fn snapshot_stacked_wip_rows() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        add_second_worktree_at_main_head(&r);
        insta::assert_snapshot!(build(&r, BuildOptions::default()).await.ascii());
    }

    #[tokio::test]
    async fn rows_carry_committer_time_distinct_from_author_time() {
        let r = TestRepo::new();
        r.commit("Initial commit");
        r.commit("Amended later");
        // TestRepo's clock advances 60 s per git call, and an amend keeps the original author
        // date while stamping a fresh committer date: the two must now differ, and the row must
        // carry both.
        r.git(&["commit", "-q", "--amend", "--no-edit"]);
        let author = r.git(&["log", "-1", "--format=%at"]).parse::<i64>().unwrap();
        let committer = r.git(&["log", "-1", "--format=%ct"]).parse::<i64>().unwrap();
        assert!(committer > author, "precondition: amend must leave committer date after author date");

        let g = build(&r, BuildOptions::default()).await;
        let row = g.rows.iter().find(|x| x.summary == "Amended later").unwrap();
        assert_eq!(row.author_time, author);
        assert_eq!(row.committer_time, committer);
        assert_ne!(row.committer_time, row.author_time);
    }

    #[tokio::test]
    async fn wip_rows_have_zero_committer_time() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let wips: Vec<_> = g.rows.iter().filter(|x| x.kind == NodeKind::Wip).collect();
        assert!(!wips.is_empty());
        assert!(wips.iter().all(|w| w.committer_time == 0 && w.author_time == 0));
    }

    #[tokio::test]
    async fn remote_only_labels_drop_the_remote_name_and_merge_across_remotes() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let fix_typo = r.git(&["rev-parse", "main~1"]);
        // A remote-only branch on origin, and the same branch name on a second remote at the
        // same commit: they merge into ONE label (one icon per remote), showing only the branch
        // part.
        r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/origin/p/janderson/foo", &fix_typo]);
        r.git(&["update-ref", "refs/remotes/upstream/p/janderson/foo", &fix_typo]);
        // The same name on a remote at a DIFFERENT commit stays its own label.
        let readme = r.git(&["rev-parse", "v1.0^{commit}"]);
        r.git(&["update-ref", "refs/remotes/upstream/elsewhere", &readme]);
        r.git(&["update-ref", "refs/remotes/origin/elsewhere", &fix_typo]);
        let g = build(&r, BuildOptions::default()).await;

        let foo: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "p/janderson/foo").collect();
        assert_eq!(foo.len(), 1, "one label for the branch name on both remotes: {:?}", g.labels);
        let foo = foo[0];
        let full: Vec<&str> = foo.remotes.iter().map(|x| x.full_name.as_str()).collect();
        assert_eq!(full, vec!["refs/remotes/origin/p/janderson/foo", "refs/remotes/upstream/p/janderson/foo"]);
        assert_eq!(foo.remotes.iter().map(|x| x.remote.as_str()).collect::<Vec<_>>(), vec!["origin", "upstream"]);
        assert!(foo.local.is_none() && !foo.tag && !foo.is_head);
        assert_eq!(g.rows[foo.row as usize].summary, "Fix typo");

        let elsewhere: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "elsewhere").collect();
        assert_eq!(elsewhere.len(), 2, "different commits keep separate labels");
        assert!(elsewhere.iter().all(|l| l.remotes.len() == 1));
        assert!(!g.labels.iter().any(|l| l.name.starts_with("origin/") || l.name.starts_with("upstream/")));
    }

    #[tokio::test]
    async fn local_label_merges_every_same_named_remote_at_its_commit() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let main = r.git(&["rev-parse", "main"]);
        r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/upstream/main", &main]);
        let g = build(&r, BuildOptions::default()).await;
        let mains: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "main").collect();
        assert_eq!(mains.len(), 1, "{:?}", g.labels);
        let m = mains[0];
        assert_eq!(m.local.as_deref(), Some("refs/heads/main"));
        assert!(m.is_head, "HEAD stays on the local label");
        assert_eq!(m.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/origin/main", "refs/remotes/upstream/main"]);
        assert!(g.labels.iter().any(|l| l.tag && l.name == "v1.0"), "tags stay separate labels");
    }

    #[tokio::test]
    async fn local_label_takes_only_the_remotes_at_its_commit() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        // main == origin/main at the merge; upstream/main lags one commit behind, at "Fix typo".
        let fix_typo = r.git(&["rev-parse", "main~1"]);
        r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/upstream/main", &fix_typo]);
        let g = build(&r, BuildOptions::default()).await;
        let mains: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "main").collect();
        assert_eq!(mains.len(), 2, "{:?}", g.labels);
        let local = mains.iter().find(|l| l.local.is_some()).unwrap();
        assert_eq!(local.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/origin/main"]);
        assert_eq!(g.rows[local.row as usize].summary, "Merge branch 'feature/login'");
        let lagging = mains.iter().find(|l| l.local.is_none()).unwrap();
        assert_eq!(lagging.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/upstream/main"]);
        assert_eq!(g.rows[lagging.row as usize].summary, "Fix typo");
    }

    #[tokio::test]
    async fn rows_carry_message_refs_and_wip_rows_have_none() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let g = build(&r, BuildOptions::default()).await;
        let row = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap_or_else(|| panic!("no row {s}"));
        // The refs sit in the body (DETAILS_MESSAGE); the URL in it contributes nothing.
        assert_eq!(row("Rename guide and update assets").mr_refs, vec!["!42", "group/sub/project!7", "#12"]);
        assert!(row("Initial commit").mr_refs.is_empty());
        let wips: Vec<_> = g.rows.iter().filter(|x| x.kind == NodeKind::Wip).collect();
        assert!(!wips.is_empty(), "the details fixture has a dirty worktree");
        assert!(wips.iter().all(|w| w.mr_refs.is_empty()));
    }

    #[tokio::test]
    async fn message_refs_come_from_the_summary_too() {
        let r = TestRepo::new();
        r.commit("Fix login (#7)\n\nSee !8 and #7");
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.rows[0].mr_refs, vec!["#7", "!8"]);
    }

    #[tokio::test]
    async fn message_refs_include_lines_after_the_summary_without_a_blank_line() {
        // No blank line: the ref lines are neither `summary` nor `body`, but the details panel
        // (`read_commit_message`) shows them, so the menu's refs must include them too.
        let r = TestRepo::new();
        r.commit("Fix login\nCloses #12");
        r.commit("Fix\nSee merge request group/project!1187");
        let g = build(&r, BuildOptions::default()).await;
        let row = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap_or_else(|| panic!("no row {s}"));
        assert_eq!(row("Fix login").mr_refs, vec!["#12"]);
        assert_eq!(row("Fix").mr_refs, vec!["group/project!1187"]);
    }

    #[tokio::test]
    async fn nonexistent_pinned_ref_override_reports_no_trunk() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions { pinned_ref: Some("refs/heads/does-not-exist".into()), ..Default::default() }).await;
        assert_eq!(g.pinned_ref, None);
        assert!(!g.rows.is_empty());
    }

    /// Real layouts for the UI's branch-membership tests (`ui/src/graph/membership.test.ts`,
    /// feedback F7). Each case builds a repo and runs the actual `build_graph`, so `default_trunk`
    /// pinning and `layout.rs` lane assignment are the real ones, then reduces the payload to rows
    /// keyed by commit summary, plus the labels. Pinned in `testdata/graph-membership.json`;
    /// regenerate with `GITBOLT_UPDATE_TESTDATA=1 cargo test -p gitbolt-core membership_vectors`.
    #[tokio::test]
    async fn membership_vectors() {
        #[derive(serde::Serialize)]
        struct Row {
            id: String,
            kind: NodeKind,
            lane: u16,
            color: u8,
            parents: Vec<String>,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: &'static str,
            rows: Vec<Row>,
            labels: Vec<RefLabel>,
            pinned_ref: Option<String>,
        }
        fn with_origin(r: &TestRepo) {
            r.commit("base");
            r.add_origin();
        }
        fn publish_main(r: &TestRepo) {
            r.push("main");
            r.git(&["remote", "set-head", "origin", "main"]);
        }
        type Build = fn(&TestRepo);
        let cases: [(&'static str, Build); 11] = [
            ("main behind origin/main, feature off origin/main", |r| {
                with_origin(r);
                r.commit("M");
                r.commit("O1");
                r.commit("O2");
                publish_main(r);
                r.git(&["reset", "-q", "--hard", "HEAD~2"]);
                r.git(&["switch", "-q", "-c", "feature", "origin/main"]);
                r.commit("F");
                r.switch("main");
            }),
            ("stale fast-forwarded branch left on the trunk", |r| {
                with_origin(r);
                r.git(&["branch", "old"]);
                r.commit("O");
                publish_main(r);
            }),
            ("hotfix from origin/main committed after main's unpushed M1", |r| {
                // H (newest) takes lane 1, so M1 opens lane 2: the lane order says nothing here.
                with_origin(r);
                r.commit("O");
                publish_main(r);
                r.commit("M1");
                r.git(&["switch", "-q", "-c", "hotfix", "origin/main"]);
                r.commit("H");
                r.switch("main");
            }),
            ("upstream/main one commit ahead (fork workflow)", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
                r.switch_new("tmp");
                r.commit("U");
                r.git(&["update-ref", "refs/remotes/upstream/main", "tmp"]);
                r.switch("main");
                r.git(&["branch", "-q", "-D", "tmp"]);
            }),
            ("unpinned repo (no remote): hotfix off main's tip, main checked out", |r| {
                r.commit("base");
                r.commit("M");
                r.switch_new("hotfix");
                r.commit("H");
                r.switch("main");
            }),
            ("feature/main off pinned main's tip", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.switch_new("feature/main");
                r.commit("FM");
                r.push("feature/main");
                r.switch("main");
            }),
            ("feature tip on its own lane after main merged its pushed part", |r| {
                // feat@F3 is committed before main merges origin/feat (F2): M's second-parent
                // line takes lane 1 first, so F2 lands there and F3 opens lane 2.
                with_origin(r);
                r.switch_new("feat");
                r.commit("F1");
                r.commit("F2");
                r.push("feat");
                r.commit("F3");
                r.switch("main");
                r.merge("origin/feat", "M");
                publish_main(r);
            }),
            ("main ahead of pinned origin/main", |r| {
                with_origin(r);
                r.commit("O");
                publish_main(r);
                r.commit("M1");
            }),
            ("feature tip merged back, then continued", |r| {
                with_origin(r);
                r.switch_new("feat");
                r.commit("F1");
                r.commit("F2");
                r.push("feat");
                r.switch("main");
                r.commit("A");
                r.merge("feat", "M");
                publish_main(r);
                r.switch("feat");
                r.commit("F3");
                r.switch("main");
            }),
            ("hotfix off pinned main's tip", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.switch_new("hotfix");
                r.commit("H");
                r.switch("main");
            }),
            ("remote-only branch off pinned main's tip", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.switch_new("topic");
                r.commit("T");
                r.push("topic");
                r.switch("main");
                r.git(&["branch", "-q", "-D", "topic"]);
            }),
        ];
        let mut out = Vec::new();
        for (name, make) in cases {
            let r = TestRepo::new();
            make(&r);
            let g = build(&r, BuildOptions::default()).await;
            let unpinned = name.starts_with("unpinned");
            assert_eq!(g.pinned_ref.as_deref(), if unpinned { None } else { Some("refs/remotes/origin/main") }, "{name}: trunk pinning");
            let summary: HashMap<&str, &str> = g.rows.iter().map(|row| (row.id.as_str(), row.summary.as_str())).collect();
            let rows = g
                .rows
                .iter()
                .map(|row| Row {
                    id: row.summary.clone(),
                    kind: row.kind,
                    lane: row.lane,
                    color: row.color,
                    parents: row.parents.iter().map(|p| summary.get(p.as_str()).expect("parent in window").to_string()).collect(),
                })
                .collect();
            out.push(Case { name, rows, labels: g.labels.clone(), pinned_ref: g.pinned_ref.clone() });
        }
        let json = serde_json::to_string_pretty(&serde_json::json!({
            "_comment": "Generated by gitbolt-core snapshot::tests::membership_vectors (real build_graph layouts). Regenerate: GITBOLT_UPDATE_TESTDATA=1 cargo test -p gitbolt-core membership_vectors",
            "cases": out,
        }))
        .unwrap()
            + "\n";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/graph-membership.json");
        if std::env::var_os("GITBOLT_UPDATE_TESTDATA").is_some() {
            std::fs::write(&path, &json).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), json, "testdata/graph-membership.json is stale: regenerate it (see this test's doc comment)");
    }
}
