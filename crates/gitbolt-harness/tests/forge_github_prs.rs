//! The GitHub provider's pull requests against the fake forge (spec #4 §7).

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_harness::fake_forge::*;

fn provider(f: &FakeForge, token: &str) -> GitHubProvider {
    GitHubProvider::new(
        GITHUB_HOST,
        &HostEndpoints {
            api: f.github_api(),
            web: f.github_web(),
            avatars: Some(f.github_avatars()),
        },
        Secret::new(token),
        None,
    )
}

async fn widget(p: &GitHubProvider) -> ForgeProject {
    p.project("octo-org/widget").await.unwrap().value
}

fn numbers(mrs: &[ForgeMr]) -> Vec<u64> {
    mrs.iter().map(|m| m.number).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_open_prs_with_their_checks() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let list = p.open_mrs(&w, MrFilter::All).await.unwrap().value;
    assert_eq!(numbers(&list), [3, 6, 7]);
    assert_eq!(
        list[0].pipeline.as_ref().map(|p| p.status),
        Some(PipelineStatus::Success)
    );
    assert!(list[0]
        .pipeline
        .as_ref()
        .unwrap()
        .web_url
        .as_deref()
        .unwrap()
        .ends_with(&format!("/commit/{:0>40}", 3)));
    assert_eq!(
        (list[1].state, list[1].pipeline.as_ref().map(|p| p.status)),
        (MrState::Draft, Some(PipelineStatus::Running))
    );
    assert_eq!(
        (list[2].pipeline.clone(), list[2].source_project.as_str()),
        (None, "octocat/widget")
    );
    assert_eq!(list[0].review.decision, ReviewDecision::ReviewRequired);
    assert_eq!(
        f.requests()
            .iter()
            .filter(|r| r.path.ends_with("/check-runs"))
            .count(),
        3
    );
    assert_eq!(
        f.requests()
            .iter()
            .filter(|r| r.path.ends_with("/status"))
            .count(),
        3
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mine_and_review_requested_filter_by_the_tokens_user() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    assert_eq!(
        numbers(&p.open_mrs(&w, MrFilter::Mine).await.unwrap().value),
        [6, 7]
    );
    assert_eq!(
        numbers(
            &p.open_mrs(&w, MrFilter::ReviewRequested)
                .await
                .unwrap()
                .value
        ),
        [3]
    );
    assert_eq!(
        f.requests().iter().filter(|r| r.path == "/user").count(),
        1,
        "the user is asked once"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_a_branchs_pr_by_owner_and_branch() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let at = |project: &str, branch: &str| SourceRef {
        project: project.into(),
        branch: branch.into(),
    };
    let old = p
        .mr_for_branch(&w, &at("octo-org/widget", "feature/old"))
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!((old.number, old.state), (4, MrState::Merged));
    assert_eq!(
        p.mr_for_branch(&w, &at("octocat/widget", "fork-fix"))
            .await
            .unwrap()
            .value
            .unwrap()
            .number,
        7
    );
    assert!(p
        .mr_for_branch(&w, &at("octo-org/widget", "fork-fix"))
        .await
        .unwrap()
        .value
        .is_none());
    let asked = f
        .requests()
        .into_iter()
        .find(|r| r.query.contains("head=octocat%3Afork-fix"))
        .unwrap();
    assert!(asked.query.contains("state=all"), "{}", asked.query);
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_details_reviews_and_mergeability() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let d = p.mr_detail(&w, 3).await.unwrap().value;
    assert_eq!(d.description, "Adds the dev work.");
    assert_eq!(
        (d.mr.review.decision, d.mr.review.approvals, d.mr.conflicts),
        (ReviewDecision::Approved, 1, Some(false))
    );
    assert_eq!(
        d.reviewers
            .iter()
            .map(|u| u.username.as_str())
            .collect::<Vec<_>>(),
        ["hubot", "octocat"]
    );
    assert_eq!(d.merge_status, MergeStatus::Mergeable);
    assert_eq!(
        d.mr.pipeline.as_ref().map(|p| p.status),
        Some(PipelineStatus::Success)
    );
    assert_eq!(
        p.mr_detail(&w, 6).await.unwrap().value.merge_status,
        MergeStatus::Blocked {
            reason: "Mark it ready first: it's a draft".into()
        }
    );
    assert_eq!(
        p.mr_detail(&w, 7).await.unwrap().value.merge_status,
        MergeStatus::Blocked {
            reason: "It has conflicts: rebase or merge the base branch first".into()
        }
    );
    assert_eq!(
        p.mr_detail(&w, 404).await.unwrap_err().kind,
        GbErrorKind::NotFound
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_the_conversation_review_threads_and_review_bodies_in_order() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let ds = p.discussions(&w, 3).await.unwrap().value;
    assert_eq!(
        ds.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
        ["issue-41", "review-31", "thread-51", "review-32"]
    );
    let thread = &ds[2];
    assert_eq!(
        thread
            .notes
            .iter()
            .map(|n| n.author.username.as_str())
            .collect::<Vec<_>>(),
        ["hubot", "monalisa"]
    );
    let pos = thread.notes[0].position.as_ref().unwrap();
    assert_eq!(
        (pos.path.as_str(), pos.line, pos.snippet.as_deref()),
        ("README.md", Some(2), Some(" Readme\n+Second line"))
    );
    assert_eq!(ds[1].notes[0].body, "Please add a test.");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forbidden_checks_lookup_leaves_that_pr_without_a_pipeline() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    f.script(Scripted {
        forge: "github".into(),
        method: "GET".into(),
        path: format!("/repos/octo-org/widget/commits/{:0>40}/check-runs", 3),
        status: 403,
        headers: vec![],
        body: serde_json::json!({"message": "Resource not accessible by personal access token"}),
        times: 5,
    });
    let list = p.open_mrs(&w, MrFilter::All).await.unwrap().value;
    assert_eq!(numbers(&list), [3, 6, 7]);
    assert!(list[0].pipeline.is_none());
    assert!(list[1].pipeline.is_some());
    assert!(p
        .mr_detail(&w, 3)
        .await
        .unwrap()
        .value
        .mr
        .pipeline
        .is_none());
}

// --- 4B T5 ---
fn seeded(f: &FakeForge, number: u64) -> github_pulls::FakePull {
    f.current_seed().github.pulls.into_iter().find(|p| p.number == number).unwrap()
}

fn options(method: Option<MergeMethod>, sha: Option<String>) -> MergeOptions {
    MergeOptions { method, squash: None, delete_source_branch: None, expected_sha: sha }
}

#[tokio::test(flavor = "multi_thread")]
async fn replies_to_the_conversation_and_to_a_review_thread() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let n = p.reply(&w, 3, &NewNote { discussion: None, body: "Thanks!".into() }).await.unwrap();
    assert_eq!((n.author.username.as_str(), n.body.as_str()), ("octocat", "Thanks!"));
    p.reply(&w, 3, &NewNote { discussion: Some("thread-51".into()), body: "Got it.".into() }).await.unwrap();
    p.reply(&w, 3, &NewNote { discussion: Some("review-31".into()), body: "Added one.".into() }).await.unwrap();
    let ds = p.discussions(&w, 3).await.unwrap().value;
    let thread = ds.iter().find(|d| d.id == "thread-51").unwrap();
    assert_eq!(thread.notes.last().unwrap().body, "Got it.");
    assert_eq!(seeded(&f, 3).comments.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(), ["Ready for review.", "Thanks!", "Added one."], "a review's summary has no thread: the conversation gets it");
    assert!(f.requests().iter().any(|r| r.method == "POST" && r.path == "/repos/octo-org/widget/pulls/3/comments/51/replies"));
}

#[tokio::test(flavor = "multi_thread")]
async fn approve_and_request_changes_submit_reviews() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    p.approve(&w, 3).await.unwrap();
    let d = p.mr_detail(&w, 3).await.unwrap().value;
    assert_eq!((d.mr.review.decision, d.mr.review.approvals), (ReviewDecision::Approved, 2));
    assert!(d.mr.review.reviews.iter().all(|r| r.state != ReviewState::Pending), "octocat reviewed: no longer requested");
    p.request_changes(&w, 3, "Needs a test.").await.unwrap();
    assert_eq!(p.mr_detail(&w, 3).await.unwrap().value.mr.review.decision, ReviewDecision::ChangesRequested);
    let e = p.request_changes(&w, 3, "").await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::InvalidInput, "GitHub wants a body");
}

