//! Discards (spec #2 §7.2, §7.3, §7.4). Every discard snapshots first (the pipeline's step 4,
//! from the plan's paths) and records an `after` snapshot, so Undo restores `before` and Redo
//! restores `after` (§5.3). Only Discard all confirms, in the UI; nothing here asks.
//!
//! What the snapshot holds is every file the discard removes or overwrites, all files (2A final
//! review): the tracked paths git writes back, the untracked files it deletes, and the files
//! outside the index that writing a tracked path back removes. The last are collisions: a folder
//! standing where a deleted file comes back (git removes it, ignored files and all), or a file or
//! symlink standing where a folder must be. They're counted in the label and held in the
//! snapshot's untracked part, so Undo brings back every byte, mode included. What a snapshot
//! can't carry is refused before anything runs: a separate repository (never deleted, including
//! one standing where a tracked file comes back), an intent-to-add entry (the mark would be
//! lost), and a folder now a symbolic link. A submodule's own changes are never discarded (git
//! can't from here): only its index entry comes back.

use crate::api::{blocking, Api};
use crate::blob::{check_relative, safe_join};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::{GitCli, GitInvocation};
use crate::hunks::{wip_diff, WipBase};
use crate::journal::{snapshot, UndoKind};
use crate::status::{status, EntryKind, StatusEntry};
use crate::write::patch::{parse, partial_patch, selection_label, Dir, StageSelection};
use crate::write::stage::{files_label, nul_list, stale_paths, unborn};
use crate::write::stage_patch::{base_now, stale};
use crate::write::types::{Expect, WriteResult};
use crate::write::precheck;
use crate::write::{run_write, Plan, Pre, Staging, WriteClass, WriteCx, WriteIntent};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum DiscardScope {
    /// Unstaged rows (a folder row: its directory, expanded here): their worktree changes; an
    /// untracked file is deleted. The staged half stays.
    Paths { paths: Vec<String> },
    /// Hunks or lines of one file's unstaged diff.
    Patch { path: String, selection: StageSelection, base: WipBase },
    /// Every unstaged and untracked change; the staged half stays.
    Unstaged,
    /// Staged, unstaged and untracked: back to HEAD.
    All {
        /// UX R1 C.2: the changed files the user confirmed (the panel's, a rename's both paths).
        /// A changed file outside them refuses it as Stale, so a Discard all never takes more
        /// than was confirmed (one sent again while the first still ran, say). Absent: every
        /// changed file.
        #[serde(default)]
        #[ts(optional)]
        confirmed: Option<Vec<String>>,
    },
}

/// `git clean`'s paths go on argv, so in chunks.
const CLEAN_CHUNK: usize = 1000;

/// What a discard acts on, every one a file path (2A final review: a directory is expanded to
/// its files before the snapshot and the precheck see it).
#[derive(Debug, Default, Clone)]
struct Targets {
    /// Tracked paths git writes back: from the index, or from HEAD for Discard all.
    restore: Vec<String>,
    /// Untracked files the discard deletes.
    delete: Vec<String>,
    /// Files outside the index that writing `restore` back removes (collisions).
    in_way: Vec<String>,
}

impl Targets {
    /// The snapshot's `(paths, untracked)`: every file the discard removes or overwrites.
    fn snapshot(&self) -> (Vec<String>, Vec<String>) {
        let untracked: BTreeSet<String> = self.delete.iter().chain(&self.in_way).cloned().collect();
        let paths: BTreeSet<String> = self.restore.iter().cloned().chain(untracked.iter().cloned()).collect();
        (paths.into_iter().collect(), untracked.into_iter().collect())
    }
}

/// A row with an unstaged change: an untracked file, or a worktree change of a tracked one.
fn unstaged(e: &StatusEntry) -> bool {
    e.kind == EntryKind::Untracked || (e.kind != EntryKind::Ignored && e.worktree != '.')
}

/// `git status` reports an untracked folder that holds a repository of its own as `sub/`: a
/// discard never deletes it (the snapshot can't carry another repository).
fn nested_repo(e: &StatusEntry) -> bool {
    e.path.ends_with('/')
}

fn separate_repo(path: &str) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, format!("{} is a separate Git repository: GitBolt won't delete it", path.trim_end_matches('/')))
}

/// The discard's files, before the snapshot (step 4) and the label.
async fn plan_targets(api: &Api, root: &Path, scope: &DiscardScope) -> Result<Targets, GbError> {
    let entries = status(&api.cli, root).await?;
    let links = gitlinks(root).await?;
    let t = targets_of(&api.cli, root, scope, &entries, &links).await?;
    // A snapshot carries an intent-to-add entry as an untracked file: Undo couldn't bring the
    // mark back, and every later state would look changed against it.
    if let Some(p) = t.restore.iter().find(|p| entries.iter().any(|e| e.path == **p && intent_to_add(e))) {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{p} is intent-to-add (git add -N): stage it or unstage it first")));
    }
    Ok(t)
}

/// `git add -N`: porcelain v2's `.A`.
fn intent_to_add(e: &StatusEntry) -> bool {
    e.kind == EntryKind::Ordinary && e.index == '.' && e.worktree == 'A'
}

/// The gitlinks (submodules, embedded repositories) of the index and of HEAD.
#[derive(Default)]
struct Gitlinks {
    index: BTreeSet<String>,
    head: BTreeSet<String>,
}

impl Gitlinks {
    /// A gitlink of the index at `p` or under it.
    fn index_at_or_under(&self, p: &str) -> bool {
        let prefix = format!("{p}/");
        self.index.iter().any(|g| g == p || g.starts_with(&prefix))
    }
}

async fn gitlinks(root: &Path) -> Result<Gitlinks, GbError> {
    let root = root.to_path_buf();
    blocking(move || {
        use gix::bstr::ByteSlice;
        let repo = gix::open(&root).map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let index_links = index.entries().iter().filter(|e| e.mode == gix::index::entry::Mode::COMMIT).map(|e| e.path(&index).to_str_lossy().into_owned()).collect();
        let mut head = BTreeSet::new();
        if let Some(tree) = repo.head_commit().ok().and_then(|c| c.tree().ok()) {
            let mut rec = gix::traverse::tree::Recorder::default();
            tree.traverse().breadthfirst(&mut rec).map_err(gix_err)?;
            head = rec.records.into_iter().filter(|r| r.mode.is_commit()).map(|r| r.filepath.to_str_lossy().into_owned()).collect();
        }
        Ok(Gitlinks { index: index_links, head })
    })
    .await
}

/// A gitlink's row under Paths or Unstaged: `git restore --worktree` never changes a submodule
/// (its content is another repository's), so the row is left out.
fn submodule_row(e: &StatusEntry, links: &Gitlinks) -> bool {
    links.index.contains(&e.path)
}

