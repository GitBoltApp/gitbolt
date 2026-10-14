//! `forge.json` v1 and the `forge_lab` fixture (website demo plan 4).

use gitvolt_core::testing::{isolated_git_env, TestRepo};
use gitvolt_harness::forge_seed;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).envs(isolated_git_env()).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim_end().to_string()
}

#[test]
fn forge_lab_has_an_mr_of_every_kind_against_its_origin() {
    let dir = tempfile::tempdir().unwrap();
    let r = TestRepo::init_at(dir.path());
    gitvolt_harness::forge_lab::build(&r);
    let f = forge_seed::read(dir.path()).expect("forge.json");
    assert_eq!((f.version, f.host.as_str(), f.project.as_str(), f.me.as_str()), (1, "gitlab.example.com", "orbital/forge-lab", "you"));
    assert!(f.gitlab.tokens.is_empty(), "no token in a fixture");
    assert_eq!(git(r.path(), &["remote", "get-url", "origin"]), "https://gitlab.example.com/orbital/forge-lab.git");
    let origin = dir.path().join("origin.git");
    let mrs = &f.gitlab.merge_requests;
    let by = |iid: u64| mrs.iter().find(|m| m.iid == iid).unwrap();
    for m in mrs.iter().filter(|m| m.state == "opened") {
        assert_eq!(m.head_sha, git(&origin, &["rev-parse", &format!("refs/heads/{}", m.source_branch)]), "!{}", m.iid);
        assert!(!m.diffs.is_empty() && !m.base_sha.is_empty(), "!{}", m.iid);
    }
    assert_eq!((by(2).title.as_str(), by(3).state.as_str()), ("Draft: Add a radar panel", "merged"));
    assert_eq!(git(r.path(), &["cat-file", "-t", &by(3).merge_commit_sha]), "commit");
    assert_eq!(by(5).target_branch, "feature/stack-a");
    assert_eq!(by(6).source_branch, "feature/ünï-names");
    let note = by(1).discussions.iter().flat_map(|d| &d.notes).find(|n| n.position.is_some()).expect("a diff note");
    let p = note.position.as_ref().unwrap();
    assert_eq!((p.new_path.as_str(), p.new_line), ("src/hud.rs", Some(8)));
    assert!(note.body.contains("```suggestion"));
    gitvolt_harness::fake_forge::gitlab_mrs::check_merge_statuses(mrs).unwrap();
}

#[test]
fn a_diff_is_split_per_file_from_its_first_hunk() {
    let r = TestRepo::new();
    r.write("a.txt", "one\n");
    r.write("b.txt", "bee\n");
    r.git(&["add", "-A"]);
    r.git(&["commit", "-q", "-m", "base"]);
    let base = r.git(&["rev-parse", "HEAD"]);
    r.write("a.txt", "one\ntwo\n");
    r.git(&["mv", "b.txt", "c.txt"]);
    r.git(&["commit", "-q", "-am", "edit"]);
    let d = forge_seed::diffs(r.path(), &base, "HEAD").unwrap();
    assert_eq!(d[0].old_path, "a.txt");
    assert_eq!(d[0].diff, "@@ -1 +1,2 @@\n one\n+two\n");
    assert_eq!((d[1].old_path.as_str(), d[1].new_path.as_str(), d[1].diff.as_str()), ("b.txt", "c.txt", ""));
    assert_eq!(forge_seed::added_line(&d, "a.txt", "two"), Some(2));
}

#[tokio::test]
async fn a_recording_on_forge_lab_answers_from_its_fake_gitlab_and_never_the_network() {
    use serde_json::json;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("forge_lab");
    gitvolt_harness::forge_lab::build(&TestRepo::init_at(&root));
    std::fs::write(root.join(gitvolt_core::testing::FIXTURE_MARKER), "").unwrap();
    let requests = vec![
        json!({ "method": "openRepo", "params": { "path": "$wt" } }),
        json!({ "method": "forgeMrList", "params": { "repo": "$repo", "filter": "all" } }),
        json!({ "method": "forgeMrDetail", "params": { "repo": "$repo", "number": 1 } }),
        json!({ "method": "fetch", "params": { "repo": "$repo", "background": false } }),
    ];
    let out = gitvolt_harness::golden::record(&root, "forge_lab", &requests, true).await.unwrap();
    let text = serde_json::to_string(&out).unwrap();
    assert!(!text.contains("127.0.0.1"), "the fake's address is the forge's: {text}");
    assert!(!text.contains(gitvolt_harness::fake_forge::DEMO_TOKEN), "no token in a recording");
    assert!(text.contains("Scale the HUD with the window"), "{}", out[1]);
    assert!(text.contains("https://gitlab.example.com/orbital/forge-lab"), "{}", out[2]);
    // F13: the origin's forge URL isn't fetched (only local paths are allowed while recording).
    assert!(out[3]["error"].to_string().contains("transport 'https' not allowed"), "{}", out[3]);
}

#[test]
fn a_bad_forge_json_says_whether_it_is_unparsable_or_another_version() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(forge_seed::load(dir.path()), Ok(None));
    std::fs::write(dir.path().join(forge_seed::FORGE_JSON), "{ not json").unwrap();
    assert!(forge_seed::load(dir.path()).unwrap_err().contains("unparsable"));
    std::fs::write(dir.path().join(forge_seed::FORGE_JSON), r#"{ "version": 0, "mergeRequests": [] }"#).unwrap();
    assert!(forge_seed::load(dir.path()).unwrap_err().contains("version 0, expected 1"));
}
