//! Rewording an older commit in place (spec #3 §3.6): the details panel's "Edit message" on a
//! commit of the current branch below HEAD. It runs a background interactive rebase from that
//! commit's parent: every row stays Pick except that one, and `update-ref` lines move the
//! stacked branches above it. A range with merges is refused: this path must never surprise.

use super::plan::Range;
use super::run::{IrebaseIntent, Source};
use super::types::{ChipAt, ChipPlan, RebaseRow, RebaseRowAction};
use crate::api::{blocking, Api};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::write::integrate::{head_branch, IntegrateOutcome};
use crate::write::run_write;
use crate::write::types::{Confirm, Expect, WriteResult};
use std::sync::OnceLock;

fn invalid(m: impl Into<String>) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, m)
}

/// The rows and chips of a reword of `oid` in `branch`'s range: every row Pick but that one, and
/// every chip on its own row.
pub(crate) fn rows_for(range: &Range, branch: &str, oid: &str, message: &str) -> Result<(Vec<RebaseRow>, Vec<ChipPlan>), GbError> {
    if !range.rows.iter().any(|r| r.oid == oid) {
        return Err(invalid(format!("That commit isn't in {branch}'s history any more")));
    }
    if range.merges > 0 {
        let n = range.merges;
        return Err(invalid(format!("This would flatten {n} merge commit{}: use the interactive rebase editor", if n == 1 { "" } else { "s" })));
    }
    if let Some(c) = range.chips.iter().find(|c| c.locked.is_some()) {
        return Err(invalid(format!("{} can't move with the reword: {}", c.branch, c.locked.as_deref().unwrap_or_default())));
    }
    let rows = range
        .rows
        .iter()
        .map(|r| {
            let it = r.oid == oid;
            RebaseRow { oid: r.oid.clone(), action: if it { RebaseRowAction::Reword } else { RebaseRowAction::Pick }, message: it.then(|| message.to_string()) }
        })
        .collect();
    let chips = range.chips.iter().map(|c| ChipPlan { branch: c.branch.clone(), at: ChipAt::Row(c.at.clone()) }).collect();
    Ok((rows, chips))
}

/// The trunk (short name, tip): `origin/HEAD`'s target when it's set, otherwise a local or
/// remote `main` or `master`. `None`: there's none to check against.
/// Also its local name (`origin/main` → `main`), HEAD's branch when HEAD is the trunk.
fn trunk(repo: &gix::Repository) -> Option<(String, String, gix::ObjectId)> {
    let named = |full: &str| -> Option<(String, String, gix::ObjectId)> {
        let mut r = repo.try_find_reference(full).ok().flatten()?;
        let id = r.peel_to_id().ok()?.detach();
        let local = full.strip_prefix("refs/heads/").or_else(|| full.strip_prefix("refs/remotes/").and_then(|x| x.split_once('/')).map(|(_, b)| b)).unwrap_or(full);
        Some((crate::error::short_ref(full).to_string(), local.to_string(), id))
    };
    let origin_head = repo.try_find_reference("refs/remotes/origin/HEAD").ok().flatten().and_then(|r| r.target().try_name().map(|n| n.as_bstr().to_string()));
    origin_head.and_then(|t| named(&t)).or_else(|| ["refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"].iter().find_map(|n| named(n)))
}

pub(crate) async fn reword_commit(api: &Api, repo: u32, worktree: &str, oid: String, message: String, expect: Expect, confirm: Confirm) -> Result<WriteResult<IntegrateOutcome>, GbError> {
    let summary = message.lines().next().unwrap_or("").trim().to_string();
    if summary.is_empty() {
        return Err(invalid("Write a commit summary"));
    }
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    // For the label and the range only: `plan` checks it's still HEAD's branch, under the lock.
    // R2: a root commit has no parent to rebase from.
    let at = oid.clone();
    let (branch, root_commit, on_trunk) = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let commit = gix::ObjectId::from_hex(at.as_bytes()).ok().and_then(|o| repo.find_commit(o).ok());
        let root_commit = commit.as_ref().is_some_and(|c| c.parent_ids().next().is_none());
        let branch = head_branch(&repo);
        // Fix round 2 (T13 review): a commit the trunk has too, reworded from another branch,
        // would be copied into it as divergent history.
        let on_trunk = match (commit, trunk(&repo)) {
            (Some(c), Some((name, local, tip))) if branch.as_deref() != Some(local.as_str()) => {
                let head = repo.head_id().ok().map(|h| h.detach());
                (head.is_some_and(|h| crate::write::is_ancestor(&repo, c.id, h)) && crate::write::is_ancestor(&repo, c.id, tip)).then_some(name)
            }
            _ => None,
        };
        Ok((branch, root_commit, on_trunk))
    })
    .await?;
    if root_commit {
        return Err(invalid("The first commit can't be reworded here. Use Interactive rebase."));
    }
    let branch = branch.ok_or_else(|| invalid("Check out a branch to reword its commits"))?;
    if let Some(t) = on_trunk {
        return Err(invalid(format!("That commit is on {t} too. Rewording it here would copy {t}'s history into this branch.")));
    }
    let label = format!("reword \"{summary}\"");
    run_write(api, repo, worktree, expect, IrebaseIntent { branch, base: format!("{oid}^"), source: Source::Reword { oid, message }, confirm, label, planned: OnceLock::new() }).await
}

