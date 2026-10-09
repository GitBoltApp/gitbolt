//! What MR/PR loading costs on a big repository: the fake forge's request log, grouped by
//! endpoint, for the UI's poll sequence (`ui/src/forge/poll.ts`) replayed through the `Api`.
//! Both forges get the same seed: 80 local branches with upstreams, 40 open MRs/PRs with
//! pipelines, approvals and reviews, and 15 merged or closed ones.
//!
//! The table: `cargo test -p gitbolt-harness --test it forge_poll_cost:: -- --nocapture`.

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::fake_forge::gitlab_mrs::FakeMergeRequest;
use gitbolt_harness::fake_forge::github_pulls::{FakeCheck, FakePull, FakeReview};
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const OPEN: u64 = 40;
pub const MERGED: u64 = 10;
pub const CLOSED: u64 = 5;
pub const NO_MR: u64 = 25;

pub async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

pub async fn ok(api: &Api, v: Value) -> Value {
    call(api, v.clone()).await.unwrap_or_else(|e| panic!("{v}: {e:?}"))
}

/// The branches: `feat-NN` (open MRs), `old-NN` (merged), `gone-NN` (closed), `wip-NN` (none).
pub fn branches() -> Vec<String> {
    let mut b: Vec<String> = (0..OPEN).map(|i| format!("feat-{i:02}")).collect();
    b.extend((0..MERGED).map(|i| format!("old-{i:02}")));
    b.extend((0..CLOSED).map(|i| format!("gone-{i:02}")));
    b.extend((0..NO_MR).map(|i| format!("wip-{i:02}")));
    b
}

/// A repository on `url` with every branch local, tracking `origin/<branch>`, all at one commit.
pub fn big_repo(url: &str) -> (TestRepo, String) {
    let r = TestRepo::new();
    let head = r.commit("a").trim().to_string();
    let head = if head.len() == 40 { head } else { r.git(&["rev-parse", "HEAD"]).trim().to_string() };
    r.git(&["remote", "add", "origin", url]);
    let mut stdin = String::new();
    for b in branches() {
        stdin.push_str(&format!("create refs/heads/{b} {head}\ncreate refs/remotes/origin/{b} {head}\n"));
    }
    std::fs::write(r.path().join(".git/refs-batch"), &stdin).unwrap();
    r.git(&["update-ref", "--stdin", "--no-deref"]);
    let mut config = std::fs::read_to_string(r.path().join(".git/config")).unwrap();
    for b in branches() {
        config.push_str(&format!("[branch \"{b}\"]\n\tremote = origin\n\tmerge = refs/heads/{b}\n"));
    }
    std::fs::write(r.path().join(".git/config"), config).unwrap();
    (r, head)
}

pub fn remote_refs() -> Vec<String> {
    branches().iter().map(|b| format!("refs/remotes/origin/{b}")).collect()
}

/// The GitLab seed: 40 open MRs (every 8th with a running pipeline when `running`), 10 merged
/// (half at the branch's tip), 5 closed, one open MR from a fork.
pub fn gitlab_seed(seed: &mut ForgeSeed, head: &str, running: bool) {
    let mr = |iid: u64, branch: String, state: &str| FakeMergeRequest {
        iid,
        project: "group/project".into(),
        source_branch: branch,
        target_branch: "main".into(),
        title: format!("Change {iid}"),
        description: "Does a thing.".into(),
        state: state.into(),
        author: if iid.is_multiple_of(2) { "ada".into() } else { "grace".into() },
        head_sha: format!("{iid:0>40}"),
        merge_status: "mergeable".into(),
        updated_at: format!("2026-10-{:02}T10:{:02}:00Z", 1 + iid % 4, iid % 60),
        ..Default::default()
    };
    let mut mrs = Vec::new();
    for i in 0..OPEN {
        mrs.push(FakeMergeRequest {
            pipeline: Some(if running && i % 8 == 0 { "running" } else { "success" }.into()),
            approvals_required: 1,
            approved_by: if i % 3 == 0 { vec!["grace".into()] } else { vec![] },
            reviewers: if i % 4 == 0 { vec!["ada".into()] } else { vec!["grace".into()] },
            labels: vec!["backend".into()],
            ..mr(100 + i, format!("feat-{i:02}"), "opened")
        });
    }
    for i in 0..MERGED {
        mrs.push(FakeMergeRequest { head_sha: if i % 2 == 0 { head.to_string() } else { format!("{:0>40}", 60 + i) }, ..mr(60 + i, format!("old-{i:02}"), "merged") });
    }
    for i in 0..CLOSED {
        mrs.push(mr(80 + i, format!("gone-{i:02}"), "closed"));
    }
    mrs.push(FakeMergeRequest { source_project: "alice/project".into(), ..mr(99, "fix".into(), "opened") });
    seed.gitlab.merge_requests = mrs;
}

