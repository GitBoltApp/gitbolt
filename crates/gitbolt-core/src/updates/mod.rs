//! Updates from GitHub Releases: the check, the download and its `SHA256SUMS` check, and the
//! install.
//!
//! - **Check:** `GET /repos/GitBoltApp/gitbolt/releases`, without a token or anything about the
//!   user's repositories, at startup and once a day (Settings › Updates turns that off), and on
//!   Check for updates. The newest release above this version is offered (`release.rs`).
//! - **Download:** this install's package (`InstallKind`) into the cache's `updates/` folder,
//!   with progress events, cancellable. It's kept only if `SHA256SUMS` from the same release
//!   lists it with the same digest; otherwise it's deleted and never run.
//! - **Install:** the command for the install kind (`install.rs`), run by the `UpdateRunner`.
//!   The digest is checked once more first.
//!
//! Core speaks no HTTP: the `UpdateSource` (gitbolt-forge's, or a test's) fetches.

pub mod install;
pub mod release;
pub mod version;

use crate::error::{GbError, GbErrorKind};
use crate::events::{AppEvent, EventBus};
use crate::forge::ForgeFuture;
use install::{install_command, manual_command, relaunch_command, InstallCommand, InstallKind};
use release::{asset_name, check_sum, newest_update, sha256_file, GhRelease, SumCheck, SUMS_ASSET};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use ts_rs::TS;
use version::Version;

/// Where the releases are.
pub const RELEASES_REPO: &str = "GitBoltApp/gitbolt";
/// The automatic check runs this often.
pub const CHECK_EVERY_SECS: i64 = 24 * 60 * 60;
/// How often the automatic check looks at the clock (a laptop that slept catches up within it).
pub const CHECK_TICK: Duration = Duration::from_secs(60 * 60);
/// After startup, the first automatic check waits this long (it never slows the first paint).
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
/// Download progress is announced at most this often (and on every new percent).
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// A release the UI can show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateRelease {
    /// `0.3.0`, `0.4.0-rc.1`.
    pub version: String,
    /// The release's title (`GitBolt 0.3.0`).
    pub name: String,
    /// Its notes: GitHub-flavoured Markdown.
    pub notes: String,
    /// The release page on GitHub.
    pub url: String,
    pub prerelease: bool,
    pub published_at: Option<String>,
    /// This install's package; `None` for a build from source, or a release without one: the
    /// dialog then offers only the release page.
    pub asset: Option<UpdateAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateAsset {
    pub name: String,
    #[ts(type = "number")]
    pub size: u64,
}

/// Where the update stands. The status bar's pill shows `available` through `installed`, and
/// `failed` when it has a release (a download or install that went wrong).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum UpdateState {
    /// Not checked yet.
    Idle,
    Checking,
    UpToDate,
    Available { release: UpdateRelease },
    Downloading {
        release: UpdateRelease,
        #[ts(type = "number")]
        received: u64,
        #[ts(type = "number")]
        total: u64,
    },
    /// Downloaded and verified.
    Ready { release: UpdateRelease },
    Installing { release: UpdateRelease },
    /// Installed over this one (Linux): Restart GitBolt starts the new version.
    Installed { release: UpdateRelease },
    Failed { message: String, release: Option<UpdateRelease> },
}

impl UpdateState {
    fn release(&self) -> Option<&UpdateRelease> {
        match self {
            Self::Available { release } | Self::Downloading { release, .. } | Self::Ready { release } | Self::Installing { release } | Self::Installed { release } => Some(release),
            Self::Failed { release, .. } => release.as_ref(),
            Self::Idle | Self::Checking | Self::UpToDate => None,
        }
    }
}

/// What Install did.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum InstallOutcome {
    /// Installed over the running version: offer Restart GitBolt.
    Installed,
    /// The installer started (Windows); GitBolt quits so it can replace its files.
    Quitting,
    /// GitBolt couldn't run the install (no `pkexec`, the password prompt was cancelled, the
    /// package manager failed): the command to run in a terminal, why (one sentence), and the
    /// package manager's output, if it ran (`None` otherwise).
    Manual { command: String, reason: String, output: Option<String> },
}

pub type DownloadProgress = Arc<dyn Fn(u64) + Send + Sync>;

