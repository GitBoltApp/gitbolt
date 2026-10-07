//! What the hub remembers per project (profile, host, project path), between polls and across
//! restarts, so a poll asks the forge only what may have changed and a relaunch shows the last
//! list and badges at once:
//! - per remote-tracking ref, what its lookup in any state found (`RefLookup`), and which refs
//!   the open list covered last time (a ref that leaves it was just merged or closed: it's asked
//!   again at once);
//! - the project, the last MR/PR list per filter, and the badges' open list;
//! - the forge's validators for those lists (`StoredResponse`: ETag and body), so the first poll
//!   after a relaunch revalidates with `If-None-Match` instead of reading everything again.
//!
//! On disk: `<data dir>/forge-cache/<profile>/<host>/<project path>.json` (names
//! percent-encoded), versioned, at most `MAX_FILE_BYTES`, ignored (and deleted) after `TTL_SECS`.
//! Never a token: the forge's own data, in the user's own data dir. Removing the account deletes
//! its host's directory.

use crate::forge::{AccountKey, ForgeMr, ForgeProject, MrState, PeopleLimits, StoredResponse};
use crate::journal::Clock;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A lookup that found no MR/PR is asked again after this long (a branch whose MR/PR was opened
/// and merged between two polls, or while GitBolt was closed).
pub const LOOKUP_NONE_SECS: i64 = 3600;
/// A merged or closed MR/PR doesn't change: kept this long (a week).
pub const LOOKUP_DONE_SECS: i64 = 7 * 24 * 3600;
/// The file format; another version is ignored.
pub const CACHE_VERSION: u32 = 1;
/// A file saved longer ago than this is ignored and deleted.
pub const TTL_SECS: i64 = 7 * 24 * 3600;
/// An unchanged file is written again (its time renewed) once it's this old.
pub const REWRITE_SECS: i64 = 24 * 3600;
/// One project's file at most: the stored responses go first, then the lists but All's.
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// One ref's lookup in any state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLookup {
    /// The ref's tips when it was asked (`BadgeRefs.tips`): a ref that moved is asked again.
    pub tips: Vec<String>,
    pub mr: Option<ForgeMr>,
    /// Unix seconds.
    pub at: i64,
}

impl RefLookup {
    /// Still good for a ref at `tips`, at `now`. An open one never is (the open list badges
    /// open ones; one it missed may change any time).
    pub fn fresh(&self, tips: &[String], now: i64) -> bool {
        let ttl = match self.mr.as_ref().map(|m| m.state) {
            None => LOOKUP_NONE_SECS,
            Some(MrState::Merged | MrState::Closed) => LOOKUP_DONE_SECS,
            Some(MrState::Open | MrState::Draft | MrState::Merging) => return false,
        };
        self.tips == tips && now.saturating_sub(self.at) < ttl
    }
}

/// A list as it was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredList {
    pub mrs: Vec<ForgeMr>,
    /// Unix seconds.
    pub fetched_at: i64,
}

/// One project's remembered state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectCache {
    pub version: u32,
    /// Unix seconds.
    pub saved_at: i64,
    pub project: Option<ForgeProject>,
    /// The sidebar list by filter (`all`, `mine`, `reviewRequested`).
    pub lists: BTreeMap<String, StoredList>,
    /// The badges' open list (every page, no pipelines).
    pub open: Option<StoredList>,
    pub lookups: BTreeMap<String, RefLookup>,
    /// The refs the last open list badged.
    pub open_refs: BTreeSet<String>,
    /// The lists' validators and bodies (`ForgeProvider::export_responses`).
    pub responses: Vec<StoredResponse>,
    /// How many reviewers and assignees its MRs may have, and when that was read (unix
    /// seconds): asked again after `PEOPLE_LIMITS_SECS`.
    pub people_limits: Option<(PeopleLimits, i64)>,
}

/// The people limits are the namespace's tier's: asked again after a day.
pub const PEOPLE_LIMITS_SECS: i64 = 24 * 3600;

/// (profile, host, project path).
pub type CacheKey = (String, String, String);

pub fn cache_key(account: &AccountKey, project_path: &str) -> CacheKey {
    (account.profile.clone(), account.host.clone(), project_path.to_string())
}

