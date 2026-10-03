//! Commit (spec #2 §8): the commit box's Commit, "Stage all & commit" and Amend, and the details
//! panel's edit of the HEAD message. `git commit -F -`: git applies `commit.cleanup`, the hooks
//! and signing; hook output streams to Activity, a failing hook is `HookFailed`.

use crate::api::{blocking, Api};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::{GitCli, GitInvocation};
use crate::journal::UndoKind;
use crate::status::EntryKind;
use crate::write::types::{Expect, WriteResult};
use crate::write::{head_state, run_write, Plan, Pre, WriteCx, WriteIntent};
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommitOutcome {
    /// The new HEAD (the graph selects it, §8.1).
    pub oid: String,
}

/// §8.1: the summary, plus a blank line and the description when there is one. The UI has already
/// normalised the draft (§8.2); git's `whitespace` cleanup does the rest.
pub(crate) fn message(summary: &str, description: &str) -> String {
    if description.trim().is_empty() { summary.to_string() } else { format!("{summary}\n\n{description}") }
}

fn summary_of(message: &str) -> &str {
    message.lines().next().unwrap_or_default()
}

fn head_oid(root: &Path) -> Result<String, GbError> {
    Ok(gix::open(root).map_err(gix_err)?.head_id().map_err(gix_err)?.to_string())
}

/// MoveRefs on a branch; MoveHead on a detached HEAD (Deviation 9). Decided in `plan`, which runs
/// before the journal entry is written.
fn undo_for(detached: &OnceLock<bool>) -> Option<UndoKind> {
    Some(if detached.get() == Some(&true) { UndoKind::MoveHead } else { UndoKind::MoveRefs })
}

fn note_detached(pre: &Pre<'_>, detached: &OnceLock<bool>) {
    let _ = detached.set(pre.before.head.branch.is_none() && pre.before.head.oid.is_some());
}

pub(crate) struct Commit {
    pub summary: String,
    pub description: String,
    pub amend: bool,
    pub stage_all: bool,
    detached: OnceLock<bool>,
}

async fn write_tree(cx: &mut WriteCx<'_>) -> Result<String, GbError> {
    let inv = cx.git(["write-tree"]);
    Ok(String::from_utf8_lossy(&cx.run_git(inv).await?.stdout).trim().to_string())
}

/// Sets a field of this write's journal entry.
fn record(cx: &WriteCx<'_>, set: impl FnOnce(&mut crate::journal::JournalEntry)) -> Result<(), GbError> {
    if let Some((store, id)) = cx.entry() {
        store.update(|j| {
            if let Some(e) = j.entry_mut(id) {
                set(e);
            }
        })?;
    }
    Ok(())
}

impl Commit {
    /// "Stage all & commit" (§8.1): the index as a tree into the entry (`index_before`, §5.3),
    /// then `git add -A`. Returns the index's trees before and after.
    ///
    /// Known gap (review m4): `write-tree` leaves intent-to-add (`git add -N`) entries out, so
    /// after an undo such a path is untracked again rather than intent-to-add; its file is kept.
    async fn stage_everything(&self, cx: &mut WriteCx<'_>) -> Result<(String, String), GbError> {
        let before = write_tree(cx).await?;
        let kept = before.clone();
        record(cx, |e| e.index_before = Some(kept))?;
        // git writes the index only when `add` succeeds: a failure leaves it as it was.
        let inv = cx.git(["add", "-A"]);
        cx.run_git(inv).await?;
        Ok((before, write_tree(cx).await?))
    }

    /// Deviation 8: the pre-commit index back after a failed "Stage all & commit". A two-way
    /// `read-tree -m -i <after> <before>` changes only what `add -A` staged, and refuses rather
    /// than overwrite an entry a hook changed since; `-i`: the worktree isn't compared or touched.
    /// If it can't, the entry is kept (`partial`, with `index_after`) so Undo can still do it.
    async fn read_back(&self, cx: &mut WriteCx<'_>, before: &str, after: &str) {
        let back = cx.git(["read-tree", "-m", "-i", after, before]);
        if let Err(e) = cx.run_git(back).await {
            tracing::warn!(target: "gitbolt_core::write", "reading the index back after a failed commit: {e}");
            let after = after.to_string();
            if record(cx, |e| e.index_after = Some(after)).is_ok() {
                cx.partial = true;
            }
        }
        cx.touch(ChangeKind::Index);
    }
}

