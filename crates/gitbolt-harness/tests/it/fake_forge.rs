//! The fake forge itself (spec #4 §7): what GitBolt's providers will meet in every forge test.

use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};

/// A blocking GET on the blocking pool (the fake runs on this runtime).
async fn get(url: String, token: Option<&'static str>, etag: Option<String>) -> (u16, Vec<(String, String)>, String) {
    tokio::task::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut req = agent.get(&url).header("User-Agent", "GitBolt/test");
        if let Some(t) = token {
            req = req.header("Authorization", &format!("Bearer {t}"));
        }
        if let Some(e) = etag {
            req = req.header("If-None-Match", &e);
        }
        let mut resp = req.call().unwrap();
        let headers = resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
        (resp.status().as_u16(), headers, resp.body_mut().read_to_string().unwrap_or_default())
    })
    .await
    .unwrap()
}

fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gitlab_user_needs_a_known_token_and_the_log_never_holds_one() {
    let f = FakeForge::start().await;
    let (status, _, _) = get(format!("{}/user", f.gitlab_api()), None, None).await;
    assert_eq!(status, 401);
    let (status, h, body) = get(format!("{}/user", f.gitlab_api()), Some(GITLAB_TOKEN), None).await;
    assert_eq!(status, 200);
    let user: Value = serde_json::from_str(&body).unwrap();
    assert_eq!((user["username"].as_str(), user["name"].as_str()), (Some("ada"), Some("Ada Lovelace")));
    assert_eq!(header(&h, "ratelimit-remaining"), Some("1998"));
    let log = f.requests();
    assert_eq!(log.len(), 2);
    assert!(!log[0].authorized && log[1].authorized);
    assert_eq!(log[1].path, "/api/v4/user");
    assert_eq!(log[1].user_agent.as_deref(), Some("GitBolt/test"));
    assert!(!serde_json::to_string(&log).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_etag_turns_a_repeat_into_a_304() {
    let f = FakeForge::start().await;
    let url = format!("{}/projects/group%2Fproject", f.gitlab_api());
    let (status, h, body) = get(url.clone(), Some(GITLAB_TOKEN), None).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["id"], 42);
    let etag = header(&h, "etag").unwrap().to_string();
    let (status, _, body) = get(url, Some(GITLAB_TOKEN), Some(etag.clone())).await;
    assert_eq!((status, body.as_str()), (304, ""));
    assert_eq!(f.requests()[1].if_none_match.as_deref(), Some(etag.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scripted_answer_is_served_the_given_number_of_times() {
    let f = FakeForge::start().await;
    f.script(Scripted { forge: "gitlab".into(), method: "GET".into(), path: "/api/v4/user".into(), status: 429, headers: vec![("Retry-After".into(), "30".into())], body: json!({"message": "Too Many Requests"}), times: 1 });
    let (status, h, _) = get(format!("{}/user", f.gitlab_api()), Some(GITLAB_TOKEN), None).await;
    assert_eq!((status, header(&h, "retry-after")), (429, Some("30")));
    assert_eq!(get(format!("{}/user", f.gitlab_api()), Some(GITLAB_TOKEN), None).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn forks_are_listed_newest_first_and_paged_with_a_next_link() {
    let f = FakeForge::start().await;
    let (status, h, body) = get(format!("{}/projects/42/forks?per_page=1", f.gitlab_api()), Some(GITLAB_TOKEN), None).await;
    assert_eq!(status, 200);
    let page: Vec<Value> = serde_json::from_str(&body).unwrap();
    assert_eq!(page[0]["path_with_namespace"], "alice/project");
    assert_eq!(page[0]["forked_from_project"]["path_with_namespace"], "group/project");
    let link = header(&h, "link").unwrap();
    assert_eq!(link, format!("<{}/projects/42/forks?per_page=1&page=2>; rel=\"next\"", f.gitlab_api()));
    let (_, h2, body2) = get(format!("{}/projects/42/forks?per_page=1&page=2", f.gitlab_api()), Some(GITLAB_TOKEN), None).await;
    assert_eq!(serde_json::from_str::<Vec<Value>>(&body2).unwrap()[0]["path_with_namespace"], "ada/project");
    assert_eq!(header(&h2, "link"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn github_states_classic_scopes_and_says_nothing_for_fine_grained_tokens() {
    let f = FakeForge::start().await;
    let (_, h, body) = get(format!("{}/user", f.github_api()), Some(GITHUB_TOKEN), None).await;
    assert_eq!(header(&h, "x-oauth-scopes"), Some("repo, read:user"));
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["login"], "octocat");
    let (_, h, _) = get(format!("{}/user", f.github_api()), Some(GITHUB_FINE_TOKEN), None).await;
    assert_eq!(header(&h, "x-oauth-scopes"), None);
    let (status, _, body) = get(format!("{}/repos/octocat/widget", f.github_api()), Some(GITHUB_TOKEN), None).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["parent"]["full_name"], "octo-org/widget");
    let (status, h, _) = get(format!("{}/u/583231?s=80", f.github_avatars()), None, None).await;
    assert_eq!((status, header(&h, "content-type")), (200, Some("image/png")));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_harness_owns_one_and_its_reset_restores_the_default_seed() {
    let h = Harness::for_tests().await;
    let mut seed = h.forge.current_seed();
    seed.gitlab.projects.retain(|p| p.path == "group/project");
    h.forge.seed(seed);
    assert_eq!(h.forge.current_seed().gitlab.projects.len(), 1);
    h.reset();
    assert_eq!(h.forge.current_seed().gitlab.projects.len(), 3);
    assert!(h.forge.requests().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn token_query_params_are_redacted_in_the_log() {
    let f = FakeForge::start().await;
    get(format!("{}/user?private_token=glpat-secret&x=1&access_token=a&token=b", f.gitlab_api()), None, None).await;
    assert_eq!(f.requests()[0].query, "private_token=***&x=1&access_token=***&token=***");
}

#[tokio::test(flavor = "multi_thread")]
async fn github_304s_on_lists_stars_and_weak_tags_and_counts_rate_limits_down() {
    let f = FakeForge::start().await;
    let url = format!("{}/repos/octocat/widget", f.github_api());
    let (_, h, _) = get(url.clone(), Some(GITHUB_TOKEN), None).await;
    assert_eq!((header(&h, "x-ratelimit-remaining"), header(&h, "x-ratelimit-used")), (Some("4999"), Some("1")));
    let etag = header(&h, "etag").unwrap().to_string();
    let strong = etag.trim_start_matches("W/").to_string();
    for inm in [format!("\"nope\", {etag}"), "*".to_string(), strong] {
        assert_eq!(get(url.clone(), Some(GITHUB_TOKEN), Some(inm.clone())).await.0, 304, "{inm}");
    }
    let (_, h, _) = get(url, Some(GITHUB_TOKEN), None).await;
    assert_eq!((header(&h, "x-ratelimit-remaining"), header(&h, "x-ratelimit-used")), (Some("4995"), Some("5")));
    let (_, h, _) = get(format!("{}/user", f.gitlab_api()), Some(GITLAB_TOKEN), None).await;
    assert_eq!(header(&h, "ratelimit-reset"), Some("4102444800"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_huge_page_number_does_not_panic() {
    let f = FakeForge::start().await;
    let (status, _, body) = get(format!("{}/projects/42/forks?per_page=5&page=18446744073709551615", f.gitlab_api()), Some(GITLAB_TOKEN), None).await;
    assert_eq!((status, body.as_str()), (200, "[]"));
    assert_eq!(get(format!("{}/user", f.gitlab_api()), Some(GITLAB_TOKEN), None).await.0, 200);
}
