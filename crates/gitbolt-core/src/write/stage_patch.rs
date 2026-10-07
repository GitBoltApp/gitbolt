//! Stage or unstage hunks and lines of one file (spec #2 §7.3): `git apply --cached --recount`
//! of the patch builder's output, after the base check under the lock.

use crate::api::{blocking, Api};
use crate::error::{GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::hunks::{base_of, wip_diff, WipBase};
use crate::journal::UndoKind;
use crate::write::patch::{parse, partial_patch, selected_lines, selection_label, Dir, StageSelection};
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, Staging, WriteClass, WriteCx, WriteIntent};

/// The path's base now, off the runtime.
pub(crate) async fn base_now(root: &std::path::Path, path: &str) -> Result<WipBase, GbError> {
    let (root, path) = (root.to_path_buf(), path.to_string());
    blocking(move || base_of(&root, &path)).await
}

pub(crate) fn stale(path: &str) -> GbError {
    GbError::stale(format!("{path} changed since it was shown"))
}

fn refused(why: String) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, why)
}

/// The diff the base check passed for, or why it can't be staged by hunk or line. A check on
/// both sides of the diff makes it the one the user's base was shown from.
async fn checked_diff(api: &Api, root: &std::path::Path, path: &str, staged: bool, base: &WipBase) -> Result<Vec<u8>, GbError> {
    if !base.matches(&base_now(root, path).await?, staged) {
        return Err(stale(path));
    }
    let diff = wip_diff(&api.cli, root, path, staged).await?;
    if !base.matches(&base_now(root, path).await?, staged) {
        return Err(stale(path));
    }
    diff.map_err(refused)
}

fn dir(staged: bool) -> Dir {
    if staged {
        Dir::Reverse
    } else {
        Dir::Forward
    }
}

struct StagePatch {
    path: String,
    staged: bool,
    selection: StageSelection,
    base: WipBase,
    /// "a hunk", "3 lines": counted when the request came in, from the diff the user saw.
    what: String,
}

impl WriteIntent for StagePatch {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Stage
    }
    fn label(&self) -> String {
        format!("{} {} in {}", if self.staged { "unstage" } else { "stage" }, self.what, self.path)
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
        // §7.3 step 1: under the lock, the diff again; a base that moved is Stale.
        let diff = checked_diff(cx.api, cx.root, &self.path, self.staged, &self.base).await?;
        let patch = partial_patch(&diff, &self.selection, dir(self.staged)).ok_or_else(|| {
            let parsed = parse(&diff);
            refused(if parsed.mode_only() {
                "Only the file's mode changed: stage the whole file".into()
            } else if parsed.hunks.is_empty() {
                format!("No changes to {} in {}", if self.staged { "unstage" } else { "stage" }, self.path)
            } else {
                "No changed lines are selected".into()
            })
        })?;
        let mut args = vec!["apply", "--cached", "--recount", "--whitespace=nowarn"];
        if self.staged {
            args.push("-R");
        }
        args.push("-");
        let inv = cx.git(args).stdin(patch);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Index);
        Ok(())
    }
}

pub(crate) async fn stage_patch(api: &Api, repo: u32, worktree: &str, path: String, staged: bool, selection: StageSelection, base: WipBase) -> Result<WriteResult<()>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    // Refused (Stale, binary, a folder, …) before the write is queued; `run` checks again.
    let what = selection_label(&checked_diff(api, &root, &path, staged, &base).await?, &selection, dir(staged));
    run_write(api, repo, worktree, Expect::default(), StagePatch { path, staged, selection, base, what }).await
}

// --- 2B T10 ---
/// The line bar's counts (spec #2 §7.3): the changed lines a selection stages (or unstages, when
/// `staged`) and the ones a discard takes, each after the no-newline tie in its own direction.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelectionLines {
    pub apply: u32,
    pub discard: u32,
}

pub(crate) async fn selection_lines(cli: &crate::git::GitCli, root: &std::path::Path, path: &str, staged: bool, selection: &StageSelection) -> Result<SelectionLines, GbError> {
    let diff = wip_diff(cli, root, path, staged).await?.map_err(refused)?;
    Ok(SelectionLines { apply: selected_lines(&diff, selection, dir(staged)).1, discard: selected_lines(&diff, selection, Dir::Reverse).1 })
}
// --- end 2B T10 ---

