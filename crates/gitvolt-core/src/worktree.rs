//! The worktree list, read in process (what `git worktree list --porcelain -z` prints).

use crate::error::{gix_err, GbError};
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
    /// git's `locked` porcelain line (with or without a reason).
    pub locked: bool,
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
                cur = Some(Worktree { path: crate::platform::fs::from_git_path(value), head: None, branch: None, is_main: list.is_empty(), bare: false, prunable: false, locked: false });
            }
            "HEAD" => if let Some(wt) = cur.as_mut() { wt.head = ObjectId::from_hex(value.as_bytes()).ok().filter(|id| !id.is_null()) },
            "branch" => if let Some(wt) = cur.as_mut() { wt.branch = Some(value.to_string()) },
            "bare" => if let Some(wt) = cur.as_mut() { wt.bare = true },
            "prunable" => if let Some(wt) = cur.as_mut() { wt.prunable = true },
            "locked" => if let Some(wt) = cur.as_mut() { wt.locked = true },
            _ => {}
        }
    }
    if let Some(wt) = cur {
        list.push(wt);
    }
    list
}

/// The repository's worktrees, as `git worktree list --porcelain` lists them, read in process
/// (no git process: this runs on every graph and sidebar refresh). `cwd` is any of its worktrees,
/// or its git dir.
pub async fn list_worktrees(cwd: &Path) -> Result<Vec<Worktree>, GbError> {
    let cwd = cwd.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let repo = gix::open_opts(&cwd, gix::open::Options::isolated().strict_config(false)).map_err(gix_err)?;
        read_worktrees(&repo)
    })
    .await
    .map_err(|e| GbError::other(format!("worktree list failed: {e}")))?
}

/// `list_worktrees` on an open repository (blocking). Like git: the main worktree first (the
/// common dir's real path without its `/.git`; `bare` per `core.bare`), then every
/// `<common>/worktrees/<id>` whose `gitdir` file names a checkout, by path. Each one's HEAD:
/// its branch (the symbolic ref it ends at) and the commit, `None` while unborn. `locked`:
/// a `locked` file; `prunable`: not locked, and its checkout's `.git` is gone.
pub fn read_worktrees(repo: &gix::Repository) -> Result<Vec<Worktree>, GbError> {
    let common = crate::platform::fs::canonicalize(repo.common_dir()).map_err(|e| GbError::new(crate::error::GbErrorKind::Io, format!("{}: {e}", repo.common_dir().display())))?;
    // The repository's own config file, read now (the handle's snapshot is from its opening).
    let config = gix::config::File::from_path_no_includes(common.join("config"), gix::config::Source::Local).ok();
    let bare = config.as_ref().and_then(|c| c.boolean("core.bare").ok().flatten()).unwrap_or(false);
    let mut list = Vec::new();
    let main_path = if bare { common.clone() } else { without_dot_git(&common) };
    let (head, branch) = if bare { (None, None) } else { head_of(repo, &common.join("HEAD")) };
    list.push(Worktree { path: main_path, head, branch, is_main: true, bare, prunable: false, locked: false });
    let mut linked = Vec::new();
    if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(raw) = std::fs::read(dir.join("gitdir")) else { continue };
            let text = String::from_utf8_lossy(&raw);
            let dot_git = text.trim_end();
            if dot_git.is_empty() {
                continue;
            }
            let dot_git = if Path::new(dot_git).is_absolute() { PathBuf::from(dot_git) } else { forgiving_realpath(&dir.join(dot_git)) };
            // (Windows: a relative one resolved above is spelled with `\`.)
            let path = match dot_git.to_str().and_then(|s| s.strip_suffix("/.git").or_else(|| s.strip_suffix("\\.git").filter(|_| cfg!(windows)))) {
                Some(p) => crate::platform::fs::from_git_path(p),
                None => dot_git.clone(),
            };
            let locked = dir.join("locked").symlink_metadata().is_ok();
            let prunable = !locked && dot_git.symlink_metadata().is_err();
            let (head, branch) = head_of(repo, &dir.join("HEAD"));
            linked.push(Worktree { path, head, branch, is_main: false, bare: false, prunable, locked });
        }
    }
    linked.sort_by(|a, b| a.path.as_os_str().as_encoded_bytes().cmp(b.path.as_os_str().as_encoded_bytes()));
    list.extend(linked);
    Ok(list)
}

/// git's `strbuf_strip_suffix(path, "/.git")`.
fn without_dot_git(p: &Path) -> PathBuf {
    match p.parent() {
        Some(parent) if p.file_name().is_some_and(|n| n == ".git") => parent.to_path_buf(),
        _ => p.to_path_buf(),
    }
}

