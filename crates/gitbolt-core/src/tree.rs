//! Every file in a commit's tree ("View all files", spec §9.3; the palette's `/` files, §11.2).

use crate::details::read_commit;
use crate::error::{gix_err, GbError};
use gix::bstr::ByteSlice;
use gix::ObjectId;
use serde::Serialize;
use ts_rs::TS;

pub fn tree_files(repo: &gix::Repository, commit: ObjectId) -> Result<Vec<String>, GbError> {
    // `read_commit` gives the same classification the rest of the API relies on: a missing
    // object is `NotFound`, an object that isn't a commit is `InvalidInput`. Everything past this
    // point is expected to succeed, since `commit` is now known to be a real commit.
    read_commit(repo, commit)?;
    let tree = repo.find_commit(commit).map_err(gix_err)?.tree().map_err(gix_err)?;
    let mut recorder = gix::traverse::tree::Recorder::default();
    tree.traverse().breadthfirst(&mut recorder).map_err(gix_err)?;
    let mut paths: Vec<String> = recorder.records.into_iter().filter(|e| !e.mode.is_tree()).map(|e| e.filepath.to_str_lossy().into_owned()).collect();
    paths.sort();
    Ok(paths)
}

/// UX G.2: the worktree's tracked files ("View all files" on the WIP row): its index's paths,
/// sorted bytewise, each once (a conflicted path's stages are one), submodules left out (there's
/// no file to show). Untracked files are the WIP sections' own.
pub fn worktree_files(root: &std::path::Path) -> Result<Vec<String>, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let mut paths: Vec<String> = index
        .entries()
        .iter()
        .filter(|e| e.mode != gix::index::entry::Mode::COMMIT)
        .map(|e| e.path(&index).to_str_lossy().into_owned())
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// What a path in a worktree is (Ctrl+V's go-to, for a pasted path): a file (a symlink too, as
/// git sees it) or a folder. Untracked ones count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PathKind {
    File,
    Dir,
}

/// What `rel` is in the worktree at `root`, from its metadata alone (the file isn't read);
/// `None` when nothing is there. A path outside the worktree or into `.git` is `InvalidInput`
/// (`safe_join`).
pub fn path_kind(root: &std::path::Path, rel: &str) -> Result<Option<PathKind>, GbError> {
    let path = match crate::blob::safe_join(root, rel) {
        Ok(p) => p,
        Err(e) if e.kind == crate::error::GbErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => Some(PathKind::Dir),
        Ok(_) => Some(PathKind::File),
        Err(_) => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GbErrorKind;
    use crate::testing::{fixtures, TestRepo};

    #[test]
    fn lists_every_file_at_a_commit_sorted() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap();
        let rename = ObjectId::from_hex(r.git(&["rev-parse", "HEAD^1"]).as_bytes()).unwrap();
        assert_eq!(
            tree_files(&repo, rename).unwrap(),
            vec!["big.txt", "crlf.txt", "data.bin", "dir with space/\u{fc}n\u{ef}.txt", "docs/manual.txt", "icon.svg", "latin1.txt", "logo.png", "src/app.php", "utf16.txt", "ws.txt"]
        );
        let head = ObjectId::from_hex(r.git(&["rev-parse", "HEAD"]).as_bytes()).unwrap();
        assert!(tree_files(&repo, head).unwrap().contains(&"feature.txt".to_string()));
    }

    #[test]
    fn worktree_files_are_the_index_paths_without_untracked_files() {
        let r = TestRepo::new();
        r.write("b/x.txt", "x\n");
        r.write("a.txt", "a\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "one"]);
        r.write("staged.txt", "s\n");
        r.git(&["add", "staged.txt"]);
        r.write("untracked.txt", "u\n");
        assert_eq!(worktree_files(r.path()).unwrap(), vec!["a.txt", "b/x.txt", "staged.txt"]);
    }

    #[test]
    fn path_kind_tells_files_from_folders_untracked_ones_too_and_stays_in_the_worktree() {
        let r = TestRepo::new();
        r.commit("one");
        r.write("new/dir/u.txt", "u\n");
        assert_eq!(path_kind(r.path(), "file_0.txt").unwrap(), Some(PathKind::File));
        assert_eq!(path_kind(r.path(), "new/dir/u.txt").unwrap(), Some(PathKind::File));
        assert_eq!(path_kind(r.path(), "new/dir").unwrap(), Some(PathKind::Dir));
        assert_eq!(path_kind(r.path(), "nope.txt").unwrap(), None);
        assert_eq!(path_kind(r.path(), "nope/deeper.txt").unwrap(), None);
        assert_eq!(path_kind(r.path(), "../outside").unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(path_kind(r.path(), ".git/config").unwrap_err().kind, GbErrorKind::InvalidInput);
    }

    #[test]
    fn missing_commit_is_not_found() {
        let r = TestRepo::new();
        r.commit("c");
        let repo = gix::open(r.path()).unwrap();
        let err = tree_files(&repo, ObjectId::from_hex("1".repeat(40).as_bytes()).unwrap()).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
    }

    #[test]
    fn non_commit_object_is_invalid_input() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap();
        let blob = ObjectId::from_hex(r.git(&["rev-parse", "HEAD:feature.txt"]).as_bytes()).unwrap();
        assert_eq!(tree_files(&repo, blob).unwrap_err().kind, GbErrorKind::InvalidInput);
    }
}
