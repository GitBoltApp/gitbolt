//! The fake forges' list filters 4D's stack code relies on (plan 4D T11).

use gitbolt_harness::fake_forge::*;
use serde_json::Value;

async fn get(url: String, token: &'static str) -> Value {
    tokio::task::spawn_blocking(move || {
        let mut resp = ureq::get(&url).header("Authorization", &format!("Bearer {token}")).call().unwrap();
        serde_json::from_str(&resp.body_mut().read_to_string().unwrap()).unwrap()
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_lists_filter_by_target_branch() {
    let f = FakeForge::start().await;
    let base = format!("{}/projects/42/merge_requests?state=all", f.gitlab_api());
    assert!(!get(format!("{base}&target_branch=main"), GITLAB_TOKEN).await.as_array().unwrap().is_empty());
    assert!(get(format!("{base}&target_branch=no-such-branch"), GITLAB_TOKEN).await.as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn github_lists_filter_by_base() {
    let f = FakeForge::start().await;
    let base = format!("{}/repos/octo-org/widget/pulls?state=all", f.github_api());
    assert!(!get(format!("{base}&base=main"), GITHUB_TOKEN).await.as_array().unwrap().is_empty());
    assert!(get(format!("{base}&base=no-such-branch"), GITHUB_TOKEN).await.as_array().unwrap().is_empty());
}
