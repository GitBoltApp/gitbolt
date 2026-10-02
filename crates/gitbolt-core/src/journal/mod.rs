//! The undo/redo journal (spec #2 §5.1).
//! One journal per worktree, in GitBolt's data dir, never in `.git`:
//! `<data>/journal/<first 16 hex of sha256(canonical worktree git dir)>.json`, 0600 in a 0700
//! directory. It's written atomically (temp + rename), under an `flock` on a sibling `.lock` file
//! (Deviation 5), so a `GITBOLT_MULTI_INSTANCE` second instance can't interleave. It records only
//! GitBolt's own operations; CAS (spec §4) protects them from outside changes.

pub(crate) mod autostash;
pub(crate) mod snapshot;
pub(crate) mod undo;

use crate::error::GbError;
use crate::events::OpKind;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

/// 2: kept stashes moved from the entries (`autostash`) to `Journal::kept` (v1 files migrate).
pub const JOURNAL_VERSION: u32 = 2;
/// The last 50 operations are kept (and at most 50 redo entries).
pub const MAX_ENTRIES: usize = 50;
/// Snapshots and autostashes expire after 14 days, as git's default `gc.pruneExpire`.
pub const SNAPSHOT_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// Milliseconds since the epoch; tests inject their own.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadState {
    pub branch: Option<String>,
    pub oid: Option<String>,
}

/// One ref's move as observed (§3.2 step 7), or as a CAS request (`write::refs::cas`: `old` is
/// what it must be now). `old: None` = didn't exist; `new: None` = deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefMove {
    pub name: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

/// A `branch.<name>.*` key's values before and after (2C writes these).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChange {
    pub key: String,
    pub old: Vec<String>,
    pub new: Vec<String>,
}

/// A dangling stash-shaped commit W (index I and untracked U are its parents 2 and 3) for the
/// path set `paths`, `untracked` being the ones captured in U (§5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub commit: String,
    pub paths: Vec<String>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashMove {
    pub oid: String,
    pub message: String,
    /// `true`: the op created it; `false`: the op dropped it.
    pub created: bool,
}

/// Why a stash is kept (§6.3–6.4, §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum KeptReason {
    /// Stashed by a running write, not restored yet: no banner while its owner runs.
    Pending,
    /// git refused to apply it; nothing changed.
    Refused,
    /// Applied with content conflicts in `files` files; the stash stays. `binary`: some are
    /// binary, where the worktree keeps only the current version (warn before Drop).
    Conflicts {
        files: u32,
        #[serde(default)]
        binary: bool,
    },
    /// The tracked changes applied, but not everything (its untracked files didn't come back):
    /// the stash still has everything, and Drop is refused.
    PartialRestore,
    /// A Stop (or the 15-minute limit) interrupted it: during the push (the op didn't run, and
    /// nothing was restored) or the apply (partly restored). Drop is refused.
    Stopped { phase: StashPhase },
    /// GitBolt stopped between the stash and its restore (found at load).
    Interrupted,
}

impl KeptReason {
    /// Only after a content conflict are the stash's changes in the worktree: any other kept
    /// stash may hold the only copy of some, so Drop is refused.
    pub fn droppable(&self) -> bool {
        matches!(self, KeptReason::Conflicts { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StashPhase {
    Push,
    Apply,
}

/// A stash GitBolt made and didn't drop: the journal's own list, apart from the undo and redo
/// stacks, so no undo, redo, cap or expiry can take its banner away. Only Apply (once applied
/// cleanly) and the banner's × or Drop stash remove it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptStash {
    /// The banner's id (the journal's id space).
    pub id: u64,
    /// `None` while its push runs: the record is written ahead (review N2), and recovery finds
    /// the stash by its exact message among those newer than `stash_before`.
    pub oid: Option<String>,
    /// `refs/stash` before the push.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash_before: Option<String>,
    pub message: String,
    /// The operation it was made for ("checkout feature/x", "undo discard a.php").
    pub label: String,
    /// What it conflicted with, for the banner.
    pub target: Option<String>,
    pub reason: KeptReason,
    pub created_ms: i64,
    /// The instance whose write made it, while `Pending`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Owner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryState {
    Pending,
    Done,
}

/// How an entry is undone (§5.3). `Stash` arrives with 2C (Deviation 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UndoKind {
    MoveRefs,
    Rewind,
    Switch,
    Restore,
    Barrier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: u64,
    pub at_ms: i64,
    pub label: String,
    pub kind: OpKind,
    pub state: EntryState,
    pub head_before: HeadState,
    pub head_after: HeadState,
    #[serde(default)]
    pub refs: Vec<RefMove>,
    #[serde(default)]
    pub config: Vec<ConfigChange>,
    pub before: Option<Snapshot>,
    pub after: Option<Snapshot>,
    #[serde(default)]
    pub stashes: Vec<StashMove>,
    /// The pre-op index tree ("Stage all & commit", 2B).
    pub index_before: Option<String>,
    pub undo: UndoKind,
    /// The GitBolt instance running it while it's pending: recovery leaves a live owner's entry
    /// alone (another instance's write in flight). `None` (older files): any recovery takes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Owner>,
}

/// A GitBolt instance that writes journals: the process (pid and start time, so a reused pid
/// isn't taken for it) and the `Api` in it. It's alive while it holds the exclusive `flock` on
/// its file in `<data>/owners/` (`OwnerLock`); the kernel releases that when the process dies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub pid: u32,
    /// `/proc/<pid>/stat`'s start time (clock ticks since boot); 0 where unknown.
    pub start: u64,
    /// Which `Api` of the process (tests run several, one after another).
    pub instance: u64,
}

impl Owner {
    fn file(&self, data_dir: &Path) -> PathBuf {
        data_dir.join("owners").join(format!("{}-{}-{}.lock", self.pid, self.start, self.instance))
    }

