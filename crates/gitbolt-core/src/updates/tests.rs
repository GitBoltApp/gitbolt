use super::release::GhAsset;
use super::*;
use std::collections::HashMap;

const DEB: &str = "GitBolt_0.3.0_amd64.deb";
const PAYLOAD: &[u8] = b"a fictional package, 0.3.0";

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn asset(name: &str) -> GhAsset {
    GhAsset { name: name.into(), size: PAYLOAD.len() as u64, browser_download_url: format!("https://downloads.example/{name}") }
}

fn release(tag: &str, assets: &[&str]) -> GhRelease {
    GhRelease {
        tag_name: tag.into(),
        name: Some(format!("GitBolt {}", tag.trim_start_matches('v'))),
        body: Some("## Added\n- Updates".into()),
        draft: false,
        prerelease: false,
        html_url: format!("https://github.example/GitBoltApp/gitbolt/releases/tag/{tag}"),
        published_at: Some("2026-10-07T12:00:00Z".into()),
        assets: assets.iter().map(|a| asset(a)).collect(),
    }
}

struct FakeSource {
    releases: Mutex<Result<Vec<GhRelease>, String>>,
    files: Mutex<HashMap<String, Vec<u8>>>,
    /// Downloads wait for their cancel flag instead of finishing.
    hang: AtomicBool,
}

impl FakeSource {
    fn with(releases: Vec<GhRelease>, sums: &str) -> Arc<Self> {
        let s = Self { releases: Mutex::new(Ok(releases)), files: Mutex::default(), hang: AtomicBool::new(false) };
        s.files.lock().unwrap().insert(format!("https://downloads.example/{DEB}"), PAYLOAD.to_vec());
        s.files.lock().unwrap().insert("https://downloads.example/SHA256SUMS".into(), sums.as_bytes().to_vec());
        Arc::new(s)
    }
}

impl UpdateSource for FakeSource {
    fn releases(&self) -> ForgeFuture<'_, Vec<GhRelease>> {
        let r = self.releases.lock().unwrap().clone().map_err(|m| GbError::new(GbErrorKind::Network, m));
        Box::pin(async move { r })
    }
    fn fetch<'a>(&'a self, url: &'a str) -> ForgeFuture<'a, Vec<u8>> {
        let r = self.files.lock().unwrap().get(url).cloned().ok_or_else(|| GbError::new(GbErrorKind::NotFound, "not found"));
        Box::pin(async move { r })
    }
    fn download<'a>(&'a self, url: &'a str, dest: &'a Path, progress: DownloadProgress, cancel: Arc<AtomicBool>) -> ForgeFuture<'a, u64> {
        Box::pin(async move {
            let bytes = self.files.lock().unwrap().get(url).cloned().ok_or_else(|| GbError::new(GbErrorKind::NotFound, "not found"))?;
            std::fs::write(dest, &bytes[..bytes.len() / 2])?;
            progress(bytes.len() as u64 / 2);
            while self.hang.load(Ordering::SeqCst) && !cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if cancel.load(Ordering::SeqCst) {
                let _ = std::fs::remove_file(dest);
                return Err(GbError::new(GbErrorKind::Cancelled, "cancelled"));
            }
            std::fs::write(dest, &bytes)?;
            progress(bytes.len() as u64);
            Ok(bytes.len() as u64)
        })
    }
}

#[derive(Default)]
struct FakeRunner {
    ran: Mutex<Vec<InstallCommand>>,
    spawned: Mutex<Vec<InstallCommand>>,
    quits: std::sync::atomic::AtomicUsize,
    /// What `run` answers: an exit code, or `None` for "not installed".
    answer: Mutex<Option<i32>>,
}