/// "Resolve 2 conflicted files first" (§8.1's disabled reason).
fn resolve_first(n: usize) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, format!("Resolve {n} conflicted {} first", if n == 1 { "file" } else { "files" }))
}

impl WriteIntent for Commit {
    type Outcome = CommitOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        format!("{} \"{}\"", if self.amend { "amend" } else { "commit" }, self.summary)
    }
    fn undo(&self) -> Option<UndoKind> {
        undo_for(&self.detached)
    }
    fn rewrite(&self) -> Option<crate::write::rewrites::RewriteKind> {
        self.amend.then_some(crate::write::rewrites::RewriteKind::Amend)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    /// In a merge, Commit makes the merge commit (§13.2); any other operation refuses it in `plan`.
    fn allowed_in_progress(&self) -> bool {
        true
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(what) = pre.before.in_progress
            && what != "merge"
        {
            return Err(GbError::in_progress(what));
        }
        if self.summary.trim().is_empty() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Write a commit summary"));
        }
        if self.amend && (self.stage_all || pre.before.head.oid.is_none()) {
            return Err(GbError::new(GbErrorKind::InvalidInput, if self.stage_all { "Amend doesn't stage everything" } else { "Nothing to amend" }));
        }
        let merging = pre.before.in_progress == Some("merge");
        if merging && self.amend {
            return Err(GbError::in_progress("merge"));
        }
        // What git would refuse with a generic error (its "nothing to commit" is on stdout).
        let entries = crate::status::status(&pre.api.cli, pre.root).await?;
        let conflicted = entries.iter().filter(|e| e.kind == EntryKind::Unmerged).count();
        if conflicted > 0 {
            return Err(resolve_first(conflicted));
        }
        // A merge commits even with nothing staged (its result may equal HEAD's tree).
        if !self.amend && !merging {
            let staged = entries.iter().any(|e| matches!(e.kind, EntryKind::Ordinary | EntryKind::Renamed) && e.index != '.');
            let changed = entries.iter().any(|e| e.kind != EntryKind::Ignored);
            if !staged && !(self.stage_all && changed) {
                return Err(GbError::new(GbErrorKind::InvalidInput, "Nothing to commit"));
            }
        }
        note_detached(pre, &self.detached);
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<CommitOutcome, GbError> {
        let trees = if self.stage_all { Some(self.stage_everything(cx).await?) } else { None };
        let mut args = vec!["commit", "-q", "-F", "-"];
        if self.amend {
            args.push("--amend");
        }
        let inv = cx.git(args).stdin(message(&self.summary, &self.description).into_bytes());
        if let Err(e) = cx.run_git(inv).await {
            // Deviation 8: a failed "Stage all & commit" leaves nothing staged that wasn't.
            if let Some((before, after)) = &trees {
                self.read_back(cx, before, after).await;
            }
            return Err(e);
        }
        cx.touch(ChangeKind::Index);
        Ok(CommitOutcome { oid: head_oid(cx.root)? })
    }
}

/// §8.3: `git commit --amend --only -F -` amends only the message; staged changes stay staged.
/// `--allow-empty` lets an empty commit's message be edited too. Journaled as an amend.
pub(crate) struct EditHeadMessage {
    pub message: String,
    detached: OnceLock<bool>,
}

impl WriteIntent for EditHeadMessage {
    type Outcome = CommitOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Commit
    }
    fn label(&self) -> String {
        format!("amend \"{}\"", summary_of(&self.message))
    }
    fn undo(&self) -> Option<UndoKind> {
        undo_for(&self.detached)
    }
    fn rewrite(&self) -> Option<crate::write::rewrites::RewriteKind> {
        Some(crate::write::rewrites::RewriteKind::Amend)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if summary_of(&self.message).trim().is_empty() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Write a commit summary"));
        }
        if pre.before.head.oid.is_none() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Nothing to amend"));
        }
        note_detached(pre, &self.detached);
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<CommitOutcome, GbError> {
        let inv = cx.git(["commit", "-q", "--amend", "--only", "--allow-empty", "-F", "-"]).stdin(self.message.clone().into_bytes());
        cx.run_git(inv).await?;
        Ok(CommitOutcome { oid: head_oid(cx.root)? })
    }
}

