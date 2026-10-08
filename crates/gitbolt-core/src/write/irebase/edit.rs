//! UX L: GitBolt's Edit stop is "about to commit". Right after git stops on the Edit row's commit,
//! HEAD goes back to its parent (`reset --soft`), so the commit's changes are staged and its
//! message is the commit box's. The user changes them, commits in pieces (Commit, at the stop) or
//! not, and Continue commits what's staged (the original author kept), then goes on.
//!
//! Only in GitBolt's own interactive rebase (its session): a terminal's rebase keeps git's stop.
//! The reset is part of the stop (its write, never an entry of its own), so one Undo of the
//! rebase restores everything; the stop's note (`EDIT_STAGED`) says it happened, for a reload and
//! for Continue.

use crate::api::blocking;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::ChangeKind;
use crate::git::GitInvocation;
use crate::in_progress::{edit_staged, write_edit_staged, EditStaged};
use crate::write::WriteCx;
use std::ffi::OsString;
use std::path::Path;

/// Continue's refusal while changes are left unstaged (git's own rule at an Edit stop).
pub(crate) const COMMIT_OR_DISCARD: &str = "Commit or discard your changes first";

fn oid(hex: &str) -> Result<gix::ObjectId, GbError> {
    gix::ObjectId::from_hex(hex.trim().as_bytes()).map_err(gix_err)
}

/// L.1: git stopped right after the Edit row's commit (`made`, HEAD: nothing done there yet).
/// HEAD goes back to its parent, a `reset --soft` (the index and the worktree stay as they are),
/// and the note records the stop, with the message the box starts with: the Edit row's new one
/// (`file`), the one this stop already had (it's staged again), or the commit's own. A root or
/// merge commit keeps git's stop. A failure is logged and leaves git's own stop: nothing is lost.
pub(crate) async fn stage_edit_stop(cx: &mut WriteCx<'_>, git_dir: &Path, at: &str, made: &str, file: Option<&str>) {
    let (root, m) = (cx.root.to_path_buf(), made.to_string());
    let read = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let c = repo.find_commit(oid(&m)?).map_err(gix_err)?;
        let parents: Vec<String> = c.parent_ids().map(|p| p.to_string()).collect();
        Ok((parents, c.message_raw().map_err(gix_err)?.to_string()))
    })
    .await;
    let (parents, own) = match read {
        Ok(x) => x,
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "reading the Edit stop's commit: {e}");
            return;
        }
    };
    let [base] = parents.as_slice() else { return };
    let message = match file.map(std::fs::read_to_string) {
        Some(Ok(m)) => m,
        Some(Err(e)) => {
            tracing::warn!(target: "gitbolt_core::write", "reading the Edit row's message: {e}");
            own
        }
        None => edit_staged(git_dir).filter(|s| s.at == at).map(|s| s.message).unwrap_or(own),
    };
    // The paths it adds: one left untracked is a piece of it the user hasn't staged.
    let added = match cx.api.cli.run(GitInvocation::new(cx.root, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", "--diff-filter=A", base.as_str(), made])).await {
        Ok(o) => paths(&o.stdout),
        Err(e) => {
            tracing::warn!(target: "gitbolt_core::write", "reading the Edit stop's commit's files: {e}");
            return;
        }
    };
    // The note first (fix round 1): a crash after it, before the reset, leaves HEAD on git's
    // commit, which reads as git's own stop (`edit_base` needs HEAD off it) and Continues as one.
    let note = EditStaged { at: at.to_string(), amend: made.to_string(), base: base.clone(), added, message };
    if let Err(e) = write_edit_staged(git_dir, &note) {
        tracing::warn!(target: "gitbolt_core::write", "noting the Edit stop: {e}; git's own stop stays");
        return;
    }
    let inv = cx.git(["reset", "-q", "--soft", base.as_str()]);
    let res = cx.run_git(inv).await;
    cx.touch(ChangeKind::Head);
    cx.touch(ChangeKind::Index);
    if let Err(e) = res {
        tracing::warn!(target: "gitbolt_core::write", "staging the Edit stop's commit: {e}; git's own stop stays");
        if let Err(e) = std::fs::remove_file(git_dir.join(crate::in_progress::EDIT_STAGED)) {
            tracing::warn!(target: "gitbolt_core::write", "removing the Edit stop's note: {e}");
        }
    }
}

