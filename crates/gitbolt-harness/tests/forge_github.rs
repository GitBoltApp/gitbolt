//! The GitHub provider against the fake forge (spec #4 §7).

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_harness::fake_forge::*;
// --- GitHub commit-author avatars ---
use gitbolt_harness::fake_forge::github::{LINKED_AUTHOR_EMAIL, UNLINKED_AUTHOR_EMAIL};
// --- end GitHub commit-author avatars ---

fn provider(f: &FakeForge, token: &str) -> GitHubProvider {
    GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(token), None)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_classic_token_needs_repo_and_a_fine_grained_one_is_taken_on_trust() {
    let f = FakeForge::start().await;
    let check = provider(&f, GITHUB_TOKEN).check_token().await.unwrap();
    assert_eq!((check.user.username.as_str(), check.write), ("octocat", WriteAccess::Yes));
    assert_eq!(provider(&f, GITHUB_FINE_TOKEN).check_token().await.unwrap().write, WriteAccess::Unknown);
    assert_eq!(provider(&f, GITHUB_READONLY_TOKEN).check_token().await.unwrap().write, WriteAccess::No { missing: "repo".into() });
    assert_eq!(provider(&f, GITHUB_TOKEN).version().await.unwrap(), None);
    assert!(f.requests().iter().all(|r| r.path == "/user"), "one request per check");
}

#[tokio::test(flavor = "multi_thread")]
async fn maps_a_fork_to_its_parent_lists_forks_and_reads_settings() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let fork = p.project("octocat/widget").await.unwrap().value;
    assert_eq!((fork.id, fork.fork_of.as_deref(), fork.host.as_str()), (502, Some("octo-org/widget"), "github.com"));
    let upstream = p.project("octo-org/widget").await.unwrap().value;
    let forks = p.forks(&upstream).await.unwrap();
    assert_eq!(forks.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["octocat/widget"]);
    assert_eq!(p.project_settings(&upstream).await.unwrap().merge_methods, vec![MergeMethod::Merge, MergeMethod::Squash]);
    let e = p.project("group/sub/project").await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "group/sub/project isn't an owner/repository path"));
    assert!(f.requests().iter().all(|r| r.path != "/repos/group/sub/project"), "never sent");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_linked_avatar_comes_only_from_githubs_avatar_host_without_the_token() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let octocat = format!("{}/u/583231?v=4", f.github_avatars());
    assert_eq!(p.avatar_at(&octocat).unwrap().await.unwrap().unwrap().mime, "image/png");
    let hits: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-avatars").collect();
    assert_eq!(hits.len(), 1);
    assert!(!hits[0].authorized, "an avatar CDN never gets the token");
    for elsewhere in [format!("{}/user", f.github_api()), format!("{}/octocat.png", f.github_web()), "https://evil.example.com/u/1".to_string()] {
        assert!(p.avatar_at(&elsewhere).is_none(), "{elsewhere}");
    }
    assert_eq!(f.requests().len(), 1, "nothing else was asked");
}

#[tokio::test(flavor = "multi_thread")]
async fn avatars_from_noreply_ids_and_learned_emails_only() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    assert_eq!(p.avatar_for_email("583231+octocat@users.noreply.github.com").await.unwrap().unwrap().mime, "image/png");
    assert_eq!(p.avatar_for_email("oldstyle@users.noreply.github.com").await.unwrap().unwrap().mime, "image/png", "the older form, by login");
    assert_eq!(p.avatar_for_email("octocat@github.example").await.unwrap(), None, "not learned yet: no request");
    p.current_user().await.unwrap();
    assert_eq!(p.avatar_for_email("octocat@github.example").await.unwrap().unwrap().mime, "image/png", "learned from the account's own user");
    assert_eq!(p.avatar_for_email("someone@example.com").await.unwrap(), None);
    assert!(f.requests().iter().all(|r| !r.path.contains("search")), "never a user search by email (30/min, public emails only)");
    let avatar_hits: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-avatars").collect();
    assert_eq!(avatar_hits.len(), 3);
    assert!(avatar_hits.iter().any(|r| r.path.ends_with("/oldstyle")), "asked by login");
    assert!(avatar_hits.iter().all(|r| !r.authorized), "avatars.githubusercontent.com never gets the token");
}

#[tokio::test(flavor = "multi_thread")]
async fn githubs_403_with_no_requests_left_is_a_rate_limit() {
    let f = FakeForge::start().await;
    // The client clamps a wait to an hour, so the reset must be near for it to be reported as given.
    let reset = gitbolt_forge::time::unix_now() + 1800;
    f.script(Scripted { forge: "github".into(), method: "GET".into(), path: "/user".into(), status: 403, headers: vec![("x-ratelimit-remaining".into(), "0".into()), ("x-ratelimit-reset".into(), reset.to_string())], body: serde_json::json!({"message": "API rate limit exceeded"}), times: 1 });
    let p = provider(&f, GITHUB_TOKEN);
    let e = p.current_user().await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::RateLimited);
    assert_eq!(p.rate_limit().limited_until, Some(reset));
}

