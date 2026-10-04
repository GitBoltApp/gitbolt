//! GitHub REST, the subset GitBolt uses. 4A: user (with classic scopes), repos, forks, avatars.

use super::{FakeProject, FakeRequest, ForgeState, Reply, GITHUB_HOST};
use serde_json::{json, Value};

pub fn repo_json(p: &FakeProject, base: &str) -> Value {
    let (owner, name) = p.path.split_once('/').unwrap_or(("", p.path.as_str()));
    let mut v = json!({
        "id": p.id, "name": name, "full_name": p.path, "owner": { "login": owner },
        "html_url": format!("{base}/github-web/{}", p.path), "default_branch": p.default_branch,
        "clone_url": p.http_url.clone().unwrap_or_else(|| format!("{base}/github-web/{}.git", p.path)),
        "ssh_url": p.ssh_url.clone().unwrap_or_else(|| format!("git@{GITHUB_HOST}:{}.git", p.path)),
        "fork": p.fork_of.is_some(), "pushed_at": p.updated_at, "updated_at": p.updated_at, "archived": p.archived,
        "allow_merge_commit": true, "allow_squash_merge": true, "allow_rebase_merge": false, "delete_branch_on_merge": false,
    });
    if let Some(parent) = &p.fork_of {
        v["parent"] = json!({ "full_name": parent });
    }
    if let (Some(obj), Some(extra)) = (v.as_object_mut(), p.settings.as_object()) {
        for (k, x) in extra {
            obj.insert(k.clone(), x.clone());
        }
    }
    v
}

pub(crate) fn route(st: &mut ForgeState, r: &FakeRequest) -> Reply {
    let segs: Vec<&str> = r.segments.iter().map(String::as_str).collect();
    let repos = &st.seed.github.repos;
    let reply = match (r.method, segs.as_slice()) {
        _ if r.token.is_none() => Reply::status(401, json!({ "message": "Bad credentials" })),
        ("GET", ["user"]) => {
            let t = r.token.as_ref().expect("checked");
            let u = &t.user;
            let reply = Reply::json(json!({ "id": u.id, "login": u.username, "name": u.name, "avatar_url": u.avatar_url, "html_url": format!("{}/github-web/{}", r.base, u.username), "email": u.email }));
            if t.fine_grained { reply } else { reply.header("X-OAuth-Scopes", &t.scopes.join(", ")) }
        }
        ("GET", ["repos", o, n]) => match repos.iter().find(|p| p.path == format!("{o}/{n}")) {
            Some(p) => Reply::json(repo_json(p, r.base)),
            None => Reply::status(404, json!({ "message": "Not Found" })),
        },
        ("GET", ["repos", o, n, "forks"]) => {
            let path = format!("{o}/{n}");
            let mut forks: Vec<&FakeProject> = repos.iter().filter(|f| f.fork_of.as_deref() == Some(path.as_str())).collect();
            forks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            // GitHub's fork list doesn't carry `parent`.
            let items = forks.iter().map(|f| { let mut v = repo_json(f, r.base); v.as_object_mut().map(|o| o.remove("parent")); v }).collect();
            Reply::page(items, r, &format!("{}/github{}", r.base, r.path))
        }
        // --- 4B: pull request routes go here ---
        _ => Reply::status(404, json!({ "message": "Not Found" })),
    };
    reply.header("x-ratelimit-limit", "5000").header("x-ratelimit-remaining", &5000u64.saturating_sub(st.served).to_string()).header("x-ratelimit-used", &st.served.min(5000).to_string()).header("x-ratelimit-reset", "4102444800")
}

/// `<base>/github-avatars/u/<id>`: any id has a picture.
pub(crate) fn avatar(r: &FakeRequest) -> Reply {
    match (r.method, r.segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice()) {
        ("GET", ["u", _]) => Reply::png(),
        _ => Reply::status(404, json!({ "message": "Not Found" })),
    }
}
