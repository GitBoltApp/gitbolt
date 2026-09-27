//! Worktree list via `git worktree list --porcelain -z`.

use crate::error::GbError;
use crate::git::{GitCli, GitInvocation};
use gix::ObjectId;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    pub head: Option<ObjectId>,
    pub branch: Option<String>,
    pub is_main: bool,
    pub bare: bool,
    pub prunable: bool,
}

pub fn parse_worktree_list(out: &[u8]) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for field in out.split(|b| *b == 0) {
        if field.is_empty() {
            if let Some(wt) = cur.take() {
                list.push(wt);
            }
            continue;
        }
        let field = String::from_utf8_lossy(field);
        let (key, value) = field.split_once(' ').unwrap_or((&field, ""));
        match key {
            "worktree" => {
                if let Some(wt) = cur.take() {
                    list.push(wt);
                }
                cur = Some(Worktree { path: PathBuf::from(value), head: None, branch: None, is_main: list.is_empty(), bare: false, prunable: false });
            }
            "HEAD" => if let Some(wt) = cur.as_mut() { wt.head = ObjectId::from_hex(value.as_bytes()).ok() },
            "branch" => if let Some(wt) = cur.as_mut() { wt.branch = Some(value.to_string()) },
            "bare" => if let Some(wt) = cur.as_mut() { wt.bare = true },
            "prunable" => if let Some(wt) = cur.as_mut() { wt.prunable = true },
            _ => {}
        }
    }
    if let Some(wt) = cur {
        list.push(wt);
    }
    list
}

pub async fn list_worktrees(cli: &GitCli, cwd: &Path) -> Result<Vec<Worktree>, GbError> {
    let out = cli.run(GitInvocation::new(cwd, ["worktree", "list", "--porcelain", "-z"])).await?;
    Ok(parse_worktree_list(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    #[test]
    fn parses_porcelain_z() {
        let sha = "a".repeat(40);
        let raw = format!("worktree /r/main\0HEAD {sha}\0branch refs/heads/main\0\0worktree /r/wt x\0HEAD {sha}\0detached\0prunable gitdir file points to non-existent location\0\0");
        let wts = parse_worktree_list(raw.as_bytes());
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_main && !wts[1].is_main);
        assert_eq!(wts[0].branch.as_deref(), Some("refs/heads/main"));
        assert_eq!(wts[1].path, PathBuf::from("/r/wt x"));
        assert_eq!(wts[1].branch, None);
        assert!(wts[1].prunable);
    }

    #[tokio::test]
    async fn lists_fixture_worktrees() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let cli = GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env());
        let wts = list_worktrees(&cli, r.path()).await.unwrap();
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[1].branch.as_deref(), Some("refs/heads/hotfix"));
        assert!(wts[1].path.ends_with("wt-hotfix"));
        assert!(wts[1].head.is_some());
    }
}