/// A relative `gitdir` (`worktree.useRelativePaths`), resolved like git's
/// `strbuf_realpath_forgiving`: the longest existing prefix canonical, the rest as written.
fn forgiving_realpath(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = crate::platform::fs::canonicalize(&cur) {
            return rest.iter().rev().fold(c, |acc: PathBuf, part: &std::ffi::OsString| acc.join(part));
        }
        match (cur.file_name().map(|n| n.to_os_string()), cur.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                cur = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// A worktree's HEAD file: the commit it resolves to (`None` while unborn) and, when symbolic,
/// the ref it ends at.
fn head_of(repo: &gix::Repository, head_file: &Path) -> (Option<ObjectId>, Option<String>) {
    let Ok(raw) = std::fs::read(head_file) else { return (None, None) };
    let text = String::from_utf8_lossy(&raw);
    let text = text.trim();
    let Some(mut name) = text.strip_prefix("ref:").map(|n| n.trim().to_string()) else {
        return (ObjectId::from_hex(text.as_bytes()).ok().filter(|id| !id.is_null()), None);
    };
    // Follow symbolic refs to the last name (git's `resolve_ref_unsafe`).
    for _ in 0..5 {
        let Ok(Some(r)) = repo.try_find_reference(name.as_str()) else { return (None, Some(name)) };
        match r.target() {
            gix::refs::TargetRef::Symbolic(next) => name = next.as_bstr().to_string(),
            gix::refs::TargetRef::Object(id) => return (Some(id.to_owned()).filter(|id| !id.is_null()), Some(name)),
        }
    }
    (None, Some(name))
}

/// The same list from `git worktree list --porcelain -z`: the parity tests' reference, and the
/// one read when a repository opens (git's ownership check, `safe.directory`, applies to it).
pub(crate) async fn list_worktrees_cli(cli: &crate::git::GitCli, cwd: &Path) -> Result<Vec<Worktree>, GbError> {
    let out = cli.run(crate::git::GitInvocation::new(cwd, ["worktree", "list", "--porcelain", "-z"])).await?;
    Ok(parse_worktree_list(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::path::Path;
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
        let wts = list_worktrees(r.path()).await.unwrap();
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[1].branch.as_deref(), Some("refs/heads/hotfix"));
        assert!(wts[1].path.ends_with("wt-hotfix"));
        assert!(wts[1].head.is_some());
    }

    fn cli() -> crate::git::GitCli {
        crate::git::GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env())
    }

    /// The in-process list is `git worktree list`'s, from every worktree and the git dir.
    async fn assert_parity(r: &TestRepo, from: &[&Path]) {
        for cwd in from {
            let ours = list_worktrees(cwd).await.unwrap();
            let git = list_worktrees_cli(&cli(), cwd).await.unwrap();
            assert_eq!(ours, git, "from {}", cwd.display());
        }
        let _ = r;
    }

    #[tokio::test]
    async fn parity_on_the_fixtures() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        assert_parity(&r, &[r.path(), &r.root().join("wt-hotfix"), &r.path().join(".git")]).await;
        let r = TestRepo::new();
        fixtures::worktrees(&r);
        assert_parity(&r, &[r.path(), &r.root().join("wt-one")]).await;
    }

    /// Locked (with and without a reason), prunable (its folder deleted), detached, unborn
    /// (`--orphan`), a symref branch, names whose folder order isn't their path order, and a
    /// relative `gitdir`.
    #[tokio::test]
    async fn parity_on_every_kind_of_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let root = r.root();
        let p = |n: &str| root.join(n).to_str().unwrap().to_string();
        r.git(&["branch", "b-one"]);
        r.git(&["branch", "b-two"]);
        r.git(&["branch", "b-three"]);
        r.git(&["worktree", "add", "-q", &p("zz-locked"), "b-one"]);
        r.git(&["worktree", "lock", &p("zz-locked")]);
        r.git(&["worktree", "add", "-q", &p("aa-locked-why"), "b-two"]);
        r.git(&["worktree", "lock", "--reason", "on a usb disk", &p("aa-locked-why")]);
        r.git(&["worktree", "add", "-q", "--detach", &p("mm-detached"), "main"]);
        r.git(&["worktree", "add", "-q", &p("gone"), "b-three"]);
        std::fs::remove_dir_all(root.join("gone")).unwrap();
        r.git(&["worktree", "add", "-q", "--orphan", "-b", "fresh", &p("bb-unborn")]);
        r.git(&["-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "--detach", &p("rel"), "main"]);
        r.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
        r.git(&["worktree", "add", "-q", "--detach", &p("cc-sym"), "main"]);
        r.git_in(&root.join("cc-sym"), &["symbolic-ref", "HEAD", "refs/heads/alias"]);
        assert_parity(&r, &[r.path(), &root.join("mm-detached"), &root.join("rel")]).await;
        let ours = list_worktrees(r.path()).await.unwrap();
        let by = |n: &str| ours.iter().find(|w| w.path.ends_with(n)).unwrap().clone();
        assert!(by("zz-locked").locked && by("aa-locked-why").locked && by("gone").prunable);
        assert_eq!((by("bb-unborn").head, by("bb-unborn").branch.as_deref()), (None, Some("refs/heads/fresh")));
        assert_eq!(by("mm-detached").branch, None);
    }

    #[tokio::test]
    async fn parity_on_a_bare_repository_with_worktrees() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let bare = r.root().join("bare.git");
        r.git_in(r.root(), &["clone", "-q", "--bare", r.path().to_str().unwrap(), bare.to_str().unwrap()]);
        r.git_in(&bare, &["worktree", "add", "-q", r.root().join("from-bare").to_str().unwrap(), "hotfix"]);
        assert_parity(&r, &[&bare, &r.root().join("from-bare")]).await;
    }

    #[test]
    fn a_locked_worktree_is_marked_locked() {
        let out = b"worktree /r/main\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /r/wt-x\0HEAD 2222222222222222222222222222222222222222\0branch refs/heads/x\0locked\0\0worktree /r/wt-y\0HEAD 3333333333333333333333333333333333333333\0detached\0locked moved to a usb disk\0\0";
        let list = parse_worktree_list(out);
        assert_eq!(list.iter().map(|w| w.locked).collect::<Vec<_>>(), [false, true, true]);
    }
}
