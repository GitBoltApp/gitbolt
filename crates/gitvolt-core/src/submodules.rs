//! Submodules, for repositories that use them: which worktrees use them (the UI offers its
//! submodule actions only there) and `git submodule status`, for the "Open in a tab" picker. The
//! writes (update, sync) are `write::submodules`.

use crate::api::Api;
use crate::error::{gix_err, GbError};
use crate::git::GitInvocation;
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

/// One line of `git submodule status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SubmoduleStatus {
    /// Checked out at the recorded commit (` `).
    Current,
    /// Checked out at another commit (`+`).
    NewCommits,
    /// Not initialised (`-`).
    Uninitialized,
    /// Conflicted in the index (`U`).
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmoduleInfo {
    /// Relative to the worktree.
    pub path: String,
    /// The commit checked out, or the one recorded when it isn't initialised.
    pub commit: String,
    pub status: SubmoduleStatus,
}

/// The gitlinks in `root`'s index: each path, with the commit it records.
pub(crate) fn gitlinks(root: &Path) -> Result<Vec<(String, String)>, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    Ok(index
        .entries()
        .iter()
        .filter(|e| e.mode == gix::index::entry::Mode::COMMIT)
        .map(|e| (e.path(&index).to_string(), e.id.to_string()))
        .collect())
}

/// A worktree that uses submodules (a `.gitmodules` file or a gitlink in its index).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmoduleSupport {
    /// Gitlinks `.gitmodules` doesn't map (an embedded repository added without one): git's
    /// submodule commands refuse the whole worktree while there's one.
    pub unmapped: Vec<String>,
}

/// Whether the worktree at `root` uses submodules, and which of its gitlinks git's submodule
/// commands can't handle. `None`: it uses none. Reads the index: call it off the runtime.
pub fn support(root: &Path) -> Option<SubmoduleSupport> {
    let repo = gix::open(root).ok()?;
    let links = gitlinks(root).ok()?;
    if links.is_empty() && !root.join(".gitmodules").is_file() {
        return None;
    }
    let mapped: Vec<String> = repo.submodules().ok().flatten().map(|subs| subs.filter_map(|s| s.path().ok().map(|p| p.to_string())).collect()).unwrap_or_default();
    Some(SubmoduleSupport { unmapped: links.into_iter().map(|(p, _)| p).filter(|p| !mapped.contains(p)).collect() })
}

/// `git submodule status` lines, matched to the gitlinks' `paths` (the line's text after the
/// commit is the path, then git's ` (describe)` when there is one): a state character, the
/// commit, the path. A line no gitlink matches is left out.
pub fn parse_status(out: &str, paths: &[String]) -> Vec<SubmoduleInfo> {
    out.lines()
        .filter_map(|line| {
            let status = match line.chars().next()? {
                ' ' => SubmoduleStatus::Current,
                '+' => SubmoduleStatus::NewCommits,
                '-' => SubmoduleStatus::Uninitialized,
                'U' => SubmoduleStatus::Conflicted,
                _ => return None,
            };
            let (commit, rest) = line[1..].split_once(' ')?;
            let path = paths.iter().filter(|p| rest == p.as_str() || rest.strip_prefix(p.as_str()).is_some_and(|d| d.starts_with(" ("))).max_by_key(|p| p.len())?;
            Some(SubmoduleInfo { path: path.clone(), commit: commit.to_string(), status })
        })
        .collect()
}

impl Api {
    /// `git submodule status` in `worktree`, one entry per gitlink of its index. A read: git
    /// takes no optional lock.
    pub(crate) async fn submodules(&self, repo: u32, worktree: &str) -> Result<Vec<SubmoduleInfo>, GbError> {
        let h = self.handle(repo)?;
        let root = self.worktree_dir(&h, worktree).await?;
        let r = root.clone();
        let paths: Vec<String> = crate::api::blocking(move || gitlinks(&r)).await?.into_iter().map(|(p, _)| p).collect();
        let out = self.cli.run(GitInvocation::new(&root, ["submodule", "status"])).await?;
        Ok(parse_status(&String::from_utf8_lossy(&out.stdout), &paths))
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};
    use serde_json::json;

