//! Read-only pre-checks (spec #2 §3.4, §6).
//!
//! Which paths an operation touches, which are dirty, and whether restoring an autostash would
//! conflict. They never write to the repository: gix reads, `git status` with the never-write
//! environment, and `git merge-file -p` on temp copies (Deviation 3).

use crate::error::{gix_err, GbError};
use crate::git::{GitCli, GitInvocation};
use crate::platform::osstr;
use crate::status::{parse_porcelain_v2, status_raw, EntryKind};
use gix::bstr::{BStr, BString, ByteSlice};
use gix::ObjectId;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The file paths that differ between two trees, each given as a commit or a tree (rename
/// detection off).
pub(crate) fn tree_diff_paths(repo: &gix::Repository, from: ObjectId, to: ObjectId) -> Result<BTreeSet<String>, GbError> {
    Ok(tree_diff(repo, from, to)?.paths)
}

// --- 2C repo-safety ---
/// A tree diff `from..to`: the paths, and what the two trees hold at them, from the diff's own
/// records (no lookups), as bytes (a non-UTF-8 name must reach the disk check as it is).
pub(crate) struct TreeDiff {
    /// The file paths that differ (trees left out, rename detection off), for display and
    /// pathspecs.
    pub paths: BTreeSet<String>,
    /// The paths `to` holds as a blob or a symlink: the writes that land on whatever is there.
    pub to_files: BTreeSet<BString>,
    /// The paths `from` holds as a gitlink (so no longer in `to`, or not one there).
    pub from_gitlinks: BTreeSet<BString>,
}

/// `from` and `to` are each a commit or a tree (2D T14: a merge's predicted tree).
pub(crate) fn tree_diff(repo: &gix::Repository, from: ObjectId, to: ObjectId) -> Result<TreeDiff, GbError> {
    let tree = |c: ObjectId| -> Result<gix::Tree<'_>, GbError> { repo.find_object(c).map_err(gix_err)?.peel_to_tree().map_err(gix_err) };
    let (a, b) = (tree(from)?, tree(to)?);
    let mut state = gix::diff::tree::State::default();
    let mut recorder = gix::diff::tree::Recorder::default();
    gix::diff::tree(gix::objs::TreeRefIter::from_bytes(&a.data, from.kind()), gix::objs::TreeRefIter::from_bytes(&b.data, to.kind()), &mut state, &repo.objects, &mut recorder).map_err(gix_err)?;
    let mut diff = TreeDiff { paths: BTreeSet::new(), to_files: BTreeSet::new(), from_gitlinks: BTreeSet::new() };
    for c in &recorder.records {
        use gix::diff::tree::recorder::Change as C;
        let (path, mode, now, was) = match c {
            C::Addition { path, entry_mode, .. } => (path, entry_mode, Some(entry_mode), None),
            C::Deletion { path, entry_mode, .. } => (path, entry_mode, None, Some(entry_mode)),
            C::Modification { path, entry_mode, previous_entry_mode, .. } => (path, entry_mode, Some(entry_mode), Some(previous_entry_mode)),
        };
        if mode.is_tree() {
            continue;
        }
        if now.is_some_and(|m| m.is_blob_or_symlink()) {
            diff.to_files.insert(path.clone());
        }
        if was.is_some_and(|m| m.is_commit()) {
            diff.from_gitlinks.insert(path.clone());
        }
        diff.paths.insert(path.to_str_lossy().into_owned());
    }
    Ok(diff)
}
// --- end 2C repo-safety ---

#[derive(Debug, Default)]
pub(crate) struct Dirty {
    /// Index or worktree changes (a rename's both paths).
    pub tracked: BTreeSet<String>,
    pub untracked: BTreeSet<String>,
    pub conflicted: u32,
    /// The unmerged paths (`conflicted` of them).
    pub unmerged: Vec<String>,
}

pub(crate) async fn dirty(cli: &GitCli, root: &Path) -> Result<Dirty, GbError> {
    let raw = status_raw(cli, root).await?;
    let mut d = Dirty::default();
    for e in parse_porcelain_v2(&raw) {
        match e.kind {
            EntryKind::Untracked => {
                d.untracked.insert(e.path);
            }
            EntryKind::Ignored => {}
            kind => {
                if kind == EntryKind::Unmerged {
                    d.conflicted += 1;
                    d.unmerged.push(e.path.clone());
                }
                d.tracked.extend(e.orig_path);
                d.tracked.insert(e.path);
            }
        }
    }
    Ok(d)
}

fn blob(repo: &gix::Repository, tree: Option<&gix::Tree<'_>>, path: &str) -> Option<Vec<u8>> {
    let entry = tree?.lookup_entry_by_path(path).ok()??;
    if entry.mode().is_tree() {
        return None;
    }
    Some(repo.find_object(entry.object_id()).ok()?.data.clone())
}

/// The paths of `paths` whose autostash restore onto `target` would conflict (§6.2): a three-way
/// merge of HEAD's version (base), the target's (ours) and the current bytes (theirs).
pub(crate) async fn predict_conflicts(cli: &GitCli, root: &Path, tmp: &Path, target: ObjectId, paths: &[String]) -> Result<Vec<String>, GbError> {
    type Sides = (String, Option<Vec<u8>>, Option<Vec<u8>>);
    // --- 2C T5: the staged side (review I2) ---
    let (sides, staged): (Vec<Sides>, Vec<String>) = {
        let repo = gix::open(root).map_err(gix_err)?;
        let head = repo.head_commit().ok().and_then(|c| c.tree().ok());
        let theirs_tree = repo.find_object(target).map_err(gix_err)?.peel_to_tree().map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let head_id = |p: &str| head.as_ref().and_then(|t| t.lookup_entry_by_path(p).ok().flatten()).filter(|e| !e.mode().is_tree()).map(|e| e.object_id());
        let staged = paths.iter().filter(|p| index.entry_by_path(p.as_str().into()).map(|e| e.id) != head_id(p)).cloned().collect();
        (paths.iter().map(|p| (p.clone(), blob(&repo, head.as_ref(), p), blob(&repo, Some(&theirs_tree), p))).collect(), staged)
    };
    // --- end 2C T5 ---
    let dir = tempfile::Builder::new().prefix("predict-").tempdir_in(tmp)?;
    let mut out = Vec::new();
    for (path, base, ours) in sides {
        let theirs = std::fs::read(root.join(&path)).ok();
        let conflict = match (&base, &ours, &theirs) {
            // The target already has these bytes.
            (_, o, t) if o == t => false,
            (Some(b), Some(o), Some(t)) => {
                let (bp, op, tp) = (dir.path().join("base"), dir.path().join("ours"), dir.path().join("theirs"));
                std::fs::write(&bp, b)?;
                std::fs::write(&op, o)?;
                std::fs::write(&tp, t)?;
                let args = ["merge-file", "-p", "-q"].into_iter().map(OsString::from).chain([op, bp, tp].map(|p| p.into_os_string()));
                // A non-zero exit is the number of conflicts (or an error: counted as one).
                cli.run(GitInvocation::new(dir.path(), args)).await.is_err()
            }
            // Added, deleted or untracked on one side only: git would refuse or conflict.
            _ => true,
        };
        if conflict {
            out.push(path);
        }
    }
    // --- 2C T5: the staged side (review I2) ---
    let pending: Vec<String> = staged.into_iter().filter(|p| !out.contains(p)).collect();
    let refused = index_refused(cli, root, dir.path(), target, &pending).await?;
    if !refused.is_empty() {
        out.extend(refused);
        out.sort_by_key(|p| paths.iter().position(|q| q == p));
    }
    // --- end 2C T5 ---
    Ok(out)
}

// --- 2C T5: the staged side (review I2) ---
/// The staged paths whose index part `git stash apply --index` would refuse on `target`. git
/// re-applies the stash's HEAD→index diff with `apply --cached`, which needs exact context (no
/// three-way fallback): a staged edit near a line the target changes is refused even where the
/// worktree merge is clean. Checked the same way, `apply --cached --check`, on a temporary index
/// holding `target`'s tree (`GIT_INDEX_FILE` in `dir`): the repository's index isn't touched.
async fn index_refused(cli: &GitCli, root: &Path, dir: &Path, target: ObjectId, staged: &[String]) -> Result<Vec<String>, GbError> {
    if staged.is_empty() {
        return Ok(Vec::new());
    }
    let index = dir.join("target-index");
    let target_hex = target.to_string();
    cli.run(GitInvocation::new(root, ["read-tree", target_hex.as_str()]).env("GIT_INDEX_FILE", &index)).await?;
    // All of them in one check first; only a refusal is narrowed down path by path (re-review N2).
    if apply_check(cli, root, &index, staged).await? {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for path in staged {
        if !apply_check(cli, root, &index, std::slice::from_ref(path)).await? {
            out.push(path.clone());
        }
    }
    Ok(out)
}

/// Whether `paths`' HEAD→index patch applies to the index at `index`. The patch is the one
/// stash builds (re-review M2): plumbing `diff-index`, which reads none of the porcelain `diff.*`
/// config, with the context, algorithm, prefixes and submodule format pinned besides.
async fn apply_check(cli: &GitCli, root: &Path, index: &Path, paths: &[String]) -> Result<bool, GbError> {
    let args = ["diff-index", "--cached", "-p", "--binary", "-U3", "--inter-hunk-context=0", "--diff-algorithm=myers", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--"].into_iter().map(String::from).chain(paths.iter().cloned());
    let patch = cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?.stdout;
    if patch.is_empty() {
        return Ok(true);
    }
    let check = GitInvocation::new(root, ["apply", "--cached", "--check"]).env("GIT_INDEX_FILE", index).stdin(patch);
    Ok(cli.run(check).await.is_ok())
}
// --- end 2C T5 ---

/// The ignored (untracked, excluded) ones among `paths`: a restore overwrites them too, and
/// `stash -u` leaves them out (review n5).
pub(crate) async fn ignored_among(cli: &GitCli, root: &Path, paths: &[String]) -> Result<Vec<String>, GbError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let args = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--"].into_iter().map(String::from).chain(paths.iter().cloned());
    let out = cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
    Ok(out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
}

// --- 2C T7: untracked among (moved from the test intents) ---
/// The untracked (not ignored) ones among `paths`: a read, with the never-write environment.
pub(crate) async fn untracked_among(cli: &GitCli, root: &Path, paths: &[String]) -> Result<Vec<String>, GbError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let args = ["ls-files", "-z", "--others", "--exclude-standard", "--"].into_iter().map(String::from).chain(paths.iter().cloned());
    let out = cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
    Ok(out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
}
// --- end 2C T7 ---

/// A worktree file as git would store it: its blob id through the clean filters, and its kind.
type Stored = (ObjectId, gix::objs::tree::EntryKind);

/// The paths of `snap` whose index entry or worktree file isn't what `snap` holds: what changed
/// since the operation left them. File content goes through git's clean filters and eol rules
/// (`git hash-object --stdin-paths`, which writes nothing), and the kind (executable, symlink)
/// counts. A snapshot git dropped counts as all of them.
pub(crate) async fn changed_since(cli: &GitCli, root: &Path, snap: &crate::journal::Snapshot) -> Result<Vec<String>, GbError> {
    use gix::objs::tree::EntryKind;
    struct Want {
        index: Option<Stored>,
        file: Option<Stored>,
        have_index: Option<Stored>,
    }
    let (wants, file_mode, hash_kind) = {
        let repo = gix::open(root).map_err(gix_err)?;
        let tree_of = |c: Option<ObjectId>| c.and_then(|c| repo.find_commit(c).ok()?.tree().ok());
        let Some(w) = ObjectId::from_hex(snap.commit.as_bytes()).ok().and_then(|c| repo.find_commit(c).ok()) else { return Ok(snap.paths.clone()) };
        let parents: Vec<ObjectId> = w.parent_ids().map(|p| p.detach()).collect();
        let (w_tree, i_tree, u_tree) = (w.tree().ok(), tree_of(parents.get(1).copied()), tree_of(parents.get(2).copied()));
        let index = repo.index_or_empty().map_err(gix_err)?;
        let entry = |tree: Option<&gix::Tree<'_>>, path: &str| tree.and_then(|t| t.lookup_entry_by_path(path).ok().flatten()).map(|e| (e.object_id(), e.mode().kind()));
        let wants: Vec<Want> = snap
            .paths
            .iter()
            .map(|p| {
                let untracked = snap.untracked.contains(p);
                Want {
                    index: if untracked { None } else { entry(i_tree.as_ref(), p) },
                    file: entry(if untracked { u_tree.as_ref() } else { w_tree.as_ref() }, p),
                    have_index: index.entry_by_path(p.as_str().into()).and_then(|e| Some((e.id, e.mode.to_tree_entry_mode()?.kind()))),
                }
            })
            .collect();
        (wants, repo.config_snapshot().boolean("core.fileMode").unwrap_or(true), repo.object_hash())
    };
    // The worktree side: symlinks hashed here, regular files by git (one process for all).
    let mut have_file: Vec<Option<Stored>> = Vec::with_capacity(snap.paths.len());
    let mut regular: Vec<(usize, EntryKind)> = Vec::new();
    for (i, p) in snap.paths.iter().enumerate() {
        let full = root.join(p);
        have_file.push(None);
        match full.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => {
                let target = std::fs::read_link(&full)?.into_os_string().into_encoded_bytes();
                have_file[i] = gix::objs::compute_hash(hash_kind, gix::objs::Kind::Blob, &target).ok().map(|id| (id, EntryKind::Link));
            }
            Ok(m) if m.is_file() => {
                regular.push((i, if crate::platform::fs::mode(&m) & 0o111 != 0 { EntryKind::BlobExecutable } else { EntryKind::Blob }));
            }
            _ => {}
        }
    }
    // Newline-separated: a path holding a newline makes the count mismatch, and then every
    // path counts as changed (the safe answer).
    if !regular.is_empty() {
        let list: String = regular.iter().map(|(i, _)| format!("{}\n", snap.paths[*i])).collect();
        let out = cli.run(GitInvocation::new(root, ["hash-object", "--stdin-paths"]).stdin(list.into_bytes())).await?;
        let ids: Vec<ObjectId> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| ObjectId::from_hex(l.trim().as_bytes()).ok()).collect();
        if ids.len() != regular.len() {
            return Ok(snap.paths.clone());
        }
        for ((i, kind), id) in regular.into_iter().zip(ids) {
            have_file[i] = Some((id, kind));
        }
    }
    // Without core.fileMode, the executable bit isn't tracked.
    let norm = |s: Option<Stored>| s.map(|(id, k)| (id, if !file_mode && k == EntryKind::BlobExecutable { EntryKind::Blob } else { k }));
    Ok(snap
        .paths
        .iter()
        .zip(wants)
        .zip(have_file)
        // --- 2B T4: a gitlink is index-only (its worktree is another repository's) ---
        .filter(|((_, w), have)| w.index != w.have_index || (!matches!(w.file, Some((_, EntryKind::Commit))) && norm(w.file) != norm(*have)))
        // --- end 2B T4 ---
        .map(|((p, _), _)| p.clone())
        .collect())
}

// --- 2C T1: ancestry counts and worktree display paths ---
/// Commits in `a` not in `b`, and in `b` not in `a` (Deviation 11: one `rev-list` read).
#[allow(dead_code)] // first reader: 2C T5 (diverged)
pub(crate) async fn ahead_behind(cli: &GitCli, root: &Path, a: &str, b: &str) -> Result<(u32, u32), GbError> {
    let range = format!("{a}...{b}");
    let out = cli.run(GitInvocation::new(root, ["rev-list", "--left-right", "--count", range.as_str(), "--"])).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
    Ok((it.next().unwrap_or(0), it.next().unwrap_or(0)))
}

/// Commits of `branch` that aren't in `into` (git's `branch -d` "not fully merged").
#[allow(dead_code)] // first reader: 2C T4 (unmerged)
pub(crate) async fn commits_not_in(cli: &GitCli, root: &Path, branch: &str, into: &str) -> Result<u32, GbError> {
    let range = format!("{into}..{branch}");
    let out = cli.run(GitInvocation::new(root, ["rev-list", "--count", range.as_str(), "--"])).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0))
}