/// `-z` git output: its paths.
fn paths(out: &[u8]) -> Vec<String> {
    out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect()
}

/// The read `args` names any path.
async fn differs(cx: &WriteCx<'_>, args: &[&str]) -> Result<bool, GbError> {
    Ok(!cx.api.cli.run(GitInvocation::new(cx.root, args.iter().copied())).await?.stdout.is_empty())
}

/// "<file> from this commit isn't staged. Stage it, or discard it, then Continue."
pub(crate) fn not_staged(file: &str) -> String {
    format!("{file} from this commit isn't staged. Stage it, or discard it, then Continue.")
}

/// Fix round 1: a path of the stopped commit (`amend`) left untracked: in its tree, but neither in
/// the index nor in HEAD, and still on disk. Any other untracked file (`.env`, build output) is
/// the user's, and never holds Continue up.
async fn left_untracked(cx: &WriteCx<'_>, amend: &str) -> Result<Option<String>, GbError> {
    let out = cx.api.cli.run(GitInvocation::new(cx.root, ["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=D", amend])).await?;
    let gone = paths(&out.stdout);
    if gone.is_empty() {
        return Ok(None);
    }
    let root = cx.root.to_path_buf();
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let head = repo.head_commit().map_err(gix_err)?.tree().map_err(gix_err)?;
        for p in gone {
            let on_disk = std::fs::symlink_metadata(root.join(&p)).is_ok();
            if on_disk && head.lookup_entry_by_path(p.as_str()).map_err(gix_err)?.is_none() {
                return Ok(Some(p));
            }
        }
        Ok(None)
    })
    .await
}

/// The current stop's note, if it's GitBolt's soft-reset Edit stop.
pub(crate) async fn staged_stop(cx: &WriteCx<'_>) -> Result<Option<EditStaged>, GbError> {
    let root = cx.root.to_path_buf();
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let git_dir = repo.git_dir();
        Ok(if git_dir.join(crate::in_progress::GITBOLT_MARKER).is_file() { edit_staged(git_dir) } else { None })
    })
    .await
}

/// What `commit_at_stop` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AtStop {
    /// Nothing changed: HEAD went back to git's own commit, which git keeps as it is.
    Restored,
    /// A commit of what was staged, the original's author kept.
    Committed,
    /// Nothing staged (all committed at the stop, or all discarded): git just goes on.
    Nothing,
}

