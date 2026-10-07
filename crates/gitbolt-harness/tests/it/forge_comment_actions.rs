//! Comment reactions, edits and deletes through the harness's `Api`: real providers, the fake
//! forge. Only a comment's author edits or deletes it; anyone reacts.

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_core::testing::TestRepo;
use gitbolt_harness::fake_forge::*;
use gitbolt_harness::Harness;
use serde_json::{json, Value};

async fn call(api: &Api, v: Value) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(v).unwrap();
    Box::pin(api.dispatch(req)).await
}

async fn open_on(h: &Harness, host: &str, kind: &str, token: &str, url: &str) -> (u64, TestRepo) {
    call(&h.api, json!({"method": "addForgeAccount", "params": {"host": host, "kind": kind, "token": token}})).await.unwrap();
    let r = TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", url]);
    let id = call(&h.api, json!({"method": "openRepo", "params": {"path": r.path()}})).await.unwrap()["id"].as_u64().unwrap();
    (id, r)
}

fn pills(v: &Value) -> Vec<(String, u64, bool)> {
    v.as_array().unwrap().iter().map(|r| (r["name"].as_str().unwrap().to_string(), r["count"].as_u64().unwrap(), r["mine"].as_bool().unwrap())).collect()
}

fn note_in<'a>(threads: &'a Value, id: &str) -> Option<&'a Value> {
    threads["value"].as_array().unwrap().iter().flat_map(|d| d["notes"].as_array().unwrap()).find(|n| n["id"] == id)
}

#[tokio::test(flavor = "multi_thread")]
async fn gitlab_notes_get_award_emoji_and_their_authors_edit_and_delete_them() {
    let h = Harness::for_tests().await;
    let (id, _repo) = open_on(&h, GITLAB_HOST, "gitlab", GITLAB_TOKEN, "https://gitlab.example.com/group/project.git").await;
    let grace = json!({"discussion": "d1", "note": "101"});

    let after = call(&h.api, json!({"method": "forgeReact", "params": {"repo": id, "number": 12, "note": grace, "name": "thumbsup", "on": true}})).await.unwrap();
    assert_eq!(pills(&after), [("thumbsup".to_string(), 1, true)]);
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 12}})).await.unwrap();
    let n = note_in(&threads, "101").unwrap();
    assert_eq!((pills(&n["reactions"]), n["reactions"][0]["users"].clone()), (vec![("thumbsup".to_string(), 1, true)], json!(["Ada Lovelace"])), "read back with GraphQL, who and mine");
    assert!(note_in(&threads, "102").unwrap().get("reactions").is_none());
    let after = call(&h.api, json!({"method": "forgeReact", "params": {"repo": id, "number": 12, "note": grace, "name": "thumbsup", "on": false}})).await.unwrap();
    assert_eq!(after, json!([]));

    // Someone else's note: the forge refuses an edit.
    let e = call(&h.api, json!({"method": "forgeEditNote", "params": {"repo": id, "number": 12, "note": grace, "body": "Mine now"}})).await.unwrap_err();
    assert!(e.message.contains("403") || e.message.to_lowercase().contains("refused"), "{}", e.message);

    let mine = call(&h.api, json!({"method": "forgeReply", "params": {"repo": id, "number": 12, "discussion": null, "body": "Typo hree"}})).await.unwrap();
    let note = json!({"discussion": format!("d{}", mine["id"].as_str().unwrap()), "note": mine["id"]});
    let edited = call(&h.api, json!({"method": "forgeEditNote", "params": {"repo": id, "number": 12, "note": note, "body": "Typo here"}})).await.unwrap();
    assert_eq!(edited["body"], "Typo here");
    call(&h.api, json!({"method": "forgeDeleteNote", "params": {"repo": id, "number": 12, "note": note}})).await.unwrap();
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert!(note_in(&threads, mine["id"].as_str().unwrap()).is_none());
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITLAB_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_gitlab_without_note_awards_still_reads_its_discussions() {
    let h = Harness::for_tests().await;
    let mut seed = h.forge.current_seed();
    seed.gitlab.old_graphql = true;
    seed.gitlab.merge_requests.iter_mut().find(|m| m.iid == 12).unwrap().discussions[0].notes[0].awards.push(gitlab_mrs::FakeAward { id: 1, name: "tada".into(), user: "grace".into() });
    h.forge.seed(seed);
    let (id, _repo) = open_on(&h, GITLAB_HOST, "gitlab", GITLAB_TOKEN, "https://gitlab.example.com/group/project.git").await;
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!(threads["value"].as_array().unwrap().len(), 3);
    assert!(note_in(&threads, "101").unwrap().get("reactions").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn github_comments_get_reactions_and_their_authors_edit_and_delete_them() {
    let h = Harness::for_tests().await;
    let (id, _repo) = open_on(&h, GITHUB_HOST, "github", GITHUB_TOKEN, "https://github.com/octo-org/widget.git").await;
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 3}})).await.unwrap();
    let n = note_in(&threads, "41").unwrap();
    assert_eq!((pills(&n["reactions"]), n["reactions"][0]["users"].clone()), (vec![("heart".to_string(), 1, false)], json!(["hubot"])));
    assert!(n["webUrl"].as_str().unwrap().ends_with("/octo-org/widget/pull/3#issuecomment-41"), "{}", n["webUrl"]);
    assert!(note_in(&threads, "51").unwrap()["webUrl"].as_str().unwrap().ends_with("#discussion_r51"));

    let monalisa = json!({"discussion": "issue-41", "note": "41"});
    let after = call(&h.api, json!({"method": "forgeReact", "params": {"repo": id, "number": 3, "note": monalisa, "name": "+1", "on": true}})).await.unwrap();
    assert_eq!(pills(&after), [("+1".to_string(), 1, true), ("heart".to_string(), 1, false)]);
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!(pills(&note_in(&threads, "41").unwrap()["reactions"]), [("+1".to_string(), 1, true), ("heart".to_string(), 1, false)]);
    let review_reply = json!({"discussion": "thread-51", "note": "52"});
    let after = call(&h.api, json!({"method": "forgeReact", "params": {"repo": id, "number": 3, "note": review_reply, "name": "eyes", "on": true}})).await.unwrap();
    assert_eq!(pills(&after), [("eyes".to_string(), 1, true)]);

    assert!(call(&h.api, json!({"method": "forgeDeleteNote", "params": {"repo": id, "number": 3, "note": monalisa}})).await.is_err(), "someone else's");
    let mine = call(&h.api, json!({"method": "forgeReply", "params": {"repo": id, "number": 3, "discussion": null, "body": "Typo hree"}})).await.unwrap();
    let note = json!({"discussion": format!("issue-{}", mine["id"].as_str().unwrap()), "note": mine["id"]});
    assert_eq!(call(&h.api, json!({"method": "forgeEditNote", "params": {"repo": id, "number": 3, "note": note, "body": "Typo here"}})).await.unwrap()["body"], "Typo here");
    call(&h.api, json!({"method": "forgeDeleteNote", "params": {"repo": id, "number": 3, "note": note}})).await.unwrap();
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert!(note_in(&threads, mine["id"].as_str().unwrap()).is_none());
    assert!(!serde_json::to_string(&h.forge.requests()).unwrap().contains(GITHUB_TOKEN));
}