    /// Whether the instance still runs: its owner file is still locked.
    pub fn alive(&self, data_dir: &Path) -> bool {
        let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(self.file(data_dir)) else { return false };
        match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
            Ok(_free) => false,
            Err((_, e)) => e == nix::errno::Errno::EWOULDBLOCK,
        }
    }
}

/// This process's start time, from `/proc/self/stat` (field 22, after the parenthesised name).
fn process_start() -> u64 {
    std::fs::read_to_string("/proc/self/stat").ok().and_then(|s| s.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(19)?.parse().ok())).unwrap_or(0)
}

/// An instance's owner `flock`, held for the `Api`'s life.
pub struct OwnerLock {
    pub owner: Owner,
    _lock: nix::fcntl::Flock<std::fs::File>,
}

impl OwnerLock {
    pub fn acquire(data_dir: &Path) -> Result<Self, GbError> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let owner = Owner { pid: std::process::id(), start: process_start(), instance: NEXT.fetch_add(1, Ordering::Relaxed) };
        if let Some(parent) = data_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::paths::private_dir(data_dir)?;
        crate::paths::private_dir(&data_dir.join("owners"))?;
        // Another instance's `sweep` may unlink the file between our open and our flock (it was
        // still unlocked then): the lock would then be on a file no one can find, and this
        // instance would look dead (2A final M3). Locked, the path must still be our file.
        let path = owner.file(data_dir);
        loop {
            let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(&path)?;
            let lock = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock).map_err(|(_, e)| GbError::from(std::io::Error::from(e)))?;
            use std::os::unix::fs::MetadataExt;
            let (ours, there) = (lock.metadata()?, std::fs::metadata(&path));
            if there.is_ok_and(|t| (t.dev(), t.ino()) == (ours.dev(), ours.ino())) {
                return Ok(Self { owner, _lock: lock });
            }
        }
    }

    /// Owner files whose instance is gone (left by a crash), so they don't pile up.
    pub fn sweep(data_dir: &Path) {
        let Ok(entries) = std::fs::read_dir(data_dir.join("owners")) else { return };
        for e in entries.flatten() {
            let p = e.path();
            let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&p) else { continue };
            if let Ok(free) = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
                let _ = std::fs::remove_file(&p);
                drop(free);
            }
        }
    }
}

impl JournalEntry {
    /// Anything happened: a ref or HEAD moved, files were snapshotted, a stash or config
    /// changed, or it's a barrier (a push changes nothing local).
    pub fn changed(&self) -> bool {
        self.undo == UndoKind::Barrier
            || !self.refs.is_empty()
            || self.head_before != self.head_after
            || self.before.is_some()
            || self.after.is_some()
            || !self.stashes.is_empty()
            || !self.config.is_empty()
    }

    /// It holds git objects that expire with `gc.pruneExpire`.
    fn holds_objects(&self) -> bool {
        self.before.is_some() || self.after.is_some()
    }
}

/// What `run_write` knows when it writes an entry ahead (§3.2 step 3).
pub struct NewEntry {
    pub label: String,
    pub kind: OpKind,
    pub head_before: HeadState,
    pub undo: UndoKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub worktree: String,
    #[serde(default)]
    pub next_id: u64,
    /// Oldest first; the last `Done` one is what Undo undoes.
    #[serde(default)]
    pub undo: Vec<JournalEntry>,
    /// The last is what Redo redoes.
    #[serde(default)]
    pub redo: Vec<JournalEntry>,
    /// Entries found pending at load (Deviation 6), until their banner is acted on.
    #[serde(default)]
    pub recovery: Vec<JournalEntry>,
    /// Stashes GitBolt made and still keeps (their banners).
    #[serde(default)]
    pub kept: Vec<KeptStash>,
}

