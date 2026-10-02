//! The write pipeline end to end (spec #2 §3.2), through the test-only intents.

use super::test_intents::{self, TestIntent};
use super::types::Expect;
use crate::api::{Api, Request};
use crate::error::{GbError, GbErrorKind};
use crate::events::{AppEvent, ChangeKind, OpKind, OpOutcome};
use crate::git::GitCli;
use crate::journal::JournalStore;
use crate::log::CommandLog;
use crate::testing::{fixtures, isolated_git_env, TestRepo};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

fn api() -> (Api, tempfile::TempDir) {
    let data = tempfile::tempdir().unwrap();
    let api = Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
    (api, data)
}

async fn open(api: &Api, path: &Path) -> u32 {
    api.dispatch(Request::OpenRepo { path: path.display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32
}

async fn write(api: &Api, id: u32, wt: &Path, expect: Expect, intent: TestIntent) -> Result<serde_json::Value, GbError> {
    test_intents::run(api, id, &wt.canonicalize().unwrap().display().to_string(), expect, intent).await
}

fn expect_ref(name: &str, oid: Option<&str>) -> Expect {
    Expect { head: None, refs: [(name.to_string(), oid.map(str::to_string))].into() }
}

fn drain(rx: &mut broadcast::Receiver<AppEvent>) -> Vec<AppEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

/// A repo with an identity of its own (gix's reflog needs one).
fn repo() -> (TestRepo, String, String) {
    let r = TestRepo::new();
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
    let c1 = r.commit("one");
    let c2 = r.commit("two");
    (r, c1, c2)
}

fn journal(data: &Path, r: &TestRepo) -> crate::journal::Journal {
    let git_dir = r.path().join(".git").canonicalize().unwrap();
    JournalStore::new(data, &git_dir, &r.path().canonicalize().unwrap()).load().unwrap()
}

#[tokio::test]
async fn a_ref_moved_since_it_was_shown_is_ref_moved_and_changes_nothing() {
    let (r, c1, c2) = repo();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    r.git(&["branch", "x", &c1]);
    let err = write(&api, id, r.path(), expect_ref("refs/heads/x", Some(&c2)), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c2.clone()) }).await.unwrap_err();
    assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::RefMoved, "x changed outside GitBolt"));
    assert_eq!(r.git(&["rev-parse", "x"]), c1);
    assert!(journal(data.path(), &r).undo.is_empty(), "nothing journaled");
}

#[tokio::test]
async fn a_journaled_write_records_what_moved_and_announces_it() {
    let (r, c1, c2) = repo();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    r.git(&["branch", "x", &c1]);
    let mut rx = api.subscribe();
    let res = write(&api, id, r.path(), expect_ref("refs/heads/x", Some(&c1)), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c2.clone()) }).await.unwrap();
    assert_eq!(r.git(&["rev-parse", "x"]), c2);
    let j = journal(data.path(), &r);
    assert_eq!(j.undo.len(), 1);
    assert_eq!(j.undo[0].refs, vec![crate::journal::RefMove { name: "refs/heads/x".into(), old: Some(c1.clone()), new: Some(c2.clone()) }]);
    assert_eq!(res["journal"]["undo"]["label"], j.undo[0].label);
    assert_eq!(res["staging"], serde_json::json!({"undo": null, "redo": null, "off": null}));
    let version = res["wip"]["version"].as_str().unwrap().to_string();
    let events = drain(&mut rx);
    let types: Vec<&str> = events
        .iter()
        .map(|e| match e {
            AppEvent::OpStarted { .. } => "started",
            AppEvent::OpFinished { outcome: OpOutcome::Ok, .. } => "finished",
            AppEvent::JournalChanged { .. } => "journal",
            AppEvent::RefsUpdated { .. } => "refs",
            AppEvent::RepoChanged { .. } => "repo",
            AppEvent::QueueChanged { .. } => "queue",
            _ => "other",
        })
        .filter(|t| *t != "queue")
        .collect();
    assert_eq!(types, ["started", "repo", "refs", "journal", "finished"]);
    let changed = events
        .iter()
        .find_map(|e| match e {
            AppEvent::RepoChanged { kinds, versions, .. } => Some((kinds.clone(), versions.clone())),
            _ => None,
        })
        .unwrap();
    assert!(changed.0.contains(&ChangeKind::Refs));
    assert_eq!(changed.1.values().next(), Some(&version), "the event carries the lists' version (K44)");
}