// --- GitHub commit-author avatars ---
fn author_lookups(f: &FakeForge) -> usize {
    f.requests().iter().filter(|r| r.forge == "github" && r.path.ends_with("/commits") && r.query.contains("author=")).count()
}

fn cached_provider(f: &FakeForge, dir: &std::path::Path) -> GitHubProvider {
    let cache = std::sync::Arc::new(gitbolt_forge::avatar_cache::DiskAvatarCache::new(dir.join(GITHUB_HOST)));
    GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(GITHUB_TOKEN), Some(cache))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_email_is_asked_once_of_the_projects_commits_and_its_linked_picture_kept() {
    let f = FakeForge::start().await;
    let dir = tempfile::tempdir().unwrap();
    let p = cached_provider(&f, dir.path());
    let project = p.project("octo-org/widget").await.unwrap().value;
    assert_eq!(p.avatar_for_email(LINKED_AUTHOR_EMAIL).await.unwrap(), None, "the first step doesn't know it");

    assert_eq!(p.avatar_for_email_in(&project, LINKED_AUTHOR_EMAIL).await.unwrap().unwrap().mime, "image/png");
    assert_eq!(author_lookups(&f), 1);
    let ask = f.requests().into_iter().find(|r| r.path.ends_with("/commits")).unwrap();
    assert_eq!((ask.path.as_str(), ask.authorized), ("/repos/octo-org/widget/commits", true));
    assert!(ask.query.contains("per_page=1"), "{}", ask.query);
    let pic: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-avatars").collect();
    assert_eq!(pic.len(), 1);
    assert!(pic[0].path.ends_with("/u/4242") && !pic[0].authorized, "the linked account's picture, without the token");

    // Learned: the first step knows it now, and the third answers from the cache.
    assert!(p.avatar_for_email(LINKED_AUTHOR_EMAIL).await.unwrap().is_some());
    assert!(p.avatar_for_email_in(&project, LINKED_AUTHOR_EMAIL).await.unwrap().is_some());
    assert_eq!(author_lookups(&f), 1, "asked once");
    // A new session: the disk cache answers, without a request.
    let next = cached_provider(&f, dir.path());
    let before = f.requests().len();
    assert!(next.avatar_for_email_in(&project, LINKED_AUTHOR_EMAIL).await.unwrap().is_some());
    assert_eq!(f.requests().len(), before, "from disk");
    assert!(f.requests().iter().all(|r| !r.path.contains("search")), "never the search API");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_email_without_a_linked_account_is_none_and_not_asked_again() {
    let f = FakeForge::start().await;
    let dir = tempfile::tempdir().unwrap();
    let p = cached_provider(&f, dir.path());
    let project = p.project("octo-org/widget").await.unwrap().value;
    for email in [UNLINKED_AUTHOR_EMAIL, "stranger@personal.example"] {
        assert_eq!(p.avatar_for_email_in(&project, email).await.unwrap(), None, "{email}");
        assert_eq!(p.avatar_for_email_in(&project, &email.to_uppercase()).await.unwrap(), None, "{email}");
    }
    assert_eq!(author_lookups(&f), 2, "one each: a null author, and no commits at all");
    let next = cached_provider(&f, dir.path());
    assert_eq!(next.avatar_for_email_in(&project, UNLINKED_AUTHOR_EMAIL).await.unwrap(), None);
    assert_eq!(author_lookups(&f), 2, "the miss is on disk too");
    assert!(f.requests().iter().all(|r| r.forge != "github-avatars" && !r.path.contains("search")));
    // Noreply addresses are the first step's.
    assert_eq!(p.avatar_for_email_in(&project, "oldstyle@users.noreply.github.com").await.unwrap(), None);
    assert_eq!(author_lookups(&f), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_commit_author_lookup_under_500_requests_left() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let project = p.project("octo-org/widget").await.unwrap().value;
    let user = serde_json::json!({"id": 583231, "login": "octocat", "name": null, "avatar_url": null, "html_url": "x", "email": null});
    f.script(Scripted { forge: "github".into(), method: "GET".into(), path: "/user".into(), status: 200, headers: vec![("x-ratelimit-remaining".into(), "499".into()), ("x-ratelimit-reset".into(), "4102444800".into())], body: user, times: 1 });
    p.current_user().await.unwrap();
    assert_eq!(p.avatar_for_email_in(&project, LINKED_AUTHOR_EMAIL).await.unwrap(), None);
    assert_eq!(author_lookups(&f), 0, "the budget is kept for the rest");
    // Not counted as asked: once the budget is back, it's asked.
    p.current_user().await.unwrap();
    assert!(p.avatar_for_email_in(&project, LINKED_AUTHOR_EMAIL).await.unwrap().is_some());
    assert_eq!(author_lookups(&f), 1);
}
// --- end GitHub commit-author avatars ---
