//! Stage and unstage whole files (spec #2 §7.2): immediate writes (§3.6) that the staging undo
//! log records (§7.6). Paths go to git on stdin, NUL-separated and literal, never on argv.

use crate::api::Api;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::UndoKind;
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, Staging, WriteClass, WriteCx, WriteIntent};
use std::path::Path;

/// `paths`, NUL-terminated: what `--pathspec-from-file=- --pathspec-file-nul` reads.
pub(crate) fn nul_list<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for p in paths {
        bytes.extend_from_slice(p.as_bytes());
        bytes.push(0);
    }
    bytes
}

/// HEAD has no commit yet: `restore --staged` needs one, so unstaging uses `rm --cached`.
pub(crate) fn unborn(root: &Path) -> Result<bool, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    Ok(repo.head().map_err(gix_err)?.is_unborn())
}

/// "a.php" or "3 files", for labels (§5.5, §7.6).
pub(crate) fn files_label(paths: &[String]) -> String {
    match paths {
        [one] => one.clone(),
        many => format!("{} files", many.len()),
    }
}

/// git's "pathspec 'x' did not match any files": the list was drawn before the file changed
/// (Review Focus 1). That's `Stale`, which the toast answers with Refresh.
pub(crate) fn stale_paths(paths: &[String]) -> impl Fn(GbError) -> GbError + '_ {
    move |e| {
        let text = e.stderr.as_deref().unwrap_or(&e.message);
        if text.contains("did not match any file") {
            GbError::stale(format!("{} changed since it was shown", paths.first().map(String::as_str).unwrap_or("A file")))
        } else {
            e
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Which {
    Stage,
    Unstage,
}

impl Which {
    pub(crate) fn verb(self) -> &'static str {
        match self {
            Which::Stage => "stage",
            Which::Unstage => "unstage",
        }
    }
}

/// Stage or unstage these files (a folder row sends the files under it).
pub(crate) struct StagePaths {
    pub which: Which,
    pub paths: Vec<String>,
    /// A rename's sources: unstaged with it, not counted in the label (Deviation 5).
    pub old_paths: Vec<String>,
}

impl WriteIntent for StagePaths {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stage
    }
    fn label(&self) -> String {
        format!("{} {}", self.which.verb(), files_label(&self.paths))
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    fn staging(&self) -> Staging {
        Staging::Step
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        if self.paths.is_empty() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("Nothing to {}", self.which.verb())));
        }
        let all: Vec<String> = self.paths.iter().chain(&self.old_paths).cloned().collect();
        let args: &[&str] = match (self.which, unborn(cx.root)?) {
            (Which::Stage, _) => &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            (Which::Unstage, false) => &["restore", "--staged", "--pathspec-from-file=-", "--pathspec-file-nul"],
            (Which::Unstage, true) => &["rm", "--cached", "-f", "-q", "-r", "--pathspec-from-file=-", "--pathspec-file-nul"],
        };
        let inv = cx.git(args.iter().copied()).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(&all));
        cx.run_git(inv).await.map_err(stale_paths(&self.paths))?;
        cx.touch(ChangeKind::Index);
        Ok(())
    }
}

/// Stage all (`git add -A`) or Unstage all.
pub(crate) struct StageAll {
    pub which: Which,
}

impl WriteIntent for StageAll {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stage
    }
    fn label(&self) -> String {
        format!("{} all", self.which.verb())
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    fn staging(&self) -> Staging {
        Staging::Step
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        // `:/` is pathspec magic (the whole worktree): no GIT_LITERAL_PATHSPECS here.
        let args: &[&str] = match (self.which, unborn(cx.root)?) {
            (Which::Stage, _) => &["add", "-A"],
            (Which::Unstage, false) => &["restore", "--staged", "--", ":/"],
            (Which::Unstage, true) => {
                let empty = gix::open(cx.root).map_err(gix_err)?.index_or_empty().map_err(gix_err)?.entries().is_empty();
                if empty {
                    return Ok(());
                }
                &["rm", "--cached", "-f", "-q", "-r", "--", ":/"]
            }
        };
        let inv = cx.git(args.iter().copied());
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Index);
        Ok(())
    }
}

pub(crate) async fn stage_paths(api: &Api, repo: u32, worktree: &str, which: Which, paths: Vec<String>, old_paths: Vec<String>) -> Result<WriteResult<()>, GbError> {
    run_write(api, repo, worktree, Expect::default(), StagePaths { which, paths, old_paths }).await
}

pub(crate) async fn stage_all(api: &Api, repo: u32, worktree: &str, which: Which) -> Result<WriteResult<()>, GbError> {
    run_write(api, repo, worktree, Expect::default(), StageAll { which }).await
}

