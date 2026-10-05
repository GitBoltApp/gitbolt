//! Measures the details panel's backend requests on a real repository (not run by default):
//! `commitDetails`, `signature` and `avatar` for the committers and co-authors, with forge avatars
//! on (a GitHub account on the fake forge) and off, and Gravatar on a local server that answers
//! after `GITBOLT_LATENCY_NET_MS` (default 150 ms), like a real avatar host. No real host is ever
//! contacted, and gpg runs in an empty temporary home (never the user's keyring).
//!
//! `GITBOLT_LATENCY_REPO=/path/to/clone cargo test -p gitbolt-harness --test it details_latency:: -- --ignored --nocapture`

use gitbolt_core::api::{Api, Request};
use gitbolt_core::avatar::AvatarProvider;
use gitbolt_core::git::GitCli;
use gitbolt_core::log::CommandLog;
use gitbolt_core::settings::SettingsStore;
use gitbolt_core::testing::isolated_git_env;
use gitbolt_forge::connector::{Forge, ForgeConfig};
use gitbolt_forge::endpoints::HostEndpoints;
use gitbolt_forge::gravatar::Gravatar;
use gitbolt_forge::tokens::FileTokenStore;
use gitbolt_harness::fake_forge::*;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

async fn call(api: &Api, v: Value) -> Value {
    let req: Request = serde_json::from_value(v.clone()).unwrap();
    Box::pin(api.dispatch(req)).await.unwrap_or_else(|e| panic!("{v}: {e:?}"))
}

async fn timed(api: &Api, v: Value) -> (Duration, Value) {
    let t = Instant::now();
    let out = call(api, v).await;
    (t.elapsed(), out)
}