/// Fetches releases and their files. No token is ever sent.
pub trait UpdateSource: Send + Sync {
    /// The repository's releases, newest first (drafts aren't visible without a token anyway).
    fn releases(&self) -> ForgeFuture<'_, Vec<GhRelease>>;
    /// A small asset (`SHA256SUMS`), whole.
    fn fetch<'a>(&'a self, url: &'a str) -> ForgeFuture<'a, Vec<u8>>;
    /// Streams `url` into `dest`, calling `progress` with the bytes so far. Once `cancel` is set
    /// it stops (`Cancelled`); on any error or cancel, `dest` is removed.
    fn download<'a>(&'a self, url: &'a str, dest: &'a Path, progress: DownloadProgress, cancel: Arc<AtomicBool>) -> ForgeFuture<'a, u64>;
}

/// A finished command: its exit code (`None`: killed by a signal) and the end of its output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub output: String,
}

pub type RunFuture<'a> = Pin<Box<dyn Future<Output = std::io::Result<RunOutput>> + Send + 'a>>;

/// Runs the install commands. The app's runs them; tests and the harness only record them.
pub trait UpdateRunner: Send + Sync {
    /// Runs `cmd` and waits for it. An `Err` of kind `NotFound`: the program isn't installed.
    fn run<'a>(&'a self, cmd: &'a InstallCommand) -> RunFuture<'a>;
    /// Starts `cmd` on its own, outliving GitBolt.
    fn spawn(&self, cmd: &InstallCommand) -> std::io::Result<()>;
    /// Quits GitBolt (as the window's close does).
    fn quit(&self);
}

/// The update machinery's parts (`Api::with_updates`).
pub struct UpdateConfig {
    pub source: Arc<dyn UpdateSource>,
    pub runner: Arc<dyn UpdateRunner>,
    /// Downloads go here (`~/.cache/gitbolt/updates`).
    pub dir: PathBuf,
    pub kind: InstallKind,
    /// The running binary, as it was at startup: Restart GitBolt starts it again.
    pub exe: Option<PathBuf>,
}

/// The release found and where its files are.
#[derive(Clone)]
struct Found {
    release: UpdateRelease,
    asset_url: Option<String>,
    sums_url: Option<String>,
    /// Once verified: the file and its digest.
    file: Option<(PathBuf, String)>,
}

struct Inner {
    state: UpdateState,
    found: Option<Found>,
    /// The running download's id and stop flag.
    download: Option<(u64, Arc<AtomicBool>)>,
    next_download: u64,
    /// The last successful check (unix seconds).
    last_check: Option<i64>,
    /// When progress was last announced, and its percent.
    announced: (Option<Instant>, u64),
}

pub struct Updates {
    cfg: UpdateConfig,
    current: Version,
    bus: EventBus,
    inner: Mutex<Inner>,
}

fn not_ready(what: &str) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, what.to_string())
}

impl Updates {
    pub fn new(cfg: UpdateConfig, current: &str, bus: EventBus) -> Self {
        // A version that doesn't parse (never, from the build) is older than every release.
        let current = Version::parse(current).unwrap_or_else(|| Version::parse("0.0.0").expect("0.0.0 parses"));
        Self { cfg, current, bus, inner: Mutex::new(Inner { state: UpdateState::Idle, found: None, download: None, next_download: 1, last_check: None, announced: (None, 0) }) }
    }

    pub fn kind(&self) -> InstallKind {
        self.cfg.kind
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("updates poisoned")
    }

    pub fn state(&self) -> UpdateState {
        self.lock().state.clone()
    }

    /// Sets the state and announces it.
    fn set(&self, inner: &mut Inner, state: UpdateState) {
        inner.state = state.clone();
        self.bus.emit(AppEvent::UpdateChanged { state });
    }

    /// The automatic check is due: never checked, or `CHECK_EVERY_SECS` since the last.
    pub fn due(&self, now: i64) -> bool {
        self.lock().last_check.is_none_or(|t| now.saturating_sub(t) >= CHECK_EVERY_SECS)
    }

