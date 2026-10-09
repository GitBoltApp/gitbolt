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
    /// A multi-line note's first line, (new, old): its `line_range` starts there and ends at
    /// `new_line` / `old_line`.
    pub start: Option<(Option<u32>, Option<u32>)>,
    /// The head its position is against; empty: none said.
    pub head_sha: String,
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
    // --- comment actions ---
    /// Its award emoji.
    pub awards: Vec<FakeAward>,
    // --- end comment actions ---
}

// --- comment actions ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeAward {
    pub id: u64,
    /// `thumbsup`, `tada`, …
    pub name: String,
    /// A username.
    pub user: String,
}
// --- end comment actions ---

// --- review comments ---
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeDraftNote {
    pub id: u64,
    /// A username.
    pub author: String,
    pub note: String,
    /// As the client sent it (GitLab answers it back).
    pub position: Option<Value>,
}

fn me(r: &FakeRequest) -> String {
    r.token.as_ref().map(|t| t.user.username.clone()).unwrap_or_default()
}

fn next_note_id(st: &ForgeState) -> u64 {
    st.seed.gitlab.merge_requests.iter().flat_map(|m| m.discussions.iter()).flat_map(|d| d.notes.iter()).map(|n| n.id).max().unwrap_or(0).max(1000) + 1
}

fn draft_json(st: &ForgeState, iid: u64, d: &FakeDraftNote) -> Value {
    // A GitLab that drops a position answers GitLab's shape for none: every field null.
    let none = json!({ "position_type": "text", "base_sha": null, "start_sha": null, "head_sha": null, "old_path": null, "new_path": null, "old_line": null, "new_line": null, "line_range": null });
    let position = if d.position.is_none() && st.seed.gitlab.drafts_drop_position { none } else { json!(d.position) };
    json!({ "id": d.id, "author_id": person(st, &d.author).id, "merge_request_id": 10_000 + iid, "resolve_discussion": false, "discussion_id": null, "note": d.note, "commit_id": null, "line_code": null, "position": position })
}

