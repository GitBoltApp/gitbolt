//! Data the shell renders besides the graph (spec §6.4 sidebar, §6.4 hover card, §14.4 remotes,
//! §6.5 git version). All of it is cheap enough to refresh with every graph refresh.
//!
//! Pure functions over an already-open repository and a `GitCli`: no dependency on `Api`, so
//! they're unit-tested directly here. `W2-A` wires them into `Api::dispatch` (fields, `Request`
//! variants, the `id -> RepoHandle` lookup) without needing anything from this module beyond what
//! it exports.

use crate::error::{GbError, GbErrorKind};
use crate::git::GitCli;
use crate::redact::redact;
use crate::reflog::read_reflog;
use crate::refs::remote_for;
use crate::remotes::{host_kind, parse_remote_url, remote_url, HostKind};
use crate::worktree::list_worktrees;
use gix::bstr::ByteSlice;
use gix::remote::Direction;
use serde::Serialize;
use std::collections::HashMap;
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
    /// The worktree (any, the handle's own included) whose HEAD names it (spec #2 §11.2).
    pub checked_out: Option<String>,
    // --- 2D T11: push target ---
    /// Where Push sends it (spec #2 §12.3, `remote/branch`): the push remote, else the upstream.
    pub push_target: Option<String>,
    /// Commits on the push target that aren't in the branch (the force confirmation's count);
    /// `None` when that ref doesn't exist yet.
    pub push_behind: Option<u32>,
    // --- end 2D T11 ---
    /// GitBolt rewrote it since its last push (a live rewrite mark, §12.3): Push forces with
    /// the lease recorded then when `push_behind` > 0.
    pub rewritten: Option<crate::write::rewrites::Rewritten>,
    /// The upstream's short name when its branch name differs from this one's (UX round 3, M.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream_mismatch: Option<String>,
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
    pub host: Option<String>,
    pub host_kind: HostKind,
    pub branches: Vec<RemoteBranch>,
    /// The branch `refs/remotes/<name>/HEAD` names (`refs/remotes/origin/main`), when set: the
    /// stack base (spec #3 §3.11).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_branch: Option<String>,
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
    /// `git worktree lock`ed: it can't be removed (spec #2 §11).
    pub locked: bool,
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
    /// An annotated tag's message and tagger (UX round 3, M.2); absent on a lightweight tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotation: Option<crate::payload::TagAnnotation>,
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

/// Commits reachable from the ref `theirs` but not from `ours_oid`, counted in process.
fn commits_behind(repo: &gix::Repository, theirs: &str, ours_oid: &str) -> Option<u32> {
    let tip = repo.find_reference(theirs).ok()?.peel_to_id().ok()?.detach();
    let ours = gix::ObjectId::from_hex(ours_oid.as_bytes()).ok()?;
    let walk = repo.rev_walk([tip]).with_hidden([ours]).all().ok()?;
    let mut n = 0u32;
    for c in walk {
        c.ok()?;
        n += 1;
    }
    Some(n)
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

/// One ref under `refs/heads`, `refs/remotes` or `refs/tags`, as the sidebar reads it: what
/// `git for-each-ref` prints with `FIELDS`, read in process (`ref_rows`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RefRow {
    pub full: String,
    /// A symbolic ref's target (`refs/remotes/origin/HEAD`); its other fields stay empty.
    pub symref: Option<String>,
    /// The ref's own object when it's an annotated tag.
    pub tag_object: Option<gix::ObjectId>,
    /// The commit it peels to.
    pub target: gix::ObjectId,
    /// The commit's committer time.
    pub tip_time: i64,
    /// `%(subject)`: the tag's for an annotated tag, else the commit's.
    pub summary: String,
    /// The commit's author name.
    pub author: String,
    pub upstream: Option<Upstream>,
}

impl Default for RefRow {
    fn default() -> Self {
        Self { full: String::new(), symref: None, tag_object: None, target: gix::ObjectId::null(gix::hash::Kind::Sha1), tip_time: 0, summary: String::new(), author: String::new(), upstream: None }
    }
}

/// A local branch's upstream (`%(upstream)`, `%(upstream:track)`, `%(upstream:remotename)`,
/// `%(upstream:remoteref)`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Upstream {
    /// The ref it tracks (`refs/remotes/origin/main`; `refs/heads/main` for remote `.`).
    pub full: String,
    pub ahead: u32,
    pub behind: u32,
    /// Configured, but that ref doesn't exist.
    pub gone: bool,
    /// `branch.<name>.remote` and the first `branch.<name>.merge`, as configured.
    pub remote: String,
    pub merge: String,
}