/// How the UI names a worktree (spec #2 §9.3, §11.1): `../shop-feature-x` beside the main
/// worktree, else its absolute path.
#[allow(dead_code)] // first readers: 2C T5, T8
pub(crate) fn display_worktree(main_root: &Path, wt: &Path) -> String {
    match (main_root.parent(), wt.parent(), wt.file_name()) {
        (Some(a), Some(b), Some(name)) if a == b && main_root != wt => format!("../{}", name.to_string_lossy()),
        _ => wt.display().to_string(),
    }
}
// --- end 2C T1 ---

// --- 2C T6: repositories in the way ---
// (2C repo-safety: one check for every move of the working tree.)
//
// Git writes a file of the target where the disk has a directory by removing the directory
// whole, `.git` included (`remove_subtree` in `checkout_entry`; `checkout-index -f` too), and a
// two-way merge takes a gitlink as always up to date: no question, and nothing a snapshot can
// carry (2C T6 review C2, C3, C4, C5). A repository is in the way where the target holds a file
// (a blob or a symlink; a gitlink only makes its directory, and a tree just descends into one) at
// a path the disk has as a directory (no symlink followed on the way: git writes through none),
// and that directory
// - holds a `.git` entry at any depth, [`dot_git_within`]: a directory, a gitdir-link file or a
//   symlink, valid or not (a broken gitfile, a damaged `.git` folder: git itself wouldn't list
//   them, and would delete them; 2B T4 re-review N1);
// - or holds a populated gitlink of the index or of `from`'s tree, at it or under it (an
//   unpopulated one is an empty directory git just removes).
//
// A symlink at the path isn't a directory (2B T4 re-review N3): git replaces the link, and
// whatever it points at stays. [`others_under`] then lists what else such a directory holds
// (the untracked files git deletes with it), a git read per such directory; nothing is paid
// when no file of the target lands on a directory.
//
// Which paths to look at is the caller's: the tree diff for a two-way move (`git switch`,
// `merge --ff-only`, `read-tree -m -u`), the tree diff ∪ the dirty tracked paths for `reset
// --hard` (it works from the index: a staged gitlink where HEAD and the target agree, C4), a
// snapshot's own paths for a restore (C5), and a discard's restored paths ([`repo_at`], 2B T4).

