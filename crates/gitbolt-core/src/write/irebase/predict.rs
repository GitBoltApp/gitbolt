//! Conflict prediction (spec #3 §3.2): each planned row, in replay order, is merged onto the
//! previous simulated result with `git merge-tree --write-tree --merge-base=<parent>`. Nothing
//! touches the working tree, the index or the refs. The trees and step commits go to a throwaway
//! object directory with the repository's objects as its alternate, so the repository's own
//! store is never written either (Ruling 5). It's only a hint: a real conflict always pauses.

use super::types::{RebaseRow, RebaseRowAction};
use crate::api::{blocking, Api};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::git::GitInvocation;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use ts_rs::TS;

/// Spec #3 §3.2: off above this many rows.
pub const LIMIT: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RowPrediction {
    pub oid: String,
    /// The paths that would conflict; empty: it applies cleanly.
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Prediction {
    /// Each row that isn't dropped, in replay order (oldest first).
    pub rows: Vec<RowPrediction>,
    /// Why there's no prediction ("Prediction is off for ranges over 300 commits", "Couldn't
    /// predict conflicts", "Superseded"); `None` when `rows` is one.
    pub off: Option<String>,
}

fn off(why: &str) -> Prediction {
    Prediction { rows: Vec::new(), off: Some(why.to_string()) }
}

/// The newest prediction asked for, per worktree: an older one still running stops at its next row.
static LATEST: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

fn begin(key: &str) -> u64 {
    let mut m = LATEST.lock().expect("prediction generations");
    let n = m.get(key).copied().unwrap_or(0) + 1;
    m.insert(key.to_string(), n);
    n
}

fn current(key: &str, n: u64) -> bool {
    LATEST.lock().expect("prediction generations").get(key) == Some(&n)
}

/// The scratch dirs' name prefix, under `<data>/tmp`.
const PREFIX: &str = "predict-";

/// A scratch dir older than this is a leftover (a crash, a killed process): no prediction runs
/// that long, so the next prediction removes it.
const STALE: std::time::Duration = std::time::Duration::from_secs(3600);

/// The scratch dir, removed on every exit path, a dropped future included.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        remove(&self.0);
    }
}

fn remove(dir: &Path) {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!(target: "gitbolt_core::write", "couldn't remove the prediction's scratch dir {}: {e}", dir.display());
        }
        _ => {}
    }
}

/// Removes the stale scratch dirs left in `tmp`. A recent one may belong to a prediction still
/// running (another worktree's, another instance's), so it stays.
fn sweep(tmp: &Path) {
    let Ok(entries) = std::fs::read_dir(tmp) else { return };
    for e in entries.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE);
        if old && e.file_name().to_string_lossy().starts_with(PREFIX) {
            remove(&e.path());
        }
    }
}

pub(crate) async fn predict(api: &Api, repo: u32, worktree: &str, base: &str, rows: Vec<RebaseRow>) -> Result<Prediction, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    if rows.len() > LIMIT {
        return Ok(off("Prediction is off for ranges over 300 commits"));
    }
    let key = format!("{repo}:{}", root.display());
    let generation = begin(&key);
    let tmp = api.tmp_dir()?;
    sweep(&tmp);
    let scratch = Scratch(tmp.join(format!("{PREFIX}{}", crate::random::random_hex(8))));
    let res = simulate(api, &root, base, &rows, &scratch.0, || current(&key, generation)).await;
    drop(scratch);
    match res {
        Ok(Some(rows)) => Ok(Prediction { rows, off: None }),
        Ok(None) => Ok(off("Superseded")),
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "conflict prediction failed: {e}");
            Ok(off("Couldn't predict conflicts"))
        }
    }
}