/// The newest entry of a stack, for the toolbar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JournalTop {
    #[ts(type = "number")]
    pub entry: u64,
    pub label: String,
    pub kind: OpKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BannerKind {
    /// GitBolt stopped mid-operation (§5.1).
    Recovery,
    /// The autostash wasn't restored: git refused (§6.4).
    AutostashRefused,
    /// The autostash was applied with conflicts; the stash is kept (§6.4).
    AutostashConflicts,
    /// "Partly restored; the stash still has everything" (Apply / Show, no Drop): its untracked
    /// files didn't come back, or a Stop interrupted the restore.
    AutostashPartial,
    /// A Stop interrupted saving the changes: the operation didn't run, and the changes are in
    /// the stash (Apply / Show, no Drop).
    AutostashStopped,
}

/// One banner in the tab's `banner` slot (§6.4). The UI writes the copy from these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Banner {
    #[ts(type = "number")]
    pub entry: u64,
    pub kind: BannerKind,
    /// The operation's label ("checkout feature/x").
    pub label: String,
    /// The kept stash's oid (Show selects it), if any.
    pub stash: Option<String>,
    pub stash_message: Option<String>,
    pub target: Option<String>,
    /// A recovery entry with a `before` snapshot: its button is Restore.
    pub snapshot: bool,
    /// Conflicted files (`AutostashConflicts`).
    pub files: u32,
    /// Drop stash is offered (after a content conflict only).
    pub can_drop: bool,
    /// Some conflicts are binary: before Drop, warn that only the current version is kept.
    pub binary: bool,
}

/// What Undo/Redo and the banners show (§5.5); every write returns it (`WriteResult.journal`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JournalState {
    pub undo: Option<JournalTop>,
    pub redo: Option<JournalTop>,
    /// Why Undo can't run now: "Nothing to undo", "Push can't be undone", "Finish or abort the rebase first".
    pub undo_blocked: Option<String>,
    pub redo_blocked: Option<String>,
    pub banners: Vec<Banner>,
}

impl JournalTop {
    fn of(e: &JournalEntry) -> Self {
        Self { entry: e.id, label: e.label.clone(), kind: e.kind }
    }
}

impl Journal {
    pub fn empty(worktree: &str) -> Self {
        Self { version: JOURNAL_VERSION, worktree: worktree.to_string(), next_id: 1, undo: Vec::new(), redo: Vec::new(), recovery: Vec::new(), kept: Vec::new() }
    }

    /// Write-ahead (§3.2 step 3): a pending entry, newest. Returns its id.
    pub fn begin(&mut self, e: NewEntry, now: i64) -> u64 {
        let id = self.next_id.max(1);
        self.next_id = id + 1;
        self.undo.push(JournalEntry {
            id,
            at_ms: now,
            label: e.label,
            kind: e.kind,
            state: EntryState::Pending,
            head_after: e.head_before.clone(),
            head_before: e.head_before,
            refs: Vec::new(),
            config: Vec::new(),
            before: None,
            after: None,
            stashes: Vec::new(),
            index_before: None,
            undo: e.undo,
            owner: None,
        });
        id
    }

    /// Records a stash a write just made (`Pending`, owned) or keeps (its reason). Its id.
    pub fn keep(&mut self, mut k: KeptStash) -> u64 {
        let id = self.next_id.max(1);
        self.next_id = id + 1;
        k.id = id;
        self.kept.push(k);
        id
    }

    pub fn kept_mut(&mut self, id: u64) -> Option<&mut KeptStash> {
        self.kept.iter_mut().find(|k| k.id == id)
    }

    pub fn entry_mut(&mut self, id: u64) -> Option<&mut JournalEntry> {
        self.undo.iter_mut().chain(self.redo.iter_mut()).chain(self.recovery.iter_mut()).find(|e| e.id == id)
    }

    /// §3.2 step 9: done, or dropped if nothing changed. A kept entry is a new operation: redo
    /// clears and the 50-entry cap applies. `true` when kept.
    pub fn finalize(&mut self, id: u64) -> bool {
        let Some(i) = self.undo.iter().position(|e| e.id == id) else { return false };
        if !self.undo[i].changed() {
            self.undo.remove(i);
            return false;
        }
        self.undo[i].state = EntryState::Done;
        self.redo.clear();
        if self.undo.len() > MAX_ENTRIES {
            let extra = self.undo.len() - MAX_ENTRIES;
            self.undo.drain(..extra);
        }
        true
    }

    pub fn drop_entry(&mut self, id: u64) {
        self.undo.retain(|e| e.id != id);
        self.redo.retain(|e| e.id != id);
        self.recovery.retain(|e| e.id != id);
    }

    /// Drops `id` and every older undo entry (a missing snapshot: undo is linear). Their labels.
    pub fn drop_through(&mut self, id: u64) -> Vec<String> {
        match self.undo.iter().position(|e| e.id == id) {
            Some(i) => self.undo.drain(..=i).map(|e| e.label).collect(),
            None => Vec::new(),
        }
    }

    /// At load: pending entries mean GitBolt stopped mid-operation. They leave the undo stack;
    /// those holding a snapshot or an autostash wait in `recovery` for their banner.
    pub fn recover(&mut self) {
        self.recover_unless(|_| false);
    }