fn thread<'a>(threads: &'a Value, id: &str) -> &'a Value {
    threads["value"].as_array().unwrap().iter().find(|d| d["id"] == id).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn threads_resolve_and_unresolve_on_both_forges_and_say_by_whom() {
    let h = Harness::for_tests().await;
    let (id, _repo) = open_on(&h, GITLAB_HOST, "gitlab", GITLAB_TOKEN, "https://gitlab.example.com/group/project.git").await;
    let state = call(&h.api, json!({"method": "forgeResolve", "params": {"repo": id, "number": 12, "discussion": "d2", "resolved": true}})).await.unwrap();
    assert_eq!(state, json!({"resolved": true, "resolvedBy": "Ada Lovelace"}));
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 12}})).await.unwrap();
    assert_eq!((thread(&threads, "d2")["resolved"].clone(), thread(&threads, "d2")["resolvedBy"].clone()), (json!(true), json!("Ada Lovelace")));
    call(&h.api, json!({"method": "forgeResolve", "params": {"repo": id, "number": 12, "discussion": "d2", "resolved": false}})).await.unwrap();
    assert!(call(&h.api, json!({"method": "forgeResolve", "params": {"repo": id, "number": 12, "discussion": "d1", "resolved": true}})).await.is_err(), "not resolvable");

    let h = Harness::for_tests().await;
    let (id, _repo) = open_on(&h, GITHUB_HOST, "github", GITHUB_TOKEN, "https://github.com/octo-org/widget.git").await;
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!((thread(&threads, "thread-51")["resolvable"].clone(), thread(&threads, "thread-51")["resolved"].clone()), (json!(true), json!(false)));
    assert_eq!(thread(&threads, "issue-41")["resolvable"], json!(false));
    let state = call(&h.api, json!({"method": "forgeResolve", "params": {"repo": id, "number": 3, "discussion": "thread-51", "resolved": true}})).await.unwrap();
    assert_eq!(state, json!({"resolved": true, "resolvedBy": "octocat"}));
    let threads = call(&h.api, json!({"method": "forgeMrDiscussions", "params": {"repo": id, "number": 3}})).await.unwrap();
    assert_eq!(thread(&threads, "thread-51")["resolvedBy"], "octocat");
}
