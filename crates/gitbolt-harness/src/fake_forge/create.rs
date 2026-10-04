//! The fake forge's create half (plan 4C): GitLab's one-POST merge request; GitHub's pull request
//! and its follow-up calls (requested reviewers, assignees, labels); the people and labels the
//! pickers search; the template files both forges serve. What's created lands in the seed's
//! `created`, so tests read it back with `current_seed()`, and is mirrored into 4B's lists
//! (`merge_requests`, `pulls`), so 4B's routes (list, view, edit, the badges) and 4D's stack
//! requests find it.

use super::gitlab_mrs::FakeMergeRequest;
use super::github_pulls::FakePull;
use super::{gitlab, FakeLabel, FakeRequest, FakeUser, ForgeState, Reply};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const NOW: &str = "2026-10-04T12:00:00Z";

pub fn seed_gitlab_members(base: &str) -> Vec<FakeUser> {
    vec![
        FakeUser { id: 7, username: "ada".into(), name: "Ada Lovelace".into(), email: Some("ada@example.com".into()), avatar_url: Some(format!("{base}/gitlab/uploads/ada.png")) },
        FakeUser { id: 8, username: "grace".into(), name: "Grace Hopper".into(), email: Some("grace@example.com".into()), avatar_url: None },
    ]
}

pub fn seed_github_assignees(base: &str) -> Vec<FakeUser> {
    vec![
        FakeUser { id: 583231, username: "octocat".into(), name: "The Octocat".into(), email: None, avatar_url: Some(format!("{base}/github-avatars/u/583231")) },
        FakeUser { id: 3, username: "hubot".into(), name: "Hubot".into(), email: None, avatar_url: Some(format!("{base}/github-avatars/u/3")) },
    ]
}

fn label(name: &str, color: &str) -> FakeLabel {
    FakeLabel { name: name.into(), color: color.into(), description: None }
}

pub fn seed_gitlab_labels() -> Vec<FakeLabel> {
    vec![label("bug", "#d9534f"), label("feature", "#428bca")]
}

pub fn seed_github_labels() -> Vec<FakeLabel> {
    vec![label("bug", "d73a4a"), label("enhancement", "a2eeef")]
}

