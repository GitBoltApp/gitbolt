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
    let avatar = call(&api, json!({"method": "avatar", "params": {"email": "ada@example.com", "repo": id}})).await.unwrap();
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

// --- GitHub commit-author avatars ---
fn author_lookups(h: &Harness) -> usize {
    h.forge.requests().iter().filter(|r| r.path.ends_with("/commits") && r.query.contains("author=")).count()
}

fn repo_with_origin(url: &str) -> TestRepo {
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", url]);
    r
}

/// The avatar request's last step: the tab's GitHub project, asked who an email's commits belong to.
#[tokio::test(flavor = "multi_thread")]
async fn a_github_repos_commit_author_gets_the_linked_accounts_picture() {
    use gitbolt_harness::fake_forge::github::{LINKED_AUTHOR_EMAIL, UNLINKED_AUTHOR_EMAIL};
    let h = Harness::for_tests().await;
    let avatar = |repo: Option<u64>, email: &str| {
        let params = match repo { Some(id) => json!({"email": email, "repo": id}), None => json!({"email": email}) };
        call(&h.api, json!({"method": "avatar", "params": params}))
    };
    let gh = repo_with_origin("https://github.com/octo-org/widget.git");
    let gh_id = call(&h.api, json!({"method": "openRepo", "params": {"path": gh.path()}})).await.unwrap()["id"].as_u64().unwrap();
    assert!(avatar(Some(gh_id), LINKED_AUTHOR_EMAIL).await.unwrap().is_null(), "no account");
    assert_eq!(author_lookups(&h), 0);
    assert!(h.forge.requests().is_empty(), "nothing at all without an account");

    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    assert!(avatar(None, LINKED_AUTHOR_EMAIL).await.unwrap().is_null(), "no repo: no project to ask");
    let gl = repo_with_origin("https://gitlab.example.com/group/project.git");
    let gl_id = call(&h.api, json!({"method": "openRepo", "params": {"path": gl.path()}})).await.unwrap()["id"].as_u64().unwrap();
    assert!(avatar(Some(gl_id), LINKED_AUTHOR_EMAIL).await.unwrap().is_null(), "a GitLab repo");
    assert_eq!(author_lookups(&h), 0);

    assert_eq!(avatar(Some(gh_id), LINKED_AUTHOR_EMAIL).await.unwrap()["mime"], "image/png");
    assert_eq!(author_lookups(&h), 1);
    assert!(!avatar(Some(gh_id), LINKED_AUTHOR_EMAIL).await.unwrap().is_null());
    assert!(avatar(None, LINKED_AUTHOR_EMAIL).await.unwrap().is_null(), "no tab: no forge is asked, not even its cache");
    assert!(avatar(Some(gh_id), UNLINKED_AUTHOR_EMAIL).await.unwrap().is_null());
    assert!(avatar(Some(gh_id), UNLINKED_AUTHOR_EMAIL).await.unwrap().is_null());
    assert_eq!(author_lookups(&h), 2, "each email once");
    let log = serde_json::to_string(&h.forge.requests()).unwrap();
    assert!(!log.contains("search") && !log.contains(GITHUB_TOKEN));
}
// --- end GitHub commit-author avatars ---

/// A commit author's email goes only to the forge hosting the tab's repo: a GitHub repo's author
/// is never looked up on the profile's GitLab account, and a GitLab repo's never on GitHub.
#[tokio::test(flavor = "multi_thread")]
async fn an_authors_email_never_reaches_a_forge_that_doesnt_host_the_repo() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let open = |r: &TestRepo| {
        let path = r.path().to_path_buf();
        let api = h.api.clone();
        async move { call(&api, json!({"method": "openRepo", "params": {"path": path}})).await.unwrap()["id"].as_u64().unwrap() }
    };
    let gh = repo_with_origin("https://github.com/octo-org/widget.git");
    let gl = repo_with_origin("https://gitlab.example.com/group/project.git");
    let (gh_id, gl_id) = (open(&gh).await, open(&gl).await);
    let email = "grace@example.com";
    let mentions = |forge: &str| h.forge.requests().iter().filter(|r| r.forge == forge && (r.query.contains("grace") || r.path.contains("grace"))).count();

    call(&h.api, json!({"method": "avatar", "params": {"email": email, "repo": gh_id, "name": "Grace Hopper"}})).await.unwrap();
    assert_eq!(mentions("gitlab"), 0, "a GitHub repo's author never goes to GitLab");
    assert!(mentions("github") > 0, "the repo's own forge is asked");

    call(&h.api, json!({"method": "avatar", "params": {"email": "grace2@example.com", "repo": gl_id, "name": "Grace Two"}})).await.unwrap();
    let github = h.forge.requests().iter().filter(|r| r.forge == "github" && r.query.contains("grace2")).count();
    assert_eq!(github, 0, "a GitLab repo's author never goes to GitHub");
    assert!(h.forge.requests().iter().any(|r| r.forge == "gitlab" && r.query.contains("grace2")), "the repo's own forge is asked");
}
