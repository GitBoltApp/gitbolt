//! UX Y: the Undo dropdown and out-of-order undo.
//!
//! The dropdown lists the newest undoable entries. The newest is the toolbar's Undo; an older one
//! can be undone on its own only when it's independent of every entry after it: nothing those
//! wrote overlaps what it wrote or read, and nothing it wrote is what they read. What an entry
//! touched comes from what it recorded (snapshot paths, ref moves, HEAD, config keys, stashes).
//! An entry whose touched set can't be told from that (a running or paused op, a stopped pick,
//! an unverified write, a push) is dependent: refused, never guessed.

use crate::error::short_ref;
use crate::events::OpKind;
use crate::journal::{EntryState, Journal, JournalEntry, UndoKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use ts_rs::TS;

/// How many entries the dropdown lists.
pub const HISTORY_ROWS: usize = 10;

/// One row of the Undo dropdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryRow {
    #[ts(type = "number")]
    pub entry: u64,
    pub label: String,
    pub kind: OpKind,
    #[ts(type = "number")]
    pub at_ms: i64,
    /// What it touched, as the UI names it: paths, then branches and tags, config keys.
    pub touched: Vec<String>,
    /// Why it can't be undone from the dropdown now ("A later action changed src/app.ts").
    pub blocked: Option<String>,
}

/// What an entry wrote and what its undo depends on.
#[derive(Debug, Default)]
pub(crate) struct Touched<'a> {
    /// Worktree and index paths (a snapshot's own).
    paths: BTreeSet<&'a str>,
    /// It rewrote files or the index it didn't record path by path (a checkout, a reset, a stash).
    all_paths: bool,
    /// Refs it moved, `HEAD` when HEAD moved, `config:<key>`, `refs/stash`.
    writes: BTreeSet<String>,
    /// What its undo relies on staying put: HEAD and its branch, for an undo that moves HEAD.
    reads: BTreeSet<String>,
}

fn head_ref(b: &Option<String>) -> Option<String> {
    b.as_ref().map(|b| format!("refs/heads/{b}"))
}

/// What `e` touched, or why that can't be told.
pub(crate) fn touched(e: &JournalEntry) -> Result<Touched<'_>, String> {
    match e.state {
        EntryState::Pending => return Err("Another action is still running".into()),
        EntryState::Paused => return Err(format!("Finish or abort the {} first", e.label)),
        EntryState::Done => {}
    }
    if e.undo == UndoKind::Barrier {
        return Err(format!("A later push can't be undone ({})", e.label));
    }
    if e.blocked.is_some() {
        return Err(format!("A later action can't be checked ({})", e.label));
    }
    if e.stopped_pick.is_some() || e.paused.is_some() {
        return Err(format!("A later action can't be checked ({})", e.label));
    }
    let mut t = Touched::default();
    for s in [&e.before, &e.after].into_iter().flatten() {
        t.paths.extend(s.paths.iter().map(String::as_str));
    }
    // A commit, an amend, a checkout or a stash touched the paths it changed (`tree_paths`,
    // recorded when it finished): HEAD's tree entries, the index, the stash's files. Where they
    // weren't recorded (older journals, a diff too big), every path. Rewind and resets stay
    // strict: every path.
    let recordable = e.head_before.oid != e.head_after.oid || e.head_before.branch != e.head_after.branch || e.index_before.is_some() || e.index_after.is_some() || !e.stashes.is_empty() || matches!(e.undo, UndoKind::Switch | UndoKind::Stash);
    let strict = matches!(e.undo, UndoKind::Rewind | UndoKind::ResetHard | UndoKind::ResetMixed | UndoKind::ResetSoft);
    match &e.tree_paths {
        _ if strict => t.all_paths = true,
        Some(paths) => t.paths.extend(paths.iter().map(String::as_str)),
        None => t.all_paths = recordable,
    }
    t.writes.extend(e.refs.iter().map(|m| m.name.clone()));
    if e.head_before != e.head_after {
        t.writes.insert("HEAD".into());
    }
    t.writes.extend(e.config.iter().map(|c| format!("config:{}", c.key)));
    if !e.stashes.is_empty() {
        t.writes.insert("refs/stash".into());
    }
    // Its undo moves HEAD itself (a checkout's switch back, a detached commit's, a reset's): it
    // relies on HEAD and its branch staying put. A snapshot restore doesn't: it writes only its
    // own paths, whose HEAD entries the path check covers.
    let against_head = strict || matches!(e.undo, UndoKind::Switch | UndoKind::MoveHead);
    if against_head {
        t.reads.insert("HEAD".into());
        t.reads.extend(head_ref(&e.head_before.branch));
        t.reads.extend(head_ref(&e.head_after.branch));
    }
    Ok(t)
}