/// L.2: Continue at a soft-reset Edit stop, before git's own `--continue`. Refused while
/// tracked changes are unstaged (git would refuse them too). Then:
/// - nothing committed at the stop (HEAD on its base), the index the commit's own tree and the
///   message its own: HEAD goes back to git's commit (`Restored`), unchanged;
/// - else, anything staged (or, HEAD on the base, a commit that was empty from the start) is
///   committed with `message` (the box's; `None`: the stop's) as the original's author and
///   author date, the committer now (`Committed`). A refusal (a hook, the signer) changes nothing;
/// - else nothing (`Nothing`): every change was committed at the stop, or discarded.
pub(crate) async fn commit_at_stop(cx: &mut WriteCx<'_>, st: &EditStaged, message: Option<&str>) -> Result<AtStop, GbError> {
    if differs(cx, &["diff", "--name-only", "-z"]).await? {
        return Err(GbError::new(GbErrorKind::InvalidInput, COMMIT_OR_DISCARD));
    }
    if let Some(file) = left_untracked(cx, &st.amend).await? {
        return Err(GbError::new(GbErrorKind::InvalidInput, not_staged(&file)));
    }
    // The index against the stop's commit (no lock, unlike `write-tree`), and against HEAD.
    let changed = differs(cx, &["diff", "--cached", "--no-renames", "--name-only", "-z", st.amend.as_str()]).await?;
    let staged = differs(cx, &["diff", "--cached", "--no-renames", "--name-only", "-z"]).await?;
    let (root, amend, base) = (cx.root.to_path_buf(), st.amend.clone(), st.base.clone());
    let (head, empty_commit, own) = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let head = repo.head_id().map_err(gix_err)?.to_string();
        let tree = |o: &str| -> Result<gix::ObjectId, GbError> { repo.find_commit(oid(o)?).map_err(gix_err)?.tree_id().map(|t| t.detach()).map_err(gix_err) };
        let own = repo.find_commit(oid(&amend)?).map_err(gix_err)?.message_raw().map_err(gix_err)?.to_string();
        Ok((head, tree(&amend)? == tree(&base)?, own))
    })
    .await?;
    let text = format!("{}\n", message.filter(|m| !m.trim().is_empty()).unwrap_or(&st.message).replace("\r\n", "\n").trim_end());
    let on_base = head == st.base;
    if on_base && !changed && own.replace("\r\n", "\n").trim_end() == text.trim_end() {
        let inv = cx.git(["reset", "-q", "--soft", st.amend.as_str()]);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Head);
        return Ok(AtStop::Restored);
    }
    let empty = on_base && empty_commit;
    if !staged && !empty {
        return Ok(AtStop::Nothing);
    }
    // The original's author and author date, as git's own amend at the stop keeps them.
    let line = |out: crate::git::GitOutput| String::from_utf8_lossy(&out.stdout).trim().to_string();
    let who = line(cx.api.cli.run(GitInvocation::new(cx.root, ["log", "-1", "--no-mailmap", "--format=%an%x00%ae%x00%ad", "--date=raw", st.amend.as_str()])).await?);
    let mut parts = who.split('\0');
    let (name, email, date) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let mut args = vec!["commit", "-q", "-F", "-"];
    if !staged {
        args.push("--allow-empty");
    }
    let envs: Vec<(OsString, OsString)> = [("GIT_AUTHOR_NAME", name), ("GIT_AUTHOR_EMAIL", email), ("GIT_AUTHOR_DATE", date)].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
    let inv = cx.git(args).stdin(text.into_bytes()).envs(envs);
    let res = cx.run_git(inv).await;
    cx.touch(ChangeKind::Head);
    cx.touch(ChangeKind::Index);
    res.map_err(|e| {
        let why = e.stderr.as_deref().and_then(super::run::hook_text).unwrap_or_else(|| e.message.clone());
        GbError { message: format!("The commit wasn't made: {}", why.trim_end_matches('.')), ..e }
    })?;
    // Work done at the stop: an Abort at a later stop keeps it on a branch (it reads as a replay,
    // its author the original's). A failure here is logged: the commit exists all the same.
    let root = cx.root.to_path_buf();
    let made = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.head_id().map_err(gix_err)?.to_string())).await;
    if let Err(e) = made.and_then(|oid| super::split::record_made(cx, &oid)) {
        tracing::warn!(target: "gitbolt_core::write", "recording the Edit stop's commit on the paused rebase: {e}");
    }
    Ok(AtStop::Committed)
}

/// After a Continue that put HEAD back on git's commit (`Restored`) and then didn't get past the
/// stop (a cancel, a failure before git moved on): the stop is staged again, as it was.
pub(crate) async fn restage(cx: &mut WriteCx<'_>, st: &EditStaged) {
    let root = cx.root.to_path_buf();
    let now = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        Ok((repo.head_id().map_err(gix_err)?.to_string(), crate::in_progress::last_done(repo.git_dir()), repo.git_dir().to_path_buf()))
    })
    .await;
    if let Ok((head, Some(at), git_dir)) = now
        && head == st.amend
        && at == st.at
    {
        stage_edit_stop(cx, &git_dir, &at, &st.amend, None).await;
    }
}

/// Tests: the Continue of these worktrees is cancelled right after `Restored`, before git runs.
#[cfg(test)]
pub(crate) mod test_hook {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    static CANCEL: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

    pub(crate) fn cancel_at(root: &Path) {
        CANCEL.lock().unwrap().push(crate::platform::fs::canonicalize(root).unwrap());
    }