/// The repository's own config file read now (a handle's snapshot is from when it opened, so an
/// upstream set since would be missed), else the snapshot's.
pub(crate) fn fresh_config(repo: &gix::Repository) -> gix::config::File {
    gix::config::File::from_path_no_includes(repo.common_dir().join("config"), gix::config::Source::Local).unwrap_or_else(|_| repo.config_snapshot().plumbing().clone())
}

/// What `fetch` refspec of `remote` maps `name` to (git's `remote_find_tracking`): the first
/// matching one.
fn tracking_ref(config: &gix::config::File, remote: &str, name: &str) -> Option<String> {
    let specs = config.strings_by("remote", Some(remote.as_bytes().as_bstr()), "fetch").unwrap_or_default();
    let specs: Vec<String> = specs.iter().map(|s| s.to_str_lossy().trim().to_string()).collect();
    let matches = |pattern: &str| -> Option<String> {
        match pattern.split_once('*') {
            Some((pre, post)) => (name.len() >= pre.len() + post.len() && name.starts_with(pre) && name.ends_with(post)).then(|| name[pre.len()..name.len() - post.len()].to_string()),
            None => (pattern == name).then(String::new),
        }
    };
    // Negative refspecs (`^…`) don't stop an upstream from mapping (git agrees).
    specs.iter().filter(|s| !s.starts_with('^')).find_map(|s| {
        let (src, dst) = s.trim_start_matches('+').split_once(':')?;
        if dst.is_empty() {
            return None;
        }
        let captured = matches(src)?;
        Some(if src.contains('*') { dst.replacen('*', &captured, 1) } else { dst.to_string() })
    })
}

/// Branch `branch`'s upstream ref, remote and merge (git's `branch_get_upstream`): the merge ref
/// mapped through the remote's fetch refspecs, or for remote `.` the local branch itself.
pub(crate) fn upstream_ref(config: &gix::config::File, branch: &str) -> Option<(String, String, String)> {
    let sub = Some(branch.as_bytes().as_bstr());
    let remote = config.string_by("branch", sub, "remote")?.to_str_lossy().into_owned();
    let merge = config.strings_by("branch", sub, "merge")?.into_iter().next()?.to_str_lossy().into_owned();
    let full = match tracking_ref(config, &remote, &merge) {
        Some(t) => t,
        None if remote == "." => {
            if merge.starts_with("refs/") {
                merge.clone()
            } else {
                format!("refs/heads/{merge}")
            }
        }
        None => return None,
    };
    Some((full, remote, merge))
}

/// `%(subject)`: the message's first paragraph (past leading empty lines), its lines joined with
/// spaces, a CR before each LF dropped.
fn subject(message: &[u8]) -> String {
    let mut m = message;
    while let Some(rest) = m.strip_prefix(b"\n") {
        m = rest;
    }
    let end = [m.find(b"\n\n"), m.find(b"\r\n\r\n")].into_iter().flatten().min().unwrap_or(m.len());
    let mut sub = &m[..end];
    while let [rest @ .., b'\n' | b'\r'] = sub {
        sub = rest;
    }
    let mut out = Vec::with_capacity(sub.len());
    for (i, &b) in sub.iter().enumerate() {
        match b {
            b'\r' if sub.get(i + 1) == Some(&b'\n') => {}
            b'\n' => out.push(b' '),
            b => out.push(b),
        }
    }
    out.to_str_lossy().into_owned()
}

/// (ours, theirs) → (ahead, behind).
type Counts = HashMap<(gix::ObjectId, gix::ObjectId), (u32, u32)>;
/// Ahead/behind counts already computed: see `Ancestry::ahead_behind`.
static AHEAD_BEHIND: std::sync::OnceLock<std::sync::Mutex<Counts>> = std::sync::OnceLock::new();
/// `AHEAD_BEHIND`'s bound: past it, the cache starts over.
const AHEAD_BEHIND_MAX: usize = 20_000;

/// Commits' committer times and parents, each read once for all of a refresh's ahead/behind
/// counts (most branches share most of their history).
struct Ancestry<'r> {
    repo: &'r gix::Repository,
    commits: HashMap<gix::ObjectId, (i64, Vec<gix::ObjectId>)>,
}

impl<'r> Ancestry<'r> {
    fn new(repo: &'r gix::Repository) -> Self {
        Self { repo, commits: HashMap::new() }
    }