#[allow(clippy::too_many_arguments)] // the request's fields, as dispatch passes them
pub(crate) async fn commit(api: &Api, repo: u32, worktree: &str, summary: String, description: String, amend: bool, stage_all: bool, expect: Expect) -> Result<WriteResult<CommitOutcome>, GbError> {
    run_write(api, repo, worktree, expect, Commit { summary, description, amend, stage_all, detached: OnceLock::new() }).await
}

pub(crate) async fn edit_head_message(api: &Api, repo: u32, worktree: &str, message: String, expect: Expect) -> Result<WriteResult<CommitOutcome>, GbError> {
    run_write(api, repo, worktree, expect, EditHeadMessage { message, detached: OnceLock::new() }).await
}

/// The pencil's note (§8.3): the upstream's short name when HEAD is reachable from it (gix
/// `merge_base`), else `None`. A read.
pub(crate) async fn head_on_upstream(cli: &GitCli, root: &Path) -> Result<Option<String>, GbError> {
    let branch = head_state(&gix::open(root).map_err(gix_err)?)?.branch;
    let Some(branch) = branch else { return Ok(None) };
    let full = format!("refs/heads/{branch}");
    let out = cli.run(GitInvocation::new(root, ["for-each-ref", "--format=%(upstream)", full.as_str()])).await?;
    let upstream = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if upstream.is_empty() {
        return Ok(None);
    }
    let root = root.to_path_buf();
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let head = repo.head_id().map_err(gix_err)?.detach();
        let Some(up) = crate::write::refs::read_ref(&repo, &upstream)? else { return Ok(None) };
        let up = gix::ObjectId::from_hex(up.as_bytes()).map_err(gix_err)?;
        let on = head == up || repo.merge_base(head, up).ok().map(|b| b.detach()) == Some(head);
        Ok(on.then(|| crate::error::short_ref(&upstream).to_string()))
    })
    .await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

/// Who a commit in `root` is made as (ux round 1): `git var GIT_AUTHOR_IDENT`, so git's own
/// resolution (the `GIT_AUTHOR_*` environment, then `user.*` config with its usual precedence and
/// includes, then the auto-detected name and email). A read: nothing is written. `None`: git has
/// no identity it would commit with.
pub(crate) async fn identity(cli: &GitCli, root: &Path) -> Result<Option<CommitIdentity>, GbError> {
    match cli.run(GitInvocation::new(root, ["var", "GIT_AUTHOR_IDENT"])).await {
        Ok(out) => Ok(parse_ident(&String::from_utf8_lossy(&out.stdout))),
        Err(e) if e.stderr.as_deref().is_some_and(|s| ["identity unknown", "auto-detect", "empty ident", "no email was given", "no name was given"].iter().any(|m| s.contains(m))) => Ok(None),
        Err(e) => Err(e),
    }
}

