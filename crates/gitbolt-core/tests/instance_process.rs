//! The single-instance guard (R19) across real processes: a later launch exits 0 after
//! forwarding, and a killed instance's leftover socket is taken over. The "other process" is
//! this test binary re-run as `helper` (ignored, so it never runs on its own), always against
//! temp runtime and config dirs: never the user's own instance.

use gitbolt_core::instance::{claim, instance_paths, Claim};
use std::io::BufRead;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const HELPER_ENV: &str = "GITBOLT_INSTANCE_TEST_HELPER";
/// What a holding helper prints once it is the first instance (libtest may print on the same line).
const PRIMARY_MARK: &str = "gb-helper-is-primary";

/// The child process: claims with launch path `/from/child`; exits 0 when it forwarded, 11 when
/// unguarded; as the first instance, exits 10, or with `hold` prints `PRIMARY_MARK` and waits to be
/// killed (a crash, as far as the guard can tell).
#[test]
#[ignore = "the child process of the other tests in this file"]
fn helper() {
    let Ok(spec) = std::env::var(HELPER_ENV) else { return };
    let mut it = spec.split('\n');
    let (rt, cfg, mode) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap_or(""));
    match claim(Path::new(rt), Path::new(cfg), Some("/from/child")) {
        Claim::Forwarded => std::process::exit(0),
        Claim::Unguarded(_) => std::process::exit(11),
        Claim::Primary(p) if mode == "hold" => {
            println!("{PRIMARY_MARK}");
            std::thread::sleep(Duration::from_secs(60));
            drop(p);
            std::process::exit(12)
        }
        Claim::Primary(_) => std::process::exit(10),
    }
}

fn spawn_helper(rt: &Path, cfg: &Path, mode: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "helper", "--ignored", "--nocapture", "--test-threads=1"])
        .env(HELPER_ENV, format!("{}\n{}\n{mode}", rt.display(), cfg.display()))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap()
}

fn wait(child: &mut Child) -> i32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code().unwrap_or(-1);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            panic!("the helper didn't exit");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_process_forwards_its_path_and_exits_0() {
    let rt = tempfile::tempdir().unwrap();
    let cfg = rt.path().join("config/gitbolt");
    let Claim::Primary(first) = claim(rt.path(), &cfg, None) else { panic!("the first instance") };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    first
        .serve(move |path| {
            let _ = tx.send(path);
        })
        .unwrap();
    let (rtp, cfgp) = (rt.path().to_path_buf(), cfg.clone());
    let code = tokio::task::spawn_blocking(move || wait(&mut spawn_helper(&rtp, &cfgp, ""))).await.unwrap();
    assert_eq!(code, 0, "forwarded, then exited 0");
    let got = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
    // As the child made it absolute (`C:\from\child` on Windows).
    let want = std::path::absolute("/from/child").unwrap();
    assert_eq!(got.as_deref(), Some(want.to_str().unwrap()));

    // Another config dir is another instance: that launch becomes its own first instance.
    let (rtp, other) = (rt.path().to_path_buf(), rt.path().join("elsewhere/gitbolt"));
    let code = tokio::task::spawn_blocking(move || wait(&mut spawn_helper(&rtp, &other, ""))).await.unwrap();
    assert_eq!(code, 10);
}

#[test]
fn a_killed_instances_socket_is_taken_over() {
    let rt = tempfile::tempdir().unwrap();
    let cfg = rt.path().join("cfg");
    let mut child = spawn_helper(rt.path(), &cfg, "hold");
    let found = std::io::BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok).find(|l| l.contains(PRIMARY_MARK));
    assert!(found.is_some(), "the helper became the first instance");
    child.kill().unwrap();
    child.wait().unwrap();
    let (_, socket) = instance_paths(rt.path(), &cfg);
    // (A Windows pipe goes with its process: nothing is left behind there.)
    #[cfg(unix)]
    assert!(socket.exists(), "SIGKILL leaves the socket file behind");
    let Claim::Primary(p) = claim(rt.path(), &cfg, None) else { panic!("the stale socket wasn't taken over") };
    assert_eq!(p.socket_path(), socket);
}