    pub(crate) fn cancels(root: &Path) -> bool {
        let root = crate::platform::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let mut list = CANCEL.lock().unwrap();
        let hit = list.iter().position(|p| *p == root);
        hit.map(|i| list.remove(i)).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::super::run::tests::{picks, plan, set, start, stay, tips};
    use crate::error::GbErrorKind;
    use crate::in_progress::InProgress;
    use crate::testing::{fixtures, TestRepo};
    use crate::write::test_support::{api, call, journal_step, open, wt};
    use serde_json::{json, Value};

    /// main moved on; `topic` has T1 (two new files, Grace's, an old date) and T2 above it.
    fn topic(r: &TestRepo) {
        r.commit("Base");
        r.switch_new("topic");
        r.write("a.txt", "a\n");
        r.write("b.txt", "b\n");
        r.git(&["add", "a.txt", "b.txt"]);
        r.git(&["commit", "-q", "--author=Grace Hopper <grace@example.com>", "--date=1600000000 +0200", "-m", "T1 Two files\n\nWith a body."]);
        r.commit("T2 After");
        r.switch("main");
        r.write("main.txt", "main\n");
        r.git(&["add", "main.txt"]);
        r.git(&["commit", "-q", "-m", "Main moves"]);
        r.switch("topic");
    }

    /// Starts the topic's rebase onto main, T1 an Edit row (with its new message, if any): stopped.
    async fn edit_t1(api: &crate::api::Api, id: u32, r: &TestRepo, message: Option<&str>) {
        let p = call(api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "topic", "base": "main" })).await.unwrap();
        let mut rows = picks(&p);
        set(&p, &mut rows, "T1", "edit", message);
        let res = call(api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "topic", "base": "main", "expect": p["expect"], "rows": rows, "chips": stay(&p) })).await.unwrap();
        assert_eq!(res["outcome"]["status"], "stopped", "{res}");
    }

    async fn cont(api: &crate::api::Api, id: u32, r: &TestRepo, message: Option<&str>) -> Result<Value, crate::error::GbError> {
        let mut params = json!({ "repo": id, "worktree": wt(r.path()), "action": "continue" });
        if let Some(m) = message {
            params["message"] = json!(m);
        }
        call(api, "rebaseControl", params).await
    }

    async fn commit(api: &crate::api::Api, id: u32, r: &TestRepo, summary: &str) -> Value {
        call(api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": summary, "expect": {} })).await.unwrap()
    }

    /// (edit_stop, edit_base, message) of GitBolt's stop.
    fn stop(r: &TestRepo) -> (Option<String>, Option<String>, String) {
        match crate::in_progress::read(r.path()).unwrap() {
            Some(InProgress::Rebase { edit_stop, edit_base, message, gitbolt: true, conflicted: 0, .. }) => (edit_stop, edit_base, message),
            other => panic!("{other:?}"),
        }
    }

    fn staged(r: &TestRepo) -> String {
        r.git(&["diff", "--cached", "--name-only"])
    }

    /// Who wrote it and when, its message and its change: all of a picked commit but its
    /// committer (and its parent).
    fn written(r: &TestRepo, rev: &str) -> String {
        r.git(&["show", "--format=%an <%ae> %ad%n%B", "--date=raw", rev])
    }

    /// L.1, L.6: the stop is "about to commit": HEAD on the commit's parent, its changes staged,
    /// nothing else; the stop's state names both. A plain Continue keeps the commit git made:
    /// identical but for its committer.
    #[tokio::test]
    async fn the_stop_is_a_soft_reset_and_a_plain_continue_keeps_the_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let t1 = written(&r, "topic~1");
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        assert_eq!(head, r.git(&["rev-parse", "main"]), "HEAD on the commit's parent");
        assert_eq!(staged(&r), "a.txt\nb.txt");
        assert_eq!(r.git(&["diff", "--name-only"]), "", "nothing unstaged");
        let (made, base, message) = stop(&r);
        assert_eq!(base.as_deref(), Some(head.as_str()));
        let made = made.expect("git's amend commit");
        assert_eq!(r.git(&["rev-parse", &format!("{made}^")]), head);
        assert_eq!(message, "T1 Two files\n\nWith a body.\n");
        let res = cont(&api, id, &r, None).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["rev-parse", "topic~1"]), made, "git's own commit");
        assert_eq!(written(&r, "topic~1"), t1);
        assert_eq!(r.git(&["log", "-1", "--format=%cn", "topic~1"]), "Ada Lovelace");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// L.2: a change staged and a new message: Continue commits them as the original's author
    /// (its date too), the committer now; one commit, as the plan had.
    #[tokio::test]
    async fn continue_commits_the_staged_change_as_the_original_author() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        r.write("a.txt", "a, changed\n");
        r.git(&["add", "a.txt"]);
        let res = cont(&api, id, &r, Some("T1 Two files, changed\n\nWhy.")).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done", "{res}");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "topic~1"]), "T1 Two files, changed\n\nWhy.");
        assert_eq!(r.git(&["log", "-1", "--format=%an <%ae> %ad", "--date=raw", "topic~1"]), "Grace Hopper <grace@example.com> 1600000000 +0200");
        assert_eq!(r.git(&["log", "-1", "--format=%cn", "topic~1"]), "Ada Lovelace");
        assert_eq!(r.git(&["show", "topic~1:a.txt"]), "a, changed");
        assert_eq!(r.git(&["rev-list", "--count", "main..topic"]), "2");
    }

    /// L.1, L.2: an Edit row's new message is the box's at the stop (git's commit isn't amended
    /// there); Continue without one commits with it.
    #[tokio::test]
    async fn the_rows_new_message_is_the_boxs_and_continue_commits_with_it() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, Some("T1 Reworded\n\nAt the stop.")).await;
        let (made, _, message) = stop(&r);
        assert_eq!(message, "T1 Reworded\n\nAt the stop.\n");
        assert_eq!(r.git(&["log", "-1", "--format=%s", &made.unwrap()]), "T1 Two files", "git's commit untouched");
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "topic~1"]), "T1 Reworded\n\nAt the stop.");
        assert_eq!(r.git(&["log", "-1", "--format=%an %ad", "--date=raw", "topic~1"]), "Grace Hopper 1600000000 +0200");
    }

    /// L.2, L.4, L.6: split in pieces: one file unstaged, Commit (the rebase stays stopped), the
    /// rest staged again, and Continue with its message. One Undo restores the branch.
    #[tokio::test]
    async fn split_in_pieces_then_continue_and_one_undo() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let before = r.git(&["rev-parse", "topic"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        r.git(&["reset", "-q", "b.txt"]);
        let res = commit(&api, id, &r, "Piece A").await;
        assert_ne!(res["journal"]["undo"]["label"], "commit \"Piece A\"", "part of the paused rebase: {res}");
        assert!(crate::in_progress::read(r.path()).unwrap().is_some(), "still stopped");
        r.git(&["add", "b.txt"]);
        assert_eq!(cont(&api, id, &r, Some("T1 Piece B")).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "--format=%s", "main..topic"]), "T2 After\nT1 Piece B\nPiece A");
        assert_eq!(r.git(&["log", "-1", "--format=%an", "topic~1"]), "Grace Hopper", "Continue's commit: the original's author");
        assert_eq!(r.git(&["log", "-1", "--format=%an", "topic~2"]), "Ada Lovelace", "the piece: the user's own");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "topic"]), before, "one Undo");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// L.2: every change committed in pieces: Continue just goes on.
    #[tokio::test]
    async fn all_committed_in_pieces_continue_just_goes_on() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        r.git(&["reset", "-q", "b.txt"]);
        commit(&api, id, &r, "Piece A").await;
        r.git(&["add", "b.txt"]);
        commit(&api, id, &r, "Piece B").await;
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "--format=%s", "main..topic"]), "T2 After\nPiece B\nPiece A");
    }

    /// L.2: changes left unstaged refuse Continue (git would too), and nothing changes. Skip,
    /// which would reset the stop's changes away, isn't offered there.
    #[tokio::test]
    async fn unstaged_changes_refuse_continue_and_skip_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        r.write("a.txt", "a, unstaged\n");
        let e = cont(&api, id, &r, None).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, super::COMMIT_OR_DISCARD));
        let e = call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "skip" })).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a, unstaged\n");
        assert_eq!(staged(&r), "a.txt\nb.txt");
        assert_eq!((r.git(&["rev-parse", "HEAD"]), stop(&r).1), (head.clone(), Some(head)), "the same stop");
    }

    /// L.4: a reload (a fresh Api on the same data) at the stop reads the same stop, the row's
    /// message in the box; Continue there finishes.
    #[tokio::test]
    async fn a_reload_at_the_stop_reads_the_same_stop() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        {
            let api = api(data.path());
            let id = open(&api, &r).await;
            edit_t1(&api, id, &r, Some("T1 Reworded")).await;
        }
        let api = api(data.path());
        let id = open(&api, &r).await;
        let (_, base, message) = stop(&r);
        assert_eq!((base, message.as_str()), (Some(r.git(&["rev-parse", "HEAD"])), "T1 Reworded\n"));
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "topic~1"]), "T1 Reworded");
    }

    /// L.4: a rebase started in a terminal keeps git's own Edit stop: HEAD on the commit, no
    /// note; GitBolt's Continue goes on with it as it is.
    #[tokio::test]
    async fn a_terminal_rebases_edit_stop_is_gits_own() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        r.git(&["-c", "sequence.editor=sed -i.orig 1s/^pick/edit/", "rebase", "-q", "-i", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        match crate::in_progress::read(r.path()).unwrap() {
            Some(InProgress::Rebase { edit_stop, edit_base, gitbolt, .. }) => assert_eq!((edit_stop, edit_base, gitbolt), (Some(head.clone()), None, false)),
            other => panic!("{other:?}"),
        }
        assert_eq!(staged(&r), "");
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["rev-parse", "topic~1"]), head);
    }

    /// An empty commit set to Edit: nothing to stage, and Continue keeps it (with a typed
    /// message, an empty commit of that message, the author kept).
    #[tokio::test]
    async fn an_empty_commit_set_to_edit_is_kept() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.commit("Base");
        r.switch_new("topic");
        r.git(&["commit", "-q", "--allow-empty", "--author=Grace Hopper <grace@example.com>", "-m", "T1 Empty"]);
        r.commit("T2 After");
        r.switch("main");
        r.commit("Main moves");
        r.switch("topic");
        let api = api(data.path());
        let id = open(&api, &r).await;
        for typed in [None, Some("T1 Empty, typed")] {
            edit_t1(&api, id, &r, None).await;
            assert_eq!(staged(&r), "");
            assert_eq!(cont(&api, id, &r, typed).await.unwrap()["outcome"]["status"], "done");
            assert_eq!(r.git(&["log", "-1", "--format=%s %an", "topic~1"]), format!("{} Grace Hopper", typed.unwrap_or("T1 Empty")));
        }
    }

    const REFUSE_BAD: &str = "#!/bin/sh\nif grep -q BAD \"$1\"; then echo 'Rejected: no BAD messages.' >&2; exit 1; fi\n";

    /// Replaces 3C's M1 test (an amend refused at the stop): the stop amends nothing, so the
    /// row's new message is the box's. A commit-msg hook refusing it at Continue changes
    /// nothing, and says why; Continue with the old message keeps the commit; one Undo.
    #[tokio::test]
    async fn a_hook_refusing_continues_commit_changes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.hook("commit-msg", REFUSE_BAD);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", Some("B2 BAD"));
        let res = start(&api, id, &r, &p, rows, stay(&p)).await.unwrap();
        assert!(res["outcome"].get("warning").is_none(), "{res}");
        assert_eq!(stop(&r).2, "B2 BAD\n");
        let head = r.git(&["rev-parse", "HEAD"]);
        let e = cont(&api, id, &r, None).await.unwrap_err();
        assert!(e.message.starts_with("The commit wasn't made: ") && e.message.contains("Rejected: no BAD messages"), "{}", e.message);
        assert_eq!((r.git(&["rev-parse", "HEAD"]), staged(&r)), (head, "lexer.txt\nlexer_test.txt".to_string()), "as it was");
        assert_eq!(cont(&api, id, &r, Some("B2 Refine lexer")).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/b"]), "B2 Refine lexer");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(tips(&r), before);
    }

    // --- fix round 1 ---
    /// (edit_added, edit_changed) of GitBolt's stop.
    fn added_changed(r: &TestRepo) -> (Vec<String>, bool) {
        match crate::in_progress::read(r.path()).unwrap() {
            Some(InProgress::Rebase { edit_added, edit_changed, .. }) => (edit_added, edit_changed),
            other => panic!("{other:?}"),
        }
    }

    /// 1, 6: the note is written before the reset. One with HEAD still on git's commit (a crash
    /// between the two) reads as git's own stop, and Continue goes on with git's commit as it is.
    #[tokio::test]
    async fn a_note_without_its_reset_is_gits_own_stop() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        let made = stop(&r).0.unwrap();
        r.git(&["reset", "-q", "--soft", &made]);
        assert!(r.path().join(".git").join(crate::in_progress::EDIT_STAGED).is_file());
        assert_eq!(stop(&r).1, None, "no edit_base while HEAD is git's commit");
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["rev-parse", "topic~1"]), made);
    }

    /// 2: Amend at the stop before any piece is committed would fold the commit into its parent:
    /// refused, in plain words. Once a piece is committed, it amends that piece.
    #[tokio::test]
    async fn amend_waits_for_a_piece() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        let amend = |summary: &'static str| call(&api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": summary, "amend": true, "expect": {} }));
        let e = amend("Folded").await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, crate::write::commit::AMEND_AT_EDIT_STOP));
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Main moves", "nothing amended");
        r.git(&["reset", "-q", "b.txt"]);
        commit(&api, id, &r, "Piece A").await;
        amend("Piece A, amended").await.unwrap();
        assert_eq!(r.git(&["log", "-2", "--format=%s"]), "Piece A, amended\nMain moves");
    }

    /// 3: a file of the commit left untracked holds Continue up, by name; an untracked file of
    /// the user's own (`.env`) never does.
    #[tokio::test]
    async fn only_the_commits_own_untracked_files_hold_continue_up() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        assert_eq!(added_changed(&r), (vec!["a.txt".to_string(), "b.txt".to_string()], false));
        r.write(".env", "SECRET=1\n");
        r.git(&["reset", "-q", "b.txt"]);
        assert!(added_changed(&r).1, "the index isn't the commit any more");
        let e = cont(&api, id, &r, None).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "b.txt from this commit isn't staged. Stage it, or discard it, then Continue."));
        r.git(&["add", "b.txt"]);
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(std::fs::read_to_string(r.path().join(".env")).unwrap(), "SECRET=1\n", "the user's file stays");
        assert_eq!(r.git(&["show", "--name-only", "--format=", "topic~1"]), "a.txt\nb.txt");
    }

    /// 7: a Continue cancelled after HEAD went back to git's commit, before git moved on (the
    /// test hook stands for the cancel): the stop is staged again, and a Continue then finishes.
    #[tokio::test]
    async fn a_cancel_after_the_restore_stages_the_stop_again() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        let (made, base, _) = stop(&r);
        super::test_hook::cancel_at(r.path());
        assert_eq!(cont(&api, id, &r, None).await.unwrap_err().kind, GbErrorKind::Cancelled);
        assert_eq!(Some(r.git(&["rev-parse", "HEAD"])), base, "back on the commit's parent");
        assert_eq!(stop(&r), (made.clone(), base, "T1 Two files\n\nWith a body.\n".to_string()));
        assert_eq!(staged(&r), "a.txt\nb.txt");
        assert_eq!(cont(&api, id, &r, None).await.unwrap()["outcome"]["status"], "done");
        assert_eq!(r.git(&["rev-parse", "topic~1"]), made.unwrap());
    }

    /// 5: a staged edit whose worktree file was put back is in the index alone: the stop's state
    /// says it changed, and Abort keeps it, in the stash's index part.
    #[tokio::test]
    async fn abort_keeps_a_staged_edit_whose_file_was_put_back() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        topic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        edit_t1(&api, id, &r, None).await;
        r.write("a.txt", "a, staged only\n");
        r.git(&["add", "a.txt"]);
        r.write("a.txt", "a\n");
        assert!(added_changed(&r).1);
        let res = call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "abort" })).await.unwrap();
        let stash = res["outcome"]["stash"].as_str().unwrap_or_else(|| panic!("a stash: {res}")).to_string();
        assert_eq!(r.git(&["show", &format!("{stash}^2:a.txt")]), "a, staged only");
    }
    // --- end fix round 1 ---
}