    fn read(&mut self, id: gix::ObjectId) -> &(i64, Vec<gix::ObjectId>) {
        let repo = self.repo;
        self.commits.entry(id).or_insert_with(|| {
            repo.find_commit(id)
                .ok()
                .and_then(|c| {
                    let d = c.decode().ok()?;
                    Some((d.committer().ok().map_or(0, |s| s.seconds()), d.parents().collect()))
                })
                .unwrap_or((0, Vec::new()))
        })
    }

    /// (`ours` not in `theirs`, `theirs` not in `ours`): git's `rev-list --left-right --count
    /// ours...theirs`. Both sides are painted down by commit time, newest first, until only
    /// commits reachable from both are left (plus a few more, git's slop against clock skew).
    fn ahead_behind(&mut self, ours: gix::ObjectId, theirs: gix::ObjectId) -> (u32, u32) {
        // Commits never change, so neither does a pair's count: every refresh but the first
        // reads it from here. Not in a shallow clone, whose history a deepening fetch extends.
        let cache = AHEAD_BEHIND.get_or_init(Default::default);
        let shallow = self.repo.is_shallow();
        if !shallow && let Some(hit) = cache.lock().ok().and_then(|c| c.get(&(ours, theirs)).copied()) {
            return hit;
        }
        let counts = self.paint(ours, theirs);
        if !shallow && let Ok(mut c) = cache.lock() {
            if c.len() >= AHEAD_BEHIND_MAX {
                c.clear();
            }
            c.insert((ours, theirs), counts);
        }
        counts
    }

    fn paint(&mut self, ours: gix::ObjectId, theirs: gix::ObjectId) -> (u32, u32) {
        const OURS: u8 = 1;
        const THEIRS: u8 = 2;
        const BOTH: u8 = 3;
        const SLOP: u32 = 5;
        let mut flags: HashMap<gix::ObjectId, u8> = HashMap::new();
        let mut queue = std::collections::BinaryHeap::new();
        // Queue entries painted one side only: once none is left, the rest is shared history.
        let mut one_sided = 0usize;
        for (id, f) in [(ours, OURS), (theirs, THEIRS)] {
            let next = flags.get(&id).copied().unwrap_or(0) | f;
            flags.insert(id, next);
            queue.push((self.read(id).0, id, next));
        }
        one_sided += queue.iter().filter(|(_, _, f)| *f != BOTH).count();
        let mut slop = SLOP;
        while let Some((_, id, f)) = queue.pop() {
            if f != BOTH {
                one_sided -= 1;
            }
            if flags.get(&id) != Some(&f) {
                continue; // repainted since: a newer entry follows
            }
            for p in self.read(id).1.clone() {
                let before = flags.get(&p).copied().unwrap_or(0);
                let next = before | f;
                if next != before {
                    flags.insert(p, next);
                    let time = self.read(p).0;
                    queue.push((time, p, next));
                    if next != BOTH {
                        one_sided += 1;
                    }
                }
            }
            if one_sided == 0 {
                if slop == 0 {
                    break;
                }
                slop -= 1;
            } else {
                slop = SLOP;
            }
        }
        let count = |side: u8| flags.values().filter(|f| **f == side).count() as u32;
        (count(OURS), count(THEIRS))
    }
}

/// Every branch, remote branch and tag that peels to a commit, sorted by name, with what the
/// sidebar shows of it: `git for-each-ref` with `FIELDS`, without the process (spec §6.4).
pub(crate) fn ref_rows(repo: &gix::Repository) -> Result<Vec<RefRow>, GbError> {
    let config = fresh_config(repo);
    let mut ancestry = Ancestry::new(repo);
    let platform = repo.references().map_err(crate::error::gix_err)?;
    let mut rows = Vec::new();
    for prefix in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        for reference in platform.prefixed(prefix.as_bytes()).map_err(crate::error::gix_err)? {
            let Ok(reference) = reference else { continue };
            let full = reference.name().as_bstr().to_str_lossy().into_owned();
            let direct = match reference.target() {
                gix::refs::TargetRef::Symbolic(t) => {
                    rows.push(RefRow { full, symref: Some(t.as_bstr().to_str_lossy().into_owned()), ..Default::default() });
                    continue;
                }
                gix::refs::TargetRef::Object(id) => id.to_owned(),
            };
            let Some(row) = object_row(repo, &config, &mut ancestry, full, direct) else { continue };
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| a.full.as_bytes().cmp(b.full.as_bytes()));
    Ok(rows)
}

