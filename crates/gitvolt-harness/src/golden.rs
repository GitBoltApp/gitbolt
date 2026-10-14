//! Golden payloads for the website demo's parity suite (`just demo-golden`): the real core's
//! answers to a list of requests on a fixture, with the fixture's paths rewritten to where the
//! demo keeps its copy (`/demo/<name>`; ui/scripts/pack-demo.mjs), so the demo's answers on the
//! same fixture's bundle compare as they are.

use crate::{Harness, HarnessOptions};
use gitvolt_core::api::Request;
use gitvolt_core::settings::{AppSettings, Profile, DEFAULT_PROFILE_ID};
use gitvolt_core::testing::{isolated_git_env, FIXTURE_MARKER};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// The parity suite's instant (the demo's `PARITY_MS`): 1800000000 s, +0000.
pub const GOLDEN_NOW_MS: i64 = 1_800_000_000_000;
/// The visitor (the interfaces doc) at that instant, as git reads them.
pub const GOLDEN_GIT_ENV: [(&str, &str); 6] = [
    ("GIT_AUTHOR_NAME", "You"),
    ("GIT_AUTHOR_EMAIL", "you@example.com"),
    ("GIT_AUTHOR_DATE", "@1800000000 +0000"),
    ("GIT_COMMITTER_NAME", "You"),
    ("GIT_COMMITTER_EMAIL", "you@example.com"),
    ("GIT_COMMITTER_DATE", "@1800000000 +0000"),
];

/// Events a recording drops: streamed output and progress (the demo has none to stream).
const UNRECORDED: [&str; 3] = ["opOutput", "opRemote", "opProgress"];

/// Larger `base64` and `dump` strings (images, media, hex dumps) are kept as their digest.
const LARGE: usize = 16 * 1024;

/// Where a fixture folder's top-level piece lives in the demo (as `demoRoot` in pack-demo.mjs).
pub fn demo_root(name: &str, piece: &str) -> String {
    match piece {
        "repo" => format!("/demo/{name}"),
        "origin.git" => format!("/demo/.origins/{name}.git"),
        _ => format!("/demo/.extra/{name}/{piece}"),
    }
}

fn piece_ends(c: Option<char>) -> bool {
    c.is_none_or(|c| c == '/' || c == '"' || c == '\'' || c == '\0' || c.is_whitespace())
}