    /// Asks GitHub for the releases. A download, a verified package or an install in progress
    /// is left alone. A failed check leaves the state as it was and returns the error.
    pub async fn check(&self, include_pre: bool, now: i64) -> Result<UpdateState, GbError> {
        let before = {
            let mut inner = self.lock();
            match inner.state {
                UpdateState::Downloading { .. } | UpdateState::Ready { .. } | UpdateState::Installing { .. } | UpdateState::Installed { .. } | UpdateState::Checking => return Ok(inner.state.clone()),
                _ => {}
            }
            let before = inner.state.clone();
            self.set(&mut inner, UpdateState::Checking);
            before
        };
        let listed = self.cfg.source.releases().await;
        let mut inner = self.lock();
        let releases = match listed {
            Ok(r) => r,
            Err(e) => {
                self.set(&mut inner, before);
                return Err(e);
            }
        };
        inner.last_check = Some(now);
        let found = newest_update(&releases, &self.current, include_pre).map(|(r, v)| self.found(r, &v));
        let state = match &found {
            Some(f) => UpdateState::Available { release: f.release.clone() },
            None => UpdateState::UpToDate,
        };
        inner.found = found;
        self.set(&mut inner, state.clone());
        Ok(state)
    }

    fn found(&self, r: &GhRelease, v: &Version) -> Found {
        let asset = asset_name(self.cfg.kind, v).and_then(|n| r.asset(&n));
        let version = v.without_build();
        Found {
            release: UpdateRelease {
                name: r.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("GitBolt {version}")),
                version,
                notes: r.body.clone().unwrap_or_default(),
                url: r.html_url.clone(),
                prerelease: r.prerelease || v.is_prerelease(),
                published_at: r.published_at.clone(),
                asset: asset.map(|a| UpdateAsset { name: a.name.clone(), size: a.size }),
            },
            asset_url: asset.map(|a| a.browser_download_url.clone()),
            sums_url: r.asset(SUMS_ASSET).map(|a| a.browser_download_url.clone()),
            file: None,
        }
    }

    /// Starts downloading the offered package (again, after a failure). Progress and the
    /// outcome arrive as `updateChanged` events.
    pub fn start_download(self: &Arc<Self>) -> Result<UpdateState, GbError> {
        let mut inner = self.lock();
        let offered = matches!(inner.state, UpdateState::Available { .. } | UpdateState::Failed { release: Some(_), .. });
        let found = inner.found.clone().filter(|_| offered).ok_or_else(|| not_ready("There's no update to download"))?;
        let (Some(url), Some(asset)) = (found.asset_url.clone(), found.release.asset.clone()) else {
            return Err(not_ready("This build has no package to download: get the update from its release page"));
        };
        let id = inner.next_download;
        inner.next_download += 1;
        let cancel = Arc::new(AtomicBool::new(false));
        inner.download = Some((id, cancel.clone()));
        inner.announced = (None, 0);
        let state = UpdateState::Downloading { release: found.release.clone(), received: 0, total: asset.size };
        self.set(&mut inner, state.clone());
        drop(inner);
        let me = self.clone();
        tokio::spawn(async move { me.download(id, found, url, asset, cancel).await });
        Ok(state)
    }

    /// Whether download `id` is still the current one (not cancelled, not replaced).
    fn current_download(inner: &Inner, id: u64) -> bool {
        inner.download.as_ref().is_some_and(|(d, _)| *d == id)
    }

    async fn download(self: Arc<Self>, id: u64, found: Found, url: String, asset: UpdateAsset, cancel: Arc<AtomicBool>) {
        let release = found.release.clone();
        let dir = self.cfg.dir.clone();
        // Its own name per download: a cancelled one still finishing never removes the next one's.
        let part = dir.join(format!("{}.{id}.part", asset.name));
        let target = dir.join(&asset.name);
        let fail = |me: &Self, message: String| {
            let _ = std::fs::remove_file(&part);
            let mut inner = me.lock();
            if Self::current_download(&inner, id) {
                inner.download = None;
                me.set(&mut inner, UpdateState::Failed { message, release: Some(release.clone()) });
            }
        };
        if let Err(e) = prepare_dir(&dir) {
            return fail(&self, format!("Couldn't prepare {} for the download: {e}", dir.display()));
        }
        let me = self.clone();
        let (rel, total) = (release.clone(), asset.size);
        let progress: DownloadProgress = Arc::new(move |received| me.progress(id, &rel, received, total));
        let got = self.cfg.source.download(&url, &part, progress, cancel.clone()).await;
        if cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&part);
            return;
        }
        if let Err(e) = got {
            return fail(&self, format!("Couldn't download the update: {}", e.message));
        }
        let Some(sums_url) = found.sums_url.clone() else {
            return fail(&self, format!("The release has no {SUMS_ASSET} to check the download against, so GitBolt deleted it."));
        };
        let sums = match self.cfg.source.fetch(&sums_url).await {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => return fail(&self, format!("Couldn't get the release's {SUMS_ASSET} ({}), so GitBolt deleted the download.", e.message)),
        };
        let (path, name) = (part.clone(), asset.name.clone());
        let checked = tokio::task::spawn_blocking(move || check_sum(&path, &name, &sums)).await;
        let digest = match checked {
            Ok(Ok(SumCheck::Good(d))) => d,
            Ok(Ok(SumCheck::Missing)) => return fail(&self, format!("{SUMS_ASSET} doesn't list {}, so GitBolt deleted the download and won't install it.", asset.name)),
            Ok(Ok(SumCheck::Mismatch)) => return fail(&self, format!("The download doesn't match its checksum in {SUMS_ASSET}, so GitBolt deleted it and won't install it.")),
            Ok(Err(e)) => return fail(&self, format!("Couldn't read the download to check it: {e}")),
            Err(e) => return fail(&self, format!("Couldn't check the download: {e}")),
        };
        if let Err(e) = std::fs::rename(&part, &target) {
            return fail(&self, format!("Couldn't keep the download: {e}"));
        }
        let mut inner = self.lock();
        if !Self::current_download(&inner, id) {
            let _ = std::fs::remove_file(&target);
            return;
        }
        inner.download = None;
        if let Some(f) = inner.found.as_mut() {
            f.file = Some((target, digest));
        }
        self.set(&mut inner, UpdateState::Ready { release });
    }

    fn progress(&self, id: u64, release: &UpdateRelease, received: u64, total: u64) {
        let mut inner = self.lock();
        if !Self::current_download(&inner, id) {
            return;
        }
        let percent = received.saturating_mul(100).checked_div(total).unwrap_or(0);
        let (last, last_percent) = inner.announced;
        let state = UpdateState::Downloading { release: release.clone(), received, total };
        if last.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) || percent != last_percent {
            inner.announced = (Some(Instant::now()), percent);
            self.set(&mut inner, state);
        } else {
            inner.state = state;
        }
    }

    /// Stops the download; the update is offered again.
    pub fn cancel_download(&self) -> UpdateState {
        let mut inner = self.lock();
        if let Some((_, cancel)) = inner.download.take() {
            cancel.store(true, Ordering::SeqCst);
            if let Some(release) = inner.state.release().cloned() {
                self.set(&mut inner, UpdateState::Available { release });
            }
        }
        inner.state.clone()
    }

    /// Installs the verified package (its digest checked again first).
    pub async fn install(&self) -> Result<InstallOutcome, GbError> {
        let (release, file, digest) = {
            let inner = self.lock();
            match (&inner.state, inner.found.as_ref().and_then(|f| f.file.clone())) {
                (UpdateState::Ready { release }, Some((file, digest))) => (release.clone(), file, digest),
                _ => return Err(not_ready("There's no verified update to install")),
            }
        };
        let path = file.clone();
        let again = tokio::task::spawn_blocking(move || sha256_file(&path)).await.map_err(|e| GbError::other(e.to_string()))?;
        if again.ok().as_deref() != Some(digest.as_str()) {
            let _ = std::fs::remove_file(&file);
            let message = "The downloaded package changed since it was checked, so GitBolt deleted it. Download it again.".to_string();
            let mut inner = self.lock();
            if let Some(f) = inner.found.as_mut() {
                f.file = None;
            }
            self.set(&mut inner, UpdateState::Failed { message: message.clone(), release: Some(release) });
            return Err(GbError::other(message));
        }
        let kind = self.cfg.kind;
        let cmd = install_command(kind, &file).ok_or_else(|| not_ready("This build has no package to install"))?;
        {
            let mut inner = self.lock();
            self.set(&mut inner, UpdateState::Installing { release: release.clone() });
        }
        if kind.quits_to_install() {
            tracing::info!(target: "gitbolt_core::updates", "starting the installer: {}", cmd.display());
            if let Err(e) = self.cfg.runner.spawn(&cmd) {
                let mut inner = self.lock();
                self.set(&mut inner, UpdateState::Ready { release });
                return Err(GbError::new(GbErrorKind::Io, format!("Couldn't start the installer: {e}")));
            }
            self.cfg.runner.quit();
            return Ok(InstallOutcome::Quitting);
        }
        tracing::info!(target: "gitbolt_core::updates", "installing the update: {}", cmd.display());
        let ran = self.cfg.runner.run(&cmd).await;
        let manual = manual_command(kind, &file).unwrap_or_default();
        let mut output = None;
        let reason = match ran {
            Ok(out) if out.code == Some(0) => {
                let mut inner = self.lock();
                self.set(&mut inner, UpdateState::Installed { release });
                return Ok(InstallOutcome::Installed);
            }
            Ok(out) if matches!(out.code, Some(126 | 127)) => "GitBolt couldn't get permission to install it: the password prompt was cancelled, or there's no polkit agent to ask.".to_string(),
            Ok(out) => {
                output = Some(install_output(&crate::redact::redact(&out.output))).filter(|o| !o.is_empty());
                let code = out.code.map_or("a signal".to_string(), |c| format!("exit {c}"));
                format!("The install failed ({code}).")
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "pkexec isn't installed, so GitBolt can't ask for the password itself.".to_string(),
            Err(e) => format!("Couldn't start pkexec: {e}"),
        };
        tracing::warn!(target: "gitbolt_core::updates", "the update didn't install: {reason} {}", output.as_deref().unwrap_or(""));
        let mut inner = self.lock();
        self.set(&mut inner, UpdateState::Ready { release });
        Ok(InstallOutcome::Manual { command: manual, reason, output })
    }

    /// Back to unchecked, any download stopped (the harness's reset).
    pub fn reset(&self) {
        let mut inner = self.lock();
        if let Some((_, cancel)) = inner.download.take() {
            cancel.store(true, Ordering::SeqCst);
        }
        inner.found = None;
        inner.last_check = None;
        self.set(&mut inner, UpdateState::Idle);
    }

    /// Starts the installed version once this one has quit, and quits.
    pub fn restart(&self) -> Result<(), GbError> {
        if !matches!(self.lock().state, UpdateState::Installed { .. }) {
            return Err(not_ready("No update has been installed"));
        }
        let exe = self.cfg.exe.as_ref().ok_or_else(|| not_ready("GitBolt doesn't know where its binary is: start it again yourself"))?;
        self.cfg.runner.spawn(&relaunch_command(exe, std::process::id())).map_err(|e| GbError::new(GbErrorKind::Io, format!("Couldn't restart GitBolt: {e}")))?;
        self.cfg.runner.quit();
        Ok(())
    }
}

