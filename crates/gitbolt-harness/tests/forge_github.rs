//! The GitHub provider against the fake forge (spec #4 §7).

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_harness::fake_forge::*;

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
async fn avatars_from_noreply_ids_and_learned_emails_only() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    assert_eq!(p.avatar_for_email("583231+octocat@users.noreply.github.com").await.unwrap().unwrap().mime, "image/png");
    assert_eq!(p.avatar_for_email("octocat@github.example").await.unwrap(), None, "not learned yet: no request");
    p.current_user().await.unwrap();
    assert_eq!(p.avatar_for_email("octocat@github.example").await.unwrap().unwrap().mime, "image/png", "learned from the account's own user");
    assert_eq!(p.avatar_for_email("someone@example.com").await.unwrap(), None);
    assert!(f.requests().iter().all(|r| !r.path.contains("search")), "never a user search by email (30/min, public emails only)");
    let avatar_hits: Vec<_> = f.requests().into_iter().filter(|r| r.forge == "github-avatars").collect();
    assert_eq!(avatar_hits.len(), 2);
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