/// The GitHub seed: the same shape as `gitlab_seed`.
pub fn github_seed(seed: &mut ForgeSeed, head: &str, running: bool) {
    let pull = |number: u64, branch: String, state: &str| FakePull {
        number,
        repo: "octo-org/widget".into(),
        head_ref: branch,
        base_ref: "main".into(),
        title: format!("Change {number}"),
        body: "Does a thing.".into(),
        state: state.into(),
        author: if number.is_multiple_of(2) { "octocat".into() } else { "monalisa".into() },
        head_sha: format!("{number:0>40}"),
        mergeable: Some(true),
        mergeable_state: "clean".into(),
        updated_at: format!("2026-10-{:02}T10:{:02}:00Z", 1 + number % 4, number % 60),
        ..Default::default()
    };
    let check = |running: bool| FakeCheck { name: "build".into(), status: if running { "in_progress" } else { "completed" }.into(), conclusion: if running { None } else { Some("success".into()) } };
    let mut pulls = Vec::new();
    for i in 0..OPEN {
        pulls.push(FakePull {
            checks: vec![check(running && i % 8 == 0)],
            requested_reviewers: if i % 4 == 0 { vec!["octocat".into()] } else { vec!["hubot".into()] },
            reviews: if i % 3 == 0 { vec![FakeReview { id: 1000 + i, user: "hubot".into(), state: "APPROVED".into(), body: String::new(), submitted_at: "2026-10-03T08:00:00Z".into(), ..Default::default() }] } else { vec![] },
            labels: vec!["backend".into()],
            ..pull(100 + i, format!("feat-{i:02}"), "open")
        });
    }
    for i in 0..MERGED {
        pulls.push(FakePull { merged: true, head_sha: if i % 2 == 0 { head.to_string() } else { format!("{:0>40}", 60 + i) }, ..pull(60 + i, format!("old-{i:02}"), "closed") });
    }
    for i in 0..CLOSED {
        pulls.push(pull(80 + i, format!("gone-{i:02}"), "closed"));
    }
    seed.github.pulls = pulls;
}

/// One forge's repository, opened in the harness with its account.
pub struct Setup {
    pub h: Harness,
    pub id: u64,
    pub _repo: TestRepo,
}

impl Setup {
    pub fn repo_path(&self) -> &std::path::Path {
        self._repo.path()
    }
}

pub async fn setup(kind: &'static str, running: bool) -> Setup {
    let h = Harness::for_tests().await;
    let (url, host, token) = match kind {
        "gitlab" => ("https://gitlab.example.com/group/project.git", GITLAB_HOST, GITLAB_TOKEN),
        _ => ("https://github.com/octo-org/widget.git", GITHUB_HOST, GITHUB_TOKEN),
    };
    ok(&h.api, json!({"method": "addForgeAccount", "params": {"host": host, "kind": kind, "token": token}})).await;
    let (repo, head) = big_repo(url);
    let mut seed = h.forge.current_seed();
    if kind == "gitlab" { gitlab_seed(&mut seed, &head, running) } else { github_seed(&mut seed, &head, running) }
    h.forge.seed(seed);
    let id = ok(&h.api, json!({"method": "openRepo", "params": {"path": repo.path()}})).await["id"].as_u64().unwrap();
    h.forge.clear_requests();
    Setup { h, id, _repo: repo }
}

/// The UI's poll (`pollOnce`): `full` asks the projects (again on `activate`) and the badges;
/// every poll asks the list for `filter` and the open MR/PR's detail and discussions.
pub async fn poll(s: &Setup, reason: &str, filter: &str, open: Option<u64>) {
    let api = &s.h.api;
    // Polls are at least 20 s apart: nothing is fresh from the last one.
    s.h.forge.advance();
    if reason != "fast" {
        ok(api, json!({"method": "forgeRepoProjects", "params": {"repo": s.id, "refresh": reason == "activate"}})).await;
        ok(api, json!({"method": "forgeBranchMrs", "params": {"repo": s.id, "refs": remote_refs()}})).await;
    }
    ok(api, json!({"method": "forgeMrList", "params": {"repo": s.id, "filter": filter}})).await;
    if let Some(n) = open {
        open_mr(s, n).await;
    }
}