#[tokio::test]
async fn a_failing_pre_commit_hook_is_hook_failed_streams_its_output_and_records_nothing() {
    let (r, _, _) = repo();
    r.hook("pre-commit", "#!/bin/sh\necho 'lint: a.php' >&2\necho 'lint failed' >&2\nexit 1\n");
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    let mut rx = api.subscribe();
    let err = write(&api, id, r.path(), Expect::default(), TestIntent::Commit { message: "Fix x".into(), allow_empty: true }).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::HookFailed);
    assert_eq!(err.message, "lint: a.php");
    let lines: Vec<String> = drain(&mut rx)
        .into_iter()
        .filter_map(|e| match e {
            AppEvent::OpOutput { line, .. } => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(lines, ["lint: a.php", "lint failed"], "hook output streams to Activity");
    let j = journal(data.path(), &r);
    assert!(j.undo.is_empty(), "nothing changed: the pending entry was dropped");
}

#[tokio::test]
async fn a_commit_msg_hook_rewriting_the_message_is_honoured() {
    let (r, _, _) = repo();
    r.hook("commit-msg", "#!/bin/sh\necho 'Signed-off-by: Hook' >> \"$1\"\n");
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    write(&api, id, r.path(), Expect::default(), TestIntent::Commit { message: "Fix x".into(), allow_empty: true }).await.unwrap();
    assert!(r.git(&["log", "-1", "--format=%B"]).contains("Signed-off-by: Hook"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_mid_write_leaves_a_pending_entry_that_becomes_a_recovery_banner() {
    let (r, _, _) = repo();
    r.write("file_0.txt", "dirty\n");
    // A file checkout runs post-checkout (flag 0): it holds the discard in its run step.
    r.hook("post-checkout", "#!/bin/sh\nsleep 3\n");
    let (api, data) = api();
    let api = Arc::new(api);
    let id = open(&api, r.path()).await;
    let a2 = api.clone();
    let wt = r.path().canonicalize().unwrap().display().to_string();
    let task = tokio::spawn(async move { test_intents::run(&a2, id, &wt, Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !journal(data.path(), &r).undo.iter().any(|e| e.before.is_some()) {
        assert!(Instant::now() < deadline, "the snapshotted pending entry never appeared");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    task.abort();
    let _ = task.await;
    drop(api);
    // "Restart": a new Api on the same data dir.
    let api = Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
    let id = open(&api, r.path()).await;
    let state = api.journal_state(&api.handle(id).unwrap().workdir).unwrap();
    assert_eq!(state.banners.len(), 1);
    assert_eq!(state.banners[0].kind, crate::journal::BannerKind::Recovery);
    assert!(state.banners[0].snapshot);
    assert!(state.undo.is_none(), "it isn't undoable");
}

/// Recovery runs once per process, at the first open, never from a write (a second instance's
/// in-flight entry must not be taken for a crashed one).
#[tokio::test]
async fn a_write_never_recovers_pending_entries() {
    let (r, c1, _) = repo();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    // Another instance's write, in flight: its pending entry is in the journal.
    let root = r.path().canonicalize().unwrap();
    let store = JournalStore::new(data.path(), &r.path().join(".git").canonicalize().unwrap(), &root);
    let theirs = store
        .update(|j| j.begin(crate::journal::NewEntry { label: "theirs".into(), kind: OpKind::Commit, head_before: Default::default(), undo: crate::journal::UndoKind::MoveRefs }, 1))
        .unwrap();
    write(&api, id, r.path(), expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(c1) }).await.unwrap();
    let j = journal(data.path(), &r);
    assert!(j.undo.iter().any(|e| e.id == theirs && e.state == crate::journal::EntryState::Pending), "still pending: {j:?}");
    assert!(j.recovery.is_empty());
}

#[tokio::test]
async fn a_snapshot_or_a_ref_edit_never_signs_but_a_commit_does() {
    let (r, c1, _) = repo();
    if !r.signing_ssh() {
        return;
    }
    r.write("file_0.txt", "dirty\n");
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    write(&api, id, r.path(), expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(c1) }).await.unwrap();
    write(&api, id, r.path(), Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await.unwrap();
    assert_eq!(r.sign_count(), 0, "snapshots and gix ref edits never call the signer");
    write(&api, id, r.path(), Expect::default(), TestIntent::Commit { message: "Signed".into(), allow_empty: true }).await.unwrap();
    assert_eq!(r.sign_count(), 1, "the user's commit signs, as git's config says");
    let verdict = r.git(&["log", "-1", "--format=%G?"]);
    assert!(verdict == "G" || verdict == "U", "{verdict}");
}

#[tokio::test]
async fn the_write_guard_refuses_before_anything_runs() {
    let (r, c1, _) = repo();
    let (api, _data) = api();
    let api = api.with_write_guard(Arc::new(|_: &Path| Err(GbError::new(GbErrorKind::InvalidInput, crate::api::FIXTURE_ONLY))));
    let id = open(&api, r.path()).await;
    let before = api.command_log().entries().len();
    let err = write(&api, id, r.path(), Expect::default(), TestIntent::MoveRef { name: "refs/heads/z".into(), to: Some(c1) }).await.unwrap_err();
    assert_eq!(err.message, "writes are limited to fixture repositories");
    let after = api.command_log().entries();
    assert!(after[before..].iter().all(|c| c.args.first().is_some_and(|a| a == "worktree")), "only the read that validated the worktree ran");
}

fn sleep(label: &str, ms: u64) -> TestIntent {
    TestIntent::Sleep { label: label.into(), ms, fail: false }
}

/// Waits for the `opStarted` of `label`: its op id.
async fn started(rx: &mut broadcast::Receiver<AppEvent>, label: &str) -> u64 {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let AppEvent::OpStarted { op, label: l, .. } = rx.recv().await.unwrap()
                && l == label
            {
                return op;
            }
        }
    })
    .await
    .expect("the op never started")
}

/// Polls `cond` (a signal from the code under test, not a clock) until it holds.
async fn until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "never: {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn started_labels(events: &[AppEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            AppEvent::OpStarted { label, .. } => Some(label.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_immediate_write_skips_the_queue() {
    let (r, _, _) = repo();
    r.write("file_0.txt", "dirty\n");
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    let w = api.repo_writes(&api.handle(id).unwrap());
    let (mut rx, mut seen) = (api.subscribe(), api.subscribe());
    let (s1, s2, ()) = tokio::join!(write(&api, id, r.path(), Expect::default(), sleep("sleep 1", 60_000)), write(&api, id, r.path(), Expect::default(), sleep("sleep 2", 0)), async {
        // "sleep 1" runs (holding the lock) and "sleep 2" waits its turn; the discard waits only
        // for the lock: it goes next once "sleep 1" ends.
        let op = started(&mut rx, "sleep 1").await;
        let (discard, ()) = tokio::join!(write(&api, id, r.path(), Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }), async {
            until("the discard waits for the lock", || w.waiting() == 1).await;
            api.ops().cancel(op);
        });
        discard.unwrap();
    });
    assert_eq!(s1.unwrap_err().kind, GbErrorKind::Cancelled);
    s2.unwrap();
    assert_eq!(started_labels(&drain(&mut seen)), ["sleep 1", "discard file_0.txt", "sleep 2"], "it waits only for the running item's local phase");
}

/// Spec §3.6: the queue's order is the click order, even when each write's own reads (its
/// worktree check) finish in another order.
#[tokio::test]
async fn queued_writes_run_in_click_order() {
    let (r, _, _) = repo();
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    let mut seen = api.subscribe();
    let wt = || r.path();
    let (a, b, c) = tokio::join!(write(&api, id, wt(), Expect::default(), sleep("a", 0)), write(&api, id, wt(), Expect::default(), sleep("b", 0)), write(&api, id, wt(), Expect::default(), sleep("c", 0)));
    a.unwrap();
    b.unwrap();
    c.unwrap();
    assert_eq!(started_labels(&drain(&mut seen)), ["a", "b", "c"]);
}

/// The app never runs a test write: without a write guard (only the harness sets one) it's
/// refused, even in a build where the `testing` feature was unified in.
#[tokio::test]
async fn a_test_write_needs_a_write_guard() {
    let (r, c1, _) = repo();
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    let wt = r.path().canonicalize().unwrap().display().to_string();
    let err = api.dispatch(Request::TestWrite { repo: id, worktree: wt, expect: Expect::default(), intent: TestIntent::MoveRef { name: "refs/heads/z".into(), to: Some(c1) } }).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::InvalidInput);
    assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/z"]).is_err(), "nothing moved");
}

/// §5.4: a merge or rebase in progress refuses a write before anything runs; a bisect doesn't.
#[tokio::test]
async fn a_merge_in_progress_refuses_a_write_but_a_bisect_doesnt() {
    let (r, c1, _) = repo();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    let git_dir = r.path().join(".git");
    std::fs::write(git_dir.join("MERGE_HEAD"), format!("{c1}\n")).unwrap();
    let err = write(&api, id, r.path(), expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(c1.clone()) }).await.unwrap_err();
    assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InProgress, "A merge is in progress"));
    assert!(r.try_git(&["rev-parse", "--verify", "-q", "refs/heads/y"]).is_err());
    assert!(journal(data.path(), &r).undo.is_empty());
    std::fs::remove_file(git_dir.join("MERGE_HEAD")).unwrap();
    std::fs::write(git_dir.join("BISECT_LOG"), "git bisect start\n").unwrap();
    write(&api, id, r.path(), expect_ref("refs/heads/y", None), TestIntent::MoveRef { name: "refs/heads/y".into(), to: Some(c1.clone()) }).await.unwrap();
    assert_eq!(r.git(&["rev-parse", "y"]), c1);
}