#[cfg(test)]
mod tests {
    use crate::api::Api;
    use crate::error::{GbError, GbErrorKind};
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, halves, open, repo, wt};
    use serde_json::{json, Value};

    async fn stage(api: &Api, id: u32, r: &TestRepo, paths: &[&str]) -> Result<Value, GbError> {
        call(api, "stage", json!({ "repo": id, "worktree": wt(r.path()), "paths": paths })).await
    }

    async fn unstage(api: &Api, id: u32, r: &TestRepo, paths: &[&str], old: &[&str]) -> Result<Value, GbError> {
        call(api, "unstage", json!({ "repo": id, "worktree": wt(r.path()), "paths": paths, "oldPaths": old })).await
    }

    fn cached_names(r: &TestRepo) -> String {
        r.git(&["diff", "--cached", "--name-status"])
    }

    #[tokio::test]
    async fn stage_and_unstage_move_whole_files() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-q", "-m", "two"]);
        r.write("a.txt", "a2\n");
        r.write("new.txt", "n\n");
        std::fs::remove_file(r.path().join("b.txt")).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = stage(&api, id, &r, &["a.txt", "new.txt", "b.txt"]).await.unwrap();
        assert_eq!(cached_names(&r), "M\ta.txt\nD\tb.txt\nA\tnew.txt");
        // The answer carries the fresh lists (§3.1) and no journal entry (§5.3 "Not journaled").
        let staged: Vec<&str> = res["wip"]["staged"]["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(staged, ["a.txt", "b.txt", "new.txt"]);
        assert!(res["journal"]["undo"].is_null(), "{res}");
        unstage(&api, id, &r, &["a.txt", "new.txt", "b.txt"], &[]).await.unwrap();
        assert_eq!(cached_names(&r), "");
        assert_eq!(r.git(&["status", "--porcelain"]), " M a.txt\n D b.txt\n?? new.txt");
    }

    #[tokio::test]
    async fn unstaging_a_rename_takes_both_paths() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["mv", "a.txt", "renamed.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        unstage(&api, id, &r, &["renamed.txt"], &["a.txt"]).await.unwrap();
        assert_eq!(cached_names(&r), "", "both sides of the rename left the index");
    }

    #[tokio::test]
    async fn stage_all_and_unstage_all() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.write("dir/n.txt", "n\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "stageAll", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(cached_names(&r), "M\ta.txt\nA\tdir/n.txt");
        call(&api, "unstageAll", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(cached_names(&r), "");
    }

    /// §7.2: an unborn HEAD unstages with `rm --cached` (`-f`: Deviation 4), never touching the file.
    #[tokio::test]
    async fn unborn_unstage_removes_from_the_index_only() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.write("a.txt", "a\n");
        r.git(&["add", "a.txt"]);
        r.write("a.txt", "a edited since\n");
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        unstage(&api, id, &r, &["a.txt"], &[]).await.unwrap();
        assert_eq!(r.git(&["ls-files"]), "b.txt");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a edited since\n");
        call(&api, "unstageAll", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(r.git(&["ls-files"]), "");
        // An empty index: Unstage all is a no-op, not git's "did not match".
        call(&api, "unstageAll", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
    }

    /// Review Focus 1.
    #[tokio::test]
    async fn staging_a_path_that_no_longer_exists_is_stale() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = stage(&api, id, &r, &["vanished.txt"]).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale, "{err:?}");
        assert_eq!(err.message, "vanished.txt changed since it was shown");
        assert_eq!(halves(&r), (String::new(), String::new()));
    }

    /// Review Focus 2: pathspecs are literal, so a glob never widens.
    #[tokio::test]
    async fn awkward_paths_stage_and_unstage_literally() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let names = ["sp ace.txt", "-dash.txt", "*.txt", "[a].txt", "é.txt"];
        for n in names {
            r.write(n, "x\n");
        }
        r.write("b.txt", "matched by a glob\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        stage(&api, id, &r, &["*.txt"]).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only", "-z"]), "*.txt\0", "only the file named *.txt");
        stage(&api, id, &r, &names).await.unwrap();
        let staged = r.git(&["-c", "core.quotepath=false", "diff", "--cached", "--name-only"]);
        for n in names {
            assert!(staged.lines().any(|l| l == n), "{n} in {staged}");
        }
        assert!(!staged.lines().any(|l| l == "b.txt"));
        unstage(&api, id, &r, &names, &[]).await.unwrap();
        assert_eq!(cached_names(&r), "");
    }

    /// §13.2: staging runs while a merge is stopped on conflicts.
    #[tokio::test]
    async fn stage_runs_during_a_merge() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::wip_conflict(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stage(&api, id, &r, &["side.txt"]).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only", "--", "side.txt"]), "side.txt");
    }
}
