//! The GitLab provider's merge requests against the fake forge (spec #4 §7): no real forge, ever.

use gitbolt_core::error::GbErrorKind;
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::gitlab::GitLabProvider;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::fake_forge::gitlab_mrs::{FakeDiff, FakeDiscussion, FakeNote, FakePosition};

fn provider(f: &FakeForge, token: &str) -> GitLabProvider {
    GitLabProvider::new(GITLAB_HOST, &HostEndpoints { api: f.gitlab_api(), web: f.gitlab_web(), avatars: None }, Secret::new(token), None).with_change_counter(f.change_counter())
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
async fn pipelines_are_asked_again_only_while_one_runs_or_a_head_is_new() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let pipelines = |f: &FakeForge| f.requests().iter().filter(|r| r.path.ends_with("/pipelines")).count();
    p.open_mrs(&g, MrFilter::All).await.unwrap();
    // Polls are a minute apart: nothing answered within `FRESH_SECS` answers again.
    p.http().expire_fresh();
    p.open_mrs(&g, MrFilter::All).await.unwrap();
    assert_eq!(pipelines(&f), 2, "!5's pipeline runs: asked each poll");
    let mut seed = f.current_seed();
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 5).unwrap().pipeline = Some("success".into());
    f.seed(seed);
    let list = p.open_mrs(&g, MrFilter::All).await.unwrap().value;
    assert_eq!(list[1].pipeline.as_ref().map(|p| p.status), Some(PipelineStatus::Success));
    p.open_mrs(&g, MrFilter::All).await.unwrap();
    p.open_mrs(&g, MrFilter::Mine).await.unwrap();
    assert_eq!(pipelines(&f), 3, "all finished: kept");
    // A new head (a push) asks again.
    let mut seed = f.current_seed();
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap().head_sha = format!("{:0>40}", 1212);
    f.seed(seed);
    p.open_mrs(&g, MrFilter::All).await.unwrap();
    assert_eq!(pipelines(&f), 4);
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
async fn a_multi_line_diff_note_has_its_range_and_its_lines() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let mut seed = f.current_seed();
    let mr = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap();
    let diff = "@@ -1,3 +1,6 @@\n fn a() {}\n+fn b() {}\n+fn c() {}\n+fn d() {}\n fn e() {}\n fn f() {}\n";
    mr.diffs.push(FakeDiff { old_path: "src/lib.rs".into(), new_path: "src/lib.rs".into(), diff: diff.into() });
    let note = |id: u64, start| FakeNote {
        id,
        author: "grace".into(),
        body: "These go together.".into(),
        created_at: "2026-10-04T09:20:00Z".into(),
        position: Some(FakePosition { new_path: "src/lib.rs".into(), old_path: "src/lib.rs".into(), new_line: Some(5), old_line: Some(2), start }),
        ..Default::default()
    };
    let discussion = |id: &str, n| FakeDiscussion { id: id.into(), notes: vec![n], resolvable: true, ..Default::default() };
    mr.discussions.push(discussion("d4", note(104, Some((Some(2), None)))));
    // A range that starts where it ends (GitLab sends one for a single line too).
    mr.discussions.push(discussion("d5", note(105, Some((Some(5), Some(2))))));
    f.seed(seed);
    let ds = p.discussions(&g, 12).await.unwrap().value;
    let pos = ds[3].notes[0].position.as_ref().unwrap();
    assert_eq!((pos.start_line, pos.start_old_line, pos.line, pos.old_line), (Some(2), None, Some(5), Some(2)));
    assert_eq!(pos.snippet.as_deref(), Some("+fn b() {}\n+fn c() {}\n+fn d() {}\n fn e() {}"));
    let one = ds[4].notes[0].position.as_ref().unwrap();
    assert_eq!((one.start_line, one.start_old_line, one.snippet.as_deref()), (None, None, Some("+fn c() {}\n+fn d() {}\n fn e() {}")));
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
    let m = p.edit(&g, 5, &MrEdit { title: Some("Explore caching more".into()), description: None, labels: None, ..Default::default() }).await.unwrap();
    assert_eq!((m.title.as_str(), m.state), ("Explore caching more", MrState::Draft));
    assert_eq!(seeded(&f, 5).title, "Draft: Explore caching more");
    p.edit(&g, 12, &MrEdit { title: None, description: Some("New text".into()), labels: Some(vec!["backend".into(), "ui".into()]), ..Default::default() }).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((s.description.as_str(), s.labels.clone(), s.title.as_str()), ("New text", vec!["backend".to_string(), "ui".to_string()], "Dev work"));
}

