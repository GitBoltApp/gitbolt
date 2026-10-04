//! The GitLab provider against the fake forge (spec #4 §7): no real forge, ever.

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::avatar_cache::DiskAvatarCache;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;
use std::sync::Arc;

fn provider(f: &FakeForge, token: &str, avatars: Option<Arc<DiskAvatarCache>>) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(token), avatars)
}

#[tokio::test(flavor = "multi_thread")]
async fn checks_a_token_reads_its_user_its_scope_and_the_version() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN, None);
    let check = p.check_token().await.unwrap();
    assert_eq!((check.user.username.as_str(), check.user.name.as_str(), check.write), ("ada", "Ada Lovelace", WriteAccess::Yes));
    assert_eq!(check.user.email.as_deref(), Some("ada@example.com"));
    assert_eq!(p.version().await.unwrap().as_deref(), Some("18.9.1-ee"));
    let ro = provider(&f, GITLAB_READONLY_TOKEN, None).check_token().await.unwrap();
    assert_eq!(ro.write, WriteAccess::No { missing: "api".into() });
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_token_is_auth_failed_and_never_echoed_anywhere() {
    let f = FakeForge::start().await;
    let wrong = "glpat-FAKE-wrong-token";
    let e = provider(&f, wrong, None).check_token().await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::AuthFailed);
    assert!(!e.message.contains(wrong) && !format!("{e:?}").contains(wrong));
    let log = serde_json::to_string(&f.requests()).unwrap();
    assert!(!log.contains(wrong) && !log.contains(GITLAB_TOKEN), "{log}");
    assert!(f.requests().iter().all(|r| r.user_agent.as_deref().is_some_and(|ua| ua.starts_with("GitBolt/"))));
}

#[tokio::test(flavor = "multi_thread")]
async fn maps_a_project_with_its_parent_and_settings_and_rereads_it_with_an_etag() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN, None);
    let fork = p.project("alice/project").await.unwrap();
    assert_eq!((fork.value.id, fork.value.fork_of.as_deref(), fork.value.default_branch.as_deref()), (77, Some("group/project"), Some("main")));
    assert_eq!(fork.value.host, GITLAB_HOST);
    assert!(!fork.not_modified);
    let again = p.project("alice/project").await.unwrap();
    assert!(again.not_modified, "a 304 the second time");
    assert_eq!(again.value, fork.value);
    let settings = p.project_settings(&fork.value).await.unwrap();
    assert_eq!(settings, ForgeProjectSettings { merge_methods: vec![MergeMethod::Merge], squash: SquashOption::DefaultOff, delete_source_branch: true });
    let missing = p.project("nobody/nothing").await.unwrap_err();
    assert_eq!((missing.kind, missing.message.as_str()), (GbErrorKind::NotFound, "Not found on gitlab.example.com"));
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_forks_newest_first() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN, None);
    let project = p.project("group/project").await.unwrap().value;
    let forks = p.forks(&project).await.unwrap();
    assert_eq!(forks.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["alice/project", "ada/project"]);
    let asked = f.requests().into_iter().find(|r| r.path.ends_with("/forks")).unwrap();
    assert_eq!(asked.query, "per_page=100&order_by=last_activity_at&sort=desc");
}

#[tokio::test(flavor = "multi_thread")]
async fn avatars_come_from_the_forge_are_cached_and_never_from_another_host() {
    let f = FakeForge::start().await;
    let dir = tempfile::tempdir().unwrap();
    let cache = Arc::new(DiskAvatarCache::new(dir.path().join(GITLAB_HOST)));
    let p = provider(&f, GITLAB_TOKEN, Some(cache.clone()));
    let ada = p.avatar_for_email("Ada@Example.com").await.unwrap().unwrap();
    assert_eq!(ada.mime, "image/png");
    let asked = |f: &FakeForge| f.requests().iter().filter(|r| r.path == "/api/v4/avatar").count();
    assert_eq!(asked(&f), 1);
    assert_eq!(p.avatar_for_email("ada@example.com").await.unwrap(), Some(ada), "from the disk cache");
    assert_eq!(asked(&f), 1);
    // Grace's avatar_url is on secure.gravatar.com: GitBolt's own Gravatar lookup handles that.
    assert_eq!(p.avatar_for_email("grace@example.com").await.unwrap(), None);
    assert!(f.requests().iter().all(|r| !r.path.contains("gravatar")));
    assert_eq!(p.avatar_for_email("nobody@example.com").await.unwrap(), None);
    p.avatar_for_email("nobody@example.com").await.unwrap();
    assert_eq!(asked(&f), 3, "a miss is remembered");
    let uploads = f.requests().into_iter().find(|r| r.path.starts_with("/uploads/")).unwrap();
    assert!(uploads.authorized, "an image on the forge itself gets the token (private instances)");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scripted_429_rate_limits_the_account() {
    let f = FakeForge::start().await;
    f.script(Scripted { forge: "gitlab".into(), method: "GET".into(), path: "/api/v4/user".into(), status: 429, headers: vec![("Retry-After".into(), "90".into())], body: serde_json::json!({"message": "Too Many Requests"}), times: 1 });
    let p = provider(&f, GITLAB_TOKEN, None);
    let e = p.current_user().await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::RateLimited);
    assert!(p.rate_limit().limited_until.is_some());
    assert_eq!(p.version().await.unwrap_err().kind, GbErrorKind::RateLimited, "fails fast");
    assert_eq!(f.requests().len(), 1);
}
