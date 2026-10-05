//! The MR/PR cache across restarts (`forge::cache`): a relaunch shows the last list and badges
//! with no request, then revalidates them with `If-None-Match`; removing the account or a write
//! clears what it kept. Both forges, the fake forge only.

use crate::forge_poll_cost::{call, ok, poll, remote_refs, setup};
use gitbolt_harness::fake_forge::*;
use serde_json::json;

fn files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.path().is_dir() {
            out.extend(files_under(&e.path()));
        } else {
            out.push(e.path());
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relaunch_shows_the_cached_list_and_badges_at_once_then_revalidates_them() {
    for kind in ["gitlab", "github"] {
        let s = setup(kind, false).await;
        poll(&s, "activate", "all", None).await;
        let before = ok(&s.h.api, json!({"method": "forgeBranchMrs", "params": {"repo": s.id, "refs": remote_refs()}})).await;
        let token = if kind == "gitlab" { GITLAB_TOKEN } else { GITHUB_TOKEN };
        let cache_dir = s.h.data_dir().join("forge-cache");
        let files = files_under(&cache_dir);
        assert!(!files.is_empty(), "{kind}: the poll left a cache");
        for f in &files {
            assert!(!std::fs::read_to_string(f).unwrap().contains(token), "{kind}: never a token in {}", f.display());
        }

        let api = s.h.relaunch();
        let id = ok(&api, json!({"method": "openRepo", "params": {"path": s.repo_path()}})).await["id"].as_u64().unwrap();
        s.h.forge.clear_requests();
        let cached = ok(&api, json!({"method": "forgeCachedMrs", "params": {"repo": id, "refs": remote_refs(), "filter": "all"}})).await;
        assert!(s.h.forge.requests().is_empty(), "{kind}: no request before revalidation: {:?}", s.h.forge.requests());
        assert_eq!(cached["kind"], kind);
        // GitLab's seed has one more open MR, from a fork.
        assert_eq!(cached["list"]["mrs"].as_array().unwrap().len(), if kind == "gitlab" { 41 } else { 40 }, "{kind}");
        assert_eq!(cached["badges"]["mrs"], before["mrs"], "{kind}: the same badges");
        assert_eq!(cached["badges"]["history"], before["history"], "{kind}: and the stacks' history");
        assert!(cached["savedAt"].as_i64().unwrap() > 0);
        assert_eq!(ok(&api, json!({"method": "forgeCachedMrs", "params": {"repo": id, "refs": remote_refs(), "filter": "mine"}})).await["list"], json!(null), "{kind}: a filter never read has no list");

        // The first poll after it: conditional, and unchanged answers are 304s.
        ok(&api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "all"}})).await;
        let lists: Vec<RecordedRequest> = s.h.forge.requests().into_iter().filter(|r| r.path.ends_with("/merge_requests") || r.path.ends_with("/pulls")).collect();
        assert!(!lists.is_empty() && lists.iter().all(|r| r.if_none_match.is_some() && r.status == 304), "{kind}: {lists:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_the_account_or_a_write_clears_what_the_cache_kept() {
    for kind in ["gitlab", "github"] {
        let s = setup(kind, false).await;
        poll(&s, "activate", "all", None).await;
        // A write: the lists it may have changed aren't shown from the cache after a relaunch.
        call(&s.h.api, json!({"method": "forgeApprove", "params": {"repo": s.id, "number": 101}})).await.unwrap();
        let api = s.h.relaunch();
        let id = ok(&api, json!({"method": "openRepo", "params": {"path": s.repo_path()}})).await["id"].as_u64().unwrap();
        assert_eq!(ok(&api, json!({"method": "forgeCachedMrs", "params": {"repo": id, "refs": remote_refs(), "filter": "all"}})).await, json!(null), "{kind}");
        // Read again, then the account goes: its host's cache goes with it.
        poll(&s, "timer", "all", None).await;
        let host = if kind == "gitlab" { GITLAB_HOST } else { GITHUB_HOST };
        let host_dir = std::fs::read_dir(s.h.data_dir().join("forge-cache")).unwrap().flatten().map(|p| p.path().join(host)).find(|d| d.is_dir()).unwrap_or_else(|| panic!("{kind}: no cache for {host}"));
        ok(&s.h.api, json!({"method": "removeForgeAccount", "params": {"host": host}})).await;
        assert!(!host_dir.exists(), "{kind}");
    }
}
