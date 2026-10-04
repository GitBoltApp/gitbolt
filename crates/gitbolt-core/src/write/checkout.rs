//! Checkout (spec #2 §9.3). The case is resolved when the op runs (§3.6), in `plan`:
//!
//! | target | local `<name>` | action |
//! |---|---|---|
//! | branch | here already | nothing (Deviation 12) |
//! | branch | elsewhere | refused: CheckedOutElsewhere |
//! | branch | — | `git switch --no-guess <name>` |
//! | remote | none | `git switch --no-guess --track -c <name> <remote>/<name>` |
//! | remote | elsewhere | refused: CheckedOutElsewhere (whatever the ancestry) |
//! | remote | here, equal or ahead | nothing (Deviation 12) |
//! | remote | equal or ahead | `git switch --no-guess <name>` |
//! | remote | behind, not checked out | CAS fast-forward, then switch |
//! | remote | behind, checked out here | `git merge --ff-only --no-autostash <remote>/<name>` (Rewind) |
//! | remote | diverged | `Diverged` (nothing runs, the oids shown come back); with `on_diverged: reset` (pinned to them by `expect`), a CAS move then a switch, or here a `read-tree -m -u` then the CAS (Rewind) |
//! | detached | — | `git switch --detach <oid>` (hex only, resolved to a commit) |
//!
//! Each autostashes per §6.1 (overlap with the commit the worktree moves to); the pipeline
//! restores it with `--index` whatever the run did (step 8), so a failed checkout never strands
//! the user's changes. A step that fails or is cancelled with HEAD where it was puts the paths it
//! touches back first (`put_back`, review I1), so the restore lands on the tree the user left.
//! A remote-tracking start is spelled as its full ref (`refs/remotes/<remote>/<name>`), so a tag
//! or local branch named `<remote>/<name>` can't win.
//!
//! Reset-here's `read-tree -m -u` runs no `post-checkout` hook and doesn't recurse into
//! submodules (review M9), as undo's Rewind; `git reset --keep` without recursion is the same.

use crate::api::blocking;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{RefMove, UndoKind};
use crate::write::precheck::{ahead_behind, display_worktree};
use crate::write::types::Confirm;
use crate::write::{config, Plan, Pre, WriteCx, WriteIntent};
use gix::objs::tree::EntryKind;
use gix::ObjectId;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum CheckoutTarget {
    Branch { name: String },
    /// `remote` and `branch` are separate: a remote's name may hold `/` (Review Focus 3).
    Remote {
        remote: String,
        branch: String,
        /// The local branch to create or track; the remote branch's own name when absent.
        #[serde(default)]
        #[ts(optional)]
        local: Option<String>,
    },
    /// A commit id (hex, 4 to 64 digits).
    Detached { oid: String },
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum OnDiverged {
    Reset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum CheckoutOutcome {
    Done { branch: Option<String> },
    /// Nothing changed. The UI asks "<local> and <remote> have diverged (2 ahead, 3 behind)."
    /// [Reset <local> to <remote>] [Cancel], and Reset sends again with `on_diverged: reset` and
    /// `expect.refs` = { `refs/heads/<local>`: `localOid`, `refs/remotes/<remote>`: `remoteOid` }
    /// (review M2): a commit or fetch since the dialog is RefMoved, never a bigger reset.
    Diverged { local: String, remote: String, ahead: u32, behind: u32, local_oid: String, remote_oid: String },
}

#[derive(Debug, Clone)]
enum Case {
    Noop { name: String },
    Switch { name: String, to: String },
    Track { name: String, remote_ref: String, to: String },
    FastForward { name: String, remote: String, from: String, to: String },
    MergeFfOnly { remote: String, remote_ref: String, to: String },
    Diverged { name: String, remote: String, ahead: u32, behind: u32, local_oid: String, remote_oid: String },
    Reset { name: String, from: String, to: String, here: bool },
    Detach { oid: String },
}

pub(crate) struct Checkout {
    pub target: CheckoutTarget,
    pub on_diverged: Option<OnDiverged>,
    pub confirm: Confirm,
    case: OnceLock<Case>,
}

impl Checkout {
    pub(crate) fn new(target: CheckoutTarget, on_diverged: Option<OnDiverged>, confirm: Confirm) -> Self {
        Self { target, on_diverged, confirm, case: OnceLock::new() }
    }

    fn case(&self) -> Result<&Case, GbError> {
        self.case.get().ok_or_else(|| GbError::other("checkout ran without a plan"))
    }

    /// What the target is called: a detached one by its resolved commit once `plan` ran (M4).
    fn target_name(&self) -> String {
        match (&self.target, self.case.get()) {
            (CheckoutTarget::Detached { .. }, Some(Case::Detach { oid })) => short(oid).to_string(),
            (CheckoutTarget::Detached { oid }, _) => short(oid).to_string(),
            (CheckoutTarget::Branch { name }, _) => name.clone(),
            (CheckoutTarget::Remote { remote, branch, .. }, _) => format!("{remote}/{branch}"),
        }
    }
}

fn heads(name: &str) -> String {
    format!("refs/heads/{name}")
}

/// The first seven characters (review M3: never a byte slice, whatever the request holds).
fn short(oid: &str) -> &str {
    oid.char_indices().nth(7).map_or(oid, |(i, _)| &oid[..i])
}

fn oid_of(s: &str) -> Option<ObjectId> {
    ObjectId::from_hex(s.as_bytes()).ok()
}

fn touch_all(cx: &mut WriteCx<'_>) {
    for k in [ChangeKind::Head, ChangeKind::Index, ChangeKind::Worktree] {
        cx.touch(k);
    }
}

/// The worktree other than this one whose HEAD is `full`, as the UI names it.
async fn elsewhere(pre: &Pre<'_>, full: &str) -> Result<Option<String>, GbError> {
    let worktrees = crate::worktree::list_worktrees(&pre.api.cli, pre.root).await?;
    let main = worktrees.iter().find(|w| w.is_main).map(|w| w.path.clone()).unwrap_or_else(|| pre.h.workdir.clone());
    Ok(worktrees
        .iter()
        .find(|w| w.branch.as_deref() == Some(full) && w.path.canonicalize().unwrap_or_else(|_| w.path.clone()) != pre.root)
        .map(|w| display_worktree(&main, &w.path)))
}

/// A detached target as a full commit oid. Only hex is accepted (review M4: not a ref name,
/// which would resolve gix's way and label the entry with it), and anything that isn't a commit
/// is NotFound before anything runs.
async fn commit_oid(pre: &Pre<'_>, given: &str) -> Result<String, GbError> {
    if !(4..=64).contains(&given.len()) || !given.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("Not a commit id: {}", short(given))));
    }
    let (root, spec) = (pre.root.to_path_buf(), given.to_ascii_lowercase());
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let found = repo.rev_parse_single(spec.as_str()).ok().and_then(|id| id.object().ok()?.peel_to_commit().ok().map(|c| c.id.to_string()));
        found.ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("No commit {}", short(&spec))))
    })
    .await
}

/// `git switch --no-guess <name>` after the branch's ref was moved (a fast-forward or a reset of
/// a branch not checked out): if the switch fails and HEAD didn't land on it, the paths it touched
/// go back (`put_back`), then the ref (a CAS on the value just set), so a refusal or a Cancel
/// changes nothing (as undo's redo does).
async fn switch_after_move(cx: &mut WriteCx<'_>, name: &str, moved: &RefMove, message: &str) -> Result<(), GbError> {
    let inv = cx.git(["switch", "--no-guess", name]);
    let res = cx.run_git(inv).await;
    touch_all(cx);
    if let Err(mut e) = res {
        let landed = gix::open(cx.root).ok().and_then(|r| crate::write::head_state(&r).ok()).is_some_and(|now| now.branch.as_deref() == Some(name));
        if !landed {
            if let Some(to) = &moved.new {
                e = put_back(cx, to, e).await;
            }
            // Not after a stopped put-back: the worktree may still be partly the target's, and the
            // kept entry (with its ref move) is what the user looks at.
            if !cx.repair_stopped() {
                let back = [RefMove { name: moved.name.clone(), old: moved.new.clone(), new: moved.old.clone() }];
                if let Err(b) = cx.cas(&back, message).await {
                    tracing::warn!(target: "gitbolt_core::write", "putting {} back after a failed checkout: {b}", moved.name);
                }
            }
        }
        return Err(e);
    }
    Ok(())
}