impl UpdateRunner for FakeRunner {
    fn run<'a>(&'a self, cmd: &'a InstallCommand) -> RunFuture<'a> {
        self.ran.lock().unwrap().push(cmd.clone());
        let answer = *self.answer.lock().unwrap();
        Box::pin(async move {
            match answer {
                Some(code) => Ok(RunOutput { code: Some(code), output: if code == 0 { String::new() } else { "\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\nE: Sub-process /usr/bin/dpkg returned an error code (1)\n".into() } }),
                None => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no pkexec")),
            }
        })
    }
    fn spawn(&self, cmd: &InstallCommand) -> std::io::Result<()> {
        self.spawned.lock().unwrap().push(cmd.clone());
        Ok(())
    }
    fn quit(&self) {
        self.quits.fetch_add(1, Ordering::SeqCst);
    }
}

struct Setup {
    updates: Arc<Updates>,
    source: Arc<FakeSource>,
    runner: Arc<FakeRunner>,
    dir: tempfile::TempDir,
    events: tokio::sync::broadcast::Receiver<AppEvent>,
}

fn setup(kind: InstallKind, current: &str, source: Arc<FakeSource>) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let runner = Arc::new(FakeRunner { answer: Mutex::new(Some(0)), ..Default::default() });
    let bus = EventBus::new();
    let events = bus.subscribe();
    let cfg = UpdateConfig { source: source.clone(), runner: runner.clone(), dir: dir.path().join("updates"), kind, exe: Some("/usr/share/GitBolt/gitbolt".into()) };
    Setup { updates: Arc::new(Updates::new(cfg, current, bus)), source, runner, dir, events }
}

fn good_sums() -> String {
    format!("{}  {DEB}\n{}  GitBolt-0.3.0-1-x86_64.pkg.tar.zst\n", sha(PAYLOAD), "0".repeat(64))
}

fn deb_release() -> Vec<GhRelease> {
    vec![release("v0.3.0", &[DEB, "GitBolt-0.3.0-1-x86_64.pkg.tar.zst", "SHA256SUMS"]), release("v0.2.0", &[])]
}

/// Waits until the state is no longer `Downloading`.
async fn settled(u: &Updates) -> UpdateState {
    for _ in 0..400 {
        let s = u.state();
        if !matches!(s, UpdateState::Downloading { .. }) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the download never finished: {:?}", u.state());
}

fn files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}

#[tokio::test]
async fn a_newer_release_is_offered_with_this_installs_package() {
    let mut s = setup(InstallKind::Deb, "0.2.0+202610072046.d1d4d7d", FakeSource::with(deb_release(), &good_sums()));
    let state = s.updates.check(false, 1000).await.unwrap();
    let UpdateState::Available { release } = &state else { panic!("{state:?}") };
    assert_eq!((release.version.as_str(), release.name.as_str()), ("0.3.0", "GitBolt 0.3.0"));
    assert_eq!(release.notes, "## Added\n- Updates");
    assert_eq!(release.asset, Some(UpdateAsset { name: DEB.into(), size: PAYLOAD.len() as u64 }));
    assert_eq!(release.url, "https://github.example/GitBoltApp/gitbolt/releases/tag/v0.3.0");
    assert!(matches!(s.events.recv().await.unwrap(), AppEvent::UpdateChanged { state: UpdateState::Checking }));
    assert_eq!(s.events.recv().await.unwrap(), AppEvent::UpdateChanged { state: state.clone() });
    // Checked a moment ago: not due again for a day.
    assert!(!s.updates.due(1000 + CHECK_EVERY_SECS - 1));
    assert!(s.updates.due(1000 + CHECK_EVERY_SECS));
}

#[tokio::test]
async fn up_to_date_and_a_failed_check_leaves_the_state_as_it_was() {
    let s = setup(InstallKind::Deb, "0.3.0", FakeSource::with(deb_release(), &good_sums()));
    assert!(s.updates.due(0));
    assert_eq!(s.updates.check(false, 1).await.unwrap(), UpdateState::UpToDate);
    *s.source.releases.lock().unwrap() = Err("Couldn't reach api.github.com".into());
    let e = s.updates.check(false, 2).await.unwrap_err();
    assert_eq!(e.message, "Couldn't reach api.github.com");
    assert_eq!(s.updates.state(), UpdateState::UpToDate);
    assert!(!s.updates.due(2), "a failed check doesn't move the last check");
}

