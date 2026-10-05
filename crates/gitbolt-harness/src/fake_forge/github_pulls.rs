//! GitHub pull requests in the fake forge (4B): the list (state, head), one PR, its reviews,
//! review comments, conversation, a commit's check runs and statuses; 4B T5 adds the writes and
//! the GraphQL draft mutations. The PRs live in the seed (`GitHubSeed.pulls`). Like GitHub, a
//! list's PRs have no `mergeable` (a single PR's GET has it).

use super::{FakeRequest, FakeUser, ForgeState, Reply};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const WRITE_TIME: &str = "2026-10-04T12:30:00Z";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeCheck {
    pub name: String,
    /// `queued`, `in_progress`, `completed`.
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeStatus {
    pub context: String,
    /// `pending`, `success`, `failure`, `error`.
    pub state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeReview {
    pub id: u64,
    pub user: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`.
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeComment {
    pub id: u64,
    pub user: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeReviewComment {
    pub id: u64,
    pub user: String,
    pub body: String,
    pub created_at: String,
    pub path: String,
    pub line: Option<u32>,
    /// `RIGHT` (the new side) or `LEFT`.
    pub side: String,
    pub diff_hunk: String,
    pub in_reply_to: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakePull {
    pub number: u64,
    /// The base repository's `owner/repo`.
    pub repo: String,
    /// The head's repository; empty: `repo`.
    pub head_repo: String,
    pub head_ref: String,
    pub base_ref: String,
    pub title: String,
    pub body: String,
    /// `open`, `closed`.
    pub state: String,
    pub merged: bool,
    /// The method the fake merged it with.
    pub merged_with: String,
    pub draft: bool,
    pub author: String,
    pub head_sha: String,
    pub labels: Vec<String>,
    pub requested_reviewers: Vec<String>,
    pub assignees: Vec<String>,
    pub mergeable: Option<bool>,
    pub mergeable_state: String,
    pub checks: Vec<FakeCheck>,
    pub statuses: Vec<FakeStatus>,
    pub reviews: Vec<FakeReview>,
    pub comments: Vec<FakeComment>,
    pub review_comments: Vec<FakeReviewComment>,
    pub updated_at: String,
}

pub fn default_users() -> Vec<FakeUser> {
    vec![
        FakeUser {
            id: 2,
            username: "monalisa".into(),
            name: "Mona Lisa".into(),
            email: None,
            avatar_url: None,
        },
        FakeUser {
            id: 3,
            username: "hubot".into(),
            name: "Hubot".into(),
            email: None,
            avatar_url: None,
        },
    ]
}

pub fn default_pulls() -> Vec<FakePull> {
    let pull = |number: u64, title: &str, head: &str, author: &str, day: &str| FakePull {
        number,
        repo: "octo-org/widget".into(),
        head_ref: head.into(),
        base_ref: "main".into(),
        title: title.into(),
        state: "open".into(),
        author: author.into(),
        head_sha: format!("{number:0>40}"),
        mergeable: Some(true),
        mergeable_state: "clean".into(),
        updated_at: format!("{day}T10:00:00Z"),
        ..Default::default()
    };
    let check = |status: &str, conclusion: Option<&str>| FakeCheck {
        name: "build".into(),
        status: status.into(),
        conclusion: conclusion.map(str::to_string),
    };
    let hunk = "@@ -1 +1,2 @@\n Readme\n+Second line";
    let comment =
        |id: u64, user: &str, body: &str, at: &str, reply: Option<u64>| FakeReviewComment {
            id,
            user: user.into(),
            body: body.into(),
            created_at: at.into(),
            path: "README.md".into(),
            line: Some(2),
            side: "RIGHT".into(),
            diff_hunk: hunk.into(),
            in_reply_to: reply,
        };
    vec![
        FakePull {
            body: "Adds the dev work.".into(),
            requested_reviewers: vec!["octocat".into()],
            labels: vec!["backend".into()],
            checks: vec![check("completed", Some("success"))],
            reviews: vec![
                FakeReview {
                    id: 31,
                    user: "hubot".into(),
                    state: "CHANGES_REQUESTED".into(),
                    body: "Please add a test.".into(),
                    submitted_at: "2026-10-03T08:00:00Z".into(),
                },
                FakeReview {
                    id: 32,
                    user: "hubot".into(),
                    state: "APPROVED".into(),
                    body: "Looks good now.".into(),
                    submitted_at: "2026-10-04T08:00:00Z".into(),
                },
            ],
            comments: vec![FakeComment {
                id: 41,
                user: "monalisa".into(),
                body: "Ready for review.".into(),
                created_at: "2026-10-03T07:00:00Z".into(),
            }],
            review_comments: vec![
                comment(
                    51,
                    "hubot",
                    "Why the second line?",
                    "2026-10-03T08:01:00Z",
                    None,
                ),
                comment(
                    52,
                    "monalisa",
                    "It documents the setup.",
                    "2026-10-03T09:00:00Z",
                    Some(51),
                ),
            ],
            ..pull(3, "Dev work", "dev", "monalisa", "2026-10-04")
        },
        FakePull {
            draft: true,
            mergeable: None,
            mergeable_state: "draft".into(),
            checks: vec![check("in_progress", None)],
            statuses: vec![FakeStatus {
                context: "ci/legacy".into(),
                state: "pending".into(),
            }],
            ..pull(6, "Explore caching", "diverged", "octocat", "2026-10-03")
        },
        FakePull {
            state: "closed".into(),
            merged: true,
            ..pull(4, "Old feature", "feature/old", "monalisa", "2026-09-20")
        },
        FakePull {
            head_repo: "octocat/widget".into(),
            mergeable: Some(false),
            mergeable_state: "dirty".into(),
            ..pull(7, "Fix from a fork", "fork-fix", "octocat", "2026-10-02")
        },
    ]
}

fn person(st: &ForgeState, login: &str) -> FakeUser {
    st.seed
        .github
        .tokens
        .iter()
        .map(|t| &t.user)
        .chain(st.seed.github.users.iter())
        .find(|u| u.username == login)
        .cloned()
        .unwrap_or_else(|| FakeUser {
            id: 999,
            username: login.into(),
            name: login.into(),
            ..Default::default()
        })
}

/// GitHub's simple user (no name: the client shows the login).
fn user_json(st: &ForgeState, login: &str, base: &str) -> Value {
    let u = person(st, login);
    json!({ "id": u.id, "login": u.username, "avatar_url": u.avatar_url, "html_url": format!("{base}/github-web/{}", u.username) })
}

fn head_repo(p: &FakePull) -> &str {
    if p.head_repo.is_empty() {
        &p.repo
    } else {
        &p.head_repo
    }
}

/// One PR as GitHub answers it; `single`: a GET of that PR (with `mergeable`).
pub fn pull_json(st: &ForgeState, p: &FakePull, base: &str, single: bool) -> Value {
    let mut v = json!({
        "id": 9_000 + p.number, "node_id": format!("PR_{}", p.number), "number": p.number, "title": p.title, "body": p.body,
        "state": p.state, "draft": p.draft, "merged": p.merged, "merged_at": if p.merged { Value::from(WRITE_TIME) } else { Value::Null },
        "user": user_json(st, &p.author, base),
        "head": { "ref": p.head_ref, "sha": p.head_sha, "repo": { "full_name": head_repo(p) } },
        "base": { "ref": p.base_ref, "repo": { "full_name": p.repo } },
        "html_url": format!("{base}/github-web/{}/pull/{}", p.repo, p.number),
        "labels": p.labels.iter().map(|l| json!({ "name": l })).collect::<Vec<_>>(),
        "requested_reviewers": p.requested_reviewers.iter().map(|u| user_json(st, u, base)).collect::<Vec<_>>(),
        "assignees": p.assignees.iter().map(|u| user_json(st, u, base)).collect::<Vec<_>>(),
        "updated_at": p.updated_at,
    });
    if single {
        v["mergeable"] = p.mergeable.map_or(Value::Null, Value::from);
        v["mergeable_state"] = p.mergeable_state.clone().into();
    }
    v
}

fn review_json(st: &ForgeState, r: &FakeReview, base: &str) -> Value {
    json!({ "id": r.id, "user": user_json(st, &r.user, base), "state": r.state, "body": r.body, "submitted_at": r.submitted_at })
}

fn comment_json(st: &ForgeState, c: &FakeComment, base: &str) -> Value {
    json!({ "id": c.id, "user": user_json(st, &c.user, base), "body": c.body, "created_at": c.created_at })
}

fn review_comment_json(st: &ForgeState, c: &FakeReviewComment, base: &str) -> Value {
    json!({
        "id": c.id, "user": user_json(st, &c.user, base), "body": c.body, "created_at": c.created_at, "path": c.path,
        "line": c.line, "original_line": c.line, "side": c.side, "diff_hunk": c.diff_hunk, "in_reply_to_id": c.in_reply_to,
    })
}

fn not_found() -> Reply {
    Reply::status(404, json!({ "message": "Not Found" }))
}

// --- 5A T3: GitHub's `full` media type and its signed images ---
/// `body_html` as far as GitBolt reads it: each `…/user-attachments/assets/<uuid>` in `body`
/// becomes a signed `private-user-images` URL (here `<base>/github-images/583231/<n>-<uuid>.png?jwt=<jwt>`),
/// as a linked image, in document order.
pub fn fake_body_html(body: &str, base: &str, jwt: &str) -> String {
    const MARK: &str = "/user-attachments/assets/";
    let mut out = String::from("<p>");
    let mut rest = body;
    let mut n = 0;
    while let Some(i) = rest.find(MARK) {
        let after = &rest[i + MARK.len()..];
        let uuid: String = after.chars().take_while(|c| c.is_ascii_hexdigit() || *c == '-').collect();
        if uuid.len() == 36 {
            n += 1;
            let url = format!("{base}/github-images/583231/{}-{uuid}.png?jwt={jwt}", 400_000 + n);
            out.push_str(&format!("<a target=\"_blank\" rel=\"noopener noreferrer\" href=\"{url}\"><img src=\"{url}\" alt=\"image\"></a>"));
        }
        rest = &after[uuid.len()..];
    }
    out.push_str("</p>");
    out
}

/// A GET answered with GitHub's `full` media type: every object with a `body` gets `body_html`.
fn with_body_html(reply: Reply, base: &str, jwt: &str) -> Reply {
    if reply.status != 200 || reply.content_type != "application/json" {
        return reply;
    }
    let Ok(mut v) = serde_json::from_slice::<Value>(&reply.body) else { return reply };
    fn add(o: &mut Value, base: &str, jwt: &str) {
        if let Some(b) = o.get("body").and_then(Value::as_str).map(str::to_string) {
            o["body_html"] = fake_body_html(&b, base, jwt).into();
        }
    }
    if let Value::Array(items) = &mut v {
        items.iter_mut().for_each(|o| add(o, base, jwt));
    } else if v.is_object() {
        add(&mut v, base, jwt);
    }
    Reply { body: v.to_string().into_bytes(), ..reply }
}

/// `<base>/github-images/…?jwt=<jwt>`: the seed's `image_jwt` is the one valid signature.
pub(crate) fn image(st: &ForgeState, r: &FakeRequest) -> Reply {
    match r.query.get("jwt") {
        Some(j) if *j == st.seed.github.image_jwt => Reply::png(),
        _ => Reply::status(403, json!({ "message": "Request has expired" })),
    }
}
// --- end 5A T3 ---

// --- 4B T5 ---
fn body_of(r: &FakeRequest) -> Value {
    serde_json::from_slice(r.body).unwrap_or(Value::Null)
}

fn login(r: &FakeRequest) -> String {
    r.token.as_ref().map(|t| t.user.username.clone()).unwrap_or_default()
}

/// The next free id among a PR's comments, review comments and reviews (from 1000).
fn next_id(p: &FakePull) -> u64 {
    p.comments.iter().map(|c| c.id).chain(p.review_comments.iter().map(|c| c.id)).chain(p.reviews.iter().map(|r| r.id)).max().unwrap_or(0).max(1000) + 1
}

/// GitHub's two draft mutations, by the PR's `node_id`.
/// The open PRs' head checks, as GitHub's `statusCheckRollup` query answers them (`ROLLUP_QUERY`).
fn rollups(st: &ForgeState, vars: &Value) -> Reply {
    let repo = format!("{}/{}", vars["owner"].as_str().unwrap_or_default(), vars["name"].as_str().unwrap_or_default());
    if !st.seed.github.repos.iter().any(|p| p.path == repo) {
        return Reply::json(json!({ "data": { "repository": null }, "errors": [{ "type": "NOT_FOUND", "message": format!("Could not resolve to a Repository with the name '{repo}'.") }] }));
    }
    let mut open: Vec<&FakePull> = st.seed.github.pulls.iter().filter(|p| p.repo == repo && p.state == "open").collect();
    open.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let nodes: Vec<Value> = open
        .iter()
        .take(100)
        .map(|p| {
            let mut contexts: Vec<Value> = p.checks.iter().map(|c| json!({ "__typename": "CheckRun", "status": c.status.to_ascii_uppercase(), "conclusion": c.conclusion.as_ref().map(|x| x.to_ascii_uppercase()) })).collect();
            contexts.extend(p.statuses.iter().map(|x| json!({ "__typename": "StatusContext", "state": x.state.to_ascii_uppercase() })));
            let rollup = if contexts.is_empty() { Value::Null } else { json!({ "contexts": { "nodes": contexts } }) };
            json!({ "number": p.number, "commits": { "nodes": [{ "commit": { "oid": p.head_sha, "statusCheckRollup": rollup } }] } })
        })
        .collect();
    Reply::json(json!({ "data": { "repository": { "pullRequests": { "nodes": nodes } } } }))
}

fn graphql(st: &mut ForgeState, r: &FakeRequest) -> Reply {
    let b = body_of(r);
    let query = b["query"].as_str().unwrap_or_default();
    let id = b["variables"]["id"].as_str().unwrap_or_default().to_string();
    if query.contains("statusCheckRollup") {
        return rollups(st, &b["variables"]);
    }
    let (field, draft) = if query.contains("convertPullRequestToDraft") {
        ("convertPullRequestToDraft", true)
    } else if query.contains("markPullRequestReadyForReview") {
        ("markPullRequestReadyForReview", false)
    } else {
        return Reply::json(json!({ "errors": [{ "message": "Unknown mutation" }] }));
    };
    match st.seed.github.pulls.iter_mut().find(|p| format!("PR_{}", p.number) == id) {
        Some(p) => {
            p.draft = draft;
            p.updated_at = WRITE_TIME.into();
            let mut data = serde_json::Map::new();
            data.insert(field.into(), json!({ "pullRequest": { "isDraft": draft } }));
            Reply::json(json!({ "data": data }))
        }
        None => Reply::json(json!({ "errors": [{ "message": format!("Could not resolve to a node with the global id of '{id}'") }] })),
    }
}
// --- end 4B T5 ---

/// The pull request routes under `/repos/<o>/<r>/` (and `/graphql`, 4B T5); `None` for any other
/// path (4A's `route` answers it). Only reached with a valid token.
pub(crate) fn route(st: &mut ForgeState, r: &FakeRequest) -> Option<Reply> {
    let segs: Vec<&str> = r.segments.iter().map(String::as_str).collect();
    let base = r.base.to_string();
    // --- 4B T5: graphql ---
    if r.method == "POST" && segs.as_slice() == ["graphql"] {
        return Some(graphql(st, r));
    }
    // --- end 4B T5 ---
    let ["repos", o, n, rest @ ..] = segs.as_slice() else {
        return None;
    };
    let repo = format!("{o}/{n}");
    if !st.seed.github.repos.iter().any(|p| p.path == repo) {
        return None;
    }
    let here = format!("{base}/github{}", r.path);
    let index = |st: &ForgeState, num: &str| {
        st.seed
            .github
            .pulls
            .iter()
            .position(|p| p.repo == repo && p.number.to_string() == num)
    };
    let reply = match (r.method, rest) {
        ("GET", ["pulls"]) => {
            let state = r.query.get("state").map(String::as_str).unwrap_or("open");
            let head = r.query.get("head");
            let mut ps: Vec<&FakePull> = st
                .seed
                .github
                .pulls
                .iter()
                .filter(|p| p.repo == repo && (state == "all" || p.state == state))
                // --- 4D T11: base ---
                .filter(|p| r.query.get("base").is_none_or(|b| *b == p.base_ref))
                // --- end 4D T11 ---
                .filter(|p| {
                    head.is_none_or(|h| {
                        *h == format!(
                            "{}:{}",
                            head_repo(p).split('/').next().unwrap_or_default(),
                            p.head_ref
                        )
                    })
                })
                .collect();
            ps.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Reply::page(
                ps.iter().map(|p| pull_json(st, p, &base, false)).collect(),
                r,
                &here,
            )
        }
        ("GET", ["pulls", num]) => match index(st, num) {
            Some(i) => Reply::json(pull_json(st, &st.seed.github.pulls[i], &base, true)),
            None => not_found(),
        },
        ("GET", ["pulls", num, "reviews"]) => match index(st, num) {
            Some(i) => Reply::page(
                st.seed.github.pulls[i]
                    .reviews
                    .iter()
                    .map(|x| review_json(st, x, &base))
                    .collect(),
                r,
                &here,
            ),
            None => not_found(),
        },
        ("GET", ["pulls", num, "comments"]) => match index(st, num) {
            Some(i) => Reply::page(
                st.seed.github.pulls[i]
                    .review_comments
                    .iter()
                    .map(|x| review_comment_json(st, x, &base))
                    .collect(),
                r,
                &here,
            ),
            None => not_found(),
        },
        ("GET", ["issues", num, "comments"]) => match index(st, num) {
            Some(i) => Reply::page(
                st.seed.github.pulls[i]
                    .comments
                    .iter()
                    .map(|x| comment_json(st, x, &base))
                    .collect(),
                r,
                &here,
            ),
            None => not_found(),
        },
        ("GET", ["commits", sha, "check-runs"]) => {
            let runs: Vec<Value> = st
                .seed
                .github
                .pulls
                .iter()
                .filter(|p| p.repo == repo && p.head_sha == *sha)
                .flat_map(|p| p.checks.iter())
                .map(|c| json!({ "name": c.name, "status": c.status, "conclusion": c.conclusion }))
                .collect();
            Reply::json(json!({ "total_count": runs.len(), "check_runs": runs }))
        }
        ("GET", ["commits", sha, "status"]) => {
            let statuses: Vec<&FakeStatus> = st
                .seed
                .github
                .pulls
                .iter()
                .filter(|p| p.repo == repo && p.head_sha == *sha)
                .flat_map(|p| p.statuses.iter())
                .collect();
            let combined = if statuses
                .iter()
                .any(|s| s.state == "failure" || s.state == "error")
            {
                "failure"
            } else if statuses.iter().any(|s| s.state == "pending") {
                "pending"
            } else {
                "success"
            };
            Reply::json(
                json!({ "state": combined, "statuses": statuses.iter().map(|s| json!({ "context": s.context, "state": s.state })).collect::<Vec<_>>() }),
            )
        }
        // --- 4B T5: writes ---
        ("POST", ["issues", num, "comments"]) => match index(st, num) {
            Some(i) => {
                let Some(body) = body_of(r)["body"].as_str().map(str::to_string) else { return Some(Reply::status(422, json!({ "message": "Validation Failed" }))) };
                let p = &mut st.seed.github.pulls[i];
                let c = FakeComment { id: next_id(p), user: login(r), body, created_at: WRITE_TIME.into() };
                p.comments.push(c.clone());
                Reply::status(201, comment_json(st, &c, &base))
            }
            None => not_found(),
        },
        ("POST", ["pulls", num, "comments", root, "replies"]) => match index(st, num) {
            Some(i) => {
                let Some(body) = body_of(r)["body"].as_str().map(str::to_string) else { return Some(Reply::status(422, json!({ "message": "Validation Failed" }))) };
                let p = &mut st.seed.github.pulls[i];
                let Some(first) = p.review_comments.iter().find(|c| c.id.to_string() == *root).cloned() else { return Some(not_found()) };
                let c = FakeReviewComment { id: next_id(p), user: login(r), body, created_at: WRITE_TIME.into(), in_reply_to: Some(first.id), ..first };
                p.review_comments.push(c.clone());
                Reply::status(201, review_comment_json(st, &c, &base))
            }
            None => not_found(),
        },
        ("POST", ["pulls", num, "reviews"]) => match index(st, num) {
            Some(i) => {
                let b = body_of(r);
                let body = b["body"].as_str().unwrap_or_default().to_string();
                let state = match b["event"].as_str() {
                    Some("APPROVE") => "APPROVED",
                    Some("REQUEST_CHANGES") if body.trim().is_empty() => return Some(Reply::status(422, json!({ "message": "Unprocessable Entity", "errors": ["Review Can not request changes on pull request without a body"] }))),
                    Some("REQUEST_CHANGES") => "CHANGES_REQUESTED",
                    _ => "COMMENTED",
                };
                let me = login(r);
                let p = &mut st.seed.github.pulls[i];
                let review = FakeReview { id: next_id(p), user: me.clone(), state: state.into(), body, submitted_at: WRITE_TIME.into() };
                p.reviews.push(review.clone());
                p.requested_reviewers.retain(|u| *u != me);
                Reply::json(review_json(st, &review, &base))
            }
            None => not_found(),
        },
        ("PUT", ["pulls", num, "merge"]) => match index(st, num) {
            Some(i) => {
                let b = body_of(r);
                let p = &mut st.seed.github.pulls[i];
                if p.state != "open" || p.draft || p.mergeable == Some(false) {
                    return Some(Reply::status(405, json!({ "message": "Pull Request is not mergeable" })));
                }
                if let Some(sha) = b["sha"].as_str()
                    && sha != p.head_sha
                {
                    return Some(Reply::status(409, json!({ "message": "Head branch was modified. Review and try the merge again." })));
                }
                p.merged = true;
                p.state = "closed".into();
                p.merged_with = b["merge_method"].as_str().unwrap_or("merge").into();
                p.updated_at = WRITE_TIME.into();
                Reply::json(json!({ "sha": "m".repeat(40), "merged": true, "message": "Pull Request successfully merged" }))
            }
            None => not_found(),
        },
        ("PATCH", ["pulls", num]) => match index(st, num) {
            Some(i) => {
                let b = body_of(r);
                let p = &mut st.seed.github.pulls[i];
                if let Some(t) = b["title"].as_str() {
                    p.title = t.into();
                }
                if let Some(d) = b["body"].as_str() {
                    p.body = d.into();
                }
                // --- 4D T2: retarget ---
                if let Some(base) = b["base"].as_str() {
                    p.base_ref = base.into();
                }
                // --- end 4D T2 ---
                p.updated_at = WRITE_TIME.into();
                Reply::json(pull_json(st, &st.seed.github.pulls[i], &base, true))
            }
            None => not_found(),
        },
        ("PUT", ["issues", num, "labels"]) => match index(st, num) {
            Some(i) => {
                let labels: Vec<String> = body_of(r)["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect();
                st.seed.github.pulls[i].labels = labels.clone();
                Reply::json(Value::Array(labels.iter().map(|l| json!({ "name": l })).collect()))
            }
            None => not_found(),
        },
        // --- end 4B T5 ---
        // --- 4C T2: create and its follow-up calls, people, labels, contents ---
        ("POST", ["pulls"]) => super::create::github_post_pull(st, r, &repo),
        ("POST", ["pulls", num, "requested_reviewers"]) => super::create::github_reviewers(st, r, &repo, num),
        ("POST", ["issues", num, "assignees"]) => super::create::github_add_assignees(st, r, &repo, num),
        ("POST", ["issues", num, "labels"]) => super::create::github_add_labels(st, r, &repo, num),
        ("GET", ["assignees"]) => super::create::github_assignees(st, r, &repo),
        ("GET", ["labels"]) => super::create::github_labels(st, r, &repo),
        ("GET", ["contents", file @ ..]) => super::create::github_contents(st, &repo, &file.join("/")),
        // --- end 4C T2 ---
        _ => return None,
    };
    // --- 5A T3 ---
    if r.method == "GET" && r.accept.as_deref().is_some_and(|a| a.contains("full+json")) {
        return Some(with_body_html(reply, &base, &st.seed.github.image_jwt));
    }
    // --- end 5A T3 ---
    Some(reply)
}