/// A local step that moves the worktree to `to` failed (or was cancelled): its paths go back,
/// and the error says what couldn't.
pub(crate) async fn failed_move<T>(cx: &mut WriteCx<'_>, res: Result<T, GbError>, to: &str) -> Result<T, GbError> {
    match res {
        Ok(v) => Ok(v),
        Err(e) => Err(put_back(cx, to, e).await),
    }
}

/// `config::changes` sorts by key (`merge` before `remote`); git wrote `--track`'s keys as
/// `remote`, then `merge`. Redo replays them in the recorded order, so they're recorded in
/// git's, and the config file reads the same after a redo as after the checkout (a read).
async fn in_config_order(cx: &WriteCx<'_>, changes: &mut [crate::journal::ConfigChange]) {
    let inv = GitInvocation::new(cx.root, ["config", "--local", "--null", "--name-only", "--get-regexp", r"^branch\."]);
    let Ok(out) = cx.api.cli.run(inv).await else { return };
    let names: Vec<&[u8]> = out.stdout.split(|b| *b == 0).filter(|n| !n.is_empty()).collect();
    changes.sort_by_key(|c| names.iter().position(|n| *n == c.key.as_bytes()).unwrap_or(usize::MAX));
}

/// `update-index -q --refresh` before a `read-tree -m -u` (2A final I2): a file saved with the
/// same bytes would otherwise be "not uptodate" and block it. `repair`: a repair step
/// (`run_repair`: the op's Cancel doesn't stop it, a Stop does).
async fn refresh_index(cx: &mut WriteCx<'_>, repair: bool) {
    let args = ["update-index", "-q", "--refresh"];
    let _ = if repair {
        let inv = cx.git_repair(args);
        cx.run_repair(inv).await
    } else {
        let inv = cx.git(args);
        cx.run_git(inv).await
    };
    cx.touch(ChangeKind::Index);
}

// --- the put-back after an interrupted move (review I1) ---
/// A tree or index entry: its blob and its kind (mode).
type Entry = (ObjectId, EntryKind);

/// One path a move touches: its entry in HEAD, in the target and in the index.
struct Touched {
    path: String,
    head: Option<Entry>,
    target: Option<Entry>,
    index: Option<Entry>,
}

/// What's in the worktree at a touched path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Found {
    /// Nothing there, or a parent that's now a file (ENOTDIR: a folder the target replaced by a
    /// file, re-review M3).
    Missing,
    Blob(Entry),
    /// A directory: put back only once it's gone (the removals below may empty it).
    Dir,
    /// Unreadable, or not hashed: left alone.
    Unknown,
}

/// Review I1. A local step that moves the worktree to `to` (`git switch`, `merge --ff-only`,
/// `read-tree -m -u`) failed or was cancelled with HEAD where preflight saw it: git may have
/// rewritten some of the paths the move touches, and even the index, before it stopped. None of
/// those paths held the user's changes (dirty ∩ touched was autostashed, §6.1), so each one whose
/// index entry and file are still as HEAD or `to` has them goes back to HEAD's (content and
/// mode); a path holding anything else is left alone. It runs before step 8 restores the
/// autostash, as repair steps (`run_repair`: a Stop ends them).
///
/// Returns the error the write reports: `failure` itself when everything went back. Otherwise
/// the entry is kept (`partial`), and the error (no longer a quiet Cancelled) names the paths
/// left as the step wrote them (re-review M1) in its message and Details; after a Stop, the
/// entry is also blocked with the reason, since undoing it would act on a half-switched tree.
pub(crate) async fn put_back(cx: &mut WriteCx<'_>, to: &str, failure: GbError) -> GbError {
    let what = if failure.kind == GbErrorKind::Cancelled { "cancelled" } else { "failed" };
    let res = if cx.repair_stopped() { Err(GbError::other("Stopped restoring files")) } else { put_back_inner(cx, to).await };
    let (left, problem) = match res {
        Ok(left) => (left, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    if problem.is_none() && left.is_empty() {
        return failure;
    }
    cx.partial = true;
    let mut details: Vec<String> = Vec::new();
    let message = if cx.repair_stopped() {
        let why = format!("Restoring files after the {what} checkout was stopped: some files may still be as it left them. Check the working copy");
        if let Err(e) = cx.edit_entry(|entry| entry.blocked = Some(why.clone())) {
            tracing::warn!(target: "gitbolt_core::write", "blocking the entry of a stopped put-back: {e}");
        }
        why
    } else if let Some(p) = &problem {
        tracing::warn!(target: "gitbolt_core::write", "putting the worktree back after a {what} move to {}: {p}", short(to));
        details.push(format!("Putting the files back failed: {}", p.message));
        details.extend(p.stderr.clone());
        format!("The {what} checkout couldn't put every file back; check the working copy")
    } else {
        let shown: Vec<&str> = left.iter().take(3).map(String::as_str).collect();
        let more = if left.len() > 3 { format!(" and {} more", left.len() - 3) } else { String::new() };
        format!("The checkout was {what}; {} left as it wrote {}: {}{more}", plural(left.len(), "file was", "files were"), if left.len() == 1 { "it" } else { "them" }, shown.join(", "))
    };
    if !left.is_empty() {
        details.push("Left as the interrupted checkout wrote them:".into());
        details.extend(left.iter().map(|p| format!("  {p}")));
    }
    details.push(format!("The checkout: {}", failure.message));
    details.extend(failure.stderr.clone());
    GbError { stderr: Some(details.join("\n")), ..GbError::other(message) }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

fn tree_entry(tree: &gix::Tree<'_>, path: &str) -> Option<Entry> {
    tree.lookup_entry_by_path(path).ok().flatten().filter(|e| !e.mode().is_tree()).map(|e| (e.object_id(), e.mode().kind()))
}

/// The paths it left alone.
async fn put_back_inner(cx: &mut WriteCx<'_>, to: &str) -> Result<Vec<String>, GbError> {
    let Some(to) = oid_of(to) else { return Ok(Vec::new()) };
    let (root, before) = (cx.root.to_path_buf(), cx.before.head.clone());
    let (rows, hash_kind, file_mode) = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let (hash_kind, file_mode) = (repo.object_hash(), repo.config_snapshot().boolean("core.fileMode").unwrap_or(true));
        // HEAD moved: the step landed (a hook failed after it), and nothing goes back.
        if crate::write::head_state(&repo)? != before {
            return Ok((Vec::new(), hash_kind, file_mode));
        }
        let Some(head) = before.oid.as_deref().and_then(oid_of) else { return Ok((Vec::new(), hash_kind, file_mode)) };
        let paths = crate::write::precheck::tree_diff_paths(&repo, head, to)?;
        let head_tree = repo.find_commit(head).map_err(gix_err)?.tree().map_err(gix_err)?;
        let to_tree = repo.find_commit(to).map_err(gix_err)?.tree().map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let rows: Vec<Touched> = paths
            .into_iter()
            .map(|p| Touched {
                head: tree_entry(&head_tree, &p),
                target: tree_entry(&to_tree, &p),
                index: index.entry_by_path(p.as_str().into()).and_then(|e| Some((e.id, e.mode.to_tree_entry_mode()?.kind()))),
                path: p,
            })
            .collect();
        Ok((rows, hash_kind, file_mode))
    })
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    // Without core.fileMode, the executable bit isn't tracked.
    let norm = |k: EntryKind| if !file_mode && k == EntryKind::BlobExecutable { EntryKind::Blob } else { k };
    let found = worktree_ids(cx, &rows, hash_kind).await?;
    let (mut left, mut unstage, mut checkout, mut remove, mut dirs) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (row, found) in rows.iter().zip(found) {
        // Content as HEAD or the target has it (the mode is put back either way).
        let ours = |e: Option<Entry>| e.map(|e| e.0) == row.head.map(|e| e.0) || e.map(|e| e.0) == row.target.map(|e| e.0);
        let file_ok = match found {
            Found::Missing | Found::Dir => true,
            Found::Blob(e) => ours(Some(e)),
            Found::Unknown => false,
        };
        // A file removed below must not sit under a symlink the step left (re-review N3).
        let linked = leading_symlink(cx.root, &row.path);
        if !ours(row.index) || !file_ok || linked {
            tracing::warn!(target: "gitbolt_core::write", "{} changed during the failed move: left as it is", row.path);
            left.push(row.path.clone());
            continue;
        }
        if row.index != row.head {
            unstage.push(row.path.clone());
        }
        match (row.head, found) {
            (Some(h), Found::Blob(e)) if e.0 == h.0 && norm(e.1) == norm(h.1) => {}
            (Some(_), Found::Dir) => dirs.push(row.path.clone()),
            (Some(_), _) => checkout.push(row.path.clone()),
            (None, Found::Blob(_)) => remove.push(row.path.clone()),
            (None, _) => {}
        }
    }
    let nul = |paths: &[String]| paths.iter().flat_map(|p| p.bytes().chain([0])).collect::<Vec<u8>>();
    // 1. The index entries the step wrote go back to HEAD's.
    if !unstage.is_empty() {
        let inv = cx.git_repair(["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"]).env("GIT_LITERAL_PATHSPECS", "1").stdin(nul(&unstage));
        cx.run_repair(inv).await?;
        cx.touch(ChangeKind::Index);
    }
    // 2. Files the step added (not in HEAD) go, and the folders that leaves empty.
    for p in &remove {
        let full = cx.root.join(p);
        std::fs::remove_file(&full)?;
        prune_empty(cx.root, full.parent());
        cx.touch(ChangeKind::Worktree);
    }
    // 3. HEAD's files come back from the index (now HEAD's for these paths), with their modes; a
    //    folder the step made in place of one only once the removals emptied it.
    for p in dirs {
        if cx.root.join(&p).exists() {
            left.push(p);
        } else {
            checkout.push(p);
        }
    }
    if !checkout.is_empty() {
        let inv = cx.git_repair(["checkout-index", "-f", "-q", "-z", "--stdin"]).stdin(nul(&checkout));
        cx.run_repair(inv).await?;
        cx.touch(ChangeKind::Worktree);
    }
    Ok(left)
}

/// Whether a folder on `rel`'s way down from `root` is a symlink.
fn leading_symlink(root: &Path, rel: &str) -> bool {
    let mut at = root.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    parts[..parts.len().saturating_sub(1)].iter().any(|part| {
        at.push(part);
        at.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink())
    })
}