/// The MR/PR view opening: its detail and discussions at once (`refreshMr`), and the merge box's settings.
pub async fn open_mr(s: &Setup, n: u64) {
    let api = &s.h.api;
    s.h.forge.advance();
    let (d, t) = tokio::join!(
        call(api, json!({"method": "forgeMrDetail", "params": {"repo": s.id, "number": n}})),
        call(api, json!({"method": "forgeMrDiscussions", "params": {"repo": s.id, "number": n}})),
    );
    d.unwrap();
    t.unwrap();
}

/// Requests by endpoint (numbers, shas and branch names folded), and how many were 304s.
pub fn grouped(reqs: &[RecordedRequest]) -> BTreeMap<String, (usize, usize)> {
    let mut out: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for r in reqs {
        let path: Vec<String> = r
            .path
            .split('/')
            .map(|seg| {
                if seg.len() == 40 && seg.chars().all(|c| c.is_ascii_hexdigit()) {
                    ":sha".to_string()
                } else if !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()) {
                    ":n".to_string()
                } else {
                    seg.to_string()
                }
            })
            .collect();
        let keys: Vec<String> = r
            .query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .filter(|(k, _)| ["state", "source_branch", "head", "scope", "reviewer_id", "target_branch", "base", "updated_after"].contains(k))
            .map(|(k, v)| if k == "state" { format!("{k}={v}") } else { k.to_string() })
            .collect();
        let key = format!("{} {}{}", r.method, path.join("/").replace("/api/v4/projects/group%2Fproject", "/api/v4/projects/:path"), if keys.is_empty() { String::new() } else { format!("?{}", keys.join("&")) });
        let e = out.entry(key).or_default();
        e.0 += 1;
        e.1 += usize::from(r.status == 304);
    }
    out
}

/// One measured step: its total, its 304s, and the endpoints.
pub struct Step {
    pub name: String,
    pub total: usize,
    pub not_modified: usize,
    pub by: BTreeMap<String, (usize, usize)>,
}

pub fn take(s: &Setup, name: &str) -> Step {
    let reqs = s.h.forge.requests();
    s.h.forge.clear_requests();
    let by = grouped(&reqs);
    Step { name: name.to_string(), total: reqs.len(), not_modified: reqs.iter().filter(|r| r.status == 304).count(), by }
}

pub fn print(kind: &str, steps: &[Step]) {
    eprintln!("\n=== {kind} ===");
    for s in steps {
        eprintln!("{:<44} {:>5} requests ({} × 304)", s.name, s.total, s.not_modified);
        for (k, (n, nm)) in &s.by {
            eprintln!("    {n:>4} ({nm:>3} × 304)  {k}");
        }
    }
}

/// The UI's poller in 10 idle minutes after an `activate` poll (`createForgePoller`): a full
/// poll per fetch interval (60 s by default, never less), and while a shown MR/PR's pipeline
/// runs, `fast` polls between them, 20 s, 40 s, 80 s then 2 min apart while the same one runs
/// (`fastPollMs`). Before this change: `fast` polls every 20 s, whatever ran.
pub async fn idle_ten_minutes(s: &Setup, pipeline: bool) {
    let (mut t, mut last_full, mut streak) = (0u64, 0u64, 0u32);
    loop {
        let fast = (20u64 << streak.min(3)).min(120);
        t += if pipeline { fast.min(60) } else { 60 };
        if t > 600 {
            break;
        }
        if t - last_full >= 60 {
            poll(s, "timer", "all", None).await;
            last_full = t;
        } else {
            poll(s, "fast", "all", None).await;
        }
        if pipeline {
            streak += 1;
        }
    }
}

