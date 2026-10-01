//! Askpass end to end (spec §5.4): real git, the harness binary as `GIT_ASKPASS`, and the
//! harness's always-401 smart-HTTP route.

use gitbolt_core::api::Api;
use gitbolt_core::error::GbErrorKind;
use gitbolt_core::events::{AppEvent, OpKind};
use gitbolt_core::git::{GitCli, GitInvocation};
use gitbolt_core::log::CommandLog;
use gitbolt_core::testing::isolated_git_env;
use gitbolt_harness::{serve, Harness, HarnessOptions};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

async fn start() -> (SocketAddr, Arc<Api>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let harness = Harness::new(HarnessOptions { askpass_exe: Some(env!("CARGO_BIN_EXE_gitbolt-harness").into()), ..Default::default() }).await;
    let api = harness.api.clone();
    tokio::spawn(serve(listener, harness));
    (addr, api)
}

fn cli() -> GitCli {
    GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env())
}

async fn ls_remote(addr: SocketAddr, api: &Api, op: &gitbolt_core::ops::OpGuard) -> gitbolt_core::error::GbError {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("http://{addr}/test/auth/x.git");
    cli()
        .run(
            GitInvocation::new(dir.path(), ["ls-remote", url.as_str()])
                .timeout(Some(Duration::from_secs(30)))
                .cancel(op.cancel.clone())
                .envs(api.askpass().unwrap().env_for(Some(op.id))),
        )
        .await
        .unwrap_err()
}

#[tokio::test(flavor = "multi_thread")]
async fn interactive_prompts_reach_the_ui_and_answers_reach_git() {
    let (addr, api) = start().await;
    let op = api.ops().begin(OpKind::Fetch, None, true);
    let mut rx = api.subscribe();
    let server = api.askpass().unwrap().clone();
    let answerer = tokio::spawn(async move {
        let mut prompts = Vec::new();
        while prompts.len() < 2 {
            if let Ok(AppEvent::AuthWaiting { prompt, text, secret, .. }) = rx.recv().await {
                server.answer(prompt, Some(if secret { "pw".into() } else { "user".into() })).unwrap();
                prompts.push((text, secret));
            }
        }
        prompts
    });
    let err = ls_remote(addr, &api, &op).await;
    assert_eq!(err.kind, GbErrorKind::AuthFailed, "{err:?}");
    let prompts = tokio::time::timeout(Duration::from_secs(5), answerer).await.unwrap().unwrap();
    assert!(prompts[0].0.starts_with(&format!("Username for 'http://{addr}")), "{prompts:?}");
    assert!(!prompts[0].1);
    assert!(prompts[1].0.starts_with("Password for"), "{prompts:?}");
    assert!(prompts[1].1);
}

