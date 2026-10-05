//! GitHub REST, the subset GitBolt uses. 4A: user (with classic scopes), repos, forks, avatars.

use super::{FakeProject, FakeRequest, FakeUser, ForgeState, Reply, GITHUB_HOST};
use std::collections::BTreeMap;
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
    // --- 4B T4: pull requests (github_pulls.rs), before the borrows below; without a token, 4A's
    // first arm answers 401. ---
    if r.token.is_some()
        && let Some(reply) = super::github_pulls::route(st, r)
    {
        return reply.header("x-ratelimit-limit", "5000").header("x-ratelimit-remaining", "4999").header("x-ratelimit-reset", "4102444800");
    }
    // --- end 4B T4 ---
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
        // --- 4C T2: a user by id (avatars of reviewers and assignees) ---
        ("GET", ["user", id]) => super::create::github_user(st, r, id),
        // --- end 4C T2 ---
        // --- GitHub commit-author avatars ---
        ("GET", ["repos", o, n, "commits"]) if repos.iter().any(|p| p.path == format!("{o}/{n}")) => commits_by_author(&st.seed.github.commit_authors, r),
        // --- end GitHub commit-author avatars ---
        _ => Reply::status(404, json!({ "message": "Not Found" })),
    };
    reply.header("x-ratelimit-limit", "5000").header("x-ratelimit-remaining", &5000u64.saturating_sub(st.served).to_string()).header("x-ratelimit-used", &st.served.min(5000).to_string()).header("x-ratelimit-reset", "4102444800")
}

/// `<base>/github-avatars/u/<id>`, or `/<login>`: any id or login has a picture.
pub(crate) fn avatar(r: &FakeRequest) -> Reply {
    match (r.method, r.segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice()) {
        ("GET", ["u", _]) | ("GET", [_]) => Reply::png(),
        _ => Reply::status(404, json!({ "message": "Not Found" })),
    }
}

// --- GitHub commit-author avatars ---
/// A commit author whose email GitHub links to an account, and one it doesn't.
pub const LINKED_AUTHOR_EMAIL: &str = "linus@personal.example";
pub const UNLINKED_AUTHOR_EMAIL: &str = "nobody@personal.example";

pub fn seed_commit_authors(base: &str) -> BTreeMap<String, Option<FakeUser>> {
    let linus = FakeUser { id: 4242, username: "linus-gh".into(), name: "Linus".into(), email: None, avatar_url: Some(format!("{base}/github-avatars/u/4242?v=4")) };
    BTreeMap::from([(LINKED_AUTHOR_EMAIL.to_string(), Some(linus)), (UNLINKED_AUTHOR_EMAIL.to_string(), None)])
}

/// `/repos/{o}/{r}/commits?author=<email>`: one commit for a seeded email (its `author` the
/// linked account, or `null`), none for any other. Every repository has the same authors.
fn commits_by_author(authors: &BTreeMap<String, Option<FakeUser>>, r: &FakeRequest) -> Reply {
    let Some(email) = r.query.get("author").map(|e| e.to_ascii_lowercase()) else { return Reply::json(json!([])) };
    let Some(linked) = authors.get(&email) else { return Reply::json(json!([])) };
    let author = linked.as_ref().map_or(Value::Null, |u| json!({ "id": u.id, "login": u.username, "avatar_url": u.avatar_url, "type": "User" }));
    Reply::json(json!([{ "sha": "0123456789abcdef0123456789abcdef01234567", "commit": { "author": { "name": "Someone", "email": email } }, "author": author }]))
}
// --- end GitHub commit-author avatars ---
