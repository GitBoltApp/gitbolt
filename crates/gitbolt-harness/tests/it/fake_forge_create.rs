//! The fake forge's create half (plan 4C): what the providers' create, people, labels and
//! template calls meet in every test.

use gitbolt_harness::fake_forge::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// One request on the blocking pool: a POST when `body` is set, else a GET.
async fn send(url: String, token: &'static str, body: Option<Value>) -> (u16, Value) {
    tokio::task::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let auth = format!("Bearer {token}");
        let mut resp = match body {
            Some(b) => agent.post(&url).header("Authorization", &auth).header("Content-Type", "application/json").send(b.to_string()).unwrap(),
            None => agent.get(&url).header("Authorization", &auth).call().unwrap(),
        };
        let text = resp.body_mut().read_to_string().unwrap_or_default();
        (resp.status().as_u16(), serde_json::from_str(&text).unwrap_or(Value::String(text)))
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_creates_once_per_open_branch_and_needs_the_api_scope() {
    let f = FakeForge::start().await;
    let url = format!("{}/projects/42/merge_requests", f.gitlab_api());
    let body = json!({"source_branch": "feature", "target_branch": "main", "title": "Draft: Add login", "description": "Why.", "reviewer_ids": [8], "assignee_ids": [7], "labels": "bug,feature", "squash": true});
    let (status, mr) = send(url.clone(), GITLAB_TOKEN, Some(body.clone())).await;
    assert_eq!(status, 201);
    assert_eq!((mr["iid"].as_u64(), mr["draft"].as_bool(), mr["state"].as_str()), (Some(1), Some(true), Some("opened")));
    assert_eq!((mr["reviewers"][0]["username"].as_str(), mr["assignees"][0]["username"].as_str()), (Some("grace"), Some("ada")));
    assert_eq!(mr["labels"], json!(["bug", "feature"]));
    assert_eq!(f.current_seed().gitlab.created.len(), 1);
    assert_eq!(f.current_seed().gitlab.merge_requests.iter().filter(|m| m.iid == 1 && m.title == "Draft: Add login" && m.reviewers == ["grace"]).count(), 1, "4B's list has it too");
    let (status, again) = send(url.clone(), GITLAB_TOKEN, Some(body.clone())).await;
    assert_eq!((status, again["message"][0].as_str()), (409, Some("Another open merge request already exists for this source branch: !1")));
    assert_eq!(send(url, GITLAB_READONLY_TOKEN, Some(body)).await.0, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_members_labels_and_template_files() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.gitlab.files.insert("group/project".into(), BTreeMap::from([(".gitlab/merge_request_templates/Default.md".to_string(), "## Why\n".to_string()), ("README.md".to_string(), "r".to_string())]));
    f.seed(seed);
    let (_, members) = send(format!("{}/projects/42/members/all?query=gra", f.gitlab_api()), GITLAB_TOKEN, None).await;
    assert_eq!(members.as_array().unwrap().iter().map(|m| m["username"].as_str().unwrap()).collect::<Vec<_>>(), ["grace"]);
    let (_, labels) = send(format!("{}/projects/42/labels?search=fea", f.gitlab_api()), GITLAB_TOKEN, None).await;
    assert_eq!(labels, json!([{"id": 2, "name": "feature", "color": "#428bca", "description": null}]));
    let (status, tree) = send(format!("{}/projects/42/repository/tree?path=.gitlab%2Fmerge_request_templates&ref=main", f.gitlab_api()), GITLAB_TOKEN, None).await;
    assert_eq!((status, tree[0]["path"].as_str(), tree[0]["type"].as_str()), (200, Some(".gitlab/merge_request_templates/Default.md"), Some("blob")));
    let (status, raw) = send(format!("{}/projects/42/repository/files/.gitlab%2Fmerge_request_templates%2FDefault.md/raw?ref=main", f.gitlab_api()), GITLAB_TOKEN, None).await;
    assert_eq!((status, raw.as_str()), (200, Some("## Why\n")));
    assert_eq!(send(format!("{}/projects/77/repository/tree?path=.gitlab%2Fmerge_request_templates", f.gitlab_api()), GITLAB_TOKEN, None).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn github_creates_then_takes_reviewers_assignees_and_labels() {
    let f = FakeForge::start().await;
    let repo = format!("{}/repos/octo-org/widget", f.github_api());
    let (status, pr) = send(format!("{repo}/pulls"), GITHUB_TOKEN, Some(json!({"title": "Add the widget", "head": "feature", "base": "main", "body": "It spins.", "draft": false}))).await;
    assert_eq!((status, pr["number"].as_u64(), pr["head"]["label"].as_str()), (201, Some(1), Some("octo-org:feature")));
    let (status, dup) = send(format!("{repo}/pulls"), GITHUB_TOKEN, Some(json!({"title": "x", "head": "feature", "base": "main"}))).await;
    assert_eq!((status, dup["errors"][0]["message"].as_str()), (422, Some("A pull request already exists for octo-org:feature.")));
    let (status, refused) = send(format!("{repo}/pulls/1/requested_reviewers"), GITHUB_TOKEN, Some(json!({"reviewers": ["stranger"]}))).await;
    assert_eq!(status, 422);
    assert!(refused["message"].as_str().unwrap().starts_with("Reviews may only be requested from collaborators."));
    assert_eq!(send(format!("{repo}/pulls/1/requested_reviewers"), GITHUB_TOKEN, Some(json!({"reviewers": ["octocat"]}))).await.1["message"], "Review cannot be requested from pull request author.");
    assert_eq!(send(format!("{repo}/pulls/1/requested_reviewers"), GITHUB_TOKEN, Some(json!({"reviewers": ["hubot"]}))).await.0, 201);
    assert_eq!(send(format!("{repo}/issues/1/assignees"), GITHUB_TOKEN, Some(json!({"assignees": ["octocat"]}))).await.0, 201);
    assert_eq!(send(format!("{repo}/issues/1/labels"), GITHUB_TOKEN, Some(json!({"labels": ["bug"]}))).await.0, 200);
    let created = &f.current_seed().github.created[0];
    assert_eq!((created["requested_reviewers"][0]["login"].as_str(), created["assignees"][0]["login"].as_str(), created["labels"][0]["name"].as_str()), (Some("hubot"), Some("octocat"), Some("bug")));
    let listed = f.current_seed().github.pulls.into_iter().find(|p| p.number == 1).expect("4B's list has it too");
    assert_eq!((listed.requested_reviewers, listed.assignees, listed.labels), (vec!["hubot".to_string()], vec!["octocat".to_string()], vec!["bug".to_string()]));
    assert_eq!(send(format!("{}/user/3", f.github_api()), GITHUB_TOKEN, None).await.1["login"], "hubot");
}

#[tokio::test(flavor = "multi_thread")]
async fn github_assignees_labels_and_contents() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.github.files.insert("octo-org/widget".into(), BTreeMap::from([(".github/PULL_REQUEST_TEMPLATE.md".to_string(), "Single\n".to_string()), (".github/PULL_REQUEST_TEMPLATE/feature.md".to_string(), "Feature\n".to_string())]));
    f.seed(seed);
    let repo = format!("{}/repos/octo-org/widget", f.github_api());
    let (_, people) = send(format!("{repo}/assignees"), GITHUB_TOKEN, None).await;
    assert_eq!(people.as_array().unwrap().iter().map(|p| p["login"].as_str().unwrap()).collect::<Vec<_>>(), ["octocat", "hubot"]);
    assert_eq!(send(format!("{repo}/labels"), GITHUB_TOKEN, None).await.1[0]["color"], "d73a4a");
    let (_, dir) = send(format!("{repo}/contents/.github?ref=main"), GITHUB_TOKEN, None).await;
    let entries: Vec<(&str, &str)> = dir.as_array().unwrap().iter().map(|e| (e["type"].as_str().unwrap(), e["path"].as_str().unwrap())).collect();
    assert_eq!(entries, [("file", ".github/PULL_REQUEST_TEMPLATE.md"), ("dir", ".github/PULL_REQUEST_TEMPLATE")], "in path order: `.` sorts before `/`");
    let (_, file) = send(format!("{repo}/contents/.github/PULL_REQUEST_TEMPLATE/feature.md?ref=main"), GITHUB_TOKEN, None).await;
    assert_eq!((file["type"].as_str(), file["encoding"].as_str()), (Some("file"), Some("base64")));
    assert_eq!(send(format!("{repo}/contents/.gitlab?ref=main"), GITHUB_TOKEN, None).await.0, 404);
}