/// Every step, (a) to (f), on one forge.
pub async fn measure(kind: &'static str) -> Vec<Step> {
    let s = setup(kind, false).await;
    let mut steps = Vec::new();
    poll(&s, "activate", "all", None).await;
    steps.push(take(&s, "(a) first poll (activate)"));
    poll(&s, "timer", "all", None).await;
    steps.push(take(&s, "(a2) second poll (lookups past the cap)"));
    poll(&s, "timer", "all", None).await;
    steps.push(take(&s, "(b) steady poll, nothing changed"));
    let mut seed = s.h.forge.current_seed();
    if kind == "gitlab" {
        let m = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 105).unwrap();
        m.title = "Change 105, edited".into();
        m.updated_at = "2026-10-05T09:00:00Z".into();
    } else {
        let p = seed.github.pulls.iter_mut().find(|p| p.number == 105).unwrap();
        p.title = "Change 105, edited".into();
        p.updated_at = "2026-10-05T09:00:00Z".into();
    }
    s.h.forge.seed(seed);
    poll(&s, "timer", "all", None).await;
    steps.push(take(&s, "(c) poll after one MR changed"));
    for f in ["all", "mine", "reviewRequested"] {
        s.h.forge.advance();
        ok(&s.h.api, json!({"method": "forgeMrList", "params": {"repo": s.id, "filter": f}})).await;
    }
    steps.push(take(&s, "(d) list filters all, mine, review requested"));
    // The concurrency peak: every request waits 20 ms while the view opens.
    s.h.forge.set_delay_ms(20);
    open_mr(&s, 105).await;
    let peak = s.h.forge.peak_in_flight();
    s.h.forge.set_delay_ms(0);
    steps.push(take(&s, &format!("(e) MR view opens (peak in flight {peak})")));
    idle_ten_minutes(&s, false).await;
    steps.push(take(&s, "(f) 10 idle minutes, no pipeline"));
    let r = setup(kind, true).await;
    poll(&r, "activate", "all", None).await;
    r.h.forge.clear_requests();
    idle_ten_minutes(&r, true).await;
    steps.push(take(&r, "(f) 10 idle minutes, a pipeline running"));
    steps
}

/// Requests whose endpoint key has `part`.
fn count(step: &Step, part: &str) -> usize {
    step.by.iter().filter(|(k, _)| k.contains(part)).map(|(_, (n, _))| n).sum()
}

