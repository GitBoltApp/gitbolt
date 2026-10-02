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
use gix::bstr::ByteSlice;
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
    use gix::index::entry::Flags;
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let want: BTreeSet<&[u8]> = paths.iter().map(|p| p.as_bytes()).collect();
    for e in index.entries() {
        let path = e.path(&index);
        if !want.contains(path.as_bytes()) {
            continue;
        }
        if e.stage_raw() != 0 {
            return Err(GbError::new(GbErrorKind::InProgress, format!("{path} has merge conflicts: resolve conflicts first")));
        }
        if e.flags.contains(Flags::SKIP_WORKTREE) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is skip-worktree: a snapshot can't carry it")));
        }
    }
    Ok(())
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
                if !repo.has_object(e.object_id()) {
                    return Err(missing());
                }
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
            (false, false) => under.into_iter().cloned().collect(),
            (false, true) if is_dir(p) => Vec::new(),
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
    let add: Vec<&String> = tracked.iter().copied().filter(|p| in_i.contains(p.as_str()) || cx.root.join(p).symlink_metadata().is_ok()).collect();
    if !add.is_empty() {
        cx.cli.run(cx.indexed(&ti, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"]).stdin(nul_list(add))).await?;
    }
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
    Ok(Snapshot { commit: w, paths: paths.to_vec(), untracked: untracked.to_vec() })
}

/// W's tree, I's tree and U's tree (if any).
fn trees(root: &Path, snap: &Snapshot) -> Result<(String, String, Option<String>), GbError> {
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
    // Preflight: everything that can be checked without writing is, before anything is written.
    let (w_tree, i_tree, u_tree) = trees(cx.root, snap)?;
    let tracked: Vec<&String> = snap.paths.iter().filter(|p| !snap.untracked.contains(p)).collect();
    let untracked: Vec<&String> = snap.untracked.iter().collect();
    check_index(cx.root, &tracked)?;
    let (index_lines, _) = tree_info(cx.root, &i_tree, &tracked)?;
    let (_, in_w) = tree_info(cx.root, &w_tree, &tracked)?;
    let in_u = match &u_tree {
        Some(u) => tree_present(cx.root, u, &untracked)?,
        None => BTreeSet::new(),
    };
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
        use std::os::unix::fs::PermissionsExt;
        let r = dirty_repo();
        let counter = r.path().join("gpg-count");
        let fake = r.path().join("fake-gpg");
        std::fs::write(&fake, format!("#!/bin/sh\necho sign >> '{}'\nexit 1\n", counter.display())).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
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
}
