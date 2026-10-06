//! Commit-author avatars by name (GitLab): an author whose email isn't public on the forge gets
//! the picture of the one forge user with that exact name, learned from MR data or found by a
//! `/users?search=` by name. Never a search by email. The fake forge only.

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_core::testing::TestRepo;
use gitbolt_forge::avatar_cache::DiskAvatarCache;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::gitlab_mrs::FakeMergeRequest;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};
use std::sync::Arc;

/// The commit author's email: not public on the forge (`/avatar?email=` has nothing for it).
const EMAIL: &str = "margaret@personal.example";
const NAME: &str = "Margaret Hamilton";

fn provider(f: &FakeForge, avatars: Option<Arc<DiskAvatarCache>>) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(GITLAB_TOKEN), avatars).with_change_counter(f.change_counter())
}

fn margaret(f: &FakeForge, id: u64) -> FakeUser {
    FakeUser { id, username: format!("mham{id}"), name: NAME.into(), email: None, avatar_url: Some(format!("{}/uploads/m{id}.png", f.gitlab_web())) }
}

fn authored_by(iid: u64, username: &str) -> FakeMergeRequest {
    FakeMergeRequest {
        iid,
        project: "group/project".into(),
        source_branch: format!("apollo-{iid}"),
        target_branch: "main".into(),
        title: "Apollo guidance".into(),
        state: "opened".into(),
        author: username.into(),
        head_sha: format!("{iid:0>40}"),
        merge_status: "mergeable".into(),
        updated_at: "2026-10-04T11:00:00Z".into(),
        ..Default::default()
    }
}

/// Margarets as forge users (none with a public email), each the author of an MR when `in_mrs`.
fn seed(f: &FakeForge, ids: &[u64], in_mrs: bool) {
    let mut s = f.current_seed();
    for (i, id) in ids.iter().enumerate() {
        let m = margaret(f, *id);
        if in_mrs {
            s.gitlab.merge_requests.push(authored_by(30 + i as u64, &m.username));
        }
        s.gitlab.users.push(m);
    }
    f.seed(s);
}

fn searches(f: &FakeForge) -> Vec<String> {
    f.requests().into_iter().filter(|r| r.path == "/api/v4/users").map(|r| r.query).collect()
}

/// Only `/avatar?email=` (the first step, as before) ever carries an email.
fn assert_no_email_in_queries(f: &FakeForge) {
    for r in f.requests() {
        if r.path != "/api/v4/avatar" {
            let q = r.query.to_lowercase();
            assert!(!q.contains("personal.example") && !q.contains("margaret%40") && !q.contains("margaret@"), "{} {}", r.path, r.query);
        }
    }
}

