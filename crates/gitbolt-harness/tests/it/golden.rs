//! `gitbolt-harness golden`: the core's answers with the fixture's paths as the demo spells them.

use gitbolt_core::testing::{fixtures, TestRepo};
use gitbolt_harness::golden::{digest_large_strings, normalise, record, resolve_revs, rewrite_paths, substitute};
use serde_json::json;

#[test]
fn rewrites_whole_pieces_only() {
    let pieces = vec!["repo".to_string(), "origin.git".to_string(), "wt-hotfix".to_string()];
    assert_eq!(rewrite_paths("wip:/f/repo", "/f", "basic", &pieces), "wip:/demo/basic");
    assert_eq!(rewrite_paths("/f/origin.git and /f/wt-hotfix/x", "/f", "basic", &pieces), "/demo/.origins/basic.git and /demo/.extra/basic/wt-hotfix/x");
    assert_eq!(rewrite_paths("/f/repository", "/f", "basic", &pieces), "/f/repository");
}

#[test]
fn a_name_that_was_its_paths_folder_follows_the_path() {
    let pieces = vec!["repo".to_string()];
    let mut v = json!({ "path": "/f/repo", "name": "repo", "items": [{ "path": "/f/repo", "name": "main" }], "/f/repo": 1 });
    normalise(&mut v, "/f", "basic", &pieces);
    assert_eq!(v, json!({ "path": "/demo/basic", "name": "basic", "items": [{ "path": "/demo/basic", "name": "main" }], "/demo/basic": 1 }));
}

#[test]
fn placeholders_resolve() {
    let req = json!({ "method": "x", "params": { "repo": "$repo", "worktree": "$wt", "other": "$wt:wt-hotfix", "id": { "$rev": "HEAD", "short": 4 }, "ids": [{ "$rev": "main" }] } });
    let revs = resolve_revs(&req, &|spec: &str| Ok(if spec == "HEAD" { "abcdef0123".to_string() } else { "f00d".to_string() })).unwrap();
    assert_eq!(revs, json!({ "method": "x", "params": { "repo": "$repo", "worktree": "$wt", "other": "$wt:wt-hotfix", "id": "abcd", "ids": ["f00d"] } }));
    assert_eq!(substitute(&revs, "/f", Some(3)), json!({ "method": "x", "params": { "repo": 3, "worktree": "/f/repo", "other": "/f/wt-hotfix", "id": "abcd", "ids": ["f00d"] } }));
    assert!(resolve_revs(&json!({ "$rev": "nope" }), &|spec: &str| Err(format!("no {spec}"))).is_err());
}

#[test]
fn large_base64_and_dumps_are_digested() {
    let mut big = json!({ "new": { "base64": "A".repeat(20_000), "text": "B".repeat(20_000) }, "dump": "small" });
    digest_large_strings(&mut big);
    let digested = big["new"]["base64"].as_str().unwrap();
    assert!(digested.starts_with("sha256:") && digested.ends_with(":20000") && digested.len() == "sha256:".len() + 64 + ":20000".len());
    assert_eq!(big["new"]["text"].as_str().unwrap().len(), 20_000);
    assert_eq!(big["dump"], "small");
}

#[tokio::test]
async fn records_the_cores_answers_with_the_demos_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("basic");
    fixtures::basic(&TestRepo::init_at(&root));
    let requests = vec![
        json!({ "method": "openRepo", "params": { "path": "$wt" } }),
        json!({ "method": "graph", "params": { "repo": "$repo", "limit": null } }),
        json!({ "method": "commitMessage", "params": { "repo": "$repo", "id": { "$rev": "main" } } }),
    ];
    let out = record(&root, "basic", &requests).await.unwrap();
    let text = serde_json::to_string(&out).unwrap();
    let canon = std::fs::canonicalize(&root).unwrap();
    assert!(!text.contains(canon.to_str().unwrap()), "no fixture path is left: {text}");
    assert_eq!(out[0]["request"], requests[0], "placeholders other than $rev are kept as written");
    assert_eq!((out[0]["response"]["path"].as_str(), out[0]["response"]["name"].as_str()), (Some("/demo/basic"), Some("basic")));
    assert!(out[1]["response"]["rows"].as_array().unwrap().iter().any(|r| r["id"] == "wip:/demo/basic"));
    assert!(text.contains("/demo/.extra/basic/wt-hotfix"));
    let main = out[2]["request"]["params"]["id"].as_str().unwrap();
    assert_eq!(main.len(), 40, "$rev resolved to the full id");
    assert_eq!(out[2]["response"]["id"], main);
}