#[tokio::test(flavor = "multi_thread")]
async fn background_ops_never_prompt() {
    let (addr, api) = start().await;
    let op = api.ops().begin(OpKind::Fetch, Some(1), false);
    let mut rx = api.subscribe();
    let err = ls_remote(addr, &api, &op).await;
    assert_eq!(err.kind, GbErrorKind::AuthFailed, "{err:?}");
    assert!(op.auth_denied());
    while let Ok(ev) = rx.try_recv() {
        assert!(!matches!(ev, AppEvent::AuthWaiting { .. }), "unexpected prompt: {ev:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_while_waiting_kills_git() {
    let (addr, api) = start().await;
    let op = api.ops().begin(OpKind::Fetch, None, true);
    let mut rx = api.subscribe();
    let (ops, id) = (api.ops().clone(), op.id);
    let resolved = tokio::spawn(async move {
        loop {
            match rx.recv().await.unwrap() {
                AppEvent::AuthWaiting { .. } => {
                    ops.cancel(id);
                }
                AppEvent::AuthResolved { .. } => return true,
                _ => {}
            }
        }
    });
    let err = ls_remote(addr, &api, &op).await;
    assert_eq!(err.kind, GbErrorKind::Cancelled, "{err:?}");
    assert!(tokio::time::timeout(Duration::from_secs(5), resolved).await.unwrap().unwrap());
}

async fn open_repo_with_auth_remote(addr: SocketAddr, api: &Api) -> (gitbolt_core::testing::TestRepo, serde_json::Value) {
    let r = gitbolt_core::testing::TestRepo::new();
    r.commit("a");
    r.git(&["remote", "add", "origin", &format!("http://{addr}/test/auth/x.git")]);
    let opened = api.dispatch(serde_json::from_value(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).unwrap()).await.unwrap();
    let id = opened["id"].clone();
    (r, id)
}

#[tokio::test(flavor = "multi_thread")]
async fn background_fetch_needing_auth_is_skipped() {
    let (addr, api) = start().await;
    let (_r, id) = open_repo_with_auth_remote(addr, &api).await;
    let mut rx = api.subscribe();
    let out = api.dispatch(serde_json::from_value(serde_json::json!({"method": "fetch", "params": {"repo": id, "background": true}})).unwrap()).await.unwrap();
    assert_eq!(out, serde_json::json!({"status": "skipped", "reason": "authRequired"}));
    let mut finished = false;
    while let Ok(ev) = rx.try_recv() {
        assert!(!matches!(ev, AppEvent::AuthWaiting { .. }), "a background fetch must never prompt");
        finished |= matches!(ev, AppEvent::OpFinished { outcome: gitbolt_core::events::OpOutcome::Skipped, .. });
    }
    assert!(finished, "the op finishes as skipped");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_user_fetch_at_its_prompt_cancels_it() {
    let (addr, api) = start().await;
    let (_r, id) = open_repo_with_auth_remote(addr, &api).await;
    let mut rx = api.subscribe();
    let canceller = api.clone();
    let events = tokio::spawn(async move {
        let mut seen = Vec::new();
        loop {
            let ev = rx.recv().await.unwrap();
            if let AppEvent::AuthWaiting { op, .. } = &ev {
                canceller.dispatch(serde_json::from_value(serde_json::json!({"method": "cancelOp", "params": {"op": op}})).unwrap()).await.unwrap();
            }
            let done = matches!(ev, AppEvent::OpFinished { .. });
            seen.push(ev);
            if done {
                return seen;
            }
        }
    });
    let err = api.dispatch(serde_json::from_value(serde_json::json!({"method": "fetch", "params": {"repo": id, "background": false}})).unwrap()).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::Cancelled, "{err:?}");
    let seen = tokio::time::timeout(Duration::from_secs(5), events).await.unwrap().unwrap();
    assert!(seen.iter().any(|e| matches!(e, AppEvent::AuthResolved { .. })), "the modal closes: {seen:?}");
    assert!(matches!(seen.last(), Some(AppEvent::OpFinished { outcome: gitbolt_core::events::OpOutcome::Cancelled, .. })), "{seen:?}");
}

/// Cancelling a clone at its credential prompt kills git and removes the folders it created.
#[tokio::test(flavor = "multi_thread")]
async fn a_clone_cancelled_at_its_prompt_leaves_nothing_behind() {
    let (addr, api) = start().await;
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("created").join("deeper").join("clone");
    let mut rx = api.subscribe();
    let canceller = api.clone();
    let events = tokio::spawn(async move {
        loop {
            match rx.recv().await.unwrap() {
                AppEvent::AuthWaiting { op, .. } => {
                    canceller.dispatch(serde_json::from_value(serde_json::json!({"method": "cancelOp", "params": {"op": op}})).unwrap()).await.unwrap();
                }
                AppEvent::OpFinished { outcome, .. } => return outcome,
                _ => {}
            }
        }
    });
    let req = serde_json::json!({"method": "clone", "params": {"url": format!("http://{addr}/test/auth/x.git"), "dest": dest}});
    let err = api.dispatch(serde_json::from_value(req).unwrap()).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::Cancelled, "{err:?}");
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), events).await.unwrap().unwrap(), gitbolt_core::events::OpOutcome::Cancelled);
    assert!(!tmp.path().join("created").exists(), "every folder the clone made is gone");
    assert!(tmp.path().is_dir());
}