/// A position GitLab takes on MR `m`: text, its three SHAs, its last line one of the file's diff
/// lines (an unchanged line naming both numbers), and a `line_range` whose ends are lines too,
/// with their line codes. GitLab's refusal (a 400) otherwise.
fn check_position(m: &FakeMergeRequest, p: &Value) -> Result<FakePosition, Reply> {
    use gitbolt_core::forge::review::{commentable_lines, line_code};
    let refused = || Reply::status(400, json!({ "message": "400 Bad request - Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}" }));
    let s = |k: &str| p[k].as_str().unwrap_or_default().to_string();
    if s("position_type") != "text" || ["base_sha", "start_sha", "head_sha"].iter().any(|k| s(k).is_empty()) {
        return Err(refused());
    }
    // The SHAs must be the MR's own diff refs, when it has them.
    if !m.base_sha.is_empty() && (s("base_sha") != m.base_sha || s("start_sha") != m.base_sha || s("head_sha") != m.head_sha) {
        return Err(refused());
    }
    let new_path = s("new_path");
    let Some(d) = m.diffs.iter().find(|d| d.new_path == new_path) else { return Err(refused()) };
    let lines = commentable_lines(&d.diff);
    let num = |v: &Value| v.as_u64().map(|n| n as u32);
    let find = |v: &Value| lines.iter().copied().find(|l| l.position_lines() == (num(&v["old_line"]), num(&v["new_line"])));
    let end = find(p).ok_or_else(refused)?;
    let mut start = None;
    if !p["line_range"].is_null() {
        let (a, b) = (&p["line_range"]["start"], &p["line_range"]["end"]);
        let (first, last) = (find(a).ok_or_else(refused)?, find(b).ok_or_else(refused)?);
        let coded = |v: &Value, l: gitbolt_core::forge::ReviewLine| v["line_code"].as_str() == Some(line_code(&new_path, &l).as_str());
        if last != end || !coded(a, first) || !coded(b, last) {
            return Err(refused());
        }
        start = Some((num(&a["new_line"]), num(&a["old_line"])));
    }
    Ok(FakePosition { new_path, old_path: s("old_path"), new_line: num(&p["new_line"]), old_line: num(&p["old_line"]), start, head_sha: s("head_sha") })
}
// --- end review comments ---

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeDiscussion {
    pub id: String,
    pub notes: Vec<FakeNote>,
    pub resolvable: bool,
    pub resolved: bool,
    // --- comment actions ---
    /// The username who resolved it.
    pub resolved_by: Option<String>,
    // --- end comment actions ---
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
    /// A merge leaves it `locked` (GitLab merging it) until the next GET of it, then `merged`.
    pub locks_on_merge: bool,
    /// Set to auto-merge by this username (GitLab's `merge_user`); `None`: not set.
    pub auto_merge_by: Option<String>,
    /// The messages the last merge (or auto-merge) asked for.
    pub merge_commit_message: Option<String>,
    pub squash_commit_message: Option<String>,
    /// RFC 3339.
    pub updated_at: String,
    pub discussions: Vec<FakeDiscussion>,
    pub diffs: Vec<FakeDiff>,
    // --- MR round 2 ---
    /// `diff_refs.base_sha` (a single MR's GET); empty: none.
    pub base_sha: String,
    /// Usernames subscribed to its notifications (`subscribed` is the token user's).
    pub subscribers: Vec<String>,
    /// Usernames whose reviewer state is requested changes (`mergeRequestRequestChanges`).
    pub changes_requested_by: Vec<String>,
    // --- review comments ---
    /// Draft notes, each its author's own (only they see it).
    pub draft_notes: Vec<FakeDraftNote>,
    // --- end review comments ---
    // --- end MR round 2 ---
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
    let note = |id: u64, author: &str, body: &str, at: &str| FakeNote { id, author: author.into(), body: body.into(), created_at: at.into(), system: false, position: None, awards: vec![] };
    let readme = FakePosition { new_path: "README.md".into(), old_path: "README.md".into(), new_line: Some(2), old_line: None, start: None, ..Default::default() };
    vec![
        FakeMergeRequest {
            description: "Adds the dev work.\n\nCloses #3.".into(),
            pipeline: Some("success".into()),
            reviewers: vec!["ada".into()],
            approvals_required: 1,
            merge_status: "not_approved".into(),
            labels: vec!["backend".into()],
            discussions: vec![
                FakeDiscussion { id: "d1".into(), notes: vec![note(101, "grace", "Looks good overall.", "2026-10-04T09:00:00Z")], resolvable: false, resolved: false, resolved_by: None },
                FakeDiscussion {
                    id: "d2".into(),
                    notes: vec![
                        FakeNote { position: Some(readme), ..note(102, "grace", "Why the second line?", "2026-10-04T09:05:00Z") },
                        // The thread's own system note, later than the thread's neighbours.
                        FakeNote { system: true, ..note(104, "grace", "changed this line in [version 2 of the diff](/gitlab/group/project/-/merge_requests/12/diffs?diff_id=2#note_104)", "2026-10-04T09:20:00Z") },
                    ],
                    resolvable: true,
                    resolved: false,
                    resolved_by: None,
                },
                FakeDiscussion { id: "d3".into(), notes: vec![FakeNote { system: true, ..note(103, "grace", "added 1 commit", "2026-10-04T09:10:00Z") }], resolvable: false, resolved: false, resolved_by: None },
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
    st.seed.gitlab.tokens.iter().map(|t| &t.user).chain(st.seed.gitlab.users.iter()).chain(st.seed.gitlab.members.iter()).find(|u| u.username == username).cloned().unwrap_or_else(|| FakeUser { id: 999, username: username.into(), name: username.into(), ..Default::default() })
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
        "merge_when_pipeline_succeeds": m.auto_merge_by.is_some(),
        "merge_user": m.auto_merge_by.as_deref().map_or(Value::Null, |u| user_json(&person(st, u), base)),
    });
    if single {
        v["head_pipeline"] = m.pipeline.as_deref().map_or(Value::Null, |s| pipeline_json(m, s, base));
        // --- MR round 2 ---
        if !m.base_sha.is_empty() {
            v["diff_refs"] = json!({ "base_sha": m.base_sha, "start_sha": m.base_sha, "head_sha": m.head_sha });
        }
        // --- end MR round 2 ---
    }
    v
}

// --- MR round 2 ---
/// A single MR's JSON for the token's user (`subscribed` is theirs).
fn mr_json_for(st: &ForgeState, m: &FakeMergeRequest, r: &FakeRequest, base: &str) -> Value {
    let mut v = mr_json(st, m, base, true);
    let me = r.token.as_ref().map(|t| t.user.username.as_str());
    v["subscribed"] = me.is_some_and(|u| m.subscribers.iter().any(|s| s == u)).into();
    v
}

/// `/api/graphql`: the people flags (per project) and `mergeRequestRequestChanges`. An older
/// GitLab (`old_graphql`) knows neither: GraphQL's "doesn't exist" errors.
pub(crate) fn graphql(st: &mut ForgeState, r: &FakeRequest) -> Reply {
    let b = body_of(r);
    let query = b["query"].as_str().unwrap_or_default();
    let vars = &b["variables"];
    let missing = |field: &str, on: &str| Reply::json(json!({ "errors": [{ "message": format!("Field '{field}' doesn't exist on type '{on}'") }] }));
    if query.contains("allowsMultipleReviewers") {
        if st.seed.gitlab.old_graphql {
            return missing("allowsMultipleReviewers", "MergeRequest");
        }
        let path = vars["path"].as_str().unwrap_or_default();
        let Some(p) = st.seed.gitlab.projects.iter().find(|p| p.path == path) else { return Reply::json(json!({ "data": { "project": null } })) };
        let multiple = !p.single_people;
        let nodes: Vec<Value> = st.seed.gitlab.merge_requests.iter().filter(|m| m.project == path).take(1).map(|_| json!({ "allowsMultipleReviewers": multiple, "allowsMultipleAssignees": multiple })).collect();
        return Reply::json(json!({ "data": { "project": { "mergeRequests": { "nodes": nodes } } } }));
    }
    if query.contains("mergeRequestRequestChanges") {
        if st.seed.gitlab.old_graphql {
            return missing("mergeRequestRequestChanges", "Mutation");
        }
        let (path, iid) = (vars["path"].as_str().unwrap_or_default(), vars["iid"].as_str().unwrap_or_default());
        let me = r.token.as_ref().map(|t| t.user.username.clone()).unwrap_or_default();
        return match st.seed.gitlab.merge_requests.iter_mut().find(|m| m.project == path && m.iid.to_string() == iid) {
            Some(m) => {
                if !m.changes_requested_by.contains(&me) {
                    m.changes_requested_by.push(me);
                }
                Reply::json(json!({ "data": { "mergeRequestRequestChanges": { "errors": [] } } }))
            }
            None => Reply::json(json!({ "data": { "mergeRequestRequestChanges": null }, "errors": [{ "message": "The resource that you are attempting to access does not exist" }] })),
        };
    }
    // --- comment actions: every note's award emoji, one page ---
    if query.contains("awardEmoji") {
        if st.seed.gitlab.old_graphql {
            return missing("awardEmoji", "Note");
        }
        let (path, iid) = (vars["path"].as_str().unwrap_or_default(), vars["iid"].as_str().unwrap_or_default());
        let Some(m) = st.seed.gitlab.merge_requests.iter().find(|m| m.project == path && m.iid.to_string() == iid) else {
            return Reply::json(json!({ "data": { "project": { "mergeRequest": null } } }));
        };
        let nodes: Vec<Value> = m.discussions.iter().flat_map(|d| d.notes.iter()).map(|n| json!({
            "id": format!("gid://gitlab/Note/{}", n.id),
            "awardEmoji": { "nodes": n.awards.iter().map(|a| { let u = person(st, &a.user); json!({ "name": a.name, "user": { "id": format!("gid://gitlab/User/{}", u.id), "username": u.username, "name": u.name } }) }).collect::<Vec<_>>() },
        })).collect();
        return Reply::json(json!({ "data": { "project": { "mergeRequest": { "notes": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": nodes } } } } }));
    }
    // --- end comment actions ---
    Reply::json(json!({ "errors": [{ "message": "Unknown query" }] }))
}

// --- comment actions ---
fn award_json(st: &ForgeState, a: &FakeAward, base: &str) -> Value {
    json!({ "id": a.id, "name": a.name, "user": user_json(&person(st, &a.user), base), "awardable_type": "Note" })
}

/// MR `i`'s note `nid`: (discussion, note) indexes.
fn note_at(st: &ForgeState, i: usize, nid: &str) -> Option<(usize, usize)> {
    st.seed.gitlab.merge_requests[i].discussions.iter().enumerate().find_map(|(d, x)| x.notes.iter().position(|n| n.id.to_string() == nid).map(|n| (d, n)))
}

fn forbidden() -> Reply {
    Reply::status(403, json!({ "message": "403 Forbidden" }))
}

/// The award emoji and note routes under `merge_requests/<iid>/notes/<id>`: anyone may award,
/// only the note's author edits or deletes it, and only an award's user removes it.
fn note_route(st: &mut ForgeState, r: &FakeRequest, i: usize, nid: &str, rest: &[&str], base: &str) -> Reply {
    let Some((d, n)) = note_at(st, i, nid) else { return not_found() };
    let me = r.token.as_ref().map(|t| t.user.username.clone()).unwrap_or_default();
    fn at(st: &mut ForgeState, i: usize, d: usize, n: usize) -> &mut FakeNote {
        &mut st.seed.gitlab.merge_requests[i].discussions[d].notes[n]
    }
    match (r.method, rest) {
        ("GET", ["award_emoji"]) => {
            let items = at(st, i, d, n).awards.clone();
            Reply::page(items.iter().map(|a| award_json(st, a, base)).collect(), r, &format!("{base}/gitlab{}", r.path))
        }
        ("POST", ["award_emoji"]) => {
            let Some(name) = body_of(r)["name"].as_str().map(str::to_string) else { return bad_request() };
            if at(st, i, d, n).awards.iter().any(|a| a.name == name && a.user == me) {
                return Reply::status(404, json!({ "message": { "base": ["Award Emoji Name has already been taken"] } }));
            }
            let id = st.seed.gitlab.merge_requests.iter().flat_map(|m| m.discussions.iter()).flat_map(|d| d.notes.iter()).flat_map(|n| n.awards.iter()).map(|a| a.id).max().unwrap_or(0).max(500) + 1;
            let a = FakeAward { id, name, user: me };
            at(st, i, d, n).awards.push(a.clone());
            Reply::status(201, award_json(st, &a, base))
        }
        ("DELETE", ["award_emoji", aid]) => {
            let awards = &mut at(st, i, d, n).awards;
            match awards.iter().position(|a| a.id.to_string() == *aid) {
                Some(k) if awards[k].user == me => {
                    awards.remove(k);
                    Reply::no_content()
                }
                Some(_) => forbidden(),
                None => not_found(),
            }
        }
        ("PUT", []) => {
            if at(st, i, d, n).author != me {
                return forbidden();
            }
            let Some(body) = body_of(r)["body"].as_str().map(str::to_string) else { return bad_request() };
            at(st, i, d, n).body = body;
            let disc = &st.seed.gitlab.merge_requests[i].discussions[d];
            Reply::json(note_json(st, &disc.notes[n], disc.resolvable, disc.resolved, base))
        }
        ("DELETE", []) => {
            if at(st, i, d, n).author != me {
                return forbidden();
            }
            let ds = &mut st.seed.gitlab.merge_requests[i].discussions;
            ds[d].notes.remove(n);
            if ds[d].notes.is_empty() {
                ds.remove(d);
            }
            Reply::no_content()
        }
        _ => not_found(),
    }
}
// --- end comment actions ---
// --- end MR round 2 ---

fn note_json(st: &ForgeState, n: &FakeNote, resolvable: bool, resolved: bool, base: &str) -> Value {
    json!({
        "id": n.id, "body": n.body, "author": user_json(&person(st, &n.author), base), "created_at": n.created_at, "system": n.system,
        "type": if n.position.is_some() { Value::from("DiffNote") } else { Value::Null },
        "position": n.position.as_ref().map(|p| {
            // GitLab's line refs: `type` is the side the line is only on (null for a context line).
            let at = |(new, old): (Option<u32>, Option<u32>)| json!({
                "line_code": format!("f00d_{}_{}", old.unwrap_or(0), new.unwrap_or(0)),
                "type": match (new, old) { (Some(_), None) => Value::from("new"), (None, Some(_)) => Value::from("old"), _ => Value::Null },
                "new_line": new, "old_line": old,
            });
            let range = p.start.map_or(Value::Null, |s| json!({ "start": at(s), "end": at((p.new_line, p.old_line)) }));
            json!({ "position_type": "text", "new_path": p.new_path, "old_path": p.old_path, "new_line": p.new_line, "old_line": p.old_line, "line_range": range, "head_sha": if p.head_sha.is_empty() { Value::Null } else { Value::from(p.head_sha.as_str()) } })
        }),
        "resolvable": resolvable, "resolved": resolved,
    })
}

fn discussion_json(st: &ForgeState, d: &FakeDiscussion, base: &str) -> Value {
    // --- comment actions: each note of a resolved discussion names who resolved it ---
    let by = d.resolved_by.as_deref().filter(|_| d.resolved).map_or(Value::Null, |u| user_json(&person(st, u), base));
    let notes: Vec<Value> = d.notes.iter().map(|n| { let mut v = note_json(st, n, d.resolvable, d.resolved, base); if d.resolvable { v["resolved_by"] = by.clone(); } v }).collect();
    json!({ "id": d.id, "individual_note": d.notes.len() == 1 && !d.resolvable, "notes": notes })
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
    // `updated_after` includes its own time (RFC 3339 in UTC compares as text).
    let branch_ok = branch_ok && q.get("updated_after").is_none_or(|t| m.updated_at.as_str() >= t.as_str());
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
    Some(FakeNote { id, author, body, created_at: WRITE_TIME.into(), system: false, position: None, awards: vec![] })
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
            Some(i) => {
                let reply = Reply::json(mr_json_for(st, &st.seed.gitlab.merge_requests[i], r, &base));
                // GitLab's merge finishes: the next GET says merged.
                let m = &mut st.seed.gitlab.merge_requests[i];
                if m.state == "locked" {
                    m.state = "merged".into();
                    m.updated_at = WRITE_TIME.into();
                }
                reply
            }
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
                st.seed.gitlab.merge_requests[i].discussions.push(FakeDiscussion { id: format!("d{}", note.id), notes: vec![note.clone()], resolvable: false, resolved: false, resolved_by: None });
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
        // --- comment actions ---
        (_, ["merge_requests", iid, "notes", nid, more @ ..]) => match index(st, iid) {
            Some(i) => note_route(st, r, i, nid, more, &base),
            None => not_found(),
        },
        ("PUT", ["merge_requests", iid, "discussions", did]) => match index(st, iid) {
            Some(i) => {
                let me = r.token.as_ref().map(|t| t.user.username.clone()).unwrap_or_default();
                let Some(d) = st.seed.gitlab.merge_requests[i].discussions.iter_mut().find(|d| d.id == *did) else { return Some(not_found()) };
                if !d.resolvable {
                    return Some(bad_request());
                }
                let Some(on) = r.query.get("resolved").map(|v| v == "true") else { return Some(bad_request()) };
                d.resolved = on;
                d.resolved_by = on.then_some(me);
                let d = d.clone();
                Reply::json(discussion_json(st, &d, &base))
            }
            None => not_found(),
        },
        // --- end comment actions ---
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
                let me = r.token.as_ref().map(|t| t.user.username.clone()).unwrap_or_default();
                let m = &mut st.seed.gitlab.merge_requests[i];
                let mergeable = m.merge_status.is_empty() || m.merge_status == "mergeable";
                // --- auto-merge: either flag (17.11's `auto_merge`, the older one) while the pipeline hasn't finished ---
                let auto = b["auto_merge"].as_bool() == Some(true) || b["merge_when_pipeline_succeeds"].as_bool() == Some(true);
                let unfinished = matches!(m.pipeline.as_deref(), Some("created" | "pending" | "running" | "waiting_for_resource" | "preparing"));
                let waits = auto && unfinished && m.state == "opened" && !is_draft(&m.title) && !m.has_conflicts;
                // --- end auto-merge ---
                if m.state != "opened" || (!mergeable && !waits) {
                    return Some(Reply::status(405, json!({ "message": "405 Method Not Allowed" })));
                }
                if let Some(sha) = b["sha"].as_str()
                    && sha != m.head_sha
                {
                    return Some(Reply::status(409, json!({ "message": format!("SHA does not match HEAD of source branch: {}", m.head_sha) })));
                }
                if waits {
                    m.auto_merge_by = Some(me);
                } else {
                    m.state = if m.locks_on_merge { "locked" } else { "merged" }.into();
                }
                if let Some(s) = b["squash"].as_bool() {
                    m.squash = s;
                }
                if let Some(d) = b["should_remove_source_branch"].as_bool() {
                    m.remove_source_branch = Some(d);
                }
                m.merge_commit_message = b["merge_commit_message"].as_str().map(str::to_string);
                m.squash_commit_message = b["squash_commit_message"].as_str().map(str::to_string);
                m.updated_at = WRITE_TIME.into();
                Reply::json(mr_json(st, &st.seed.gitlab.merge_requests[i], &base, true))
            }
            None => not_found(),
        },
        // --- auto-merge ---
        ("POST", ["merge_requests", iid, "cancel_merge_when_pipeline_succeeds"]) => match index(st, iid) {
            Some(i) => {
                let m = &mut st.seed.gitlab.merge_requests[i];
                if m.state != "opened" || m.auto_merge_by.take().is_none() {
                    return Some(Reply::status(406, json!({ "message": "406 Not Acceptable" })));
                }
                m.updated_at = WRITE_TIME.into();
                Reply::status(201, mr_json(st, &st.seed.gitlab.merge_requests[i], &base, true))
            }
            None => not_found(),
        },
        // --- end auto-merge ---
        ("PUT", ["merge_requests", iid]) => match index(st, iid) {
            Some(i) => {
                let b = body_of(r);
                // The whole lists, as ids; like GitLab, an id it can't add is dropped silently.
                let people = |key: &str| -> Option<Vec<String>> {
                    let ids: Vec<u64> = b[key].as_array()?.iter().filter_map(Value::as_u64).collect();
                    let g = &st.seed.gitlab;
                    Some(ids.iter().filter_map(|id| g.tokens.iter().map(|t| &t.user).chain(&g.users).chain(&g.members).find(|u| u.id == *id)).map(|u| u.username.clone()).collect())
                };
                let (mut reviewers, mut assignees) = (people("reviewer_ids"), people("assignee_ids"));
                // --- MR round 2: GitLab Free keeps only the first id, silently ---
                if find(&st.seed.gitlab.projects, &project).is_some_and(|p| p.single_people) {
                    for list in [&mut reviewers, &mut assignees].into_iter().flatten() {
                        list.truncate(1);
                    }
                }
                // --- end MR round 2 ---
                let m = &mut st.seed.gitlab.merge_requests[i];
                if let Some(list) = reviewers {
                    m.reviewers = list;
                }
                if let Some(list) = assignees {
                    m.assignees = list;
                }
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
        // --- MR round 2: one member (whoever a PUT can add), and notifications (304 when already so, as GitLab) ---
        ("GET", ["members", "all", uid]) => {
            let g = &st.seed.gitlab;
            match g.tokens.iter().map(|t| &t.user).chain(&g.users).chain(&g.members).find(|u| u.id.to_string() == *uid) {
                Some(u) => Reply::json(user_json(u, &base)),
                None => not_found(),
            }
        }
        ("POST", ["merge_requests", iid, action @ ("subscribe" | "unsubscribe")]) => match (index(st, iid), r.token.as_ref().map(|t| t.user.username.clone())) {
            (Some(i), Some(me)) => {
                let on = *action == "subscribe";
                let m = &mut st.seed.gitlab.merge_requests[i];
                if m.subscribers.contains(&me) == on {
                    return Some(Reply::status(304, Value::Null));
                }
                if on { m.subscribers.push(me) } else { m.subscribers.retain(|u| *u != me) }
                Reply::status(201, mr_json_for(st, &st.seed.gitlab.merge_requests[i], r, &base))
            }
            _ => not_found(),
        },
        // --- end MR round 2 ---
        // --- 4C T2: create, people, labels, templates ---
        ("POST", ["merge_requests"]) => super::create::gitlab_post_mr(st, r, id),
        ("GET", ["members", "all"]) => super::create::gitlab_members(st, r, id),
        ("GET", ["labels"]) => super::create::gitlab_labels(st, r, id),
        ("GET", ["repository", "tree"]) => super::create::gitlab_tree(st, r, id),
        ("GET", ["repository", "files", file, "raw"]) => super::create::gitlab_raw(st, id, file),
        // --- end 4C T2 ---
        // --- 5A T3: project uploads through the API ---
        ("GET", ["uploads", secret, file]) => {
            if st.seed.gitlab.no_uploads_api {
                // Grape's answer to a route it doesn't have.
                Reply::status(404, json!({ "error": "404 Not Found" }))
            } else if st.seed.gitlab.uploads.iter().any(|u| *u == format!("{project}/{secret}/{file}")) {
                Reply::attachment(file, super::upload_bytes(file))
            } else {
                Reply::status(404, json!({ "message": "404 Not Found" }))
            }
        }
        // --- end 5A T3 ---
        // --- review comments: draft notes (the token user's own) and positioned threads ---
        ("GET", ["merge_requests", iid, "draft_notes"]) => match index(st, iid) {
            Some(i) => {
                let me = me(r);
                let m = &st.seed.gitlab.merge_requests[i];
                Reply::page(m.draft_notes.iter().filter(|d| d.author == me).map(|d| draft_json(st, m.iid, d)).collect(), r, &here)
            }
            None => not_found(),
        },
        ("POST", ["merge_requests", iid, "draft_notes", "bulk_publish"]) => match index(st, iid) {
            Some(i) => {
                let me = me(r);
                let first = next_note_id(st);
                let m = &st.seed.gitlab.merge_requests[i];
                let mine: Vec<(String, Option<FakePosition>)> = m.draft_notes.iter().filter(|d| d.author == me).map(|d| (d.note.clone(), d.position.as_ref().and_then(|p| check_position(m, p).ok()))).collect();
                let m = &mut st.seed.gitlab.merge_requests[i];
                m.draft_notes.retain(|d| d.author != me);
                for (id, (body, position)) in (first..).zip(mine) {
                    let note = FakeNote { id, author: me.clone(), body, created_at: WRITE_TIME.into(), system: false, position, awards: vec![] };
                    m.discussions.push(FakeDiscussion { id: format!("d{id}"), notes: vec![note], resolvable: true, resolved: false, resolved_by: None });
                }
                m.updated_at = WRITE_TIME.into();
                Reply::no_content()
            }
            None => not_found(),
        },
        ("POST", ["merge_requests", iid, "draft_notes"]) => match index(st, iid) {
            Some(i) => {
                let b = body_of(r);
                let Some(note) = b["note"].as_str().map(str::to_string) else { return Some(bad_request()) };
                let position = if st.seed.gitlab.drafts_drop_position || b["position"].is_null() {
                    None
                } else {
                    if let Err(refused) = check_position(&st.seed.gitlab.merge_requests[i], &b["position"]) {
                        return Some(refused);
                    }
                    Some(b["position"].clone())
                };
                let id = st.seed.gitlab.merge_requests.iter().flat_map(|m| m.draft_notes.iter()).map(|d| d.id).max().unwrap_or(0).max(2000) + 1;
                let d = FakeDraftNote { id, author: me(r), note, position };
                st.seed.gitlab.merge_requests[i].draft_notes.push(d.clone());
                Reply::status(201, draft_json(st, st.seed.gitlab.merge_requests[i].iid, &d))
            }
            None => not_found(),
        },
        ("PUT", ["merge_requests", iid, "draft_notes", did]) => match index(st, iid) {
            Some(i) => {
                let me = me(r);
                let Some(note) = body_of(r)["note"].as_str().map(str::to_string) else { return Some(bad_request()) };
                let Some(d) = st.seed.gitlab.merge_requests[i].draft_notes.iter_mut().find(|d| d.id.to_string() == *did && d.author == me) else { return Some(not_found()) };
                d.note = note;
                let d = d.clone();
                Reply::json(draft_json(st, st.seed.gitlab.merge_requests[i].iid, &d))
            }
            None => not_found(),
        },
        ("DELETE", ["merge_requests", iid, "draft_notes", did]) => match index(st, iid) {
            Some(i) => {
                let me = me(r);
                let drafts = &mut st.seed.gitlab.merge_requests[i].draft_notes;
                match drafts.iter().position(|d| d.id.to_string() == *did && d.author == me) {
                    Some(k) => {
                        drafts.remove(k);
                        Reply::no_content()
                    }
                    None => not_found(),
                }
            }
            None => not_found(),
        },
        ("POST", ["merge_requests", iid, "discussions"]) => match index(st, iid) {
            Some(i) => {
                let b = body_of(r);
                let Some(body) = b["body"].as_str().map(str::to_string) else { return Some(bad_request()) };
                let position = match check_position(&st.seed.gitlab.merge_requests[i], &b["position"]) {
                    Ok(p) => p,
                    Err(refused) => return Some(refused),
                };
                let id = next_note_id(st);
                let note = FakeNote { id, author: me(r), body, created_at: WRITE_TIME.into(), system: false, position: Some(position), awards: vec![] };
                let d = FakeDiscussion { id: format!("d{id}"), notes: vec![note], resolvable: true, resolved: false, resolved_by: None };
                st.seed.gitlab.merge_requests[i].discussions.push(d.clone());
                Reply::status(201, discussion_json(st, &d, &base))
            }
            None => not_found(),
        },
        // --- end review comments ---
        _ => return None,
    };
    Some(reply)
}
