//! App-wide settings and per-profile state (spec §14.1, §14.3): JSON files under the config
//! dir, written atomically (temp file, fsync, rename), debounced 500 ms, each with a schema
//! version. An unreadable or newer-version file is set aside (renamed), never overwritten.
//!
//! View preferences that must apply before the first paint (zoom, density, diff mode and its
//! toggles, sticky scroll, the last opener, file-list prefs, the details split) stay in the UI's
//! localStorage behind 1B's seams (ruling R4), so `AppSettings` has no fields for them.
//!
//! Deviation (spec §14.1/§14.4): host-type overrides are per profile, keyed by host.

use crate::error::{GbError, GbErrorKind};
use crate::random::random_hex;
use crate::remotes::HostKind;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ts_rs::TS;

pub const SETTINGS_VERSION: u32 = 1;
pub const PROFILE_VERSION: u32 = 1;
pub const DEFAULT_PROFILE_ID: &str = "default";
pub const MAX_CLOSED_TABS: usize = 20;
pub const MAX_RECENT: usize = 50;
pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// Retries of a failed flush before it waits for the next change.
pub const MAX_SAVE_RETRIES: u32 = 5;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);

/// 1 s, 2 s, 4 s, … up to `MAX_RETRY_DELAY`.
fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.min(16)).min(MAX_RETRY_DELAY)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DateFormat {
    /// `2026-09-26 @ 3:14 PM`
    #[default]
    Ymd12h,
    /// `2026-09-26 15:14`
    Ymd24h,
    /// `26/09/2026 15:14`
    Dmy24h,
    /// `09/26/2026 3:14 PM`
    Mdy12h,
}

/// What the toolbar's Fetch/Pull button runs (spec #2 §12.1). Fetch All by default: the least
/// surprising. Within pull, ff-only is the preferred mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SyncButtonMode {
    #[default]
    FetchAll,
    PullFfOrMerge,
    PullFfOnly,
    PullRebase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AppSettings {
    pub version: u32,
    pub active_profile: String,
    /// Theme id; plan 1D owns the list.
    pub theme: String,
    /// Plan 1D applies it.
    pub editor_font_size: u16,
    /// Background fetch period in seconds; 0 turns background fetch off.
    pub fetch_interval_secs: u32,
    pub prune: bool,
    /// Commits loaded per graph (`snapshot::DEFAULT_COMMIT_LIMIT` by default).
    pub commit_limit: u32,
    pub date_format: DateFormat,
    pub gravatar: bool,
    /// Writes `debug`-level lines to the log file (spec §16.2).
    pub debug_logging: bool,
    /// The toolbar Fetch/Pull button's default operation (spec #2 §12.1).
    pub sync_button: SyncButtonMode,
    /// "Push tags with branches" (spec #3 §3.9): every push adds `--follow-tags`, sending the
    /// annotated tags on the pushed commits that the remote lacks. On by default (a release's
    /// annotated tag goes out with its commit).
    pub push_follow_tags: bool,
    // --- 4A T6 ---
    /// "Load avatars from your forge accounts" (spec #4 §2 "Avatars"): the forges first, then
    /// Gravatar (its own setting), then initials.
    pub forge_avatars: bool,
    // --- end 4A T6 ---
    /// Per-theme lane colour overrides (plan 1D): theme id → lane index → `#rrggbb`, or null for
    /// the theme's own colour. The UI validates the entries; an invalid one shows the theme's.
    #[ts(type = "Record<string, (string | null)[]>")]
    pub graph_color_overrides: BTreeMap<String, Vec<Option<String>>>,
    /// The main window's last normal geometry (K46). Owned by the app shell, not the UI: it's
    /// left out of the TypeScript bindings, and `save_settings` keeps the store's own value
    /// whatever the UI sends back. Absent in files written before it existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub window: Option<WindowGeometry>,
}

/// Where the main window was, in logical (DPI-independent) pixels: its last normal (not
/// maximized, not minimized) rect, whether it was maximized on top of that, and the monitor it
/// was on. `x`/`y` are the outer (frame) position and are absent where the platform doesn't
/// report one (Wayland); `width`/`height` are the inner (content) size.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowGeometry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor: Option<MonitorIdentity>,
}