    /// `recover`, leaving the pending entries of an owner that's `alive` (another instance's
    /// write in flight) where they are.
    pub fn recover_unless(&mut self, alive: impl Fn(&Owner) -> bool) {
        let (crashed, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.undo).into_iter().partition(|e| e.state == EntryState::Pending && !e.owner.as_ref().is_some_and(&alive));
        self.undo = kept;
        self.recovery.extend(crashed.into_iter().filter(|e| e.holds_objects()));
        // A stash made by a write that never restored it: its banner shows now.
        for k in &mut self.kept {
            if k.reason == KeptReason::Pending && !k.owner.as_ref().is_some_and(&alive) {
                k.reason = KeptReason::Interrupted;
                k.owner = None;
            }
        }
    }

    /// Recovery of records written ahead of a push that never reported back (review N2):
    /// `stashes` is the stash list, newest first, as (oid, subject `On <branch>: <message>`).
    /// The match is the newest one, newer than `stash_before`, whose message is exactly the
    /// record's; none means git stored nothing, and the record goes.
    pub fn resolve_unrecorded(&mut self, stashes: &[(String, String)]) {
        let mut taken: Vec<String> = self.kept.iter().filter_map(|k| k.oid.clone()).collect();
        self.kept.retain_mut(|k| {
            if k.oid.is_some() || k.reason == KeptReason::Pending {
                return true;
            }
            let newer = stashes.iter().take_while(|(oid, _)| Some(oid) != k.stash_before.as_ref());
            let found = newer.filter(|(oid, _)| !taken.contains(oid)).find(|(_, subject)| subject.split_once(": ").is_some_and(|(_, m)| m == k.message));
            match found {
                Some((oid, _)) => {
                    taken.push(oid.clone());
                    k.oid = Some(oid.clone());
                    true
                }
                None => false,
            }
        });
    }

    /// §5.1: an entry whose snapshot or autostash is older than 14 days goes, with every older
    /// one (undo and redo are linear). Returns the dropped labels.
    pub fn expire(&mut self, now: i64) -> Vec<String> {
        let cutoff = now - SNAPSHOT_TTL_MS;
        let stale = |e: &JournalEntry| e.holds_objects() && e.at_ms < cutoff;
        let mut gone = Vec::new();
        for stack in [&mut self.undo, &mut self.redo] {
            if let Some(i) = stack.iter().rposition(stale) {
                gone.extend(stack.drain(..=i).map(|e| e.label));
            }
        }
        self.recovery.retain(|e| e.at_ms >= cutoff);
        gone
    }

    /// The newest finished entry (a running op's pending entry isn't undoable yet).
    pub fn undo_top(&self) -> Option<&JournalEntry> {
        self.undo.iter().rev().find(|e| e.state == EntryState::Done)
    }

    pub fn redo_top(&self) -> Option<&JournalEntry> {
        self.redo.last()
    }

    /// After an undo (`to_redo`) or a redo, the entry changes stacks (§5.4). Each stack keeps 50.
    pub fn shift(&mut self, id: u64, to_redo: bool) {
        let (from, to) = if to_redo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        if let Some(i) = from.iter().position(|e| e.id == id) {
            let e = from.remove(i);
            to.push(e);
        }
        for stack in [&mut self.undo, &mut self.redo] {
            if stack.len() > MAX_ENTRIES {
                let extra = stack.len() - MAX_ENTRIES;
                stack.drain(..extra);
            }
        }
    }

    /// `in_progress`: "rebase", "merge", … when the worktree is mid-operation.
    pub fn state(&self, in_progress: Option<&str>) -> JournalState {
        let busy = in_progress.map(|w| format!("Finish or abort the {w} first"));
        let top = self.undo_top();
        let undo_blocked = busy.clone().or_else(|| match top {
            None => Some("Nothing to undo".to_string()),
            Some(e) if e.undo == UndoKind::Barrier => Some("Push can't be undone".to_string()),
            Some(_) => None,
        });
        let redo_blocked = busy.or_else(|| self.redo_top().is_none().then(|| "Nothing to redo".to_string()));
        let mut banners: Vec<Banner> = self
            .recovery
            .iter()
            .map(|e| Banner {
                entry: e.id,
                kind: BannerKind::Recovery,
                label: e.label.clone(),
                stash: None,
                stash_message: None,
                target: None,
                snapshot: e.before.is_some(),
                files: 0,
                can_drop: false,
                binary: false,
            })
            .collect();
        for k in &self.kept {
            let Some(oid) = &k.oid else { continue };
            let (kind, files, binary) = match k.reason {
                KeptReason::Refused => (BannerKind::AutostashRefused, 0, false),
                KeptReason::Conflicts { files, binary } => (BannerKind::AutostashConflicts, files, binary),
                KeptReason::PartialRestore | KeptReason::Stopped { phase: StashPhase::Apply } => (BannerKind::AutostashPartial, 0, false),
                KeptReason::Stopped { phase: StashPhase::Push } => (BannerKind::AutostashStopped, 0, false),
                KeptReason::Interrupted => (BannerKind::Recovery, 0, false),
                KeptReason::Pending => continue,
            };
            banners.push(Banner { entry: k.id, kind, label: k.label.clone(), stash: Some(oid.clone()), stash_message: Some(k.message.clone()), target: k.target.clone(), snapshot: false, files, can_drop: k.reason.droppable(), binary });
        }
        JournalState { undo: top.map(JournalTop::of), redo: self.redo_top().map(JournalTop::of), undo_blocked, redo_blocked, banners }
    }
}

