//! A snapshot captures the index and the worktree separately, plus the untracked files the
//! operation destroys, for a path set P. They're stash-shaped commits that stay dangling:
//! W = worktree tree, with parents HEAD, I (the index) and U (untracked). No ref points at them,
//! and git's `gc.pruneExpire` (2 weeks) keeps them as long as the journal does. They're built
//! through temp index files in the data dir's `tmp/`, so the real index is never touched and the
//! cost is proportional to P. They never sign (`commit-tree --no-gpg-sign`) and carry GitBolt's
//! own identity (Deviation 7).

use crate::error::{gix_err, GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use crate::journal::Snapshot;
use crate::write::WriteToken;
use gix::bstr::{BString, ByteSlice};
use gix::ObjectId;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_OID: &str = "0000000000000000000000000000000000000000";
const IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "GitBolt"),
    ("GIT_AUTHOR_EMAIL", "gitbolt@localhost"),
    ("GIT_COMMITTER_NAME", "GitBolt"),
    ("GIT_COMMITTER_EMAIL", "gitbolt@localhost"),
];

pub(crate) struct SnapshotCx<'a> {
    pub cli: &'a GitCli,
    pub token: &'a WriteToken,
    /// The worktree (canonical).
    pub root: &'a Path,
    /// The data dir's `tmp/` (0700).
    pub tmp: &'a Path,
}

impl SnapshotCx<'_> {
    fn git<I, S>(&self, args: I) -> GitInvocation
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        // Detached (2A final M6): a clean filter can't block on the terminal the app started from.
        GitInvocation::write(self.token, self.root, args).envs(IDENTITY.iter().map(|(k, v)| (OsString::from(k), OsString::from(v)))).env("GIT_LITERAL_PATHSPECS", "1").detach_terminal()
    }

    fn indexed<I, S>(&self, index: &Path, args: I) -> GitInvocation
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.git(args).env("GIT_INDEX_FILE", index)
    }

    async fn text(&self, inv: GitInvocation) -> Result<String, GbError> {
        let out = self.cli.run(inv).await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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

fn missing() -> GbError {
    GbError::new(GbErrorKind::NotFound, "the snapshot is missing: git has garbage-collected it")
}

fn oid(hex: &str) -> Result<ObjectId, GbError> {
    ObjectId::from_hex(hex.as_bytes()).map_err(|_| missing())
}

/// HEAD's oid (`None` when unborn) and `"<branch>: <short> <subject>"`, as git's stash messages.
fn head_info(root: &Path) -> Result<(Option<String>, String), GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let head = repo.head().map_err(gix_err)?;
    let branch = head.referent_name().map(|n| n.shorten().to_string()).unwrap_or_else(|| "(no branch)".into());
    let Some(id) = head.id() else { return Ok((None, format!("{branch}: (no commits)"))) };
    let subject = repo.find_commit(id.detach()).ok().and_then(|c| c.message().ok().map(|m| m.summary().to_string())).unwrap_or_default();
    Ok((Some(id.to_string()), format!("{branch}: {} {subject}", id.to_hex_with_len(7))))
}

/// Refuses what a snapshot can't carry: a conflicted path of `paths` (stages 1-3) or a
/// skip-worktree one. Intent-to-add entries are carried as absent from the index (a snapshot
/// restores them as plain untracked files; their content is in W).
fn check_index(root: &Path, paths: &[&String]) -> Result<(), GbError> {
    check_index_with(root, paths, false).map(|_| ())
}

/// 3B T2: `check_index`, but with `unmerged_ok` a conflicted path of `paths` is returned instead
/// of refused (the Undo of a stopped "without committing" pick clears its stages).
fn check_index_with(root: &Path, paths: &[&String], unmerged_ok: bool) -> Result<BTreeSet<String>, GbError> {
    use gix::index::entry::Flags;
    let mut unmerged = BTreeSet::new();
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let want: BTreeSet<&[u8]> = paths.iter().map(|p| p.as_bytes()).collect();
    for e in index.entries() {
        let path = e.path(&index);
        if !want.contains(path.as_bytes()) {
            continue;
        }
        if e.stage_raw() != 0 {
            if unmerged_ok {
                unmerged.insert(path.to_str_lossy().into_owned());
                continue;
            }
            return Err(GbError::new(GbErrorKind::InProgress, format!("{path} has merge conflicts: resolve conflicts first")));
        }
        if e.flags.contains(Flags::SKIP_WORKTREE) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is skip-worktree: a snapshot can't carry it")));
        }
    }
    Ok(unmerged)
}

/// `update-index -z --index-info` lines setting each of `paths` to its stage-0 entry in this
/// worktree's real index (read with gix), or removing it (mode 0) where it has none.
fn index_info(root: &Path, paths: &[&String]) -> Result<Vec<u8>, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let want: BTreeSet<&str> = paths.iter().map(|p| p.as_str()).collect();
    let mut info = Vec::new();
    let mut seen = BTreeSet::new();
    for e in index.entries() {
        let path = e.path(&index).to_str_lossy();
        if e.stage_raw() == 0 && !e.flags.contains(gix::index::entry::Flags::INTENT_TO_ADD) && want.contains(path.as_ref()) {
            info.extend_from_slice(format!("{:o} {}\t{path}\0", e.mode.bits(), e.id).as_bytes());
            seen.insert(path.into_owned());
        }
    }
    for p in paths.iter().filter(|p| !seen.contains(p.as_str())) {
        info.extend_from_slice(format!("0 {ZERO_OID}\t{p}\0").as_bytes());
    }
    Ok(info)
}