/// More paths than this aren't recorded (review 3): the entry then counts as touching every path.
const TREE_PATHS_CAP: usize = 2_000;

/// A tree diff's file paths into `set`; the walk stops as soon as it holds more than the cap
/// (review 4: never read past it).
struct CappedPaths<'s> {
    inner: gix::diff::tree::Recorder,
    set: &'s mut BTreeSet<String>,
    over: bool,
}

impl gix::diff::tree::Visit for CappedPaths<'_> {
    fn pop_front_tracked_path_and_set_current(&mut self) {
        self.inner.pop_front_tracked_path_and_set_current();
    }
    fn push_back_tracked_path_component(&mut self, component: &gix::bstr::BStr) {
        self.inner.push_back_tracked_path_component(component);
    }
    fn push_path_component(&mut self, component: &gix::bstr::BStr) {
        self.inner.push_path_component(component);
    }
    fn pop_path_component(&mut self) {
        self.inner.pop_path_component();
    }
    fn visit(&mut self, change: gix::diff::tree::visit::Change) -> gix::diff::tree::visit::Action {
        if !change.entry_mode().is_tree() {
            self.set.insert(self.inner.path().to_string());
        }
        if self.set.len() > TREE_PATHS_CAP {
            self.over = true;
            return std::ops::ControlFlow::Break(());
        }
        std::ops::ControlFlow::Continue(())
    }
}

/// `from..to` (each a commit or a tree) into `set`, capped.
fn capped_diff(repo: &gix::Repository, from: gix::ObjectId, to: gix::ObjectId, set: &mut BTreeSet<String>) -> Result<(), String> {
    let tree = |c: gix::ObjectId| repo.find_object(c).map_err(|e| e.to_string())?.peel_to_tree().map_err(|e| e.to_string());
    let (a, b) = (tree(from)?, tree(to)?);
    let mut state = gix::diff::tree::State::default();
    let mut v = CappedPaths { inner: gix::diff::tree::Recorder::default(), set, over: false };
    let res = gix::diff::tree(gix::objs::TreeRefIter::from_bytes(&a.data, from.kind()), gix::objs::TreeRefIter::from_bytes(&b.data, to.kind()), &mut state, &repo.objects, &mut v);
    if v.over {
        return Err(format!("more than {TREE_PATHS_CAP} paths"));
    }
    res.map_err(|e| e.to_string())
}

/// What a finished write changed beyond its snapshots (`JournalEntry::tree_paths`), read once
/// when it finishes: HEAD's tree diff (a commit, an amend, a checkout), the index paths "Stage all
/// & commit" consumed (its `index_before` against what it left), and each stash's files (its
/// worktree and index changes, and its untracked files). `None` when there's nothing to record
/// (no HEAD move, index tree or stash), for a reset or rewind (strict), or when it can't be read
/// or holds more than `TREE_PATHS_CAP` paths (logged): the entry then touches every path. Reads.
pub(crate) async fn tree_paths(cli: &crate::git::GitCli, root: &std::path::Path, e: &JournalEntry) -> Option<Vec<String>> {
    let strict = matches!(e.undo, UndoKind::Rewind | UndoKind::ResetHard | UndoKind::ResetMixed | UndoKind::ResetSoft);
    let relevant = e.head_before.oid != e.head_after.oid || e.head_before.branch != e.head_after.branch || e.index_before.is_some() || !e.stashes.is_empty() || matches!(e.undo, UndoKind::Switch | UndoKind::Stash);
    if strict || !relevant {
        return None;
    }
    match read_tree_paths(cli, root, e).await {
        Ok(paths) => Some(paths),
        Err(why) => {
            tracing::warn!(target: "gitbolt_core::journal", "{}: what it changed wasn't recorded ({why}); it counts as touching every path", e.label);
            None
        }
    }
}

