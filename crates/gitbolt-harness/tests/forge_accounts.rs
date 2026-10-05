//! The whole forge stack through the harness's `Api`: real providers, the fake forge, a file
//! token store in the harness's temp dir (spec #4 §7).

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_added_through_the_api_maps_remotes_lists_forks_and_serves_avatars() {
    let h = Harness::for_tests().await;
    let api = h.api.clone();
    let added = call(&api, json!({"method": "addForgeAccount", "params": {"host": "https://gitlab.example.com/", "kind": "gitlab", "token": format!(" {GITLAB_TOKEN}\n")}})).await.unwrap();
    assert_eq!(added["account"]["user"]["username"], "ada");
    assert_eq!(added["account"]["storage"], "file");
    assert_eq!(added["account"]["version"], "18.9.1-ee");
    let file = h.tokens_path();
    assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);

    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", "https://gitlab.example.com/group/project.git"]);
    let id = call(&api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap();
    let projects = call(&api, json!({"method": "forgeRepoProjects", "params": {"repo": id, "refresh": false}})).await.unwrap();
    assert_eq!(projects["remotes"][0]["project"]["id"], 42);
    assert_eq!(projects["target"], "origin");
    let forks = call(&api, json!({"method": "forgeForks", "params": {"repo": id, "remote": "origin"}})).await.unwrap();
    assert_eq!(forks["forks"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect::<Vec<_>>(), ["alice/project", "ada/project"]);
    let settings = call(&api, json!({"method": "forgeProjectSettings", "params": {"repo": id, "remote": "origin"}})).await.unwrap();
    assert_eq!(settings["squash"], "defaultOff");
    let avatar = call(&api, json!({"method": "avatar", "params": {"email": "ada@example.com"}})).await.unwrap();
    assert_eq!(avatar["mime"], "image/png");

    let log = serde_json::to_string(&h.forge.requests()).unwrap();
    assert!(!log.contains(GITLAB_TOKEN), "the fake's log never holds the token");
    call(&api, json!({"method": "removeForgeAccount", "params": {"host": "gitlab.example.com"}})).await.unwrap();
    assert_eq!(call(&api, json!({"method": "forgeAccounts"})).await.unwrap(), json!([]));
    assert!(!file.exists() || !std::fs::read_to_string(file).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_account_and_a_host_without_a_fake_is_refused() {
    let h = Harness::for_tests().await;
    let gh = call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_FINE_TOKEN}})).await.unwrap();
    assert_eq!(gh["account"]["user"]["username"], "octocat");
    let e = call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.other.example", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap_err();
    assert_eq!(e.message, "gitlab.other.example isn't reachable from this build (tests use the fake forge)");
}

#[tokio::test(flavor = "multi_thread")]
async fn reset_forgets_accounts_tokens_and_the_fakes_state() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    h.reset();
    assert_eq!(call(&h.api, json!({"method": "forgeAccounts"})).await.unwrap(), json!([]));
    assert!(!h.tokens_path().exists());
    assert!(h.forge.requests().is_empty());
}
