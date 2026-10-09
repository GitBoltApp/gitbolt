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
    // --- review comments ---
    /// The head a pending review was started on.
    pub commit_id: String,
    // --- end review comments ---
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeComment {
    pub id: u64,
    pub user: String,
    pub body: String,
    pub created_at: String,
    // --- comment actions ---
    pub reactions: Vec<FakeReaction>,
    // --- end comment actions ---
}

// --- comment actions ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeReaction {
    pub id: u64,
    /// One of GitHub's eight (`+1`, `heart`, …).
    pub content: String,
    /// A login.
    pub user: String,
}

pub const REACTIONS: [&str; 8] = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"];
// --- end comment actions ---

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
    /// A multi-line comment's first line, on `start_side` (`RIGHT` or `LEFT`).
    pub start_line: Option<u32>,
    pub start_side: Option<String>,
    // --- comment actions ---
    pub reactions: Vec<FakeReaction>,
    // --- end comment actions ---
    // --- review comments ---
    /// Its review's id (`pull_request_review_id`); a pending review's comments are its author's
    /// alone.
    pub review: Option<u64>,
    // --- end review comments ---
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
    /// Set to auto-merge (`enablePullRequestAutoMerge`); `None`: not set.
    pub auto_merge: Option<FakeAutoMerge>,
    /// The commit title and message the merge asked for.
    pub merge_title: Option<String>,
    pub merge_message: Option<String>,
    // --- MR round 2 ---
    /// `base.sha`; empty: none.
    pub base_sha: String,
    /// Logins subscribed to its notifications (`viewerSubscription` is the token user's).
    pub subscribers: Vec<String>,
    // --- end MR round 2 ---
    // --- comment actions ---
    /// Review threads (by their first comment's id) resolved, and by whom (a login).
    pub resolved_threads: Vec<FakeResolvedThread>,
    // --- end comment actions ---
    // --- review comments ---
    /// `/files`: each changed file and its patch.
    pub files: Vec<FakePrFile>,
    // --- end review comments ---
    // --- branch update ---
    /// Anyone who can push to the base may push to a fork's head (`maintainer_can_modify`).
    pub maintainer_can_modify: bool,
    /// How the last Update branch went in (`merge`, `rebase`); empty: none.
    pub updated_with: String,
    // --- end branch update ---
}

// --- review comments ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakePrFile {
    pub filename: String,
    pub previous_filename: Option<String>,
    /// `None`: GitHub sent none (a large file).
    pub patch: Option<String>,
}
// --- end review comments ---

// --- comment actions ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeResolvedThread {
    pub root: u64,
    pub by: String,
}
// --- end comment actions ---

/// A PR's `auto_merge`, as GitHub's REST shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeAutoMerge {
    pub enabled_by: String,
    /// `merge`, `squash`, `rebase`.
    pub merge_method: String,
    pub commit_title: Option<String>,
    pub commit_message: Option<String>,
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
            reactions: vec![],
            start_line: None,
            start_side: None,
            review: None,
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
                    ..Default::default()
                },
                FakeReview {
                    id: 32,
                    user: "hubot".into(),
                    state: "APPROVED".into(),
                    body: "Looks good now.".into(),
                    submitted_at: "2026-10-04T08:00:00Z".into(),
                    ..Default::default()
                },
            ],
            comments: vec![FakeComment {
                id: 41,
                user: "monalisa".into(),
                body: "Ready for review.".into(),
                created_at: "2026-10-03T07:00:00Z".into(),
                reactions: vec![FakeReaction { id: 701, content: "heart".into(), user: "hubot".into() }],
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
            files: vec![FakePrFile { filename: "README.md".into(), previous_filename: None, patch: Some("@@ -1 +1,2 @@\n Readme\n+Second line".into()) }],
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
        // The collaborators the people picker offers (added as reviewers or assignees).
        .chain(st.seed.github.assignees.iter())
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
        "base": { "ref": p.base_ref, "sha": if p.base_sha.is_empty() { Value::Null } else { Value::from(p.base_sha.as_str()) }, "repo": { "full_name": p.repo } },
        "html_url": format!("{base}/github-web/{}/pull/{}", p.repo, p.number),
        "labels": p.labels.iter().map(|l| json!({ "name": l })).collect::<Vec<_>>(),
        "requested_reviewers": p.requested_reviewers.iter().map(|u| user_json(st, u, base)).collect::<Vec<_>>(),
        "assignees": p.assignees.iter().map(|u| user_json(st, u, base)).collect::<Vec<_>>(),
        "updated_at": p.updated_at,
        "auto_merge": p.auto_merge.as_ref().map_or(Value::Null, |a| json!({
            "enabled_by": user_json(st, &a.enabled_by, base), "merge_method": a.merge_method, "commit_title": a.commit_title, "commit_message": a.commit_message,
        })),
    });
    if single {
        v["mergeable"] = p.mergeable.map_or(Value::Null, Value::from);
        v["mergeable_state"] = p.mergeable_state.clone().into();
        v["maintainer_can_modify"] = p.maintainer_can_modify.into();
    }
    v
}

