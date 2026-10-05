//! GitLab merge requests in the fake forge (4B): the list and its filters, one MR, its
//! approvals, discussions and diffs, and the project's pipelines; 4B T3 adds the writes. The MRs
//! live in the seed (`GitLabSeed.merge_requests`), so a write changes what the next read sees.
//! Like GitLab, a list's MRs have no `head_pipeline` (a single MR's GET has it).

use super::gitlab::{find, user_json};
use super::{FakeRequest, FakeUser, ForgeState, Reply};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// When the fake's writes happen.
pub const WRITE_TIME: &str = "2026-10-04T12:30:00Z";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakePosition {
    pub new_path: String,
    pub old_path: String,
    pub new_line: Option<u32>,
    pub old_line: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeNote {
    pub id: u64,
    /// A username (a token's user or `GitLabSeed.users`).
    pub author: String,
    pub body: String,
    /// RFC 3339.
    pub created_at: String,
    pub system: bool,
    pub position: Option<FakePosition>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeDiscussion {
    pub id: String,
    pub notes: Vec<FakeNote>,
    pub resolvable: bool,
    pub resolved: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeDiff {
    pub old_path: String,
    pub new_path: String,
    /// Unified diff text, from its first `@@` line.
    pub diff: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeMergeRequest {
    pub iid: u64,
    /// The target project's path.
    pub project: String,
    /// Empty: the target project itself.
    pub source_project: String,
    pub source_branch: String,
    pub target_branch: String,
    /// As GitLab keeps it: a draft's starts with `Draft:`.
    pub title: String,
    pub description: String,
    /// `opened`, `merged`, `closed`.
    pub state: String,
    pub author: String,
    pub head_sha: String,
    /// A GitLab pipeline status (`success`, `running`, …).
    pub pipeline: Option<String>,
    pub approved_by: Vec<String>,
    pub approvals_required: u32,
    pub reviewers: Vec<String>,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub has_conflicts: bool,
    /// `detailed_merge_status`; empty is `mergeable`.
    pub merge_status: String,
    pub squash: bool,
    pub remove_source_branch: Option<bool>,
    /// RFC 3339.
    pub updated_at: String,
    pub discussions: Vec<FakeDiscussion>,
    pub diffs: Vec<FakeDiff>,
}

pub fn default_users() -> Vec<FakeUser> {
    vec![FakeUser { id: 9, username: "alice".into(), name: "Alice Fork".into(), email: Some("alice@example.com".into()), avatar_url: None }]
}

pub fn default_mrs() -> Vec<FakeMergeRequest> {
    let mr = |iid: u64, title: &str, source: &str, author: &str, state: &str, day: &str| FakeMergeRequest {
        iid,
        project: "group/project".into(),
        source_branch: source.into(),
        target_branch: "main".into(),
        title: title.into(),
        state: state.into(),
        author: author.into(),
        head_sha: format!("{iid:0>40}"),
        merge_status: "mergeable".into(),
        updated_at: format!("{day}T10:00:00Z"),
        ..Default::default()
    };
    let note = |id: u64, author: &str, body: &str, at: &str| FakeNote { id, author: author.into(), body: body.into(), created_at: at.into(), system: false, position: None };
    let readme = FakePosition { new_path: "README.md".into(), old_path: "README.md".into(), new_line: Some(2), old_line: None };
    vec![
        FakeMergeRequest {
            description: "Adds the dev work.\n\nCloses #3.".into(),
            pipeline: Some("success".into()),
            reviewers: vec!["ada".into()],
            approvals_required: 1,
            merge_status: "not_approved".into(),
            labels: vec!["backend".into()],
            discussions: vec![
                FakeDiscussion { id: "d1".into(), notes: vec![note(101, "grace", "Looks good overall.", "2026-10-04T09:00:00Z")], resolvable: false, resolved: false },
                FakeDiscussion { id: "d2".into(), notes: vec![FakeNote { position: Some(readme), ..note(102, "grace", "Why the second line?", "2026-10-04T09:05:00Z") }], resolvable: true, resolved: false },
                FakeDiscussion { id: "d3".into(), notes: vec![FakeNote { system: true, ..note(103, "grace", "added 1 commit", "2026-10-04T09:10:00Z") }], resolvable: false, resolved: false },
            ],
            diffs: vec![FakeDiff { old_path: "README.md".into(), new_path: "README.md".into(), diff: "@@ -1,1 +1,2 @@\n Readme\n+Second line\n".into() }],
            ..mr(12, "Dev work", "dev", "grace", "opened", "2026-10-04")
        },
        FakeMergeRequest { pipeline: Some("running".into()), merge_status: "draft_status".into(), ..mr(5, "Draft: Explore caching", "diverged", "ada", "opened", "2026-10-03") },
        mr(9, "Old feature", "feature/old", "ada", "merged", "2026-09-20"),
        FakeMergeRequest { source_project: "alice/project".into(), ..mr(14, "Fix from a fork", "fix", "alice", "opened", "2026-10-02") },
    ]
}

/// A username's user: a token's, else `GitLabSeed.users`, else a stand-in.
fn person(st: &ForgeState, username: &str) -> FakeUser {
    st.seed.gitlab.tokens.iter().map(|t| &t.user).chain(st.seed.gitlab.users.iter()).find(|u| u.username == username).cloned().unwrap_or_else(|| FakeUser { id: 999, username: username.into(), name: username.into(), ..Default::default() })
}

fn is_draft(title: &str) -> bool {
    let t = title.trim_start().to_ascii_lowercase();
    ["draft:", "[draft]", "(draft)", "draft -", "wip:", "[wip]"].iter().any(|p| t.starts_with(p))
}

fn project_id(st: &ForgeState, path: &str) -> u64 {
    st.seed.gitlab.projects.iter().find(|p| p.path == path).map_or(0, |p| p.id)
}

fn users_json(st: &ForgeState, names: &[String], base: &str) -> Vec<Value> {
    names.iter().map(|u| user_json(&person(st, u), base)).collect()
}

fn pipeline_json(m: &FakeMergeRequest, status: &str, base: &str) -> Value {
    let id = 50_000 + m.iid;
    json!({ "id": id, "sha": m.head_sha, "ref": m.source_branch, "status": status, "web_url": format!("{base}/gitlab/{}/-/pipelines/{id}", m.project), "updated_at": m.updated_at })
}

/// One MR as GitLab answers it; `single`: a GET of that MR (with its head pipeline).
pub fn mr_json(st: &ForgeState, m: &FakeMergeRequest, base: &str, single: bool) -> Value {
    let source = if m.source_project.is_empty() { m.project.as_str() } else { m.source_project.as_str() };
    let mut v = json!({
        "id": 10_000 + m.iid, "iid": m.iid, "project_id": project_id(st, &m.project),
        "title": m.title, "description": m.description, "state": m.state, "draft": is_draft(&m.title), "work_in_progress": is_draft(&m.title),
        "source_branch": m.source_branch, "target_branch": m.target_branch,
        "source_project_id": project_id(st, source), "target_project_id": project_id(st, &m.project),
        "author": user_json(&person(st, &m.author), base),
        "reviewers": users_json(st, &m.reviewers, base), "assignees": users_json(st, &m.assignees, base),
        "labels": m.labels, "sha": m.head_sha,
        "web_url": format!("{base}/gitlab/{}/-/merge_requests/{}", m.project, m.iid),
        "has_conflicts": m.has_conflicts,
        "detailed_merge_status": if m.merge_status.is_empty() { "mergeable" } else { m.merge_status.as_str() },
        "squash": m.squash, "force_remove_source_branch": m.remove_source_branch, "updated_at": m.updated_at,
    });
    if single {
        v["head_pipeline"] = m.pipeline.as_deref().map_or(Value::Null, |s| pipeline_json(m, s, base));
    }
    v
}

fn note_json(st: &ForgeState, n: &FakeNote, resolvable: bool, resolved: bool, base: &str) -> Value {
    json!({
        "id": n.id, "body": n.body, "author": user_json(&person(st, &n.author), base), "created_at": n.created_at, "system": n.system,
        "type": if n.position.is_some() { Value::from("DiffNote") } else { Value::Null },
        "position": n.position.as_ref().map(|p| json!({ "position_type": "text", "new_path": p.new_path, "old_path": p.old_path, "new_line": p.new_line, "old_line": p.old_line })),
        "resolvable": resolvable, "resolved": resolved,
    })
}

fn discussion_json(st: &ForgeState, d: &FakeDiscussion, base: &str) -> Value {
    json!({ "id": d.id, "individual_note": d.notes.len() == 1 && !d.resolvable, "notes": d.notes.iter().map(|n| note_json(st, n, d.resolvable, d.resolved, base)).collect::<Vec<_>>() })
}

fn approvals_json(st: &ForgeState, m: &FakeMergeRequest, base: &str) -> Value {
    let left = m.approvals_required.saturating_sub(m.approved_by.len() as u32);
    json!({
        "approved": left == 0 && !m.approved_by.is_empty(), "approvals_required": m.approvals_required, "approvals_left": left,
        "approved_by": m.approved_by.iter().map(|u| json!({ "user": user_json(&person(st, u), base) })).collect::<Vec<_>>(),
    })
}

/// The list's filters: `state`, `source_branch`, `target_branch`, `scope=created_by_me|assigned_to_me`, `reviewer_id`.
fn query_matches(st: &ForgeState, m: &FakeMergeRequest, r: &FakeRequest) -> bool {
    let q = &r.query;
    let me = r.token.as_ref().map(|t| t.user.username.as_str());
    let state_ok = match q.get("state").map(String::as_str) {
        None | Some("all") => true,
        Some(s) => m.state == s,
    };
    let branch_ok = q.get("source_branch").is_none_or(|b| *b == m.source_branch);
    let scope_ok = match q.get("scope").map(String::as_str) {
        Some("created_by_me") => me == Some(m.author.as_str()),
        Some("assigned_to_me") => me.is_some_and(|u| m.assignees.iter().any(|a| a == u)),
        _ => true,
    };
    // --- 4D T11: target_branch ---
    let branch_ok = branch_ok && q.get("target_branch").is_none_or(|b| *b == m.target_branch);
    // --- end 4D T11 ---
    let reviewer_ok = q.get("reviewer_id").is_none_or(|id| m.reviewers.iter().any(|u| person(st, u).id.to_string() == *id));
    state_ok && branch_ok && scope_ok && reviewer_ok
}

fn not_found() -> Reply {
    Reply::status(404, json!({ "message": "404 Not found" }))
}

/// The merge request routes under `/api/v4/projects/<id>/`; `None` for any other path (4A's
/// `route` answers it). Only reached with a valid token.
// --- 4B T3 ---
fn body_of(r: &FakeRequest) -> Value {
    serde_json::from_slice(r.body).unwrap_or(Value::Null)
}

fn bad_request() -> Reply {
    Reply::status(400, json!({ "message": "400 Bad request" }))
}

/// A note from the request's `body`, by the token's user, with the next free id.
fn new_note(st: &ForgeState, r: &FakeRequest) -> Option<FakeNote> {
    let body = body_of(r)["body"].as_str()?.to_string();
    let author = r.token.as_ref()?.user.username.clone();
    let id = st.seed.gitlab.merge_requests.iter().flat_map(|m| m.discussions.iter()).flat_map(|d| d.notes.iter()).map(|n| n.id).max().unwrap_or(0).max(1000) + 1;
    Some(FakeNote { id, author, body, created_at: WRITE_TIME.into(), system: false, position: None })
}
// --- end 4B T3 ---

pub(crate) fn route(st: &mut ForgeState, r: &FakeRequest) -> Option<Reply> {
    let segs: Vec<&str> = r.segments.iter().map(String::as_str).collect();
    let ["api", "v4", "projects", id, rest @ ..] = segs.as_slice() else { return None };
    let project = find(&st.seed.gitlab.projects, id)?.path.clone();
    let base = r.base.to_string();
    let here = format!("{base}/gitlab{}", r.path);
    let index = |st: &ForgeState, iid: &str| st.seed.gitlab.merge_requests.iter().position(|m| m.project == project && m.iid.to_string() == iid);
    let reply = match (r.method, rest) {
        ("GET", ["merge_requests"]) => {
            let mut mrs: Vec<&FakeMergeRequest> = st.seed.gitlab.merge_requests.iter().filter(|m| m.project == project && query_matches(st, m, r)).collect();
            mrs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            // As GitLab: the lists (not a single MR's GET) take `with_labels_details`, then each
            // label is an object with its colour.
            let details = r.query.get("with_labels_details").is_some_and(|v| v == "true");
            let one = |m: &FakeMergeRequest| {
                let mut v = mr_json(st, m, &base, false);
                if details {
                    let color = |l: &String| st.seed.gitlab.labels.iter().find(|x| x.name == *l).map(|x| x.color.clone());
                    v["labels"] = Value::Array(m.labels.iter().map(|l| json!({ "name": l, "color": color(l) })).collect());
                }
                v
            };
            Reply::page(mrs.iter().map(|m| one(m)).collect(), r, &here)
        }
        ("GET", ["pipelines"]) => {
            let mut mrs: Vec<&FakeMergeRequest> = st.seed.gitlab.merge_requests.iter().filter(|m| m.project == project && m.pipeline.is_some()).collect();
            mrs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Reply::json(Value::Array(mrs.iter().map(|m| pipeline_json(m, m.pipeline.as_deref().unwrap_or_default(), &base)).collect()))
        }
        ("GET", ["merge_requests", iid]) => match index(st, iid) {
            Some(i) => Reply::json(mr_json(st, &st.seed.gitlab.merge_requests[i], &base, true)),
            None => not_found(),
        },
        ("GET", ["merge_requests", iid, "approvals"]) => match index(st, iid) {
            Some(i) => Reply::json(approvals_json(st, &st.seed.gitlab.merge_requests[i], &base)),
            None => not_found(),
        },
        ("GET", ["merge_requests", iid, "discussions"]) => match index(st, iid) {
            Some(i) => Reply::page(st.seed.gitlab.merge_requests[i].discussions.iter().map(|d| discussion_json(st, d, &base)).collect(), r, &here),
            None => not_found(),
        },
        ("GET", ["merge_requests", iid, "diffs"]) => match index(st, iid) {
            Some(i) => Reply::page(st.seed.gitlab.merge_requests[i].diffs.iter().map(|d| json!({ "old_path": d.old_path, "new_path": d.new_path, "diff": d.diff, "new_file": false, "deleted_file": false, "renamed_file": d.old_path != d.new_path })).collect(), r, &here),
            None => not_found(),
        },
        // --- 4B T3: writes ---
        ("POST", ["merge_requests", iid, "notes"]) => match index(st, iid) {
            Some(i) => {
                let Some(note) = new_note(st, r) else { return Some(bad_request()) };
                st.seed.gitlab.merge_requests[i].discussions.push(FakeDiscussion { id: format!("d{}", note.id), notes: vec![note.clone()], resolvable: false, resolved: false });
                Reply::status(201, note_json(st, &note, false, false, &base))
            }
            None => not_found(),
        },
        ("POST", ["merge_requests", iid, "discussions", did, "notes"]) => match index(st, iid) {
            Some(i) => {
                let Some(note) = new_note(st, r) else { return Some(bad_request()) };
                let Some(d) = st.seed.gitlab.merge_requests[i].discussions.iter_mut().find(|d| d.id == *did) else { return Some(not_found()) };
                d.notes.push(note.clone());
                let (resolvable, resolved) = (d.resolvable, d.resolved);
                Reply::status(201, note_json(st, &note, resolvable, resolved, &base))
            }
            None => not_found(),
        },
        ("POST", ["merge_requests", iid, "approve"]) => match (index(st, iid), r.token.as_ref().map(|t| t.user.username.clone())) {
            (Some(i), Some(me)) => {
                let m = &mut st.seed.gitlab.merge_requests[i];
                if !m.approved_by.contains(&me) {
                    m.approved_by.push(me);
                }
                if m.merge_status == "not_approved" && m.approved_by.len() as u32 >= m.approvals_required {
                    m.merge_status = "mergeable".into();
                }
                Reply::status(201, approvals_json(st, &st.seed.gitlab.merge_requests[i], &base))
            }
            _ => not_found(),
        },
        ("POST", ["merge_requests", iid, "unapprove"]) => match (index(st, iid), r.token.as_ref().map(|t| t.user.username.clone())) {
            (Some(i), Some(me)) => {
                let m = &mut st.seed.gitlab.merge_requests[i];
                if !m.approved_by.contains(&me) {
                    return Some(not_found());
                }
                m.approved_by.retain(|u| *u != me);
                if m.merge_status == "mergeable" && (m.approved_by.len() as u32) < m.approvals_required {
                    m.merge_status = "not_approved".into();
                }
                Reply::status(201, approvals_json(st, &st.seed.gitlab.merge_requests[i], &base))
            }
            _ => not_found(),
        },
        ("PUT", ["merge_requests", iid, "merge"]) => match index(st, iid) {
            Some(i) => {
                let b = body_of(r);
                let m = &mut st.seed.gitlab.merge_requests[i];
                let mergeable = m.merge_status.is_empty() || m.merge_status == "mergeable";
                if m.state != "opened" || !mergeable {
                    return Some(Reply::status(405, json!({ "message": "405 Method Not Allowed" })));
                }
                if let Some(sha) = b["sha"].as_str()
                    && sha != m.head_sha
                {
                    return Some(Reply::status(409, json!({ "message": format!("SHA does not match HEAD of source branch: {}", m.head_sha) })));
                }
                m.state = "merged".into();
                if let Some(s) = b["squash"].as_bool() {
                    m.squash = s;
                }
                if let Some(d) = b["should_remove_source_branch"].as_bool() {
                    m.remove_source_branch = Some(d);
                }
                m.updated_at = WRITE_TIME.into();
                Reply::json(mr_json(st, &st.seed.gitlab.merge_requests[i], &base, true))
            }
            None => not_found(),
        },
        ("PUT", ["merge_requests", iid]) => match index(st, iid) {
            Some(i) => {
                let b = body_of(r);
                let m = &mut st.seed.gitlab.merge_requests[i];
                if let Some(t) = b["title"].as_str() {
                    m.title = t.into();
                }
                if let Some(d) = b["description"].as_str() {
                    m.description = d.into();
                }
                if let Some(l) = b["labels"].as_str() {
                    m.labels = l.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect();
                }
                // --- 4D T2: retarget ---
                if let Some(t) = b["target_branch"].as_str() {
                    m.target_branch = t.into();
                }
                // --- end 4D T2 ---
                m.updated_at = WRITE_TIME.into();
                Reply::json(mr_json(st, &st.seed.gitlab.merge_requests[i], &base, true))
            }
            None => not_found(),
        },
        // --- end 4B T3 ---
        // --- 4C T2: create, people, labels, templates ---
        ("POST", ["merge_requests"]) => super::create::gitlab_post_mr(st, r, id),
        ("GET", ["members", "all"]) => super::create::gitlab_members(st, r, id),
        ("GET", ["labels"]) => super::create::gitlab_labels(st, r, id),
        ("GET", ["repository", "tree"]) => super::create::gitlab_tree(st, r, id),
        ("GET", ["repository", "files", file, "raw"]) => super::create::gitlab_raw(st, id, file),
        // --- end 4C T2 ---
        // --- 5A T3: project uploads through the API ---
        ("GET", ["uploads", secret, file]) => {
            if st.seed.gitlab.uploads.iter().any(|u| *u == format!("{project}/{secret}/{file}")) { Reply::png() } else { Reply::status(404, json!({ "message": "404 Not Found" })) }
        }
        // --- end 5A T3 ---
        _ => return None,
    };
    Some(reply)
}