/// A monitor as the window saw it: its name (connector, maker, model) and its logical rect.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            active_profile: DEFAULT_PROFILE_ID.into(),
            theme: "default-dark".into(),
            editor_font_size: 13,
            fetch_interval_secs: 60,
            prune: true,
            commit_limit: 2000,
            date_format: DateFormat::Ymd12h,
            gravatar: true,
            debug_logging: false,
            sync_button: SyncButtonMode::FetchAll,
            push_follow_tags: true,
            forge_avatars: true,
            graph_color_overrides: BTreeMap::new(),
            window: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TabKind {
    #[default]
    Repo,
    /// The Open Repository screen (spec §13).
    Open,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TabState {
    pub id: String,
    pub kind: TabKind,
    /// Canonical repo path (`RepoSummary.path`); `None` for Open tabs.
    pub path: Option<String>,
    /// Display alias (tab "Rename").
    pub alias: Option<String>,
    /// The tab's active worktree (spec #2 §11.2); `None`: the repository's main worktree. A
    /// profile saved before 2C has none, and `path` may be a linked worktree's: opening the tab
    /// rewrites it to the repository's path and this worktree. Optional in TypeScript too: a tab
    /// made before 2C has none.
    #[ts(optional = nullable)]
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ClosedTab {
    pub path: String,
    pub alias: Option<String>,
    pub index: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub pinned: bool,
    /// Unix seconds.
    #[ts(type = "number")]
    pub opened_at: i64,
}

/// The default external editor (spec §14.5, ruling R5): one of 1B's openers, by the id
/// `listOpeners` gives it (`vscode`, `jetbrains-phpstorm`, …), or a custom command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum EditorChoice {
    Opener { id: String },
    /// A command template with `{file}`, `{line}` and `{repo}`.
    Custom { template: String },
}

/// Pinned trunk per repo (spec §8.2). Absent means `auto` (the default trunk).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PinSetting {
    Auto,
    Off,
    Ref { name: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SortMode {
    #[default]
    Tree,
    Recent,
}

/// Mirrors `ColumnPrefs` in `ui/src/graph/columns.ts` (graph `None` = fit the lanes).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ColumnPrefsDto {
    pub labels: u32,
    pub graph: Option<u32>,
    pub author: u32,
    pub date: u32,
    pub sha: u32,
    /// The Message column's dragged width; `None` = it fills the table (the default until dragged).
    pub message: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct RepoSettings {
    pub pin: Option<PinSetting>,
    pub columns: Option<ColumnPrefsDto>,
    /// Hidden graph columns: `labels` | `author` | `date` | `sha`.
    pub hidden_columns: Vec<String>,
    /// Sidebar section id → sort mode.
    pub sidebar_sort: BTreeMap<String, SortMode>,
    /// Collapsed sidebar sections (`section:<id>`) and folders (`<sectionId>:<folder/path>`).
    pub collapsed: Vec<String>,
    /// Overrides the profile's editor for this repo.
    pub editor: Option<EditorChoice>,
    // --- 4B T11 ---
    /// The sidebar MR/PR section's filter (spec #4 §2 "MR/PR list"); `None` is All.
    pub mr_filter: Option<crate::forge::MrFilter>,
    // --- end 4B T11 ---
    /// The remote whose forge project the repo's MRs/PRs target; `None` picks automatically.
    pub forge_target_remote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Profile {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub color: String,
    pub tabs: Vec<TabState>,
    pub active_tab: Option<String>,
    /// Oldest first; Ctrl+Shift+T pops the last.
    pub closed_tabs: Vec<ClosedTab>,
    /// Newest first.
    pub recent: Vec<RecentRepo>,
    pub repos_folder: Option<String>,
    /// The folders "Your repos" scans, merged. `None` = never set (see `migrate_repos_folders`).
    pub repos_folders: Option<Vec<String>>,
    pub editor: Option<EditorChoice>,
    /// Added to every git command as `-c include.path=<path>` (spec §14.2).
    pub extra_gitconfig: Option<String>,
    /// Host → forge type override (spec §14.4).
    pub host_overrides: BTreeMap<String, HostKind>,
    pub sidebar_width: u32,
    pub sidebar_narrow: bool,
    /// Sidebar panel id → its height in px when last resized (the weights the expanded panels share).
    pub sidebar_panels: BTreeMap<String, u32>,
    /// The details panel's width; `None` is the UI's default.
    pub right_panel_width: Option<u32>,
    // --- 4B T6 ---
    /// The left flyout's width (spec #4 §5); `None` is the UI's default.
    pub flyout_width: Option<u32>,
    // --- end 4B T6 ---
    /// Keyed by canonical repo path.
    pub repos: BTreeMap<String, RepoSettings>,
    // --- 4A T5 ---
    /// Forge accounts (spec #4 §3.2): host, kind, user, where the token is (never the token).
    /// Owned by the store (`set_forge_accounts`): left out of the TypeScript bindings, and
    /// `save_profile` keeps the store's copy whatever the UI sends, as `AppSettings.window`.
    #[ts(skip)]
    pub forge_accounts: Vec<crate::forge::accounts::ForgeAccount>,
    // --- end 4A T5 ---
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            version: PROFILE_VERSION,
            id: String::new(),
            name: String::new(),
            color: "#4d88ff".into(),
            tabs: Vec::new(),
            active_tab: None,
            closed_tabs: Vec::new(),
            recent: Vec::new(),
            repos_folder: None,
            repos_folders: None,
            editor: None,
            extra_gitconfig: None,
            host_overrides: BTreeMap::new(),
            sidebar_width: 240,
            sidebar_narrow: false,
            sidebar_panels: BTreeMap::new(),
            right_panel_width: None,
            // --- 4B T6 ---
            flyout_width: None,
            // --- end 4B T6 ---
            repos: BTreeMap::new(),
            forge_accounts: Vec::new(),
        }
    }
}

impl Profile {
    /// A profile that never chose "Your repos" folders gets its default clone folder, else the
    /// suggested `<home>/repos` when it exists. An explicit (even empty) list is left alone.
    pub fn migrate_repos_folders(&mut self, home: Option<&std::path::Path>) {
        if self.repos_folders.is_none() {
            let first = self.repos_folder.clone().or_else(|| crate::scan::suggest_repos_folder(home));
            self.repos_folders = Some(first.into_iter().collect());
        }
    }

    pub fn new(id: &str, name: &str, color: &str) -> Self {
        Self { id: id.into(), name: name.into(), color: color.into(), ..Default::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileMeta {
    pub id: String,
    pub name: String,
    pub color: String,
}

impl From<&Profile> for ProfileMeta {
    fn from(p: &Profile) -> Self {
        Self { id: p.id.clone(), name: p.name.clone(), color: p.color.clone() }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatePayload {
    pub settings: AppSettings,
    pub profile: Profile,
    pub profiles: Vec<ProfileMeta>,
}

#[derive(Default)]
struct Inner {
    settings: AppSettings,
    profiles: BTreeMap<String, Profile>,
    dirty_settings: bool,
    dirty_profiles: BTreeSet<String>,
    deleted: BTreeSet<String>,
    flush_scheduled: bool,
    /// `settings.json` exists but couldn't be read (EACCES, EIO): never written this session.
    settings_locked: bool,
    /// Profiles whose `profile.json` exists but couldn't be read: never written or removed.
    locked_profiles: BTreeSet<String>,
}

impl Inner {
    fn fresh() -> Self {
        let mut inner = Inner { dirty_settings: true, ..Default::default() };
        inner.ensure_default();
        inner
    }

    fn ensure_default(&mut self) {
        if self.profiles.is_empty() {
            self.profiles.insert(DEFAULT_PROFILE_ID.into(), Profile::new(DEFAULT_PROFILE_ID, "Default", "#4d88ff"));
            self.dirty_profiles.insert(DEFAULT_PROFILE_ID.into());
        }
        if !self.profiles.contains_key(&self.settings.active_profile) {
            self.settings.active_profile = self.profiles.keys().next().cloned().expect("at least one profile");
            self.dirty_settings = true;
        }
    }

    fn state(&self) -> StatePayload {
        StatePayload {
            settings: self.settings.clone(),
            profile: self.profiles[&self.settings.active_profile].clone(),
            profiles: self.profiles.values().map(ProfileMeta::from).collect(),
        }
    }
}

pub struct SettingsStore {
    root: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// Held for a whole flush (taking the dirty state and writing it), so two flushes (the
    /// debounce task and the exit flush) never interleave their writes or land out of order.
    writing: Mutex<()>,
    /// Failed flushes in a row (0 once one succeeds).
    save_failures: AtomicU32,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Renames an unusable file to `<name>.<tag>-<unix>` so the user's data is never lost.
fn set_aside(path: &Path, tag: &str) {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dest = path.with_file_name(format!("{name}.{tag}-{}", now_secs()));
    match std::fs::rename(path, &dest) {
        Ok(()) => tracing::warn!("set aside unusable settings file {} as {}", path.display(), dest.display()),
        Err(e) => tracing::warn!("could not set aside {}: {e}", path.display()),
    }
}

/// What reading one settings file found.
enum Loaded<T> {
    Found(T),
    /// No file, or an unusable one that was set aside: defaults, and the file is ours to write.
    Absent,
    /// The file exists but couldn't be read (EACCES, EIO, …): defaults, and it's left alone.
    Unreadable,
}

fn load_json<T: DeserializeOwned>(path: &Path, supported: u32) -> Loaded<T> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Absent,
        Err(e) => {
            tracing::warn!("cannot read {}: {e}; using defaults and leaving it untouched until restart", path.display());
            return Loaded::Unreadable;
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            set_aside(path, "corrupt");
            return Loaded::Absent;
        }
    };
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if version > u64::from(supported) {
        set_aside(path, &format!("v{version}"));
        return Loaded::Absent;
    }
    match serde_json::from_value(value) {
        Ok(v) => Loaded::Found(v),
        Err(_) => {
            set_aside(path, "corrupt");
            Loaded::Absent
        }
    }
}

fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), GbError> {
    let dir = path.parent().ok_or_else(|| GbError::other("settings path has no parent"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // A unique name per write (pid + counter): two instances (or two stores) on one directory
    // never share a temp inode, so a rename always installs one writer's complete JSON.
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let tmp = dir.join(format!(".{name}.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let json = serde_json::to_vec_pretty(value).map_err(|e| GbError::other(format!("serialize settings: {e}")))?;
    let written = (|| -> Result<(), GbError> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // The rename is durable only once the directory entry is.
    crate::platform::fs::sync_dir(dir)?;
    Ok(())
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(24).collect();
    if out.is_empty() { "profile".into() } else { out }
}

fn trim_profile(p: &mut Profile) {
    p.version = PROFILE_VERSION;
    if p.closed_tabs.len() > MAX_CLOSED_TABS {
        let excess = p.closed_tabs.len() - MAX_CLOSED_TABS;
        p.closed_tabs.drain(..excess);
    }
    if p.recent.len() > MAX_RECENT {
        let pinned: Vec<RecentRepo> = p.recent.iter().filter(|r| r.pinned).cloned().collect();
        let room = MAX_RECENT.saturating_sub(pinned.len());
        let mut kept: Vec<RecentRepo> = p.recent.iter().filter(|r| !r.pinned).take(room).cloned().collect();
        kept.extend(pinned);
        kept.sort_by_key(|r| std::cmp::Reverse(r.opened_at));
        p.recent = kept;
    }
}

impl SettingsStore {
    fn with(root: Option<PathBuf>, inner: Inner) -> Arc<Self> {
        Arc::new(Self { root, inner: Mutex::new(inner), writing: Mutex::new(()), save_failures: AtomicU32::new(0) })
    }

    /// Never touches the disk (the default for `Api::new`).
    pub fn in_memory() -> Arc<Self> {
        Self::with(None, Inner::fresh())
    }

    pub fn open(root: impl Into<PathBuf>) -> Arc<Self> {
        let root = root.into();
        let mut inner = match load_json::<AppSettings>(&root.join("settings.json"), SETTINGS_VERSION) {
            Loaded::Found(settings) => Inner { settings, ..Default::default() },
            Loaded::Absent => Inner { dirty_settings: true, ..Default::default() },
            Loaded::Unreadable => Inner { settings_locked: true, ..Default::default() },
        };
        if let Ok(dir) = std::fs::read_dir(root.join("profiles")) {
            for entry in dir.flatten() {
                // The directory name is the id; trust it over the file's content.
                let id = entry.file_name().to_string_lossy().into_owned();
                match load_json::<Profile>(&entry.path().join("profile.json"), PROFILE_VERSION) {
                    Loaded::Found(mut p) => {
                        p.id = id;
                        inner.profiles.insert(p.id.clone(), p);
                    }
                    Loaded::Absent => {}
                    Loaded::Unreadable => {
                        inner.locked_profiles.insert(id);
                    }
                }
            }
        }
        inner.ensure_default();
        Self::with(Some(root), inner)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("settings store poisoned")
    }

    pub fn state(&self) -> StatePayload {
        self.lock().state()
    }

    pub fn active_profile(&self) -> Profile {
        self.lock().state().profile
    }

    /// An unknown `active_profile` keeps the current one: switching goes through `switch_profile`.
    /// The window geometry is the store's own (see [`Self::save_window`]): the UI's copy is
    /// whatever it loaded at startup, so it never replaces the one saved since.
    pub fn save_settings(self: &Arc<Self>, mut settings: AppSettings) {
        settings.version = SETTINGS_VERSION;
        {
            let mut g = self.lock();
            if !g.profiles.contains_key(&settings.active_profile) {
                settings.active_profile = g.settings.active_profile.clone();
            }
            settings.window = g.settings.window.clone();
            g.settings = settings;
            g.dirty_settings = true;
        }
        self.schedule();
    }

    /// The main window's last saved geometry (K46).
    pub fn window(&self) -> Option<WindowGeometry> {
        self.lock().settings.window.clone()
    }

    /// The main window's geometry (K46), saved debounced like any other change. An unchanged
    /// value doesn't dirty the file.
    pub fn save_window(self: &Arc<Self>, window: WindowGeometry) {
        {
            let mut g = self.lock();
            if g.settings.window.as_ref() == Some(&window) {
                return;
            }
            g.settings.window = Some(window);
            g.dirty_settings = true;
        }
        self.schedule();
    }

    pub fn save_profile(self: &Arc<Self>, mut profile: Profile) -> Result<(), GbError> {
        trim_profile(&mut profile);
        {
            let mut g = self.lock();
            if !g.profiles.contains_key(&profile.id) {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("unknown profile {}", profile.id)));
            }
            // --- 4A T5: the store's accounts, not the UI's copy ---
            profile.forge_accounts = g.profiles.get(&profile.id).map(|p| p.forge_accounts.clone()).unwrap_or_default();
            // --- end 4A T5 ---
            g.dirty_profiles.insert(profile.id.clone());
            g.profiles.insert(profile.id.clone(), profile);
        }
        self.schedule();
        Ok(())
    }

    pub fn create_profile(self: &Arc<Self>, name: &str, color: &str) -> Result<ProfileMeta, GbError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "A profile needs a name"));
        }
        let id = format!("{}-{}", slug(name), random_hex(3));
        let profile = Profile::new(&id, name, color);
        let meta = ProfileMeta::from(&profile);
        {
            let mut g = self.lock();
            g.dirty_profiles.insert(id.clone());
            g.deleted.remove(&id);
            g.profiles.insert(id, profile);
        }
        self.schedule();
        Ok(meta)
    }

    pub fn switch_profile(self: &Arc<Self>, id: &str) -> Result<StatePayload, GbError> {
        let state = {
            let mut g = self.lock();
            if !g.profiles.contains_key(id) {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("unknown profile {id}")));
            }
            g.settings.active_profile = id.to_string();
            g.dirty_settings = true;
            g.state()
        };
        self.schedule();
        Ok(state)
    }

    pub fn delete_profile(self: &Arc<Self>, id: &str) -> Result<Vec<ProfileMeta>, GbError> {
        let left = {
            let mut g = self.lock();
            if g.settings.active_profile == id {
                return Err(GbError::new(GbErrorKind::InvalidInput, "Switch to another profile before deleting this one"));
            }
            if g.profiles.len() <= 1 || !g.profiles.contains_key(id) {
                return Err(GbError::new(GbErrorKind::InvalidInput, "That profile can't be deleted"));
            }
            g.profiles.remove(id);
            g.dirty_profiles.remove(id);
            g.deleted.insert(id.to_string());
            g.profiles.values().map(ProfileMeta::from).collect()
        };
        self.schedule();
        Ok(left)
    }

    // --- 4A T5: forge accounts ---
    /// One profile by id (its accounts, to delete their tokens with it).
    pub fn profile(&self, id: &str) -> Option<Profile> {
        self.lock().profiles.get(id).cloned()
    }

    pub fn forge_accounts(&self, profile: &str) -> Vec<crate::forge::accounts::ForgeAccount> {
        self.lock().profiles.get(profile).map(|p| p.forge_accounts.clone()).unwrap_or_default()
    }

    pub fn set_forge_accounts(self: &Arc<Self>, profile: &str, accounts: Vec<crate::forge::accounts::ForgeAccount>) -> Result<(), GbError> {
        self.update_forge_accounts(profile, |a| *a = accounts)
    }

    /// Reads, changes and schedules the save of `profile`'s accounts under one lock: two
    /// changes at once both land. `change` runs under the store's lock, so it mustn't call the
    /// store.
    pub fn update_forge_accounts<R>(self: &Arc<Self>, profile: &str, change: impl FnOnce(&mut Vec<crate::forge::accounts::ForgeAccount>) -> R) -> Result<R, GbError> {
        let r = {
            let mut g = self.lock();
            let p = g.profiles.get_mut(profile).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("unknown profile {profile}")))?;
            let r = change(&mut p.forge_accounts);
            g.dirty_profiles.insert(profile.to_string());
            r
        };
        self.schedule();
        Ok(r)
    }
    // --- end 4A T5 ---

    /// Failed flushes in a row; 0 once one succeeds.
    pub fn save_failures(&self) -> u32 {
        self.save_failures.load(Ordering::SeqCst)
    }

    /// Writes every dirty file now. Called by the debounce task and on app exit. A file that
    /// fails to write stays dirty, so the next flush retries it. A file that couldn't be read
    /// at open is never written or removed.
    pub fn flush_now(&self) -> Result<(), GbError> {
        let result = self.flush_inner();
        match &result {
            Ok(()) => self.save_failures.store(0, Ordering::SeqCst),
            Err(_) => {
                self.save_failures.fetch_add(1, Ordering::SeqCst);
            }
        }
        result
    }

    fn flush_inner(&self) -> Result<(), GbError> {
        let _writing = self.writing.lock().expect("settings writer poisoned");
        let (settings, profiles, deleted) = {
            let mut g = self.lock();
            g.flush_scheduled = false;
            let settings = std::mem::take(&mut g.dirty_settings).then(|| g.settings.clone()).filter(|_| !g.settings_locked);
            let ids = std::mem::take(&mut g.dirty_profiles);
            let profiles: Vec<Profile> = ids.iter().filter(|id| !g.locked_profiles.contains(*id)).filter_map(|id| g.profiles.get(id).cloned()).collect();
            let deleted: BTreeSet<String> = std::mem::take(&mut g.deleted).into_iter().filter(|id| !g.locked_profiles.contains(id)).collect();
            (settings, profiles, deleted)
        };
        let Some(root) = &self.root else { return Ok(()) };
        let mut first_err = None;
        if let Some(s) = settings
            && let Err(e) = write_atomic(&root.join("settings.json"), &s)
        {
            self.lock().dirty_settings = true;
            first_err.get_or_insert(e);
        }
        for p in profiles {
            if let Err(e) = write_atomic(&root.join("profiles").join(&p.id).join("profile.json"), &p) {
                self.lock().dirty_profiles.insert(p.id.clone());
                first_err.get_or_insert(e);
            }
        }
        for id in deleted {
            let dir = root.join("profiles").join(&id);
            if dir.exists()
                && let Err(e) = std::fs::remove_dir_all(&dir)
            {
                self.lock().deleted.insert(id);
                first_err.get_or_insert(e.into());
            }
        }
        first_err.map_or(Ok(()), Err)
    }

    /// Test harness only: forget everything and start from a fresh default state.
    pub fn reset(self: &Arc<Self>) {
        {
            let _writing = self.writing.lock().expect("settings writer poisoned");
            if let Some(root) = &self.root {
                let _ = std::fs::remove_dir_all(root.join("profiles"));
                let _ = std::fs::remove_file(root.join("settings.json"));
            }
            *self.lock() = Inner::fresh();
        }
        self.schedule();
    }

    fn schedule(self: &Arc<Self>) {
        self.schedule_in(SAVE_DEBOUNCE, 0);
    }

    /// A flush after `delay`. One that fails retries by itself `MAX_SAVE_RETRIES` times, backing
    /// off from 1 s (doubling, at most `MAX_RETRY_DELAY`); after that, the next change
    /// schedules again.
    fn schedule_in(self: &Arc<Self>, delay: Duration, attempt: u32) {
        if self.root.is_none() {
            return;
        }
        {
            let mut g = self.lock();
            if g.flush_scheduled {
                return;
            }
            g.flush_scheduled = true;
        }
        let me = Arc::clone(self);
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    tokio::time::sleep(delay).await;
                    // Blocking file I/O (fsync): off the async workers.
                    let flusher = me.clone();
                    let failed = match tokio::task::spawn_blocking(move || flusher.flush_now()).await {
                        Ok(Ok(())) => return,
                        Ok(Err(e)) => e.to_string(),
                        Err(e) => e.to_string(),
                    };
                    if attempt < MAX_SAVE_RETRIES {
                        let next = retry_delay(attempt);
                        tracing::warn!("saving settings failed: {failed}; retrying in {next:?}");
                        me.schedule_in(next, attempt + 1);
                    } else {
                        tracing::warn!("saving settings failed: {failed}; giving up until the next change");
                    }
                });
            }
            // No runtime (plain unit tests, app shutdown): write synchronously.
            Err(_) => {
                if let Err(e) = me.flush_now() {
                    tracing::warn!("saving settings failed: {e}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_keeps_its_active_worktree_and_old_tabs_have_none() {
        let t: TabState = serde_json::from_value(serde_json::json!({"id": "t", "kind": "repo", "path": "/r", "alias": null})).unwrap();
        assert_eq!(t.worktree, None);
        let t = TabState { worktree: Some("/r-x".into()), ..t };
        assert_eq!(serde_json::to_value(&t).unwrap()["worktree"], "/r-x");
    }

    #[test]
    fn debug_logging_defaults_off_for_older_files() {
        let mut v = serde_json::to_value(AppSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("debugLogging");
        assert!(!serde_json::from_value::<AppSettings>(v).unwrap().debug_logging);
    }

    fn read(p: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    }

    #[test]
    fn concurrent_saves_from_two_stores_always_leave_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let a = SettingsStore::open(dir.path());
        let b = SettingsStore::open(dir.path());
        let path = dir.path().join("settings.json");
        let writers: Vec<_> = [a, b]
            .into_iter()
            .map(|store| {
                std::thread::spawn(move || {
                    for i in 0..40 {
                        let mut s = store.state().settings;
                        s.commit_limit = 100 + i;
                        store.save_settings(s);
                        store.flush_now().unwrap();
                    }
                })
            })
            .collect();
        let reader = {
            let path = path.clone();
            std::thread::spawn(move || {
                for _ in 0..400 {
                    if let Ok(bytes) = std::fs::read(&path) {
                        serde_json::from_slice::<serde_json::Value>(&bytes).expect("settings.json is always valid JSON");
                    }
                }
            })
        };
        for w in writers {
            w.join().unwrap();
        }
        reader.join().unwrap();
        read(&path);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty(), "no temp file is left behind: {leftovers:?}");
    }

    #[test]
    fn empty_dir_gets_a_default_profile() {
        let dir = tempfile::tempdir().unwrap();
        let st = SettingsStore::open(dir.path()).state();
        assert_eq!(st.profiles.len(), 1);
        assert_eq!(st.profile.id, DEFAULT_PROFILE_ID);
        assert_eq!(st.profile.name, "Default");
        assert_eq!(st.settings.active_profile, DEFAULT_PROFILE_ID);
        assert_eq!(st.settings.fetch_interval_secs, 60);
        assert_eq!(st.settings.commit_limit, 2000);
        assert_eq!(st.settings.commit_limit as usize, crate::snapshot::DEFAULT_COMMIT_LIMIT);
        assert!(st.settings.prune);
    }

    fn geometry() -> WindowGeometry {
        WindowGeometry {
            x: Some(1940.0),
            y: Some(32.0),
            width: 1400.0,
            height: 860.0,
            maximized: true,
            monitor: Some(MonitorIdentity { name: Some("DP-1".into()), x: 1920.0, y: 0.0, width: 2560.0, height: 1440.0 }),
        }
    }

    /// K46: a settings file from before the window field loads with none, and writes none back.
    #[test]
    fn an_old_settings_file_without_the_window_loads() {
        let old = r#"{"version":1,"activeProfile":"default","theme":"default-dark","editorFontSize":13,"fetchIntervalSecs":60,"prune":true,"commitLimit":2000,"dateFormat":"ymd12h","gravatar":true}"#;
        let s: AppSettings = serde_json::from_str(old).unwrap();
        assert_eq!(s.window, None);
        assert_eq!(s, AppSettings::default());
        assert!(serde_json::to_value(&s).unwrap().get("window").is_none());
    }

    #[test]
    fn the_window_geometry_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path());
        store.save_window(geometry());
        store.flush_now().unwrap();
        let json = read(&dir.path().join("settings.json"));
        assert_eq!(json["window"]["width"], 1400.0);
        assert_eq!(json["window"]["monitor"]["name"], "DP-1");
        assert_eq!(SettingsStore::open(dir.path()).state().settings.window, Some(geometry()));

        // Wayland: no position, no monitor name; partial objects fill in from defaults.
        let partial: WindowGeometry = serde_json::from_str(r#"{"width":900,"height":600}"#).unwrap();
        assert_eq!(partial, WindowGeometry { width: 900.0, height: 600.0, ..Default::default() });
    }

    /// The UI's settings carry the geometry it loaded at startup; saving them must not undo a
    /// geometry the app saved since.
    #[test]
    fn saving_the_uis_settings_keeps_the_stores_window() {
        let store = SettingsStore::in_memory();
        let from_ui = store.state().settings;
        store.save_window(geometry());
        let mut changed = from_ui.clone();
        changed.theme = "light".into();
        store.save_settings(changed);
        let s = store.state().settings;
        assert_eq!(s.theme, "light");
        assert_eq!(s.window, Some(geometry()));
    }

    #[test]
    fn flush_writes_versioned_files_that_reload() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path());
        let mut s = store.state().settings;
        s.commit_limit = 500;
        store.save_settings(s);
        let mut p = store.active_profile();
        p.repos_folder = Some("/home/u/repos".into());
        p.right_panel_width = Some(420);
        p.repos.insert("/r".into(), RepoSettings { columns: Some(ColumnPrefsDto { labels: 200, graph: None, author: 160, date: 170, sha: 90, message: Some(333) }), ..Default::default() });
        store.save_profile(p).unwrap();
        store.flush_now().unwrap();
        let settings = read(&dir.path().join("settings.json"));
        assert_eq!(settings["version"], SETTINGS_VERSION);
        assert_eq!(settings["commitLimit"], 500);
        let profile = read(&dir.path().join("profiles/default/profile.json"));
        assert_eq!(profile["version"], PROFILE_VERSION);
        assert_eq!(profile["reposFolder"], "/home/u/repos");
        assert_eq!(profile["repos"]["/r"]["columns"]["sha"], 90);
        assert_eq!(profile["repos"]["/r"]["columns"]["message"], 333);
        let again = SettingsStore::open(dir.path()).state();
        assert_eq!(again.settings.commit_limit, 500);
        assert_eq!(again.profile.repos_folder.as_deref(), Some("/home/u/repos"));
        assert_eq!(again.profile.right_panel_width, Some(420));
        assert_eq!(again.profile.repos["/r"].columns.as_ref().unwrap().sha, 90, "a saved SHA width survives a reload");
    }

    #[test]
    fn repos_folders_round_trip_and_migrate_once() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("repos")).unwrap();
        let store = SettingsStore::open(dir.path());
        let mut p = store.active_profile();
        assert_eq!(p.repos_folders, None, "an existing profile has no folders yet");
        p.migrate_repos_folders(Some(home.path()));
        assert_eq!(p.repos_folders, Some(vec![home.path().join("repos").display().to_string()]));
        p.repos_folders = Some(vec!["/a".into(), "/b".into()]);
        p.migrate_repos_folders(Some(home.path()));
        assert_eq!(p.repos_folders.as_deref(), Some(&["/a".to_string(), "/b".to_string()][..]), "set lists are kept");
        p.repos_folders = Some(vec![]);
        p.migrate_repos_folders(Some(home.path()));
        assert_eq!(p.repos_folders, Some(vec![]), "a deliberately emptied list stays empty");
        p.repos_folders = Some(vec!["/a".into(), "/b".into()]);
        store.save_profile(p).unwrap();
        store.flush_now().unwrap();
        assert_eq!(SettingsStore::open(dir.path()).state().profile.repos_folders, Some(vec!["/a".into(), "/b".into()]));
        let mut q = Profile { repos_folder: Some("/clone".into()), ..Default::default() };
        q.migrate_repos_folders(Some(home.path()));
        assert_eq!(q.repos_folders, Some(vec!["/clone".into()]), "the default clone folder wins");
        let mut none = Profile::default();
        none.migrate_repos_folders(None);
        assert_eq!(none.repos_folders, Some(vec![]));
    }

    #[tokio::test(start_paused = true)]
    async fn saves_are_debounced() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path());
        let mut s = store.state().settings;
        s.commit_limit = 120;
        store.save_settings(s.clone());
        s.commit_limit = 130;
        store.save_settings(s);
        assert!(!dir.path().join("settings.json").exists(), "nothing written before the debounce elapses");
        // A sleep, not `advance`: the paused clock jumps to each pending timer in turn, so the
        // store's debounce timer (armed when its task first runs) fires first.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!dir.path().join("settings.json").exists(), "nor 100 ms in");
        tokio::time::sleep(SAVE_DEBOUNCE).await;
        // The write itself runs on the blocking pool, in real time; the rename makes it appear whole.
        let path = dir.path().join("settings.json");
        for _ in 0..500 {
            tokio::task::yield_now().await;
            if path.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(read(&path)["commitLimit"], 130);
    }

    #[test]
    fn corrupt_file_is_set_aside_and_defaults_load() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), b"{ not json").unwrap();
        let st = SettingsStore::open(dir.path()).state();
        assert_eq!(st.settings.commit_limit, 2000);
        let aside: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("settings.json.corrupt-")).collect();
        assert_eq!(aside.len(), 1, "the unreadable file is kept, not overwritten");
    }

    #[test]
    fn corrupt_profile_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let pdir = dir.path().join("profiles/default");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(pdir.join("profile.json"), br#"{"version": 1, "tabs": "not a list"}"#).unwrap();
        let st = SettingsStore::open(dir.path()).state();
        assert_eq!(st.profile.id, DEFAULT_PROFILE_ID);
        assert!(std::fs::read_dir(&pdir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("profile.json.corrupt-")));
    }

    /// A file that exists but can't be read (EACCES here; EIO alike) is never written over: the
    /// store runs on defaults for it and leaves it alone for the session.
    #[test]
    fn unreadable_files_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let pdir = dir.path().join("profiles/default");
        std::fs::create_dir_all(&pdir).unwrap();
        let profile = pdir.join("profile.json");
        std::fs::write(&settings, br#"{"version": 1, "commitLimit": 500}"#).unwrap();
        std::fs::write(&profile, br#"{"version": 1, "name": "Mine"}"#).unwrap();
        let lock = |p: &Path, mode| crate::platform::fs::set_mode(p, mode).unwrap();
        lock(&settings, 0o000);
        lock(&profile, 0o000);
        if std::fs::read(&settings).is_ok() {
            eprintln!("skipped: running with permission to read a mode-000 file (root?)");
            lock(&settings, 0o644);
            lock(&profile, 0o644);
            return;
        }
        let store = SettingsStore::open(dir.path());
        let st = store.state();
        assert_eq!(st.settings.commit_limit, 2000, "defaults stand in for the unreadable file");
        let mut s = st.settings;
        s.commit_limit = 700;
        store.save_settings(s);
        let mut p = store.active_profile();
        p.repos_folder = Some("/x".into());
        store.save_profile(p).unwrap();
        store.flush_now().unwrap();
        lock(&settings, 0o644);
        lock(&profile, 0o644);
        assert_eq!(read(&settings)["commitLimit"], 500, "the user's settings file is untouched");
        assert_eq!(read(&profile)["name"], "Mine", "the user's profile file is untouched");
        let names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.iter().filter(|n| n.starts_with("settings.json")).count(), 1, "{names:?}");
    }

    /// A failed flush retries by itself, backing off, and gives up after `MAX_SAVE_RETRIES`
    /// (the next change schedules again), so it can't spin.
    #[tokio::test(start_paused = true)]
    async fn a_failed_save_retries_with_backoff_then_stops() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("cfg");
        let store = SettingsStore::open(&root);
        // A plain file where the directory should be: every write fails.
        std::fs::write(&root, b"").unwrap();
        let mut s = store.state().settings;
        s.commit_limit = 321;
        store.save_settings(s);
        let failures = |n: u32| {
            let store = store.clone();
            async move {
                // Up to 200 s on the paused clock (all retries take ~31 s); the writes themselves
                // run on the blocking pool in real time.
                for _ in 0..2000 {
                    if store.save_failures() >= n {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    std::thread::sleep(Duration::from_millis(1));
                }
                panic!("expected {n} failed saves, saw {}", store.save_failures());
            }
        };
        failures(1).await;
        failures(2).await;
        // Fixed before the next retry: it lands without any further change.
        std::fs::remove_file(&root).unwrap();
        for _ in 0..500 {
            if root.join("settings.json").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(read(&root.join("settings.json"))["commitLimit"], 321);
        assert_eq!(store.save_failures(), 0);

        // Broken for good: a bounded number of attempts, then quiet.
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::write(&root, b"").unwrap();
        let mut s = store.state().settings;
        s.commit_limit = 322;
        store.save_settings(s);
        failures(MAX_SAVE_RETRIES + 1).await;
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(store.save_failures(), MAX_SAVE_RETRIES + 1);
    }

    #[test]
    fn newer_version_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), br#"{"version": 99, "commitLimit": 500}"#).unwrap();
        let st = SettingsStore::open(dir.path()).state();
        assert_eq!(st.settings.commit_limit, 2000);
        assert!(std::fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("settings.json.v99-")));
    }

    #[test]
    fn missing_fields_take_defaults_and_unknown_fields_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        // `zoom` and `diffMode` are unknown here: those view preferences stay in the UI's
        // localStorage (ruling R4).
        std::fs::write(dir.path().join("settings.json"), br#"{"version": 1, "commitLimit": 500, "zoom": 150, "someFutureField": true}"#).unwrap();
        let st = SettingsStore::open(dir.path()).state();
        assert_eq!(st.settings.commit_limit, 500);
        assert_eq!(st.settings.theme, "default-dark");
    }

    #[test]
    fn graph_color_overrides_default_empty_and_round_trip() {
        let mut v = serde_json::to_value(AppSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("graphColorOverrides");
        let s: AppSettings = serde_json::from_value(v).unwrap();
        assert!(s.graph_color_overrides.is_empty());
        assert_eq!(s.theme, "default-dark");

        let mut s = AppSettings::default();
        s.graph_color_overrides.insert("nord".into(), vec![Some("#123456".into()), None]);
        let back: AppSettings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.graph_color_overrides["nord"], vec![Some("#123456".to_string()), None]);
    }

    #[test]
    fn closed_tabs_are_capped_keeping_the_newest() {
        let store = SettingsStore::in_memory();
        let mut p = store.active_profile();
        p.closed_tabs = (0..25).map(|i| ClosedTab { path: format!("/r/{i}"), alias: None, index: 0 }).collect();
        store.save_profile(p).unwrap();
        let p = store.active_profile();
        assert_eq!(p.closed_tabs.len(), MAX_CLOSED_TABS);
        assert_eq!(p.closed_tabs.last().unwrap().path, "/r/24");
        assert_eq!(p.closed_tabs.first().unwrap().path, "/r/5");
    }

    #[test]
    fn recent_repos_keep_pinned_and_cap_the_rest() {
        let store = SettingsStore::in_memory();
        let mut p = store.active_profile();
        p.recent = (0..60).map(|i| RecentRepo { path: format!("/r/{i}"), name: format!("r{i}"), pinned: i == 59, opened_at: 1000 - i }).collect();
        store.save_profile(p).unwrap();
        let p = store.active_profile();
        assert_eq!(p.recent.len(), MAX_RECENT);
        assert!(p.recent.iter().any(|r| r.path == "/r/59" && r.pinned), "pinned entries survive the cap");
    }

    #[test]
    fn profiles_create_switch_delete() {
        let store = SettingsStore::in_memory();
        let work = store.create_profile("Work stuff", "#ff0000").unwrap();
        assert!(work.id.starts_with("work-stuff-"), "{}", work.id);
        assert!(store.create_profile("   ", "#fff").is_err());
        let st = store.switch_profile(&work.id).unwrap();
        assert_eq!(st.profile.id, work.id);
        assert_eq!(st.settings.active_profile, work.id);
        assert_eq!(store.delete_profile(&work.id).unwrap_err().kind, GbErrorKind::InvalidInput, "can't delete the active profile");
        store.switch_profile(DEFAULT_PROFILE_ID).unwrap();
        let left = store.delete_profile(&work.id).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(store.delete_profile(DEFAULT_PROFILE_ID).unwrap_err().kind, GbErrorKind::InvalidInput);
        assert!(store.switch_profile("nope").is_err());
    }

    #[test]
    fn saving_an_unknown_profile_is_rejected() {
        let store = SettingsStore::in_memory();
        let p = Profile::new("ghost", "Ghost", "#000");
        assert_eq!(store.save_profile(p).unwrap_err().kind, GbErrorKind::InvalidInput);
    }

    #[test]
    fn saving_settings_never_points_at_an_unknown_profile() {
        let store = SettingsStore::in_memory();
        let mut s = store.state().settings;
        s.active_profile = "../../etc".into();
        store.save_settings(s);
        assert_eq!(store.state().settings.active_profile, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn deleted_profile_directory_is_removed_on_flush() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path());
        let meta = store.create_profile("Temp", "#123456").unwrap();
        store.flush_now().unwrap();
        assert!(dir.path().join("profiles").join(&meta.id).join("profile.json").exists());
        store.delete_profile(&meta.id).unwrap();
        store.flush_now().unwrap();
        assert!(!dir.path().join("profiles").join(&meta.id).exists());
    }

    #[test]
    fn reset_restores_a_fresh_default_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path());
        let other = store.create_profile("Other", "#111").unwrap();
        store.flush_now().unwrap();
        assert!(dir.path().join("profiles").join(&other.id).exists());
        store.reset();
        let st = store.state();
        assert_eq!(st.profiles.len(), 1);
        assert!(st.profile.tabs.is_empty());
        assert!(!dir.path().join("profiles").join(&other.id).exists());
    }

    #[test]
    fn ts_shapes_are_camel_case() {
        let v = serde_json::to_value(PinSetting::Ref { name: "refs/remotes/origin/main".into() }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "ref", "name": "refs/remotes/origin/main"}));
        assert_eq!(serde_json::to_value(PinSetting::Off).unwrap(), serde_json::json!({"kind": "off"}));
        assert_eq!(serde_json::to_value(DateFormat::Ymd24h).unwrap(), "ymd24h");
        // The editor setting is a 1B opener id (from `listOpeners`) or a custom template (R5).
        assert_eq!(serde_json::to_value(EditorChoice::Opener { id: "jetbrains-phpstorm".into() }).unwrap(), serde_json::json!({"kind": "opener", "id": "jetbrains-phpstorm"}));
        assert_eq!(
            serde_json::to_value(EditorChoice::Custom { template: "subl {file}:{line}".into() }).unwrap(),
            serde_json::json!({"kind": "custom", "template": "subl {file}:{line}"})
        );
    }

    /// Spec #2 §12.1: the Fetch/Pull button's default is Fetch All; files without it load so.
    #[test]
    fn the_sync_button_defaults_to_fetch_all() {
        assert_eq!(AppSettings::default().sync_button, SyncButtonMode::FetchAll);
        let s: AppSettings = serde_json::from_value(serde_json::json!({"version": SETTINGS_VERSION})).unwrap();
        assert_eq!(s.sync_button, SyncButtonMode::FetchAll);
        assert_eq!(serde_json::to_value(SyncButtonMode::PullFfOrMerge).unwrap(), "pullFfOrMerge");
    }
}