// --- branch update ---
/// Update branch (REST's merge, GraphQL's `MERGE` / `REBASE`): only an open PR behind its base,
/// while its head is `expected` (when said). The head gets a new SHA and it's up to date (`clean`).
/// The refusal in GitHub's words otherwise.
fn update_branch(p: &mut FakePull, expected: Option<&str>, method: &str) -> Result<(), &'static str> {
    if p.state != "open" {
        return Err("Pull request is closed");
    }
    if expected.is_some_and(|sha| sha != p.head_sha) {
        return Err("expected head sha didn't match current head ref.");
    }
    if p.mergeable_state != "behind" {
        return Err("There are no new commits on the base branch.");
    }
    p.head_sha = format!("{:0>40x}", 0xc0000 + p.number * 0x100 + u64::from(method == "rebase"));
    p.mergeable_state = "clean".into();
    p.updated_with = method.into();
    p.updated_at = WRITE_TIME.into();
    Ok(())
}
// --- end branch update ---

fn review_json(st: &ForgeState, r: &FakeReview, base: &str) -> Value {
    let submitted = if r.submitted_at.is_empty() { Value::Null } else { Value::from(r.submitted_at.as_str()) };
    json!({ "id": r.id, "node_id": format!("PRR_{}", r.id), "user": user_json(st, &r.user, base), "state": r.state, "body": r.body, "submitted_at": submitted, "commit_id": r.commit_id })
}

// --- comment actions: each comment's reactions summary and its `html_url` (`pull`: the PR's) ---
fn summary_json(reactions: &[FakeReaction]) -> Value {
    let mut v = json!({ "total_count": reactions.len() });
    for c in REACTIONS {
        v[c] = reactions.iter().filter(|r| r.content == c).count().into();
    }
    v
}

fn pull_url(p: &FakePull, base: &str) -> String {
    format!("{base}/github-web/{}/pull/{}", p.repo, p.number)
}

fn reaction_json(st: &ForgeState, r: &FakeReaction, base: &str) -> Value {
    json!({ "id": r.id, "content": r.content, "user": user_json(st, &r.user, base) })
}

/// A conversation comment (`issues`) or a review comment (`pulls`) of `repo`, by id: its author,
/// its reactions and its body, to change.
fn comment_parts<'a>(st: &'a mut ForgeState, repo: &str, kind: &str, id: &str) -> Option<(&'a str, &'a mut Vec<FakeReaction>, &'a mut String)> {
    let pulls = st.seed.github.pulls.iter_mut().filter(|p| p.repo == repo);
    if kind == "issues" {
        pulls.flat_map(|p| p.comments.iter_mut()).find(|c| c.id.to_string() == id).map(|c| (c.user.as_str(), &mut c.reactions, &mut c.body))
    } else {
        pulls.flat_map(|p| p.review_comments.iter_mut()).find(|c| c.id.to_string() == id).map(|c| (c.user.as_str(), &mut c.reactions, &mut c.body))
    }
}

