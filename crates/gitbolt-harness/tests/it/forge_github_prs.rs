//! The GitHub provider's pull requests against the fake forge (spec #4 §7).

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::github::GitHubProvider;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::fake_forge::github_pulls::FakeReviewComment;

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
    .with_change_counter(f.change_counter())
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
    // Every PR's checks in one GraphQL query, none per PR.
    let count = |f: &FakeForge, end: &str| f.requests().iter().filter(|r| r.path.ends_with(end)).count();
    assert_eq!((count(&f, "/graphql"), count(&f, "/check-runs"), count(&f, "/status")), (1, 0, 0));
    // A poll that changes nothing asks again only for the running one's head (#6).
    p.open_mrs(&w, MrFilter::All).await.unwrap();
    assert_eq!(count(&f, "/graphql"), 2);
    let mut seed = f.current_seed();
    let six = seed.github.pulls.iter_mut().find(|x| x.number == 6).unwrap();
    six.checks[0] = gitbolt_harness::fake_forge::github_pulls::FakeCheck { name: "build".into(), status: "completed".into(), conclusion: Some("success".into()) };
    six.statuses.clear();
    f.seed(seed);
    let list = p.open_mrs(&w, MrFilter::All).await.unwrap().value;
    assert_eq!(list[1].pipeline.as_ref().map(|p| p.status), Some(PipelineStatus::Success));
    p.open_mrs(&w, MrFilter::Mine).await.unwrap();
    assert_eq!(count(&f, "/graphql"), 3, "all settled: the next lists ask no checks");
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
async fn a_multi_line_review_comment_has_its_range_and_its_lines() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let mut seed = f.current_seed();
    let pr = seed.github.pulls.iter_mut().find(|p| p.number == 3).unwrap();
    pr.review_comments.push(FakeReviewComment {
        id: 53,
        user: "hubot".into(),
        body: "These go together.".into(),
        created_at: "2026-10-03T10:00:00Z".into(),
        path: "src/lib.rs".into(),
        line: Some(5),
        side: "RIGHT".into(),
        start_line: Some(2),
        start_side: Some("RIGHT".into()),
        diff_hunk: "@@ -1,2 +1,5 @@\n fn a() {}\n+fn b() {}\n+fn c() {}\n+fn d() {}\n fn e() {}".into(),
        ..Default::default()
    });
    f.seed(seed);
    let ds = p.discussions(&w, 3).await.unwrap().value;
    let pos = ds.iter().find(|d| d.id == "thread-53").unwrap().notes[0].position.as_ref().unwrap();
    assert_eq!((pos.start_line, pos.start_old_line, pos.line, pos.old_line), (Some(2), None, Some(5), None));
    assert_eq!(pos.snippet.as_deref(), Some("+fn b() {}\n+fn c() {}\n+fn d() {}\n fn e() {}"));
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
    // GraphQL refused too: the list falls back to REST's lookups per head.
    f.script(Scripted {
        forge: "github".into(),
        method: "POST".into(),
        path: "/graphql".into(),
        status: 403,
        headers: vec![],
        body: serde_json::json!({"message": "Resource not accessible by personal access token"}),
        times: 1,
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
    MergeOptions { method, expected_sha: sha, ..Default::default() }
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
    let m = p.edit(&w, 3, &MrEdit { title: Some("Dev work, part 1".into()), description: Some("New body".into()), labels: Some(vec!["ui".into()]), ..Default::default() }).await.unwrap();
    assert_eq!((m.title.as_str(), m.labels.clone()), ("Dev work, part 1", vec!["ui".to_string()]));
    assert_eq!(seeded(&f, 3).body, "New body");
}

fn people(add: &[u64], remove: &[u64]) -> Option<PeopleEdit> {
    Some(PeopleEdit { add: add.to_vec(), remove: remove.to_vec() })
}

const OCTOCAT: u64 = 583231;
const HUBOT: u64 = 3;

#[tokio::test(flavor = "multi_thread")]
async fn adds_and_removes_reviewers_and_assignees() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    // #3: octocat's review is requested; hubot reviewed (asking again re-requests it).
    p.edit(&w, 3, &MrEdit { reviewers: people(&[HUBOT], &[OCTOCAT]), assignees: people(&[HUBOT], &[]), ..Default::default() }).await.unwrap();
    let s = seeded(&f, 3);
    assert_eq!((s.requested_reviewers, s.assignees), (vec!["hubot".to_string()], vec!["hubot".to_string()]));
    let calls: Vec<(String, String)> = f.requests().into_iter().filter(|r| r.method == "POST" || r.method == "DELETE").map(|r| (r.method, r.path)).collect();
    assert_eq!(calls, [
        ("DELETE".to_string(), "/repos/octo-org/widget/pulls/3/requested_reviewers".to_string()),
        ("POST".to_string(), "/repos/octo-org/widget/pulls/3/requested_reviewers".to_string()),
        ("POST".to_string(), "/repos/octo-org/widget/issues/3/assignees".to_string()),
    ]);
    p.edit(&w, 3, &MrEdit { assignees: people(&[], &[HUBOT]), ..Default::default() }).await.unwrap();
    assert!(seeded(&f, 3).assignees.is_empty());
    // The view's detail reads the change (the write expired the fresh answers).
    let d = p.mr_detail(&w, 3).await.unwrap().value;
    assert!(d.assignees.is_empty());
    assert!(d.mr.review.reviews.iter().any(|r| r.user.username == "hubot" && r.state == ReviewState::Pending));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reviewer_who_reviewed_stays_and_refusals_say_why() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let e = p.edit(&w, 3, &MrEdit { reviewers: people(&[], &[HUBOT]), ..Default::default() }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "hubot already reviewed: GitHub keeps a submitted review, so they stay a reviewer"));
    assert!(!f.requests().iter().any(|r| r.method == "DELETE"), "refused before any write");
    // Not a collaborator (monalisa, id 2): GitHub's 422 says so; not assignable: dropped, named.
    let e = p.edit(&w, 6, &MrEdit { reviewers: people(&[2], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!(e.kind, GbErrorKind::InvalidInput);
    assert!(e.message.starts_with("github.com: Reviews may only be requested from collaborators."), "{}", e.message);
    let e = p.edit(&w, 6, &MrEdit { assignees: people(&[2], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!(e.message, "GitHub didn't assign monalisa: they can't be assigned in octo-org/widget");
    let e = p.edit(&w, 6, &MrEdit { assignees: people(&[424242], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "github.com has no user 424242"));
    // No permission: the 403's reason.
    f.script(Scripted { forge: "github".into(), method: "POST".into(), path: "/repos/octo-org/widget/issues/6/assignees".into(), status: 403, headers: vec![], body: serde_json::json!({"message": "Resource not accessible by personal access token"}), times: 1 });
    let e = p.edit(&w, 6, &MrEdit { assignees: people(&[HUBOT], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::AuthFailed, "github.com refused: Resource not accessible by personal access token"));
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

// --- auto-merge ---
/// #3 with its checks running (branch protection blocks it until they pass).
fn running(f: &FakeForge, allow_auto_merge: Option<bool>) {
    let mut seed = f.current_seed();
    let pr = seed.github.pulls.iter_mut().find(|p| p.number == 3).unwrap();
    pr.checks[0].status = "in_progress".into();
    pr.checks[0].conclusion = None;
    pr.mergeable_state = "blocked".into();
    if let Some(allow) = allow_auto_merge {
        let repo = seed.github.repos.iter_mut().find(|r| r.path == "octo-org/widget").unwrap();
        repo.settings = serde_json::json!({ "allow_auto_merge": allow });
    }
    f.seed(seed);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_merge_is_enabled_with_the_method_read_back_and_disabled() {
    let f = FakeForge::start().await;
    running(&f, Some(true));
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let head = seeded(&f, 3).head_sha;
    let opts = options(Some(MergeMethod::Squash), Some(head));
    let m = p.set_auto_merge(&w, 3, &opts).await.unwrap();
    let a = m.auto_merge.unwrap();
    assert_eq!((a.enabled_by.map(|u| u.username), a.method, m.state), (Some("octocat".into()), Some(MergeMethod::Squash), MrState::Open));
    let s = seeded(&f, 3).auto_merge.unwrap();
    assert_eq!((s.commit_title.as_deref(), s.commit_message.as_deref()), (None, None), "GitHub's own message");
    assert!(p.open_mrs(&w, MrFilter::All).await.unwrap().value.iter().find(|m| m.number == 3).unwrap().auto_merge.is_some(), "the list shows it too");
    assert_eq!(p.cancel_auto_merge(&w, 3).await.unwrap().auto_merge, None);
    assert_eq!(seeded(&f, 3).auto_merge, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_merge_refusals_say_why() {
    let f = FakeForge::start().await;
    running(&f, Some(false));
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let e = p.set_auto_merge(&w, 3, &options(Some(MergeMethod::Merge), None)).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "Auto-merge isn't enabled for this repository"));
    running(&f, Some(true));
    let e = p.set_auto_merge(&w, 3, &options(Some(MergeMethod::Merge), Some("dead".repeat(10)))).await.unwrap_err();
    assert_eq!(e.message, "#3 changed since it was loaded: refresh and try again");
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let e = p.set_auto_merge(&w, 3, &options(Some(MergeMethod::Merge), None)).await.unwrap_err();
    assert_eq!(e.message, "#3 can merge now: use Merge", "its checks passed");
    assert_eq!(seeded(&f, 3).auto_merge, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_leaves_the_title_and_message_to_github() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    p.merge(&w, 3, &options(Some(MergeMethod::Merge), None)).await.unwrap();
    let s = seeded(&f, 3);
    assert_eq!((s.merge_title, s.merge_message), (None, None));
}
// --- end auto-merge ---

// --- MR round 2 ---
#[tokio::test(flavor = "multi_thread")]
async fn the_review_composer_posts_one_review_with_its_event_and_message() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let before = seeded(&f, 3).reviews.len();
    for (event, body) in [(ReviewEvent::Comment, "A note"), (ReviewEvent::Approve, "Nice work"), (ReviewEvent::Approve, ""), (ReviewEvent::RequestChanges, "Rename it")] {
        assert!(!p.review(&w, 3, &ReviewSubmit { event, body: body.into() }).await.unwrap().fallback);
    }
    let added: Vec<(String, String)> = seeded(&f, 3).reviews.into_iter().skip(before).map(|r| (r.state, r.body)).collect();
    let want = [("COMMENTED", "A note"), ("APPROVED", "Nice work"), ("APPROVED", ""), ("CHANGES_REQUESTED", "Rename it")];
    assert_eq!(added, want.map(|(s, b)| (s.to_string(), b.to_string())));
    let posts = f.requests().into_iter().filter(|r| r.method == "POST").count();
    assert_eq!(posts, 4, "one request each");
}

#[tokio::test(flavor = "multi_thread")]
async fn github_caps_assignees_at_ten() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    assert_eq!(p.people_limits(&w).await.unwrap(), PeopleLimits { max_reviewers: None, max_assignees: Some(10) });
    assert!(f.requests().iter().all(|r| r.path != "/graphql"), "no request");
}

#[tokio::test(flavor = "multi_thread")]
async fn notifications_are_read_once_per_change_and_toggled() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.github.pulls.iter_mut().find(|p| p.number == 3).unwrap().base_sha = "c".repeat(40);
    f.seed(seed);
    let p = provider(&f, GITHUB_TOKEN);
    let w = widget(&p).await;
    let d = p.mr_detail(&w, 3).await.unwrap().value;
    assert_eq!((d.subscribed, d.base_sha), (Some(false), Some("c".repeat(40))));
    f.clear_requests();
    p.http().expire_fresh();
    p.mr_detail(&w, 3).await.unwrap();
    assert!(f.requests().iter().all(|r| r.path != "/graphql"), "the PR didn't change: not asked again");
    assert!(p.set_subscribed(&w, 3, true).await.unwrap());
    assert_eq!(seeded(&f, 3).subscribers, ["octocat"]);
    p.http().expire_fresh();
    assert_eq!(p.mr_detail(&w, 3).await.unwrap().value.subscribed, Some(true));
    assert!(!p.set_subscribed(&w, 3, false).await.unwrap());
    assert!(seeded(&f, 3).subscribers.is_empty());
}
// --- end MR round 2 ---
