//! Active-tab file watcher (spec §4.4). inotify via `notify`; events are classified into change
//! kinds, debounced (150 ms, at most 1 s while events keep coming), and worktree-level changes are
//! confirmed with a status digest, so ignored-file churn and GitBolt's own reads never reach the
//! UI.
//!
//! Deviation (spec §4.4): instead of one recursive watch per worktree, this watches every tracked
//! directory non-recursively (from the worktree's index), plus every directory holding an
//! untracked, non-ignored file (from the last status), `.git` and `.git/worktrees` (flat),
//! `.git/refs` (recursive) and each linked worktree's gitdir. Ignored trees like `node_modules`
//! or `vendor` would otherwise eat the inotify watch limit. Past `MAX_FLAT_DIRS` directories, or
//! once inotify's own limit is hit, the watch is *degraded*: it keeps reporting what it does see,
//! but its status cache is no longer trusted, so every graph build re-reads status.
//!
//! Never triggering itself: GitBolt's reads only open files (`IN_OPEN`/`IN_CLOSE_NOWRITE`, which
//! are dropped here), `git status` runs with `GIT_OPTIONAL_LOCKS=0` and `git diff` with
//! `diff.autoRefreshIndex=false`, so neither rewrites the index; `worktree`/`index` are only
//! reported when a status digest actually changed. Those opens can still overflow the kernel
//! queue on a big repo: an overflow arriving while (or just after) the watcher ran its own status
//! is its own doing and is dropped, and any other overflow reports only what a status digest or
//! a refs/HEAD/stash/config snapshot shows changed.

use crate::api::{Api, RepoHandle};
use crate::error::{GbError, GbErrorKind};
use crate::events::{AppEvent, ChangeKind, EventBus};
use crate::git::GitCli;
use crate::payload::BlobSource;
use crate::diff::wip_lists;
use crate::snapshot::{WipCache, WipEntry, WipLists};
use crate::status::{parse_porcelain_v2, status_raw, EntryKind};
use crate::worktree::{list_worktrees, Worktree};
use notify::event::{AccessKind, AccessMode, EventKind, ModifyKind, RemoveKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub const DEBOUNCE: Duration = Duration::from_millis(150);
pub const MAX_WAIT: Duration = Duration::from_secs(1);
pub const MAX_FLAT_DIRS: usize = 20_000;

/// One worktree being watched; both paths canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchedWorktree {
    pub root: PathBuf,
    /// Its git directory: the common dir for the main worktree, `<common>/worktrees/<name>` for a
    /// linked one.
    pub git_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Classified {
    pub kind: ChangeKind,
    /// Index into the worktree list: whose HEAD, index or files changed.
    pub worktree: Option<usize>,
}

/// What a changed path means, or `None` for paths that don't matter (lock files, objects,
/// `FETCH_HEAD`, reflogs other than the stash's, anything under a worktree's `.git`).
pub fn classify(path: &Path, common_dir: &Path, worktrees: &[WatchedWorktree]) -> Option<Classified> {
    if path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(".lock")) {
        return None;
    }
    let by_git_dir = |g: &Path| worktrees.iter().position(|w| w.git_dir == g);
    if let Ok(rel) = path.strip_prefix(common_dir) {
        let rel = rel.to_string_lossy();
        let c = |kind, worktree| Some(Classified { kind, worktree });
        return match rel.as_ref() {
            "HEAD" => c(ChangeKind::Head, by_git_dir(common_dir)),
            "index" => c(ChangeKind::Index, by_git_dir(common_dir)),
            "packed-refs" => c(ChangeKind::Refs, None),
            "config" => c(ChangeKind::Config, None),
            "refs/stash" | "logs/refs/stash" => c(ChangeKind::Stash, None),
            r if r.starts_with("refs/") => c(ChangeKind::Refs, None),
            r if r.starts_with("worktrees/") => {
                let mut parts = r.splitn(3, '/').skip(1);
                let (name, file) = (parts.next()?, parts.next()?);
                let owner = by_git_dir(&common_dir.join("worktrees").join(name));
                match file {
                    "HEAD" => c(ChangeKind::Head, owner),
                    "index" => c(ChangeKind::Index, owner),
                    _ => None,
                }
            }
            _ => None,
        };
    }
    let (i, w) = worktrees.iter().enumerate().filter(|(_, w)| path.starts_with(&w.root)).max_by_key(|(_, w)| w.root.as_os_str().len())?;
    let rel = path.strip_prefix(&w.root).ok()?;
    if rel.components().next().is_some_and(|c| c.as_os_str() == ".git") {
        return None;
    }
    Some(Classified { kind: ChangeKind::Worktree, worktree: Some(i) })
}


#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WatchPlan {
    pub recursive: BTreeSet<PathBuf>,
    pub flat: BTreeSet<PathBuf>,
    /// Some directories were left out (past the cap, or a worktree whose index can't be read).
    pub truncated: bool,
}

impl WatchPlan {
    fn len(&self) -> usize {
        self.recursive.len() + self.flat.len()
    }
}

/// Adds `rel`'s parent directories (under `root`, which is always in `dirs`) to `dirs`.
fn add_parents(dirs: &mut BTreeSet<PathBuf>, root: &Path, mut rel: PathBuf) {
    while rel.pop() && !rel.as_os_str().is_empty() {
        if !dirs.insert(root.join(&rel)) {
            break;
        }
    }
}

/// The worktree root and every directory holding a tracked file (from that worktree's index).
fn tracked_dirs(root: &Path) -> Option<BTreeSet<PathBuf>> {
    let repo = gix::open(root).ok()?;
    let index = repo.index_or_empty().ok()?;
    let mut dirs = BTreeSet::from([root.to_path_buf()]);
    for entry in index.entries() {
        add_parents(&mut dirs, root, gix::path::from_bstr(entry.path(&index)).into_owned());
    }
    Some(dirs)
}

/// Every directory under `root` holding an untracked (not ignored) file in a status output.
fn untracked_dirs(root: &Path, raw: &[u8]) -> BTreeSet<PathBuf> {
    let mut dirs = BTreeSet::new();
    for e in parse_porcelain_v2(raw).into_iter().filter(|e| e.kind == EntryKind::Untracked) {
        add_parents(&mut dirs, root, PathBuf::from(e.path));
    }
    dirs
}

pub fn plan(common_dir: &Path, worktrees: &[WatchedWorktree]) -> WatchPlan {
    plan_capped(common_dir, worktrees, MAX_FLAT_DIRS)
}

/// `plan` with at most `cap` flat watches; the rest are left out (`truncated`), never replaced
/// by a recursive watch of a whole worktree (which would walk its ignored trees too).
fn plan_capped(common_dir: &Path, worktrees: &[WatchedWorktree], cap: usize) -> WatchPlan {
    let mut p = WatchPlan::default();
    p.flat.insert(common_dir.to_path_buf());
    let linked = common_dir.join("worktrees");
    if linked.is_dir() {
        p.flat.insert(linked);
    }
    p.recursive.insert(common_dir.join("refs"));
    // The stash reflog: dropping an older stash (`stash@{1}`) rewrites only `logs/refs/stash`.
    // Flat, so `logs/refs/heads` churn isn't watched (classify ignores every other reflog).
    let reflogs = common_dir.join("logs").join("refs");
    if reflogs.is_dir() {
        p.flat.insert(reflogs);
    }
    for w in worktrees {
        if w.git_dir != common_dir {
            p.flat.insert(w.git_dir.clone());
        }
    }
    for w in worktrees {
        let Some(dirs) = tracked_dirs(&w.root) else {
            p.truncated = true;
            continue;
        };
        for d in dirs {
            if p.flat.len() >= cap {
                p.truncated = true;
                break;
            }
            p.flat.insert(d);
        }
    }
    p
}

/// A snapshot of the non-worktree state an overflow may have hidden changes to: refs (loose and
/// packed, but not the stash), the stash (ref and reflog), the config, and every HEAD.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct GitState {
    refs: u64,
    stash: u64,
    config: u64,
    heads: u64,
}

fn hash_file(h: &mut impl Hasher, path: &Path) {
    path.hash(h);
    std::fs::read(path).ok().hash(h);
}

fn hash_tree(h: &mut impl Hasher, dir: &Path, skip: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p == skip {
            continue;
        }
        if p.is_dir() {
            hash_tree(h, &p, skip);
        } else {
            hash_file(h, &p);
        }
    }
}

fn git_state(common_dir: &Path, worktrees: &[WatchedWorktree]) -> GitState {
    let digest = |f: &dyn Fn(&mut std::collections::hash_map::DefaultHasher)| {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        f(&mut h);
        h.finish()
    };
    GitState {
        refs: digest(&|h| {
            hash_tree(h, &common_dir.join("refs"), &common_dir.join("refs/stash"));
            hash_file(h, &common_dir.join("packed-refs"));
        }),
        stash: digest(&|h| {
            hash_file(h, &common_dir.join("refs/stash"));
            hash_file(h, &common_dir.join("logs/refs/stash"));
        }),
        config: digest(&|h| hash_file(h, &common_dir.join("config"))),
        heads: digest(&|h| worktrees.iter().for_each(|w| hash_file(h, &w.git_dir.join("HEAD")))),
    }
}

