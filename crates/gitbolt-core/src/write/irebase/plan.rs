//! The range an interactive rebase replays (spec #3 §3.3, Ruling 6): its rows, newest first
//! (merges flattened away), its chips, and the tips the plan expects. A read: gix, `git log` and
//! `git worktree list`.

use crate::api::{blocking, Api};
use crate::error::{gix_err, short_ref, GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use crate::write::integrate::{branch_sets, local_branches};
use crate::write::is_ancestor;
use gix::bstr::ByteSlice;
use gix::ObjectId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use ts_rs::TS;

/// Ruling 11: the editor's ceiling.
pub const MAX_ROWS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanRow {
    pub oid: String,
    pub summary: String,
    /// The whole message (`%B`).
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    #[ts(type = "number")]
    pub author_time: i64,
    /// Already in the base under another id (`rev-list --cherry-mark`'s `=`): git's own todo
    /// would leave it out. 3D's Rebase stack drops these rows; the editor shows them as is.
    pub upstream: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanChip {
    /// Short name (`feature/a`).
    pub branch: String,
    /// The row it sits on (an oid of `rows`).
    pub at: String,
    /// Why it can't move ("checked out in /x", "merged in: it stays where it is"); `None`: free.
    pub locked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RebasePlanPayload {
    pub branch: String,
    /// As asked (`main`, `origin/main`, an oid).
    pub base: String,
    pub base_oid: String,
    pub base_summary: String,
    /// Local branches at the base: the bottom row's chips.
    pub base_chips: Vec<String>,
    /// Newest first.
    pub rows: Vec<PlanRow>,
    /// Merge commits in range: flattened (the header's warning).
    pub merges: u32,
    /// Commits of the base the branch doesn't have (`branch..base`); 0: it already sits on it.
    pub behind: u32,
    pub chips: Vec<PlanChip>,
    /// Every local branch: a new chip's name must be new.
    pub branches: Vec<String>,
    /// Full ref → oid: the branch, every chip's branch, and the base's ref when it names one.
    pub expect: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RangeRow {
    pub oid: String,
    pub message: String,
    pub summary: String,
    /// `%ae %at %s`: the reword script's check (Ruling 3).
    pub guard: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub upstream: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct Range {
    pub head: ObjectId,
    pub base: ObjectId,
    /// The base's full ref name, when `base` names a ref.
    pub base_ref: Option<String>,
    /// `base_ref`'s own value, unpeeled (an annotated tag: the tag object, not `base`): the
    /// value the write's ref check compares against.
    pub base_ref_target: Option<ObjectId>,
    pub base_summary: String,
    pub rows: Vec<RangeRow>,
    pub merges: u32,
    pub behind: u32,
    pub chips: Vec<PlanChip>,
    pub base_chips: Vec<String>,
    pub tips: BTreeMap<String, String>,
    pub locked: BTreeMap<String, String>,
}

const FORMAT: &str = "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%ae %at %s%x1f%B%x1e";

fn parse_rows(stdout: &[u8]) -> Vec<RangeRow> {
    String::from_utf8_lossy(stdout)
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(6, '\x1f').collect();
            let [oid, name, email, time, guard, message] = f[..] else { return None };
            Some(RangeRow {
                oid: oid.to_string(),
                summary: message.lines().next().unwrap_or("").to_string(),
                message: message.to_string(),
                guard: guard.to_string(),
                author_name: name.to_string(),
                author_email: email.to_string(),
                author_time: time.parse().unwrap_or(0),
                upstream: false,
            })
        })
        .collect()
}

pub(crate) async fn read_range(cli: &GitCli, root: &Path, branch: &str, base: &str, max: usize) -> Result<Range, GbError> {
    let (r, b, s) = (root.to_path_buf(), branch.to_string(), base.to_string());
    // gix first: the tips, the base and the branch sets (no git process).
    let (head, base_oid, base_ref, base_ref_target, base_summary, sets, tips) = blocking(move || {
        let repo = gix::open(&r).map_err(gix_err)?;
        let head = repo
            .find_reference(format!("refs/heads/{b}").as_str())
            .map_err(|_| GbError::new(GbErrorKind::NotFound, format!("No branch {b}")))?
            .peel_to_id()
            .map_err(gix_err)?
            .detach();
        let commit = repo
            .rev_parse_single(format!("{s}^{{commit}}").as_str())
            .map_err(|e| GbError::new(GbErrorKind::NotFound, format!("{s}: {e}")))?
            .object()
            .map_err(gix_err)?
            .into_commit();
        let base_summary = commit.message_raw_sloppy().lines().next().map(|l| l.to_str_lossy().to_string()).unwrap_or_default();
        let base = commit.id;
        // The ref's own value, unpeeled (an annotated tag: the tag object): what the write's ref
        // check reads (3B T3), so the CAS compares like with like.
        let (base_ref, base_ref_target) = match repo.find_reference(s.as_str()) {
            Ok(mut r) => {
                let name = r.name().as_bstr().to_string();
                let id = r.follow_to_object().map_err(gix_err)?.detach();
                (Some(name), Some(id))
            }
            Err(_) => (None, None),
        };
        let sets = branch_sets(&repo, &b, base)?;
        let mut tips = BTreeMap::new();
        for full in local_branches(&repo)? {
            if let Ok(mut rf) = repo.find_reference(full.as_str())
                && let Ok(id) = rf.peel_to_id()
            {
                tips.insert(short_ref(&full).to_string(), id.to_string());
            }
        }
        Ok((head, base, base_ref, base_ref_target, base_summary, sets, tips))
    })
    .await?;
    // git: the rows (one log, capped one past the limit), the merge count, the worktrees.
    let span = format!("{base_oid}..{head}");
    let cap = format!("--max-count={}", max + 1);
    let out = cli.run(GitInvocation::new(root, ["log", "--topo-order", "--no-merges", "--no-show-signature", cap.as_str(), FORMAT, span.as_str(), "--"])).await?;
    let mut rows = parse_rows(&out.stdout);
    if rows.len() > max {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("Over {max} commits between {base} and {branch}: the editor takes up to {max}")));
    }
    let merges = cli.run(GitInvocation::new(root, ["rev-list", "--count", "--min-parents=2", span.as_str(), "--"])).await?;
    let merges: u32 = String::from_utf8_lossy(&merges.stdout).trim().parse().unwrap_or(0);
    // Rows already in the base under another id: `=` in git's own `--cherry-mark` (the patch-ids
    // `git rebase` computes for its default todo).
    let sym = format!("{base_oid}...{head}");
    let marks = cli.run(GitInvocation::new(root, ["rev-list", "--cherry-mark", "--right-only", "--no-merges", sym.as_str(), "--"])).await?;
    let upstream: HashSet<String> = String::from_utf8_lossy(&marks.stdout).lines().filter_map(|l| l.strip_prefix('=')).map(|o| o.trim().to_string()).collect();
    for row in &mut rows {
        row.upstream = upstream.contains(&row.oid);
    }
    let lag = format!("{head}..{base_oid}");
    let behind = cli.run(GitInvocation::new(root, ["rev-list", "--count", lag.as_str(), "--"])).await?;
    let behind: u32 = String::from_utf8_lossy(&behind.stdout).trim().parse().unwrap_or(0);
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let elsewhere: BTreeMap<String, String> = crate::worktree::list_worktrees(root)
        .await?
        .into_iter()
        .filter(|w| w.path.canonicalize().unwrap_or_else(|_| w.path.clone()) != canon)
        .filter_map(|w| Some((short_ref(&w.branch?).to_string(), w.path.display().to_string())))
        .collect();
    // Chips: each branch with a tip in range sits on its row, or (a merge commit) on the newest
    // row that's an ancestor of it (Ruling 6).
    let (r, row_oids) = (root.to_path_buf(), rows.iter().map(|x| x.oid.clone()).collect::<Vec<_>>());
    let in_range: Vec<(String, ObjectId, bool)> = sets.stacked.iter().map(|(n, o)| (n.clone(), *o, false)).chain(sets.merged_in.iter().map(|(n, o)| (n.clone(), *o, true))).collect();
    let placed = blocking(move || {
        let repo = gix::open(&r).map_err(gix_err)?;
        let ids: Vec<ObjectId> = row_oids.iter().filter_map(|o| ObjectId::from_hex(o.as_bytes()).ok()).collect();
        Ok(in_range
            .into_iter()
            .filter_map(|(full, tip, merged)| {
                let at = ids.iter().find(|&&row| is_ancestor(&repo, row, tip))?;
                Some((short_ref(&full).to_string(), at.to_string(), merged))
            })
            .collect::<Vec<_>>())
    })
    .await?;
    let mut locked = BTreeMap::new();
    let chips = placed
        .into_iter()
        .filter(|(b, _, _)| b != branch)
        .map(|(b, at, merged)| {
            let why = elsewhere.get(&b).map(|p| format!("checked out in {p}")).or_else(|| merged.then(|| "merged in: it stays where it is".to_string()));
            if let Some(w) = &why {
                locked.insert(b.clone(), w.clone());
            }
            PlanChip { branch: b, at, locked: why }
        })
        .collect();
    let base_hex = base_oid.to_string();
    let base_chips = tips.iter().filter(|(_, o)| **o == base_hex).map(|(b, _)| b.clone()).collect();
    Ok(Range { head, base: base_oid, base_ref, base_ref_target, base_summary, rows, merges, behind, chips, base_chips, tips, locked })
}

pub(crate) async fn rebase_plan(api: &Api, repo: u32, worktree: &str, branch: &str, base: &str) -> Result<RebasePlanPayload, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let range = read_range(&api.cli, &root, branch, base, MAX_ROWS).await?;
    let mut expect = BTreeMap::new();
    expect.insert(format!("refs/heads/{branch}"), range.head.to_string());
    for c in &range.chips {
        expect.insert(format!("refs/heads/{}", c.branch), range.tips[&c.branch].clone());
    }
    if let (Some(r), Some(at)) = (&range.base_ref, range.base_ref_target) {
        expect.insert(r.clone(), at.to_string());
    }
    Ok(RebasePlanPayload {
        branch: branch.to_string(),
        base: base.to_string(),
        base_oid: range.base.to_string(),
        base_summary: range.base_summary,
        base_chips: range.base_chips,
        rows: range.rows.into_iter().map(|r| PlanRow { oid: r.oid, summary: r.summary, message: r.message, author_name: r.author_name, author_email: r.author_email, author_time: r.author_time, upstream: r.upstream }).collect(),
        merges: range.merges,
        behind: range.behind,
        chips: range.chips,
        branches: range.tips.keys().cloned().collect(),
        expect,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use crate::write::test_support::{api, call, open, wt};
    use serde_json::json;

    fn cli() -> GitCli {
        GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(50))).with_env(isolated_git_env())
    }

    fn subjects(p: &RebasePlanPayload) -> Vec<String> {
        p.rows.iter().map(|r| r.summary.split(' ').next().unwrap().to_string()).collect()
    }

    #[tokio::test]
    async fn the_plan_lists_the_flattened_rows_newest_first_with_the_stack_chips() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let v = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main" })).await.unwrap();
        let p: RebasePlanPayload = serde_json::from_value(v).unwrap();
        let s = subjects(&p);
        assert_eq!(s.len(), 8, "{s:?}");
        assert_eq!(&s[..3], ["C2", "C1", "B2"]);
        assert_eq!(&s[5..], ["A3", "A2", "A1"]);
        assert!(!s.contains(&"Merge".to_string()), "merges are flattened away");
        assert_eq!(p.merges, 1);
        assert_eq!(p.behind, 1, "Main moves");
        assert!(p.rows.iter().all(|x| !x.upstream));
        assert_eq!(p.base_oid, r.git(&["rev-parse", "main"]));
        assert_eq!(p.base_summary, "Main moves");
        assert_eq!(p.base_chips, ["main"]);
        let at = |b: &str| p.chips.iter().find(|c| c.branch == b).unwrap_or_else(|| panic!("{b}")).clone();
        assert_eq!(at("feature/a").at, r.git(&["rev-parse", "feature/a"]));
        assert_eq!(at("feature/b").at, r.git(&["rev-parse", "feature/b"]));
        assert!(at("feature/a").locked.is_none());
        assert!(p.chips.iter().all(|c| c.branch != "feature/c"), "the rebased branch isn't a chip");
        for b in ["feature/a", "feature/b", "feature/c", "main"] {
            assert_eq!(p.expect[&format!("refs/heads/{b}")], r.git(&["rev-parse", b]), "{b}");
        }
        assert_eq!(p.rows[0].message, "C2 Polish\n");
        assert!(p.branches.contains(&"main".to_string()));
    }

    /// A branch whose tip is a merge commit sits on the newest row that's an ancestor of it.
    #[tokio::test]
    async fn a_chip_on_a_merge_sits_on_the_newest_row_below_it() {
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.git(&["branch", "on-merge", "feature/b~1"]); // "Merge side"
        let range = read_range(&cli(), r.path(), "feature/c", "main", MAX_ROWS).await.unwrap();
        let chip = range.chips.iter().find(|c| c.branch == "on-merge").unwrap();
        let row = range.rows.iter().position(|x| x.oid == chip.at).unwrap();
        let below = |x: &RangeRow| x.summary.starts_with("S1") || x.summary.starts_with("B1");
        assert!(below(&range.rows[row]), "{}", range.rows[row].summary);
        assert!(!range.rows[..row].iter().any(below), "the newest of them");
    }

    /// A commit already in the base under another id (picked into main) stays a row, marked
    /// `upstream`: git's own todo would leave it out, and 3D's Rebase stack drops it.
    #[tokio::test]
    async fn a_row_already_in_the_base_is_marked_upstream() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let a1 = r.git(&["rev-parse", "feature/a~2"]);
        r.switch("main");
        r.git(&["cherry-pick", a1.as_str()]);
        r.switch("feature/c");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let v = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main" })).await.unwrap();
        let p: RebasePlanPayload = serde_json::from_value(v).unwrap();
        assert_eq!(p.rows.len(), 8, "still a row");
        let marked: Vec<&str> = p.rows.iter().filter(|x| x.upstream).map(|x| x.summary.as_str()).collect();
        assert_eq!(marked, ["A1 Add parser"]);
        assert_eq!(p.behind, 2, "Main moves, and the picked A1");
    }

    /// An annotated tag as the base: the rows run from the commit it peels to, but `expect` holds
    /// the tag ref's own value (the tag object), which is what the write's ref check reads.
    #[tokio::test]
    async fn an_annotated_tag_base_expects_the_tag_object() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.git(&["tag", "-a", "v1.0", "-m", "Release 1.0", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let v = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "v1.0" })).await.unwrap();
        let p: RebasePlanPayload = serde_json::from_value(v).unwrap();
        let (tag, commit) = (r.git(&["rev-parse", "v1.0"]), r.git(&["rev-parse", "main"]));
        assert_ne!(tag, commit, "an annotated tag");
        assert_eq!(p.base_oid, commit);
        assert_eq!(p.rows.len(), 8);
        assert_eq!(p.base_chips, ["main"]);
        assert_eq!(p.expect["refs/tags/v1.0"], tag, "the unpeeled value");
    }

    #[tokio::test]
    async fn a_branch_checked_out_elsewhere_is_a_locked_chip() {
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.add_worktree("wt-a", "feature/a");
        let range = read_range(&cli(), r.path(), "feature/c", "main", MAX_ROWS).await.unwrap();
        let why = range.locked.get("feature/a").expect("locked");
        assert!(why.starts_with("checked out in "), "{why}");
        assert_eq!(range.chips.iter().find(|c| c.branch == "feature/a").unwrap().locked.as_deref(), Some(why.as_str()));
    }

    #[tokio::test]
    async fn over_the_limit_the_plan_is_refused() {
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let e = read_range(&cli(), r.path(), "feature/c", "main", 5).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
        assert!(e.message.contains("the editor takes up to 5"), "{}", e.message);
    }
}
