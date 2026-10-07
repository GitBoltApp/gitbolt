//! Find in the graph (spec §8.7): message and SHA over the loaded window (in memory), path
//! search through a lazily built path index (each commit's tree diffed against its first parent,
//! rename detection off), hashes outside the window (`locateCommit`), and "Search older history".
//!
//! Every `graph` request replaces the repo's `FindSnapshot` (`RepoHandle::snapshot`). A new
//! snapshot's path index is built on its first path query, reusing the previous index's entries
//! for the commits both windows hold: a refresh or a deeper window diffs only the new commits.

use crate::api::Api;
use crate::error::{GbError, GbErrorKind};
use crate::git::GitInvocation;
use crate::refs::read_refs;
use crate::snapshot::graph_tips;
use crate::walk::{walk_by_date, WalkOptions};
use crate::worktree::list_worktrees;
use gix::ObjectId;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;
use ts_rs::TS;

/// How deep `locateCommit` walks for a hash outside the window (spec §8.7).
pub const LOCATE_LIMIT: usize = 10_000;
/// The most "Search older history" lists.
const HISTORY_MAX: usize = 200;
/// The shortest query the path index answers (spec §8.7).
pub const PATH_MIN_CHARS: usize = 2;
/// The shortest hex query matched as a SHA prefix.
const SHA_MIN_CHARS: usize = 4;
/// The path index build's object cache.
const OBJECT_CACHE_BYTES: usize = 32 * 1024 * 1024;

/// One `graph` window's searchable state: its commits in walk order, each one's lowercased full
/// message, and the path index once a path query has asked for it.
pub struct FindSnapshot {
    pub ids: Arc<[ObjectId]>,
    pub texts: Vec<String>,
    paths: OnceCell<Arc<PathIndex>>,
    /// The previous window's index (and its commits), reused by this one's build. Kept (cloned,
    /// not taken) while that build runs, so a refresh meanwhile seeds its own snapshot from it
    /// too; dropped once this snapshot's index is built (a successor then seeds from that).
    seed: Mutex<Option<Seed>>,
}

#[derive(Clone)]
struct Seed {
    ids: Arc<[ObjectId]>,
    index: Arc<PathIndex>,
}

impl FindSnapshot {
    /// `pairs`: each walked commit and its lowercased message (`build_graph_with_text`).
    /// `prev`: the snapshot this one replaces, whose path index (built, or still seeded) it reuses.
    pub fn new(pairs: Vec<(ObjectId, String)>, prev: Option<&FindSnapshot>) -> Self {
        let (ids, texts): (Vec<ObjectId>, Vec<String>) = pairs.into_iter().unzip();
        let seed = prev.and_then(|p| match p.paths.get() {
            Some(index) => Some(Seed { ids: p.ids.clone(), index: index.clone() }),
            None => p.seed.lock().expect("seed poisoned").clone(),
        });
        Self { ids: ids.into(), texts, paths: OnceCell::new(), seed: Mutex::new(seed) }
    }

    /// The path index, if a path query has built it.
    pub fn path_index(&self) -> Option<&Arc<PathIndex>> {
        self.paths.get()
    }

    /// What this snapshot's index build starts from: a copy of the seed, which stays in place.
    fn build_seed(&self) -> Option<Seed> {
        self.seed.lock().expect("seed poisoned").clone()
    }
}

/// Every loaded commit's changed paths (against its first parent; a root commit: all its files),
/// lowercased and interned: each path is stored once, and commits hold indexes into `paths`.
pub struct PathIndex {
    /// Each path once: `intern` holds the same allocations.
    paths: Vec<Arc<str>>,
    intern: HashMap<Arc<str>, u32>,
    /// Aligned with the snapshot's `ids`.
    by_commit: Vec<Vec<u32>>,
    /// How many commits this build diffed (the rest came from the seed).
    diffed: usize,
}

