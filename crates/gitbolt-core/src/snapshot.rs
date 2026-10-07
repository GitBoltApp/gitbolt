//! Builds the graph payload for one repository.

use crate::error::GbError;
use crate::git::GitCli;
use crate::graph::{layout, LayoutNode, NodeKind, Parent};
use crate::payload::{FileListPayload, GraphPayload, GraphWorktree, HeadPayload, RefLabel, RemoteRefLabel, RowPayload, WipPayload};
use crate::refs::{read_refs, RefKind, RepoRefs};
use crate::remotes::HostKind;
use crate::status::{parse_porcelain_v2, status_raw, summarize, WipCounts};
use crate::walk::{walk, WalkOptions, WalkResult};
use crate::worktree::{list_worktrees, Worktree};
use gix::ObjectId;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const DEFAULT_COMMIT_LIMIT: usize = 2000;

#[derive(Debug, Clone)]
pub struct BuildOptions {
    pub limit: usize,
    pub pinned_ref: Option<String>,
    /// No trunk at all (the pin setting `off`): `pinned_ref` is ignored and no default is picked.
    pub no_pin: bool,
    /// Reuse (and refresh) per-worktree status from here; `None` always runs status.
    pub wip_cache: Option<Arc<WipCache>>,
    /// Run status for every worktree even when cached (tab activation, spec §4.4).
    pub rescan: bool,
    /// The worktree laid out as the open one: its HEAD, its WIP at row 0 (spec #2 §11.2).
    /// `None`: the `workdir` the graph is built in.
    pub active: Option<PathBuf>,
    /// The handle's walk cache.
    pub walk_cache: Option<Arc<Mutex<Option<WalkCache>>>>,
    /// Remote → the remote whose project it's a fork of, from the forge's cached data (never a
    /// request): the default trunk follows the root (`default_trunk`).
    pub fork_parents: HashMap<String, String>,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self { limit: DEFAULT_COMMIT_LIMIT, pinned_ref: None, no_pin: false, wip_cache: None, rescan: false, active: None, walk_cache: None, fork_parents: HashMap::new() }
    }
}

/// The last walk a handle made, reused while the tips, the window and the stash set are the same
/// (spec #2 §11.2, Deviation 1): a switch of the active worktree re-lays out without walking.
pub struct WalkCache {
    key: (Vec<ObjectId>, usize, Vec<ObjectId>),
    walked: Arc<WalkResult>,
    /// How many walks went through this slot (the tests count them per handle: a global
    /// counter would see the walks of tests running in parallel).
    walks: usize,
}

impl std::fmt::Debug for WalkCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalkCache").field("tips", &self.key.0.len()).field("limit", &self.key.1).field("commits", &self.walked.commits.len()).finish()
    }
}

/// How many revwalks a handle's graph builds made (tests).
#[cfg(any(test, feature = "testing"))]
pub fn walks(cache: &Mutex<Option<WalkCache>>) -> usize {
    cache.lock().ok().and_then(|c| c.as_ref().map(|w| w.walks)).unwrap_or(0)
}

/// One worktree's status: counts for the WIP row, and a digest of the raw porcelain output so
/// the watcher can tell whether anything visible changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WipEntry {
    pub counts: WipCounts,
    pub digest: u64,
}

impl WipEntry {
    pub fn from_raw(raw: &[u8]) -> Self {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        raw.hash(&mut h);
        Self { counts: summarize(&parse_porcelain_v2(raw)), digest: h.finish() }
    }
}

/// Last known status per worktree, keyed by canonical path. A graph build reads it (unless
/// rescanning); the active tab's watcher keeps it fresh (spec §4.4, §8.6).
///
/// Two writers (graph builds and the watcher) put into it, so every put carries the `stamp` taken
/// before its status read: a read that started earlier never replaces one that started later.
/// A `watched_only` cache (a repository handle's) offers an entry for reuse only while a watcher
/// `cover`s that worktree.
#[derive(Debug, Default)]
pub struct WipCache {
    seq: AtomicU64,
    inner: Mutex<WipInner>,
    /// Per worktree: held while its lists are computed on request, so two requests at once (the
    /// UI reads a WIP row's two lists together) share one computation.
    list_reads: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

/// One worktree's WIP file lists, computed by the active tab's watcher (K44) from the status
/// read whose digest is `digest`, so selecting the WIP row needs no git process.
#[derive(Debug, Clone)]
pub struct WipLists {
    /// The `WipCache::stamp` taken before the status read they come from: an older computation
    /// never replaces a newer one.
    pub stamp: u64,
    /// The status digest they were computed with: they're served only while the cached status
    /// still has it.
    pub digest: u64,
    /// A digest of both lists, which `FileListPayload::version` and `repoChanged` carry.
    pub version: String,
    pub staged: Arc<FileListPayload>,
    pub unstaged: Arc<FileListPayload>,
}

impl WipLists {
    /// Stamps both lists with a version derived from their content.
    pub fn new(stamp: u64, digest: u64, mut staged: FileListPayload, mut unstaged: FileListPayload) -> Self {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for l in [&staged, &unstaged] {
            serde_json::to_vec(l).unwrap_or_default().hash(&mut h);
        }
        let version = format!("{:016x}", h.finish());
        staged.version = Some(version.clone());
        unstaged.version = Some(version.clone());
        Self { stamp, digest, version, staged: Arc::new(staged), unstaged: Arc::new(unstaged) }
    }
}

#[derive(Debug, Default)]
struct WipInner {
    entries: HashMap<PathBuf, (u64, WipEntry)>,
    /// The watcher's WIP lists per covered worktree; dropped with the coverage.
    lists: HashMap<PathBuf, WipLists>,
    /// `None`: every entry is reusable. `Some`: only the covered worktrees', and whose watcher
    /// (by serial) covers them.
    coverage: Option<(Option<u64>, HashSet<PathBuf>)>,
    /// The worktree the last graph laid out as the open one: the watcher keeps it responsive,
    /// and the others' changes throttled, with counts only (`None`: the handle's own).
    active: Option<PathBuf>,
    /// Worktrees whose kept lists were served (a `fileList`) since they were computed.
    served: HashSet<PathBuf>,
}

impl WipCache {
    /// A cache whose entries are reused only for worktrees a watcher covers.
    pub fn watched_only() -> Self {
        Self { inner: Mutex::new(WipInner { coverage: Some((None, HashSet::new())), ..Default::default() }), ..Default::default() }
    }

    /// The graph laid `path` out as the open worktree.
    pub fn set_active(&self, path: &Path) {
        self.lock().active = Some(Self::key(path));
    }

    /// The open worktree, if a graph named one.
    pub fn active(&self) -> Option<PathBuf> {
        self.lock().active.clone()
    }

    /// A `fileList` was answered from this worktree's kept lists (or computed them).
    pub fn mark_served(&self, path: &Path) {
        let key = Self::key(path);
        self.lock().served.insert(key);
    }

    /// Whether its kept lists were served since they were computed.
    pub fn served(&self, path: &Path) -> bool {
        let key = Self::key(path);
        self.lock().served.contains(&key)
    }

    /// Held while `path`'s lists are computed on request (see `list_reads`).
    pub async fn list_read(&self, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self.list_reads.lock().expect("wip cache poisoned").entry(Self::key(path)).or_default().clone();
        lock.lock_owned().await
    }