/// The gitlinks of the index, as byte paths.
pub(crate) fn index_gitlinks(index: &gix::index::File) -> BTreeSet<BString> {
    index.entries().iter().filter(|e| e.mode == gix::index::entry::Mode::COMMIT).map(|e| e.path(index).to_owned()).collect()
}

/// The gitlinks a two-way check looks for: the index's, and `from`'s among the diff.
pub(crate) fn gitlinks(index: &gix::index::File, diff: &TreeDiff) -> BTreeSet<BString> {
    let mut out = diff.from_gitlinks.clone();
    out.extend(index_gitlinks(index));
    out
}

/// `root/rel`, the bytes as they are (unix paths aren't UTF-8; see [`crate::platform::osstr`]).
pub(crate) fn full_path(root: &Path, rel: &[u8]) -> PathBuf {
    root.join(osstr::from_bytes(rel))
}

/// Whether `rel` is a directory on disk, with no symlink on the way (a leading symlink, or one
/// at the path, isn't one: git unlinks a symlink, it never writes through it). One lstat on the
/// common path (a file, or nothing, at `rel`); the components are walked only for a directory.
pub(crate) fn dir_on_disk(root: &Path, rel: &[u8]) -> bool {
    if !full_path(root, rel).symlink_metadata().is_ok_and(|m| m.is_dir()) {
        return false;
    }
    let mut at = root.to_path_buf();
    let parts: Vec<&[u8]> = rel.split(|b| *b == b'/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        at.push(osstr::from_bytes(part));
        if at.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
    }
    true
}