/// `Ada Lovelace <ada@example.com> 1700000000 +0000` → its name and email.
fn parse_ident(line: &str) -> Option<CommitIdentity> {
    let (name, rest) = line.trim().split_once('<')?;
    let (email, _) = rest.rsplit_once('>')?;
    Some(CommitIdentity { name: name.trim().to_string(), email: email.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use crate::api::Api;
    use crate::error::GbErrorKind;
    use crate::events::AppEvent;
    use crate::testing::state::RepoState;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, halves, journal_step, open, open_at, repo, wt};
    use serde_json::{json, Value};
    use std::path::Path;

    async fn commit_at(api: &Api, id: u32, dir: &Path, summary: &str, description: &str, amend: bool, stage_all: bool) -> Result<Value, crate::error::GbError> {
        call(api, "commit", json!({ "repo": id, "worktree": wt(dir), "summary": summary, "description": description, "amend": amend, "stageAll": stage_all, "expect": {} })).await
    }

    async fn commit(api: &Api, id: u32, r: &TestRepo, summary: &str, amend: bool, stage_all: bool) -> Result<Value, crate::error::GbError> {
        commit_at(api, id, r.path(), summary, "", amend, stage_all).await
    }

    async fn round_trip(api: &Api, id: u32, r: &TestRepo, run: impl std::future::Future<Output = Result<Value, crate::error::GbError>>, label: &str) -> Value {
        let before = RepoState::capture(r);
        let res = run.await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], label, "{res}");
        let after = RepoState::capture(r);
        journal_step(api, id, r.path(), "undo").await.unwrap();
        assert_eq!(RepoState::capture(r), before, "undo: the changes come back staged");
        journal_step(api, id, r.path(), "redo").await.unwrap();
        assert_eq!(RepoState::capture(r), after);
        res
    }

    #[tokio::test]
    async fn a_commit_round_trips_with_its_changes_staged_again() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = round_trip(&api, id, &r, commit(&api, id, &r, "Fix x", false, false), "commit \"Fix x\"").await;
        assert_eq!(res["outcome"]["oid"].as_str().unwrap(), r.git(&["rev-parse", "HEAD"]));
        assert_eq!(r.git(&["log", "-1", "--format=%B"]), "Fix x");
    }

    /// §5.3: "Stage all & commit" undoes to the pre-commit split.
    #[tokio::test]
    async fn stage_all_and_commit_round_trips_the_split() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-q", "-m", "b"]);
        r.write("a.txt", "a staged\n");
        r.git(&["add", "a.txt"]);
        r.write("b.txt", "b unstaged\n");
        r.write("c.txt", "untracked\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, commit(&api, id, &r, "All of it", false, true), "commit \"All of it\"").await;
        assert_eq!(r.git(&["status", "--porcelain"]), "", "after redo, everything is committed");
    }

    #[tokio::test]
    async fn a_failed_stage_all_commit_puts_the_index_back() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.write("c.txt", "c\n");
        r.hook("pre-commit", "#!/bin/sh\nexit 1\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = RepoState::capture(&r);
        let err = commit(&api, id, &r, "Nope", false, true).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::HookFailed);
        assert_eq!(RepoState::capture(&r), before, "Deviation 8: nothing staged that wasn't");
        let j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(j["undo"].is_null(), "{j}");
    }

    #[tokio::test]
    async fn amend_round_trips_and_the_old_message_returns() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.commit("two");
        let parent = r.git(&["rev-parse", "HEAD^@"]);
        assert!(!parent.is_empty(), "not a root commit");
        r.write("a.txt", "amended in\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, commit(&api, id, &r, "two, amended", true, false), "amend \"two, amended\"").await;
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "two, amended");
        assert_eq!(r.git(&["rev-parse", "HEAD^@"]), parent, "same parents");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "two");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt", "the amended-in change is staged again");
    }

    /// §8.3: `--only` amends only the message; what's staged stays staged.
    #[tokio::test]
    async fn edit_head_message_amends_only_the_message() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let tree = r.git(&["rev-parse", "HEAD^{tree}"]);
        r.write("a.txt", "staged, not part of the edit\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let edit = call(&api, "editHeadMessage", json!({ "repo": id, "worktree": wt(r.path()), "message": "one\n\nwith a body", "expect": { "head": head } }));
        round_trip(&api, id, &r, edit, "amend \"one\"").await;
        assert_eq!(r.git(&["log", "-1", "--format=%B"]), "one\n\nwith a body");
        assert_eq!(r.git(&["rev-parse", "HEAD^{tree}"]), tree);
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt");
    }

    #[tokio::test]
    async fn edit_head_message_checks_the_head_it_was_shown() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let shown = r.git(&["rev-parse", "HEAD"]);
        r.commit("moved on");
        let err = call(&api, "editHeadMessage", json!({ "repo": id, "worktree": wt(r.path()), "message": "x", "expect": { "head": shown } })).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::RefMoved);
    }

    /// Deviation 9.
    #[tokio::test]
    async fn a_detached_head_commit_undoes_with_move_head() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["switch", "-q", "--detach", "HEAD"]);
        r.write("a.txt", "on a detached head\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, commit(&api, id, &r, "Detached", false, false), "commit \"Detached\"").await;
        assert_eq!(r.git(&["rev-parse", "--symbolic-full-name", "HEAD"]), "HEAD", "still detached");
    }

    #[tokio::test]
    async fn a_failing_pre_commit_is_hook_failed_with_its_output() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        r.hook("pre-commit", "#!/bin/sh\necho 'lint failed: a.txt' >&2\nexit 1\n");
        let api = api(data.path());
        let mut events = api.bus.subscribe();
        let id = open(&api, &r).await;
        let split = halves(&r);
        let err = commit(&api, id, &r, "Fix x", false, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::HookFailed);
        assert_eq!(halves(&r), split, "nothing staged or unstaged changed");
        assert!(matches!(&err.detail, Some(crate::error::ErrorDetail::Hook { hook }) if hook == "pre-commit"), "{err:?}");
        let mut lines = Vec::new();
        while let Ok(ev) = events.try_recv() {
            if let AppEvent::OpOutput { line, .. } = ev {
                lines.push(line);
            }
        }
        assert!(lines.iter().any(|l| l.contains("lint failed: a.txt")), "{lines:?}");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt", "a failed commit keeps what was staged");
    }

    #[tokio::test]
    async fn a_commit_msg_hook_rewrite_is_honoured() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        r.hook("commit-msg", "#!/bin/sh\nprintf '\\nSigned-off-by: Hook <hook@example.com>\\n' >> \"$1\"\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        commit(&api, id, &r, "Fix x", false, false).await.unwrap();
        assert!(r.git(&["log", "-1", "--format=%B"]).ends_with("Signed-off-by: Hook <hook@example.com>"));
    }

    /// §17.1 signing: commit, amend and a message edit are signed by git; GitBolt's own commits
    /// (snapshots) never call the signer.
    #[tokio::test]
    async fn commits_and_amends_are_signed_and_snapshots_never_are() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        if !r.signing_ssh() {
            return;
        }
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        commit(&api, id, &r, "Signed", false, false).await.unwrap();
        assert!(matches!(r.git(&["log", "-1", "--format=%G?"]).as_str(), "G" | "U"));
        assert_eq!(r.sign_count(), 1);
        commit(&api, id, &r, "Signed, amended", true, false).await.unwrap();
        let head = r.git(&["rev-parse", "HEAD"]);
        call(&api, "editHeadMessage", json!({ "repo": id, "worktree": wt(r.path()), "message": "Signed again", "expect": { "head": head } })).await.unwrap();
        assert_eq!(r.sign_count(), 3);
        r.write("a.txt", "to discard\n");
        crate::write::test_intents::run(&api, id, &wt(r.path()), Default::default(), crate::write::test_intents::TestIntent::Discard { paths: vec!["a.txt".into()] }).await.unwrap();
        assert_eq!(r.sign_count(), 3, "snapshots never sign");
    }

    #[tokio::test]
    async fn gpg_signs_commits() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let Some(_home) = r.signing_gpg() else { return };
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        commit(&api, id, &r, "GPG", false, false).await.unwrap();
        assert!(matches!(r.git(&["log", "-1", "--format=%G?"]).as_str(), "G" | "U"));
    }

    /// Review Focus 3.
    #[tokio::test]
    async fn a_commit_in_a_linked_worktree_commits_only_its_index() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["branch", "feature"]);
        let side = r.add_worktree("side", "feature");
        std::fs::write(side.join("s.txt"), "side\n").unwrap();
        r.git_in(&side, &["add", "s.txt"]);
        r.write("a.txt", "main's staged change\n");
        r.git(&["add", "a.txt"]);
        let main_head = r.git(&["rev-parse", "main"]);
        let api = api(data.path());
        let id = open_at(&api, r.path()).await;
        commit_at(&api, id, &side, "Side work", "", false, false).await.unwrap();
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature"]), "Side work");
        assert_eq!(r.git(&["rev-parse", "main"]), main_head);
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt", "main's index untouched");
        let main_j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        let side_j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(&side) })).await.unwrap();
        assert!(main_j["undo"].is_null() && side_j["undo"]["label"] == "commit \"Side work\"", "{main_j} {side_j}");
    }

    /// Review Focus 5: `-F` uses git's `whitespace` cleanup, so `#` lines and inner blank lines stay.
    #[tokio::test]
    async fn hash_lines_and_inner_blank_lines_are_committed_verbatim() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        commit_at(&api, id, r.path(), "#123 fix the parser", "# Why\n\nIt broke.\n\n# How\nCarefully.", false, false).await.unwrap();
        assert_eq!(r.git(&["log", "-1", "--format=%B"]), "#123 fix the parser\n\n# Why\n\nIt broke.\n\n# How\nCarefully.");
    }

    #[tokio::test]
    async fn an_empty_summary_or_a_rebase_in_progress_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = commit(&api, id, &r, "   ", false, false).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "Write a commit summary"));
        // A rebase stopped on a conflict.
        r.git(&["commit", "-q", "-m", "main edit"]);
        r.git(&["switch", "-q", "-c", "topic", "HEAD~1"]);
        r.write("a.txt", "topic edit\n");
        r.git(&["commit", "-q", "-am", "topic edit"]);
        let _ = r.try_git(&["rebase", "main"]);
        let err = commit(&api, id, &r, "x", false, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InProgress);
    }

    /// §13.2: in a merge, Commit makes the merge commit.
    #[tokio::test]
    async fn a_commit_in_a_merge_makes_the_merge_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::wip_conflict(&r);
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        commit(&api, id, &r, "Merge branch 'other'", false, false).await.unwrap();
        assert_eq!(r.git(&["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3, "two parents");
    }

    /// Ux round 1: the identity is git's own (the test env sets `GIT_AUTHOR_*`).
    #[tokio::test]
    async fn commit_identity_is_what_git_would_commit_as() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let who = call(&api, "commitIdentity", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(who, json!({ "name": "Ada Lovelace", "email": "ada@example.com" }));
    }

    /// No identity at all (config only, none set): `None`, not an error.
    #[tokio::test]
    async fn no_commit_identity_is_none() {
        let r = repo();
        r.git(&["config", "--unset", "user.name"]);
        r.git(&["config", "--unset", "user.email"]);
        r.git(&["config", "user.useConfigOnly", "true"]);
        let env = [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_NOSYSTEM", "1"), ("LC_ALL", "C")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        let cli = crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(100))).with_env(env);
        if std::env::var_os("GIT_AUTHOR_EMAIL").is_some() || std::env::var_os("EMAIL").is_some() {
            return; // this machine's environment names one
        }
        assert_eq!(super::identity(&cli, r.path()).await.unwrap(), None);
        r.git(&["config", "user.name", "Grace Hopper"]);
        r.git(&["config", "user.email", "grace@example.com"]);
        assert_eq!(super::identity(&cli, r.path()).await.unwrap(), Some(super::CommitIdentity { name: "Grace Hopper".into(), email: "grace@example.com".into() }));
    }

    #[test]
    fn an_ident_line_parses() {
        assert_eq!(super::parse_ident("A B <a@b.c> 1700000000 +0000\n"), Some(super::CommitIdentity { name: "A B".into(), email: "a@b.c".into() }));
        assert_eq!(super::parse_ident(""), None);
    }

    #[tokio::test]
    async fn head_on_upstream_names_it_only_when_head_is_on_it() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.add_origin();
        r.git(&["push", "-q", "-u", "origin", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let on = call(&api, "headOnUpstream", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(on, "origin/main");
        r.commit("local only");
        let off = call(&api, "headOnUpstream", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(off.is_null());
    }

    /// Review m5: a branch tracking a local branch gets its short name too.
    #[tokio::test]
    async fn head_on_upstream_shortens_a_local_upstream() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["switch", "-q", "-c", "topic", "--track", "main"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let on = call(&api, "headOnUpstream", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(on, "main");
    }

    /// A "Stage all & commit" whose split had `a.txt` unstaged and `c.txt` untracked, on top of
    /// a commit that has `d.txt`. Returns (the api, the repo id, HEAD before the commit).
    async fn staged_all(data: &Path, r: &TestRepo) -> (Api, u32, String) {
        r.write("d.txt", "d0\n");
        r.git(&["add", "d.txt"]);
        r.git(&["commit", "-q", "-m", "d"]);
        let parent = r.git(&["rev-parse", "HEAD"]);
        r.write("a.txt", "a2\n");
        r.write("c.txt", "c\n");
        let api = api(data);
        let id = open(&api, r).await;
        commit(&api, id, r, "X", false, true).await.unwrap();
        (api, id, parent)
    }

    /// Review I1, scenario A: what was staged after the commit survives its undo.
    #[tokio::test]
    async fn undoing_a_stage_all_commit_keeps_what_was_staged_since() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let (api, id, parent) = staged_all(data.path(), &r).await;
        r.write("d.txt", "v1\n");
        r.git(&["add", "d.txt"]);
        r.write("d.txt", "v2\n");
        r.git(&["add", "d.txt"]);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD"]), parent);
        assert_eq!(r.git(&["show", ":d.txt"]), "v2", "the staged v2 survives");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "d.txt", "the commit's own changes are unstaged again");
        assert_eq!(r.git(&["diff", "--name-only"]), "a.txt");
        assert_eq!(r.git(&["ls-files", "--others", "--exclude-standard"]), "c.txt");
    }

    /// Review I1: a path of the commit staged again since makes the undo refuse, changing nothing.
    #[tokio::test]
    async fn undoing_a_stage_all_commit_refuses_over_a_restaged_path() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let (api, id, _) = staged_all(data.path(), &r).await;
        r.write("a.txt", "a3\n");
        r.git(&["add", "a.txt"]);
        let before = RepoState::capture(&r);
        let top = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap()["undo"].clone();
        assert!(journal_step(&api, id, r.path(), "undo").await.is_err());
        assert_eq!(RepoState::capture(&r), before, "nothing changed, the staged a3 included");
        let j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(j["undo"], top, "still undoable once that's sorted out");
    }

    /// Review I1, scenario B: the undo never writes main's index into another branch's checkout.
    #[tokio::test]
    async fn an_undo_after_an_outside_switch_leaves_that_checkout_alone() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["switch", "-q", "-c", "other"]);
        r.commit("other work");
        r.git(&["switch", "-q", "main"]);
        let (api, id, parent) = staged_all(data.path(), &r).await;
        r.git(&["switch", "-q", "other"]);
        let before = RepoState::capture(&r);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "main"]), parent, "main moves back");
        let after = RepoState::capture(&r);
        assert_eq!((after.head, after.index, after.files), (before.head, before.index, before.files), "other's checkout is untouched");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// m3: a hook that changed what `add -A` staged blocks the read-back; the entry is kept so
    /// Undo can still try.
    #[tokio::test]
    async fn a_failed_read_back_keeps_the_entry() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("c.txt", "c\n");
        r.hook("pre-commit", "#!/bin/sh\nprintf 'hooked\\n' > c.txt\ngit add c.txt\nexit 1\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = commit(&api, id, &r, "Nope", false, true).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::HookFailed);
        let j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(j["undo"]["label"], "commit \"Nope\"", "{j}");
    }

    /// Review I2: a detached HEAD moved since asks, with the commits it drops; "Undo anyway"
    /// runs against the HEAD it showed and lands on the commit's parent.
    #[tokio::test]
    async fn a_moved_detached_head_asks_then_undo_anyway_lands_on_the_parent() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let parent = r.git(&["rev-parse", "HEAD"]);
        r.git(&["switch", "-q", "--detach", "HEAD"]);
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let made = commit(&api, id, &r, "Detached", false, false).await.unwrap()["outcome"]["oid"].as_str().unwrap().to_string();
        let outside = r.commit("outside");
        let asked = journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(asked["outcome"]["status"], "moved", "{asked}");
        let m = &asked["outcome"]["refs"][0];
        assert_eq!((m["name"].as_str(), m["expected"].as_str(), m["actual"].as_str(), m["target"].as_str(), m["dropped"].as_u64()), (Some("HEAD"), Some(made.as_str()), Some(outside.as_str()), Some(parent.as_str()), Some(1)));
        let entry = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap()["undo"]["entry"].clone();
        let done = call(&api, "undo", json!({ "repo": id, "worktree": wt(r.path()), "entry": entry, "confirm": { "HEAD": outside } })).await.unwrap();
        assert_eq!(done["outcome"]["status"], "done", "{done}");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), parent);
        assert_eq!(r.git(&["rev-parse", "--symbolic-full-name", "HEAD"]), "HEAD", "still detached");
    }

    /// Review I2: once HEAD is on a branch, a detached commit's undo is refused, no override.
    #[tokio::test]
    async fn a_detached_commit_undo_refuses_once_head_is_on_a_branch() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let parent = r.git(&["rev-parse", "HEAD"]);
        r.git(&["switch", "-q", "--detach", "HEAD"]);
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let made = commit(&api, id, &r, "Detached", false, false).await.unwrap()["outcome"]["oid"].as_str().unwrap().to_string();
        r.git(&["switch", "-q", "main"]);
        let main = r.git(&["rev-parse", "main"]);
        let err = journal_step(&api, id, r.path(), "undo").await.unwrap_err();
        // 2B final I2: the refusal says what works, not "refresh and retry".
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, format!("HEAD is on main now: switch back to {} to undo commit \"Detached\"", &made[..7]).as_str()));
        assert_eq!((r.git(&["rev-parse", "--symbolic-full-name", "HEAD"]), r.git(&["rev-parse", "HEAD"])), ("refs/heads/main".to_string(), main));
        // Switching back to it makes the same entry undoable.
        r.git(&["switch", "-q", "--detach", &made]);
        let done = journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(done["outcome"]["status"], "done", "{done}");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), parent);
    }

    /// m6: a message edit on a detached HEAD is a MoveHead.
    #[tokio::test]
    async fn edit_head_message_on_a_detached_head_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.commit("two");
        r.git(&["switch", "-q", "--detach", "HEAD"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let edit = call(&api, "editHeadMessage", json!({ "repo": id, "worktree": wt(r.path()), "message": "two, reworded", "expect": { "head": head } }));
        round_trip(&api, id, &r, edit, "amend \"two, reworded\"").await;
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "two, reworded");
        assert_eq!(r.git(&["rev-parse", "--symbolic-full-name", "HEAD"]), "HEAD", "still detached");
    }

    /// m6: a message edit in a linked worktree rewrites its branch's HEAD, journaled there.
    #[tokio::test]
    async fn edit_head_message_in_a_linked_worktree() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["branch", "feature"]);
        let side = r.add_worktree("side", "feature");
        r.git_in(&side, &["commit", "-q", "--allow-empty", "-m", "side one"]);
        let main_head = r.git(&["rev-parse", "main"]);
        let api = api(data.path());
        let id = open_at(&api, r.path()).await;
        let head = r.git_in(&side, &["rev-parse", "HEAD"]);
        call(&api, "editHeadMessage", json!({ "repo": id, "worktree": wt(&side), "message": "side one, reworded", "expect": { "head": head } })).await.unwrap();
        assert_eq!(r.git(&["log", "-1", "--format=%s", "feature"]), "side one, reworded");
        assert_eq!(r.git(&["rev-parse", "main"]), main_head);
        let main_j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        let side_j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(&side) })).await.unwrap();
        assert!(main_j["undo"].is_null() && side_j["undo"]["label"] == "amend \"side one, reworded\"", "{main_j} {side_j}");
    }

    /// m6: amending a merge commit keeps both parents.
    #[tokio::test]
    async fn amending_a_merge_commit_keeps_its_parents() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.switch_new("side");
        r.commit("side");
        r.switch("main");
        r.commit("main");
        r.merge("side", "Merge side");
        let parents = r.git(&["rev-parse", "HEAD^@"]);
        r.write("a.txt", "amended in\n");
        r.git(&["add", "a.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        commit(&api, id, &r, "Merge side, amended", true, false).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "HEAD^@"]), parents);
        assert_eq!(parents.lines().count(), 2);
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Merge side, amended");
    }

    /// m1, m6: nothing staged (or nothing at all, for "Stage all & commit") is refused up front.
    #[tokio::test]
    async fn nothing_to_commit_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        for stage_all in [false, true] {
            let err = commit(&api, id, &r, "x", false, stage_all).await.unwrap_err();
            assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "Nothing to commit"), "stage_all {stage_all}");
        }
        r.write("a.txt", "unstaged\n");
        let err = commit(&api, id, &r, "x", false, false).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "Nothing to commit"));
    }

    /// m2: in a merge, conflicts and amend are refused up front.
    #[tokio::test]
    async fn conflicts_and_amend_in_a_merge_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::wip_conflict(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        for stage_all in [false, true] {
            let err = commit(&api, id, &r, "Merge", false, stage_all).await.unwrap_err();
            assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "Resolve 1 conflicted file first"), "stage_all {stage_all}");
        }
        let err = commit(&api, id, &r, "Merge", true, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InProgress);
    }
}