/// A Gravatar stand-in: every request waits `delay`, then answers 404 (no avatar). Counts hits.
fn slow_gravatar(delay: Duration) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/avatar", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let counter = counter.clone();
            std::thread::spawn(move || {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(delay);
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            });
        }
    });
    (base, hits)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn stats(name: &str, mut v: Vec<Duration>) {
    if v.is_empty() {
        return;
    }
    v.sort();
    let p = |q: f64| ms(v[((v.len() - 1) as f64 * q).round() as usize]);
    println!("{name:<44} n={:<5} median={:>7.2}ms p95={:>7.2}ms max={:>7.2}ms", v.len(), p(0.5), p(0.95), p(1.0));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a measurement: set GITBOLT_LATENCY_REPO"]
async fn details_latency() {
    let Ok(repo) = std::env::var("GITBOLT_LATENCY_REPO") else {
        eprintln!("GITBOLT_LATENCY_REPO not set; skipping");
        return;
    };
    let commits: usize = std::env::var("GITBOLT_LATENCY_COMMITS").ok().and_then(|n| n.parse().ok()).unwrap_or(300);
    let net = Duration::from_millis(std::env::var("GITBOLT_LATENCY_NET_MS").ok().and_then(|n| n.parse().ok()).unwrap_or(150));
    let tmp = tempfile::tempdir().unwrap();
    let gnupg = tmp.path().join("gnupg");
    std::fs::create_dir_all(&gnupg).unwrap();
    std::fs::set_permissions(&gnupg, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let mut env = isolated_git_env();
    env.push(("GNUPGHOME".into(), gnupg.clone().into()));

    let forge = FakeForge::start().await;
    let overrides = std::collections::HashMap::from([(GITHUB_HOST.to_string(), HostEndpoints { api: forge.github_api(), web: forge.github_web(), avatars: Some(forge.github_avatars()) })]);
    let connector = Arc::new(Forge::new(ForgeConfig { overrides, only_overrides: true, avatar_dir: Some(tmp.path().join("forge-avatars")) }));
    let (gravatar_base, gravatar_hits) = slow_gravatar(net);
    let gravatar: Arc<dyn AvatarProvider> = Arc::new(Gravatar::new(tmp.path().join("avatars"), gravatar_base));
    let log = Arc::new(CommandLog::new(100_000));
    let api = Api::new(GitCli::new(log.clone()).with_env(env), None)
        .with_data_dir(tmp.path().join("data"))
        .with_store(SettingsStore::open(tmp.path().join("config")))
        .with_avatars(gravatar)
        .with_forge(connector, Arc::new(FileTokenStore::new(tmp.path().join("tokens"))));
    let id = call(&api, json!({"method": "openRepo", "params": {"path": repo}})).await["id"].as_u64().unwrap();

    let out = std::process::Command::new("git").args(["-C", &repo, "rev-list", "--all", "-n", &commits.to_string()]).env("GIT_OPTIONAL_LOCKS", "0").output().unwrap();
    let ids: Vec<String> = String::from_utf8(out.stdout).unwrap().lines().map(str::to_string).collect();
    println!("\n== {} commits of {repo}; avatar network latency {} ms", ids.len(), net.as_millis());

    let mut details = Vec::new();
    let (mut first, mut slowest) = (Vec::new(), (Duration::ZERO, String::new()));
    for c in &ids {
        let (t, d) = timed(&api, json!({"method": "commitDetails", "params": {"repo": id, "id": c}})).await;
        if t > slowest.0 {
            slowest = (t, c.clone());
        }
        first.push(t);
        details.push(d);
    }
    stats("commitDetails", first);
    println!("  slowest: {} ({:.2} ms)", &slowest.1[..10], ms(slowest.0));

    // signature: first and second ask, and git spawns per ask.
    let signed: Vec<&Value> = details.iter().filter(|d| d["signed"] == true).collect();
    let (mut sig1, mut sig2, mut kinds) = (Vec::new(), Vec::new(), std::collections::BTreeMap::<String, usize>::new());
    let before = log.entries().len();
    for d in signed.iter().take(100) {
        let (t, s) = timed(&api, json!({"method": "signature", "params": {"repo": id, "id": d["id"]}})).await;
        sig1.push(t);
        *kinds.entry(s["kind"].as_str().unwrap().to_string()).or_default() += 1;
    }
    let spawned1 = log.entries().len() - before;
    let before = log.entries().len();
    for d in signed.iter().take(100) {
        sig2.push(timed(&api, json!({"method": "signature", "params": {"repo": id, "id": d["id"]}})).await.0);
    }
    let spawned2 = log.entries().len() - before;
    println!("signed commits: {} of {}; verdicts (first 100): {kinds:?}", signed.len(), details.len());
    stats("signature, first ask", sig1);
    stats("signature, second ask", sig2);
    println!("  git spawns: first pass {spawned1}, second pass {spawned2}");

    // The people the graph doesn't draw: committers that differ from the author, and co-authors.
    let mut people: Vec<String> = Vec::new();
    for d in &details {
        if d["committer"]["email"] != d["author"]["email"] {
            people.push(d["committer"]["email"].as_str().unwrap().to_string());
        }
        for c in d["coAuthors"].as_array().unwrap() {
            people.push(c["email"].as_str().unwrap().to_string());
        }
    }
    let mut uniq = people.clone();
    uniq.sort();
    uniq.dedup();
    let noreply = uniq.iter().filter(|e| e.ends_with("noreply.github.com") || *e == "noreply@github.com").count();
    println!("details-only people: {} asks, {} distinct emails ({} GitHub noreply forms)", people.len(), uniq.len(), noreply);

    for forge_on in [false, true] {
        if forge_on {
            call(&api, json!({"method": "addForgeAccount", "params": {"host": "github.com", "kind": "github", "token": GITHUB_TOKEN}})).await;
        }
        let label = if forge_on { "forge avatars on (GitHub account)" } else { "no forge account" };
        let hits0 = gravatar_hits.load(Ordering::SeqCst);
        let forge0 = forge.requests().len();
        let (mut cold, mut warm) = (Vec::new(), Vec::new());
        for e in &uniq {
            cold.push(timed(&api, json!({"method": "avatar", "params": {"email": e}})).await.0);
        }
        for e in &uniq {
            warm.push(timed(&api, json!({"method": "avatar", "params": {"email": e}})).await.0);
        }
        println!("-- {label}");
        stats("  avatar, first ask (per distinct email)", cold);
        stats("  avatar, second ask", warm);
        println!("  gravatar requests {}, forge requests {}", gravatar_hits.load(Ordering::SeqCst) - hits0, forge.requests().len() - forge0);

        // The graph's queue: 4 unknown emails in flight on the network, then one already-cached
        // details email.
        let api_ref = &api;
        let busy: Vec<_> = (0..4).map(|n| async move { call(api_ref, json!({"method": "avatar", "params": {"email": format!("graph-{forge_on}-{n}@example.com")}})).await }).collect();
        let probe = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            timed(api_ref, json!({"method": "avatar", "params": {"email": uniq.first().cloned().unwrap_or_default()}})).await.0
        };
        let (_, t) = tokio::join!(futures_util::future::join_all(busy), probe);
        println!("  a cached details email while 4 graph emails wait on the network: {:.2} ms", ms(t));
    }
    gpgconf_kill(&gnupg);
}

fn gpgconf_kill(home: &std::path::Path) {
    let _ = std::process::Command::new("gpgconf").arg("--homedir").arg(home).args(["--kill", "all"]).output();
}