/// The downloads folder, emptied of older downloads (one update is kept at a time).
fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// The app's runner: commands run with `hook`'s environment (the app's `restore_child_env`),
/// stdin closed; `quit` quits the app.
pub struct SystemRunner {
    pub hook: crate::openers::ChildEnvHook,
    pub quit: Arc<dyn Fn() + Send + Sync>,
}

/// The last lines of a command's output that the install error shows.
const OUTPUT_TAIL: usize = 1200;

impl UpdateRunner for SystemRunner {
    fn run<'a>(&'a self, cmd: &'a InstallCommand) -> RunFuture<'a> {
        Box::pin(async move {
            let mut c = tokio::process::Command::new(&cmd.program);
            c.args(&cmd.args).stdin(std::process::Stdio::null()).kill_on_drop(true);
            if let Some(dir) = &cmd.cwd {
                c.current_dir(dir);
            }
            for var in crate::openers::PRIVATE_ENV {
                c.env_remove(var);
            }
            (self.hook)(c.as_std_mut());
            let out = c.output().await?;
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            let start = text.len().saturating_sub(OUTPUT_TAIL);
            let start = (start..text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(text.len());
            Ok(RunOutput { code: out.status.code(), output: text[start..].to_string() })
        })
    }

    fn spawn(&self, cmd: &InstallCommand) -> std::io::Result<()> {
        let launch = crate::openers::LaunchCommand { program: cmd.program.clone().into(), args: cmd.args.iter().map(Into::into).collect() };
        crate::openers::spawn_detached_with(&launch, &|c: &mut std::process::Command| {
            if let Some(dir) = &cmd.cwd {
                c.current_dir(dir);
            }
            (self.hook)(c);
        })
        .map_err(|e| std::io::Error::other(e.message))
    }

    fn quit(&self) {
        (self.quit)();
    }
}

#[cfg(test)]
mod tests;

/// A package manager's output for the dialog: trimmed, less apt's notice that its CLI isn't stable
/// (it prints it to anything that isn't a terminal) and the blank lines around it.
fn install_output(out: &str) -> String {
    out.lines()
        .filter(|l| !l.contains("apt does not have a stable CLI interface"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}
