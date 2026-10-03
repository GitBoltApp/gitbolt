//! Split this commit (spec #3 §3.5). At an Edit stop, `git reset HEAD^` (mixed) turns the stopped
//! commit's changes into unstaged work; the user commits them again in pieces, then Continues.
//! It's part of the paused rebase (Ruling 9): not journaled, and Abort restores the commit.

use crate::api::{blocking, Api};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::in_progress::InProgress;
use crate::journal::UndoKind;
use crate::status::EntryKind;
use crate::write::types::WriteResult;
use crate::write::{is_ancestor, run_write, Plan, Pre, WriteCx, WriteIntent};

pub(crate) struct SplitIntent;

/// Fix round 1 (M4): an Edit stop of a rebase started outside GitBolt.
pub(crate) const NOT_OURS: &str = "Finish this rebase where you started it.";

/// The worktree's paused entry is GitBolt's interactive rebase (it carries the session).
pub(crate) fn gitbolt_owns_the_pause(pre: &Pre<'_>) -> Result<bool, GbError> {
    let journal = pre.api.journal(pre.root)?.load()?;
    Ok(journal.paused().and_then(|e| e.paused.as_ref()).is_some_and(|p| p.irebase.is_some()))
}

fn refuse<T>(m: &str) -> Result<T, GbError> {
    Err(GbError::new(GbErrorKind::InvalidInput, m))
}

impl WriteIntent for SplitIntent {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Rebase
    }
    fn label(&self) -> String {
        "split the stopped commit".into()
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let Some(InProgress::Rebase { edit_stop: Some(at), conflicted: 0, .. }) = crate::in_progress::read(pre.root)? else { return refuse("Split works at an Edit stop") };
        if !gitbolt_owns_the_pause(pre)? {
            return refuse(NOT_OURS);
        }
        if pre.before.head.oid.as_deref() != Some(at.as_str()) {
            return refuse("HEAD moved since the stop: only the stopped commit can be split");
        }
        let entries = crate::status::status(&pre.api.cli, pre.root).await?;
        if entries.iter().any(|e| matches!(e.kind, EntryKind::Ordinary | EntryKind::Renamed) && e.index != '.') {
            return refuse("Unstage your changes first");
        }
        let root = pre.root.to_path_buf();
        let parents = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.head_commit().map_err(gix_err)?.parent_ids().count())).await?;
        match parents {
            0 => refuse("The first commit can't be split"),
            1 => Ok(Plan::default()),
            _ => refuse("A merge commit can't be split"),
        }
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["reset", "-q", "HEAD^"]);
        cx.run_git(inv).await?;
        for k in [ChangeKind::Head, ChangeKind::Index, ChangeKind::Worktree] {
            cx.touch(k);
        }
        Ok(())
    }
}

pub(crate) async fn split(api: &Api, repo: u32, worktree: &str) -> Result<WriteResult<()>, GbError> {
    run_write(api, repo, worktree, Default::default(), SplitIntent).await
}

/// A commit made at an Edit stop (Split's pieces, through `Commit`) goes on the paused entry, so
/// the settle that ends the rebase counts it as the rebase's own (it's newly authored, unlike
/// every replayed commit) rather than as someone else's work.
pub(crate) fn record_made(cx: &WriteCx<'_>, oid: &str) -> Result<(), GbError> {
    cx.api.journal(cx.root)?.update(|j| {
        if let Some(id) = j.paused().map(|e| e.id)
            && let Some(s) = j.entry_mut(id).and_then(|e| e.paused.as_mut()).and_then(|p| p.irebase.as_mut())
        {
            s.made.push(oid.to_string());
        }
    })?;
    Ok(())
}

/// An untracked file `clear_leftovers` removed.
pub(crate) struct Leftover {
    path: String,
    blob: gix::ObjectId,
    executable: bool,
}

