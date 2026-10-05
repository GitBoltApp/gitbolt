//! The GitLab provider's merge requests against the fake forge (spec #4 §7): no real forge, ever.

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;

fn provider(f: &FakeForge, token: &str) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(token), None)
}

async fn group(p: &GitLabProvider) -> ForgeProject {
    p.project("group/project").await.unwrap().value
}

fn numbers(mrs: &[ForgeMr]) -> Vec<u64> {
    mrs.iter().map(|m| m.number).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_open_mrs_with_their_pipelines_and_draft_titles_stripped() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let list = p.open_mrs(&g, MrFilter::All).await.unwrap().value;
    assert_eq!(numbers(&list), [12, 5, 14]);
    let (dev, draft, fork) = (&list[0], &list[1], &list[2]);
    assert_eq!((dev.state, dev.author.username.as_str(), dev.source_branch.as_str(), dev.target_branch.as_str()), (MrState::Open, "grace", "dev", "main"));
    assert_eq!(dev.pipeline.as_ref().map(|p| p.status), Some(PipelineStatus::Success), "from /pipelines: a list has no head_pipeline");
    assert_eq!((draft.state, draft.title.as_str()), (MrState::Draft, "Explore caching"));
    assert_eq!(draft.pipeline.as_ref().map(|p| p.status), Some(PipelineStatus::Running));
    assert_eq!((fork.source_project.as_str(), fork.target_project.as_str()), ("alice/project", "group/project"));
    let asked = f.requests().into_iter().find(|r| r.path.ends_with("/merge_requests")).unwrap();
    assert_eq!(asked.query, "state=opened&order_by=updated_at&sort=desc&per_page=100&with_labels_details=true", "label colours, in the same request");
    assert_eq!(f.requests().iter().filter(|r| r.path.ends_with("/pipelines")).count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn mine_and_review_requested_filter_on_the_server() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    assert_eq!(numbers(&p.open_mrs(&g, MrFilter::Mine).await.unwrap().value), [5]);
    assert_eq!(numbers(&p.open_mrs(&g, MrFilter::ReviewRequested).await.unwrap().value), [12]);
    let queries: Vec<String> = f.requests().into_iter().filter(|r| r.path.ends_with("/merge_requests")).map(|r| r.query).collect();
    assert!(queries[0].ends_with("&scope=created_by_me"), "{queries:?}");
    assert!(queries[1].ends_with("&reviewer_id=7"), "{queries:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_a_branchs_mr_in_any_state_from_its_source_project() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let at = |project: &str, branch: &str| SourceRef { project: project.into(), branch: branch.into() };
    let old = p.mr_for_branch(&g, &at("group/project", "feature/old")).await.unwrap().value.unwrap();
    assert_eq!((old.number, old.state), (9, MrState::Merged));
    assert_eq!(p.mr_for_branch(&g, &at("alice/project", "fix")).await.unwrap().value.unwrap().number, 14);
    assert!(p.mr_for_branch(&g, &at("group/project", "fix")).await.unwrap().value.is_none(), "the same branch name in another project");
    assert!(p.mr_for_branch(&g, &at("group/project", "nope")).await.unwrap().value.is_none());
    let asked = f.requests().into_iter().find(|r| r.query.contains("source_branch=feature%2Fold")).unwrap();
    assert!(asked.query.contains("state=all"), "{}", asked.query);
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_a_detail_with_its_pipeline_approvals_and_why_it_cant_merge() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let d = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!(d.description, "Adds the dev work.\n\nCloses #3.");
    assert_eq!(d.mr.pipeline.as_ref().map(|p| p.status), Some(PipelineStatus::Success));
    assert_eq!((d.mr.review.decision, d.mr.review.approvals, d.mr.review.approvals_required), (ReviewDecision::ReviewRequired, 0, Some(1)));
    assert_eq!(d.merge_status, MergeStatus::Blocked { reason: "It needs approval first".into() });
    assert_eq!(d.reviewers.iter().map(|u| u.username.as_str()).collect::<Vec<_>>(), ["ada"]);
    assert_eq!((d.mr.conflicts, d.mr.labels.clone()), (Some(false), vec!["backend".to_string()]));
    assert_eq!(p.mr_detail(&g, 5).await.unwrap().value.merge_status, MergeStatus::Blocked { reason: "Mark it ready first: it's a draft".into() });
    assert_eq!(p.mr_detail(&g, 404).await.unwrap_err().kind, GbErrorKind::NotFound);
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_discussions_with_diff_note_snippets() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let ds = p.discussions(&g, 12).await.unwrap().value;
    assert_eq!(ds.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["d1", "d2", "d3"]);
    assert_eq!((ds[0].notes[0].author.name.as_str(), ds[0].notes[0].body.as_str()), ("Grace Hopper", "Looks good overall."));
    let pos = ds[1].notes[0].position.as_ref().unwrap();
    assert_eq!((pos.path.as_str(), pos.line, pos.old_path.as_deref()), ("README.md", Some(2), None));
    assert_eq!(pos.snippet.as_deref(), Some(" Readme\n+Second line"));
    assert!(ds[1].resolvable && !ds[1].resolved);
    assert!(ds[2].notes[0].system);
    let diffs = |f: &FakeForge| f.requests().iter().filter(|r| r.path.ends_with("/diffs")).count();
    assert_eq!(diffs(&f), 1);
    assert!(p.discussions(&g, 5).await.unwrap().value.is_empty());
    assert_eq!(diffs(&f), 1, "no diff note, no diffs request");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unchanged_list_comes_back_not_modified() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    assert!(!p.open_mrs(&g, MrFilter::All).await.unwrap().not_modified);
    assert!(p.open_mrs(&g, MrFilter::All).await.unwrap().not_modified);
}

fn project_gets(f: &FakeForge, id: &str) -> usize {
    let path = format!("/api/v4/projects/{id}");
    f.requests().iter().filter(|r| r.method == "GET" && r.path.ends_with(&path)).count()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fork_source_project_is_fetched_once_across_lists() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.open_mrs(&g, MrFilter::All).await.unwrap();
    p.open_mrs(&g, MrFilter::All).await.unwrap();
    assert_eq!(project_gets(&f, "77"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_source_project_is_asked_once_and_its_mr_still_lists() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    let mut extra = seed.gitlab.merge_requests[3].clone();
    extra.iid = 15;
    extra.source_project = "hidden/project".into();
    seed.gitlab.merge_requests[3].source_project = "hidden/project".into();
    seed.gitlab.merge_requests.push(extra);
    f.seed(seed);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let first = p.open_mrs(&g, MrFilter::All).await.unwrap().value;
    let second = p.open_mrs(&g, MrFilter::All).await.unwrap().value;
    assert!(numbers(&first).contains(&14) && numbers(&second).contains(&15));
    assert_eq!(project_gets(&f, "0"), 1, "one failing lookup for both MRs and both lists");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_branch_with_a_hash_is_encoded() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let at = SourceRef { project: "group/project".into(), branch: "fix#1".into() };
    assert!(p.mr_for_branch(&g, &at).await.unwrap().value.is_none());
    assert!(f.requests().iter().any(|r| r.query.contains("source_branch=fix%231")));
}

// --- 4B T3 ---
fn seeded(f: &FakeForge, iid: u64) -> gitlab_mrs::FakeMergeRequest {
    f.current_seed().gitlab.merge_requests.into_iter().find(|m| m.iid == iid).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn replies_in_a_thread_and_starts_a_new_one() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let n = p.reply(&g, 12, &NewNote { discussion: Some("d2".into()), body: "To document the setup.".into() }).await.unwrap();
    assert_eq!((n.author.username.as_str(), n.body.as_str()), ("ada", "To document the setup."));
    p.reply(&g, 12, &NewNote { discussion: None, body: "Thanks!".into() }).await.unwrap();
    let ds = p.discussions(&g, 12).await.unwrap().value;
    assert_eq!(ds[1].notes.len(), 2);
    assert_eq!(ds.last().unwrap().notes[0].body, "Thanks!");
    assert!(f.requests().iter().any(|r| r.method == "POST" && r.path == "/api/v4/projects/42/merge_requests/12/discussions/d2/notes"));
}

#[tokio::test(flavor = "multi_thread")]
async fn approving_unblocks_the_merge_and_requesting_changes_withdraws_the_approval() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    let d = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((d.mr.review.decision, d.mr.review.approvals, d.merge_status.clone()), (ReviewDecision::Approved, 1, MergeStatus::Mergeable));
    assert_eq!(d.mr.review.reviews[0].user.username, "ada");
    p.request_changes(&g, 12, "Please rename it.").await.unwrap();
    let d = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((d.mr.review.approvals, d.merge_status), (0, MergeStatus::Blocked { reason: "It needs approval first".into() }));
    assert_eq!(p.discussions(&g, 12).await.unwrap().value.last().unwrap().notes[0].body, "Please rename it.");
    p.request_changes(&g, 12, "Still.").await.unwrap();
    assert!(f.requests().iter().any(|r| r.path.ends_with("/unapprove")), "a second time, unapprove's 404 is fine");
}

#[tokio::test(flavor = "multi_thread")]
async fn merges_with_the_options_and_the_expected_sha() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    let head = p.mr_detail(&g, 12).await.unwrap().value.mr.head_sha;
    let merged = p.merge(&g, 12, &MergeOptions { method: None, squash: Some(true), delete_source_branch: Some(true), expected_sha: head }).await.unwrap();
    assert_eq!(merged.state, MrState::Merged);
    let s = seeded(&f, 12);
    assert_eq!((s.state.as_str(), s.squash, s.remove_source_branch), ("merged", true, Some(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_sha_is_refused_with_refresh_advice() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    let e = p.merge(&g, 12, &MergeOptions { method: None, squash: None, delete_source_branch: None, expected_sha: Some("dead".repeat(10)) }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "!12 changed since it was loaded: refresh and try again"));
    assert_eq!(seeded(&f, 12).state, "opened");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocked_merge_says_to_refresh() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let e = p.merge(&g, 5, &MergeOptions { method: None, squash: None, delete_source_branch: None, expected_sha: None }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "GitLab can't merge !5 now: refresh to see why"));
}

#[tokio::test(flavor = "multi_thread")]
async fn editing_a_drafts_title_keeps_it_a_draft() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let m = p.edit(&g, 5, &MrEdit { title: Some("Explore caching more".into()), description: None, labels: None }).await.unwrap();
    assert_eq!((m.title.as_str(), m.state), ("Explore caching more", MrState::Draft));
    assert_eq!(seeded(&f, 5).title, "Draft: Explore caching more");
    p.edit(&g, 12, &MrEdit { title: None, description: Some("New text".into()), labels: Some(vec!["backend".into(), "ui".into()]) }).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((s.description.as_str(), s.labels.clone(), s.title.as_str()), ("New text", vec!["backend".to_string(), "ui".to_string()], "Dev work"));
}

#[tokio::test(flavor = "multi_thread")]
async fn draft_and_ready_round_trip_through_the_title() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    assert_eq!(p.set_draft(&g, 12, true).await.unwrap().state, MrState::Draft);
    assert_eq!(seeded(&f, 12).title, "Draft: Dev work");
    let ready = p.set_draft(&g, 12, false).await.unwrap();
    assert_eq!((ready.state, ready.title.as_str()), (MrState::Open, "Dev work"));
    assert_eq!(seeded(&f, 12).title, "Dev work");
}
// --- end 4B T3 ---

// --- 4B final fix ---
#[tokio::test(flavor = "multi_thread")]
async fn a_detail_whose_optional_approvals_alone_change_is_not_modified_no_more() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let approved = |d: &Fresh<ForgeMrDetail>| d.value.mr.review.reviews.iter().any(|r| r.user.username == "grace" && r.state == ReviewState::Approved);
    let first = p.mr_detail(&g, 14).await.unwrap();
    assert_eq!((approved(&first), first.not_modified), (false, false));
    assert!(p.mr_detail(&g, 14).await.unwrap().not_modified, "both requests answered 304");
    let mut seed = f.current_seed();
    let mr = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 14).unwrap();
    assert_eq!(mr.approvals_required, 0, "optional approvals");
    mr.approved_by.push("grace".into());
    f.seed(seed);
    let after = p.mr_detail(&g, 14).await.unwrap();
    assert_eq!((approved(&after), after.not_modified), (true, false), "the MR answered 304, its approvals didn't");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_light_list_reads_no_pipelines() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    assert!(!p.open_mrs_light(&g, MrFilter::All).await.unwrap().value.is_empty());
    assert!(!f.requests().iter().any(|r| r.path.ends_with("/pipelines")));
}
// --- end 4B final fix ---