async fn read_tree_paths(cli: &crate::git::GitCli, root: &std::path::Path, e: &JournalEntry) -> Result<Vec<String>, String> {
    use gix::ObjectId;
    let oid = |s: Option<&str>| s.and_then(|s| ObjectId::from_hex(s.as_bytes()).ok()).ok_or_else(|| format!("no object id ({s:?})"));
    let mut set = BTreeSet::new();
    let mut untracked = Vec::new();
    {
        let repo = gix::open(root).map_err(|e| e.to_string())?;
        if e.head_before.oid != e.head_after.oid {
            capped_diff(&repo, oid(e.head_before.oid.as_deref())?, oid(e.head_after.oid.as_deref())?, &mut set)?;
        }
        if let Some(before) = &e.index_before {
            capped_diff(&repo, oid(Some(before))?, oid(e.index_after.as_deref().or(e.head_after.oid.as_deref()))?, &mut set)?;
        }
        for m in &e.stashes {
            let w = repo.find_commit(oid(Some(&m.oid))?).map_err(|e| e.to_string())?;
            let parents: Vec<ObjectId> = w.parent_ids().map(|p| p.detach()).collect();
            let base = *parents.first().ok_or("a stash without a base")?;
            capped_diff(&repo, base, w.id, &mut set)?;
            if let Some(index) = parents.get(1) {
                capped_diff(&repo, base, *index, &mut set)?;
            }
            untracked.extend(parents.get(2).map(|u| u.to_string()));
        }
    }
    for u in untracked {
        let out = cli.run(crate::git::GitInvocation::new(root, ["ls-tree", "-r", "-z", "--name-only", u.as_str()])).await.map_err(|e| e.message)?;
        for p in out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            set.insert(String::from_utf8_lossy(p).into_owned());
            if set.len() > TREE_PATHS_CAP {
                return Err(format!("more than {TREE_PATHS_CAP} paths"));
            }
        }
    }
    Ok(set.into_iter().collect())
}

/// The first path of `a` that overlaps one of `b` (the same file, or a folder holding the other),
/// by lookups (review 3): itself, a range for what's under it, and each folder above it.
pub(crate) fn first_overlap<'a>(a: &BTreeSet<&'a str>, b: &BTreeSet<&str>) -> Option<&'a str> {
    use std::ops::Bound::{Excluded, Included};
    a.iter()
        .find(|p| {
            if b.contains(**p) {
                return true;
            }
            // Under `p/`: from "p/" up to "p0" ('0' follows '/').
            let (lo, hi) = (format!("{p}/"), format!("{p}0"));
            if b.range::<str, _>((Included(lo.as_str()), Excluded(hi.as_str()))).next().is_some() {
                return true;
            }
            p.match_indices('/').any(|(i, _)| b.contains(&p[..i]))
        })
        .copied()
}

fn describe(name: &str) -> String {
    if name == "HEAD" {
        "A later action moved HEAD".into()
    } else if let Some(key) = name.strip_prefix("config:") {
        format!("A later action changed {key}")
    } else if name == "refs/stash" {
        "A later action changed the stash list".into()
    } else {
        format!("A later action moved {}", short_ref(name))
    }
}

/// Why `older` can't be undone past `newer`, if it can't.
fn conflict(older: &Touched, newer: &Touched, newer_label: &str) -> Option<String> {
    if (older.all_paths && (newer.all_paths || !newer.paths.is_empty())) || (newer.all_paths && !older.paths.is_empty()) {
        return Some(format!("A later action changed the working tree ({newer_label})"));
    }
    if let Some(p) = first_overlap(&older.paths, &newer.paths) {
        return Some(format!("A later action changed {p}"));
    }
    let hits: Vec<&String> = older.writes.iter().filter(|w| newer.writes.contains(*w) || newer.reads.contains(*w)).chain(newer.writes.iter().filter(|w| older.reads.contains(*w))).collect();
    // A branch says more than HEAD does ("moved main", not "moved HEAD").
    hits.iter().find(|w| **w != "HEAD").or(hits.first()).map(|w| describe(w))
}