async fn targets_of(cli: &GitCli, root: &Path, scope: &DiscardScope, entries: &[StatusEntry], links: &Gitlinks) -> Result<Targets, GbError> {
    let mut t = Targets::default();
    // The paths whose target (what git writes back) is a gitlink: only the index entry changes.
    let mut link_targets = BTreeSet::new();
    match scope {
        DiscardScope::Paths { paths } => {
            let (mut restore, mut delete) = (BTreeSet::new(), BTreeSet::new());
            for p in paths {
                let p = p.trim_end_matches('/');
                check_relative(p)?;
                let exact: Vec<&StatusEntry> = entries.iter().filter(|e| e.path == p).collect();
                let rows: Vec<&StatusEntry> = if exact.is_empty() {
                    // A folder row: the changed files under it (a conflicted one has its own row).
                    let prefix = format!("{p}/");
                    entries.iter().filter(|e| e.path.starts_with(&prefix) && e.kind != EntryKind::Unmerged).collect()
                } else {
                    exact
                };
                let picked: Vec<&StatusEntry> = rows.iter().copied().filter(|e| unstaged(e) && !nested_repo(e) && !submodule_row(e, links)).collect();
                if picked.is_empty() {
                    return Err(if let Some(e) = rows.iter().find(|e| nested_repo(e)) {
                        separate_repo(&e.path)
                    } else if let Some(e) = rows.iter().find(|e| submodule_row(e, links)) {
                        GbError::new(GbErrorKind::InvalidInput, format!("{} is a submodule: discard its changes inside it", e.path))
                    } else {
                        // Gone, or only staged now: the list was drawn before (Review Focus 1).
                        stale(p)
                    });
                }
                for e in picked {
                    if e.kind == EntryKind::Untracked {
                        delete.insert(e.path.clone());
                    } else {
                        restore.insert(e.path.clone());
                    }
                }
            }
            t.restore = restore.into_iter().collect();
            t.delete = delete.into_iter().collect();
        }
        DiscardScope::Patch { path, .. } => {
            check_relative(path)?;
            if entries.iter().any(|e| e.path == *path && e.kind == EntryKind::Untracked) {
                t.delete.push(path.clone());
            } else {
                t.restore.push(path.clone());
            }
            // The file is rewritten in place: nothing else is in the way.
            return Ok(t);
        }
        DiscardScope::Unstaged => {
            for e in entries.iter().filter(|e| unstaged(e) && !nested_repo(e) && !submodule_row(e, links) && e.kind != EntryKind::Unmerged) {
                if e.kind == EntryKind::Untracked {
                    t.delete.push(e.path.clone());
                } else {
                    t.restore.push(e.path.clone());
                }
            }
        }
        DiscardScope::All { confirmed } => {
            // The snapshot can't carry a conflicted path, and Discard all can't leave one.
            if let Some(e) = entries.iter().find(|e| e.kind == EntryKind::Unmerged) {
                return Err(GbError::new(GbErrorKind::InProgress, format!("{} has merge conflicts: resolve conflicts first", e.path)));
            }
            // UX R1 C.2: never more than the user confirmed (a separate repository is never
            // deleted, so it isn't one of them).
            if let Some(confirmed) = confirmed {
                let confirmed: BTreeSet<&str> = confirmed.iter().map(|p| p.trim_end_matches('/')).collect();
                let changed = entries.iter().filter(|e| e.kind != EntryKind::Ignored && !nested_repo(e)).flat_map(|e| std::iter::once(&e.path).chain(&e.orig_path));
                if let Some(p) = changed.into_iter().find(|p| !confirmed.contains(p.as_str())) {
                    return Err(GbError::stale(format!("{p} changed since you confirmed: look again, then discard")));
                }
            }
            let mut restore = BTreeSet::new();
            for e in entries.iter().filter(|e| !matches!(e.kind, EntryKind::Untracked | EntryKind::Ignored)) {
                restore.insert(e.path.clone());
                if let Some(o) = &e.orig_path {
                    restore.insert(o.clone()); // a rename's source comes back from HEAD
                }
            }
            let untracked: BTreeSet<&str> = entries.iter().filter(|e| e.kind == EntryKind::Untracked && !nested_repo(e)).map(|e| e.path.as_str()).collect();
            // An untracked file at a rename's source (or over a staged deletion) is overwritten
            // with HEAD's: it's a tracked path of the snapshot (its index state comes back too).
            t.delete = untracked.iter().filter(|p| !restore.contains(**p)).map(|p| p.to_string()).collect();
            // HEAD's gitlink back at a path (M2): git re-adds the index entry and never touches
            // the folder.
            link_targets = restore.iter().filter(|p| links.head.contains(*p)).cloned().collect();
            t.restore = restore.into_iter().collect();
        }
    }
    refuse_symlinked_folders(root, &t.restore)?;
    if matches!(scope, DiscardScope::All { .. }) && unborn(root)? {
        // `rm --cached` writes no file, and only files are deleted after it: nothing is in the way.
        return Ok(t);
    }
    // C1: writing a file (or a removal) where a repository stands would delete it, `.git` and
    // all, and no snapshot carries one.
    for p in t.restore.iter().filter(|p| !link_targets.contains(*p)) {
        if precheck::repo_at(root, p) || links.index_at_or_under(p) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{p} is a repository in the way: move it first")));
        }
    }
    let known: BTreeSet<String> = t.restore.iter().chain(&t.delete).cloned().collect();
    let writes: Vec<String> = t.restore.iter().filter(|p| !link_targets.contains(*p)).cloned().collect();
    t.in_way = in_the_way(cli, root, &writes, &known).await?;
    Ok(t)
}

/// M3: a tracked folder replaced by a symbolic link. git refuses the path ("beyond a symbolic
/// link"), so it's refused here first, in words; nothing outside the repository is touched.
fn refuse_symlinked_folders(root: &Path, restore: &[String]) -> Result<(), GbError> {
    for r in restore {
        let mut at = 0;
        while let Some(i) = r[at..].find('/') {
            let lead = &r[..at + i];
            match root.join(lead).symlink_metadata() {
                Ok(m) if m.file_type().is_symlink() => {
                    return Err(GbError::new(GbErrorKind::InvalidInput, format!("{lead} is a symbolic link where a folder of {r} was: move it first")));
                }
                Ok(m) if m.is_dir() => at += i + 1,
                _ => break,
            }
        }
    }
    Ok(())
}

/// The files outside the index that writing `restore`'s paths back removes (git does, with
/// force): everything in a folder standing where a file comes back (ignored files too), and a
/// file or symlink standing where one of its folders must be. A folder holding a repository of
/// its own is refused: the snapshot can't carry it.
async fn in_the_way(cli: &GitCli, root: &Path, restore: &[String], known: &BTreeSet<String>) -> Result<Vec<String>, GbError> {
    let mut out = BTreeSet::new();
    for r in restore {
        let full = root.join(r);
        if full.symlink_metadata().is_ok_and(|m| m.is_dir()) {
            // `--others` without `--exclude-standard`: ignored files are listed too.
            let args = ["ls-files", "-z", "--others", "--", r.as_str()];
            let listed = cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
            for f in listed.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
                let f = String::from_utf8_lossy(f).into_owned();
                if f.ends_with('/') {
                    return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is a separate Git repository in the way of {r}: move it first", f.trim_end_matches('/'))));
                }
                if !known.contains(&f) {
                    out.insert(f);
                }
            }
        }
        // A leading folder that's a file (or a symlink) now: git unlinks it to make the folder.
        let mut at = 0;
        while let Some(i) = r[at..].find('/') {
            let lead = &r[..at + i];
            match root.join(lead).symlink_metadata() {
                Ok(m) if m.is_dir() => at += i + 1,
                Ok(_) => {
                    if !known.contains(lead) {
                        out.insert(lead.to_string());
                    }
                    break;
                }
                Err(_) => break,
            }
        }
    }
    Ok(out.into_iter().collect())
}