/// A pending entry with a snapshot, as a crashed (or running) write leaves it.
fn leave_pending(data: &Path, git_dir: &Path, root: &Path, label: &str, commit: &str, owner: Option<crate::journal::Owner>) -> u64 {
    JournalStore::new(data, &git_dir.canonicalize().unwrap(), &root.canonicalize().unwrap())
        .update(|j| {
            let id = j.begin(crate::journal::NewEntry { label: label.into(), kind: OpKind::Discard, head_before: Default::default(), undo: crate::journal::UndoKind::Restore }, (crate::journal::system_clock())());
            let e = j.entry_mut(id).unwrap();
            e.before = Some(crate::journal::Snapshot { commit: commit.into(), paths: vec!["file_0.txt".into()], untracked: Vec::new(), ..Default::default() });
            e.owner = owner;
            id
        })
        .unwrap()
}

fn restart(data: &Path) -> Api {
    Api::new(GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env()), None).with_data_dir(data.to_path_buf())
}

/// I2: the main worktree's journal is recovered even when a linked worktree opens first.
#[tokio::test]
async fn the_main_worktrees_journal_is_recovered_whichever_worktree_opens_first() {
    let r = TestRepo::new();
    fixtures::basic(&r);
    let head = r.git(&["rev-parse", "HEAD"]);
    let data = tempfile::tempdir().unwrap();
    leave_pending(data.path(), &r.path().join(".git"), r.path(), "discard file_0.txt", &head, None);
    let api = restart(data.path());
    open(&api, &r.root().join("wt-hotfix")).await;
    let main = open(&api, r.path()).await;
    let state = api.journal_state(&api.handle(main).unwrap().workdir).unwrap();
    assert_eq!(state.banners.iter().map(|b| (b.kind, b.label.as_str())).collect::<Vec<_>>(), [(crate::journal::BannerKind::Recovery, "discard file_0.txt")]);
}

