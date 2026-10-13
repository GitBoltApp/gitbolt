//! Golden payloads for the website demo's parity suite (`just demo-golden`): the real core's
//! answers to a list of requests on a fixture, with the fixture's paths rewritten to where the
//! demo keeps its copy (`/demo/<name>`; ui/scripts/pack-demo.mjs), so the demo's answers on the
//! same fixture's bundle compare as they are.

use crate::{Harness, HarnessOptions};
use gitbolt_core::api::Request;
use gitbolt_core::settings::{AppSettings, Profile, DEFAULT_PROFILE_ID};
use gitbolt_core::testing::{isolated_git_env, FIXTURE_MARKER};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

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

/// The core's answer to each of `requests` on the fixture folder `root` (a fresh harness).
pub async fn record(root: &Path, name: &str, requests: &[Value]) -> Result<Vec<Value>, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let root_s = root.to_str().ok_or("the fixture folder's path isn't UTF-8")?.to_string();
    let pieces: Vec<String> = std::fs::read_dir(&root).map_err(|e| format!("{}: {e}", root.display()))?.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n != FIXTURE_MARKER).collect();
    let worktree = root.join("repo");
    let rev_parse = rev_parse_in(&worktree);
    let harness = Harness::new(HarnessOptions { fixture_root: Some(root.clone()), ..Default::default() }).await;
    let mut id = None;
    let mut out = Vec::new();
    for req in requests {
        let resolved = resolve_revs(req, &rev_parse)?;
        let parsed: Request = serde_json::from_value(substitute(&resolved, &root_s, id)).map_err(|e| format!("bad request {req}: {e}"))?;
        let opens = req.get("method").and_then(Value::as_str) == Some("openRepo");
        out.push(match harness.api.dispatch(parsed).await {
            Ok(mut ok) => {
                if opens {
                    id = id.or_else(|| ok.get("id").and_then(Value::as_u64));
                }
                normalise(&mut ok, &root_s, name, &pieces);
                digest_large_strings(&mut ok);
                json!({ "request": resolved, "response": ok })
            }
            Err(e) => {
                let mut err = serde_json::to_value(e).map_err(|e| e.to_string())?;
                normalise(&mut err, &root_s, name, &pieces);
                json!({ "request": resolved, "error": err })
            }
        });
    }
    Ok(out)
}

/// Records the requests in `requests_json` (an array) for the fixture `name` into
/// `out_dir/<n>.json`, replacing the `.json` files there.
pub async fn write(requests_json: &Path, name: &str, root: &Path, out_dir: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(requests_json).map_err(|e| format!("{}: {e}", requests_json.display()))?;
    let requests: Vec<Value> = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", requests_json.display()))?;
    let answers = record(root, name, &requests).await?;
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