/// The unstaged diff the base check passed for (checked on both sides of the diff, so it's the
/// one the user's base was shown from), or why it can't be discarded by hunk or line.
async fn checked_diff(api: &Api, root: &Path, path: &str, base: &WipBase) -> Result<Vec<u8>, GbError> {
    if !base.matches(&base_now(root, path).await?, false) {
        return Err(stale(path));
    }
    let diff = wip_diff(&api.cli, root, path, false).await?;
    if !base.matches(&base_now(root, path).await?, false) {
        return Err(stale(path));
    }
    // The refusals name staging ("Binary file: stage the whole file"); here it's a discard.
    diff.map_err(|why| GbError::new(GbErrorKind::InvalidInput, why.replace("stage the whole file", "discard the whole file")))
}

fn nothing_selected() -> GbError {
    GbError::new(GbErrorKind::InvalidInput, "No changed lines are selected")
}

struct Discard {
    scope: DiscardScope,
    /// M6: counted again under the lock, by `plan`, so the journal's label says what was done.
    label: Mutex<String>,
    /// What `plan` found under the lock; `run` acts on it, within what the snapshot holds.
    targets: Mutex<Option<Targets>>,
}

impl Discard {
    async fn clean(&self, cx: &mut WriteCx<'_>, untracked: &[String]) -> Result<(), GbError> {
        for chunk in untracked.chunks(CLEAN_CHUNK) {
            let args = ["clean", "-f", "-q", "--"].into_iter().map(String::from).chain(chunk.iter().cloned());
            let inv = cx.git(args).env("GIT_LITERAL_PATHSPECS", "1");
            cx.run_git(inv).await?;
        }
        Ok(())
    }

    async fn restore_worktree(&self, cx: &mut WriteCx<'_>, tracked: &[String]) -> Result<(), GbError> {
        if tracked.is_empty() {
            return Ok(());
        }
        let inv = cx.git(["restore", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(tracked));
        cx.run_git(inv).await.map_err(stale_paths(tracked)).map(drop)
    }

    /// Discard all's tracked part: back to HEAD in the index and the worktree. Unborn: out of the
    /// index (`rm --cached -f`), then their files (held in the snapshot) are deleted; a folder
    /// standing at one is left alone.
    async fn reset_all(&self, cx: &mut WriteCx<'_>, tracked: &[String]) -> Result<(), GbError> {
        if tracked.is_empty() {
            return Ok(());
        }
        if unborn(cx.root)? {
            let inv = cx.git(["rm", "--cached", "-f", "-q", "-r", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(tracked));
            cx.run_git(inv).await?;
            // Not `git clean`: a staged file may be ignored, which `clean` (without -x) keeps.
            for p in tracked {
                let full = cx.root.join(p);
                if full.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
                    std::fs::remove_file(&full)?;
                }
            }
            return Ok(());
        }
        let inv = cx.git(["restore", "--source=HEAD", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul_list(tracked));
        cx.run_git(inv).await.map(drop)
    }

    /// §7.3 "Discard lines or hunk", through a temp index so clean/smudge filters and CRLF
    /// round-trip; the real index is never touched (Deviation 7: the temp index starts empty).
    /// The file keeps its permissions exactly (`checkout-index` would take them from the temp
    /// entry, which `core.fileMode=false` makes 0644).
    async fn discard_patch(&self, cx: &mut WriteCx<'_>, path: &str, sel: &StageSelection, base: &WipBase, untracked: bool) -> Result<(), GbError> {
        let diff = checked_diff(cx.api, cx.root, path, base).await?;
        let file = safe_join(cx.root, path)?;
        let meta = file.symlink_metadata().map_err(|_| stale(path))?;
        if !meta.is_file() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is deleted: discard the whole file instead")));
        }
        if untracked {
            let kept = drop_new_lines(&std::fs::read(&file)?, &diff, sel)?;
            cx.partial = true;
            return crate::write::files::write_atomic(&file, &kept);
        }
        let patch = partial_patch(&diff, sel, Dir::Reverse).ok_or_else(|| {
            let parsed = parse(&diff);
            if parsed.mode_only() {
                GbError::new(GbErrorKind::InvalidInput, "Only the file's mode changed: discard the whole file")
            } else if parsed.hunks.is_empty() {
                GbError::new(GbErrorKind::InvalidInput, format!("No changes to discard in {path}"))
            } else {
                nothing_selected()
            }
        })?;
        let dir = tempfile::Builder::new().prefix("discard-").tempdir_in(&cx.tmp)?;
        let t = dir.path().join("index");
        let temp = |inv: GitInvocation| inv.env("GIT_INDEX_FILE", &t).env("GIT_LITERAL_PATHSPECS", "1");
        let inv = temp(cx.git(["add", "--", path]));
        cx.run_git(inv).await?;
        let inv = temp(cx.git(["apply", "--cached", "-R", "--recount", "--whitespace=nowarn", "-"])).stdin(patch);
        cx.run_git(inv).await?;
        // From here the file changes.
        cx.partial = true;
        let inv = temp(cx.git(["checkout-index", "-f", "--", path]));
        cx.run_git(inv).await?;
        std::fs::set_permissions(&file, meta.permissions())?;
        Ok(())
    }
}

/// Deviation 6: an untracked file's picked lines are cut from its bytes (it has no index version
/// to reverse-apply against); the caller writes them atomically, its mode kept.
fn drop_new_lines(bytes: &[u8], diff: &[u8], sel: &StageSelection) -> Result<Vec<u8>, GbError> {
    let hunk = parse(diff).hunks.into_iter().next().ok_or_else(nothing_selected)?;
    let add = hunk.summary().add;
    let picked: BTreeSet<u32> = match sel {
        StageSelection::Hunks { hunks } if hunks.contains(&0) => add.into_iter().collect(),
        StageSelection::Hunks { .. } => BTreeSet::new(),
        StageSelection::Lines { new, .. } => add.into_iter().filter(|n| new.iter().any(|r| (r.start..=r.end).contains(n))).collect(),
    };
    if picked.is_empty() {
        return Err(nothing_selected());
    }
    Ok(bytes.split_inclusive(|b| *b == b'\n').enumerate().filter(|(i, _)| !picked.contains(&(*i as u32 + 1))).flat_map(|(_, l)| l.iter().copied()).collect())
}

impl WriteIntent for Discard {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Discard
    }
    fn label(&self) -> String {
        self.label.lock().map(|l| l.clone()).unwrap_or_else(|_| "discard".into())
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Restore)
    }
    /// §13.2: per-file discards run in the conflict state; Unstaged and All don't ("Abort instead").
    fn allowed_in_progress(&self) -> bool {
        matches!(self.scope, DiscardScope::Paths { .. } | DiscardScope::Patch { .. })
    }
    /// Only Discard all rewrites the index; the others leave the staging log valid.
    fn staging(&self) -> Staging {
        if matches!(self.scope, DiscardScope::All { .. }) {
            Staging::Clear
        } else {
            Staging::Keep
        }
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        // A patch whose base moved is Stale before anything is snapshotted or journaled.
        let diff = match &self.scope {
            DiscardScope::Patch { path, base, .. } => Some(checked_diff(pre.api, pre.root, path, base).await?),
            _ => None,
        };
        let targets = plan_targets(pre.api, pre.root, &self.scope).await?;
        if let Ok(mut l) = self.label.lock() {
            *l = label_of(&self.scope, &targets, diff.as_deref());
        }
        let (paths, untracked) = targets.snapshot();
        if paths.is_empty() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Nothing to discard"));
        }
        *self.targets.lock().map_err(|_| GbError::other("the discard's plan is poisoned"))? = Some(targets);
        Ok(Plan { snapshot: Some((paths, untracked)), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let snap = cx.snapshot.clone().ok_or_else(|| GbError::other("the discard has no snapshot"))?;
        let t = self.targets.lock().map_err(|_| GbError::other("the discard's plan is poisoned"))?.clone().ok_or_else(|| GbError::other("the discard has no plan"))?;
        // Only what the snapshot holds is deleted or written over (never a path that appeared since).
        let held: BTreeSet<&String> = snap.paths.iter().collect();
        let delete: Vec<String> = t.delete.iter().filter(|p| snap.untracked.contains(p)).cloned().collect();
        let restore: Vec<String> = t.restore.iter().filter(|p| held.contains(p) && !snap.untracked.contains(p)).cloned().collect();
        match &self.scope {
            DiscardScope::Paths { .. } | DiscardScope::Unstaged => {
                // From here the working tree may change, even if a step fails.
                cx.partial = true;
                self.clean(cx, &delete).await?;
                self.restore_worktree(cx, &restore).await?;
            }
            DiscardScope::All { .. } => {
                cx.partial = true;
                self.clean(cx, &delete).await?;
                self.reset_all(cx, &restore).await?;
                cx.touch(ChangeKind::Index);
            }
            DiscardScope::Patch { path, selection, base } => self.discard_patch(cx, path, selection, base, !delete.is_empty()).await?,
        }
        // The same files as `before`, the untracked part too: a file still there (a cut
        // untracked file, one git left in place) is carried in U again, a deleted one is absent.
        cx.after = Some(snapshot::create(&cx.snapshots(), &self.label(), &snap.paths, &snap.untracked).await?);
        cx.touch(ChangeKind::Worktree);
        Ok(())
    }
}