async fn simulate(api: &Api, root: &Path, base: &str, rows: &[RebaseRow], scratch: &Path, live: impl Fn() -> bool) -> Result<Option<Vec<RowPrediction>>, GbError> {
    let objects = scratch.join("objects");
    std::fs::create_dir_all(&objects).map_err(|e| GbError::new(GbErrorKind::Io, format!("{}: {e}", objects.display())))?;
    // Replay order, drops left out: what git would apply, one after the other.
    let replay: Vec<String> = rows.iter().rev().filter(|r| r.action != RebaseRowAction::Drop).map(|r| r.oid.clone()).collect();
    let (r, b) = (root.to_path_buf(), base.to_string());
    // gix: the base's commit, each row's first parent, the repository's object directory.
    let (start, steps, store): (String, Vec<(String, Option<String>)>, PathBuf) = blocking(move || {
        let repo = gix::open(&r).map_err(gix_err)?;
        let start = repo.rev_parse_single(format!("{b}^{{commit}}").as_str()).map_err(|e| GbError::new(GbErrorKind::NotFound, format!("{b}: {e}")))?.detach().to_string();
        let steps = replay
            .into_iter()
            .map(|o| {
                let id = gix::ObjectId::from_hex(o.as_bytes()).map_err(gix_err)?;
                let parent = repo.find_commit(id).map_err(gix_err)?.parent_ids().next().map(|p| p.to_string());
                Ok((o, parent))
            })
            .collect::<Result<Vec<_>, GbError>>()?;
        Ok((start, steps, repo.common_dir().join("objects")))
    })
    .await?;
    let env = |inv: GitInvocation| {
        inv.env("GIT_OBJECT_DIRECTORY", &objects)
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &store)
            .env("GIT_AUTHOR_NAME", "GitBolt")
            .env("GIT_AUTHOR_EMAIL", "gitbolt@localhost")
            .env("GIT_AUTHOR_DATE", "@0 +0000")
            .env("GIT_COMMITTER_NAME", "GitBolt")
            .env("GIT_COMMITTER_EMAIL", "gitbolt@localhost")
            .env("GIT_COMMITTER_DATE", "@0 +0000")
    };
    let mut at = start;
    let mut out = Vec::with_capacity(steps.len());
    for (oid, parent) in steps {
        if !live() {
            return Ok(None);
        }
        let Some(parent) = parent else {
            // A root commit: never a row of a plan (the base is a commit's parent), and there's
            // no merge base to replay it with.
            return Err(GbError::other(format!("{oid} is a root commit")));
        };
        if parent == at {
            // git fast-forwards it: nothing to merge.
            at = oid.clone();
            out.push(RowPrediction { oid, conflicts: Vec::new() });
            continue;
        }
        let merge_base = format!("--merge-base={parent}");
        let inv = env(GitInvocation::new(root, ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", merge_base.as_str(), at.as_str(), oid.as_str()]).ok_exit(1));
        let res = api.cli.run(inv).await?;
        let mut fields = res.stdout.split(|b| *b == 0).filter(|f| !f.is_empty()).map(|f| String::from_utf8_lossy(f).into_owned());
        let tree = fields.next().ok_or_else(|| GbError::other("merge-tree printed no tree"))?;
        let mut conflicts: Vec<String> = fields.collect();
        conflicts.sort();
        conflicts.dedup();
        if conflicts.is_empty() {
            // `--no-gpg-sign`: a `commit.gpgSign` config would otherwise sign each step commit.
            let c = api.cli.run(env(GitInvocation::new(root, ["commit-tree", "--no-gpg-sign", tree.as_str(), "-p", at.as_str(), "-m", "gitbolt prediction"]))).await?;
            at = String::from_utf8_lossy(&c.stdout).trim().to_string();
        }
        // A conflicting row: the rows after it continue from its "ours" side (`at` stays).
        out.push(RowPrediction { oid, conflicts });
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};
    use crate::write::irebase::plan::RebasePlanPayload;
    use crate::write::test_support::{api, call, open, wt};
    use serde_json::{json, Value};

    async fn plan(api: &Api, id: u32, r: &TestRepo) -> RebasePlanPayload {
        let v = call(api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main" })).await.unwrap();
        serde_json::from_value(v).unwrap()
    }

    /// The row whose summary starts with `name` ("C1").
    fn oid(p: &RebasePlanPayload, name: &str) -> String {
        p.rows.iter().find(|x| x.summary.split(' ').next() == Some(name)).unwrap_or_else(|| panic!("{name}")).oid.clone()
    }

    /// Picks in this order (newest first, as the request sends them).
    fn order(p: &RebasePlanPayload, names: &[&str]) -> Vec<Value> {
        names.iter().map(|n| json!({ "oid": oid(p, n), "action": "pick" })).collect()
    }

    /// The plan's rows as they are, all picks.
    fn picks(p: &RebasePlanPayload) -> Vec<Value> {
        p.rows.iter().map(|x| json!({ "oid": x.oid, "action": "pick" })).collect()
    }

    fn set(p: &RebasePlanPayload, rows: &mut [Value], name: &str, action: &str) {
        let o = oid(p, name);
        let row = rows.iter_mut().find(|r| r["oid"] == o.as_str()).unwrap_or_else(|| panic!("{name}"));
        row["action"] = json!(action);
    }

    async fn predict_rows(api: &Api, id: u32, r: &TestRepo, rows: &[Value]) -> Prediction {
        let v = call(api, "predictRebase", json!({ "repo": id, "worktree": wt(r.path()), "base": "main", "rows": rows })).await.unwrap();
        serde_json::from_value(v).unwrap()
    }

    /// The scratch dirs left under `<data>/tmp`.
    fn scratch_dirs(data: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(data.join("tmp")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(PREFIX)).collect();
        v.sort();
        v
    }

    fn conflicting(p: &Prediction) -> Vec<(String, Vec<String>)> {
        p.rows.iter().filter(|r| !r.conflicts.is_empty()).map(|r| (r.oid.clone(), r.conflicts.clone())).collect()
    }

    /// GitBolt's own Start (`interactiveRebase`) with these rows: the run the prediction stands for.
    async fn real_rebase(api: &Api, id: u32, r: &TestRepo, rows: Vec<Value>) {
        use crate::write::irebase::run::tests::{plan, start, stay};
        let p = plan(api, id, r).await;
        let res = start(api, id, r, &p, rows, stay(&p)).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped", "the rebase stops on a conflict: {res}");
    }

    /// §7: prediction against a real run. C1 below A2 conflicts in notes.txt; the real rebase
    /// stops at the same commit, on the same file.
    #[tokio::test]
    async fn prediction_matches_a_real_run() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let rows = order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        let objects = r.git(&["count-objects"]);
        let pred = predict_rows(&api, id, &r, &rows).await;
        assert_eq!(pred.off, None);
        assert_eq!(pred.rows.len(), 8);
        let c1 = oid(&p, "C1");
        assert_eq!(conflicting(&pred), [(c1.clone(), vec!["notes.txt".to_string()])]);
        assert_eq!(r.git(&["count-objects"]), objects, "the repository's object store is untouched");
        assert_eq!(scratch_dirs(data.path()), Vec::<String>::new(), "the scratch dir is removed");
        real_rebase(&api, id, &r, rows).await;
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "notes.txt");
        let stopped = r.git(&["rev-parse", "REBASE_HEAD"]);
        assert_eq!(stopped, c1, "the predicted row is where the real rebase stops");
    }

    #[tokio::test]
    async fn a_clean_plan_predicts_no_conflicts_and_drops_are_skipped() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = order(&p, &["C1", "C2", "B2", "S1", "B1", "A3", "A2", "A1"]);
        set(&p, &mut rows, "A3", "squash");
        set(&p, &mut rows, "S1", "drop");
        let pred = predict_rows(&api, id, &r, &rows).await;
        assert!(conflicting(&pred).is_empty(), "{pred:?}");
        assert_eq!(pred.rows.len(), 7, "the dropped row isn't predicted");
        assert_eq!(pred.rows[0].oid, oid(&p, "A1"), "replay order, oldest first");
        // Dropping A2 makes C1 conflict: A2 added the line C1 rewrites.
        let mut rows = picks(&p);
        set(&p, &mut rows, "A2", "drop");
        let pred = predict_rows(&api, id, &r, &rows).await;
        assert_eq!(conflicting(&pred).len(), 1);
        assert_eq!(conflicting(&pred)[0].0, oid(&p, "C1"));
    }

    /// Rows already on the base: each one's parent is the simulated tip, so it fast-forwards.
    #[tokio::test]
    async fn rows_already_on_the_base_fast_forward() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let rows = vec![json!({ "oid": r.git(&["rev-parse", "feature/a"]), "action": "pick" }), json!({ "oid": r.git(&["rev-parse", "feature/a~1"]), "action": "pick" })];
        let v = call(&api, "predictRebase", json!({ "repo": id, "worktree": wt(r.path()), "base": "feature/a~2", "rows": rows })).await.unwrap();
        let pred: Prediction = serde_json::from_value(v).unwrap();
        assert_eq!(pred.off, None);
        assert_eq!(pred.rows.len(), 2);
        assert!(conflicting(&pred).is_empty());
        let log = api.cli.log().entries();
        assert!(!format!("{log:?}").contains("merge-tree"), "no process runs for a fast-forward");
    }

    #[tokio::test]
    async fn a_git_failure_turns_prediction_off() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let rows = vec![json!({ "oid": "1".repeat(40), "action": "pick" })];
        let pred = predict_rows(&api, id, &r, &rows).await;
        assert_eq!(pred.off.as_deref(), Some("Couldn't predict conflicts"));
        assert!(pred.rows.is_empty());
        assert_eq!(scratch_dirs(data.path()), Vec::<String>::new(), "the scratch dir is removed on a failure too");
    }

    /// A root commit has no merge base to replay it with: no prediction, rather than a clean row
    /// the simulation never applied.
    #[tokio::test]
    async fn a_root_commit_row_turns_prediction_off() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let root = r.git(&["rev-list", "--max-parents=0", "main"]);
        let rows = vec![json!({ "oid": root, "action": "pick" })];
        let pred = predict_rows(&api, id, &r, &rows).await;
        assert_eq!(pred.off.as_deref(), Some("Couldn't predict conflicts"));
        assert!(pred.rows.is_empty());
    }

    /// A scratch dir left by a crash is removed by the next prediction; a recent one (another
    /// prediction, still running) stays.
    #[tokio::test]
    async fn the_next_prediction_sweeps_stale_scratch_dirs() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let tmp = api.tmp_dir().unwrap();
        std::fs::create_dir_all(tmp.join("predict-stale/objects")).unwrap();
        std::fs::create_dir_all(tmp.join("predict-fresh/objects")).unwrap();
        let old = std::time::SystemTime::now() - STALE - std::time::Duration::from_secs(60);
        crate::platform::fs::set_modified(tmp.join("predict-stale"), old).unwrap();
        let p = plan(&api, id, &r).await;
        let pred = predict_rows(&api, id, &r, &picks(&p)).await;
        assert_eq!(pred.off, None);
        assert_eq!(scratch_dirs(data.path()), ["predict-fresh"]);
    }

    #[tokio::test]
    async fn over_300_rows_prediction_is_off() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let rows: Vec<Value> = (0..301).map(|_| json!({ "oid": "0".repeat(40), "action": "pick" })).collect();
        let pred = predict_rows(&api, id, &r, &rows).await;
        assert_eq!(pred.off.as_deref(), Some("Prediction is off for ranges over 300 commits"));
        assert!(pred.rows.is_empty());
    }

    #[test]
    fn a_newer_prediction_supersedes_an_older_one() {
        let a = begin("t:/r");
        assert!(current("t:/r", a));
        let b = begin("t:/r");
        assert!(!current("t:/r", a) && current("t:/r", b));
        assert!(current("t:/other", begin("t:/other")), "per worktree");
    }
}