/// Before an Abort of a rebase that was split: git won't overwrite an untracked file with the
/// commit `rebase --abort` goes back to (`rebase-merge/orig-head`), and a Split piece never
/// committed again is one. A file with exactly that commit's content is the commit's own: it
/// goes, and the abort writes it back. Any other file stays, and git refuses the abort. Returns
/// what went, for `put_back` if the abort fails.
pub(crate) async fn clear_leftovers(cx: &WriteCx<'_>) -> Result<Vec<Leftover>, GbError> {
    let untracked: Vec<String> = crate::status::status(&cx.api.cli, cx.root).await?.into_iter().filter(|e| e.kind == EntryKind::Untracked).map(|e| e.path).collect();
    if untracked.is_empty() {
        return Ok(Vec::new());
    }
    let root = cx.root.to_path_buf();
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let Ok(orig) = std::fs::read_to_string(repo.git_dir().join("rebase-merge/orig-head")) else { return Ok(Vec::new()) };
        let Ok(orig) = gix::ObjectId::from_hex(orig.trim().as_bytes()) else { return Ok(Vec::new()) };
        let tree = repo.find_commit(orig).map_err(gix_err)?.tree().map_err(gix_err)?;
        let mut gone = Vec::new();
        // M1: an error part-way puts back what already went.
        let each = |path: String, gone: &mut Vec<Leftover>| -> Result<(), GbError> {
            let Some(entry) = tree.lookup_entry_by_path(path.as_str()).map_err(gix_err)? else { return Ok(()) };
            if !(entry.mode().is_blob() || entry.mode().is_executable()) {
                return Ok(());
            }
            let file = root.join(&path);
            if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
                return Ok(());
            }
            let blob = entry.object().map_err(gix_err)?;
            if std::fs::read(&file).ok().as_deref() != Some(&blob.data[..]) {
                return Ok(());
            }
            std::fs::remove_file(&file).map_err(|e| GbError::new(GbErrorKind::Io, format!("{}: {e}", file.display())))?;
            gone.push(Leftover { path, blob: entry.object_id(), executable: entry.mode().is_executable() });
            Ok(())
        };
        for path in untracked {
            if let Err(e) = each(path, &mut gone) {
                put_back(&root, &gone);
                return Err(e);
            }
        }
        Ok(gone)
    })
    .await
}

/// What an Abort keeps of the work done at the stop (fix round 2, I2): commits on a branch, the
/// worktree's edits in a stash, and the journal's kept-stash record for that stash.
pub(crate) struct KeptWork {
    /// The stash of the worktree's edits (its oid), listed before the abort.
    pub stash: Option<String>,
    /// `<branch>-rebase-work`, at HEAD: the commits made at the stop.
    pub branch: Option<String>,
    /// A conflict stop: the files whose changes the abort discards (git's own semantics).
    pub discarded: Option<u32>,
    record: Option<u64>,
    head: Option<String>,
    /// The worktree's status before the abort (`--porcelain=v2`, with index oids): an abort
    /// that failed after resetting files changed it.
    status: Vec<u8>,
}

/// The commits HEAD has beyond `onto` that aren't a replay of one of `orig`'s: authored at the
/// stop (by GitBolt's Commit or in a terminal). As settle's completion check, by author and time.
fn new_commits(repo: &gix::Repository, head: gix::ObjectId, orig: gix::ObjectId, onto: gix::ObjectId) -> Result<bool, GbError> {
    let authored = |tip: gix::ObjectId| -> Result<std::collections::BTreeSet<(Vec<u8>, String)>, GbError> {
        let mut out = std::collections::BTreeSet::new();
        for info in repo.rev_walk([tip]).with_hidden([onto]).all().map_err(gix_err)? {
            let c = repo.find_commit(info.map_err(gix_err)?.id).map_err(gix_err)?;
            let a = c.author().map_err(gix_err)?;
            out.insert((a.email.to_vec(), a.time.to_string()));
        }
        Ok(out)
    };
    Ok(!authored(head)?.is_subset(&authored(orig)?))
}

