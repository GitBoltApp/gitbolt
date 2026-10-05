//! Stacks against the fake forge (spec #4 §7): the providers' retarget (4D T2), and the stack
//! requests through the harness's Api (4D T10). No test reaches a real forge.

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;
use serde_json::{json, Value};

/// Replaces one forge's merge requests in the seed (4B's seed fields, A8).
fn seed_mrs(f: &FakeForge, forge: &str, mrs: Value) {
    let mut seed = serde_json::to_value(f.current_seed()).unwrap();
    seed[forge][if forge == "gitlab" { "mergeRequests" } else { "pulls" }] = mrs;
    f.seed(serde_json::from_value(seed).unwrap());
}

fn seeded(f: &FakeForge, forge: &str) -> Vec<Value> {
    let seed = serde_json::to_value(f.current_seed()).unwrap();
    seed[forge][if forge == "gitlab" { "mergeRequests" } else { "pulls" }].as_array().cloned().unwrap_or_default()
}

fn gitlab_mr(iid: u64, source: &str, target: &str, state: &str, description: &str) -> Value {
    json!({ "project": "group/project", "iid": iid, "title": format!("MR {iid}"), "sourceBranch": source, "targetBranch": target, "state": state, "description": description, "author": "ada" })
}

fn github_pr(number: u64, head: &str, base: &str, state: &str, body: &str) -> Value {
    json!({ "repo": "octo-org/widget", "number": number, "title": format!("PR {number}"), "headRef": head, "baseRef": base, "state": state, "merged": false, "draft": false, "body": body, "author": "octocat" })
}

fn gitlab(f: &FakeForge) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(GITLAB_TOKEN), None)
}

fn github(f: &FakeForge) -> GitHubProvider {
    GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(GITHUB_TOKEN), None)
}

// --- 4D T2 ---
#[tokio::test(flavor = "multi_thread")]
async fn gitlab_retargets_with_a_put_of_target_branch() {
    let f = FakeForge::start().await;
    seed_mrs(&f, "gitlab", json!([gitlab_mr(1, "feature/a", "main", "merged", ""), gitlab_mr(2, "feature/b", "feature/a", "opened", "Body")]));
    let p = gitlab(&f);
    let project = p.project("group/project").await.unwrap().value;
    let mr = p.retarget(&project, 2, "main").await.unwrap();
    assert_eq!((mr.number, mr.source_branch.as_str(), mr.target_branch.as_str(), mr.state), (2, "feature/b", "main", MrState::Open));
    assert_eq!(seeded(&f, "gitlab")[1]["targetBranch"], "main");
    assert_eq!(seeded(&f, "gitlab")[1]["description"], "Body", "nothing else changes");
    let put = f.requests().into_iter().find(|r| r.method == "PUT").expect("a PUT");
    assert_eq!(put.path, "/api/v4/projects/42/merge_requests/2");
    let e = p.retarget(&project, 99, "main").await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::NotFound);
}

#[tokio::test(flavor = "multi_thread")]
async fn github_retargets_with_a_patch_of_base() {
    let f = FakeForge::start().await;
    seed_mrs(&f, "github", json!([github_pr(1, "feature/a", "main", "closed", ""), github_pr(2, "feature/b", "feature/a", "open", "Body")]));
    let p = github(&f);
    let repo = p.project("octo-org/widget").await.unwrap().value;
    let pr = p.retarget(&repo, 2, "main").await.unwrap();
    assert_eq!((pr.number, pr.target_branch.as_str()), (2, "main"));
    assert_eq!(seeded(&f, "github")[1]["baseRef"], "main");
    let patch = f.requests().into_iter().find(|r| r.method == "PATCH").expect("a PATCH");
    assert_eq!(patch.path, "/repos/octo-org/widget/pulls/2");
    assert_eq!(p.retarget(&repo, 99, "main").await.unwrap_err().kind, GbErrorKind::NotFound);
}
// --- end 4D T2 ---

// --- 4D T10: the stack requests through the harness's Api ---
use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::Harness;

async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

