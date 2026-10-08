//! gix `Repository::state()` for one worktree, plus what the banner (§13.2) and the merge tool's
//! labels (§13.3) need, read from that worktree's git dir. Read-only.

use crate::error::{gix_err, GbError};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum InProgress {
    /// `MERGE_HEAD` exists. `message`: `MERGE_MSG`, line endings normalised (§8.2).
    Merge { merge_head: String, message: String, conflicted: u32 },
    /// `rebase-merge/` (or `rebase-apply/`). `onto` and `stopped_at` are oids; `head_name` is the
    /// branch being rebased (`refs/heads/main`). `message`: what Continue commits the stopped
    /// pick with (`rebase-merge/message`, `rebase-apply/final-commit`), line endings normalised;
    /// empty when git wrote none.
    Rebase {
        onto: String,
        head_name: String,
        step: u32,
        total: u32,
        stopped_at: Option<String>,
        // --- 3C T4 ---
        /// At an `edit` stop: the commit git made there (`rebase-merge/amend`). `None` at a
        /// conflict, or a stop of another kind.
        edit_stop: Option<String>,
        // --- end 3C T4 ---
        /// UX L: GitBolt's Edit stop is "about to commit": right after git stopped, HEAD was
        /// soft-reset to the edited commit's parent (this oid), so its changes are staged and its
        /// message (`message`) is the commit box's. `None`: git's own stop (HEAD on `edit_stop`),
        /// as a terminal's rebase has it.
        edit_base: Option<String>,
        /// UX L, with `edit_base`: the paths the stopped commit adds. One left untracked is a
        /// piece of it not staged yet: Continue waits for it (any other untracked file doesn't).
        edit_added: Vec<String>,
        /// UX L, with `edit_base`: the index isn't the stopped commit's tree (changed, or some of
        /// it unstaged): an Abort keeps it.
        edit_changed: bool,
        /// 3C final fix (I1): the stopped pick is an `edit` line that stopped before git made its
        /// commit (a conflict): git won't stop again once it's resolved, so this stop is the Edit's.
        edit_conflict: bool,
        /// 3C final fix (M1, M2): GitBolt couldn't apply this stop's new message (a commit-msg
        /// hook refused it): why. HEAD keeps the old one.
        message_failed: Option<String>,
        /// 3C fix round 2: GitBolt's own interactive rebase (its session is there): Commit at
        /// its Edit stops is GitBolt's. `false` for one started in a terminal.
        gitbolt: bool,
        conflicted: u32,
        message: String,
    },
    /// `CHERRY_PICK_HEAD` (a single pick, or a range's, `.git/sequencer/` too). `head`: the commit
    /// being picked; `message`: `MERGE_MSG`, what Continue commits it with. A range stopped
    /// between picks (`sequencer/` alone) isn't an operation here, as for gix.
    CherryPick { head: Option<String>, message: String, conflicted: u32 },
    /// `REVERT_HEAD`: as `CherryPick`, for the commit being reverted.
    Revert { head: Option<String>, message: String, conflicted: u32 },
    /// `git am`, started outside GitBolt; #3 adds its actions.
    Other { what: String },
}

fn unmerged_paths(repo: &gix::Repository) -> u32 {
    let Ok(index) = repo.index_or_empty() else { return 0 };
    let mut paths: Vec<&gix::bstr::BStr> = index.entries().iter().filter(|e| e.stage_raw() != 0).map(|e| e.path(&index)).collect();
    paths.dedup();
    paths.len() as u32
}

/// `\r\n` and `\r` become `\n` (§8.2).
fn normalise(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// The worktree's git dir is mid-merge, -rebase, -cherry-pick or -revert (or `am`), as `read`
/// (gix) sees it: `sequencer/` alone doesn't count, since nothing here acts on it. A few stats,
/// no repository open. Its WIP row shows even when it's clean, so the commit panel's Continue
/// and Abort are always reachable (ux round 1).
pub fn mid_operation(worktree: &Path) -> bool {
    let dot = worktree.join(".git");
    let git_dir = if dot.is_dir() {
        dot
    } else {
        let Ok(text) = std::fs::read_to_string(&dot) else { return false };
        let Some(dir) = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim) else { return false };
        worktree.join(dir)
    };
    ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].iter().any(|n| git_dir.join(n).exists())
}

