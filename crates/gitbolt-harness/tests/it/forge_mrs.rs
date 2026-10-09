//! MRs and PRs through the harness's `Api`: real providers, the fake forge (spec #4 §7).

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};

async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

/// A repo whose origin is `url`, with local `dev` tracking `origin/dev`.
fn repo_on(url: &str) -> TestRepo {
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", url]);
    r.git(&["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    r.git(&["branch", "dev"]);
    r.git(&["config", "branch.dev.remote", "origin"]);
    r.git(&["config", "branch.dev.merge", "refs/heads/dev"]);
    r
}

async fn open(api: &Api, r: &TestRepo) -> u64 {
    call(api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gitlab_repo_gets_badges_a_list_details_and_its_writes_answered() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let r = repo_on("https://gitlab.example.com/group/project.git");
    let id = open(&h.api, &r).await;

    let badges = call(&h.api, json!({"method": "forgeBranchMrs", "params": {"repo": id, "refs": ["refs/remotes/origin/dev", "refs/remotes/origin/feature/old"]}})).await.unwrap();
    let by: std::collections::BTreeMap<String, (u64, String)> = badges["mrs"].as_array().unwrap().iter().map(|b| (b["remoteRef"].as_str().unwrap().to_string(), (b["mr"]["number"].as_u64().unwrap(), b["mr"]["state"].as_str().unwrap().to_string()))).collect();
    assert_eq!(by["refs/remotes/origin/dev"], (12, "open".to_string()));
    // Looked up in any state: merged, and this repo has no `origin/feature/old` at its head (nor a
    // branch tracking it), so no badge; 4D's stacks still read it.
    assert!(!by.contains_key("refs/remotes/origin/feature/old"), "{by:?}");
    let history: Vec<(&str, u64)> = badges["history"].as_array().unwrap().iter().map(|b| (b["remoteRef"].as_str().unwrap(), b["mr"]["number"].as_u64().unwrap())).collect();
    assert_eq!(history, [("refs/remotes/origin/feature/old", 9)]);
    assert_eq!(by["refs/remotes/origin/diverged"], (5, "draft".to_string()), "every open one on a mapped remote");

    let review = call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "reviewRequested"}})).await.unwrap();
    assert_eq!(review["mrs"].as_array().unwrap().iter().map(|m| m["number"].as_u64().unwrap()).collect::<Vec<_>>(), [12]);
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(detail["value"]["mr"]["pipeline"]["status"], "success");
    assert_eq!(detail["value"]["mergeStatus"], json!({"kind": "blocked", "reason": "It needs approval first"}));
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(threads["value"][1]["notes"][0]["position"]["snippet"], " Readme\n+Second line");

    let note = call(&h.api, json!({"method": "forgeReply", "params": {"repo": id, "number": 12, "discussion": null, "body": "Thanks!"}})).await.unwrap();
    assert_eq!(note["author"]["username"], "ada");
    call(&h.api, json!({"method": "forgeApprove", "params": {"repo": id, "number": 12}})).await.unwrap();
    let head = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap()["value"]["mr"]["headSha"].clone();
    let merged = call(&h.api, json!({"method": "forgeMerge", "params": {"repo": id, "number": 12, "options": {"method": null, "squash": true, "deleteSourceBranch": true, "expectedSha": head}}})).await.unwrap();
    assert_eq!(merged["state"], "merged");
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_repo_gets_its_pull_requests() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    let r = repo_on("https://github.com/octo-org/widget.git");
    let id = open(&h.api, &r).await;
    let list = call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "all"}})).await.unwrap();
    assert_eq!(list["kind"], "github");
    assert_eq!(list["mrs"].as_array().unwrap().iter().map(|m| m["number"].as_u64().unwrap()).collect::<Vec<_>>(), [3, 6, 7]);
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!((detail["value"]["mr"]["review"]["decision"].as_str(), detail["value"]["mergeStatus"]["kind"].as_str()), (Some("approved"), Some("mergeable")));
    let draft = call(&h.api, json!({"method": "forgeSetDraft", "params": {"repo": id, "number": 3, "draft": true}})).await.unwrap();
    assert_eq!(draft["state"], "draft");
}