/// Removes `dir` and its parents while they're empty, never `root` itself.
fn prune_empty(root: &Path, mut dir: Option<&Path>) {
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || std::fs::remove_dir(d).is_err() {
            return;
        }
        dir = d.parent();
    }
}

/// Each touched path's file as git would store it (clean filters applied, nothing written:
/// `hash-object --stdin-paths` without `-w`, a repair step so a Stop ends a hung filter); a
/// symlink hashes its target.
async fn worktree_ids(cx: &mut WriteCx<'_>, rows: &[Touched], hash_kind: gix::hash::Kind) -> Result<Vec<Found>, GbError> {
    use std::os::unix::fs::PermissionsExt;
    let mut found = vec![Found::Unknown; rows.len()];
    let mut regular: Vec<(usize, EntryKind)> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let full = cx.root.join(&row.path);
        found[i] = match full.symlink_metadata() {
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Found::Missing,
            Err(_) => Found::Unknown,
            Ok(m) if m.file_type().is_symlink() => match std::fs::read_link(&full) {
                Ok(t) => gix::objs::compute_hash(hash_kind, gix::objs::Kind::Blob, &t.into_os_string().into_encoded_bytes()).map_or(Found::Unknown, |id| Found::Blob((id, EntryKind::Link))),
                Err(_) => Found::Unknown,
            },
            Ok(m) if m.is_dir() => Found::Dir,
            Ok(m) if m.is_file() && !row.path.contains('\n') => {
                regular.push((i, if m.permissions().mode() & 0o111 != 0 { EntryKind::BlobExecutable } else { EntryKind::Blob }));
                Found::Unknown
            }
            Ok(_) => Found::Unknown,
        };
    }
    if !regular.is_empty() {
        let list: String = regular.iter().map(|(i, _)| format!("{}\n", rows[*i].path)).collect();
        let out = cx.run_repair(GitInvocation::new(cx.root, ["hash-object", "--stdin-paths"]).stdin(list.into_bytes())).await?;
        let ids: Vec<ObjectId> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| oid_of(l.trim())).collect();
        if ids.len() == regular.len() {
            for ((i, kind), id) in regular.into_iter().zip(ids) {
                found[i] = Found::Blob((id, kind));
            }
        }
    }
    Ok(found)
}
// --- end the put-back ---

