//! The work done at an Edit stop of GitBolt's interactive rebase: the commits made there (spec #3
//! §3.5; UX L: the stop is "about to commit", so splitting is unstage some, Commit, commit the
//! rest), and what an Abort keeps of it. It's part of the paused rebase (Ruling 9): not journaled.

use crate::api::blocking;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::ChangeKind;
use crate::git::GitInvocation;
use crate::in_progress::InProgress;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::Path;
use crate::status::EntryKind;
use crate::write::{is_ancestor, Pre, WriteCx};

/// Fix round 1 (M4): an Edit stop of a rebase started outside GitBolt.
pub(crate) const NOT_OURS: &str = "Finish this rebase where you started it.";

/// The worktree's paused entry is GitBolt's interactive rebase (it carries the session).
pub(crate) fn gitbolt_owns_the_pause(pre: &Pre<'_>) -> Result<bool, GbError> {
    let journal = pre.api.journal(pre.root)?.load()?;
    Ok(journal.paused().and_then(|e| e.paused.as_ref()).is_some_and(|p| p.irebase.is_some()))
}

/// A commit made at an Edit stop (its pieces, through `Commit`; UX L: Continue's) goes on the paused entry, so
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

/// Before an Abort at an Edit stop: git won't overwrite an untracked file with the commit
/// `rebase --abort` goes back to (`rebase-merge/orig-head`), and a new file of the stop's commit,
/// unstaged there and never committed again, is one. A file with exactly that commit's content is the commit's own: it
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

/// What an Abort keeps of the work done at the stop (fix round 2, I2; UX N: only what's worth
/// keeping): commits on a branch, the worktree's edits in a stash, and the journal's kept-stash
/// record for that stash.
pub(crate) struct KeptWork {
    /// The stash of the worktree's edits (its oid), listed before the abort.
    pub stash: Option<String>,
    /// `<branch>-rebase-work`, at HEAD: the commits made at the stop.
    pub branch: Option<String>,
    record: Option<u64>,
    head: Option<String>,
    /// The worktree's status before the abort (`--porcelain=v2`, with index oids): an abort
    /// that failed after resetting files changed it.
    status: Vec<u8>,
    /// UX N: the changed paths' worktree content before the abort, for the same check.
    worktree: Option<BTreeMap<String, State>>,
    /// Fix round 1: the whole-worktree stash's tree (`keep_whole`), for the same check.
    tree: Option<String>,
}

/// UX N: a path's content in a tree or an index: its kind (`kind_of`) and object; `None`: absent.
type State = Option<(u8, gix::ObjectId)>;

/// A mode as git keeps it: a file (0), an executable (1), a link (2), a submodule (3), a tree (4).
fn kind_of(mode: u32) -> u8 {
    match mode & 0o170000 {
        0o120000 => 2,
        0o160000 => 3,
        0o040000 => 4,
        _ if mode & 0o111 != 0 => 1,
        _ => 0,
    }
}

fn mode_of(kind: u8) -> &'static str {
    match kind {
        1 => "100755",
        2 => "120000",
        3 => "160000",
        4 => "040000",
        _ => "100644",
    }
}

fn nul_list<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for p in paths {
        bytes.extend_from_slice(p.as_bytes());
        bytes.push(0);
    }
    bytes
}

/// `ls-files -s -z`: (path, stage, content).
fn listed(out: &[u8]) -> Vec<(String, u8, (u8, gix::ObjectId))> {
    out.split(|b| *b == 0)
        .filter_map(|rec| {
            let tab = rec.iter().position(|b| *b == b'\t')?;
            let meta = std::str::from_utf8(&rec[..tab]).ok()?;
            let mut f = meta.split(' ');
            let mode = u32::from_str_radix(f.next()?, 8).ok()?;
            let oid = gix::ObjectId::from_hex(f.next()?.as_bytes()).ok()?;
            let stage = f.next()?.parse().ok()?;
            Some((String::from_utf8_lossy(&rec[tab + 1..]).into_owned(), stage, (kind_of(mode), oid)))
        })
        .collect()
}

/// `diff-tree -r -z` (raw): each path and its new content; `None` when the line can't be read
/// (it counts as new).
fn raw_changes(out: &[u8]) -> Vec<(String, Option<State>)> {
    let mut changes = Vec::new();
    let mut it = out.split(|b| *b == 0).filter(|t| !t.is_empty());
    while let Some(meta) = it.next() {
        if meta.first() != Some(&b':') {
            continue;
        }
        let Some(path) = it.next() else { break };
        let meta = String::from_utf8_lossy(&meta[1..]);
        let f: Vec<&str> = meta.split(' ').collect();
        let state = match f.as_slice() {
            [_, _, _, _, status, ..] if status.starts_with('D') => Some(None),
            [_, mode, _, oid, ..] => u32::from_str_radix(mode, 8).ok().zip(gix::ObjectId::from_hex(oid.as_bytes()).ok()).map(|(m, o)| Some((kind_of(m), o))),
            _ => None,
        };
        changes.push((String::from_utf8_lossy(path).into_owned(), state));
    }
    changes
}

/// `path`'s content in each of `trees`.
fn states_in(trees: &[gix::Tree<'_>], path: &str) -> Result<Vec<State>, GbError> {
    trees.iter().map(|t| Ok(t.lookup_entry_by_path(path).map_err(gix_err)?.map(|e| (kind_of(e.mode().value() as u32), e.object_id())))).collect()
}

fn load_trees<'r>(repo: &'r gix::Repository, ids: &BTreeSet<gix::ObjectId>) -> Result<Vec<gix::Tree<'r>>, GbError> {
    ids.iter().map(|t| repo.find_tree(*t).map_err(gix_err)).collect()
}

/// A path of the index: its stage-0 content (`None`: not in the index), or conflicted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Staged(State),
    Unmerged,
}

