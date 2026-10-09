//! Inline review comments through the harness's `Api`: real providers, the fake forges. Drafts go
//! in on lines of the MR's diff, publish with the review, and Comment now posts at once.

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};

const BASE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

async fn open_on(h: &Harness, host: &str, kind: &str, token: &str, url: &str) -> (u64, TestRepo) {
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": host, "kind": kind, "token": token}})).await.unwrap();
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", url]);
    let id = call(&h.api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap();
    (id, r)
}

/// A method on MR/PR `number` of repo `id`, with more params.
async fn on(h: &Harness, method: &str, id: u64, number: u64, more: Value) -> Result<Value, GbError> {
    let mut params = json!({"repo": id, "number": number});
    params.as_object_mut().unwrap().extend(more.as_object().cloned().unwrap_or_default());
    call(&h.api, json!({"method": method, "params": params})).await
}

/// A comment on README.md's line `end`, from `start` for a range, against `refs`.
fn comment(refs: &Value, start: Value, end: Value, body: &str) -> Value {
    json!({"comment": {"anchor": {"path": "README.md", "oldPath": "README.md", "start": start, "end": end}, "body": body, "refs": refs}})
}

fn bodies(threads: &Value) -> Vec<String> {
    threads["value"].as_array().unwrap().iter().flat_map(|d| d["notes"].as_array().unwrap()).filter_map(|n| n["body"].as_str().map(str::to_string)).collect()
}

/// GitLab says `version` (and drops draft positions when `drop`); MR 12 has its diff refs.
fn gitlab_seed(h: &Harness, version: &str, drop: bool) {
    let mut seed = h.forge.current_seed();
    seed.gitlab.version = version.into();
    seed.gitlab.drafts_drop_position = drop;
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap().base_sha = BASE.into();
    h.forge.seed(seed);
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_drafts_go_in_on_their_lines_and_publish_with_the_approval() {
    let h = Harness::for_tests().await;
    gitlab_seed(&h, "18.9.1-ee", false);
    let (id, _repo) = open_on(&h, GITLAB_HOST, "gitlab", GITLAB_TOKEN, "https://gitlab.example.com/group/project.git").await;
    let diff = on(&h, "forgeReviewDiff", id, 12, json!({})).await.unwrap();
    assert_eq!(diff["refs"], json!({"baseSha": BASE, "startSha": BASE, "headSha": format!("{:0>40}", 12)}));
    let lines = diff["files"][0]["lines"].clone();
    assert_eq!(lines, json!([{"kind": "context", "oldLine": 1, "newLine": 1}, {"kind": "added", "oldLine": 2, "newLine": 2}]));
    let refs = diff["refs"].clone();
    let state = on(&h, "forgeReviewDrafts", id, 12, json!({})).await.unwrap();
    assert_eq!((state["drafts"].clone(), state["canDraft"].clone(), state["pendingReview"].clone()), (json!([]), json!(true), json!(null)));

    let draft = on(&h, "forgeAddDraft", id, 12, comment(&refs, lines[0].clone(), lines[1].clone(), "Both lines?")).await.unwrap();
    assert_eq!((draft["position"]["line"].clone(), draft["position"]["startLine"].clone()), (json!(2), json!(1)));
    let edited = on(&h, "forgeEditDraft", id, 12, json!({"id": draft["id"], "body": "Both lines, really?"})).await.unwrap();
    assert_eq!((edited["body"].clone(), edited["position"].clone()), (json!("Both lines, really?"), Value::Null), "no position: the caller keeps its own");
    // A line outside the diff: GitLab's refusal, said as one.
    let far = json!({"kind": "added", "oldLine": 2, "newLine": 9});
    let e = on(&h, "forgeAddDraft", id, 12, comment(&refs, Value::Null, far, "Here?")).await.unwrap_err();
    assert!(e.message.starts_with("GitLab won't take a comment on that line"), "{}", e.message);
    // Not on the timeline until it's published.
    assert!(!bodies(&on(&h, "forgeMrDiscussions", id, 12, json!({})).await.unwrap()).iter().any(|b| b.starts_with("Both lines")));

    let out = on(&h, "forgeSubmitReview", id, 12, json!({"review": {"event": "approve", "body": ""}})).await.unwrap();
    assert_eq!(out, json!({"published": 1, "eventError": null, "bodyPosted": false, "eventSent": true, "fallback": false}));
    let threads = on(&h, "forgeMrDiscussions", id, 12, json!({})).await.unwrap();
    let t = threads["value"].as_array().unwrap().iter().find(|d| d["notes"][0]["body"] == "Both lines, really?").unwrap();
    assert_eq!((t["notes"][0]["position"]["line"].clone(), t["notes"][0]["position"]["startLine"].clone(), t["resolvable"].clone()), (json!(2), json!(1), json!(true)));
    assert_eq!(on(&h, "forgeReviewDrafts", id, 12, json!({})).await.unwrap()["drafts"], json!([]));
    assert!(h.forge.current_seed().gitlab.merge_requests.iter().find(|m| m.iid == 12).unwrap().approved_by.contains(&"ada".to_string()));

    // Comment now: a thread at once.
    let now = on(&h, "forgeCommentNow", id, 12, comment(&refs, Value::Null, lines[1].clone(), "Typo?")).await.unwrap();
    assert_eq!((now["notes"][0]["position"]["line"].clone(), now["notes"][0]["position"]["headSha"].clone()), (json!(2), refs["headSha"].clone()));
    // Discard: every draft goes.
    on(&h, "forgeAddDraft", id, 12, comment(&refs, Value::Null, lines[0].clone(), "Scrap me")).await.unwrap();
    assert_eq!(on(&h, "forgeDiscardReview", id, 12, json!({})).await.unwrap(), json!(1));
    assert_eq!(on(&h, "forgeReviewDrafts", id, 12, json!({})).await.unwrap()["drafts"], json!([]));
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_gitlab_keeps_no_drafts_and_says_to_comment_now() {
    let old = gitbolt_core::forge::review::OLD_GITLAB_DRAFTS;
    let h = Harness::for_tests().await;
    gitlab_seed(&h, "16.2.4", false);
    let (id, _repo) = open_on(&h, GITLAB_HOST, "gitlab", GITLAB_TOKEN, "https://gitlab.example.com/group/project.git").await;
    let refs = on(&h, "forgeReviewDiff", id, 12, json!({})).await.unwrap()["refs"].clone();
    assert_eq!(on(&h, "forgeReviewDrafts", id, 12, json!({})).await.unwrap()["canDraft"], json!(false));
    let line = json!({"kind": "added", "oldLine": 2, "newLine": 2});
    assert_eq!(on(&h, "forgeAddDraft", id, 12, comment(&refs, Value::Null, line.clone(), "Why?")).await.unwrap_err().message, old);
    on(&h, "forgeCommentNow", id, 12, comment(&refs, Value::Null, line.clone(), "Why?")).await.unwrap();

    // One that says it's newer but drops the position: the general draft it kept is taken back.
    let h = Harness::for_tests().await;
    gitlab_seed(&h, "18.9.1-ee", true);
    let (id, _repo) = open_on(&h, GITLAB_HOST, "gitlab", GITLAB_TOKEN, "https://gitlab.example.com/group/project.git").await;
    assert_eq!(on(&h, "forgeAddDraft", id, 12, comment(&refs, Value::Null, line, "Why?")).await.unwrap_err().message, old);
    assert_eq!(on(&h, "forgeReviewDrafts", id, 12, json!({})).await.unwrap()["drafts"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn github_drafts_make_one_pending_review_that_submits_with_its_event() {
    let h = Harness::for_tests().await;
    let mut seed = h.forge.current_seed();
    let pr = seed.github.pulls.iter_mut().find(|p| p.number == 3).unwrap();
    pr.base_sha = BASE.into();
    // Someone else's pending review: private to them.
    pr.reviews.push(github_pulls::FakeReview { id: 900, user: "hubot".into(), state: "PENDING".into(), ..Default::default() });
    pr.review_comments.push(github_pulls::FakeReviewComment { id: 901, user: "hubot".into(), body: "Hubot's draft".into(), path: "README.md".into(), line: Some(2), side: "RIGHT".into(), review: Some(900), ..Default::default() });
    h.forge.seed(seed);
    let (id, _repo) = open_on(&h, GITHUB_HOST, "github", GITHUB_TOKEN, "https://github.com/octo-org/widget.git").await;
    let diff = on(&h, "forgeReviewDiff", id, 3, json!({})).await.unwrap();
    assert_eq!(diff["refs"]["headSha"], json!(format!("{:0>40}", 3)));
    let lines = diff["files"][0]["lines"].clone();
    assert_eq!(lines, json!([{"kind": "context", "oldLine": 1, "newLine": 1}, {"kind": "added", "oldLine": 2, "newLine": 2}]));
    let refs = diff["refs"].clone();

    // A first draft off the diff: the pending review started for it is taken back, so Comment
    // now still works.
    let far = json!({"kind": "added", "oldLine": 2, "newLine": 9});
    assert!(on(&h, "forgeAddDraft", id, 3, comment(&refs, Value::Null, far.clone(), "Here?")).await.unwrap_err().message.contains("must be part of the diff"));
    assert_eq!(on(&h, "forgeReviewDrafts", id, 3, json!({})).await.unwrap()["pendingReview"], json!(null));
    on(&h, "forgeCommentNow", id, 3, comment(&refs, Value::Null, lines[1].clone(), "Right away")).await.unwrap();

    let first = on(&h, "forgeAddDraft", id, 3, comment(&refs, lines[0].clone(), lines[1].clone(), "Both lines?")).await.unwrap();
    on(&h, "forgeAddDraft", id, 3, comment(&refs, Value::Null, lines[0].clone(), "Scrap me")).await.unwrap();
    let state = on(&h, "forgeReviewDrafts", id, 3, json!({})).await.unwrap();
    assert!(state["pendingReview"].as_str().is_some_and(|r| r.starts_with("PRR_")), "{state}");
    assert_eq!(state["drafts"].as_array().unwrap().len(), 2, "one pending review holds both");
    assert_eq!((state["drafts"][0]["position"]["line"].clone(), state["drafts"][0]["position"]["startLine"].clone()), (json!(2), json!(1)));
    // Pending comments aren't threads yet, the user's own or anyone else's.
    let threads = bodies(&on(&h, "forgeMrDiscussions", id, 3, json!({})).await.unwrap());
    assert!(!threads.iter().any(|b| b == "Both lines?" || b == "Hubot's draft"), "{threads:?}");
    // GitHub won't take a single comment while the review is pending: said plainly.
    let e = on(&h, "forgeCommentNow", id, 3, comment(&refs, Value::Null, lines[1].clone(), "Now?")).await.unwrap_err();
    assert_eq!(e.message, gitbolt_forge::github::SINGLE_WHILE_PENDING);
    // A line outside the diff: GitHub's refusal, and the review that was pending stays.
    assert!(on(&h, "forgeAddDraft", id, 3, comment(&refs, Value::Null, far, "Here?")).await.unwrap_err().message.contains("must be part of the diff"));
    assert_eq!(on(&h, "forgeReviewDrafts", id, 3, json!({})).await.unwrap()["drafts"].as_array().unwrap().len(), 2);

    on(&h, "forgeEditDraft", id, 3, json!({"id": first["id"], "body": "Both lines, really?"})).await.unwrap();
    let second = state["drafts"][1]["id"].clone();
    on(&h, "forgeDeleteDraft", id, 3, json!({"id": second})).await.unwrap();
    let out = on(&h, "forgeSubmitReview", id, 3, json!({"review": {"event": "requestChanges", "body": "Please split it."}})).await.unwrap();
    assert_eq!(out, json!({"published": 1, "eventError": null, "bodyPosted": true, "eventSent": true, "fallback": false}));
    let threads = on(&h, "forgeMrDiscussions", id, 3, json!({})).await.unwrap();
    assert!(bodies(&threads).iter().any(|b| b == "Both lines, really?"), "{threads}");
    let pr = h.forge.current_seed().github.pulls.into_iter().find(|p| p.number == 3).unwrap();
    assert!(pr.reviews.iter().any(|r| r.user == "octocat" && r.state == "CHANGES_REQUESTED" && r.body == "Please split it."));
    assert_eq!(on(&h, "forgeReviewDrafts", id, 3, json!({})).await.unwrap()["pendingReview"], json!(null));

    // With no review pending, Comment now posts at once.
    let now = on(&h, "forgeCommentNow", id, 3, comment(&refs, Value::Null, lines[1].clone(), "Typo?")).await.unwrap();
    assert_eq!(now["notes"][0]["position"]["line"], json!(2));
    // Discard: the pending review and its comments go.
    on(&h, "forgeAddDraft", id, 3, comment(&refs, Value::Null, lines[1].clone(), "Scrap me too")).await.unwrap();
    assert_eq!(on(&h, "forgeDiscardReview", id, 3, json!({})).await.unwrap(), json!(1));
    let pr = h.forge.current_seed().github.pulls.into_iter().find(|p| p.number == 3).unwrap();
    assert!(!pr.reviews.iter().any(|r| r.state == "PENDING" && r.user == "octocat") && !pr.review_comments.iter().any(|c| c.body == "Scrap me too"));
    assert!(pr.review_comments.iter().any(|c| c.body == "Hubot's draft"), "someone else's pending review stays");
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITHUB_TOKEN));
}