/// I4: recovery leaves a live owner's pending entry (another instance's write in flight) alone
/// and takes a dead one's.
#[tokio::test]
async fn recovery_skips_a_live_owners_pending_entry() {
    let (r, _, _) = repo();
    let head = r.git(&["rev-parse", "HEAD"]);
    let data = tempfile::tempdir().unwrap();
    let live = crate::journal::OwnerLock::acquire(data.path()).unwrap();
    let dead = crate::journal::OwnerLock::acquire(data.path()).unwrap().owner.clone();
    let git_dir = r.path().join(".git");
    let theirs = leave_pending(data.path(), &git_dir, r.path(), "theirs", &head, Some(live.owner.clone()));
    let crashed = leave_pending(data.path(), &git_dir, r.path(), "crashed", &head, Some(dead));
    let api = restart(data.path());
    open(&api, r.path()).await;
    let j = journal(data.path(), &r);
    assert_eq!(j.undo.iter().map(|e| e.id).collect::<Vec<_>>(), [theirs], "the live owner's entry stays pending");
    assert_eq!(j.recovery.iter().map(|e| e.id).collect::<Vec<_>>(), [crashed]);
    drop(api);
    // That instance is gone too now: the next process recovers its entry.
    drop(live);
    let api = restart(data.path());
    open(&api, r.path()).await;
    assert_eq!(journal(data.path(), &r).recovery.iter().map(|e| e.id).collect::<Vec<_>>(), [crashed, theirs]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_watchers_echo_of_a_write_is_absorbed() {
    let (r, c1, c2) = repo();
    r.git(&["branch", "x", &c1]);
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    api.dispatch(Request::Graph { repo: id, limit: None, pin: None, rescan: None, active: None }).await.unwrap();
    api.dispatch(Request::WatchRepo { repo: id }).await.unwrap();
    let mut rx = api.subscribe();
    write(&api, id, r.path(), expect_ref("refs/heads/x", Some(&c1)), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c2) }).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let changed = drain(&mut rx).into_iter().filter(|e| matches!(e, AppEvent::RepoChanged { .. })).count();
    assert_eq!(changed, 1, "the write's own repoChanged, and no second one from the watcher");
}