/// Whether `e` itself can be undone out of order (its kind's undo restores only what it recorded).
fn eligible(e: &JournalEntry) -> Result<(), String> {
    let in_order = || Err("Only Undo of the actions after it can reach this one".to_string());
    if e.state != EntryState::Done || e.blocked.is_some() || e.undo == UndoKind::Barrier || e.stopped_pick.is_some() || e.paused.is_some() {
        return in_order();
    }
    if e.index_before.is_some() || e.index_after.is_some() || !e.stashes.is_empty() {
        return in_order();
    }
    match e.undo {
        UndoKind::Restore if e.before.is_some() && e.after.is_some() && e.refs.is_empty() && e.config.is_empty() && e.head_before == e.head_after => Ok(()),
        UndoKind::MoveRefs if e.before.is_none() && e.after.is_none() && (!e.refs.is_empty() || !e.config.is_empty()) => Ok(()),
        _ => in_order(),
    }
}

/// What the dropdown shows an entry touched.
fn touched_names(e: &JournalEntry) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut push = |s: String, out: &mut Vec<String>| {
        if seen.insert(s.clone()) {
            out.push(s);
        }
    };
    for s in [&e.before, &e.after].into_iter().flatten() {
        for p in &s.paths {
            push(p.clone(), &mut out);
        }
    }
    for p in e.tree_paths.iter().flatten() {
        push(p.clone(), &mut out);
    }
    let strict = matches!(e.undo, UndoKind::Rewind | UndoKind::ResetHard | UndoKind::ResetMixed | UndoKind::ResetSoft);
    let recordable = e.head_before.oid != e.head_after.oid || e.head_before.branch != e.head_after.branch || e.index_before.is_some() || e.index_after.is_some() || !e.stashes.is_empty() || matches!(e.undo, UndoKind::Switch | UndoKind::Stash);
    if strict || (recordable && e.tree_paths.is_none()) {
        push("working tree".into(), &mut out);
    }
    for m in &e.refs {
        push(short_ref(&m.name).to_string(), &mut out);
    }
    if e.head_before.branch != e.head_after.branch || (e.head_before.oid != e.head_after.oid && e.refs.is_empty()) {
        push("HEAD".into(), &mut out);
    }
    for c in &e.config {
        push(c.key.clone(), &mut out);
    }
    if !e.stashes.is_empty() {
        push("stash".into(), &mut out);
    }
    out
}

impl Journal {
    /// The entry `id` if it can be undone out of order now: done, on the undo stack, of a kind
    /// whose undo is only its own paths and refs, and independent of every entry after it.
    /// `except`: an entry to leave out of the check (the out-of-order undo's own, in flight).
    pub fn out_of_order(&self, id: u64, except: Option<u64>) -> Result<&JournalEntry, String> {
        let Some(at) = self.undo.iter().position(|e| e.id == id) else { return Err("The undo history changed; refreshed".into()) };
        let t: Vec<Result<Touched, String>> = self.undo[at..].iter().map(touched).collect();
        self.independent(at, &t, except)?;
        Ok(&self.undo[at])
    }

    /// `undo[at]` against everything after it; `t`: `touched` of `undo[at..]`.
    fn independent(&self, at: usize, t: &[Result<Touched, String>], except: Option<u64>) -> Result<(), String> {
        eligible(&self.undo[at])?;
        let mine = t[0].as_ref().map_err(Clone::clone)?;
        for (n, theirs) in self.undo[at + 1..].iter().zip(&t[1..]).filter(|(n, _)| Some(n.id) != except) {
            if let Some(why) = conflict(mine, theirs.as_ref().map_err(Clone::clone)?, &n.label) {
                return Err(why);
            }
        }
        Ok(())
    }

    /// Whether the Redo stack can stay through an out-of-order undo of `target` (review 7): every
    /// redo entry's touched set is known and independent of the target's.
    pub(crate) fn redo_survives(&self, target: &JournalEntry) -> bool {
        let Ok(mine) = touched(target) else { return false };
        self.redo.iter().all(|r| touched(r).is_ok_and(|theirs| conflict(&mine, &theirs, &r.label).is_none() && conflict(&theirs, &mine, &target.label).is_none()))
    }