fn object_row(repo: &gix::Repository, config: &gix::config::File, ancestry: &mut Ancestry<'_>, full: String, direct: gix::ObjectId) -> Option<RefRow> {
    let obj = repo.find_object(direct).ok()?;
    let (tag_object, tag_subject, commit) = match obj.kind {
        gix::object::Kind::Commit => (None, None, obj.into_commit()),
        gix::object::Kind::Tag => {
            let tag_subject = obj.try_to_tag_ref().ok().map(|t| subject(t.message));
            let commit = obj.peel_to_kind(gix::object::Kind::Commit).ok()?.into_commit();
            (Some(direct), tag_subject, commit)
        }
        _ => return None,
    };
    let c = commit.decode().ok()?;
    let target = commit.id;
    let tip_time = c.committer().ok().map_or(0, |s| s.seconds());
    let author = c.author().ok().map(|a| a.name.to_str_lossy().into_owned()).unwrap_or_default();
    let summary = tag_subject.filter(|s| !s.is_empty()).unwrap_or_else(|| subject(c.message));
    let upstream = full.strip_prefix("refs/heads/").and_then(|branch| upstream_ref(config, branch)).map(|(up, remote, merge)| {
        let tip = repo.find_reference(up.as_str()).ok().and_then(|mut r| r.peel_to_id().ok()).map(|id| id.detach());
        let (ahead, behind, gone) = match tip {
            None => (0, 0, true),
            Some(t) if t == target => (0, 0, false),
            Some(t) => {
                let (ahead, behind) = ancestry.ahead_behind(target, t);
                (ahead, behind, false)
            }
        };
        Upstream { full: up, ahead, behind, gone, remote, merge }
    });
    Some(RefRow { full, symref: None, tag_object, target, tip_time, summary, author, upstream })
}

/// The same rows from `git for-each-ref` (`FIELDS`): the parity tests' reference.
#[cfg(test)]
pub(crate) async fn ref_rows_cli(cli: &GitCli, workdir: &Path) -> Result<Vec<RefRow>, GbError> {
    let format = format!("--format={}", FIELDS.join("%00"));
    let out = cli.run(crate::git::GitInvocation::new(workdir, ["for-each-ref", format.as_str(), "refs/heads", "refs/remotes", "refs/tags"])).await?;
    let mut rows = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() != FIELDS.len() {
            continue;
        }
        if !f[1].is_empty() {
            rows.push(RefRow { full: f[0].to_string(), symref: Some(f[1].to_string()), ..Default::default() });
            continue;
        }
        let peeled = !f[5].is_empty();
        if (if peeled { f[4] } else { f[2] }) != "commit" {
            continue;
        }
        let pick = |a: &str, b: &str| if a.is_empty() { b.to_string() } else { a.to_string() };
        let upstream = (!f[6].is_empty()).then(|| {
            let (ahead, behind, gone) = parse_track(f[7]);
            Upstream { full: f[6].to_string(), ahead, behind, gone, remote: f[14].to_string(), merge: f[15].to_string() }
        });
        rows.push(RefRow {
            full: f[0].to_string(),
            symref: None,
            tag_object: (f[2] == "tag").then(|| gix::ObjectId::from_hex(f[3].as_bytes()).unwrap()),
            target: gix::ObjectId::from_hex(if peeled { f[5] } else { f[3] }.as_bytes()).unwrap(),
            tip_time: pick(f[8], f[9]).parse().unwrap_or(0),
            summary: pick(f[10], f[11]),
            author: pick(f[12], f[13]),
            upstream,
        });
    }
    Ok(rows)
}

#[cfg(test)]
const FIELDS: [&str; 16] = [
    "%(refname)", "%(symref)", "%(objecttype)", "%(objectname)", "%(*objecttype)", "%(*objectname)", "%(upstream)",
    "%(upstream:track,nobracket)", "%(committerdate:unix)", "%(*committerdate:unix)", "%(subject)", "%(*subject)", "%(authorname)", "%(*authorname)",
    "%(upstream:remotename)", "%(upstream:remoteref)",
];