// --- auto-merge ---
#[tokio::test(flavor = "multi_thread")]
async fn auto_merge_is_set_and_cancelled_through_the_api() {
    let h = Harness::for_tests().await;
    let mut seed = h.forge.current_seed();
    let m = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap();
    m.pipeline = Some("running".into());
    m.merge_status = "ci_still_running".into();
    h.forge.seed(seed);
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let r = repo_on("https://gitlab.example.com/group/project.git");
    let id = open(&h.api, &r).await;
    let set = call(&h.api, json!({"method": "forgeSetAutoMerge", "params": {"repo": id, "number": 12, "options": {"method": null, "squash": false, "deleteSourceBranch": true, "expectedSha": null}}})).await.unwrap();
    assert_eq!((set["state"].as_str(), set["autoMerge"]["enabledBy"]["username"].as_str()), (Some("open"), Some("ada")));
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(detail["value"]["mr"]["autoMerge"]["enabledBy"]["username"], "ada");
    let cancelled = call(&h.api, json!({"method": "forgeCancelAutoMerge", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(cancelled["autoMerge"], serde_json::Value::Null);
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITLAB_TOKEN));
}
// --- end auto-merge ---

// --- branch update ---
#[tokio::test(flavor = "multi_thread")]
async fn a_gitlab_mr_behind_its_target_is_rebased_through_the_api() {
    let h = Harness::for_tests().await;
    let mut seed = h.forge.current_seed();
    let m = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap();
    (m.diverged_commits_count, m.merge_status) = (3, "need_rebase".into());
    let failing = seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 5).unwrap();
    failing.rebase_error = Some("Rebase failed: conflicts. Please rebase locally".into());
    h.forge.seed(seed);
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": GITLAB_TOKEN}})).await.unwrap();
    let r = repo_on("https://gitlab.example.com/group/project.git");
    let id = open(&h.api, &r).await;

    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(detail["value"]["update"], json!({"behind": 3, "kinds": ["rebase", "rebaseSkipCi"], "inProgress": false}));
    let head = detail["value"]["mr"]["headSha"].clone();
    let out = call(&h.api, json!({"method": "forgeUpdateBranch", "params": {"repo": id, "number": 12, "how": "rebaseSkipCi", "expectedSha": head}})).await.unwrap();
    assert_ne!(out["headSha"], head, "the rebased head");
    // Asked while GitLab rebased it (in progress for one read), then done.
    let looks = h.forge.requests().iter().filter(|q| q.method == "GET" && q.path.ends_with("/merge_requests/12") && q.query.contains("include_rebase_in_progress")).count();
    assert_eq!(looks, 3, "the detail, then in progress, then done");
    let m = h.forge.current_seed().gitlab.merge_requests.into_iter().find(|m| m.iid == 12).unwrap();
    assert_eq!((m.rebases, m.rebase_skipped_ci, m.pipeline), (1, true, None), "without pipeline");
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(detail["value"].get("update"), None, "up to date");
    assert_eq!(detail["value"]["mergeStatus"]["kind"], "mergeable");

    // A rebase GitLab can't do: its merge_error, and nothing moved.
    let e = call(&h.api, json!({"method": "forgeUpdateBranch", "params": {"repo": id, "number": 5, "how": "rebase", "expectedSha": null}})).await.unwrap_err();
    assert_eq!(e.message, "GitLab couldn't rebase !5: Rebase failed: conflicts. Please rebase locally");
    // One the user can't push: GitLab's 403 in its words, and the account stays fine.
    let mut seed = h.forge.current_seed();
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 5).unwrap().rebase_forbidden = true;
    h.forge.seed(seed);
    let e = call(&h.api, json!({"method": "forgeUpdateBranch", "params": {"repo": id, "number": 5, "how": "rebase", "expectedSha": null}})).await.unwrap_err();
    assert_eq!(e.message, "GitLab can't rebase !5: Cannot push to source branch");
    let accounts = call(&h.api, json!({"method": "forgeAccounts"})).await.unwrap();
    assert_eq!(accounts[0]["status"]["kind"], "ok", "{accounts}");
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_pr_behind_its_base_is_updated_by_merge_or_rebase_through_the_api() {
    let h = Harness::for_tests().await;
    let behind = |h: &Harness| {
        let mut seed = h.forge.current_seed();
        seed.github.pulls.iter_mut().find(|p| p.number == 3).unwrap().mergeable_state = "behind".into();
        h.forge.seed(seed);
    };
    behind(&h);
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    let r = repo_on("https://github.com/octo-org/widget.git");
    let id = open(&h.api, &r).await;

    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!(detail["value"]["update"], json!({"behind": null, "kinds": ["merge", "rebase"], "inProgress": false}));
    let head = detail["value"]["mr"]["headSha"].clone();
    // A head that moved since: refused, in plain words.
    let e = call(&h.api, json!({"method": "forgeUpdateBranch", "params": {"repo": id, "number": 3, "how": "merge", "expectedSha": "f".repeat(40)}})).await.unwrap_err();
    assert_eq!(e.message, "#3 changed since it was loaded: refresh and try again");
    let out = call(&h.api, json!({"method": "forgeUpdateBranch", "params": {"repo": id, "number": 3, "how": "merge", "expectedSha": head}})).await.unwrap();
    assert_ne!(out["headSha"], head);
    let pull = |h: &Harness| h.forge.current_seed().github.pulls.into_iter().find(|p| p.number == 3).unwrap();
    assert_eq!(pull(&h).updated_with, "merge");
    let detail = call(&h.api, json!({"method": "forgeMrDetail", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!(detail["value"].get("update"), None, "up to date");

    behind(&h);
    let out = call(&h.api, json!({"method": "forgeUpdateBranch", "params": {"repo": id, "number": 3, "how": "rebase", "expectedSha": null}})).await.unwrap();
    assert_eq!((pull(&h).updated_with.as_str(), out["headSha"].as_str()), ("rebase", Some(pull(&h).head_sha.as_str())));
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITHUB_TOKEN));
}
// --- end branch update ---

// --- 4B final fix ---
#[tokio::test(flavor = "multi_thread")]
async fn a_full_github_poll_reads_each_prs_checks_once() {
    let h = Harness::for_tests().await;
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await.unwrap();
    let r = repo_on("https://github.com/octo-org/widget.git");
    let id = open(&h.api, &r).await;
    let checks = |h: &Harness| h.forge.requests().iter().filter(|q| q.path.ends_with("/check-runs")).count();
    let before = checks(&h);
    // The poll's badges, then its list (UI forge/poll.ts).
    call(&h.api, json!({"method": "forgeBranchMrs", "params": {"repo": id, "refs": ["refs/remotes/origin/dev"]}})).await.unwrap();
    assert_eq!(checks(&h), before, "the badges read no checks");
    let list = call(&h.api, json!({"method": "forgeMrList", "params": {"repo": id, "filter": "all"}})).await.unwrap();
    assert_eq!(list["mrs"].as_array().unwrap().len(), 3);
    assert_eq!(checks(&h) - before, 0, "no request per PR: one GraphQL query for them all");
    assert_eq!(h.forge.requests().iter().filter(|q| q.path == "/graphql").count(), 1);
}
// --- end 4B final fix ---

#[tokio::test(flavor = "multi_thread")]
async fn the_add_account_helper_the_test_route_uses_adds_an_account() {
    let h = Harness::for_tests().await;
    let added = h.add_forge_account_for_test("gitlab.example.com", gitbolt_core::forge::ForgeKind::GitLab, GITLAB_TOKEN).await.unwrap();
    assert_eq!(added["account"]["user"]["username"], "ada");
}