#[cfg(test)]
mod tests {
    use crate::testing::{fixtures, TestRepo};
    use crate::write::test_support::{api, call, journal_step, open, wt};
    use serde_json::json;

    async fn reword(api: &crate::api::Api, id: u32, r: &TestRepo, rev: &str, message: &str) -> Result<serde_json::Value, crate::error::GbError> {
        let oid = r.git(&["rev-parse", rev]);
        call(api, "rewordCommit", json!({ "repo": id, "worktree": wt(r.path()), "oid": oid, "message": message, "expect": { "head": r.git(&["rev-parse", "HEAD"]), "refs": {} } })).await
    }

    fn stack_tips(r: &TestRepo) -> Vec<String> {
        ["feature/a", "feature/b", "feature/c", "main"].iter().map(|b| r.git(&["rev-parse", b])).collect()
    }

    /// §3.6: feature/a's commit, two branches below HEAD (feature/c), reworded; the stack above it
    /// moves along; main stays; one Undo.
    #[tokio::test]
    async fn rewording_a_stacked_commit_moves_the_branches_above_it() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let before = stack_tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = reword(&api, id, &r, "feature/a", "Work on A, reworded\n\nWhy.").await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(res["journal"]["undo"]["label"], "reword \"Work on A, reworded\"");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/a"]), "Work on A, reworded\n\nWhy.");
        assert_eq!(res["outcome"]["rewritten"], r.git(&["rev-parse", "feature/a"]).as_str(), "3C final fix M4: the reworded commit's new oid");
        assert!(r.try_git(&["merge-base", "--is-ancestor", "feature/a", "feature/b"]).is_ok());
        assert!(r.try_git(&["merge-base", "--is-ancestor", "feature/b", "feature/c"]).is_ok());
        assert_eq!(r.git(&["rev-parse", "main"]), before[3]);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(stack_tips(&r), before);
    }

    #[tokio::test]
    async fn a_range_with_a_merge_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = reword(&api, id, &r, "feature/a~2", "A1, reworded").await.unwrap_err();
        assert_eq!(e.message, "This would flatten 1 merge commit: use the interactive rebase editor");
    }

    #[tokio::test]
    async fn a_stacked_branch_checked_out_elsewhere_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.add_worktree("wt-b", "feature/b");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = reword(&api, id, &r, "feature/a", "x").await.unwrap_err();
        assert!(e.message.starts_with("feature/b can't move with the reword: checked out in"), "{}", e.message);
    }

    /// main: Root, Trunk work, Trunk more; feature/x forks at Trunk work: X1, X2 (HEAD).
    fn forked() -> TestRepo {
        let r = TestRepo::new();
        r.commit("Root");
        r.commit("Trunk work");
        r.switch_new("feature/x");
        r.commit("X1");
        r.commit("X2");
        r.switch("main");
        r.commit("Trunk more");
        r.switch("feature/x");
        r
    }

    /// Fix round 2 (T13 review): a trunk commit below the fork point is refused from a branch;
    /// the branch's own commit is reworded.
    #[tokio::test]
    async fn a_trunk_commit_below_the_fork_is_refused_and_the_branchs_own_is_allowed() {
        let data = tempfile::tempdir().unwrap();
        let r = forked();
        let before = r.git(&["rev-parse", "feature/x"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = reword(&api, id, &r, "feature/x~2", "Trunk work, reworded").await.unwrap_err();
        assert_eq!(e.message, "That commit is on main too. Rewording it here would copy main's history into this branch.");
        assert_eq!(r.git(&["rev-parse", "feature/x"]), before);
        let res = reword(&api, id, &r, "feature/x~1", "X1, reworded").await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/x~1"]), "X1, reworded");
    }

    /// Fix round 2: with HEAD on the trunk itself, its own commits reword in place; origin/HEAD
    /// names the trunk when it's set.
    #[tokio::test]
    async fn on_the_trunk_itself_its_commits_reword() {
        let data = tempfile::tempdir().unwrap();
        let r = forked();
        r.add_origin();
        r.push("main");
        r.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = reword(&api, id, &r, "feature/x~2", "x").await.unwrap_err();
        assert_eq!(e.message, "That commit is on origin/main too. Rewording it here would copy origin/main's history into this branch.");
        r.switch("main");
        let res = reword(&api, id, &r, "main~1", "Trunk work, reworded").await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "main~1"]), "Trunk work, reworded");
    }

    /// Fix round 1 (R2): the root commit has no parent to rebase from: plain copy, no `<oid>^`.
    #[tokio::test]
    async fn the_root_commit_is_refused_in_plain_words() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let before = stack_tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = reword(&api, id, &r, "main~1", "Base, reworded").await.unwrap_err();
        assert_eq!(e.message, "The first commit can't be reworded here. Use Interactive rebase.");
        assert_eq!(stack_tips(&r), before);
    }

    /// Controller ruling: a commit that isn't in the branch's history (main's, here) is refused,
    /// naming the branch.
    #[tokio::test]
    async fn a_commit_outside_the_branch_is_refused_naming_it() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let before = stack_tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = reword(&api, id, &r, "main", "Main, reworded").await.unwrap_err();
        assert_eq!(e.message, "That commit isn't in feature/c's history any more");
        assert_eq!(stack_tips(&r), before);
    }
}