/// `text` with every `<root>/<piece>` pointing at the demo's copy (pack-demo.mjs's `rewritePaths`).
pub fn rewrite_paths(text: &str, root: &str, name: &str, pieces: &[String]) -> String {
    let prefix = format!("{root}/");
    let mut sorted: Vec<&String> = pieces.iter().collect();
    sorted.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(&prefix) {
        out.push_str(&rest[..at]);
        let after = &rest[at + prefix.len()..];
        match sorted.iter().find(|p| after.starts_with(p.as_str()) && piece_ends(after[p.len()..].chars().next())) {
            Some(p) => {
                out.push_str(&demo_root(name, p));
                rest = &after[p.len()..];
            }
            // A folder beside the main worktree (a suggested worktree path, `<repo>-<branch>`):
            // beside the demo's, whose folder is the fixture's name.
            None if after.starts_with("repo-") => {
                out.push_str(&format!("{}-", demo_root(name, "repo")));
                rest = &after["repo-".len()..];
            }
            None => {
                out.push_str(&prefix);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn last_component(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Every string and key of `v` with its fixture paths rewritten; a `name` beside a `path` that
/// was the path's last component follows it (the main worktree's folder is `repo` here).
pub fn normalise(v: &mut Value, root: &str, name: &str, pieces: &[String]) {
    match v {
        Value::String(s) => *s = rewrite_paths(s, root, name, pieces),
        Value::Array(items) => items.iter_mut().for_each(|x| normalise(x, root, name, pieces)),
        Value::Object(map) => {
            let follows = match (map.get("path").and_then(Value::as_str), map.get("name").and_then(Value::as_str)) {
                (Some(p), Some(n)) => last_component(p) == n,
                _ => false,
            };
            let old = std::mem::take(map);
            for (k, mut x) in old {
                normalise(&mut x, root, name, pieces);
                map.insert(rewrite_paths(&k, root, name, pieces), x);
            }
            if follows && let Some(p) = map.get("path").and_then(Value::as_str).map(|p| last_component(p).to_string()) {
                map.insert("name".into(), Value::String(p));
            }
        }
        _ => {}
    }
}

/// The placeholder ui/src/demo/golden/normalise.ts compares against for the versions it masks.
const VERSION: &str = "<version>";

/// The list versions that hash the worktree's absolute path (each fixture records in a fresh
/// temp root) as `<version>`: a working-copy answer's `wip`, `wip.staged` and `wip.unstaged`, and
/// a `repoChanged` event's `versions` values. The same fields normalise.ts masks on the demo side.
pub fn mask_versions(v: &mut Value) {
    let mask = |x: &mut Value| {
        if let Some(version) = x.get_mut("version") {
            *version = json!(VERSION);
        }
    };
    if v.get("journal").is_some()
        && v.get("staging").is_some()
        && let Some(wip) = v.get_mut("wip").filter(|w| w.is_object())
    {
        mask(wip);
        for part in ["staged", "unstaged"] {
            if let Some(p) = wip.get_mut(part).filter(|p| p.is_object()) {
                mask(p);
            }
        }
    }
    if v.get("type").and_then(Value::as_str) == Some("repoChanged")
        && let Some(Value::Object(versions)) = v.get_mut("versions")
    {
        versions.values_mut().for_each(|x| *x = json!(VERSION));
    }
}

/// The placeholder for a field `mask_untimed` hides.
const UNTIMED: &str = "<untimed>";

/// Where a forge answer holds the recording's wall clock, its HTTP state or the harness's token
/// storage, by method: dot-separated paths, `[]` for each item of a list. ui/src/demo/golden/
/// normalise.ts drops the same fields on both sides (keep the two tables alike).
const UNTIMED_FIELDS: [(&str, &[&str]); 6] = [
    ("forgeAccounts", &["[].account.addedAt", "[].account.storage", "[].account.versionCheckedAt"]),
    ("forgeBranchMrs", &["fetchedAt", "pollIntervalSecs"]),
    ("forgeCachedMrs", &["savedAt", "badges.fetchedAt", "badges.pollIntervalSecs", "list.fetchedAt", "list.pollIntervalSecs"]),
    ("forgeMrDetail", &["fetchedAt", "notModified", "pollIntervalSecs"]),
    ("forgeMrDiscussions", &["fetchedAt", "notModified", "pollIntervalSecs"]),
    ("forgeMrList", &["fetchedAt", "pollIntervalSecs", "rateLimit"]),
];

fn mask_at(v: &mut Value, path: &[&str]) {
    match path {
        [] => {}
        ["[]", rest @ ..] => {
            if let Value::Array(items) = v {
                items.iter_mut().for_each(|x| mask_at(x, rest));
            }
        }
        [key] => {
            if let Some(x) = v.get_mut(*key) {
                *x = json!(UNTIMED);
            }
        }
        [key, rest @ ..] => {
            if let Some(x) = v.get_mut(*key) {
                mask_at(x, rest);
            }
        }
    }
}

/// A forge answer's wall-clock and HTTP fields (`UNTIMED_FIELDS`) as `<untimed>`, so a recording
/// made at another time, or after a different number of requests, gives the same file.
pub fn mask_untimed(method: &str, v: &mut Value) {
    for (_, paths) in UNTIMED_FIELDS.iter().filter(|(m, _)| *m == method) {
        for p in *paths {
            mask_at(v, &p.split('.').collect::<Vec<_>>());
        }
    }
}

/// `ev` repeats `last`: both `refsUpdated` for the same repo.
fn collapses(last: Option<&Value>, ev: &Value) -> bool {
    let refs = |e: &Value| e.get("type").and_then(Value::as_str) == Some("refsUpdated");
    last.is_some_and(|l| refs(l) && refs(ev) && l.get("repo") == ev.get("repo"))
}

/// A user's fetch names the repository by its folder (`fetch <name>`, netops.rs), which is `repo`
/// in a recording and the fixture's name in the demo (as `normalise` makes a `name` follow its
/// `path`): its op's and queue item's labels name the demo's folder.
pub fn rename_fetch_labels(ev: &mut Value, name: &str) {
    let fetch = |x: &Value| x.get("kind").and_then(Value::as_str) == Some("fetch");
    match ev.get("type").and_then(Value::as_str) {
        Some("opStarted") if fetch(ev) && ev.get("label").and_then(Value::as_str) == Some("repo") => ev["label"] = json!(name),
        Some("queueChanged") => {
            let rename = |item: &mut Value| {
                if fetch(item) && item.get("label").and_then(Value::as_str) == Some("fetch repo") {
                    item["label"] = json!(format!("fetch {name}"));
                }
            };
            if let Some(running) = ev.get_mut("running") {
                rename(running);
            }
            if let Some(Value::Array(queued)) = ev.get_mut("queued") {
                queued.iter_mut().for_each(rename);
            }
        }
        _ => {}
    }
}

/// `base64` and `dump` strings over 16 KiB as `sha256:<hex>:<length>`, so committed goldens stay
/// small (ui/src/demo/golden/normalise.ts digests the demo's answers the same way).
pub fn digest_large_strings(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (key, x) in map.iter_mut() {
                let digest = match &*x {
                    Value::String(s) if (key == "base64" || key == "dump") && s.len() > LARGE => {
                        let hex: String = Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                        Some(format!("sha256:{hex}:{}", s.len()))
                    }
                    _ => None,
                };
                match digest {
                    Some(d) => *x = Value::String(d),
                    None => digest_large_strings(x),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(digest_large_strings),
        _ => {}
    }
}

/// `v` with each `{"$rev": spec, "short"?: n}` as the id `rev_parse` gives (its first `n`
/// characters with `short`). Commit ids are the fixture's, so both sides share them.
pub fn resolve_revs(v: &Value, rev_parse: &dyn Fn(&str) -> Result<String, String>) -> Result<Value, String> {
    Ok(match v {
        Value::Object(map) if map.contains_key("$rev") => {
            let spec = map["$rev"].as_str().ok_or("$rev names a revision")?;
            let mut id = rev_parse(spec)?;
            if let Some(n) = map.get("short").and_then(Value::as_u64) {
                id.truncate(n as usize);
            }
            Value::String(id)
        }
        Value::Object(map) => Value::Object(map.iter().map(|(k, x)| Ok((k.clone(), resolve_revs(x, rev_parse)?))).collect::<Result<_, String>>()?),
        Value::Array(items) => Value::Array(items.iter().map(|x| resolve_revs(x, rev_parse)).collect::<Result<_, String>>()?),
        _ => v.clone(),
    })
}

pub fn resolve_hashes(v: &Value, hash: &dyn Fn(&str) -> Result<String, String>) -> Result<Value, String> {
    Ok(match v {
        Value::Object(map) if map.contains_key("$hash") => Value::String(hash(map["$hash"].as_str().ok_or("$hash names a file")?)?),
        Value::Object(map) => Value::Object(map.iter().map(|(k, x)| Ok((k.clone(), resolve_hashes(x, hash)?))).collect::<Result<_, String>>()?),
        Value::Array(items) => Value::Array(items.iter().map(|x| resolve_hashes(x, hash)).collect::<Result<_, String>>()?),
        _ => v.clone(),
    })
}

pub fn resolve_entries(v: &Value, entry: &dyn Fn(&str) -> Result<u64, String>) -> Result<Value, String> {
    Ok(match v {
        Value::Object(map) if map.contains_key("$entry") => Value::from(entry(map["$entry"].as_str().ok_or("$entry names undo, redo or banner")?)?),
        Value::Object(map) => Value::Object(map.iter().map(|(k, x)| Ok((k.clone(), resolve_entries(x, entry)?))).collect::<Result<_, String>>()?),
        Value::Array(items) => Value::Array(items.iter().map(|x| resolve_entries(x, entry)).collect::<Result<_, String>>()?),
        _ => v.clone(),
    })
}

/// `git hash-object --no-filters` of `<root>/<rel>`: the worktree bytes' blob id (`worktree_id`).
fn hash_in(root: &Path) -> impl Fn(&str) -> Result<String, String> + '_ {
    move |rel: &str| {
        let out = std::process::Command::new("git")
            .args(["hash-object", "--no-filters", "--"])
            .arg(root.join(rel))
            .envs(isolated_git_env())
            .output()
            .map_err(|e| format!("git hash-object: {e}"))?;
        if !out.status.success() {
            return Err(format!("git hash-object {rel}: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// `v` for the harness: `"$repo"` as `id`, `"$wt"` as `<root>/repo`, `"$wt:<dir>"` as `<root>/<dir>`.
pub fn substitute(v: &Value, root: &str, id: Option<u64>) -> Value {
    match v {
        Value::String(s) if s == "$repo" => id.map_or(Value::Null, Value::from),
        Value::String(s) if s == "$wt" => Value::String(format!("{root}/repo")),
        Value::String(s) => match s.strip_prefix("$wt:") {
            Some(dir) => Value::String(format!("{root}/{dir}")),
            None => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(|x| substitute(x, root, id)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), substitute(x, root, id))).collect()),
        _ => v.clone(),
    }
}

/// `git rev-parse --verify` in the fixture's worktree, with the tests' isolated git environment.
fn rev_parse_in(worktree: &Path) -> impl Fn(&str) -> Result<String, String> + '_ {
    move |spec: &str| {
        let out = std::process::Command::new("git")
            .args(["rev-parse", "--verify", "--end-of-options", spec])
            .current_dir(worktree)
            .envs(isolated_git_env())
            .output()
            .map_err(|e| format!("git rev-parse: {e}"))?;
        if !out.status.success() {
            return Err(format!("git rev-parse --verify {spec}: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// How long a request's events may keep coming after its answer, and the quiet that ends them.
const SETTLE_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);
/// The 40 ms quiet assumes no watched repo: the watcher's DEBOUNCE is 150 ms, so a scenario that
/// calls watchRepo must wait longer.
const SETTLE_QUIET: std::time::Duration = std::time::Duration::from_millis(40);

/// The events a request emitted: every op it started has finished and its queue is idle again,
/// then a short quiet, so nothing late lands in the next request's list. Bounded by SETTLE_LIMIT.
async fn settle(rx: &mut tokio::sync::broadcast::Receiver<gitvolt_core::events::AppEvent>) -> Result<Vec<gitvolt_core::events::AppEvent>, String> {
    use gitvolt_core::events::AppEvent;
    use tokio::sync::broadcast::error::RecvError;
    let deadline = tokio::time::Instant::now() + SETTLE_LIMIT;
    let mut got = Vec::new();
    let mut open = std::collections::BTreeSet::new();
    let mut busy = std::collections::BTreeSet::new();
    loop {
        let done = open.is_empty() && busy.is_empty();
        let wait = if done { SETTLE_QUIET } else { deadline.saturating_duration_since(tokio::time::Instant::now()) };
        match tokio::time::timeout(wait, rx.recv()).await {
            Ok(Ok(ev)) => {
                match &ev {
                    AppEvent::OpStarted { op, .. } => {
                        open.insert(*op);
                    }
                    AppEvent::OpFinished { op, .. } => {
                        open.remove(op);
                    }
                    AppEvent::QueueChanged { repo, running, queued, .. } => {
                        if running.is_none() && queued.is_empty() {
                            busy.remove(repo);
                        } else {
                            busy.insert(*repo);
                        }
                    }
                    _ => {}
                }
                got.push(ev);
            }
            Ok(Err(RecvError::Lagged(n))) => return Err(format!("{n} events lost while recording")),
            Ok(Err(RecvError::Closed)) => return Ok(got),
            Err(_) if done => return Ok(got),
            Err(_) => return Err(format!("a request's ops didn't finish within {SETTLE_LIMIT:?}: ops {open:?}, busy queues {busy:?}")),
        }
    }
}

/// Each `"$wt:<dir>"` names a folder inside the fixture tree (the write guard checks only the
/// repository's common dir, not where an added worktree goes).
fn check_paths(v: &Value) -> Result<(), String> {
    match v {
        Value::String(s) => match s.strip_prefix("$wt:") {
            Some(dir) if dir.is_empty() || dir.starts_with('/') || dir.split('/').any(|c| c == ".." || c == "." || c.is_empty()) => Err(format!("{s} leaves the fixture tree")),
            _ => Ok(()),
        },
        Value::Array(items) => items.iter().try_for_each(check_paths),
        Value::Object(map) => map.values().try_for_each(check_paths),
        _ => Ok(()),
    }
}

/// The core's answer to each of `requests` on the fixture folder `root` (a fresh harness in golden
/// mode), each with the events it emitted when `events`.
pub async fn record(root: &Path, name: &str, requests: &[Value], events: bool) -> Result<Vec<Value>, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let root_s = root.to_str().ok_or("the fixture folder's path isn't UTF-8")?.to_string();
    let read_pieces = || -> Result<Vec<String>, String> {
        Ok(std::fs::read_dir(&root).map_err(|e| format!("{}: {e}", root.display()))?.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n != FIXTURE_MARKER).collect())
    };
    let mut pieces: Vec<String>;
    let worktree = root.join("repo");
    let rev_parse = rev_parse_in(&worktree);
    // The write guard wants the marked folder strictly below its root: the fixture folder's parent.
    let guard_root = root.parent().ok_or("the fixture folder has no parent")?.to_path_buf();
    let harness = Harness::new(HarnessOptions { fixture_root: Some(guard_root), golden: true, ..Default::default() }).await;
    // Plan 4: a fixture with a forge.json gets its fake GitLab, and the visitor's account on it.
    let forge = crate::forge_seed::load(&root)?;
    if let Some(f) = &forge {
        let mut gitlab = f.gitlab.clone();
        gitlab.tokens.push(crate::fake_forge::FakeToken { token: crate::fake_forge::DEMO_TOKEN.into(), user: crate::forge_seed::me(), scopes: vec!["api".into()], fine_grained: false });
        harness.forge.try_seed(crate::fake_forge::ForgeSeed { gitlab, github: Default::default() })?;
        harness.add_forge_account_for_test(&f.host, gitvolt_core::forge::ForgeKind::GitLab, crate::fake_forge::DEMO_TOKEN).await.map_err(|e| e.message)?;
    }
    // The fake's own address in answers, and the forge's that the demo's answers name instead.
    let web = forge.as_ref().map(|f| (harness.forge.gitlab_web(), format!("https://{}", f.host)));
    let mut rx = harness.api.subscribe();
    let mut id = None;
    let mut out = Vec::new();
    requests.iter().try_for_each(check_paths)?;
    for req in requests {
        let mut resolved = resolve_hashes(&resolve_revs(req, &rev_parse)?, &hash_in(&root))?;
        if resolved.to_string().contains("\"$entry\"") {
            // The journal's ids, read for the request's own worktree.
            let params = substitute(&resolved["params"], &root_s, id);
            let ask = |method: &str| serde_json::from_value::<Request>(json!({ "method": method, "params": { "repo": params["repo"], "worktree": params["worktree"] } })).map_err(|e| e.to_string());
            let state = harness.api.dispatch(ask("journalState")?).await.map_err(|e| e.message)?;
            let history = harness.api.dispatch(ask("journalHistory")?).await.map_err(|e| e.message)?;
            let pick = |which: &str| -> Result<u64, String> {
                let v = match which {
                    "undo" => &state["undo"]["entry"],
                    "redo" => &state["redo"]["entry"],
                    "banner" => &state["banners"][0]["entry"],
                    other => match other.strip_prefix("label:") {
                        Some(label) => history.as_array().and_then(|rows| rows.iter().find(|r| r["label"] == label)).map(|r| &r["entry"]).unwrap_or(&Value::Null),
                        None => return Err(format!("$entry {other}")),
                    },
                };
                v.as_u64().ok_or_else(|| format!("no {which} entry for {req}"))
            };
            resolved = resolve_entries(&resolved, &pick)?;
        }
        let parsed: Request = serde_json::from_value(substitute(&resolved, &root_s, id)).map_err(|e| format!("bad request {req}: {e}"))?;
        let opens = req.get("method").and_then(Value::as_str) == Some("openRepo");
        while rx.try_recv().is_ok() {}
        let result = harness.api.dispatch(parsed).await;
        // A folder the request added (a worktree beside the fixture's) is rewritten like the others.
        pieces = read_pieces()?;
        let mut entry = match result {
            Ok(mut ok) => {
                if opens {
                    id = id.or_else(|| ok.get("id").and_then(Value::as_u64));
                }
                normalise(&mut ok, &root_s, name, &pieces);
                if let Some((from, to)) = &web {
                    rewrite_base(&mut ok, from, to);
                }
                digest_large_strings(&mut ok);
                mask_versions(&mut ok);
                mask_untimed(req.get("method").and_then(Value::as_str).unwrap_or(""), &mut ok);
                json!({ "request": resolved, "response": ok })
            }
            Err(e) => {
                let mut err = serde_json::to_value(e).map_err(|e| e.to_string())?;
                normalise(&mut err, &root_s, name, &pieces);
                if let Some((from, to)) = &web {
                    rewrite_base(&mut err, from, to);
                }
                json!({ "request": resolved, "error": err })
            }
        };
        let mut emitted = Vec::new();
        for ev in settle(&mut rx).await? {
            let mut ev = serde_json::to_value(ev).map_err(|e| e.to_string())?;
            if ev.get("type").and_then(Value::as_str).is_some_and(|t| UNRECORDED.contains(&t)) {
                continue;
            }
            normalise(&mut ev, &root_s, name, &pieces);
            if let Some((from, to)) = &web {
                rewrite_base(&mut ev, from, to);
            }
            mask_versions(&mut ev);
            rename_fetch_labels(&mut ev, name);
            // The core's rebase sends one per progress tick on which HEAD moved (`head_ticker`):
            // how many depends on git's speed, so a run of them for one repo is recorded as one.
            if !collapses(emitted.last(), &ev) {
                emitted.push(ev);
            }
        }
        if events {
            entry["events"] = Value::Array(emitted);
        }
        out.push(entry);
    }
    Ok(out)
}

/// The fake forge's own address (`http://127.0.0.1:<port>/gitlab`) as the forge's: the demo's
/// answers name `https://gitlab.example.com`.
pub fn rewrite_base(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) if s.contains(from) => *s = s.replace(from, to),
        Value::Array(items) => items.iter_mut().for_each(|x| rewrite_base(x, from, to)),
        Value::Object(map) => map.values_mut().for_each(|x| rewrite_base(x, from, to)),
        _ => {}
    }
}

/// Records the requests in `requests_json` (an array) for the fixture `name` into
/// `out_dir/<n>.json`, replacing the `.json` files there.
pub async fn write(requests_json: &Path, name: &str, root: &Path, out_dir: &Path, events: bool) -> Result<(), String> {
    let text = std::fs::read_to_string(requests_json).map_err(|e| format!("{}: {e}", requests_json.display()))?;
    let requests: Vec<Value> = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", requests_json.display()))?;
    let answers = record(root, name, &requests, events).await?;
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(out_dir).map_err(|e| e.to_string())?.flatten() {
        if entry.path().extension().is_some_and(|x| x == "json") {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    for (n, a) in answers.iter().enumerate() {
        std::fs::write(out_dir.join(format!("{n}.json")), serde_json::to_string_pretty(a).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A fresh install's settings and profile, as the core makes them (the demo's defaults test).
pub fn defaults() -> Value {
    json!({ "settings": AppSettings::default(), "profile": Profile::new(DEFAULT_PROFILE_ID, "Default", "#4d88ff") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_resolve_inside_requests() {
        let v = json!({"method": "undo", "params": {"entry": {"$entry": "undo"}}});
        assert_eq!(resolve_entries(&v, &|w: &str| if w == "undo" { Ok(7) } else { Err(w.into()) }).unwrap(), json!({"method": "undo", "params": {"entry": 7}}));
    }

    #[test]
    fn a_folder_beside_the_main_worktree_is_beside_the_demos() {
        let pieces = vec!["repo".to_string(), "wt-hotfix".to_string()];
        assert_eq!(rewrite_paths("/t/f/repo-demo-wt and /t/f/repo/x and /t/f/wt-hotfix", "/t/f", "basic", &pieces), "/demo/basic-demo-wt and /demo/basic/x and /demo/.extra/basic/wt-hotfix");
    }

    #[test]
    fn scenario_paths_stay_in_the_fixture_tree() {
        assert!(check_paths(&json!({"params": {"path": "$wt:wt-demo", "worktree": "$wt"}})).is_ok());
        for bad in ["$wt:../elsewhere", "$wt:/tmp/x", "$wt:", "$wt:a//b", "$wt:a/../../b"] {
            assert!(check_paths(&json!([{"params": {"path": bad}}])).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn settle_waits_for_the_op_and_its_queue() {
        use gitvolt_core::events::{AppEvent, OpOutcome};
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let kind = gitvolt_core::events::OpKind::Commit;
        tx.send(AppEvent::OpStarted { op: 3, kind, repo: Some(1), label: "commit".into(), interactive: true }).unwrap();
        let late = tx.clone();
        let sender = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            late.send(AppEvent::OpFinished { op: 3, kind, repo: Some(1), outcome: OpOutcome::Ok, message: None, command: None }).unwrap();
        });
        let got = settle(&mut rx).await.unwrap();
        sender.await.unwrap();
        assert_eq!(got.len(), 2, "the late opFinished is this request's");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn versions_are_masked_only_where_they_hash_the_worktree_path() {
        let mut answer = json!({"journal": {}, "staging": {}, "outcome": {"version": "kept"}, "wip": {"version": "a1", "staged": {"version": "b2", "files": []}, "unstaged": {"version": "c3"}}});
        mask_versions(&mut answer);
        assert_eq!(answer, json!({"journal": {}, "staging": {}, "outcome": {"version": "kept"}, "wip": {"version": VERSION, "staged": {"version": VERSION, "files": []}, "unstaged": {"version": VERSION}}}));
        // A `wip` outside a write's answer (no journal and staging beside it) is left as it is.
        let mut read = json!({"wip": {"version": "a1"}});
        mask_versions(&mut read);
        assert_eq!(read, json!({"wip": {"version": "a1"}}));
        let mut ev = json!({"type": "repoChanged", "versions": {"/demo/basic": "a1", "/demo/.extra/basic/wt-x": "b2"}, "version": "kept"});
        mask_versions(&mut ev);
        assert_eq!(ev, json!({"type": "repoChanged", "versions": {"/demo/basic": VERSION, "/demo/.extra/basic/wt-x": VERSION}, "version": "kept"}));
        let mut other = json!({"type": "refsUpdated", "versions": {"x": "a1"}});
        mask_versions(&mut other);
        assert_eq!(other, json!({"type": "refsUpdated", "versions": {"x": "a1"}}));
    }

    #[test]
    fn untimed_fields_are_masked_only_where_the_method_has_them() {
        let mut accounts = json!([{"account": {"host": "h", "addedAt": 5, "storage": "file", "versionCheckedAt": 6, "user": {"fetchedAt": 7}}}]);
        mask_untimed("forgeAccounts", &mut accounts);
        assert_eq!(accounts, json!([{"account": {"host": "h", "addedAt": UNTIMED, "storage": UNTIMED, "versionCheckedAt": UNTIMED, "user": {"fetchedAt": 7}}}]));
        let mut cached = json!({"savedAt": 1, "badges": {"fetchedAt": 2, "pollIntervalSecs": null}, "list": null});
        mask_untimed("forgeCachedMrs", &mut cached);
        assert_eq!(cached, json!({"savedAt": UNTIMED, "badges": {"fetchedAt": UNTIMED, "pollIntervalSecs": UNTIMED}, "list": null}));
        let mut other = json!({"fetchedAt": 3});
        mask_untimed("fetch", &mut other);
        assert_eq!(other, json!({"fetchedAt": 3}), "another method's field of that name is kept");
    }

    #[test]
    fn a_run_of_refs_updated_for_one_repo_is_one() {
        let refs = |repo: u32| json!({"type": "refsUpdated", "repo": repo});
        assert!(collapses(Some(&refs(1)), &refs(1)));
        assert!(!collapses(Some(&refs(1)), &refs(2)));
        assert!(!collapses(Some(&json!({"type": "journalChanged", "repo": 1})), &refs(1)));
        assert!(!collapses(None, &refs(1)));
    }

    #[test]
    fn a_fetchs_labels_name_the_demos_folder() {
        let mut started = json!({"type": "opStarted", "op": 1, "kind": "fetch", "repo": 1, "label": "repo", "interactive": true});
        rename_fetch_labels(&mut started, "sync");
        assert_eq!(started["label"], "sync");
        let mut queue = json!({"type": "queueChanged", "repo": 1, "running": {"id": 1, "kind": "fetch", "label": "fetch repo", "op": 1}, "queued": [{"id": 2, "kind": "fetch", "label": "fetch repo", "op": 2}, {"id": 3, "kind": "commit", "label": "fetch repo", "op": 3}], "stopped": null});
        rename_fetch_labels(&mut queue, "sync");
        assert_eq!(queue["running"]["label"], "fetch sync");
        assert_eq!(queue["queued"][0]["label"], "fetch sync");
        assert_eq!(queue["queued"][1]["label"], "fetch repo", "only a fetch's");
        let mut idle = json!({"type": "queueChanged", "repo": 1, "running": null, "queued": [], "stopped": null});
        rename_fetch_labels(&mut idle, "sync");
        assert_eq!(idle["running"], Value::Null);
    }

    #[test]
    fn the_fake_forges_address_is_the_forges() {
        let mut v = json!({"webUrl": "http://127.0.0.1:9/gitlab/orbital/x"});
        rewrite_base(&mut v, "http://127.0.0.1:9/gitlab", "https://gitlab.example.com");
        assert_eq!(v, json!({"webUrl": "https://gitlab.example.com/orbital/x"}));
    }

    #[test]
    fn hashes_resolve_inside_requests() {
        let v = json!({"method": "writeWorktreeFile", "params": {"base": {"$hash": "repo/a.txt"}, "keep": [{"$hash": "repo/b.txt"}]}});
        let got = resolve_hashes(&v, &|p: &str| Ok(format!("hash-of-{p}"))).unwrap();
        assert_eq!(got, json!({"method": "writeWorktreeFile", "params": {"base": "hash-of-repo/a.txt", "keep": ["hash-of-repo/b.txt"]}}));
    }
}