fn people(add: &[u64], remove: &[u64]) -> Option<PeopleEdit> {
    Some(PeopleEdit { add: add.to_vec(), remove: remove.to_vec() })
}

const ADA: u64 = 7;
const GRACE: u64 = 8;

#[tokio::test(flavor = "multi_thread")]
async fn reviewers_and_assignees_change_through_one_put_of_the_whole_lists() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    // !12: ada reviews, no assignee.
    p.edit(&g, 12, &MrEdit { reviewers: people(&[GRACE], &[ADA]), assignees: people(&[ADA], &[]), ..Default::default() }).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((s.reviewers, s.assignees), (vec!["grace".to_string()], vec!["ada".to_string()]));
    let puts: Vec<_> = f.requests().into_iter().filter(|r| r.method != "GET").map(|r| (r.method, r.path)).collect();
    assert_eq!(puts, [("PUT".to_string(), "/api/v4/projects/42/merge_requests/12".to_string())]);
    p.edit(&g, 12, &MrEdit { assignees: people(&[], &[ADA]), ..Default::default() }).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((s.reviewers, s.assignees), (vec!["grace".to_string()], vec![]), "the reviewers kept");
    let d = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((d.reviewers.iter().map(|u| u.id).collect::<Vec<_>>(), d.assignees.len()), (vec![GRACE], 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn people_gitlab_wont_add_and_a_refusal_say_why() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let e = p.edit(&g, 12, &MrEdit { reviewers: people(&[99], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "GitLab didn't add user 99 as a reviewer: are they a member of group/project?"));
    f.script(Scripted { forge: "gitlab".into(), method: "PUT".into(), path: "/api/v4/projects/42/merge_requests/12".into(), status: 403, headers: vec![], body: serde_json::json!({"message": "403 Forbidden"}), times: 1 });
    let e = p.edit(&g, 12, &MrEdit { assignees: people(&[GRACE], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::AuthFailed, "gitlab.example.com refused: 403 Forbidden"));
    assert!(seeded(&f, 12).assignees.is_empty());
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
    p.edit(&g, 12, &MrEdit { title: None, description: None, labels: Some(vec!["bug".into(), "nope".into()]), ..Default::default() }).await.unwrap();
    let listed = p.open_mrs_light(&g, MrFilter::All).await.unwrap().value;
    let bug = || [("bug".to_string(), "#d9534f".to_string())].into_iter().collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(listed.iter().find(|m| m.number == 12).unwrap().label_colors, bug(), "the list's label details");
    let labels_asked = |f: &FakeForge| f.requests().iter().filter(|r| r.path.ends_with("/labels")).count();
    assert_eq!(labels_asked(&f), 0);
    // A single MR's GET has names only: the detail's chips still get their colours.
    let detail = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((detail.mr.labels.clone(), detail.mr.label_colors), (vec!["bug".to_string(), "nope".to_string()], bug()));
    assert_eq!(labels_asked(&f), 1);
    // `nope` isn't a project label (it may be new): asked again (ETag-revalidated, past the
    // `FRESH_SECS` that answer from what's kept); `bug` stays.
    p.http().expire_fresh();
    assert_eq!(p.mr_detail(&g, 12).await.unwrap().value.mr.label_colors, bug());
    assert_eq!(labels_asked(&f), 2);
    // Every label known: kept for the session, no request.
    p.edit(&g, 12, &MrEdit { title: None, description: None, labels: Some(vec!["bug".into()]), ..Default::default() }).await.unwrap();
    assert_eq!(p.mr_detail(&g, 12).await.unwrap().value.mr.label_colors, bug());
    assert_eq!(labels_asked(&f), 2, "kept for the session");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_etags_a_poll_asks_only_whether_any_mr_changed() {
    let f = FakeForge::start().await;
    f.set_gitlab_etags(false);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let lists = |f: &FakeForge| f.requests().into_iter().filter(|r| r.path.ends_with("/merge_requests")).map(|r| r.query).collect::<Vec<_>>();
    assert_eq!(numbers(&p.open_mrs_light(&g, MrFilter::All).await.unwrap().value), [12, 5, 14]);
    f.clear_requests();
    f.advance();
    let again = p.open_mrs_light(&g, MrFilter::All).await.unwrap();
    assert_eq!((numbers(&again.value), again.not_modified), (vec![12, 5, 14], true));
    let asked = lists(&f);
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert!(asked[0].contains("state=all") && asked[0].contains("per_page=1") && asked[0].contains("updated_after=2026-10-04T10%3A00%3A01Z"), "{asked:?}");
    // !5 is merged: the probe finds it, and the list is read again.
    let mut seed = f.current_seed();
    let m = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 5).unwrap();
    m.state = "merged".into();
    m.updated_at = "2026-10-05T08:00:00Z".into();
    f.seed(seed);
    f.clear_requests();
    assert_eq!(numbers(&p.open_mrs_light(&g, MrFilter::All).await.unwrap().value), [12, 14]);
    assert_eq!(lists(&f).len(), 2, "the probe, then the list");
    // And the mark moved past it: the next poll's probe finds nothing.
    f.clear_requests();
    f.advance();
    assert_eq!(numbers(&p.open_mrs_light(&g, MrFilter::All).await.unwrap().value), [12, 14]);
    assert_eq!(lists(&f).len(), 1);
}

// --- auto-merge ---
/// !12 with its pipeline running (GitLab: `ci_still_running` until it passes).
fn running(f: &FakeForge) {
    let mut seed = f.current_seed();
    let m = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap();
    m.pipeline = Some("running".into());
    m.merge_status = "ci_still_running".into();
    f.seed(seed);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_merge_is_set_with_the_options_read_back_and_cancelled() {
    let f = FakeForge::start().await;
    running(&f);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let opts = MergeOptions { squash: Some(true), delete_source_branch: Some(true), ..Default::default() };
    let m = p.set_auto_merge(&g, 12, &opts).await.unwrap();
    assert_eq!(m.state, MrState::Open, "it waits for the pipeline");
    let by = m.auto_merge.unwrap().enabled_by.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((s.auto_merge_by.as_deref(), s.squash, s.remove_source_branch), (Some(by.username.as_str()), true, Some(true)));
    assert_eq!((s.merge_commit_message.as_deref(), s.squash_commit_message.as_deref()), (None, None), "GitLab's own messages");
    p.http().expire_fresh();
    assert!(p.mr_detail(&g, 12).await.unwrap().value.mr.auto_merge.is_some(), "the detail reads it");
    assert!(p.open_mrs(&g, MrFilter::All).await.unwrap().value.iter().find(|m| m.number == 12).unwrap().auto_merge.is_some(), "and the list (the sidebar's mark)");
    assert_eq!(p.cancel_auto_merge(&g, 12).await.unwrap().auto_merge, None);
    assert_eq!(seeded(&f, 12).auto_merge_by, None);
    let e = p.cancel_auto_merge(&g, 12).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "!12 isn't set to auto-merge any more: refresh"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_merge_merges_at_once_when_the_pipeline_passed_and_is_refused_on_a_draft() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    assert_eq!(p.set_auto_merge(&g, 12, &MergeOptions::default()).await.unwrap().state, MrState::Merged, "!12's pipeline passed");
    let e = p.set_auto_merge(&g, 5, &MergeOptions::default()).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "GitLab can't set !5 to auto-merge now: refresh to see why"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_gitlab_is_still_processing_is_merging_then_merged() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap().locks_on_merge = true;
    f.seed(seed);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    assert_eq!(p.merge(&g, 12, &MergeOptions::default()).await.unwrap().state, MrState::Merging, "locked: not closed");
    let d = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((d.mr.state, d.merge_status), (MrState::Merging, MergeStatus::Blocked { reason: "It's being merged".into() }));
    p.http().expire_fresh();
    assert_eq!(p.mr_detail(&g, 12).await.unwrap().value.mr.state, MrState::Merged);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_leaves_the_messages_to_gitlab() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    p.merge(&g, 12, &MergeOptions { squash: Some(true), ..Default::default() }).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((s.merge_commit_message, s.squash_commit_message), (None, None));
}
// --- end auto-merge ---

// --- MR round 2 ---
fn single_people(f: &FakeForge, single: bool, old: bool) {
    let mut seed = f.current_seed();
    seed.gitlab.projects.iter_mut().find(|p| p.path == "group/project").unwrap().single_people = single;
    seed.gitlab.old_graphql = old;
    f.seed(seed);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_people_limits_come_from_graphql_per_project() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    assert_eq!(p.people_limits(&g).await.unwrap(), PeopleLimits::default(), "a paid tier: several of each");
    single_people(&f, true, false);
    assert_eq!(p.people_limits(&g).await.unwrap(), PeopleLimits { max_reviewers: Some(1), max_assignees: Some(1) });
    let fork = p.project("alice/project").await.unwrap().value;
    assert_eq!(p.people_limits(&fork).await.unwrap(), PeopleLimits::default(), "another project (no MR to ask about): no limit");
    let asked = f.requests().into_iter().filter(|r| r.path == "/api/graphql").count();
    assert_eq!(asked, 3, "one small request per project");
    single_people(&f, true, true);
    assert_eq!(p.people_limits(&g).await.unwrap(), PeopleLimits::default(), "an older GitLab without the fields: assume several");
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_free_keeping_only_the_first_says_who_it_kept() {
    let f = FakeForge::start().await;
    single_people(&f, true, false);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    // !12: ada reviews; adding grace sends [ada, grace]: GitLab keeps ada.
    let e = p.edit(&g, 12, &MrEdit { reviewers: people(&[GRACE], &[]), ..Default::default() }).await.unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "GitLab kept only Ada Lovelace: this project allows one reviewer"));
    assert!(matches!(e.detail, Some(gitbolt_core::error::ErrorDetail::PeopleLimit { ref role }) if &**role == "reviewers"));
    assert_eq!(seeded(&f, 12).reviewers, ["ada"]);
    // A swap (the single mode's pick) goes in.
    p.edit(&g, 12, &MrEdit { reviewers: people(&[GRACE], &[ADA]), ..Default::default() }).await.unwrap();
    assert_eq!(seeded(&f, 12).reviewers, ["grace"]);
}

fn review(event: ReviewEvent, body: &str) -> ReviewSubmit {
    ReviewSubmit { event, body: body.into() }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_review_composer_comments_approves_and_requests_changes() {
    let f = FakeForge::start().await;
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let notes = |f: &FakeForge| seeded(f, 12).discussions.iter().flat_map(|d| d.notes.iter().map(|n| n.body.clone())).collect::<Vec<_>>();
    assert!(!p.review(&g, 12, &review(ReviewEvent::Comment, "A note")).await.unwrap().fallback);
    assert_eq!(notes(&f).last().map(String::as_str), Some("A note"));
    p.review(&g, 12, &review(ReviewEvent::Approve, "")).await.unwrap();
    assert_eq!((seeded(&f, 12).approved_by, notes(&f).len()), (vec!["ada".to_string()], 4), "no message: no note");
    let out = p.review(&g, 12, &review(ReviewEvent::RequestChanges, "Rename it")).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((out.fallback, s.changes_requested_by, s.approved_by), (false, vec!["ada".to_string()], vec![]), "the reviewer state, and the approval withdrawn");
    assert_eq!(notes(&f).last().map(String::as_str), Some("Rename it"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_gitlab_requests_changes_with_a_note_and_the_approval_withdrawn() {
    let f = FakeForge::start().await;
    single_people(&f, false, true);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    p.approve(&g, 12).await.unwrap();
    let out = p.review(&g, 12, &review(ReviewEvent::RequestChanges, "Rename it")).await.unwrap();
    let s = seeded(&f, 12);
    assert_eq!((out.fallback, s.changes_requested_by.len(), s.approved_by.len()), (true, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn notifications_and_the_base_come_with_the_detail() {
    let f = FakeForge::start().await;
    let mut seed = f.current_seed();
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap().base_sha = "b".repeat(40);
    f.seed(seed);
    let p = provider(&f, GITLAB_TOKEN);
    let g = group(&p).await;
    let d = p.mr_detail(&g, 12).await.unwrap().value;
    assert_eq!((d.subscribed, d.base_sha), (Some(false), Some("b".repeat(40))));
    assert!(p.set_subscribed(&g, 12, true).await.unwrap());
    assert_eq!(seeded(&f, 12).subscribers, ["ada"]);
    assert!(p.set_subscribed(&g, 12, true).await.unwrap(), "already: GitLab's 304 is fine");
    p.http().expire_fresh();
    assert_eq!(p.mr_detail(&g, 12).await.unwrap().value.subscribed, Some(true));
    assert!(!p.set_subscribed(&g, 12, false).await.unwrap());
    assert!(seeded(&f, 12).subscribers.is_empty());
}
// --- end MR round 2 ---