/// The index's side of `paths` (the repository's index, or the temp one `temp`).
async fn index_sides(cx: &WriteCx<'_>, paths: &BTreeSet<String>, temp: Option<&Path>) -> Result<BTreeMap<String, Side>, GbError> {
    let mut out: BTreeMap<String, Side> = paths.iter().map(|p| (p.clone(), Side::Staged(None))).collect();
    let all: Vec<&String> = paths.iter().collect();
    for chunk in all.chunks(500) {
        let mut args: Vec<OsString> = ["ls-files", "-s", "-z", "--"].into_iter().map(OsString::from).collect();
        args.extend(chunk.iter().map(|p| OsString::from(p.as_str())));
        let mut inv = GitInvocation::new(cx.root, args).env("GIT_LITERAL_PATHSPECS", "1");
        if let Some(t) = temp {
            inv = inv.env("GIT_INDEX_FILE", t);
        }
        for (p, stage, s) in listed(&cx.api.cli.run(inv).await?.stdout) {
            if let Some(side) = out.get_mut(&p) {
                *side = if stage == 0 { Side::Staged(Some(s)) } else { Side::Unmerged };
            }
        }
    }
    Ok(out)
}

/// The worktree's side of `paths`, as `git add` would store it (filters, links, the executable
/// bit), through a temp index copied from the real one, as `git stash` does (fix round 1: so
/// `core.fileMode=false` and `core.symlinks=false` keep the index's modes): the real one isn't
/// touched. A directory is a submodule: its commit is the index's (`index`).
async fn worktree_states(cx: &WriteCx<'_>, paths: &BTreeSet<String>, index: &BTreeMap<String, Side>) -> Result<BTreeMap<String, State>, GbError> {
    let mut out = BTreeMap::new();
    let mut files = Vec::new();
    for p in paths {
        match std::fs::symlink_metadata(cx.root.join(p)) {
            Ok(m) if m.is_dir() => drop(out.insert(p.clone(), if let Some(Side::Staged(s)) = index.get(p) { *s } else { None })),
            Ok(_) => files.push(p.clone()),
            Err(_) => drop(out.insert(p.clone(), None)),
        }
    }
    if files.is_empty() {
        return Ok(out);
    }
    let dir = tempfile::Builder::new().prefix("abort-").tempdir_in(&cx.tmp)?;
    let temp = dir.path().join("index");
    let real = gix::open(cx.root).map_err(gix_err)?.index_path();
    if real.is_file() {
        std::fs::copy(&real, &temp)?;
    }
    let inv = cx.git_stash(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"]).env("GIT_INDEX_FILE", &temp).stdin(nul_list(&files));
    cx.api.cli.run(inv).await?;
    let files: BTreeSet<String> = files.into_iter().collect();
    for (p, side) in index_sides(cx, &files, Some(&temp)).await? {
        out.insert(p, if let Side::Staged(s) = side { s } else { None });
    }
    Ok(out)
}

/// `base`'s tree with `entries` set (`None`: removed), through a temp index. `--replace` (fix
/// round 1; `--index-info` implies it, said explicitly): a file where `base` has a directory (or
/// the reverse) replaces it.
async fn tree_with<'a>(cx: &WriteCx<'_>, base: &str, entries: impl IntoIterator<Item = (&'a String, State)>) -> Result<String, GbError> {
    let dir = tempfile::Builder::new().prefix("abort-").tempdir_in(&cx.tmp)?;
    let temp = dir.path().join("index");
    let mut info = Vec::new();
    for (p, s) in entries {
        let meta = match s {
            Some((k, oid)) => format!("{} {oid}\t", mode_of(k)),
            None => format!("0 {}\t", "0".repeat(base.len())),
        };
        info.extend_from_slice(meta.as_bytes());
        info.extend_from_slice(p.as_bytes());
        info.push(0);
    }
    cx.api.cli.run(cx.git_stash(["read-tree", base]).env("GIT_INDEX_FILE", &temp)).await?;
    cx.api.cli.run(cx.git_stash(["update-index", "--replace", "-z", "--index-info"]).env("GIT_INDEX_FILE", &temp).stdin(info)).await?;
    let out = cx.api.cli.run(cx.git_stash(["write-tree"]).env("GIT_INDEX_FILE", &temp)).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn commit_tree(cx: &WriteCx<'_>, tree: &str, parents: &[&str], message: &str) -> Result<String, GbError> {
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree];
    for p in parents {
        args.extend(["-p", p]);
    }
    args.extend(["-m", message]);
    let out = cx.api.cli.run(cx.git_stash(args)).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// UX N: where a git step of the rebase started, for `note_stop`.
pub(crate) enum Before {
    /// The rebase's Start: any stop is one git just made.
    Start,
    /// A stop (its key, `last_done`): a stop with another key is one git just made.
    At(String),
    /// Unreadable (fix round 1): no stop is taken for git's own.
    Unknown,
}

impl Before {
    pub(crate) fn made(&self, at: &str) -> bool {
        match self {
            Before::Start => true,
            Before::At(k) => k != at,
            Before::Unknown => false,
        }
    }
}

/// UX N: the current stop's key.
pub(crate) fn stop_key(root: &Path) -> Before {
    match gix::open(root).ok().and_then(|r| crate::in_progress::last_done(r.git_dir())) {
        Some(k) => Before::At(k),
        None => Before::Unknown,
    }
}

/// UX N: at a stop git just made, what it left there (its merge result in the index, a
/// conflicted file's markers): content that's git's, never the user's, which an Abort doesn't
/// keep while it's still exactly that. Only the index of a staged path (git leaves its worktree
/// file the same) and the worktree file of a conflicted one. A failure is logged: the Abort then
/// keeps more, never less.
pub(crate) async fn note_stop(cx: &WriteCx<'_>, git_dir: &Path, at: &str) {
    let content = async {
        let mut staged = BTreeSet::new();
        let mut unmerged = BTreeSet::new();
        for e in crate::status::status(&cx.api.cli, cx.root).await? {
            match e.kind {
                EntryKind::Unmerged => drop(unmerged.insert(e.path)),
                EntryKind::Ordinary | EntryKind::Renamed if e.index != '.' => {
                    staged.insert(e.path);
                    staged.extend(e.orig_path);
                }
                _ => {}
            }
        }
        if staged.is_empty() && unmerged.is_empty() {
            return Ok::<_, GbError>(None);
        }
        let mut out: Vec<(String, Option<(u8, String)>)> = Vec::new();
        for (p, side) in index_sides(cx, &staged, None).await? {
            if let Side::Staged(s) = side {
                out.push((p, s.map(|(k, o)| (k, o.to_string()))));
            }
        }
        for (p, s) in worktree_states(cx, &unmerged, &BTreeMap::new()).await? {
            out.push((p, s.map(|(k, o)| (k, o.to_string()))));
        }
        Ok(Some(serde_json::to_string(&out).map_err(|e| GbError::other(e.to_string()))?))
    };
    let res = match content.await {
        // Fix round 1: nothing to record; an older stop's note goes.
        Ok(None) => match std::fs::remove_file(git_dir.join(crate::in_progress::STOP_CONTENT)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
        Ok(Some(text)) => crate::in_progress::write_stop_note(git_dir, crate::in_progress::STOP_CONTENT, at, &text).map_err(|e| e.to_string()),
        Err(e) => Err(e.message),
    };
    if let Err(e) = res {
        tracing::warn!(target: "gitbolt_core::write", "noting what git left at the rebase's stop: {e}");
    }
}

/// The current stop's `note_stop` content, path → contents.
fn stop_content(root: &Path) -> BTreeMap<String, Vec<State>> {
    let mut out: BTreeMap<String, Vec<State>> = BTreeMap::new();
    let Ok(repo) = gix::open(root) else { return out };
    let git_dir = repo.git_dir();
    let Some(text) = crate::in_progress::last_done(git_dir).and_then(|at| crate::in_progress::stop_note(git_dir, crate::in_progress::STOP_CONTENT, &at)) else { return out };
    let list: Vec<(String, Option<(u8, String)>)> = serde_json::from_str(&text).unwrap_or_default();
    for (p, s) in list {
        let s = match s {
            Some((k, o)) => match gix::ObjectId::from_hex(o.as_bytes()) {
                Ok(o) => Some((k, o)),
                Err(_) => continue,
            },
            None => None,
        };
        out.entry(p).or_default().push(s);
    }
    out
}

/// A commit HEAD has beyond `onto`, or an original pick: its oid and first parent.
#[derive(Debug, Clone)]
struct Commit {
    oid: String,
    parent: Option<String>,
}

/// UX N: what an Abort's work is judged against.
struct Sources {
    /// Trees a path's content can be had from again: orig-head, the stopped commit (git's and
    /// the original), HEAD, and the autostash the rebase holds (each of its trees).
    trees: BTreeSet<gix::ObjectId>,
    /// The commits made at the stops (by GitBolt's Commit, or in a terminal): not replays. Each
    /// with whether its message is none of the original picks'.
    made: Vec<(Commit, bool)>,
    /// Fix round 1: the replays of the original picks (a conflict resolved by hand at an earlier
    /// stop is in one), each with the picks it may replay (by author and time).
    replays: Vec<(Commit, Vec<Commit>)>,
    /// The trees of orig-head's history (the rebased range, its parents, `onto`) and of the
    /// stopped commit: content in one of them at its path is no new work.
    history: BTreeSet<gix::ObjectId>,
    /// The history couldn't be read: the commits are kept (`true`) whenever HEAD can be.
    fallback: Option<bool>,
}

/// Reads `Sources` (blocking).
fn sources(repo: &gix::Repository, head: Option<&str>, edit_stop: Option<&str>, stopped_at: Option<&str>, onto: &str, autostash: Option<&str>, made: &[String]) -> Result<Sources, GbError> {
    let rev = |h: &str| repo.rev_parse_single(h.trim()).ok().map(|i| i.detach());
    let tree_of = |c: gix::ObjectId| repo.find_commit(c).ok().and_then(|c| c.tree_id().ok()).map(|t| t.detach());
    let orig = std::fs::read_to_string(repo.git_dir().join("rebase-merge/orig-head")).ok().and_then(|t| rev(&t));
    let (head, stop, stopped, onto) = (head.and_then(rev), edit_stop.and_then(rev), stopped_at.and_then(rev), rev(onto));
    let mut s = Sources { trees: BTreeSet::new(), made: Vec::new(), replays: Vec::new(), history: BTreeSet::new(), fallback: None };
    s.trees.extend([orig, stop, stopped, head].into_iter().flatten().filter_map(tree_of));
    if let Some(a) = autostash.and_then(rev).and_then(|a| repo.find_commit(a).ok()) {
        s.trees.extend(a.tree_id().ok().map(|t| t.detach()));
        s.trees.extend(a.parent_ids().skip(1).filter_map(|p| tree_of(p.detach())));
    }
    let (Some(h), Some(o), Some(b)) = (head, orig, onto) else {
        s.fallback = Some(head.is_some());
        return Ok(s);
    };
    // Fix round 3: at an Edit stop, a commit off the stop's commit is made there too (a terminal
    // amend or `commit -C` keeps author and time, so it reads as a replay), unless HEAD is only
    // below it (UX L: on its parent, the "about to commit" stop).
    let off_stop = |c: gix::ObjectId| stop.is_some_and(|st| !is_ancestor(repo, c, st));
    let author = |c: &gix::Commit<'_>| -> Result<(Vec<u8>, String), GbError> {
        let a = c.author().map_err(gix_err)?;
        Ok((a.email.to_vec(), a.time.to_string()))
    };
    let message = |c: &gix::Commit<'_>| -> Result<String, GbError> { Ok(c.message_raw().map_err(gix_err)?.to_string().trim_end().to_string()) };
    let commit = |c: &gix::Commit<'_>| Commit { oid: c.id.to_string(), parent: c.parent_ids().next().map(|p| p.to_string()) };
    let mut picks: BTreeMap<(Vec<u8>, String), Vec<Commit>> = BTreeMap::new();
    let mut messages = BTreeSet::new();
    for info in repo.rev_walk([o]).with_hidden([b]).all().map_err(gix_err)? {
        let c = repo.find_commit(info.map_err(gix_err)?.id).map_err(gix_err)?;
        picks.entry(author(&c)?).or_default().push(commit(&c));
        messages.insert(message(&c)?);
        s.history.insert(c.tree_id().map_err(gix_err)?.detach());
        s.history.extend(c.parent_ids().filter_map(|p| tree_of(p.detach())));
    }
    s.history.extend([Some(b), stop, stopped].into_iter().flatten().filter_map(tree_of));
    // The commits HEAD has beyond `onto`: made at a stop (`made`, one that isn't a replay of one
    // of `orig`'s by author and time, as settle's completion check, or one off the stop's
    // commit), or replays.
    for info in repo.rev_walk([h]).with_hidden([b]).all().map_err(gix_err)? {
        let c = repo.find_commit(info.map_err(gix_err)?.id).map_err(gix_err)?;
        let replays = picks.get(&author(&c)?);
        if made.iter().any(|m| m == &c.id.to_string()) || replays.is_none() || off_stop(c.id) {
            s.made.push((commit(&c), !messages.contains(&message(&c)?)));
        } else {
            s.replays.push((commit(&c), replays.cloned().unwrap_or_default()));
        }
    }
    Ok(s)
}

/// `c`'s changes from its first parent: each path and its new content (`None`: unreadable).
async fn changes_of(cx: &WriteCx<'_>, c: &Commit) -> Result<Vec<(String, Option<State>)>, GbError> {
    let args = match &c.parent {
        Some(p) => vec!["diff-tree", "-r", "--no-renames", "-z", p.as_str(), c.oid.as_str()],
        None => vec!["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "-z", c.oid.as_str()],
    };
    Ok(raw_changes(&cx.api.cli.run(GitInvocation::new(cx.root, args)).await?.stdout))
}

/// The `changes` no tree of `trees` has at their path (an unreadable one never is).
async fn not_in(cx: &WriteCx<'_>, trees: &BTreeSet<gix::ObjectId>, changes: Vec<(String, Option<State>)>) -> Result<Vec<(String, Option<State>)>, GbError> {
    let (root, trees) = (cx.root.to_path_buf(), trees.clone());
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let trees = load_trees(&repo, &trees)?;
        let mut left = Vec::new();
        for (p, s) in changes {
            match s {
                Some(s) if states_in(&trees, &p)?.contains(&s) => {}
                _ => left.push((p, s)),
            }
        }
        Ok(left)
    })
    .await
}

/// UX N: the commits beyond `onto` hold new work, so HEAD goes on the work branch:
/// - a commit made at a stop whose message differs from every original pick's (a split piece's
///   own, a reword typed at the stop: the user's typing), or that introduces content found
///   nowhere in orig-head's history (the picks, their parents, `onto`) or the stopped commit. A
///   re-commit of a pick's own content, whole or in part, under that pick's message isn't kept;
/// - fix round 1: a replay with such content that git's own merge of its pick onto the replay's
///   parent doesn't have either (a conflict resolved by hand at an earlier stop; a clean merge
///   with `onto`'s changes, or a side taken whole, is git's).
async fn new_work_in_commits(cx: &WriteCx<'_>, src: &Sources) -> Result<bool, GbError> {
    if let Some(keep) = src.fallback {
        return Ok(keep);
    }
    if src.made.iter().any(|m| m.1) {
        return Ok(true);
    }
    for (c, _) in &src.made {
        if !not_in(cx, &src.history, changes_of(cx, c).await?).await?.is_empty() {
            return Ok(true);
        }
    }
    for (c, picks) in &src.replays {
        let mut left = not_in(cx, &src.history, changes_of(cx, c).await?).await?;
        for p in picks {
            if left.is_empty() {
                break;
            }
            let (Some(parent), Some(base)) = (&c.parent, &p.parent) else { continue };
            let merge_base = format!("--merge-base={base}");
            let inv = cx.git_stash(["merge-tree", "--write-tree", "--no-messages", merge_base.as_str(), parent.as_str(), p.oid.as_str()]).ok_exit(1);
            let Ok(out) = cx.api.cli.run(inv).await else { continue };
            let first = out.stdout.split(|b| *b == b'\n').next().unwrap_or_default();
            let Ok(tree) = gix::ObjectId::from_hex(first) else { continue };
            left = not_in(cx, &BTreeSet::from([tree]), left).await?;
        }
        if !left.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Before an Abort of GitBolt's interactive rebase (I2, fix round 2): `rebase --abort` resets the
/// worktree, index and HEAD to where the rebase started. What was done at the stop is kept first,
/// each kind by what fits it, and (UX N) only what can't be had again (`Sources`):
/// - commits holding new work (`new_work_in_commits`): a real branch at HEAD,
///   `<branch>-rebase-work` (`-2`, `-3`… when taken). GitBolt never deletes it: it isn't in an
///   undoable entry (the abort has none, and the paused entry's settle doesn't record it).
/// - the index's and the worktree's tracked edits, a conflicted file's too: a stash of only the
///   paths whose content (either side) is in none of orig-head, the stopped commit, HEAD, the
///   autostash, or what git itself left at the stop (`note_stop`). Listed before the abort, so
///   it's reachable.
///
/// Nothing worth keeping: no branch, no stash, no banner. Fix round 1: a changed path that isn't
/// UTF-8 can't be judged path by path, so everything is kept, as before UX N: HEAD on the branch
/// (when it has commits beyond `onto`) and the whole worktree in the stash. Undone by
/// `finish_kept_work` if the abort fails.
pub(crate) async fn keep_work(cx: &mut WriteCx<'_>, s: &crate::journal::IrebaseState) -> Result<KeptWork, GbError> {
    let mut w = KeptWork { stash: None, branch: None, record: None, head: cx.before.head.oid.clone(), status: Vec::new(), worktree: None, tree: None };
    let Some(InProgress::Rebase { edit_stop, head_name, onto, stopped_at, .. }) = crate::in_progress::read(cx.root)? else { return Ok(w) };
    let short = crate::error::short_ref(&head_name).to_string();
    let journal = cx.api.journal(cx.root)?.load()?;
    let autostash = journal.paused().and_then(|e| e.paused.as_ref()?.autostash).and_then(|id| journal.kept.iter().find(|k| k.id == id)?.oid.clone());
    let (root, head, made) = (cx.root.to_path_buf(), w.head.clone(), s.made.clone());
    let src = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        sources(&repo, head.as_deref(), edit_stop.as_deref(), stopped_at.as_deref(), &onto, autostash.as_deref(), &made)
    })
    .await?;
    w.status = crate::status::status_raw(&cx.api.cli, cx.root).await?;
    let whole = !tracked_paths_utf8(&w.status);
    // Commits.
    let keep = match src.fallback {
        Some(keep) => keep,
        None if whole => !src.made.is_empty() || !src.replays.is_empty(),
        None => new_work_in_commits(cx, &src).await?,
    };
    if let (true, Some(head)) = (keep, w.head.clone()) {
        w.branch = Some(work_branch(cx, &short, &head).await?);
    }
    // Edits. 3C final fix (M5): a failure here takes the work branch back, as the later ones do.
    let res = if whole { keep_whole(cx, &mut w, &short).await } else { keep_edits(cx, &mut w, &src, &short).await };
    if let Err(e) = res {
        finish_kept_work(cx, &w, false).await;
        return Err(e);
    }
    Ok(w)
}

/// Fix round 1: every tracked path of a `--porcelain=v2 -z` status is UTF-8 (`keep_edits` reads
/// them as strings).
fn tracked_paths_utf8(raw: &[u8]) -> bool {
    let mut it = raw.split(|b| *b == 0);
    while let Some(rec) = it.next() {
        let ok = match rec.first() {
            Some(b'1' | b'u') => std::str::from_utf8(rec).is_ok(),
            Some(b'2') => std::str::from_utf8(rec).is_ok() && it.next().is_none_or(|o| std::str::from_utf8(o).is_ok()),
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Fix round 1: the whole worktree's tracked edits in the stash (`git stash create`, as before
/// UX N); an unmerged index refuses it, and so the Abort.
async fn keep_whole(cx: &mut WriteCx<'_>, w: &mut KeptWork, short: &str) -> Result<(), GbError> {
    let message = format!("GitBolt: work from the aborted rebase of {short}");
    let out = cx.run_git(cx.git_stash(["stash", "create", message.as_str()])).await?;
    let created = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if created.is_empty() {
        return Ok(());
    }
    w.tree = stash_tree(cx, &created).await;
    store_kept(cx, w, short, created, message).await
}

async fn stash_tree(cx: &WriteCx<'_>, stash: &str) -> Option<String> {
    let spec = format!("{stash}^{{tree}}");
    cx.api.cli.run(GitInvocation::new(cx.root, ["rev-parse", spec.as_str()])).await.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// `keep_work`'s stash: HEAD, with only the paths worth keeping changed, in the index (`I`, its
/// second parent) and the worktree (the stash commit's own tree), as `git stash` shapes it.
async fn keep_edits(cx: &mut WriteCx<'_>, w: &mut KeptWork, src: &Sources, short: &str) -> Result<(), GbError> {
    let mut paths = BTreeSet::new();
    for e in crate::status::parse_porcelain_v2(&w.status) {
        if matches!(e.kind, EntryKind::Ordinary | EntryKind::Renamed | EntryKind::Unmerged) {
            paths.insert(e.path);
            paths.extend(e.orig_path);
        }
    }
    if paths.is_empty() {
        return Ok(());
    }
    let index = index_sides(cx, &paths, None).await?;
    let worktree = worktree_states(cx, &paths, &index).await?;
    w.worktree = Some(worktree.clone());
    let at_stop = stop_content(cx.root);
    let (root, trees, all) = (cx.root.to_path_buf(), src.trees.clone(), paths.clone());
    let known = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let trees = load_trees(&repo, &trees)?;
        all.into_iter().map(|p| Ok((p.clone(), states_in(&trees, &p)?))).collect::<Result<BTreeMap<_, _>, GbError>>()
    })
    .await?;
    let new = |p: &str, s: &State| !known.get(p).is_some_and(|k| k.contains(s)) && !at_stop.get(p).is_some_and(|k| k.contains(s));
    // A conflicted path's index is its stages: the commits' own content.
    let worth: Vec<&String> = paths.iter().filter(|p| matches!(index.get(*p), Some(Side::Staged(s)) if new(p, s)) || worktree.get(*p).is_some_and(|s| new(p, s))).collect();
    let Some(head) = w.head.clone().filter(|_| !worth.is_empty()) else { return Ok(()) };
    let staged = worth.iter().filter_map(|p| match index.get(*p) {
        Some(Side::Staged(s)) => Some((*p, *s)),
        _ => None,
    });
    let itree = tree_with(cx, &head, staged).await?;
    let wtree = tree_with(cx, &head, worth.iter().map(|p| (*p, worktree.get(*p).copied().flatten()))).await?;
    let message = format!("GitBolt: work from the aborted rebase of {short}");
    let i = commit_tree(cx, &itree, &[&head], &format!("index on {short}")).await?;
    let created = commit_tree(cx, &wtree, &[&head, &i], &message).await?;
    store_kept(cx, w, short, created, message).await
}

/// The kept stash `created`: its journal record (no banner while the Abort runs), then listed.
async fn store_kept(cx: &mut WriteCx<'_>, w: &mut KeptWork, short: &str, created: String, message: String) -> Result<(), GbError> {
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
    w.record = Some(cx.api.journal(cx.root)?.update(|j| j.keep(k))?);
    cx.journal_changed = true;
    let inv = cx.git_stash(["stash", "store", "-m", message.as_str(), created.as_str()]);
    let stored = cx.run_git(inv).await;
    cx.touch(ChangeKind::Stash);
    w.stash = Some(created);
    stored.map(drop)
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
/// HEAD is still where it was at the stop, and the worktree is as it was (its status, and UX N:
/// the changed paths' content). Otherwise git got part-way: the work's stash and branch stay,
/// and the error says where they are. Anything unreadable counts as touched.
pub(crate) async fn untouched(cx: &WriteCx<'_>, w: &KeptWork) -> bool {
    let head = gix::open(cx.root).ok().and_then(|r| r.head_id().ok().map(|h| h.to_string()));
    if !matches!(crate::in_progress::read(cx.root), Ok(Some(InProgress::Rebase { .. }))) || head != w.head {
        return false;
    }
    if crate::status::status_raw(&cx.api.cli, cx.root).await.ok().as_ref() != Some(&w.status) {
        return false;
    }
    if let Some(tree) = &w.tree {
        let now = match cx.api.cli.run(GitInvocation::new(cx.root, ["stash", "create"])).await {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(_) => return false,
        };
        return !now.is_empty() && stash_tree(cx, &now).await.as_ref() == Some(tree);
    }
    let Some(before) = &w.worktree else { return true };
    let paths: BTreeSet<String> = before.keys().cloned().collect();
    let Ok(index) = index_sides(cx, &paths, None).await else { return false };
    worktree_states(cx, &paths, &index).await.ok().as_ref() == Some(before)
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
        let res = res.and_then(|_| {
            if l.executable { crate::platform::fs::set_mode(&file, 0o755).map_err(|e| e.to_string()) } else { Ok(()) }
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

    /// UX L: the stop's changes, staged there, all unstaged (what 3C's Split left).
    fn unstage_all(r: &TestRepo) {
        r.git(&["reset", "-q"]);
    }

    async fn commit(api: &crate::api::Api, id: u32, r: &TestRepo, summary: &str) -> serde_json::Value {
        call(api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": summary, "expect": {} })).await.unwrap()
    }

    /// §3.5, §7 (e2e 2's core), UX L: B2's changes staged at the stop, unstaged, committed again
    /// in two pieces, Continue; feature/b follows the last piece, and one Undo restores the
    /// original history.
    #[tokio::test]
    async fn split_then_commit_pieces_then_continue() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "S1 Side work", "HEAD on B2's parent (S1, the merge flattened)");
        assert_eq!(r.git(&["status", "--porcelain"]), "A  lexer.txt\nA  lexer_test.txt");
        unstage_all(&r);
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

    /// Fix round 2 (test 3), UX L: the stop's changes unstaged, then Abort with nothing new:
    /// nothing is kept.
    #[tokio::test]
    async fn unstaged_then_abort_restores_the_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        unstage_all(&r);
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["status"], "aborted");
        assert!(res["outcome"]["stash"].is_null() && res["outcome"]["branch"].is_null(), "{res}");
        assert_eq!(tips(&r), before);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// Fix round 2 (test 3), UX L: C1's change to a tracked file, unstaged at its stop, is in the
    /// worktree, exactly the stopped commit's content: no stash, no branch.
    #[tokio::test]
    async fn a_tracked_change_unstaged_then_abort_keeps_nothing() {
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
        unstage_all(&r);
        assert!(r.git(&["status", "--porcelain"]).contains("notes.txt"));
        let res = abort(&api, id, &r).await.unwrap();
        assert!(res["outcome"]["stash"].is_null() && res["outcome"]["branch"].is_null(), "{res}");
        assert_eq!(r.git(&["stash", "list"]), "");
        assert_eq!(tips(&r), before);
    }

    /// Fix round 2 (test 4): an abort git refuses (an edited, untracked piece) resets
    /// nothing, so what was kept for it goes again: the stash entry and the work branch.
    #[tokio::test]
    async fn abort_never_removes_an_edited_piece() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        unstage_all(&r);
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

    /// Fix round 2 (test 1): the stop's changes unstaged, one piece committed (UX N: B2's content,
    /// but a message of its own: new work), edited again, Abort. The piece is on
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
        unstage_all(&r);
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
    /// Abort: the commit is on the work branch. UX N: the conflicted file, as git left it, isn't
    /// work: no stash, and nothing counted as discarded.
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
        assert!(res["outcome"]["discarded"].is_null(), "{res}");
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
        unstage_all(&r);
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
        unstage_all(&r);
        r.git(&["add", "lexer.txt"]);
        commit(&api, id, &r, "Lexer").await;
        r.write("lexer.txt", "lexer, edited at the stop\n");
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work-2", "{res}");
        assert_eq!(res["journal"]["banners"][0]["target"], "feature/c-rebase-work-2");
    }

    /// Fix round 1 (M4): an Edit stop of a rebase started in a terminal takes no commit from
    /// GitBolt.
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
    }

    /// UX L (L.4): the stop's commit, staged there, changed and staged again, then Abort: the
    /// change is kept in a stash; nothing was committed, so no branch.
    #[tokio::test]
    async fn a_staged_change_at_the_stop_is_kept_by_abort() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let before = tips(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        stop_at_b2(&api, id, &r).await;
        r.write("lexer.txt", "lexer, changed at the stop\n");
        r.git(&["add", "lexer.txt"]);
        let res = abort(&api, id, &r).await.unwrap();
        assert!(res["outcome"]["branch"].is_null(), "{res}");
        let stash = res["outcome"]["stash"].as_str().expect("a stash").to_string();
        assert_eq!(r.git(&["show", &format!("{stash}:lexer.txt")]), "lexer, changed at the stop");
        assert_eq!(tips(&r), before);
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

    // --- UX N: Abort keeps only what's worth keeping ---
    async fn fresh() -> (tempfile::TempDir, TestRepo, crate::api::Api, u32) {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::irebase(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        (data, r, api, id)
    }

    /// C1 conflicts on A2's notes.txt (the order puts it first).
    async fn conflict_stop(api: &crate::api::Api, id: u32, r: &TestRepo) {
        let p = plan(api, id, r).await;
        let rows = crate::write::irebase::run::tests::order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        assert_eq!(start(api, id, r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        assert_eq!(r.git(&["status", "--porcelain"]), "UU notes.txt");
    }

    /// The abort kept nothing: no stash, no branch, no banner, no count; the branches as they were.
    fn kept_nothing(r: &TestRepo, res: &serde_json::Value, before: &[String], case: &str) {
        assert_eq!(res["outcome"]["status"], "aborted", "{case}: {res}");
        let o = &res["outcome"];
        assert!(o["stash"].is_null() && o["branch"].is_null() && o["discarded"].is_null(), "{case}: {res}");
        assert_eq!(res["journal"]["banners"], json!([]), "{case}: {res}");
        assert_eq!(r.git(&["stash", "list"]), "", "{case}");
        assert!(!r.git(&["branch", "--list", "*rebase-work*"]).contains("rebase-work"), "{case}");
        assert_eq!(tips(r), before, "{case}");
    }

    /// The kept stash's content of `path`, in its worktree tree.
    fn stashed(r: &TestRepo, res: &serde_json::Value, path: &str) -> String {
        let stash = res["outcome"]["stash"].as_str().unwrap_or_else(|| panic!("a stash: {res}"));
        r.git(&["show", &format!("{stash}:{path}")])
    }

    /// N.1 (1): a fresh Edit stop, nothing done there.
    #[tokio::test]
    async fn abort_at_an_untouched_edit_stop_keeps_nothing() {
        let (_d, r, api, id) = fresh().await;
        let before = tips(&r);
        stop_at_b2(&api, id, &r).await;
        let res = abort(&api, id, &r).await.unwrap();
        kept_nothing(&r, &res, &before, "fresh stop");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// N.1 (2), coordinator's ruling: pieces that commit the stop's own changes again (one, both,
    /// one with the rest staged) under messages of their own are the user's: they're on the work
    /// branch. What's left of the commit isn't stashed.
    #[tokio::test]
    async fn pieces_with_their_own_messages_are_kept_on_the_work_branch() {
        for case in ["one piece, the rest unstaged", "both pieces", "one piece, the rest staged"] {
            let (_d, r, api, id) = fresh().await;
            let before = tips(&r);
            stop_at_b2(&api, id, &r).await;
            if case == "one piece, the rest staged" {
                r.git(&["reset", "-q", "--", "lexer_test.txt"]);
                commit(&api, id, &r, "Lexer").await;
                r.git(&["add", "lexer_test.txt"]);
            } else {
                unstage_all(&r);
                r.git(&["add", "lexer.txt"]);
                commit(&api, id, &r, "Lexer").await;
                if case == "both pieces" {
                    r.git(&["add", "lexer_test.txt"]);
                    commit(&api, id, &r, "Lexer tests").await;
                }
            }
            let head = r.git(&["rev-parse", "HEAD"]);
            let res = abort(&api, id, &r).await.unwrap();
            assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work", "{case}: {res}");
            assert_eq!(branch_at(&r, "feature/c-rebase-work"), Some(head), "{case}");
            assert!(res["outcome"]["stash"].is_null(), "{case}: {res}");
            assert_eq!(r.git(&["stash", "list"]), "", "{case}");
            assert_eq!(tips(&r), before, "{case}");
            assert_eq!(r.git(&["status", "--porcelain"]), "", "{case}");
        }
    }

    /// N.2, coordinator's ruling: the stopped commit's content committed again with its own
    /// message (whole, or a piece of it) is an original pick redone: nothing is kept.
    #[tokio::test]
    async fn the_stopped_commit_recommitted_with_its_message_is_not_kept() {
        for piece in [false, true] {
            let (_d, r, api, id) = fresh().await;
            let before = tips(&r);
            stop_at_b2(&api, id, &r).await;
            if piece {
                r.git(&["reset", "-q", "--", "lexer_test.txt"]);
            }
            commit(&api, id, &r, "B2 Refine lexer").await;
            assert_eq!(r.git(&["log", "-1", "--format=%B"]), "B2 Refine lexer");
            let res = abort(&api, id, &r).await.unwrap();
            kept_nothing(&r, &res, &before, if piece { "a piece" } else { "the whole commit" });
            assert_eq!(r.git(&["status", "--porcelain"]), "");
        }
    }

    /// N.1 (3): a conflict stop with nothing resolved: git's own markers aren't work, so no
    /// stash and no "discarded" count (here, and at a conflict a Continue reached).
    #[tokio::test]
    async fn abort_at_an_unresolved_conflict_keeps_nothing() {
        let (_d, r, api, id) = fresh().await;
        let before = tips(&r);
        conflict_stop(&api, id, &r).await;
        let res = abort(&api, id, &r).await.unwrap();
        kept_nothing(&r, &res, &before, "at the start");
        let (_d, r, api, id) = fresh().await;
        let p = plan(&api, id, &r).await;
        let mut rows = crate::write::irebase::run::tests::order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        set(&p, &mut rows, "A1", "edit", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        assert_eq!(control(&api, id, &r, "continue").await["outcome"]["status"], "stopped", "C1 conflicts");
        let res = abort(&api, id, &r).await.unwrap();
        kept_nothing(&r, &res, &before, "after a Continue");
    }

    /// N.1 (4), N.2: a conflict resolved with the stopped commit's own side is in that commit:
    /// not kept. One resolved by hand is, staged or not (fix round 3 lost the unstaged one).
    #[tokio::test]
    async fn only_a_resolution_of_the_users_own_is_kept() {
        let (_d, r, api, id) = fresh().await;
        let before = tips(&r);
        conflict_stop(&api, id, &r).await;
        r.git(&["checkout", "--theirs", "notes.txt"]);
        r.git(&["add", "notes.txt"]);
        let res = abort(&api, id, &r).await.unwrap();
        kept_nothing(&r, &res, &before, "theirs");
        for staged in [true, false] {
            let (_d, r, api, id) = fresh().await;
            conflict_stop(&api, id, &r).await;
            r.write("notes.txt", "resolved by hand\n");
            if staged {
                r.git(&["add", "notes.txt"]);
            }
            let res = abort(&api, id, &r).await.unwrap();
            assert!(res["outcome"]["branch"].is_null() && res["outcome"]["discarded"].is_null(), "{res}");
            assert_eq!(stashed(&r, &res, "notes.txt"), "resolved by hand", "staged: {staged}");
            assert_eq!(res["journal"]["banners"][0]["kind"], "abortedWork");
            assert_eq!(tips(&r), before);
        }
    }

    /// N.3: a resolution left after a Continue git refused (the file still conflicted) isn't
    /// taken for git's own content: that stop's note is the one git made.
    #[tokio::test]
    async fn a_resolution_after_a_refused_continue_is_kept() {
        let (_d, r, api, id) = fresh().await;
        conflict_stop(&api, id, &r).await;
        r.write("notes.txt", "one\n<<<<<<< half done\n");
        let _ = call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "continue" })).await;
        assert!(crate::in_progress::read(r.path()).unwrap().is_some(), "still paused");
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(stashed(&r, &res, "notes.txt"), "one\n<<<<<<< half done");
    }

    /// N.1 (5): an untouched autostash is only restored, at an Edit stop and a conflict stop;
    /// content at the stop that's the autostash's own isn't kept twice.
    #[tokio::test]
    async fn an_untouched_autostash_is_only_restored() {
        for conflict in [false, true] {
            let (_d, r, api, id) = fresh().await;
            let before = tips(&r);
            r.write("lexer.txt", "dirty before the rebase\n");
            if conflict {
                conflict_stop(&api, id, &r).await;
            } else {
                stop_at_b2(&api, id, &r).await;
                r.write("lexer.txt", "dirty before the rebase\n");
            }
            let res = abort(&api, id, &r).await.unwrap();
            kept_nothing(&r, &res, &before, if conflict { "conflict stop" } else { "edit stop" });
            assert_eq!(std::fs::read_to_string(r.path().join("lexer.txt")).unwrap(), "dirty before the rebase\n");
        }
    }
    /// Fix round 1 (1): a conflict resolved by hand at an earlier stop is in a replay; the
    /// later stop's resolution (ours) isn't work. HEAD goes on the work branch all the same.
    #[tokio::test]
    async fn an_earlier_stops_hand_resolution_is_kept_on_the_work_branch() {
        let (_d, r, api, id) = fresh().await;
        let before = tips(&r);
        conflict_stop(&api, id, &r).await;
        r.write("notes.txt", "one, resolved by hand\n");
        r.git(&["add", "notes.txt"]);
        assert_eq!(control(&api, id, &r, "continue").await["outcome"]["status"], "stopped", "A2 conflicts too");
        assert!(r.git(&["status", "--porcelain"]).contains("notes.txt"), "{}", r.git(&["status", "--porcelain"]));
        r.git(&["checkout", "--ours", "notes.txt"]);
        r.git(&["add", "notes.txt"]);
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work", "{res}");
        assert_eq!(r.git(&["show", "feature/c-rebase-work:notes.txt"]), "one, resolved by hand");
        assert!(res["outcome"]["stash"].is_null(), "ours is HEAD's: {res}");
        assert_eq!(tips(&r), before);
    }

    /// Fix round 1 (1): replays git merged cleanly with `onto`'s own change to the same file are
    /// git's: nothing is kept.
    #[tokio::test]
    async fn a_clean_merge_with_ontos_changes_is_not_kept() {
        let (_d, r, api, id) = fresh().await;
        r.switch("main");
        r.write("notes.txt", "zero\none\n");
        r.git(&["commit", "-q", "-am", "Main edits notes"]);
        r.switch("feature/c");
        let before = tips(&r);
        stop_at_b2(&api, id, &r).await;
        let res = abort(&api, id, &r).await.unwrap();
        kept_nothing(&r, &res, &before, "a clean merge");
    }

    /// Fix round 1 (3): a changed path that isn't UTF-8 keeps everything, as before UX N.
    #[cfg(unix)] // non-UTF-8 file names exist only on Unix
    #[tokio::test]
    async fn a_non_utf8_path_keeps_everything() {
        use std::os::unix::ffi::OsStrExt;
        let (_d, r, api, id) = fresh().await;
        stop_at_b2(&api, id, &r).await;
        std::fs::write(r.path().join(std::ffi::OsStr::from_bytes(b"caf\xe9.txt")), "x\n").unwrap();
        r.git(&["add", "-A"]);
        let res = abort(&api, id, &r).await.unwrap();
        let stash = res["outcome"]["stash"].as_str().unwrap_or_else(|| panic!("a stash: {res}")).to_string();
        let files = r.git(&["ls-tree", "-r", "--name-only", &stash]);
        assert!(files.contains("caf") && files.contains("lexer.txt"), "the whole worktree: {files}");
        assert_eq!(res["outcome"]["branch"], "feature/c-rebase-work", "{res}");
    }

    /// Fix round 1 (4): with `core.fileMode=false`, an executable file whose bit the filesystem
    /// lost reads with the index's mode, as `git stash` reads it: nothing new.
    #[tokio::test]
    async fn file_mode_false_doesnt_flip_a_mode_into_work() {
        let (_d, r, api, id) = fresh().await;
        r.write("script.sh", "#!/bin/sh\n");
        crate::platform::fs::set_mode(r.path().join("script.sh"), 0o755).unwrap();
        r.git(&["add", "script.sh"]);
        r.git(&["commit", "-q", "-m", "C3 Add script"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean: no autostash");
        let before = tips(&r);
        let p = plan(&api, id, &r).await;
        let mut rows = picks(&p);
        set(&p, &mut rows, "C3", "edit", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        assert_eq!(r.git(&["status", "--porcelain"]), "A  script.sh");
        r.git(&["config", "core.fileMode", "false"]);
        crate::platform::fs::set_mode(r.path().join("script.sh"), 0o644).unwrap();
        let res = abort(&api, id, &r).await.unwrap();
        kept_nothing(&r, &res, &before, "fileMode false");
    }

    /// Fix round 1 (7): a file where HEAD has a directory goes into the stash (`--replace`), and
    /// the Abort runs.
    #[tokio::test]
    async fn a_directory_replaced_by_a_file_is_kept() {
        let (_d, r, api, id) = fresh().await;
        r.switch("main");
        r.write("d/x", "in a directory\n");
        r.git(&["add", "d/x"]);
        r.git(&["commit", "-q", "-m", "Main adds d/x"]);
        r.switch("feature/c");
        stop_at_b2(&api, id, &r).await;
        r.git(&["rm", "-q", "-r", "d"]);
        r.write("d", "now a file\n");
        r.git(&["add", "d"]);
        let res = abort(&api, id, &r).await.unwrap();
        assert_eq!(stashed(&r, &res, "d"), "now a file");
    }

    /// Fix round 1 (5): a stop with nothing to note clears an earlier stop's note.
    #[tokio::test]
    async fn a_stop_with_nothing_to_note_clears_the_last_note() {
        let (_d, r, api, id) = fresh().await;
        let p = plan(&api, id, &r).await;
        let mut rows = crate::write::irebase::run::tests::order(&p, &["C2", "B2", "S1", "B1", "A3", "A2", "C1", "A1"]);
        set(&p, &mut rows, "B1", "edit", None);
        assert_eq!(start(&api, id, &r, &p, rows, stay(&p)).await.unwrap()["outcome"]["status"], "stopped");
        let note = r.path().join(".git").join(crate::in_progress::STOP_CONTENT);
        assert!(note.is_file(), "C1's conflict is noted");
        r.write("notes.txt", "one\ntwo\n");
        r.git(&["add", "notes.txt"]);
        let mut out = control(&api, id, &r, "continue").await;
        while r.git(&["status", "--porcelain"]).contains("UU") {
            r.write("notes.txt", "one\ntwo\n");
            r.git(&["add", "notes.txt"]);
            out = control(&api, id, &r, "continue").await;
        }
        assert_eq!(out["outcome"]["status"], "stopped", "B1's Edit stop");
        assert!(!note.exists(), "B1's stop is git's commit, nothing to note");
    }
    // --- end UX N ---
}