    #[test]
    fn parses_each_state_and_matches_the_gitlinks_paths() {
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        // `vendor/x (old)` is a path of its own: the longest gitlink that fits wins, and a line no
        // gitlink matches is left out.
        let out = format!(" {a} vendor/parser (heads/main)\n+{b} vendor/two words\n-{a} vendor/theme\nU{b} vendor/x (old) (v1.0-2-gabc)\n+{b} elsewhere/unknown\n");
        let paths: Vec<String> = ["vendor/parser", "vendor/two words", "vendor/theme", "vendor/x", "vendor/x (old)"].map(String::from).to_vec();
        let list = parse_status(&out, &paths);
        let got: Vec<(&str, &str, SubmoduleStatus)> = list.iter().map(|s| (s.path.as_str(), s.commit.as_str(), s.status)).collect();
        assert_eq!(got, vec![
            ("vendor/parser", a.as_str(), SubmoduleStatus::Current),
            ("vendor/two words", b.as_str(), SubmoduleStatus::NewCommits),
            ("vendor/theme", a.as_str(), SubmoduleStatus::Uninitialized),
            ("vendor/x (old)", b.as_str(), SubmoduleStatus::Conflicted),
        ]);
    }

    #[tokio::test]
    async fn lists_each_submodule_with_its_state_and_writes_nothing() {
        use crate::write::test_support::{api, open, wt};
        let r = TestRepo::new();
        fixtures::submodules(&r);
        let parser = r.path().join("vendor/parser");
        r.git_in(&parser, &["checkout", "-q", "HEAD~1"]);
        let older = r.git_in(&parser, &["rev-parse", "HEAD"]);
        let theme = r.git(&["rev-parse", "HEAD:vendor/theme"]);
        let index = std::fs::read(r.path().join(".git/index")).unwrap();
        let data = tempfile::tempdir().unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let list = api.submodules(id, &wt(r.path())).await.unwrap();
        assert_eq!(list, vec![
            SubmoduleInfo { path: "vendor/parser".into(), commit: older, status: SubmoduleStatus::NewCommits },
            SubmoduleInfo { path: "vendor/theme".into(), commit: theme, status: SubmoduleStatus::Uninitialized },
        ]);
        assert_eq!(std::fs::read(r.path().join(".git/index")).unwrap(), index, "a read");
        let info = api.dispatch(crate::api::Request::RepoInfo { repo: id }).await.unwrap();
        assert_eq!(info["submodules"], json!({ wt(r.path()): {"unmapped": []} }));
    }

    #[test]
    fn a_worktree_uses_submodules_with_a_gitmodules_file_or_a_gitlink() {
        let plain = TestRepo::new();
        plain.commit("one");
        assert_eq!(support(plain.path()), None);

        let r = TestRepo::new();
        fixtures::submodules(&r);
        assert_eq!(support(r.path()), Some(SubmoduleSupport::default()));

        // An embedded repository staged without a `.gitmodules`: a gitlink git's submodule
        // commands refuse.
        let e = TestRepo::new();
        e.commit("one");
        let inner = e.path().join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        e.git_in(&inner, &["init", "-q", "-b", "main"]);
        std::fs::write(inner.join("x.txt"), "x\n").unwrap();
        e.git_in(&inner, &["add", "x.txt"]);
        e.git_in(&inner, &["commit", "-q", "-m", "inner"]);
        e.git(&["add", "inner"]);
        assert!(!e.path().join(".gitmodules").exists());
        assert_eq!(support(e.path()), Some(SubmoduleSupport { unmapped: vec!["inner".into()] }));
    }

    /// Per worktree: a linked worktree whose branch has submodules, beside a main one without.
    #[tokio::test]
    async fn repo_info_names_each_worktree_that_uses_submodules() {
        let r = TestRepo::new();
        r.commit("one");
        r.switch_new("with-subs");
        r.write(".gitmodules", "[submodule \"vendor/x\"]\n\tpath = vendor/x\n\turl = ../x-src\n");
        r.git(&["add", ".gitmodules"]);
        r.git(&["commit", "-q", "-m", "gitmodules"]);
        r.switch("main");
        let linked = r.add_worktree("subs", "with-subs");
        let repo = gix::ThreadSafeRepository::open(r.path()).unwrap();
        let info = crate::shelldata::repo_info(&repo, r.path()).await.unwrap();
        let canonical = crate::platform::fs::canonicalize(&linked).unwrap().display().to_string();
        assert_eq!(info.submodules.into_iter().collect::<Vec<_>>(), vec![(canonical, SubmoduleSupport::default())]);
    }
}