#[tokio::test(flavor = "multi_thread")]
async fn merges_with_the_chosen_method_and_refuses_a_moved_head() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let e = p.merge(&w, 7, &options(None, None)).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "GitHub can't merge #7 now: refresh to see why"));
    let before = f.requests().len();
    let e = p.merge(&w, 3, &options(Some(MergeMethod::SemiLinear), None)).await.unwrap_err();
    assert_eq!(e.message, "GitHub can't merge with semi-linear merges");
    assert_eq!(f.requests().len(), before, "refused before asking");
    let e = p.merge(&w, 3, &options(Some(MergeMethod::Squash), Some("dead".repeat(10)))).await.unwrap_err();
    assert_eq!(e.message, "#3 changed since it was loaded: refresh and try again");
    assert!(!seeded(&f, 3).merged);
    let merged = p.merge(&w, 3, &options(Some(MergeMethod::Squash), Some(format!("{:0>40}", 3)))).await.unwrap();
    assert_eq!(merged.state, MrState::Merged);
    assert_eq!(seeded(&f, 3).merged_with, "squash");
}

#[tokio::test(flavor = "multi_thread")]
async fn edits_the_title_body_and_labels() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let m = p.edit(&w, 3, &MrEdit { title: Some("Dev work, part 1".into()), description: Some("New body".into()), labels: Some(vec!["ui".into()]) }).await.unwrap();
    assert_eq!((m.title.as_str(), m.labels.clone()), ("Dev work, part 1", vec!["ui".to_string()]));
    assert_eq!(seeded(&f, 3).body, "New body");
}