/// Review Focus 1.
#[tokio::test]
async fn a_write_in_a_linked_worktree_uses_that_worktrees_journal_and_lists() {
    let r = TestRepo::new();
    fixtures::basic(&r);
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    let wt = r.root().join("wt-hotfix").canonicalize().unwrap();
    let res = write(&api, id, &wt, Expect::default(), TestIntent::Commit { message: "In the worktree".into(), allow_empty: true }).await.unwrap();
    assert_eq!(res["wip"]["worktree"], wt.display().to_string());
    assert!(res["wip"]["unstaged"]["files"].as_array().unwrap().iter().any(|f| f["path"] == "file_0.txt"), "the linked worktree's own dirty file");
    let wt_git_dir = r.path().join(".git/worktrees/wt-hotfix").canonicalize().unwrap();
    let wt_journal = JournalStore::new(data.path(), &wt_git_dir, &wt).load().unwrap();
    assert_eq!(wt_journal.undo.len(), 1);
    assert_eq!(wt_journal.undo[0].refs[0].name, "refs/heads/hotfix");
    assert!(journal(data.path(), &r).undo.is_empty(), "the main worktree's journal is untouched");
}

/// Review Focus 5, with T8 review 2's rule: a Cancel never stops the queue.
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_write_mid_hook_leaves_no_lock_and_no_pending_entry() {
    let (r, _, _) = repo();
    r.hook("pre-commit", "#!/bin/sh\nsleep 10\n");
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    let mut rx = api.subscribe();
    let (res, ()) = tokio::join!(write(&api, id, r.path(), Expect::default(), TestIntent::Commit { message: "x".into(), allow_empty: true }), async {
        let op = loop {
            match rx.recv().await.unwrap() {
                AppEvent::OpStarted { op, kind: OpKind::Commit, .. } => break op,
                _ => continue,
            }
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        api.ops().cancel(op);
    });
    assert_eq!(res.unwrap_err().kind, GbErrorKind::Cancelled);
    assert!(!r.path().join(".git/index.lock").exists(), "SIGTERM let git remove its lock");
    let j = journal(data.path(), &r);
    assert!(j.undo.is_empty() && j.recovery.is_empty(), "no pending entry left");
    assert!(api.repo_writes(&api.handle(id).unwrap()).queue.state().stopped.is_none(), "a Cancel never stops the queue");
}

/// §17.1 queue: "commit then push pushes the new commit"; an outside move between items is RefMoved.
#[tokio::test]
async fn expect_is_carried_forward_and_an_outside_move_between_items_is_ref_moved() {
    let (r, c1, c2) = repo();
    let c3 = r.commit("three");
    r.git(&["branch", "x", &c1]);
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    let shown = expect_ref("refs/heads/x", Some(&c1));
    // Clicked back to back, so both were shown x at c1: the second is carried past the first.
    let (a, b) = tokio::join!(
        write(&api, id, r.path(), shown.clone(), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c2.clone()) }),
        write(&api, id, r.path(), shown.clone(), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c3.clone()) }),
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(r.git(&["rev-parse", "x"]), c3, "the second ran against what the first left");
    let shown = expect_ref("refs/heads/x", Some(&c3));
    let w = api.repo_writes(&api.handle(id).unwrap());
    let mut rx = api.subscribe();
    let (s, c, ()) = tokio::join!(
        write(&api, id, r.path(), Expect::default(), sleep("sleep", 60_000)),
        write(&api, id, r.path(), shown.clone(), TestIntent::MoveRef { name: "refs/heads/x".into(), to: Some(c1.clone()) }),
        async {
            // While the sleep runs and the move waits its turn, something outside GitBolt moves x.
            let op = started(&mut rx, "sleep").await;
            until("the move is queued", || w.queue.state().queued.len() == 1).await;
            r.git(&["update-ref", "refs/heads/x", &c2]);
            api.ops().cancel(op);
        },
    );
    assert_eq!(s.unwrap_err().kind, GbErrorKind::Cancelled);
    assert_eq!(c.unwrap_err().kind, GbErrorKind::RefMoved);
    assert_eq!(r.git(&["rev-parse", "x"]), c2);
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// Deviation 1: the token is the type-level guard; this pins where writes are built.
#[test]
fn only_the_write_pipeline_and_the_journal_build_write_invocations() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let offenders: Vec<String> = files
        .iter()
        .filter(|f| {
            let rel = f.strip_prefix(&src).unwrap();
            !(rel.starts_with("write") || rel.starts_with("journal") || rel == Path::new("journal.rs") || rel == Path::new("git.rs"))
        })
        .filter(|f| {
            // Test modules (after the first `#[cfg(test)]`) may mint a test token.
            let text = std::fs::read_to_string(f).unwrap();
            let prod = text.split("#[cfg(test)]").next().unwrap();
            let squashed: String = prod.split_whitespace().collect();
            squashed.contains("GitInvocation::write(")
                || squashed.contains("Self::write(&")
                || (squashed.contains("WriteToken") && squashed.contains("::write("))
                || squashed.contains("WriteToken::mint")
                || squashed.contains("WriteToken::for_tests")
        })
        .map(|f| f.display().to_string())
        .collect();
    assert!(offenders.is_empty(), "write invocations outside crate::write / crate::journal: {offenders:?}");
}