/// Each of `paths` in `tree`: its `--index-info` line (a removal where it's absent), and which are there.
fn tree_info(root: &Path, tree: &str, paths: &[&String]) -> Result<(Vec<u8>, BTreeSet<String>), GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let tree = repo.find_tree(oid(tree)?).map_err(|_| missing())?;
    let mut info = Vec::new();
    let mut present = BTreeSet::new();
    for p in paths {
        match tree.lookup_entry_by_path(p.as_str()).map_err(gix_err)? {
            Some(e) if !e.mode().is_tree() => {
                // --- 2B T4: a gitlink's commit is the submodule's, never in this repository ---
                if !e.mode().is_commit() && !repo.has_object(e.object_id()) {
                    return Err(missing());
                }
                // --- end 2B T4 ---
                info.extend_from_slice(format!("{} {}\t{p}\0", e.mode().kind().as_octal_str(), e.object_id()).as_bytes());
                present.insert((*p).clone());
            }
            _ => info.extend_from_slice(format!("0 {ZERO_OID}\t{p}\0").as_bytes()),
        }
    }
    Ok((info, present))
}

/// Which of `paths` are in `tree`, as a file or a directory.
fn tree_present(root: &Path, tree: &str, paths: &[&String]) -> Result<BTreeSet<String>, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let tree = repo.find_tree(oid(tree)?).map_err(|_| missing())?;
    let mut present = BTreeSet::new();
    for p in paths {
        if tree.lookup_entry_by_path(p.as_str()).map_err(gix_err)?.is_some() {
            present.insert((*p).clone());
        }
    }
    Ok(present)
}