/// One worktree's journal file.
pub struct JournalStore {
    dir: PathBuf,
    path: PathBuf,
    lock: PathBuf,
    worktree: String,
}

impl JournalStore {
    pub(crate) fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// `git_dir`: the worktree's canonical git dir (the common dir for the main worktree).
    pub fn new(data_dir: &Path, git_dir: &Path, worktree: &Path) -> Self {
        let name = &Self::hex(&Sha256::digest(git_dir.as_os_str().as_encoded_bytes()))[..16];
        let dir = data_dir.join("journal");
        Self { path: dir.join(format!("{name}.json")), lock: dir.join(format!("{name}.lock")), dir, worktree: worktree.display().to_string() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Journal, GbError> {
        let _lock = self.locked()?;
        self.read()
    }

    /// Runs `f` on the journal under the lock, and writes it back atomically only if `f` changed it.
    pub fn update<T>(&self, f: impl FnOnce(&mut Journal) -> T) -> Result<T, GbError> {
        let _lock = self.locked()?;
        let mut j = self.read()?;
        let before = serde_json::to_vec(&j).map_err(|e| GbError::other(format!("journal: {e}")))?;
        let out = f(&mut j);
        if serde_json::to_vec(&j).map_err(|e| GbError::other(format!("journal: {e}")))? != before {
            let bytes = serde_json::to_vec_pretty(&j).map_err(|e| GbError::other(format!("journal: {e}")))?;
            write_private(&self.path, &bytes)?;
        }
        Ok(out)
    }

    /// The 0700 directories, then an exclusive `flock` on `<hash>.lock` (Deviation 5).
    fn locked(&self) -> Result<nix::fcntl::Flock<std::fs::File>, GbError> {
        let data = self.dir.parent().ok_or_else(|| GbError::other("journal dir has no parent"))?;
        if let Some(parent) = data.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::paths::private_dir(data)?;
        crate::paths::private_dir(&self.dir)?;
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(&self.lock)?;
        nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusive).map_err(|(_, e)| GbError::from(std::io::Error::from(e)))
    }

    /// Missing: empty. Corrupt or from a newer GitBolt: set aside (renamed, never overwritten),
    /// then empty. Unreadable (EACCES, EIO): an error, so nothing writes over it.
    fn read(&self) -> Result<Journal, GbError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Journal::empty(&self.worktree)),
            Err(e) => return Err(e.into()),
        };
        let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            self.set_aside("corrupt");
            return Ok(Journal::empty(&self.worktree));
        };
        let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
        if version > u64::from(JOURNAL_VERSION) {
            self.set_aside(&format!("v{version}"));
            return Ok(Journal::empty(&self.worktree));
        }
        if version < 2 {
            migrate_v1(&mut value);
        }
        match serde_json::from_value::<Journal>(value) {
            Ok(j) => Ok(j),
            Err(_) => {
                self.set_aside("corrupt");
                Ok(Journal::empty(&self.worktree))
            }
        }
    }

    fn set_aside(&self, tag: &str) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let dest = self.path.with_extension(format!("json.{tag}-{now}"));
        match std::fs::rename(&self.path, &dest) {
            Ok(()) => tracing::warn!("set aside unusable journal {} as {}", self.path.display(), dest.display()),
            Err(e) => tracing::warn!("could not set aside {}: {e}", self.path.display()),
        }
    }
}

/// v1 kept an autostash on its entry (`autostash: { oid, message, target, outcome, dismissed }`):
/// each one not restored or dismissed becomes a `kept` record, so its banner survives.
fn migrate_v1(v: &mut serde_json::Value) {
    use serde_json::json;
    let mut next = v.get("nextId").and_then(|n| n.as_u64()).unwrap_or(1).max(1);
    let mut kept = Vec::new();
    for stack in ["undo", "redo", "recovery"] {
        let Some(entries) = v.get_mut(stack).and_then(|s| s.as_array_mut()) else { continue };
        for e in entries {
            let (label, at) = (e.get("label").cloned().unwrap_or(json!("")), e.get("atMs").cloned().unwrap_or(json!(0)));
            let Some(a) = e.as_object_mut().and_then(|o| o.remove("autostash")).filter(|a| a.is_object()) else { continue };
            let status = a["outcome"]["status"].as_str().unwrap_or("pending");
            if a["dismissed"] == json!(true) || status == "restored" {
                continue;
            }
            let reason = match status {
                "refused" => json!({"status": "refused"}),
                "conflicts" => json!({"status": "conflicts", "files": a["outcome"]["files"], "binary": false}),
                _ => json!({"status": "interrupted"}),
            };
            kept.push(json!({"id": next, "oid": a["oid"], "message": a["message"], "label": label, "target": a["target"], "reason": reason, "createdMs": at}));
            next += 1;
        }
    }
    if let Some(o) = v.as_object_mut() {
        o.insert("kept".into(), json!(kept));
        o.insert("nextId".into(), json!(next));
        o.insert("version".into(), json!(JOURNAL_VERSION));
    }
}