#[tokio::test]
async fn hook_output_lines_are_redacted_before_they_are_emitted() {
    let bus = crate::events::EventBus::new();
    let mut rx = bus.subscribe();
    let (tx, task) = super::forward_output(bus, 5);
    tx.send(format!("remote: https://user:glpat-{}@host/x.git", "a".repeat(21))).unwrap();
    drop(tx);
    task.await.unwrap();
    match rx.recv().await.unwrap() {
        AppEvent::OpOutput { op: 5, line } => {
            assert!(!line.contains("glpat-"), "{line}");
            assert!(line.contains("https://***@host"), "{line}");
        }
        other => panic!("{other:?}"),
    }
}

// --- 2D T1: network phases ---

/// Waits for `line` in op `op`'s Activity output.
async fn output_line(rx: &mut broadcast::Receiver<AppEvent>, op: u64, line: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let AppEvent::OpOutput { op: o, line: l } = rx.recv().await.unwrap()
                && o == op
                && l == line
            {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never saw {line:?}"));
}

/// Spec #2 §3.5: a network transfer holds only the queue's running slot, never the write lock
/// or the watcher hold. A discard (immediate) runs during it, and the next queued item still
/// waits for it. Both shapes: pull's fetch-first and push's mid-run transfer.
#[tokio::test]
async fn a_transfer_holds_only_the_queue_slot() {
    for first in [true, false] {
        let (r, _, _) = repo();
        r.write("file_0.txt", "dirty\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let w = api.repo_writes(&api.handle(id).unwrap());
        let (mut rx, mut seen) = (api.subscribe(), api.subscribe());
        let transfer = TestIntent::Transfer { label: "push x".into(), ms: 60_000, first };
        let (t, after, ()) = tokio::join!(write(&api, id, r.path(), Expect::default(), transfer), write(&api, id, r.path(), Expect::default(), sleep("after", 0)), async {
            let op = started(&mut rx, "push x").await;
            output_line(&mut rx, op, "transferring").await;
            assert!(w.lock.try_lock().is_ok(), "the transfer holds no write lock (first: {first})");
            write(&api, id, r.path(), Expect::default(), TestIntent::Discard { paths: vec!["file_0.txt".into()] }).await.unwrap();
            assert_eq!(w.queue.state().queued.len(), 1, "\"after\" still waits for the transfer's slot");
            api.ops().cancel(op);
        });
        assert_eq!(t.unwrap_err().kind, GbErrorKind::Cancelled);
        after.unwrap_or_else(|e| panic!("a Cancel of the running item never stops the queue: {e:?}"));
        assert_eq!(started_labels(&drain(&mut seen)), ["push x", "discard file_0.txt", "after"], "first: {first}");
        // (2C T1's network-step test, merged in here.)
        assert!(w.lock.try_lock().is_ok(), "a cancelled transfer relocked, then released at the end (first: {first})");
    }
}

/// A transfer that relocks finishes its local phases under the lock again: its verify and the
/// write's refresh run locked, and the lock is free at the end.
#[tokio::test]
async fn a_finished_transfer_relocks_before_verify() {
    let (r, _, _) = repo();
    let (api, _data) = api();
    let id = open(&api, r.path()).await;
    let res = write(&api, id, r.path(), Expect::default(), TestIntent::Transfer { label: "push y".into(), ms: 0, first: false }).await.unwrap();
    assert!(res["wip"].is_object(), "the write's fresh lists, read under the lock again");
    let w = api.repo_writes(&api.handle(id).unwrap());
    assert!(w.lock.try_lock().is_ok(), "released at the end");
}
// --- end 2D T1 ---

// --- 2D T2: the pause ---

/// main and feature both change c.txt (a conflict); d.txt has an uncommitted change, which a
/// merge autostashes (§6.1: any tracked change). Returns main's tip.
fn conflicting() -> (TestRepo, String) {
    let r = TestRepo::new();
    r.git(&["config", "user.name", "Ada Lovelace"]);
    r.git(&["config", "user.email", "ada@example.com"]);
    r.write("c.txt", "base\n");
    r.write("d.txt", "d\n");
    r.git(&["add", "c.txt", "d.txt"]);
    r.git(&["commit", "-q", "-m", "base"]);
    r.switch_new("feature");
    r.write("c.txt", "feature\n");
    r.git(&["commit", "-q", "-am", "feature"]);
    r.switch("main");
    r.write("c.txt", "main\n");
    r.git(&["commit", "-q", "-am", "main"]);
    let tip = r.git(&["rev-parse", "HEAD"]);
    r.write("d.txt", "dirty\n");
    (r, tip)
}

async fn settle(api: &Api, id: u32, wt: &Path) -> serde_json::Value {
    api.dispatch(Request::SettlePaused { repo: id, worktree: wt.canonicalize().unwrap().display().to_string() }).await.unwrap()
}

/// §13.2: a merge that stops on conflicts keeps its entry and autostash waiting, and the Commit
/// that completes it makes one undoable step (Deviation 3).
#[tokio::test]
async fn a_stopped_merge_waits_then_its_commit_completes_one_entry() {
    let (r, main_tip) = conflicting();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    let res = write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    assert_eq!(res["journal"]["paused"]["label"], "merge feature into main");
    assert!(res["journal"]["banners"].as_array().unwrap().is_empty(), "no autostash banner while paused");
    assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "d\n", "d.txt's change waits in the autostash");
    let j = journal(data.path(), &r);
    assert_eq!(j.undo.last().unwrap().state, crate::journal::EntryState::Paused);
    assert_eq!(j.kept.len(), 1);
    assert_eq!(j.kept[0].reason, crate::journal::KeptReason::Paused);
    let err = write(&api, id, r.path(), Expect::default(), TestIntent::MoveRef { name: "refs/heads/feature".into(), to: Some(main_tip.clone()) }).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::InProgress, "other writes wait for the merge");

    r.write("c.txt", "resolved\n");
    r.git(&["add", "c.txt"]);
    let res = write(&api, id, r.path(), Expect::default(), TestIntent::CommitMerge { message: "Merge feature".into() }).await.unwrap();
    assert!(res["journal"]["paused"].is_null());
    assert_eq!(res["journal"]["undo"]["label"], "merge feature into main", "the commit is absorbed: one Undo step");
    assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n", "the autostash is restored at completion");
    let j = journal(data.path(), &r);
    assert_eq!(j.undo.len(), 1);
    assert_eq!(j.undo[0].refs[0].old.as_deref(), Some(main_tip.as_str()));
    assert!(j.kept.is_empty());
    assert_eq!(r.git(&["rev-list", "--count", "--merges", "HEAD"]), "1");
}