/// The directory at or under `rel` (a real directory, see [`dir_on_disk`]) that holds a `.git`
/// entry of any kind, valid or not; the shallowest first. The walk follows no symlink and
/// doesn't enter a directory once its `.git` is found.
pub(crate) fn dot_git_within(root: &Path, rel: &[u8]) -> Option<BString> {
    let mut pending: Vec<BString> = vec![rel.into()];
    while let Some(dir) = pending.pop() {
        let full = full_path(root, &dir);
        if full.join(".git").symlink_metadata().is_ok() {
            return Some(dir);
        }
        let Ok(entries) = std::fs::read_dir(&full) else { continue };
        let mut subdirs: Vec<BString> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| {
                let mut p = dir.clone();
                p.push(b'/');
                p.extend_from_slice(e.file_name().as_encoded_bytes());
                p
            })
            .collect();
        subdirs.sort_by(|a, b| b.cmp(a));
        pending.extend(subdirs);
    }
    None
}

/// A repository stands at `path`, or inside it: the one-path form of [`repos_at`] for a discard
/// (2B T4), whose writes are the worktree against the index, not a tree diff. Writing a file
/// there would delete it, its history and its uncommitted work, which no snapshot carries.
pub(crate) fn repo_at(root: &Path, path: &str) -> bool {
    dir_on_disk(root, path.as_bytes()) && dot_git_within(root, path.as_bytes()).is_some()
}

/// What [`repos_at`] found.
#[derive(Debug, Default)]
pub(crate) struct InTheWay {
    /// Repositories found without a git read, sorted (for messages: lossy).
    pub repos: BTreeSet<String>,
    /// The directories in the way of a file of the target, for [`others_under`] (the untracked
    /// files git would delete with them) and for the index entries under them.
    pub dirs: Vec<BString>,
}

impl InTheWay {
    /// The index entries at or under `dirs` (what a move removes with the directory: a staged-new
    /// file, review M1; what a restore leaves broken, I2), lossy for a pathspec.
    pub(crate) fn indexed_under(&self, index: &gix::index::File) -> Vec<String> {
        if self.dirs.is_empty() {
            return Vec::new();
        }
        let under: Vec<BString> = self.dirs.iter().map(|d| {
            let mut u = d.clone();
            u.push(b'/');
            u
        }).collect();
        index.entries().iter().map(|e| e.path(index)).filter(|p| under.iter().any(|u| p.starts_with(u))).map(|p| p.to_str_lossy().into_owned()).collect()
    }
}