/// 3C fix round 2: GitBolt's interactive rebase marks its `rebase-merge/` (the session's
/// directory in it), so the mark goes with git's own state when the rebase ends.
pub(crate) const GITBOLT_MARKER: &str = "rebase-merge/gitbolt-irebase";

/// 3C final fix: notes on one stop of GitBolt's interactive rebase, in git's `rebase-merge/` (so
/// they go with it). Each is `<the stop's done line>\n<text>`: a note of an earlier stop doesn't
/// match the current one. `MESSAGE_APPLIED`: the stop's new message was handled (never twice,
/// over a message the user typed since); `MESSAGE_FAILED`: it couldn't be applied, and why.
pub(crate) const MESSAGE_APPLIED: &str = "rebase-merge/gitbolt-message-applied";
pub(crate) const MESSAGE_FAILED: &str = "rebase-merge/gitbolt-message-failed";
/// With `MESSAGE_FAILED`: the commit the refused message was for (HEAD then) and the message:
/// `<oid>\n<message>`. The panel prefills it, and a Continue with a message typed there amends
/// that commit (only while HEAD is still it).
pub(crate) const REFUSED: &str = "rebase-merge/gitbolt-refused";
/// UX L: this Edit stop is (being) soft-reset, "about to commit": an `EditStaged`, as JSON. It's
/// written before the reset, so a note with HEAD still on `amend` is a reset that didn't happen.
pub(crate) const EDIT_STAGED: &str = "rebase-merge/gitbolt-edit-staged";
/// UX N: what git itself left at a stop it just made (its merge result staged, a conflicted file's
/// markers): JSON, path → content. An Abort doesn't keep what's still exactly that.
pub(crate) const STOP_CONTENT: &str = "rebase-merge/gitbolt-stop-content";

/// UX L: an `EDIT_STAGED` note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub(crate) struct EditStaged {
    /// The stop's key (`last_done`).
    pub at: String,
    /// The commit git made at the stop (`rebase-merge/amend`).
    pub amend: String,
    /// Its parent: where the soft reset put HEAD.
    pub base: String,
    /// The paths the commit adds (in `amend`, not in `base`): one left untracked is a piece of
    /// the commit the user hasn't staged (Continue waits for it).
    #[serde(default)]
    pub added: Vec<String>,
    /// The message the box starts with (the Edit row's new one, or the commit's own).
    pub message: String,
}

/// This stop's `EDIT_STAGED` note, while git's `amend` still names the commit it was made for.
pub(crate) fn edit_staged(git_dir: &Path) -> Option<EditStaged> {
    let at = last_done(git_dir)?;
    let mut s: EditStaged = serde_json::from_str(&std::fs::read_to_string(git_dir.join(EDIT_STAGED)).ok()?).ok()?;
    if s.at != at || s.base.is_empty() {
        return None;
    }
    s.message = format!("{}\n", normalise(&s.message).trim_end());
    let now = std::fs::read_to_string(git_dir.join("rebase-merge/amend")).ok()?;
    (now.trim() == s.amend).then_some(s)
}

/// Writes an `EDIT_STAGED` note.
pub(crate) fn write_edit_staged(git_dir: &Path, s: &EditStaged) -> std::io::Result<()> {
    std::fs::write(git_dir.join(EDIT_STAGED), serde_json::to_vec(s).map_err(std::io::Error::other)?)
}

/// UX L: the index holds something other than the stop's commit (`amend`'s tree): changes made
/// at the stop, or some of its own left out. Unreadable counts as changed.
fn index_differs(repo: &gix::Repository, amend: &str) -> bool {
    let read = || -> Option<bool> {
        let commit = repo.find_commit(gix::ObjectId::from_hex(amend.as_bytes()).ok()?).ok()?;
        let theirs = repo.index_from_tree(&commit.tree_id().ok()?).ok()?;
        let ours = repo.index_or_empty().ok()?;
        let key = |f: &gix::index::State, e: &gix::index::Entry| (e.path(f).to_owned(), e.id, e.mode, e.stage_raw());
        let a = theirs.entries().iter().map(|e| key(&theirs, e));
        let b = ours.entries().iter().map(|e| key(&ours, e));
        Some(!a.eq(b))
    };
    read().unwrap_or(true)
}