    fn key(path: &Path) -> PathBuf {
        crate::platform::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WipInner> {
        self.inner.lock().expect("wip cache poisoned")
    }

    /// Take one before a status read; pass it to `put` with that read's result.
    pub fn stamp(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn get(&self, path: &Path) -> Option<WipEntry> {
        let key = Self::key(path);
        self.lock().entries.get(&key).map(|(_, e)| *e)
    }

    /// `get`, if this worktree's entry may stand in for a status read (see `watched_only`).
    pub fn reusable(&self, path: &Path) -> Option<WipEntry> {
        let key = Self::key(path);
        let inner = self.lock();
        match &inner.coverage {
            Some((_, roots)) if !roots.contains(&key) => None,
            _ => inner.entries.get(&key).map(|(_, e)| *e),
        }
    }

    /// Stores `entry`, read under `stamp`, and returns what was cached before. A put whose
    /// stamp is older than the cached entry's changes nothing (and returns the entry that stays).
    pub fn put(&self, path: &Path, stamp: u64, entry: WipEntry) -> Option<WipEntry> {
        let key = Self::key(path);
        let mut inner = self.lock();
        match inner.entries.get(&key) {
            Some(&(held, current)) if held > stamp => Some(current),
            _ => inner.entries.insert(key, (stamp, entry)).map(|(_, e)| e),
        }
    }

    /// The watcher's lists for this worktree, whatever their status digest (the watcher compares
    /// versions with them).
    pub fn lists(&self, path: &Path) -> Option<WipLists> {
        let key = Self::key(path);
        self.lock().lists.get(&key).cloned()
    }

    /// Keeps `lists` unless newer ones (by stamp) are held.
    pub fn put_lists(&self, path: &Path, lists: WipLists) {
        let key = Self::key(path);
        let mut inner = self.lock();
        if inner.lists.get(&key).is_none_or(|held| held.stamp <= lists.stamp) {
            inner.served.remove(&key);
            inner.lists.insert(key, lists);
        }
    }

    pub fn drop_lists(&self, path: &Path) {
        let key = Self::key(path);
        let mut inner = self.lock();
        inner.served.remove(&key);
        inner.lists.remove(&key);
    }

    /// Whether a watcher covers this worktree.
    pub fn covered(&self, path: &Path) -> bool {
        let key = Self::key(path);
        matches!(&self.lock().coverage, Some((Some(_), roots)) if roots.contains(&key))
    }

    /// The watcher's lists for this worktree, if they may stand in for a `fileList`: a watcher
    /// covers it, and they were computed from the status the cache holds now.
    pub fn fresh_lists(&self, path: &Path) -> Option<WipLists> {
        let key = Self::key(path);
        let inner = self.lock();
        let covered = matches!(&inner.coverage, Some((Some(_), roots)) if roots.contains(&key));
        let lists = inner.lists.get(&key)?;
        let current = inner.entries.get(&key).is_some_and(|(_, e)| e.digest == lists.digest);
        (covered && current).then(|| lists.clone())
    }

    /// The watcher `owner` keeps these (canonical) worktrees fresh.
    pub fn cover(&self, owner: u64, roots: HashSet<PathBuf>) {
        let mut inner = self.lock();
        inner.lists.retain(|k, _| roots.contains(k));
        inner.served.retain(|k| roots.contains(k));
        inner.coverage = Some((Some(owner), roots));
    }

    /// The watcher `owner` stopped (or can't keep up): nothing is covered, unless another
    /// watcher took over meanwhile, and its lists are dropped.
    pub fn uncover(&self, owner: u64) {
        let inner = &mut *self.lock();
        if let Some((who, roots)) = &mut inner.coverage
            && *who == Some(owner)
        {
            *who = None;
            roots.clear();
            inner.lists.clear();
            inner.served.clear();
        }
    }
}

pub async fn build_graph(repo: gix::ThreadSafeRepository, workdir: PathBuf, cli: GitCli, opts: BuildOptions) -> Result<GraphPayload, GbError> {
    Ok(build_graph_with_text(repo, workdir, cli, opts).await?.0)
}

/// Like `build_graph`, plus each walked commit's lowercased full message (`summary + "\n" +
/// body`), in walk order, for find (spec §8.7).
pub async fn build_graph_with_text(repo: gix::ThreadSafeRepository, workdir: PathBuf, cli: GitCli, opts: BuildOptions) -> Result<(GraphPayload, Vec<(ObjectId, String)>), GbError> {
    let worktrees = list_worktrees(&workdir).await?;
    // `active` must be one of the usable worktrees (a crafted request can't lay out, or read the
    // status of, an arbitrary directory); checked against this list, so no second listing.
    if let Some(active) = &opts.active {
        let wanted = canonical(active);
        if !worktrees.iter().any(|w| !w.bare && !w.prunable && canonical(&w.path) == wanted) {
            return Err(GbError::new(crate::error::GbErrorKind::InvalidInput, format!("{} is not a worktree of this repository", active.display())));
        }
    }
    let wip = collect_wip(&cli, &worktrees, opts.wip_cache.as_deref(), opts.rescan).await;
    tokio::task::spawn_blocking(move || assemble(&repo.to_thread_local(), &worktrees, &wip, &workdir, &opts))
        .await
        .map_err(|e| GbError::other(format!("graph task failed: {e}")))?
}

/// The commits the graph walks from, deduplicated, in order: HEAD, every ref, every worktree's
/// HEAD, then the stashes. Find's `locateCommit` walks from the same tips, so the window it
/// computes is the one the graph then loads.
pub(crate) fn graph_tips(refs: &RepoRefs, worktrees: &[Worktree]) -> Vec<ObjectId> {
    let mut tips = Vec::new();
    let mut seen = HashSet::new();
    let candidates = refs.head.target.into_iter()
        .chain(refs.refs.iter().map(|r| r.target))
        .chain(worktrees.iter().filter_map(|w| w.head))
        .chain(refs.stashes.iter().map(|s| s.id));
    for id in candidates {
        if seen.insert(id) {
            tips.push(id);
        }
    }
    tips
}

/// (index into `worktrees`, counts) for every dirty, usable worktree. A worktree whose cached counts
/// are `reusable` keeps them unless `rescan`; every status that does run refreshes the cache
/// (stamped before the read, so an older read never replaces a newer one).
async fn collect_wip(cli: &GitCli, worktrees: &[Worktree], cache: Option<&WipCache>, rescan: bool) -> Vec<(usize, WipCounts)> {
    let jobs = worktrees.iter().enumerate().filter(|(_, w)| !w.bare && !w.prunable && w.path.is_dir()).map(|(i, w)| async move {
        if !rescan
            && let Some(e) = cache.and_then(|c| c.reusable(&w.path))
        {
            return Some((i, e.counts));
        }
        let stamp = cache.map(WipCache::stamp).unwrap_or(0);
        match status_raw(cli, &w.path).await {
            Ok(raw) => {
                let entry = WipEntry::from_raw(&raw);
                if let Some(c) = cache {
                    c.put(&w.path, stamp, entry);
                }
                Some((i, entry.counts))
            }
            Err(e) => {
                tracing::warn!("status failed for worktree {}: {e}", w.path.display());
                None
            }
        }
    });
    // A clean worktree has no WIP row, unless it's mid-operation: the row's commit panel holds the
    // operation's Continue and Abort (ux round 1).
    futures_util::future::join_all(jobs).await.into_iter().flatten().filter(|(i, c)| !c.is_empty() || crate::in_progress::mid_operation(&worktrees[*i].path)).collect()
}

/// The default trunk (the pin setting `auto`): the local counterpart of the main remote's
/// default branch.
/// 1. The remote trunk `T`: per remote, its HEAD's target, else its main, master, dev or develop.
///    Remotes in order: roots first (a remote whose project forks another remote's, by the
///    forge's cached data, comes after it), then by convention `upstream` (GitHub's fork
///    workflow: `origin` is your fork, `upstream` the original), `origin`, the others by name.
/// 2. Its local counterpart: a local branch whose upstream is `T` (the one named like `T`'s
///    branch first, then by name); else the local branch named like `T`'s branch, whatever its
///    upstream (in the fork workflow, `main` tracking your fork stands for `upstream/main`);
///    else `T` itself.
/// 3. No remote trunk at all (a local-only repo): the local main, master, dev or develop.
///
/// Returns the pin and, when it's a local counterpart, `T` (`GraphPayload::pinned_remote`).
fn default_trunk(refs: &RepoRefs, fork_parents: &HashMap<String, String>) -> Option<(String, Option<String>)> {
    match remote_trunk(refs, fork_parents) {
        Some((t, branch)) => Some(match local_counterpart(refs, &t, &branch) {
            Some(local) => (local, Some(t)),
            None => (t, None),
        }),
        None => ["main", "master", "dev", "develop"].into_iter().map(|b| format!("refs/heads/{b}")).find(|n| refs.refs.iter().any(|r| &r.full_name == n)).map(|n| (n, None)),
    }
}

/// An explicitly pinned local branch's remote counterpart: its upstream, when that ref exists.
fn upstream_ref(refs: &RepoRefs, pinned: &str) -> Option<String> {
    let upstream = refs.refs.iter().find(|r| r.kind == RefKind::Local && r.full_name == pinned)?.upstream.clone()?;
    refs.refs.iter().any(|r| r.full_name == upstream).then_some(upstream)
}

/// `T` and its branch part (`main` for `refs/remotes/origin/main`).
fn remote_trunk(refs: &RepoRefs, fork_parents: &HashMap<String, String>) -> Option<(String, String)> {
    let exists = |n: &str| refs.refs.iter().any(|r| r.full_name == n);
    // A parent that isn't a configured remote says nothing about the order.
    let is_fork = |r: &str| fork_parents.get(r).is_some_and(|p| p != r && refs.remote_hosts.contains_key(p));
    let convention = |r: &str| match r {
        "upstream" => 0,
        "origin" => 1,
        _ => 2,
    };
    let mut remotes: Vec<&String> = refs.remote_hosts.keys().collect();
    remotes.sort_by_key(|r| (is_fork(r), convention(r), r.as_str()));
    for remote in remotes {
        let prefix = format!("refs/remotes/{remote}/");
        if let Some(t) = refs.remote_heads.get(remote)
            && exists(t)
            && let Some(branch) = t.strip_prefix(&prefix)
        {
            return Some((t.clone(), branch.to_string()));
        }
        for b in ["main", "master", "dev", "develop"] {
            let name = format!("{prefix}{b}");
            if exists(&name) {
                return Some((name, b.to_string()));
            }
        }
    }
    None
}

/// The local branch standing for the remote trunk `t` (see `default_trunk`).
fn local_counterpart(refs: &RepoRefs, t: &str, branch: &str) -> Option<String> {
    let locals = || refs.refs.iter().filter(|r| r.kind == RefKind::Local);
    let mut tracking: Vec<_> = locals().filter(|r| r.upstream.as_deref() == Some(t)).collect();
    tracking.sort_by_key(|r| (r.short_name != branch, r.short_name.as_str()));
    if let Some(r) = tracking.first() {
        return Some(r.full_name.clone());
    }
    locals().find(|r| r.short_name == branch).map(|r| r.full_name.clone())
}

enum Entry {
    Commit(usize),
    Wip(usize),
}

fn assemble(repo: &gix::Repository, worktrees: &[Worktree], wip: &[(usize, WipCounts)], workdir: &Path, opts: &BuildOptions) -> Result<(GraphPayload, Vec<(ObjectId, String)>), GbError> {
    let mut refs = read_refs(repo)?;
    let stash_ids: HashSet<ObjectId> = refs.stashes.iter().map(|s| s.id).collect();

    // The tips come from the handle's own HEAD, whichever worktree is active: the active one's
    // HEAD is among the worktrees' anyway, and the same tips keep the walk cache valid across
    // a switch.
    let tips = graph_tips(&refs, worktrees);
    let walked = cached_walk(repo, tips, &stash_ids, opts)?;
    let commits = &walked.commits;

    // The active worktree's HEAD replaces the handle's (`read_refs` reads the handle's own).
    let active = opts.active.as_deref().map(canonical);
    if let Some(active) = &active
        && let Some(w) = worktrees.iter().find(|w| &canonical(&w.path) == active)
    {
        refs.head = crate::refs::HeadInfo { branch: w.branch.clone(), target: w.head, detached: w.branch.is_none() && w.head.is_some(), unborn: w.head.is_none() };
    }
    let index: HashMap<ObjectId, usize> = commits.iter().enumerate().map(|(i, c)| (c.id, i)).collect();

    let (pinned_ref_candidate, pinned_remote) = match (&opts.pinned_ref, opts.no_pin) {
        (_, true) => (None, None),
        (Some(name), false) => (Some(name.clone()), upstream_ref(&refs, name)),
        (None, false) => default_trunk(&refs, &opts.fork_parents).map_or((None, None), |(pin, t)| (Some(pin), t)),
    };
    let trunk_target = pinned_ref_candidate.as_ref().and_then(|n| refs.refs.iter().find(|r| &r.full_name == n)).map(|r| r.target);
    // Lane 0 is the trunk's whenever a pinned ref resolves, even if this window was cut above its
    // tip: the window then lays out exactly as the prefix of a longer one (spec §8.2).
    let reserve_trunk = trunk_target.is_some();
    let pinned_tip = trunk_target.filter(|id| index.contains_key(id));
    // Don't report a trunk name whose target isn't actually in the walked window (an invalid
    // override, or a ref whose commit got truncated out): that would show a name with nothing
    // pinned to it.
    let (pinned_ref, pinned_remote) = if pinned_tip.is_some() { (pinned_ref_candidate, pinned_remote) } else { (None, None) };
    let mut pinned: HashSet<usize> = HashSet::new();
    let mut cur = pinned_tip;
    while let Some(id) = cur {
        let Some(&i) = index.get(&id) else { break };
        if !pinned.insert(i) {
            break;
        }
        cur = commits[i].parents.first().copied();
    }

    // WIP placement (spec §8.6): the open worktree's WIP is "now", row 0, whatever the dates of
    // the commits below it; every other worktree's WIP docks directly above its HEAD commit,
    // several on one commit stacked by worktree name.
    let here = active.unwrap_or_else(|| canonical(workdir));
    let mut current_wip = None;
    let mut wip_by_head: HashMap<usize, Vec<usize>> = HashMap::new();
    // An unborn worktree (no HEAD yet) has changes but no commit to dock above: its WIP row has
    // no parent and sits at the top, so the first commit is reachable.
    let mut unborn_wip: Vec<usize> = vec![];
    for (k, (wt, _)) in wip.iter().enumerate() {
        let w = &worktrees[*wt];
        if w.head.is_none() {
            if current_wip.is_none() && canonical(&w.path) == here {
                current_wip = Some(k);
            } else {
                unborn_wip.push(k);
            }
            continue;
        }
        let Some(&ci) = w.head.and_then(|h| index.get(&h)) else { continue };
        if current_wip.is_none() && canonical(&w.path) == here {
            current_wip = Some(k);
        } else {
            wip_by_head.entry(ci).or_default().push(k);
        }
    }
    for stack in wip_by_head.values_mut() {
        stack.sort_by_cached_key(|&k| {
            let p = &worktrees[wip[k].0].path;
            (p.file_name().map(|f| f.to_os_string()), p.clone())
        });
    }
    let mut entries = Vec::with_capacity(commits.len() + wip.len());
    entries.extend(current_wip.map(Entry::Wip));
    entries.extend(unborn_wip.into_iter().map(Entry::Wip));
    let mut row_of_commit = vec![0u32; commits.len()];
    for (ci, slot) in row_of_commit.iter_mut().enumerate() {
        for &k in wip_by_head.get(&ci).map(Vec::as_slice).unwrap_or(&[]) {
            entries.push(Entry::Wip(k));
        }
        *slot = entries.len() as u32;
        entries.push(Entry::Commit(ci));
    }

    // The topmost WIP on the pinned tip rides the trunk's lane 0: nothing else is pinned above
    // the tip, so its dashed line runs down lane 0 into the tip (any other WIP on that commit
    // takes its own lane).
    let head_of = |k: usize| worktrees[wip[k].0].head.map(|h| index[&h]);
    let pinned_wip = entries.iter().find_map(|e| match *e {
        Entry::Wip(k) if head_of(k).is_some_and(|h| Some(commits[h].id) == pinned_tip && pinned.contains(&h)) => Some(k),
        _ => None,
    });
    let nodes: Vec<LayoutNode> = entries
        .iter()
        .map(|e| match e {
            Entry::Commit(ci) => {
                let c = &commits[*ci];
                LayoutNode {
                    parents: c.parents.iter().map(|p| index.get(p).map(|&pi| Parent::Row(row_of_commit[pi])).unwrap_or(Parent::Outside(*p))).collect(),
                    kind: if stash_ids.contains(&c.id) { NodeKind::Stash } else if c.parents.len() > 1 { NodeKind::Merge } else { NodeKind::Commit },
                    pinned: pinned.contains(ci),
                    time: c.committer_time,
                }
            }
            Entry::Wip(k) => LayoutNode { parents: head_of(*k).map(|h| Parent::Row(row_of_commit[h])).into_iter().collect(), kind: NodeKind::Wip, pinned: pinned_wip == Some(*k), time: i64::MAX },
        })
        .collect();
    let lay = layout(&nodes, reserve_trunk);
    // Unit tests and the harness (and so the e2e suite, including the opt-in real-repo spec)
    // verify every graph they build; a violation surfaces as an ordinary error, not a panic.
    #[cfg(any(test, feature = "testing"))]
    crate::graph::check_continuity(&lay, &nodes).map_err(|e| GbError::other(format!("graph continuity violated: {e}")))?;

    let main_path = worktrees.iter().find(|w| w.is_main).map(|w| w.path.clone());
    let rows = entries
        .iter()
        .zip(&lay.rows)
        .zip(&nodes)
        .map(|((e, g), n)| {
            let segments = g.segments.iter().map(|s| s.pack()).collect();
            match e {
                Entry::Commit(ci) => {
                    let c = &commits[*ci];
                    RowPayload {
                        id: c.id.to_string(),
                        kind: n.kind,
                        lane: g.lane,
                        color: g.color,
                        segments,
                        summary: c.summary.clone(),
                        body_first_line: c.body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string(),
                        author_name: c.author_name.clone(),
                        author_email: c.author_email.clone(),
                        author_time: c.author_time,
                        committer_time: c.committer_time,
                        parents: c.parents.iter().map(ObjectId::to_string).collect(),
                        // Parsed by the walk from the full message: no second object lookup.
                        mr_refs: c.mr_refs.clone(),
                        wip: None,
                    }
                }
                Entry::Wip(k) => {
                    let (wt_idx, counts) = wip[*k];
                    let wt = &worktrees[wt_idx];
                    let is_main = main_path.as_ref() == Some(&wt.path);
                    RowPayload {
                        id: format!("wip:{}", wt.path.display()),
                        kind: NodeKind::Wip,
                        lane: g.lane,
                        color: g.color,
                        segments,
                        summary: "// WIP".into(),
                        body_first_line: String::new(),
                        author_name: String::new(),
                        author_email: String::new(),
                        author_time: 0,
                        committer_time: 0,
                        parents: wt.head.map(|h| h.to_string()).into_iter().collect(),
                        mr_refs: vec![],
                        wip: Some(WipPayload {
                            worktree_path: wt.path.display().to_string(),
                            worktree_name: (!is_main).then(|| wt.path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()),
                            modified: counts.modified,
                            added: counts.added,
                            deleted: counts.deleted,
                            renamed: counts.renamed,
                            conflicted: counts.conflicted,
                        }),
                    }
                }
            }
        })
        .collect();

    let texts = commits.iter().map(|c| (c.id, format!("{}\n{}", c.summary, c.body).to_lowercase())).collect();
    // 2D-T6 begin
    let in_progress: std::collections::BTreeMap<String, crate::in_progress::InProgress> = worktrees
        .iter()
        .filter(|w| !w.bare && !w.prunable)
        .filter_map(|w| Some((w.path.display().to_string(), crate::in_progress::read(&w.path).ok()??)))
        .collect();
    // 2D-T6 end
    let payload = GraphPayload {
        rows,
        labels: build_labels(&refs, worktrees, &here, &index, &row_of_commit),
        max_lanes: lay.max_lanes,
        pinned_ref,
        pinned_remote,
        head: HeadPayload {
            branch: refs.head.branch.clone(),
            target: refs.head.target.map(|t| t.to_string()),
            detached: refs.head.detached,
            unborn: refs.head.unborn,
        },
        truncated: walked.truncated,
        open_worktree: worktrees.iter().find(|w| !w.bare && !w.prunable && canonical(&w.path) == here).map(|w| w.path.display().to_string()),
        // 2C T2: each worktree's in-progress kind, from 2D's map (one open per worktree).
        worktrees: worktrees
            .iter()
            .filter(|w| !w.bare && !w.prunable)
            .map(|w| {
                let path = w.path.display().to_string();
                let in_progress = in_progress.get(&path).map(|s| match s {
                    crate::in_progress::InProgress::Merge { .. } => "merge".to_string(),
                    crate::in_progress::InProgress::Rebase { .. } => "rebase".to_string(),
                    crate::in_progress::InProgress::CherryPick { .. } => "cherry-pick".to_string(),
                    crate::in_progress::InProgress::Revert { .. } => "revert".to_string(),
                    crate::in_progress::InProgress::Other { what } => what.clone(),
                });
                GraphWorktree { path, branch: w.branch.clone(), head: w.head.map(|h| h.to_string()), is_main: w.is_main, locked: w.locked, in_progress }
            })
            .collect(),
        in_progress,
    };
    Ok((payload, texts))
}

/// The walk from `tips`, served from the handle's walk cache when the tips, the window and the
/// stash set are the ones it last walked (commits are immutable, so nothing else can differ).
fn cached_walk(repo: &gix::Repository, tips: Vec<ObjectId>, stash_ids: &HashSet<ObjectId>, opts: &BuildOptions) -> Result<Arc<WalkResult>, GbError> {
    let mut first_parent: Vec<ObjectId> = stash_ids.iter().copied().collect();
    first_parent.sort();
    let key = (tips, opts.limit, first_parent);
    let cached = opts.walk_cache.as_ref().and_then(|c| c.lock().ok()?.as_ref().filter(|w| w.key == key).map(|w| w.walked.clone()));
    if let Some(w) = cached {
        return Ok(w);
    }
    let w = Arc::new(walk(repo, &key.0, &WalkOptions { limit: opts.limit, first_parent_only: stash_ids.clone() })?);
    if let Some(c) = &opts.walk_cache
        && let Ok(mut slot) = c.lock()
    {
        let walks = slot.as_ref().map_or(0, |s| s.walks) + 1;
        *slot = Some(WalkCache { key, walked: w.clone(), walks });
    }
    Ok(w)
}

fn canonical(p: &Path) -> PathBuf {
    crate::platform::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// `here`: the canonical open (active) worktree.
fn build_labels(refs: &RepoRefs, worktrees: &[Worktree], here: &Path, index: &HashMap<ObjectId, usize>, row_of_commit: &[u32]) -> Vec<RefLabel> {
    let checked_out_elsewhere: HashMap<&str, String> = worktrees
        .iter()
        .filter(|w| canonical(&w.path) != here)
        .filter_map(|w| w.branch.as_deref().map(|b| (b, w.path.display().to_string())))
        .collect();
    let checked_out: HashMap<&str, String> = worktrees.iter().filter_map(|w| w.branch.as_deref().map(|b| (b, w.path.display().to_string()))).collect();
    let row_of = |id: &ObjectId| index.get(id).map(|&i| row_of_commit[i]);
    let host_name = |remote: &str| refs.remote_host_names.get(remote).cloned();
    let host = |remote: &str| refs.remote_hosts.get(remote).copied().unwrap_or(HostKind::Generic);

    let mut labels = Vec::new();
    let mut merged: HashSet<&str> = HashSet::new();
    for local in refs.refs.iter().filter(|r| r.kind == RefKind::Local) {
        let Some(row) = row_of(&local.target) else { continue };
        let mut remotes = Vec::new();
        for rr in &refs.refs {
            let RefKind::Remote { remote } = &rr.kind else { continue };
            let branch_part = &rr.short_name[remote.len() + 1..];
            let is_counterpart = branch_part == local.short_name || local.upstream.as_deref() == Some(rr.full_name.as_str());
            if rr.target == local.target && is_counterpart {
                remotes.push(RemoteRefLabel { full_name: rr.full_name.clone(), remote: remote.clone(), host: host_name(remote), host_kind: host(remote) });
                merged.insert(rr.full_name.as_str());
            }
        }
        labels.push(RefLabel {
            row,
            name: local.short_name.clone(),
            local: Some(local.full_name.clone()),
            remotes,
            tag: false,
            is_head: refs.head.branch.as_deref() == Some(local.full_name.as_str()),
            worktree: checked_out_elsewhere.get(local.full_name.as_str()).cloned(),
            checked_out: checked_out.get(local.full_name.as_str()).cloned(),
            upstream_mismatch: local.upstream_mismatch.clone(),
            annotation: None,
        });
    }
    // Remote-only refs: one label per (commit, branch name), so the same branch on several
    // remotes at the same commit is ONE chip with one icon per remote (§8.5).
    let mut remote_only: HashMap<(ObjectId, &str), usize> = HashMap::new();
    for rr in &refs.refs {
        let RefKind::Remote { remote } = &rr.kind else { continue };
        if merged.contains(rr.full_name.as_str()) {
            continue;
        }
        let Some(row) = row_of(&rr.target) else { continue };
        // Only the branch part (`p/janderson/foo`, not `origin/p/janderson/foo`): the remote
        // icons already mark it as remote, and `remotes[].full_name` keeps each full name for
        // the tooltip.
        let branch = &rr.short_name[remote.len() + 1..];
        let remote_label = RemoteRefLabel { full_name: rr.full_name.clone(), remote: remote.clone(), host: host_name(remote), host_kind: host(remote) };
        match remote_only.get(&(rr.target, branch)) {
            Some(&i) => labels[i].remotes.push(remote_label),
            None => {
                remote_only.insert((rr.target, branch), labels.len());
                labels.push(RefLabel { row, name: branch.to_string(), local: None, remotes: vec![remote_label], tag: false, is_head: false, worktree: None, checked_out: None, upstream_mismatch: None, annotation: None });
            }
        }
    }
    for t in refs.refs.iter().filter(|r| r.kind == RefKind::Tag) {
        if let Some(row) = row_of(&t.target) {
            labels.push(RefLabel { row, name: t.short_name.clone(), local: None, remotes: vec![], tag: true, is_head: false, worktree: None, checked_out: None, upstream_mismatch: None, annotation: t.annotation.clone() });
        }
    }
    if refs.head.detached
        && let Some(row) = refs.head.target.as_ref().and_then(row_of)
    {
        labels.push(RefLabel { row, name: "HEAD".into(), local: None, remotes: vec![], tag: false, is_head: true, worktree: None, checked_out: None, upstream_mismatch: None, annotation: None });
    }
    // HEAD's branch, then locals: a published one (its remote at the same commit, `main` with
    // `origin/main`) before a local-only one, and one checked out in another worktree (a scratch
    // branch) last; then remote-only branches, then tags. Ties keep the refs' order.
    let priority = |l: &RefLabel| match () {
        _ if l.is_head => (0, 0),
        _ if l.local.is_some() => (1, if l.worktree.is_some() { 2 } else if l.remotes.is_empty() { 1 } else { 0 }),
        _ if !l.tag => (2, 0),
        _ => (3, 0),
    };
    labels.sort_by_key(|l| (l.row, priority(l)));
    labels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::NodeKind;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    async fn build(r: &TestRepo, opts: BuildOptions) -> GraphPayload {
        let repo = gix::ThreadSafeRepository::open(r.path()).unwrap();
        build_graph(repo, r.path().to_path_buf(), cli(), opts).await.unwrap()
    }

    #[tokio::test]
    async fn wip_cache_is_reused_unless_rescanning() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let cache = Arc::new(WipCache::default());
        let opts = || BuildOptions { wip_cache: Some(cache.clone()), ..Default::default() };
        let g = build(&r, opts()).await;
        let main_wip = |g: &GraphPayload| g.rows.iter().find_map(|row| row.wip.as_ref().filter(|w| w.worktree_name.is_none()).cloned()).unwrap();
        assert_eq!(main_wip(&g).modified, 1);
        r.write("brand-new.txt", "x\n");
        let g = build(&r, opts()).await;
        assert_eq!(main_wip(&g).added, 0, "cached counts are reused");
        let g = build(&r, BuildOptions { wip_cache: Some(cache.clone()), rescan: true, ..Default::default() }).await;
        assert_eq!(main_wip(&g).added, 1, "rescan refreshes");
    }

    #[test]
    fn wip_cache_put_returns_the_previous_entry() {
        let c = WipCache::default();
        let dir = tempfile::tempdir().unwrap();
        let e = WipEntry::from_raw(b"1 .M N... 100644 100644 100644 a b f\0");
        assert_eq!(c.put(dir.path(), c.stamp(), e), None);
        assert_eq!(c.put(dir.path(), c.stamp(), e), Some(e));
        let clean = WipEntry::from_raw(b"");
        assert_eq!(c.put(dir.path(), c.stamp(), clean), Some(e));
        assert_eq!(c.get(dir.path()).unwrap().counts, WipCounts::default());
    }

    /// Two writers (a graph build and the watcher): a status read that started earlier never
    /// replaces one that started later, whichever finishes last.
    #[test]
    fn an_older_status_read_never_replaces_a_newer_one() {
        let c = WipCache::default();
        let dir = tempfile::tempdir().unwrap();
        let (older, newer) = (c.stamp(), c.stamp());
        let (old, new) = (WipEntry::from_raw(b"? a\0"), WipEntry::from_raw(b""));
        c.put(dir.path(), newer, new);
        assert_eq!(c.put(dir.path(), older, old), Some(new), "the stale put reports what stays");
        assert_eq!(c.get(dir.path()), Some(new));
    }

    /// A watched-only cache (a repo handle's) reuses an entry only for a worktree its watcher
    /// covers, and only while that watcher's coverage stands.
    /// K44: kept lists stand in for a `fileList` only while covered and computed from the status
    /// held now; uncovering drops them.
    #[test]
    fn kept_wip_lists_are_fresh_only_while_covered_and_current() {
        let c = WipCache::watched_only();
        let a = tempfile::tempdir().unwrap();
        let root = crate::platform::fs::canonicalize(a.path()).unwrap();
        let empty = || FileListPayload { files: vec![], added: 0, deleted: 0, version: None };
        let e = WipEntry::from_raw(b"? a\0");
        c.put(&root, c.stamp(), e);
        c.put_lists(&root, WipLists::new(1, e.digest, empty(), empty()));
        assert!(c.fresh_lists(&root).is_none(), "not covered");
        c.cover(1, HashSet::from([root.clone()]));
        let l = c.fresh_lists(&root).expect("covered and current");
        assert_eq!(l.staged.version.as_deref(), Some(l.version.as_str()));
        c.put(&root, c.stamp(), WipEntry::from_raw(b""));
        assert!(c.fresh_lists(&root).is_none(), "computed from an older status");
        c.put(&root, c.stamp(), e);
        assert!(c.fresh_lists(&root).is_some());
        c.uncover(1);
        assert!(c.fresh_lists(&root).is_none() && c.lists(&root).is_none(), "dropped with the coverage");
    }

    #[test]
    fn a_watched_only_cache_reuses_covered_worktrees_only() {
        let c = WipCache::watched_only();
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let e = WipEntry::from_raw(b"");
        c.put(a.path(), c.stamp(), e);
        c.put(b.path(), c.stamp(), e);
        assert_eq!(c.reusable(a.path()), None, "nothing is covered yet");
        c.cover(7, [crate::platform::fs::canonicalize(a.path()).unwrap()].into());
        assert_eq!(c.reusable(a.path()), Some(e));
        assert_eq!(c.reusable(b.path()), None, "not covered by the watcher");
        c.uncover(8);
        assert_eq!(c.reusable(a.path()), Some(e), "another watcher's uncover changes nothing");
        c.uncover(7);
        assert_eq!(c.reusable(a.path()), None);
        assert_eq!(WipCache::default().reusable(a.path()), None);
    }

    #[tokio::test]
    async fn basic_fixture_rows_kinds_and_pinning() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;

        let kinds: Vec<NodeKind> = g.rows.iter().map(|x| x.kind).collect();
        use NodeKind::*;
        assert_eq!(kinds, vec![Wip, Stash, Wip, Commit, Merge, Commit, Commit, Commit, Commit, Commit]);
        let summaries: Vec<&str> = g.rows.iter().map(|x| x.summary.as_str()).collect();
        assert_eq!(summaries[1], "On main: Experiment");
        assert_eq!(summaries[3], "Hotfix: null check");
        assert_eq!(summaries[4], "Merge branch 'feature/login'");
        assert_eq!(g.pinned_ref.as_deref(), Some("refs/heads/main"));

        let lane = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap().lane;
        for s in ["Merge branch 'feature/login'", "Fix typo", "Add readme", "Initial commit"] {
            assert_eq!(lane(s), 0, "{s} is on the pinned trunk");
        }
        for s in ["Login form", "Login validation", "Hotfix: null check", "On main: Experiment"] {
            assert_ne!(lane(s), 0, "{s} is off-trunk");
        }
        assert_eq!(g.rows[0].lane, 0, "main's WIP row is row 0, on the pinned trunk lane down to its HEAD (the pinned tip)");
        assert!(!g.truncated);
        assert!(g.head.branch.as_deref() == Some("refs/heads/main") && !g.head.unborn);
    }

    #[tokio::test]
    async fn wip_rows_carry_worktree_and_counts() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let hotfix = g.rows[2].wip.as_ref().unwrap();
        assert_eq!(hotfix.worktree_name.as_deref(), Some("wt-hotfix"));
        assert_eq!(hotfix.modified, 1);
        assert!(g.rows[2].id.starts_with("wip:"));
        assert_eq!(g.rows[2].parents, vec![g.rows[3].id.clone()]);
        let main = g.rows[0].wip.as_ref().unwrap();
        assert_eq!(main.worktree_name, None);
        assert_eq!(main.modified, 1);
        let out: Vec<_> = g.rows[2].segments.iter().map(|&s| crate::graph::Segment::unpack(s)).filter(|s| s.half == crate::graph::Half::Bottom).collect();
        assert!(!out.is_empty() && out.iter().all(|s| s.dashed), "WIP outgoing segments are dashed");
    }

