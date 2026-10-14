//! Builds the graph payload for one repository.

use crate::error::GbError;
use crate::git::GitCli;
use crate::graph::{to_gix, to_oid};
use crate::in_progress::InProgress;
use crate::payload::{FileListPayload, GraphPayload};
use crate::refs::{read_refs, RepoRefs};
use crate::status::{parse_porcelain_v2, status_raw, summarize, WipCounts};
use crate::walk::{walk, WalkOptions, WalkResult};
use crate::worktree::{list_worktrees, Worktree};
use gitvolt_graph::{GraphInput, HeadIn, Oid, RefIn, RefsIn, StashIn, WorktreeIn};
use gix::ObjectId;
use std::collections::{BTreeMap, HashMap, HashSet};
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
    /// What the forge's cached data says about the remotes' forks (never a request): the default
    /// pin follows the root, and tells a fork (`default_pair`, `fork_of`).
    pub forks: ForkFacts,
}

pub use gitvolt_graph::ForkFacts;

impl Default for BuildOptions {
    fn default() -> Self {
        Self { limit: DEFAULT_COMMIT_LIMIT, pinned_ref: None, no_pin: false, wip_cache: None, rescan: false, active: None, walk_cache: None, forks: ForkFacts::default() }
    }
}

/// The last walk a handle made, reused while the tips, the window and the stash set are the same
/// (spec #2 §11.2, Deviation 1): a switch of the active worktree re-lays out without walking.
pub struct WalkCache {
    key: (Vec<Oid>, usize, Vec<Oid>),
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
    tokio::task::spawn_blocking(move || assemble(&repo.to_thread_local(), &worktrees, wip, &workdir, &opts))
        .await
        .map_err(|e| GbError::other(format!("graph task failed: {e}")))?
}

/// The commits the graph walks from (`gitvolt_graph::graph_tips`).
pub(crate) fn graph_tips(refs: RepoRefs, worktrees: &[Worktree]) -> Vec<Oid> {
    gitvolt_graph::graph_tips(&refs_input(refs), &worktrees_input(worktrees))
}

fn refs_input(r: RepoRefs) -> RefsIn {
    RefsIn {
        head: HeadIn { branch: r.head.branch, target: r.head.target.map(to_oid), detached: r.head.detached, unborn: r.head.unborn },
        refs: r
            .refs
            .into_iter()
            .map(|x| RefIn { full_name: x.full_name, short_name: x.short_name, kind: x.kind, target: to_oid(x.target), upstream: x.upstream, upstream_mismatch: x.upstream_mismatch, annotation: x.annotation })
            .collect(),
        remote_heads: r.remote_heads,
        remote_hosts: r.remote_hosts,
        remote_host_names: r.remote_host_names,
        stashes: r.stashes.into_iter().map(|s| StashIn { index: s.index, id: to_oid(s.id), message: s.message, time: s.time }).collect(),
        push_remotes: r.push_remotes,
        remote_ids: r.remote_ids,
        compare_heads: r.compare_heads.into_iter().map(to_oid).collect(),
    }
}

fn worktrees_input(worktrees: &[Worktree]) -> Vec<WorktreeIn> {
    worktrees
        .iter()
        .map(|w| WorktreeIn { path: w.path.display().to_string(), canonical: canonical(&w.path).display().to_string(), head: w.head.map(to_oid), branch: w.branch.clone(), is_main: w.is_main, bare: w.bare, prunable: w.prunable, locked: w.locked })
        .collect()
}

/// Each usable worktree's operation in progress, keyed by its path as its WIP row spells it.
fn in_progress_of(worktrees: &[Worktree]) -> BTreeMap<String, InProgress> {
    worktrees.iter().filter(|w| !w.bare && !w.prunable).filter_map(|w| Some((w.path.display().to_string(), crate::in_progress::read(&w.path).ok()??))).collect()
}