#[tokio::test]
async fn a_build_from_source_is_offered_the_release_page_only() {
    let s = setup(InstallKind::Unpackaged, "0.2.0", FakeSource::with(deb_release(), &good_sums()));
    let UpdateState::Available { release } = s.updates.check(false, 1).await.unwrap() else { panic!() };
    assert_eq!(release.asset, None);
    assert!(s.updates.start_download().unwrap_err().message.contains("release page"));
}

#[tokio::test]
async fn a_release_without_this_kinds_package_offers_the_page_only() {
    let s = setup(InstallKind::Msi, "0.2.0", FakeSource::with(deb_release(), &good_sums()));
    let UpdateState::Available { release } = s.updates.check(false, 1).await.unwrap() else { panic!() };
    assert_eq!(release.asset, None);
}

#[tokio::test]
async fn downloads_verifies_and_keeps_the_package_with_progress() {
    let mut s = setup(InstallKind::Deb, "0.2.0", FakeSource::with(deb_release(), &good_sums()));
    s.updates.check(false, 1).await.unwrap();
    let started = s.updates.start_download().unwrap();
    assert!(matches!(started, UpdateState::Downloading { received: 0, total, .. } if total == PAYLOAD.len() as u64));
    let UpdateState::Ready { release } = settled(&s.updates).await else { panic!("{:?}", s.updates.state()) };
    assert_eq!(release.version, "0.3.0");
    let dir = s.dir.path().join("updates");
    assert_eq!(files(&dir), [DEB]);
    assert_eq!(std::fs::read(dir.join(DEB)).unwrap(), PAYLOAD);
    let mut seen = Vec::new();
    while let Ok(AppEvent::UpdateChanged { state }) = s.events.try_recv() {
        if let UpdateState::Downloading { received, .. } = state {
            seen.push(received);
        }
    }
    assert_eq!(seen.first(), Some(&0));
    assert!(seen.contains(&(PAYLOAD.len() as u64 / 2)), "{seen:?}");
}

async fn failed_download(sums: &str, assets: &[&str]) -> (String, Vec<String>) {
    let s = setup(InstallKind::Deb, "0.2.0", FakeSource::with(vec![release("v0.3.0", assets)], sums));
    s.updates.check(false, 1).await.unwrap();
    s.updates.start_download().unwrap();
    let UpdateState::Failed { message, release } = settled(&s.updates).await else { panic!("{:?}", s.updates.state()) };
    assert_eq!(release.unwrap().version, "0.3.0");
    // Retrying is allowed; the runner never ran anything.
    assert!(s.runner.ran.lock().unwrap().is_empty() && s.runner.spawned.lock().unwrap().is_empty());
    assert!(s.updates.install().await.is_err());
    (message, files(&s.dir.path().join("updates")))
}

