//! Data the shell renders besides the graph (spec §6.4 sidebar, §6.4 hover card, §14.4 remotes,
//! §6.5 git version). All of it is cheap enough to refresh with every graph refresh.
//!
//! Pure functions over an already-open repository and a `GitCli`: no dependency on `Api`, so
//! they're unit-tested directly here. `W2-A` wires them into `Api::dispatch` (fields, `Request`
//! variants, the `id -> RepoHandle` lookup) without needing anything from this module beyond what
//! it exports.

use crate::error::{GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use crate::redact::redact;
use crate::reflog::read_reflog;
use crate::refs::remote_for;
use crate::remotes::{host_kind, parse_remote_url, remote_url, HostKind};
use crate::worktree::list_worktrees;
use gix::bstr::ByteSlice;
use gix::remote::Direction;
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteInfo {
    pub name: String,
    /// Redacted (`redact`): never a raw credential or token.
    pub url: String,
    pub host: Option<String>,
    pub path: Option<String>,
    pub host_kind: HostKind,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoInfoPayload {
    pub remotes: Vec<RemoteInfo>,
    /// Set when the open repo is a linked worktree: its main worktree (spec §13).
    pub main_worktree: Option<String>,
    pub common_dir: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalBranch {
    pub name: String,
    pub full_name: String,
    pub target: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream is configured but no longer exists.
    pub gone: bool,
    #[ts(type = "number")]
    pub tip_time: i64,
    pub summary: String,
    pub author: String,
    pub is_head: bool,
    /// Checked out in another worktree (its path).
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteBranch {
    pub name: String,
    pub full_name: String,
    pub target: String,
    #[ts(type = "number")]
    pub tip_time: i64,
    pub summary: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteGroup {
    pub name: String,
    pub host_kind: HostKind,
    pub branches: Vec<RemoteBranch>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorktreeItem {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StashItem {
    pub index: u32,
    pub id: String,
    pub message: String,
    #[ts(type = "number")]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagItem {
    pub name: String,
    pub full_name: String,
    pub target: String,
    #[ts(type = "number")]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SidebarPayload {
    pub locals: Vec<LocalBranch>,
    pub remotes: Vec<RemoteGroup>,
    pub worktrees: Vec<WorktreeItem>,
    pub stashes: Vec<StashItem>,
    pub tags: Vec<TagItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum LastPushKind {
    /// Newest `update by push` in the remote-tracking ref's reflog.
    Push,
    /// No push recorded: newest `fetch` ("last seen on remote").
    Fetch,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LastPushPayload {
    #[ts(type = "number")]
    pub time: i64,
    pub kind: LastPushKind,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfoPayload {
    pub app_version: String,
    pub git_version: String,
}

/// `%(upstream:track,nobracket)`: "ahead 3, behind 2" | "ahead 3" | "behind 2" | "gone" | "".
pub fn parse_track(s: &str) -> (u32, u32, bool) {
    let s = s.trim();
    if s == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in s.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

const FIELDS: [&str; 14] = [
    "%(refname)", "%(symref)", "%(objecttype)", "%(objectname)", "%(*objecttype)", "%(*objectname)", "%(upstream)",
    "%(upstream:track,nobracket)", "%(committerdate:unix)", "%(*committerdate:unix)", "%(subject)", "%(*subject)", "%(authorname)", "%(*authorname)",
];

fn canonical(p: &Path) -> std::path::PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// The sidebar's branches, remotes, worktrees, stashes and tags (spec §6.4), for the repository at
/// `workdir`/`repo`. `repo` must be a handle already opened on `workdir`; this never opens one.
pub async fn sidebar(cli: &GitCli, repo: &gix::ThreadSafeRepository, workdir: &Path) -> Result<SidebarPayload, GbError> {
    let format = format!("--format={}", FIELDS.join("%00"));
    let out = cli.run(GitInvocation::new(workdir, ["for-each-ref", format.as_str(), "refs/heads", "refs/remotes", "refs/tags"])).await?;
    let worktrees = list_worktrees(cli, workdir).await?;
    let local = repo.to_thread_local();
    let remote_names: Vec<String> = local.remote_names().into_iter().map(|n| n.to_str_lossy().into_owned()).collect();
    let host_kind_of = |remote: &str| remote_url(&local, remote, Direction::Fetch).and_then(|u| parse_remote_url(&u)).map(|u| host_kind(&u.host)).unwrap_or(HostKind::Generic);
    let head_branch = local.head_name().ok().flatten().map(|n| n.as_bstr().to_string());
    let here = canonical(workdir);
    let elsewhere: std::collections::HashMap<String, String> = worktrees
        .iter()
        .filter(|w| canonical(&w.path) != here)
        .filter_map(|w| w.branch.clone().map(|b| (b, w.path.display().to_string())))
        .collect();
    let mut s = SidebarPayload { locals: vec![], remotes: vec![], worktrees: vec![], stashes: vec![], tags: vec![] };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() != FIELDS.len() || !f[1].is_empty() {
            continue; // malformed, or a symbolic ref (origin/HEAD)
        }
        let peeled = !f[5].is_empty();
        let target_type = if peeled { f[4] } else { f[2] };
        if target_type != "commit" {
            continue;
        }
        let target = if peeled { f[5] } else { f[3] }.to_string();
        let pick = |a: &str, b: &str| if a.is_empty() { b.to_string() } else { a.to_string() };
        let tip_time = pick(f[8], f[9]).parse().unwrap_or(0);
        let summary = pick(f[10], f[11]);
        let author = pick(f[12], f[13]);
        let full = f[0].to_string();
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(f[7]);
            s.locals.push(LocalBranch {
                name: name.into(),
                upstream: (!f[6].is_empty()).then(|| f[6].to_string()),
                ahead,
                behind,
                gone,
                tip_time,
                summary,
                author,
                is_head: head_branch.as_deref() == Some(full.as_str()),
                worktree: elsewhere.get(&full).cloned(),
                target,
                full_name: full,
            });
        } else if let Some(rest) = full.strip_prefix("refs/remotes/") {
            let Some(remote) = remote_for(rest, &remote_names) else { continue };
            let branch = RemoteBranch { name: rest[remote.len() + 1..].to_string(), full_name: full.clone(), target, tip_time, summary, author };
            match s.remotes.iter_mut().find(|g| g.name == remote) {
                Some(g) => g.branches.push(branch),
                None => s.remotes.push(RemoteGroup { host_kind: host_kind_of(&remote), name: remote, branches: vec![branch] }),
            }
        } else if let Some(name) = full.strip_prefix("refs/tags/") {
            s.tags.push(TagItem { name: name.into(), full_name: full.clone(), target, time: tip_time });
        }
    }
    s.worktrees = worktrees
        .iter()
        .filter(|w| !w.bare)
        .map(|w| WorktreeItem {
            path: w.path.display().to_string(),
            name: w.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            branch: w.branch.as_ref().map(|b| b.trim_start_matches("refs/heads/").to_string()),
            head: w.head.map(|id| id.to_string()),
            is_main: w.is_main,
            is_current: canonical(&w.path) == here,
        })
        .collect();
    s.stashes = read_reflog(local.common_dir(), "refs/stash")?
        .into_iter()
        .enumerate()
        .map(|(i, e)| StashItem { index: i as u32, id: e.new.to_string(), message: e.message, time: e.time })
        .collect();
    Ok(s)
}

/// When the remote-tracking ref `remote_ref` (e.g. `refs/remotes/origin/main`) was last updated by
/// a push, or (failing that) last seen by a fetch: "last pushed"/"last seen on remote" (spec
/// §6.4's hover card). `None` when the ref has no reflog entry of either kind (or no reflog at
/// all). `remote_ref` must be under `refs/remotes/`, checked here since it names a path under the
/// repository's `logs/` directory.
pub fn last_push(repo: &gix::ThreadSafeRepository, remote_ref: &str) -> Result<Option<LastPushPayload>, GbError> {
    if !remote_ref.starts_with("refs/remotes/") || remote_ref.split('/').any(|c| c == ".." || c.is_empty()) {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("not a remote-tracking ref: {remote_ref}")));
    }
    let entries = read_reflog(repo.to_thread_local().common_dir(), remote_ref)?;
    let find = |prefix: &str, kind| entries.iter().find(|e| e.message.starts_with(prefix)).map(|e| LastPushPayload { time: e.time, kind });
    // `git pull` (fetch + merge) records its remote-tracking-ref update with a "pull" reflog
    // message, not "fetch": it's still just "last seen on remote", the same as a plain fetch.
    Ok(find("update by push", LastPushKind::Push).or_else(|| find("fetch", LastPushKind::Fetch)).or_else(|| find("pull", LastPushKind::Fetch)))
}

/// Every remote with its redacted URL and parsed host (spec §14.4), and (for a linked worktree)
/// the main worktree it belongs to (spec §13).
pub async fn repo_info(cli: &GitCli, repo: &gix::ThreadSafeRepository, workdir: &Path) -> Result<RepoInfoPayload, GbError> {
    let (remotes, common_dir, linked) = {
        let local = repo.to_thread_local();
        // Reuses `details::remotes()` (origin first, then alphabetical) rather than its own
        // remote loop (drift ruling P16/T7): every remote list in the app orders the same way,
        // and the parsing logic lives in exactly one place.
        let remotes = crate::details::remotes(&local)
            .into_iter()
            .map(|r| {
                let url = remote_url(&local, &r.name, Direction::Fetch).map(|u| redact(&u)).unwrap_or_default();
                RemoteInfo { name: r.name, url, host: r.host, path: r.path, host_kind: r.host_kind }
            })
            .collect::<Vec<_>>();
        (remotes, canonical(local.common_dir()), canonical(local.git_dir()) != canonical(local.common_dir()))
    };
    let main_worktree = if linked {
        list_worktrees(cli, workdir).await?.into_iter().find(|w| w.is_main).map(|w| canonical(&w.path).display().to_string())
    } else {
        None
    };
    Ok(RepoInfoPayload { remotes, main_worktree, common_dir: common_dir.display().to_string() })
}

/// `AppInfoPayload` for a git version already known (e.g. `Api`'s cached `check_version`).
pub fn app_info_payload(git_version: (u32, u32, u32)) -> AppInfoPayload {
    let (a, b, c) = git_version;
    AppInfoPayload { app_version: env!("CARGO_PKG_VERSION").into(), git_version: format!("{a}.{b}.{c}") }
}

/// The app's own version and git's, for the About screen (spec §6.5). Runs `git --version` fresh;
/// callers that already cache the version (as `Api` does, for the process lifetime) should build
/// the payload from that cache with `app_info_payload` instead of calling this every time.
pub async fn app_info(cli: &GitCli) -> Result<AppInfoPayload, GbError> {
    Ok(app_info_payload(cli.check_version().await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    fn open(r: &TestRepo) -> (gix::ThreadSafeRepository, std::path::PathBuf) {
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let workdir = repo.work_dir().unwrap().to_path_buf();
        (repo, workdir)
    }

    #[test]
    fn parses_upstream_track() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("ahead 10, behind 58"), (10, 58, false));
        assert_eq!(parse_track("behind 2"), (0, 2, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
    }

    #[tokio::test]
    async fn sidebar_lists_every_section() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.commit("local only");
        let (repo, workdir) = open(&r);
        let s = sidebar(&cli(), &repo, &workdir).await.unwrap();
        let names: Vec<&str> = s.locals.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["feature/login", "hotfix", "main"]);
        let main = s.locals.iter().find(|b| b.name == "main").unwrap();
        assert!(main.is_head);
        assert_eq!(main.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!((main.ahead, main.behind), (1, 0));
        assert_eq!(main.summary, "local only");
        assert!(main.tip_time > 0);
        let hotfix = s.locals.iter().find(|b| b.name == "hotfix").unwrap();
        assert!(hotfix.worktree.as_deref().unwrap().ends_with("wt-hotfix"));
        assert_eq!(s.remotes.len(), 1);
        assert_eq!(s.remotes[0].name, "origin");
        let rnames: Vec<&str> = s.remotes[0].branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(rnames, vec!["feature/login", "main"], "origin/HEAD (symbolic) is skipped");
        assert_eq!(s.worktrees.len(), 2);
        assert!(s.worktrees[0].is_main && s.worktrees[0].is_current);
        assert!(!s.worktrees[1].is_current);
        assert_eq!(s.stashes.len(), 1);
        assert_eq!(s.stashes[0].message, "On main: Experiment");
        assert_eq!(s.tags.len(), 1);
        assert_eq!(s.tags[0].name, "v1.0");
        assert_eq!(s.tags[0].target, r.git(&["rev-parse", "v1.0^{commit}"]), "annotated tags peel to their commit");
        assert!(s.tags[0].time > 0);
    }

    #[tokio::test]
    async fn last_push_prefers_push_then_fetch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (repo, _workdir) = open(&r);
        let lp = last_push(&repo, "refs/remotes/origin/main").unwrap().unwrap();
        assert_eq!(lp.kind, LastPushKind::Push);
        // A branch that only ever arrived by fetch.
        let origin = r.root().join("origin.git");
        r.git_in(&origin, &["branch", "fetched-only", "main"]);
        r.git(&["fetch", "-q", "origin"]);
        let lp = last_push(&repo, "refs/remotes/origin/fetched-only").unwrap().unwrap();
        assert_eq!(lp.kind, LastPushKind::Fetch);
        assert!(last_push(&repo, "refs/remotes/origin/nope").unwrap().is_none());
        assert!(last_push(&repo, "../../etc/passwd").is_err(), "only refs/remotes/* is accepted");
    }

    /// `git pull`'s reflog entry for the remote-tracking ref starts with "pull", not "fetch": it
    /// still means "last seen on remote", not a push.
    #[tokio::test]
    async fn last_push_treats_a_pull_reflog_entry_as_a_fetch() {
        let r = TestRepo::new();
        r.commit("a");
        let (repo, _workdir) = open(&r);
        let common = repo.to_thread_local().common_dir().to_path_buf();
        let logs = common.join("logs/refs/remotes/origin");
        std::fs::create_dir_all(&logs).unwrap();
        let old = "0".repeat(40);
        let new = "1".repeat(40);
        std::fs::write(logs.join("main"), format!("{old} {new} Ada Lovelace <ada@example.com> 1700000000 +0000\tpull origin main: Fast-forward\n")).unwrap();
        let lp = last_push(&repo, "refs/remotes/origin/main").unwrap().unwrap();
        assert_eq!(lp.kind, LastPushKind::Fetch);
    }

    #[tokio::test]
    async fn repo_info_parses_remotes_and_redacts_urls() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["remote", "add", "gl", "https://ada:tok@gitlab.example.com/acme/shop.git"]);
        r.git(&["remote", "add", "gh", "git@github.com:owner/repo.git"]);
        let (repo, workdir) = open(&r);
        let info = repo_info(&cli(), &repo, &workdir).await.unwrap();
        let gl = info.remotes.iter().find(|x| x.name == "gl").unwrap();
        assert_eq!(gl.url, "https://***@gitlab.example.com/acme/shop.git");
        assert_eq!((gl.host.as_deref(), gl.path.as_deref(), gl.host_kind), (Some("gitlab.example.com"), Some("acme/shop"), HostKind::GitLab));
        let gh = info.remotes.iter().find(|x| x.name == "gh").unwrap();
        assert_eq!(gh.host_kind, HostKind::GitHub);
        assert_eq!(info.main_worktree, None);
    }

    /// Drift ruling P16/T7: `repoInfo.remotes` must build on `details::remotes()` (so `origin`
    /// sorts first, matching every other remote list in the app) rather than its own remote loop.
    #[tokio::test]
    async fn repo_info_lists_origin_first_like_every_other_remote_list() {
        let r = TestRepo::new();
        r.commit("a");
        // Alphabetically "aaa" sorts before "origin": only an origin-first rule (not plain
        // alphabetical order, and not git's own remote-add or iteration order) puts origin first.
        r.git(&["remote", "add", "aaa", "https://example.com/a/a.git"]);
        r.git(&["remote", "add", "origin", "https://example.com/o/o.git"]);
        let (repo, workdir) = open(&r);
        let info = repo_info(&cli(), &repo, &workdir).await.unwrap();
        assert_eq!(info.remotes.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["origin", "aaa"]);
    }

    /// Deferred Rust minor #13: a remote reached only through an `insteadOf` alias still gets a
    /// redacted URL and a parsed host.
    #[tokio::test]
    async fn repo_info_resolves_instead_of_aliases() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["config", "url.https://oauth2:tok@github.com/.insteadOf", "gh:"]);
        r.git(&["remote", "add", "origin", "gh:owner/repo.git"]);
        let (repo, workdir) = open(&r);
        let info = repo_info(&cli(), &repo, &workdir).await.unwrap();
        assert_eq!(info.remotes[0].url, "https://***@github.com/owner/repo.git");
        assert_eq!(info.remotes[0].host_kind, HostKind::GitHub);
    }

    #[tokio::test]
    async fn linked_worktree_reports_its_main_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let wt = r.root().join("wt-hotfix");
        let repo = gix::ThreadSafeRepository::discover(&wt).unwrap();
        let workdir = repo.work_dir().unwrap().to_path_buf();
        let info = repo_info(&cli(), &repo, &workdir).await.unwrap();
        assert_eq!(info.main_worktree.as_deref(), Some(r.path().canonicalize().unwrap().display().to_string().as_str()));
    }

    #[tokio::test]
    async fn app_info_reports_versions() {
        let info = app_info(&cli()).await.unwrap();
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
        assert!(info.git_version.starts_with('2'));
        assert_eq!(app_info_payload((2, 40, 1)).git_version, "2.40.1");
    }
}