fn changed_kinds(old: &GitState, new: &GitState) -> BTreeSet<ChangeKind> {
    [(old.refs != new.refs, ChangeKind::Refs), (old.stash != new.stash, ChangeKind::Stash), (old.config != new.config, ChangeKind::Config), (old.heads != new.heads, ChangeKind::Head)]
        .into_iter()
        .filter_map(|(changed, k)| changed.then_some(k))
        .collect()
}

/// Test knobs (the defaults are production's).
#[derive(Debug, Clone)]
struct Tuning {
    max_flat: usize,
    /// Act as if inotify's watch limit (ENOSPC) were this many watches.
    max_watches: Option<usize>,
    /// Queue an overflow after every status read, as a huge repo's own reads would.
    overflow_after_status: bool,
    /// While set, the watcher's WIP-list computations fail.
    fail_lists: Option<Arc<AtomicBool>>,
}

impl Default for Tuning {
    fn default() -> Self {
        Self { max_flat: MAX_FLAT_DIRS, max_watches: None, overflow_after_status: false, fail_lists: None }
    }
}

/// Reads a watched worktree's status and WIP file lists and keeps them (K44): a `fileList` for a
/// covered worktree whose lists aren't kept yet (they're computed lazily: `ready` never waits
/// for numstat). Stamped before the status read, so it never replaces newer lists.
pub(crate) async fn read_and_keep_lists(handle: &gix::ThreadSafeRepository, cli: &GitCli, wip: &WipCache, root: &Path) -> Result<WipLists, GbError> {
    let stamp = wip.stamp();
    let raw = status_raw(cli, root).await?;
    let entry = WipEntry::from_raw(&raw);
    wip.put(root, stamp, entry);
    let (staged, unstaged) = wip_lists(handle, cli, root, parse_porcelain_v2(&raw), &HashMap::new()).await?;
    let lists = WipLists::new(stamp, entry.digest, staged, unstaged);
    wip.put_lists(root, lists.clone());
    Ok(lists)
}

/// The line counts of `lists`' untracked files (unstaged additions with no old side, read from
/// the worktree) not in `written`: `wip_lists` reuses them.
fn untracked_counts(lists: &WipLists, written: Option<&BTreeSet<String>>) -> HashMap<String, Option<u32>> {
    lists
        .unstaged
        .files
        .iter()
        .filter(|f| f.status == "A" && f.old == BlobSource::Absent && matches!(f.new, BlobSource::Worktree { .. }))
        .filter(|f| written.is_none_or(|w| !w.contains(&f.path)))
        .map(|f| (f.path.clone(), f.additions))
        .collect()
}

/// The inotify watches actually in place.
struct Watches {
    w: RecommendedWatcher,
    applied: WatchPlan,
    max: Option<usize>,
    /// inotify's watch limit was hit: no more watches are added.
    full: bool,
}

impl Watches {
    fn add(&mut self, p: &Path, mode: RecursiveMode) -> bool {
        if self.full {
            return false;
        }
        let res = match self.max {
            Some(max) if self.applied.len() >= max => Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch)),
            _ => self.w.watch(p, mode),
        };
        match res {
            Ok(()) => true,
            // A directory removed since it was listed (a deleted untracked folder, a checkout).
            Err(notify::Error { kind: notify::ErrorKind::PathNotFound, .. }) => {
                tracing::debug!("not watching {} (gone)", p.display());
                false
            }
            Err(notify::Error { kind: notify::ErrorKind::MaxFilesWatch, .. }) => {
                tracing::warn!(
                    "the inotify watch limit is reached ({} watches in this repo): changes may be missed, so status is re-read on every refresh (raise fs.inotify.max_user_watches)",
                    self.applied.len()
                );
                self.full = true;
                false
            }
            Err(e) => {
                tracing::warn!("cannot watch {}: {e}", p.display());
                false
            }
        }
    }

    /// Unwatches what `next` drops and watches what it adds (until the limit, if hit).
    fn sync(&mut self, next: &WatchPlan) {
        let gone: Vec<PathBuf> = self.applied.recursive.difference(&next.recursive).chain(self.applied.flat.difference(&next.flat)).cloned().collect();
        for p in gone {
            let _ = self.w.unwatch(&p);
            self.applied.recursive.remove(&p);
            self.applied.flat.remove(&p);
        }
        for p in next.recursive.difference(&self.applied.recursive.clone()) {
            if self.add(p, RecursiveMode::Recursive) {
                self.applied.recursive.insert(p.clone());
            }
        }
        for p in next.flat.difference(&self.applied.flat.clone()) {
            if self.add(p, RecursiveMode::NonRecursive) {
                self.applied.flat.insert(p.clone());
            }
        }
    }

    /// A folder was deleted or renamed away: its watches (and its subfolders') died with it, so
    /// they're dropped here, and the next `sync` watches the folder again if it's back.
    fn forget(&mut self, gone: &Path) {
        let dead: Vec<PathBuf> = self.applied.flat.iter().chain(&self.applied.recursive).filter(|p| p.starts_with(gone)).cloned().collect();
        for p in dead {
            let _ = self.w.unwatch(&p);
            self.applied.flat.remove(&p);
            self.applied.recursive.remove(&p);
        }
    }
}