/// P as files only (2A final I3). A directory entry would escape the "changed since" check, which
/// compares exact paths, so a Restore could overwrite a file edited inside it with no autostash.
/// An untracked directory stands for every untracked file under it, ignored ones included
/// (`ls-files --others`); a tracked one for its index entries. A tracked entry that is neither
/// in the index nor holds any of it is a worktree-only directory the op doesn't touch: dropped.
/// Every untracked path is in P. A path that isn't a directory stays as given.
async fn files_only(cx: &SnapshotCx<'_>, paths: &[String], untracked: &[String]) -> Result<(Vec<String>, Vec<String>), GbError> {
    let indexed: Vec<String> = {
        let repo = gix::open(cx.root).map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        index.entries().iter().map(|e| e.path(&index).to_str_lossy().into_owned()).collect()
    };
    let is_dir = |p: &str| cx.root.join(p).symlink_metadata().is_ok_and(|m| m.is_dir());
    // --- 2B T4: a file of HEAD stays in P ---
    // A HEAD file the index no longer has (a staged deletion, a rename's source) is a path the op
    // touches even when a folder stands there now: its index state ("absent") must come back.
    let head_files: BTreeSet<String> = {
        let repo = gix::open(cx.root).map_err(gix_err)?;
        match repo.head_commit().ok().and_then(|c| c.tree().ok()) {
            Some(tree) => paths.iter().filter(|p| tree.lookup_entry_by_path(p.as_str()).ok().flatten().is_some_and(|e| !e.mode().is_tree())).cloned().collect(),
            None => BTreeSet::new(),
        }
    };
    // --- end 2B T4 ---
    let (mut p_out, mut u_out, mut seen) = (Vec::new(), Vec::new(), BTreeSet::new());
    for p in untracked {
        let files = if is_dir(p) {
            let args = ["ls-files", "-z", "--others", "--"].into_iter().map(String::from).chain([p.clone()]);
            let out = cx.cli.run(GitInvocation::new(cx.root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
            out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
        } else {
            vec![p.clone()]
        };
        for f in files {
            if seen.insert(f.clone()) {
                u_out.push(f.clone());
                p_out.push(f);
            }
        }
    }
    for p in paths.iter().filter(|p| !untracked.contains(p)) {
        let prefix = format!("{p}/");
        let exact = indexed.iter().any(|q| q == p);
        let under: Vec<&String> = indexed.iter().filter(|q| q.starts_with(&prefix)).collect();
        let files: Vec<String> = match (exact, under.is_empty()) {
            (false, false) => under.into_iter().cloned().chain(head_files.contains(p).then(|| p.clone())).collect(),
            (false, true) if is_dir(p) && !head_files.contains(p) => Vec::new(),
            _ => vec![p.clone()],
        };
        for f in files {
            if seen.insert(f.clone()) {
                p_out.push(f);
            }
        }
    }
    Ok((p_out, u_out))
}

/// Snapshots P (`paths`), `untracked` being the ones the op deletes. Directory entries are
/// expanded to their files ([`files_only`]): the returned `paths` and `untracked` are what the
/// snapshot holds, and an `after` snapshot takes the `before` one's `paths`, so both name the
/// same files.
pub(crate) async fn create(cx: &SnapshotCx<'_>, label: &str, paths: &[String], untracked: &[String]) -> Result<Snapshot, GbError> {
    let (paths, untracked) = files_only(cx, paths, untracked).await?;
    let (paths, untracked) = (paths.as_slice(), untracked.as_slice());
    let tracked: Vec<&String> = paths.iter().filter(|p| !untracked.contains(p)).collect();
    check_index(cx.root, &tracked)?;
    let (head, title) = head_info(cx.root)?;
    let base = match head {
        Some(h) => h,
        // Unborn: a parentless empty-tree commit stands in for HEAD.
        None => cx.text(cx.git(["commit-tree", "--no-gpg-sign", EMPTY_TREE, "-m", "gitbolt: unborn base"])).await?,
    };
    let dir = tempfile::Builder::new().prefix("snap-").tempdir_in(cx.tmp)?;
    let ti = dir.path().join("index");

    // 1. I: the base tree with P's stage-0 entries from the real index.
    cx.cli.run(cx.indexed(&ti, ["read-tree", base.as_str()])).await?;
    if !tracked.is_empty() {
        cx.cli.run(cx.indexed(&ti, ["update-index", "-z", "--index-info"]).stdin(index_info(cx.root, &tracked)?)).await?;
    }
    let i_tree = cx.text(cx.indexed(&ti, ["write-tree"])).await?;
    let i = cx.text(cx.git(["commit-tree", "--no-gpg-sign", i_tree.as_str(), "-p", base.as_str(), "-m", &format!("index on {title}")])).await?;

    // 2. W-tree: the same temp index plus P's tracked worktree state (deletions included). Only
    //    paths git knows of or that exist, or `add` fails the pathspec.
    let (_, in_i) = tree_info(cx.root, &i_tree, &tracked)?;
    // --- 2B T4: a path with no file is a removal, never an `add` ---
    // No file at it (gone, a file where a folder of it must be) or a folder in its place (not a
    // submodule): W has nothing there. `add` would put the folder's files in W, which then looks
    // changed against every later state, or fail on an ignored file standing in its way.
    let gitlinks: BTreeSet<String> = {
        let repo = gix::open(cx.root).map_err(gix_err)?;
        let tree = repo.find_tree(oid(&i_tree)?).map_err(|_| missing())?;
        tracked.iter().filter(|p| tree.lookup_entry_by_path(p.as_str()).ok().flatten().is_some_and(|e| e.mode().is_commit())).map(|p| (*p).clone()).collect()
    };
    // Only "not found" and "not a directory" (a file where a folder of it is) mean no file: any
    // other error (permission denied) fails the snapshot, as `add` would have.
    let mut no_file = BTreeSet::new();
    for p in &tracked {
        let none = match cx.root.join(p).symlink_metadata() {
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => true,
            Err(e) => return Err(e.into()),
            Ok(m) => m.is_dir() && !gitlinks.contains(*p),
        };
        if none {
            no_file.insert((*p).clone());
        }
    }
    let removals: Vec<u8> = tracked.iter().filter(|p| in_i.contains(p.as_str()) && no_file.contains(**p)).flat_map(|p| format!("0 {ZERO_OID}\t{p}\0").into_bytes()).collect();
    if !removals.is_empty() {
        cx.cli.run(cx.indexed(&ti, ["update-index", "-z", "--index-info"]).stdin(removals)).await?;
    }
    let add: Vec<&String> = tracked.iter().copied().filter(|p| !no_file.contains(*p)).collect();
    // `-f`: every path is named exactly, so it adds that file, nothing more. Without it, `add`
    // refuses a tracked file inside an ignored folder ("paths are ignored"), and a file at a
    // HEAD path the index doesn't have (a rename's source) that's ignored.
    if !add.is_empty() {
        cx.cli.run(cx.indexed(&ti, ["add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"]).stdin(nul_list(add))).await?;
    }
    // --- end 2B T4 ---
    let w_tree = cx.text(cx.indexed(&ti, ["write-tree"])).await?;

    // 3. U: the untracked files the operation deletes, in a fresh temp index.
    let u = if untracked.is_empty() {
        None
    } else {
        let tu = dir.path().join("untracked");
        let present: Vec<&String> = untracked.iter().filter(|p| cx.root.join(p).symlink_metadata().is_ok()).collect();
        if !present.is_empty() {
            cx.cli.run(cx.indexed(&tu, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"]).stdin(nul_list(present))).await?;
        }
        let u_tree = cx.text(cx.indexed(&tu, ["write-tree"])).await?;
        Some(cx.text(cx.git(["commit-tree", "--no-gpg-sign", u_tree.as_str(), "-m", &format!("untracked files on {title}")])).await?)
    };

    // 4. W, the snapshot.
    let message = format!("gitbolt snapshot: {label}");
    let mut args = vec!["commit-tree", "--no-gpg-sign", w_tree.as_str(), "-p", base.as_str(), "-p", i.as_str()];
    if let Some(u) = &u {
        args.extend(["-p", u.as_str()]);
    }
    args.extend(["-m", message.as_str()]);
    let w = cx.text(cx.git(args)).await?;
    // --- 2B T4: permission bits ---
    let modes = paths.iter().filter_map(|p| cx.root.join(p).symlink_metadata().ok().filter(|m| m.is_file()).map(|m| (p.clone(), crate::platform::fs::mode(&m) & 0o7777))).collect();
    Ok(Snapshot { commit: w, paths: paths.to_vec(), untracked: untracked.to_vec(), modes })
    // --- end 2B T4 ---
}

// --- 2B T4: permission bits ---
/// The permission bits the snapshot recorded, on each regular file it checked out (`paths`).
/// Best effort: a file that can't be chmodded keeps git's mode, with a warning.
fn reapply_modes(root: &Path, snap: &Snapshot, paths: &BTreeSet<String>) {
    for p in paths {
        let Some(mode) = snap.modes.get(p) else { continue };
        let full = root.join(p);
        if full.symlink_metadata().is_ok_and(|m| m.is_file())
            && let Err(e) = crate::platform::fs::set_mode(&full, *mode)
        {
            tracing::warn!(target: "gitbolt_core::write", "restoring {p}'s permissions: {e}");
        }
    }
}
// --- end 2B T4 ---

/// W's tree, I's tree and U's tree (if any).
pub(crate) fn trees(root: &Path, snap: &Snapshot) -> Result<(String, String, Option<String>), GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let tree_of = |id: ObjectId| -> Result<String, GbError> {
        let tree = repo.find_commit(id).map_err(|_| missing())?.tree_id().map_err(|_| missing())?.detach();
        repo.find_tree(tree).map_err(|_| missing())?;
        Ok(tree.to_string())
    };
    let w = repo.find_commit(oid(&snap.commit)?).map_err(|_| missing())?;
    let parents: Vec<ObjectId> = w.parent_ids().map(|p| p.detach()).collect();
    let i = tree_of(*parents.get(1).ok_or_else(missing)?)?;
    let u = parents.get(2).map(|p| tree_of(*p)).transpose()?;
    Ok((tree_of(w.id)?, i, u))
}

pub(crate) fn exists(root: &Path, snap: &Snapshot) -> bool {
    trees(root, snap).is_ok()
}

/// A temp index holding `tree`, checked out for `paths` (filters and line endings round-trip).
async fn checkout_from(cx: &SnapshotCx<'_>, index: &Path, tree: &str, paths: &BTreeSet<String>) -> Result<(), GbError> {
    if paths.is_empty() {
        return Ok(());
    }
    cx.cli.run(cx.indexed(index, ["read-tree", tree])).await?;
    cx.cli.run(cx.indexed(index, ["checkout-index", "-f", "-z", "--stdin"]).stdin(nul_list(paths))).await?;
    Ok(())
}

pub(crate) async fn restore(cx: &SnapshotCx<'_>, snap: &Snapshot) -> Result<(), GbError> {
    restore_with(cx, snap, false).await
}

/// `restore`; with `unmerged_ok` (3B T2: the Undo of a stopped "without committing" pick, after
/// its question) a conflicted path of P is restored too: its stages are cleared in the same
/// `update-index` that writes P's entries from I.
pub(crate) async fn restore_with(cx: &SnapshotCx<'_>, snap: &Snapshot, unmerged_ok: bool) -> Result<(), GbError> {
    // Preflight: everything that can be checked without writing is, before anything is written.
    let (w_tree, i_tree, u_tree) = trees(cx.root, snap)?;
    let tracked: Vec<&String> = snap.paths.iter().filter(|p| !snap.untracked.contains(p)).collect();
    let untracked: Vec<&String> = snap.untracked.iter().collect();
    let unmerged = check_index_with(cx.root, &tracked, unmerged_ok)?;
    let (index_lines, _) = tree_info(cx.root, &i_tree, &tracked)?;
    // A mode-0 line removes every stage of its path; I's line for it follows.
    let index_lines: Vec<u8> = unmerged.iter().flat_map(|p| format!("0 {ZERO_OID}\t{p}\0").into_bytes()).chain(index_lines).collect();
    let (_, in_w) = tree_info(cx.root, &w_tree, &tracked)?;
    let in_u = match &u_tree {
        Some(u) => tree_present(cx.root, u, &untracked)?,
        None => BTreeSet::new(),
    };
    // --- 2C repo-safety ---
    // A repository standing where a file of W or U goes back would be removed whole by
    // `checkout-index -f`: refused here in words, whatever the caller checked (2B T4 re-review
    // N5, 2C T6 re-review 3 C5).
    let (root_buf, snap_owned) = (cx.root.to_path_buf(), snap.clone());
    if let Some(p) = crate::api::blocking(move || scan_in_the_way(&root_buf, &snap_owned)).await?.scan.repos.first() {
        return Err(crate::write::precheck::repository_in_the_way(p, "restore"));
    }
    // --- end 2C repo-safety ---
    let dir = tempfile::Builder::new().prefix("restore-").tempdir_in(cx.tmp)?;

    // 1. The worktree from W and U, each through a temp index (the likeliest step to fail, so
    //    first: the real index is untouched until it succeeds). U is checked out whole: its
    //    directories were captured recursively.
    checkout_from(cx, &dir.path().join("w"), &w_tree, &in_w).await?;
    if let (Some(u), false) = (&u_tree, in_u.is_empty()) {
        let tu = dir.path().join("u");
        cx.cli.run(cx.indexed(&tu, ["read-tree", u.as_str()])).await?;
        cx.cli.run(cx.indexed(&tu, ["checkout-index", "-f", "-a"])).await?;
    }
    // --- 2B T4: permission bits ---
    reapply_modes(cx.root, snap, &in_w.union(&in_u).cloned().collect());
    // --- end 2B T4 ---
    // 2. The real index: P's entries from I (a removal line where I has none).
    if !tracked.is_empty() {
        cx.cli.run(cx.git(["update-index", "-z", "--index-info"]).stdin(index_lines)).await?;
    }
    // 3. A path of P in neither W nor U wasn't in the worktree before the operation: its file is
    //    unlinked, the one non-git write (Deviation 12). A directory in its place is left alone
    //    (only removed if empty).
    for p in snap.paths.iter().filter(|p| !in_w.contains(*p) && !in_u.contains(*p)) {
        let full = cx.root.join(p);
        let res = match full.symlink_metadata() {
            Ok(m) if m.is_dir() => std::fs::remove_dir(&full).or_else(|e| if e.kind() == std::io::ErrorKind::DirectoryNotEmpty { Ok(()) } else { Err(e) }),
            Ok(_) => std::fs::remove_file(&full),
            Err(_) => Ok(()),
        };
        match res {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

// --- 2C repo-safety ---
/// What [`restore`] would delete writing a file of W or U where the disk now has a directory:
/// `checkout-index -f` removes the directory whole (2C T6 re-review 3 C5). A caller refuses over
/// `repos` and autostashes `untracked` first, which asks (§6.1, the Paths rule).
#[derive(Debug, Default)]
pub(crate) struct DirsInTheWay {
    /// Repositories in such a directory (`.git`, a populated gitlink, a nested clone), sorted.
    pub repos: Vec<String>,
    /// What else the restore would delete that the snapshot doesn't hold, sorted, for the
    /// autostash: the files outside the index in such a directory, the index entries under it
    /// (safety review I2: `checkout-index -f` leaves them `AD` beside the file), and a file or
    /// a symlink standing where one of a restored path's directories must be (I1: `-f` unlinks
    /// it).
    pub untracked: Vec<String>,
}

/// The gix part of [`dirs_in_the_way`]: `scan` is the directories in the way of a file of W or
/// U; `blocked` the rest of what is lost without a git read (I1, I2). One lstat per path of the
/// snapshot, a walk only of a directory found in the way ([`crate::write::precheck::repos_at`]).
pub(crate) struct RestoreScan {
    pub scan: crate::write::precheck::InTheWay,
    pub blocked: Vec<String>,
}

pub(crate) fn scan_in_the_way(root: &Path, snap: &Snapshot) -> Result<RestoreScan, GbError> {
    use crate::write::precheck;
    let (w_tree, _, u_tree) = trees(root, snap)?;
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let gitlinks = precheck::index_gitlinks(&index);
    let tracked = snap.paths.iter().filter(|p| !snap.untracked.contains(p));
    let mut files = precheck::files_in(&repo.find_tree(oid(&w_tree)?).map_err(|_| missing())?, tracked)?;
    if let Some(u) = &u_tree {
        files.extend(precheck::files_in(&repo.find_tree(oid(u)?).map_err(|_| missing())?, &snap.untracked)?);
    }
    let scan = precheck::repos_at(root, &gitlinks, files.iter().map(|p| p.as_bstr()));
    let mut blocked = scan.indexed_under(&index);
    // I1: a file (or a symlink) standing where one of a restored path's directories must be.
    for f in &files {
        let parts: Vec<&[u8]> = f.split(|b| *b == b'/').collect();
        let mut lead = BString::default();
        for part in &parts[..parts.len().saturating_sub(1)] {
            if !lead.is_empty() {
                lead.push(b'/');
            }
            lead.extend_from_slice(part);
            match precheck::full_path(root, &lead).symlink_metadata() {
                Ok(m) if m.is_dir() => continue,
                Ok(_) => blocked.push(lead.to_str_lossy().into_owned()),
                Err(_) => {}
            }
            break;
        }
    }
    blocked.retain(|p| !snap.paths.contains(p));
    Ok(RestoreScan { scan, blocked })
}

/// A read: [`scan_in_the_way`], then `ls-files --others` only over the directories it found in
/// the way ([`crate::write::precheck::others_under`]).
pub(crate) async fn dirs_in_the_way(cli: &GitCli, root: &Path, snap: &Snapshot) -> Result<DirsInTheWay, GbError> {
    let (root_buf, snap_owned) = (root.to_path_buf(), snap.clone());
    let RestoreScan { scan, blocked } = crate::api::blocking(move || scan_in_the_way(&root_buf, &snap_owned)).await?;
    let (nested, files) = crate::write::precheck::others_under(cli, root, &scan.dirs).await?;
    let mut repos = scan.repos;
    repos.extend(nested);
    let mut untracked: Vec<String> = files.into_iter().filter(|f| !snap.paths.contains(f)).collect();
    untracked.extend(blocked);
    untracked.sort();
    untracked.dedup();
    Ok(DirsInTheWay { repos: repos.into_iter().collect(), untracked })
}
// --- end 2C repo-safety ---

// --- 2C T6: restore_index ---
/// `restore`'s read-only checks alone (the objects are there, P's index entries can be
/// carried), so a caller can run them before it moves a ref.
pub(crate) fn check_restore(root: &Path, snap: &Snapshot) -> Result<(), GbError> {
    let (w_tree, i_tree, u_tree) = trees(root, snap)?;
    let tracked: Vec<&String> = snap.paths.iter().filter(|p| !snap.untracked.contains(p)).collect();
    check_index(root, &tracked)?;
    tree_info(root, &i_tree, &tracked)?;
    tree_info(root, &w_tree, &tracked)?;
    if let Some(u) = &u_tree {
        tree_present(root, u, &snap.untracked.iter().collect::<Vec<_>>())?;
    }
    Ok(())
}

/// The index part of a restore only (§5.3, the mixed reset's undo): P's entries from I. The
/// working tree is never touched, so later edits there survive.
pub(crate) async fn restore_index(cx: &SnapshotCx<'_>, snap: &Snapshot) -> Result<(), GbError> {
    let (_, i_tree, _) = trees(cx.root, snap)?;
    let tracked: Vec<&String> = snap.paths.iter().filter(|p| !snap.untracked.contains(p)).collect();
    if tracked.is_empty() {
        return Ok(());
    }
    check_index(cx.root, &tracked)?;
    let (index_lines, _) = tree_info(cx.root, &i_tree, &tracked)?;
    cx.cli.run(cx.git(["update-index", "-z", "--index-info"]).stdin(index_lines)).await?;
    Ok(())
}
// --- end 2C T6 ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(200))).with_env(isolated_git_env())
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// a: fully staged; b: first line staged, last line not; c: untracked; d: deleted, unstaged.
    fn dirty_repo() -> TestRepo {
        let r = TestRepo::new();
        r.write("a.txt", "a1\n");
        r.write("b.txt", "b1\nb2\nb3\nb4\nb5\nb6\nb7\nb8\n");
        r.write("d.txt", "d\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.write("a.txt", "a2\n");
        r.git(&["add", "a.txt"]);
        r.write("b.txt", "B1\nb2\nb3\nb4\nb5\nb6\nb7\nb8\n");
        r.git(&["add", "b.txt"]);
        r.write("b.txt", "B1\nb2\nb3\nb4\nb5\nb6\nb7\nB8\n");
        r.write("c.txt", "new\n");
        std::fs::remove_file(r.path().join("d.txt")).unwrap();
        r
    }

    fn split(r: &TestRepo) -> (String, String) {
        (r.git(&["diff", "--cached"]), r.git(&["diff"]))
    }

    fn destroy(r: &TestRepo) {
        r.git(&["reset", "-q", "--hard"]);
        r.git(&["clean", "-q", "-f"]);
    }

    #[tokio::test]
    async fn restores_the_staged_split_and_the_untracked_files() {
        let r = dirty_repo();
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let before = split(&r);
        let snap = create(&cx, "discard all changes", &strings(&["a.txt", "b.txt", "c.txt", "d.txt"]), &strings(&["c.txt"])).await.unwrap();
        destroy(&r);
        assert_ne!(split(&r), before);
        restore(&cx, &snap).await.unwrap();
        assert_eq!(split(&r), before, "index and worktree come back separately");
        assert_eq!(std::fs::read_to_string(r.path().join("c.txt")).unwrap(), "new\n");
        assert!(!r.path().join("d.txt").exists(), "a file deleted before the op stays deleted (Deviation 12)");
        assert!(r.git(&["log", "--all", "--format=%s"]).lines().all(|s| !s.starts_with("gitbolt snapshot")), "no ref points at it");
        assert!(std::fs::read_dir(tmp.path()).unwrap().next().is_none(), "temp indexes are removed");
    }

    #[tokio::test]
    async fn creating_never_touches_the_real_index() {
        let r = dirty_repo();
        let index = r.path().join(".git/index");
        let (bytes, mtime) = (std::fs::read(&index).unwrap(), std::fs::metadata(&index).unwrap().modified().unwrap());
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        create(&cx, "x", &strings(&["a.txt", "b.txt"]), &[]).await.unwrap();
        assert_eq!(std::fs::read(&index).unwrap(), bytes);
        assert_eq!(std::fs::metadata(&index).unwrap().modified().unwrap(), mtime);
    }

    #[tokio::test]
    async fn a_snapshot_never_calls_the_signer() {
        let r = dirty_repo();
        let counter = r.path().join("gpg-count");
        let fake = r.path().join("fake-gpg");
        std::fs::write(&fake, format!("#!/bin/sh\necho sign >> '{}'\nexit 1\n", crate::platform::fs::to_git_path(&counter))).unwrap();
        crate::platform::fs::set_mode(&fake, 0o755).unwrap();
        for (k, v) in [("gpg.format", "openpgp"), ("commit.gpgsign", "true"), ("user.signingkey", "ABCDEF"), ("gpg.program", fake.to_str().unwrap())] {
            r.git(&["config", k, v]);
        }
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        create(&cx, "x", &strings(&["a.txt", "c.txt"]), &strings(&["c.txt"])).await.unwrap();
        assert!(!counter.exists(), "commit-tree --no-gpg-sign: the signer is never called");
    }

    #[tokio::test]
    async fn works_in_an_unborn_repository() {
        let r = TestRepo::new();
        r.write("a.txt", "first\n");
        r.git(&["add", "a.txt"]);
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["a.txt"]), &[]).await.unwrap();
        r.git(&["rm", "-q", "--cached", "a.txt"]);
        std::fs::remove_file(r.path().join("a.txt")).unwrap();
        restore(&cx, &snap).await.unwrap();
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "a.txt");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "first\n");
    }

    /// Spec §5.2: a user can recover one by hand with `git stash apply --index <W>`.
    #[tokio::test]
    async fn git_stash_apply_index_restores_it_too() {
        let r = dirty_repo();
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let before = split(&r);
        let snap = create(&cx, "x", &strings(&["a.txt", "b.txt", "c.txt", "d.txt"]), &strings(&["c.txt"])).await.unwrap();
        destroy(&r);
        r.git(&["stash", "apply", "-q", "--index", &snap.commit]);
        assert_eq!(split(&r), before);
        assert!(r.path().join("c.txt").exists());
    }

    #[tokio::test]
    async fn it_exists_until_gc_prunes_it() {
        let r = dirty_repo();
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["a.txt", "c.txt"]), &strings(&["c.txt"])).await.unwrap();
        assert!(exists(r.path(), &snap));
        r.git(&["gc", "-q", "--prune=now"]);
        assert!(!exists(r.path(), &snap));
        let err = restore(&cx, &snap).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
    }

    /// Review Focus 3: pathspecs are literal and NUL-separated, never argv.
    #[cfg(unix)] // file names Windows forbids (*, ?, :, newlines)
    #[tokio::test]
    async fn awkward_paths_round_trip() {
        let r = TestRepo::new();
        let names = ["-dash.txt", "a b.txt", "*.txt", "é.txt", "dir/[x].txt"];
        for n in names {
            r.write(n, "base\n");
        }
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "base"]);
        for n in names {
            r.write(n, "changed\n");
        }
        r.git(&["add", "--", "a b.txt"]);
        r.write("[new] *.txt", "untracked\n");
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let before = split(&r);
        let mut paths = strings(&names);
        paths.push("[new] *.txt".into());
        let snap = create(&cx, "x", &paths, &strings(&["[new] *.txt"])).await.unwrap();
        destroy(&r);
        restore(&cx, &snap).await.unwrap();
        assert_eq!(split(&r), before);
        assert_eq!(std::fs::read_to_string(r.path().join("[new] *.txt")).unwrap(), "untracked\n");
    }

    #[tokio::test]
    async fn refuses_a_conflicted_path() {
        let r = TestRepo::new();
        r.write("f.txt", "base\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.git(&["checkout", "-q", "-b", "other"]);
        r.write("f.txt", "other\n");
        r.git(&["commit", "-qam", "other"]);
        r.git(&["checkout", "-q", "-"]);
        r.write("f.txt", "mine\n");
        r.git(&["commit", "-qam", "mine"]);
        let _ = std::process::Command::new("git").current_dir(r.path()).args(["merge", "other"]).output();
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let err = create(&cx, "x", &strings(&["f.txt"]), &[]).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InProgress);
        assert!(err.message.contains("resolve conflicts"));
    }

    /// 3B T2: `restore` refuses a conflicted path of P; `restore_with(unmerged_ok)` clears its
    /// stages and restores it.
    #[tokio::test]
    async fn only_restore_with_unmerged_ok_restores_over_a_conflicted_path() {
        let r = TestRepo::new();
        r.write("f.txt", "base\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.git(&["checkout", "-q", "-b", "other"]);
        r.write("f.txt", "other\n");
        r.git(&["commit", "-qam", "other"]);
        r.git(&["checkout", "-q", "-"]);
        r.write("f.txt", "mine\n");
        r.git(&["commit", "-qam", "mine"]);
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["f.txt"]), &[]).await.unwrap();
        let _ = std::process::Command::new("git").current_dir(r.path()).args(["merge", "other"]).output();
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "f.txt");
        let err = restore(&cx, &snap).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InProgress);
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "f.txt", "refused before writing");
        restore_with(&cx, &snap, true).await.unwrap();
        assert_eq!(r.git(&["diff", "--name-only", "--diff-filter=U"]), "");
        assert_eq!(r.git(&["ls-files", "-s", "f.txt"]).split_whitespace().nth(2), Some("0"), "stage 0 only");
        assert_eq!(std::fs::read_to_string(r.path().join("f.txt")).unwrap(), "mine\n");
        assert_eq!(r.git(&["diff", "HEAD", "--name-only"]), "");
    }

    /// Intent-to-add degrades: the file comes back with its content as an untracked file.
    #[tokio::test]
    async fn intent_to_add_degrades_to_untracked() {
        let r = TestRepo::new();
        r.write("base.txt", "b\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.write("n.txt", "content\n");
        r.git(&["add", "-N", "n.txt"]);
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["n.txt"]), &[]).await.unwrap();
        std::fs::remove_file(r.path().join("n.txt")).unwrap();
        r.git(&["rm", "-q", "--cached", "n.txt"]);
        restore(&cx, &snap).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("n.txt")).unwrap(), "content\n");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "");
        assert_eq!(r.git(&["ls-files", "--others", "--exclude-standard"]), "n.txt");
    }

    #[tokio::test]
    async fn untracked_directories_and_ignored_files_round_trip() {
        let r = TestRepo::new();
        r.write(".gitignore", "*.log\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.write("dir/one.txt", "1\n");
        r.write("dir/sub/two.txt", "2\n");
        r.write("x.log", "ignored\n");
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let list = strings(&["dir", "x.log"]);
        let snap = create(&cx, "clean -x", &list, &list).await.unwrap();
        let files = strings(&["dir/one.txt", "dir/sub/two.txt", "x.log"]);
        assert_eq!((&snap.paths, &snap.untracked), (&files, &files), "P holds files only (2A final I3)");
        std::fs::remove_dir_all(r.path().join("dir")).unwrap();
        std::fs::remove_file(r.path().join("x.log")).unwrap();
        restore(&cx, &snap).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("dir/sub/two.txt")).unwrap(), "2\n");
        assert_eq!(std::fs::read_to_string(r.path().join("dir/one.txt")).unwrap(), "1\n");
        assert_eq!(std::fs::read_to_string(r.path().join("x.log")).unwrap(), "ignored\n");
    }

    /// 2A final I3: a tracked directory stands for its index entries; a worktree-only one that
    /// isn't in `untracked` (the op doesn't delete it) holds nothing of P.
    #[tokio::test]
    async fn a_tracked_directory_is_its_index_entries() {
        let r = TestRepo::new();
        r.write("src/a.txt", "a\n");
        r.write("src/deep/b.txt", "b\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.write("src/a.txt", "changed\n");
        r.write("src/new.txt", "untracked, kept\n");
        r.write("loose/c.txt", "untracked\n");
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "checkout -- src", &strings(&["src", "loose"]), &[]).await.unwrap();
        assert_eq!(snap.paths, strings(&["src/a.txt", "src/deep/b.txt"]));
        assert!(snap.untracked.is_empty());
        r.git(&["checkout", "--", "src"]);
        restore(&cx, &snap).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("src/a.txt")).unwrap(), "changed\n");
        assert_eq!(std::fs::read_to_string(r.path().join("src/new.txt")).unwrap(), "untracked, kept\n");
    }

    #[tokio::test]
    async fn restore_tolerates_a_directory_where_a_path_was_absent() {
        let r = dirty_repo();
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["a.txt", "d.txt"]), &[]).await.unwrap();
        r.write("d.txt/inner.txt", "now a dir\n");
        restore(&cx, &snap).await.unwrap();
        assert!(r.path().join("d.txt/inner.txt").exists());
    }

    // --- 2B T4 ---
    /// Review M5: a path whose metadata can't be read (permission denied) fails the snapshot;
    /// only "not found" and "not a directory" mean no file.
    #[cfg(unix)] // permission bits (Windows has none; git keeps the executable bit in the index)
    #[tokio::test]
    async fn an_unreadable_path_fails_the_snapshot() {
        let r = TestRepo::new();
        r.write("locked/f.txt", "f\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        crate::platform::fs::set_mode(r.path().join("locked"), 0o000).unwrap();
        let res = create(&cx, "x", &strings(&["locked/f.txt"]), &[]).await;
        crate::platform::fs::set_mode(r.path().join("locked"), 0o755).unwrap();
        assert!(res.is_err(), "{res:?}");
    }

    /// Review I2: permission bits come back exactly, under `core.fileMode=false` too.
    #[cfg(unix)] // permission bits (Windows has none; git keeps the executable bit in the index)
    #[tokio::test]
    async fn permission_bits_round_trip() {
        let r = TestRepo::new();
        r.git(&["config", "core.fileMode", "false"]);
        r.write("t.sh", "tracked\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.write("u.txt", "untracked secret\n");
        let mode = |p: &str| crate::platform::fs::mode(&std::fs::metadata(r.path().join(p)).unwrap()) & 0o7777;
        let set = |p: &str, m: u32| crate::platform::fs::set_mode(r.path().join(p), m).unwrap();
        set("t.sh", 0o750);
        set("u.txt", 0o600);
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["t.sh", "u.txt"]), &strings(&["u.txt"])).await.unwrap();
        set("t.sh", 0o644);
        std::fs::remove_file(r.path().join("u.txt")).unwrap();
        restore(&cx, &snap).await.unwrap();
        assert_eq!((mode("t.sh"), mode("u.txt")), (0o750, 0o600));
        // A journal written before the field still loads.
        let old: Snapshot = serde_json::from_str(r#"{"commit":"w","paths":[],"untracked":[]}"#).unwrap();
        assert!(old.modes.is_empty());
    }

    /// Review I1: a gitlink in P snapshots and restores (its commit isn't in this repository).
    #[tokio::test]
    async fn a_gitlink_in_p_snapshots_and_restores() {
        let r = TestRepo::new();
        r.commit("base");
        let inner = r.path().join("emb");
        std::fs::create_dir_all(&inner).unwrap();
        r.git_in(&inner, &["init", "-q"]);
        std::fs::write(inner.join("e.txt"), "e\n").unwrap();
        r.git_in(&inner, &["add", "."]);
        r.git_in(&inner, &["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "inner"]);
        r.git(&["add", "emb"]);
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let staged = r.git(&["ls-files", "-s", "emb"]);
        let snap = create(&cx, "x", &strings(&["emb"]), &[]).await.unwrap();
        r.git(&["rm", "-q", "-f", "--cached", "emb"]);
        restore(&cx, &snap).await.unwrap();
        assert_eq!(r.git(&["ls-files", "-s", "emb"]), staged);
        assert!(inner.join("e.txt").exists() && inner.join(".git").exists());
    }
    // --- end 2B T4 ---

    // --- 2C repo-safety ---
    /// 2B T4 re-review N5: a repository standing where a file of the snapshot goes back is
    /// refused in words by the restore itself, and nothing changes.
    #[tokio::test]
    async fn restore_refuses_a_repository_standing_at_a_snapshot_path() {
        let r = dirty_repo();
        let tmp = tempfile::tempdir().unwrap();
        let (cli, token) = (cli(), WriteToken::for_tests());
        let cx = SnapshotCx { cli: &cli, token: &token, root: r.path(), tmp: tmp.path() };
        let snap = create(&cx, "x", &strings(&["a.txt", "c.txt"]), &strings(&["c.txt"])).await.unwrap();
        destroy(&r);
        std::fs::create_dir(r.path().join("c.txt")).unwrap();
        r.git_in(&r.path().join("c.txt"), &["init", "-q"]);
        let before = split(&r);
        let err = restore(&cx, &snap).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "c.txt is a repository in the way of the restore: move it first"));
        assert_eq!(split(&r), before, "nothing changed");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a1\n", "W wasn't checked out either");
        assert!(r.path().join("c.txt/.git").is_dir());
    }
    // --- end 2C repo-safety ---
}
