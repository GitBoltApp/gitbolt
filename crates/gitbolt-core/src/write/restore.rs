//! Restore a file from a commit (spec #3 §3.8): the file as it is in `sha`, written into the
//! working tree unstaged (the index untouched); a path `sha` doesn't have is deleted instead
//! ("Delete <path>"). Like a discard (#2 §5.3) it snapshots the path first and records an `after`
//! snapshot, so Undo and Redo restore either side, an untracked file's bytes included.

use crate::api::Api;
use crate::blob::check_relative;
use crate::error::{gix_err, ErrorDetail, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{snapshot, UndoKind};
use crate::status::{status, EntryKind};
use crate::write::stage::nul_list;
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, Plan, Pre, Staging, WriteClass, WriteCx, WriteIntent};
use std::path::Path;
use std::sync::Mutex;

/// What `sha` holds at the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtCommit {
    File,
    Absent,
}

struct Restore {
    sha: String,
    path: String,
    /// "Click again to replace your changes" was answered.
    confirm: bool,
    label: Mutex<String>,
    at: Mutex<Option<AtCommit>>,
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn label_of(path: &str, sha: &str, at: AtCommit) -> String {
    match at {
        AtCommit::File => format!("restore {path} from {}", short(sha)),
        AtCommit::Absent => format!("delete {path} (as in {})", short(sha)),
    }
}

fn poisoned() -> GbError {
    GbError::other("the restore's plan is poisoned")
}

async fn at_commit(root: &Path, sha: &str, path: &str) -> Result<AtCommit, GbError> {
    let (root, sha, path) = (root.to_path_buf(), sha.to_string(), path.to_string());
    crate::api::blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let id = gix::ObjectId::from_hex(sha.as_bytes()).map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {sha}")))?;
        let commit = repo.find_commit(id).map_err(|e| GbError::new(GbErrorKind::NotFound, format!("{}: {e}", short(&sha))))?;
        let tree = commit.tree().map_err(gix_err)?;
        match tree.lookup_entry_by_path(path.as_str()).map_err(gix_err)? {
            None => Ok(AtCommit::Absent),
            Some(e) if e.mode().is_tree() => Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is a directory in {}", short(&sha)))),
            Some(e) if e.mode().is_commit() => Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is a submodule: restore it inside it"))),
            Some(_) => Ok(AtCommit::File),
        }
    })
    .await
}

/// `[path]` when a file stands at `path` that the index doesn't have (untracked or ignored): the
/// snapshot's untracked part, so Undo brings its bytes back.
fn untracked_of(root: &Path, path: &str) -> Result<Vec<String>, GbError> {
    use gix::bstr::ByteSlice;
    if root.join(path).symlink_metadata().is_err() {
        return Ok(Vec::new());
    }
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let tracked = index.entries().iter().any(|e| e.path(&index).to_str_lossy() == path);
    Ok(if tracked { Vec::new() } else { vec![path.to_string()] })
}

/// Ruling 3: the file's own changes a restore would replace (unstaged edits, a deletion, an
/// untracked file). A staged-only change isn't one: the index keeps it.
async fn has_changes(api: &Api, root: &Path, path: &str, untracked: bool) -> Result<bool, GbError> {
    if untracked {
        return Ok(true);
    }
    let entries = status(&api.cli, root).await?;
    Ok(entries.iter().any(|e| e.path == path && e.kind != EntryKind::Ignored && e.worktree != '.'))
}

