//! MRs and PRs through the harness's `Api`: real providers, the fake forge (spec #4 §7).

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};

async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

/// A repo whose origin is `url`, with local `dev` tracking `origin/dev`.
fn repo_on(url: &str) -> TestRepo {
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", url]);
    r.git(&["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    r.git(&["branch", "dev"]);
    r.git(&["config", "branch.dev.remote", "origin"]);
    r.git(&["config", "branch.dev.merge", "refs/heads/dev"]);
    r
}

async fn open(api: &Api, r: &TestRepo) -> u64 {
    call(api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gitlab_repo_gets_badges_a_list_details_and_its_writes_answered() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let r = repo_on("https://gitlab.example.com/group/project.git");
    let id = open(&h.api, &r).await;

    let badges = call(&h.api, json!({"method": "forgeBranchMrs", "params": {"repo": id, "refs": ["refs/remotes/origin/dev", "refs/remotes/origin/feature/old"]}})).await.unwrap();
    let by: std::collections::BTreeMap<String, (u64, String)> = badges["mrs"].as_array().unwrap().iter().map(|b| (b["remoteRef"].as_str().unwrap().to_string(), (b["mr"]["number"].as_u64().unwrap(), b["mr"]["state"].as_str().unwrap().to_string()))).collect();
    assert_eq!(by["refs/remotes/origin/dev"], (12, "open".to_string()));
    assert_eq!(by["refs/remotes/origin/feature/old"], (9, "merged".to_string()), "looked up in any state");
    assert_eq!(by["refs/remotes/origin/diverged"], (5, "draft".to_string()), "every open one on a mapped remote");

    let review = call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "reviewRequested"}})).await.unwrap();
    assert_eq!(review["mrs"].as_array().unwrap().iter().map(|m| m["number"].as_u64().unwrap()).collect::<Vec<_>>(), [12]);
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(detail["value"]["mr"]["pipeline"]["status"], "success");
    assert_eq!(detail["value"]["mergeStatus"], json!({"kind": "blocked", "reason": "It needs approval first"}));
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(threads["value"][1]["notes"][0]["position"]["snippet"], " Readme\n+Second line");

    let note = call(&h.api, json!({"method": "forgeReply", "params": {"repo": id, "number": 12, "discussion": null, "body": "Thanks!"}})).await.unwrap();
    assert_eq!(note["author"]["username"], "ada");
    call(&h.api, json!({"method": "forgeApprove", "params": {"repo": id, "number": 12}})).await.unwrap();
    let head = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap()["value"]["mr"]["headSha"].clone();
    let merged = call(&h.api, json!({"method": "forgeMerge", "params": {"repo": id, "number": 12, "options": {"method": null, "squash": true, "deleteSourceBranch": true, "expectedSha": head}}})).await.unwrap();
    assert_eq!(merged["state"], "merged");
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_repo_gets_its_pull_requests() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    let r = repo_on("https://github.com/octo-org/widget.git");
    let id = open(&h.api, &r).await;
    let list = call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "all"}})).await.unwrap();
    assert_eq!(list["kind"], "github");
    assert_eq!(list["mrs"].as_array().unwrap().iter().map(|m| m["number"].as_u64().unwrap()).collect::<Vec<_>>(), [3, 6, 7]);
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!((detail["value"]["mr"]["review"]["decision"].as_str(), detail["value"]["mergeStatus"]["kind"].as_str()), (Some("approved"), Some("mergeable")));
    let draft = call(&h.api, json!({"method": "forgeSetDraft", "params": {"repo": id, "number": 3, "draft": true}})).await.unwrap();
    assert_eq!(draft["state"], "draft");
}

// --- 4B final fix ---
#[tokio::test(flavor = "multi_thread")]
async fn a_full_github_poll_reads_each_prs_checks_once() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    let r = repo_on("https://github.com/octo-org/widget.git");
    let id = open(&h.api, &r).await;
    let checks = |h: &Harness| h.forge.requests().iter().filter(|q| q.path.ends_with("/check-runs")).count();
    let before = checks(&h);
    // The poll's badges, then its list (UI forge/poll.ts).
    call(&h.api, json!({"method": "forgeBranchMrs", "params": {"repo": id, "refs": ["refs/remotes/origin/dev"]}})).await.unwrap();
    assert_eq!(checks(&h), before, "the badges read no checks");
    let list = call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "all"}})).await.unwrap();
    assert_eq!(list["mrs"].as_array().unwrap().len(), 3);
    assert_eq!(checks(&h) - before, 3, "once per open PR, not twice");
}
// --- end 4B final fix ---

#[tokio::test(flavor = "multi_thread")]
async fn the_add_account_helper_the_test_route_uses_adds_an_account() {
    let h = Harness::for_tests().await;
    let added = h.add_forge_account_for_test("gitlab.example.com", gitbolt_core::forge::ForgeKind::GitLab, GITLAB_TOKEN).await.unwrap();
    assert_eq!(added["account"]["user"]["username"], "ada");
}