/// Before an Abort of GitBolt's interactive rebase (I2, fix round 2): `rebase --abort` resets the
/// worktree, index and HEAD to where the rebase started. What was done at the stop is kept first,
/// each kind by what fits it:
/// - commits made there (`made`, or any HEAD has that isn't a replay): a real branch at HEAD,
///   `<branch>-rebase-work` (`-2`, `-3`… when taken). GitBolt never deletes it: it isn't in an
///   undoable entry (the abort has none, and the paused entry's settle doesn't record it).
/// - the worktree's tracked edits: a stash (`git stash create`), unless its tree is the stop's
///   commit's own (a Split, then nothing new). Listed before the abort, so it's reachable.
///
/// A conflict stop's unmerged index can't be stashed: those changes go with the abort, as git's
/// own abort does, and `discarded` says how many files. Undone by `finish_kept_work` if the
/// abort fails.
pub(crate) async fn keep_work(cx: &mut WriteCx<'_>, s: &crate::journal::IrebaseState) -> Result<KeptWork, GbError> {
    let mut w = KeptWork { stash: None, branch: None, discarded: None, record: None, head: cx.before.head.oid.clone(), status: Vec::new() };
    let Some(InProgress::Rebase { edit_stop, head_name, onto, .. }) = crate::in_progress::read(cx.root)? else { return Ok(w) };
    let short = crate::error::short_ref(&head_name).to_string();
    // Commits.
    let (root, head, made) = (cx.root.to_path_buf(), w.head.clone(), !s.made.is_empty());
    let (keep, stop_tree) = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let oid = |h: &str| gix::ObjectId::from_hex(h.trim().as_bytes()).ok();
        let orig = std::fs::read_to_string(repo.git_dir().join("rebase-merge/orig-head")).ok().and_then(|t| oid(&t));
        let head = head.as_deref().and_then(oid);
        let stop = edit_stop.as_deref().and_then(oid);
        // Fix round 3: at an Edit stop, HEAD off the stop's commit is work too (a terminal amend
        // or `commit -C` keeps author and time, so it reads as a replay), unless HEAD is only
        // below it (a Split: its content is the worktree's, judged against the stop's tree).
        let moved = matches!((head, stop), (Some(h), Some(st)) if h != st && !is_ancestor(&repo, h, st));
        let keep = made
            || moved
            || match (head, orig, oid(&onto)) {
                (Some(h), Some(o), Some(b)) => new_commits(&repo, h, o, b)?,
                _ => false,
            };
        let stop_tree = stop.and_then(|o| repo.find_commit(o).ok()).and_then(|c| c.tree_id().ok()).map(|t| t.to_string());
        Ok((keep, stop_tree))
    })
    .await?;
    if let (true, Some(head)) = (keep, w.head.clone()) {
        w.branch = Some(work_branch(cx, &short, &head).await?);
    }
    // Edits.
    // 3C final fix (M5): a failure here takes the work branch back, as the later ones do.
    w.status = match crate::status::status_raw(&cx.api.cli, cx.root).await {
        Ok(s) => s,
        Err(e) => {
            finish_kept_work(cx, &w, false).await;
            return Err(e);
        }
    };
    let entries = crate::status::parse_porcelain_v2(&w.status);
    let changed = entries.iter().any(|e| matches!(e.kind, EntryKind::Ordinary | EntryKind::Renamed));
    if entries.iter().any(|e| e.kind == EntryKind::Unmerged) {
        // Fix round 3: the conflicted files and the user's unstaged edits, not what git merged
        // cleanly (it's in the commit being replayed).
        let lost = entries.iter().filter(|e| e.kind == EntryKind::Unmerged || (matches!(e.kind, EntryKind::Ordinary | EntryKind::Renamed) && e.worktree != '.')).count();
        w.discarded = Some(lost as u32);
    } else if changed {
        let message = format!("GitBolt: work from the aborted rebase of {short}");
        let created = match cx.run_git(cx.git(["stash", "create", message.as_str()])).await {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(e) => {
                finish_kept_work(cx, &w, false).await;
                return Err(e);
            }
        };
        let tree = if created.is_empty() {
            None
        } else {
            let spec = format!("{created}^{{tree}}");
            cx.run_git(cx.git(["rev-parse", spec.as_str()])).await.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        };
        if !created.is_empty() && tree != stop_tree {
            let k = crate::journal::KeptStash {
                id: 0,
                oid: Some(created.clone()),
                stash_before: None,
                message: message.clone(),
                label: format!("abort the rebase of {short}"),
                // Fix round 3: the branch the commits went on, for the banner.
                target: w.branch.clone(),
                reason: crate::journal::KeptReason::AbortRunning,
                created_ms: cx.api.now(),
                owner: Some(cx.api.owner()?),
            };
            match cx.api.journal(cx.root).and_then(|j| j.update(|j| j.keep(k))) {
                Ok(id) => w.record = Some(id),
                Err(e) => {
                    finish_kept_work(cx, &w, false).await;
                    return Err(e);
                }
            }
            cx.journal_changed = true;
            let inv = cx.git_stash(["stash", "store", "-m", message.as_str(), created.as_str()]);
            let stored = cx.run_git(inv).await;
            cx.touch(ChangeKind::Stash);
            w.stash = Some(created);
            if let Err(e) = stored {
                finish_kept_work(cx, &w, false).await;
                return Err(e);
            }
        }
    }
    Ok(w)
}