impl WriteIntent for Restore {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Restore
    }
    fn label(&self) -> String {
        self.label.lock().map(|l| l.clone()).unwrap_or_else(|_| "restore".into())
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Restore)
    }
    /// The index is never written: the staging log stays valid.
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    /// Under the lock: what `sha` has, what's in the way, and the question, from the worktree now.
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let at = at_commit(pre.root, &self.sha, &self.path).await?;
        let meta = pre.root.join(&self.path).symlink_metadata().ok();
        if meta.as_ref().is_some_and(|m| m.is_dir()) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is a directory in the working tree", self.path)));
        }
        if at == AtCommit::Absent && meta.is_none() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} isn't in the working tree: nothing to delete", self.path)));
        }
        let untracked = untracked_of(pre.root, &self.path)?;
        if !self.confirm && has_changes(pre.api, pre.root, &self.path, !untracked.is_empty()).await? {
            return Err(GbError::new(GbErrorKind::DirtyWorktree, format!("Replace your changes to {}?", self.path)).with_detail(ErrorDetail::RestoreOverChanges { path: self.path.as_str().into() }));
        }
        *self.label.lock().map_err(|_| poisoned())? = label_of(&self.path, &self.sha, at);
        *self.at.lock().map_err(|_| poisoned())? = Some(at);
        Ok(Plan { snapshot: Some((vec![self.path.clone()], untracked)), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let snap = cx.snapshot.clone().ok_or_else(|| GbError::other("the restore has no snapshot"))?;
        let at = (*self.at.lock().map_err(|_| poisoned())?).ok_or_else(|| GbError::other("the restore has no plan"))?;
        cx.partial = true;
        match at {
            AtCommit::File => {
                let source = format!("--source={}", self.sha);
                let inv = cx.git(["restore", source.as_str(), "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list([&self.path]));
                cx.run_git(inv).await?;
            }
            AtCommit::Absent => {
                // Only what the snapshot holds is deleted.
                let full = cx.root.join(&self.path);
                if snap.paths.contains(&self.path) && full.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
                    std::fs::remove_file(&full)?;
                }
            }
        }
        // The same path; untracked now if it came back where the index has none (Review Focus 5).
        let untracked = untracked_of(cx.root, &self.path)?;
        cx.after = Some(snapshot::create(&cx.snapshots(), &self.label(), &snap.paths, &untracked).await?);
        cx.touch(ChangeKind::Worktree);
        Ok(())
    }
}

pub(crate) async fn restore_file(api: &Api, repo: u32, worktree: &str, sha: String, path: String, confirm: bool) -> Result<WriteResult<()>, GbError> {
    check_relative(&path)?;
    if sha.len() < 40 || gix::ObjectId::from_hex(sha.as_bytes()).is_err() {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {sha}")));
    }
    let label = format!("restore {path} from {}", short(&sha));
    run_write(api, repo, worktree, Expect::default(), Restore { sha, path, confirm, label: Mutex::new(label), at: Mutex::new(None) }).await
}
#[cfg(test)]
mod tests {
    use crate::api::Api;
    use crate::error::{ErrorDetail, GbError, GbErrorKind};
    use crate::testing::state::RepoState;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, journal_step, open, repo, wt};
    use serde_json::{json, Value};

    async fn restore(api: &Api, id: u32, r: &TestRepo, sha: &str, path: &str, confirm: bool) -> Result<Value, GbError> {
        call(api, "restoreFile", json!({ "repo": id, "worktree": wt(r.path()), "sha": sha, "path": path, "confirm": confirm })).await
    }
    fn read(r: &TestRepo, p: &str) -> String {
        std::fs::read_to_string(r.path().join(p)).unwrap()
    }
    /// `repo()` (a.txt "a\n", commit "one") plus "two" (a.txt "a two\n"): the sha of "one".
    fn two_versions() -> (TestRepo, String) {
        let r = repo();
        let one = r.git(&["rev-parse", "HEAD"]);
        r.write("a.txt", "a two\n");
        r.git(&["commit", "-qam", "two"]);
        (r, one)
    }

    #[tokio::test]
    async fn restoring_an_older_version_round_trips_and_leaves_the_index() {
        let data = tempfile::tempdir().unwrap();
        let (r, one) = two_versions();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = RepoState::capture(&r);
        let res = restore(&api, id, &r, &one, "a.txt", false).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], format!("restore a.txt from {}", &one[..7]));
        assert_eq!(read(&r, "a.txt"), "a\n");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "", "the index is untouched");
        assert_eq!(r.git(&["status", "--porcelain"]), " M a.txt", "unstaged");
        let after = RepoState::capture(&r);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(RepoState::capture(&r), before);
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(RepoState::capture(&r), after);
    }

    /// Review Focus 2; spec #3 §3.8 "Click again to replace your changes to <path>".
    #[tokio::test]
    async fn restoring_over_local_changes_asks_then_undo_brings_them_back() {
        let data = tempfile::tempdir().unwrap();
        let (r, one) = two_versions();
        r.write("a.txt", "my edit\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = restore(&api, id, &r, &one, "a.txt", false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::DirtyWorktree);
        assert!(matches!(&err.detail, Some(ErrorDetail::RestoreOverChanges { path }) if &**path == "a.txt"), "{err:?}");
        assert_eq!(read(&r, "a.txt"), "my edit\n", "nothing written before the answer");
        let dirty = RepoState::capture(&r);
        restore(&api, id, &r, &one, "a.txt", true).await.unwrap();
        assert_eq!(read(&r, "a.txt"), "a\n");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(RepoState::capture(&r), dirty, "the edit is back, byte for byte");
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(read(&r, "a.txt"), "a\n");
    }

    /// Ruling 3: a staged-only change isn't asked about, and stays staged.
    #[tokio::test]
    async fn a_staged_only_change_is_not_asked_about_and_stays_staged() {
        let data = tempfile::tempdir().unwrap();
        let (r, one) = two_versions();
        r.write("a.txt", "staged\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        restore(&api, id, &r, &one, "a.txt", false).await.unwrap();
        assert_eq!(r.git(&["show", ":a.txt"]), "staged");
        assert_eq!(read(&r, "a.txt"), "a\n");
    }

    /// Spec #3 §3.8: a file absent at that commit offers "Delete <path>".
    #[tokio::test]
    async fn a_path_the_commit_lacks_is_deleted_and_undo_restores_it() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let one = r.git(&["rev-parse", "HEAD"]);
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-qm", "add b"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = restore(&api, id, &r, &one, "b.txt", false).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], format!("delete b.txt (as in {})", &one[..7]));
        assert!(!r.path().join("b.txt").exists());
        assert_eq!(r.git(&["status", "--porcelain"]), " D b.txt");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(read(&r, "b.txt"), "b\n");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    #[tokio::test]
    async fn an_untracked_file_where_the_commit_has_none_asks_then_is_deleted() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let one = r.git(&["rev-parse", "HEAD"]);
        r.write("n.txt", "new\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        assert_eq!(restore(&api, id, &r, &one, "n.txt", false).await.unwrap_err().kind, GbErrorKind::DirtyWorktree);
        restore(&api, id, &r, &one, "n.txt", true).await.unwrap();
        assert!(!r.path().join("n.txt").exists());
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(read(&r, "n.txt"), "new\n");
    }

    /// Review Focus 5.
    #[tokio::test]
    async fn a_file_gone_since_comes_back_and_undo_removes_it_again() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-qm", "add b"]);
        let with_b = r.git(&["rev-parse", "HEAD"]);
        r.git(&["rm", "-q", "b.txt"]);
        r.git(&["commit", "-qm", "drop b"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        restore(&api, id, &r, &with_b, "b.txt", false).await.unwrap();
        assert_eq!(read(&r, "b.txt"), "b\n");
        assert_eq!(r.git(&["status", "--porcelain"]), "?? b.txt");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert!(!r.path().join("b.txt").exists());
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(read(&r, "b.txt"), "b\n");
    }

    #[tokio::test]
    async fn nothing_to_delete_a_directory_and_a_bad_sha_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d/x.txt", "x\n");
        r.git(&["add", "d/x.txt"]);
        r.git(&["commit", "-qm", "d"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        assert_eq!(restore(&api, id, &r, &head, "nope.txt", false).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(restore(&api, id, &r, &head, "d", false).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(restore(&api, id, &r, "HEAD", "a.txt", false).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(restore(&api, id, &r, &head, "../a.txt", false).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }
}