/// The repositories in the way of the target's files at `files` (paths the target holds as a
/// blob or a symlink), and the directories to scan. The gitlinks are [`gitlinks`]'s. Cheap: one
/// lstat per path; a directory in the way is walked ([`dot_git_within`]), which git does too
/// to remove it.
pub(crate) fn repos_at<'a>(root: &Path, gitlinks: &BTreeSet<BString>, files: impl IntoIterator<Item = &'a BStr>) -> InTheWay {
    let mut out = InTheWay::default();
    for p in files {
        if !dir_on_disk(root, p) {
            continue;
        }
        if let Some(r) = dot_git_within(root, p) {
            out.repos.insert(r.to_str_lossy().into_owned());
            continue;
        }
        let mut under: BString = p.to_owned();
        under.push(b'/');
        let mut hit = false;
        for g in gitlinks.iter().filter(|g| g.as_bstr() == p || g.starts_with(&under)) {
            // A populated gitlink without a `.git` (the walk found none): a non-empty directory.
            if dir_on_disk(root, g) && std::fs::read_dir(full_path(root, g)).is_ok_and(|mut d| d.next().is_some()) {
                out.repos.insert(g.to_str_lossy().into_owned());
                hit = true;
            }
        }
        if !hit {
            out.dirs.push(p.to_owned());
        }
    }
    out
}

/// Everything outside the index under `dirs` (`ls-files --others`, ignored files included, a
/// read): the nested repositories git recognises (listed as `d/r/`, never entered; the walk in
/// [`repos_at`] finds these and more, so they're a second opinion), and the files.
pub(crate) async fn others_under(cli: &GitCli, root: &Path, dirs: &[BString]) -> Result<(Vec<String>, Vec<String>), GbError> {
    let (mut repos, mut files) = (Vec::new(), Vec::new());
    if dirs.is_empty() {
        return Ok((repos, files));
    }
    // `ls-files` takes no `--pathspec-from-file`: the directories (few: each is one git would
    // delete) go on argv, as the bytes they are.
    let args = ["ls-files", "-z", "--others", "--"].map(OsString::from).into_iter().chain(dirs.iter().map(|d| osstr::from_bytes(d).into_owned()));
    let out = cli.run(GitInvocation::new(root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
    for f in out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let f = String::from_utf8_lossy(f).into_owned();
        match f.strip_suffix('/') {
            Some(r) => repos.push(r.to_string()),
            None => files.push(f),
        }
    }
    Ok((repos, files))
}

/// The gix part of a two-way move's check, for a caller that has the index and the diff.
pub(crate) fn scan_move(root: &Path, index: &gix::index::File, diff: &TreeDiff) -> InTheWay {
    repos_at(root, &gitlinks(index, diff), diff.to_files.iter().map(|p| p.as_bstr()))
}

/// [`InTheWay`] plus the git read: every repository, sorted.
pub(crate) async fn finish(cli: &GitCli, root: &Path, scan: InTheWay) -> Result<Vec<String>, GbError> {
    let mut found = scan.repos;
    found.extend(others_under(cli, root, &scan.dirs).await?.0);
    Ok(found.into_iter().collect())
}

/// What a two-way move of this worktree takes with a directory it replaces by a file, from one
/// scan of the tree diff ([`check_move`]).
#[derive(Debug, Default)]
pub(crate) struct MoveCheck {
    /// The repositories it would delete whole (see above), sorted: refused.
    pub repos: Vec<String>,
    /// The index entries under such a directory (a clean staged-new file): git removes them
    /// with it, with no refusal (safety review M1). Touched, for the autostash.
    pub swept: Vec<String>,
    /// The ignored files under such a directory: git deletes them without asking (M2). Only an
    /// `--all` stash carries them.
    pub ignored: Vec<String>,
}

impl MoveCheck {
    /// The autostash rule for the move: `base` (Overlap, Merged, Rebased), wrapped with what the
    /// move sweeps when it sweeps anything.
    pub(crate) fn rule_over(self, base: crate::journal::autostash::AutostashRule) -> crate::journal::autostash::AutostashRule {
        use crate::journal::autostash::{AutostashRule, Swept};
        if self.swept.is_empty() && self.ignored.is_empty() { base } else { AutostashRule::With(Box::new(base), Swept { swept: self.swept, ignored: self.ignored }) }
    }

    /// [`Self::rule_over`] Overlap: a checkout, a fast-forward, a Switch or Rewind undo.
    pub(crate) fn rule(self) -> crate::journal::autostash::AutostashRule {
        self.rule_over(crate::journal::autostash::AutostashRule::Overlap)
    }
}

/// One check for a two-way move from `from`'s tree to `to`'s: the gix scan, then the git read
/// over the directories in the way only ([`others_under`], then `ignored_among` of its files).
pub(crate) async fn check_move(cli: &GitCli, root: &Path, from: ObjectId, to: ObjectId) -> Result<MoveCheck, GbError> {
    check_landing(cli, root, from, to, false).await
}

/// The check for a merge of `theirs` into `ours` (safety review 2 N2): the files that land are
/// the ones `theirs` changed since the merge base (a fast-forward is the two-way move itself),
/// so the diff is `merge_base(ours, theirs)..theirs`. The merge's two-way checkout writes them
/// over whatever stands at them. Without a merge base, `ours..theirs`.
pub(crate) async fn check_merge(cli: &GitCli, root: &Path, ours: ObjectId, theirs: ObjectId) -> Result<MoveCheck, GbError> {
    check_landing(cli, root, ours, theirs, true).await
}

async fn check_landing(cli: &GitCli, root: &Path, from: ObjectId, to: ObjectId, from_merge_base: bool) -> Result<MoveCheck, GbError> {
    // Off the async stack (the gix objects are large; a deep write future overflowed a test
    // thread's), as the reset's scan.
    let root_buf = root.to_path_buf();
    let (scan, swept) = crate::api::blocking(move || {
        let repo = gix::open(&root_buf).map_err(gix_err)?;
        let from = if from_merge_base { repo.merge_base(from, to).map(|id| id.detach()).unwrap_or(from) } else { from };
        let diff = tree_diff(&repo, from, to)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let scan = scan_move(&root_buf, &index, &diff);
        let swept = scan.indexed_under(&index);
        Ok((scan, swept))
    })
    .await?;
    let (nested, files) = others_under(cli, root, &scan.dirs).await?;
    let ignored = ignored_among(cli, root, &files).await?;
    let mut repos = scan.repos;
    repos.extend(nested);
    Ok(MoveCheck { repos: repos.into_iter().collect(), swept, ignored })
}

/// The paths of `tree` among `paths` that it holds as a blob or a symlink (for a path set that
/// isn't a diff: a reset's dirty paths, a snapshot's).
pub(crate) fn files_in<'a>(tree: &gix::Tree<'_>, paths: impl IntoIterator<Item = &'a String>) -> Result<Vec<BString>, GbError> {
    let mut out = Vec::new();
    for p in paths {
        if tree.lookup_entry_by_path(p.as_str()).map_err(gix_err)?.is_some_and(|e| e.mode().is_blob_or_symlink()) {
            out.push(p.as_str().into());
        }
    }
    Ok(out)
}