    /// The dropdown: the newest done entries, newest first. The first is what Undo undoes
    /// (`undo_blocked` is its reason); `busy` blocks the rest too. Each entry's touched set is
    /// worked out once (review 3).
    pub(crate) fn history(&self, busy: Option<&str>, undo_blocked: &Option<String>) -> Vec<HistoryRow> {
        let top = self.undo_top().map(|e| e.id);
        let rows: Vec<usize> = (0..self.undo.len()).rev().filter(|i| self.undo[*i].state == EntryState::Done).take(HISTORY_ROWS).collect();
        let from = rows.last().copied().unwrap_or(0);
        let t: Vec<Result<Touched, String>> = self.undo[from..].iter().map(touched).collect();
        rows.into_iter()
            .map(|i| {
                let e = &self.undo[i];
                let blocked = if Some(e.id) == top {
                    undo_blocked.clone()
                } else if let Some(w) = busy {
                    Some(format!("Finish or abort the {w} first"))
                } else {
                    self.independent(i, &t[i - from..], None).err()
                };
                HistoryRow { entry: e.id, label: e.label.clone(), kind: e.kind, at_ms: e.at_ms, touched: touched_names(e), blocked }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{ConfigChange, HeadState, NewEntry, RefMove, Snapshot};

    fn head(oid: &str) -> HeadState {
        HeadState { branch: Some("main".into()), oid: Some(oid.into()) }
    }

    fn snap(paths: &[&str]) -> Snapshot {
        Snapshot { commit: "c".into(), paths: paths.iter().map(|p| p.to_string()).collect(), ..Default::default() }
    }

    fn add(j: &mut Journal, label: &str, undo: UndoKind, f: impl FnOnce(&mut JournalEntry)) -> u64 {
        let id = j.begin(NewEntry { label: label.into(), kind: OpKind::Discard, head_before: head("a"), undo }, 0);
        let e = j.entry_mut(id).unwrap();
        f(e);
        e.state = EntryState::Done;
        id
    }

    fn discard(j: &mut Journal, paths: &[&str]) -> u64 {
        add(j, &format!("discard {}", paths.join(", ")), UndoKind::Restore, |e| {
            e.before = Some(snap(paths));
            e.after = Some(snap(paths));
        })
    }

    #[test]
    fn a_discard_is_independent_of_a_later_change_to_another_file() {
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        discard(&mut j, &["b.txt"]);
        assert!(j.out_of_order(a, None).is_ok());
        let rows = j.history(None, &None);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "discard b.txt");
        assert_eq!(rows[1].blocked, None);
        assert_eq!(rows[1].touched, vec!["a.txt".to_string()]);
    }

    #[test]
    fn a_later_change_to_the_same_path_or_folder_makes_it_dependent() {
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["src/app.ts"]);
        discard(&mut j, &["src/app.ts"]);
        assert_eq!(j.out_of_order(a, None).unwrap_err(), "A later action changed src/app.ts");
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["src/app.ts"]);
        discard(&mut j, &["src"]);
        assert_eq!(j.out_of_order(a, None).unwrap_err(), "A later action changed src/app.ts");
        assert_eq!(j.history(None, &None)[1].blocked.as_deref(), Some("A later action changed src/app.ts"));
        // `srcx` isn't under `src`.
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["src/app.ts"]);
        discard(&mut j, &["srcx"]);
        assert!(j.out_of_order(a, None).is_ok());
    }

    #[test]
    fn a_later_commit_moves_head_under_a_snapshot() {
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        add(&mut j, "commit \"x\"", UndoKind::MoveRefs, |e| {
            e.refs = vec![RefMove { name: "refs/heads/main".into(), old: Some("a".into()), new: Some("b".into()) }];
            e.head_after = head("b");
        });
        assert!(j.out_of_order(a, None).is_err());
    }

    /// Follow-up 1: a commit, a checkout or a stash touches the paths it changed (`tree_paths`);
    /// resets stay strict, and an unrecorded HEAD move touches every path.
    #[test]
    fn recorded_tree_paths_make_commits_checkouts_and_stashes_path_based() {
        fn commit(paths: Option<&'static [&'static str]>) -> impl FnOnce(&mut JournalEntry) {
            move |e: &mut JournalEntry| {
                e.refs = vec![RefMove { name: "refs/heads/main".into(), old: Some("a".into()), new: Some("b".into()) }];
                e.head_after = head("b");
                e.tree_paths = paths.map(|p| p.iter().map(|s| s.to_string()).collect());
            }
        }
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        add(&mut j, "commit B", UndoKind::MoveRefs, commit(Some(&["b.txt"])));
        assert!(j.out_of_order(a, None).is_ok(), "the commit didn't touch a.txt");
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        add(&mut j, "commit A", UndoKind::MoveRefs, commit(Some(&["a.txt"])));
        assert_eq!(j.out_of_order(a, None).unwrap_err(), "A later action changed a.txt");
        // An earlier commit, a later one on the same branch: the ref blocks it.
        let mut j = Journal::empty("/w");
        let first = add(&mut j, "commit B", UndoKind::MoveRefs, commit(Some(&["b.txt"])));
        add(&mut j, "commit C", UndoKind::MoveRefs, commit(Some(&["c.txt"])));
        assert_eq!(j.out_of_order(first, None).unwrap_err(), "A later action moved main");
        // A checkout and a stash by their paths; a reset strict whatever it recorded.
        for (undo, ok) in [(UndoKind::Switch, true), (UndoKind::Stash, true), (UndoKind::ResetSoft, false)] {
            let mut j = Journal::empty("/w");
            let a = discard(&mut j, &["a.txt"]);
            add(&mut j, "later", undo, |e| {
                e.head_after = HeadState { branch: Some("y".into()), oid: Some("b".into()) };
                e.tree_paths = Some(vec!["c.txt".into()]);
            });
            assert_eq!(j.out_of_order(a, None).is_ok(), ok, "{undo:?}");
        }
        // Not recorded (an older journal): every path.
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        add(&mut j, "commit ?", UndoKind::MoveRefs, commit(None));
        assert_eq!(j.out_of_order(a, None).unwrap_err(), "A later action changed the working tree (commit ?)");
    }

    /// Review 3: two 2000-path entries are checked by lookups, not pair by pair: fast.
    #[test]
    fn two_2000_path_entries_check_fast() {
        let paths = |dir: &str| (0..2000).map(|i| format!("src/{dir}/{i:04}.rs")).collect::<Vec<_>>();
        let (a, b) = (paths("a"), paths("b"));
        let mut j = Journal::empty("/w");
        let target = add(&mut j, "discard a", UndoKind::Restore, |e| {
            let s = Snapshot { commit: "c".into(), paths: a.clone(), ..Default::default() };
            e.before = Some(s.clone());
            e.after = Some(s);
        });
        add(&mut j, "commit b", UndoKind::MoveRefs, |e| {
            e.refs = vec![RefMove { name: "refs/heads/main".into(), old: Some("a".into()), new: Some("b".into()) }];
            e.head_after = head("b");
            e.tree_paths = Some(b.clone());
        });
        assert!(j.history(None, &None)[1].blocked.is_none());
        // This thread's own CPU time (`/proc/thread-self/schedstat`, ns), not the wall clock: every
        // test runs in parallel, and a loaded machine leaves a thread waiting. Best of 3.
        let cpu = || std::fs::read_to_string("/proc/thread-self/schedstat").ok().and_then(|s| s.split_whitespace().next()?.parse::<u64>().ok());
        let took = (0..3)
            .map(|_| {
                let (wall, ns) = (std::time::Instant::now(), cpu());
                assert!(j.out_of_order(target, None).is_ok());
                match (ns, cpu()) {
                    (Some(a), Some(b)) => std::time::Duration::from_nanos(b - a),
                    _ => wall.elapsed(),
                }
            })
            .min()
            .unwrap();
        assert!(took < std::time::Duration::from_millis(50), "{took:?}");
    }

    #[test]
    fn ref_overlap_and_upstream_config_are_dependent_and_unrelated_refs_are_not() {
        let mut j = Journal::empty("/w");
        let x = add(&mut j, "create branch x", UndoKind::MoveRefs, |e| e.refs = vec![RefMove { name: "refs/heads/x".into(), old: None, new: Some("a".into()) }]);
        add(&mut j, "create branch y", UndoKind::MoveRefs, |e| e.refs = vec![RefMove { name: "refs/heads/y".into(), old: None, new: Some("a".into()) }]);
        discard(&mut j, &["a.txt"]);
        assert!(j.out_of_order(x, None).is_ok(), "nothing later touched x");
        add(&mut j, "set upstream of x", UndoKind::MoveRefs, |e| e.config = vec![ConfigChange { key: "branch.x.merge".into(), old: vec![], new: vec!["refs/heads/x".into()] }]);
        let up = j.undo.last().unwrap().id;
        add(&mut j, "move x", UndoKind::MoveRefs, |e| e.refs = vec![RefMove { name: "refs/heads/x".into(), old: Some("a".into()), new: Some("b".into()) }]);
        assert_eq!(j.out_of_order(x, None).unwrap_err(), "A later action moved x");
        add(&mut j, "set upstream again", UndoKind::MoveRefs, |e| e.config = vec![ConfigChange { key: "branch.x.merge".into(), old: vec!["refs/heads/x".into()], new: vec![] }]);
        assert_eq!(j.out_of_order(up, None).unwrap_err(), "A later action changed branch.x.merge");
    }

    #[test]
    fn a_checkout_onto_a_created_branch_depends_on_it() {
        let mut j = Journal::empty("/w");
        let x = add(&mut j, "create branch x", UndoKind::MoveRefs, |e| e.refs = vec![RefMove { name: "refs/heads/x".into(), old: None, new: Some("a".into()) }]);
        add(&mut j, "checkout x", UndoKind::Switch, |e| e.head_after = HeadState { branch: Some("x".into()), oid: Some("a".into()) });
        assert_eq!(j.out_of_order(x, None).unwrap_err(), "A later action moved x");
    }

    #[test]
    fn undeterminable_entries_refuse() {
        // A later push, a running op, an unverified write: dependent.
        for f in [
            (|e: &mut JournalEntry| e.undo = UndoKind::Barrier) as fn(&mut JournalEntry),
            |e| e.blocked = Some(crate::journal::UNVERIFIED.into()),
            |e| e.stopped_pick = Some(Default::default()),
        ] {
            let mut j = Journal::empty("/w");
            let a = discard(&mut j, &["a.txt"]);
            add(&mut j, "later", UndoKind::MoveRefs, f);
            assert!(j.out_of_order(a, None).is_err());
        }
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        j.begin(NewEntry { label: "running".into(), kind: OpKind::Commit, head_before: head("a"), undo: UndoKind::MoveRefs }, 0);
        assert_eq!(j.out_of_order(a, None).unwrap_err(), "Another action is still running");
        let running = j.undo.last().unwrap().id;
        assert!(j.out_of_order(a, Some(running)).is_ok(), "its own entry is left out");
        // A checkout rewrote files it didn't list: any snapshot under it is dependent.
        let mut j = Journal::empty("/w");
        let a = discard(&mut j, &["a.txt"]);
        add(&mut j, "checkout y", UndoKind::Switch, |e| e.head_after = HeadState { branch: Some("y".into()), oid: Some("b".into()) });
        assert!(j.out_of_order(a, None).is_err());
    }

    #[test]
    fn only_restores_and_ref_moves_undo_out_of_order() {
        let mut j = Journal::empty("/w");
        let sw = add(&mut j, "checkout y", UndoKind::Switch, |e| e.head_after = HeadState { branch: Some("y".into()), oid: Some("b".into()) });
        let no_after = add(&mut j, "discard q", UndoKind::Restore, |e| e.before = Some(snap(&["q"])));
        add(&mut j, "create branch z", UndoKind::MoveRefs, |e| e.refs = vec![RefMove { name: "refs/heads/z".into(), old: None, new: Some("a".into()) }]);
        assert!(j.out_of_order(sw, None).is_err());
        assert!(j.out_of_order(no_after, None).is_err());
        assert_eq!(j.out_of_order(999, None).unwrap_err(), "The undo history changed; refreshed");
    }

    #[test]
    fn the_list_is_the_newest_ten_and_busy_blocks_the_older_ones() {
        let mut j = Journal::empty("/w");
        for i in 0..12 {
            discard(&mut j, &[&format!("f{i}")]);
        }
        let rows = j.history(None, &None);
        assert_eq!(rows.len(), HISTORY_ROWS);
        assert_eq!(rows[0].label, "discard f11");
        let rows = j.history(Some("rebase"), &Some("Finish or abort the rebase first".into()));
        assert!(rows.iter().all(|r| r.blocked.as_deref() == Some("Finish or abort the rebase first")));
    }
}