/// `<branch>-rebase-work` at `head` (`-2`, `-3`… when that name, or one below it, is taken: a
/// failed create tries the next one, fix round 3).
async fn work_branch(cx: &mut WriteCx<'_>, short: &str, head: &str) -> Result<String, GbError> {
    let mut last = None;
    for n in 1..=20 {
        let name = if n == 1 { format!("{short}-rebase-work") } else { format!("{short}-rebase-work-{n}") };
        let m = crate::journal::RefMove { name: format!("refs/heads/{name}"), old: None, new: Some(head.to_string()) };
        match cx.cas(&[m], "rebase: keep the commits made at the stop").await {
            Ok(()) => {
                cx.touch(ChangeKind::Refs);
                return Ok(name);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| GbError::other("no free name for the work branch")))
}

/// After the Abort: it ran (`ok`), so the stash's record becomes the "work from the stop"
/// banner; or it failed, and nothing was reset: the stash entry is dropped and the branch
/// deleted again (the work is still in the worktree and at HEAD), and the record goes.
pub(crate) async fn finish_kept_work(cx: &mut WriteCx<'_>, w: &KeptWork, ok: bool) {
    if !ok {
        if let Some(oid) = &w.stash {
            let listed = crate::write::stash::stash_list(&cx.api.cli, cx.root).await.unwrap_or_default();
            if let Some(n) = listed.iter().position(|(o, _)| o == oid)
                && let Err(e) = crate::write::stash::drop_at(cx, n, oid, false).await
            {
                tracing::warn!(target: "gitbolt_core::write", "dropping the stash {oid} after a failed abort: {e}");
            }
        }
        if let (Some(name), Some(head)) = (&w.branch, &w.head) {
            let m = crate::journal::RefMove { name: format!("refs/heads/{name}"), old: Some(head.clone()), new: None };
            if let Err(e) = cx.cas(&[m], "rebase: the abort failed; its work branch goes").await {
                tracing::warn!(target: "gitbolt_core::write", "deleting {name} after a failed abort: {e}");
            }
            cx.touch(ChangeKind::Refs);
        }
    }
    let Some(id) = w.record else { return };
    let res = cx.api.journal(cx.root).and_then(|store| {
        store.update(|j| {
            if ok {
                if let Some(k) = j.kept_mut(id) {
                    k.reason = crate::journal::KeptReason::AbortedWork;
                    k.owner = None;
                }
            } else {
                j.kept.retain(|k| k.id != id);
            }
        })
    });
    if let Err(e) = res {
        tracing::warn!(target: "gitbolt_core::write", "the kept work's record: {e}");
    }
    cx.journal_changed = true;
}

/// Fix round 3: an abort that failed reset nothing only if the rebase is still in progress,
/// HEAD is still where it was at the stop, and the worktree is as it was (its status, and the
/// stash's tree for the edits' content). Otherwise git got part-way: the work's stash and branch
/// stay, and the error says where they are. Anything unreadable counts as touched.
pub(crate) async fn untouched(cx: &WriteCx<'_>, w: &KeptWork) -> bool {
    let head = gix::open(cx.root).ok().and_then(|r| r.head_id().ok().map(|h| h.to_string()));
    if !matches!(crate::in_progress::read(cx.root), Ok(Some(InProgress::Rebase { .. }))) || head != w.head {
        return false;
    }
    if crate::status::status_raw(&cx.api.cli, cx.root).await.ok().as_ref() != Some(&w.status) {
        return false;
    }
    let Some(stash) = &w.stash else { return true };
    let tree = |spec: String| async move { cx.api.cli.run(crate::git::GitInvocation::new(cx.root, ["rev-parse", spec.as_str()])).await.ok().map(|o| o.stdout) };
    let now = match cx.api.cli.run(crate::git::GitInvocation::new(cx.root, ["stash", "create"])).await {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return false,
    };
    !now.is_empty() && tree(format!("{now}^{{tree}}")).await == tree(format!("{stash}^{{tree}}")).await
}

/// Where a part-way abort left the work (fix round 3).
pub(crate) fn kept_error(e: GbError, w: &KeptWork) -> GbError {
    let mut kept = Vec::new();
    if let Some(b) = &w.branch {
        kept.push(format!("its commits are on {b}"));
    }
    if w.stash.is_some() {
        kept.push("its edits are in stash \"GitBolt: work from the aborted rebase\"".to_string());
    }
    if kept.is_empty() {
        return e;
    }
    let message = format!("{} The work from the stop is kept: {}.", e.message, kept.join(", "));
    GbError { message, detail: Some(crate::error::ErrorDetail::AbortKeptWork { stash: w.stash.as_deref().map(Into::into), branch: w.branch.as_deref().map(Into::into) }), ..e }
}

/// The abort failed: the files `clear_leftovers` removed come back, from their blobs.
pub(crate) fn put_back(root: &std::path::Path, gone: &[Leftover]) {
    let Ok(repo) = gix::open(root) else { return };
    for l in gone {
        let file = root.join(&l.path);
        let res = repo.find_object(l.blob).map_err(|e| e.to_string()).and_then(|o| std::fs::write(&file, &o.data).map_err(|e| e.to_string()));
        #[cfg(unix)]
        let res = res.and_then(|_| {
            use std::os::unix::fs::PermissionsExt;
            if l.executable { std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string()) } else { Ok(()) }
        });
        if let Err(e) = res {
            tracing::warn!(target: "gitbolt_core::write", "putting {} back after a failed abort: {e}", file.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::{fixtures, TestRepo};
    use crate::write::irebase::run::tests::{control, picks, plan, set, start, stay, subjects, tips};
    use crate::write::test_support::{api, call, journal_step, open, wt};
    use serde_json::json;

    async fn stop_at_b2(api: &crate::api::Api, id: u32, r: &TestRepo) {
        let p = plan(api, id, r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "B2", "edit", None);
        assert_eq!(start(api, id, r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
    }

    async fn split(api: &crate::api::Api, id: u32, r: &TestRepo) -> Result<serde_json::Value, crate::error::GbError> {
        call(api, "splitCommit", json!({ "repo": id, "worktree": wt(r.path()) })).await
    }

    async fn commit(api: &crate::api::Api, id: u32, r: &TestRepo, summary: &str) -> serde_json::Value {
        call(api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": summary, "expect": {} })).await.unwrap()
    }

    /// §3.5, §7 (e2e 2's core): split B2, commit it in two pieces, Continue; feature/b follows
    /// the last piece, and one Undo restores the original history.
    #[tokio::test]
    async fn split_then_commit_pieces_then_continue() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        let stopped = r.git(&["rev-parse", "HEAD"]);
        split(&api, id, &r).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD"]), r.git(&["rev-parse", &format!("{stopped}^")]));
        assert_eq!(r.git(&["status", "--porcelain"]), "?? lexer.txt\n?? lexer_test.txt");
        r.git(&["add", "lexer.txt"]);
        let res = commit(&api, id, &r, "Lexer").await;
        assert_ne!(res["journal"]["undo"]["label"], "commit \"Lexer\"", "a commit at the stop is part of the paused rebase");
        r.git(&["add", "lexer_test.txt"]);
        commit(&api, id, &r, "Lexer tests").await;
        assert_eq!(control(&api, id, &r, "continue").await["outcome"]["status"], "done");
        let s = subjects(&r, "main..feature/c");
        assert_eq!(&s[2..4], ["Lexer tests", "Lexer"], "{s:?}");
        assert!(!s.iter().any(|x| x.starts_with("B2")));
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature/b"]), "Lexer tests");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(tips(&r), before);
    }

    async fn abort(api: &crate::api::Api, id: u32, r: &TestRepo) -> Result<serde_json::Value, crate::error::GbError> {
        call(api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "abort" })).await
    }

    fn branch_at(r: &TestRepo, name: &str) -> Option<String> {
        r.try_git(&["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).ok()
    }

    /// Fix round 2 (test 3): a Split, then Abort with nothing new: nothing is kept.
    #[tokio::test]
    async fn split_then_abort_restores_the_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        split(&api, id, &r).await.unwrap();
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["status"], "aborted");
        assert!(res["outcome"]["stash"].is_null() && res["outcome"]["branch"].is_null(), "{res}");
        assert_eq!(tips(&r), before);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// Fix round 2 (test 3): C1's Split leaves its change to a tracked file in the worktree,
    /// exactly the stopped commit's content: no stash, no branch.
    #[tokio::test]
    async fn a_split_of_a_tracked_change_then_abort_keeps_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "C1", "edit", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        split(&api, id, &r).await.unwrap();
        assert!(r.git(&["status", "--porcelain"]).contains("notes.txt"));
        let res = abort(&api, id, &r).await.unwrap();
        assert!(res["outcome"]["stash"].is_null() && res["outcome"]["branch"].is_null(), "{res}");
        assert_eq!(r.git(&["stash", "list"]), "");
        assert_eq!(tips(&r), before);
    }

    /// Fix round 2 (test 4): an abort git refuses (an edited, untracked Split piece) resets
    /// nothing, so what was kept for it goes again: the stash entry and the work branch.
    #[tokio::test]
    async fn abort_never_removes_an_edited_piece() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        split(&api, id, &r).await.unwrap();
        r.git(&["add", "lexer.txt"]);
        commit(&api, id, &r, "Lexer").await;
        r.write("lexer.txt", "lexer, edited at the stop\n");
        r.write("lexer_test.txt", "my edit\n");
        let e = abort(&api, id, &r).await.unwrap_err();
        assert!(e.stderr.as_deref().unwrap_or_default().contains("lexer_test.txt"), "{e:?}");
        assert_eq!(std::fs::read_to_string(r.path().join("lexer_test.txt")).unwrap(), "my edit\n");
        assert_eq!(std::fs::read_to_string(r.path().join("lexer.txt")).unwrap(), "lexer, edited at the stop\n");
        assert!(crate::in_progress::read(r.path()).unwrap().is_some(), "still paused");
        assert_eq!(r.git(&["stash", "list"]), "", "the stash entry went again");
        assert_eq!(branch_at(&r, "feature/c-rebase-work"), None, "and the work branch");
        let state = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(state["banners"], json!([]), "{state}");
    }

    /// Fix round 2 (test 1): Split, commit one piece, edit it again, Abort. The piece is on
    /// `feature/c-rebase-work`, the edit in a kept stash; the branches are restored. Applying
    /// the stash brings the edit back and leaves the work branch alone.
    #[tokio::test]
    async fn abort_keeps_commits_on_a_branch_and_edits_in_a_stash() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        split(&api, id, &r).await.unwrap();
        r.git(&["add", "lexer.txt"]);
        let piece = commit(&api, id, &r, "Lexer").await["outcome"]["oid"].as_str().unwrap().to_string();
        r.write("lexer.txt", "lexer, edited at the stop\n");
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["status"], "aborted");
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work");
        assert_eq!(branch_at(&r, "feature/c-rebase-work").as_deref(), Some(piece.as_str()));
        let stash = res["outcome"]["stash"].as_str().expect("a stash").to_string();
        assert_eq!(tips(&r), before);
        assert_eq!(r.git(&["stash", "list", "--format=%H %gs"]), format!("{stash} GitBolt: work from the aborted rebase of feature/c"));
        assert_eq!(r.git(&["show", &format!("{stash}:lexer.txt")]), "lexer, edited at the stop");
        let banners = &res["journal"]["banners"];
        assert_eq!(banners[0]["kind"], "abortedWork", "{banners}");
        assert_eq!(banners[0]["stash"], stash.as_str());
        call(&api, "applyKeptStash", json!({ "repo": id, "worktree": wt(r.path()), "entry": banners[0]["entry"] })).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("lexer.txt")).unwrap(), "lexer, edited at the stop\n");
        assert_eq!(branch_at(&r, "feature/c-rebase-work").as_deref(), Some(piece.as_str()), "Apply leaves the branch");
    }

    /// Fix round 2 (test 2): a commit made at an earlier Edit stop, then a conflict stop, then
    /// Abort: the commit is on the work branch; the conflicted file's changes go, as git's own
    /// abort does, and the outcome counts them.
    #[tokio::test]
    async fn a_conflict_stop_abort_keeps_the_earlier_stops_commit_on_a_branch() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let mut rows = crate::write::irebase::run::tests::order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        set(&p, &mut rows, "A1", "edit", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        r.write("extra.txt", "extra\n");
        r.git(&["add", "extra.txt"]);
        let made = commit(&api, id, &r, "Extra at the stop").await["outcome"]["oid"].as_str().unwrap().to_string();
        assert_eq!(control(&api, id, &r, "continue").await["outcome"]["status"], "stopped", "C1 conflicts");
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work", "{res}");
        assert!(r.try_git(&["merge-base", "--is-ancestor", &made, "feature/c-rebase-work"]).is_ok());
        assert!(res["outcome"]["stash"].is_null(), "{res}");
        assert_eq!(res["outcome"]["discarded"], 1);
        assert_eq!(tips(&r), before);
    }

    /// Fix round 3 (1): an amend made in a terminal at the Edit stop keeps author and time, so
    /// it reads as a replay; HEAD off the stop's commit keeps it on the work branch all the same.
    #[tokio::test]
    async fn a_terminal_amend_at_the_stop_is_kept_on_the_work_branch() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        r.write("lexer.txt", "lexer, amended\n");
        r.git(&["commit", "-q", "-a", "--amend", "-m", "x"]);
        let amended = r.git(&["rev-parse", "HEAD"]);
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work", "{res}");
        assert_eq!(branch_at(&r, "feature/c-rebase-work").as_deref(), Some(amended.as_str()));
        assert_eq!(tips(&r), before);
    }

    /// Fix round 3 (2): an abort that fails after git reset the worktree (here `HEAD.lock` is
    /// held, so git can't move HEAD back) keeps the stash and the work branch, and the error
    /// says where they are.
    #[tokio::test]
    async fn an_abort_that_fails_part_way_keeps_the_work() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        split(&api, id, &r).await.unwrap();
        r.git(&["add", "lexer.txt"]);
        let piece = commit(&api, id, &r, "Lexer").await["outcome"]["oid"].as_str().unwrap().to_string();
        r.write("lexer.txt", "lexer, edited at the stop\n");
        let lock = r.path().join(".git/HEAD.lock");
        std::fs::write(&lock, "").unwrap();
        let e = abort(&api, id, &r).await.unwrap_err();
        std::fs::remove_file(&lock).unwrap();
        let detail = serde_json::to_value(&e.detail).unwrap();
        assert_eq!(detail["kind"], "abortKeptWork", "{e:?}");
        assert_eq!(detail["branch"], "feature/c-rebase-work");
        assert!(e.message.contains("its commits are on feature/c-rebase-work"), "{}", e.message);
        assert_eq!(branch_at(&r, "feature/c-rebase-work").as_deref(), Some(piece.as_str()));
        let stash = detail["stash"].as_str().expect("the stash stays").to_string();
        assert!(r.git(&["stash", "list", "--format=%H"]).contains(&stash));
        assert_eq!(r.git(&["show", &format!("{stash}:lexer.txt")]), "lexer, edited at the stop");
    }

    /// Fix round 3 (minor): a ref below the work branch's name (`…-rebase-work/x`) takes the
    /// next suffix rather than refusing the Abort; the kept stash's banner names the branch.
    #[tokio::test]
    async fn a_taken_work_branch_name_takes_the_next_suffix() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        r.git(&["branch", "feature/c-rebase-work/x", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        split(&api, id, &r).await.unwrap();
        r.git(&["add", "lexer.txt"]);
        commit(&api, id, &r, "Lexer").await;
        r.write("lexer.txt", "lexer, edited at the stop\n");
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work-2", "{res}");
        assert_eq!(res["journal"]["banners"][0]["target"], "feature/c-rebase-work-2");
    }

    /// Fix round 1 (M4): an Edit stop of a rebase started in a terminal takes no commit and no
    /// Split from GitBolt.
    #[tokio::test]
    async fn a_terminal_rebases_edit_stop_is_finished_there() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.commit("base");
        r.commit("second");
        r.git(&["-c", "sequence.editor=sed -i 1s/^pick/edit/", "rebase", "-q", "-i", "HEAD~1"]);
        r.write("extra.txt", "x\n");
        r.git(&["add", "extra.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": "x", "expect": {} })).await.unwrap_err();
        assert_eq!(e.message, "Finish this rebase where you started it.");
        r.git(&["reset", "-q", "extra.txt"]);
        assert_eq!(split(&api, id, &r).await.unwrap_err().message, "Finish this rebase where you started it.");
    }

    #[tokio::test]
    async fn split_is_refused_off_an_edit_stop_or_with_staged_changes() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        assert_eq!(split(&api, id, &r).await.unwrap_err().message, "Split works at an Edit stop");
        stop_at_b2(&api, id, &r).await;
        r.write("lexer.txt", "edited at the stop\n");
        r.git(&["add", "lexer.txt"]);
        assert_eq!(split(&api, id, &r).await.unwrap_err().message, "Unstage your changes first");
    }

    /// A conflict stop still refuses a commit (2D's rule): only an Edit stop takes one.
    #[tokio::test]
    async fn a_commit_is_refused_at_a_conflict_stop() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let p = plan(&api, id, &r).await;
        let rows = crate::write::irebase::run::tests::order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        r.write("notes.txt", "resolved\n");
        r.git(&["add", "notes.txt"]);
        let e = call(&api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": "x", "expect": {} })).await.unwrap_err();
        assert!(e.message.contains("rebase"), "{}", e.message);
    }
}