/// C1 of the safety review: `git stash push --include-untracked` ends in a `reset --hard`
/// that writes HEAD's file over a directory standing at a dirty tracked path, deleting a
/// repository in it whole (a clone in place of the file, a staged clone at it, a `git init`
/// in it). The check is HEAD's files among `tracked` (the dirty tracked paths), restricted to
/// `pathspec` when the stash takes one. Sorted; empty when nothing is in the way.
pub(crate) async fn stash_push_in_the_way(cli: &GitCli, root: &Path, tracked: &BTreeSet<String>, pathspec: Option<&[String]>) -> Result<Vec<String>, GbError> {
    if tracked.is_empty() {
        return Ok(Vec::new());
    }
    let (root_buf, tracked, pathspec) = (root.to_path_buf(), tracked.clone(), pathspec.map(<[String]>::to_vec));
    let scan = crate::api::blocking(move || {
        let repo = gix::open(&root_buf).map_err(gix_err)?;
        let Ok(head) = repo.head_commit() else { return Ok(InTheWay::default()) };
        let head = head.tree().map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let within = |p: &&String| pathspec.as_deref().is_none_or(|spec| spec.iter().any(|s| *p == s || p.strip_prefix(s.as_str()).is_some_and(|rest| rest.starts_with('/'))));
        let files = files_in(&head, tracked.iter().filter(within))?;
        Ok(repos_at(&root_buf, &index_gitlinks(&index), files.iter().map(|p| p.as_bstr())))
    })
    .await?;
    finish(cli, root, scan).await
}

/// C2 of the safety review: `git stash apply` checks its merge out as a two-way move from HEAD,
/// writing the stash's files over whatever stands at them (a populated gitlink HEAD has there,
/// a directory with a `git init` or an ignored clone in it). The files are the ones the stash
/// changed, against its base: W's, I's, and U's untracked ones. Sorted.
pub(crate) async fn stash_apply_in_the_way(cli: &GitCli, root: &Path, stash: &str) -> Result<Vec<String>, GbError> {
    let stash = ObjectId::from_hex(stash.as_bytes()).map_err(gix_err)?;
    let root_buf = root.to_path_buf();
    let scan = crate::api::blocking(move || {
        let root = root_buf.as_path();
        let repo = gix::open(root).map_err(gix_err)?;
        let w = repo.find_commit(stash).map_err(gix_err)?;
        let parents: Vec<ObjectId> = w.parent_ids().map(|p| p.detach()).collect();
        let Some(base) = parents.first().copied() else { return Ok(InTheWay::default()) };
        let index = repo.index_or_empty().map_err(gix_err)?;
        let diff = tree_diff(&repo, base, w.id)?;
        let mut files = diff.to_files.clone();
        let mut links = gitlinks(&index, &diff);
        if let Some(i) = parents.get(1) {
            let d = tree_diff(&repo, base, *i)?;
            files.extend(d.to_files);
            links.extend(d.from_gitlinks);
        }
        if let Some(u) = parents.get(2) {
            let tree = repo.find_commit(*u).map_err(gix_err)?.tree().map_err(gix_err)?;
            let mut rec = gix::traverse::tree::Recorder::default();
            tree.traverse().breadthfirst(&mut rec).map_err(gix_err)?;
            files.extend(rec.records.into_iter().filter(|r| r.mode.is_blob_or_symlink()).map(|r| r.filepath));
        }
        Ok(repos_at(root, &links, files.iter().map(|p| p.as_bstr())))
    })
    .await?;
    finish(cli, root, scan).await
}

/// The refusal for a repository in the way: `what` is the operation ("reset", "checkout", "stash",
/// "apply", "undo", "redo", "restore").
pub(crate) fn repository_in_the_way(path: &str, what: &str) -> GbError {
    GbError::new(crate::error::GbErrorKind::InvalidInput, format!("{path} is a repository in the way of the {what}: move it first"))
}