async fn repo_on(api: &Api, url: &str) -> (TestRepo, u64) {
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", url]);
    let id = call(api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap();
    (r, id)
}

fn puts(f: &FakeForge) -> usize {
    f.requests().iter().filter(|r| r.method == "PUT" || r.method == "PATCH").count()
}

/// Review Focus 2, end to end: CRLF kept, the merged MR untouched, nothing resent.
#[tokio::test(flavor = "multi_thread")]
async fn a_managed_gitlab_stack_gets_its_tables_once() {
    let h = Harness::for_tests().await;
    seed_mrs(&h.forge, "gitlab", json!([gitlab_mr(1, "feature/a", "main", "merged", "A body"), gitlab_mr(2, "feature/b", "feature/a", "opened", "B body\r\n\r\nMore")]));
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": GITLAB_HOST, "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let (_r, id) = repo_on(&h.api, "https://gitlab.example.com/group/project.git").await;
    let sync = json!({"method": "forgeSyncStack", "params": {"repo": id, "branches": ["feature/a", "feature/b"], "base": "main"}});
    let s = call(&h.api, sync.clone()).await.unwrap();
    assert_eq!((s["edited"].clone(), s["failed"].clone()), (json!([2]), json!([])));
    let d = seeded(&h.forge, "gitlab")[1]["description"].as_str().unwrap().to_string();
    assert!(d.starts_with("B body\r\n\r\nMore\r\n\r\n<!-- gitbolt-stack:start -->\r\n"), "{d:?}");
    assert!(d.contains("| 1 | !1 | MR 1 | Merged |\r\n| **2** | **!2** | **MR 2** | **Open** |"), "{d:?}");
    assert_eq!(seeded(&h.forge, "gitlab")[0]["description"], "A body");
    let before = puts(&h.forge);
    let again = call(&h.api, sync).await.unwrap();
    assert_eq!(again["unchanged"], json!([2]));
    assert_eq!(puts(&h.forge), before, "an unchanged description isn't sent");
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_19_1_is_native_and_writes_no_table() {
    let h = Harness::for_tests().await;
    let mut seed = serde_json::to_value(h.forge.current_seed()).unwrap();
    seed["gitlab"]["version"] = json!("19.1.0-ee");
    h.forge.seed(serde_json::from_value(seed).unwrap());
    seed_mrs(&h.forge, "gitlab", json!([gitlab_mr(1, "feature/a", "main", "opened", ""), gitlab_mr(2, "feature/b", "feature/a", "opened", "")]));
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": GITLAB_HOST, "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let (_r, id) = repo_on(&h.api, "https://gitlab.example.com/group/project.git").await;
    let v = call(&h.api, json!({"method": "forgeStack", "params": {"repo": id, "branches": ["feature/a", "feature/b"], "base": "main", "baseRef": "refs/heads/main"}})).await.unwrap();
    assert_eq!((v["mode"].as_str(), v["members"][1]["mr"]["number"].as_u64()), (Some("native"), Some(2)));
    call(&h.api, json!({"method": "forgeSyncStack", "params": {"repo": id, "branches": ["feature/a", "feature/b"], "base": "main"}})).await.unwrap();
    assert_eq!(puts(&h.forge), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_pr_is_retargeted_through_the_api() {
    let h = Harness::for_tests().await;
    seed_mrs(&h.forge, "github", json!([github_pr(2, "feature/b", "feature/a", "open", "")]));
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": GITHUB_HOST, "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    let (_r, id) = repo_on(&h.api, "https://github.com/octo-org/widget.git").await;
    let pr = call(&h.api, json!({"method": "forgeRetarget", "params": {"repo": id, "number": 2, "target": "main"}})).await.unwrap();
    assert_eq!((pr["number"].as_u64(), pr["targetBranch"].as_str()), (Some(2), Some("main")));
    assert_eq!(seeded(&h.forge, "github")[0]["baseRef"], "main");
    let v = call(&h.api, json!({"method": "forgeStack", "params": {"repo": id, "branches": ["feature/b"], "base": "main", "baseRef": "refs/heads/main"}})).await.unwrap();
    assert_eq!((v["kind"].as_str(), v["mode"].as_str()), (Some("github"), Some("managed")));
}
// --- end 4D T10 ---