#[tokio::test]
async fn a_checksum_mismatch_deletes_the_download() {
    let (message, left) = failed_download(&format!("{}  {DEB}\n", "1".repeat(64)), &[DEB, "SHA256SUMS"]).await;
    assert_eq!(message, "The download doesn't match its checksum in SHA256SUMS, so GitBolt deleted it and won't install it.");
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test]
async fn a_package_missing_from_the_sums_is_deleted() {
    let (message, left) = failed_download(&format!("{}  other.deb\n", sha(PAYLOAD)), &[DEB, "SHA256SUMS"]).await;
    assert_eq!(message, format!("SHA256SUMS doesn't list {DEB}, so GitBolt deleted the download and won't install it."));
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test]
async fn a_release_without_sums_is_never_installed() {
    let (message, left) = failed_download("", &[DEB]).await;
    assert_eq!(message, "The release has no SHA256SUMS to check the download against, so GitBolt deleted it.");
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test]
async fn a_cancelled_download_is_removed_and_the_update_offered_again() {
    let s = setup(InstallKind::Deb, "0.2.0", FakeSource::with(deb_release(), &good_sums()));
    s.source.hang.store(true, Ordering::SeqCst);
    s.updates.check(false, 1).await.unwrap();
    s.updates.start_download().unwrap();
    let dir = s.dir.path().join("updates");
    for _ in 0..400 {
        if !files(&dir).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(files(&dir).len(), 1, "a partial download is on disk");
    assert!(matches!(s.updates.cancel_download(), UpdateState::Available { .. }));
    for _ in 0..400 {
        if files(&dir).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(files(&dir).is_empty());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(s.updates.state(), UpdateState::Available { .. }), "the cancelled download changes nothing later");
    // And it can start again.
    s.source.hang.store(false, Ordering::SeqCst);
    s.updates.start_download().unwrap();
    assert!(matches!(settled(&s.updates).await, UpdateState::Ready { .. }));
}

async fn ready(kind: InstallKind) -> Setup {
    let mut releases = deb_release();
    releases[0].assets.extend([asset("GitBolt_0.3.0_x64.msi"), asset("GitBolt_0.3.0_x64-setup.exe")]);
    let source = FakeSource::with(releases, &format!("{}  {DEB}\n{0}  GitBolt_0.3.0_x64.msi\n{0}  GitBolt_0.3.0_x64-setup.exe\n", sha(PAYLOAD)));
    for name in ["GitBolt_0.3.0_x64.msi", "GitBolt_0.3.0_x64-setup.exe"] {
        source.files.lock().unwrap().insert(format!("https://downloads.example/{name}"), PAYLOAD.to_vec());
    }
    let s = setup(kind, "0.2.0", source);
    s.updates.check(false, 1).await.unwrap();
    s.updates.start_download().unwrap();
    assert!(matches!(settled(&s.updates).await, UpdateState::Ready { .. }), "{:?}", s.updates.state());
    s
}

#[tokio::test]
async fn a_deb_installs_through_pkexec_then_restarts_the_installed_binary() {
    let s = ready(InstallKind::Deb).await;
    assert_eq!(s.updates.install().await.unwrap(), InstallOutcome::Installed);
    let ran = s.runner.ran.lock().unwrap().clone();
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].display(), format!("pkexec apt install -y {}", s.dir.path().join("updates").join(DEB).display()));
    assert_eq!(ran[0].cwd, None);
    assert!(matches!(s.updates.state(), UpdateState::Installed { .. }));
    s.updates.restart().unwrap();
    let spawned = s.runner.spawned.lock().unwrap().clone();
    assert_eq!(spawned, [relaunch_command(Path::new("/usr/share/GitBolt/gitbolt"), std::process::id())]);
    assert_eq!(s.runner.quits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_cancelled_password_prompt_or_no_pkexec_shows_the_command_to_run() {
    let s = ready(InstallKind::Deb).await;
    let file = s.dir.path().join("updates").join(DEB);
    *s.runner.answer.lock().unwrap() = Some(126);
    let InstallOutcome::Manual { command, reason, output } = s.updates.install().await.unwrap() else { panic!() };
    assert_eq!(command, format!("sudo apt install {}", super::install::quote(&file.display().to_string())));
    assert!(reason.contains("password prompt was cancelled"), "{reason}");
    assert_eq!(output, None, "pkexec's own refusal: no package manager output");
    assert!(matches!(s.updates.state(), UpdateState::Ready { .. }), "it can be tried again");
    *s.runner.answer.lock().unwrap() = None;
    let InstallOutcome::Manual { reason, .. } = s.updates.install().await.unwrap() else { panic!() };
    assert_eq!(reason, "pkexec isn't installed, so GitBolt can't ask for the password itself.");
    *s.runner.answer.lock().unwrap() = Some(100);
    let InstallOutcome::Manual { reason, output, .. } = s.updates.install().await.unwrap() else { panic!() };
    assert_eq!(reason, "The install failed (exit 100).");
    assert_eq!(output.as_deref(), Some("E: Sub-process /usr/bin/dpkg returned an error code (1)"), "apart from the reason, less apt's CLI notice");
    assert!(s.updates.restart().is_err(), "nothing installed: no restart");
    assert_eq!(s.runner.quits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn arch_installs_with_pacman() {
    let mut releases = deb_release();
    releases[0].assets = vec![asset("GitBolt-0.3.0-1-x86_64.pkg.tar.zst"), asset("SHA256SUMS")];
    let source = FakeSource::with(releases, &format!("{}  GitBolt-0.3.0-1-x86_64.pkg.tar.zst\n", sha(PAYLOAD)));
    source.files.lock().unwrap().insert("https://downloads.example/GitBolt-0.3.0-1-x86_64.pkg.tar.zst".into(), PAYLOAD.to_vec());
    let s = setup(InstallKind::Arch, "0.2.0", source);
    s.updates.check(false, 1).await.unwrap();
    s.updates.start_download().unwrap();
    assert!(matches!(settled(&s.updates).await, UpdateState::Ready { .. }));
    *s.runner.answer.lock().unwrap() = Some(127);
    let InstallOutcome::Manual { command, .. } = s.updates.install().await.unwrap() else { panic!() };
    let file = s.dir.path().join("updates").join("GitBolt-0.3.0-1-x86_64.pkg.tar.zst");
    assert_eq!(command, format!("sudo pacman -U {}", super::install::quote(&file.display().to_string())));
    assert_eq!(s.runner.ran.lock().unwrap()[0].display(), format!("pkexec pacman -U --noconfirm {}", super::install::quote(&file.display().to_string())));
}

#[tokio::test]
async fn windows_installers_start_and_gitbolt_quits() {
    for (kind, program) in [(InstallKind::Msi, "msiexec"), (InstallKind::Nsis, "GitBolt_0.3.0_x64-setup.exe")] {
        let s = ready(kind).await;
        assert_eq!(s.updates.install().await.unwrap(), InstallOutcome::Quitting);
        let spawned = s.runner.spawned.lock().unwrap().clone();
        assert!(spawned[0].program.ends_with(program), "{spawned:?}");
        assert!(s.runner.ran.lock().unwrap().is_empty());
        assert_eq!(s.runner.quits.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn a_package_changed_after_its_check_is_deleted_and_never_run() {
    let s = ready(InstallKind::Deb).await;
    let file = s.dir.path().join("updates").join(DEB);
    std::fs::write(&file, b"something else").unwrap();
    let e = s.updates.install().await.unwrap_err();
    assert!(e.message.contains("changed since it was checked"), "{}", e.message);
    assert!(!file.exists());
    assert!(s.runner.ran.lock().unwrap().is_empty());
    assert!(matches!(s.updates.state(), UpdateState::Failed { release: Some(_), .. }));
}

#[tokio::test]
async fn a_check_during_a_download_leaves_it_alone() {
    let s = setup(InstallKind::Deb, "0.2.0", FakeSource::with(deb_release(), &good_sums()));
    s.source.hang.store(true, Ordering::SeqCst);
    s.updates.check(false, 1).await.unwrap();
    s.updates.start_download().unwrap();
    assert!(matches!(s.updates.check(false, 2).await.unwrap(), UpdateState::Downloading { .. }));
    s.updates.cancel_download();
}

#[test]
fn states_serialize_as_the_ui_reads_them() {
    let release = UpdateRelease { version: "0.3.0".into(), name: "GitBolt 0.3.0".into(), notes: String::new(), url: "u".into(), prerelease: false, published_at: None, asset: Some(UpdateAsset { name: DEB.into(), size: 9 }) };
    assert_eq!(serde_json::to_value(UpdateState::UpToDate).unwrap(), serde_json::json!({"state": "upToDate"}));
    assert_eq!(
        serde_json::to_value(UpdateState::Downloading { release, received: 3, total: 9 }).unwrap(),
        serde_json::json!({"state": "downloading", "received": 3, "total": 9, "release": {"version": "0.3.0", "name": "GitBolt 0.3.0", "notes": "", "url": "u", "prerelease": false, "publishedAt": null, "asset": {"name": DEB, "size": 9}}})
    );
    assert_eq!(serde_json::to_value(InstallOutcome::Manual { command: "c".into(), reason: "r".into(), output: Some("o".into()) }).unwrap(), serde_json::json!({"outcome": "manual", "command": "c", "reason": "r", "output": "o"}));
}