#[tokio::test(flavor = "multi_thread")]
async fn label_colours_come_with_the_list_and_for_a_detail_from_the_projects_labels_once() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.edit(&g, 12, &MrEdit { title: None, description: None, labels: Some(vec!["bug".into(), "nope".into()]) }).await.unwrap();
    let listed = p.open_mrs_light(&g, MrFilter::All).await.unwrap().value;
    let bug = || [("bug".to_string(), "#d9534f".to_string())].into_iter().collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(listed.iter().find(|m| m.number == 12).unwrap().label_colors, bug(), "the list's label details");
    let labels_asked = |f: &FakeForge| f.requests().iter().filter(|r| r.path.ends_with("/labels")).count();
    assert_eq!(labels_asked(&f), 0);
    // A single MR's GET has names only: the detail's chips still get their colours.
    let detail = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((detail.mr.labels.clone(), detail.mr.label_colors), (vec!["bug".to_string(), "nope".to_string()], bug()));
    assert_eq!(labels_asked(&f), 1);
    // `nope` isn't a project label (it may be new): asked again (ETag-revalidated); `bug` stays.
    assert_eq!(p.mr_detail(&g, 12).await.unwrap().value.mr.label_colors, bug());
    assert_eq!(labels_asked(&f), 2);
    // Every label known: kept for the session, no request.
    p.edit(&g, 12, &MrEdit { title: None, description: None, labels: Some(vec!["bug".into()]) }).await.unwrap();
    assert_eq!(p.mr_detail(&g, 12).await.unwrap().value.mr.label_colors, bug());
    assert_eq!(labels_asked(&f), 2, "kept for the session");
}