/// Review Focus 2: aborted in a terminal while paused, the next settle restores the autostash
/// and drops the entry (nothing moved).
#[tokio::test]
async fn an_outside_abort_settles_and_restores_the_autostash() {
    let (r, main_tip) = conflicting();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    r.git(&["merge", "--abort"]);
    let res = settle(&api, id, r.path()).await;
    assert!(res["journal"]["paused"].is_null());
    assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
    assert_eq!(r.git(&["rev-parse", "HEAD"]), main_tip);
    let j = journal(data.path(), &r);
    assert!(j.undo.is_empty(), "an abort leaves nothing to undo");
    assert!(j.kept.is_empty());
}

/// Review Focus 3: a restart while paused isn't a crash. The entry stays paused (no recovery
/// banner), and completion after the restart still restores the autostash.
#[tokio::test]
async fn a_paused_entry_survives_a_restart_and_completes() {
    let (r, _) = conflicting();
    let data = tempfile::tempdir().unwrap();
    let new_api = || Api::new(GitCli::new(Arc::new(CommandLog::new(1000))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
    {
        let api = new_api();
        let id = open(&api, r.path()).await;
        write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    }
    let api = new_api();
    let id = open(&api, r.path()).await;
    let state = api.dispatch(Request::JournalState { repo: id, worktree: r.path().canonicalize().unwrap().display().to_string() }).await.unwrap();
    assert!(state["banners"].as_array().unwrap().is_empty(), "no \"GitBolt stopped during\" banner: {state}");
    assert_eq!(state["paused"]["kind"], "merge");
    r.write("c.txt", "resolved\n");
    r.git(&["add", "c.txt"]);
    r.git(&["commit", "-q", "--no-edit"]);
    settle(&api, id, r.path()).await;
    assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
    assert_eq!(journal(data.path(), &r).undo[0].state, crate::journal::EntryState::Done);
}

/// Review I1: aborted outside GitBolt, the pause settles before the next write runs: that
/// write's own move isn't recorded on the merge entry, and the autostash comes back first.
/// Review N3: that write then fails Stale (the worktree changed under what the user saw), and
/// its retry runs.
#[tokio::test]
async fn an_outside_abort_settles_before_the_next_write_runs() {
    let (r, main_tip) = conflicting();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    r.git(&["merge", "--abort"]);
    let err = write(&api, id, r.path(), Expect::default(), TestIntent::Commit { message: "after".into(), allow_empty: true }).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::Stale, "{err:?}");
    assert_eq!(r.git(&["rev-parse", "HEAD"]), main_tip, "the commit didn't run");
    assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n", "restored before the commit, on main");
    let state = api.dispatch(Request::JournalState { repo: id, worktree: r.path().canonicalize().unwrap().display().to_string() }).await.unwrap();
    assert!(state["paused"].is_null());
    write(&api, id, r.path(), Expect::default(), TestIntent::Commit { message: "after".into(), allow_empty: true }).await.unwrap();
    let j = journal(data.path(), &r);
    assert_eq!(j.undo.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["commit \"after\""], "the aborted merge left nothing");
    assert_eq!(j.undo[0].refs[0].old.as_deref(), Some(main_tip.as_str()));
    assert!(j.kept.is_empty());
}

/// Review I1: a new merge that stops after an outside abort settles the old pause first: one
/// paused entry, one waiting autostash.
#[tokio::test]
async fn a_new_merge_after_an_outside_abort_settles_the_old_pause_first() {
    let (r, _) = conflicting();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    let first = journal(data.path(), &r).kept[0].id;
    r.git(&["merge", "--abort"]);
    let err = write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::Stale, "the old pause settled first (its autostash is back): {err:?}");
    assert!(journal(data.path(), &r).undo.is_empty(), "the old pause was dropped (an abort)");
    write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    let j = journal(data.path(), &r);
    assert_eq!(j.undo.len(), 1, "the old pause was dropped (an abort)");
    assert_eq!(j.undo[0].state, crate::journal::EntryState::Paused);
    assert_eq!(j.kept.len(), 1);
    assert_ne!(j.kept[0].id, first, "the old autostash was restored, then stashed again");
    assert_eq!(j.kept[0].reason, crate::journal::KeptReason::Paused);
    assert_eq!(r.git(&["stash", "list"]).lines().count(), 1);
}

/// Review M2: aborted, then committed in a terminal: not a completed merge, so the terminal
/// commit isn't recorded as the merge's move (Undo would rewind it).
#[tokio::test]
async fn an_outside_abort_then_commit_is_not_recorded_as_the_merge() {
    let (r, _) = conflicting();
    let (api, data) = api();
    let id = open(&api, r.path()).await;
    write(&api, id, r.path(), Expect::default(), TestIntent::MergeStop { target: "feature".into() }).await.unwrap();
    r.git(&["merge", "--abort"]);
    r.git(&["commit", "-q", "--allow-empty", "-m", "outside"]);
    settle(&api, id, r.path()).await;
    let j = journal(data.path(), &r);
    assert!(j.undo.is_empty(), "treated as an abort: {:?}", j.undo);
    assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
}
// --- end 2D T2 ---
