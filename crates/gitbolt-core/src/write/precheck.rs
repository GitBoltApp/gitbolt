//! Read-only pre-checks (spec #2 §3.4, §6).
//!
//! Which paths an operation touches, which are dirty, and whether restoring an autostash would
//! conflict. They never write to the repository: gix reads, `git status` with the never-write
//! environment, and `git merge-file -p` on temp copies (Deviation 3).

use crate::error::{gix_err, GbError};
use crate::git::{GitCli, GitInvocation};
use crate::status::{parse_porcelain_v2, status_raw, EntryKind};
use gix::ObjectId;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;

/// The file paths that differ between two commits' trees (rename detection off).
pub(crate) fn tree_diff_paths(repo: &gix::Repository, from: ObjectId, to: ObjectId) -> Result<BTreeSet<String>, GbError> {
    let tree = |c: ObjectId| -> Result<gix::Tree<'_>, GbError> { repo.find_commit(c).map_err(gix_err)?.tree().map_err(gix_err) };
    let (a, b) = (tree(from)?, tree(to)?);
    let mut state = gix::diff::tree::State::default();
    let mut recorder = gix::diff::tree::Recorder::default();
    gix::diff::tree(gix::objs::TreeRefIter::from_bytes(&a.data, from.kind()), gix::objs::TreeRefIter::from_bytes(&b.data, to.kind()), &mut state, &repo.objects, &mut recorder).map_err(gix_err)?;
    Ok(recorder
        .records
        .iter()
        .filter_map(|c| {
            use gix::diff::tree::recorder::Change as C;
            let (path, mode) = match c {
                C::Addition { path, entry_mode, .. } | C::Deletion { path, entry_mode, .. } | C::Modification { path, entry_mode, .. } => (path, entry_mode),
            };
            (!mode.is_tree()).then(|| String::from_utf8_lossy(path).into_owned())
        })
        .collect())
}

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
    let sides: Vec<Sides> = {
        let repo = gix::open(root).map_err(gix_err)?;
        let head = repo.head_commit().ok().and_then(|c| c.tree().ok());
        let theirs_tree = repo.find_commit(target).map_err(gix_err)?.tree().map_err(gix_err)?;
        paths.iter().map(|p| (p.clone(), blob(&repo, head.as_ref(), p), blob(&repo, Some(&theirs_tree), p))).collect()
    };
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
    Ok(out)
}

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
                use std::os::unix::fs::PermissionsExt;
                regular.push((i, if m.permissions().mode() & 0o111 != 0 { EntryKind::BlobExecutable } else { EntryKind::Blob }));
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
        .filter(|((_, w), have)| w.index != w.have_index || norm(w.file) != norm(*have))
        .map(|((p, _), _)| p.clone())
        .collect())
}

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
}