/// `/{issues|pulls}/comments/<id>[/reactions[/<rid>]]`: anyone reacts (GitHub answers 200 with the
/// one already there), only a reaction's user removes it, only the author edits or deletes.
fn comment_route(st: &mut ForgeState, r: &FakeRequest, repo: &str, kind: &str, id: &str, rest: &[&str], base: &str) -> Reply {
    let me = login(r);
    let next = st.seed.github.pulls.iter().flat_map(|p| p.comments.iter().map(|c| &c.reactions).chain(p.review_comments.iter().map(|c| &c.reactions))).flatten().map(|x| x.id).max().unwrap_or(0).max(800) + 1;
    let Some((author, reactions, body)) = comment_parts(st, repo, kind, id) else { return not_found() };
    let author = author.to_string();
    let forbidden = || Reply::status(403, json!({ "message": "Must have admin rights to Repository." }));
    match (r.method, rest) {
        ("GET", ["reactions"]) => {
            let items = reactions.clone();
            Reply::page(items.iter().map(|x| reaction_json(st, x, base)).collect(), r, &format!("{base}/github{}", r.path))
        }
        ("POST", ["reactions"]) => {
            let content = body_of(r)["content"].as_str().unwrap_or_default().to_string();
            if !REACTIONS.contains(&content.as_str()) {
                return Reply::status(422, json!({ "message": "Validation Failed" }));
            }
            if let Some(x) = reactions.iter().find(|x| x.content == content && x.user == me).cloned() {
                return Reply::json(reaction_json(st, &x, base));
            }
            let x = FakeReaction { id: next, content, user: me };
            reactions.push(x.clone());
            Reply::status(201, reaction_json(st, &x, base))
        }
        ("DELETE", ["reactions", rid]) => match reactions.iter().position(|x| x.id.to_string() == *rid) {
            Some(k) if reactions[k].user == me => {
                reactions.remove(k);
                Reply::no_content()
            }
            Some(_) => forbidden(),
            None => not_found(),
        },
        ("PATCH", []) if author == me => {
            let Some(b) = body_of(r)["body"].as_str().map(str::to_string) else { return Reply::status(422, json!({ "message": "Validation Failed" })) };
            *body = b;
            let pull = st.seed.github.pulls.iter().find(|p| p.repo == repo && (p.comments.iter().any(|c| c.id.to_string() == id) || p.review_comments.iter().any(|c| c.id.to_string() == id))).map(|p| pull_url(p, base)).unwrap_or_default();
            let p = st.seed.github.pulls.iter().find(|p| pull_url(p, base) == pull).expect("found above");
            match kind {
                "issues" => Reply::json(comment_json(st, p.comments.iter().find(|c| c.id.to_string() == id).expect("found"), base, &pull)),
                _ => Reply::json(review_comment_json(st, p.review_comments.iter().find(|c| c.id.to_string() == id).expect("found"), base, &pull)),
            }
        }
        ("DELETE", []) if author == me => {
            for p in st.seed.github.pulls.iter_mut().filter(|p| p.repo == repo) {
                if kind == "issues" { p.comments.retain(|c| c.id.to_string() != id) } else { p.review_comments.retain(|c| c.id.to_string() != id) }
            }
            Reply::no_content()
        }
        ("PATCH" | "DELETE", []) => forbidden(),
        _ => not_found(),
    }
}
// --- end comment actions ---

fn comment_json(st: &ForgeState, c: &FakeComment, base: &str, pull: &str) -> Value {
    json!({ "id": c.id, "user": user_json(st, &c.user, base), "body": c.body, "created_at": c.created_at, "html_url": format!("{pull}#issuecomment-{}", c.id), "reactions": summary_json(&c.reactions) })
}