/// Refuses when [`check_move`] finds a repository (the first names the error); otherwise the
/// check, for the move's autostash rule.
pub(crate) async fn refuse_repos_in_the_way(cli: &GitCli, root: &Path, from: ObjectId, to: ObjectId, what: &str) -> Result<MoveCheck, GbError> {
    let check = Box::pin(check_move(cli, root, from, to)).await?;
    match check.repos.first() {
        Some(p) => Err(repository_in_the_way(p, what)),
        None => Ok(check),
    }
}

/// [`refuse_repos_in_the_way`] for a merge of `theirs` into `ours` ([`check_merge`]).
pub(crate) async fn refuse_repos_in_the_way_of_merge(cli: &GitCli, root: &Path, ours: ObjectId, theirs: ObjectId, what: &str) -> Result<MoveCheck, GbError> {
    let check = Box::pin(check_merge(cli, root, ours, theirs)).await?;
    match check.repos.first() {
        Some(p) => Err(repository_in_the_way(p, what)),
        None => Ok(check),
    }
}
// --- end 2C T6 ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    fn lines(n: usize, change: Option<(usize, &str)>) -> String {
        (1..=n).map(|i| match change { Some((at, s)) if at == i => format!("{s}\n"), _ => format!("line {i}\n") }).collect()
    }

    /// main: f.txt (20 lines); other: f.txt's last line changed, and g.txt added.
    fn two_branches() -> (TestRepo, gix::ObjectId) {
        let r = TestRepo::new();
        r.write("f.txt", &lines(20, None));
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("other");
        r.write("f.txt", &lines(20, Some((20, "theirs"))));
        r.write("g.txt", "g\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "other"]);
        r.switch("main");
        let other = gix::ObjectId::from_hex(r.git(&["rev-parse", "other"]).as_bytes()).unwrap();
        (r, other)
    }

    #[test]
    fn the_paths_two_commits_differ_in() {
        let (r, other) = two_branches();
        let repo = gix::open(r.path()).unwrap();
        let head = repo.head_id().unwrap().detach();
        assert_eq!(tree_diff_paths(&repo, head, other).unwrap().into_iter().collect::<Vec<_>>(), ["f.txt", "g.txt"]);
    }

    #[tokio::test]
    async fn dirty_splits_tracked_from_untracked() {
        let (r, _) = two_branches();
        r.write("f.txt", &lines(20, Some((1, "mine"))));
        r.write("u.txt", "u\n");
        let d = dirty(&cli(), r.path()).await.unwrap();
        assert_eq!(d.tracked.into_iter().collect::<Vec<_>>(), ["f.txt"]);
        assert_eq!(d.untracked.into_iter().collect::<Vec<_>>(), ["u.txt"]);
    }

    #[tokio::test]
    async fn a_restore_is_predicted_to_conflict_only_where_the_changes_meet() {
        let (r, other) = two_branches();
        let tmp = tempfile::tempdir().unwrap();
        r.write("f.txt", &lines(20, Some((1, "mine"))));
        assert!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap().is_empty(), "far from the target's change");
        r.write("f.txt", &lines(20, Some((20, "mine"))));
        assert_eq!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap(), ["f.txt"]);
        r.write("g.txt", "untracked here\n");
        assert_eq!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["g.txt".into()]).await.unwrap(), ["g.txt"], "added on both sides, differently");
        let before = std::fs::read(r.path().join(".git/index")).unwrap();
        predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into(), "g.txt".into()]).await.unwrap();
        assert_eq!(std::fs::read(r.path().join(".git/index")).unwrap(), before, "a prediction writes nothing");
    }

    // --- 2C T5: the staged side (review I2) ---
    /// `stash apply --index` re-applies the staged diff with exact context: line 1 staged and the
    /// target changing line 3 is refused, though the worktree merge is clean.
    #[tokio::test]
    async fn a_staged_edit_near_the_targets_change_is_predicted() {
        let r = TestRepo::new();
        r.write("f.txt", &lines(20, None));
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("other");
        r.write("f.txt", &lines(20, Some((3, "theirs"))));
        r.git(&["commit", "-q", "-am", "other"]);
        r.switch("main");
        let other = gix::ObjectId::from_hex(r.git(&["rev-parse", "other"]).as_bytes()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // Unstaged only: the worktree merge of line 1 and line 3 is clean.
        r.write("f.txt", &lines(20, Some((1, "mine"))));
        assert!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap().is_empty(), "unstaged: clean");
        // Staged: the index part's context (lines 2-4) holds the target's line 3.
        r.git(&["add", "f.txt"]);
        let before = std::fs::read(r.path().join(".git/index")).unwrap();
        assert_eq!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap(), ["f.txt"]);
        assert_eq!(std::fs::read(r.path().join(".git/index")).unwrap(), before, "the repository's index isn't touched");
        // Staged far from the target's change: clean.
        r.write("f.txt", &lines(20, Some((15, "mine"))));
        r.git(&["add", "f.txt"]);
        assert!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap().is_empty(), "far: clean");
        // Re-review M2: the user's diff config doesn't change the prediction. With 8 lines of
        // context, line 9 staged would reach the target's line 3; stash's patch has 3, so it applies.
        r.git(&["config", "diff.context", "8"]);
        r.git(&["config", "diff.algorithm", "patience"]);
        r.write("f.txt", &lines(20, Some((9, "mine"))));
        r.git(&["add", "f.txt"]);
        assert!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap().is_empty(), "diff.context=8: still clean");
        r.write("f.txt", &lines(20, Some((5, "mine"))));
        r.git(&["add", "f.txt"]);
        assert_eq!(predict_conflicts(&cli(), r.path(), tmp.path(), other, &["f.txt".into()]).await.unwrap(), ["f.txt"], "within 3 lines: refused");
    }
    // --- end 2C T5 ---

    // --- 2C T1: ancestry counts and worktree display paths ---
    #[tokio::test]
    async fn ahead_behind_and_commits_not_in_count_both_sides() {
        let r = crate::testing::TestRepo::new();
        r.commit("base");
        r.switch_new("x");
        r.commit("x1");
        r.commit("x2");
        r.switch("main");
        r.commit("m1");
        let cli = crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(50))).with_env(crate::testing::isolated_git_env());
        assert_eq!(ahead_behind(&cli, r.path(), "refs/heads/x", "refs/heads/main").await.unwrap(), (2, 1));
        assert_eq!(commits_not_in(&cli, r.path(), "refs/heads/x", "refs/heads/main").await.unwrap(), 2);
        assert_eq!(commits_not_in(&cli, r.path(), "refs/heads/main", "refs/heads/main").await.unwrap(), 0);
    }

    #[test]
    fn display_worktree_is_relative_beside_the_main_one() {
        assert_eq!(display_worktree(Path::new("/r/shop"), Path::new("/r/shop-feature-x")), "../shop-feature-x");
        assert_eq!(display_worktree(Path::new("/r/shop"), Path::new("/elsewhere/wt")), "/elsewhere/wt");
        assert_eq!(display_worktree(Path::new("/r/shop"), Path::new("/r/shop")), "/r/shop");
    }
    // --- end 2C T1 ---

    // --- 2C repo-safety ---
    /// 2B T4 re-review N1 and N3: a `.git` of any kind, at any depth, valid or not, makes a
    /// directory in the way a repository; a symlink at the path, or on the way to it, doesn't.
    #[test]
    fn any_dot_git_at_any_depth_is_in_the_way_and_a_symlink_at_the_path_is_not() {
        let r = TestRepo::new();
        r.write("d", "file\n");
        r.write("lib/sm", "file\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        let none = BTreeSet::new();
        let check = |p: &str| repos_at(r.path(), &none, [p.as_bytes().as_bstr()]);
        let repos = |p: &str| check(p).repos.into_iter().collect::<Vec<_>>();
        // A broken gitfile deep down: git lists nothing for it, and would delete it.
        std::fs::remove_file(r.path().join("d")).unwrap();
        std::fs::create_dir_all(r.path().join("d/a/b")).unwrap();
        std::fs::write(r.path().join("d/a/b/.git"), "gitdir: /nowhere\n").unwrap();
        assert_eq!(repos("d"), ["d/a/b"]);
        assert!(repo_at(r.path(), "d"));
        // A damaged `.git` folder (no HEAD, no refs), shallower: named first.
        std::fs::create_dir(r.path().join("d/a/.git")).unwrap();
        assert_eq!(repos("d"), ["d/a"]);
        // Only untracked files: a directory to list, no repository.
        std::fs::remove_dir(r.path().join("d/a/.git")).unwrap();
        std::fs::remove_file(r.path().join("d/a/b/.git")).unwrap();
        std::fs::write(r.path().join("d/a/b/f"), "f\n").unwrap();
        let scan = check("d");
        assert!(scan.repos.is_empty() && scan.dirs == [BString::from("d")], "{scan:?}");
        assert!(!repo_at(r.path(), "d"));
        // N3: a symlink at the path to a folder holding a repository: git replaces the link.
        // (Unix only: folder symlinks.)
        #[cfg(unix)]
        {
            std::fs::remove_dir_all(r.path().join("d")).unwrap();
            let elsewhere = r.root().join("elsewhere");
            std::fs::create_dir_all(elsewhere.join(".git")).unwrap();
            std::os::unix::fs::symlink(&elsewhere, r.path().join("d")).unwrap();
            let scan = check("d");
            assert!(scan.repos.is_empty() && scan.dirs.is_empty(), "{scan:?}");
            assert!(!repo_at(r.path(), "d"));
            // A symlink on the way: `lib` -> a folder with a repository at `sm`.
            std::fs::remove_dir_all(r.path().join("lib")).unwrap();
            std::fs::create_dir_all(elsewhere.join("sm/.git")).unwrap();
            std::os::unix::fs::symlink(&elsewhere, r.path().join("lib")).unwrap();
            let scan = check("lib/sm");
            assert!(scan.repos.is_empty() && scan.dirs.is_empty(), "{scan:?}");
            assert!(!dir_on_disk(r.path(), b"lib/sm"));
        }
    }

    /// Safety review M4: a directory whose name isn't UTF-8 reaches the disk check as its bytes,
    /// so a repository in it is found (a lossy name would have missed the path).
    #[cfg(unix)] // non-UTF-8 file names exist only on Unix
    #[test]
    fn a_non_utf8_directory_name_is_checked_as_bytes() {
        use std::os::unix::ffi::OsStrExt;
        let r = TestRepo::new();
        let name: &[u8] = b"d\xff";
        let dir = r.path().join(std::ffi::OsStr::from_bytes(name));
        std::fs::create_dir_all(dir.join("sub/.git")).unwrap();
        assert!(dir_on_disk(r.path(), name));
        assert_eq!(dot_git_within(r.path(), name), Some(BString::from(&b"d\xff/sub"[..])));
        let scan = repos_at(r.path(), &BTreeSet::new(), [name.as_bstr()]);
        assert_eq!(scan.repos.into_iter().collect::<Vec<_>>(), ["d\u{FFFD}/sub"]);
        assert!(!dir_on_disk(r.path(), "d\u{FFFD}".as_bytes()), "the lossy name is another path");
    }
    // --- end 2C repo-safety ---
}