fn canonical(p: &Path) -> std::path::PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// The sidebar's branches, remotes, worktrees, stashes and tags (spec §6.4), for the repository at
/// `workdir`/`repo`. `repo` must be a handle already opened on `workdir`; this never opens one.
pub async fn sidebar(repo: &gix::ThreadSafeRepository, workdir: &Path) -> Result<SidebarPayload, GbError> {
    let shared = repo.clone();
    let rows = tokio::task::spawn_blocking(move || ref_rows(&shared.to_thread_local())).await.map_err(|e| GbError::other(format!("sidebar read failed: {e}")))??;
    let worktrees = list_worktrees(workdir).await?;
    let local = repo.to_thread_local();
    let remote_names: Vec<String> = local.remote_names().into_iter().map(|n| n.to_str_lossy().into_owned()).collect();
    let host_of = |remote: &str| remote_url(&local, remote, Direction::Fetch).and_then(|u| parse_remote_url(&u)).map(|u| u.host);
    let host_kind_of = |remote: &str| host_of(remote).map(|h| host_kind(&h)).unwrap_or(HostKind::Generic);
    let head_branch = local.head_name().ok().flatten().map(|n| n.as_bstr().to_string());
    let here = canonical(workdir);
    let elsewhere: std::collections::HashMap<String, String> = worktrees
        .iter()
        .filter(|w| canonical(&w.path) != here)
        .filter_map(|w| w.branch.clone().map(|b| (b, w.path.display().to_string())))
        .collect();
    let checked_out: std::collections::HashMap<String, String> = worktrees.iter().filter_map(|w| w.branch.clone().map(|b| (b, w.path.display().to_string()))).collect();
    let mut s = SidebarPayload { locals: vec![], remotes: vec![], worktrees: vec![], stashes: vec![], tags: vec![] };
    let mut defaults: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for row in rows {
        if let Some(sym) = row.symref {
            // A symbolic ref: `refs/remotes/<r>/HEAD` names that remote's default branch.
            if let Some(remote) = row.full.strip_prefix("refs/remotes/").and_then(|s| s.strip_suffix("/HEAD")) {
                defaults.insert(remote.to_string(), sym);
            }
            continue;
        }
        let (target, tip_time, summary, author) = (row.target.to_string(), row.tip_time, row.summary, row.author);
        let full = row.full;
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let up = row.upstream.unwrap_or_default();
            s.locals.push(LocalBranch {
                name: name.into(),
                upstream: (!up.full.is_empty()).then(|| up.full.clone()),
                ahead: up.ahead,
                behind: up.behind,
                gone: up.gone,
                tip_time,
                summary,
                author,
                is_head: head_branch.as_deref() == Some(full.as_str()),
                worktree: elsewhere.get(&full).cloned(),
                checked_out: checked_out.get(&full).cloned(),
                push_target: None,
                push_behind: None,
                rewritten: None,
                upstream_mismatch: crate::refs::mismatched_upstream(name, &up.remote, &up.merge),
                target,
                full_name: full,
            });
        } else if let Some(rest) = full.strip_prefix("refs/remotes/") {
            let Some(remote) = remote_for(rest, &remote_names) else { continue };
            let branch = RemoteBranch { name: rest[remote.len() + 1..].to_string(), full_name: full.clone(), target, tip_time, summary, author };
            match s.remotes.iter_mut().find(|g| g.name == remote) {
                Some(g) => g.branches.push(branch),
                None => s.remotes.push(RemoteGroup { host: host_of(&remote), host_kind: host_kind_of(&remote), name: remote, branches: vec![branch], default_branch: None }),
            }
        } else if let Some(name) = full.strip_prefix("refs/tags/") {
            // An annotated tag (`objecttype` tag): its message, read in process and cached by object.
            let annotation = row.tag_object.and_then(|id| crate::refs::read_tag(&local, id)).and_then(|t| t.annotation);
            s.tags.push(TagItem { name: name.into(), full_name: full.clone(), target, time: tip_time, annotation });
        }
    }
    // --- 3D T1: each remote's default branch (`for-each-ref` sorts `HEAD` before the branches) ---
    for g in s.remotes.iter_mut() {
        g.default_branch = defaults.remove(&g.name);
    }
    // --- end 3D T1 ---
    // --- 2D T11: push targets (every remote branch is listed by now) ---
    for b in s.locals.iter_mut() {
        let Some(t) = crate::write::sync::push_target(&local, &b.name) else { continue };
        let label = format!("{}/{}", t.remote, t.branch);
        let exists = s.remotes.iter().any(|g| g.name == t.remote && g.branches.iter().any(|r| r.name == t.branch));
        let theirs = format!("refs/remotes/{label}");
        b.push_behind = if !exists {
            None
        } else if b.upstream.as_deref() == Some(theirs.as_str()) {
            // The upstream's own count, already parsed: nothing to compute.
            Some(b.behind)
        } else {
            // Triangular setup: commits on the push target that the branch lacks, in process
            // (the sidebar build spawns no git per branch).
            commits_behind(&local, &theirs, &b.target)
        };
        b.push_target = Some(label);
    }
    // --- end 2D T11 ---
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
            locked: w.locked,
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
pub async fn repo_info(repo: &gix::ThreadSafeRepository, workdir: &Path) -> Result<RepoInfoPayload, GbError> {
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
        list_worktrees(workdir).await?.into_iter().find(|w| w.is_main).map(|w| canonical(&w.path).display().to_string())
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

    /// The in-process rows are `git for-each-ref`'s.
    async fn assert_ref_parity(r: &TestRepo) {
        let git = ref_rows_cli(&cli(), r.path()).await.unwrap();
        let ours = ref_rows(&gix::open(r.path()).unwrap()).unwrap();
        for (a, b) in ours.iter().zip(&git) {
            assert_eq!(a, b);
        }
        assert_eq!(ours.len(), git.len(), "{:?}\nvs\n{:?}", ours.iter().map(|r| &r.full).collect::<Vec<_>>(), git.iter().map(|r| &r.full).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn ref_rows_match_for_each_ref_on_the_fixtures() {
        for build in [fixtures::basic, fixtures::sync, fixtures::worktrees, fixtures::stack] {
            let r = TestRepo::new();
            build(&r);
            let _ = r.try_git(&["fetch", "-q", "origin"]);
            assert_ref_parity(&r).await;
        }
    }

    /// Upstreams of every kind (none, gone, a local `.` one, a merge ref no refspec maps, a remote
    /// with no fetch refspec, a negative refspec, a differently named one, two merge values),
    /// ahead/behind across merges, annotated, nested and lightweight tags, a tag of a tree,
    /// symrefs, and messages whose subject spans lines, has CRLFs or starts with blank lines.
    #[tokio::test]
    async fn ref_rows_match_for_each_ref_on_every_kind_of_ref() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.git(&["fetch", "-q", "origin"]);
        // Ahead/behind across merges: a branch that merged main and its upstream, both moved on.
        r.git(&["switch", "-q", "-c", "merged", "origin/dev"]);
        r.git(&["branch", "-q", "--set-upstream-to", "origin/main"]);
        r.git(&["merge", "-q", "--no-edit", "--no-ff", "main"]);
        r.commit("after the merge");
        r.git(&["switch", "-q", "main"]);
        r.git(&["branch", "-q", "no-upstream"]);
        r.git(&["branch", "-q", "gone-up"]);
        r.git(&["config", "branch.gone-up.remote", "origin"]);
        r.git(&["config", "branch.gone-up.merge", "refs/heads/deleted-long-ago"]);
        r.git(&["branch", "-q", "--track", "local-up", "dev"]);
        r.git(&["branch", "-q", "unmapped"]);
        r.git(&["config", "branch.unmapped.remote", "origin"]);
        r.git(&["config", "branch.unmapped.merge", "main"]);
        r.git(&["remote", "add", "nofetch", "/nowhere"]);
        r.git(&["config", "--unset-all", "remote.nofetch.fetch"]);
        r.git(&["branch", "-q", "via-nofetch"]);
        r.git(&["config", "branch.via-nofetch.remote", "nofetch"]);
        r.git(&["config", "branch.via-nofetch.merge", "refs/heads/main"]);
        r.git(&["config", "--add", "remote.origin.fetch", "^refs/heads/secret"]);
        r.git(&["branch", "-q", "secret"]);
        r.git(&["config", "branch.secret.remote", "origin"]);
        r.git(&["config", "branch.secret.merge", "refs/heads/secret"]);
        r.git(&["branch", "-q", "renamed.with.dots"]);
        r.git(&["config", "branch.renamed.with.dots.remote", "origin"]);
        r.git(&["config", "branch.renamed.with.dots.merge", "refs/heads/dev"]);
        r.git(&["branch", "-q", "two-merges"]);
        r.git(&["config", "branch.two-merges.remote", "origin"]);
        r.git(&["config", "--add", "branch.two-merges.merge", "refs/heads/dev"]);
        r.git(&["config", "--add", "branch.two-merges.merge", "refs/heads/main"]);
        // Messages.
        r.write("m.txt", "1\n");
        r.git(&["add", "m.txt"]);
        r.git(&["commit", "-q", "--cleanup=verbatim", "-m", "\n\nFirst line\nsecond line\r\nthird\n\nbody"]);
        r.git(&["branch", "-q", "odd-message"]);
        r.write("m.txt", "2\n");
        r.git(&["add", "m.txt"]);
        r.git(&["commit", "-q", "--cleanup=verbatim", "-m", "CRLF subject\r\n\r\nbody\r\n"]);
        r.git(&["branch", "-q", "crlf-message"]);
        // Tags.
        r.git(&["tag", "light", "dev"]);
        r.git(&["tag", "-a", "-m", "Annotated\nover two lines\n\nand a body", "annotated", "dev"]);
        r.git(&["tag", "-a", "-m", "", "empty-annotation", "dev"]);
        r.git(&["tag", "-a", "-m", "A tag of a tag", "nested", "annotated"]);
        let tree = r.git(&["rev-parse", "main^{tree}"]);
        r.git(&["tag", "tree-tag", tree.trim()]);
        // Symrefs.
        r.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
        r.git(&["pack-refs", "--all"]);
        r.git(&["branch", "-q", "loose-after-pack"]);
        assert_ref_parity(&r).await;
    }

    /// A measurement, not a check (`cargo test -p gitbolt-core large_repo_refresh_reads --
    /// --ignored --nocapture`): the refresh's reads on a repository with 1000 commits, 400
    /// tracked branches, 400 tags and 8 linked worktrees, git's against in-process.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn large_repo_refresh_reads() {
        use std::io::Write;
        let r = TestRepo::new();
        fixtures::sync(&r);
        for i in 0..1000 {
            r.git(&["commit", "-q", "--allow-empty", "-m", &format!("commit {i}")]);
        }
        let ids: Vec<String> = r.git(&["rev-list", "main"]).lines().map(str::to_string).collect();
        let mut refs = String::new();
        let mut config = String::new();
        for i in 0..400 {
            refs.push_str(&format!("create refs/heads/b{i} {}\ncreate refs/remotes/origin/b{i} {}\n", ids[i % 900], ids[(i * 7) % 900]));
            refs.push_str(&format!("create refs/tags/light{i} {}\n", ids[(i * 3) % 900]));
            config.push_str(&format!("[branch \"b{i}\"]\n\tremote = origin\n\tmerge = refs/heads/b{i}\n"));
        }
        let mut child = std::process::Command::new("git").current_dir(r.path()).args(["update-ref", "--stdin"]).envs(isolated_git_env()).stdin(std::process::Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(refs.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        std::fs::OpenOptions::new().append(true).open(r.path().join(".git/config")).unwrap().write_all(config.as_bytes()).unwrap();
        for i in 0..8 {
            r.git(&["worktree", "add", "-q", "--detach", r.root().join(format!("wt{i}")).to_str().unwrap(), &ids[i * 10]]);
        }
        let time = |label: &str, f: &mut dyn FnMut()| {
            let mut runs: Vec<std::time::Duration> = (0..7).map(|_| { let t = std::time::Instant::now(); f(); t.elapsed() }).collect();
            let first = runs[0];
            runs.sort();
            println!("{label}: first {first:?}, median {:?} (min {:?})", runs[3], runs[0]);
        };
        let rt = tokio::runtime::Handle::current();
        let path = r.path().to_path_buf();
        let cli = cli();
        tokio::task::block_in_place(|| {
            time("for-each-ref (git)", &mut || { rt.block_on(ref_rows_cli(&cli, &path)).unwrap(); });
            time("ref rows (gix)", &mut || { ref_rows(&gix::open(&path).unwrap()).unwrap(); });
            time("worktree list (git)", &mut || { rt.block_on(crate::worktree::list_worktrees_cli(&cli, &path)).unwrap(); });
            time("worktree list (gix)", &mut || { rt.block_on(crate::worktree::list_worktrees(&path)).unwrap(); });
            let (repo, workdir) = open(&r);
            time("sidebar (in process)", &mut || { rt.block_on(sidebar(&repo, &workdir)).unwrap(); });
        });
    }

    #[test]
    fn parses_upstream_track() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("ahead 10, behind 58"), (10, 58, false));
        assert_eq!(parse_track("behind 2"), (0, 2, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
    }

    /// The push target's behind count: the upstream's own count when the target is the upstream,
    /// and counted in process (no git spawned) when a push remote makes it triangular.
    #[tokio::test]
    async fn push_behind_matches_git_for_tracked_and_triangular_branches() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.push_from_clone("dev", "late.txt", "late\n", "Pushed meanwhile");
        r.push_from_clone("main", "late2.txt", "late\n", "Pushed meanwhile 2");
        r.git(&["fetch", "-q", "origin"]);
        let want = |b: &str| r.git(&["rev-list", "--count", &format!("{b}..origin/{b}")]).parse::<u32>().unwrap();
        let (repo, workdir) = open(&r);
        let s = sidebar(&repo, &workdir).await.unwrap();
        let dev = s.locals.iter().find(|b| b.name == "dev").unwrap();
        assert_eq!((dev.push_target.as_deref(), dev.push_behind, dev.behind), (Some("origin/dev"), Some(want("dev")), want("dev")));
        assert!(want("dev") > 0);
        // main's upstream becomes origin/dev while its push target stays origin/main.
        r.git(&["config", "branch.main.merge", "refs/heads/dev"]);
        r.git(&["config", "branch.main.pushRemote", "origin"]);
        let (repo, workdir) = open(&r);
        let s = sidebar(&repo, &workdir).await.unwrap();
        let main = s.locals.iter().find(|b| b.name == "main").unwrap();
        assert_eq!((main.push_target.as_deref(), main.push_behind), (Some("origin/main"), Some(want("main"))));
        assert!(want("main") > 0);
    }

    /// No `refs/remotes/<r>/HEAD`: no default branch (the UI falls back to main/master/trunk).
    #[tokio::test]
    async fn a_remote_without_a_head_has_no_default_branch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["remote", "set-head", "origin", "-d"]);
        let (repo, workdir) = open(&r);
        let s = sidebar(&repo, &workdir).await.unwrap();
        assert_eq!(s.remotes[0].default_branch, None);
        assert_eq!(serde_json::to_value(&s.remotes[0]).unwrap().get("defaultBranch"), None, "absent, not null");
    }

    #[tokio::test]
    async fn sidebar_lists_every_section() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.commit("local only");
        let (repo, workdir) = open(&r);
        let s = sidebar(&repo, &workdir).await.unwrap();
        let names: Vec<&str> = s.locals.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["feature/login", "hotfix", "main"]);
        let main = s.locals.iter().find(|b| b.name == "main").unwrap();
        assert!(main.is_head);
        assert_eq!(main.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!((main.ahead, main.behind), (1, 0));
        assert_eq!((main.push_target.as_deref(), main.push_behind), (Some("origin/main"), Some(0)));
        assert_eq!(main.summary, "local only");
        assert!(main.tip_time > 0);
        let hotfix = s.locals.iter().find(|b| b.name == "hotfix").unwrap();
        assert!(hotfix.worktree.as_deref().unwrap().ends_with("wt-hotfix"));
        assert_eq!(s.remotes.len(), 1);
        assert_eq!(s.remotes[0].name, "origin");
        let rnames: Vec<&str> = s.remotes[0].branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(rnames, vec!["feature/login", "main"], "origin/HEAD (symbolic) is skipped");
        // `fixtures::basic` set origin's HEAD to main (spec #3 §3.11's stack base).
        assert_eq!(s.remotes[0].default_branch.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!(s.worktrees.len(), 2);
        assert!(s.worktrees[0].is_main && s.worktrees[0].is_current);
        assert!(!s.worktrees[1].is_current);
        assert_eq!(s.stashes.len(), 1);
        assert_eq!(s.stashes[0].message, "On main: Experiment");
        assert_eq!(s.tags.len(), 1);
        assert_eq!(s.tags[0].name, "v1.0");
        assert_eq!(s.tags[0].target, r.git(&["rev-parse", "v1.0^{commit}"]), "annotated tags peel to their commit");
        assert!(s.tags[0].time > 0);
        // UX round 3, M.2 / M.1: the annotated tag's message; no mismatch on same-name upstreams.
        assert_eq!(s.tags[0].annotation.as_ref().map(|a| a.message.as_str()), Some("v1.0"));
        assert!(s.locals.iter().all(|b| b.upstream_mismatch.is_none()));
        r.git(&["tag", "light", "main"]);
        r.git(&["branch", "--set-upstream-to=origin/feature/login", "hotfix"]);
        let s = sidebar(&repo, &workdir).await.unwrap();
        assert_eq!(s.tags.iter().find(|t| t.name == "light").unwrap().annotation, None);
        assert_eq!(s.locals.iter().find(|b| b.name == "hotfix").unwrap().upstream_mismatch.as_deref(), Some("origin/feature/login"));
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
        let info = repo_info(&repo, &workdir).await.unwrap();
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
        let info = repo_info(&repo, &workdir).await.unwrap();
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
        let info = repo_info(&repo, &workdir).await.unwrap();
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
        let info = repo_info(&repo, &workdir).await.unwrap();
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