impl WriteIntent for Checkout {
    type Outcome = CheckoutOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Checkout
    }
    fn label(&self) -> String {
        format!("checkout {}", self.target_name())
    }
    /// `run` changes it to Rewind when the checked-out branch moved in place.
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Switch)
    }
    /// `post-checkout`, and the merge hooks of `--ff-only`.
    fn runs_hooks(&self) -> bool {
        true
    }
    fn refs(&self) -> Vec<String> {
        match &self.target {
            CheckoutTarget::Branch { name } => vec![heads(name)],
            CheckoutTarget::Remote { remote, branch, local } => vec![heads(local.as_ref().unwrap_or(branch)), format!("refs/remotes/{remote}/{branch}")],
            CheckoutTarget::Detached { .. } => Vec::new(),
        }
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let here_branch = pre.before.head.branch.clone();
        let read = |name: &str| pre.before.refs.get(name).cloned().flatten();
        let case = match &self.target {
            CheckoutTarget::Branch { name } => {
                let Some(to) = read(&heads(name)) else {
                    return Err(GbError::new(GbErrorKind::NotFound, format!("No branch {name}")));
                };
                if here_branch.as_deref() == Some(name.as_str()) {
                    Case::Noop { name: name.clone() }
                } else if let Some(shown) = elsewhere(pre, &heads(name)).await? {
                    return Err(GbError::checked_out_elsewhere(name, &shown));
                } else {
                    Case::Switch { name: name.clone(), to }
                }
            }
            CheckoutTarget::Remote { remote, branch, local: pick } => {
                let lname = pick.as_ref().unwrap_or(branch);
                let remote_ref = format!("refs/remotes/{remote}/{branch}");
                let shown_remote = format!("{remote}/{branch}");
                let Some(to) = read(&remote_ref) else {
                    return Err(GbError::new(GbErrorKind::NotFound, format!("No branch {shown_remote}")));
                };
                let here = here_branch.as_deref() == Some(lname.as_str());
                match read(&heads(lname)) {
                    None => Case::Track { name: lname.clone(), remote_ref, to },
                    Some(local) => {
                        // Every case below lands this worktree on the branch: one checked out in
                        // another worktree is refused first, before any question is asked.
                        if !here && let Some(shown) = elsewhere(pre, &heads(lname)).await? {
                            return Err(GbError::checked_out_elsewhere(lname, &shown));
                        }
                        let (ahead, behind) = ahead_behind(&pre.api.cli, pre.root, &local, &to).await?;
                        match (ahead, behind) {
                            (_, 0) if here => Case::Noop { name: lname.clone() },
                            (_, 0) => Case::Switch { name: lname.clone(), to: local },
                            (0, _) if here => Case::MergeFfOnly { remote: shown_remote, remote_ref, to },
                            (0, _) => Case::FastForward { name: lname.clone(), remote: shown_remote, from: local, to },
                            (ahead, behind) => match self.on_diverged {
                                None => Case::Diverged { name: lname.clone(), remote: shown_remote, ahead, behind, local_oid: local, remote_oid: to },
                                Some(OnDiverged::Reset) => {
                                    // Review M2: the Reset is the one the dialog showed. Preflight
                                    // compared `expect` with the refs (RefMoved when they moved).
                                    if !pre.expect.refs.contains_key(&heads(lname)) || !pre.expect.refs.contains_key(&remote_ref) {
                                        return Err(GbError::new(GbErrorKind::InvalidInput, format!("Reset {lname} needs the commits the question showed")));
                                    }
                                    Case::Reset { name: lname.clone(), from: local, to, here }
                                }
                            },
                        }
                    }
                }
            }
            CheckoutTarget::Detached { oid } => Case::Detach { oid: commit_oid(pre, oid).await? },
        };
        // §6.1: autostash on overlap with the commit the worktree moves to.
        let moves_to = match &case {
            Case::Noop { .. } | Case::Diverged { .. } => None,
            Case::Switch { to, .. } | Case::Track { to, .. } | Case::MergeFfOnly { to, .. } | Case::FastForward { to, .. } | Case::Reset { to, .. } => Some(to.clone()),
            Case::Detach { oid } => Some(oid.clone()),
        };
        // --- 2C repo-safety ---
        // Every case that moves the worktree (`git switch`, `--track`, `--detach`, `merge
        // --ff-only`, Reset-here's `read-tree -m -u`, and the switch after a CAS) is a two-way
        // move from HEAD's tree to `to`'s: one that writes a file where a populated submodule or
        // an embedded clone sits deletes it whole, and a clean one isn't dirty, so the autostash
        // never sees it. Refused before anything runs (2C T6 re-review 3, C1 and C2).
        // The same check says what the move sweeps away with a directory (safety review M1,
        // M2): the autostash rule carries it.
        let mut rule = AutostashRule::Overlap;
        if let (Some(from), Some(to)) = (pre.before.head.oid.as_deref().and_then(oid_of), moves_to.as_deref().and_then(oid_of)) {
            rule = crate::write::precheck::refuse_repos_in_the_way(&pre.api.cli, pre.root, from, to, "checkout").await?.rule();
        }
        // --- end 2C repo-safety ---
        let _ = self.case.set(case);
        let autostash = moves_to.and_then(|t| oid_of(&t)).map(|t| AutostashSpec { rule, target: Some(t), op: self.label(), target_name: Some(self.target_name()) });
        Ok(Plan { autostash, ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<CheckoutOutcome, GbError> {
        let done = |name: Option<&str>| CheckoutOutcome::Done { branch: name.map(str::to_string) };
        match self.case()?.clone() {
            Case::Noop { name } => Ok(done(Some(&name))),
            Case::Diverged { name, remote, ahead, behind, local_oid, remote_oid } => Ok(CheckoutOutcome::Diverged { local: name, remote, ahead, behind, local_oid, remote_oid }),
            Case::Switch { name, to } => {
                let inv = cx.git(["switch", "--no-guess", name.as_str()]);
                let res = cx.run_git(inv).await;
                touch_all(cx);
                failed_move(cx, res, &to).await?;
                Ok(done(Some(&name)))
            }
            Case::Track { name, remote_ref, to } => {
                let before = config::branch_config(&cx.api.cli, cx.root, &name).await?;
                let inv = cx.git(["switch", "--no-guess", "--track", "-c", name.as_str(), remote_ref.as_str()]);
                let res = cx.run_git(inv).await;
                touch_all(cx);
                let res = failed_move(cx, res, &to).await;
                // Whatever git did: a branch it created comes with its config, which undo replays.
                match config::branch_config(&cx.api.cli, cx.root, &name).await {
                    Ok(after) => {
                        let mut changes = config::changes(&before, &after);
                        in_config_order(cx, &mut changes).await;
                        cx.record_config(changes)?;
                    }
                    // Review M8: unknown, so the entry can't undo it faithfully: kept, and blocked
                    // with the reason (undo would delete the branch and leave its config).
                    Err(e) => {
                        tracing::warn!(target: "gitbolt_core::write", "reading branch.{name}.* after the checkout: {e}");
                        cx.partial = true;
                        let why = format!("Couldn't read {name}'s config after the checkout ({}), so it can't be undone", e.message);
                        cx.edit_entry(|entry| entry.blocked = Some(why))?;
                    }
                }
                res?;
                Ok(done(Some(&name)))
            }
            Case::FastForward { name, remote, from, to } => {
                let moved = RefMove { name: heads(&name), old: Some(from), new: Some(to) };
                let message = format!("merge {remote}: Fast-forward");
                cx.cas(std::slice::from_ref(&moved), &message).await?;
                switch_after_move(cx, &name, &moved, &message).await?;
                Ok(done(Some(&name)))
            }
            Case::MergeFfOnly { remote, remote_ref, to } => {
                cx.set_undo(UndoKind::Rewind)?;
                // Review M5: git never makes its own stash behind ours (`merge.autoStash`), and
                // the reflog reads `merge <remote>/<b>: Fast-forward`, as the FastForward case's.
                let inv = cx.git(["merge", "--ff-only", "--no-autostash", "-q", remote_ref.as_str()]).env("GIT_REFLOG_ACTION", format!("merge {remote}"));
                let res = cx.run_git(inv).await;
                touch_all(cx);
                failed_move(cx, res, &to).await?;
                Ok(done(cx.before.head.branch.as_deref()))
            }
            Case::Reset { name, from, to, here } => {
                let moved = RefMove { name: heads(&name), old: Some(from.clone()), new: Some(to.clone()) };
                let message = format!("gitbolt: reset {name} to {}", short(&to));
                if here {
                    // Rewind-style (§9.3): the two-way read-tree carries local changes and refuses
                    // on overlap; then the CAS; a failed CAS reverses the read-tree.
                    cx.set_undo(UndoKind::Rewind)?;
                    refresh_index(cx, false).await;
                    let inv = cx.git(["read-tree", "-m", "-u", from.as_str(), to.as_str()]);
                    let res = cx.run_git(inv).await;
                    touch_all(cx);
                    failed_move(cx, res, &to).await?;
                    if let Err(e) = cx.cas(std::slice::from_ref(&moved), &message).await {
                        refresh_index(cx, true).await;
                        let back = cx.git_repair(["read-tree", "-m", "-u", to.as_str(), from.as_str()]);
                        if let Err(b) = cx.run_repair(back).await {
                            tracing::warn!(target: "gitbolt_core::write", "reading the tree back after a failed reset of {name}: {b}");
                            return Err(put_back(cx, &to, e).await);
                        }
                        return Err(e);
                    }
                } else {
                    cx.cas(std::slice::from_ref(&moved), &message).await?;
                    switch_after_move(cx, &name, &moved, &message).await?;
                }
                Ok(done(Some(&name)))
            }
            Case::Detach { oid } => {
                let inv = cx.git(["switch", "--detach", oid.as_str()]);
                let res = cx.run_git(inv).await;
                touch_all(cx);
                failed_move(cx, res, &oid).await?;
                Ok(done(None))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::state::RepoState;
    use crate::testing::write::{identity, open, send, wt, WriteEnv};
    use crate::testing::TestRepo;
    use serde_json::json;

    /// Nine numbered lines, with the first, fifth and ninth given.
    fn lines(prefix: &str, first: &str, fifth: &str, last: &str) -> String {
        (1..=9)
            .map(|i| match i {
                1 => format!("{first}\n"),
                5 => format!("{fifth}\n"),
                9 => format!("{last}\n"),
                _ => format!("{prefix}{i}\n"),
            })
            .collect()
    }

    /// main and origin/main; feature/x (pushed) changes line 9 of a.txt and b.txt.
    fn repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.write("a.txt", &lines("a", "a1", "a5", "a9"));
        r.write("b.txt", &lines("b", "b1", "b5", "b9"));
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.add_origin();
        r.push("main");
        r.switch_new("feature/x");
        r.write("a.txt", &lines("a", "a1", "a5", "a9 x"));
        r.write("b.txt", &lines("b", "b1", "b5", "b9 x"));
        r.git(&["commit", "-q", "-am", "x"]);
        r.push("feature/x");
        r.switch("main");
        r
    }

    /// The staged and unstaged diffs without blob ids or context: what the split is.
    fn split(r: &TestRepo) -> (String, String) {
        let strip = |d: String| d.lines().filter(|l| !l.starts_with("index ")).collect::<Vec<_>>().join("\n");
        (strip(r.git(&["diff", "--cached", "-U0"])), strip(r.git(&["diff", "-U0"])))
    }

    fn oid(r: &TestRepo, rev: &str) -> String {
        r.git(&["rev-parse", rev])
    }

    fn checkout(id: u32, r: &TestRepo, target: serde_json::Value) -> serde_json::Value {
        json!({"method": "checkout", "params": {"repo": id, "worktree": wt(r), "target": target}})
    }

    async fn undo_redo(api: &crate::api::Api, id: u32, r: &TestRepo, before: &RepoState, after: &RepoState) {
        let s = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "undo", "params": {"repo": id, "worktree": wt(r), "entry": s["undo"]["entry"]}})).await.unwrap();
        assert_eq!(&RepoState::capture(r), before, "undo");
        let s = send(api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap();
        send(api, json!({"method": "redo", "params": {"repo": id, "worktree": wt(r), "entry": s["redo"]["entry"]}})).await.unwrap();
        assert_eq!(&RepoState::capture(r), after, "redo");
    }

    /// The Reset answer to a Diverged outcome, as the UI sends it: pinned to the oids shown (M2).
    fn reset_resend(id: u32, r: &TestRepo, out: &serde_json::Value) -> serde_json::Value {
        let o = &out["outcome"];
        let (local, remote) = (o["local"].as_str().unwrap(), o["remote"].as_str().unwrap());
        let (r_name, b_name) = remote.split_once('/').unwrap();
        let expect = json!({"refs": {format!("refs/heads/{local}"): o["localOid"], format!("refs/remotes/{remote}"): o["remoteOid"]}});
        json!({"method": "checkout", "params": {"repo": id, "worktree": wt(r), "target": {"kind": "remote", "remote": r_name, "branch": b_name}, "onDiverged": "reset", "expect": expect}})
    }

    /// Advances origin's `branch` by one commit from a second clone, then fetches.
    fn advance_remote(r: &TestRepo, branch: &str) {
        r.push_from_clone(branch, "theirs.txt", &format!("theirs on {branch}\n"), &format!("theirs on {branch}"));
        r.git(&["fetch", "-q", "origin"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_checkout_round_trips() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let out = send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "feature/x"}))).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "done", "branch": "feature/x"}));
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature/x");
        let after = RepoState::capture(&r);
        undo_redo(&env.api, id, &r, &before, &after).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checking_out_the_branch_already_here_is_a_no_op() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "main"}))).await.unwrap();
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        assert!(s["undo"].is_null(), "Deviation 12: no entry");
    }

    /// §17.1: a fully staged, b partly staged (line 1 staged, line 5 not), c untracked. The
    /// checkout overlaps a and b (feature/x changes their line 9), so they're autostashed, and the
    /// `--index` restore brings the same split back.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_autostash_keeps_the_staged_split() {
        let env = WriteEnv::new();
        let r = repo();
        r.write("a.txt", &lines("a", "a1 mine", "a5", "a9"));
        r.git(&["add", "a.txt"]);
        r.write("b.txt", &lines("b", "b1 staged", "b5", "b9"));
        r.git(&["add", "b.txt"]);
        r.write("b.txt", &lines("b", "b1 staged", "b5 unstaged", "b9"));
        r.write("c.txt", "untracked\n");
        let before = split(&r);
        let id = open(&env.api, &r).await;
        send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "feature/x"}))).await.unwrap();
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature/x");
        let s = send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(&r)}})).await.unwrap();
        assert!(s["banners"].as_array().unwrap().is_empty(), "restored cleanly: {s}");
        assert_eq!(split(&r), before, "the same staged and unstaged changes");
        assert!(r.path().join("c.txt").exists());
        assert!(r.git(&["stash", "list"]).is_empty(), "the autostash was dropped");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_branch_without_a_local_one_creates_a_tracking_branch() {
        let env = WriteEnv::new();
        let r = repo();
        r.git(&["branch", "-D", "feature/x"]);
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "feature/x@{upstream}"]), "origin/feature/x");
        let after = RepoState::capture(&r);
        undo_redo(&env.api, id, &r, &before, &after).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_branch_with_a_local_name_tracks_that_name_and_leaves_the_same_name_branch() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let same = oid(&r, "feature/x");
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x", "local": "origin-feature/x"}))).await.unwrap();
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/origin-feature/x");
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "origin-feature/x@{upstream}"]), "origin/feature/x");
        assert_eq!(oid(&r, "feature/x"), same, "the same-name branch is untouched");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_branch_equal_or_ahead_locally_just_switches() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let local = oid(&r, "feature/x");
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!((r.git(&["symbolic-ref", "HEAD"]), oid(&r, "HEAD")), ("refs/heads/feature/x".into(), local));
        r.commit("ahead");
        r.switch("main");
        let ahead = oid(&r, "feature/x");
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!(oid(&r, "HEAD"), ahead, "a local branch ahead of the remote isn't moved");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_behind_branch_not_checked_out_fast_forwards_then_switches() {
        let env = WriteEnv::new();
        let r = repo();
        advance_remote(&r, "feature/x");
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!(oid(&r, "feature/x"), oid(&r, "origin/feature/x"));
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature/x");
        let after = RepoState::capture(&r);
        undo_redo(&env.api, id, &r, &before, &after).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_behind_branch_checked_out_here_merges_ff_only_and_rewinds_on_undo() {
        let env = WriteEnv::new();
        let r = repo();
        r.switch("feature/x");
        advance_remote(&r, "feature/x");
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!(oid(&r, "HEAD"), oid(&r, "origin/feature/x"));
        let after = RepoState::capture(&r);
        undo_redo(&env.api, id, &r, &before, &after).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn diverged_asks_then_resets_and_undo_brings_the_local_commits_back() {
        for here in [false, true] {
            let env = WriteEnv::new();
            let r = repo();
            if here {
                r.switch("feature/x");
            }
            advance_remote(&r, "feature/x");
            r.git(&["switch", "-q", "feature/x"]);
            r.commit("mine 1");
            r.commit("mine 2");
            if !here {
                r.git(&["switch", "-q", "main"]);
            }
            let id = open(&env.api, &r).await;
            let before = RepoState::capture(&r);
            let target = json!({"kind": "remote", "remote": "origin", "branch": "feature/x"});
            let out = send(&env.api, checkout(id, &r, target)).await.unwrap();
            let (local, remote) = (oid(&r, "feature/x"), oid(&r, "origin/feature/x"));
            assert_eq!(out["outcome"], json!({"status": "diverged", "local": "feature/x", "remote": "origin/feature/x", "ahead": 2, "behind": 1, "localOid": local, "remoteOid": remote}));
            assert_eq!(RepoState::capture(&r), before, "nothing changed until Reset");
            send(&env.api, reset_resend(id, &r, &out)).await.unwrap();
            assert_eq!(oid(&r, "feature/x"), oid(&r, "origin/feature/x"), "here={here}");
            assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature/x");
            let after = RepoState::capture(&r);
            undo_redo(&env.api, id, &r, &before, &after).await;
        }
    }

    /// Review Focus 4.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_branch_checked_out_in_another_worktree_is_refused_with_where() {
        let env = WriteEnv::new();
        let r = repo();
        r.add_worktree("x", "feature/x");
        advance_remote(&r, "feature/x");
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        for target in [json!({"kind": "branch", "name": "feature/x"}), json!({"kind": "remote", "remote": "origin", "branch": "feature/x"})] {
            let e = send(&env.api, checkout(id, &r, target)).await.unwrap_err();
            assert_eq!(e.kind, GbErrorKind::InvalidInput);
            let v = serde_json::to_value(&e).unwrap();
            assert_eq!(v["detail"], json!({"kind": "checkedOutElsewhere", "branch": "feature/x", "worktree": "../wt-x"}));
        }
        assert_eq!(RepoState::capture(&r), before);
    }

    /// Review Focus 3.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_remote_named_with_a_slash_checks_out() {
        let env = WriteEnv::new();
        let r = repo();
        let up = r.root().join("up.git");
        r.git_in(r.root(), &["init", "-q", "--bare", up.to_str().unwrap()]);
        r.git(&["remote", "add", "up/stream", up.to_str().unwrap()]);
        r.git(&["push", "-q", "up/stream", "feature/x:refs/heads/topic"]);
        r.git(&["fetch", "-q", "up/stream"]);
        let id = open(&env.api, &r).await;
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "up/stream", "branch": "topic"}))).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "up/stream/topic");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_detached_checkout_round_trips_and_a_merge_in_progress_refuses() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let base = oid(&r, "main");
        send(&env.api, checkout(id, &r, json!({"kind": "detached", "oid": oid(&r, "feature/x")}))).await.unwrap();
        assert!(r.try_git(&["symbolic-ref", "-q", "HEAD"]).is_err());
        let after = RepoState::capture(&r);
        undo_redo(&env.api, id, &r, &before, &after).await;
        // A merge in progress (MERGE_HEAD present): preflight refuses before anything runs.
        std::fs::write(r.path().join(".git/MERGE_HEAD"), format!("{base}\n")).unwrap();
        let e = send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "feature/x"}))).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InProgress);
    }

    /// §6.2: changes that would conflict with the target ask first, with nothing changed (the
    /// staged and unstaged split included), and nothing is left in the stash list.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_conflicting_autostash_asks_first_and_changes_nothing() {
        let env = WriteEnv::new();
        let r = repo();
        r.write("a.txt", &lines("a", "a1", "a5", "a9 mine"));
        r.git(&["add", "a.txt"]);
        r.write("b.txt", &lines("b", "b1", "b5", "b9 mine"));
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let e = send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "feature/x"}))).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Conflict, "{e:?}");
        assert_eq!(RepoState::capture(&r), before);
        assert!(r.git(&["stash", "list"]).is_empty());
    }

    /// A diverged branch checked out in another worktree is refused before Reset is offered.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_diverged_branch_elsewhere_is_refused_before_asking() {
        let env = WriteEnv::new();
        let r = repo();
        advance_remote(&r, "feature/x");
        r.git(&["switch", "-q", "feature/x"]);
        r.commit("mine");
        r.git(&["switch", "-q", "main"]);
        r.add_worktree("x", "feature/x");
        let id = open(&env.api, &r).await;
        let e = send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_short_detached_oid_resolves_and_an_unknown_one_is_not_found() {
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        let x = oid(&r, "feature/x");
        let out = send(&env.api, checkout(id, &r, json!({"kind": "detached", "oid": &x[..7]}))).await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "done", "branch": null}));
        assert_eq!(oid(&r, "HEAD"), x);
        let e = send(&env.api, checkout(id, &r, json!({"kind": "detached", "oid": "0000000000000000000000000000000000000001"}))).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::NotFound);
    }

    // --- fix round 1 ---

    async fn journal_state(env: &WriteEnv, id: u32, r: &TestRepo) -> serde_json::Value {
        send(&env.api, json!({"method": "journalState", "params": {"repo": id, "worktree": wt(r)}})).await.unwrap()
    }

    /// main → feature/x, in the order git writes them: `a.txt` changes, `b.sh` only becomes
    /// executable, the folder `d/` (with `d/b.txt`) becomes a file `d`, six `*.slow` files change
    /// through a smudge filter, and `new/added.txt` is added. The filter takes a second per file
    /// while `<root>/slow` exists, and thirty while `<root>/hang` does. The user's changes: `a.txt`
    /// (the target touches it: autostashed) and `mine.txt` (it doesn't).
    fn slow_repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.write(".gitattributes", "*.slow filter=slow\n");
        r.write("a.txt", &lines("a", "a1", "a5", "a9"));
        r.write("b.sh", "echo b\n");
        r.write("d/b.txt", "in d\n");
        r.write("mine.txt", "mine\n");
        for i in 0..6 {
            r.write(&format!("f{i}.slow"), &format!("main {i}\n"));
        }
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature/x");
        r.write("a.txt", &lines("a", "a1", "a5", "a9 x"));
        r.git(&["update-index", "--chmod=+x", "b.sh"]);
        r.git(&["rm", "-q", "-r", "d"]);
        r.write("d", "d is a file\n");
        for i in 0..6 {
            r.write(&format!("f{i}.slow"), &format!("x {i}\n"));
        }
        r.write("new/added.txt", "added\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "x"]);
        r.switch("main");
        // The filter is gated by a FIFO: while `<root>/gate` exists, each run blocks reading one
        // line from it, so the test knows the exact moment git is in a filter (its open of the
        // FIFO for writing returns), and a filter left without a writer is the hang. No sleeps.
        let gate = r.root().join("gate");
        assert!(std::process::Command::new("mkfifo").arg(&gate).status().unwrap().success());
        r.git(&["config", "filter.slow.smudge", &format!("sh -c 'if [ -p {g} ]; then read _ < {g}; fi; cat'", g = gate.display())]);
        r.write("a.txt", &lines("a", "a1 mine", "a5", "a9"));
        r.write("mine.txt", "mine, edited\n");
        r
    }

    /// The next event, skipping what a busy bus dropped (`Lagged`).
    async fn next_event(rx: &mut tokio::sync::broadcast::Receiver<crate::events::AppEvent>) -> crate::events::AppEvent {
        loop {
            match rx.recv().await {
                Ok(ev) => return ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(e) => panic!("the event bus closed: {e}"),
            }
        }
    }

    /// The checkout's op, once it started.
    async fn checkout_op(rx: &mut tokio::sync::broadcast::Receiver<crate::events::AppEvent>) -> u64 {
        loop {
            if let crate::events::AppEvent::OpStarted { op, kind: crate::events::OpKind::Checkout, .. } = next_event(rx).await {
                return op;
            }
        }
    }

    /// Blocks until a filter is reading the gate: git is in the middle of the switch (`d` was
    /// replaced before the first `*.slow` file). Returns the gate's writer: dropping it releases
    /// that filter (`read` gets EOF and `cat` runs).
    async fn mid_switch(r: &TestRepo) -> std::fs::File {
        let gate = r.root().join("gate");
        tokio::task::spawn_blocking(move || std::fs::OpenOptions::new().write(true).open(gate)).await.unwrap().unwrap()
    }

    /// Review I1: a Cancel while `git switch` rewrites the files leaves the tree as the user left
    /// it: the files git had switched go back to HEAD's (the mode-only `b.sh` too, and `d/b.txt`
    /// under the file `d` that replaced its folder: re-review M3), then the autostash (the change
    /// the target touches) comes back, and the change it doesn't touch was never moved. No entry.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancel_mid_checkout_puts_the_tree_back() {
        let env = WriteEnv::new();
        let r = slow_repo();
        let id = open(&env.api, &r).await;
        let before = RepoState::capture(&r);
        let mut rx = env.api.subscribe();
        let (res, ()) = tokio::time::timeout(std::time::Duration::from_secs(60), async { tokio::join!(send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "feature/x"}))), async {
            let op = checkout_op(&mut rx).await;
            let writer = mid_switch(&r).await;
            assert!(r.path().join("d").is_file(), "git replaced the folder d by the file before the cancel");
            env.api.ops().cancel(op);
            // Every later filter (the put-back's included) runs through; the blocked one is released.
            std::fs::remove_file(r.root().join("gate")).unwrap();
            drop(writer);
        }) })
        .await
        .expect("the cancelled checkout and its put-back end");
        assert_eq!(res.unwrap_err().kind, GbErrorKind::Cancelled);
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(std::fs::read_to_string(r.path().join("d/b.txt")).unwrap(), "in d\n");
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(r.path().join("b.sh")).unwrap().permissions().mode() & 0o111, 0, "b.sh's mode went back");
        }
        assert_eq!(r.git(&["status", "--porcelain", "--", "b.sh", "d"]), "", "no mode or D/F leftovers");
        assert_eq!(RepoState::capture(&r), before, "the tree the user left, their changes included");
        assert!(journal_state(&env, id, &r).await["undo"].is_null(), "nothing changed: no entry");
    }

    /// 2C final I2: create branch + Check out cancelled mid-switch puts the tree back the same
    /// way: HEAD stays on main and the files, the user's changes included, are as they were.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancel_mid_create_and_checkout_puts_the_tree_back() {
        let env = WriteEnv::new();
        let r = slow_repo();
        let id = open(&env.api, &r).await;
        let start = r.git(&["rev-parse", "feature/x"]);
        let before = RepoState::capture(&r);
        let mut rx = env.api.subscribe();
        let create = json!({"method": "createBranch", "params": {"repo": id, "worktree": wt(&r), "name": "topic", "start": start, "checkout": true}});
        let (res, ()) = tokio::time::timeout(std::time::Duration::from_secs(60), async { tokio::join!(send(&env.api, create), async {
            let op = loop {
                if let crate::events::AppEvent::OpStarted { op, kind: crate::events::OpKind::Branch, .. } = next_event(&mut rx).await {
                    break op;
                }
            };
            let writer = mid_switch(&r).await;
            env.api.ops().cancel(op);
            std::fs::remove_file(r.root().join("gate")).unwrap();
            drop(writer);
        }) })
        .await
        .expect("the cancelled create and its put-back end");
        assert_eq!(res.unwrap_err().kind, GbErrorKind::Cancelled);
        assert_eq!(r.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
        let after = RepoState::capture(&r);
        assert_eq!((&after.head, &after.index, &after.files, &after.modes, &after.untracked, &after.stashes), (&before.head, &before.index, &before.files, &before.modes, &before.untracked, &before.stashes), "the tree the user left, their changes included");
    }

    /// Re-review I1: a smudge filter that hangs while the files go back doesn't hold the write:
    /// a Stop ends the repair ("Restoring files…" is announced), the error says so, and the entry
    /// is kept, blocked with the reason.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stop_ends_a_hung_put_back() {
        use crate::events::{AppEvent, StashStep};
        let env = WriteEnv::new();
        let r = slow_repo();
        let id = open(&env.api, &r).await;
        let mut rx = env.api.subscribe();
        let mut steps = env.api.subscribe();
        let (res, ()) = tokio::time::timeout(std::time::Duration::from_secs(60), async { tokio::join!(send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "feature/x"}))), async {
            let op = checkout_op(&mut rx).await;
            let writer = mid_switch(&r).await;
            env.api.ops().cancel(op);
            // The switch's blocked filter is released; the gate stays, so the repair's
            // checkout-index hangs in its first filter (no writer): Stop it once it's announced
            // (`run_stash_step` listens before it announces, so one press is enough).
            drop(writer);
            loop {
                match next_event(&mut rx).await {
                    AppEvent::OpStashStep { op: o, step: Some(StashStep::RestoringFiles), .. } if o == op => break,
                    _ => continue,
                }
            }
            assert!(env.api.ops().cancel(op), "the op is still running");
        }) })
        .await
        .expect("the Stop ends the hung put-back");
        let _ = std::fs::remove_file(r.root().join("gate"));
        let e = res.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Other, "{e:?}");
        assert!(e.message.contains("was stopped"), "{}", e.message);
        let mut announced = false;
        loop {
            match steps.try_recv() {
                Ok(ev) => announced |= matches!(ev, AppEvent::OpStashStep { step: Some(StashStep::RestoringFiles), .. }),
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        assert!(announced, "the repair was announced as a step");
        let s = journal_state(&env, id, &r).await;
        assert!(!s["undo"].is_null(), "the entry is kept: {s}");
        assert!(s["undoBlocked"].as_str().is_some_and(|b| b.contains("was stopped")), "{s}");
    }


    /// Review M7: the switch after a fast-forward or a Reset of a branch not checked out fails
    /// (it can't take the index lock): the ref goes back, and nothing is left changed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_switch_that_fails_after_the_ref_moved_puts_the_ref_back() {
        for diverged in [false, true] {
            let env = WriteEnv::new();
            let r = repo();
            advance_remote(&r, "feature/x");
            if diverged {
                r.git(&["switch", "-q", "feature/x"]);
                r.commit("mine");
                r.git(&["switch", "-q", "main"]);
            }
            let id = open(&env.api, &r).await;
            let target = json!({"kind": "remote", "remote": "origin", "branch": "feature/x"});
            let req = if diverged {
                let out = send(&env.api, checkout(id, &r, target)).await.unwrap();
                reset_resend(id, &r, &out)
            } else {
                checkout(id, &r, target)
            };
            let before = RepoState::capture(&r);
            let lock = r.path().join(".git/index.lock");
            std::fs::write(&lock, "").unwrap();
            let res = send(&env.api, req).await;
            std::fs::remove_file(&lock).unwrap();
            assert!(res.is_err(), "diverged={diverged}");
            assert_eq!(RepoState::capture(&r), before, "diverged={diverged}");
            assert!(journal_state(&env, id, &r).await["undo"].is_null(), "diverged={diverged}");
        }
    }

    /// Review M7: Reset-here's ref update fails after its read-tree (the ref is locked): the
    /// reverse read-tree puts the worktree back.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reset_here_whose_ref_update_fails_reads_the_tree_back() {
        let env = WriteEnv::new();
        let r = repo();
        r.switch("feature/x");
        advance_remote(&r, "feature/x");
        r.commit("mine");
        let id = open(&env.api, &r).await;
        let out = send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!(out["outcome"]["status"], "diverged");
        let before = RepoState::capture(&r);
        let lock = r.path().join(".git/refs/heads/feature/x.lock");
        std::fs::write(&lock, "").unwrap();
        let res = send(&env.api, reset_resend(id, &r, &out)).await;
        std::fs::remove_file(&lock).unwrap();
        assert!(res.is_err());
        assert_eq!(RepoState::capture(&r), before);
        assert!(journal_state(&env, id, &r).await["undo"].is_null());
    }

    /// Review M2: Reset answers the question shown. Without the oids it's refused; after a commit
    /// since the dialog it's RefMoved, and nothing changes.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reset_is_pinned_to_the_diverged_oids_shown() {
        let env = WriteEnv::new();
        let r = repo();
        advance_remote(&r, "feature/x");
        r.git(&["switch", "-q", "feature/x"]);
        r.commit("mine 1");
        r.git(&["switch", "-q", "main"]);
        let id = open(&env.api, &r).await;
        let target = json!({"kind": "remote", "remote": "origin", "branch": "feature/x"});
        let out = send(&env.api, checkout(id, &r, target.clone())).await.unwrap();
        let bare = json!({"method": "checkout", "params": {"repo": id, "worktree": wt(&r), "target": target, "onDiverged": "reset"}});
        assert_eq!(send(&env.api, bare).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        r.git(&["switch", "-q", "feature/x"]);
        r.commit("mine 2, after the dialog");
        r.git(&["switch", "-q", "main"]);
        let before = RepoState::capture(&r);
        assert_eq!(send(&env.api, reset_resend(id, &r, &out)).await.unwrap_err().kind, GbErrorKind::RefMoved);
        assert_eq!(RepoState::capture(&r), before);
    }

    /// Review M3, M4: a detached target is hex only (a ref name or non-ASCII text is refused, never
    /// a panic), and the entry is labelled with the resolved commit.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_detached_target_is_hex_and_labelled_by_the_resolved_commit() {
        assert_eq!(super::short("ééééééééé"), "ééééééé");
        assert_eq!(super::short("abc"), "abc");
        let env = WriteEnv::new();
        let r = repo();
        let id = open(&env.api, &r).await;
        for bad in ["ééééééééé", "main", ""] {
            let e = send(&env.api, checkout(id, &r, json!({"kind": "detached", "oid": bad}))).await.unwrap_err();
            assert_eq!(e.kind, GbErrorKind::InvalidInput, "{bad}");
        }
        let x = oid(&r, "feature/x");
        send(&env.api, checkout(id, &r, json!({"kind": "detached", "oid": x[..12].to_uppercase()}))).await.unwrap();
        assert_eq!(journal_state(&env, id, &r).await["undo"]["label"], format!("checkout {}", &x[..7]));
    }

    /// Review M5: `merge --ff-only` never autostashes on its own (`merge.autoStash`): a change it
    /// doesn't touch isn't rewritten (its mtime stays), and the reflog reads as the FF case's.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_ff_only_merge_never_autostashes_and_logs_the_remote_name() {
        let env = WriteEnv::new();
        let r = repo();
        r.switch("feature/x");
        advance_remote(&r, "feature/x");
        r.git(&["config", "merge.autoStash", "true"]);
        r.write("a.txt", &lines("a", "a1 mine", "a5", "a9 x"));
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        std::fs::File::options().write(true).open(r.path().join("a.txt")).unwrap().set_modified(old).unwrap();
        let id = open(&env.api, &r).await;
        send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "feature/x"}))).await.unwrap();
        assert_eq!(oid(&r, "HEAD"), oid(&r, "origin/feature/x"));
        assert_eq!(std::fs::metadata(r.path().join("a.txt")).unwrap().modified().unwrap(), old, "a.txt was never stashed and rewritten");
        assert_eq!(r.git(&["reflog", "-1", "--format=%gs", "refs/heads/feature/x"]), "merge origin/feature/x: Fast-forward");
    }

    // --- 2C repo-safety (2C T6 re-review 3's checkout follow-up) ---

    /// A repository to clone from, with one commit.
    fn upstream() -> TestRepo {
        let s = TestRepo::new();
        identity(&s);
        s.write("s.txt", "s\n");
        s.git(&["add", "."]);
        s.git(&["commit", "-q", "-m", "s"]);
        s
    }

    /// `git clone` of `from` at `at`, with a local-only branch (what the user would lose).
    fn embed(r: &TestRepo, from: &TestRepo, at: &str) {
        r.git(&["clone", "-q", &from.path().display().to_string(), at]);
        let sm = r.path().join(at);
        for args in [&["config", "user.name", "Ada Lovelace"][..], &["config", "user.email", "ada@example.com"], &["switch", "-q", "-c", "feat"]] {
            r.git_in(&sm, args);
        }
        std::fs::write(sm.join("local.txt"), "local\n").unwrap();
        r.git_in(&sm, &["add", "local.txt"]);
        r.git_in(&sm, &["commit", "-q", "-m", "local-only"]);
        r.git_in(&sm, &["switch", "-q", "main"]);
    }

    /// C1: on `b`, whose gitlink `sm` is a clean populated clone, switching to `a` (the file
    /// `sm`) would delete the clone whole, with no autostash to see it: refused, nothing changed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_switch_never_deletes_a_clean_submodule_where_the_target_has_a_file() {
        let sub = upstream();
        let r = TestRepo::new();
        identity(&r);
        r.write("x", "x\n");
        r.git(&["add", "x"]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.switch_new("a");
        r.write("sm", "file\n");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "file"]);
        r.git(&["switch", "-q", "-c", "b", "main"]);
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        r.git(&["commit", "-q", "-m", "gitlink"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "a"}))).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "sm is a repository in the way of the checkout: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
        assert_eq!(r.git_in(&r.path().join("sm"), &["rev-parse", "--verify", "feat"]).len(), 40, "the local-only branch is still there");
    }

    /// C2: `merge --ff-only` to origin/main, which turned the gitlink `lib/sm` into the file
    /// `lib`, over the populated clone: refused the same way.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_ff_only_merge_never_deletes_a_submodule_under_a_replaced_directory() {
        let sub = upstream();
        let r = TestRepo::new();
        identity(&r);
        r.write("x", "x\n");
        embed(&r, &sub, "lib/sm");
        r.git(&["add", "x", "lib/sm"]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.add_origin();
        r.push("main");
        // Upstream replaces lib/sm by the file lib (made here on a side branch, pushed as main).
        r.switch_new("up");
        r.git(&["rm", "-q", "--cached", "lib/sm"]);
        let aside = r.root().join("sm-aside");
        std::fs::rename(r.path().join("lib/sm"), &aside).unwrap();
        std::fs::remove_dir(r.path().join("lib")).unwrap();
        r.write("lib", "f\n");
        r.git(&["add", "lib"]);
        r.git(&["commit", "-q", "-m", "file"]);
        r.git(&["push", "-q", "origin", "up:main"]);
        r.git(&["fetch", "-q", "origin"]);
        r.git(&["switch", "-q", "main"]);
        let _ = std::fs::remove_dir(r.path().join("lib/sm")); // the gitlink's empty directory
        std::fs::rename(&aside, r.path().join("lib/sm")).unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, checkout(id, &r, json!({"kind": "remote", "remote": "origin", "branch": "main"}))).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "lib/sm is a repository in the way of the checkout: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("lib/sm/.git").is_dir());
    }

    // --- 2C repo-safety, round 5 (the safety review) ---

    /// C1 (S6b): the checkout's whole-worktree autostash (an edit overlapping the target, no
    /// conflict, so no question) would `stash push -u`, whose `reset --hard` writes HEAD's file
    /// `sm` over the clone staged there: refused before anything runs.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_checkouts_autostash_never_deletes_a_staged_clone() {
        let sub = upstream();
        let r = TestRepo::new();
        identity(&r);
        r.write("a.txt", &lines("a", "a1", "a5", "a9"));
        r.write("sm", "f\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("other");
        r.write("a.txt", &lines("a", "a1", "a5", "a9 other"));
        r.git(&["commit", "-q", "-am", "other"]);
        r.switch("main");
        r.git(&["rm", "-q", "--cached", "sm"]);
        std::fs::remove_file(r.path().join("sm")).unwrap();
        embed(&r, &sub, "sm");
        r.git(&["add", "sm"]);
        r.write("a.txt", &lines("a", "a1 mine", "a5", "a9"));
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "other"}))).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "sm is a repository in the way of the stash: move it first"));
        assert_eq!(RepoState::capture(&r), shown);
        assert!(r.path().join("sm/.git").is_dir());
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    /// main: the folder `vendor/` (with `vendor/x`); `a`: the file `vendor`.
    fn folder_to_file_repo() -> TestRepo {
        let r = TestRepo::new();
        identity(&r);
        r.write("vendor", "v\n");
        r.write("x", "x\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.git(&["branch", "a"]);
        r.git(&["rm", "-q", "vendor"]);
        r.write("vendor/x", "vx\n");
        r.git(&["add", "vendor"]);
        r.git(&["commit", "-q", "-m", "two"]);
        r
    }

    /// M1 (S1c): git drops a clean staged-new file under a folder the target replaces by a file,
    /// with no refusal (its path isn't in the tree diff). It counts as touched: the clean-restore
    /// warning asks (it can't come back under the file), then the autostash takes it, and it
    /// survives in the kept stash.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_checkout_carries_a_staged_new_file_under_a_folder_the_target_replaces() {
        let r = folder_to_file_repo();
        r.write("vendor/new.txt", "staged\n");
        r.git(&["add", "vendor/new.txt"]);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let shown = RepoState::capture(&r);
        let e = send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "a"}))).await.unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"]["paths"], json!(["vendor/new.txt"]), "{e:?}");
        assert_eq!(RepoState::capture(&r), shown, "asking changes nothing");
        send(&env.api, json!({"method": "checkout", "params": {"repo": id, "worktree": wt(&r), "target": {"kind": "branch", "name": "a"}, "confirmAutostash": true}})).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("vendor")).unwrap(), "v\n");
        assert_eq!(r.git(&["stash", "list"]).lines().count(), 1, "kept: git can't put the file back under the file vendor");
        assert_eq!(r.git(&["show", "stash@{0}^2:vendor/new.txt"]), "staged");
    }

    /// M2 (S5): `git switch` deletes the ignored files under a folder the target replaces by a
    /// file. They go in the autostash (`--all`, naming its paths), where they survive.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_checkout_stashes_the_ignored_files_under_a_folder_the_target_replaces() {
        let r = folder_to_file_repo();
        std::fs::write(r.path().join(".git/info/exclude"), "vendor/build/\n").unwrap();
        r.write("vendor/build/out", "precious build cache\n");
        assert_eq!(r.git(&["status", "--porcelain"]), "", "clean: nothing else to stash");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        send(&env.api, checkout(id, &r, json!({"kind": "branch", "name": "a"}))).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("vendor")).unwrap(), "v\n");
        let s = journal_state(&env, id, &r).await;
        assert_eq!(r.git(&["stash", "list"]).lines().count(), 1, "{s}");
        assert_eq!(r.git(&["show", "stash@{0}^3:vendor/build/out"]), "precious build cache");
    }
}
