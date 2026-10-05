//! Forks come a page at a time from both forges (the Add remote dialog lazy-loads them).

use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;

fn extra_forks(parent: &str, first_id: u64, n: u64) -> Vec<FakeProject> {
    (0..n)
        .map(|i| FakeProject { id: first_id + i, path: format!("user{i:02}/forked"), default_branch: Some("main".into()), fork_of: Some(parent.into()), updated_at: format!("2026-07-{:02}T00:00:00Z", i + 1), ..Default::default() })
        .collect()
}

async fn pages(p: &dyn ForgeProvider, project: &ForgeProject) -> Vec<(usize, Option<u32>)> {
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let r = p.forks_page(project, page, 10).await.unwrap();
        out.push((r.forks.len(), r.next));
        match r.next {
            Some(n) => page = n,
            None => return out,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_forks_page_ten_at_a_time_newest_first() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.gitlab.projects.extend(extra_forks("group/project", 1000, 23));
    f.seed(seed);
    let p = GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(GITLAB_TOKEN), None);
    let project = p.project("group/project").await.unwrap().value;
    assert_eq!(pages(&p, &project).await, [(10, Some(2)), (10, Some(3)), (5, None)]);
    let first = p.forks_page(&project, 1, 10).await.unwrap();
    assert_eq!(first.forks[0].path, "alice/project", "most recent activity first");
    assert!(f.requests().iter().any(|r| r.path.ends_with("/forks") && r.query == "order_by=last_activity_at&sort=desc&per_page=10&page=1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn github_forks_page_ten_at_a_time() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.github.repos.extend(extra_forks("octo-org/widget", 2000, 24));
    f.seed(seed);
    let p = GitHubProvider::new(GITHUB_HOST, &HostEndpoints { api: f.github_api(), web: f.github_web(), avatars: Some(f.github_avatars()) }, Secret::new(GITHUB_TOKEN), None);
    let project = p.project("octo-org/widget").await.unwrap().value;
    assert_eq!(pages(&p, &project).await, [(10, Some(2)), (10, Some(3)), (5, None)]);
    assert!(f.requests().iter().any(|r| r.path.ends_with("/forks") && r.query == "sort=newest&per_page=10&page=3"));
}