fn cache(dir: &tempfile::TempDir) -> Arc<DiskAvatarCache> {
    Arc::new(DiskAvatarCache::new(dir.path().join(GITLAB_HOST)))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_mr_authors_name_gives_a_commit_author_their_picture_with_no_search() {
    let f = FakeForge::start().await;
    seed(&f, &[21], true);
    let dir = tempfile::tempdir().unwrap();
    let p = provider(&f, Some(cache(&dir)));
    assert_eq!(p.avatar_for_email(EMAIL).await.unwrap(), None, "the email isn't public");
    let project = p.project("group/project").await.unwrap().value;
    p.open_mrs(&project, MrFilter::All).await.unwrap();
    let found = p.avatar_for_name(EMAIL, "  margaret   HAMILTON ").await.unwrap().unwrap();
    assert_eq!(found.mime, "image/png");
    assert!(searches(&f).is_empty(), "known from the MR list: no search");
    assert!(f.requests().iter().any(|r| r.path == "/uploads/m21.png"));
    assert_eq!(p.avatar_for_name(EMAIL, "Margaret").await.unwrap(), Some(found.clone()), "kept under the email");

    // A second ask, and the next session: from the disk cache, no request at all.
    f.clear_requests();
    assert_eq!(p.avatar_for_email(EMAIL).await.unwrap(), Some(found.clone()));
    assert_eq!(p.avatar_for_name(EMAIL, NAME).await.unwrap(), Some(found.clone()));
    let next = provider(&f, Some(cache(&dir)));
    assert_eq!(next.avatar_for_email(EMAIL).await.unwrap(), Some(found));
    assert!(f.requests().is_empty(), "{:?}", f.requests());
    assert_no_email_in_queries(&f);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_never_seen_is_searched_once_by_name_only() {
    let f = FakeForge::start().await;
    seed(&f, &[21], false);
    let dir = tempfile::tempdir().unwrap();
    let p = provider(&f, Some(cache(&dir)));
    assert_eq!(p.avatar_for_email(EMAIL).await.unwrap(), None);
    let found = p.avatar_for_name(EMAIL, NAME).await.unwrap().unwrap();
    assert_eq!(found.mime, "image/png");
    assert_eq!(searches(&f), ["search=margaret%20hamilton&per_page=5"]);
    // A second ask: no new request.
    let before = f.requests().len();
    assert_eq!(p.avatar_for_name(EMAIL, NAME).await.unwrap(), Some(found.clone()));
    assert_eq!(p.avatar_for_email(EMAIL).await.unwrap(), Some(found));
    assert_eq!(f.requests().len(), before);

    // Nobody by that name: one search a session, then "none" on disk for a while.
    let stranger = "stranger@personal.example";
    assert_eq!(p.avatar_for_name(stranger, "Nobody Known").await.unwrap(), None);
    assert_eq!(p.avatar_for_name(stranger, "nobody known").await.unwrap(), None);
    assert_eq!(searches(&f).len(), 2);
    let next = provider(&f, Some(cache(&dir)));
    assert_eq!(next.avatar_for_name(stranger, "Nobody Known").await.unwrap(), None);
    assert_eq!(searches(&f).len(), 2, "the miss is remembered");
    // A part of a name is no match: the search finds Margaret Hamilton, who isn't "Margaret".
    assert_eq!(next.avatar_for_name(stranger, "Margaret").await.unwrap(), None);
    assert_eq!(searches(&f).len(), 3);
    assert_no_email_in_queries(&f);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_people_with_the_name_give_no_picture() {
    let f = FakeForge::start().await;
    // Both known from MRs: no guess, and no search.
    seed(&f, &[21, 22], true);
    let p = provider(&f, None);
    let project = p.project("group/project").await.unwrap().value;
    p.open_mrs(&project, MrFilter::All).await.unwrap();
    assert_eq!(p.avatar_for_name(EMAIL, NAME).await.unwrap(), None);
    assert!(searches(&f).is_empty());
    assert!(f.requests().iter().all(|r| !r.path.starts_with("/uploads/")));

    // Both found by the search: none either.
    let f = FakeForge::start().await;
    seed(&f, &[21, 22], false);
    let p = provider(&f, None);
    assert_eq!(p.avatar_for_name(EMAIL, NAME).await.unwrap(), None);
    assert_eq!(p.avatar_for_name(EMAIL, NAME).await.unwrap(), None);
    assert_eq!(searches(&f).len(), 1, "asked once");
    assert!(f.requests().iter().all(|r| !r.path.starts_with("/uploads/")));
    assert_no_email_in_queries(&f);
}

// --- Through the API: the graph's avatar request ---
async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

#[tokio::test(flavor = "multi_thread")]
async fn the_graphs_author_avatar_comes_by_name_after_the_mr_list_or_a_search() {
    let h = Harness::for_tests().await;
    seed(&h.forge, &[21], true);
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", "https://gitlab.example.com/group/project.git"]);
    let id = call(&h.api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap();
    let avatar = |email: &str, name: Option<&str>| {
        let params = match name { Some(n) => json!({"email": email, "repo": id, "name": n}), None => json!({"email": email, "repo": id}) };
        call(&h.api, json!({"method": "avatar", "params": params}))
    };
    call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "all"}})).await.unwrap();
    assert!(avatar(EMAIL, None).await.unwrap().is_null(), "no name: no name step");
    assert_eq!(avatar(EMAIL, Some(NAME)).await.unwrap()["mime"], "image/png");
    assert!(searches(&h.forge).is_empty(), "learned from the MR list");
    // Asked again (with or without the name): no lookup by email or name again. Outside a tab no
    // forge is asked at all.
    let lookups = |f: &FakeForge| f.requests().iter().filter(|r| r.path == "/api/v4/avatar" || r.path == "/api/v4/users").count();
    let before = lookups(&h.forge);
    assert_eq!(avatar(EMAIL, Some(NAME)).await.unwrap()["mime"], "image/png");
    assert_eq!(avatar(EMAIL, None).await.unwrap()["mime"], "image/png");
    assert!(call(&h.api, json!({"method": "avatar", "params": {"email": EMAIL}})).await.unwrap().is_null());
    assert_eq!(lookups(&h.forge), before);

    // An author no MR names: one search by name.
    let mut s = h.forge.current_seed();
    s.gitlab.users.push(FakeUser { id: 40, username: "kjohnson".into(), name: "Katherine Johnson".into(), email: None, avatar_url: Some(format!("{}/uploads/k.png", h.forge.gitlab_web())) });
    h.forge.seed(s);
    assert_eq!(avatar("katherine@personal.example", Some("Katherine Johnson")).await.unwrap()["mime"], "image/png");
    assert!(avatar("katherine@personal.example", Some("Katherine Johnson")).await.unwrap().is_object());
    assert_eq!(searches(&h.forge), ["search=katherine%20johnson&per_page=5"]);
    assert_no_email_in_queries(&h.forge);
    let log = serde_json::to_string(&h.forge.requests()).unwrap();
    assert!(!log.contains(GITLAB_TOKEN));
}

// --- GitHub: the free step only (a PR list's users carry logins) ---
#[tokio::test(flavor = "multi_thread")]
async fn a_github_pr_authors_login_names_a_commit_author_with_no_search() {
    use gitbolt_forge::github::GitHubProvider;
    let f = FakeForge::start().await;
    let mut s = f.current_seed();
    for u in &mut s.github.users {
        u.avatar_url = Some(format!("{}/u/{}", f.github_avatars(), u.id));
    }
    f.seed(s);
    let p = GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(GITHUB_TOKEN), None);
    let email = "mona@personal.example";
    assert_eq!(p.avatar_for_name(email, "monalisa").await.unwrap(), None, "nobody seen yet");
    assert!(f.requests().is_empty(), "and no search");
    let project = p.project("octo-org/widget").await.unwrap().value;
    p.open_mrs(&project, MrFilter::All).await.unwrap();
    assert_eq!(p.avatar_for_name(email, "MonaLisa").await.unwrap().unwrap().mime, "image/png");
    let fetched: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-avatars").collect();
    assert_eq!(fetched.len(), 1);
    assert!(!fetched[0].authorized, "the avatar host never gets the token");
    assert!(p.avatar_for_email(email).await.unwrap().is_some(), "learned under the email");
    assert!(f.requests().iter().all(|r| !r.path.contains("search") && !r.query.contains("personal.example")));
}