fn body(r: &FakeRequest) -> Value {
    serde_json::from_slice(r.body).unwrap_or(Value::Null)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn matches(u: &FakeUser, q: &str) -> bool {
    let q = q.trim().to_lowercase();
    q.is_empty() || u.username.to_lowercase().contains(&q) || u.name.to_lowercase().contains(&q)
}

fn per_page(r: &FakeRequest, default: usize) -> usize {
    r.query.get("per_page").and_then(|v| v.parse().ok()).filter(|n: &usize| *n > 0).unwrap_or(default)
}

fn text(content: &str) -> Reply {
    Reply { status: 200, headers: Vec::new(), body: content.as_bytes().to_vec(), content_type: "text/plain" }
}

fn labels_json(list: &[FakeLabel]) -> Vec<Value> {
    list.iter().enumerate().map(|(i, l)| json!({ "id": i + 1, "name": l.name, "color": l.color, "description": l.description })).collect()
}

/// The direct children of `dir` among `files`: `(is_dir, path)`, directories once each.
fn children(files: &BTreeMap<String, String>, dir: &str) -> Vec<(bool, String)> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let mut out: Vec<(bool, String)> = Vec::new();
    for path in files.keys() {
        let Some(rest) = path.strip_prefix(&prefix) else { continue };
        let entry = match rest.split_once('/') {
            Some((sub, _)) => (true, format!("{prefix}{sub}")),
            None => (false, path.clone()),
        };
        if !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

fn no_project() -> Reply {
    Reply::status(404, json!({ "message": "404 Project Not Found" }))
}

// --- GitLab ---------------------------------------------------------------------------------

pub(crate) fn gitlab_post_mr(st: &mut ForgeState, r: &FakeRequest, id: &str) -> Reply {
    let token = r.token.as_ref().expect("checked");
    if !token.scopes.iter().any(|s| s == "api") {
        return Reply::status(403, json!({ "error": "insufficient_scope", "error_description": "The request requires higher privileges than provided by the access token." }));
    }
    let Some(source) = gitlab::find(&st.seed.gitlab.projects, id).cloned() else { return no_project() };
    let b = body(r);
    let target = match b["target_project_id"].as_u64() {
        Some(t) => match st.seed.gitlab.projects.iter().find(|p| p.id == t) {
            Some(p) => p.clone(),
            None => return no_project(),
        },
        None => source.clone(),
    };
    let (Some(src_branch), Some(tgt_branch), Some(title)) = (b["source_branch"].as_str(), b["target_branch"].as_str(), b["title"].as_str()) else {
        return Reply::status(400, json!({ "message": "source_branch, target_branch and title are required" }));
    };
    if let Some(dup) = st.seed.gitlab.created.iter().find(|m| m["source_project_id"] == source.id && m["source_branch"] == src_branch && m["state"] == "opened") {
        return Reply::status(409, json!({ "message": [format!("Another open merge request already exists for this source branch: !{}", dup["iid"])] }));
    }
    let iid = st.seed.gitlab.created.iter().filter(|m| m["project_id"] == target.id).count() as u64 + 1;
    let pick = |key: &str| -> Vec<Value> {
        let ids: Vec<u64> = b[key].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        st.seed.gitlab.members.iter().filter(|m| ids.contains(&m.id)).map(|u| gitlab::user_json(u, r.base)).collect()
    };
    let labels: Vec<&str> = b["labels"].as_str().unwrap_or("").split(',').map(str::trim).filter(|l| !l.is_empty()).collect();
    let mr = json!({
        "id": 1000 + iid, "iid": iid, "project_id": target.id, "title": title, "description": b["description"],
        "state": "opened", "draft": title.to_lowercase().starts_with("draft:"), "author": gitlab::user_json(&token.user, r.base),
        "source_branch": src_branch, "target_branch": tgt_branch, "source_project_id": source.id, "target_project_id": target.id,
        "sha": "1111111111111111111111111111111111111111", "web_url": format!("{}/gitlab/{}/-/merge_requests/{iid}", r.base, target.path),
        "labels": labels, "assignees": pick("assignee_ids"), "reviewers": pick("reviewer_ids"),
        "squash": b["squash"].as_bool().unwrap_or(false), "force_remove_source_branch": b["remove_source_branch"].as_bool().unwrap_or(false),
        "has_conflicts": false, "updated_at": NOW,
    });
    st.seed.gitlab.created.push(mr.clone());
    // --- the same MR in 4B's list, as 4B's GitLab routes keep it (a draft is its title's prefix) ---
    let usernames = |key: &str| -> Vec<String> {
        let ids: Vec<u64> = b[key].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        st.seed.gitlab.members.iter().filter(|m| ids.contains(&m.id)).map(|u| u.username.clone()).collect()
    };
    let (reviewers, assignees) = (usernames("reviewer_ids"), usernames("assignee_ids"));
    st.seed.gitlab.merge_requests.push(FakeMergeRequest {
        iid, project: target.path.clone(), source_project: if source.id == target.id { String::new() } else { source.path.clone() },
        source_branch: src_branch.into(), target_branch: tgt_branch.into(), title: title.into(), description: b["description"].as_str().unwrap_or_default().into(),
        state: "opened".into(), author: token.user.username.clone(), head_sha: "1111111111111111111111111111111111111111".into(),
        reviewers, assignees, labels: labels.iter().map(|l| l.to_string()).collect(),
        squash: b["squash"].as_bool().unwrap_or(false), remove_source_branch: b["remove_source_branch"].as_bool(), updated_at: NOW.into(),
        ..Default::default()
    });
    Reply::status(201, mr)
}

pub(crate) fn gitlab_members(st: &ForgeState, r: &FakeRequest, id: &str) -> Reply {
    if gitlab::find(&st.seed.gitlab.projects, id).is_none() {
        return no_project();
    }
    let q = r.query.get("query").map(String::as_str).unwrap_or("");
    let items: Vec<Value> = st.seed.gitlab.members.iter().filter(|u| matches(u, q)).take(per_page(r, 20)).map(|u| gitlab::user_json(u, r.base)).collect();
    Reply::json(Value::Array(items))
}

pub(crate) fn gitlab_labels(st: &ForgeState, r: &FakeRequest, id: &str) -> Reply {
    if gitlab::find(&st.seed.gitlab.projects, id).is_none() {
        return no_project();
    }
    let q = r.query.get("search").map(|s| s.to_lowercase()).unwrap_or_default();
    let all = labels_json(&st.seed.gitlab.labels);
    Reply::json(Value::Array(all.into_iter().filter(|l| l["name"].as_str().is_some_and(|n| n.to_lowercase().contains(&q))).collect()))
}

pub(crate) fn gitlab_tree(st: &ForgeState, r: &FakeRequest, id: &str) -> Reply {
    let Some(p) = gitlab::find(&st.seed.gitlab.projects, id) else { return no_project() };
    let dir = r.query.get("path").cloned().unwrap_or_default();
    let entries: Vec<Value> = st.seed.gitlab.files.get(&p.path).map(|f| children(f, &dir)).unwrap_or_default().into_iter()
        .map(|(is_dir, path)| json!({ "id": "0", "name": path.rsplit('/').next(), "type": if is_dir { "tree" } else { "blob" }, "path": path, "mode": "100644" }))
        .collect();
    if entries.is_empty() {
        return Reply::status(404, json!({ "message": "404 Tree Not Found" }));
    }
    Reply::json(Value::Array(entries))
}

pub(crate) fn gitlab_raw(st: &ForgeState, id: &str, file: &str) -> Reply {
    let Some(p) = gitlab::find(&st.seed.gitlab.projects, id) else { return no_project() };
    match st.seed.gitlab.files.get(&p.path).and_then(|f| f.get(file)) {
        Some(content) => text(content),
        None => Reply::status(404, json!({ "message": "404 File Not Found" })),
    }
}

// --- GitHub ---------------------------------------------------------------------------------

fn gh_user(u: &FakeUser, base: &str) -> Value {
    json!({ "id": u.id, "login": u.username, "avatar_url": u.avatar_url, "html_url": format!("{base}/github-web/{}", u.username) })
}

fn gh_not_found() -> Reply {
    Reply::status(404, json!({ "message": "Not Found" }))
}

fn pull_mut<'a>(st: &'a mut ForgeState, path: &str, n: &str) -> Option<&'a mut Value> {
    let n: u64 = n.parse().ok()?;
    st.seed.github.created.iter_mut().find(|p| p["base"]["repo"]["full_name"] == path && p["number"] == n)
}

