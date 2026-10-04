//! The GitHub provider's create half against the fake forge (plan 4C): POST /pulls, then the
//! follow-up calls, each failure explicit (spec #4 §3.5).

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_harness::fake_forge::*;
use serde_json::json;
use std::collections::BTreeMap;

fn provider(f: &FakeForge) -> GitHubProvider {
    GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(GITHUB_TOKEN), None)
}

fn req(source: &str, reviewers: Vec<u64>) -> CreateMr {
    CreateMr {
        source: SourceRef { project: source.into(), branch: "feature".into() }, target_branch: "main".into(), title: "Add the widget".into(), description: "It spins.".into(),
        draft: false, reviewers, assignees: vec![583231], labels: vec!["bug".into()], squash: None, delete_source_branch: None,
    }
}

fn posts(f: &FakeForge) -> Vec<String> {
    f.requests().into_iter().filter(|r| r.method == "POST").map(|r| r.path).collect()
}

async fn widget(p: &GitHubProvider) -> ForgeProject {
    p.project("octo-org/widget").await.unwrap().value
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_then_requests_reviewers_assigns_and_labels() {
    let f = FakeForge::start().await;
    let p = provider(&f);
    let project = widget(&p).await;
    let out = p.create_mr(&project, &req("octo-org/widget", vec![3])).await.unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!((out.mr.number, out.mr.state, out.mr.labels.clone()), (1, MrState::Open, vec!["bug".to_string()]));
    let created = &f.current_seed().github.created[0];
    assert_eq!(created["requested_reviewers"][0]["login"], "hubot");
    assert_eq!(created["assignees"][0]["login"], "octocat");
    assert_eq!(created["labels"][0]["name"], "bug");
    assert_eq!(posts(&f), ["/repos/octo-org/widget/pulls", "/repos/octo-org/widget/pulls/1/requested_reviewers", "/repos/octo-org/widget/issues/1/assignees", "/repos/octo-org/widget/issues/1/labels"]);
    assert!(f.requests().iter().any(|r| r.path == "/user/3"), "ids become logins");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_reviewer_is_a_partial_failure_and_a_retry_adds_only_what_failed() {
    let f = FakeForge::start().await;
    f.script(Scripted { forge: "github".into(), method: "POST".into(), path: "/repos/octo-org/widget/pulls/1/requested_reviewers".into(), status: 422, headers: vec![], body: json!({"message": "Reviews may only be requested from collaborators."}), times: 1 });
    let p = provider(&f);
    let project = widget(&p).await;
    let r = req("octo-org/widget", vec![3]);
    let out = p.create_mr(&project, &r).await.unwrap();
    assert_eq!(out.failed, [PartFailure { part: CreatePart::Reviewers, message: "Reviews may only be requested from collaborators.".into() }]);
    assert_eq!(out.mr.labels, ["bug"], "the next parts still ran");
    let still = p.complete_create(&project, out.mr.number, &r, &[CreatePart::Reviewers]).await.unwrap();
    assert!(still.is_empty());
    let p_posts = posts(&f);
    assert_eq!(p_posts.last().map(String::as_str), Some("/repos/octo-org/widget/pulls/1/requested_reviewers"));
    assert_eq!(p_posts.iter().filter(|x| x.ends_with("/labels")).count(), 1, "a retry reruns only the failed part");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_labels_call_is_a_partial_outcome_with_the_pr_kept_and_a_retry_labels_it() {
    let f = FakeForge::start().await;
    f.script(Scripted { forge: "github".into(), method: "POST".into(), path: "/repos/octo-org/widget/issues/1/labels".into(), status: 500, headers: vec![], body: json!({"message": "Server Error"}), times: 1 });
    let p = provider(&f);
    let project = widget(&p).await;
    let r = req("octo-org/widget", vec![]);
    let out = p.create_mr(&project, &r).await.unwrap();
    assert_eq!(out.mr.number, 1, "the created PR is not hidden");
    assert_eq!(out.failed.len(), 1);
    assert_eq!(out.failed[0].part, CreatePart::Labels);
    assert!(!out.failed[0].message.is_empty());
    assert!(out.mr.labels.is_empty(), "labels weren't applied");
    let still = p.complete_create(&project, 1, &r, &[CreatePart::Labels]).await.unwrap();
    assert!(still.is_empty(), "{still:?}");
    assert_eq!(f.current_seed().github.created[0]["labels"][0]["name"], "bug");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_author_as_reviewer_is_refused_with_githubs_reason() {
    let f = FakeForge::start().await;
    let p = provider(&f);
    let out = p.create_mr(&widget(&p).await, &req("octo-org/widget", vec![583231])).await.unwrap();
    assert_eq!(out.failed[0].message, "Review cannot be requested from pull request author.");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_pr_for_the_branch_says_it_exists() {
    let f = FakeForge::start().await;
    let p = provider(&f);
    let project = widget(&p).await;
    p.create_mr(&project, &req("octo-org/widget", vec![])).await.unwrap();
    let e = p.create_mr(&project, &req("octo-org/widget", vec![])).await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::InvalidInput);
    assert_eq!(e.message, "github.com: Validation Failed: A pull request already exists for octo-org:feature.");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pr_from_a_fork_heads_with_the_forks_owner() {
    let f = FakeForge::start().await;
    let p = provider(&f);
    let out = p.create_mr(&widget(&p).await, &req("octocat/widget", vec![])).await.unwrap();
    assert_eq!(out.mr.source_project, "octocat/widget");
    assert_eq!(f.current_seed().github.created[0]["head"]["label"], "octocat:feature");
}

#[tokio::test(flavor = "multi_thread")]
async fn people_are_the_repos_assignees_filtered_here_and_labels_carry_a_hash() {
    let f = FakeForge::start().await;
    let p = provider(&f);
    let project = widget(&p).await;
    assert_eq!(p.search_users(&project, "HUB").await.unwrap().into_iter().map(|u| u.username).collect::<Vec<_>>(), ["hubot"]);
    assert_eq!(p.labels(&project, "enh").await.unwrap(), [ForgeLabel { name: "enhancement".into(), color: Some("#a2eeef".into()), description: None }]);
    assert!(!f.requests().iter().any(|r| r.path.starts_with("/search/")), "never the 30-a-minute user search");
}

#[tokio::test(flavor = "multi_thread")]
async fn templates_are_found_case_insensitively_and_decoded() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.github.files.insert(
        "octo-org/widget".into(),
        BTreeMap::from([
            (".github/PULL_REQUEST_TEMPLATE.md".to_string(), "Single\r\n".to_string()),
            (".github/PULL_REQUEST_TEMPLATE/feature.md".to_string(), "Feature\n".to_string()),
            (".github/workflows/ci.yml".to_string(), "x".to_string()),
        ]),
    );
    f.seed(seed);
    let p = provider(&f);
    let list = p.mr_templates(&widget(&p).await, "main").await.unwrap();
    assert_eq!(list.iter().map(|t| (t.name.as_str(), t.body.as_str())).collect::<Vec<_>>(), [("Default", "Single\n"), ("feature", "Feature\n")]);
    let fork = p.project("octocat/widget").await.unwrap().value;
    assert!(p.mr_templates(&fork, "main").await.unwrap().is_empty());
}

fn seed_templates(f: &FakeForge) {
    let mut seed = f.current_seed();
    seed.github.files.insert(
        "octo-org/widget".into(),
        BTreeMap::from([
            (".github/PULL_REQUEST_TEMPLATE.md".to_string(), "Single\n".to_string()),
            (".github/PULL_REQUEST_TEMPLATE/feature.md".to_string(), "Feature\n".to_string()),
            (".github/PULL_REQUEST_TEMPLATE/bug.md".to_string(), "Bug\n".to_string()),
        ]),
    );
    f.seed(seed);
}

fn script_get(f: &FakeForge, path: &str, status: u16) {
    f.script(Scripted { forge: "github".into(), method: "GET".into(), path: path.into(), status, headers: vec![], body: json!({"message": "x"}), times: 5 });
}

async fn names(p: &GitHubProvider) -> Result<Vec<String>, gitbolt_core::error::GbError> {
    Ok(p.mr_templates(&widget(p).await, "main").await?.into_iter().map(|t| t.name).collect())
}

#[tokio::test(flavor = "multi_thread")]
async fn one_unreadable_template_file_leaves_the_others() {
    let f = FakeForge::start().await;
    seed_templates(&f);
    script_get(&f, "/repos/octo-org/widget/contents/.github/PULL_REQUEST_TEMPLATE/feature.md", 404);
    assert_eq!(names(&provider(&f)).await.unwrap(), ["Default", "bug"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forbidden_template_directory_leaves_the_single_template() {
    let f = FakeForge::start().await;
    seed_templates(&f);
    script_get(&f, "/repos/octo-org/widget/contents/.github/PULL_REQUEST_TEMPLATE", 403);
    assert_eq!(names(&provider(&f)).await.unwrap(), ["Default"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forbidden_github_directory_is_an_error_so_the_hub_reads_the_local_copy() {
    let f = FakeForge::start().await;
    seed_templates(&f);
    script_get(&f, "/repos/octo-org/widget/contents/.github", 403);
    let e = names(&provider(&f)).await.unwrap_err();
    assert!(gitbolt_forge::http::is_forbidden(&e), "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_github_directory_means_no_templates() {
    let f = FakeForge::start().await;
    seed_templates(&f);
    script_get(&f, "/repos/octo-org/widget/contents/.github", 404);
    assert!(names(&provider(&f)).await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_error_on_a_template_still_fails() {
    let f = FakeForge::start().await;
    seed_templates(&f);
    script_get(&f, "/repos/octo-org/widget/contents/.github/PULL_REQUEST_TEMPLATE/feature.md", 500);
    assert!(names(&provider(&f)).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn assignees_the_response_leaves_out_are_a_partial_failure() {
    let f = FakeForge::start().await;
    f.script(Scripted { forge: "github".into(), method: "POST".into(), path: "/repos/octo-org/widget/issues/1/assignees".into(), status: 201, headers: vec![], body: json!({"assignees": []}), times: 1 });
    let p = provider(&f);
    let out = p.create_mr(&widget(&p).await, &req("octo-org/widget", vec![])).await.unwrap();
    assert_eq!(out.failed, [PartFailure { part: CreatePart::Assignees, message: "couldn't assign: octocat".into() }]);
}