    /// On one commit: a published local branch (with its remote) leads a local-only one, and a
    /// branch checked out in another worktree comes last, whatever their names.
    #[tokio::test]
    async fn a_rows_published_branch_leads_its_local_and_worktree_ones() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["branch", "a-local", "feature/login"]);
        r.git(&["branch", "a-wt", "feature/login"]);
        let p = r.root().join("wt-a");
        r.git(&["worktree", "add", "-q", p.to_str().unwrap(), "a-wt"]);
        let g = build(&r, BuildOptions::default()).await;
        let row = g.labels.iter().find(|l| l.name == "feature/login").unwrap().row;
        let names: Vec<_> = g.labels.iter().filter(|l| l.row == row).map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["feature/login", "a-local", "a-wt"]);
    }

    #[tokio::test]
    async fn labels_merge_local_and_remote() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let label = |name: &str| g.labels.iter().find(|l| l.name == name).unwrap_or_else(|| panic!("no label {name}"));

        let main = label("main");
        assert_eq!(main.row, 4);
        assert!(main.is_head);
        assert_eq!(main.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/origin/main"]);

        let login = label("feature/login");
        assert_eq!(g.rows[login.row as usize].summary, "Login validation");
        assert_eq!(login.remotes.len(), 1);

        let hotfix = label("hotfix");
        assert!(hotfix.remotes.is_empty());
        assert!(hotfix.worktree.as_deref().unwrap().ends_with("wt-hotfix"));

        let tag = label("v1.0");
        assert!(tag.tag);
        assert_eq!(g.rows[tag.row as usize].summary, "Add readme");

        assert!(!g.labels.iter().any(|l| l.name.starts_with("origin/")), "all remotes merged into local labels");
    }

    #[tokio::test]
    async fn unborn_repo_has_empty_graph() {
        let r = TestRepo::new();
        fixtures::unborn(&r);
        let g = build(&r, BuildOptions::default()).await;
        assert!(g.rows.is_empty());
        assert!(g.head.unborn);
        assert_eq!(g.pinned_ref, None);
    }

    #[tokio::test]
    async fn unborn_repo_with_changes_has_a_lone_parentless_wip_row() {
        let r = TestRepo::new();
        fixtures::unborn(&r);
        std::fs::write(r.path().join("first.txt"), "hi\n").unwrap();
        let g = build(&r, BuildOptions::default()).await;
        assert!(g.head.unborn);
        assert_eq!(g.rows.len(), 1, "only the WIP row");
        assert_eq!(g.rows[0].kind, NodeKind::Wip);
        assert!(g.rows[0].parents.is_empty());
        assert_eq!(g.rows[0].wip.as_ref().unwrap().added + g.rows[0].wip.as_ref().unwrap().modified, 1);
    }

    #[tokio::test]
    async fn pinned_override_moves_trunk() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions { pinned_ref: Some("refs/heads/hotfix".into()), ..Default::default() }).await;
        let lane = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap().lane;
        assert_eq!(lane("Hotfix: null check"), 0);
        assert_eq!(lane("Merge branch 'feature/login'"), 0, "the hotfix chain includes the merge");
        assert_ne!(lane("On main: Experiment"), 0);
    }

    #[tokio::test]
    async fn pin_off_disables_the_default_trunk() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        assert!(build(&r, BuildOptions::default()).await.pinned_ref.is_some());
        let g = build(&r, BuildOptions { no_pin: true, ..Default::default() }).await;
        assert_eq!(g.pinned_ref, None);
    }

    /// A repo with `main` published to origin and origin/HEAD set to it.
    fn published_main(r: &TestRepo) {
        r.commit("base");
        r.add_origin();
        r.push("main");
        r.git(&["remote", "set-head", "origin", "main"]);
    }

    #[tokio::test]
    async fn the_default_trunk_is_the_local_branch_tracking_origin_head() {
        let r = TestRepo::new();
        published_main(&r);
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/main"));
    }

    #[tokio::test]
    async fn the_default_trunk_is_a_differently_named_local_branch_tracking_origin_head() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["branch", "-q", "-m", "main", "trunk"]);
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/trunk"));
        // Two local branches tracking it: the one named like it wins.
        r.git(&["branch", "-q", "--track", "main", "origin/main"]);
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/main"));
    }

    #[tokio::test]
    async fn the_default_trunk_is_a_same_named_local_branch_without_upstream() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["branch", "-q", "--unset-upstream", "main"]);
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/main"));
    }

    #[tokio::test]
    async fn the_default_trunk_is_the_remote_ref_without_a_local_counterpart() {
        let r = TestRepo::new();
        published_main(&r);
        r.switch_new("feature");
        r.git(&["branch", "-q", "-D", "main"]);
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!((g.pinned_ref.as_deref(), g.pinned_remote), (Some("refs/remotes/origin/main"), None), "the pin is T itself: no separate remote");
    }

    /// No local branch tracks T: the local branch named like it is the pin, whatever it tracks;
    /// one that does track T wins over it.
    #[tokio::test]
    async fn a_same_named_local_branch_is_the_pin_whatever_its_upstream() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["update-ref", "refs/remotes/origin/other", "HEAD"]);
        r.git(&["branch", "-q", "--set-upstream-to", "origin/other", "main"]);
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!((g.pinned_ref.as_deref(), g.pinned_remote.as_deref()), (Some("refs/heads/main"), Some("refs/remotes/origin/main")));
        r.git(&["branch", "-q", "--track", "trunk", "origin/main"]);
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/trunk"), "tracking T comes first");
    }

    /// `pinned_remote`: the remote counterpart of a pinned local branch (the default pick's T, an
    /// explicit pin's upstream); none when the pin is a remote ref or has no upstream.
    #[tokio::test]
    async fn the_pinned_remote_names_the_pinned_local_branchs_remote_counterpart() {
        let r = TestRepo::new();
        published_main(&r);
        r.switch_new("hotfix");
        r.commit("H");
        r.push("hotfix");
        r.switch_new("scratch");
        let pin = |name: &str| BuildOptions { pinned_ref: Some(name.into()), ..Default::default() };
        let remote_of = |g: GraphPayload| g.pinned_remote;
        assert_eq!(remote_of(build(&r, BuildOptions::default()).await).as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!(remote_of(build(&r, pin("refs/heads/hotfix")).await).as_deref(), Some("refs/remotes/origin/hotfix"), "an explicit pin: its upstream");
        assert_eq!(remote_of(build(&r, pin("refs/heads/scratch")).await), None, "no upstream");
        assert_eq!(remote_of(build(&r, pin("refs/remotes/origin/hotfix")).await), None, "a remote pin");
        assert_eq!(remote_of(build(&r, BuildOptions { no_pin: true, ..Default::default() }).await), None);
    }

    #[tokio::test]
    async fn a_local_only_repo_pins_its_local_main() {
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("hotfix");
        r.commit("H");
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/main"));
        r.git(&["branch", "-q", "-m", "main", "work"]);
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref, None, "no main, master, dev or develop: no trunk");
    }

    /// `origin` and `upstream`, both with a main; local `main` tracks `track`'s.
    fn fork_layout(r: &TestRepo, track: &str) {
        published_main(r);
        let origin = r.root().join("origin.git");
        r.git(&["remote", "add", "upstream", origin.to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/upstream/main", "HEAD"]);
        r.git(&["branch", "-q", "--set-upstream-to", &format!("{track}/main"), "main"]);
    }

    #[tokio::test]
    async fn without_forge_data_upstream_is_the_root_remote() {
        let r = TestRepo::new();
        fork_layout(&r, "upstream");
        assert_eq!(build(&r, BuildOptions::default()).await.pinned_ref.as_deref(), Some("refs/heads/main"));
        // main tracks the fork (origin): still the pin, as upstream/main's local counterpart.
        r.git(&["branch", "-q", "--set-upstream-to", "origin/main", "main"]);
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!((g.pinned_ref.as_deref(), g.pinned_remote.as_deref()), (Some("refs/heads/main"), Some("refs/remotes/upstream/main")));
    }

    #[tokio::test]
    async fn cached_fork_data_makes_the_parent_remote_the_root() {
        let r = TestRepo::new();
        fork_layout(&r, "origin");
        // Reversed naming: upstream's project is a fork of origin's.
        let fork_parents = HashMap::from([("upstream".to_string(), "origin".to_string())]);
        let g = build(&r, BuildOptions { fork_parents: fork_parents.clone(), ..Default::default() }).await;
        assert_eq!(g.pinned_ref.as_deref(), Some("refs/heads/main"));
        // A parent that isn't one of the remotes changes nothing.
        assert_eq!(g.pinned_remote.as_deref(), Some("refs/remotes/origin/main"));
        // A parent that isn't one of the remotes changes nothing: upstream is the root.
        let elsewhere = HashMap::from([("upstream".to_string(), "someone-else".to_string())]);
        let g = build(&r, BuildOptions { fork_parents: elsewhere, ..Default::default() }).await;
        assert_eq!(g.pinned_remote.as_deref(), Some("refs/remotes/upstream/main"));
    }

    #[tokio::test]
    async fn an_explicit_remote_pin_stays_the_remote_ref() {
        let r = TestRepo::new();
        published_main(&r);
        let g = build(&r, BuildOptions { pinned_ref: Some("refs/remotes/origin/main".into()), ..Default::default() }).await;
        assert_eq!(g.pinned_ref.as_deref(), Some("refs/remotes/origin/main"));
        let g = build(&r, BuildOptions { pinned_ref: Some("refs/heads/main".into()), no_pin: true, ..Default::default() }).await;
        assert_eq!(g.pinned_ref, None);
    }

    #[tokio::test]
    async fn missing_worktree_directory_is_skipped() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        std::fs::remove_dir_all(r.root().join("wt-hotfix")).unwrap();
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.rows.iter().filter(|x| x.kind == NodeKind::Wip).count(), 1);
    }

    #[tokio::test]
    async fn detached_head_gets_a_head_label() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["switch", "-q", "--detach", "HEAD~1"]);
        let g = build(&r, BuildOptions::default()).await;
        let head = g.labels.iter().find(|l| l.name == "HEAD").unwrap();
        assert!(head.is_head);
        assert_eq!(g.rows[head.row as usize].summary, "Fix typo");
    }

    #[tokio::test]
    async fn wide_fixture_holds_one_lane_per_branch() {
        let r = TestRepo::new();
        fixtures::wide(&r);
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.rows.len(), fixtures::WIDE_BRANCHES + 1);
        assert_eq!(g.pinned_ref.as_deref(), Some("refs/heads/main"), "no remote: the local main");
        assert_eq!(usize::from(g.max_lanes), fixtures::WIDE_BRANCHES + 1, "the trunk keeps lane 0");
    }

    /// K79: the dev merge is newer than the branches forked under it, so it locks its parents in
    /// its own lanes and the later forks curve in from the left (the column rule).
    #[tokio::test]
    async fn merge_lock_fixture_keeps_the_trunk_lane() {
        let r = TestRepo::new();
        fixtures::merge_lock(&r);
        let g = build(&r, BuildOptions::default()).await;
        let summaries: Vec<&str> = g.rows.iter().map(|x| x.summary.as_str()).collect();
        assert_eq!(
            summaries,
            ["// WIP", "Spike: streaming", "Merge branch 'feature/parser' into dev", "Spike: tokens", "Parser", "Retry policy", "Config loader", "Initial commit"]
        );
        let lanes: Vec<u16> = g.rows.iter().map(|x| x.lane).collect();
        assert_eq!(lanes, [0, 1, 2, 1, 3, 1, 2, 0]);
        let from_left = |row: usize| unpacked(&g.rows[row]).iter().any(|s| s.half == crate::graph::Half::Top && s.from_lane < s.to_lane);
        assert!(from_left(4), "Spike: tokens' lane curves right into Parser");
        assert!(from_left(6), "Retry policy's lane curves right into Config loader");
        assert_eq!(g.max_lanes, 4);
    }

    /// A window cut above the pinned trunk's tip still reserves lane 0 for it, so every row it
    /// shows sits where the whole history puts it (the window is the whole's prefix).
    #[tokio::test]
    async fn a_window_cut_above_the_trunk_tip_keeps_lane_zero_for_it() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let whole = build(&r, BuildOptions::default()).await;
        let cut = build(&r, BuildOptions { limit: 2, ..Default::default() }).await;
        assert!(cut.truncated && cut.pinned_ref.is_none(), "the pinned tip is below the cut");
        let lane_in_whole = |id: &str| whole.rows.iter().find(|x| x.id == id).unwrap().lane;
        for row in cut.rows.iter().filter(|x| x.kind != NodeKind::Wip) {
            assert_ne!(row.lane, 0, "{} stays off the trunk's lane", row.summary);
            assert_eq!(row.lane, lane_in_whole(&row.id), "{} is where the whole history puts it", row.summary);
        }
    }

    #[tokio::test]
    async fn limit_truncates() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions { limit: 3, ..Default::default() }).await;
        assert!(g.truncated);
        assert_eq!(g.rows.iter().filter(|x| x.kind != NodeKind::Wip).count(), 3);
    }

    #[tokio::test]
    async fn snapshot_basic_fixture() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        insta::assert_snapshot!(build(&r, BuildOptions::default()).await.ascii());
    }

    /// A linked worktree `name`, detached at main's HEAD (the pinned tip), with an uncommitted change.
    fn add_worktree_at_main_head(r: &TestRepo, name: &str) -> std::path::PathBuf {
        let p = r.root().join(name);
        r.git(&["worktree", "add", "-q", "--detach", p.to_str().unwrap(), "main"]);
        std::fs::write(p.join("file_2.txt"), "linked worktree change\n").expect("write worktree file");
        p
    }

    fn wip_name(row: &RowPayload) -> Option<&str> {
        row.wip.as_ref().expect("a WIP row").worktree_name.as_deref()
    }

    fn unpacked(row: &RowPayload) -> Vec<crate::graph::Segment> {
        row.segments.iter().map(|&s| crate::graph::Segment::unpack(s)).collect()
    }

    /// The WIP's dashed line runs unbroken from its row down into `head`'s row: a dashed Full
    /// segment on one lane through every row between (the layout's continuity check covers the
    /// rest).
    fn assert_dashed_line(g: &GraphPayload, wip: usize, head: usize) {
        use crate::graph::Half;
        let out = unpacked(&g.rows[wip]);
        let start = out.iter().find(|s| s.half == Half::Bottom).expect("the WIP's outgoing segment");
        assert!(start.dashed);
        let lane = start.to_lane;
        for r in wip + 1..head {
            assert!(unpacked(&g.rows[r]).iter().any(|s| s.half == Half::Full && s.from_lane == lane && s.dashed), "row {r}: the WIP's dashed lane {lane} passes through");
        }
        assert!(unpacked(&g.rows[head]).iter().any(|s| s.half == Half::Top && s.from_lane == lane && s.dashed), "the dashed lane ends in the HEAD commit");
    }

    #[tokio::test]
    async fn current_worktree_wip_is_row_0_when_head_is_not_the_newest_commit() {
        // HEAD (`feature`, F) is older than main's three commits and the stash: its WIP is still
        // row 0, "now", with a dashed line down to F.
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("feature");
        r.commit("F");
        r.switch("main");
        r.commit("M1");
        r.commit("M2");
        r.stash("newer stash");
        r.commit("M3");
        r.switch("feature");
        r.write("file_1.txt", "dirty\n");
        let g = build(&r, BuildOptions::default()).await;
        let summaries: Vec<&str> = g.rows.iter().map(|x| x.summary.as_str()).collect();
        assert_eq!(summaries, ["// WIP", "M3", "On main: newer stash", "M2", "M1", "F", "base"]);
        assert_eq!(wip_name(&g.rows[0]), None);
        assert_eq!(g.rows[0].parents, [g.rows[5].id.clone()]);
        assert_dashed_line(&g, 0, 5);
    }

    #[tokio::test]
    async fn current_worktree_wip_is_row_0_above_a_newer_remote_tip() {
        // origin/main is ahead of the checked-out main: the WIP is row 0 anyway. The trunk is the
        // local main, so the WIP rides its lane down to it and origin/main's newer O sits beside.
        let r = TestRepo::new();
        r.commit("base");
        r.add_origin();
        r.commit("M");
        r.push("main");
        r.git(&["remote", "set-head", "origin", "main"]);
        r.commit("O");
        r.push("main");
        r.git(&["reset", "-q", "--hard", "HEAD~1"]);
        r.write("file_0.txt", "dirty\n");
        let g = build(&r, BuildOptions::default()).await;
        let summaries: Vec<&str> = g.rows.iter().map(|x| x.summary.as_str()).collect();
        assert_eq!(summaries, ["// WIP", "O", "M", "base"]);
        assert_eq!((g.rows[0].lane, g.rows[2].lane), (0, 0), "the WIP and main's M are on the pinned lane");
        assert_ne!(g.rows[1].lane, 0, "origin/main's newer tip is off the trunk");
        assert_dashed_line(&g, 0, 2);
    }

    #[tokio::test]
    async fn linked_worktree_wip_docks_above_its_head_and_the_opened_worktree_is_row_0() {
        // basic: wt-hotfix's WIP sits directly above `Hotfix: null check`, main's WIP is row 0.
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let hotfix = g.rows.iter().position(|x| x.summary == "Hotfix: null check").unwrap();
        assert_eq!(wip_name(&g.rows[hotfix - 1]), Some("wt-hotfix"));
        assert_eq!(wip_name(&g.rows[0]), None);
        assert_dashed_line(&g, hotfix - 1, hotfix);

        // Opened from the linked worktree, the roles swap: its WIP is row 0, main's docks above
        // main's HEAD (the merge, where it is the topmost WIP on the pinned tip: lane 0).
        let wt = r.root().join("wt-hotfix");
        let repo = gix::ThreadSafeRepository::open(&wt).unwrap();
        let g = build_graph(repo, wt.clone(), cli(), BuildOptions::default()).await.unwrap();
        let summaries: Vec<&str> = g.rows.iter().take(5).map(|x| x.summary.as_str()).collect();
        assert_eq!(summaries, ["// WIP", "On main: Experiment", "Hotfix: null check", "// WIP", "Merge branch 'feature/login'"]);
        assert_eq!(wip_name(&g.rows[0]), Some("wt-hotfix"));
        assert_eq!(wip_name(&g.rows[3]), None);
        assert_eq!(g.rows[3].lane, 0);
        assert_dashed_line(&g, 0, 2);
        assert_eq!(g.open_worktree.as_deref(), Some(g.rows[0].wip.as_ref().unwrap().worktree_path.as_str()), "the open worktree, spelled as its WIP row's");
    }

    #[tokio::test]
    async fn open_worktree_is_reported_clean_or_dirty() {
        let r = TestRepo::new();
        r.commit("base");
        let g = build(&r, BuildOptions::default()).await;
        assert!(g.rows.iter().all(|x| x.kind != NodeKind::Wip), "clean");
        assert_eq!(g.open_worktree.as_deref().map(|p| canonical(Path::new(p))), Some(canonical(r.path())));
        r.write("file_0.txt", "dirty\n");
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.open_worktree.as_deref(), Some(g.rows[0].wip.as_ref().unwrap().worktree_path.as_str()));
    }

    #[tokio::test]
    async fn worktrees_on_one_commit_current_on_top_others_stacked_by_name() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        // Created out of name order: the stack is by name all the same.
        add_worktree_at_main_head(&r, "wt-zeta");
        add_worktree_at_main_head(&r, "wt-alpha");

        let g = build(&r, BuildOptions::default()).await;
        let merge = g.rows.iter().position(|x| x.summary == "Merge branch 'feature/login'").unwrap();
        assert_eq!(wip_name(&g.rows[0]), None, "the open worktree's WIP is row 0");
        assert_eq!([wip_name(&g.rows[merge - 2]), wip_name(&g.rows[merge - 1])], [Some("wt-alpha"), Some("wt-zeta")]);
        assert_eq!(g.rows.iter().filter(|x| x.kind == NodeKind::Wip).count(), 4, "plus wt-hotfix's");

        // The topmost WIP on the pinned tip (row 0) rides lane 0 down to it; the docked ones
        // take their own lanes, which converge on the merge.
        assert_eq!(g.rows[0].lane, 0);
        assert_dashed_line(&g, 0, merge);
        for w in [merge - 2, merge - 1] {
            assert_ne!(g.rows[w].lane, 0);
            assert_dashed_line(&g, w, merge);
        }
    }

    #[tokio::test]
    async fn snapshot_stacked_wip_rows() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        add_worktree_at_main_head(&r, "wt-second");
        insta::assert_snapshot!(build(&r, BuildOptions::default()).await.ascii());
    }

    #[tokio::test]
    async fn rows_carry_committer_time_distinct_from_author_time() {
        let r = TestRepo::new();
        r.commit("Initial commit");
        r.commit("Amended later");
        // TestRepo's clock advances 60 s per git call, and an amend keeps the original author
        // date while stamping a fresh committer date: the two must now differ, and the row must
        // carry both.
        r.git(&["commit", "-q", "--amend", "--no-edit"]);
        let author = r.git(&["log", "-1", "--format=%at"]).parse::<i64>().unwrap();
        let committer = r.git(&["log", "-1", "--format=%ct"]).parse::<i64>().unwrap();
        assert!(committer > author, "precondition: amend must leave committer date after author date");

        let g = build(&r, BuildOptions::default()).await;
        let row = g.rows.iter().find(|x| x.summary == "Amended later").unwrap();
        assert_eq!(row.author_time, author);
        assert_eq!(row.committer_time, committer);
        assert_ne!(row.committer_time, row.author_time);
    }

    #[tokio::test]
    async fn wip_rows_have_zero_committer_time() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions::default()).await;
        let wips: Vec<_> = g.rows.iter().filter(|x| x.kind == NodeKind::Wip).collect();
        assert!(!wips.is_empty());
        assert!(wips.iter().all(|w| w.committer_time == 0 && w.author_time == 0));
    }

    #[tokio::test]
    async fn remote_only_labels_drop_the_remote_name_and_merge_across_remotes() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let fix_typo = r.git(&["rev-parse", "main~1"]);
        // A remote-only branch on origin, and the same branch name on a second remote at the
        // same commit: they merge into ONE label (one icon per remote), showing only the branch
        // part.
        r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/origin/p/janderson/foo", &fix_typo]);
        r.git(&["update-ref", "refs/remotes/upstream/p/janderson/foo", &fix_typo]);
        // The same name on a remote at a DIFFERENT commit stays its own label.
        let readme = r.git(&["rev-parse", "v1.0^{commit}"]);
        r.git(&["update-ref", "refs/remotes/upstream/elsewhere", &readme]);
        r.git(&["update-ref", "refs/remotes/origin/elsewhere", &fix_typo]);
        let g = build(&r, BuildOptions::default()).await;

        let foo: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "p/janderson/foo").collect();
        assert_eq!(foo.len(), 1, "one label for the branch name on both remotes: {:?}", g.labels);
        let foo = foo[0];
        let full: Vec<&str> = foo.remotes.iter().map(|x| x.full_name.as_str()).collect();
        assert_eq!(full, vec!["refs/remotes/origin/p/janderson/foo", "refs/remotes/upstream/p/janderson/foo"]);
        assert_eq!(foo.remotes.iter().map(|x| x.remote.as_str()).collect::<Vec<_>>(), vec!["origin", "upstream"]);
        assert!(foo.local.is_none() && !foo.tag && !foo.is_head);
        assert_eq!(g.rows[foo.row as usize].summary, "Fix typo");

        let elsewhere: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "elsewhere").collect();
        assert_eq!(elsewhere.len(), 2, "different commits keep separate labels");
        assert!(elsewhere.iter().all(|l| l.remotes.len() == 1));
        assert!(!g.labels.iter().any(|l| l.name.starts_with("origin/") || l.name.starts_with("upstream/")));
    }

    #[tokio::test]
    async fn local_label_merges_every_same_named_remote_at_its_commit() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let main = r.git(&["rev-parse", "main"]);
        r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/upstream/main", &main]);
        let g = build(&r, BuildOptions::default()).await;
        let mains: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "main").collect();
        assert_eq!(mains.len(), 1, "{:?}", g.labels);
        let m = mains[0];
        assert_eq!(m.local.as_deref(), Some("refs/heads/main"));
        assert!(m.is_head, "HEAD stays on the local label");
        assert_eq!(m.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/origin/main", "refs/remotes/upstream/main"]);
        assert!(g.labels.iter().any(|l| l.tag && l.name == "v1.0"), "tags stay separate labels");
    }

    #[tokio::test]
    async fn local_label_takes_only_the_remotes_at_its_commit() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        // main == origin/main at the merge; upstream/main lags one commit behind, at "Fix typo".
        let fix_typo = r.git(&["rev-parse", "main~1"]);
        r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/upstream/main", &fix_typo]);
        let g = build(&r, BuildOptions::default()).await;
        let mains: Vec<&RefLabel> = g.labels.iter().filter(|l| l.name == "main").collect();
        assert_eq!(mains.len(), 2, "{:?}", g.labels);
        let local = mains.iter().find(|l| l.local.is_some()).unwrap();
        assert_eq!(local.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/origin/main"]);
        assert_eq!(g.rows[local.row as usize].summary, "Merge branch 'feature/login'");
        let lagging = mains.iter().find(|l| l.local.is_none()).unwrap();
        assert_eq!(lagging.remotes.iter().map(|x| x.full_name.as_str()).collect::<Vec<_>>(), vec!["refs/remotes/upstream/main"]);
        assert_eq!(g.rows[lagging.row as usize].summary, "Fix typo");
    }

    #[tokio::test]
    async fn rows_carry_message_refs_and_wip_rows_have_none() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let g = build(&r, BuildOptions::default()).await;
        let row = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap_or_else(|| panic!("no row {s}"));
        // The refs sit in the body (DETAILS_MESSAGE); the URL in it contributes nothing.
        assert_eq!(row("Rename guide and update assets").mr_refs, vec!["!42", "group/sub/project!7", "#12"]);
        assert!(row("Initial commit").mr_refs.is_empty());
        let wips: Vec<_> = g.rows.iter().filter(|x| x.kind == NodeKind::Wip).collect();
        assert!(!wips.is_empty(), "the details fixture has a dirty worktree");
        assert!(wips.iter().all(|w| w.mr_refs.is_empty()));
    }

    #[tokio::test]
    async fn message_refs_come_from_the_summary_too() {
        let r = TestRepo::new();
        r.commit("Fix login (#7)\n\nSee !8 and #7");
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.rows[0].mr_refs, vec!["#7", "!8"]);
    }

    #[tokio::test]
    async fn message_refs_include_lines_after_the_summary_without_a_blank_line() {
        // No blank line: the ref lines are neither `summary` nor `body`, but the details panel
        // (`read_commit_message`) shows them, so the menu's refs must include them too.
        let r = TestRepo::new();
        r.commit("Fix login\nCloses #12");
        r.commit("Fix\nSee merge request group/project!1187");
        let g = build(&r, BuildOptions::default()).await;
        let row = |s: &str| g.rows.iter().find(|x| x.summary == s).unwrap_or_else(|| panic!("no row {s}"));
        assert_eq!(row("Fix login").mr_refs, vec!["#12"]);
        assert_eq!(row("Fix").mr_refs, vec!["group/project!1187"]);
    }

    #[tokio::test]
    async fn nonexistent_pinned_ref_override_reports_no_trunk() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let g = build(&r, BuildOptions { pinned_ref: Some("refs/heads/does-not-exist".into()), ..Default::default() }).await;
        assert_eq!(g.pinned_ref, None);
        assert!(!g.rows.is_empty());
    }

    /// Real layouts for the UI's branch-membership tests (`ui/src/graph/membership.test.ts`,
    /// feedback F7). Each case builds a repo and runs the actual `build_graph`, so `default_trunk`
    /// pinning and `layout.rs` lane assignment are the real ones, then reduces the payload to rows
    /// keyed by commit summary, plus the labels. Pinned in `testdata/graph-membership.json`;
    /// regenerate with `GITBOLT_UPDATE_TESTDATA=1 cargo test -p gitbolt-core membership_vectors`.
    #[tokio::test]
    async fn membership_vectors() {
        #[derive(serde::Serialize)]
        struct Row {
            id: String,
            kind: NodeKind,
            lane: u16,
            color: u8,
            parents: Vec<String>,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: &'static str,
            rows: Vec<Row>,
            labels: Vec<RefLabel>,
            pinned_ref: Option<String>,
            pinned_remote: Option<String>,
        }
        fn with_origin(r: &TestRepo) {
            r.commit("base");
            r.add_origin();
        }
        fn publish_main(r: &TestRepo) {
            r.push("main");
            r.git(&["remote", "set-head", "origin", "main"]);
        }
        type Build = fn(&TestRepo);
        let cases: [(&'static str, Build); 13] = [
            ("main behind origin/main, feature off origin/main", |r| {
                with_origin(r);
                r.commit("M");
                r.commit("O1");
                r.commit("O2");
                publish_main(r);
                r.git(&["reset", "-q", "--hard", "HEAD~2"]);
                r.git(&["switch", "-q", "-c", "feature", "origin/main"]);
                r.commit("F");
                r.switch("main");
            }),
            ("stale fast-forwarded branch left on the trunk", |r| {
                with_origin(r);
                r.git(&["branch", "old"]);
                r.commit("O");
                publish_main(r);
            }),
            ("hotfix from origin/main committed after main's unpushed M1", |r| {
                // H (newest) takes lane 1, so M1 opens lane 2: the lane order says nothing here.
                with_origin(r);
                r.commit("O");
                publish_main(r);
                r.commit("M1");
                r.git(&["switch", "-q", "-c", "hotfix", "origin/main"]);
                r.commit("H");
                r.switch("main");
            }),
            ("upstream/main one commit ahead (fork workflow)", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.git(&["remote", "add", "upstream", r.root().join("origin.git").to_str().unwrap()]);
                r.switch_new("tmp");
                r.commit("U");
                r.git(&["update-ref", "refs/remotes/upstream/main", "tmp"]);
                r.switch("main");
                r.git(&["branch", "-q", "-D", "tmp"]);
            }),
            ("local-only repo (no remote) pins main: hotfix off main's tip, main checked out", |r| {
                r.commit("base");
                r.commit("M");
                r.switch_new("hotfix");
                r.commit("H");
                r.switch("main");
            }),
            ("unpinned repo (no remote, no main): hotfix off work's tip, work checked out", |r| {
                r.commit("base");
                r.git(&["branch", "-q", "-m", "main", "work"]);
                r.commit("W");
                r.switch_new("hotfix");
                r.commit("H");
                r.switch("work");
            }),
            ("feature/main off pinned main's tip", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.switch_new("feature/main");
                r.commit("FM");
                r.push("feature/main");
                r.switch("main");
            }),
            ("feature tip on its own lane after main merged its pushed part", |r| {
                // feat@F3 is committed before main merges origin/feat (F2): M's second-parent
                // line takes lane 1 first, so F2 lands there and F3 opens lane 2.
                with_origin(r);
                r.switch_new("feat");
                r.commit("F1");
                r.commit("F2");
                r.push("feat");
                r.commit("F3");
                r.switch("main");
                r.merge("origin/feat", "M");
                publish_main(r);
            }),
            ("main ahead of pinned origin/main", |r| {
                with_origin(r);
                r.commit("O");
                publish_main(r);
                r.commit("M1");
            }),
            ("feature tip merged back, then continued", |r| {
                with_origin(r);
                r.switch_new("feat");
                r.commit("F1");
                r.commit("F2");
                r.push("feat");
                r.switch("main");
                r.commit("A");
                r.merge("feat", "M");
                publish_main(r);
                r.switch("feat");
                r.commit("F3");
                r.switch("main");
            }),
            ("hotfix off pinned main's tip", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.switch_new("hotfix");
                r.commit("H");
                r.switch("main");
            }),
            ("remote-only branch off pinned main's tip", |r| {
                with_origin(r);
                r.commit("M");
                publish_main(r);
                r.switch_new("topic");
                r.commit("T");
                r.push("topic");
                r.switch("main");
                r.git(&["branch", "-q", "-D", "topic"]);
            }),
            ("dirty feature checked out, older than pinned main", |r| {
                // The WIP is row 0 ("now") above the newer M, its dashed lane down to F.
                with_origin(r);
                r.switch_new("feature");
                r.commit("F");
                r.switch("main");
                r.commit("M");
                publish_main(r);
                r.switch("feature");
                r.write("file_0.txt", "dirty\n");
            }),
        ];
        let mut out = Vec::new();
        for (name, make) in cases {
            let r = TestRepo::new();
            make(&r);
            let g = build(&r, BuildOptions::default()).await;
            // The local main (in the fork workflow, upstream/main's counterpart though it
            // tracks origin), but where there's no trunk at all.
            let pin = if name.starts_with("unpinned") {
                None
            } else {
                Some("refs/heads/main")
            };
            assert_eq!(g.pinned_ref.as_deref(), pin, "{name}: trunk pinning");
            let summary: HashMap<&str, &str> = g.rows.iter().map(|row| (row.id.as_str(), row.summary.as_str())).collect();
            let rows = g
                .rows
                .iter()
                .map(|row| Row {
                    id: row.summary.clone(),
                    kind: row.kind,
                    lane: row.lane,
                    color: row.color,
                    parents: row.parents.iter().map(|p| summary.get(p.as_str()).expect("parent in window").to_string()).collect(),
                })
                .collect();
            // `checked_out` names a temp dir: left out, so the vectors stay byte-stable.
            let labels = g.labels.iter().cloned().map(|l| RefLabel { checked_out: None, ..l }).collect();
            out.push(Case { name, rows, labels, pinned_ref: g.pinned_ref.clone(), pinned_remote: g.pinned_remote.clone() });
        }
        let json = serde_json::to_string_pretty(&serde_json::json!({
            "_comment": "Generated by gitbolt-core snapshot::tests::membership_vectors (real build_graph layouts). Regenerate: GITBOLT_UPDATE_TESTDATA=1 cargo test -p gitbolt-core membership_vectors",
            "cases": out,
        }))
        .unwrap()
            + "\n";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/graph-membership.json");
        if std::env::var_os("GITBOLT_UPDATE_TESTDATA").is_some() {
            std::fs::write(&path, &json).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), json, "testdata/graph-membership.json is stale: regenerate it (see this test's doc comment)");
    }

    /// Spec #2 §13.2, Deviation 1: every worktree's state, keyed as its WIP row spells it.
    #[tokio::test]
    async fn the_graph_carries_each_worktrees_in_progress_state() {
        let r = TestRepo::new();
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "feature"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        assert!(r.try_git(&["merge", "--no-edit", "feature"]).is_err());
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.in_progress.len(), 1, "{:?}", g.in_progress);
        let (path, state) = g.in_progress.iter().next().unwrap();
        assert_eq!(Some(path.as_str()), g.open_worktree.as_deref());
        assert!(matches!(state, crate::in_progress::InProgress::Merge { conflicted: 1, .. }));
        // Resolved and staged as HEAD's content: the worktree is clean, but still mid-merge, so
        // its WIP row (and the commit panel's Commit and Abort) stays (ux round 1).
        r.git(&["checkout", "--ours", "c.txt"]);
        r.git(&["add", "c.txt"]);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
        let g = build(&r, BuildOptions::default()).await;
        assert!(g.rows.iter().any(|row| row.wip.is_some()), "the clean, mid-merge worktree keeps its WIP row");
        r.git(&["merge", "--abort"]);
        let g = build(&r, BuildOptions::default()).await;
        assert!(!g.rows.iter().any(|row| row.wip.is_some()));
    }
}