/// This stop's `REFUSED` note: (the commit, the refused message).
pub(crate) fn refused(git_dir: &Path) -> Option<(String, String)> {
    let at = last_done(git_dir)?;
    let text = stop_note(git_dir, REFUSED, &at)?;
    let (oid, message) = text.split_once('\n').unwrap_or((text.as_str(), ""));
    Some((oid.to_string(), format!("{}\n", normalise(message).trim_end())))
}

/// The last line of `rebase-merge/done`: the todo line git stopped at.
pub(crate) fn last_done(git_dir: &Path) -> Option<String> {
    let done = std::fs::read_to_string(git_dir.join("rebase-merge/done")).ok()?;
    done.lines().map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_string)
}

/// The text of the note `name` when it's this stop's (`at`: `last_done`).
pub(crate) fn stop_note(git_dir: &Path, name: &str, at: &str) -> Option<String> {
    let text = std::fs::read_to_string(git_dir.join(name)).ok()?;
    let (key, rest) = text.split_once('\n').unwrap_or((text.as_str(), ""));
    (key == at).then(|| rest.trim_end().to_string())
}

/// Writes the note `name` for the stop `at`.
pub(crate) fn write_stop_note(git_dir: &Path, name: &str, at: &str, text: &str) -> std::io::Result<()> {
    std::fs::write(git_dir.join(name), format!("{at}\n{text}\n"))
}