impl PathIndex {
    /// Indexes `ids`, taking the entries of the commits `seed` already holds from it.
    fn build(repo: &gix::Repository, ids: &[ObjectId], seed: Option<&Seed>) -> Self {
        // Consecutive commits share most trees (a commit's parent tree is usually the next
        // commit's own): an object cache saves re-reading and re-inflating them.
        let mut repo = repo.clone();
        repo.object_cache_size_if_unset(OBJECT_CACHE_BYTES);
        let repo = &repo;
        let mut paths = seed.map(|s| s.index.paths.clone()).unwrap_or_default();
        let mut intern = seed.map(|s| s.index.intern.clone()).unwrap_or_default();
        let prev: HashMap<ObjectId, &Vec<u32>> = seed.map(|s| s.ids.iter().copied().zip(&s.index.by_commit).collect()).unwrap_or_default();
        let mut state = gix::diff::tree::State::default();
        let mut diffed = 0;
        let by_commit = ids
            .iter()
            .map(|id| {
                if let Some(entry) = prev.get(id) {
                    return (*entry).clone();
                }
                diffed += 1;
                // A fresh recorder per commit: one carries its path stack over from the last diff.
                let mut recorder = gix::diff::tree::Recorder::default();
                if let Err(e) = changed_paths(repo, *id, &mut state, &mut recorder) {
                    tracing::warn!("path index: no diff for {id}: {e}");
                }
                let mut mine: Vec<u32> = recorder
                    .records
                    .iter()
                    .filter_map(|ch| {
                        use gix::diff::tree::recorder::Change as C;
                        let (path, mode) = match ch {
                            C::Addition { path, entry_mode, .. } | C::Deletion { path, entry_mode, .. } | C::Modification { path, entry_mode, .. } => (path, entry_mode),
                        };
                        (!mode.is_tree()).then(|| {
                            let p = String::from_utf8_lossy(path).to_lowercase();
                            match intern.get(p.as_str()) {
                                Some(&i) => i,
                                None => {
                                    let i = paths.len() as u32;
                                    let p: Arc<str> = p.into();
                                    paths.push(p.clone());
                                    intern.insert(p, i);
                                    i
                                }
                            }
                        })
                    })
                    .collect();
                mine.sort_unstable();
                mine.dedup();
                mine
            })
            .collect();
        Self { paths, intern, by_commit, diffed }
    }

    /// Positions (in the snapshot's commits) whose changed paths contain `q_lower`.
    pub fn matching(&self, q_lower: &str) -> Vec<usize> {
        let hit: Vec<bool> = self.paths.iter().map(|p| p.contains(q_lower)).collect();
        self.by_commit.iter().enumerate().filter(|(_, ps)| ps.iter().any(|&i| hit[i as usize])).map(|(c, _)| c).collect()
    }

    /// How many commits this index's build diffed itself.
    pub fn diffed(&self) -> usize {
        self.diffed
    }
}

/// Records `id`'s changes against its first parent (the empty tree for a root commit) into
/// `recorder`, rename detection off.
fn changed_paths(repo: &gix::Repository, id: ObjectId, state: &mut gix::diff::tree::State, recorder: &mut gix::diff::tree::Recorder) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let commit = repo.find_commit(id)?;
    let tree = repo.find_tree(commit.tree_id()?)?;
    let parent = match commit.parent_ids().next() {
        Some(p) => repo.find_tree(repo.find_commit(p.detach())?.tree_id()?)?,
        None => repo.empty_tree(),
    };
    let kind = id.kind();
    gix::diff::tree(
        gix::objs::TreeRefIter::from_bytes(&parent.data, kind),
        gix::objs::TreeRefIter::from_bytes(&tree.data, kind),
        state,
        &repo.objects,
        recorder,
    )?;
    Ok(())
}

