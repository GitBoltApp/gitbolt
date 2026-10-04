//! The GitLab provider's create half against the fake forge (plan 4C).

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;
use std::collections::BTreeMap;

fn provider(f: &FakeForge, token: &str) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(token), None)
}

fn req(source: &str) -> CreateMr {
    CreateMr {
        source: SourceRef { project: source.into(), branch: "feature".into() }, target_branch: "main".into(), title: "Add login".into(), description: "Why.".into(),
        draft: true, reviewers: vec![8], assignees: vec![7], labels: vec!["bug".into(), "feature".into()], squash: Some(true), delete_source_branch: Some(false),
    }
}

fn posts(f: &FakeForge) -> Vec<String> {
    f.requests().into_iter().filter(|r| r.method == "POST").map(|r| r.path).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_in_one_post_with_people_labels_squash_and_the_draft_prefix() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let project = p.project("group/project").await.unwrap().value;
    let out = p.create_mr(&project, &req("group/project")).await.unwrap();
    assert!(out.failed.is_empty(), "GitLab creates in one POST: nothing can partly fail");
    assert_eq!((out.mr.number, out.mr.state, out.mr.title.as_str()), (1, MrState::Draft, "Draft: Add login"));
    assert_eq!((out.mr.source_branch.as_str(), out.mr.target_branch.as_str(), out.mr.target_project.as_str()), ("feature", "main", "group/project"));
    assert_eq!(out.mr.labels, ["bug", "feature"]);
    let created = &f.current_seed().gitlab.created[0];
    assert_eq!((created["reviewers"][0]["username"].as_str(), created["assignees"][0]["username"].as_str()), (Some("grace"), Some("ada")));
    assert_eq!((created["squash"].as_bool(), created["force_remove_source_branch"].as_bool()), (Some(true), Some(false)));
    assert_eq!(posts(&f), ["/api/v4/projects/42/merge_requests"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_mr_from_a_fork_is_posted_to_the_fork_and_names_the_target() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let target = p.project("group/project").await.unwrap().value;
    let out = p.create_mr(&target, &req("alice/project")).await.unwrap();
    assert_eq!((out.mr.source_project.as_str(), out.mr.target_project.as_str()), ("alice/project", "group/project"));
    assert_eq!(posts(&f), ["/api/v4/projects/77/merge_requests"]);
    assert_eq!(f.current_seed().gitlab.created[0]["target_project_id"], 42);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_open_mr_for_the_branch_says_which_one_exists() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let project = p.project("group/project").await.unwrap().value;
    p.create_mr(&project, &req("group/project")).await.unwrap();
    let e = p.create_mr(&project, &req("group/project")).await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::InvalidInput);
    assert_eq!(e.message, "gitlab.example.com: Another open merge request already exists for this source branch: !1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_only_token_is_refused_with_the_forges_reason() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_READONLY_TOKEN);
    let project = p.project("group/project").await.unwrap().value;
    let e = p.create_mr(&project, &req("group/project")).await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::AuthFailed);
    assert_eq!(e.message, "gitlab.example.com refused: The request requires higher privileges than provided by the access token.");
}

#[tokio::test(flavor = "multi_thread")]
async fn members_and_labels_are_searched_on_the_project() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let project = p.project("group/project").await.unwrap().value;
    let names = |l: Vec<ForgeUser>| l.into_iter().map(|u| u.username).collect::<Vec<_>>();
    assert_eq!(names(p.search_users(&project, "gra").await.unwrap()), ["grace"]);
    assert_eq!(names(p.search_users(&project, "").await.unwrap()), ["ada", "grace"]);
    assert_eq!(p.labels(&project, "fea").await.unwrap(), [ForgeLabel { name: "feature".into(), color: Some("#428bca".into()), description: None }]);
    let log = f.requests();
    assert!(log.iter().any(|r| r.path == "/api/v4/projects/42/members/all" && r.query.contains("query=gra")), "{log:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn templates_come_from_the_target_branch_default_first_and_none_is_no_error() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.gitlab.files.insert(
        "group/project".into(),
        BTreeMap::from([
            (".gitlab/merge_request_templates/Bug.md".to_string(), "## Bug\r\n".to_string()),
            (".gitlab/merge_request_templates/Default.md".to_string(), "## Why\n".to_string()),
            (".gitlab/merge_request_templates/notes.txt".to_string(), "x".to_string()),
            ("README.md".to_string(), "r".to_string()),
        ]),
    );
    f.seed(seed);
    let p = provider(&f, GITLAB_TOKEN);
    let project = p.project("group/project").await.unwrap().value;
    let list = p.mr_templates(&project, "main").await.unwrap();
    assert_eq!(list.iter().map(|t| (t.name.as_str(), t.body.as_str())).collect::<Vec<_>>(), [("Default", "## Why\n"), ("Bug", "## Bug\n")]);
    assert!(f.requests().iter().any(|r| r.path == "/api/v4/projects/42/repository/tree" && r.query.contains("ref=main")));
    let fork = p.project("alice/project").await.unwrap().value;
    assert!(p.mr_templates(&fork, "main").await.unwrap().is_empty(), "no directory: no templates, not an error");
}