/// The follow-up calls change the PR in 4B's list too.
fn mirror_pull(st: &mut ForgeState, path: &str, n: &str, change: impl FnOnce(&mut FakePull)) {
    let Ok(n) = n.parse::<u64>() else { return };
    if let Some(p) = st.seed.github.pulls.iter_mut().find(|p| p.repo == path && p.number == n) {
        change(p);
    }
}

pub(crate) fn github_post_pull(st: &mut ForgeState, r: &FakeRequest, path: &str) -> Reply {
    let token = r.token.as_ref().expect("checked");
    if !token.fine_grained && !token.scopes.iter().any(|s| s == "repo") {
        return Reply::status(403, json!({ "message": "Resource not accessible by personal access token" }));
    }
    if !st.seed.github.repos.iter().any(|p| p.path == path) {
        return gh_not_found();
    }
    let b = body(r);
    let (Some(title), Some(head), Some(base)) = (b["title"].as_str(), b["head"].as_str(), b["base"].as_str()) else {
        return Reply::status(422, json!({ "message": "Validation Failed", "errors": [{ "resource": "PullRequest", "code": "missing_field" }] }));
    };
    let (owner, name) = path.split_once('/').unwrap_or((path, ""));
    let (head_owner, head_ref) = head.split_once(':').unwrap_or((owner, head));
    let head_label = format!("{head_owner}:{head_ref}");
    let created = &st.seed.github.created;
    if created.iter().any(|p| p["base"]["repo"]["full_name"] == path && p["head"]["label"] == head_label.as_str() && p["state"] == "open") {
        return Reply::status(422, json!({ "message": "Validation Failed", "errors": [{ "resource": "PullRequest", "code": "custom", "message": format!("A pull request already exists for {head_label}.") }] }));
    }
    let number = created.iter().filter(|p| p["base"]["repo"]["full_name"] == path).count() as u64 + 1;
    let head_repo = if head_owner == owner { path.to_string() } else { format!("{head_owner}/{name}") };
    let pr = json!({
        "id": 9000 + number, "number": number, "title": title, "body": b["body"], "state": "open", "draft": b["draft"].as_bool().unwrap_or(false),
        "user": gh_user(&token.user, r.base),
        "head": { "ref": head_ref, "label": head_label, "sha": "2222222222222222222222222222222222222222", "repo": { "full_name": head_repo } },
        "base": { "ref": base, "label": format!("{owner}:{base}"), "repo": { "full_name": path } },
        "html_url": format!("{}/github-web/{path}/pull/{number}", r.base),
        "labels": [], "requested_reviewers": [], "assignees": [], "mergeable": null, "updated_at": NOW,
    });
    st.seed.github.created.push(pr.clone());
    // --- the same PR in 4B's list, as 4B's GitHub routes keep it ---
    st.seed.github.pulls.push(FakePull {
        number, repo: path.to_string(), head_repo: if head_owner == owner { String::new() } else { head_repo.clone() }, head_ref: head_ref.into(), base_ref: base.into(),
        title: title.into(), body: b["body"].as_str().unwrap_or_default().into(), state: "open".into(), draft: b["draft"].as_bool().unwrap_or(false),
        author: token.user.username.clone(), head_sha: "2222222222222222222222222222222222222222".into(), updated_at: NOW.into(),
        ..Default::default()
    });
    Reply::status(201, pr)
}

