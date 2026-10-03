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
        /// 3C final fix (I1): the stopped pick is an `edit` line that stopped before git made its
        /// commit (a conflict): git won't stop again once it's resolved, so this stop is the Edit's.
        edit_conflict: bool,
        /// 3C final fix (M1, M2): GitBolt couldn't apply this stop's new message (a commit-msg
        /// hook refused it): why. HEAD keeps the old one.
        message_failed: Option<String>,
        /// 3C fix round 2: GitBolt's own interactive rebase (its session is there): Commit and
        /// Split at its Edit stops are GitBolt's. `false` for one started in a terminal.
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
            let message = if edit_stop.is_some() {
                repo.head_commit().ok().and_then(|c| c.message_raw().ok().map(|m| normalise(&m.to_string()))).unwrap_or_default()
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
            Some(InProgress::Rebase { onto, head_name, step, total, stopped_at, edit_stop, edit_conflict, message_failed, gitbolt, conflicted, message }) => {
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
        r.git(&["-c", "sequence.editor=sed -i 1s/^pick/edit/", "rebase", "-q", "-i", "HEAD~1"]);
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