pub fn read(root: &Path) -> Result<Option<InProgress>, GbError> {
    use gix::state::InProgress as S;
    let repo = gix::open(root).map_err(gix_err)?;
    let Some(state) = repo.state() else { return Ok(None) };
    let git_dir = repo.git_dir().to_path_buf();
    let text = |name: &str| std::fs::read_to_string(git_dir.join(name)).ok().map(|s| s.trim().to_string());
    let message = |name: &str| std::fs::read_to_string(git_dir.join(name)).map(|s| normalise(&s)).unwrap_or_default();
    let conflicted = unmerged_paths(&repo);
    Ok(Some(match state {
        S::Merge => InProgress::Merge {
            merge_head: text("MERGE_HEAD").unwrap_or_default().lines().next().unwrap_or_default().to_string(),
            message: message("MERGE_MSG"),
            conflicted,
        },
        S::Rebase | S::RebaseInteractive | S::ApplyMailboxRebase => {
            let merge = git_dir.join("rebase-merge").is_dir();
            let dir = if merge { "rebase-merge" } else { "rebase-apply" };
            let f = |n: &str| text(&format!("{dir}/{n}"));
            let num = |n: &str| f(n).and_then(|s| s.parse().ok()).unwrap_or(0);
            let (step, total) = if merge { (num("msgnum"), num("end")) } else { (num("next"), num("last")) };
            // An `edit` stop (`amend` names the commit git made): Continue keeps HEAD's message
            // (whether the user reworded it there or not), so that's the one to show.
            let edit_stop = if merge { f("amend") } else { None };
            // UX L: GitBolt's Edit stop, soft-reset: the box starts with the note's message.
            // Only once HEAD left git's commit: a note with HEAD still on it is a reset that
            // didn't happen (git's own stop).
            // HEAD is read once, before the note: the stop's reset (`stage_edit_stop`) writes the
            // note and then moves HEAD, so HEAD off git's commit here means the note is there. A
            // second read of HEAD for the message could see the reset this one didn't, and give
            // the parent's message (the box keeps a stop's first message).
            let head_commit = if edit_stop.is_some() { repo.head_commit().ok() } else { None };
            let head = head_commit.as_ref().map(|c| c.id.to_string());
            let staged = if edit_stop.is_some() && git_dir.join(GITBOLT_MARKER).is_file() { edit_staged(&git_dir).filter(|s| head.as_deref() != Some(s.amend.as_str())) } else { None };
            let edit_changed = staged.as_ref().is_some_and(|s| index_differs(&repo, &s.amend));
            let message = if let Some(s) = &staged {
                s.message.clone()
            } else if edit_stop.is_some() {
                head_commit.as_ref().and_then(|c| c.message_raw().ok().map(|m| normalise(&m.to_string()))).unwrap_or_default()
            } else {
                message(&format!("{dir}/{}", if merge { "message" } else { "final-commit" }))
            };
            let last = if merge { last_done(&git_dir) } else { None };
            let edit_conflict = edit_stop.is_none() && last.as_deref().is_some_and(|l| matches!(l.split_whitespace().next(), Some("edit" | "e")));
            let message_failed = last.as_deref().and_then(|at| stop_note(&git_dir, MESSAGE_FAILED, at));
            // The refused message prefills the box (the 3C final ruling): retrying is one edit.
            let message = match message_failed.as_ref().and_then(|_| refused(&git_dir)) {
                Some((_, refused)) => refused,
                None => message,
            };
            InProgress::Rebase {
                onto: f("onto").unwrap_or_default(),
                head_name: f("head-name").unwrap_or_default(),
                step,
                total,
                stopped_at: f("stopped-sha").or_else(|| text("REBASE_HEAD")),
                edit_stop,
                edit_added: staged.as_ref().map(|s| s.added.clone()).unwrap_or_default(),
                edit_changed,
                edit_base: staged.map(|s| s.base),
                edit_conflict,
                message_failed,
                gitbolt: merge && git_dir.join(GITBOLT_MARKER).is_file(),
                conflicted,
                message,
            }
        }
        S::CherryPick | S::CherryPickSequence => InProgress::CherryPick { head: text("CHERRY_PICK_HEAD"), message: message("MERGE_MSG"), conflicted },
        S::Revert | S::RevertSequence => InProgress::Revert { head: text("REVERT_HEAD"), message: message("MERGE_MSG"), conflicted },
        S::ApplyMailbox => InProgress::Other { what: "am".into() },
        S::Bisect => return Ok(None),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestRepo;

    fn two_sides(r: &TestRepo) {
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
    }

    #[test]
    fn nothing_in_progress() {
        let r = TestRepo::new();
        r.commit("c");
        assert_eq!(read(r.path()).unwrap(), None);
    }

    #[test]
    fn a_conflicted_merge() {
        let r = TestRepo::new();
        two_sides(&r);
        assert!(r.try_git(&["merge", "--no-edit", "feature"]).is_err());
        match read(r.path()).unwrap() {
            Some(InProgress::Merge { merge_head, message, conflicted }) => {
                assert_eq!(merge_head, r.git(&["rev-parse", "feature"]));
                assert!(message.starts_with("Merge branch 'feature'"), "{message}");
                assert_eq!(conflicted, 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_stopped_rebase() {
        let r = TestRepo::new();
        two_sides(&r);
        r.switch("feature");
        assert!(r.try_git(&["rebase", "main"]).is_err());
        match read(r.path()).unwrap() {
            Some(InProgress::Rebase { onto, head_name, step, total, stopped_at, edit_stop, edit_base, edit_added, edit_changed, edit_conflict, message_failed, gitbolt, conflicted, message }) => {
                assert_eq!((edit_base, edit_added.len(), edit_changed), (None, 0, false), "not an Edit stop");
                assert!(!gitbolt, "started in a terminal");
                assert!(!edit_conflict && message_failed.is_none(), "a pick's conflict, no note");
                assert!(message.starts_with("Fix x\n"), "{message}");
                assert_eq!(edit_stop, None, "a conflict, not an edit stop");
                assert_eq!(onto, r.git(&["rev-parse", "main"]));
                assert_eq!(head_name, "refs/heads/feature");
                assert_eq!((step, total, conflicted), (1, 1, 1));
                assert!(stopped_at.is_some());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_sequencer_alone_is_no_operation() {
        let r = TestRepo::new();
        r.commit("c");
        let seq = r.path().join(".git").join("sequencer");
        std::fs::create_dir(&seq).unwrap();
        std::fs::write(seq.join("todo"), "pick 0000000 x\n").unwrap();
        assert!(!mid_operation(r.path()), "nothing could act on it: no WIP row kept for it");
        assert_eq!(read(r.path()).unwrap(), None);
    }

    /// An `edit` stop shows HEAD's message: the one Continue keeps.
    #[test]
    fn an_edit_stop_shows_heads_message() {
        let r = TestRepo::new();
        r.commit("base");
        r.commit("second");
        r.git(&["-c", "sequence.editor=sed -i.orig 1s/^pick/edit/", "rebase", "-q", "-i", "HEAD~1"]);
        let made = r.git(&["rev-parse", "HEAD"]);
        r.git(&["commit", "-q", "--amend", "-m", "reworded at the stop"]);
        match read(r.path()).unwrap() {
            Some(InProgress::Rebase { message, edit_stop, gitbolt, .. }) => {
                assert!(!gitbolt, "a terminal's rebase isn't GitBolt's");
                assert_eq!(message.trim_end(), "reworded at the stop");
                assert_eq!(edit_stop.as_deref(), Some(made.as_str()), "the commit git made at the stop");
            }
            other => panic!("{other:?}"),
        }
    }

    /// UX L (the flaky e2e "flow 2b"): GitBolt's Edit stop moves HEAD off git's commit (the note
    /// first, then `reset --soft`) while the watcher may be reading the stop. A read that saw
    /// HEAD on git's commit, then took the message from HEAD again after the reset, showed the
    /// parent's message, and the box kept it for the whole stop. HEAD is read once.
    #[test]
    fn an_edit_stop_being_staged_never_shows_the_parents_message() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let r = TestRepo::new();
        r.commit("base");
        r.commit("first");
        r.commit("second");
        r.git(&["-c", "sequence.editor=sed -i.orig 1s/^pick/edit/", "rebase", "-q", "-i", "HEAD~1"]);
        let made = r.git(&["rev-parse", "HEAD"]);
        let base = r.git(&["rev-parse", "HEAD~1"]);
        let git_dir = r.path().join(".git");
        std::fs::write(git_dir.join(GITBOLT_MARKER), "x\n").unwrap();
        let at = last_done(&git_dir).unwrap();
        write_edit_staged(&git_dir, &EditStaged { at, amend: made.clone(), base: base.clone(), added: Vec::new(), message: "second\n".into() }).unwrap();
        // HEAD flips between git's commit and its parent (atomically, as git's lock-and-rename
        // does), as the stop's reset moves it, while the stop is read.
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let flipper = {
            let (stop, git_dir) = (stop.clone(), git_dir.clone());
            std::thread::spawn(move || {
                let tmp = git_dir.join("HEAD.flip");
                for i in 0usize.. {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    std::fs::write(&tmp, format!("{}\n", if i % 2 == 0 { &base } else { &made })).unwrap();
                    std::fs::rename(&tmp, git_dir.join("HEAD")).unwrap();
                }
            })
        };
        let started = std::time::Instant::now();
        let mut reads = 0;
        let mut seen = Ok(());
        while reads < 3000 && started.elapsed() < std::time::Duration::from_secs(3) {
            match read(r.path()) {
                Ok(Some(InProgress::Rebase { message, .. })) if message.trim_end() == "second" => {}
                other => {
                    seen = Err(format!("read {reads}: {other:?}"));
                    break;
                }
            }
            reads += 1;
        }
        stop.store(true, Ordering::Relaxed);
        flipper.join().unwrap();
        seen.unwrap();
    }

    #[test]
    fn a_stopped_cherry_pick_and_revert() {
        let r = TestRepo::new();
        two_sides(&r);
        assert!(!mid_operation(r.path()));
        let feature = r.git(&["rev-parse", "feature"]);
        assert!(r.try_git(&["cherry-pick", "feature"]).is_err());
        assert!(mid_operation(r.path()));
        match read(r.path()).unwrap() {
            Some(InProgress::CherryPick { head, message, conflicted }) => {
                assert_eq!(head.as_deref(), Some(feature.as_str()));
                assert!(message.starts_with("Fix x"), "{message}");
                assert_eq!(conflicted, 1);
            }
            other => panic!("{other:?}"),
        }
        r.git(&["cherry-pick", "--abort"]);
        r.write("c.txt", "edited again\n");
        r.git(&["commit", "-q", "-am", "again"]);
        let reverted = r.git(&["rev-parse", "HEAD~1"]);
        assert!(r.try_git(&["revert", "--no-edit", "HEAD~1"]).is_err());
        match read(r.path()).unwrap() {
            Some(InProgress::Revert { head, message, conflicted }) => {
                assert_eq!(head.as_deref(), Some(reverted.as_str()));
                assert!(message.starts_with("Revert \"main\""), "{message}");
                assert_eq!(conflicted, 1);
            }
            other => panic!("{other:?}"),
        }
    }
}