/// (index into `worktrees`, counts) for every dirty, usable worktree. A worktree whose cached counts
/// are `reusable` keeps them unless `rescan`; every status that does run refreshes the cache
/// (stamped before the read, so an older read never replaces a newer one).
async fn collect_wip(cli: &GitCli, worktrees: &[Worktree], cache: Option<&WipCache>, rescan: bool) -> Vec<(usize, WipCounts)> {
    let jobs = worktrees.iter().enumerate().filter(|(_, w)| !w.bare && !w.prunable && w.path.is_dir()).map(|(i, w)| async move {
        // Still being checked out: no counts yet, and none cached (the watcher reads it once its index appears).
        if crate::status::checkout_pending(&w.path) {
            return None;
        }
        // Mid-command (a terminal's add or commit): keep what was last read, rather than blink the row out.
        if crate::status::index_locked(&w.path) {
            return cache.and_then(|c| c.get(&w.path)).map(|e| (i, e.counts));
        }
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

fn assemble(repo: &gix::Repository, worktrees: &[Worktree], wip: Vec<(usize, WipCounts)>, workdir: &Path, opts: &BuildOptions) -> Result<(GraphPayload, Vec<(ObjectId, String)>), GbError> {
    let refs = refs_input(read_refs(repo)?);
    let worktrees_in = worktrees_input(worktrees);
    // The tips come from the handle's own HEAD, whichever worktree is active: the active one's
    // HEAD is among the worktrees' anyway, and the same tips keep the walk cache valid across
    // a switch.
    let tips = gitvolt_graph::graph_tips(&refs, &worktrees_in);
    let stash_ids: HashSet<Oid> = refs.stashes.iter().map(|s| s.id).collect();
    let walked = cached_walk(repo, tips, &stash_ids, opts)?;
    let input = GraphInput {
        refs,
        worktrees: worktrees_in,
        wip,
        in_progress: in_progress_of(worktrees),
        workdir: canonical(workdir).display().to_string(),
        active: opts.active.as_deref().map(|a| canonical(a).display().to_string()),
        pinned_ref: opts.pinned_ref.clone(),
        no_pin: opts.no_pin,
        forks: opts.forks.clone(),
    };
    // Unit tests and the harness (and so the e2e suite) verify every graph they build (the
    // `testing` feature); a violation surfaces as an ordinary error, not a panic.
    let payload = gitvolt_graph::assemble(&input, &walked).map_err(|e| GbError::other(format!("graph continuity violated: {e}")))?;
    let texts = walked.commits.iter().map(|c| (to_gix(c.id), format!("{}\n{}", c.summary, c.body).to_lowercase())).collect();
    Ok((payload, texts))
}

/// The walk from `tips`, served from the handle's walk cache when the tips, the window and the
/// stash set are the ones it last walked (commits are immutable, so nothing else can differ).
fn cached_walk(repo: &gix::Repository, tips: Vec<Oid>, stash_ids: &HashSet<Oid>, opts: &BuildOptions) -> Result<Arc<WalkResult>, GbError> {
    let mut first_parent: Vec<Oid> = stash_ids.iter().copied().collect();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::NodeKind;
    use crate::log::CommandLog;
    use crate::payload::{ForkDetection, ForkPayload, RefLabel, RowPayload};
    use crate::remotes::HostKind;
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

    /// `git worktree add` writes the checkout before its index: a status then reads every file as
    /// deleted and untracked, so the worktree has no counts (and none are cached) until the index
    /// exists.
    #[tokio::test]
    async fn a_worktree_being_checked_out_has_no_counts_until_its_index_exists() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let wt = r.root().join("wt-hotfix");
        let git_dir = r.path().join(".git/worktrees/wt-hotfix");
        let index = git_dir.join("index");
        let aside = git_dir.join("index.aside");
        let wt_wip = |g: &GraphPayload| g.rows.iter().find_map(|row| row.wip.as_ref().filter(|w| w.worktree_name.is_some()).cloned());
        let cache = Arc::new(WipCache::default());
        let opts = || BuildOptions { wip_cache: Some(cache.clone()), rescan: true, ..Default::default() };

        std::fs::rename(&index, &aside).unwrap();
        assert!(crate::status::checkout_pending(&wt));
        assert!(wt_wip(&build(&r, opts()).await).is_none(), "no index yet: no bogus counts");
        assert!(cache.get(&wt).is_none(), "and nothing cached");

        std::fs::rename(&aside, &index).unwrap();
        std::fs::write(git_dir.join("index.lock"), "").unwrap();
        assert!(wt_wip(&build(&r, opts()).await).is_none(), "index.lock held, nothing cached yet");
        std::fs::remove_file(git_dir.join("index.lock")).unwrap();
        assert_eq!(wt_wip(&build(&r, opts()).await).expect("index exists").modified, 1);
        std::fs::write(git_dir.join("index.lock"), "").unwrap();
        std::fs::write(wt.join("extra.txt"), "x\n").unwrap();
        let w = wt_wip(&build(&r, opts()).await).expect("index.lock held, counts cached");
        assert_eq!((w.modified, w.added), (1, 0), "the cached counts stay");
        std::fs::remove_file(git_dir.join("index.lock")).unwrap();

        assert!(!crate::status::checkout_pending(&wt));
        let w = wt_wip(&build(&r, opts()).await).expect("index exists");
        assert_eq!((w.modified, w.added, w.deleted), (1, 1, 0));
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
        assert_eq!(g.pinned_refs, ["refs/heads/main", "refs/remotes/origin/main"]);

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
        assert!(g.pinned_refs.is_empty());
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
        assert!(!build(&r, BuildOptions::default()).await.pinned_refs.is_empty());
        let g = build(&r, BuildOptions { no_pin: true, ..Default::default() }).await;
        assert!(g.pinned_refs.is_empty());
    }

    /// A repo with `main` published to origin and origin/HEAD set to it.
    fn published_main(r: &TestRepo) {
        r.commit("base");
        r.add_origin();
        r.push("main");
        r.git(&["remote", "set-head", "origin", "main"]);
    }

    /// The pinned refs a build reports.
    async fn pins(r: &TestRepo, opts: BuildOptions) -> Vec<String> {
        build(r, opts).await.pinned_refs
    }

    fn pin(name: &str) -> BuildOptions {
        BuildOptions { pinned_ref: Some(name.into()), ..Default::default() }
    }

    /// The forge's cached data: each remote → the remote its project forks.
    fn parents(pairs: &[(&str, &str)]) -> BuildOptions {
        BuildOptions { forks: ForkFacts { parents: pairs.iter().map(|(r, p)| (r.to_string(), p.to_string())).collect(), ..Default::default() }, ..Default::default() }
    }

    /// The default: local main tracking origin/main pins with it.
    #[tokio::test]
    async fn the_default_trunk_is_the_local_branch_tracking_origin_head_with_its_upstream() {
        let r = TestRepo::new();
        published_main(&r);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main", "refs/remotes/origin/main"]);
    }

    #[tokio::test]
    async fn the_default_trunk_is_a_differently_named_local_branch_tracking_origin_head() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["branch", "-q", "-m", "main", "trunk"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/trunk", "refs/remotes/origin/main"]);
        // Two local branches tracking it: the one named like it wins.
        r.git(&["branch", "-q", "--track", "main", "origin/main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main", "refs/remotes/origin/main"]);
    }

    /// A local branch with no upstream pins alone.
    #[tokio::test]
    async fn a_local_branch_without_upstream_pins_alone() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["branch", "-q", "--unset-upstream", "main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main"], "the default: the same-named local main");
        r.switch_new("scratch");
        assert_eq!(pins(&r, pin("refs/heads/scratch")).await, ["refs/heads/scratch"], "an explicit pin");
    }

    /// No local counterpart: the default is the remote trunk itself, alone.
    #[tokio::test]
    async fn the_default_trunk_is_the_remote_ref_without_a_local_counterpart() {
        let r = TestRepo::new();
        published_main(&r);
        r.switch_new("feature");
        r.git(&["branch", "-q", "-D", "main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/remotes/origin/main"]);
    }

    /// No local branch tracks T: the local branch named like it is the pin, whatever it tracks,
    /// and pairs with its own upstream; one that does track T wins over it.
    #[tokio::test]
    async fn a_same_named_local_branch_is_the_pin_whatever_its_upstream() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["update-ref", "refs/remotes/origin/other", "HEAD"]);
        r.git(&["branch", "-q", "--set-upstream-to", "origin/other", "main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main", "refs/remotes/origin/other"]);
        r.git(&["branch", "-q", "--track", "trunk", "origin/main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/trunk", "refs/remotes/origin/main"], "tracking T comes first");
    }

    /// An explicit pin pairs like the default: a local branch with its upstream, a remote
    /// branch with the local branch tracking it.
    #[tokio::test]
    async fn an_explicit_pin_pairs_with_its_counterpart() {
        let r = TestRepo::new();
        published_main(&r);
        r.switch_new("hotfix");
        r.commit("H");
        r.push("hotfix");
        let pair = ["refs/heads/hotfix", "refs/remotes/origin/hotfix"];
        assert_eq!(pins(&r, pin("refs/heads/hotfix")).await, pair, "a local pin: its upstream");
        assert_eq!(pins(&r, pin("refs/remotes/origin/hotfix")).await, pair, "a remote pin: the local branch tracking it, still first");
        assert!(pins(&r, BuildOptions { pinned_ref: Some("refs/heads/hotfix".into()), no_pin: true, ..Default::default() }).await.is_empty());
    }

    /// A remote branch several local branches track: the one named like it, else the first by
    /// name. With none, the remote branch pins alone.
    #[tokio::test]
    async fn a_remote_pin_pairs_with_the_best_tracking_local_branch() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["branch", "-q", "--track", "b-copy", "origin/main"]);
        r.git(&["branch", "-q", "--track", "a-copy", "origin/main"]);
        let remote = "refs/remotes/origin/main";
        assert_eq!(pins(&r, pin(remote)).await, ["refs/heads/main", remote], "named like it");
        r.switch("a-copy");
        r.git(&["branch", "-q", "-D", "main"]);
        assert_eq!(pins(&r, pin(remote)).await, ["refs/heads/a-copy", remote], "else the first by name");
        r.git(&["branch", "-q", "--unset-upstream", "a-copy"]);
        r.git(&["branch", "-q", "--unset-upstream", "b-copy"]);
        assert_eq!(pins(&r, pin(remote)).await, [remote], "no local branch tracks it: alone");
    }

    #[tokio::test]
    async fn a_local_only_repo_pins_its_local_main() {
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("hotfix");
        r.commit("H");
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main"]);
        r.git(&["branch", "-q", "-m", "main", "work"]);
        assert!(pins(&r, BuildOptions::default()).await.is_empty(), "no main, master, dev or develop: no trunk");
    }

    /// `origin` and `upstream`, both with a main; local `main` tracks `track`'s.
    fn fork_layout(r: &TestRepo, track: &str) {
        published_main(r);
        r.git(&["remote", "add", "upstream", r.root().join("upstream.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/upstream/main", "HEAD"]);
        r.git(&["branch", "-q", "--set-upstream-to", &format!("{track}/main"), "main"]);
    }

    #[tokio::test]
    async fn without_forge_data_upstream_is_the_root_remote() {
        let r = TestRepo::new();
        fork_layout(&r, "upstream");
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/remotes/upstream/main", "refs/heads/main"]);
        // main tracks the fork (origin): still the pin, as upstream/main's local counterpart, and
        // it pairs with upstream/main, not with the fork's main it tracks.
        r.git(&["branch", "-q", "--set-upstream-to", "origin/main", "main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/remotes/upstream/main", "refs/heads/main"]);
    }

    /// The fork a build reports.
    async fn fork(r: &TestRepo, opts: BuildOptions) -> Option<ForkPayload> {
        build(r, opts).await.fork
    }

    fn fork_payload_of(fork: &str, original: &str, detected_by: ForkDetection, trunk: Option<&str>, fork_trunk: &str, trunk_branches: &[&str]) -> Option<ForkPayload> {
        Some(ForkPayload {
            fork: fork.into(),
            original: original.into(),
            host: None,
            host_kind: HostKind::Generic,
            detected_by,
            trunk: trunk.map(Into::into),
            fork_trunk: Some(fork_trunk.into()),
            trunk_branches: trunk_branches.iter().map(|b| b.to_string()).collect(),
        })
    }

    /// A fork by convention (`upstream` next to `origin`): the default pin is upstream's trunk
    /// with the local main, whatever main tracks; origin/main is never pinned by default. The
    /// payload names the trunk branches: the pinned local and those tracking origin/main.
    #[tokio::test]
    async fn in_a_fork_the_original_projects_trunk_is_pinned_not_the_forks() {
        let r = TestRepo::new();
        published_main(&r);
        assert_eq!(fork(&r, BuildOptions::default()).await, None, "one remote: not a fork");
        r.git(&["remote", "add", "upstream", r.root().join("upstream.git").to_str().unwrap()]);
        // upstream not fetched yet: no trunk of its own to pin, so origin's as before.
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main", "refs/remotes/origin/main"]);
        let unfetched = fork_payload_of("origin", "upstream", ForkDetection::UpstreamRemote, None, "refs/remotes/origin/main", &["refs/heads/main"]);
        assert_eq!(fork(&r, BuildOptions::default()).await, unfetched);

        r.git(&["update-ref", "refs/remotes/upstream/main", "HEAD"]);
        let upstream_pair = ["refs/remotes/upstream/main", "refs/heads/main"];
        assert_eq!(pins(&r, BuildOptions::default()).await, upstream_pair, "main tracking origin/main pairs with upstream/main");
        r.git(&["branch", "-q", "--track", "feature", "origin/main"]);
        let expected = fork_payload_of("origin", "upstream", ForkDetection::UpstreamRemote, Some("refs/remotes/upstream/main"), "refs/remotes/origin/main", &["refs/heads/feature", "refs/heads/main"]);
        assert_eq!(fork(&r, BuildOptions::default()).await, expected);
        // Explicit pins are unchanged: origin/main pairs with main, which tracks it.
        assert_eq!(pins(&r, pin("refs/remotes/origin/main")).await, ["refs/heads/main", "refs/remotes/origin/main"]);
        assert_eq!(fork(&r, pin("refs/remotes/origin/main")).await, expected, "reported whatever the pin");

        // main tracking upstream/main: the same pair; it's still a trunk branch, as upstream/main's counterpart.
        r.git(&["branch", "-q", "--set-upstream-to", "upstream/main", "main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, upstream_pair);
        assert_eq!(fork(&r, BuildOptions::default()).await, expected);

        // No local main: upstream/main alone (feature tracks the fork's main, not upstream's).
        r.switch("feature");
        r.git(&["branch", "-q", "-D", "main"]);
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/remotes/upstream/main"]);
        let no_main = fork_payload_of("origin", "upstream", ForkDetection::UpstreamRemote, Some("refs/remotes/upstream/main"), "refs/remotes/origin/main", &["refs/heads/feature"]);
        assert_eq!(fork(&r, BuildOptions::default()).await, no_main);
    }

    /// A fork the forge tells, whatever the remotes' names: origin's project forks `project`'s.
    #[tokio::test]
    async fn a_fork_by_the_forges_data_pins_the_parent_remotes_trunk() {
        let r = TestRepo::new();
        published_main(&r);
        let origin = r.root().join("origin.git");
        r.git(&["remote", "add", "project", origin.to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/project/main", "HEAD"]);
        // No forge data, no `upstream`: not a fork, origin first by convention.
        assert_eq!(pins(&r, BuildOptions::default()).await, ["refs/heads/main", "refs/remotes/origin/main"]);
        assert_eq!(fork(&r, BuildOptions::default()).await, None);
        let opts = || parents(&[("origin", "project")]);
        assert_eq!(pins(&r, opts()).await, ["refs/remotes/project/main", "refs/heads/main"]);
        assert_eq!(fork(&r, opts()).await, fork_payload_of("origin", "project", ForkDetection::Forge, Some("refs/remotes/project/main"), "refs/remotes/origin/main", &["refs/heads/main"]));
    }

    /// A maintainer's clone: origin is the project, `alice` a contributor's fork of it. The forge
    /// says alice forks origin, but alice isn't yours: not a fork. A remote other than origin is
    /// yours when the local trunk branch pushes to it or tracks it.
    #[tokio::test]
    async fn a_forking_remote_makes_a_fork_only_when_its_yours() {
        let r = TestRepo::new();
        published_main(&r);
        r.git(&["remote", "add", "alice", r.root().join("alice.git").to_str().unwrap()]);
        r.git(&["update-ref", "refs/remotes/alice/main", "HEAD"]);
        let opts = || parents(&[("alice", "origin")]);
        assert_eq!(fork(&r, opts()).await, None, "a contributor's fork as a remote");
        assert_eq!(pins(&r, opts()).await, ["refs/heads/main", "refs/remotes/origin/main"]);
        let alice = || async { fork(&r, opts()).await.map(|f| (f.fork, f.original, f.detected_by)) };
        let yours = Some(("alice".to_string(), "origin".to_string(), ForkDetection::Forge));
        r.git(&["config", "branch.main.pushRemote", "alice"]);
        assert_eq!(alice().await, yours, "main pushes to alice");
        r.git(&["config", "--unset", "branch.main.pushRemote"]);
        r.git(&["config", "remote.pushDefault", "alice"]);
        assert_eq!(alice().await, yours, "everything pushes to alice");
        r.git(&["config", "--unset", "remote.pushDefault"]);
        assert_eq!(alice().await, None);
        r.git(&["branch", "-q", "--set-upstream-to", "alice/main", "main"]);
        assert_eq!(alice().await, yours, "main, origin/main's counterpart by name, tracks alice/main");
    }

    /// In a fork, upstream/main leads the pair: diverged from the local main, its commits run
    /// down lane 0 and main's own take lane 1; origin/main (main's upstream) isn't pinned.
    #[tokio::test]
    async fn in_a_fork_the_original_trunk_leads_lane_0_when_main_has_diverged() {
        let r = TestRepo::new();
        fork_layout(&r, "origin");
        r.switch_new("tmp");
        r.commit("U1");
        r.commit("U2");
        r.git(&["update-ref", "refs/remotes/upstream/main", "tmp"]);
        r.switch("main");
        r.git(&["branch", "-q", "-D", "tmp"]);
        r.commit("L");
        let g = build(&r, BuildOptions::default()).await;
        assert_eq!(g.pinned_refs, ["refs/remotes/upstream/main", "refs/heads/main"]);
        let lanes: Vec<(&str, u16)> = g.rows.iter().map(|x| (x.summary.as_str(), x.lane)).collect();
        assert_eq!(lanes, [("L", 1), ("U2", 0), ("U1", 0), ("base", 0)]);
    }

    /// The `upstream` convention holds only where the forge can't say otherwise: not for an
    /// upstream that is origin's own project (another URL for it), not once the forge knows
    /// origin's project isn't a fork, and not at all on a host an account covers.
    #[tokio::test]
    async fn the_upstream_convention_yields_to_the_forge_and_to_the_same_project() {
        let r = TestRepo::new();
        fork_layout(&r, "origin");
        let by_convention = || async { fork(&r, BuildOptions::default()).await.map(|f| f.detected_by) };
        assert_eq!(by_convention().await, Some(ForkDetection::UpstreamRemote));
        // The same project, spelled two ways.
        r.git(&["remote", "set-url", "origin", "https://git.example.com/group/project.git"]);
        r.git(&["remote", "set-url", "upstream", "git@git.example.com:Group/project"]);
        assert_eq!(by_convention().await, None, "upstream is origin's own project");
        r.git(&["remote", "set-url", "upstream", "https://gitlab.example.com/other/project.git"]);
        assert_eq!(by_convention().await, Some(ForkDetection::UpstreamRemote));
        // The original's host and forge (the notice's "merge request").
        let f = fork(&r, BuildOptions::default()).await.unwrap();
        assert_eq!((f.host.as_deref(), f.host_kind), (Some("gitlab.example.com"), HostKind::GitLab));
        // A local path, the same one: also the same project.
        let path = r.root().join("upstream.git");
        r.git(&["remote", "set-url", "origin", path.to_str().unwrap()]);
        r.git(&["remote", "set-url", "upstream", path.to_str().unwrap()]);
        assert_eq!(by_convention().await, None);
        r.git(&["remote", "set-url", "origin", r.root().join("origin.git").to_str().unwrap()]);
        assert_eq!(by_convention().await, Some(ForkDetection::UpstreamRemote));
        let facts = |f: ForkFacts| BuildOptions { forks: f, ..Default::default() };
        let one = |r: &str| std::iter::once(r.to_string()).collect::<HashSet<_>>();
        let known_root = facts(ForkFacts { roots: one("origin"), ..Default::default() });
        assert_eq!(fork(&r, known_root).await, None, "the forge knows origin's project isn't a fork");
        let covered = facts(ForkFacts { covered: one("origin"), ..Default::default() });
        assert_eq!(fork(&r, covered).await, None, "an account covers origin's host: the forge's data only");
        // A covered upstream alone doesn't stop the convention: origin's host is the one asked.
        let upstream_covered = facts(ForkFacts { covered: one("upstream"), ..Default::default() });
        assert_eq!(fork(&r, upstream_covered).await.map(|f| f.detected_by), Some(ForkDetection::UpstreamRemote));
    }

    #[tokio::test]
    async fn cached_fork_data_makes_the_parent_remote_the_root() {
        let r = TestRepo::new();
        fork_layout(&r, "origin");
        // Reversed naming: upstream's project is a fork of origin's, and yours (main pushes
        // there), so origin/main is T and main, tracking it, its counterpart.
        r.git(&["branch", "-q", "--track", "up", "upstream/main"]);
        r.git(&["config", "branch.main.pushRemote", "upstream"]);
        assert_eq!(pins(&r, parents(&[("upstream", "origin")])).await, ["refs/remotes/origin/main", "refs/heads/main"]);
        // A parent that isn't one of the remotes changes nothing: upstream is the root, and `up`
        // tracks upstream/main.
        assert_eq!(pins(&r, parents(&[("upstream", "someone-else")])).await, ["refs/remotes/upstream/main", "refs/heads/up"]);
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
        assert_eq!(g.pinned_refs, ["refs/heads/main"], "no remote: the local main");
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
        assert!(cut.truncated && cut.pinned_refs.is_empty(), "the pinned tip is below the cut");
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
        // origin/main is ahead of the checked-out main: the WIP is row 0 anyway. The pinned pair
        // is one chain from origin/main's newer O down through main's M, all in lane 0, so the
        // WIP takes lane 1 and runs dashed down beside it into M.
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
        let lanes: Vec<u16> = g.rows.iter().map(|x| x.lane).collect();
        assert_eq!(lanes, [1, 0, 0, 0], "origin/main's O and main's M on the pinned lane");
        assert_dashed_line(&g, 0, 2);
    }

    /// The pinned pair's layouts (local main and origin/main), each with a newer `side` branch
    /// off `base` that must stay right of both: behind and ahead share lane 0 (the newer tip's
    /// first-parent line runs into the older one), diverged takes lanes 0 (local) and 1 (the
    /// remote's own commits), equal tips are one lane with both names.
    #[tokio::test]
    async fn the_pinned_pair_lays_out_at_the_left() {
        async fn lanes_of(make: fn(&TestRepo)) -> (Vec<String>, Vec<(String, u16)>) {
            let r = TestRepo::new();
            let base = r.commit("base");
            r.add_origin();
            r.push("main");
            r.git(&["remote", "set-head", "origin", "main"]);
            make(&r);
            // A branch off base, newer than everything else: it must not take a pinned lane.
            r.git(&["switch", "-q", "-c", "side", &base]);
            r.commit("S");
            r.switch("main");
            let g = build(&r, BuildOptions::default()).await;
            (g.pinned_refs, g.rows.iter().map(|x| (x.summary.clone(), x.lane)).collect())
        }
        let pair = ["refs/heads/main", "refs/remotes/origin/main"];
        let lanes = |v: &[(&str, u16)]| v.iter().map(|&(s, l)| (s.to_string(), l)).collect::<Vec<_>>();

        // Behind: origin/main's O2, O1 above main's M, one line in lane 0.
        let (pins, got) = lanes_of(|r| {
            r.commit("M");
            r.commit("O1");
            r.commit("O2");
            r.push("main");
            r.git(&["reset", "-q", "--hard", "HEAD~2"]);
        })
        .await;
        assert_eq!(pins, pair);
        assert_eq!(got, lanes(&[("S", 1), ("O2", 0), ("O1", 0), ("M", 0), ("base", 0)]), "behind");

        // Ahead: main's unpushed M1, M2 above origin/main's O.
        let (pins, got) = lanes_of(|r| {
            r.commit("O");
            r.push("main");
            r.commit("M1");
            r.commit("M2");
        })
        .await;
        assert_eq!(pins, pair);
        assert_eq!(got, lanes(&[("S", 1), ("M2", 0), ("M1", 0), ("O", 0), ("base", 0)]), "ahead");

        // Diverged: main's M in lane 0, origin/main's O2, O1 in lane 1, base shared in lane 0;
        // the newer S opens lane 2.
        let (pins, got) = lanes_of(|r| {
            r.commit("O1");
            r.commit("O2");
            r.push("main");
            r.git(&["reset", "-q", "--hard", "HEAD~2"]);
            r.commit("M");
        })
        .await;
        assert_eq!(pins, pair);
        assert_eq!(got, lanes(&[("S", 2), ("M", 0), ("O2", 1), ("O1", 1), ("base", 0)]), "diverged");

        // Equal: one lane, one chip carrying both names.
        let (pins, got) = lanes_of(|r| {
            r.commit("M");
            r.push("main");
        })
        .await;
        assert_eq!(pins, pair);
        assert_eq!(got, lanes(&[("S", 1), ("M", 0), ("base", 0)]), "equal");
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
        assert!(g.pinned_refs.is_empty());
        assert!(!g.rows.is_empty());
    }

    /// Real layouts for the UI's branch-membership tests (`ui/src/graph/membership.test.ts`,
    /// feedback F7). Each case builds a repo and runs the actual `build_graph`, so `default_pair`
    /// pinning and `layout.rs` lane assignment are the real ones, then reduces the payload to rows
    /// keyed by commit summary, plus the labels. Pinned in `testdata/graph-membership.json`;
    /// regenerate with `GITVOLT_UPDATE_TESTDATA=1 cargo test -p gitvolt-core membership_vectors`.
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
            pinned_refs: Vec<String>,
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
        let cases: [(&'static str, Build); 14] = [
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
            ("main diverged from origin/main, feature off origin/main", |r| {
                // main's M (lane 0) and origin/main's O1, O2 (lane 1) both stay left of feature.
                with_origin(r);
                r.commit("O1");
                r.commit("O2");
                publish_main(r);
                r.git(&["reset", "-q", "--hard", "HEAD~2"]);
                r.commit("M");
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
                r.git(&["remote", "add", "upstream", r.root().join("upstream.git").to_str().unwrap()]);
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
            // The local main with the origin/main it tracks; in the fork workflow, upstream/main
            // first, with main though it tracks origin; alone without a remote; nothing where
            // there's no trunk at all.
            let pins: &[&str] = if name.starts_with("unpinned") {
                &[]
            } else if name.starts_with("local-only") {
                &["refs/heads/main"]
            } else if name.contains("fork workflow") {
                &["refs/remotes/upstream/main", "refs/heads/main"]
            } else {
                &["refs/heads/main", "refs/remotes/origin/main"]
            };
            assert_eq!(g.pinned_refs, pins, "{name}: trunk pinning");
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
            out.push(Case { name, rows, labels, pinned_refs: g.pinned_refs.clone() });
        }
        let json = serde_json::to_string_pretty(&serde_json::json!({
            "_comment": "Generated by gitvolt-core snapshot::tests::membership_vectors (real build_graph layouts). Regenerate: GITVOLT_UPDATE_TESTDATA=1 cargo test -p gitvolt-core membership_vectors",
            "cases": out,
        }))
        .unwrap()
            + "\n";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/graph-membership.json");
        if std::env::var_os("GITVOLT_UPDATE_TESTDATA").is_some() {
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