/// inotify also reports opens and reads (notify watches `IN_OPEN`); only writes matter.
fn relevant(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

#[derive(Clone)]
pub struct WatchSpec {
    pub repo: u32,
    /// The repository, for the WIP file lists the watcher keeps (K44).
    pub handle: gix::ThreadSafeRepository,
    /// Where `git worktree list` runs when the worktrees change.
    pub workdir: PathBuf,
    pub common_dir: PathBuf,
    pub worktrees: Vec<WatchedWorktree>,
}

#[derive(Default)]
struct Batch {
    kinds: BTreeSet<ChangeKind>,
    /// Roots of the worktrees whose status must be re-read.
    status: BTreeSet<PathBuf>,
    /// Per worktree root: the paths (relative, as status prints them) written in it. A write to
    /// a path status already lists can change its WIP lists' line counts without changing status.
    touched: HashMap<PathBuf, BTreeSet<String>>,
    /// The kernel queue overflowed: events were lost.
    overflow: bool,
    /// A linked worktree was added or removed (`<common>/worktrees/<name>`).
    topology: bool,
    /// Folders deleted or renamed away.
    gone: Vec<PathBuf>,
}

impl Batch {
    fn is_empty(&self) -> bool {
        self.kinds.is_empty() && !self.overflow && !self.topology && self.gone.is_empty()
    }

    fn add(&mut self, ev: &notify::Event, spec: &WatchSpec) {
        if ev.need_rescan() {
            self.overflow = true;
            return;
        }
        let linked = spec.common_dir.join("worktrees");
        for (i, p) in ev.paths.iter().enumerate() {
            let gone = match ev.kind {
                EventKind::Remove(RemoveKind::Folder) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => true,
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => i == 0,
                _ => false,
            };
            if gone {
                self.gone.push(p.clone());
            }
            if *p == linked || p.parent() == Some(linked.as_path()) {
                self.topology = true;
                continue;
            }
            if let Some(c) = classify(p, &spec.common_dir, &spec.worktrees) {
                self.kinds.insert(c.kind);
                if matches!(c.kind, ChangeKind::Worktree | ChangeKind::Index | ChangeKind::Head)
                    && let Some(i) = c.worktree
                {
                    let root = &spec.worktrees[i].root;
                    self.status.insert(root.clone());
                    if c.kind == ChangeKind::Worktree
                        && let Ok(rel) = p.strip_prefix(root)
                    {
                        self.touched.entry(root.clone()).or_default().insert(rel.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
}

/// Collects `first` and every event after it until `DEBOUNCE` passes quietly, or `MAX_WAIT`
/// after `first`. `None` once stopped (or the watcher is gone).
async fn gather(first: notify::Event, rx: &mut mpsc::UnboundedReceiver<notify::Event>, stop: &CancellationToken) -> Option<Vec<notify::Event>> {
    let mut events = vec![first];
    let started = Instant::now();
    loop {
        let deadline = (Instant::now() + DEBOUNCE).min(started + MAX_WAIT);
        tokio::select! {
            _ = stop.cancelled() => return None,
            _ = tokio::time::sleep_until(deadline) => return Some(events),
            ev = rx.recv() => events.push(ev?),
        }
    }
}

/// What the watch loop and its `RepoWatcher` share.
struct Shared {
    serial: u64,
    wakeups: AtomicU64,
    degraded: AtomicBool,
    /// How many inotify watches are in place.
    watches: AtomicUsize,
}

/// The live watch of one repository. Dropping it stops the watch (no event is emitted after the
/// drop returns, except one already being sent) and withdraws its status-cache coverage.
pub struct RepoWatcher {
    shared: Arc<Shared>,
    stop: CancellationToken,
    /// Becomes `true` once the first pass (a status of every worktree) is done.
    ready: watch::Receiver<bool>,
    wip: Arc<WipCache>,
    #[cfg_attr(not(test), allow(dead_code))]
    inject: mpsc::UnboundedSender<notify::Event>,
}

/// The loop's ends of a `RepoWatcher` made before its watch is set up.
struct Handles {
    shared: Arc<Shared>,
    stop: CancellationToken,
    ready: watch::Sender<bool>,
    tx: mpsc::UnboundedSender<notify::Event>,
    rx: mpsc::UnboundedReceiver<notify::Event>,
}

impl RepoWatcher {
    fn pending(wip: Arc<WipCache>) -> (Self, Handles) {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let shared = Arc::new(Shared { serial: SERIAL.fetch_add(1, Ordering::Relaxed), wakeups: AtomicU64::new(0), degraded: AtomicBool::new(false), watches: AtomicUsize::new(0) });
        let stop = CancellationToken::new();
        let (ready_tx, ready) = watch::channel(false);
        let (tx, rx) = mpsc::unbounded_channel();
        let w = Self { shared: shared.clone(), stop: stop.clone(), ready, wip, inject: tx.clone() };
        (w, Handles { shared, stop, ready: ready_tx, tx, rx })
    }

    /// Blocking (index reads and inotify setup): call from `spawn_blocking` inside a tokio
    /// runtime (the watch loop is `tokio::spawn`ed).
    pub fn start(spec: WatchSpec, cli: GitCli, wip: Arc<WipCache>, bus: EventBus) -> Result<Self, GbError> {
        Self::start_tuned(spec, cli, wip, bus, Tuning::default())
    }

    fn start_tuned(spec: WatchSpec, cli: GitCli, wip: Arc<WipCache>, bus: EventBus, tuning: Tuning) -> Result<Self, GbError> {
        let (w, handles) = Self::pending(wip.clone());
        launch(spec, cli, wip, bus, handles, tuning)?;
        Ok(w)
    }

    /// Waits for the first pass: after it, the WIP cache is current and every later change is
    /// reported (or the watch has ended).
    pub async fn ready(&self) {
        let _ = self.ready.clone().wait_for(|r| *r).await;
    }

    /// Some directories aren't watched (past `MAX_FLAT_DIRS`, or inotify's limit was hit).
    pub fn degraded(&self) -> bool {
        self.shared.degraded.load(Ordering::SeqCst)
    }

    /// Whether its status cache may stand in for status reads: set up, and not degraded.
    pub fn trusted(&self) -> bool {
        *self.ready.borrow() && !self.degraded()
    }

    /// How many debounced batches of relevant events this watch has handled (tests use it to
    /// prove GitBolt's own reads don't even wake it).
    pub fn wakeups(&self) -> u64 {
        self.shared.wakeups.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    fn watches_len(&self) -> usize {
        self.shared.watches.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    fn inject(&self, ev: notify::Event) {
        self.inject.send(ev).unwrap();
    }
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        self.stop.cancel();
        self.wip.uncover(self.shared.serial);
    }
}

/// The usable worktrees of a `git worktree list`, with canonical paths (blocking: opens each).
fn watched_worktrees(list: &[Worktree]) -> Vec<WatchedWorktree> {
    list.iter()
        .filter(|w| !w.bare && !w.prunable && w.path.is_dir())
        .filter_map(|w| {
            let git_dir = gix::open(&w.path).ok()?.git_dir().canonicalize().ok()?;
            Some(WatchedWorktree { root: w.path.canonicalize().ok()?, git_dir })
        })
        .collect()
}

/// Sets up inotify for `spec` and spawns the watch loop (blocking; see `RepoWatcher::start`).
fn launch(spec: WatchSpec, cli: GitCli, wip: Arc<WipCache>, bus: EventBus, h: Handles, tuning: Tuning) -> Result<(), GbError> {
    let tx = h.tx.clone();
    let w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
        Ok(ev) if relevant(&ev.kind) => {
            let _ = tx.send(ev);
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("file watcher: {e}"),
    })
    .map_err(|e| GbError::new(GbErrorKind::Io, format!("file watcher: {e}")))?;
    let base = plan_capped(&spec.common_dir, &spec.worktrees, tuning.max_flat);
    let mut watches = Watches { w, applied: WatchPlan::default(), max: tuning.max_watches, full: false };
    watches.sync(&base);
    h.shared.watches.store(watches.applied.len(), Ordering::SeqCst);
    let git = git_state(&spec.common_dir, &spec.worktrees);
    let state = Loop {
        truncated: base.truncated,
        base,
        watches,
        untracked: HashMap::new(),
        digests: HashMap::new(),
        git,
        spec,
        cli,
        wip,
        bus,
        stop: h.stop,
        shared: h.shared,
        tuning,
        inject: h.tx,
        quiet_until: Instant::now(),
        trusted: false,
    };
    tokio::spawn(state.run(h.rx, h.ready));
    Ok(())
}

struct Loop {
    spec: WatchSpec,
    watches: Watches,
    /// The tracked-directory plan, recomputed after HEAD, index or worktree-list changes.
    base: WatchPlan,
    /// The last `rewatch` left directories out.
    truncated: bool,
    /// Per worktree root: the directories holding untracked files, from its last status.
    untracked: HashMap<PathBuf, BTreeSet<PathBuf>>,
    /// Per worktree root: the digest of this watcher's own last status read. Changes are judged
    /// against these, never against the shared cache (which graph builds write too).
    digests: HashMap<PathBuf, u64>,
    git: GitState,
    cli: GitCli,
    wip: Arc<WipCache>,
    bus: EventBus,
    stop: CancellationToken,
    shared: Arc<Shared>,
    tuning: Tuning,
    inject: mpsc::UnboundedSender<notify::Event>,
    /// An overflow before this is the watcher's own doing (its status reads open every file).
    quiet_until: Instant,
    /// The last `update_trust` covered the worktrees.
    trusted: bool,
}

impl Loop {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<notify::Event>, ready: watch::Sender<bool>) {
        if self.stop.is_cancelled() {
            return;
        }
        // The first pass: watch the untracked directories, and report a worktree whose status
        // changed since the graph last read it (between that build and this watch starting).
        // Which of its files or index changed is unknown, so it reports both kinds.
        let all: BTreeSet<PathBuf> = self.roots().collect();
        let changed = self.refresh_status(&all, true, &HashMap::new(), true).await;
        self.emit(BTreeSet::from([ChangeKind::Worktree, ChangeKind::Index]), changed);
        self.update_trust();
        self.quiet_until = Instant::now() + DEBOUNCE;
        let _ = ready.send(true);
        loop {
            let first = tokio::select! {
                _ = self.stop.cancelled() => return,
                ev = rx.recv() => match ev { Some(e) => e, None => return },
            };
            if self.own_overflow(&first) {
                continue;
            }
            let Some(events) = gather(first, &mut rx, &self.stop).await else { return };
            let mut batch = Batch::default();
            for ev in events.iter().filter(|ev| !self.own_overflow(ev)) {
                batch.add(ev, &self.spec);
            }
            if batch.is_empty() {
                continue;
            }
            self.shared.wakeups.fetch_add(1, Ordering::SeqCst);
            self.handle(batch).await;
            self.update_trust();
            self.quiet_until = Instant::now() + DEBOUNCE;
        }
    }

    fn roots(&self) -> impl Iterator<Item = PathBuf> + '_ {
        self.spec.worktrees.iter().map(|w| w.root.clone())
    }

    /// Watched worktrees whose directory no longer exists.
    fn vanished(&self) -> Vec<PathBuf> {
        self.roots().filter(|r| !r.is_dir()).collect()
    }

    fn own_overflow(&self, ev: &notify::Event) -> bool {
        let own = ev.need_rescan() && Instant::now() < self.quiet_until;
        if own {
            tracing::debug!("dropping an event-queue overflow caused by the watcher's own status read");
        }
        own
    }

    async fn handle(&mut self, batch: Batch) {
        for g in &batch.gone {
            self.watches.forget(g);
        }
        let mut kinds = batch.kinds;
        let mut status = batch.status;
        let mut topology = BTreeSet::new();
        // A worktree whose directory was deleted without `git worktree remove` leaves
        // `.git/worktrees/<name>` in place, so the topology watch never fires for it; its own
        // events are all that tell. Reading its status would spawn git in a missing cwd.
        // They are dropped here, whether or not the worktrees can be re-listed (the directory
        // the repo was opened from may be the one that's gone), so the warning is given once.
        let vanished = self.vanished();
        if !vanished.is_empty() {
            self.forget_worktrees(&vanished).await;
            topology.extend(vanished.iter().map(|p| p.display().to_string()));
        }
        if batch.topology || batch.overflow || !vanished.is_empty() {
            let (added, removed) = self.respec().await;
            status.extend(added.iter().cloned());
            topology.extend(added.union(&removed).map(|p| p.display().to_string()));
        } else if kinds.contains(&ChangeKind::Head) || kinds.contains(&ChangeKind::Index) {
            // A checkout may add or remove tracked directories.
            self.replan().await;
        }
        if batch.overflow {
            status.extend(self.roots());
        }
        // Gone worktrees (and any the re-listing couldn't drop) are never read.
        status.retain(|r| r.is_dir());
        let mut changed = self.refresh_status(&status, false, &batch.touched, batch.overflow).await;
        let git_kinds = [ChangeKind::Refs, ChangeKind::Head, ChangeKind::Stash, ChangeKind::Config];
        if batch.overflow || git_kinds.iter().any(|k| kinds.contains(k)) {
            let (c, w) = (self.spec.common_dir.clone(), self.spec.worktrees.clone());
            if let Ok(next) = tokio::task::spawn_blocking(move || git_state(&c, &w)).await {
                if batch.overflow {
                    // Lost events: report only what the snapshot shows changed.
                    kinds.retain(|k| !git_kinds.contains(k));
                    kinds.extend(changed_kinds(&self.git, &next));
                }
                self.git = next;
            }
        }
        if !topology.is_empty() {
            kinds.extend([ChangeKind::Head, ChangeKind::Worktree]);
            changed.extend(topology);
        }
        self.emit(kinds, changed);
    }

    /// Re-lists the worktrees (one was added or removed) and re-plans the watches. Returns the
    /// roots added and removed.
    /// Stops watching worktrees whose directories are gone, with one warning each.
    async fn forget_worktrees(&mut self, gone: &[PathBuf]) {
        for v in gone {
            // Removing a worktree is routine (`git worktree remove`), not a problem.
            tracing::info!("the worktree directory {} was removed: no longer watching it", v.display());
            self.digests.remove(v);
            self.untracked.remove(v);
        }
        self.spec.worktrees.retain(|w| !gone.contains(&w.root));
        self.replan().await;
    }

    async fn respec(&mut self) -> (BTreeSet<PathBuf>, BTreeSet<PathBuf>) {
        // `git worktree list` runs from the directory the repo was opened from, which may be
        // the worktree that's gone: the common dir answers the same.
        let cwd = if self.spec.workdir.is_dir() { self.spec.workdir.clone() } else { self.spec.common_dir.clone() };
        let list = match list_worktrees(&self.cli, &cwd).await {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("couldn't re-list the worktrees: {e}");
                return Default::default();
            }
        };
        let Ok(next) = tokio::task::spawn_blocking(move || watched_worktrees(&list)).await else { return Default::default() };
        let old: BTreeSet<PathBuf> = self.roots().collect();
        let new: BTreeSet<PathBuf> = next.iter().map(|w| w.root.clone()).collect();
        let (added, removed): (BTreeSet<PathBuf>, BTreeSet<PathBuf>) = (new.difference(&old).cloned().collect(), old.difference(&new).cloned().collect());
        for r in &removed {
            self.digests.remove(r);
            self.untracked.remove(r);
        }
        self.spec.worktrees = next;
        self.replan().await;
        (added, removed)
    }

    async fn replan(&mut self) {
        let (c, w, cap) = (self.spec.common_dir.clone(), self.spec.worktrees.clone(), self.tuning.max_flat);
        if let Ok(next) = tokio::task::spawn_blocking(move || plan_capped(&c, &w, cap)).await {
            self.base = next;
        }
    }

    /// Runs status for the worktrees `roots`, refreshing the cache and the untracked-directory
    /// watches, and their WIP file lists (K44) where they may have changed: none kept yet, the
    /// status changed, a path status lists was written (`touched`), or `relist` (an overflow).
    /// The `first` pass computes no lists (`ready` doesn't wait for numstat; the first read
    /// does, `read_and_keep_lists`). Lists that can't be recomputed are dropped, never kept
    /// stale. Returns the canonical roots whose status or lists changed: against this watcher's
    /// own last read, or on the `first` pass, against the cache (what the graph last showed; a
    /// first read of an uncached worktree isn't a change).
    async fn refresh_status(&mut self, roots: &BTreeSet<PathBuf>, first: bool, touched: &HashMap<PathBuf, BTreeSet<String>>, relist: bool) -> BTreeSet<String> {
        let (cli, wip, handle, fail) = (&self.cli, &self.wip, &self.spec.handle, &self.tuning.fail_lists);
        let reads = roots.iter().filter(|root| root.is_dir()).map(|root| async move {
            let stamp = wip.stamp();
            let res = status_raw(cli, root).await;
            // `None`: not recomputed. `Some(Err)`: recomputing failed.
            let mut lists = None;
            if let Ok(raw) = &res
                && !first
            {
                let digest = WipEntry::from_raw(raw).digest;
                let entries = parse_porcelain_v2(raw);
                let prev = wip.lists(root);
                let touched = touched.get(root);
                let written = touched.is_some_and(|t| entries.iter().any(|e| t.contains(&e.path) || e.orig_path.as_ref().is_some_and(|o| t.contains(o))));
                if relist || written || prev.as_ref().is_none_or(|p| p.digest != digest) {
                    // After an overflow, which files were written is unknown: count them all.
                    let reuse = match &prev {
                        Some(p) if !relist => untracked_counts(p, touched),
                        _ => HashMap::new(),
                    };
                    let res = if fail.as_ref().is_some_and(|f| f.load(Ordering::SeqCst)) {
                        Err(GbError::other("test: WIP lists fail"))
                    } else {
                        wip_lists(handle, cli, root, entries, &reuse).await
                    };
                    lists = Some(res.map(|(staged, unstaged)| (prev.map(|p| p.version), WipLists::new(stamp, digest, staged, unstaged))));
                }
            }
            (root, stamp, res, lists)
        });
        let mut changed = BTreeSet::new();
        for (root, stamp, res, lists) in futures_util::future::join_all(reads).await {
            match res {
                Ok(raw) => {
                    let entry = WipEntry::from_raw(&raw);
                    let before = self.wip.put(root, stamp, entry);
                    let differs = if first { before.is_some_and(|b| b.digest != entry.digest) } else { self.digests.get(root) != Some(&entry.digest) };
                    let relisted = match lists {
                        Some(Ok((prev, next))) => {
                            let moved = prev.is_some_and(|v| v != next.version);
                            self.wip.put_lists(root, next);
                            moved
                        }
                        Some(Err(e)) => {
                            tracing::warn!("WIP file lists failed for {}: {e}", root.display());
                            // Kept, they could still match the (unchanged) status: drop them.
                            let held = self.wip.lists(root).is_some();
                            self.wip.drop_lists(root);
                            held
                        }
                        None => false,
                    };
                    if differs || (relisted && !first) {
                        changed.insert(root.display().to_string());
                    }
                    self.digests.insert(root.clone(), entry.digest);
                    self.untracked.insert(root.clone(), untracked_dirs(root, &raw));
                }
                Err(e) => tracing::warn!("status failed for {}: {e}", root.display()),
            }
            if self.tuning.overflow_after_status {
                let _ = self.inject.send(notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan));
            }
        }
        self.rewatch();
        changed
    }

    /// Brings the watches in line with `base` plus the untracked directories (those not already
    /// under a recursive watch), up to the flat-watch cap.
    fn rewatch(&mut self) {
        let mut next = self.base.clone();
        let current: HashSet<PathBuf> = self.roots().collect();
        'dirs: for (root, dirs) in &self.untracked {
            if !current.contains(root) {
                continue;
            }
            for d in dirs {
                if next.flat.contains(d) || next.recursive.iter().any(|r| d.starts_with(r)) {
                    continue;
                }
                if next.flat.len() >= self.tuning.max_flat {
                    next.truncated = true;
                    break 'dirs;
                }
                next.flat.insert(d.clone());
            }
        }
        self.truncated = next.truncated;
        self.watches.sync(&next);
        self.shared.watches.store(self.watches.applied.len(), Ordering::SeqCst);
    }

    /// Covers the current worktrees in the status cache, or withdraws coverage while degraded
    /// (or stopped). Becoming degraded reports every worktree changed, so the UI drops the WIP
    /// lists it held (K44): changes may now go unseen.
    fn update_trust(&mut self) {
        let degraded = self.watches.full || self.truncated;
        self.shared.degraded.store(degraded, Ordering::SeqCst);
        let trusted = !degraded && !self.stop.is_cancelled();
        if trusted {
            self.wip.cover(self.shared.serial, self.roots().collect());
        } else {
            self.wip.uncover(self.shared.serial);
            if self.trusted {
                self.emit(BTreeSet::from([ChangeKind::Worktree, ChangeKind::Index]), self.roots().map(|r| r.display().to_string()).collect());
            }
        }
        self.trusted = trusted;
    }

    /// `repoChanged`, minus `worktree`/`index` unless some worktree's status changed. Nothing is
    /// sent once the watch has been stopped (an unwatch during a status read).
    fn emit(&self, mut kinds: BTreeSet<ChangeKind>, changed: BTreeSet<String>) {
        if changed.is_empty() {
            kinds.remove(&ChangeKind::Worktree);
            kinds.remove(&ChangeKind::Index);
        }
        if kinds.is_empty() || self.stop.is_cancelled() {
            return;
        }
        // The lists' versions, where they're current and covered (a degraded watch has none).
        let versions = changed.iter().filter_map(|w| Some((w.clone(), self.wip.fresh_lists(Path::new(w))?.version))).collect();
        self.bus.emit(AppEvent::RepoChanged { repo: self.spec.repo, kinds: kinds.into_iter().collect(), worktrees: changed.into_iter().collect(), versions });
    }
}

impl Api {
    /// What to watch for `h`: its common dir and usable worktrees, canonical.
    async fn watch_spec(&self, id: u32, h: &RepoHandle) -> Result<WatchSpec, GbError> {
        let list = list_worktrees(&self.cli, &h.workdir).await?;
        let (repo, workdir) = (h.repo.clone(), h.workdir.clone());
        tokio::task::spawn_blocking(move || {
            let common_dir = repo.to_thread_local().common_dir().canonicalize()?;
            Ok(WatchSpec { repo: id, handle: repo, workdir, common_dir, worktrees: watched_worktrees(&list) })
        })
        .await
        .map_err(|e| GbError::other(format!("watcher setup failed: {e}")))?
    }

    /// Starts watching `id` (the active tab's repo, spec §4.4); if it's already watched, waits
    /// for that watch to be ready. The watcher is registered before its setup, so an
    /// `unwatchRepo` arriving meanwhile (requests run concurrently) stops it rather than being
    /// overtaken by it. Returns once the first pass is done.
    pub(crate) async fn watch_repo(&self, id: u32) -> Result<(), GbError> {
        let h = self.handle(id)?;
        let (pending, handles) = RepoWatcher::pending(h.wip.clone());
        let (serial, stop, mut ready) = (pending.shared.serial, pending.stop.clone(), pending.ready.clone());
        let existing = {
            let mut watchers = self.watchers.lock().expect("watchers poisoned");
            match watchers.get(&id) {
                Some(w) => Some(w.ready.clone()),
                None => {
                    watchers.insert(id, pending);
                    None
                }
            }
        };
        if let Some(mut ready) = existing {
            let _ = ready.wait_for(|r| *r).await;
            return Ok(());
        }
        let setup = async {
            let spec = self.watch_spec(id, &h).await?;
            let (cli, wip, bus) = (self.cli.clone(), h.wip.clone(), self.bus.clone());
            tokio::task::spawn_blocking(move || if stop.is_cancelled() { Ok(()) } else { launch(spec, cli, wip, bus, handles, Tuning::default()) })
                .await
                .map_err(|e| GbError::other(format!("watcher setup failed: {e}")))?
        };
        if let Err(e) = setup.await {
            let mut watchers = self.watchers.lock().expect("watchers poisoned");
            if watchers.get(&id).is_some_and(|w| w.shared.serial == serial) {
                watchers.remove(&id);
            }
            return Err(e);
        }
        // Ends early (the sender is dropped) if it was unwatched meanwhile.
        let _ = ready.wait_for(|r| *r).await;
        Ok(())
    }

    pub(crate) fn unwatch_repo(&self, id: u32) {
        let w = self.watchers.lock().expect("watchers poisoned").remove(&id);
        drop(w);
    }

    /// Whether `id`'s status cache is kept fresh by a ready, non-degraded watcher. Only then may
    /// a graph build reuse it; otherwise it re-reads status.
    pub(crate) fn status_is_watched(&self, id: u32) -> bool {
        self.watchers.lock().expect("watchers poisoned").get(&id).is_some_and(RepoWatcher::trusted)
    }

    /// Ids of repos with a live watcher (normally just the active tab's), sorted.
    pub fn watched_repos(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self.watchers.lock().expect("watchers poisoned").keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    pub fn unwatch_all(&self) {
        let all = std::mem::take(&mut *self.watchers.lock().expect("watchers poisoned"));
        drop(all);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Api, Request};
    use crate::events::AppEvent;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use tokio::sync::broadcast;

    fn wt(root: &str, git_dir: &str) -> WatchedWorktree {
        WatchedWorktree { root: root.into(), git_dir: git_dir.into() }
    }

    #[test]
    fn classifies_git_dir_and_worktree_paths() {
        let c = Path::new("/r/.git");
        let wts = [wt("/r", "/r/.git"), wt("/w/hotfix", "/r/.git/worktrees/hotfix"), wt("/r/nested-wt", "/r/.git/worktrees/nested")];
        let k = |p: &str| classify(Path::new(p), c, &wts).map(|x| (x.kind, x.worktree));
        assert_eq!(k("/r/.git/HEAD"), Some((ChangeKind::Head, Some(0))));
        assert_eq!(k("/r/.git/index"), Some((ChangeKind::Index, Some(0))));
        assert_eq!(k("/r/.git/refs/heads/main"), Some((ChangeKind::Refs, None)));
        assert_eq!(k("/r/.git/packed-refs"), Some((ChangeKind::Refs, None)));
        assert_eq!(k("/r/.git/refs/stash"), Some((ChangeKind::Stash, None)));
        assert_eq!(k("/r/.git/logs/refs/stash"), Some((ChangeKind::Stash, None)));
        assert_eq!(k("/r/.git/config"), Some((ChangeKind::Config, None)));
        assert_eq!(k("/r/.git/worktrees/hotfix/HEAD"), Some((ChangeKind::Head, Some(1))));
        assert_eq!(k("/r/.git/worktrees/hotfix/index"), Some((ChangeKind::Index, Some(1))));
        assert_eq!(k("/r/.git/index.lock"), None);
        assert_eq!(k("/r/.git/refs/heads/main.lock"), None);
        assert_eq!(k("/r/.git/objects/ab/cdef"), None);
        assert_eq!(k("/r/.git/FETCH_HEAD"), None);
        assert_eq!(k("/r/.git/logs/HEAD"), None);
        assert_eq!(k("/r/src/a.php"), Some((ChangeKind::Worktree, Some(0))));
        assert_eq!(k("/w/hotfix/src/a.php"), Some((ChangeKind::Worktree, Some(1))));
        assert_eq!(k("/r/nested-wt/x"), Some((ChangeKind::Worktree, Some(2))), "longest root wins");
        assert_eq!(k("/w/hotfix/.git"), None);
        assert_eq!(k("/elsewhere/x"), None);
    }

    #[test]
    fn plans_flat_watches_on_tracked_dirs_only() {
        let r = TestRepo::new();
        r.write("src/deep/a.txt", "a\n");
        r.write("top.txt", "t\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "c"]);
        std::fs::create_dir_all(r.path().join("node_modules/pkg")).unwrap();
        let root = r.path().canonicalize().unwrap();
        let common = root.join(".git");
        let p = plan(&common, &[WatchedWorktree { root: root.clone(), git_dir: common.clone() }]);
        assert!(p.flat.contains(&root) && p.flat.contains(&root.join("src")) && p.flat.contains(&root.join("src/deep")));
        assert!(p.flat.contains(&common));
        assert!(p.recursive.contains(&common.join("refs")));
        assert!(!p.flat.iter().any(|d| d.starts_with(root.join("node_modules"))), "untracked trees aren't watched");
    }

    fn api() -> Api {
        Api::new(crate::git::GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), None)
    }

    async fn call(api: &Api, v: serde_json::Value) -> serde_json::Value {
        api.dispatch(serde_json::from_value::<Request>(v).unwrap()).await.unwrap()
    }

    async fn watched(r: &TestRepo) -> (Api, u32, broadcast::Receiver<AppEvent>) {
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
        call(&api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}})).await;
        call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}})).await;
        let rx = api.subscribe();
        (api, id, rx)
    }

    async fn next_change(rx: &mut broadcast::Receiver<AppEvent>, within: Duration) -> Option<(Vec<ChangeKind>, Vec<String>)> {
        tokio::time::timeout(within, async {
            loop {
                if let Ok(AppEvent::RepoChanged { kinds, worktrees, .. }) = rx.recv().await {
                    return (kinds, worktrees);
                }
            }
        })
        .await
        .ok()
    }

    fn wakeups(api: &Api, id: u32) -> u64 {
        api.watchers.lock().unwrap().get(&id).expect("watched").wakeups()
    }

    fn canonical(p: &Path) -> String {
        p.canonicalize().unwrap().display().to_string()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn worktree_edits_emit_repo_changed_with_the_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        r.write("brand-new.txt", "x\n");
        let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Worktree), "{kinds:?}");
        assert_eq!(wts, vec![canonical(r.path())]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn linked_worktree_edits_name_that_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        std::fs::write(r.root().join("wt-hotfix").join("added.txt"), "x\n").unwrap();
        let (_, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert_eq!(wts, vec![canonical(&r.root().join("wt-hotfix"))]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ref_changes_emit_refs() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        r.git(&["branch", "made-outside"]);
        let (kinds, _) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Refs), "{kinds:?}");
    }

    /// `git add` rewrites the index and changes what status reports: `index` for that worktree.
    #[tokio::test(flavor = "multi_thread")]
    async fn staging_emits_index_for_the_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        r.git(&["add", "file_1.txt"]);
        let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Index), "{kinds:?}");
        assert_eq!(wts, vec![canonical(r.path())]);
    }

    /// Switching to a new branch at the same commit moves HEAD and adds a ref, but status is the
    /// same: `head` and `refs`, and no `worktree`/`index` (nor any worktree path).
    #[tokio::test(flavor = "multi_thread")]
    async fn head_moves_without_status_changes_emit_head_only() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        r.git(&["switch", "-q", "-c", "same-commit"]);
        let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Head) && kinds.contains(&ChangeKind::Refs), "{kinds:?}");
        assert!(!kinds.contains(&ChangeKind::Worktree) && !kinds.contains(&ChangeKind::Index), "{kinds:?}");
        assert!(wts.is_empty(), "{wts:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn own_status_reads_emit_nothing() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        for _ in 0..3 {
            call(&api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "rescan": true}})).await;
        }
        assert!(next_change(&mut rx, Duration::from_millis(1500)).await.is_none(), "GitBolt's own reads must not trigger events");
        assert_eq!(wakeups(&api, id), 0, "GitBolt's own status reads must not even wake the watcher");
    }

    /// The WIP panel's reads (`git diff` with `diff.autoRefreshIndex=false`, `check-attr`, the
    /// worktree file itself) on a stat-dirty tree: no event either.
    #[tokio::test(flavor = "multi_thread")]
    async fn own_diff_reads_emit_nothing() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        // Stat-dirty but unchanged: a plain `git diff` would refresh (rewrite) the index here.
        let tracked = r.path().join("file_0.txt");
        let same = std::fs::read(&tracked).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        std::fs::write(&tracked, &same).unwrap();
        let (api, id, mut rx) = watched(&r).await;
        let wt = canonical(r.path());
        for _ in 0..2 {
            for staged in [false, true] {
                call(&api, serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": wt, "staged": staged}}})).await;
            }
            call(
                &api,
                serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "file_1.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}, "force": false}}),
            )
            .await;
        }
        assert!(next_change(&mut rx, Duration::from_millis(1500)).await.is_none(), "GitBolt's own diff reads must not trigger events");
        assert_eq!(wakeups(&api, id), 0, "GitBolt's own diff reads must not even wake the watcher");
    }

    /// The watcher's own status run (after a real change) must not wake it again: one change,
    /// then silence, with no further batches.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_watchers_own_status_run_does_not_wake_it() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        r.write("brand-new.txt", "x\n");
        next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        let after = wakeups(&api, id);
        assert!(after >= 1, "the event came from a batch");
        assert!(next_change(&mut rx, Duration::from_millis(1500)).await.is_none());
        assert_eq!(wakeups(&api, id), after, "no batch after the watcher's own status run");
    }

    /// Files created later inside a new, untracked (not ignored) folder are seen: the folder is
    /// watched once a status lists it.
    #[tokio::test(flavor = "multi_thread")]
    async fn new_files_in_an_untracked_folder_are_seen() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.write("newdir/first.txt", "x\n");
        // The first pass (status at watch start) lists newdir/first.txt, so newdir is watched.
        let (_api, _id, mut rx) = watched(&r).await;
        r.write("newdir/second.txt", "x\n");
        let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Worktree), "{kinds:?}");
        assert_eq!(wts, vec![canonical(r.path())]);
    }

    /// A change between the last graph build and the watch starting is still reported.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_change_before_the_watch_started_is_reported() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
        call(&api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}})).await;
        r.write("while-inactive.txt", "x\n");
        let mut rx = api.subscribe();
        call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}})).await;
        let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert_eq!(kinds, vec![ChangeKind::Worktree, ChangeKind::Index]);
        assert_eq!(wts, vec![canonical(r.path())]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ignored_churn_emits_nothing() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.write(".gitignore", "build/\n");
        r.git(&["add", ".gitignore"]);
        r.git(&["commit", "-q", "-m", "ignore build"]);
        let (_api, _id, mut rx) = watched(&r).await;
        std::fs::create_dir_all(r.path().join("build")).unwrap();
        for i in 0..20 {
            std::fs::write(r.path().join("build").join(format!("out{i}.o")), "x").unwrap();
        }
        assert!(next_change(&mut rx, Duration::from_millis(1500)).await.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bursts_are_debounced() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        for i in 0..30 {
            r.write(&format!("burst-{i}.txt"), "x\n");
        }
        assert!(next_change(&mut rx, Duration::from_secs(5)).await.is_some());
        let mut extra = 0;
        while next_change(&mut rx, Duration::from_millis(600)).await.is_some() {
            extra += 1;
        }
        assert!(extra <= 1, "30 writes produced {} events", extra + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unwatch_stops_events_and_watch_is_idempotent() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}})).await;
        assert_eq!(api.watched_repos(), vec![id]);
        call(&api, serde_json::json!({"method": "unwatchRepo", "params": {"repo": id}})).await;
        assert!(api.watched_repos().is_empty());
        r.write("after-unwatch.txt", "x\n");
        assert!(next_change(&mut rx, Duration::from_millis(1000)).await.is_none());
    }

    fn main_added(g: &serde_json::Value) -> u64 {
        let rows = g["rows"].as_array().unwrap();
        rows.iter().find_map(|r| r["wip"].as_object().filter(|w| w["worktreeName"].is_null()).map(|w| w["added"].as_u64().unwrap())).unwrap()
    }

    /// The status cache is trusted only while a watcher keeps it fresh: an unwatched repo's graph
    /// always re-reads status (1B's no-stale-WIP behaviour), a watched one's reflects the change
    /// the watcher saw.
    #[tokio::test(flavor = "multi_thread")]
    async fn graph_reuses_status_only_while_watched() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
        let graph = serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}});
        assert_eq!(main_added(&call(&api, graph.clone()).await), 0);
        r.write("unwatched.txt", "x\n");
        assert_eq!(main_added(&call(&api, graph.clone()).await), 1, "no watcher: status is re-read");
        call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}})).await;
        let mut rx = api.subscribe();
        r.write("watched.txt", "x\n");
        next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert_eq!(main_added(&call(&api, graph).await), 2, "the watcher refreshed the cache");
    }

    /// Requests run concurrently: an unwatch that lands while the watch is still being set up
    /// wins, and nothing stays watched.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unwatch_during_setup_wins() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
        let mut rx = api.subscribe();
        tokio::join!(call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}})), async {
            tokio::task::yield_now().await;
            call(&api, serde_json::json!({"method": "unwatchRepo", "params": {"repo": id}})).await
        });
        assert!(api.watched_repos().is_empty());
        r.write("after-unwatch.txt", "x\n");
        assert!(next_change(&mut rx, Duration::from_millis(1000)).await.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unwatch_all_clears_every_watcher() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        assert_eq!(api.watched_repos(), vec![id]);
        api.unwatch_all();
        assert!(api.watched_repos().is_empty());
        r.write("after-unwatch-all.txt", "x\n");
        assert!(next_change(&mut rx, Duration::from_millis(1000)).await.is_none(), "unwatch_all stops the events too");
    }

    /// `unwatchAll` (the UI's startup reset) stops every repo's watcher, and is a no-op with none.
    #[tokio::test(flavor = "multi_thread")]
    async fn unwatch_all_request_stops_every_watcher() {
        let (a, b) = (TestRepo::new(), TestRepo::new());
        fixtures::basic(&a);
        fixtures::basic(&b);
        let (api, first, mut rx) = watched(&a).await;
        let second = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": b.path()}})).await["id"].as_u64().unwrap() as u32;
        call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": second}})).await;
        assert_eq!(api.watched_repos(), vec![first, second]);
        assert!(call(&api, serde_json::json!({"method": "unwatchAll"})).await.is_null());
        assert!(api.watched_repos().is_empty());
        a.write("after-unwatch-all.txt", "x\n");
        b.write("after-unwatch-all.txt", "x\n");
        assert!(next_change(&mut rx, Duration::from_millis(1000)).await.is_none(), "no watcher reports a change");
        assert!(call(&api, serde_json::json!({"method": "unwatchAll"})).await.is_null(), "nothing watched: still null");
    }

    /// Starts a watcher with test `tuning` for an opened, graphed repo, as `watchRepo` would.
    async fn watched_tuned(r: &TestRepo, tuning: Tuning) -> (Api, u32, broadcast::Receiver<AppEvent>) {
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
        call(&api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}})).await;
        let h = api.handle(id).unwrap();
        let spec = api.watch_spec(id, &h).await.unwrap();
        let (cli, wip, bus) = (api.cli.clone(), h.wip.clone(), api.bus.clone());
        let w = tokio::task::spawn_blocking(move || RepoWatcher::start_tuned(spec, cli, wip, bus, tuning)).await.unwrap().unwrap();
        w.ready().await;
        api.watchers.lock().unwrap().insert(id, w);
        let rx = api.subscribe();
        (api, id, rx)
    }

    fn with_watcher<T>(api: &Api, id: u32, f: impl FnOnce(&RepoWatcher) -> T) -> T {
        f(api.watchers.lock().unwrap().get(&id).expect("watched"))
    }

    fn overflow() -> notify::Event {
        notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan)
    }

    /// A kernel-queue overflow (events lost) with nothing actually changed: a rescan, and no
    /// event (refs/HEAD/stash/config are checked against a snapshot, not assumed changed).
    #[tokio::test(flavor = "multi_thread")]
    async fn an_overflow_with_nothing_changed_emits_nothing() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        tokio::time::sleep(DEBOUNCE * 2).await; // past the first pass's own-overflow window
        with_watcher(&api, id, |w| w.inject(overflow()));
        assert!(next_change(&mut rx, Duration::from_millis(1500)).await.is_none());
        assert_eq!(wakeups(&api, id), 1, "one rescan, and no loop");
    }

    /// On a huge repo the watcher's own status reads can overflow the queue; those overflows are
    /// its own doing and must not start another rescan (which would overflow again, forever).
    #[tokio::test(flavor = "multi_thread")]
    async fn overflows_from_its_own_status_reads_do_not_loop() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched_tuned(&r, Tuning { overflow_after_status: true, ..Default::default() }).await;
        r.write("brand-new.txt", "x\n");
        next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        let after = wakeups(&api, id);
        assert!(next_change(&mut rx, Duration::from_millis(1500)).await.is_none());
        assert_eq!(wakeups(&api, id), after, "the self-inflicted overflows were dropped");
    }

    /// Dropping an older stash (`stash@{1}`) rewrites only `logs/refs/stash`, and `refs/stash`
    /// stays put: the flat watch on `logs/refs` is what reports it (1C review M1).
    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_an_older_stash_is_reported() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let file = r.git(&["ls-files"]).lines().next().unwrap().to_string();
        r.write(&file, "second stash\n");
        r.git(&["stash", "push", "-q"]);
        assert!(r.git(&["stash", "list"]).lines().count() >= 2);
        let (_api, _id, mut rx) = watched(&r).await;
        tokio::time::sleep(DEBOUNCE * 2).await;
        r.git(&["stash", "drop", "-q", "stash@{1}"]);
        let (kinds, _) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Stash), "{kinds:?}");
    }

    #[test]
    fn the_git_snapshot_tells_which_kinds_changed() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let common = r.path().join(".git").canonicalize().unwrap();
        let wts = [WatchedWorktree { root: r.path().canonicalize().unwrap(), git_dir: common.clone() }];
        let snap = || git_state(&common, &wts);
        let mut before = snap();
        assert!(changed_kinds(&before, &snap()).is_empty(), "stable");
        let mut step = |f: &dyn Fn(), want: &[ChangeKind]| {
            f();
            let now = snap();
            assert_eq!(changed_kinds(&before, &now), want.iter().copied().collect::<BTreeSet<_>>());
            before = now;
        };
        step(&|| drop(r.git(&["branch", "snap-branch"])), &[ChangeKind::Refs]);
        step(&|| drop(r.git(&["config", "gitbolt.test", "1"])), &[ChangeKind::Config]);
        step(&|| drop(r.git(&["switch", "-q", "snap-branch"])), &[ChangeKind::Head]);
        step(&|| drop(r.git(&["stash", "push", "-q"])), &[ChangeKind::Stash]);
    }

    /// inotify's watch limit (ENOSPC): no more watches, and the cache is no longer trusted, so a
    /// graph re-reads status even with the watcher running.
    #[tokio::test(flavor = "multi_thread")]
    async fn hitting_the_watch_limit_degrades_the_watch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, _rx) = watched_tuned(&r, Tuning { max_watches: Some(3), ..Default::default() }).await;
        assert!(with_watcher(&api, id, |w| w.degraded() && w.watches_len() == 3));
        assert!(!api.status_is_watched(id));
        r.write("unseen.txt", "x\n");
        let g = call(&api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}})).await;
        assert_eq!(main_added(&g), 1, "status re-read");
    }

    /// Past the flat-watch cap: no recursive fallback over the worktree; the rest is left out and
    /// the watch is degraded.
    #[tokio::test(flavor = "multi_thread")]
    async fn past_the_flat_cap_the_watch_is_degraded_not_recursive() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let common = r.path().join(".git").canonicalize().unwrap();
        let root = r.path().canonicalize().unwrap();
        let p = plan_capped(&common, &[WatchedWorktree { root: root.clone(), git_dir: common.clone() }], 3);
        assert!(p.truncated && p.flat.len() == 3);
        assert_eq!(p.recursive, BTreeSet::from([common.join("refs")]));
        let (api, id, _rx) = watched_tuned(&r, Tuning { max_flat: 3, ..Default::default() }).await;
        assert!(with_watcher(&api, id, RepoWatcher::degraded));
        assert!(!api.status_is_watched(id));
    }

    /// `git worktree add`: the new worktree is listed, watched and reported; its edits are seen.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_linked_worktree_is_picked_up() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        let added = r.root().join("wt-added");
        r.git(&["worktree", "add", "-q", "-b", "added-branch", added.to_str().unwrap()]);
        let want = canonical(&added);
        let (kinds, wts) = loop {
            let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
            if wts.contains(&want) {
                break (kinds, wts);
            }
        };
        assert!(kinds.contains(&ChangeKind::Head), "{kinds:?} {wts:?}");
        assert!(api.status_is_watched(id));
        std::fs::write(added.join("in-added.txt"), "x\n").unwrap();
        let (_, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert_eq!(wts, vec![want]);
    }

    /// A tracked folder deleted and recreated is watched again (its old inotify watch died).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_recreated_folder_is_watched_again() {
        let r = TestRepo::new();
        r.write("sub/x.txt", "x\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "sub"]);
        let (_api, _id, mut rx) = watched(&r).await;
        let sub = r.path().join("sub");
        std::fs::remove_dir_all(&sub).unwrap();
        next_change(&mut rx, Duration::from_secs(5)).await.expect("the deletion");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("x.txt"), "x\n").unwrap();
        next_change(&mut rx, Duration::from_secs(5)).await.expect("the restore");
        std::fs::write(sub.join("later.txt"), "x\n").unwrap();
        let (_, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("a file added in the recreated folder");
        assert_eq!(wts, vec![canonical(r.path())]);
    }

    /// A linked worktree whose directory is deleted behind git's back (`rm -rf`, no `git worktree
    /// remove`, so `.git/worktrees/<name>` stays and the topology watch sees nothing): the watcher
    /// stops watching it, reports it gone once, and never spawns git in the missing directory.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_deleted_worktree_directory_is_unwatched_not_polled_with_git() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, _id, mut rx) = watched(&r).await;
        let wt = r.root().join("wt-hotfix");
        let want = canonical(&wt);
        std::fs::remove_dir_all(&wt).unwrap();
        // Runs the watcher started while the removal was still under way don't count (one that
        // began before it finished can complete after): only runs that start once it is done.
        let removed_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let (kinds, wts) = loop {
            let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("the worktree's removal is reported");
            if wts.contains(&want) {
                break (kinds, wts);
            }
        };
        assert!(kinds.contains(&ChangeKind::Worktree) && kinds.contains(&ChangeKind::Head), "{kinds:?} {wts:?}");
        // Edits elsewhere are still seen, and nothing ran in the missing directory.
        r.write("after.txt", "x\n");
        let (_, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("the main worktree is still watched");
        assert_eq!(wts, vec![canonical(r.path())]);
        let missing = wt.display().to_string();
        let ran: Vec<_> = api.command_log().entries().into_iter().filter(|e| e.started_ms > removed_ms && (e.cwd == missing || e.cwd == want)).collect();
        assert!(ran.is_empty(), "git ran in the deleted worktree: {ran:?}");
    }

    /// The worktree the repo was opened from is the one deleted: it's dropped from the watch
    /// directly (nothing can be re-listed from its directory), reported once, and later changes
    /// elsewhere don't name it again.
    #[tokio::test(flavor = "multi_thread")]
    async fn deleting_the_opened_worktree_is_reported_once() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let wt = r.root().join("wt-hotfix");
        let want = canonical(&wt);
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": wt}})).await["id"].as_u64().unwrap() as u32;
        call(&api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}})).await;
        call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}})).await;
        let mut rx = api.subscribe();
        std::fs::remove_dir_all(&wt).unwrap();
        loop {
            let (_, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("the removal is reported");
            if wts.contains(&want) {
                break;
            }
        }
        for n in 0..3 {
            r.write(&format!("after-{n}.txt"), "x\n");
            let (_, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("the other worktree is still watched");
            assert!(!wts.contains(&want), "{wts:?} names the deleted worktree again");
        }
    }

    /// Staging in a linked worktree: `index` for that worktree.
    #[tokio::test(flavor = "multi_thread")]
    async fn staging_in_a_linked_worktree_names_it() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (_api, _id, mut rx) = watched(&r).await;
        let wt = r.root().join("wt-hotfix");
        r.git_in(&wt, &["add", "file_0.txt"]);
        let (kinds, wts) = next_change(&mut rx, Duration::from_secs(5)).await.expect("an event");
        assert!(kinds.contains(&ChangeKind::Index), "{kinds:?}");
        assert_eq!(wts, vec![canonical(&wt)]);
    }

    /// A second `watchRepo` while the first is still setting up waits for it to be ready; until
    /// then the pending watcher doesn't count for graphs.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_watch_waits_for_the_first_to_be_ready() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
        let watch = || call(&api, serde_json::json!({"method": "watchRepo", "params": {"repo": id}}));
        tokio::join!(watch(), async {
            tokio::task::yield_now().await;
            assert!(!api.status_is_watched(id), "pending: not trusted yet");
            watch().await;
            assert!(api.status_is_watched(id), "the second call returned only once the watch was ready");
        });
    }

    /// `MAX_WAIT`: events that keep coming (every 100 ms, under the debounce) are cut into a
    /// batch 1 s after the first.
    #[tokio::test(start_paused = true)]
    async fn steady_events_are_batched_at_max_wait() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let feeder = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if tx.send(notify::Event::new(EventKind::Any)).is_err() {
                    return;
                }
            }
        });
        let start = Instant::now();
        let events = gather(notify::Event::new(EventKind::Any), &mut rx, &CancellationToken::new()).await.unwrap();
        let took = start.elapsed();
        assert!(took >= MAX_WAIT && took < MAX_WAIT + Duration::from_millis(100), "{took:?}");
        assert!(events.len() >= 10, "{}", events.len());
        feeder.abort();
        // A single event: the batch closes after one quiet debounce.
        let (tx, mut rx) = mpsc::unbounded_channel::<notify::Event>();
        let start = Instant::now();
        gather(notify::Event::new(EventKind::Any), &mut rx, &CancellationToken::new()).await.unwrap();
        assert_eq!(start.elapsed(), DEBOUNCE);
        drop(tx);
    }

    async fn file_list(api: &Api, id: u32, wt: &str, staged: bool) -> serde_json::Value {
        call(api, serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": wt, "staged": staged}}})).await
    }

    fn paths(list: &serde_json::Value) -> Vec<String> {
        list["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_string()).collect()
    }

    /// The id of the last git process run (the command log's), to tell whether a call ran any.
    fn last_git(api: &Api) -> Option<u64> {
        api.cli.log().entries().last().map(|e| e.id)
    }

    /// The index's bytes and mtime: what C1 says no read may change.
    fn index_state(r: &TestRepo) -> (Vec<u8>, std::time::SystemTime) {
        let p = r.path().join(".git/index");
        (std::fs::read(&p).unwrap(), std::fs::metadata(&p).unwrap().modified().unwrap())
    }

    async fn change_naming(rx: &mut broadcast::Receiver<AppEvent>, wt: &str) -> std::collections::BTreeMap<String, String> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(AppEvent::RepoChanged { worktrees, versions, .. }) = rx.recv().await
                    && worktrees.iter().any(|w| w == wt)
                {
                    return versions;
                }
            }
        })
        .await
        .expect("a repoChanged naming the worktree")
    }

    /// K44: once watched, the WIP lists come from the watcher's cache (no git process, and a
    /// version the UI may hold), and are recomputed when the worktree changes: the event carries
    /// the new version, the next read has it and the new file, and the index is never written.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_watcher_keeps_the_wip_lists_and_refreshes_them_on_change() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let index = index_state(&r);
        let (api, id, mut rx) = watched(&r).await;
        let wt = canonical(r.path());
        // The first read (the UI's read-ahead) computes and keeps them; the next ones are served.
        file_list(&api, id, &wt, false).await;
        let before = last_git(&api);
        let unstaged = file_list(&api, id, &wt, false).await;
        let staged = file_list(&api, id, &wt, true).await;
        assert_eq!(last_git(&api), before, "served from the kept lists: no git process");
        assert_eq!(paths(&unstaged), vec!["file_1.txt"]);
        assert!(paths(&staged).is_empty());
        let v1 = unstaged["version"].as_str().expect("a version").to_string();
        assert_eq!(staged["version"], unstaged["version"], "both lists share their version");

        r.write("brand-new.txt", "a\nb\n");
        let versions = change_naming(&mut rx, &wt).await;
        let v2 = versions.get(&wt).expect("the event carries the lists' version").clone();
        assert_ne!(v1, v2);
        let before = last_git(&api);
        let unstaged = file_list(&api, id, &wt, false).await;
        assert_eq!(last_git(&api), before, "refreshed before the event: still no git process");
        assert_eq!(paths(&unstaged), vec!["brand-new.txt", "file_1.txt"]);
        assert_eq!(unstaged["version"], v2.as_str());
        assert_eq!(index_state(&r), index, "the watcher's lists never write the index (C1)");
    }

    /// Writing again to a file that's already modified leaves status alone but changes its line
    /// counts: the lists are recomputed and reported.
    #[tokio::test(flavor = "multi_thread")]
    async fn rewriting_a_modified_file_refreshes_its_counts() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        let wt = canonical(r.path());
        let count = |l: &serde_json::Value| l["files"][0]["additions"].as_u64().unwrap();
        let first = file_list(&api, id, &wt, false).await;
        r.write("file_1.txt", "main change\nmore\nand more\n");
        let versions = change_naming(&mut rx, &wt).await;
        let next = file_list(&api, id, &wt, false).await;
        assert_eq!(next["version"].as_str(), versions.get(&wt).map(String::as_str));
        assert!(count(&next) > count(&first), "{first} → {next}");
    }

    /// A stat-dirty but unchanged tracked file (mtime bumped) while watched: no event, never
    /// listed, and the index untouched (C1).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stat_dirty_file_is_not_listed_by_the_kept_lists() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        let index = index_state(&r);
        let wt = canonical(r.path());
        let f = std::fs::File::open(r.path().join("file_0.txt")).unwrap();
        f.set_modified(f.metadata().unwrap().modified().unwrap() + Duration::from_secs(120)).unwrap();
        r.write("other.txt", "x\n"); // a real change, so a refresh certainly runs
        change_naming(&mut rx, &wt).await;
        let unstaged = file_list(&api, id, &wt, false).await;
        assert_eq!(paths(&unstaged), vec!["file_1.txt", "other.txt"]);
        assert_eq!(index_state(&r), index);
    }

    /// Linked worktrees' lists are kept too.
    #[tokio::test(flavor = "multi_thread")]
    async fn linked_worktree_lists_are_kept_while_watched() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, _rx) = watched(&r).await;
        let wt = canonical(&r.root().join("wt-hotfix"));
        let first = file_list(&api, id, &wt, false).await;
        assert!(first["version"].is_string(), "a watched worktree's lists are kept from the first read");
        let before = last_git(&api);
        let list = file_list(&api, id, &wt, false).await;
        assert_eq!(last_git(&api), before);
        assert_eq!(paths(&list), vec!["file_0.txt"]);
        assert_eq!(list["version"], first["version"]);
    }

    /// An edit in a linked worktree: a new version for it, in the event and the next read.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_linked_worktree_edit_bumps_its_version() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, mut rx) = watched(&r).await;
        let dir = r.root().join("wt-hotfix");
        let wt = canonical(&dir);
        let v1 = file_list(&api, id, &wt, false).await["version"].as_str().unwrap().to_string();
        std::fs::write(dir.join("added.txt"), "x\n").unwrap();
        let versions = change_naming(&mut rx, &wt).await;
        let v2 = versions.get(&wt).expect("the linked worktree's new version").clone();
        assert_ne!(v1, v2);
        let before = last_git(&api);
        let list = file_list(&api, id, &wt, false).await;
        assert_eq!(last_git(&api), before);
        assert_eq!(list["version"], v2.as_str());
        assert_eq!(paths(&list), vec!["added.txt", "file_0.txt"]);
    }

    /// `ready` doesn't wait for any worktree's file lists (numstat on a big repo): they're
    /// computed on the first read, or by the watcher once a worktree changes.
    #[tokio::test(flavor = "multi_thread")]
    async fn ready_does_not_wait_for_the_wip_lists() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, _rx) = watched(&r).await;
        let h = api.handle(id).unwrap();
        assert!(h.wip.lists(r.path()).is_none() && h.wip.lists(&r.root().join("wt-hotfix")).is_none());
    }

    /// The lists can't be recomputed after a write to a file status already lists (so status,
    /// and the digest the old lists match, didn't change): they're dropped and the worktree is
    /// reported, never served stale.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_relist_drops_the_lists_and_reports_the_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let fail = Arc::new(AtomicBool::new(false));
        let (api, id, mut rx) = watched_tuned(&r, Tuning { fail_lists: Some(fail.clone()), ..Default::default() }).await;
        let wt = canonical(r.path());
        let first = file_list(&api, id, &wt, false).await;
        assert!(first["version"].is_string());
        fail.store(true, Ordering::SeqCst);
        r.write("file_1.txt", "main change\nmore\nand more\n");
        let versions = change_naming(&mut rx, &wt).await;
        assert!(!versions.contains_key(&wt), "no lists kept, so no version: {versions:?}");
        assert!(api.handle(id).unwrap().wip.lists(r.path()).is_none(), "the stale lists are dropped");
        let next = file_list(&api, id, &wt, false).await;
        assert!(next["files"][0]["additions"].as_u64().unwrap() > first["files"][0]["additions"].as_u64().unwrap(), "read anew: {next}");
    }

    /// Unwatched, or watched but degraded: the lists are read on request, with no version (the
    /// UI must not hold them).
    #[tokio::test(flavor = "multi_thread")]
    async fn unwatched_or_degraded_lists_are_read_on_request_without_a_version() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let (api, id, _rx) = watched(&r).await;
        let wt = canonical(r.path());
        call(&api, serde_json::json!({"method": "unwatchRepo", "params": {"repo": id}})).await;
        let before = last_git(&api);
        let list = file_list(&api, id, &wt, false).await;
        assert_ne!(last_git(&api), before, "read on request");
        assert_eq!(paths(&list), vec!["file_1.txt"]);
        assert!(list.get("version").is_none());

        let (api, id, _rx) = watched_tuned(&r, Tuning { max_watches: Some(3), ..Default::default() }).await;
        let list = file_list(&api, id, &wt, false).await;
        assert_eq!(paths(&list), vec!["file_1.txt"]);
        assert!(list.get("version").is_none(), "degraded: no version");
    }

    /// A watch that becomes degraded (here: new untracked folders past the flat-watch cap)
    /// reports every worktree changed, with no versions, so the UI drops what it held.
    #[tokio::test(flavor = "multi_thread")]
    async fn becoming_degraded_reports_every_worktree() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let roots = [canonical(r.path()), canonical(&r.root().join("wt-hotfix"))];
        let cap = {
            let api = api();
            let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await["id"].as_u64().unwrap() as u32;
            let spec = api.watch_spec(id, &api.handle(id).unwrap()).await.unwrap();
            plan(&spec.common_dir, &spec.worktrees).flat.len() + 2
        };
        let (api, id, mut rx) = watched_tuned(&r, Tuning { max_flat: cap, ..Default::default() }).await;
        assert!(api.status_is_watched(id));
        for i in 0..5 {
            r.write(&format!("new{i}/x.txt"), "x\n");
        }
        let (worktrees, versions) = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(AppEvent::RepoChanged { worktrees, versions, .. }) = rx.recv().await
                    && worktrees.len() == 2
                {
                    return (worktrees, versions);
                }
            }
        })
        .await
        .expect("every worktree reported");
        assert!(!api.status_is_watched(id));
        assert_eq!(worktrees.into_iter().collect::<BTreeSet<_>>(), roots.into_iter().collect());
        assert!(versions.is_empty());
    }
}