/// Whether `oid`'s hex form starts with `q` (lowercase hex digits), without formatting it.
fn hex_prefix(oid: &ObjectId, q: &[u8]) -> bool {
    let bytes = oid.as_bytes();
    q.len() <= bytes.len() * 2
        && q.iter().enumerate().all(|(i, &c)| {
            let b = bytes[i / 2];
            let nibble = if i % 2 == 0 { b >> 4 } else { b & 0xf };
            char::from_digit(u32::from(nibble), 16) == Some(c as char)
        })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocateResult {
    pub found: bool,
    /// The commit window that includes the commit; `null` when it's already loaded (or not found).
    pub limit: Option<u32>,
}

/// A commit outside the loaded window that matches "Search older history".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryHit {
    pub id: String,
    /// Committer time, seconds since the epoch.
    #[ts(type = "number")]
    pub time: i64,
    pub author: String,
    pub summary: String,
}

/// `q` as a literal inside a pathspec glob: wildmatch's special characters backslash-escaped.
fn glob_escape(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for c in q.chars() {
        if matches!(c, '*' | '?' | '[' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

const LOG_FORMAT: &str = "--format=%H%x00%ct%x00%an%x00%s";

fn parse_log(out: &[u8]) -> Vec<HistoryHit> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\0');
            Some(HistoryHit { id: f.next()?.to_string(), time: f.next()?.parse().ok()?, author: f.next()?.to_string(), summary: f.next().unwrap_or("").to_string() })
        })
        .collect()
}