pub(crate) async fn discard(api: &Api, repo: u32, worktree: &str, scope: DiscardScope) -> Result<WriteResult<()>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    // Refused (Stale, a separate repository, …) before the write runs; `plan` checks and counts
    // again under the lock (the journal's label is that one).
    let diff = match &scope {
        DiscardScope::Patch { path, base, .. } => Some(checked_diff(api, &root, path, base).await?),
        _ => None,
    };
    let label = label_of(&scope, &plan_targets(api, &root, &scope).await?, diff.as_deref());
    run_write(api, repo, worktree, Expect::default(), Discard { scope, label: Mutex::new(label), targets: Mutex::new(None) }).await
}

/// `discard a.php`, `discard 3 files`, `discard a hunk in a.php`, `discard 3 lines in a.php`,
/// `discard unstaged changes`, `discard all changes` (§5.5). `diff`: a patch's checked diff.
fn label_of(scope: &DiscardScope, targets: &Targets, diff: Option<&[u8]>) -> String {
    match scope {
        DiscardScope::Paths { .. } => format!("discard {}", files_label(&targets.snapshot().0)),
        DiscardScope::Patch { path, selection, .. } => format!("discard {} in {path}", selection_label(diff.unwrap_or_default(), selection, Dir::Reverse)),
        DiscardScope::Unstaged => "discard unstaged changes".into(),
        DiscardScope::All { .. } => "discard all changes".into(),
    }
}