/// Temp file (0600) + fsync + rename + directory fsync.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), GbError> {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let dir = path.parent().ok_or_else(|| GbError::other("journal path has no parent"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn store(data: &Path) -> JournalStore {
        JournalStore::new(data, Path::new("/r/.git"), Path::new("/r"))
    }

    fn head(oid: &str) -> HeadState {
        HeadState { branch: Some("main".into()), oid: Some(oid.into()) }
    }

    fn new_entry(label: &str, undo: UndoKind) -> NewEntry {
        NewEntry { label: label.into(), kind: OpKind::Commit, head_before: head("a"), undo }
    }

    /// Begins and finalizes one entry that moved `main`.
    fn record(j: &mut Journal, label: &str, now: i64) -> u64 {
        let id = j.begin(new_entry(label, UndoKind::MoveRefs), now);
        j.entry_mut(id).unwrap().refs.push(RefMove { name: "refs/heads/main".into(), old: Some("a".into()), new: Some("b".into()) });
        assert!(j.finalize(id));
        id
    }

    #[test]
    fn the_file_is_per_worktree_hashed_and_private() {
        let data = tempfile::tempdir().unwrap();
        let s = store(data.path());
        let want = format!("{}.json", &JournalStore::hex(&sha2::Sha256::digest(b"/r/.git"))[..16]);
        assert_eq!(s.path(), data.path().join("journal").join(want));
        s.update(|j| record(j, "commit \"x\"", 1)).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&data.path().join("journal")), 0o700);
        assert_eq!(mode(s.path()), 0o600);
        let other = JournalStore::new(data.path(), Path::new("/r/.git/worktrees/wt"), Path::new("/wt"));
        assert_ne!(other.path(), s.path(), "a linked worktree has its own journal");
    }

    #[test]
    fn it_persists_across_stores_and_carries_its_schema_version() {
        let data = tempfile::tempdir().unwrap();
        store(data.path()).update(|j| record(j, "commit \"x\"", 1)).unwrap();
        let j = store(data.path()).load().unwrap();
        assert_eq!((j.version, j.undo.len(), j.undo[0].label.as_str()), (JOURNAL_VERSION, 1, "commit \"x\""));
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(store(data.path()).path()).unwrap()).unwrap();
        assert_eq!(raw["version"], JOURNAL_VERSION);
    }

    #[test]
    fn an_entry_is_written_ahead_then_finalized_dropped_if_nothing_changed() {
        let mut j = Journal::empty("/r");
        let id = j.begin(new_entry("commit \"x\"", UndoKind::MoveRefs), 1);
        assert_eq!(j.undo[0].state, EntryState::Pending);
        assert!(!j.finalize(id), "no ref moved, nothing snapshotted: dropped");
        assert!(j.undo.is_empty());
        let barrier = j.begin(new_entry("push main to origin/main", UndoKind::Barrier), 2);
        assert!(j.finalize(barrier), "a barrier is kept though nothing local changed");
    }

    #[test]
    fn a_new_operation_clears_redo() {
        let mut j = Journal::empty("/r");
        let id = record(&mut j, "one", 1);
        let e = j.undo.pop().unwrap();
        assert_eq!(e.id, id);
        j.redo.push(e);
        record(&mut j, "two", 2);
        assert!(j.redo.is_empty());
    }

    #[test]
    fn it_keeps_the_last_50() {
        let mut j = Journal::empty("/r");
        for n in 0..55 {
            record(&mut j, &format!("op {n}"), n);
        }
        assert_eq!(j.undo.len(), MAX_ENTRIES);
        assert_eq!(j.undo[0].label, "op 5");
        assert_eq!(j.undo.last().unwrap().label, "op 54");
    }

    #[test]
    fn snapshots_expire_after_14_days_with_every_older_entry() {
        let day = 24 * 60 * 60 * 1000;
        let mut j = Journal::empty("/r");
        record(&mut j, "old plain", 0);
        let snap = j.begin(new_entry("discard a.php", UndoKind::Restore), day);
        j.entry_mut(snap).unwrap().before = Some(Snapshot { commit: "w".into(), paths: vec!["a.php".into()], untracked: vec![] });
        assert!(j.finalize(snap));
        record(&mut j, "recent", 10 * day);
        assert!(j.expire(14 * day).is_empty(), "13 days old: kept");
        let gone = j.expire(15 * day + 1);
        assert_eq!(gone, vec!["old plain".to_string(), "discard a.php".to_string()], "undo is linear: the older entry goes too");
        assert_eq!(j.undo.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["recent"], "an entry without objects ages out only through the cap");
    }

    #[test]
    fn a_pending_entry_at_load_becomes_a_recovery_banner() {
        let mut j = Journal::empty("/r");
        let id = j.begin(new_entry("discard a.php", UndoKind::Restore), 1);
        j.entry_mut(id).unwrap().before = Some(Snapshot { commit: "w".into(), paths: vec!["a.php".into()], untracked: vec![] });
        let bare = j.begin(new_entry("commit \"y\"", UndoKind::MoveRefs), 2);
        j.recover();
        assert!(j.undo.is_empty(), "pending entries leave the undo stack");
        assert_eq!(j.recovery.len(), 1, "only one with something to restore stays (Deviation 6)");
        let b = &j.state(None).banners[0];
        assert_eq!((b.kind, b.entry, b.label.as_str(), b.snapshot), (BannerKind::Recovery, id, "discard a.php", true));
        assert!(j.entry_mut(bare).is_none());
    }

    #[test]
    fn the_state_names_the_top_and_why_it_cant_run() {
        let mut j = Journal::empty("/r");
        let s = j.state(None);
        assert_eq!((s.undo, s.undo_blocked.as_deref(), s.redo_blocked.as_deref()), (None, Some("Nothing to undo"), Some("Nothing to redo")));
        let id = record(&mut j, "commit \"Fix x\"", 1);
        let s = j.state(None);
        assert_eq!(s.undo, Some(JournalTop { entry: id, label: "commit \"Fix x\"".into(), kind: OpKind::Commit }));
        assert_eq!(s.undo_blocked, None);
        assert_eq!(j.state(Some("rebase")).undo_blocked.as_deref(), Some("Finish or abort the rebase first"));
        let barrier = j.begin(new_entry("push main to origin/main", UndoKind::Barrier), 2);
        j.finalize(barrier);
        assert_eq!(j.state(None).undo_blocked.as_deref(), Some("Push can't be undone"));
        let pending = j.begin(new_entry("commit \"later\"", UndoKind::MoveRefs), 3);
        assert_eq!(j.state(None).undo.unwrap().entry, barrier, "a running op isn't the top");
        j.drop_entry(pending);
    }

    fn kept(oid: &str, reason: KeptReason) -> KeptStash {
        KeptStash { id: 0, oid: Some(oid.into()), stash_before: None, message: format!("autostash before checkout {oid}"), label: format!("checkout {oid}"), target: Some("feature/x".into()), reason, created_ms: 1, owner: None }
    }

    /// Review n3/n4: a v1 file's per-entry autostash becomes a kept record (its banner stays).
    #[test]
    fn a_v1_journal_migrates_its_autostashes() {
        let data = tempfile::tempdir().unwrap();
        let s = store(data.path());
        std::fs::create_dir_all(data.path().join("journal")).unwrap();
        let entry = |id: u64, outcome: &str| serde_json::json!({"id": id, "atMs": 5, "label": format!("checkout {id}"), "kind": "checkout", "state": "done", "headBefore": {"branch": "main", "oid": "a"}, "headAfter": {"branch": "x", "oid": "a"}, "before": null, "after": null, "indexBefore": null, "undo": "switch", "autostash": {"oid": format!("s{id}"), "message": "autostash before checkout x", "target": "x", "outcome": {"status": outcome}, "dismissed": false}});
        let v1 = serde_json::json!({"version": 1, "worktree": "/r", "nextId": 3, "undo": [entry(1, "refused"), entry(2, "restored")], "redo": [], "recovery": []});
        std::fs::write(s.path(), serde_json::to_vec(&v1).unwrap()).unwrap();
        let j = s.load().unwrap();
        assert_eq!(j.version, JOURNAL_VERSION);
        assert_eq!(j.undo.len(), 2, "the entries stay");
        let b = &j.state(None).banners;
        assert_eq!(b.len(), 1, "only the stash still kept: {b:?}");
        assert_eq!((b[0].kind, b[0].stash.as_deref(), b[0].entry), (BannerKind::AutostashRefused, Some("s1"), 3));
    }

    /// Review N2: a record written ahead of a push that never reported back.
    #[test]
    fn an_unrecorded_push_is_found_by_its_message_or_dropped() {
        let mut j = Journal::empty("/r");
        let mut k = kept("x", KeptReason::Pending);
        (k.oid, k.stash_before, k.owner) = (None, Some("old".into()), Some(Owner { pid: 1, start: 2, instance: 3 }));
        let id = j.keep(k.clone());
        let gone = j.keep(k);
        j.recover_unless(|_| false);
        let stashes = [("new".to_string(), "On main: autostash before checkout x".to_string()), ("old".to_string(), "On main: autostash before checkout x".to_string())];
        j.resolve_unrecorded(&stashes);
        assert_eq!(j.kept.len(), 1, "one stash, one record: the other push stored nothing");
        let b = &j.state(None).banners[0];
        assert_eq!((b.kind, b.entry, b.stash.as_deref()), (BannerKind::Recovery, id, Some("new")));
        assert!(j.kept_mut(gone).is_none());
    }

    #[test]
    fn a_kept_stash_shows_its_banner_until_removed() {
        let mut j = Journal::empty("/r");
        let id = j.keep(kept("s", KeptReason::Refused));
        let b = &j.state(None).banners[0];
        assert_eq!((b.kind, b.entry, b.stash.as_deref(), b.target.as_deref()), (BannerKind::AutostashRefused, id, Some("s"), Some("feature/x")));
        j.kept_mut(id).unwrap().reason = KeptReason::Conflicts { files: 2, binary: false };
        assert_eq!((j.state(None).banners[0].kind, j.state(None).banners[0].files), (BannerKind::AutostashConflicts, 2));
        j.kept_mut(id).unwrap().reason = KeptReason::Pending;
        assert!(j.state(None).banners.is_empty(), "a running write's stash has no banner");
    }

    /// Review I2: undo, redo, the caps, expiry and drop_through never take a kept stash away.
    #[test]
    fn stack_maintenance_never_drops_a_kept_stash() {
        let mut j = Journal::empty("/r");
        let first = record(&mut j, "checkout x", 1);
        j.keep(kept("s", KeptReason::Refused));
        j.shift(first, true);
        record(&mut j, "new op", 2); // clears redo
        for n in 0..60 {
            record(&mut j, &format!("op {n}"), 3);
        }
        let last = j.undo_top().unwrap().id;
        j.drop_through(last);
        j.expire(SNAPSHOT_TTL_MS * 10);
        assert_eq!(j.state(None).banners.len(), 1);
    }

    /// Review I5: a stash whose write died before restoring it raises the recovery banner.
    #[test]
    fn an_unrestored_stash_at_load_becomes_a_recovery_banner() {
        let mut j = Journal::empty("/r");
        let mut k = kept("s", KeptReason::Pending);
        k.owner = Some(Owner { pid: 1, start: 2, instance: 3 });
        let id = j.keep(k);
        j.recover_unless(|_| true);
        assert!(j.state(None).banners.is_empty(), "its owner still runs");
        j.recover_unless(|_| false);
        let b = &j.state(None).banners[0];
        assert_eq!((b.kind, b.entry, b.stash.as_deref()), (BannerKind::Recovery, id, Some("s")));
    }

    /// Review Focus 4.
    #[test]
    fn a_corrupt_or_newer_journal_is_set_aside() {
        let data = tempfile::tempdir().unwrap();
        let s = store(data.path());
        s.update(|j| record(j, "one", 1)).unwrap();
        std::fs::write(s.path(), b"{ not json").unwrap();
        assert!(s.load().unwrap().undo.is_empty());
        let aside = |tag: &str| std::fs::read_dir(data.path().join("journal")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(tag));
        assert!(aside(".corrupt-"), "the unreadable file is kept, renamed");
        std::fs::write(s.path(), br#"{"version": 99, "worktree": "/r"}"#).unwrap();
        s.update(|j| record(j, "two", 2)).unwrap();
        assert!(aside(".v99-"), "a newer GitBolt's journal is never overwritten");
        assert_eq!(s.load().unwrap().undo.len(), 1);
    }

    /// Two instances on one file (GITBOLT_MULTI_INSTANCE) never lose each other's entries.
    #[test]
    fn concurrent_updates_never_interleave() {
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().to_path_buf();
        let threads: Vec<_> = (0..2)
            .map(|t| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for n in 0..20 {
                        store(&dir).update(|j| record(j, &format!("t{t} {n}"), n)).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(store(&dir).load().unwrap().undo.len(), 40);
    }

    #[test]
    fn an_entry_shifts_between_the_stacks() {
        let mut j = Journal::empty("/r");
        let id = record(&mut j, "one", 1);
        j.shift(id, true);
        assert!(j.undo.is_empty());
        assert_eq!(j.redo_top().unwrap().id, id);
        j.shift(id, false);
        assert_eq!(j.undo_top().unwrap().id, id);
        assert!(j.redo.is_empty(), "a redo doesn't clear what's left to redo, but this was the only one");
    }

    #[test]
    fn journal_changed_serializes() {
        let ev = crate::events::AppEvent::JournalChanged { repo: 1, worktree: "/r".into(), state: Journal::empty("/r").state(None) };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "journalChanged");
        assert_eq!(v["state"]["undoBlocked"], "Nothing to undo");
    }
}
