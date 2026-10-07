//! GitLab REST v4, the subset GitBolt uses. 4A: user, token, version, projects, forks, avatars.

use super::{FakeProject, FakeRequest, ForgeState, FakeUser, Reply, GITLAB_HOST};
use serde_json::{json, Value};

pub fn user_json(u: &FakeUser, base: &str) -> Value {
    json!({ "id": u.id, "username": u.username, "name": u.name, "avatar_url": u.avatar_url, "web_url": format!("{base}/gitlab/{}", u.username), "public_email": u.email, "email": u.email })
}

pub fn find<'a>(projects: &'a [FakeProject], id: &str) -> Option<&'a FakeProject> {
    projects.iter().find(|p| p.path == id || p.id.to_string() == id)
}

pub fn project_json(p: &FakeProject, all: &[FakeProject], base: &str) -> Value {
    let (owner, name) = p.path.rsplit_once('/').unwrap_or(("", p.path.as_str()));
    let mut v = json!({
        "id": p.id, "name": name, "path": name, "path_with_namespace": p.path, "namespace": { "full_path": owner },
        "web_url": format!("{base}/gitlab/{}", p.path), "default_branch": p.default_branch,
        "http_url_to_repo": p.http_url.clone().unwrap_or_else(|| format!("{base}/gitlab/{}.git", p.path)),
        "ssh_url_to_repo": p.ssh_url.clone().unwrap_or_else(|| format!("git@{GITLAB_HOST}:{}.git", p.path)),
        "last_activity_at": p.updated_at, "archived": p.archived,
        "squash_option": "default_off", "merge_method": "merge", "remove_source_branch_after_merge": true,
    });
    if let Some(parent) = p.fork_of.as_ref().and_then(|f| all.iter().find(|x| &x.path == f)) {
        v["forked_from_project"] = json!({ "id": parent.id, "path_with_namespace": parent.path });
    }
    if let (Some(obj), Some(extra)) = (v.as_object_mut(), p.settings.as_object()) {
        for (k, x) in extra {
            obj.insert(k.clone(), x.clone());
        }
    }
    v
}

pub(crate) fn route(st: &mut ForgeState, r: &FakeRequest) -> Reply {
    // --- 4B T2: merge requests and pipelines (gitlab_mrs.rs). They write the seed, so they're
    // answered before the borrows below; without a token, 4A's arms answer 401. ---
    if r.token.is_some()
        && let Some(reply) = super::gitlab_mrs::route(st, r)
    {
        let (remaining, reset) = st.rate_headers(2000);
        return reply.header("RateLimit-Limit", "2000").header("RateLimit-Remaining", &remaining).header("RateLimit-Reset", &reset);
    }
    // --- end 4B T2 ---
    // --- MR round 2: GraphQL ---
    if r.method == "POST" && r.segments.iter().map(String::as_str).eq(["api", "graphql"]) {
        return if r.token.is_some() { super::gitlab_mrs::graphql(st, r) } else { Reply::status(401, json!({ "message": "401 Unauthorized" })) };
    }
    // --- end MR round 2 ---
    let segs: Vec<&str> = r.segments.iter().map(String::as_str).collect();
    let projects = &st.seed.gitlab.projects;
    let reply = match (r.method, segs.as_slice()) {
        ("GET", ["uploads", _]) => Reply::png(),
        ("GET", ["api", "v4", "avatar"]) => {
            let email = r.query.get("email").map(|e| e.to_lowercase()).unwrap_or_default();
            Reply::json(json!({ "avatar_url": st.seed.gitlab.avatars.get(&email) }))
        }
        (_, ["api", "v4", ..]) if r.token.is_none() => Reply::status(401, json!({ "message": "401 Unauthorized" })),
        ("GET", ["api", "v4", "user"]) => Reply::json(user_json(&r.token.as_ref().expect("checked").user, r.base)),
        ("GET", ["api", "v4", "personal_access_tokens", "self"]) => {
            let t = r.token.as_ref().expect("checked");
            Reply::json(json!({ "id": 1, "name": "GitBolt", "scopes": t.scopes, "active": true, "revoked": false }))
        }
        // --- commit-author avatars by name ---
        // As GitLab for a non-admin: `search` matches names and usernames (any case, a part of
        // either), and the users carry no email.
        ("GET", ["api", "v4", "users"]) => {
            let q = r.query.get("search").map(|s| s.to_lowercase()).unwrap_or_default();
            let per_page = r.query.get("per_page").and_then(|n| n.parse().ok()).unwrap_or(20);
            let g = &st.seed.gitlab;
            let mut seen = std::collections::HashSet::new();
            let found: Vec<Value> = g.tokens.iter().map(|t| &t.user).chain(&g.users).chain(&g.members)
                .filter(|u| seen.insert(u.id) && (u.name.to_lowercase().contains(&q) || u.username.to_lowercase().contains(&q)))
                .take(per_page)
                .map(|u| json!({ "id": u.id, "username": u.username, "name": u.name, "state": "active", "avatar_url": u.avatar_url, "web_url": format!("{}/gitlab/{}", r.base, u.username) }))
                .collect();
            Reply::json(Value::Array(found))
        }
        // --- end commit-author avatars by name ---
        ("GET", ["api", "v4", "version"]) => Reply::json(json!({ "version": st.seed.gitlab.version, "revision": "fake" })),
        ("GET", ["api", "v4", "projects", id]) => match find(projects, id) {
            Some(p) => Reply::json(project_json(p, projects, r.base)),
            None => Reply::status(404, json!({ "message": "404 Project Not Found" })),
        },
        ("GET", ["api", "v4", "projects", id, "forks"]) => match find(projects, id) {
            Some(p) => {
                let mut forks: Vec<&FakeProject> = projects.iter().filter(|f| f.fork_of.as_deref() == Some(p.path.as_str())).collect();
                forks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let items = forks.iter().map(|f| project_json(f, projects, r.base)).collect();
                Reply::page(items, r, &format!("{}/gitlab{}", r.base, r.path))
            }
            None => Reply::status(404, json!({ "message": "404 Project Not Found" })),
        },
        // --- 4B: merge request routes go here ---
        _ => Reply::status(404, json!({ "message": "404 Not Found" })),
    };
    let (remaining, reset) = st.rate_headers(2000);
    reply.header("RateLimit-Limit", "2000").header("RateLimit-Remaining", &remaining).header("RateLimit-Reset", &reset)
}