/// What the fix promises, on either forge: lookups per branch only for branches never asked
/// (the first two polls, `BRANCH_LOOKUPS` each), none per MR/PR for the list; a steady poll is
/// one request (the list, a 304); one detail request for an opened MR/PR.
fn assert_cheap(kind: &str, steps: &[Step], lookup: &str, detail: &str) {
    let [a, a2, b, c, d, e, idle, running] = steps else { panic!("{kind}: {} steps", steps.len()) };
    assert!(count(a, lookup) <= gitbolt_core::forge::mrs::BRANCH_LOOKUPS && a.total <= gitbolt_core::forge::mrs::BRANCH_LOOKUPS + 5, "{kind} (a): {:?}", a.by);
    assert_eq!(count(a, "/commits/") + count(a, "/approvals"), 0, "{kind} (a): nothing per MR/PR");
    assert_eq!(count(a, lookup) + count(a2, lookup), usize::try_from(crate::forge_poll_cost::MERGED + crate::forge_poll_cost::CLOSED + crate::forge_poll_cost::NO_MR).unwrap(), "{kind}: each branch without an open MR/PR asked once");
    assert_eq!((b.total, b.not_modified, count(b, lookup)), (1, 1, 0), "{kind} (b): one list request, a 304: {:?}", b.by);
    assert!(c.total <= 2 && count(c, lookup) == 0, "{kind} (c): {:?}", c.by);
    assert!(d.total <= 4 && count(d, "/commits/") == 0 && count(d, "/pipelines") <= 1, "{kind} (d): {:?}", d.by);
    assert_eq!(e.by.get(detail).map(|(n, _)| *n), Some(1), "{kind} (e): one detail request: {:?}", e.by);
    assert_eq!((idle.total, idle.not_modified), (10, 10), "{kind} (f): a 304 a minute");
    assert!(running.total <= 40, "{kind} (f, running): {:?}", running.by);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_poll_cost_on_a_big_gitlab_repo() {
    let steps = measure("gitlab").await;
    print("GitLab", &steps);
    assert_cheap("gitlab", &steps, "source_branch", "GET /api/v4/projects/:n/merge_requests/:n");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_poll_cost_on_a_big_github_repo() {
    let steps = measure("github").await;
    print("GitHub", &steps);
    assert_cheap("github", &steps, "?head", "GET /repos/octo-org/widget/pulls/:n");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_carries_the_rate_limit_and_a_spent_budget_waits_for_its_reset() {
    for kind in ["gitlab", "github"] {
        let s = setup(kind, false).await;
        let reset = 4_102_444_000;
        s.h.forge.set_rate(150, reset);
        let list = ok(&s.h.api, json!({"method": "forgeMrList", "params": {"repo": s.id, "filter": "all"}})).await;
        let limit = if kind == "gitlab" { 2000 } else { 5000 };
        assert_eq!(list["rateLimit"], json!({"limitedUntil": null, "remaining": 150, "resetAt": reset, "limit": limit}), "{kind}");
        // The last of the budget: that answer is good, the next request waits for the reset.
        s.h.forge.set_rate(0, reset);
        s.h.forge.advance();
        let list = ok(&s.h.api, json!({"method": "forgeMrList", "params": {"repo": s.id, "filter": "all"}})).await;
        assert!(list["rateLimit"]["limitedUntil"].as_i64().is_some(), "{kind}: the list says until when the next waits: {list}");
        s.h.forge.clear_requests();
        s.h.forge.advance();
        let e = call(&s.h.api, json!({"method": "forgeMrList", "params": {"repo": s.id, "filter": "all"}})).await.unwrap_err();
        assert_eq!(e.kind, gitbolt_core::error::GbErrorKind::RateLimited, "{kind}");
        assert!(s.h.forge.requests().is_empty(), "{kind}: no request until the reset");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn never_more_than_four_requests_in_flight_per_account() {
    for kind in ["gitlab", "github"] {
        let s = setup(kind, false).await;
        poll(&s, "activate", "all", None).await;
        // A slow forge, and the UI asking a lot at once (hover cards, the open MR, its threads).
        s.h.forge.set_delay_ms(40);
        s.h.forge.clear_requests();
        let api = &s.h.api;
        let asks = (100..112).flat_map(|n| [json!({"method": "forgeMrDetail", "params": {"repo": s.id, "number": n}}), json!({"method": "forgeMrDiscussions", "params": {"repo": s.id, "number": n}})]);
        let all = futures_util::future::join_all(asks.map(|v| call(api, v))).await;
        assert!(all.iter().all(|r| r.is_ok()), "{kind}: every one answered");
        let peak = s.h.forge.peak_in_flight();
        assert!((2..=gitbolt_forge::http::PARALLEL).contains(&peak), "{kind}: at most {} at once, saw {peak}", gitbolt_forge::http::PARALLEL);
        s.h.forge.set_delay_ms(0);
    }
}

/// A GitLab that sends no ETags (some versions and proxies): no 304s, so a steady poll would read
/// every list in full; it asks instead whether any MR changed since (one MR at most).
#[tokio::test(flavor = "multi_thread")]
async fn the_poll_cost_on_a_big_gitlab_repo_without_etags() {
    let s = setup("gitlab", false).await;
    s.h.forge.set_gitlab_etags(false);
    let mut steps = Vec::new();
    poll(&s, "activate", "all", None).await;
    steps.push(take(&s, "(a) first poll (activate)"));
    poll(&s, "timer", "all", None).await;
    steps.push(take(&s, "(a2) second poll (lookups past the cap)"));
    poll(&s, "timer", "all", None).await;
    steps.push(take(&s, "(b) steady poll, nothing changed"));
    let mut seed = s.h.forge.current_seed();
    let m = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 105).unwrap();
    m.title = "Change 105, edited".into();
    m.updated_at = "2026-10-05T09:00:00Z".into();
    s.h.forge.seed(seed);
    poll(&s, "timer", "all", None).await;
    steps.push(take(&s, "(c) poll after one MR changed"));
    idle_ten_minutes(&s, false).await;
    steps.push(take(&s, "(f) 10 idle minutes, no pipeline"));
    print("GitLab without ETags", &steps);
    assert_eq!((steps[2].total, count(&steps[2], "updated_after")), (1, 1), "(b): the probe only: {:?}", steps[2].by);
    assert_eq!(steps[3].total, 2, "(c): the probe, then the list: {:?}", steps[3].by);
    assert_eq!(steps[4].total, 10, "(f): a probe a minute");
}

/// The review session's refresh in each poll (`refreshReview`): its drafts (the diff only when
/// the head moved). Pinned per forge, so a request more shows: GitLab asks the MR and its draft
/// notes; GitHub the PR and its reviews (and the user once). Nothing changed: all 304s.
#[tokio::test(flavor = "multi_thread")]
async fn a_review_session_refresh_costs_a_fixed_few_requests() {
    for (kind, start, steady) in [("gitlab", 2, 2), ("github", 3, 2)] {
        let s = setup(kind, false).await;
        poll(&s, "activate", "all", None).await;
        s.h.forge.clear_requests();
        let drafts = json!({"method": "forgeReviewDrafts", "params": {"repo": s.id, "number": 105}});
        s.h.forge.advance();
        ok(&s.h.api, drafts.clone()).await;
        let first = take(&s, "review session starts");
        s.h.forge.advance();
        ok(&s.h.api, drafts).await;
        let again = take(&s, "review session refresh, nothing changed");
        assert_eq!(first.total, start, "{kind}: {:?}", first.by);
        assert_eq!((again.total, again.not_modified), (steady, steady), "{kind}: {:?}", again.by);
    }
}
