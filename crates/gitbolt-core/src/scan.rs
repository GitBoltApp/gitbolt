//! "Your repos" (spec §13): repositories in a folder the user picks, two levels deep. Pure and
//! synchronous; the caller (`W2-A`'s `api.rs`) runs it on the blocking pool and caches it per root.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScannedRepo {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    #[ts(type = "number")]
    pub modified: i64,
}

/// `.git` directory, or the directory a `.git` file (`gitdir: …`) points to (a linked worktree or
/// a submodule checkout). `None` when `dir` isn't a git repository at all.
fn git_dir(dir: &Path) -> Option<PathBuf> {
    let dot = dir.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let target = PathBuf::from(text.strip_prefix("gitdir:")?.trim());
    Some(if target.is_absolute() { target } else { dir.join(target) })
}

fn mtime(p: &Path) -> i64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn describe(dir: &Path, gd: &Path) -> ScannedRepo {
    let branch = std::fs::read_to_string(gd.join("HEAD")).ok().and_then(|h| h.trim().strip_prefix("ref: refs/heads/").map(String::from));
    let modified = ["index", "HEAD", "logs/HEAD"].iter().map(|f| mtime(&gd.join(f))).max().unwrap_or(0);
    ScannedRepo { path: dir.display().to_string(), name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), branch, modified }
}

/// Non-hidden subdirectories of `dir`, in no particular order. A directory that can't be read
/// (permissions, or it's gone) contributes nothing rather than failing the whole scan.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect()
}

/// Every repository under `root`, at depth 1 or 2 (a repo at depth 1 isn't also searched for
/// nested repos: `git` itself doesn't nest working copies that way, and it would be surprising to
/// list a repo's own subdirectory as a second entry). Hidden directories (`.cache`, `.git` of a
/// repo already found, …) are never descended into. Newest first by `modified`, ties broken by
/// name so the order is stable.
pub fn scan_repos(root: &Path) -> Vec<ScannedRepo> {
    let mut found = Vec::new();
    for d1 in subdirs(root) {
        if let Some(gd) = git_dir(&d1) {
            found.push(describe(&d1, &gd));
            continue;
        }
        for d2 in subdirs(&d1) {
            if let Some(gd) = git_dir(&d2) {
                found.push(describe(&d2, &gd));
            }
        }
    }
    found.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    found
}

/// The per-folder scans as one list: de-duplicated by path (folders may overlap), sorted as a
/// single scan is.
pub fn merge_scans(scans: impl IntoIterator<Item = Vec<ScannedRepo>>) -> Vec<ScannedRepo> {
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<ScannedRepo> = scans.into_iter().flatten().filter(|r| seen.insert(r.path.clone())).collect();
    all.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    all
}

/// `~/repos`, when it exists: the "Open Repository" screen's suggested default folder.
pub fn suggest_repos_folder(home: Option<&Path>) -> Option<String> {
    let p = home?.join("repos");
    p.is_dir().then(|| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestRepo;

    #[test]
    fn scans_two_levels_newest_first_without_descending_into_repos() {
        let root = tempfile::tempdir().unwrap();
        let a = TestRepo::init_at(&root.path().join("alpha")); // root/alpha/repo (depth 2)
        a.commit("a");
        let b = TestRepo::init_at(&root.path().join("group/beta")); // root/group/beta/repo (depth 3): too deep
        b.commit("b");
        std::fs::create_dir_all(root.path().join(".hidden/repo/.git")).unwrap(); // hidden dirs are skipped
        let found = scan_repos(root.path());
        let names: Vec<&str> = found.iter().map(|r| r.path.as_str()).collect();
        assert!(names.iter().any(|p| p.ends_with("alpha/repo")), "{names:?}");
        assert!(!names.iter().any(|p| p.contains("group/beta")), "{names:?}");
        assert!(!names.iter().any(|p| p.contains(".hidden")), "{names:?}");
        assert!(found.iter().all(|r| r.branch.as_deref() == Some("main")));
        assert!(found.windows(2).all(|w| w[0].modified >= w[1].modified));
    }

    #[test]
    fn merged_scans_dedupe_by_path_and_sort_like_one_scan() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        TestRepo::init_at(&a.path().join("one")).commit("1");
        TestRepo::init_at(&b.path().join("two")).commit("2");
        let (sa, sb) = (scan_repos(a.path()), scan_repos(b.path()));
        let merged = merge_scans([sa.clone(), sb.clone(), sa.clone()]);
        assert_eq!(merged.len(), 2, "{merged:?}");
        assert!(merged.windows(2).all(|w| w[0].modified >= w[1].modified));
        assert!(merge_scans(Vec::<Vec<ScannedRepo>>::new()).is_empty());
    }

    #[test]
    fn a_repo_isnt_also_searched_for_nested_repos() {
        let root = tempfile::tempdir().unwrap();
        let a = TestRepo::init_at(&root.path().join("alpha")); // root/alpha/repo, a repo at depth 2
        a.commit("a");
        // A nested checkout inside that same repo's working tree (depth 3 from root): not listed.
        TestRepo::init_at(&root.path().join("alpha/repo/vendor"));
        let found = scan_repos(root.path());
        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("alpha/repo"));
    }

    #[test]
    fn suggests_repos_folder_only_when_it_exists() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(suggest_repos_folder(Some(home.path())), None);
        std::fs::create_dir(home.path().join("repos")).unwrap();
        assert_eq!(suggest_repos_folder(Some(home.path())), Some(home.path().join("repos").display().to_string()));
        assert_eq!(suggest_repos_folder(None), None);
    }
}