#[cfg(test)]
mod tests {
    use crate::api::Api;
    use crate::error::GbErrorKind;
    use crate::testing::state::RepoState;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, journal_step, open, repo, wt};
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;

    async fn discard(api: &Api, id: u32, r: &TestRepo, scope: Value) -> Result<Value, crate::error::GbError> {
        call(api, "discard", json!({ "repo": id, "worktree": wt(r.path()), "scope": scope })).await
    }

    /// Every worktree file's full mode: 120000 for a symlink, else 100000 | its permission bits
    /// (`RepoState` holds the bytes, not the modes).
    fn modes(r: &TestRepo) -> BTreeMap<String, u32> {
        fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut BTreeMap<String, u32>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.file_name().is_some_and(|n| n == ".git") {
                    continue;
                }
                let m = std::fs::symlink_metadata(&p).unwrap();
                if m.is_dir() {
                    walk(root, &p, out);
                } else {
                    let mode = if m.file_type().is_symlink() { 0o120000 } else { 0o100000 | (m.permissions().mode() & 0o7777) };
                    out.insert(p.strip_prefix(root).unwrap().display().to_string(), mode);
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(r.path(), r.path(), &mut out);
        out
    }

    fn state(r: &TestRepo) -> (RepoState, BTreeMap<String, u32>) {
        (RepoState::capture(r), modes(r))
    }

    /// §17.1: after undo everything equals its value before; after redo, after. Modes too.
    async fn round_trip(api: &Api, id: u32, r: &TestRepo, scope: Value, label: &str) {
        let before = state(r);
        let res = discard(api, id, r, scope).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], label);
        let after = state(r);
        assert_ne!(before, after);
        journal_step(api, id, r.path(), "undo").await.unwrap();
        assert_eq!(state(r), before, "undo restores the state before");
        journal_step(api, id, r.path(), "redo").await.unwrap();
        assert_eq!(state(r), after, "redo restores the state after");
    }

    fn dirty() -> TestRepo {
        let r = repo();
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-q", "-m", "b"]);
        r.write("a.txt", "a staged\n");
        r.git(&["add", "a.txt"]);
        r.write("a.txt", "a staged then edited\n");
        r.write("b.txt", "b edited\n");
        r.write("new.txt", "untracked\n");
        r.write("dir/n1.txt", "u1\n");
        r.write("dir/n2.txt", "u2\n");
        r.write("added.txt", "staged new\n");
        r.git(&["add", "added.txt"]);
        r
    }

    fn chmod(r: &TestRepo, path: &str, mode: u32) {
        std::fs::set_permissions(r.path().join(path), std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[tokio::test]
    async fn discarding_files_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["b.txt", "new.txt"] }), "discard 2 files").await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["a.txt"] }), "discard a.txt").await;
        // The staged half stays: only the worktree change of a.txt went.
        assert_eq!(r.git(&["show", ":a.txt"]), "a staged");
    }

    /// 2A final review: a folder row's directory is expanded to its files before the snapshot.
    #[tokio::test]
    async fn a_directory_is_discarded_as_its_files() {
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = discard(&api, id, &r, json!({ "kind": "paths", "paths": ["dir"] })).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "discard 2 files");
        assert!(!r.path().join("dir/n1.txt").exists() && !r.path().join("dir/n2.txt").exists());
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("dir/n2.txt")).unwrap(), "u2\n");
    }

    #[tokio::test]
    async fn discarding_unstaged_round_trips_and_keeps_the_staged_half() {
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "unstaged" }), "discard unstaged changes").await;
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "M  a.txt\nA  added.txt");
    }

    #[tokio::test]
    async fn discarding_all_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        assert_eq!(r.git(&["status", "--porcelain"]), "", "after redo: clean");
    }

    /// UX R1 C.2: Discard all with the files the user confirmed. A changed file outside them
    /// refuses it, nothing touched; the same request sent again once it ran discards nothing.
    #[tokio::test]
    async fn discard_all_never_takes_more_than_was_confirmed() {
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        r.git(&["mv", "b.txt", "moved.txt"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let shown = ["a.txt", "added.txt", "moved.txt", "b.txt", "new.txt", "dir/n1.txt", "dir/n2.txt"];
        let scope = json!({ "kind": "all", "confirmed": shown });
        // A file that changed after the confirm.
        r.write("late.txt", "typed after the confirm\n");
        let before = state(&r);
        let err = discard(&api, id, &r, scope.clone()).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Stale, "{err:?}");
        assert!(err.message.contains("late.txt"), "{}", err.message);
        assert_eq!(state(&r), before, "nothing was touched");
        std::fs::remove_file(r.path().join("late.txt")).unwrap();
        discard(&api, id, &r, scope.clone()).await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain", "--untracked-files=all"]), "");
        // Sent again (a second click while the first ran), now over a new change: refused.
        r.write("late.txt", "new\n");
        assert_eq!(discard(&api, id, &r, scope).await.unwrap_err().kind, GbErrorKind::Stale);
        assert!(r.path().join("late.txt").exists());
    }

    #[tokio::test]
    async fn discarding_all_in_an_unborn_repo_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.write("s.txt", "staged\n");
        r.git(&["add", "s.txt"]);
        r.write("u.txt", "untracked\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    #[tokio::test]
    async fn discard_all_is_refused_during_a_merge() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        crate::testing::fixtures::wip_conflict(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = discard(&api, id, &r, json!({ "kind": "all" })).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::InProgress);
        // A per-file discard is allowed in the conflict state (§13.2).
        discard(&api, id, &r, json!({ "kind": "paths", "paths": ["side.txt"] })).await.unwrap();
    }

    fn base(r: &TestRepo, path: &str) -> Value {
        serde_json::to_value(crate::hunks::base_of(r.path(), path).unwrap()).unwrap()
    }

    fn thirty(changed: &[usize]) -> String {
        (1..=30).map(|i| if changed.contains(&i) { format!("L{i} changed\n") } else { format!("L{i}\n") }).collect()
    }

    #[tokio::test]
    async fn discarding_a_hunk_and_lines_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("f.txt", &thirty(&[]));
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "f"]);
        r.write("f.txt", &thirty(&[3, 20]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let scope = json!({ "kind": "patch", "path": "f.txt", "selection": { "kind": "hunks", "hunks": [0] }, "base": base(&r, "f.txt") });
        round_trip(&api, id, &r, scope, "discard a hunk in f.txt").await;
        assert_eq!(std::fs::read_to_string(r.path().join("f.txt")).unwrap(), thirty(&[20]));
        let scope = json!({ "kind": "patch", "path": "f.txt", "selection": { "kind": "lines", "old": [{ "start": 20, "end": 20 }], "new": [] }, "base": base(&r, "f.txt") });
        round_trip(&api, id, &r, scope, "discard 1 line in f.txt").await;
    }

    #[tokio::test]
    async fn discarding_lines_of_an_untracked_file_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("n.txt", "one\ntwo\nthree\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let scope = json!({ "kind": "patch", "path": "n.txt", "selection": { "kind": "lines", "old": [], "new": [{ "start": 2, "end": 2 }] }, "base": base(&r, "n.txt") });
        round_trip(&api, id, &r, scope, "discard 1 line in n.txt").await;
        assert_eq!(std::fs::read_to_string(r.path().join("n.txt")).unwrap(), "one\nthree\n");
    }

    #[tokio::test]
    async fn crlf_discard_lines_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["config", "core.autocrlf", "true"]);
        r.write("w.txt", "a\r\nb\r\nc\r\n");
        r.git(&["add", "w.txt"]);
        r.git(&["commit", "-q", "-m", "w"]);
        r.write("w.txt", "a\r\nB\r\nc\r\nd\r\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let scope = json!({ "kind": "patch", "path": "w.txt", "selection": { "kind": "lines", "old": [{ "start": 2, "end": 2 }], "new": [{ "start": 2, "end": 2 }] }, "base": base(&r, "w.txt") });
        round_trip(&api, id, &r, scope, "discard 2 lines in w.txt").await;
        assert_eq!(std::fs::read(r.path().join("w.txt")).unwrap(), b"a\r\nb\r\nc\r\nd\r\n", "CRLF kept by the smudge");
    }

    /// §17.1: discard-lines through a clean/smudge filter.
    #[tokio::test]
    async fn a_filtered_file_discards_lines_through_its_filter() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["config", "filter.up.clean", "tr a-z A-Z"]);
        r.git(&["config", "filter.up.smudge", "tr A-Z a-z"]);
        r.write(".gitattributes", "*.up filter=up\n");
        r.write("x.up", "one\ntwo\n");
        r.git(&["add", ".gitattributes", "x.up"]);
        r.git(&["commit", "-q", "-m", "x"]);
        r.write("x.up", "one\ntwo\nthree\nfour\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let scope = json!({ "kind": "patch", "path": "x.up", "selection": { "kind": "lines", "old": [], "new": [{ "start": 4, "end": 4 }] }, "base": base(&r, "x.up") });
        round_trip(&api, id, &r, scope, "discard 1 line in x.up").await;
        assert_eq!(std::fs::read_to_string(r.path().join("x.up")).unwrap(), "one\ntwo\nthree\n", "smudged back to lower case");
    }

    #[tokio::test]
    async fn a_stale_patch_discard_changes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a\nmore\n");
        let shown = base(&r, "a.txt");
        r.write("a.txt", "a\nmore\nand more\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = RepoState::capture(&r);
        let err = discard(&api, id, &r, json!({ "kind": "patch", "path": "a.txt", "selection": { "kind": "hunks", "hunks": [0] }, "base": shown })).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
        assert_eq!(RepoState::capture(&r), before);
        let j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(j["undo"].is_null(), "an unchanged failure leaves no entry: {j}");
    }

    /// Review Focus 2.
    #[tokio::test]
    async fn awkward_paths_discard_literally() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        for n in ["sp ace.txt", "-dash.txt", "*.txt", "é.txt"] {
            r.write(n, "x\n");
        }
        r.write("keep.txt", "a glob must not reach me\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        discard(&api, id, &r, json!({ "kind": "paths", "paths": ["*.txt", "sp ace.txt", "-dash.txt", "é.txt"] })).await.unwrap();
        assert!(r.path().join("keep.txt").exists());
        assert!(!r.path().join("*.txt").exists() && !r.path().join("-dash.txt").exists());
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert!(r.path().join("é.txt").exists() && r.path().join("*.txt").exists());
    }

    /// §7.6 and §17.1: hunk and line staging round-trip through staging undo (T2 + T3).
    #[tokio::test]
    async fn hunk_and_line_staging_round_trip_through_staging_undo() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("f.txt", &thirty(&[]));
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "f"]);
        r.write("f.txt", &thirty(&[3, 20]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        for selection in [json!({ "kind": "hunks", "hunks": [1] }), json!({ "kind": "lines", "old": [{ "start": 3, "end": 3 }], "new": [] })] {
            let before = RepoState::capture(&r);
            call(&api, "stagePatch", json!({ "repo": id, "worktree": wt(r.path()), "path": "f.txt", "staged": false, "selection": selection, "base": base(&r, "f.txt") })).await.unwrap();
            let after = RepoState::capture(&r);
            call(&api, "stagingUndo", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
            assert_eq!(RepoState::capture(&r), before);
            call(&api, "stagingRedo", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
            assert_eq!(RepoState::capture(&r), after);
            call(&api, "stagingUndo", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        }
    }

    // --- Collisions, modes and what a snapshot can't carry (2C T6 review's lessons) ---

    /// A folder now stands where a tracked file was deleted: restoring the file removes the
    /// folder, ignored files and all. Every one is counted, snapshotted and comes back.
    #[tokio::test]
    async fn a_folder_where_a_deleted_file_comes_back_is_snapshotted() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("d", "tracked d\n");
        r.git(&["add", "d"]);
        r.git(&["commit", "-q", "-m", "d"]);
        std::fs::remove_file(r.path().join("d")).unwrap();
        r.write("d/u.txt", "untracked inside\n");
        r.write("d/deep/i.log", "ignored inside\n");
        std::fs::write(r.path().join(".git/info/exclude"), "*.log\n").unwrap();
        chmod(&r, "d/u.txt", 0o755);
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["d"] }), "discard 3 files").await;
        assert_eq!(std::fs::read_to_string(r.path().join("d")).unwrap(), "tracked d\n");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("d/deep/i.log")).unwrap(), "ignored inside\n");
    }

    /// A file stands where a deleted file's folder must be: git unlinks it. It's counted and
    /// snapshotted, and the index (a/b, deleted in the worktree) comes back as it was.
    #[tokio::test]
    async fn a_file_where_a_folder_must_be_is_snapshotted() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a/b.txt", "tracked a/b\n");
        r.git(&["add", "a/b.txt"]);
        r.git(&["commit", "-q", "-m", "a/b"]);
        std::fs::remove_dir_all(r.path().join("a")).unwrap();
        r.write("a", "an ignored file in the way\n");
        std::fs::write(r.path().join(".git/info/exclude"), "/a\n").unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["a/b.txt"] }), "discard 2 files").await;
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a")).unwrap(), "an ignored file in the way\n");
        assert_eq!(r.git(&["status", "--porcelain"]), " D a/b.txt");
    }

    /// Discard all over a staged deletion with a folder in its place: the folder's files are
    /// snapshotted, and Undo brings the deletion back staged (the path stays in the snapshot).
    #[tokio::test]
    async fn discard_all_over_a_staged_deletion_with_a_folder_in_its_place_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("x", "tracked x\n");
        r.git(&["add", "x"]);
        r.git(&["commit", "-q", "-m", "x"]);
        r.git(&["rm", "-q", "x"]);
        r.write("x/inner.txt", "untracked inside\n");
        r.write("x/more.txt", "more\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = r.git(&["status", "--porcelain"]);
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        assert_eq!(r.git(&["status", "--porcelain"]), "");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), before, "the deletion is staged again");
    }

    /// Discard all over a staged rename with a new file at its source: HEAD's file overwrites
    /// it, and Undo brings back both the rename and the new file's bytes.
    #[tokio::test]
    async fn discard_all_over_a_rename_with_a_new_file_at_its_source_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("old.txt", "renamed content\nline two\nline three\n");
        r.git(&["add", "old.txt"]);
        r.git(&["commit", "-q", "-m", "old"]);
        r.git(&["mv", "old.txt", "new.txt"]);
        r.write("old.txt", "a different file at the source\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = r.git(&["status", "--porcelain"]);
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        assert_eq!(std::fs::read_to_string(r.path().join("old.txt")).unwrap(), "renamed content\nline two\nline three\n");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), before);
    }

    /// An ignored file at a HEAD path the index doesn't have (a staged deletion): Discard all
    /// writes HEAD's file over it, and Undo brings back its bytes and the staged deletion.
    #[tokio::test]
    async fn discard_all_over_an_ignored_file_at_a_staged_deletion_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("gone.log", "tracked\n");
        r.git(&["add", "gone.log"]);
        r.git(&["commit", "-q", "-m", "log"]);
        r.git(&["rm", "-q", "gone.log"]);
        r.write("gone.log", "ignored now\n");
        std::fs::write(r.path().join(".git/info/exclude"), "*.log\n").unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = r.git(&["status", "--porcelain"]);
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("gone.log")).unwrap(), "ignored now\n");
        assert_eq!(r.git(&["status", "--porcelain"]), before);
    }

    /// A separate repository is never deleted: named, it's refused; under Discard unstaged, left.
    #[tokio::test]
    async fn a_separate_repository_is_never_deleted() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let sub = TestRepo::new();
        sub.commit("inside");
        let nested = r.path().join("sub");
        std::fs::rename(sub.path(), &nested).unwrap();
        r.write("loose.txt", "untracked\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = discard(&api, id, &r, json!({ "kind": "paths", "paths": ["sub"] })).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::InvalidInput, "{}", err.message);
        discard(&api, id, &r, json!({ "kind": "unstaged" })).await.unwrap();
        assert!(nested.join(".git").exists() && !r.path().join("loose.txt").exists());
        std::fs::rename(&nested, sub.path()).unwrap();
    }

    /// Modes: an executable untracked file, an unstaged chmod and a 0600 file all come back.
    #[tokio::test]
    async fn modes_round_trip() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("tool.sh", "#!/bin/sh\n");
        chmod(&r, "tool.sh", 0o755);
        chmod(&r, "a.txt", 0o755);
        r.write("secret.txt", "private\n");
        chmod(&r, "secret.txt", 0o600);
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["tool.sh", "a.txt", "secret.txt"] }), "discard 3 files").await;
        assert_eq!(modes(&r)["a.txt"] & 0o111, 0, "the chmod is discarded");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!((modes(&r)["secret.txt"], modes(&r)["tool.sh"], modes(&r)["a.txt"]), (0o100600, 0o100755, 0o100755), "full modes come back");
    }

    /// I2: with `core.fileMode=false` git keeps no exec bit, but the snapshot's own record does.
    #[tokio::test]
    async fn modes_round_trip_without_core_filemode() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["config", "core.fileMode", "false"]);
        r.write("tool.sh", "#!/bin/sh\n");
        chmod(&r, "tool.sh", 0o755);
        r.write("a.txt", "edited\n");
        chmod(&r, "a.txt", 0o600);
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["tool.sh", "a.txt"] }), "discard 2 files").await;
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!((modes(&r)["tool.sh"], modes(&r)["a.txt"]), (0o100755, 0o100600));
    }

    /// A hunk discard keeps the file's permissions exactly, even with `core.fileMode=false`.
    #[tokio::test]
    async fn a_hunk_discard_keeps_the_files_permissions() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["config", "core.fileMode", "false"]);
        r.write("f.txt", &thirty(&[]));
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "f"]);
        r.write("f.txt", &thirty(&[3, 20]));
        chmod(&r, "f.txt", 0o750);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let scope = json!({ "kind": "patch", "path": "f.txt", "selection": { "kind": "hunks", "hunks": [1] }, "base": base(&r, "f.txt") });
        round_trip(&api, id, &r, scope, "discard a hunk in f.txt").await;
        assert_eq!(std::fs::read_to_string(r.path().join("f.txt")).unwrap(), thirty(&[3]));
        assert_eq!(modes(&r)["f.txt"], 0o100750, "exactly the file's permissions");
    }

    /// With `core.fileMode` on, an executable file's hunk discard round-trips with its mode.
    #[tokio::test]
    async fn an_executable_files_hunk_discard_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("f.sh", &thirty(&[]));
        chmod(&r, "f.sh", 0o755);
        r.git(&["add", "f.sh"]);
        r.git(&["commit", "-q", "-m", "f"]);
        r.write("f.sh", &thirty(&[3, 20]));
        let api = api(data.path());
        let id = open(&api, &r).await;
        let scope = json!({ "kind": "patch", "path": "f.sh", "selection": { "kind": "hunks", "hunks": [0] }, "base": base(&r, "f.sh") });
        round_trip(&api, id, &r, scope, "discard a hunk in f.sh").await;
        assert_eq!(modes(&r)["f.sh"] & 0o100, 0o100);
    }

    /// Discard all in an unborn repository deletes a staged file even when it's ignored.
    #[tokio::test]
    async fn discard_all_unborn_deletes_an_ignored_staged_file() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.write("build.log", "forced in\n");
        r.git(&["add", "-f", "build.log"]);
        std::fs::write(r.path().join(".git/info/exclude"), "*.log\n").unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        assert!(!r.path().join("build.log").exists());
    }

    /// A path that's gone (or only staged) since the list was drawn is Stale; nothing is kept.
    #[tokio::test]
    async fn a_path_gone_since_it_was_shown_is_stale() {
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        let api = api(data.path());
        let id = open(&api, &r).await;
        for p in ["nope.txt", "added.txt"] {
            let err = discard(&api, id, &r, json!({ "kind": "paths", "paths": [p] })).await.unwrap_err();
            assert_eq!(err.kind, crate::error::GbErrorKind::Stale, "{p}");
        }
        let j = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(j["undo"].is_null(), "{j}");
    }

    /// An intent-to-add file (`add -N`): a snapshot can't carry the mark (it degrades to an
    /// untracked file), so every discard that would touch one is refused; nothing changes.
    #[tokio::test]
    async fn an_intent_to_add_file_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("n.txt", "content\nmore\n");
        r.git(&["add", "-N", "n.txt"]);
        r.write("a.txt", "edited\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = RepoState::capture(&r);
        let patch = json!({ "kind": "patch", "path": "n.txt", "selection": { "kind": "hunks", "hunks": [0] }, "base": base(&r, "n.txt") });
        for scope in [json!({ "kind": "paths", "paths": ["n.txt"] }), patch, json!({ "kind": "unstaged" }), json!({ "kind": "all" })] {
            let err = discard(&api, id, &r, scope.clone()).await.unwrap_err();
            assert_eq!(err.kind, crate::error::GbErrorKind::InvalidInput, "{scope}: {}", err.message);
            assert!(err.message.contains("n.txt"), "{}", err.message);
        }
        assert_eq!(RepoState::capture(&r), before);
        // A discard that doesn't touch it runs.
        discard(&api, id, &r, json!({ "kind": "paths", "paths": ["a.txt"] })).await.unwrap();
    }

    /// A tracked file inside an ignored folder discards and comes back like any other.
    #[tokio::test]
    async fn a_tracked_file_in_an_ignored_folder_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("build/t.txt", "t\n");
        r.git(&["add", "build/t.txt"]);
        r.git(&["commit", "-q", "-m", "t"]);
        std::fs::write(r.path().join(".git/info/exclude"), "/build\n").unwrap();
        r.write("build/t.txt", "changed\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "paths", "paths": ["build/t.txt"] }), "discard build/t.txt").await;
    }

    // --- Fix round 1 (task-4-review.md) ---

    /// A repository with one commit of `file` at `dir`, made with plain git.
    fn make_repo(dir: &std::path::Path, file: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let g = |args: &[&str]| {
            let out = std::process::Command::new("git").current_dir(dir).envs(crate::testing::isolated_git_env()).args(["-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join(file), "inner content\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "inner"]);
    }

    /// C1 (probe p04b): a repository standing where a tracked file was deleted (` T d`), with a
    /// `.git` folder or a `.git` file, is never wiped: every scope refuses, nothing changes.
    #[tokio::test]
    async fn a_repository_where_a_deleted_file_was_is_refused() {
        for gitfile in [false, true] {
            for scope in [json!({ "kind": "paths", "paths": ["d"] }), json!({ "kind": "unstaged" }), json!({ "kind": "all" })] {
                let data = tempfile::tempdir().unwrap();
                let r = repo();
                r.write("d", "tracked d\n");
                r.git(&["add", "d"]);
                r.git(&["commit", "-q", "-m", "d"]);
                std::fs::remove_file(r.path().join("d")).unwrap();
                let ext = tempfile::tempdir().unwrap();
                if gitfile {
                    make_repo(&ext.path().join("x"), "e.txt");
                    std::fs::create_dir_all(r.path().join("d")).unwrap();
                    std::fs::write(r.path().join("d/.git"), format!("gitdir: {}\n", ext.path().join("x/.git").display())).unwrap();
                    std::fs::write(r.path().join("d/e.txt"), "uncommitted work in d\n").unwrap();
                } else {
                    make_repo(&r.path().join("d"), "e.txt");
                    std::fs::write(r.path().join("d/wip.txt"), "uncommitted work in d\n").unwrap();
                }
                let api = api(data.path());
                let id = open(&api, &r).await;
                let before = RepoState::capture(&r);
                let err = discard(&api, id, &r, scope.clone()).await.unwrap_err();
                assert_eq!((err.kind, err.message.as_str()), (crate::error::GbErrorKind::InvalidInput, "d is a repository in the way: move it first"), "gitfile={gitfile} {scope}");
                assert!(r.path().join("d/.git").exists() && r.path().join("d/e.txt").exists(), "gitfile={gitfile} {scope}");
                assert_eq!(RepoState::capture(&r), before, "gitfile={gitfile} {scope}");
            }
        }
    }

    /// I1 (probes p20, p02): a dirty submodule beside an ordinary edit. Discard unstaged and all
    /// run (no false "garbage-collected"), never touch inside the submodule, and round-trip.
    #[tokio::test]
    async fn a_dirty_submodule_beside_an_edit_discards_and_round_trips() {
        for scope in ["unstaged", "all"] {
            let data = tempfile::tempdir().unwrap();
            let r = repo();
            make_repo(&r.path().join("emb"), "e.txt");
            r.git(&["add", "emb"]);
            r.git(&["commit", "-q", "-m", "emb"]);
            std::fs::write(r.path().join("emb/e.txt"), "dirty inside\n").unwrap();
            r.write("a.txt", "edited\n");
            let api = api(data.path());
            let id = open(&api, &r).await;
            let label = if scope == "all" { "discard all changes" } else { "discard unstaged changes" };
            round_trip(&api, id, &r, json!({ "kind": scope }), label).await;
            assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a\n", "{scope}");
            assert_eq!(std::fs::read_to_string(r.path().join("emb/e.txt")).unwrap(), "dirty inside\n", "{scope}: never inside");
        }
        // Named alone, the submodule's row says why nothing can be discarded there.
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        make_repo(&r.path().join("emb"), "e.txt");
        r.git(&["add", "emb"]);
        r.git(&["commit", "-q", "-m", "emb"]);
        std::fs::write(r.path().join("emb/e.txt"), "dirty inside\n").unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = discard(&api, id, &r, json!({ "kind": "paths", "paths": ["emb"] })).await.unwrap_err();
        assert_eq!(err.message, "emb is a submodule: discard its changes inside it");
    }

    /// M2 (probe p03): Discard all over a staged submodule deletion, its folder kept: the gitlink
    /// comes back in the index, the folder is never touched.
    #[tokio::test]
    async fn discard_all_over_a_staged_submodule_deletion_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        make_repo(&r.path().join("emb"), "e.txt");
        r.git(&["add", "emb"]);
        r.git(&["commit", "-q", "-m", "emb"]);
        r.git(&["rm", "-q", "--cached", "emb"]);
        std::fs::write(r.path().join("emb/new.txt"), "new inside\n").unwrap();
        r.write("a.txt", "edited\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        round_trip(&api, id, &r, json!({ "kind": "all" }), "discard all changes").await;
        assert!(r.path().join("emb/.git").exists() && r.path().join("emb/new.txt").exists());
        assert_eq!(r.git(&["ls-files", "-s", "emb"]).split(' ').next(), Some("160000"), "the gitlink is back");
    }

    /// M3 (probes p07, p19): a tracked folder replaced by a symlink is refused in words; the
    /// folder it points at is untouched.
    #[tokio::test]
    async fn a_folder_replaced_by_a_symlink_is_refused() {
        for unborn in [false, true] {
            for scope in [json!({ "kind": "paths", "paths": ["s/f.txt"] }), json!({ "kind": "all" })] {
                if unborn && scope["kind"] == "paths" {
                    continue;
                }
                let data = tempfile::tempdir().unwrap();
                let r = if unborn { TestRepo::new() } else { repo() };
                r.write("s/f.txt", "tracked f\n");
                r.git(&["add", "s/f.txt"]);
                if !unborn {
                    r.git(&["commit", "-q", "-m", "s"]);
                }
                std::fs::remove_dir_all(r.path().join("s")).unwrap();
                let ext = tempfile::tempdir().unwrap();
                std::fs::write(ext.path().join("f.txt"), "OUTSIDE\n").unwrap();
                std::os::unix::fs::symlink(ext.path(), r.path().join("s")).unwrap();
                let api = api(data.path());
                let id = open(&api, &r).await;
                let err = discard(&api, id, &r, scope.clone()).await.unwrap_err();
                assert_eq!(err.message, "s is a symbolic link where a folder of s/f.txt was: move it first", "unborn={unborn} {scope}");
                assert_eq!(std::fs::read_to_string(ext.path().join("f.txt")).unwrap(), "OUTSIDE\n");
            }
        }
    }

    /// M1 (probe p12): HEAD moved outside since the discard. Undo asks (HEAD's moved-ref prompt)
    /// and changes nothing; "Undo anyway" with HEAD as shown restores the snapshot.
    #[tokio::test]
    async fn undo_after_head_moved_asks_then_undo_anyway_restores() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a edited\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        discard(&api, id, &r, json!({ "kind": "all" })).await.unwrap();
        r.write("b.txt", "committed outside\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-q", "-m", "outside"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let before = RepoState::capture(&r);
        let asked = journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(asked["outcome"]["status"], "moved", "{asked}");
        assert_eq!((asked["outcome"]["refs"][0]["name"].as_str(), asked["outcome"]["refs"][0]["actual"].as_str()), (Some("HEAD"), Some(head.as_str())));
        // 2B final I1: HEAD stays where it is; the prompt never says the undo moves it.
        assert_eq!((asked["outcome"]["refs"][0]["target"].as_str(), asked["outcome"]["refs"][0]["stays"].as_bool()), (Some(head.as_str()), Some(true)));
        assert_eq!(RepoState::capture(&r), before, "asking changes nothing");
        let state = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        let entry = state["undo"]["entry"].as_u64().unwrap();
        let shown = asked["outcome"]["refs"][0]["actual"].clone();
        call(&api, "undo", json!({ "repo": id, "worktree": wt(r.path()), "entry": entry, "confirm": { "HEAD": shown } })).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a edited\n", "undone anyway");
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head, "HEAD itself never moves");
    }

    /// 2B final I1: a branch switch at the same commit is shown by branch (never "it's at X,
    /// not X"), and "Undo anyway" with the branch as shown restores over it, HEAD unmoved.
    #[tokio::test]
    async fn undo_after_a_branch_switch_asks_by_branch() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "a edited\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        discard(&api, id, &r, json!({ "kind": "all" })).await.unwrap();
        r.git(&["switch", "-q", "-c", "feature"]);
        let asked = journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(asked["outcome"]["status"], "moved", "{asked}");
        let m = &asked["outcome"]["refs"][0];
        assert_eq!(
            (m["expected"].as_str(), m["actual"].as_str(), m["target"].as_str(), m["stays"].as_bool()),
            (Some("refs/heads/main"), Some("refs/heads/feature"), Some("refs/heads/feature"), Some(true))
        );
        let entry = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap()["undo"]["entry"].clone();
        let done = call(&api, "undo", json!({ "repo": id, "worktree": wt(r.path()), "entry": entry, "confirm": { "HEAD": m["actual"] } })).await.unwrap();
        assert_eq!(done["outcome"]["status"], "done", "{done}");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a edited\n");
        assert_eq!(r.git(&["rev-parse", "--symbolic-full-name", "HEAD"]), "refs/heads/feature", "HEAD stays");
    }

    /// M6: the label is counted under the lock, from what `plan` found.
    #[tokio::test]
    async fn the_label_counts_what_plan_found() {
        use crate::write::WriteIntent;
        let data = tempfile::tempdir().unwrap();
        let r = dirty();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let h = api.handle(id).unwrap();
        let root = r.path().canonicalize().unwrap();
        let d = super::Discard { scope: super::DiscardScope::Paths { paths: vec!["dir".into()] }, label: std::sync::Mutex::new("discard dir".into()), targets: std::sync::Mutex::new(None) };
        let before = crate::write::Before { head: Default::default(), refs: Default::default(), in_progress: None };
        let pre = crate::write::Pre { api: &api, h: &h, root: &root, expect: &Default::default(), before: &before };
        d.plan(&pre).await.unwrap();
        assert_eq!(d.label(), "discard 2 files");
    }
}