fn review_comment_json(st: &ForgeState, c: &FakeReviewComment, base: &str, pull: &str) -> Value {
    json!({
        "id": c.id, "node_id": format!("PRRC_{}", c.id), "pull_request_review_id": c.review,
        "user": user_json(st, &c.user, base), "body": c.body, "created_at": c.created_at, "path": c.path,
        "line": c.line, "original_line": c.line, "side": c.side, "diff_hunk": c.diff_hunk, "in_reply_to_id": c.in_reply_to,
        "start_line": c.start_line, "original_start_line": c.start_line, "start_side": c.start_side,
        "html_url": format!("{pull}#discussion_r{}", c.id), "reactions": summary_json(&c.reactions),
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

// --- auto-merge ---
/// `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge`, with GitHub's refusals: a
/// repository without `allow_auto_merge` (the seed's repo `settings`; allowed when absent), a
/// draft, a PR that could merge now ("clean status"), a moved head.
fn auto_merge(st: &mut ForgeState, r: &FakeRequest, vars: &Value, enable: bool) -> Reply {
    let err = |m: &str| Reply::json(json!({ "data": null, "errors": [{ "type": "UNPROCESSABLE", "message": m }] }));
    let id = vars["id"].as_str().unwrap_or_default();
    let me = login(r);
    let Some(i) = st.seed.github.pulls.iter().position(|p| format!("PR_{}", p.number) == id) else {
        return err(&format!("Could not resolve to a node with the global id of '{id}'"));
    };
    let allowed = st.seed.github.repos.iter().find(|x| x.path == st.seed.github.pulls[i].repo).is_none_or(|x| x.settings["allow_auto_merge"].as_bool() != Some(false));
    let p = &mut st.seed.github.pulls[i];
    if !enable {
        p.auto_merge = None;
        p.updated_at = WRITE_TIME.into();
        return Reply::json(json!({ "data": { "disablePullRequestAutoMerge": { "pullRequest": { "number": p.number } } } }));
    }
    let finished = p.checks.iter().all(|c| c.status == "completed") && p.statuses.iter().all(|x| x.state != "pending");
    if !allowed {
        return err("Pull request Auto merge is not allowed for this repository");
    }
    if p.state != "open" {
        return err("Pull request is not open");
    }
    if p.draft {
        return err("Pull request is in draft state");
    }
    if finished && p.mergeable_state == "clean" {
        return err("Pull request is in clean status");
    }
    if vars["sha"].as_str().is_some_and(|sha| sha != p.head_sha) {
        return err("Head branch was modified. Review and try the merge again.");
    }
    p.auto_merge = Some(FakeAutoMerge {
        enabled_by: me,
        merge_method: vars["method"].as_str().unwrap_or("MERGE").to_ascii_lowercase(),
        commit_title: vars["headline"].as_str().map(str::to_string),
        commit_message: vars["body"].as_str().map(str::to_string),
    });
    p.updated_at = WRITE_TIME.into();
    Reply::json(json!({ "data": { "enablePullRequestAutoMerge": { "pullRequest": { "number": p.number } } } }))
}
// --- end auto-merge ---

// --- review comments ---
/// Whether `line` on `side` (`LEFT`/`RIGHT`) is a line of `path`'s patch in `p` (GitHub: "must
/// be part of the diff").
fn in_diff(p: &FakePull, path: &str, side: &str, line: u32) -> bool {
    use gitbolt_core::forge::DiffSide;
    let want = if side == "LEFT" { DiffSide::Old } else { DiffSide::New };
    let Some(patch) = p.files.iter().find(|f| f.filename == path).and_then(|f| f.patch.as_deref()) else { return false };
    gitbolt_core::forge::review::commentable_lines(patch).iter().any(|l| l.side() == want && l.number() == line)
}

fn patch_of(p: &FakePull, path: &str) -> String {
    p.files.iter().find(|f| f.filename == path).and_then(|f| f.patch.clone()).unwrap_or_default()
}

fn gql_error(m: impl Into<String>) -> Reply {
    Reply::json(json!({ "errors": [{ "message": m.into() }] }))
}

/// Whether `me` sees review comment `c` of `p`: someone else's pending review is private. The
/// user's own pending comments are listed (as GitHub may), so the provider must skip them itself.
fn visible(p: &FakePull, c: &FakeReviewComment, me: &str) -> bool {
    !c.review.is_some_and(|rid| p.reviews.iter().any(|x| x.id == rid && x.state == "PENDING" && x.user != me))
}

/// `x` is `me`'s pending review `rid`.
fn my_pending(x: &FakeReview, rid: Option<u64>, me: &str) -> bool {
    Some(x.id) == rid && x.state == "PENDING" && x.user == me
}

/// The pending review's GraphQL mutations (`github.rs`'s consts), by node id: `PR_<n>`, `PRR_<id>`,
/// `PRRC_<id>`. Only the review's author touches it. `None`: not one of them.
fn review_mutation(st: &mut ForgeState, r: &FakeRequest, query: &str, v: &Value) -> Option<Reply> {
    let me = login(r);
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    let num = |id: String, prefix: &str| id.strip_prefix(prefix).and_then(|x| x.parse::<u64>().ok());
    let unknown = |id: String| gql_error(format!("Could not resolve to a node with the global id of '{id}'"));
    let pulls = &mut st.seed.github.pulls;
    if query.contains("addPullRequestReviewThread") {
        let rid = num(s("review"), "PRR_");
        let Some(p) = pulls.iter_mut().find(|p| p.reviews.iter().any(|x| my_pending(x, rid, &me))) else { return Some(unknown(s("review"))) };
        let (path, side) = (s("path"), s("side"));
        let line = v["line"].as_u64().unwrap_or(0) as u32;
        let start = v["startLine"].as_u64().map(|n| n as u32);
        let start_side = v["startSide"].as_str().map(str::to_string);
        // As GitHub: no thread, and the review it was for stays, even one just started for it.
        if !in_diff(p, &path, &side, line) || start.is_some_and(|n| !in_diff(p, &path, start_side.as_deref().unwrap_or(&side), n)) {
            return Some(Reply::json(json!({ "data": { "addPullRequestReviewThread": { "thread": null } }, "errors": [{ "message": "Pull request review thread line must be part of the diff" }] })));
        }
        let c = FakeReviewComment { id: next_id(p), user: me.clone(), body: s("body"), created_at: WRITE_TIME.into(), path: path.clone(), line: Some(line), side: side.clone(), diff_hunk: patch_of(p, &path), in_reply_to: None, start_line: start, start_side: start_side.clone(), reactions: vec![], review: rid };
        p.review_comments.push(c.clone());
        let start_diff_side = start.map(|_| start_side.clone().unwrap_or_else(|| side.clone()));
        let thread = json!({ "id": format!("PRRT_{}", c.id), "path": path, "line": line, "startLine": start, "diffSide": side, "startDiffSide": start_diff_side, "isOutdated": false, "comments": { "nodes": [{ "id": format!("PRRC_{}", c.id), "body": c.body }] } });
        return Some(Reply::json(json!({ "data": { "addPullRequestReviewThread": { "thread": thread } } })));
    }
    if query.contains("addPullRequestReview") {
        let Some(p) = pulls.iter_mut().find(|p| format!("PR_{}", p.number) == s("pr")) else { return Some(unknown(s("pr"))) };
        if p.reviews.iter().any(|x| x.state == "PENDING" && x.user == me) {
            return Some(gql_error("User can only have one pending review per pull request"));
        }
        let id = next_id(p);
        p.reviews.push(FakeReview { id, user: me.clone(), state: "PENDING".into(), commit_id: s("commit"), ..Default::default() });
        return Some(Reply::json(json!({ "data": { "addPullRequestReview": { "pullRequestReview": { "id": format!("PRR_{id}") } } } })));
    }
    if query.contains("updatePullRequestReviewComment") {
        let cid = num(s("id"), "PRRC_");
        let Some(c) = pulls.iter_mut().flat_map(|p| p.review_comments.iter_mut()).find(|c| Some(c.id) == cid && c.user == me) else { return Some(unknown(s("id"))) };
        c.body = s("body");
        return Some(Reply::json(json!({ "data": { "updatePullRequestReviewComment": { "pullRequestReviewComment": { "id": s("id"), "body": c.body } } } })));
    }
    if query.contains("deletePullRequestReviewComment") {
        let cid = num(s("id"), "PRRC_");
        for p in pulls.iter_mut() {
            if let Some(k) = p.review_comments.iter().position(|c| Some(c.id) == cid && c.user == me) {
                p.review_comments.remove(k);
                return Some(Reply::json(json!({ "data": { "deletePullRequestReviewComment": { "clientMutationId": null } } })));
            }
        }
        return Some(unknown(s("id")));
    }
    if query.contains("deletePullRequestReview") {
        let rid = num(s("review"), "PRR_");
        for p in pulls.iter_mut() {
            if let Some(k) = p.reviews.iter().position(|x| my_pending(x, rid, &me)) {
                p.reviews.remove(k);
                p.review_comments.retain(|c| c.review != rid);
                return Some(Reply::json(json!({ "data": { "deletePullRequestReview": { "clientMutationId": null } } })));
            }
        }
        return Some(unknown(s("review")));
    }
    if query.contains("submitPullRequestReview") {
        let rid = num(s("review"), "PRR_");
        let state = match s("event").as_str() {
            "APPROVE" => "APPROVED",
            "REQUEST_CHANGES" => "CHANGES_REQUESTED",
            "COMMENT" => "COMMENTED",
            _ => return Some(gql_error("Argument 'event' on InputObject 'SubmitPullRequestReviewInput' has an invalid value")),
        };
        for p in pulls.iter_mut() {
            if let Some(x) = p.reviews.iter_mut().find(|x| my_pending(x, rid, &me)) {
                x.state = state.into();
                x.body = v["body"].as_str().unwrap_or_default().into();
                x.submitted_at = WRITE_TIME.into();
                p.requested_reviewers.retain(|u| *u != me);
                p.updated_at = WRITE_TIME.into();
                return Some(Reply::json(json!({ "data": { "submitPullRequestReview": { "pullRequestReview": { "id": s("review"), "state": state } } } })));
            }
        }
        return Some(unknown(s("review")));
    }
    None
}
// --- end review comments ---

fn graphql(st: &mut ForgeState, r: &FakeRequest) -> Reply {
    let b = body_of(r);
    let query = b["query"].as_str().unwrap_or_default();
    let id = b["variables"]["id"].as_str().unwrap_or_default().to_string();
    // --- review comments ---
    if let Some(reply) = review_mutation(st, r, query, &b["variables"]) {
        return reply;
    }
    // --- end review comments ---
    if query.contains("statusCheckRollup") {
        return rollups(st, &b["variables"]);
    }
    // --- comment actions: review threads, resolved or not ---
    if query.contains("resolveReviewThread") || query.contains("unresolveReviewThread") {
        let on = !query.contains("unresolveReviewThread");
        let field = if on { "resolveReviewThread" } else { "unresolveReviewThread" };
        let me = login(r);
        let root = id.strip_prefix("PRRT_").and_then(|x| x.parse::<u64>().ok());
        let Some(p) = st.seed.github.pulls.iter_mut().find(|p| p.review_comments.iter().any(|c| Some(c.id) == root && c.in_reply_to.is_none())) else {
            return Reply::json(json!({ "errors": [{ "message": format!("Could not resolve to a node with the global id of '{id}'") }] }));
        };
        let root = root.expect("found");
        p.resolved_threads.retain(|t| t.root != root);
        if on {
            p.resolved_threads.push(FakeResolvedThread { root, by: me.clone() });
        }
        let mut data = serde_json::Map::new();
        data.insert(field.into(), json!({ "thread": { "isResolved": on, "resolvedBy": if on { json!({ "login": me }) } else { Value::Null } } }));
        return Reply::json(json!({ "data": data }));
    }
    if query.contains("reviewThreads") {
        let v = &b["variables"];
        let repo = format!("{}/{}", v["owner"].as_str().unwrap_or_default(), v["name"].as_str().unwrap_or_default());
        let pr = st.seed.github.pulls.iter().find(|p| p.repo == repo && Some(p.number) == v["number"].as_u64());
        let me = login(r);
        let nodes: Vec<Value> = pr.map(|p| p.review_comments.iter().filter(|c| c.in_reply_to.is_none() && visible(p, c, &me)).map(|c| {
            let res = p.resolved_threads.iter().find(|t| t.root == c.id);
            json!({ "id": format!("PRRT_{}", c.id), "isResolved": res.is_some(), "resolvedBy": res.map_or(Value::Null, |t| json!({ "login": t.by })), "comments": { "nodes": [{ "databaseId": c.id }] } })
        }).collect()).unwrap_or_default();
        return Reply::json(json!({ "data": { "repository": { "pullRequest": pr.map(|_| json!({ "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": nodes } })) } } }));
    }
    // --- end comment actions ---
    // --- MR round 2: notifications ---
    let me = login(r);
    let state = |p: &FakePull| if p.subscribers.contains(&me) { "SUBSCRIBED" } else { "UNSUBSCRIBED" };
    if query.contains("updateSubscription") {
        let on = b["variables"]["state"].as_str() == Some("SUBSCRIBED");
        return match st.seed.github.pulls.iter_mut().find(|p| format!("PR_{}", p.number) == id) {
            Some(p) => {
                p.subscribers.retain(|u| *u != me);
                if on {
                    p.subscribers.push(me.clone());
                }
                Reply::json(json!({ "data": { "updateSubscription": { "subscribable": { "viewerSubscription": state(p) } } } }))
            }
            None => Reply::json(json!({ "errors": [{ "message": format!("Could not resolve to a node with the global id of '{id}'") }] })),
        };
    }
    if query.contains("viewerSubscription") {
        let v = &b["variables"];
        let repo = format!("{}/{}", v["owner"].as_str().unwrap_or_default(), v["name"].as_str().unwrap_or_default());
        let pr = st.seed.github.pulls.iter().find(|p| p.repo == repo && Some(p.number) == v["number"].as_u64());
        return Reply::json(json!({ "data": { "repository": { "pullRequest": pr.map(|p| json!({ "viewerSubscription": state(p) })) } } }));
    }
    // --- end MR round 2 ---
    // --- auto-merge ---
    if query.contains("enablePullRequestAutoMerge") || query.contains("disablePullRequestAutoMerge") {
        return auto_merge(st, r, &b["variables"], query.contains("enablePullRequestAutoMerge"));
    }
    // --- end auto-merge ---
    // --- branch update ---
    if query.contains("updatePullRequestBranch") {
        let v = &b["variables"];
        let method = v["method"].as_str().unwrap_or("MERGE").to_ascii_lowercase();
        return match st.seed.github.pulls.iter_mut().find(|p| format!("PR_{}", p.number) == id) {
            Some(p) => match update_branch(p, v["sha"].as_str(), &method) {
                Ok(()) => Reply::json(json!({ "data": { "updatePullRequestBranch": { "pullRequest": { "number": p.number } } } })),
                Err(m) => Reply::json(json!({ "data": { "updatePullRequestBranch": null }, "errors": [{ "type": "UNPROCESSABLE", "message": m }] })),
            },
            None => Reply::json(json!({ "errors": [{ "message": format!("Could not resolve to a node with the global id of '{id}'") }] })),
        };
    }
    // --- end branch update ---
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
        // --- comment actions ---
        (_, [kind @ ("issues" | "pulls"), "comments", id, more @ ..]) if id.bytes().all(|b| b.is_ascii_digit()) => comment_route(st, r, &repo, kind, id, more, &base),
        // --- end comment actions ---
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
            Some(i) => {
                let me = login(r);
                Reply::page(
                    st.seed.github.pulls[i]
                        .reviews
                        .iter()
                        // A pending review is its author's alone.
                        .filter(|x| x.state != "PENDING" || x.user == me)
                        .map(|x| review_json(st, x, &base))
                        .collect(),
                    r,
                    &here,
                )
            }
            None => not_found(),
        },
        ("GET", ["pulls", num, "comments"]) => match index(st, num) {
            Some(i) => {
                let me = login(r);
                let p = &st.seed.github.pulls[i];
                let url = pull_url(p, &base);
                Reply::page(p.review_comments.iter().filter(|c| visible(p, c, &me)).map(|x| review_comment_json(st, x, &base, &url)).collect(), r, &here)
            }
            None => not_found(),
        },
        ("GET", ["issues", num, "comments"]) => match index(st, num) {
            Some(i) => Reply::page(
                st.seed.github.pulls[i]
                    .comments
                    .iter()
                    .map(|x| comment_json(st, x, &base, &pull_url(&st.seed.github.pulls[i], &base)))
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
        // --- review comments ---
        ("GET", ["pulls", num, "files"]) => match index(st, num) {
            Some(i) => {
                let files: Vec<Value> = st.seed.github.pulls[i].files.iter().map(|f| {
                    let mut v = json!({ "sha": null, "filename": f.filename, "status": if f.previous_filename.is_some() { "renamed" } else { "modified" }, "additions": 1, "deletions": 0, "changes": 1 });
                    if let Some(p) = &f.previous_filename { v["previous_filename"] = p.clone().into(); }
                    if let Some(p) = &f.patch { v["patch"] = p.clone().into(); }
                    v
                }).collect();
                Reply::page(files, r, &here)
            }
            None => not_found(),
        },
        ("GET", ["pulls", num, "reviews", rid, "comments"]) => match index(st, num) {
            Some(i) => {
                let me = login(r);
                let p = &st.seed.github.pulls[i];
                let Some(rv) = p.reviews.iter().find(|x| x.id.to_string() == *rid && (x.state != "PENDING" || x.user == me)) else { return Some(not_found()) };
                let url = pull_url(p, &base);
                Reply::page(p.review_comments.iter().filter(|c| c.review == Some(rv.id)).map(|x| review_comment_json(st, x, &base, &url)).collect(), r, &here)
            }
            None => not_found(),
        },
        // --- end review comments ---
        // --- 4B T5: writes ---
        // --- review comments: Comment now ---
        ("POST", ["pulls", num, "comments"]) => match index(st, num) {
            Some(i) => {
                let b = body_of(r);
                let me = login(r);
                let invalid = |m: &str| Reply::status(422, json!({ "message": "Validation Failed", "errors": [{ "message": m }] }));
                let p = &st.seed.github.pulls[i];
                // github.com lists this reason as a plain string, not an `{message}` object.
                if p.reviews.iter().any(|x| x.state == "PENDING" && x.user == me) {
                    return Some(Reply::status(422, json!({ "message": "Unprocessable Entity", "errors": ["User can only have one pending review per pull request"] })));
                }
                let (Some(body), Some(path), Some(line)) = (b["body"].as_str(), b["path"].as_str(), b["line"].as_u64()) else { return Some(invalid("body, path and line are required")) };
                if b["commit_id"].as_str().is_none_or(str::is_empty) {
                    return Some(invalid("commit_id is required"));
                }
                let (line, side) = (line as u32, b["side"].as_str().unwrap_or("RIGHT").to_string());
                let start = b["start_line"].as_u64().map(|n| n as u32);
                let start_side = b["start_side"].as_str().map(str::to_string);
                if !in_diff(p, path, &side, line) || start.is_some_and(|n| !in_diff(p, path, start_side.as_deref().unwrap_or(&side), n)) {
                    return Some(invalid("pull_request_review_thread.line must be part of the diff"));
                }
                let c = FakeReviewComment { id: next_id(p), user: me, body: body.into(), created_at: WRITE_TIME.into(), path: path.into(), line: Some(line), side, diff_hunk: patch_of(p, path), in_reply_to: None, start_line: start, start_side, reactions: vec![], review: None };
                st.seed.github.pulls[i].review_comments.push(c.clone());
                st.seed.github.pulls[i].updated_at = WRITE_TIME.into();
                Reply::status(201, review_comment_json(st, &c, &base, &pull_url(&st.seed.github.pulls[i], &base)))
            }
            None => not_found(),
        },
        // --- end review comments ---
        ("POST", ["issues", num, "comments"]) => match index(st, num) {
            Some(i) => {
                let Some(body) = body_of(r)["body"].as_str().map(str::to_string) else { return Some(Reply::status(422, json!({ "message": "Validation Failed" }))) };
                let p = &mut st.seed.github.pulls[i];
                let c = FakeComment { id: next_id(p), user: login(r), body, created_at: WRITE_TIME.into(), reactions: vec![] };
                p.comments.push(c.clone());
                Reply::status(201, comment_json(st, &c, &base, &pull_url(&st.seed.github.pulls[i], &base)))
            }
            None => not_found(),
        },
        ("POST", ["pulls", num, "comments", root, "replies"]) => match index(st, num) {
            Some(i) => {
                let Some(body) = body_of(r)["body"].as_str().map(str::to_string) else { return Some(Reply::status(422, json!({ "message": "Validation Failed" }))) };
                let p = &mut st.seed.github.pulls[i];
                let Some(first) = p.review_comments.iter().find(|c| c.id.to_string() == *root).cloned() else { return Some(not_found()) };
                let c = FakeReviewComment { id: next_id(p), user: login(r), body, created_at: WRITE_TIME.into(), in_reply_to: Some(first.id), reactions: vec![], ..first };
                p.review_comments.push(c.clone());
                Reply::status(201, review_comment_json(st, &c, &base, &pull_url(&st.seed.github.pulls[i], &base)))
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
                    Some("COMMENT") if body.trim().is_empty() => return Some(Reply::status(422, json!({ "message": "Unprocessable Entity", "errors": ["Review Can not comment on pull request without a body"] }))),
                    _ => "COMMENTED",
                };
                let me = login(r);
                let p = &mut st.seed.github.pulls[i];
                let review = FakeReview { id: next_id(p), user: me.clone(), state: state.into(), body, submitted_at: WRITE_TIME.into(), ..Default::default() };
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
                // --- auto-merge: the message the merge asked for ---
                p.merge_title = b["commit_title"].as_str().map(str::to_string);
                p.merge_message = b["commit_message"].as_str().map(str::to_string);
                // --- end auto-merge ---
                p.updated_at = WRITE_TIME.into();
                Reply::json(json!({ "sha": "m".repeat(40), "merged": true, "message": "Pull Request successfully merged" }))
            }
            None => not_found(),
        },
        // --- branch update: REST's Update branch merges the base in (202: GitHub does it in the background) ---
        ("PUT", ["pulls", num, "update-branch"]) => match index(st, num) {
            Some(i) => {
                let b = body_of(r);
                match update_branch(&mut st.seed.github.pulls[i], b["expected_head_sha"].as_str(), "merge") {
                    Ok(()) => Reply::status(202, json!({ "message": "Updating pull request branch.", "url": format!("{base}/github/repos/{repo}/pulls/{num}") })),
                    Err(m) => Reply::status(422, json!({ "message": m, "documentation_url": "https://docs.github.com/rest/pulls/pulls#update-a-pull-request-branch" })),
                }
            }
            None => not_found(),
        },
        // --- end branch update ---
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
        ("POST" | "DELETE", ["pulls", num, "requested_reviewers"]) => super::create::github_reviewers(st, r, &repo, num),
        ("POST" | "DELETE", ["issues", num, "assignees"]) => super::create::github_assignees_change(st, r, &repo, num),
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