/// A file or directory name for any text: RFC 3986's unreserved characters stay, the rest are
/// `%XX` (so `group/sub/project` is one name); a name of dots only is all `%2E` (never `..`).
fn file_name(s: &str) -> String {
    if s.bytes().all(|b| b == b'.') {
        return if s.is_empty() { "%".into() } else { "%2E".repeat(s.len()) };
    }
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'~' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn hash_of(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

pub struct ForgeCache {
    clock: Clock,
    /// `<data dir>/forge-cache`; `None`: memory only.
    dir: Mutex<Option<PathBuf>>,
    projects: Mutex<HashMap<CacheKey, ProjectCache>>,
    /// What each file holds now (its JSON's hash, without the time) and when it was written: an
    /// unchanged state isn't written again, unless the file is a day old (it'd age out in use).
    written: Mutex<HashMap<CacheKey, (u64, i64)>>,
}

impl ForgeCache {
    pub fn new(clock: Clock) -> Self {
        Self { clock, dir: Mutex::default(), projects: Mutex::default(), written: Mutex::default() }
    }

    fn now(&self) -> i64 {
        (self.clock)() / 1000
    }

    /// Keeps the cache in `dir` from now on (what's in memory stays); files past the TTL go.
    pub fn set_dir(&self, dir: PathBuf) {
        *self.dir.lock().expect("forge cache poisoned") = Some(dir.clone());
        let now = self.now();
        // Best effort, off the caller's thread: a week-old file is never read anyway.
        std::thread::spawn(move || prune(&dir, now));
    }

    pub fn dir(&self) -> Option<PathBuf> {
        self.dir.lock().expect("forge cache poisoned").clone()
    }

    fn file(&self, key: &CacheKey) -> Option<PathBuf> {
        Some(self.dir()?.join(file_name(&key.0)).join(file_name(&key.1)).join(format!("{}.json", file_name(&key.2))))
    }

    fn load(&self, key: &CacheKey) -> ProjectCache {
        let Some(path) = self.file(key) else { return ProjectCache::default() };
        let Ok(bytes) = std::fs::read(&path) else { return ProjectCache::default() };
        match serde_json::from_slice::<ProjectCache>(&bytes) {
            Ok(c) if c.version == CACHE_VERSION && self.now().saturating_sub(c.saved_at) < TTL_SECS => {
                let timeless = ProjectCache { saved_at: 0, ..c.clone() };
                let hash = serde_json::to_vec(&timeless).map_or(0, |b| hash_of(&b));
                self.written.lock().expect("forge cache poisoned").insert(key.clone(), (hash, c.saved_at));
                c
            }
            _ => {
                let _ = std::fs::remove_file(&path);
                ProjectCache::default()
            }
        }
    }

    /// Reads (or changes) one project's state; the first touch this run reads its file.
    pub fn with<T>(&self, key: &CacheKey, f: impl FnOnce(&mut ProjectCache) -> T) -> T {
        let loaded = !self.projects.lock().expect("forge cache poisoned").contains_key(key);
        let fresh = if loaded { Some(self.load(key)) } else { None };
        let mut all = self.projects.lock().expect("forge cache poisoned");
        let c = all.entry(key.clone()).or_insert_with(|| fresh.unwrap_or_default());
        f(c)
    }

    /// Writes one project's state to its file, when it changed since the last write. Best
    /// effort: a cache that can't be written only costs the next launch its head start.
    pub fn save(&self, key: &CacheKey) {
        let Some(path) = self.file(key) else { return };
        let now = self.now();
        let Some(mut c) = self.projects.lock().expect("forge cache poisoned").get(key).cloned() else { return };
        c.version = CACHE_VERSION;
        c.saved_at = 0;
        let Ok(mut bytes) = serde_json::to_vec(&c) else { return };
        // The time alone changing isn't a change.
        let hash = hash_of(&bytes);
        if self.written.lock().expect("forge cache poisoned").get(key).is_some_and(|(h, at)| *h == hash && now.saturating_sub(*at) < REWRITE_SECS) {
            return;
        }
        c.saved_at = now;
        shrink(&mut c);
        bytes = match serde_json::to_vec(&c) {
            Ok(b) => b,
            Err(_) => return,
        };
        let write = || -> std::io::Result<()> {
            let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
            std::fs::create_dir_all(dir)?;
            let tmp = dir.join(format!(".{}.tmp", std::process::id()));
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, &path)
        };
        match write() {
            Ok(()) => {
                self.written.lock().expect("forge cache poisoned").insert(key.clone(), (hash, now));
            }
            Err(e) => tracing::debug!("forge cache: couldn't write {}: {e}", path.display()),
        }
    }

    /// After a write to the forge: the lists may be out of date (the next poll reads them again;
    /// a relaunch meanwhile doesn't show them as they were).
    pub fn forget_lists(&self, key: &CacheKey) {
        self.with(key, |c| {
            c.lists.clear();
            c.open = None;
        });
        self.save(key);
    }

    /// Forgets an account's projects (it was removed or replaced), on disk too.
    pub fn drop_account(&self, account: &AccountKey) {
        let mine = |(p, h, _): &CacheKey| p == &account.profile && h == &account.host;
        self.projects.lock().expect("forge cache poisoned").retain(|k, _| !mine(k));
        self.written.lock().expect("forge cache poisoned").retain(|k, _| !mine(k));
        if let Some(dir) = self.dir() {
            let _ = std::fs::remove_dir_all(dir.join(file_name(&account.profile)).join(file_name(&account.host)));
        }
    }

    /// Everything, on disk too (the harness's reset).
    pub fn clear(&self) {
        self.projects.lock().expect("forge cache poisoned").clear();
        self.written.lock().expect("forge cache poisoned").clear();
        if let Some(dir) = self.dir() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Under `MAX_FILE_BYTES`: the stored responses go first (largest first), then the lists but All's.
fn shrink(c: &mut ProjectCache) {
    let size = |c: &ProjectCache| serde_json::to_vec(c).map_or(0, |b| b.len());
    c.responses.sort_by_key(|r| std::cmp::Reverse(r.body.len()));
    while size(c) > MAX_FILE_BYTES && !c.responses.is_empty() {
        c.responses.remove(0);
    }
    if size(c) > MAX_FILE_BYTES {
        c.lists.retain(|f, _| f == "all");
    }
    if size(c) > MAX_FILE_BYTES {
        c.lists.clear();
        c.open = None;
    }
}

/// Deletes the files saved more than `TTL_SECS` before `now`.
fn prune(dir: &Path, now: i64) {
    let Ok(profiles) = std::fs::read_dir(dir) else { return };
    for p in profiles.flatten() {
        let Ok(hosts) = std::fs::read_dir(p.path()) else { continue };
        for h in hosts.flatten() {
            let Ok(files) = std::fs::read_dir(h.path()) else { continue };
            for f in files.flatten() {
                let stale = std::fs::read(f.path()).ok().and_then(|b| serde_json::from_slice::<ProjectCache>(&b).ok()).is_none_or(|c| c.version != CACHE_VERSION || now.saturating_sub(c.saved_at) >= TTL_SECS);
                if stale {
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn key() -> CacheKey {
        ("default".into(), "gitlab.example.com".into(), "group/sub/project".into())
    }

    fn cache(dir: &Path, now: &Arc<AtomicI64>) -> ForgeCache {
        let n = now.clone();
        let c = ForgeCache::new(Arc::new(move || n.load(Ordering::SeqCst) * 1000));
        *c.dir.lock().unwrap() = Some(dir.to_path_buf());
        c
    }

    #[test]
    fn a_saved_project_comes_back_after_a_restart_until_its_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicI64::new(1_000_000));
        let a = cache(tmp.path(), &now);
        a.with(&key(), |c| c.lists.insert("all".into(), StoredList { mrs: vec![], fetched_at: 5 }));
        a.save(&key());
        let file = tmp.path().join("default").join("gitlab.example.com").join("group%2Fsub%2Fproject.json");
        assert!(file.is_file(), "one file per project, its path one name");
        let b = cache(tmp.path(), &now);
        assert_eq!(b.with(&key(), |c| (c.lists["all"].fetched_at, c.saved_at)), (5, 1_000_000));
        now.store(1_000_000 + TTL_SECS, Ordering::SeqCst);
        let c = cache(tmp.path(), &now);
        assert!(c.with(&key(), |c| c.lists.is_empty()), "a week old: ignored");
        assert!(!file.exists(), "and deleted");
    }

    #[test]
    fn an_unchanged_state_isnt_written_again_and_removing_the_account_deletes_its_files() {
        let tmp = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicI64::new(1_000_000));
        let a = cache(tmp.path(), &now);
        a.with(&key(), |c| c.open_refs.insert("refs/remotes/origin/dev".into()));
        a.save(&key());
        let file = tmp.path().join("default").join("gitlab.example.com").join("group%2Fsub%2Fproject.json");
        let first = std::fs::metadata(&file).unwrap().modified().unwrap();
        now.store(1_000_100, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(20));
        a.save(&key());
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), first);
        a.drop_account(&AccountKey { profile: "default".into(), host: "gitlab.example.com".into() });
        assert!(!tmp.path().join("default").join("gitlab.example.com").exists());
    }

    #[test]
    fn a_file_too_big_drops_its_stored_responses_first() {
        let mut c = ProjectCache { lists: BTreeMap::from([("all".to_string(), StoredList { mrs: vec![], fetched_at: 1 })]), ..Default::default() };
        c.responses = (0..3).map(|i| StoredResponse { key: format!("k{i}"), etag: "e".into(), body: "x".repeat(MAX_FILE_BYTES / 2), next_page: None, poll_interval_secs: None }).collect();
        shrink(&mut c);
        assert!(serde_json::to_vec(&c).unwrap().len() <= MAX_FILE_BYTES);
        assert_eq!((c.responses.len(), c.lists.len()), (1, 1));
    }

    #[test]
    fn names_never_escape_the_directory() {
        assert_eq!(file_name(".."), "%2E%2E");
        assert_eq!(file_name("a/b"), "a%2Fb");
        assert_eq!(file_name("h:8443"), "h%3A8443");
    }
}