impl Api {
    /// The repo's current find snapshot (its last `graph` window).
    pub(crate) fn find_snapshot(&self, id: u32) -> Result<Arc<FindSnapshot>, GbError> {
        self.handle(id)?
            .snapshot
            .lock()
            .expect("snapshot poisoned")
            .clone()
            .ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "load the graph before searching it"))
    }

    /// Commits in the window whose message contains `query` (case-insensitive), or, for a hex
    /// query of at least 4 characters, whose id starts with it. Graph (walk) order.
    pub(crate) fn find_text(&self, id: u32, query: &str) -> Result<Vec<String>, GbError> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let s = self.find_snapshot(id)?;
        let hex = q.len() >= SHA_MIN_CHARS && q.bytes().all(|b| b.is_ascii_hexdigit());
        Ok(s.ids
            .iter()
            .zip(&s.texts)
            .filter(|(oid, text)| text.contains(&q) || (hex && hex_prefix(oid, q.as_bytes())))
            .map(|(oid, _)| oid.to_string())
            .collect())
    }

    /// Commits in the window that touched a path containing `query` (case-insensitive); `[]` under
    /// 2 characters. The first call on a window builds its path index, on the blocking pool.
    pub(crate) async fn find_paths(&self, id: u32, query: &str) -> Result<Vec<String>, GbError> {
        let q = query.trim().to_lowercase();
        if q.chars().count() < PATH_MIN_CHARS {
            return Ok(vec![]);
        }
        let s = self.find_snapshot(id)?;
        let repo = self.handle(id)?.repo.clone();
        let index = s
            .paths
            .get_or_try_init(|| {
                let ids = s.ids.clone();
                let seed = s.build_seed();
                async move {
                    tokio::task::spawn_blocking(move || Arc::new(PathIndex::build(&repo.to_thread_local(), &ids, seed.as_ref())))
                        .await
                        .map_err(|e| GbError::other(format!("path index failed: {e}")))
                }
            })
            .await?;
        // Built: successors seed from `paths` now, so the previous index can go.
        s.seed.lock().expect("seed poisoned").take();
        Ok(index.matching(&q).into_iter().map(|i| s.ids[i].to_string()).collect())
    }

    /// Where `sha` is: `limit: null` if the window holds it, else the smallest window (at least
    /// the current one) that would, if that's within `LOCATE_LIMIT` commits; `found: false`
    /// beyond. Not a commit at all: `NotFound`.
    pub(crate) async fn locate_commit(&self, id: u32, sha: &str) -> Result<LocateResult, GbError> {
        let s = self.find_snapshot(id)?;
        let h = self.handle(id)?;
        let worktrees = list_worktrees(&h.workdir).await?;
        let sha = sha.trim().to_string();
        let repo = h.repo.clone();
        tokio::task::spawn_blocking(move || {
            let repo = repo.to_thread_local();
            let not_found = || GbError::new(GbErrorKind::NotFound, format!("No commit {sha}"));
            let target = repo.rev_parse_single(format!("{sha}^{{commit}}").as_str()).map_err(|_| not_found())?.detach();
            if s.ids.contains(&target) {
                return Ok(LocateResult { found: true, limit: None });
            }
            let refs = read_refs(&repo)?;
            let stash_ids: HashSet<ObjectId> = refs.stashes.iter().map(|x| x.id).collect();
            let tips = graph_tips(&refs, &worktrees);
            // The order the graph's walk collects commits in: a window of `i + 1` holds commit `i`.
            let (collected, _) = walk_by_date(&repo, &tips, &WalkOptions { limit: LOCATE_LIMIT, first_parent_only: stash_ids })?;
            Ok(match collected.iter().position(|c| c.id == target) {
                Some(i) => LocateResult { found: true, limit: Some((i + 1).max(s.ids.len()) as u32) },
                None => LocateResult { found: false, limit: None },
            })
        })
        .await
        .map_err(|e| GbError::other(format!("locate failed: {e}")))?
    }

    /// "Search older history" (spec §8.7): commits outside the window whose message contains
    /// `query` (fixed string, case-insensitive) or that touched a path containing it, newest first.
    pub(crate) async fn search_history(&self, id: u32, query: &str) -> Result<Vec<HistoryHit>, GbError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let h = self.handle(id)?;
        let s = self.find_snapshot(id)?;
        // The graph's own history (spec §8.2): branches, remotes, tags, HEAD, every worktree's
        // HEAD and the stashes, never `--all` (notes, `refs/original`, other namespaces). A stash's
        // index and untracked-files commits aren't graph rows (only its first parent is followed),
        // so they're dropped from the results.
        let worktrees = list_worktrees(&h.workdir).await?;
        let repo = h.repo.clone();
        let (extra_tips, stash_parts) = tokio::task::spawn_blocking(move || -> Result<(Vec<String>, HashSet<ObjectId>), GbError> {
            let repo = repo.to_thread_local();
            let refs = read_refs(&repo)?;
            // HEAD by id, not by name: an unborn HEAD would make `log HEAD` fail.
            let mut tips: Vec<String> = refs.head.target.into_iter().chain(worktrees.iter().filter_map(|w| w.head)).map(|o| o.to_string()).collect();
            let mut parts = HashSet::new();
            for st in &refs.stashes {
                tips.push(st.id.to_string());
                if let Ok(c) = repo.find_commit(st.id) {
                    parts.extend(c.parent_ids().skip(1).map(|p| p.detach()));
                }
            }
            Ok((tips, parts))
        })
        .await
        .map_err(|e| GbError::other(format!("search failed: {e}")))??;
        // Up to the whole window can match too: ask for enough to still have HISTORY_MAX beyond it.
        let max = format!("-n{}", HISTORY_MAX + s.ids.len());
        let grep = format!("--grep={q}");
        let glob = format!(":(icase)*{}*", glob_escape(q));
        let mut common: Vec<&str> = vec!["log", "--no-show-signature", LOG_FORMAT, max.as_str(), "--branches", "--remotes", "--tags"];
        common.extend(extra_tips.iter().map(String::as_str));
        let by_msg = self.cli.run(GitInvocation::new(&h.workdir, common.iter().copied().chain(["-i", "-F", grep.as_str(), "--"])));
        let by_path = self.cli.run(GitInvocation::new(&h.workdir, common.iter().copied().chain(["--", glob.as_str()])));
        let (a, b) = tokio::join!(by_msg, by_path);
        let loaded: HashSet<ObjectId> = s.ids.iter().copied().collect();
        let skip = |hit: &HistoryHit| ObjectId::from_hex(hit.id.as_bytes()).is_ok_and(|o| loaded.contains(&o) || stash_parts.contains(&o));
        let mut seen = HashSet::new();
        let mut hits: Vec<HistoryHit> = parse_log(&a?.stdout)
            .into_iter()
            .chain(parse_log(&b?.stdout))
            .filter(|hit| !skip(hit) && seen.insert(hit.id.clone()))
            .collect();
        hits.sort_by_key(|x| std::cmp::Reverse(x.time));
        hits.truncate(HISTORY_MAX);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use crate::api::{Api, Request};
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn api() -> Api {
        Api::new(crate::git::GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), None)
    }

    async fn call(api: &Api, v: serde_json::Value) -> Result<serde_json::Value, crate::error::GbError> {
        api.dispatch(serde_json::from_value::<Request>(v).unwrap()).await
    }

    async fn graph(api: &Api, id: u32, limit: Option<u32>) {
        call(api, serde_json::json!({"method": "graph", "params": {"repo": id, "limit": limit}})).await.unwrap();
    }

    async fn opened(api: &Api, r: &TestRepo, limit: Option<u32>) -> u32 {
        let id = call(api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap() as u32;
        graph(api, id, limit).await;
        id
    }

    /// The commit whose subject is exactly `subject` (a grep would also match the basic
    /// fixture's stash commit "index on main: … Merge branch 'feature/login'").
    fn sha_of(r: &TestRepo, subject: &str) -> String {
        let log = r.git(&["log", "--all", "--format=%H %s"]);
        log.lines().find_map(|l| l.split_once(' ').filter(|(_, s)| *s == subject).map(|(h, _)| h.to_string())).unwrap()
    }

    #[tokio::test]
    async fn finds_by_message_and_sha_prefix() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = opened(&api, &r, None).await;
        let hits = api.find_text(id, "LOGIN").unwrap();
        assert_eq!(hits.len(), 3, "Login form, Login validation, Merge branch 'feature/login'");
        let fix = sha_of(&r, "Fix typo");
        assert_eq!(api.find_text(id, &fix[..6]).unwrap(), vec![fix.clone()]);
        assert_eq!(api.find_text(id, &fix[..6].to_uppercase()).unwrap(), vec![fix.clone()], "hex is case-insensitive");
        assert!(api.find_text(id, &fix[..3]).unwrap().is_empty(), "under 4 hex characters: no SHA match");
        assert!(api.find_text(id, "   ").unwrap().is_empty());
    }

    #[tokio::test]
    async fn find_before_any_graph_is_invalid_input() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = call(&api, serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap() as u32;
        assert_eq!(api.find_text(id, "login").unwrap_err().kind, crate::error::GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn the_requests_dispatch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = opened(&api, &r, None).await;
        let v = call(&api, serde_json::json!({"method": "findText", "params": {"repo": id, "query": "typo"}})).await.unwrap();
        assert_eq!(v, serde_json::json!([sha_of(&r, "Fix typo")]));
        let v = call(&api, serde_json::json!({"method": "findPaths", "params": {"repo": id, "query": "f"}})).await.unwrap();
        assert_eq!(v, serde_json::json!([]));
        let v = call(&api, serde_json::json!({"method": "locateCommit", "params": {"repo": id, "sha": sha_of(&r, "Fix typo")}})).await.unwrap();
        assert_eq!(v, serde_json::json!({"found": true, "limit": null}));
        let v = call(&api, serde_json::json!({"method": "searchHistory", "params": {"repo": id, "query": "typo"}})).await.unwrap();
        assert_eq!(v, serde_json::json!([]), "everything is loaded");
    }

    #[tokio::test]
    async fn finds_by_path_with_a_lazily_built_index() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = opened(&api, &r, None).await;
        let mut hits = api.find_paths(id, "FILE_3").await.unwrap();
        hits.sort();
        let mut want = vec![sha_of(&r, "Login validation"), sha_of(&r, "Merge branch 'feature/login'")];
        want.sort();
        assert_eq!(hits, want, "the merge touches file_3 against its first parent");
        assert!(api.find_paths(id, "f").await.unwrap().is_empty(), "one character: no path search");
    }

    #[tokio::test]
    async fn nested_paths_are_indexed_whole_and_per_commit() {
        let r = TestRepo::new();
        r.commit("root");
        r.write("src/deep/a.txt", "a\n");
        let a = r.commit_all_as("add a", "A", "a@example.com");
        r.write("src/b.txt", "b\n");
        let b = r.commit_all_as("add b", "A", "a@example.com");
        r.write("c.txt", "c\n");
        let c = r.commit_all_as("add c", "A", "a@example.com");
        let api = api();
        let id = opened(&api, &r, None).await;
        let mut src = api.find_paths(id, "src/").await.unwrap();
        src.sort();
        let mut want = vec![a.clone(), b.clone()];
        want.sort();
        assert_eq!(src, want);
        assert_eq!(api.find_paths(id, "src/deep/a.txt").await.unwrap(), vec![a]);
        assert_eq!(api.find_paths(id, "c.txt").await.unwrap(), vec![c], "a path is never prefixed by the previous diff's directories");
        assert!(api.find_paths(id, "deep/").await.unwrap().len() == 1, "directories themselves aren't entries, but their files' paths contain them");
    }

    #[tokio::test]
    async fn a_new_graph_extends_the_path_index_instead_of_rebuilding_it() {
        let r = TestRepo::new();
        for i in 1..=3 {
            r.commit(&format!("c{i}"));
        }
        let api = api();
        let id = opened(&api, &r, None).await;
        assert_eq!(api.find_paths(id, "file_").await.unwrap().len(), 3);
        assert_eq!(api.find_snapshot(id).unwrap().path_index().unwrap().diffed(), 3);
        r.commit("c4");
        graph(&api, id, None).await;
        assert_eq!(api.find_paths(id, "file_").await.unwrap().len(), 4);
        assert_eq!(api.find_snapshot(id).unwrap().path_index().unwrap().diffed(), 1, "only the new commit is diffed");
        assert_eq!(api.find_paths(id, "file_3").await.unwrap(), vec![sha_of(&r, "c4")]);
    }

    #[tokio::test]
    async fn a_refresh_during_an_index_build_still_seeds_from_the_previous_index() {
        let r = TestRepo::new();
        for i in 1..=3 {
            r.commit(&format!("c{i}"));
        }
        let api = api();
        let id = opened(&api, &r, None).await;
        api.find_paths(id, "file_").await.unwrap();
        r.commit("c4");
        graph(&api, id, None).await;
        // A build of this window starts: it copies its seed, leaving it in place …
        let building = api.find_snapshot(id).unwrap();
        assert!(building.build_seed().is_some());
        // … so a refresh before it finishes seeds the next window from it as well.
        r.commit("c5");
        graph(&api, id, None).await;
        assert!(api.find_snapshot(id).unwrap().build_seed().is_some(), "the in-flight build kept its seed");
        assert_eq!(api.find_paths(id, "file_").await.unwrap().len(), 5);
        assert_eq!(api.find_snapshot(id).unwrap().path_index().unwrap().diffed(), 2, "c4 and c5 only");
        assert!(api.find_snapshot(id).unwrap().build_seed().is_none(), "built: the old index is dropped");
    }

    #[tokio::test]
    async fn locate_sizes_the_window_by_collection_order_under_clock_skew() {
        let r = TestRepo::new();
        r.set_clock(2_000_000_000);
        r.commit("M");
        r.switch_new("b1");
        r.set_clock(3_000_000_000);
        r.commit("C1");
        r.switch("main");
        r.switch_new("b2");
        r.set_clock(1_000_000_000);
        r.commit("C2");
        let api = api();
        let id = opened(&api, &r, Some(1)).await;
        let c2 = sha_of(&r, "C2");
        let limit = api.locate_commit(id, &c2).await.unwrap().limit.unwrap();
        assert_eq!(limit, 3, "C2 is second in topological order but third collected");
        graph(&api, id, Some(limit)).await;
        assert!(api.find_text(id, "c2").unwrap().contains(&c2));
    }

    #[tokio::test]
    async fn older_history_follows_the_graphs_refs_not_stash_parts_or_notes() {
        let r = TestRepo::new();
        for i in 1..=4 {
            r.commit(&format!("c{i}"));
        }
        r.stash("Experiment");
        r.git(&["notes", "add", "-m", "a note on c1", "HEAD~3"]);
        let api = api();
        let id = opened(&api, &r, Some(1)).await;
        assert!(api.search_history(id, "index on main").await.unwrap().is_empty(), "a stash's index commit isn't a graph row");
        assert!(api.search_history(id, "Notes added").await.unwrap().is_empty(), "refs/notes isn't searched");
        let hits = api.search_history(id, "c2").await.unwrap();
        assert_eq!(hits.iter().map(|h| h.summary.as_str()).collect::<Vec<_>>(), vec!["c2"]);
        // The stash's own commit is a graph row: found when it's outside the window.
        r.commit("c5");
        graph(&api, id, Some(1)).await;
        let stash = api.search_history(id, "Experiment").await.unwrap();
        assert_eq!(stash.len(), 1);
        assert!(stash[0].summary.contains("Experiment"));
    }

    #[tokio::test]
    async fn older_history_path_search_takes_glob_characters_literally() {
        let r = TestRepo::new();
        r.write("lit/a[x].txt", "a\n");
        r.commit_all_as("bracketed file", "A", "a@example.com");
        r.write("lit/x.txt", "x\n");
        r.commit_all_as("plain x file", "A", "a@example.com");
        r.write("lit/star*.txt", "s\n");
        r.commit_all_as("star file", "A", "a@example.com");
        r.commit("newest");
        let api = api();
        let id = opened(&api, &r, Some(1)).await;
        let summaries = |q: &'static str| {
            let api = &api;
            async move { api.search_history(id, q).await.unwrap().into_iter().map(|h| h.summary).collect::<Vec<_>>() }
        };
        assert_eq!(summaries("[x]").await, vec!["bracketed file"], "[x] is not a character class");
        assert_eq!(summaries("r*.t").await, vec!["star file"], "* is literal");
        assert_eq!(summaries("a?x").await, Vec::<String>::new(), "? is literal");
    }

    #[tokio::test]
    async fn locates_commits_beyond_the_window() {
        let r = TestRepo::new();
        for i in 1..=5 {
            r.commit(&format!("c{i}"));
        }
        let api = api();
        let id = opened(&api, &r, Some(2)).await;
        let c1 = sha_of(&r, "c1");
        let res = api.locate_commit(id, &c1).await.unwrap();
        assert!(res.found);
        assert_eq!(res.limit, Some(5));
        let c3 = sha_of(&r, "c3");
        assert_eq!(api.locate_commit(id, &c3).await.unwrap().limit, Some(3));
        let c5 = sha_of(&r, "c5");
        assert_eq!(api.locate_commit(id, &c5).await.unwrap().limit, None, "already loaded");
        assert_eq!(api.locate_commit(id, &"d".repeat(40)).await.unwrap_err().kind, crate::error::GbErrorKind::NotFound);
    }

    #[tokio::test]
    async fn searches_older_history_by_message_and_path() {
        let r = TestRepo::new();
        for i in 1..=5 {
            r.commit(&format!("c{i} [x]"));
        }
        let api = api();
        let id = opened(&api, &r, Some(2)).await;
        let hits = api.search_history(id, "c1 [x]").await.unwrap();
        assert_eq!(hits.iter().map(|h| h.summary.as_str()).collect::<Vec<_>>(), vec!["c1 [x]"], "fixed-string grep; regex chars are literal");
        let by_path = api.search_history(id, "FILE_1").await.unwrap();
        assert_eq!(by_path.iter().map(|h| h.summary.as_str()).collect::<Vec<_>>(), vec!["c2 [x]"], "file_1.txt came with the second commit (case-insensitive)");
        assert!(api.search_history(id, "c5 [x]").await.unwrap().is_empty(), "commits in the window are excluded");
        let all = api.search_history(id, "[x]").await.unwrap();
        assert_eq!(all.iter().map(|h| h.summary.as_str()).collect::<Vec<_>>(), vec!["c3 [x]", "c2 [x]", "c1 [x]"], "newest first");
        assert_eq!(all[0].id, sha_of(&r, "c3 [x]"));
    }
}