pub(crate) fn github_reviewers(st: &mut ForgeState, r: &FakeRequest, path: &str, n: &str) -> Reply {
    let logins = strings(&body(r)["reviewers"]);
    let collaborators = st.seed.github.assignees.clone();
    let Some(pr) = pull_mut(st, path, n) else { return gh_not_found() };
    if logins.iter().any(|l| pr["user"]["login"] == l.as_str()) {
        return Reply::status(422, json!({ "message": "Review cannot be requested from pull request author." }));
    }
    let mut users = Vec::new();
    for login in &logins {
        match collaborators.iter().find(|u| &u.username == login) {
            Some(u) => users.push(gh_user(u, r.base)),
            None => return Reply::status(422, json!({ "message": format!("Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the {path} repository.") })),
        }
    }
    pr["requested_reviewers"] = Value::Array(users);
    let reply = Reply::status(201, pr.clone());
    mirror_pull(st, path, n, |p| p.requested_reviewers = logins);
    reply
}

pub(crate) fn github_add_assignees(st: &mut ForgeState, r: &FakeRequest, path: &str, n: &str) -> Reply {
    let logins = strings(&body(r)["assignees"]);
    // GitHub drops the logins that can't be assigned, silently.
    let known: Vec<Value> = st.seed.github.assignees.iter().filter(|u| logins.contains(&u.username)).map(|u| gh_user(u, r.base)).collect();
    let on_pr: Vec<String> = st.seed.github.assignees.iter().filter(|u| logins.contains(&u.username)).map(|u| u.username.clone()).collect();
    let Some(pr) = pull_mut(st, path, n) else { return gh_not_found() };
    pr["assignees"] = Value::Array(known);
    let reply = Reply::status(201, pr.clone());
    mirror_pull(st, path, n, |p| p.assignees = on_pr);
    reply
}

pub(crate) fn github_add_labels(st: &mut ForgeState, r: &FakeRequest, path: &str, n: &str) -> Reply {
    let names = strings(&body(r)["labels"]);
    let seeded = st.seed.github.labels.clone();
    let Some(pr) = pull_mut(st, path, n) else { return gh_not_found() };
    let mut on: Vec<Value> = pr["labels"].as_array().cloned().unwrap_or_default();
    for name in names {
        if !on.iter().any(|l| l["name"] == name.as_str()) {
            let color = seeded.iter().find(|l| l.name == name).map(|l| l.color.clone()).unwrap_or_else(|| "ededed".into());
            on.push(json!({ "name": name, "color": color }));
        }
    }
    pr["labels"] = Value::Array(on.clone());
    let names: Vec<String> = on.iter().filter_map(|l| l["name"].as_str().map(str::to_string)).collect();
    mirror_pull(st, path, n, |p| p.labels = names);
    Reply::json(Value::Array(on))
}

pub(crate) fn github_assignees(st: &ForgeState, r: &FakeRequest, path: &str) -> Reply {
    let items = st.seed.github.assignees.iter().map(|u| gh_user(u, r.base)).collect();
    Reply::page(items, r, &format!("{}/github/repos/{path}/assignees", r.base))
}

pub(crate) fn github_labels(st: &ForgeState, r: &FakeRequest, path: &str) -> Reply {
    Reply::page(labels_json(&st.seed.github.labels), r, &format!("{}/github/repos/{path}/labels", r.base))
}

/// `/contents/<file>`: the file (base64, wrapped every 60 characters, as GitHub sends it), or a
/// directory's entries.
pub(crate) fn github_contents(st: &ForgeState, path: &str, file: &str) -> Reply {
    let Some(files) = st.seed.github.files.get(path) else { return gh_not_found() };
    if let Some(content) = files.get(file) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(content);
        let wrapped = encoded.as_bytes().chunks(60).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("\n");
        return Reply::json(json!({ "type": "file", "name": file.rsplit('/').next(), "path": file, "encoding": "base64", "content": wrapped }));
    }
    let entries: Vec<Value> = children(files, file).into_iter().map(|(is_dir, p)| json!({ "type": if is_dir { "dir" } else { "file" }, "name": p.rsplit('/').next(), "path": p })).collect();
    if entries.is_empty() {
        return gh_not_found();
    }
    Reply::json(Value::Array(entries))
}

pub(crate) fn github_user(st: &ForgeState, r: &FakeRequest, id: &str) -> Reply {
    let id: u64 = id.parse().unwrap_or(0);
    let gh = &st.seed.github;
    match gh.tokens.iter().map(|t| &t.user).chain(gh.assignees.iter()).find(|u| u.id == id) {
        Some(u) => Reply::json(gh_user(u, r.base)),
        None => gh_not_found(),
    }
}
