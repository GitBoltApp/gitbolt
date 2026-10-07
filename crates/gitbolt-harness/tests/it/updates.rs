//! The update check end to end on the harness: the fake GitHub's releases, the download through
//! its redirect with the real HTTP client, the SHA256SUMS check, and the install command, which
//! the harness only records. No token is ever sent.

use gitbolt_core::api::{Api, Request};
use gitbolt_core::error::GbError;
use gitbolt_harness::fake_forge::releases::{FakeAsset, FakeRelease};
use gitbolt_harness::Harness;
use serde_json::{json, Value};

async fn call(api: &Api, method: &str) -> Result<Value, GbError> {
    let req: Request = serde_json::from_value(json!({ "method": method })).unwrap();
    Box::pin(api.dispatch(req)).await
}

const DEB: &str = "GitBolt_0.99.0_amd64.deb";

fn seed(h: &Harness, bad_sums: bool) {
    let mut s = h.forge.current_seed();
    let asset = |name: &str, size| FakeAsset { name: name.into(), size };
    s.github.releases = vec![
        FakeRelease { tag_name: "v1.0.0-rc.1".into(), name: "GitBolt 1.0.0-rc.1".into(), prerelease: true, assets: vec![asset("GitBolt_1.0.0-rc.1_amd64.deb", 10), asset("SHA256SUMS", 0)], ..Default::default() },
        FakeRelease {
            tag_name: "v0.99.0".into(),
            name: "GitBolt 0.99.0".into(),
            body: "## Added\n- Updates".into(),
            assets: vec![asset(DEB, 300_000), asset("GitBolt-0.99.0-1-x86_64.pkg.tar.zst", 1000), asset("SHA256SUMS", 0)],
            bad_sums: if bad_sums { vec![DEB.into()] } else { Vec::new() },
            ..Default::default()
        },
        FakeRelease { tag_name: "v5.0.0".into(), draft: true, ..Default::default() },
    ];
    h.forge.seed(s);
}

async fn settled(api: &Api) -> Value {
    for _ in 0..500 {
        let s = call(api, "updateStatus").await.unwrap();
        if s["state"] != "downloading" {
            return s;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the download never finished");
}

#[tokio::test(flavor = "multi_thread")]
async fn checks_downloads_verifies_and_records_the_install() {
    let h = Harness::for_tests().await;
    assert_eq!(call(&h.api, "updateCheck").await.unwrap()["state"], "upToDate", "no releases seeded");
    seed(&h, false);
    let state = call(&h.api, "updateCheck").await.unwrap();
    assert_eq!(state["state"], "available");
    assert_eq!(state["release"]["version"], "0.99.0", "not the draft, nor the pre-release: {state}");
    assert_eq!(state["release"]["asset"], json!({"name": DEB, "size": 300_000}));
    assert_eq!(state["release"]["notes"], "## Added\n- Updates");
    assert_eq!(call(&h.api, "updateDownload").await.unwrap()["state"], "downloading");
    let state = settled(&h.api).await;
    assert_eq!(state["state"], "ready", "{state}");
    let paths: Vec<String> = h.forge.requests().iter().map(|r| format!("{} {}", r.forge, r.path)).collect();
    assert!(paths.contains(&"github /repos/GitBoltApp/gitbolt/releases".to_string()), "{paths:?}");
    assert!(paths.contains(&format!("github-releases /GitBoltApp/gitbolt/releases/download/v0.99.0/{DEB}")), "{paths:?}");
    assert!(paths.contains(&format!("github-objects /v0.99.0/{DEB}")), "{paths:?}");
    assert!(paths.contains(&"github-objects /v0.99.0/SHA256SUMS".to_string()), "{paths:?}");
    assert!(h.forge.requests().iter().all(|r| !r.authorized && r.user_agent.as_deref().is_some_and(|u| u.starts_with("GitBolt/"))));

    // The harness never installs: the dialog gets the command to run by hand.
    let out = call(&h.api, "updateInstall").await.unwrap();
    assert_eq!(out["outcome"], "manual", "{out}");
    assert!(out["command"].as_str().unwrap().starts_with("sudo apt install "), "{out}");
    assert_eq!(h.launches.all(), [json!({"program": "pkexec", "args": ["apt", "install", "-y", format!("./{DEB}")]})]);
    assert_eq!(call(&h.api, "updateStatus").await.unwrap()["state"], "ready");

    // Pre-releases when the setting says so.
    let mut s = h.store.state().settings;
    s.update_prereleases = true;
    h.store.save_settings(s);
    h.api.reset_updates();
    assert_eq!(call(&h.api, "updateCheck").await.unwrap()["release"]["version"], "1.0.0-rc.1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_checksum_fails_and_leaves_nothing_to_install() {
    let h = Harness::for_tests().await;
    seed(&h, true);
    call(&h.api, "updateCheck").await.unwrap();
    call(&h.api, "updateDownload").await.unwrap();
    let state = settled(&h.api).await;
    assert_eq!(state["state"], "failed", "{state}");
    assert_eq!(state["message"], "The download doesn't match its checksum in SHA256SUMS, so GitBolt deleted it and won't install it.");
    assert!(call(&h.api, "updateInstall").await.is_err());
    assert!(h.launches.all().is_empty());
}