/// K96: an ssh key passphrase reaches the modal (`authWaiting`, secret) even with no display
/// (`SSH_ASKPASS_REQUIRE=force`), through the real askpass binary, and the right answer lets the
/// fetch through. `scripts/fake-ssh` asks the way OpenSSH decides, then serves the bare origin.
#[tokio::test(flavor = "multi_thread")]
async fn an_ssh_passphrase_prompt_reaches_the_modal_without_a_display() {
    // No display at all: DISPLAY and WAYLAND_DISPLAY unset (not just empty), after everything else.
    let no_display: gitbolt_core::git::CommandHook = Arc::new(|c| {
        c.env_remove("DISPLAY").env_remove("WAYLAND_DISPLAY");
    });
    let api = Arc::new(Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()).with_command_hook(no_display), None));
    let runtime = tempfile::tempdir().unwrap();
    api.start_askpass(runtime.path(), env!("CARGO_BIN_EXE_gitbolt-harness").into()).await.unwrap();
    let r = gitbolt_core::testing::TestRepo::new();
    gitbolt_core::testing::fixtures::basic(&r);
    let origin = r.root().join("origin.git");
    r.git(&["remote", "set-url", "origin", &format!("ssh://fake{}", origin.display())]);
    r.git(&["config", "core.sshCommand", &format!("{}/../../scripts/fake-ssh --passphrase testpass", env!("CARGO_MANIFEST_DIR"))]);
    r.git(&["config", "ssh.variant", "simple"]);
    r.git_in(&origin, &["branch", "over-ssh", "main"]);
    let opened = api.dispatch(serde_json::from_value(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}})).unwrap()).await.unwrap();
    let mut rx = api.subscribe();
    let server = api.askpass().unwrap().clone();
    let asked = tokio::spawn(async move {
        loop {
            if let AppEvent::AuthWaiting { prompt, text, secret, .. } = rx.recv().await.unwrap() {
                server.answer(prompt, Some("testpass".into())).unwrap();
                return (text, secret);
            }
        }
    });
    let out = api.dispatch(serde_json::from_value(serde_json::json!({"method": "fetch", "params": {"repo": opened["id"], "background": false}})).unwrap()).await.unwrap();
    assert_eq!(out, serde_json::json!({"status": "done", "changed": true}));
    let (text, secret) = tokio::time::timeout(Duration::from_secs(5), asked).await.unwrap().unwrap();
    assert!(text.starts_with("Enter passphrase for key"), "{text}");
    assert!(secret);
    assert!(r.try_git(&["rev-parse", "--verify", "refs/remotes/origin/over-ssh"]).is_ok());
}

/// The user dismissing the credential modal cancels the fetch; it isn't a failure.
#[tokio::test(flavor = "multi_thread")]
async fn a_fetch_whose_prompt_the_user_cancels_reports_cancelled() {
    let (addr, api) = start().await;
    let (_r, id) = open_repo_with_auth_remote(addr, &api).await;
    let mut rx = api.subscribe();
    let server = api.askpass().unwrap().clone();
    let events = tokio::spawn(async move {
        loop {
            match rx.recv().await.unwrap() {
                AppEvent::AuthWaiting { prompt, .. } => server.answer(prompt, None).unwrap(),
                AppEvent::OpFinished { outcome, .. } => return outcome,
                _ => {}
            }
        }
    });
    let err = api.dispatch(serde_json::from_value(serde_json::json!({"method": "fetch", "params": {"repo": id, "background": false}})).unwrap()).await.unwrap_err();
    assert_eq!(err.kind, GbErrorKind::Cancelled, "{err:?}");
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), events).await.unwrap().unwrap(), gitbolt_core::events::OpOutcome::Cancelled);
}

/// `Harness::for_tests()` needs no `askpass_exe`: git runs the harness binary, not the test's.
#[tokio::test(flavor = "multi_thread")]
async fn for_tests_prompts_through_the_harness_binary() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let harness = Harness::for_tests().await;
    let api = harness.api.clone();
    tokio::spawn(serve(listener, harness));
    let env = api.askpass().unwrap().env_for(None);
    let exe = &env.iter().find(|(k, _)| k == "GIT_ASKPASS").unwrap().1;
    assert_eq!(std::path::Path::new(exe).file_name().unwrap(), "gitbolt-harness", "{exe:?}");
    let op = api.ops().begin(OpKind::Fetch, None, true);
    let mut rx = api.subscribe();
    let server = api.askpass().unwrap().clone();
    let answerer = tokio::spawn(async move {
        loop {
            if let Ok(AppEvent::AuthWaiting { prompt, .. }) = rx.recv().await {
                server.answer(prompt, None).unwrap();
                return true;
            }
        }
    });
    ls_remote(addr, &api, &op).await;
    assert!(tokio::time::timeout(Duration::from_secs(5), answerer).await.unwrap().unwrap(), "the prompt reached the UI");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_auth_route_always_answers_401_with_a_basic_challenge() {
    let (addr, _api) = start().await;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(b"GET /test/auth/x.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: h\r\nAuthorization: Basic dTpw\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 401"), "{out}");
    assert!(out.to_ascii_lowercase().contains("www-authenticate: basic realm=\"gitbolt-test\""), "{out}");
}