#[tokio::test(flavor = "multi_thread")]
async fn draft_and_ready_go_through_graphql() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    assert_eq!(p.set_draft(&w, 3, true).await.unwrap().state, MrState::Draft);
    assert!(f.requests().iter().any(|r| r.method == "POST" && r.path == "/graphql"));
    assert_eq!(p.set_draft(&w, 3, false).await.unwrap().state, MrState::Open);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_graphql_error_says_why() {
    let f = FakeForge::start().await;
    f.script(Scripted { forge: "github".into(), method: "POST".into(), path: "/graphql".into(), status: 200, headers: vec![], body: serde_json::json!({"errors": [{"message": "Resource not accessible by personal access token"}]}), times: 1 });
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let e = p.set_draft(&w, 3, true).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "GitHub: Resource not accessible by personal access token"));
    assert!(!seeded(&f, 3).draft);
}
// --- end 4B T5 ---

// --- 4B final fix ---
#[tokio::test(flavor = "multi_thread")]
async fn a_detail_whose_checks_alone_change_is_not_modified_no_more() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let status = |d: &Fresh<ForgeMrDetail>| d.value.mr.pipeline.as_ref().map(|p| p.status);
    let first = p.mr_detail(&w, 3).await.unwrap();
    assert_eq!((status(&first), first.not_modified), (Some(PipelineStatus::Success), false));
    assert!(p.mr_detail(&w, 3).await.unwrap().not_modified, "every request answered 304");
    let mut seed = f.current_seed();
    let pull = seed.github.pulls.iter_mut().find(|x| x.number == 3).unwrap();
    pull.checks[0].conclusion = Some("failure".into());
    f.seed(seed);
    let after = p.mr_detail(&w, 3).await.unwrap();
    assert_eq!((status(&after), after.not_modified), (Some(PipelineStatus::Failed), false), "the PR itself answered 304, its checks didn't");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_light_list_reads_no_checks() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let list = p.open_mrs_light(&w, MrFilter::All).await.unwrap().value;
    assert_eq!(numbers(&list), [3, 6, 7]);
    assert!(list.iter().all(|m| m.pipeline.is_none()));
    assert!(!f.requests().iter().any(|r| r.path.ends_with("/check-runs") || r.path.ends_with("/status")));
}
// --- end 4B final fix ---