#[cfg(test)]
mod tests {
    use crate::api::Api;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, open, repo, wt};
    use crate::write::WriteIntent;
    use serde_json::{json, Value};

    fn base(r: &TestRepo, path: &str) -> Value {
        serde_json::to_value(crate::hunks::base_of(r.path(), path).unwrap()).unwrap()
    }

    async fn patch(api: &Api, id: u32, r: &TestRepo, path: &str, staged: bool, selection: Value) -> Result<Value, crate::error::GbError> {
        call(api, "stagePatch", json!({ "repo": id, "worktree": wt(r.path()), "path": path, "staged": staged, "selection": selection, "base": base(r, path) })).await
    }

    fn ten(changed: &[usize]) -> String {
        (1..=30).map(|i| if changed.contains(&i) { format!("L{i} changed\n") } else { format!("L{i}\n") }).collect()
    }

    fn file_repo() -> TestRepo {
        let r = repo();
        r.write("f.txt", &ten(&[]));
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "f"]);
        r.write("f.txt", &ten(&[3, 20]));
        r
    }

    /// The index's bytes of `path`, untrimmed.
    fn index_bytes(r: &TestRepo, path: &str) -> Vec<u8> {
        let out = std::process::Command::new("git").current_dir(r.path()).args(["cat-file", "blob", &format!(":{path}")]).envs(crate::testing::isolated_git_env()).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    /// The label (§7.6): 2B T2 reports it as `staging.undo`; here it's the intent's own.
    #[test]
    fn labels_name_the_side_the_count_and_the_file() {
        let sel = crate::write::patch::StageSelection::Hunks { hunks: vec![1] };
        let mk = |staged, what: &str| super::StagePatch { path: "f.txt".into(), staged, selection: sel.clone(), base: Default::default(), what: what.into() };
        assert_eq!(mk(false, "a hunk").label(), "stage a hunk in f.txt");
        assert_eq!(mk(true, "3 lines").label(), "unstage 3 lines in f.txt");
    }

    #[tokio::test]
    async fn staging_one_hunk_then_unstaging_it() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = patch(&api, id, &r, "f.txt", false, json!({ "kind": "hunks", "hunks": [1] })).await.unwrap();
        assert_eq!(r.git(&["show", ":f.txt"]) + "\n", ten(&[20]));
        assert_eq!(res["staging"]["undo"], "stage a hunk in f.txt");
        patch(&api, id, &r, "f.txt", true, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached"]), "");
        assert_eq!(std::fs::read_to_string(r.path().join("f.txt")).unwrap(), ten(&[3, 20]), "the worktree is never touched");
    }

    #[tokio::test]
    async fn staging_lines_takes_only_the_picked_changed_lines() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        // Line 3's "+" only: the "-" stays as context, so L3 and "L3 changed" are both in the index.
        patch(&api, id, &r, "f.txt", false, json!({ "kind": "lines", "old": [], "new": [{ "start": 3, "end": 3 }] })).await.unwrap();
        let index = r.git(&["show", ":f.txt"]);
        assert!(index.contains("L3\nL3 changed\nL4"), "{index}");
        assert!(!index.contains("L20 changed"), "{index}");
    }

    /// 2B T10: the line bar's counts come from the same code the write uses.
    #[tokio::test]
    async fn selection_lines_counts_what_a_write_would_take() {
        let r = file_repo();
        let cli = crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(50))).with_env(crate::testing::isolated_git_env());
        let sel = |old: Value, new: Value| serde_json::from_value::<super::StageSelection>(json!({ "kind": "lines", "old": old, "new": new })).unwrap();
        let both = super::selection_lines(&cli, r.path(), "f.txt", false, &sel(json!([{ "start": 2, "end": 22 }]), json!([{ "start": 1, "end": 4 }]))).await.unwrap();
        assert_eq!((both.apply, both.discard), (3, 3));
        let none = super::selection_lines(&cli, r.path(), "f.txt", false, &sel(json!([]), json!([{ "start": 10, "end": 12 }]))).await.unwrap();
        assert_eq!((none.apply, none.discard), (0, 0));
    }

    /// A selection spanning context lines across both hunks takes only the changed lines in it.
    #[tokio::test]
    async fn a_line_selection_spanning_context_takes_only_its_changed_lines() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        // Old side 2–22 holds "-L3" and "-L20"; new side 1–4 holds "+L3 changed" only.
        patch(&api, id, &r, "f.txt", false, json!({ "kind": "lines", "old": [{ "start": 2, "end": 22 }], "new": [{ "start": 1, "end": 4 }] })).await.unwrap();
        let mut want: Vec<String> = (1..=30).map(|i| format!("L{i}")).collect();
        want[2] = "L3 changed".into();
        want.remove(19);
        assert_eq!(r.git(&["show", ":f.txt"]), want.join("\n"));
        // Unstaging a span that covers only context and the "-L20" line restores L20.
        patch(&api, id, &r, "f.txt", true, json!({ "kind": "lines", "old": [{ "start": 15, "end": 25 }], "new": [] })).await.unwrap();
        assert_eq!(r.git(&["show", ":f.txt"]) + "\n", ten(&[3]));
    }

    /// Changes 8 lines apart give two hunks with one untouched line between their contexts.
    #[tokio::test]
    async fn adjacent_hunks_stage_and_unstage_on_their_own() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        r.write("f.txt", &ten(&[3, 11]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let h = call(&api, "wipHunks", json!({ "repo": id, "worktree": wt(r.path()), "path": "f.txt", "staged": false })).await.unwrap();
        assert_eq!(h["hunks"].as_array().unwrap().len(), 2, "{h}");
        assert_eq!(h["hunks"][1]["oldStart"], 8, "{h}");
        patch(&api, id, &r, "f.txt", false, json!({ "kind": "hunks", "hunks": [1] })).await.unwrap();
        assert_eq!(r.git(&["show", ":f.txt"]) + "\n", ten(&[11]));
        patch(&api, id, &r, "f.txt", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        assert_eq!(r.git(&["show", ":f.txt"]) + "\n", ten(&[3, 11]));
        // Staged is now two hunks; unstage the second alone, then the first.
        patch(&api, id, &r, "f.txt", true, json!({ "kind": "hunks", "hunks": [1] })).await.unwrap();
        assert_eq!(r.git(&["show", ":f.txt"]) + "\n", ten(&[3]));
        patch(&api, id, &r, "f.txt", true, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached"]), "");
    }

    #[tokio::test]
    async fn partial_staging_of_an_untracked_file() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("n.txt", "one\ntwo\nthree\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "n.txt", false, json!({ "kind": "lines", "old": [], "new": [{ "start": 1, "end": 2 }] })).await.unwrap();
        assert_eq!(r.git(&["show", ":n.txt"]), "one\ntwo");
        patch(&api, id, &r, "n.txt", true, json!({ "kind": "lines", "old": [], "new": [{ "start": 2, "end": 2 }] })).await.unwrap();
        assert_eq!(r.git(&["show", ":n.txt"]), "one", "a partial unstage of a new file keeps the rest staged");
    }

    /// A file added or deleted as a whole: its one hunk stages and unstages the whole file.
    #[tokio::test]
    async fn whole_added_and_deleted_files_stage_and_unstage() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        r.write("n.txt", "one\ntwo\n");
        std::fs::remove_file(r.path().join("a.txt")).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let all = json!({ "kind": "hunks", "hunks": [0] });
        patch(&api, id, &r, "n.txt", false, all.clone()).await.unwrap();
        assert_eq!(index_bytes(&r, "n.txt"), b"one\ntwo\n");
        patch(&api, id, &r, "a.txt", false, all.clone()).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-status"]), "D\ta.txt\nA\tn.txt");
        patch(&api, id, &r, "n.txt", true, all.clone()).await.unwrap();
        patch(&api, id, &r, "a.txt", true, all).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached"]), "");
        assert_eq!(r.git(&["status", "--porcelain"]), " D a.txt\n M f.txt\n?? n.txt");
        // Part of a deletion: stage removing line 1 only.
        r.write("a.txt", "x\ny\n");
        r.git(&["add", "a.txt"]);
        r.git(&["commit", "-q", "-m", "xy"]);
        std::fs::remove_file(r.path().join("a.txt")).unwrap();
        patch(&api, id, &r, "a.txt", false, json!({ "kind": "lines", "old": [{ "start": 1, "end": 1 }], "new": [] })).await.unwrap();
        assert_eq!(index_bytes(&r, "a.txt"), b"y\n");
    }

    /// A staged rename: git diffs the new path alone (a new file), and unstaging a line of it
    /// keeps the rest staged under the new name.
    #[tokio::test]
    async fn a_staged_rename_unstages_a_line() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("old.txt", "one\ntwo\nthree\nfour\n");
        r.git(&["add", "old.txt"]);
        r.git(&["commit", "-q", "-m", "old"]);
        r.git(&["mv", "old.txt", "new.txt"]);
        r.write("new.txt", "one\ntwo\nthree\nfour\nfive\n");
        r.git(&["add", "new.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let h = call(&api, "wipHunks", json!({ "repo": id, "worktree": wt(r.path()), "path": "new.txt", "staged": true })).await.unwrap();
        let five = h["hunks"][0]["add"].as_array().unwrap().last().unwrap().as_u64().unwrap();
        patch(&api, id, &r, "new.txt", true, json!({ "kind": "lines", "old": [], "new": [{ "start": five, "end": five }] })).await.unwrap();
        assert_eq!(index_bytes(&r, "new.txt"), b"one\ntwo\nthree\nfour\n");
        assert_eq!(r.git(&["diff", "--cached", "-M", "--name-status"]), "R100\told.txt\tnew.txt");
    }

    #[tokio::test]
    async fn crlf_with_autocrlf_stages_clean_lines() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["config", "core.autocrlf", "true"]);
        r.write("w.txt", "a\r\nb\r\nc\r\n");
        r.git(&["add", "w.txt"]);
        r.git(&["commit", "-q", "-m", "w"]);
        r.write("w.txt", "a\r\nB\r\nc\r\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "w.txt", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        let blob = r.git(&["cat-file", "-p", ":w.txt"]);
        assert_eq!(blob, "a\nB\nc", "the index holds the cleaned (LF) text");
    }

    /// One line of an autocrlf file checked out as CRLF (the index is LF): only that line reaches
    /// the index, cleaned, as `git add -p` stages it; the worktree file is untouched.
    #[tokio::test]
    async fn one_line_of_an_autocrlf_file_stages_clean() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::wip_crlf(&r);
        r.write("auto.txt", &(1..=10).map(|i| if matches!(i, 2 | 5) { format!("line {i:02} edited\r\n") } else { format!("line {i:02}\r\n") }).collect::<String>());
        let disk = std::fs::read(r.path().join("auto.txt")).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let h = call(&api, "wipHunks", json!({ "repo": id, "worktree": wt(r.path()), "path": "auto.txt", "staged": false })).await.unwrap();
        assert_eq!(h["hunks"].as_array().unwrap().len(), 1, "git's diff: two edited lines, one hunk, no CRLF noise");
        patch(&api, id, &r, "auto.txt", false, json!({ "kind": "lines", "old": [{ "start": 5, "end": 5 }], "new": [{ "start": 5, "end": 5 }] })).await.unwrap();
        let want: String = (1..=10).map(|i| if i == 5 { "line 05 edited\n".to_string() } else { format!("line {i:02}\n") }).collect();
        assert_eq!(String::from_utf8(index_bytes(&r, "auto.txt")).unwrap(), want);
        assert_eq!(std::fs::read(r.path().join("auto.txt")).unwrap(), disk);
        assert_eq!(r.git(&["diff", "--numstat", "--", "auto.txt"]), "1\t1\tauto.txt", "line 2 is left unstaged");
    }

    /// `.gitattributes` `eol=crlf` (no autocrlf): a hunk stages clean, like autocrlf's.
    #[tokio::test]
    async fn a_hunk_of_an_eol_crlf_file_stages_clean() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write(".gitattributes", "*.txt text eol=crlf\n");
        r.write("w.txt", "a\nb\nc\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "w"]);
        r.write("w.txt", "a\r\nB\r\nc\r\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "w.txt", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        assert_eq!(index_bytes(&r, "w.txt"), b"a\nB\nc\n");
        assert_eq!(r.git(&["status", "--porcelain", "--", "w.txt"]), "M  w.txt", "nothing left unstaged");
    }

    /// An untracked CRLF file with autocrlf: staged as `git add` would store it.
    #[tokio::test]
    async fn an_untracked_crlf_file_with_autocrlf_stages_clean_lines() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["config", "core.autocrlf", "true"]);
        r.write("u.txt", "a\r\nb\r\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "u.txt", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        assert_eq!(index_bytes(&r, "u.txt"), b"a\nb\n");
        assert_eq!(r.git(&["status", "--porcelain"]), "A  u.txt", "nothing left unstaged");
    }

    /// CRLF committed as is (no autocrlf): the `\r` bytes reach the index untouched.
    #[tokio::test]
    async fn crlf_without_conversion_stages_byte_for_byte() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("w.txt", "a\r\nb\r\nc\r\n");
        r.git(&["add", "w.txt"]);
        r.git(&["commit", "-q", "-m", "w"]);
        r.write("w.txt", "a\r\nB\r\nc\r\nd\r\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "w.txt", false, json!({ "kind": "lines", "old": [], "new": [{ "start": 4, "end": 4 }] })).await.unwrap();
        assert_eq!(index_bytes(&r, "w.txt"), b"a\r\nb\r\nc\r\nd\r\n");
    }

    #[tokio::test]
    async fn no_newline_at_end_of_file_stages_cleanly() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("e.txt", "a\nb");
        r.git(&["add", "e.txt"]);
        r.git(&["commit", "-q", "-m", "e"]);
        r.write("e.txt", "a\nc");
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "e.txt", false, json!({ "kind": "lines", "old": [], "new": [{ "start": 2, "end": 2 }] })).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--stat"]).lines().count(), 2, "{}", r.git(&["diff", "--cached"]));
        assert_eq!(r.git(&["diff"]), "", "the -b/+c pair was staged together (Deviation 13)");
    }

    /// Lines appended to a file without a final newline: staging only the last keeps the line
    /// before it (now with its newline).
    #[tokio::test]
    async fn staging_a_line_appended_after_a_no_newline_end_keeps_that_line() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("e.txt", "a\nb");
        r.git(&["add", "e.txt"]);
        r.git(&["commit", "-q", "-m", "e"]);
        r.write("e.txt", "a\nb\nc\nd\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = patch(&api, id, &r, "e.txt", false, json!({ "kind": "lines", "old": [], "new": [{ "start": 4, "end": 4 }] })).await.unwrap();
        assert_eq!(index_bytes(&r, "e.txt"), b"a\nb\nd\n");
        // Review m1: the label counts what the tie really staged ("-b", "+b", "+d").
        assert_eq!(res["staging"]["undo"], "stage 3 lines in e.txt");
        // Unstaging the "-b" side alone takes the lines after it with it: back to HEAD.
        let res = patch(&api, id, &r, "e.txt", true, json!({ "kind": "lines", "old": [{ "start": 2, "end": 2 }], "new": [] })).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached"]), "");
        assert_eq!(res["staging"]["undo"], "unstage 3 lines in e.txt");
    }

    /// The index entry's mode of `path` (`100644`, `100755`).
    fn index_mode(r: &TestRepo, path: &str) -> String {
        r.git(&["ls-files", "-s", "--", path]).split(' ').next().unwrap_or_default().to_string()
    }

    /// Review I1: a mode change is the file's, never a hunk's. Staging one hunk leaves a pending
    /// `chmod +x` unstaged; unstaging one leaves a staged mode staged.
    #[tokio::test]
    async fn a_hunk_never_carries_the_file_mode() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let twelve: String = (1..=12).map(|i| format!("{i}\n")).collect();
        r.write("m", &twelve);
        r.git(&["add", "m"]);
        r.git(&["commit", "-q", "-m", "m"]);
        let path = r.path().join("m");
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        r.write("m", &twelve.replace("\n2\n", "\nTWO\n").replace("\n11\n", "\nELEVEN\n"));
        let api = api(data.path());
        let id = open(&api, &r).await;
        patch(&api, id, &r, "m", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        assert_eq!(index_mode(&r, "m"), "100644");
        assert!(!r.git(&["diff", "--cached", "--summary"]).contains("mode change"));
        assert!(index_bytes(&r, "m").starts_with(b"1\nTWO\n3\n"));
        r.git(&["add", "m"]);
        assert_eq!(index_mode(&r, "m"), "100755");
        patch(&api, id, &r, "m", true, json!({ "kind": "hunks", "hunks": [1] })).await.unwrap();
        assert_eq!(index_mode(&r, "m"), "100755", "unstaging a hunk keeps the staged mode");
        assert!(index_bytes(&r, "m").ends_with(b"10\n11\n12\n"));
        // A mode-only change has nothing to stage by hunk.
        r.git(&["checkout", "--", "m"]);
        r.git(&["reset", "-q", "--", "m"]);
        r.write("m", &twelve);
        let err = patch(&api, id, &r, "m", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (crate::error::GbErrorKind::InvalidInput, "Only the file's mode changed: stage the whole file"));
    }

    /// Review I2's repro: `path=d` must never stage d/b's hunk into d/a.
    #[tokio::test]
    async fn a_folder_path_stages_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d/a", "x\ny\n");
        r.write("d/b", "x\ny\n");
        r.git(&["add", "d"]);
        r.git(&["commit", "-q", "-m", "d"]);
        r.write("d/a", "x\nY\n");
        r.write("d/b", "x\ny\nz\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = patch(&api, id, &r, "d", false, json!({ "kind": "hunks", "hunks": [1] })).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (crate::error::GbErrorKind::InvalidInput, "d is not a file"));
        assert_eq!(r.git(&["diff", "--cached"]), "");
    }

    /// Review I3's repro: a `-` line of a retargeted symlink would stage an empty target.
    #[tokio::test]
    async fn a_symlink_line_selection_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        std::os::unix::fs::symlink("old", r.path().join("l")).unwrap();
        r.git(&["add", "l"]);
        r.git(&["commit", "-q", "-m", "l"]);
        std::fs::remove_file(r.path().join("l")).unwrap();
        std::os::unix::fs::symlink("new", r.path().join("l")).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = patch(&api, id, &r, "l", false, json!({ "kind": "lines", "old": [{ "start": 1, "end": 1 }], "new": [] })).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (crate::error::GbErrorKind::InvalidInput, "Symlink: stage the whole file"));
        assert_eq!(r.git(&["diff", "--cached"]), "");
    }

    /// Review m3: a binary file names why.
    #[tokio::test]
    async fn a_binary_file_is_refused_by_name() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write_bytes("b.bin", b"\0\x01\x02");
        r.git(&["add", "b.bin"]);
        r.git(&["commit", "-q", "-m", "b"]);
        r.write_bytes("b.bin", b"\0\x01\x03");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = patch(&api, id, &r, "b.bin", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap_err();
        assert_eq!(err.message, crate::write::patch::BINARY);
    }

    #[tokio::test]
    async fn a_stale_base_is_refused_and_nothing_changes() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let shown = base(&r, "f.txt");
        r.write("f.txt", &ten(&[3, 20, 25]));
        let err = call(&api, "stagePatch", json!({ "repo": id, "worktree": wt(r.path()), "path": "f.txt", "staged": false, "selection": { "kind": "hunks", "hunks": [0] }, "base": shown })).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
        assert_eq!(err.message, "f.txt changed since it was shown");
        assert_eq!(r.git(&["diff", "--cached"]), "");
    }

    #[tokio::test]
    async fn nothing_changed_selected_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = file_repo();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = patch(&api, id, &r, "f.txt", false, json!({ "kind": "lines", "old": [{ "start": 9, "end": 12 }], "new": [] })).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::InvalidInput);
        assert_eq!(r.git(&["diff", "--cached"]), "");
    }

    /// UX report: staging the only hunk of `basic`'s file_1.txt moves it to Staged and out of
    /// Unstaged, in the write's own lists and in a fresh read.
    #[tokio::test]
    async fn staging_the_only_hunk_leaves_nothing_unstaged() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::basic(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = patch(&api, id, &r, "file_1.txt", false, json!({ "kind": "hunks", "hunks": [0] })).await.unwrap();
        let paths = |side: &str| -> Vec<String> { res["wip"][side]["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_string()).collect() };
        assert_eq!(paths("staged"), ["file_1.txt"]);
        let raw = r.git(&["-c", "diff.autoRefreshIndex=false", "diff", "--raw", "--numstat"]);
        let status = r.git(&["status", "--porcelain=v2"]);
        assert!(paths("unstaged").is_empty(), "unstaged: {:?}\nraw: {raw}\nstatus: {status}", paths("unstaged"));
        let list = call(&api, "fileList", json!({ "repo": id, "spec": { "kind": "wip", "worktree": wt(r.path()), "staged": false } })).await.unwrap();
        assert_eq!(list["files"], json!([]), "a fresh read agrees");
    }
}
