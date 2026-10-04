//! The single command surface shared by the Tauri app and the test harness.

use crate::askpass::AskpassServer;
use crate::avatar::{AvatarPayload, AvatarProvider};
use crate::blob::{diff_contents, is_dotgit, safe_join, working_tree_encoding, Side};
use crate::commit::{parse_commit, parse_oid, read_commit_message};
use crate::details::{commit_details, read_commit, remotes};
use crate::diff::{file_list, DiffSpec};
use crate::error::{GbError, GbErrorKind};
use crate::events::{AppEvent, EventBus};
use crate::git::GitCli;
use crate::links::{validate_web_url, UrlOpener};
use crate::log::CommandLog;
use crate::openers::chooser::Chooser;
use crate::openers::folder_picker::FolderPicker;
use crate::ops::{OpId, OpRegistry};
use crate::openers::{template_opener, DetectEnv, Launcher, Opener, OpenerKind, OpenerPayload, CHOOSER_ID, CUSTOM_ID};
use crate::payload::{BlobSource, RepoSummary, SignatureKind, SignaturePayload};
use crate::scan::ScannedRepo;
use crate::settings::{AppSettings, EditorChoice, PinSetting, Profile, SettingsStore};
use crate::signature::signature_status;
use crate::snapshot::{build_graph_with_text, BuildOptions};
use crate::tree::tree_files;
use crate::worktree::list_worktrees;
use gix::ObjectId;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, OnceCell};
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(tag = "method", content = "params", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum Request {
    OpenRepo { path: String },
    /// A frontend error or notice for the log file (spec §16.2).
    LogFrontend { level: crate::logging::FrontendLevel, message: String, stack: Option<String> },
    SetDebugLogging { debug: bool },
    /// The log directory, or `null` where there is no file logging (the harness).
    LogsDir,
    /// Plain-text diagnostics for "Copy diagnostics" (secrets scrubbed).
    Diagnostics { ui: crate::diagnostics::UiDiagnostics },
    /// Shows the log directory in the file manager.
    OpenLogsFolder,
    /// The graph snapshot. `pin` (the repo's pin setting): `auto` or absent is the default
    /// trunk, `off` no trunk, `ref` that ref (spec §8.3).
    /// `rescan`: run status for every worktree instead of reusing the cached counts (tab
    /// activation, spec §4.4). The counts are only reused while the repo is watched; an
    /// unwatched repo always re-reads status.
    Graph {
        repo: u32,
        limit: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        pin: Option<PinSetting>,
        #[serde(default)]
        #[ts(optional)]
        rescan: Option<bool>,
        /// The tab's active worktree (spec #2 §11.2): laid out as the open one. Absent: the
        /// handle's own (the main worktree).
        #[serde(default)]
        #[ts(optional)]
        active: Option<String>,
    },
    CommandLog,
    LaunchRepo,
    /// Takes (and clears) the paths later launches forwarded (the single-instance guard, R19) that
    /// the UI hasn't opened yet: each one is returned once, by whichever call comes first.
    TakeOpenRequests,
    /// The full message of one commit (read-only, via gix): loaded lazily by the graph's
    /// full-message tooltip and the details panel, instead of shipping every body with the graph.
    CommitMessage { repo: u32, id: String },
    /// The details panel's header: parents, author, committer, co-authors, signed (spec §9.1).
    CommitDetails { repo: u32, id: String },
    /// Every remote's parsed host and path, `origin` first (for forge links, spec §14.4).
    Remotes { repo: u32 },
    /// The changed-file list for a commit, a compare, a worktree diff or WIP (spec §9.3, §9.4, §8.6).
    FileList { repo: u32, spec: DiffSpec },
    /// Both sides of one file diff, decoded for the viewer (spec §10.2, §10.4).
    DiffContents { repo: u32, path: String, old: BlobSource, new: BlobSource, force: bool },
    /// Both sides of a binary file as hex dumps, each capped at `hex::HEX_CAP` bytes (UX round 2,
    /// lane I): `HexDumpPayload`.
    HexDump { repo: u32, path: String, old: BlobSource, new: BlobSource },
    /// Every file at a commit, sorted bytewise ("View all files", spec §9.3; the palette, §11.2).
    TreeFiles { repo: u32, id: String },
    /// UX G.2: the worktree's tracked files, sorted bytewise ("View all files" on the WIP row).
    WorktreeFiles { repo: u32, worktree: String },
    /// The commit's signature status, verified through the user's own gpg/ssh config and cached
    /// per repository and commit id for the process lifetime (spec §9.1).
    Signature { repo: u32, id: String },
    /// A cached avatar for an email, or `null` (the UI shows initials; spec §14.3).
    Avatar { email: String },
    /// Opens an `http(s)` link in the default browser (spec §14.4); returns `null`.
    OpenUrl { url: String },
    /// The detected external editors and the file manager, for "Open in…" (spec §14.5, H9).
    ListOpeners,
    /// `ListOpeners` for one repository: the `custom` entry is listed only when that
    /// repository's effective editor (its own setting, else the profile's) is a Custom command.
    ListOpenersFor { repo: u32 },
    /// Checks a custom editor command template the way an open would build it (the shell-code
    /// guard, then the program lookup), so the settings can show a refusal inline. Returns `null`
    /// when the template would open, else the error.
    ValidateEditorTemplate { template: String },
    /// Opens `path` (relative to `worktree`, one of this repo's worktrees) in the opener `id`d by
    /// `opener` (or `"other"`, the Open With chooser), at `line` when it supports one. `source` is
    /// the version shown: the working-tree file (`worktree`, or none), or a stored one (`object`,
    /// `atCommit`), which opens as a read-only copy (spec §14.5). The file manager shows the
    /// working-tree folder (its nearest existing parent if it's gone). Returns `null`.
    OpenIn {
        repo: u32,
        worktree: String,
        path: String,
        line: Option<u32>,
        opener: String,
        #[serde(default)]
        source: Option<BlobSource>,
        /// A WIP file's stored version, opened (as a copy) when the working-tree file is gone.
        #[serde(default)]
        fallback: Option<BlobSource>,
    },
    /// App settings, the active profile and the profile list (spec §14.1): `StatePayload`.
    LoadState,
    /// Replaces the app settings (written debounced); returns `null`.
    SaveSettings { settings: AppSettings },
    /// Replaces one existing profile (written debounced); returns `null`.
    SaveProfile { profile: Profile },
    /// A new, empty profile: `ProfileMeta`.
    CreateProfile { name: String, color: String },
    /// Makes `id` the active profile: the new `StatePayload`.
    SwitchProfile { id: String },
    /// Deletes an inactive profile: the remaining `ProfileMeta[]`.
    DeleteProfile { id: String },
    /// The user's answer to a credential prompt (`authWaiting`); `null` cancels it. Returns `null`.
    AuthAnswer {
        #[ts(type = "number")]
        prompt: u64,
        answer: Option<String>,
    },
    /// Cancels a running network operation; unknown ids are ignored. Returns `null`.
    CancelOp {
        #[ts(type = "number")]
        op: u64,
    },
    /// `git fetch --all` (spec §15): `FetchOutcome`. `background` = GitBolt-started (never prompts).
    Fetch {
        repo: u32,
        background: bool,
        #[serde(default)]
        #[ts(optional)]
        remote: Option<String>,
    },
    // --- 4A T7 ---
    /// `git remote add <name> <url>` (spec #4 §4 4A): `WriteResult<null>`. Not journaled.
    AddRemote { repo: u32, worktree: String, name: String, url: String },
    // --- end 4A T7 ---
    /// Clones `url` into the absolute `dest` (spec §13) and opens it: `RepoSummary`.
    Clone { url: String, dest: String },
    /// Every remote with its redacted URL, and the main worktree of a linked one: `RepoInfoPayload`.
    RepoInfo { repo: u32 },
    /// Branches, remotes, worktrees, stashes and tags (spec §6.4): `SidebarPayload`.
    Sidebar { repo: u32 },
    /// When a remote-tracking ref was last pushed (or else last fetched): `LastPushPayload | null`.
    LastPush { repo: u32, remote_ref: String },
    /// GitBolt's and git's versions (spec §6.5): `AppInfoPayload`.
    AppInfo,
    /// The system folder picker, starting in `start`: the picked folder, or `null` (cancelled,
    /// or no picker on this desktop: the UI falls back to a typed path).
    PickFolder { start: Option<String> },
    /// The repositories in `root` (absolute), two levels deep, newest first: `ScannedRepo[]`.
    /// Cached per root; `refresh` rescans.
    ScanRepos { root: String, refresh: bool },
    /// `ScanRepos` over several folders in parallel, merged and de-duplicated by path:
    /// `ScannedRepo[]`. Each folder is cached on its own; a folder that fails to scan is skipped.
    ScanFolders { roots: Vec<String>, refresh: bool },
    /// `~/repos` when it exists, else `null`.
    SuggestReposFolder,
    /// Starts the file watcher for this repo (the active tab's, spec §4.4); idempotent. `null`.
    WatchRepo { repo: u32 },
    /// Stops this repo's watcher; `null`.
    UnwatchRepo { repo: u32 },
    /// Stops every watcher (the UI's startup reset: none survive a reload); `null`.
    UnwatchAll,
    /// The action queue (spec #2 §3.6): `QueueStatePayload`.
    QueueState { repo: u32 },
    /// A queued item's ×: `true` if it was still queued.
    QueueRemove {
        repo: u32,
        #[ts(type = "number")]
        id: u64,
    },
    /// Run the "not run" items after a stop, each re-resolving.
    QueueResume { repo: u32 },
    /// Drop the "not run" items.
    QueueClear { repo: u32 },
    /// Find (spec §8.7): the loaded window's commits whose message contains `query`
    /// (case-insensitive), or, for 4+ hex characters, whose id starts with it: `string[]`.
    FindText { repo: u32, query: String },
    /// The loaded window's commits that touched a path containing `query` (case-insensitive;
    /// `[]` under 2 characters). The first call per window builds the path index: `string[]`.
    FindPaths { repo: u32, query: String },
    /// Whether `sha` is in the first 10,000 commits, and the window that would include it:
    /// `LocateResult`. Not a commit: `notFound`.
    LocateCommit { repo: u32, sha: String },
    /// "Search older history": commits outside the window whose message or paths match `query`,
    /// newest first: `HistoryHit[]`.
    SearchHistory { repo: u32, query: String },
    // --- Undo / redo (2A T10) ---
    /// Undo the newest journal entry, `entry` being the one the toolbar showed (spec #2 §5.4):
    /// `WriteResult<UndoOutcome>`. `confirm`: "Undo anyway", each moved ref as the prompt showed it.
    Undo {
        repo: u32,
        worktree: String,
        #[ts(type = "number")]
        entry: u64,
        #[serde(default)]
        #[ts(optional, type = "Record<string, string | null>")]
        confirm: Option<std::collections::BTreeMap<String, Option<String>>>,
        /// The clean-restore warning (§6.2) was confirmed (2A T11).
        #[serde(default)]
        #[ts(optional)]
        confirm_autostash: Option<bool>,
        // --- 2C T7 ---
        /// "Apply without restoring what was staged?" was confirmed (a stash's undo applies it).
        #[serde(default)]
        #[ts(optional)]
        without_index: Option<bool>,
        // --- end 2C T7 ---
        // --- 3B T2 ---
        /// "Undo the stopped cherry-pick?" was confirmed (`ErrorDetail::UndoStoppedPick`): the
        /// stopped "without committing" pick's changes are discarded.
        #[serde(default)]
        #[ts(optional)]
        confirm_discard: Option<bool>,
        // --- end 3B T2 ---
    },
    Redo {
        repo: u32,
        worktree: String,
        #[ts(type = "number")]
        entry: u64,
        /// The clean-restore warning (§6.2) was confirmed (2A T11).
        #[serde(default)]
        #[ts(optional)]
        confirm_autostash: Option<bool>,
        // --- 2C T7 ---
        /// "Apply without restoring what was staged?" was confirmed (a pop's redo applies it).
        #[serde(default)]
        #[ts(optional)]
        without_index: Option<bool>,
        // --- end 2C T7 ---
    },
    // --- UX Y: the Undo dropdown ---
    /// Undo `entry` from the Undo dropdown (`JournalState.history`): the newest is Undo itself;
    /// an older one only when it's independent of every later entry, as its own new entry, with
    /// no Redo: `WriteResult<UndoOutcome>`. Refused, with nothing changed, when anything it
    /// changed has changed since.
    UndoEntry {
        repo: u32,
        worktree: String,
        #[ts(type = "number")]
        entry: u64,
        /// The clean-restore warning (§6.2) was confirmed.
        #[serde(default)]
        #[ts(optional)]
        confirm_autostash: Option<bool>,
    },
    /// The Undo dropdown's rows, newest first: `HistoryRow[]` (each older one's dependency check
    /// runs here, when the dropdown opens, never with every `JournalState`).
    JournalHistory { repo: u32, worktree: String },
    // --- end UX Y ---
    /// What Undo/Redo and the banners show for a worktree (§5.5).
    JournalState { repo: u32, worktree: String },
    // --- end undo / redo (2A T10) ---
    // --- Autostash banners (2A T11) ---
    /// A banner's Apply, or a recovery banner's Restore (spec #2 §6.4, §5.1): `WriteResult<null>`.
    /// `withoutIndex`: after "Apply without restoring what was staged?".
    ApplyKeptStash {
        repo: u32,
        worktree: String,
        #[ts(type = "number")]
        entry: u64,
        #[serde(default)]
        #[ts(optional)]
        without_index: Option<bool>,
        /// A recovery Restore's clean-restore warning (§6.2) was confirmed.
        #[serde(default)]
        #[ts(optional)]
        confirm_autostash: Option<bool>,
    },
    /// A banner's × (the stash stays), or its Drop stash: `JournalState`.
    DismissBanner {
        repo: u32,
        worktree: String,
        #[ts(type = "number")]
        entry: u64,
        #[serde(default)]
        #[ts(optional)]
        drop_stash: Option<bool>,
    },
    // --- end autostash banners (2A T11) ---
    // --- The pause (2D T2) ---
    /// A worktree's paused merge or rebase ended outside GitBolt (Deviation 4): settles it (its
    /// journal entry, its autostash). `WriteResult<null>`; nothing happens when none is over.
    SettlePaused { repo: u32, worktree: String },
    // --- end the pause (2D T2) ---
    // --- 2D T12: conflicted files ---
    /// A conflicted file for the merge tool (read; spec #2 §13.3): `ConflictFilePayload`, or
    /// `null` when the path isn't conflicted.
    ConflictFile { repo: u32, worktree: String, path: String },
    // --- end 2D T12 ---
    // --- 2D T15 ---
    /// Resolve a conflicted file (spec #2 §13.3): `WriteResult<null>`. `base`: the hash
    /// `conflictFile` reported (a `Text` save is `Stale` if the file changed since).
    /// `confirmMarkers`: Mark resolved although conflict markers remain. `confirmDiscard`: take a
    /// side over the user's edits to the file.
    ResolveFile {
        repo: u32,
        worktree: String,
        path: String,
        resolution: crate::write::conflict::Resolution,
        #[serde(default)]
        #[ts(optional)]
        base: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        confirm_markers: Option<bool>,
        #[serde(default)]
        #[ts(optional)]
        confirm_discard: Option<bool>,
    },
    // --- end 2D T15 ---
    /// A test-only write (spec #2 §18 2A): tests and the harness only; the app doesn't know it.
    #[cfg(any(test, feature = "testing"))]
    TestWrite {
        repo: u32,
        worktree: String,
        #[serde(default)]
        expect: crate::write::types::Expect,
        intent: crate::write::test_intents::TestIntent,
    },
    /// Remove stale lock (spec #2 §14): unlinks `path` (a worktree's `index.lock`) only if its
    /// mtime is still `mtime_ms`, the one the error saw.
    RemoveIndexLock {
        repo: u32,
        path: String,
        #[ts(type = "number")]
        mtime_ms: i64,
        /// The lock's inode and device when the error saw it.
        #[ts(type = "number")]
        ino: u64,
        #[ts(type = "number")]
        dev: u64,
    },
    // --- 2B T6: save a working file (spec #2 §7.5); UX round 2 G.2: journaled, renamed ---
    /// `WriteResult<SaveOutcome>`; `Stale` when the file's bytes no longer hash to `base`.
    WriteWorktreeFile { repo: u32, worktree: String, path: String, text: String, base: String },
    // --- end 2B T6 ---
    // --- UX round 3 O.1 ---
    /// A new, empty file at `path` (folders made as needed): `WriteResult<SaveOutcome>`. Refused
    /// when it exists or isn't plainly inside the worktree. Journaled: Undo removes it.
    CreateWorktreeFile { repo: u32, worktree: String, path: String },
    // --- end UX round 3 O.1 ---
    // --- 2B T1: stage and unstage (spec #2 §7.2) ---
    /// Stage `paths` (`git add -A`): `WriteResult<null>`. An immediate write (§3.6), not
    /// journaled; the staging undo log records it (§7.6).
    Stage { repo: u32, worktree: String, paths: Vec<String> },
    /// Unstage `paths`; `oldPaths`: a rename's sources, unstaged with it (§7.2).
    Unstage {
        repo: u32,
        worktree: String,
        paths: Vec<String>,
        #[serde(default)]
        #[ts(optional)]
        old_paths: Option<Vec<String>>,
    },
    StageAll { repo: u32, worktree: String },
    UnstageAll { repo: u32, worktree: String },
    // --- end 2B T1 ---
    // --- 2B T2: the staging undo log (spec #2 §7.6) ---
    /// Undo the worktree's newest staging step: `WriteResult<null>`. `Stale` when the index changed
    /// outside staging (the log is then cleared).
    StagingUndo { repo: u32, worktree: String },
    StagingRedo { repo: u32, worktree: String },
    /// The staging buttons' state when the WIP panel opens (read): `StagingUndoState`.
    StagingState { repo: u32, worktree: String },
    // --- end 2B T2 ---
    // --- 2B T5: commit (spec #2 §8) ---
    /// Commit (or amend) what's staged, or with `stageAll` everything (§8.1): `WriteResult<CommitOutcome>`.
    /// A queued write; hooks and signing are git's.
    Commit {
        repo: u32,
        worktree: String,
        summary: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        amend: bool,
        #[serde(default)]
        stage_all: bool,
        #[serde(default)]
        expect: crate::write::types::Expect,
    },
    /// §8.3: `git commit --amend --only -F -` with `message`: `WriteResult<CommitOutcome>`.
    EditHeadMessage {
        repo: u32,
        worktree: String,
        message: String,
        #[serde(default)]
        expect: crate::write::types::Expect,
    },
    /// The HEAD pencil's force-push note (read): the upstream's short name when HEAD is on it, else `null`.
    HeadOnUpstream { repo: u32, worktree: String },
    // --- end 2B T5 ---
    // --- 2C T3: branches ---
    /// Create branch here / the toolbar Branch (spec #2 §9.1): `WriteResult<null>`.
    CreateBranch {
        repo: u32,
        worktree: String,
        name: String,
        start: String,
        #[serde(default)]
        #[ts(optional)]
        start_ref: Option<String>,
        checkout: bool,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        #[ts(optional)]
        confirm_autostash: Option<bool>,
    },
    /// Rename (§9.1): `git branch -m`. `WriteResult<null>`.
    RenameBranch {
        repo: u32,
        worktree: String,
        from: String,
        to: String,
        #[serde(default)]
        expect: crate::write::types::Expect,
    },
    /// Set upstream (§9.1); `upstream: null` unsets it. Not journaled: `WriteResult<null>`.
    SetUpstream { repo: u32, worktree: String, branch: String, upstream: Option<crate::write::branch::UpstreamTarget> },
    // --- end 2C T3 ---
    // --- 2C T8: worktrees ---
    /// Create worktree (spec #2 §11.1): `WriteResult<WorktreeAdded>`. Not journaled.
    WorktreeAdd { repo: u32, worktree: String, path: String, branch: crate::write::worktree::WorktreeBranch },
    /// Remove (§11.1): `WriteResult<WorktreeRemoveOutcome>`. Runs in the main worktree.
    WorktreeRemove {
        repo: u32,
        worktree: String,
        path: String,
        #[serde(default)]
        force: bool,
    },
    /// The create dialog's default folder (§11.1), a read: `string`.
    SuggestWorktreePath { repo: u32, branch: String },
    // --- end 2C T8 ---
    // --- 2C T4: delete ---
    /// `Delete | Local | Remote | Both |` (spec #2 §9.2): `WriteResult<DeleteOutcome>`.
    DeleteBranch {
        repo: u32,
        worktree: String,
        branch: String,
        local: bool,
        remote: Option<crate::write::branch_delete::RemoteBranchRef>,
        #[serde(default)]
        force: bool,
        #[serde(default)]
        expect: crate::write::types::Expect,
    },
    // --- end 2C T4 ---
    // --- 2D T9: integrate ---
    /// Merge `target` into HEAD's branch, or rebase HEAD's branch onto it (spec #2 §13.1):
    /// `WriteResult<IntegrateOutcome>`. `updateRefs`: the stacked-branches checkbox (absent: git's
    /// own `rebase.updateRefs`).
    Integrate {
        repo: u32,
        worktree: String,
        kind: crate::write::integrate::IntegrateKind,
        target: String,
        #[serde(default)]
        #[ts(optional)]
        update_refs: Option<bool>,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
    },
    /// The commit panel's Continue, Skip, Abort for a rebase (§13.2): `WriteResult<IntegrateOutcome>`.
    /// `message`: what Continue commits the stopped pick with; absent, git's own.
    RebaseControl {
        repo: u32,
        worktree: String,
        action: crate::write::rebase::RebaseAction,
        #[serde(default)]
        #[ts(optional)]
        message: Option<String>,
    },
    // --- end 2D T9 ---
    /// The same for a cherry-pick or revert in progress (ux round 1): `WriteResult<PickOutcome>`.
    PickControl {
        repo: u32,
        worktree: String,
        action: crate::write::rebase::RebaseAction,
        #[serde(default)]
        #[ts(optional)]
        message: Option<String>,
    },
    // --- 3B T1: cherry-pick and revert ---
    /// Cherry-pick `oids` onto HEAD's branch, oldest first (spec #3 §3.7): `WriteResult<SequenceOutcome>`.
    /// `oids`: newest first, as the graph lists them. `noCommit`: "without committing".
    CherryPick {
        repo: u32,
        worktree: String,
        oids: Vec<String>,
        #[serde(default)]
        #[ts(as = "Option<bool>", optional)]
        no_commit: bool,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
    },
    /// Revert `oids` on HEAD's branch, newest first (spec #3 §3.7), the same way.
    Revert {
        repo: u32,
        worktree: String,
        oids: Vec<String>,
        #[serde(default)]
        #[ts(as = "Option<bool>", optional)]
        no_commit: bool,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
    },
    // --- end 3B T1 ---
    /// Who a commit here is made as (read; ux round 1): `CommitIdentity`, or `null` when git
    /// has none (it would refuse the commit).
    CommitIdentity { repo: u32, worktree: String },
    // --- 2D T10: integrate ---
    /// What a merge or rebase of `target` would do (read; spec #2 §13.1): relation, predicted
    /// conflicts, stacked branches.
    IntegratePreview { repo: u32, worktree: String, kind: crate::write::integrate::IntegrateKind, target: String },
    // --- 3C T1 ---
    /// The interactive rebase editor's plan (read; spec #3 §3.3): `RebasePlanPayload`.
    RebasePlan { repo: u32, worktree: String, branch: String, base: String },
    // --- end 3C T1 ---
    // --- 3C T7 ---
    /// Conflict prediction for the editor's plan (read; spec #3 §3.2): `Prediction`.
    PredictRebase { repo: u32, worktree: String, base: String, rows: Vec<crate::write::irebase::types::RebaseRow> },
    // --- end 3C T7 ---
    // --- 3C T3 ---
    /// The interactive rebase editor's Start (spec #3 §3.3): `WriteResult<IntegrateOutcome>`. `rows`
    /// newest first; `expect`: full ref → oid of every branch involved and of the base's ref.
    InteractiveRebase {
        repo: u32,
        worktree: String,
        branch: String,
        base: String,
        #[serde(default)]
        expect: std::collections::BTreeMap<String, String>,
        rows: Vec<crate::write::irebase::types::RebaseRow>,
        #[serde(default)]
        chips: Vec<crate::write::irebase::types::ChipPlan>,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
    },
    // --- end 3C T3 ---
    // --- 3C T6 ---
    /// "Edit message" on an older commit of the current branch (spec #3 §3.6): `WriteResult<IntegrateOutcome>`.
    RewordCommit {
        repo: u32,
        worktree: String,
        oid: String,
        message: String,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
    },
    // --- end 3C T6 ---
    /// "Fast-forward Y to X" (§13.1): `WriteResult<IntegrateOutcome>`.
    FastForward {
        repo: u32,
        worktree: String,
        branch: String,
        to: String,
        #[serde(default)]
        expect: crate::write::types::Expect,
    },
    /// The commit panel's Abort merge (§13.2): `WriteResult<IntegrateOutcome>`.
    MergeAbort { repo: u32, worktree: String },
    // --- end 2D T10 ---
    // --- 2B T3: hunks and lines (spec #2 §7.3) ---
    /// A WIP file's hunks from git, with the blobs they came from (read-only): `HunksPayload`.
    WipHunks { repo: u32, worktree: String, path: String, staged: bool },
    /// Stage (or, `staged`, unstage) hunks or lines of one file: `WriteResult<null>`. `Stale` when
    /// `base` is no longer the file's.
    StagePatch {
        repo: u32,
        worktree: String,
        path: String,
        staged: bool,
        selection: crate::write::patch::StageSelection,
        base: crate::hunks::WipBase,
    },
    // --- end 2B T3 ---
    // --- 2B T10 ---
    /// How many changed lines `selection` would stage (or unstage) and discard, after the
    /// no-newline tie, for the line bar's label (read-only): `SelectionLines`.
    SelectionLines { repo: u32, worktree: String, path: String, staged: bool, selection: crate::write::patch::StageSelection },
    // --- end 2B T10 ---
    // --- 2B T4: discards (spec #2 §7.2–§7.4) ---
    /// Discard files, hunks or lines, every unstaged change, or everything: `WriteResult<null>`,
    /// journaled with `before` and `after` snapshots, so Undo and Redo restore them.
    Discard { repo: u32, worktree: String, scope: crate::write::discard::DiscardScope },
    // --- end 2B T4 ---
    // --- 2D T11: push ---
    /// Push `branch` (spec #2 §12.3): `WriteResult<PushOutcome>`. `target` + `setUpstream`: the
    /// no-upstream dialog. `lease`: a confirmed force-with-lease.
    Push {
        repo: u32,
        worktree: String,
        branch: String,
        #[serde(default)]
        #[ts(optional)]
        target: Option<crate::write::sync::PushTarget>,
        #[serde(default)]
        #[ts(optional)]
        set_upstream: Option<bool>,
        #[serde(default)]
        #[ts(optional)]
        lease: Option<crate::write::sync::Lease>,
        #[serde(default)]
        expect: crate::write::types::Expect,
    },
    // --- end 2D T11 ---
    // --- 2D T14: pull ---
    /// Pull (spec #2 §12.2): `WriteResult<PullOutcome>`. `branch`: the Sync row on a branch that
    /// isn't checked out (ff-only; plan 2D Deviation 13).
    Pull {
        repo: u32,
        worktree: String,
        #[serde(default)]
        #[ts(optional)]
        branch: Option<String>,
        mode: crate::write::sync::PullMode,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        confirm: crate::write::types::Confirm,
    },
    // --- end 2D T14 ---
    // --- 2C T5: checkout ---
    /// Checkout (spec #2 §9.3): `WriteResult<CheckoutOutcome>`.
    Checkout {
        repo: u32,
        worktree: String,
        target: crate::write::checkout::CheckoutTarget,
        #[serde(default)]
        #[ts(optional)]
        on_diverged: Option<crate::write::checkout::OnDiverged>,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        #[ts(optional)]
        confirm_autostash: Option<bool>,
    },
    // --- end 2C T5 ---
    // --- 2C T7: stashes ---
    /// The toolbar Stash, the WIP header's and the WIP row menu's (spec #2 §10):
    /// `WriteResult<StashPushOutcome>`. `message`: the whole WIP draft ("" for the default).
    StashPush { repo: u32, worktree: String, message: String },
    /// Apply, or Pop (§10): `WriteResult<StashApplyOutcome>`. `withoutIndex`: after "Apply
    /// without restoring what was staged?". A gone `oid` is `NotFound` "That stash is gone".
    StashApply {
        repo: u32,
        worktree: String,
        oid: String,
        pop: bool,
        #[serde(default)]
        #[ts(optional)]
        without_index: Option<bool>,
    },
    /// Delete (§10): `WriteResult<null>`.
    StashDrop { repo: u32, worktree: String, oid: String },
    // --- end 2C T7 ---
    // --- 2C T6: reset ---
    /// `Reset X to this commit | Soft | Mixed | Hard |` (spec #2 §9.4): `WriteResult<null>`.
    /// A hard reset over changes fails `DirtyWorktree` with `ResetDiscards` until it's sent
    /// again with `discard` (the "discard changes to N files?" was confirmed).
    Reset {
        repo: u32,
        worktree: String,
        to: String,
        mode: crate::write::reset::ResetMode,
        #[serde(default)]
        expect: crate::write::types::Expect,
        #[serde(default)]
        #[ts(optional)]
        discard: Option<bool>,
    },
    // --- end 2C T6 ---
    // --- 3A T2: File History and Blame (spec #3 §3.10) ---
    /// One page of `path`'s history, newest first (read): `FileHistoryPage`. `rev`: where the
    /// walk starts (absent: the worktree's HEAD); `skip`: the rows already loaded; `limit`: the
    /// page size (the UI's is 200, at most 1000).
    FileHistory {
        repo: u32,
        worktree: String,
        path: String,
        #[serde(default)]
        #[ts(optional)]
        rev: Option<String>,
        #[serde(default)]
        skip: u32,
        limit: u32,
    },
    /// `path` at `rev`, line by line (read): `BlamePayload`.
    Blame { repo: u32, worktree: String, rev: String, path: String },
    // --- end 3A T2 ---
    // --- 3A T3: restore a file from a commit (spec #3 §3.8) ---
    /// `git restore --source=<sha> --worktree -- <path>`, or a path `sha` lacks deleted: unstaged,
    /// the index untouched, journaled with before/after snapshots (`WriteResult<null>`). Over the
    /// file's own changes it fails `DirtyWorktree` with `RestoreOverChanges` until sent with `confirm`.
    RestoreFile {
        repo: u32,
        worktree: String,
        sha: String,
        path: String,
        #[serde(default)]
        #[ts(optional)]
        confirm: Option<bool>,
    },
    // --- end 3A T3 ---
    // --- 3B T3: tags ---
    /// Create tag here (spec #3 §3.9): lightweight, or annotated with `message`: `WriteResult<null>`.
    CreateTag {
        repo: u32,
        worktree: String,
        name: String,
        target: String,
        #[serde(default)]
        #[ts(optional)]
        message: Option<String>,
    },
    /// `Delete | Local | Remote | Both |` on a tag: `WriteResult<null>`.
    DeleteTag {
        repo: u32,
        worktree: String,
        name: String,
        #[serde(default)]
        local: bool,
        #[serde(default)]
        #[ts(optional)]
        remote: Option<String>,
    },
    /// Push one tag, or every tag (`tag` absent), to `remote`: `WriteResult<TagPushOutcome>`.
    PushTags {
        repo: u32,
        worktree: String,
        remote: String,
        #[serde(default)]
        #[ts(optional)]
        tag: Option<String>,
    },
    // --- end 3B T3 ---
    // --- 4A T5 ---
    /// The active profile's forge accounts, with what their last requests said (no network):
    /// `ForgeAccountView[]`. Empty when this build has no forges.
    ForgeAccounts,
    /// Checks `token` against `host` (its user, its write scope, GitLab's version) and keeps it in
    /// the token store (spec #4 §3.2): `ForgeAccountView`. Replaces the host's account if it has one.
    AddForgeAccount {
        host: String,
        kind: crate::forge::ForgeKind,
        #[ts(type = "string")]
        token: crate::redact::Secret,
    },
    /// Removes the account and deletes its token: `null`.
    RemoveForgeAccount { host: String },
    /// The forge's prefilled "new token" page for `host`: a URL for `openUrl`.
    ForgeTokenPage { host: String, kind: crate::forge::ForgeKind },
    // --- end 4A T5 ---
    // --- 4A T6 ---
    /// Every remote with its forge project, and the remote MRs/PRs target (spec #4 §3.3):
    /// `RepoProjects`. `refresh` asks the forges again (conditional requests).
    ForgeRepoProjects { repo: u32, refresh: bool },
    /// The project settings of `remote`'s project (squash, merge methods, delete source branch):
    /// `ForgeProjectSettings`.
    ForgeProjectSettings { repo: u32, remote: String },
    /// `remote`'s project's forks, newest first: `ForgeProject[]`.
    ForgeForks { repo: u32, remote: String },
    // --- end 4A T6 ---
}

impl Request {
    /// Whether it writes to a repository (spec #2 §17.1).
    pub fn is_write(&self) -> bool {
        match self {
            // --- 4A T5: settings and the token store, never the repository ---
            Request::ForgeAccounts | Request::AddForgeAccount { .. } | Request::RemoveForgeAccount { .. } | Request::ForgeTokenPage { .. } => false,
            // --- end 4A T5 ---
            // --- 4A T6 ---
            Request::ForgeRepoProjects { .. } | Request::ForgeProjectSettings { .. } | Request::ForgeForks { .. } => false,
            // --- end 4A T6 ---
            // Remote-tracking refs and objects.
            // --- 4A T7 ---
            Request::AddRemote { .. } => true,
            // --- end 4A T7 ---
            Request::Fetch { .. } | Request::Clone { .. } | Request::RemoveIndexLock { .. } => true,
            Request::WriteWorktreeFile { .. } | Request::CreateWorktreeFile { .. } => true,
            // 2B T1.
            Request::Stage { .. } | Request::Unstage { .. } | Request::StageAll { .. } | Request::UnstageAll { .. } => true,
            // 2B T2.
            Request::StagingUndo { .. } | Request::StagingRedo { .. } => true,
            Request::StagingState { .. } => false,
            #[cfg(any(test, feature = "testing"))]
            Request::TestWrite { .. } => true,
            // Undo / redo (2A T10); a journal file isn't the repository.
            Request::Undo { .. } | Request::Redo { .. } => true,
            Request::UndoEntry { .. } => true, // UX Y
            Request::JournalHistory { .. } => false,
            Request::JournalState { .. } => false,
            // Autostash banners (2A T11): × only edits the journal; Drop stash writes.
            Request::ApplyKeptStash { .. } => true,
            Request::DismissBanner { drop_stash, .. } => drop_stash.unwrap_or(false),
            // The pause (2D T2): a write (its settle may restore an autostash).
            Request::SettlePaused { .. } => true,
            // --- 2D T12 ---
            Request::ConflictFile { .. } => false,
            // --- 3A T2 ---
            Request::FileHistory { .. } | Request::Blame { .. } => false,
            // --- end 3A T2 ---
            // --- 3A T3 ---
            Request::RestoreFile { .. } => true,
            // --- end 3A T3 ---
            // --- end 2D T12 ---
            // --- 2D T15 ---
            Request::ResolveFile { .. } => true,
            // --- end 2D T15 ---
            // --- 2B T5 ---
            Request::Commit { .. } | Request::EditHeadMessage { .. } => true,
            Request::HeadOnUpstream { .. } => false,
            // --- end 2B T5 ---
            // --- 2C T3 ---
            Request::CreateBranch { .. } | Request::RenameBranch { .. } | Request::SetUpstream { .. } => true,
            // --- end 2C T3 ---
            // --- 2C T8 ---
            Request::WorktreeAdd { .. } | Request::WorktreeRemove { .. } => true,
            Request::SuggestWorktreePath { .. } => false,
            // --- end 2C T8 ---
            // --- 2C T4 ---
            Request::DeleteBranch { .. } => true,
            // --- end 2C T4 ---
            // --- 2D T9: integrate ---
            Request::Integrate { .. } | Request::RebaseControl { .. } | Request::PickControl { .. } => true,
            // --- 3B T1 ---
            Request::CherryPick { .. } | Request::Revert { .. } => true,
            // --- end 3B T1 ---
            Request::CommitIdentity { .. } => false,
            // --- end 2D T9 ---
            // --- 2D T10: integrate ---
            Request::FastForward { .. } | Request::MergeAbort { .. } => true,
            Request::IntegratePreview { .. } => false,
            Request::RebasePlan { .. } => false,
            Request::PredictRebase { .. } => false,
            // --- 3C T3 ---
            Request::InteractiveRebase { .. } => true,
            // --- end 3C T3 ---
            // --- 3C T6 ---
            Request::RewordCommit { .. } => true,
            // --- end 3C T6 ---
            // --- end 2D T10 ---
            // --- 2B T3 ---
            Request::StagePatch { .. } => true,
            Request::WipHunks { .. } => false,
            // --- end 2B T3 ---
            // --- 2B T10 ---
            Request::SelectionLines { .. } => false,
            // --- end 2B T10 ---
            // --- 2B T4 ---
            Request::Discard { .. } => true,
            // --- end 2B T4 ---
            // --- 2D T11 ---
            Request::Push { .. } => true,
            // --- end 2D T11 ---
            // --- 2D T14 ---
            Request::Pull { .. } => true,
            // --- end 2D T14 ---
            // --- 2C T5: checkout ---
            Request::Checkout { .. } => true,
            // --- end 2C T5 ---
            // --- 2C T7 ---
            Request::StashPush { .. } | Request::StashApply { .. } | Request::StashDrop { .. } => true,
            // --- end 2C T7 ---
            // --- 2C T6: reset ---
            Request::Reset { .. } => true,
            // --- end 2C T6 ---
            // --- 3B T3 ---
            Request::CreateTag { .. } | Request::DeleteTag { .. } | Request::PushTags { .. } => true,
            // --- end 3B T3 ---
            Request::OpenRepo { .. }
            | Request::LogFrontend { .. }
            | Request::SetDebugLogging { .. }
            | Request::LogsDir
            | Request::Diagnostics { .. }
            | Request::OpenLogsFolder
            | Request::Graph { .. }
            | Request::CommandLog
            | Request::LaunchRepo
            | Request::TakeOpenRequests
            | Request::CommitMessage { .. }
            | Request::CommitDetails { .. }
            | Request::Remotes { .. }
            | Request::FileList { .. }
            | Request::DiffContents { .. }
            | Request::HexDump { .. }
            | Request::TreeFiles { .. }
            | Request::WorktreeFiles { .. }
            | Request::Signature { .. }
            | Request::Avatar { .. }
            | Request::OpenUrl { .. }
            | Request::ListOpeners
            | Request::ListOpenersFor { .. }
            | Request::ValidateEditorTemplate { .. }
            | Request::OpenIn { .. }
            | Request::LoadState
            | Request::SaveSettings { .. }
            | Request::SaveProfile { .. }
            | Request::CreateProfile { .. }
            | Request::SwitchProfile { .. }
            | Request::DeleteProfile { .. }
            | Request::AuthAnswer { .. }
            | Request::CancelOp { .. }
            | Request::RepoInfo { .. }
            | Request::Sidebar { .. }
            | Request::LastPush { .. }
            | Request::AppInfo
            | Request::PickFolder { .. }
            | Request::ScanRepos { .. }
            | Request::ScanFolders { .. }
            | Request::SuggestReposFolder
            | Request::WatchRepo { .. }
            | Request::UnwatchRepo { .. }
            | Request::UnwatchAll
            | Request::FindText { .. }
            | Request::FindPaths { .. }
            | Request::LocateCommit { .. }
            | Request::SearchHistory { .. }
            // The queue's own controls write nothing; the writes they let run are their own requests.
            | Request::QueueState { .. }
            | Request::QueueRemove { .. }
            | Request::QueueResume { .. }
            | Request::QueueClear { .. } => false,
        }
    }
}

pub(crate) struct RepoHandle {
    pub(crate) repo: gix::ThreadSafeRepository,
    pub(crate) workdir: PathBuf,
    /// The working directory's folder name (the fetch op's label).
    pub(crate) name: String,
    /// The canonical common dir: the write lock and queue key (spec #2 §3.5).
    pub(crate) common_dir: PathBuf,
    /// Each worktree's last status (the watcher keeps it fresh while the tab is active).
    pub(crate) wip: Arc<crate::snapshot::WipCache>,
    /// The last `graph` window's find state (spec §8.7); `None` until the first graph.
    pub(crate) snapshot: Mutex<Option<Arc<crate::find::FindSnapshot>>>,
    /// The last graph walk, reused while nothing it walked from moved (spec #2 §11.2): every
    /// tab on the repository shares it, whichever worktree it has active.
    pub(crate) walk: Arc<Mutex<Option<crate::snapshot::WalkCache>>>,
}

/// Decides whether a write may touch a repository (spec #2 §17.2), given its canonical common
/// dir. The app has none; the harness allows fixture repositories only (`fixture_guard`).
pub type WriteGuard = Arc<dyn Fn(&Path) -> Result<(), GbError> + Send + Sync>;

/// The harness's refusal (spec #2 §17.2, verbatim).
pub const FIXTURE_ONLY: &str = "writes are limited to fixture repositories";

pub struct Api {
    pub(crate) cli: GitCli,
    pub(crate) launch_repo: Option<String>,
    pub(crate) repos: Mutex<HashMap<u32, Arc<RepoHandle>>>,
    pub(crate) next_id: AtomicU32,
    /// git's version, checked (and cached) by the first `openRepo` (or `appInfo`).
    pub(crate) version: OnceCell<(u32, u32, u32)>,
    /// Signature verdicts, keyed by (the repository's git directory, commit id), for the process
    /// lifetime (spec §9.1). Keyed on the repository too, not just the commit: the signature
    /// bytes never change, but git's verdict depends on the keyring, trust database and
    /// repo-local config (`gpg.ssh.allowedSignersFile`, `gpg.program`), which differ per
    /// repository. Only a definitive verdict is cached (verified, unverified, bad, expired):
    /// `unknownKey` means "couldn't verify with what's configured right now" (a missing key, or
    /// `gpg.ssh.allowedSignersFile` not set yet) and must be re-checked every time, since the
    /// user can fix their configuration between calls without the commit changing at all.
    pub(crate) signatures: Mutex<HashMap<(PathBuf, ObjectId), SignaturePayload>>,
    pub(crate) avatars: Option<Arc<dyn AvatarProvider>>,
    // --- 4A T5 ---
    /// Forge accounts and providers (spec #4 §3.2). `None` (most tests): the account list is
    /// empty and the other forge requests refuse.
    pub(crate) forge: Option<Arc<crate::forge::hub::ForgeHub>>,
    // --- end 4A T5 ---
    pub(crate) url_opener: Option<UrlOpener>,
    pub(crate) openers: Option<Arc<OpenerSource>>,
    /// "Other…" (H32): the system's Open With chooser; listed only when set.
    pub(crate) chooser: Option<Chooser>,
    /// How long a detection answers `listOpeners` before the next one re-detects (the menu asks
    /// each time it opens, so a newly installed editor shows up without a restart).
    pub(crate) opener_refresh: Duration,
    /// Old versions' read-only copies (spec §14.5).
    pub(crate) open_cache: Option<PathBuf>,
    /// Backend → frontend events (spec §4.3), forwarded by the app and the harness.
    pub(crate) bus: EventBus,
    /// Settings and profiles (spec §14.3); in memory unless `with_store` gives it a directory.
    pub(crate) store: Arc<SettingsStore>,
    /// Running network operations (fetch, clone): ids, cancellation, may they prompt.
    pub(crate) ops: Arc<OpRegistry>,
    /// The per-session askpass socket (spec §5.4), once `start_askpass` ran.
    pub(crate) askpass: std::sync::OnceLock<Arc<AskpassServer>>,
    /// The system folder picker (spec §13); `pickFolder` answers `null` without one.
    pub(crate) folder_picker: Option<FolderPicker>,
    /// The user's home, for the suggested repos folder (`~/repos`).
    pub(crate) home: Option<PathBuf>,
    /// `scanRepos` results per root, until a `refresh`.
    pub(crate) scans: Mutex<HashMap<String, Vec<ScannedRepo>>>,
    /// The live file watchers by repo id: only the active tab's (spec §4.4).
    pub(crate) watchers: Mutex<HashMap<u32, crate::watch::RepoWatcher>>,
    /// The file-logging handle (`None` in the harness and in tests).
    pub(crate) log: Option<crate::logging::LogHandle>,
    /// The runtime versions shown in diagnostics.
    pub(crate) runtime_info: String,
    /// Paths later launches forwarded (`request_open`), until `takeOpenRequests` takes them.
    pub(crate) open_requests: Mutex<Vec<String>>,
    /// Asked before every write; `None` (the app) allows all.
    pub(crate) write_guard: Option<WriteGuard>,
    /// Each repository's write lock and action queue, by canonical common dir: shared by every
    /// handle (worktree tab) of it (spec #2 §3.5, §3.6).
    pub(crate) write_locks: Mutex<HashMap<PathBuf, Arc<crate::write::queue::RepoWrites>>>,
    /// GitBolt's data dir (spec #2 §5.1): the journal and temp index files. A private temp dir
    /// unless `with_data_dir` (only the app passes `paths::data_dir()`).
    pub(crate) data_dir: PathBuf,
    data_tmp: Option<tempfile::TempDir>,
    pub(crate) clock: crate::journal::Clock,
    /// The staging undo logs (spec #2 §7.6), in memory: a restart clears them.
    pub(crate) staging: crate::journal::staging::StagingLogs,
    /// The repositories (canonical common dirs) whose journals this process has recovered
    /// pending entries in: once, at the first open.
    pub(crate) recovered: Mutex<std::collections::HashSet<PathBuf>>,
    /// This instance's journal owner lock (`<data>/owners/`), taken at its first journaled
    /// write and held for the `Api`'s life.
    owner: Mutex<Option<crate::journal::OwnerLock>>,
    /// The hard limit on one autostash step (spec #2 §6, 2A T11 review N3); tests shorten it.
    pub(crate) autostash_timeout: Duration,
}

/// The most forwarded paths kept for a UI that never takes them (the oldest go first).
const MAX_OPEN_REQUESTS: usize = 64;

/// "Open in…": how to find the openers and how to launch one (the app spawns; the harness and
/// tests record). `found` is the last successful detection and when it ran: a failed one (a
/// panic) is never cached, so the next call retries. The lock is held only to read or store it,
/// never while detecting; `refreshing` keeps one background re-detection at a time.
pub(crate) struct OpenerSource {
    detect: Arc<dyn Fn() -> Vec<Opener> + Send + Sync>,
    launcher: Launcher,
    found: Mutex<Option<(Instant, Arc<Vec<Opener>>)>>,
    refreshing: std::sync::atomic::AtomicBool,
}

impl OpenerSource {
    /// Detects now, on the blocking pool, and caches the result.
    async fn detect_now(&self) -> Result<Arc<Vec<Opener>>, GbError> {
        let detect = self.detect.clone();
        let list = Arc::new(tokio::task::spawn_blocking(move || detect()).await.map_err(|e| GbError::other(format!("couldn't look for editors: {e}")))?);
        *self.found.lock().expect("openers poisoned") = Some((Instant::now(), list.clone()));
        Ok(list)
    }
}

/// Signature statuses kept per process; past this the cache starts over.
const SIGNATURE_CACHE_MAX: usize = 4096;

/// Whether a signature status may be remembered for the process lifetime. An unknown key and an
/// unverified signature both change when the user trusts the key (or adds it to the allowed
/// signers), so neither is cached: the badge follows the next look.
fn cacheable(kind: SignatureKind) -> bool {
    !matches!(kind, SignatureKind::UnknownKey | SignatureKind::Unverified)
}

/// `opener_refresh` unless changed.
const OPENER_REFRESH: Duration = Duration::from_secs(30);

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, GbError> {
    serde_json::to_value(v).map_err(|e| GbError::other(format!("serialize: {e}")))
}

/// The request's variant name only: its Debug text up to the first non-identifier character, so
/// parameters (paths, an askpass answer) never reach a log line.
#[cfg(test)]
fn variant_name(req: &Request) -> String {
    name_in(&format!("{req:?}"))
}

fn name_in(debug: &str) -> String {
    debug.split(|c: char| !(c.is_alphanumeric() || c == '_')).next().unwrap_or("?").to_string()
}

// --- UX R1 C.4: failed writes in the log ---
/// A write request's repository id and worktree, read from its Debug text (writes name them
/// `repo: 3` and `worktree: "/abs/path"`): what a failure's message is made relative to.
fn write_scope(debug: &str) -> (Option<u32>, Option<PathBuf>) {
    static REPO: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\brepo: (\d+)").unwrap());
    static WORKTREE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#"\bworktree: (?:Some\()?"((?:[^"\\]|\\.)*)""#).unwrap());
    let repo = REPO.captures(debug).and_then(|c| c[1].parse().ok());
    let worktree = WORKTREE.captures(debug).map(|c| PathBuf::from(c[1].replace("\\\"", "\"").replace("\\\\", "\\")));
    (repo, worktree)
}

/// `message` with the absolute paths in it made relative: under a root (the worktree, the
/// repository's) `<root>/a/b` reads `a/b` and `<root>` alone `.`; the git dir reads `.git`;
/// anything else under the home folder starts with `~`. Then redacted.
fn relative_message(message: &str, roots: &[PathBuf], git_dir: Option<&Path>) -> String {
    let mut subs: Vec<(String, &str)> = Vec::new();
    if let Some(g) = git_dir {
        subs.push((g.display().to_string(), ".git"));
    }
    subs.extend(roots.iter().map(|r| (r.display().to_string(), ".")));
    if let Some(home) = dirs::home_dir() {
        subs.push((home.display().to_string(), "~"));
    }
    // Longest first: the git dir inside the worktree is `.git`, not `./.git`.
    subs.retain(|(from, _)| from.len() > 1);
    subs.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
    let mut out = message.to_string();
    for (from, to) in subs {
        let mut next = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(i) = rest.find(&from) {
            next.push_str(&rest[..i]);
            let after = &rest[i + from.len()..];
            // A whole path only: `/r` isn't in `/r2`.
            let whole = after.chars().next().is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '-' | '_' | '.')));
            if !whole {
                next.push_str(&from);
                rest = after;
            } else if to == "." && after.starts_with('/') {
                rest = &after[1..];
            } else {
                next.push_str(to);
                rest = after;
            }
        }
        next.push_str(rest);
        out = next;
    }
    crate::redact::redact(&out)
}
/// `CherryPick` → `cherryPick`, as the UI sends it.
fn wire_method(variant: &str) -> String {
    let mut chars = variant.chars();
    chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default()
}
// --- end UX R1 C.4 ---

pub async fn catch_panics<F>(method: &str, fut: F) -> Result<serde_json::Value, GbError>
where
    F: std::future::Future<Output = Result<serde_json::Value, GbError>>,
{
    use futures_util::FutureExt;
    match std::panic::AssertUnwindSafe(fut).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            let msg = crate::redact::redact(&crate::logging::panic_text(payload.as_ref()));
            tracing::error!(target: "gitbolt_core::api", method, "request panicked: {msg}");
            Err(GbError::other(format!("Internal error in {method}: {msg}")))
        }
    }
}

/// Runs gix work on the blocking pool. A `gix::Repository` is `!Sync`, so it must never be held
/// across an `.await` in `dispatch` (whose future has to be `Send`).
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, GbError> + Send + 'static) -> Result<T, GbError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| GbError::other(format!("task failed: {e}")))?
}

impl Api {
    pub fn new(cli: GitCli, launch_repo: Option<String>) -> Self {
        // A test or a harness that forgets `with_data_dir` never touches the user's data dir. No
        // writable temp dir (the app, which replaces it anyway, must not panic): a per-process one.
        let data_tmp = tempfile::tempdir().ok();
        let data_dir = data_tmp.as_ref().map(|t| t.path().to_path_buf()).unwrap_or_else(|| std::env::temp_dir().join(format!("gitbolt-data-{}", std::process::id())));
        Self {
            cli,
            launch_repo: launch_repo.filter(|p| !p.is_empty()),
            staging: Default::default(),
            repos: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            version: OnceCell::new(),
            signatures: Mutex::new(HashMap::new()),
            avatars: None,
            forge: None,
            url_opener: None,
            openers: None,
            chooser: None,
            opener_refresh: OPENER_REFRESH,
            open_cache: None,
            bus: EventBus::new(),
            store: SettingsStore::in_memory(),
            ops: Arc::new(OpRegistry::default()),
            askpass: std::sync::OnceLock::new(),
            folder_picker: None,
            home: crate::paths::home_dir(),
            scans: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            log: None,
            runtime_info: "harness".into(),
            open_requests: Mutex::new(Vec::new()),
            write_guard: None,
            write_locks: Mutex::new(HashMap::new()),
            data_dir,
            data_tmp,
            clock: crate::journal::system_clock(),
            recovered: Mutex::default(),
            owner: Mutex::new(None),
            autostash_timeout: crate::journal::autostash::AUTOSTASH_TIMEOUT,
        }
    }

    pub fn with_data_dir(mut self, dir: PathBuf) -> Self {
        self.data_dir = dir;
        self.data_tmp = None;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_autostash_timeout(mut self, limit: Duration) -> Self {
        self.autostash_timeout = limit;
        self
    }

    pub fn with_clock(mut self, clock: crate::journal::Clock) -> Self {
        self.clock = clock;
        self
    }

    pub(crate) fn now(&self) -> i64 {
        (self.clock)()
    }

    /// `<data>/tmp`, 0700: temp index files and trace2 files.
    pub(crate) fn tmp_dir(&self) -> Result<PathBuf, GbError> {
        if let Some(parent) = self.data_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::paths::private_dir(&self.data_dir)?;
        Ok(crate::paths::private_dir(&self.data_dir.join("tmp"))?)
    }

    /// `root`'s journal (its own git dir). It never recovers pending entries: that happens once
    /// per process, at the repository's first open (`recover_journals`), so a write never takes
    /// another instance's in-flight entry for a crashed one.
    pub(crate) fn journal(&self, root: &Path) -> Result<crate::journal::JournalStore, GbError> {
        let git_dir = gix::open(root).map_err(crate::error::gix_err)?.git_dir().canonicalize()?;
        Ok(crate::journal::JournalStore::new(&self.data_dir, &git_dir, root))
    }

    /// This instance's journal owner, stamped on its pending entries (taken once, then held).
    pub(crate) fn owner(&self) -> Result<crate::journal::Owner, GbError> {
        let mut held = self.owner.lock().expect("owner poisoned");
        if held.is_none() {
            *held = Some(crate::journal::OwnerLock::acquire(&self.data_dir)?);
        }
        Ok(held.as_ref().expect("owner lock").owner.clone())
    }

    /// At a repository's first open in this process: a pending entry still in a worktree's
    /// journal means GitBolt stopped mid-operation (§5.1). Every worktree's journal (the main
    /// one's too, whichever worktree opens first), once; not while one of this process's writes
    /// holds the repository's lock (the next open retries). A free lock doesn't mean no write is
    /// in flight: a push or pull releases it during its transfer (2D T1). What protects such a
    /// write's pending entry is its owner: an entry whose owner still runs (this instance, or
    /// another one) is never recovered.
    fn recover_journals(&self, workdir: &Path, common_dir: &Path) {
        if self.recovered.lock().expect("recovered poisoned").contains(common_dir) {
            return;
        }
        let writes = self.writes_for(common_dir);
        let Ok(_idle) = writes.lock.try_lock() else { return };
        if !self.recovered.lock().expect("recovered poisoned").insert(common_dir.to_path_buf()) {
            return;
        }
        // Git dir → worktree root, deduped.
        let mut worktrees: std::collections::BTreeMap<PathBuf, PathBuf> = std::collections::BTreeMap::new();
        let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        // The main worktree: gix lists only the linked ones. Its git dir is the common dir.
        let main_root = gix::open(common_dir).ok().and_then(|m| m.workdir().map(Path::to_path_buf)).or_else(|| common_dir.file_name().is_some_and(|n| n == ".git").then(|| common_dir.parent().map(Path::to_path_buf)).flatten());
        if let Some(main_root) = main_root {
            worktrees.insert(canonical(common_dir), canonical(&main_root));
        }
        if let Ok(repo) = gix::open(workdir) {
            worktrees.insert(canonical(repo.git_dir()), workdir.to_path_buf());
            for wt in repo.worktrees().unwrap_or_default() {
                if let Ok(base) = wt.base() {
                    worktrees.insert(canonical(wt.git_dir()), canonical(&base));
                }
            }
        }
        let data = self.data_dir.clone();
        // The shared stash stack, newest first: records written ahead of a push that never
        // reported back find their stash by message (2A T11 review N2). A stack it can't read
        // (an I/O error, or reftable, which keeps no `logs/refs/stash`) resolves nothing: an
        // empty list would drop every such record, and a stash git did store would lose its
        // banner (2A final M4). An absent reflog is an empty stack.
        let stashes: Option<Vec<(String, String)>> = if common_dir.join("reftable").is_dir() {
            None
        } else {
            crate::reflog::read_reflog(common_dir, "refs/stash").ok().map(|l| l.into_iter().map(|e| (e.new.to_string(), e.message)).collect())
        };
        // --- 2C T7: a recorded stash's commit, listed or not ---
        let objects = gix::open(common_dir).ok();
        let exists = |oid: &str| objects.as_ref().zip(gix::ObjectId::from_hex(oid.as_bytes()).ok()).is_some_and(|(r, id)| r.has_object(id));
        // --- end 2C T7 ---
        for (git_dir, root) in worktrees {
            let store = crate::journal::JournalStore::new(&data, &git_dir, &root);
            if let Err(e) = store.update(|j| {
                j.recover_unless(|o| o.alive(&data));
                if let Some(stashes) = &stashes {
                    j.resolve_unrecorded(stashes);
                    // --- 2C T7 ---
                    j.resolve_stash_moves(stashes, exists);
                    // --- end 2C T7 ---
                }
            }) {
                tracing::warn!(target: "gitbolt_core::write", "journal recovery failed for {}: {e}", root.display());
            }
        }
        crate::journal::OwnerLock::sweep(&data);
    }

    fn running_writes(&self) -> Vec<Arc<crate::ops::OpEntry>> {
        self.ops.running().into_iter().filter(|o| !matches!(o.kind, crate::events::OpKind::Fetch | crate::events::OpKind::Clone)).collect()
    }

    /// Whether a write op (anything but a fetch or a clone) is registered: queued or running.
    pub fn writes_running(&self) -> bool {
        !self.running_writes().is_empty()
    }

    /// The app is quitting: waits up to `wait` for the running writes (every op but a fetch or
    /// a clone) to finish, then cancels the rest and gives them `WRITE_TERM_GRACE` to stop, so
    /// git can remove its locks (spec #2 §3.3).
    pub async fn settle_writes(&self, wait: Duration) {
        let writing = || self.running_writes();
        let deadline = Instant::now() + wait;
        while !writing().is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let left = writing();
        if left.is_empty() {
            return;
        }
        for op in &left {
            op.cancel.cancel();
        }
        let deadline = Instant::now() + crate::git::WRITE_TERM_GRACE + Duration::from_millis(500);
        while !writing().is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// UX Y: the Undo dropdown's rows. A read: the journal is loaded (a copy, the lock released)
    /// and expired in memory; the dependency check runs outside the journal's lock.
    pub(crate) fn journal_history(&self, root: &Path) -> Result<Vec<crate::journal::history::HistoryRow>, GbError> {
        let mut j = self.journal(root)?.load()?;
        let repo = gix::open(root).map_err(crate::error::gix_err)?;
        let busy = repo.state().and_then(crate::write::in_progress_name);
        j.expire(self.now());
        let blocked = j.state(busy).undo_blocked;
        Ok(j.history(busy, &blocked))
    }

    /// What Undo/Redo and the banners show; expired entries go first (§5.1).
    pub(crate) fn journal_state(&self, root: &Path) -> Result<crate::journal::JournalState, GbError> {
        let store = self.journal(root)?;
        let repo = gix::open(root).map_err(crate::error::gix_err)?;
        let busy = repo.state().and_then(crate::write::in_progress_name);
        let now = self.now();
        let mut state = store.update(|j| {
            j.expire(now);
            j.state(busy)
        })?;
        // 2C final I1: an autostash git couldn't restore (refused, conflicts, partial) stays
        // listed; once it isn't (popped or dropped from another worktree, or outside GitBolt),
        // its banner's Apply and Drop would fail, so it doesn't show. A recovery or stopped-push
        // banner is for a stash that may never have been listed: those always show. A stack it
        // can't read (reftable, an I/O error) hides nothing, as in `recover_journals`.
        use crate::journal::BannerKind;
        let common = repo.common_dir();
        let listed = (!common.join("reftable").is_dir()).then(|| crate::reflog::read_reflog(common, "refs/stash").ok()).flatten();
        if let Some(listed) = listed {
            let listed: std::collections::HashSet<String> = listed.into_iter().map(|e| e.new.to_string()).collect();
            let unrestored = |k: BannerKind| matches!(k, BannerKind::AutostashRefused | BannerKind::AutostashConflicts | BannerKind::AutostashPartial);
            state.banners.retain(|b| !unrestored(b.kind) || b.stash.as_ref().is_none_or(|oid| listed.contains(oid)));
        }
        Ok(state)
    }

    /// Holds on every live watcher of the repository (one per tab's worktree).
    pub(crate) fn watch_holds(&self, common_dir: &Path) -> Vec<crate::watch::WatchHold> {
        let ids: Vec<u32> = self.watchers.lock().expect("watchers poisoned").keys().copied().collect();
        let mine: Vec<u32> = ids.into_iter().filter(|id| self.handle(*id).is_ok_and(|h| h.common_dir == common_dir)).collect();
        let watchers = self.watchers.lock().expect("watchers poisoned");
        mine.iter().filter_map(|id| watchers.get(id)).map(|w| w.hold()).collect()
    }

    /// The harness's reset: every queue cleared, every journal gone.
    #[cfg(any(test, feature = "testing"))]
    pub fn reset_writes(&self) {
        for w in self.write_locks.lock().expect("write locks poisoned").values() {
            w.queue.clear();
            w.queue.resume();
        }
        self.recovered.lock().expect("recovered poisoned").clear();
        let _ = std::fs::remove_dir_all(self.data_dir.join("journal"));
    }

    pub fn with_write_guard(mut self, guard: WriteGuard) -> Self {
        self.write_guard = Some(guard);
        self
    }

    /// Every write asks this first (`run_write`, `remove_index_lock`).
    pub(crate) fn check_write(&self, common_dir: &Path) -> Result<(), GbError> {
        match &self.write_guard {
            Some(guard) => guard(common_dir),
            None => Ok(()),
        }
    }

    /// A later launch's path (the single-instance guard, R19): queued for `takeOpenRequests`,
    /// then announced as `openRequested`. The UI takes the queue on that event and once at boot,
    /// so a path forwarded before the page listened (startup, a reload) still opens, and once.
    pub fn request_open(&self, path: String) {
        {
            let mut queue = self.open_requests.lock().expect("open requests poisoned");
            if queue.len() >= MAX_OPEN_REQUESTS {
                queue.remove(0);
            }
            queue.push(path.clone());
        }
        self.bus.emit(AppEvent::OpenRequested { path });
    }

    /// Takes (and clears) the queued `request_open` paths, oldest first.
    pub fn take_open_requests(&self) -> Vec<String> {
        std::mem::take(&mut *self.open_requests.lock().expect("open requests poisoned"))
    }

    pub fn with_folder_picker(mut self, picker: FolderPicker) -> Self {
        self.folder_picker = Some(picker);
        self
    }

    /// The home `suggestReposFolder` looks in (the user's own unless changed; the harness's is
    /// a temp dir).
    pub fn with_home(mut self, home: Option<PathBuf>) -> Self {
        self.home = home;
        self
    }

    /// Drops every cached `scanRepos` result (the harness's reset).
    pub fn forget_scans(&self) {
        self.scans.lock().expect("scans poisoned").clear();
    }

    /// One folder's scan: absolute roots only, cached per root unless `refresh`.
    async fn scan_root(&self, root: String, refresh: bool) -> Result<Vec<ScannedRepo>, GbError> {
        if !Path::new(&root).is_absolute() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("not an absolute folder: {root}")));
        }
        if !refresh && let Some(hit) = self.scans.lock().expect("scans poisoned").get(&root).cloned() {
            return Ok(hit);
        }
        let dir = PathBuf::from(&root);
        let found = blocking(move || Ok(crate::scan::scan_repos(&dir))).await?;
        self.scans.lock().expect("scans poisoned").insert(root, found.clone());
        Ok(found)
    }

    /// git's version, checked against `MIN_GIT` once and cached for the process lifetime.
    pub(crate) async fn git_version(&self) -> Result<(u32, u32, u32), GbError> {
        self.version.get_or_try_init(|| self.cli.check_version()).await.copied()
    }

    /// The custom editor (R5: the settings' Custom command, the repo's own over the profile's),
    /// built for the worktree `root` (its `{repo}`). Its program is looked up on the login
    /// shell's `PATH` when that's been captured (spec §5.3), else the app's.
    async fn custom_opener(&self, h: &RepoHandle, root: &Path) -> Result<Opener, GbError> {
        let profile = self.store.active_profile();
        let own = profile.repos.get(&h.workdir.display().to_string()).and_then(|r| r.editor.clone());
        let Some(EditorChoice::Custom { template }) = own.or(profile.editor) else {
            return Err(GbError::new(GbErrorKind::InvalidInput, "no custom editor command is set"));
        };
        let captured = self.cli.child_env().await;
        let root = root.to_path_buf();
        blocking(move || {
            let mut env = DetectEnv::from_system();
            if let Some(path) = captured.as_ref().and_then(|vars| vars.iter().find(|(k, _)| k == "PATH")).map(|(_, v)| v.clone()) {
                env.path = std::env::split_paths(&path).filter(|d| d.is_absolute()).collect();
            }
            template_opener(CUSTOM_ID, "Custom", &template, root, &env)
        })
        .await
    }

    /// The "Open in…" list. The `custom` entry is in it only when the Custom editor is the
    /// effective setting: the repository's own at `workdir`, else the profile's.
    async fn list_openers(&self, workdir: Option<String>) -> Result<serde_json::Value, GbError> {
        let mut list: Vec<OpenerPayload> = self.openers(false).await?.iter().map(Opener::payload).collect();
        let profile = self.store.active_profile();
        let own = workdir.and_then(|w| profile.repos.get(&w).and_then(|r| r.editor.clone()));
        if matches!(own.or(profile.editor), Some(EditorChoice::Custom { .. })) {
            let at = list.iter().position(|o| o.kind != OpenerKind::Editor).unwrap_or(list.len());
            list.insert(at, OpenerPayload { id: CUSTOM_ID.into(), name: "Custom".into(), kind: OpenerKind::Editor });
        }
        if self.chooser.is_some() {
            list.push(OpenerPayload { id: CHOOSER_ID.into(), name: "Other…".into(), kind: OpenerKind::Chooser });
        }
        to_json(list)
    }

    /// Pushes the Gravatar on/off setting to the avatar provider (spec §14.1).
    fn apply_avatar_setting(&self, on: bool) {
        if let Some(p) = &self.avatars {
            p.set_enabled(on);
        }
    }

    pub fn ops(&self) -> &Arc<OpRegistry> {
        &self.ops
    }

    pub fn askpass(&self) -> Option<&Arc<AskpassServer>> {
        self.askpass.get()
    }

    /// Starts the askpass socket in `dir` (spec §5.4). `exe` is the binary git runs as askpass.
    /// A second call keeps the first server.
    pub async fn start_askpass(&self, dir: &Path, exe: PathBuf) -> std::io::Result<()> {
        if self.askpass.get().is_some() {
            return Ok(());
        }
        let server = AskpassServer::start(dir, exe, self.ops.clone(), self.bus.clone()).await?;
        if let Err(extra) = self.askpass.set(server) {
            extra.close();
        }
        Ok(())
    }

    /// Environment for a network command belonging to `op`: askpass's (none if askpass isn't
    /// running: git then fails a prompt at once, `GIT_TERMINAL_PROMPT=0`), and for a GitBolt-started
    /// (non-interactive) op, `GCM_INTERACTIVE=never` too, so Git Credential Manager never shows
    /// its own prompt for a background fetch either.
    pub(crate) fn net_env(&self, op: OpId) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        let mut env = self.askpass.get().map(|s| s.env_for(Some(op))).unwrap_or_default();
        if self.ops.get(op).is_some_and(|e| !e.interactive) {
            env.push(("GCM_INTERACTIVE".into(), "never".into()));
        }
        env
    }

    pub fn with_store(mut self, store: Arc<SettingsStore>) -> Self {
        self.store = store;
        self.apply_profile_git_config();
        self
    }

    /// Applies the active profile's extra gitconfig (spec §14.2) to every git command: after
    /// loading the store, and whenever the profile (or which one is active) changes.
    fn apply_profile_git_config(&self) {
        let inc = self.store.active_profile().extra_gitconfig.filter(|p| !p.trim().is_empty()).map(PathBuf::from);
        self.cli.set_include_path(inc);
    }

    pub fn store(&self) -> &Arc<SettingsStore> {
        &self.store
    }

    pub fn with_avatars(mut self, provider: Arc<dyn AvatarProvider>) -> Self {
        self.avatars = Some(provider);
        self
    }

    // --- 4A T5 ---
    /// The forge connector and token store (gitbolt-forge's `Forge` and `SystemTokenStore` in
    /// the app; the fake forge's and a temp file in the harness).
    pub fn with_forge(mut self, connector: Arc<dyn crate::forge::ForgeConnector>, tokens: Arc<dyn crate::forge::TokenStore>) -> Self {
        self.forge = Some(Arc::new(crate::forge::hub::ForgeHub::new(connector, tokens, self.clock.clone())));
        self
    }

    /// Harness reset: forgets cached providers, statuses and projects.
    pub fn forge_reset(&self) {
        if let Some(h) = &self.forge {
            h.reset();
        }
    }

    pub(crate) fn forge_hub(&self) -> Result<&Arc<crate::forge::hub::ForgeHub>, GbError> {
        self.forge.as_ref().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Forge accounts aren't available here"))
    }
    // --- end 4A T5 ---

    pub fn with_url_opener(mut self, opener: UrlOpener) -> Self {
        self.url_opener = Some(opener);
        self
    }

    pub fn with_openers(mut self, detect: Arc<dyn Fn() -> Vec<Opener> + Send + Sync>, launcher: Launcher) -> Self {
        self.openers = Some(Arc::new(OpenerSource { detect, launcher, found: Mutex::new(None), refreshing: std::sync::atomic::AtomicBool::new(false) }));
        self
    }

    pub fn with_chooser(mut self, chooser: Chooser) -> Self {
        self.chooser = Some(chooser);
        self
    }

    /// Where "Open in…" writes old versions (the app's `~/.cache/gitbolt/open`). Without one,
    /// only working-tree files can be opened.
    pub fn with_open_cache(mut self, dir: PathBuf) -> Self {
        self.open_cache = Some(dir);
        self
    }

    pub fn with_opener_refresh(mut self, every: Duration) -> Self {
        self.opener_refresh = every;
        self
    }

    pub fn events(&self) -> &EventBus {
        &self.bus
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.bus.subscribe()
    }

    pub fn command_log(&self) -> &Arc<CommandLog> {
        self.cli.log()
    }

    pub fn with_log_handle(mut self, handle: crate::logging::LogHandle) -> Self {
        self.log = Some(handle);
        self
    }

    pub fn with_runtime_info(mut self, info: impl Into<String>) -> Self {
        self.runtime_info = info.into();
        self
    }

    /// Every request, with panics turned into `GbError::Other` (spec §16.1); the panic hook
    /// (logging::install_panic_hook) has already logged it with a backtrace.
    pub async fn dispatch(&self, req: Request) -> Result<serde_json::Value, GbError> {
        let debug = format!("{req:?}");
        let method = name_in(&debug);
        let write = req.is_write();
        // Boxed: `dispatch_inner` holds every request's future, so inline it would make each
        // caller's future (a Tauri command's, a test's) as large as the largest request's.
        let res = catch_panics(&method, Box::pin(self.dispatch_inner(req))).await;
        // UX R1 C.4: a failed write is logged (the UI's log only says its menu row ran).
        if write && let Err(e) = &res {
            self.log_write_failure(&method, &debug, e);
        }
        res
    }

    /// UX R1 C.4: one WARN line per failed write, with the method as the UI sends it, the
    /// error's kind and its message (paths relative to the repository, redacted). A Cancel is
    /// the user's own: INFO.
    fn log_write_failure(&self, variant: &str, debug: &str, e: &GbError) {
        let (method, kind) = (wire_method(variant), format!("{:?}", e.kind));
        let (repo, worktree) = write_scope(debug);
        let handle = repo.and_then(|id| self.handle(id).ok());
        let roots: Vec<PathBuf> = worktree.into_iter().chain(handle.as_ref().map(|h| h.workdir.clone())).collect();
        let message = relative_message(crate::log::truncate_utf8(&e.message, crate::log::STDERR_LOG_LIMIT), &roots, handle.as_ref().map(|h| h.common_dir.as_path()));
        if e.kind == GbErrorKind::Cancelled {
            tracing::info!(target: "gitbolt_core::write", method = %method, kind = %kind, "write cancelled: {message}");
        } else {
            tracing::warn!(target: "gitbolt_core::write", method = %method, kind = %kind, "write failed: {message}");
        }
    }

    async fn dispatch_inner(&self, req: Request) -> Result<serde_json::Value, GbError> {
        match req {
            Request::LogFrontend { level, message, stack } => {
                crate::logging::log_frontend(level, &message, stack.as_deref());
                to_json(())
            }
            Request::SetDebugLogging { debug } => {
                if let Some(h) = &self.log {
                    h.set_debug(debug)?;
                }
                to_json(())
            }
            Request::LogsDir => to_json(self.log.as_ref().map(|h| h.dir().display().to_string())),
            Request::Diagnostics { ui } => {
                let git_version = self.cli.check_version().await.ok();
                to_json(crate::diagnostics::format(&crate::diagnostics::DiagnosticsInput {
                    app_version: env!("CARGO_PKG_VERSION"),
                    runtime: &self.runtime_info,
                    git_version,
                    os: crate::diagnostics::os_description(),
                    session: crate::diagnostics::session_description(),
                    ui: &ui,
                }))
            }
            Request::OpenLogsFolder => {
                let dir = self.log.as_ref().map(|h| h.dir().to_path_buf()).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "no log folder in this build"))?;
                let launcher = self.openers.as_ref().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "opening folders isn't available here"))?.launcher.clone();
                let find = |list: &[Opener]| list.iter().find(|o| o.kind == OpenerKind::FileManager).cloned();
                let manager = match find(&self.openers(false).await?) {
                    Some(o) => o,
                    None => find(&self.openers(true).await?).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "no file manager on this machine"))?,
                };
                let cmd = manager.command(&dir, None);
                blocking(move || launcher(&cmd)).await?;
                to_json(())
            }
            Request::OpenRepo { path } => to_json(self.open_repo(&path).await?),
            Request::Graph { repo, limit, pin, rescan, active } => {
                let h = self.handle(repo)?;
                // Checked against the build's own `git worktree list` (`build_graph_with_text`),
                // so a switch's relayout runs one git process, not two.
                let active = match active {
                    Some(a) => Some(Path::new(&a).canonicalize().map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("{a} is not a worktree of this repository")))?),
                    None => None,
                };
                let (pinned_ref, no_pin) = match pin {
                    Some(PinSetting::Off) => (None, true),
                    Some(PinSetting::Ref { name }) => (Some(name), false),
                    Some(PinSetting::Auto) | None => (None, false),
                };
                let opts = BuildOptions {
                    limit: limit.map(|l| l as usize).unwrap_or(crate::snapshot::DEFAULT_COMMIT_LIMIT),
                    pinned_ref,
                    no_pin,
                    wip_cache: Some(h.wip.clone()),
                    rescan: rescan.unwrap_or(false) || !self.status_is_watched(repo),
                    active,
                    walk_cache: Some(h.walk.clone()),
                };
                let (payload, texts) = build_graph_with_text(h.repo.clone(), h.workdir.clone(), self.cli.clone(), opts).await?;
                {
                    // Find searches this window now; the path index carries over (find.rs).
                    let mut snapshot = h.snapshot.lock().expect("snapshot poisoned");
                    let next = crate::find::FindSnapshot::new(texts, snapshot.as_deref());
                    *snapshot = Some(Arc::new(next));
                }
                to_json(payload)
            }
            Request::FindText { repo, query } => to_json(self.find_text(repo, &query)?),
            Request::FindPaths { repo, query } => to_json(self.find_paths(repo, &query).await?),
            Request::LocateCommit { repo, sha } => to_json(self.locate_commit(repo, &sha).await?),
            Request::SearchHistory { repo, query } => to_json(self.search_history(repo, &query).await?),
            Request::CommandLog => to_json(self.cli.log().entries()),
            Request::LaunchRepo => to_json(&self.launch_repo),
            Request::TakeOpenRequests => to_json(self.take_open_requests()),
            Request::CommitMessage { repo, id } => {
                let h = self.handle(repo)?;
                to_json(blocking(move || read_commit_message(&h.repo.to_thread_local(), &id)).await?)
            }
            Request::CommitDetails { repo, id } => {
                let h = self.handle(repo)?;
                let id = parse_oid(&id)?;
                to_json(blocking(move || commit_details(&h.repo.to_thread_local(), id)).await?)
            }
            Request::Remotes { repo } => {
                let h = self.handle(repo)?;
                to_json(remotes(&h.repo.to_thread_local()))
            }
            Request::FileList { repo, spec } => {
                let h = self.handle(repo)?;
                // The active tab's watcher keeps its worktrees' WIP lists (K44): no git process,
                // and no worktree lookup either (only a watched worktree's lists are kept). A
                // covered worktree's first read computes and keeps them.
                if let DiffSpec::Wip { worktree, staged } = &spec
                    && self.status_is_watched(repo)
                    && h.wip.covered(Path::new(worktree))
                {
                    let lists = match h.wip.fresh_lists(Path::new(worktree)) {
                        Some(l) => l,
                        None => crate::watch::read_and_keep_lists(&h.repo, &self.cli, &h.wip, &Path::new(worktree).canonicalize()?).await?,
                    };
                    return to_json(if *staged { &*lists.staged } else { &*lists.unstaged });
                }
                let wt = match &spec {
                    DiffSpec::Worktree { worktree, .. } | DiffSpec::Wip { worktree, .. } => Some(self.worktree_dir(&h, worktree).await?),
                    DiffSpec::Commit { .. } | DiffSpec::Compare { .. } => None,
                };
                to_json(file_list(&h.repo, &self.cli, &h.workdir, &spec, wt.as_deref()).await?)
            }
            Request::DiffContents { repo, path, old, new, force } => {
                let h = self.handle(repo)?;
                let old = self.resolve_side(&h, &path, old).await?;
                let new = self.resolve_side(&h, &path, new).await?;
                let (repo, p, o, n) = (h.repo.clone(), path.clone(), old.clone(), new.clone());
                let mut c = blocking(move || diff_contents(&repo.to_thread_local(), &p, &o, &n, force)).await?;
                // A binary shows as a capped hex dump: no large-file prompt, whatever its size.
                crate::hex::ungate_binary(&h.repo, &self.cli, &h.workdir, &path, &old, &new, &mut c).await?;
                to_json(c)
            }
            Request::HexDump { repo, path, old, new } => {
                let h = self.handle(repo)?;
                let old = self.resolve_side(&h, &path, old).await?;
                let new = self.resolve_side(&h, &path, new).await?;
                to_json(crate::hex::hex_dump(&h.repo, &self.cli, &h.workdir, &path, old, new, crate::hex::HEX_CAP).await?)
            }
            Request::TreeFiles { repo, id } => {
                let h = self.handle(repo)?;
                let id = parse_oid(&id)?;
                to_json(blocking(move || tree_files(&h.repo.to_thread_local(), id)).await?)
            }
            Request::WorktreeFiles { repo, worktree } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(blocking(move || crate::tree::worktree_files(&root)).await?)
            }
            Request::Signature { repo, id } => {
                let h = self.handle(repo)?;
                let id = parse_oid(&id)?;
                let cache_key = (h.repo.git_dir().to_path_buf(), id);
                if let Some(s) = self.signatures.lock().expect("signatures poisoned").get(&cache_key).cloned() {
                    return to_json(s);
                }
                let signed = parse_commit(&read_commit(&h.repo.to_thread_local(), id)?)?.signed;
                let s = signature_status(&self.cli, &h.workdir, id, signed).await?;
                if cacheable(s.kind) {
                    let mut cache = self.signatures.lock().expect("signatures poisoned");
                    if cache.len() >= SIGNATURE_CACHE_MAX {
                        cache.clear();
                    }
                    cache.insert(cache_key, s.clone());
                }
                to_json(s)
            }
            Request::Avatar { email } => {
                // --- 4A T6: the forges first (spec #4 §2 "Avatars") ---
                if self.store.state().settings.forge_avatars
                    && let Some(hub) = &self.forge
                    && let Some(found) = hub.avatar(&self.store, &email).await
                {
                    return to_json(Some(found));
                }
                // --- end 4A T6 ---
                match &self.avatars {
                    Some(p) => to_json(p.avatar(&email).await?),
                    None => to_json(Option::<AvatarPayload>::None),
                }
            }
            Request::ListOpeners => self.list_openers(None).await,
            Request::ListOpenersFor { repo } => {
                let workdir = self.handle(repo)?.workdir.display().to_string();
                self.list_openers(Some(workdir)).await
            }
            Request::ValidateEditorTemplate { template } => {
                let captured = self.cli.child_env().await;
                blocking(move || {
                    let mut env = DetectEnv::from_system();
                    if let Some(path) = captured.as_ref().and_then(|vars| vars.iter().find(|(k, _)| k == "PATH")).map(|(_, v)| v.clone()) {
                        env.path = std::env::split_paths(&path).filter(|d| d.is_absolute()).collect();
                    }
                    template_opener(CUSTOM_ID, "Custom", &template, "/", &env).map(|_| ())
                })
                .await?;
                to_json(())
            }
            Request::OpenIn { repo, worktree, path, line, opener, source, fallback } => {
                let h = self.handle(repo)?;
                if line == Some(0) {
                    return Err(GbError::new(GbErrorKind::InvalidInput, "lines start at 1"));
                }
                let unavailable = || GbError::new(GbErrorKind::InvalidInput, "opening files isn't available here");
                if opener == CHOOSER_ID {
                    let chooser = self.chooser.clone().ok_or_else(unavailable)?;
                    let root = self.worktree_dir(&h, &worktree).await?;
                    let target = self.open_in_file(&h, &root, &path, source, fallback).await?;
                    blocking(move || chooser(&target)).await?;
                    return to_json(());
                }
                let launcher = self.openers.as_ref().ok_or_else(unavailable)?.launcher.clone();
                let root = self.worktree_dir(&h, &worktree).await?;
                let o = if opener == CUSTOM_ID {
                    self.custom_opener(&h, &root).await?
                } else {
                    // An id the cached list doesn't have (installed since): detect again once.
                    let find = |list: &[Opener]| list.iter().find(|o| o.id == opener).cloned();
                    match find(&self.openers(false).await?) {
                        Some(o) => o,
                        None => find(&self.openers(true).await?).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("no opener {opener:?} on this machine")))?,
                    }
                };
                let target = match o.kind {
                    OpenerKind::FileManager => folder_target(&root, &path)?,
                    OpenerKind::Editor | OpenerKind::Chooser => self.open_in_file(&h, &root, &path, source, fallback).await?,
                };
                if o.kind == OpenerKind::Editor {
                    // Spec §5.3: editors start with the login shell's environment, which the
                    // launcher reads once captured; wait for the capture (bounded, and at most once).
                    let _ = self.cli.child_env().await;
                }
                let cmd = o.command(&target, line);
                blocking(move || launcher(&cmd)).await?;
                to_json(())
            }
            Request::OpenUrl { url } => {
                validate_web_url(&url)?;
                let opener = self.url_opener.as_ref().ok_or_else(|| GbError::other("opening links isn't available here"))?;
                opener(&url)?;
                to_json(())
            }
            Request::LoadState => {
                self.apply_profile_git_config();
                let mut state = self.store.state();
                state.profile.migrate_repos_folders(self.home.as_deref());
                self.apply_avatar_setting(state.settings.gravatar);
                to_json(state)
            }
            Request::SaveSettings { settings } => {
                self.apply_avatar_setting(settings.gravatar);
                self.store.save_settings(settings);
                to_json(())
            }
            Request::SaveProfile { profile } => {
                self.store.save_profile(profile)?;
                self.apply_profile_git_config();
                to_json(())
            }
            Request::CreateProfile { name, color } => to_json(self.store.create_profile(&name, &color)?),
            Request::SwitchProfile { id } => {
                let mut st = self.store.switch_profile(&id)?;
                st.profile.migrate_repos_folders(self.home.as_deref());
                self.apply_profile_git_config();
                to_json(st)
            }
            Request::DeleteProfile { id } => {
                // --- 4A T5: its tokens go with it ---
                let gone = self.store.profile(&id);
                let left = self.store.delete_profile(&id)?;
                if let (Some(hub), Some(p)) = (&self.forge, gone) {
                    hub.forget_profile(&p).await;
                }
                // --- end 4A T5 ---
                to_json(left)
            }
            Request::AuthAnswer { prompt, answer } => {
                let server = self.askpass.get().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "askpass is not running"))?;
                server.answer(prompt, answer)?;
                to_json(())
            }
            Request::CancelOp { op } => {
                self.ops.cancel(op);
                to_json(())
            }
            Request::Fetch { repo, background, remote } => to_json(self.fetch_remote(repo, background, remote).await?),
            // --- 4A T7 ---
            Request::AddRemote { repo, worktree, name, url } => {
                let done = crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::remotes::AddRemote { name, url }).await?;
                self.reopen_repo(repo)?;
                to_json(done)
            }
            // --- end 4A T7 ---
            // --- 4A T5 ---
            Request::ForgeAccounts => to_json(self.forge.as_ref().map(|f| f.accounts(&self.store)).unwrap_or_default()),
            Request::AddForgeAccount { host, kind, token } => to_json(self.forge_hub()?.add_account(&self.store, &host, kind, token).await?),
            Request::RemoveForgeAccount { host } => {
                self.forge_hub()?.remove_account(&self.store, &host).await?;
                to_json(())
            }
            Request::ForgeTokenPage { host, kind } => {
                let host = crate::forge::accounts::normalize_host(&host)?;
                crate::forge::accounts::check_kind_host(kind, &host)?;
                to_json(crate::forge::accounts::token_page_url(kind, &host))
            }
            // --- end 4A T5 ---
            // --- 4A T6 ---
            Request::ForgeRepoProjects { repo, refresh } => {
                let h = self.handle(repo)?;
                let list = remotes(&h.repo.to_thread_local());
                match &self.forge {
                    Some(hub) => to_json(hub.repo_projects(&self.store, &list, refresh).await),
                    None => to_json(crate::forge::hub::RepoProjects::without_accounts(&list)),
                }
            }
            Request::ForgeProjectSettings { repo, remote } => {
                let list = remotes(&self.handle(repo)?.repo.to_thread_local());
                to_json(self.forge_hub()?.project_settings(&self.store, &list, &remote).await?)
            }
            Request::ForgeForks { repo, remote } => {
                let list = remotes(&self.handle(repo)?.repo.to_thread_local());
                to_json(self.forge_hub()?.forks(&self.store, &list, &remote).await?)
            }
            // --- end 4A T6 ---
            Request::Clone { url, dest } => to_json(self.clone_repo(url, dest).await?),
            Request::RepoInfo { repo } => {
                let h = self.handle(repo)?;
                to_json(crate::shelldata::repo_info(&self.cli, &h.repo, &h.workdir).await?)
            }
            Request::Sidebar { repo } => {
                let h = self.handle(repo)?;
                let mut s = crate::shelldata::sidebar(&self.cli, &h.repo, &h.workdir).await?;
                crate::write::rewrites::annotate(&self.data_dir, &h.common_dir, &h.repo.to_thread_local(), &mut s.locals);
                to_json(s)
            }
            Request::LastPush { repo, remote_ref } => {
                let h = self.handle(repo)?;
                to_json(blocking(move || crate::shelldata::last_push(&h.repo, &remote_ref)).await?)
            }
            Request::AppInfo => to_json(crate::shelldata::app_info_payload(self.git_version().await?)),
            Request::PickFolder { start } => {
                let Some(picker) = self.folder_picker.clone() else { return to_json(Option::<String>::None) };
                let start = start.map(PathBuf::from).filter(|p| p.is_absolute());
                let picked = blocking(move || Ok(picker(start.as_deref()))).await?;
                to_json(picked.map(|p| p.display().to_string()))
            }
            Request::ScanRepos { root, refresh } => to_json(self.scan_root(root, refresh).await?),
            Request::ScanFolders { roots, refresh } => {
                let mut seen = std::collections::HashSet::new();
                let roots: Vec<String> = roots.into_iter().filter(|r| seen.insert(r.clone())).collect();
                let scans = futures_util::future::join_all(roots.into_iter().map(|r| self.scan_root(r, refresh))).await;
                to_json(crate::scan::merge_scans(scans.into_iter().filter_map(Result::ok)))
            }
            Request::SuggestReposFolder => to_json(crate::scan::suggest_repos_folder(self.home.as_deref())),
            Request::WatchRepo { repo } => {
                self.watch_repo(repo).await?;
                to_json(())
            }
            Request::UnwatchRepo { repo } => {
                self.unwatch_repo(repo);
                to_json(())
            }
            Request::UnwatchAll => {
                self.unwatch_all();
                to_json(())
            }
            Request::QueueState { repo } => to_json(self.repo_writes(&*self.handle(repo)?).queue.state()),
            Request::QueueRemove { repo, id } => to_json(self.repo_writes(&*self.handle(repo)?).queue.remove(id)),
            Request::QueueResume { repo } => {
                self.repo_writes(&*self.handle(repo)?).queue.resume();
                to_json(())
            }
            Request::QueueClear { repo } => {
                self.repo_writes(&*self.handle(repo)?).queue.clear();
                to_json(())
            }
            // --- Undo / redo (2A T10) ---
            Request::Undo { repo, worktree, entry, confirm, confirm_autostash, without_index, confirm_discard } => to_json(crate::journal::undo::undo_or_redo(self, repo, &worktree, crate::journal::undo::Direction::Undo, entry, confirm.unwrap_or_default(), confirm_autostash.unwrap_or(false), without_index.unwrap_or(false), confirm_discard.unwrap_or(false)).await?),
            Request::Redo { repo, worktree, entry, confirm_autostash, without_index } => to_json(crate::journal::undo::undo_or_redo(self, repo, &worktree, crate::journal::undo::Direction::Redo, entry, Default::default(), confirm_autostash.unwrap_or(false), without_index.unwrap_or(false), false).await?),
            Request::UndoEntry { repo, worktree, entry, confirm_autostash } => to_json(crate::journal::undo::undo_out_of_order(self, repo, &worktree, entry, confirm_autostash.unwrap_or(false)).await?), // UX Y
            Request::JournalHistory { repo, worktree } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(self.journal_history(&root)?)
            }
            Request::JournalState { repo, worktree } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(self.journal_state(&root)?)
            }
            // --- end undo / redo (2A T10) ---
            // --- Autostash banners (2A T11) ---
            Request::ApplyKeptStash { repo, worktree, entry, without_index, confirm_autostash } => to_json(crate::journal::autostash::apply_kept(self, repo, &worktree, entry, without_index.unwrap_or(false), confirm_autostash.unwrap_or(false)).await?),
            Request::DismissBanner { repo, worktree, entry, drop_stash } => to_json(crate::journal::autostash::dismiss(self, repo, &worktree, entry, drop_stash.unwrap_or(false)).await?),
            // --- end autostash banners (2A T11) ---
            // --- The pause (2D T2) ---
            Request::SettlePaused { repo, worktree } => to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::SettleIntent).await?),
            // --- 2C T3 ---
            Request::CreateBranch { repo, worktree, name, start, start_ref, checkout, expect, confirm_autostash } => {
                let confirm = crate::write::types::Confirm { autostash: confirm_autostash.unwrap_or(false) };
                to_json(crate::write::run_write(self, repo, &worktree, expect, crate::write::branch::CreateBranch { name, start, start_ref, checkout, confirm }).await?)
            }
            Request::RenameBranch { repo, worktree, from, to, expect } => to_json(crate::write::run_write(self, repo, &worktree, expect, crate::write::branch::RenameBranch { from, to }).await?),
            Request::SetUpstream { repo, worktree, branch, upstream } => to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::branch::SetUpstream { branch, upstream }).await?),
            // --- end 2C T3 ---
            // --- end the pause (2D T2) ---
            // --- 2D T12: conflicted files ---
            Request::ConflictFile { repo, worktree, path } => to_json(crate::write::conflict::conflict_file(self, repo, &worktree, path).await?),
            // --- 3A T2 ---
            Request::FileHistory { repo, worktree, path, rev, skip, limit } => to_json(crate::history::file_history(self, repo, &worktree, path, rev, skip, limit).await?),
            Request::Blame { repo, worktree, rev, path } => to_json(crate::history::blame(self, repo, &worktree, rev, path).await?),
            // --- end 3A T2 ---
            // --- 3A T3 ---
            Request::RestoreFile { repo, worktree, sha, path, confirm } => to_json(crate::write::restore::restore_file(self, repo, &worktree, sha, path, confirm.unwrap_or(false)).await?),
            // --- end 3A T3 ---
            // --- 2D T15 ---
            Request::ResolveFile { repo, worktree, path, resolution, base, confirm_markers, confirm_discard } => {
                crate::blob::check_relative(&path)?;
                to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::conflict::ResolveIntent { path, resolution, base, confirm_markers: confirm_markers.unwrap_or(false), confirm_discard: confirm_discard.unwrap_or(false) }).await?)
            }
            // --- end 2D T15 ---
            // --- end 2D T12 ---
            #[cfg(any(test, feature = "testing"))]
            Request::TestWrite { repo, worktree, expect, intent } => {
                // A workspace build unifies `testing` into the app's core: without a write guard
                // (only the harness sets one) a test write is refused, whatever was compiled in.
                if self.write_guard.is_none() {
                    return Err(GbError::new(GbErrorKind::InvalidInput, "test writes need a write guard (the harness)"));
                }
                crate::write::test_intents::run(self, repo, &worktree, expect, intent).await
            }
            Request::WriteWorktreeFile { repo, worktree, path, text, base } => to_json(crate::write::files::write_worktree_file(self, repo, &worktree, path, text, base).await?),
            Request::CreateWorktreeFile { repo, worktree, path } => to_json(crate::write::files::create_worktree_file(self, repo, &worktree, path).await?),
            Request::RemoveIndexLock { repo, path, mtime_ms, ino, dev } => {
                crate::write::index_lock::remove_index_lock(self, repo, &path, mtime_ms, ino, dev).await?;
                to_json(())
            }
            // --- 2B T1 ---
            Request::Stage { repo, worktree, paths } => to_json(crate::write::stage::stage_paths(self, repo, &worktree, crate::write::stage::Which::Stage, paths, Vec::new()).await?),
            Request::Unstage { repo, worktree, paths, old_paths } => to_json(crate::write::stage::stage_paths(self, repo, &worktree, crate::write::stage::Which::Unstage, paths, old_paths.unwrap_or_default()).await?),
            Request::StageAll { repo, worktree } => to_json(crate::write::stage::stage_all(self, repo, &worktree, crate::write::stage::Which::Stage).await?),
            Request::UnstageAll { repo, worktree } => to_json(crate::write::stage::stage_all(self, repo, &worktree, crate::write::stage::Which::Unstage).await?),
            // --- end 2B T1 ---
            // --- 2B T2 ---
            Request::StagingUndo { repo, worktree } => to_json(crate::journal::staging::staging_undo(self, repo, &worktree, crate::journal::staging::Dir::Undo).await?),
            Request::StagingRedo { repo, worktree } => to_json(crate::journal::staging::staging_undo(self, repo, &worktree, crate::journal::staging::Dir::Redo).await?),
            Request::StagingState { repo, worktree } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(crate::journal::staging::read_state(self, &root)?)
            }
            // --- end 2B T2 ---
            // --- 2B T5 ---
            Request::Commit { repo, worktree, summary, description, amend, stage_all, expect } => to_json(crate::write::commit::commit(self, repo, &worktree, summary, description, amend, stage_all, expect).await?),
            Request::EditHeadMessage { repo, worktree, message, expect } => to_json(crate::write::commit::edit_head_message(self, repo, &worktree, message, expect).await?),
            Request::HeadOnUpstream { repo, worktree } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(crate::write::commit::head_on_upstream(&self.cli, &root).await?)
            }
            // --- end 2B T5 ---
            // --- 2C T8: worktrees ---
            Request::WorktreeAdd { repo, worktree, path, branch } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                let path = std::path::PathBuf::from(path);
                let shown = crate::write::worktree::shown(&self.cli, &root, &path).await;
                to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::worktree::WorktreeAdd { path, branch, shown }).await?)
            }
            Request::WorktreeRemove { repo, worktree, path, force } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                let cwd = crate::write::worktree::remove_cwd(&self.cli, &root).await?.display().to_string();
                let path = std::path::PathBuf::from(path);
                let shown = crate::write::worktree::shown(&self.cli, &root, &path).await;
                to_json(crate::write::run_write(self, repo, &cwd, Default::default(), crate::write::worktree::WorktreeRemove { path, force, shown }).await?)
            }
            Request::SuggestWorktreePath { repo, branch } => {
                let h = self.handle(repo)?;
                to_json(crate::write::worktree::suggest(&self.cli, &h.workdir, &branch).await?)
            }
            // --- end 2C T8 ---
            // --- 2C T4 ---
            Request::DeleteBranch { repo, worktree, branch, local, remote, force, expect } => to_json(crate::write::run_write(self, repo, &worktree, expect, crate::write::branch_delete::DeleteBranch::new(branch, local, remote, force)).await?),
            // --- end 2C T4 ---
            // --- 2D T9: integrate ---
            Request::Integrate { repo, worktree, kind, target, update_refs, expect, confirm } => to_json(crate::write::integrate::integrate(self, repo, &worktree, kind, target, update_refs, expect, confirm).await?),
            Request::RebaseControl { repo, worktree, action, message } => to_json(crate::write::rebase::control(self, repo, &worktree, action, message).await?),
            Request::PickControl { repo, worktree, action, message } => to_json(crate::write::pick::control(self, repo, &worktree, action, message).await?),
            // --- 3B T1 ---
            Request::CherryPick { repo, worktree, oids, no_commit, expect, confirm } => to_json(crate::write::sequence::sequence(self, repo, &worktree, crate::write::sequence::SequenceKind::CherryPick, oids, no_commit, expect, confirm).await?),
            Request::Revert { repo, worktree, oids, no_commit, expect, confirm } => to_json(crate::write::sequence::sequence(self, repo, &worktree, crate::write::sequence::SequenceKind::Revert, oids, no_commit, expect, confirm).await?),
            // --- end 3B T1 ---
            Request::CommitIdentity { repo, worktree } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(crate::write::commit::identity(&self.cli, &root).await?)
            }
            // --- end 2D T9 ---
            // --- 2D T10: integrate ---
            Request::IntegratePreview { repo, worktree, kind, target } => to_json(crate::write::integrate::preview(self, repo, &worktree, kind, target).await?),
            Request::RebasePlan { repo, worktree, branch, base } => to_json(crate::write::irebase::plan::rebase_plan(self, repo, &worktree, &branch, &base).await?),
            Request::PredictRebase { repo, worktree, base, rows } => to_json(crate::write::irebase::predict::predict(self, repo, &worktree, &base, rows).await?),
            // --- 3C T3 ---
            Request::InteractiveRebase { repo, worktree, branch, base, expect, rows, chips, confirm } => to_json(crate::write::irebase::run::interactive_rebase(self, repo, &worktree, branch, base, expect, rows, chips, confirm).await?),
            // --- end 3C T3 ---
            // --- 3C T6 ---
            Request::RewordCommit { repo, worktree, oid, message, expect, confirm } => to_json(crate::write::irebase::reword::reword_commit(self, repo, &worktree, oid, message, expect, confirm).await?),
            // --- end 3C T6 ---
            Request::FastForward { repo, worktree, branch, to, expect } => to_json(crate::write::run_write(self, repo, &worktree, expect, crate::write::integrate::FastForwardIntent { branch, to }).await?),
            Request::MergeAbort { repo, worktree } => to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::integrate::MergeAbortIntent).await?),
            // --- end 2D T10 ---
            // --- 2B T3 ---
            Request::WipHunks { repo, worktree, path, staged } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(crate::hunks::wip_hunks(&self.cli, &root, &path, staged).await?)
            }
            Request::StagePatch { repo, worktree, path, staged, selection, base } => to_json(crate::write::stage_patch::stage_patch(self, repo, &worktree, path, staged, selection, base).await?),
            // --- end 2B T3 ---
            // --- 2B T10 ---
            Request::SelectionLines { repo, worktree, path, staged, selection } => {
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                to_json(crate::write::stage_patch::selection_lines(&self.cli, &root, &path, staged, &selection).await?)
            }
            // --- end 2B T10 ---
            // --- 2B T4 ---
            Request::Discard { repo, worktree, scope } => to_json(crate::write::discard::discard(self, repo, &worktree, scope).await?),
            // --- end 2B T4 ---
            // --- 2D T11 ---
            Request::Push { repo, worktree, branch, target, set_upstream, lease, expect } => to_json(crate::write::sync::push(self, repo, &worktree, branch, target, set_upstream.unwrap_or(false), lease, expect).await?),
            // --- end 2D T11 ---
            // --- 2D T14 ---
            Request::Pull { repo, worktree, branch, mode, expect, confirm } => to_json(crate::write::sync::pull(self, repo, &worktree, branch, mode, expect, confirm).await?),
            // --- end 2D T14 ---
            // --- 2C T5: checkout ---
            Request::Checkout { repo, worktree, target, on_diverged, expect, confirm_autostash } => {
                let confirm = crate::write::types::Confirm { autostash: confirm_autostash.unwrap_or(false) };
                to_json(crate::write::run_write(self, repo, &worktree, expect, crate::write::checkout::Checkout::new(target, on_diverged, confirm)).await?)
            }
            // --- end 2C T5 ---
            // --- 2C T7 ---
            Request::StashPush { repo, worktree, message } => to_json(crate::write::stash::stash_push(self, repo, &worktree, message).await?),
            Request::StashApply { repo, worktree, oid, pop, without_index } => to_json(crate::write::stash::stash_apply(self, repo, &worktree, oid, pop, without_index.unwrap_or(false)).await?),
            Request::StashDrop { repo, worktree, oid } => to_json(crate::write::stash::stash_drop(self, repo, &worktree, oid).await?),
            // --- end 2C T7 ---
            // --- 2C T6: reset ---
            Request::Reset { repo, worktree, to, mode, expect, discard } => {
                // `X` for the label and the question: the worktree's branch, or `HEAD`.
                let h = self.handle(repo)?;
                let root = self.worktree_dir(&h, &worktree).await?;
                let x = blocking(move || {
                    let repo = gix::open(&root).map_err(crate::error::gix_err)?;
                    Ok(crate::write::head_state(&repo)?.branch.unwrap_or_else(|| "HEAD".to_string()))
                })
                .await?;
                to_json(crate::write::run_write(self, repo, &worktree, expect, crate::write::reset::Reset { to, mode, discard: discard.unwrap_or(false), x }).await?)
            }
            // --- end 2C T6 ---
            // --- 3B T3 ---
            Request::CreateTag { repo, worktree, name, target, message } => to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::tags::CreateTag { name, target, message }).await?),
            Request::DeleteTag { repo, worktree, name, local, remote } => to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::tags::DeleteTag { name, local, remote }).await?),
            Request::PushTags { repo, worktree, remote, tag } => to_json(crate::write::run_write(self, repo, &worktree, Default::default(), crate::write::tags::PushTags { remote, tag }).await?),
            // --- end 3B T3 ---
        }
    }

    /// The detected openers. With a cached detection (and not `force`d), that one, at once; if
    /// it's `opener_refresh` old, a re-detection runs in the background (one at a time) for the
    /// next caller (fix round 2: nothing waits on it). Without one, or `force`d, a detection now.
    /// Detection runs on the blocking pool (it reads the disk and asks `xdg-mime`); one that
    /// panics is an error and isn't cached. Empty when none are configured.
    async fn openers(&self, force: bool) -> Result<Arc<Vec<Opener>>, GbError> {
        let Some(src) = self.openers.clone() else { return Ok(Arc::default()) };
        let cached = src.found.lock().expect("openers poisoned").clone();
        if let Some((at, list)) = cached.filter(|_| !force) {
            if at.elapsed() >= self.opener_refresh && !src.refreshing.swap(true, Ordering::SeqCst) {
                tokio::spawn(async move {
                    let _ = src.detect_now().await;
                    src.refreshing.store(false, Ordering::SeqCst);
                });
            }
            return Ok(list);
        }
        src.detect_now().await
    }

    /// The file an editor or the chooser opens for `path` in the worktree `root`: the working-tree
    /// file (`source` absent or a worktree), or a read-only copy of the stored version. A
    /// working-tree file that's gone (a WIP file staged, then deleted there) opens `fallback`,
    /// the version its list has, when there is one (fix round 2).
    async fn open_in_file(&self, h: &Arc<RepoHandle>, root: &Path, path: &str, source: Option<BlobSource>, fallback: Option<BlobSource>) -> Result<PathBuf, GbError> {
        match source {
            None | Some(BlobSource::Worktree { .. }) => match (worktree_file(root, path), fallback) {
                (Err(e), Some(stored @ (BlobSource::Object { .. } | BlobSource::AtCommit { .. }))) if e.kind == GbErrorKind::NotFound => self.stored_copy(h, path, stored).await,
                (found, _) => found,
            },
            Some(stored) => self.stored_copy(h, path, stored).await,
        }
    }

    /// A read-only copy of `path`'s stored version `source` (spec §14.5).
    async fn stored_copy(&self, h: &Arc<RepoHandle>, path: &str, source: BlobSource) -> Result<PathBuf, GbError> {
        let (side, oid) = match source {
            BlobSource::Worktree { .. } => return Err(GbError::new(GbErrorKind::InvalidInput, "not a stored version")),
            BlobSource::Object { oid } => {
                let oid = parse_oid(&oid)?;
                (Side::Object(oid), oid)
            }
            BlobSource::AtCommit { commit } => {
                let commit = parse_oid(&commit)?;
                (Side::AtCommit(commit), commit)
            }
            BlobSource::Absent | BlobSource::Submodule { .. } => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} has no file to open on that side"))),
        };
        crate::blob::check_relative(path)?;
        let cache = self.open_cache.clone().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "old versions can't be opened here"))?;
        let (h, path) = (h.clone(), path.to_string());
        blocking(move || {
            let bytes = crate::blob::side_bytes(&h.repo.to_thread_local(), &path, &side, crate::diff::MAX_FORCED_BYTES)?;
            crate::open_copy::write_copy(&cache, &oid.to_hex_with_len(12).to_string(), &path, &bytes)
        })
        .await
    }

    pub(crate) fn handle(&self, id: u32) -> Result<Arc<RepoHandle>, GbError> {
        self.repos
            .lock()
            .expect("repos poisoned")
            .get(&id)
            .cloned()
            .ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("no open repository with id {id}")))
    }

    // --- 4A T7 ---
    /// Replaces handle `id` with one reopened from its workdir: gix keeps the config snapshot
    /// from when a repository opened, so a remote added since is unknown to `remote_names()`
    /// (the sidebar, the graph's labels, the forge mapping). The caches move over. Holders of the
    /// old handle finish with it.
    pub(crate) fn reopen_repo(&self, id: u32) -> Result<(), GbError> {
        let old = self.handle(id)?;
        let repo = gix::ThreadSafeRepository::open(&old.workdir).map_err(crate::error::gix_err)?;
        let fresh = Arc::new(RepoHandle {
            repo,
            workdir: old.workdir.clone(),
            name: old.name.clone(),
            common_dir: old.common_dir.clone(),
            wip: old.wip.clone(),
            snapshot: Mutex::new(old.snapshot.lock().expect("snapshot poisoned").clone()),
            walk: old.walk.clone(),
        });
        self.repos.lock().expect("repos poisoned").insert(id, fresh);
        Ok(())
    }
    // --- end 4A T7 ---

    pub(crate) async fn open_repo(&self, path: &str) -> Result<RepoSummary, GbError> {
        self.git_version().await?;
        let repo = gix::ThreadSafeRepository::discover(path)
            .map_err(|_| GbError::new(GbErrorKind::NotFound, format!("Not a git repository: {path}")))?;
        let opened = repo
            .work_dir()
            .map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()))
            .ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Bare repositories are not supported"))?;
        let common_dir = {
            let local = repo.to_thread_local();
            local.common_dir().canonicalize().unwrap_or_else(|_| local.common_dir().to_path_buf())
        };
        // One handle per repository (spec #2 §11.2, 2C Deviation 2): whichever worktree opens,
        // it's the handle of its common dir, and the summary names the worktree opened.
        let summary = |id: u32, h: &RepoHandle| RepoSummary { id, path: h.workdir.display().to_string(), name: h.name.clone(), worktree: opened.display().to_string() };
        let open = |repos: &HashMap<u32, Arc<RepoHandle>>| repos.iter().find(|(_, h)| h.common_dir == common_dir).map(|(&id, h)| (id, h.clone()));
        if let Some((id, h)) = open(&self.repos.lock().expect("repos poisoned")) {
            return Ok(summary(id, &h));
        }
        // The handle lives in the main worktree; a bare main keeps the one opened.
        let main = crate::worktree::list_worktrees(&self.cli, &opened).await?.into_iter().find(|w| w.is_main && !w.bare && w.path.is_dir()).map(|w| w.path.canonicalize().unwrap_or(w.path));
        let workdir = main.unwrap_or_else(|| opened.clone());
        let repo = if workdir == opened { repo } else { gix::ThreadSafeRepository::open(&workdir).map_err(crate::error::gix_err)? };
        let name = workdir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| workdir.display().to_string());
        // Lock order: `repos`, then `write_locks` (nothing takes them the other way round).
        self.recover_journals(&workdir, &common_dir);
        let mut repos = self.repos.lock().expect("repos poisoned");
        if let Some((id, h)) = open(&repos) {
            return Ok(summary(id, &h));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let h = Arc::new(RepoHandle {
            repo,
            workdir,
            name,
            common_dir: common_dir.clone(),
            wip: Arc::new(crate::snapshot::WipCache::watched_only()),
            snapshot: Mutex::new(None),
            walk: Arc::default(),
        });
        repos.insert(id, h.clone());
        self.writes_for(&common_dir).add_id(id);
        Ok(summary(id, &h))
    }

    /// The repository's write lock and queue, shared by every handle (worktree tab) of it.
    pub(crate) fn repo_writes(&self, h: &RepoHandle) -> Arc<crate::write::queue::RepoWrites> {
        self.writes_for(&h.common_dir)
    }

    fn writes_for(&self, common_dir: &Path) -> Arc<crate::write::queue::RepoWrites> {
        let mut map = self.write_locks.lock().expect("write locks poisoned");
        map.entry(common_dir.to_path_buf())
            .or_insert_with(|| {
                let bus = self.bus.clone();
                Arc::new(crate::write::queue::RepoWrites::new(move |repo, s| {
                    bus.emit(AppEvent::QueueChanged { repo, running: s.running.clone(), queued: s.queued.clone(), stopped: s.stopped.clone() });
                }))
            })
            .clone()
    }

    /// The canonical path of `worktree`, if it's one of this repository's usable worktrees. Every
    /// request that reads a worktree goes through this, so a UI bug or a crafted request can't
    /// point GitBolt at an arbitrary directory.
    pub(crate) async fn worktree_dir(&self, h: &RepoHandle, worktree: &str) -> Result<PathBuf, GbError> {
        let invalid = || GbError::new(GbErrorKind::InvalidInput, format!("{worktree} is not a worktree of this repository"));
        let wanted = Path::new(worktree).canonicalize().map_err(|_| invalid())?;
        // --- 2D T9 review P1: the main worktree needs no `worktree list` ---
        if h.workdir.canonicalize().is_ok_and(|w| w == wanted) {
            return Ok(wanted);
        }
        // --- end 2D T9 ---
        list_worktrees(&self.cli, &h.workdir)
            .await?
            .into_iter()
            .filter(|w| !w.bare && !w.prunable)
            .map(|w| w.path.canonicalize().unwrap_or(w.path))
            .find(|p| *p == wanted)
            .ok_or_else(invalid)
    }

    /// Validates a UI-supplied blob source: object ids must be full hex, and a worktree must be
    /// one of this repo's (plus its declared `working-tree-encoding` for `path`).
    async fn resolve_side(&self, h: &RepoHandle, path: &str, src: BlobSource) -> Result<Side, GbError> {
        Ok(match src {
            BlobSource::Absent => Side::Absent,
            BlobSource::Object { oid } => Side::Object(parse_oid(&oid)?),
            BlobSource::Submodule { oid } => Side::Submodule(parse_oid(&oid)?.to_string()),
            BlobSource::AtCommit { commit } => Side::AtCommit(parse_oid(&commit)?),
            BlobSource::Worktree { worktree } => {
                let root = self.worktree_dir(h, &worktree).await?;
                // Reject escaping paths before git sees them (`check-attr` would fail with a
                // generic error); `diff_contents` joins the path again when it reads the file.
                safe_join(&root, path)?;
                let encoding = working_tree_encoding(&self.cli, &root, path).await?;
                Side::Worktree { root, encoding }
            }
        })
    }
}

/// The file "Open in…" hands an editor or the chooser: the working-tree file for a worktree
/// source (or none), which must exist and resolve inside the worktree, outside `.git` (a
/// committed symlink to `.git/config`, or out of the worktree entirely, is refused); for a stored
/// version, a read-only copy of its bytes (spec §14.5, `open_copy`). `safe_join` / `check_relative`
/// reject escaping, absolute and `.git` paths first, but only up to the leaf: `path`'s own last
/// component may be a symlink (that's what `safe_join` hands its other callers), so it's resolved
/// here and checked again — a symlinked leaf can point through `.git` even when no path segment
/// before it does.
fn worktree_file(root: &Path, path: &str) -> Result<PathBuf, GbError> {
    let escaped = || GbError::new(GbErrorKind::InvalidInput, format!("{path} points outside the worktree"));
    let joined = safe_join(root, path)?;
    let real = joined.canonicalize().map_err(|_| GbError::new(GbErrorKind::NotFound, format!("{path} isn't in the working tree")))?;
    let inside = real.strip_prefix(root).map_err(|_| escaped())?;
    if !inside.components().all(|c| matches!(c, Component::Normal(n) if !is_dotgit(&n.to_string_lossy()))) {
        return Err(escaped());
    }
    Ok(joined)
}

/// The file manager's folder: the file's working-tree folder, or its nearest existing parent
/// inside the worktree when it's gone (a deleted file's folder, a file at an old commit).
fn folder_target(root: &Path, path: &str) -> Result<PathBuf, GbError> {
    crate::blob::check_relative(path)?;
    let mut dir = root.join(path);
    while dir.pop() && dir.starts_with(root) {
        if let Ok(real) = dir.canonicalize()
            && real.is_dir()
            && real.starts_with(root)
        {
            return Ok(real);
        }
    }
    Ok(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};

    fn api() -> Api {
        Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), Some("/launch/path".into()))
    }

    #[tokio::test]
    async fn the_write_guard_decides_and_none_allows_everything() {
        let r = TestRepo::new();
        let common = r.path().join(".git");
        assert!(api().check_write(&common).is_ok(), "no guard: the app");
        let guarded = api().with_write_guard(Arc::new(|_: &Path| Err(GbError::new(GbErrorKind::InvalidInput, FIXTURE_ONLY))));
        let err = guarded.check_write(&common).unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "writes are limited to fixture repositories"));
    }

    /// An unverified signature (a good one from a key that isn't trusted yet) is looked at again
    /// next time, as an unknown key is, so trusting the key shows without a restart.
    #[test]
    fn only_settled_signature_statuses_are_cached() {
        for kind in [SignatureKind::Verified, SignatureKind::Bad, SignatureKind::Expired, SignatureKind::Unsigned] {
            assert!(cacheable(kind), "{kind:?}");
        }
        for kind in [SignatureKind::Unverified, SignatureKind::UnknownKey] {
            assert!(!cacheable(kind), "{kind:?}");
        }
    }

    fn req(json: serde_json::Value) -> Request {
        serde_json::from_value(json).unwrap()
    }

    #[tokio::test]
    async fn logging_requests_are_harmless_without_a_log_handle() {
        let api = api();
        assert_eq!(api.dispatch(req(serde_json::json!({"method": "logsDir"}))).await.unwrap(), serde_json::Value::Null);
        assert_eq!(api.dispatch(req(serde_json::json!({"method": "setDebugLogging", "params": {"debug": true}}))).await.unwrap(), serde_json::Value::Null);
        let logged = api.dispatch(req(serde_json::json!({"method": "logFrontend", "params": {"level": "error", "message": "boom", "stack": null}}))).await;
        assert_eq!(logged.unwrap(), serde_json::Value::Null);
    }

    #[tokio::test]
    async fn logs_dir_comes_from_the_handle() {
        let dir = tempfile::tempdir().unwrap();
        let (_sub, logging) = crate::logging::build(dir.path(), false, false).unwrap();
        let api = api().with_log_handle(logging.handle.clone());
        let got = api.dispatch(req(serde_json::json!({"method": "logsDir"}))).await.unwrap();
        assert_eq!(got, dir.path().display().to_string());
    }

    #[tokio::test]
    async fn a_panicking_request_becomes_an_error() {
        let err = catch_panics("graph", async { panic!("boom") }).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Other);
        assert!(err.message.contains("graph") && err.message.contains("boom"), "{}", err.message);
    }

    #[tokio::test]
    async fn a_panic_message_is_redacted_before_it_reaches_the_ui() {
        let token = format!("glpat-{}", "d".repeat(24));
        let err = catch_panics("fetch", async move { panic!("clone https://u:{token}@h.example.com/r.git failed") }).await.unwrap_err();
        assert!(err.message.contains("h.example.com") && !err.message.contains("glpat-"), "{}", err.message);
    }

    #[test]
    fn variant_names_never_include_parameters() {
        assert_eq!(variant_name(&Request::LogsDir), "LogsDir");
        assert_eq!(variant_name(&Request::OpenRepo { path: "/secret/path".into() }), "OpenRepo");
    }

    // --- UX R1 C.4 ---
    #[test]
    fn a_write_failures_paths_are_made_relative() {
        let roots = [PathBuf::from("/w/repo")];
        let git = Path::new("/w/repo/.git");
        let rel = |m: &str| relative_message(m, &roots, Some(git));
        assert_eq!(rel("/w/repo/.git/MERGE_MSG: Permission denied"), ".git/MERGE_MSG: Permission denied");
        assert_eq!(rel("error: '/w/repo/src/a.rs' is in the way"), "error: 'src/a.rs' is in the way");
        assert_eq!(rel("fatal: not a git repository: /w/repo"), "fatal: not a git repository: .");
        assert_eq!(rel("/w/repo2/x stays"), "/w/repo2/x stays", "a whole path only");
        assert_eq!(rel("fatal: unable to access 'https://ada:pw@h/x.git/'"), "fatal: unable to access 'https://***@h/x.git/'");
        if let Some(home) = dirs::home_dir().filter(|h| h.as_os_str().len() > 1) {
            assert_eq!(rel(&format!("{}/elsewhere/f", home.display())), "~/elsewhere/f");
        }
    }

    #[test]
    fn a_write_requests_scope_is_read_from_its_debug_text() {
        let req: Request = serde_json::from_value(serde_json::json!({"method": "discard", "params": {"repo": 7, "worktree": "/w/a \"b\"", "scope": {"kind": "all"}}})).unwrap();
        assert_eq!(write_scope(&format!("{req:?}")), (Some(7), Some(PathBuf::from("/w/a \"b\""))));
        assert_eq!(wire_method("CherryPick"), "cherryPick");
    }

    /// A failed write's WARN line: its method, kind and message, and no absolute path.
    #[tokio::test]
    async fn a_failed_write_is_logged_at_warn() {
        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let out = buf.clone();
        let sub = tracing_subscriber::fmt().with_writer(move || out.clone()).with_ansi(false).with_max_level(tracing::Level::INFO).finish();
        let _guard = tracing::subscriber::set_default(sub);
        let data = tempfile::tempdir().unwrap();
        let r = crate::write::test_support::repo();
        let api = crate::write::test_support::api(data.path());
        let id = crate::write::test_support::open(&api, &r).await;
        let wt = crate::write::test_support::wt(r.path());
        let err = crate::write::test_support::call(&api, "discard", serde_json::json!({"repo": id, "worktree": wt, "scope": {"kind": "paths", "paths": ["nope.txt"]}})).await.unwrap_err();
        crate::write::test_support::call(&api, "graph", serde_json::json!({"repo": id})).await.unwrap();
        let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        let line = text.lines().find(|l| l.contains("write failed")).unwrap_or_else(|| panic!("no WARN line in {text}"));
        assert!(line.contains("WARN") && line.contains("method=discard") && line.contains(&format!("kind={:?}", err.kind)), "{line}");
        assert!(line.contains(&err.message) || line.contains("nope.txt"), "{line}");
        assert!(!text.contains(&wt), "no absolute path: {text}");
        assert_eq!(text.lines().filter(|l| l.contains("write failed")).count(), 1, "reads aren't logged: {text}");
    }
    // --- end UX R1 C.4 ---

    #[tokio::test]
    async fn diagnostics_reports_versions_and_scrubbed_settings() {
        let text = api()
            .dispatch(req(serde_json::json!({"method": "diagnostics", "params": {"ui": {"userAgent": "Chrome/152.0.7977.83", "settings": {"token": "abc"}}}})))
            .await
            .unwrap();
        let text = text.as_str().unwrap();
        assert!(text.starts_with("GitBolt "));
        assert!(text.contains("Runtime: harness") && text.contains("Chromium: 152.0.7977.83") && text.contains("git: 2."));
        assert!(!text.contains("abc"));
    }

    #[tokio::test]
    async fn open_logs_folder_launches_the_file_manager_on_the_log_dir() {
        let dir = tempfile::tempdir().unwrap();
        let (_sub, logging) = crate::logging::build(dir.path(), false, false).unwrap();
        let (with_log, launches) = with_openers(api());
        let with_log = with_log.with_log_handle(logging.handle.clone());
        assert_eq!(with_log.dispatch(req(serde_json::json!({"method": "openLogsFolder"}))).await.unwrap(), serde_json::Value::Null);
        {
            let launched = launches.lock().unwrap();
            assert_eq!(launched.len(), 1, "{launched:?}");
            assert!(launched[0].args.iter().any(|a| a == dir.path().as_os_str()), "{launched:?}");
        }
        let bare = with_openers(api()).0.dispatch(req(serde_json::json!({"method": "openLogsFolder"}))).await.unwrap_err();
        assert_eq!(bare.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn open_then_graph() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let opened = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap();
        assert_eq!(opened["name"], "repo");
        let id = opened["id"].as_u64().unwrap();
        let sub = r.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let again = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": sub}}))).await.unwrap();
        assert_eq!(again["id"].as_u64().unwrap(), id, "same repo reuses its id");
        let graph = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert_eq!(graph["rows"].as_array().unwrap().len(), 10);
        assert_eq!(graph["rows"][0]["kind"], "wip", "the open worktree's WIP is row 0");
    }

    #[tokio::test]
    async fn not_a_repo_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = api().dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": dir.path()}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
        assert!(err.message.starts_with("Not a git repository"));
    }

    #[tokio::test]
    async fn bare_repo_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(dir.path())
            .envs(isolated_git_env())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let err = api().dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": dir.path()}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn unknown_repo_id_is_invalid_input() {
        let err = api().dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": 99, "limit": null}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn launch_repo_and_command_log() {
        let api = api();
        assert_eq!(api.dispatch(req(serde_json::json!({"method": "launchRepo"}))).await.unwrap(), "/launch/path");
        assert!(api.dispatch(req(serde_json::json!({"method": "commandLog"}))).await.unwrap().is_array());
    }

    /// R19: a path forwarded before anyone listens is still there for the UI's boot-time take,
    /// and each one is taken once.
    #[tokio::test]
    async fn forwarded_paths_wait_for_take_open_requests_and_are_taken_once() {
        let api = api();
        api.request_open("/a".into());
        let mut events = api.subscribe();
        api.request_open("/b".into());
        assert_eq!(events.recv().await.unwrap(), AppEvent::OpenRequested { path: "/b".into() });
        let take = || api.dispatch(req(serde_json::json!({"method": "takeOpenRequests"})));
        assert_eq!(take().await.unwrap(), serde_json::json!(["/a", "/b"]));
        assert_eq!(take().await.unwrap(), serde_json::json!([]));
        for i in 0..MAX_OPEN_REQUESTS + 2 {
            api.request_open(format!("/r{i}"));
        }
        let kept = take().await.unwrap();
        assert_eq!(kept.as_array().unwrap().len(), MAX_OPEN_REQUESTS);
        assert_eq!(kept[0], "/r2", "the oldest go first");
    }

    #[tokio::test]
    async fn state_round_trips_through_dispatch() {
        let api = api();
        let st = api.dispatch(req(serde_json::json!({"method": "loadState"}))).await.unwrap();
        assert_eq!(st["profile"]["id"], "default");
        let mut profile = st["profile"].clone();
        profile["tabs"] = serde_json::json!([{"id": "t1", "kind": "repo", "path": "/r", "alias": null}]);
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": profile}}))).await.unwrap();
        let st = api.dispatch(req(serde_json::json!({"method": "loadState"}))).await.unwrap();
        assert_eq!(st["profile"]["tabs"][0]["path"], "/r");
        let mut settings = st["settings"].clone();
        settings["fetchIntervalSecs"] = serde_json::json!(0);
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": settings}}))).await.unwrap();
        assert_eq!(api.store().state().settings.fetch_interval_secs, 0);
        let made = api.dispatch(req(serde_json::json!({"method": "createProfile", "params": {"name": "Work", "color": "#f00"}}))).await.unwrap();
        let switched = api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": made["id"]}}))).await.unwrap();
        assert_eq!(switched["profile"]["name"], "Work");
        assert_eq!(switched["profiles"].as_array().unwrap().len(), 2);
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": "default"}}))).await.unwrap();
        let left = api.dispatch(req(serde_json::json!({"method": "deleteProfile", "params": {"id": made["id"]}}))).await.unwrap();
        assert_eq!(left, serde_json::json!([{"id": "default", "name": "Default", "color": "#4d88ff"}]));
    }

    #[tokio::test]
    async fn profile_extra_gitconfig_reaches_git_commands() {
        let r = TestRepo::new();
        r.commit("a");
        let inc = r.root().join("work.gitconfig");
        std::fs::write(&inc, "[gitbolt]\n\tprobe = work\n").unwrap();
        let api = api();
        let mut p = api.store().active_profile();
        p.extra_gitconfig = Some(inc.display().to_string());
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": p}}))).await.unwrap();
        let out = api.cli.run(crate::git::GitInvocation::new(r.path(), ["config", "gitbolt.probe"])).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "work");
        // A blank path is no include at all; switching to a profile without one drops it.
        p.extra_gitconfig = Some("  ".into());
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": p}}))).await.unwrap();
        assert_eq!(api.cli.include_path(), None);
        p.extra_gitconfig = Some(inc.display().to_string());
        api.dispatch(req(serde_json::json!({"method": "saveProfile", "params": {"profile": p}}))).await.unwrap();
        let made = api.dispatch(req(serde_json::json!({"method": "createProfile", "params": {"name": "Plain", "color": "#0f0"}}))).await.unwrap();
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": made["id"]}}))).await.unwrap();
        assert!(api.cli.run(crate::git::GitInvocation::new(r.path(), ["config", "gitbolt.probe"])).await.is_err());
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": "default"}}))).await.unwrap();
        assert_eq!(api.cli.include_path(), Some(inc.clone()));
        // A store opened with an active profile that has one applies it at once.
        let other = super::Api::new(GitCli::new(Arc::new(CommandLog::new(10))), None).with_store(api.store().clone());
        assert_eq!(other.cli.include_path(), Some(inc));
    }

    #[tokio::test]
    async fn shell_data_requests_dispatch() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let s = api.dispatch(req(serde_json::json!({"method": "sidebar", "params": {"repo": id}}))).await.unwrap();
        assert!(s["locals"].as_array().unwrap().iter().any(|b| b["name"] == "main" && b["isHead"] == true));
        assert_eq!(s["remotes"][0]["name"], "origin");
        let lp = api.dispatch(req(serde_json::json!({"method": "lastPush", "params": {"repo": id, "remoteRef": "refs/remotes/origin/main"}}))).await.unwrap();
        assert_eq!(lp["kind"], "push");
        let bad = api.dispatch(req(serde_json::json!({"method": "lastPush", "params": {"repo": id, "remoteRef": "../../etc/passwd"}}))).await.unwrap_err();
        assert_eq!(bad.kind, GbErrorKind::InvalidInput);
        let info = api.dispatch(req(serde_json::json!({"method": "repoInfo", "params": {"repo": id}}))).await.unwrap();
        assert_eq!(info["remotes"][0]["name"], "origin");
        assert!(info["mainWorktree"].is_null());
        let before = api.command_log().entries().len();
        let app = api.dispatch(req(serde_json::json!({"method": "appInfo"}))).await.unwrap();
        assert_eq!(app["appVersion"], env!("CARGO_PKG_VERSION"));
        assert!(app["gitVersion"].as_str().unwrap().starts_with('2'));
        assert_eq!(api.command_log().entries().len(), before, "the git version is the one openRepo cached");
    }

    #[tokio::test]
    async fn graph_accepts_a_pin_choice() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let graph = |pin: serde_json::Value| req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "pin": pin}}));
        let auto = api.dispatch(graph(serde_json::json!({"kind": "auto"}))).await.unwrap();
        assert!(auto["pinnedRef"].is_string());
        assert!(api.dispatch(graph(serde_json::json!({"kind": "off"}))).await.unwrap()["pinnedRef"].is_null());
        let hotfix = api.dispatch(graph(serde_json::json!({"kind": "ref", "name": "refs/heads/hotfix"}))).await.unwrap();
        assert_eq!(hotfix["pinnedRef"], "refs/heads/hotfix");
        let absent = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert_eq!(absent["pinnedRef"], auto["pinnedRef"], "no pin is the default trunk");
    }

    #[tokio::test]
    async fn pick_folder_scan_repos_and_suggest_repos_folder_dispatch() {
        let api = api();
        assert!(api.dispatch(req(serde_json::json!({"method": "pickFolder", "params": {"start": null}}))).await.unwrap().is_null(), "no picker: nothing picked");
        let asked: Arc<Mutex<Vec<Option<PathBuf>>>> = Arc::default();
        let sink = asked.clone();
        let api = api.with_folder_picker(Arc::new(move |start: Option<&Path>| {
            sink.lock().unwrap().push(start.map(Path::to_path_buf));
            Some(PathBuf::from("/picked/here"))
        }));
        let picked = api.dispatch(req(serde_json::json!({"method": "pickFolder", "params": {"start": "/start"}}))).await.unwrap();
        assert_eq!(picked, "/picked/here");
        assert_eq!(*asked.lock().unwrap(), [Some(PathBuf::from("/start"))]);

        let home = tempfile::tempdir().unwrap();
        let api = api.with_home(Some(home.path().to_path_buf()));
        let suggest = || req(serde_json::json!({"method": "suggestReposFolder"}));
        assert!(api.dispatch(suggest()).await.unwrap().is_null(), "no ~/repos yet");
        let repos = home.path().join("repos");
        TestRepo::init_at(&repos.join("one")).commit("a");
        assert_eq!(api.dispatch(suggest()).await.unwrap(), repos.display().to_string());

        let scan = |refresh: bool| req(serde_json::json!({"method": "scanRepos", "params": {"root": repos, "refresh": refresh}}));
        assert_eq!(api.dispatch(scan(false)).await.unwrap().as_array().unwrap().len(), 1);
        TestRepo::init_at(&repos.join("two")).commit("b");
        assert_eq!(api.dispatch(scan(false)).await.unwrap().as_array().unwrap().len(), 1, "cached per root");
        assert_eq!(api.dispatch(scan(true)).await.unwrap().as_array().unwrap().len(), 2, "refresh rescans");
        let rel = api.dispatch(req(serde_json::json!({"method": "scanRepos", "params": {"root": "relative", "refresh": false}}))).await.unwrap_err();
        assert_eq!(rel.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn scan_folders_merges_dedupes_and_skips_bad_folders() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        TestRepo::init_at(&a.path().join("one")).commit("a");
        TestRepo::init_at(&b.path().join("two")).commit("b");
        let api = api();
        let scan = |roots: serde_json::Value| req(serde_json::json!({"method": "scanFolders", "params": {"roots": roots, "refresh": false}}));
        let got = api.dispatch(scan(serde_json::json!([a.path(), b.path(), a.path(), "relative", "/no/such/dir"]))).await.unwrap();
        assert_eq!(got.as_array().unwrap().len(), 2, "{got}");
        assert!(api.dispatch(scan(serde_json::json!([]))).await.unwrap().as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_custom_editor_template_opens_through_the_launcher() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (api, launches) = with_openers(api());
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let open_custom = |line: Option<u32>| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": line, "opener": "custom"}}));
        assert_eq!(api.dispatch(open_custom(None)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "no custom command set");
        let mut p = api.store().active_profile();
        p.editor = Some(crate::settings::EditorChoice::Custom { template: "/bin/echo --goto {file}:{line} --project {repo}".into() });
        api.store().save_profile(p.clone()).unwrap();
        api.dispatch(open_custom(Some(7))).await.unwrap();
        let file = wt.join("src/app.php").display().to_string();
        assert_eq!(argv(launches.lock().unwrap().last().unwrap()), ["/bin/echo", "--goto", &format!("{file}:7"), "--project", &wt.display().to_string()]);
        // The repo's own editor wins over the profile's.
        p.repos.insert(wt.display().to_string(), crate::settings::RepoSettings { editor: Some(crate::settings::EditorChoice::Custom { template: "/bin/echo {file}".into() }), ..Default::default() });
        api.store().save_profile(p.clone()).unwrap();
        api.dispatch(open_custom(None)).await.unwrap();
        assert_eq!(argv(launches.lock().unwrap().last().unwrap()), ["/bin/echo", &file]);
        // The same path checks as any editor, and the template guard.
        let escape = req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "../x", "line": null, "opener": "custom"}}));
        assert_eq!(api.dispatch(escape).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        p.repos.clear();
        p.editor = Some(crate::settings::EditorChoice::Custom { template: "/bin/sh -c 'vim {file}'".into() });
        api.store().save_profile(p.clone()).unwrap();
        assert_eq!(api.dispatch(open_custom(None)).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        p.editor = Some(crate::settings::EditorChoice::Opener { id: "vscode".into() });
        api.store().save_profile(p).unwrap();
        assert_eq!(api.dispatch(open_custom(None)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "the editor is an opener, not a custom command");
        assert_eq!(launches.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn auth_answer_and_cancel_op_dispatch() {
        let api = api();
        let answer = |prompt: u64| req(serde_json::json!({"method": "authAnswer", "params": {"prompt": prompt, "answer": "x"}}));
        assert_eq!(api.dispatch(answer(1)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "no askpass yet");
        assert!(api.dispatch(req(serde_json::json!({"method": "cancelOp", "params": {"op": 42}}))).await.unwrap().is_null(), "unknown ids are ignored");
        let op = api.ops().begin(crate::events::OpKind::Fetch, None, true);
        api.dispatch(req(serde_json::json!({"method": "cancelOp", "params": {"op": op.id}}))).await.unwrap();
        assert!(op.cancel.is_cancelled());
        assert!(api.net_env(op.id).is_empty(), "no askpass: no askpass environment");
        let dir = tempfile::tempdir().unwrap();
        api.start_askpass(dir.path(), "/bin/false".into()).await.unwrap();
        let first = api.askpass().unwrap().socket_path().to_path_buf();
        api.start_askpass(dir.path(), "/bin/true".into()).await.unwrap();
        assert_eq!(api.askpass().unwrap().socket_path(), first, "started once");
        assert_eq!(api.dispatch(answer(1)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "no such prompt");
        let env = api.net_env(op.id);
        assert!(env.iter().any(|(k, v)| k == crate::askpass::ENV_OP && *v == *op.id.to_string()));
        assert!(!env.iter().any(|(k, _)| k == "GCM_INTERACTIVE"), "a user-started op may prompt through a credential manager");
        // A GitBolt-started op never prompts, not even through Git Credential Manager's own UI.
        let background = api.ops().begin(crate::events::OpKind::Fetch, Some(1), false);
        let env = api.net_env(background.id);
        assert!(env.iter().any(|(k, v)| k == "GCM_INTERACTIVE" && v == "never"), "{env:?}");
        assert!(super::Api::new(GitCli::new(Arc::new(CommandLog::new(10))), None).net_env(background.id).is_empty(), "an op this Api doesn't know");
        let plain = super::tests::api();
        let bg = plain.ops().begin(crate::events::OpKind::Fetch, Some(1), false);
        assert_eq!(plain.net_env(bg.id), vec![("GCM_INTERACTIVE".into(), "never".into())], "even without askpass");
    }

    #[tokio::test]
    async fn commit_message_is_loaded_on_demand() {
        let r = TestRepo::new();
        fixtures::long_labels(&r);
        let api = api();
        let id = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap()["id"].as_u64().unwrap();
        let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
        let m = api.dispatch(req(serde_json::json!({"method": "commitMessage", "params": {"repo": id, "id": root}}))).await.unwrap();
        assert_eq!(m, serde_json::json!({"id": root, "summary": "Initial commit", "body": "With a body line\n\nA second paragraph,\nwrapped over two lines."}));
        let graph = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert!(graph["rows"][0].get("body").is_none(), "graph rows don't carry full bodies");
        let err = api.dispatch(req(serde_json::json!({"method": "commitMessage", "params": {"repo": id, "id": "1".repeat(40)}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
    }

    async fn open(api: &Api, r: &TestRepo) -> u64 {
        api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap()["id"].as_u64().unwrap()
    }

    #[tokio::test]
    async fn commit_details_and_remotes_dispatch() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let rename = r.git(&["rev-parse", "HEAD^1"]);
        let d = api.dispatch(req(serde_json::json!({"method": "commitDetails", "params": {"repo": id, "id": rename}}))).await.unwrap();
        assert_eq!(d["coAuthors"][0]["name"], "Margaret Hamilton");
        assert_eq!(d["committer"]["name"], "Ada Lovelace");
        assert!(d.get("summary").is_none() && d.get("body").is_none(), "the message itself comes from commitMessage");
        let bad = api.dispatch(req(serde_json::json!({"method": "commitDetails", "params": {"repo": id, "id": "HEAD"}}))).await.unwrap_err();
        assert_eq!(bad.kind, GbErrorKind::InvalidInput);
        let remotes = api.dispatch(req(serde_json::json!({"method": "remotes", "params": {"repo": id}}))).await.unwrap();
        assert_eq!(remotes[0]["hostKind"], "gitlab");
        assert_eq!(remotes[0]["path"], "group/project");
    }

    #[tokio::test]
    async fn file_list_dispatch_and_worktree_validation() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let list = api.dispatch(req(serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "commit", "id": head, "parent": 1}}}))).await.unwrap();
        assert_eq!(list["files"].as_array().unwrap().len(), 10);
        let wt = r.path().to_string_lossy().into_owned();
        let wip = api.dispatch(req(serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": wt, "staged": false}}}))).await.unwrap();
        assert_eq!(wip["files"][1]["new"]["kind"], "worktree");
        let elsewhere = tempfile::tempdir().unwrap();
        let err = api
            .dispatch(req(serde_json::json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": elsewhere.path(), "staged": false}}})))
            .await
            .unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn diff_contents_dispatch_and_worktree_validation() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let old = r.git(&["rev-parse", "HEAD^1^1:crlf.txt"]);
        let new = r.git(&["rev-parse", "HEAD^1:crlf.txt"]);
        let c = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "crlf.txt", "old": {"kind": "object", "oid": old}, "new": {"kind": "object", "oid": new}, "force": false}})))
            .await
            .unwrap();
        assert_eq!(c["eolOnly"], true);
        assert_eq!(c["old"]["eol"], "crlf");
        let wt = r.path().to_string_lossy().into_owned();
        let w = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "notes.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}, "force": false}})))
            .await
            .unwrap();
        assert_eq!(w["new"]["text"], "untracked notes\n");
        let escape = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "../outside.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}, "force": false}})))
            .await
            .unwrap_err();
        assert_eq!(escape.kind, GbErrorKind::InvalidInput, "the path is checked before git sees it");
        let err = api
            .dispatch(req(serde_json::json!({"method": "diffContents", "params": {"repo": id, "path": "x", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": "/"}, "force": false}})))
            .await
            .unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn tree_files_and_signature_dispatch() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let api = api();
        let id = open(&api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let files = api.dispatch(req(serde_json::json!({"method": "treeFiles", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(files.as_array().unwrap().len(), 12);
        let before = api.command_log().entries().len();
        let sig = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(sig["kind"], "unsigned");
        assert_eq!(api.command_log().entries().len(), before);
    }

    /// An `unknownKey` verdict (no allowed-signers file configured yet) must never be cached,
    /// since it only means "couldn't verify with what's configured right now"; a `verified`
    /// verdict, once git can actually check it, is definitive and is served from the cache.
    #[tokio::test]
    async fn signature_cache_never_holds_unknown_key_but_caches_a_verified_result() {
        if let Some(reason) = crate::testing::ssh_signing_unavailable() {
            eprintln!("{reason}; skipping");
            return;
        }
        let r = TestRepo::new();
        r.commit("base");
        r.git(&["config", "gpg.format", "ssh"]);
        let key = r.root().join("key");
        let out = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "trusted", "-f"]).arg(&key).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        r.git(&["config", "user.signingkey", key.to_str().unwrap()]);
        r.write("signed.txt", "signed\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-S", "-m", "signed"]);
        let head = r.git(&["rev-parse", "HEAD"]);

        let api = api();
        let id = open(&api, &r).await;

        let before = api.command_log().entries().len();
        let unknown = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(unknown["kind"], "unknownKey");
        let after_first = api.command_log().entries().len();
        assert!(after_first > before, "git ran to try to verify");

        // Queried again with nothing changed: still not cached, so git runs again.
        let unknown_again = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(unknown_again["kind"], "unknownKey");
        let after_second = api.command_log().entries().len();
        assert!(after_second > after_first, "an unknownKey verdict is never cached");

        // Now the user fixes their config; the very next call must re-verify rather than serve a
        // stale unknownKey from a cache, and this time it succeeds.
        let allowed = r.root().join("allowed_signers");
        std::fs::write(&allowed, format!("ada@example.com {}", std::fs::read_to_string(key.with_extension("pub")).unwrap())).unwrap();
        r.git(&["config", "gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()]);
        let verified = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(verified["kind"], "verified");
        let after_third = api.command_log().entries().len();
        assert!(after_third > after_second, "verified re-queries git; the prior unknownKey wasn't cached");

        // A definitive verdict, once reached, is cached: no further git invocation.
        let before_cached = api.command_log().entries().len();
        let cached = api.dispatch(req(serde_json::json!({"method": "signature", "params": {"repo": id, "id": head}}))).await.unwrap();
        assert_eq!(cached["kind"], "verified");
        assert_eq!(api.command_log().entries().len(), before_cached, "a verified verdict is served from the cache");
    }

    // Avatars and URL opening (plan 1B Task 5).
    struct FakeAvatars;
    impl crate::avatar::AvatarProvider for FakeAvatars {
        fn avatar<'a>(&'a self, email: &'a str) -> crate::avatar::AvatarFuture<'a> {
            Box::pin(async move { Ok((email == "ada@example.com").then(|| crate::avatar::AvatarPayload { mime: "image/png".into(), base64: "iVBO".into() })) })
        }
    }

    #[tokio::test]
    async fn the_gravatar_setting_reaches_the_provider() {
        struct Flag(std::sync::atomic::AtomicBool);
        impl crate::avatar::AvatarProvider for Flag {
            fn avatar<'a>(&'a self, _: &'a str) -> crate::avatar::AvatarFuture<'a> {
                Box::pin(async { Ok(None) })
            }
            fn set_enabled(&self, on: bool) {
                self.0.store(on, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let flag = Arc::new(Flag(std::sync::atomic::AtomicBool::new(true)));
        let api = api().with_avatars(flag.clone());
        let mut s = serde_json::to_value(crate::settings::AppSettings::default()).unwrap();
        s["gravatar"] = false.into();
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": s}}))).await.unwrap();
        assert!(!flag.0.load(std::sync::atomic::Ordering::SeqCst));
        s["gravatar"] = true.into();
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": s}}))).await.unwrap();
        assert!(flag.0.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn editor_templates_are_validated_with_the_guards_message() {
        let api = api();
        let check = |t: &str| req(serde_json::json!({"method": "validateEditorTemplate", "params": {"template": t}}));
        assert!(api.dispatch(check("/bin/echo {file}")).await.unwrap().is_null());
        let refused = api.dispatch(check(r#"sh -c "geany {file}""#)).await.unwrap_err();
        assert_eq!(refused.kind, GbErrorKind::InvalidInput);
        assert!(refused.message.contains("can't contain"), "{}", refused.message);
        assert_eq!(api.dispatch(check("no-such-editor-xyz {file}")).await.unwrap_err().kind, GbErrorKind::NotFound);
    }

    #[tokio::test]
    async fn the_custom_editor_is_listed_only_for_a_repo_whose_effective_editor_is_custom() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (api, _launches) = with_openers(api());
        let id = open(&api, &r).await;
        let workdir = api.handle(id as u32).unwrap().workdir.display().to_string();
        let ids = |v: serde_json::Value| v.as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let global = || req(serde_json::json!({"method": "listOpeners"}));
        let for_repo = || req(serde_json::json!({"method": "listOpenersFor", "params": {"repo": id}}));
        let custom = "custom".to_string();
        assert!(!ids(api.dispatch(global()).await.unwrap()).contains(&custom));
        assert!(!ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom));

        let mut p = api.store().active_profile();
        p.editor = Some(EditorChoice::Custom { template: "/bin/echo {file}".into() });
        api.store().save_profile(p.clone()).unwrap();
        assert!(ids(api.dispatch(global()).await.unwrap()).contains(&custom));
        assert!(ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom), "the profile's Custom applies to the repo");

        // The repo's own detected-editor choice overrides the profile's Custom: no entry.
        p.repos.insert(workdir.clone(), crate::settings::RepoSettings { editor: Some(EditorChoice::Opener { id: "vscode".into() }), ..Default::default() });
        api.store().save_profile(p.clone()).unwrap();
        assert!(!ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom));

        // Custom on one repo only: not listed for a repo (or the profile) without it.
        p.editor = None;
        p.repos.insert(workdir, crate::settings::RepoSettings { editor: Some(EditorChoice::Custom { template: "/bin/echo {file}".into() }), ..Default::default() });
        api.store().save_profile(p).unwrap();
        assert!(ids(api.dispatch(for_repo()).await.unwrap()).contains(&custom));
        assert!(!ids(api.dispatch(global()).await.unwrap()).contains(&custom), "other repos don't see it");
    }

    #[tokio::test]
    async fn avatars_come_from_the_injected_provider() {
        let plain = super::tests::api();
        assert!(plain.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": "ada@example.com"}}))).await.unwrap().is_null());
        let with = api().with_avatars(Arc::new(FakeAvatars));
        let a = with.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": "ada@example.com"}}))).await.unwrap();
        assert_eq!(a["mime"], "image/png");
        assert!(with.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": "x@y"}}))).await.unwrap().is_null());
    }

    #[tokio::test]
    async fn open_url_accepts_web_links_only() {
        let opened = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = opened.clone();
        let api = api().with_url_opener(Arc::new(move |u: &str| {
            sink.lock().unwrap().push(u.to_string());
            Ok(())
        }));
        api.dispatch(req(serde_json::json!({"method": "openUrl", "params": {"url": "https://gitlab.example.com/group/project/-/merge_requests/42"}}))).await.unwrap();
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "https://x y"] {
            let err = api.dispatch(req(serde_json::json!({"method": "openUrl", "params": {"url": bad}}))).await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad}");
        }
        assert_eq!(*opened.lock().unwrap(), vec!["https://gitlab.example.com/group/project/-/merge_requests/42"]);
        let none = super::Api::new(GitCli::new(Arc::new(CommandLog::new(10))), None);
        assert!(none.dispatch(req(serde_json::json!({"method": "openUrl", "params": {"url": "https://x"}}))).await.is_err(), "no opener configured");
    }

    // "Open in…" (feedback H9).
    type Launches = Arc<Mutex<Vec<crate::openers::LaunchCommand>>>;

    fn with_openers(api: Api) -> (Api, Launches) {
        use crate::openers::ArgStyle;
        let launches: Launches = Arc::default();
        let sink = launches.clone();
        let api = api.with_openers(
            Arc::new(|| vec![
                Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", ArgStyle::VsCode),
                Opener::new("jetbrains-phpstorm", "PhpStorm", OpenerKind::Editor, "/fake/phpstorm", ArgStyle::JetBrains),
                Opener::new("file-manager", "Files", OpenerKind::FileManager, "/fake/nautilus", ArgStyle::Exec(vec![crate::openers::ExecArg::File])),
            ]),
            Arc::new(move |c: &crate::openers::LaunchCommand| {
                sink.lock().unwrap().push(c.clone());
                Ok(())
            }),
        );
        (api, launches)
    }

    fn argv(c: &crate::openers::LaunchCommand) -> Vec<String> {
        std::iter::once(c.program.to_string_lossy().into_owned()).chain(c.args.iter().map(|a| a.to_string_lossy().into_owned())).collect()
    }

    #[tokio::test]
    async fn list_openers_returns_the_detected_ones_and_none_without_detection() {
        assert_eq!(api().dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap(), serde_json::json!([]));
        let (api, _) = with_openers(api());
        let list = api.dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap();
        assert_eq!(list, serde_json::json!([
            {"id": "vscode", "name": "VS Code", "kind": "editor"},
            {"id": "jetbrains-phpstorm", "name": "PhpStorm", "kind": "editor"},
            {"id": "file-manager", "name": "Files", "kind": "fileManager"},
        ]));
    }

    #[tokio::test]
    async fn open_in_launches_the_opener_on_the_worktree_file() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (api, launches) = with_openers(api());
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let file = wt.join("src/app.php");
        let open_in = |path: &str, line: Option<u32>, opener: &str| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": line, "opener": opener}}));
        assert!(api.dispatch(open_in("src/app.php", Some(12), "vscode")).await.unwrap().is_null());
        api.dispatch(open_in("src/app.php", Some(3), "jetbrains-phpstorm")).await.unwrap();
        api.dispatch(open_in("src/app.php", None, "jetbrains-phpstorm")).await.unwrap();
        api.dispatch(open_in("src/app.php", Some(3), "file-manager")).await.unwrap();
        let got: Vec<Vec<String>> = launches.lock().unwrap().iter().map(argv).collect();
        let f = file.to_string_lossy().into_owned();
        assert_eq!(got, [
            vec!["/fake/code".to_string(), "-g".into(), format!("{f}:12")],
            vec!["/fake/phpstorm".into(), "--line".into(), "3".into(), f.clone()],
            vec!["/fake/phpstorm".into(), f.clone()],
            vec!["/fake/nautilus".into(), wt.join("src").to_string_lossy().into_owned()],
        ]);
    }

    #[tokio::test]
    async fn open_in_rejects_unknown_openers_escaping_paths_foreign_worktrees_and_missing_files() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), r.path().join("link.txt")).unwrap();
        // Rust triage #1: a committed symlink whose target is inside .git resolves, through
        // canonicalize, to a real path that still starts with the worktree root (.git lives
        // under it) — so the leaf must be checked for a .git component too, not just the dirs
        // safe_join already covers (a symlinked *directory*, `x -> .git`, tested elsewhere).
        std::os::unix::fs::symlink(".git/config", r.path().join("gitlink.txt")).unwrap();
        let (api, launches) = with_openers(api());
        let id = open(&api, &r).await;
        let wt = r.path().to_string_lossy().into_owned();
        let open_in = |worktree: &str, path: &str, line: Option<u32>, opener: &str| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": worktree, "path": path, "line": line, "opener": opener}}));
        let cases = [
            (open_in(&wt, "src/app.php", None, "/usr/bin/xterm"), GbErrorKind::InvalidInput, "an opener is an id, never a program"),
            (open_in(&wt, "src/app.php", None, "sublime"), GbErrorKind::InvalidInput, "not detected"),
            (open_in(&wt, "../outside.txt", None, "vscode"), GbErrorKind::InvalidInput, "escapes the worktree"),
            (open_in(&wt, "/etc/passwd", None, "vscode"), GbErrorKind::InvalidInput, "absolute"),
            (open_in(&wt, ".git/config", None, "vscode"), GbErrorKind::InvalidInput, "inside .git"),
            (open_in(&wt, "link.txt", None, "vscode"), GbErrorKind::InvalidInput, "a symlink out of the worktree"),
            (open_in(&wt, "gitlink.txt", None, "vscode"), GbErrorKind::InvalidInput, "a symlink into .git"),
            (open_in(&outside.path().to_string_lossy(), "secret.txt", None, "vscode"), GbErrorKind::InvalidInput, "not a worktree of this repo"),
            (open_in(&wt, "gone.txt", None, "vscode"), GbErrorKind::NotFound, "not in the working tree"),
            (open_in(&wt, "src/app.php", Some(0), "vscode"), GbErrorKind::InvalidInput, "lines start at 1"),
        ];
        for (request, kind, why) in cases {
            let err = api.dispatch(request).await.unwrap_err();
            assert_eq!(err.kind, kind, "{why}: {}", err.message);
        }
        assert!(launches.lock().unwrap().is_empty(), "nothing was launched");
        let plain = super::tests::api();
        let pid = open(&plain, &r).await;
        let none = plain.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": pid, "worktree": wt, "path": "src/app.php", "line": null, "opener": "vscode"}}))).await.unwrap_err();
        assert_eq!(none.kind, GbErrorKind::InvalidInput);
    }

    // Old versions (spec §14.5, fix round 1).
    fn launched_file(launches: &Launches) -> PathBuf {
        PathBuf::from(launches.lock().unwrap().last().unwrap().args.last().unwrap())
    }

    #[tokio::test]
    async fn a_file_at_an_old_commit_opens_as_a_read_only_copy_at_the_line() {
        use std::os::unix::fs::PermissionsExt;
        let r = TestRepo::new();
        fixtures::details(&r);
        let cache = tempfile::tempdir().unwrap();
        let (api, launches) = with_openers(api().with_open_cache(cache.path().to_path_buf()));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let open_in = |path: &str, line: Option<u32>, opener: &str, source: serde_json::Value| {
            req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": line, "opener": opener, "source": source}}))
        };
        // A blob (the file list's side): its bytes, under <cache>/<short oid>/<path>, 0444.
        let old = r.git(&["rev-parse", "HEAD^1^1:src/app.php"]);
        api.dispatch(open_in("src/app.php", Some(7), "jetbrains-phpstorm", serde_json::json!({"kind": "object", "oid": old}))).await.unwrap();
        let copy = launched_file(&launches);
        assert_eq!(copy, cache.path().canonicalize().unwrap().join(&old[..12]).join("src/app.php"));
        assert_eq!(std::fs::read_to_string(&copy).unwrap().trim_end(), r.git(&["show", "HEAD^1^1:src/app.php"]).trim_end());
        assert_eq!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o444);
        assert_eq!(launches.lock().unwrap().last().unwrap().args[..2], [std::ffi::OsString::from("--line"), std::ffi::OsString::from("7")], "the line is the shown version's");
        // The file at a commit (View all files).
        let head = r.git(&["rev-parse", "HEAD"]);
        api.dispatch(open_in("latin1.txt", None, "vscode", serde_json::json!({"kind": "atCommit", "commit": head}))).await.unwrap();
        assert_eq!(std::fs::read(launched_file(&launches)).unwrap(), b"caf\xe9 cr\xe8me br\xfbl\xe9e\n");
        // A deleted file opens its old blob (the UI sends the old side).
        let deleted = r.git(&["rev-parse", "HEAD^1^1:old.txt"]);
        api.dispatch(open_in("old.txt", None, "vscode", serde_json::json!({"kind": "object", "oid": deleted}))).await.unwrap();
        assert_eq!(std::fs::read_to_string(launched_file(&launches)).unwrap(), "to be deleted\n");
        // The worktree side (and no side) opens the working-tree file itself.
        api.dispatch(open_in("src/app.php", None, "vscode", serde_json::json!({"kind": "worktree", "worktree": wt}))).await.unwrap();
        assert_eq!(launched_file(&launches), wt.join("src/app.php"));
        // Refused: an escaping path (nothing is written), an absent or submodule side.
        let before = launches.lock().unwrap().len();
        for (path, source) in [("../x.txt", serde_json::json!({"kind": "object", "oid": old})), ("src/app.php", serde_json::json!({"kind": "absent"})), ("src/app.php", serde_json::json!({"kind": "submodule", "oid": old}))] {
            assert_eq!(api.dispatch(open_in(path, None, "vscode", source)).await.unwrap_err().kind, GbErrorKind::InvalidInput, "{path}");
        }
        assert_eq!(launches.lock().unwrap().len(), before);
        assert!(!cache.path().join("x.txt").exists());
        // Without a cache directory, an old version can't be opened.
        let (plain, _) = with_openers(super::tests::api());
        let pid = open(&plain, &r).await;
        let err = plain.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": pid, "worktree": wt, "path": "src/app.php", "line": null, "opener": "vscode", "source": {"kind": "object", "oid": old}}}))).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn the_file_manager_shows_the_working_tree_folder_or_its_nearest_existing_parent() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let cache = tempfile::tempdir().unwrap();
        let (api, launches) = with_openers(api().with_open_cache(cache.path().to_path_buf()));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let old = r.git(&["rev-parse", "HEAD^1^1:src/app.php"]);
        for (path, source, want) in [
            ("src/app.php", serde_json::json!({"kind": "object", "oid": old}), wt.join("src")),
            ("src/gone/deeper/x.php", serde_json::json!({"kind": "object", "oid": old}), wt.join("src")),
            ("gone/x.txt", serde_json::Value::Null, wt.clone()),
        ] {
            api.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": null, "opener": "file-manager", "source": source}}))).await.unwrap();
            assert_eq!(launched_file(&launches), want, "{path}");
        }
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0, "the file manager never makes a copy");
    }

    // "Other…" and detection refresh (feedback H32).
    #[tokio::test]
    async fn other_is_listed_last_and_hands_the_checked_file_to_the_chooser() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let chosen: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let sink = chosen.clone();
        let (api, launches) = with_openers(api());
        let api = api.with_chooser(Arc::new(move |p: &Path| {
            sink.lock().unwrap().push(p.to_path_buf());
            Ok(())
        }));
        let list = api.dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap();
        assert_eq!(list.as_array().unwrap().last().unwrap(), &serde_json::json!({"id": "other", "name": "Other…", "kind": "chooser"}));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let other = |path: &str| req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": path, "line": 3, "opener": "other"}}));
        api.dispatch(other("src/app.php")).await.unwrap();
        assert_eq!(*chosen.lock().unwrap(), [wt.join("src/app.php")]);
        assert_eq!(api.dispatch(other("../x")).await.unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(api.dispatch(other("gone.txt")).await.unwrap_err().kind, GbErrorKind::NotFound);
        assert_eq!(chosen.lock().unwrap().len(), 1);
        assert!(launches.lock().unwrap().is_empty(), "the chooser isn't a launch");
        // Without a chooser there's no "Other…".
        let (plain, _) = with_openers(super::tests::api());
        let ids = plain.dispatch(req(serde_json::json!({"method": "listOpeners"}))).await.unwrap();
        assert!(ids.as_array().unwrap().iter().all(|o| o["id"] != "other"));
    }

    fn counting_detect(calls: Arc<std::sync::atomic::AtomicUsize>) -> Arc<dyn Fn() -> Vec<Opener> + Send + Sync> {
        use crate::openers::ArgStyle;
        Arc::new(move || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            let mut v = vec![Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", ArgStyle::VsCode)];
            if n > 0 {
                v.push(Opener::new("zed", "Zed", OpenerKind::Editor, "/fake/zed", ArgStyle::PathColonLine));
            }
            v
        })
    }

    #[tokio::test]
    async fn detection_is_cached_briefly_and_redone_for_an_opener_it_hasnt_seen() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let api = api().with_openers(counting_detect(calls.clone()), Arc::new(|_: &crate::openers::LaunchCommand| Ok(())));
        let list = || req(serde_json::json!({"method": "listOpeners"}));
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 1);
        api.dispatch(list()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "cached within the refresh interval");
        // Zed was installed since: opening in it re-detects instead of refusing.
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        api.dispatch(req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": null, "opener": "zed"}}))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // Past the interval, a listing answers from the cache at once and re-detects behind it
        // (fix round 2): the next listing has the new result.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let api = super::tests::api().with_openers(counting_detect(calls.clone()), Arc::new(|_: &crate::openers::LaunchCommand| Ok(()))).with_opener_refresh(std::time::Duration::ZERO);
        api.dispatch(list()).await.unwrap();
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 1, "the stale list, at once");
        wait_until(|| calls.load(Ordering::SeqCst) == 2).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 2);
    }

    async fn wait_until(done: impl Fn() -> bool) {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Fix round 2: a slow re-detection never holds up a listing or an open.
    #[tokio::test]
    async fn a_slow_redetection_doesnt_hold_up_listing_or_opening() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let api = super::tests::api()
            .with_openers(
                Arc::new(move || {
                    if count.fetch_add(1, Ordering::SeqCst) > 0 {
                        let _ = gate.lock().unwrap().recv();
                    }
                    vec![Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", crate::openers::ArgStyle::VsCode)]
                }),
                Arc::new(|_: &crate::openers::LaunchCommand| Ok(())),
            )
            .with_opener_refresh(std::time::Duration::ZERO);
        let list = || req(serde_json::json!({"method": "listOpeners"}));
        api.dispatch(list()).await.unwrap();
        let quick = std::time::Duration::from_secs(2);
        tokio::time::timeout(quick, api.dispatch(list())).await.expect("listing waited on the re-detection").unwrap();
        wait_until(|| calls.load(Ordering::SeqCst) == 2).await;
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let open_in = req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": null, "opener": "vscode"}}));
        tokio::time::timeout(quick, api.dispatch(open_in)).await.expect("opening waited on the re-detection").unwrap();
        tokio::time::timeout(quick, api.dispatch(list())).await.expect("a second listing waited").unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one re-detection at a time");
        release.send(()).unwrap();
    }

    /// Fix round 2: a WIP file (staged too) opens the working-tree file; when it's gone from the
    /// working tree, a read-only copy of the version the list has (`fallback`).
    #[tokio::test]
    async fn a_wip_file_opens_from_the_working_tree_or_its_stored_version_when_gone() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let cache = tempfile::tempdir().unwrap();
        let (api, launches) = with_openers(api().with_open_cache(cache.path().to_path_buf()));
        let id = open(&api, &r).await;
        let wt = r.path().canonicalize().unwrap();
        let staged = r.git(&["rev-parse", ":src/app.php"]);
        let open_in = |fallback: serde_json::Value| {
            req(serde_json::json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "src/app.php", "line": 2, "opener": "vscode", "source": {"kind": "worktree", "worktree": wt}, "fallback": fallback}}))
        };
        api.dispatch(open_in(serde_json::json!({"kind": "object", "oid": staged}))).await.unwrap();
        assert_eq!(launched_file(&launches), PathBuf::from(format!("{}:2", wt.join("src/app.php").display())));
        std::fs::remove_file(wt.join("src/app.php")).unwrap();
        api.dispatch(open_in(serde_json::json!({"kind": "object", "oid": staged}))).await.unwrap();
        let copy = launched_file(&launches).to_string_lossy().trim_end_matches(":2").to_string();
        assert!(copy.starts_with(&cache.path().canonicalize().unwrap().to_string_lossy().into_owned()), "{copy}");
        assert!(std::fs::read_to_string(&copy).unwrap().ends_with("// staged tweak\n"));
        // No fallback: the missing file is an error, as before.
        assert_eq!(api.dispatch(open_in(serde_json::Value::Null)).await.unwrap_err().kind, GbErrorKind::NotFound);
    }

    #[tokio::test]
    async fn a_detection_that_panics_isnt_cached() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let api = api().with_openers(
            Arc::new(move || {
                if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("a broken desktop entry");
                }
                vec![Opener::new("vscode", "VS Code", OpenerKind::Editor, "/fake/code", crate::openers::ArgStyle::VsCode)]
            }),
            Arc::new(|_: &crate::openers::LaunchCommand| Ok(())),
        );
        let list = || req(serde_json::json!({"method": "listOpeners"}));
        assert!(api.dispatch(list()).await.is_err(), "a failed detection is an error, not an empty list");
        assert_eq!(api.dispatch(list()).await.unwrap().as_array().unwrap().len(), 1, "and the next call retries");
    }

    // --- 2C T2: one handle per repository ---
    /// Spec #2 §11.2: a linked worktree's tab reuses the repository's handle (2A Deviation 4,
    /// one handle per worktree, is reversed: 2C Deviation 2).
    #[tokio::test]
    async fn every_worktree_of_a_repository_opens_one_handle() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let linked = r.root().join("wt-hotfix");
        let first = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": linked}}))).await.unwrap();
        let main = open(&api, &r).await;
        assert_eq!(first["id"].as_u64().unwrap(), main, "one handle, whichever worktree opened first");
        assert_eq!(first["path"].as_str().unwrap(), r.path().canonicalize().unwrap().display().to_string(), "the handle's path is the main worktree");
        assert_eq!(first["worktree"].as_str().unwrap(), linked.canonicalize().unwrap().display().to_string(), "and the summary names the one opened");
        let again = api.dispatch(req(serde_json::json!({"method": "openRepo", "params": {"path": r.path()}}))).await.unwrap();
        assert_eq!(again["worktree"].as_str().unwrap(), r.path().canonicalize().unwrap().display().to_string());
        // The queue is the repository's, and its one id hears about it (queueChanged per open id).
        let h = api.handle(main as u32).unwrap();
        let mut rx = api.subscribe();
        let w = api.repo_writes(&h);
        let ticket = w.queue.enqueue("commit \"x\"", crate::events::OpKind::Commit, 1);
        let mut ids = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let AppEvent::QueueChanged { repo, .. } = ev {
                ids.push(repo);
            }
        }
        assert_eq!(ids, [main as u32]);
        drop(ticket);
    }

    #[tokio::test]
    async fn the_graph_lays_out_the_active_worktree_as_the_open_one() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let linked = r.root().join("wt-hotfix").canonicalize().unwrap().display().to_string();
        let main = r.path().canonicalize().unwrap().display().to_string();
        let g = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "active": linked}}))).await.unwrap();
        assert_eq!(g["head"]["branch"], "refs/heads/hotfix");
        assert_eq!(g["openWorktree"].as_str(), Some(linked.as_str()));
        assert_eq!(g["rows"][0]["wip"]["worktreePath"].as_str(), Some(linked.as_str()), "the active worktree's WIP is row 0");
        let wts = g["worktrees"].as_array().unwrap();
        assert_eq!(wts.len(), 2);
        let m = wts.iter().find(|w| w["isMain"] == true).unwrap();
        assert_eq!((m["path"].as_str(), m["branch"].as_str()), (Some(main.as_str()), Some("refs/heads/main")));
        let labels = g["labels"].as_array().unwrap();
        let label = |n: &str| labels.iter().find(|l| l["name"] == n).unwrap().clone();
        assert_eq!(label("hotfix")["checkedOut"].as_str(), Some(linked.as_str()));
        assert_eq!(label("main")["checkedOut"].as_str(), Some(main.as_str()));
        assert_eq!(label("hotfix")["isHead"], true);
        assert!(label("feature/login")["checkedOut"].is_null());
        let plain = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null}}))).await.unwrap();
        assert_eq!(plain["head"]["branch"], "refs/heads/main", "without `active`: the handle's (main) worktree");
        let bad = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "active": "/nonexistent"}}))).await;
        assert_eq!(bad.unwrap_err().kind, GbErrorKind::InvalidInput);
        let outside = tempfile::tempdir().unwrap();
        let bad = api.dispatch(req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "active": outside.path()}}))).await;
        assert_eq!(bad.unwrap_err().kind, GbErrorKind::InvalidInput, "an existing folder that isn't one of its worktrees");
    }

    #[tokio::test]
    async fn the_sidebar_names_every_branchs_worktree_and_locked_worktrees() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        r.git(&["worktree", "lock", r.root().join("wt-hotfix").to_str().unwrap()]);
        let api = api();
        let id = open(&api, &r).await;
        let s = api.dispatch(req(serde_json::json!({"method": "sidebar", "params": {"repo": id}}))).await.unwrap();
        let local = |n: &str| s["locals"].as_array().unwrap().iter().find(|b| b["name"] == n).unwrap().clone();
        assert_eq!(local("main")["checkedOut"].as_str(), Some(r.path().canonicalize().unwrap().display().to_string().as_str()));
        assert!(local("hotfix")["checkedOut"].as_str().unwrap().ends_with("wt-hotfix"));
        let wt = s["worktrees"].as_array().unwrap().iter().find(|w| w["isMain"] == false).unwrap().clone();
        assert_eq!(wt["locked"], true);
    }

    /// Counted per handle (`snapshot::walks`): a global count would see the walks of the tests
    /// running in parallel.
    #[tokio::test]
    async fn a_second_graph_over_unmoved_refs_reuses_the_walk() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await;
        let h = api.handle(id as u32).unwrap();
        let graph = |active: Option<String>| req(serde_json::json!({"method": "graph", "params": {"repo": id, "limit": null, "active": active}}));
        api.dispatch(graph(None)).await.unwrap();
        let walks = crate::snapshot::walks(&h.walk);
        assert_eq!(walks, 1);
        let linked = r.root().join("wt-hotfix").canonicalize().unwrap().display().to_string();
        api.dispatch(graph(Some(linked))).await.unwrap();
        assert_eq!(crate::snapshot::walks(&h.walk), walks, "the switch's relayout didn't walk");
        r.commit("moves main");
        let g = api.dispatch(graph(None)).await.unwrap();
        assert!(crate::snapshot::walks(&h.walk) > walks, "moved refs walk again");
        assert_eq!(g["rows"].as_array().unwrap().iter().filter(|row| row["summary"] == "moves main").count(), 1);
    }
    // --- end 2C T2 ---

    #[tokio::test]
    async fn queue_requests_dispatch() {
        let r = TestRepo::new();
        r.commit("c");
        let api = api();
        let id = open(&api, &r).await;
        let w = api.repo_writes(&api.handle(id as u32).unwrap());
        let a = w.queue.enqueue("a", crate::events::OpKind::Commit, 1);
        let b = w.queue.enqueue("b", crate::events::OpKind::Commit, 2);
        let c = w.queue.enqueue("c", crate::events::OpKind::Commit, 3);
        let state = api.dispatch(req(serde_json::json!({"method": "queueState", "params": {"repo": id}}))).await.unwrap();
        assert_eq!(state["queued"].as_array().unwrap().len(), 3);
        let b_id = state["queued"][1]["id"].as_u64().unwrap();
        assert_eq!(api.dispatch(req(serde_json::json!({"method": "queueRemove", "params": {"repo": id, "id": b_id}}))).await.unwrap(), true);
        w.queue.turn(a).await.unwrap().finish(Some(&GbError::other("boom")), &[]);
        assert!(w.queue.state().stopped.is_some());
        api.dispatch(req(serde_json::json!({"method": "queueResume", "params": {"repo": id}}))).await.unwrap();
        assert!(w.queue.state().stopped.is_none());
        api.dispatch(req(serde_json::json!({"method": "queueClear", "params": {"repo": id}}))).await.unwrap();
        assert_eq!(w.queue.state(), crate::write::types::QueueStatePayload::default());
        drop((b, c));
    }

    /// Every file under `.git` but objects (index bytes and mtime included): what a read must
    /// never change (spec #2 §17.1).
    fn repo_bytes(r: &TestRepo) -> Vec<(String, Vec<u8>, Option<std::time::SystemTime>)> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>, Option<std::time::SystemTime>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
            entries.sort();
            for p in entries {
                let rel = p.strip_prefix(base).unwrap().display().to_string();
                if rel == "objects" || rel.ends_with(".lock") {
                    continue;
                }
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    let mtime = (rel == "index" || rel.ends_with("/index")).then(|| std::fs::metadata(&p).unwrap().modified().unwrap());
                    out.push((rel, std::fs::read(&p).unwrap(), mtime));
                }
            }
        }
        let git = r.path().join(".git");
        let mut out = Vec::new();
        walk(&git, &git, &mut out);
        out
    }

    /// Every path under `.git/objects`, which `repo_bytes` leaves out: a read that writes an
    /// object (a tree, a commit) adds one.
    fn object_files(r: &TestRepo) -> Vec<String> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                out.push(p.strip_prefix(base).unwrap().display().to_string());
                if p.is_dir() {
                    walk(&p, base, out);
                }
            }
        }
        let objects = r.path().join(".git/objects");
        let mut out = Vec::new();
        walk(&objects, &objects, &mut out);
        out.sort();
        out
    }

    /// Run against `fixtures::basic` (feature/login, v1.0).
    fn read_samples(id: u32, r: &TestRepo) -> Vec<serde_json::Value> {
        let login = r.git(&["rev-parse", "feature/login"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let wt = r.path().canonicalize().unwrap().display().to_string();
        let root = r.root().display().to_string();
        use serde_json::json;
        vec![
            // --- 4A T5 ---
            json!({"method": "forgeAccounts"}),
            json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": "glpat-FAKE-never-sent"}}),
            json!({"method": "removeForgeAccount", "params": {"host": "gitlab.example.com"}}),
            json!({"method": "forgeTokenPage", "params": {"host": "gitlab.example.com", "kind": "gitlab"}}),
            // --- end 4A T5 ---
            // --- 4A T6 ---
            json!({"method": "forgeRepoProjects", "params": {"repo": id, "refresh": false}}),
            json!({"method": "forgeProjectSettings", "params": {"repo": id, "remote": "origin"}}),
            json!({"method": "forgeForks", "params": {"repo": id, "remote": "origin"}}),
            // --- end 4A T6 ---
            json!({"method": "openRepo", "params": {"path": wt}}),
            json!({"method": "logFrontend", "params": {"level": "info", "message": "x", "stack": null}}),
            json!({"method": "setDebugLogging", "params": {"debug": false}}),
            json!({"method": "logsDir"}),
            json!({"method": "stagingState", "params": {"repo": id, "worktree": wt}}),
            json!({"method": "diagnostics", "params": {"ui": {"userAgent": "t", "settings": {}}}}),
            json!({"method": "openLogsFolder"}),
            json!({"method": "graph", "params": {"repo": id, "limit": null}}),
            json!({"method": "commandLog"}),
            json!({"method": "launchRepo"}),
            json!({"method": "takeOpenRequests"}),
            json!({"method": "commitMessage", "params": {"repo": id, "id": head}}),
            json!({"method": "commitDetails", "params": {"repo": id, "id": head}}),
            json!({"method": "remotes", "params": {"repo": id}}),
            json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": wt, "staged": false}}}),
            json!({"method": "fileList", "params": {"repo": id, "spec": {"kind": "wip", "worktree": wt, "staged": true}}}),
            json!({"method": "diffContents", "params": {"repo": id, "path": "file_1.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}, "force": false}}),
            json!({"method": "hexDump", "params": {"repo": id, "path": "file_1.txt", "old": {"kind": "absent"}, "new": {"kind": "worktree", "worktree": wt}}}),
            json!({"method": "treeFiles", "params": {"repo": id, "id": head}}),
            json!({"method": "worktreeFiles", "params": {"repo": id, "worktree": wt}}),
            json!({"method": "signature", "params": {"repo": id, "id": head}}),
            json!({"method": "avatar", "params": {"email": "ada@example.com"}}),
            json!({"method": "openUrl", "params": {"url": "https://example.com"}}),
            json!({"method": "listOpeners"}),
            json!({"method": "listOpenersFor", "params": {"repo": id}}),
            json!({"method": "validateEditorTemplate", "params": {"template": "code {file}"}}),
            json!({"method": "openIn", "params": {"repo": id, "worktree": wt, "path": "file_1.txt", "line": null, "opener": "none", "source": null, "fallback": null}}),
            json!({"method": "loadState"}),
            json!({"method": "saveSettings", "params": {"settings": {}}}),
            json!({"method": "saveProfile", "params": {"profile": {}}}),
            json!({"method": "createProfile", "params": {"name": "p", "color": "#336699"}}),
            json!({"method": "switchProfile", "params": {"id": "none"}}),
            json!({"method": "deleteProfile", "params": {"id": "none"}}),
            json!({"method": "authAnswer", "params": {"prompt": 1, "answer": null}}),
            json!({"method": "cancelOp", "params": {"op": 1}}),
            json!({"method": "repoInfo", "params": {"repo": id}}),
            json!({"method": "commitIdentity", "params": {"repo": id, "worktree": wt}}),
            json!({"method": "sidebar", "params": {"repo": id}}),
            json!({"method": "lastPush", "params": {"repo": id, "remoteRef": "refs/remotes/origin/main"}}),
            json!({"method": "appInfo"}),
            json!({"method": "pickFolder", "params": {"start": null}}),
            json!({"method": "scanRepos", "params": {"root": root, "refresh": true}}),
            json!({"method": "scanFolders", "params": {"roots": [root], "refresh": true}}),
            json!({"method": "suggestReposFolder"}),
            json!({"method": "watchRepo", "params": {"repo": id}}),
            json!({"method": "unwatchRepo", "params": {"repo": id}}),
            json!({"method": "unwatchAll"}),
            json!({"method": "findText", "params": {"repo": id, "query": "x"}}),
            json!({"method": "findPaths", "params": {"repo": id, "query": "file"}}),
            json!({"method": "locateCommit", "params": {"repo": id, "sha": head}}),
            json!({"method": "searchHistory", "params": {"repo": id, "query": "x"}}),
            json!({"method": "queueState", "params": {"repo": id}}),
            json!({"method": "queueRemove", "params": {"repo": id, "id": 1}}),
            json!({"method": "queueResume", "params": {"repo": id}}),
            json!({"method": "queueClear", "params": {"repo": id}}),
            // Undo / redo (2A T10).
            json!({"method": "journalState", "params": {"repo": id, "worktree": wt}}),
            json!({"method": "journalHistory", "params": {"repo": id, "worktree": wt}}), // UX Y
            // Autostash banners (2A T11).
            json!({"method": "dismissBanner", "params": {"repo": id, "worktree": wt, "entry": 999}}),
            // 2B T5.
            json!({"method": "headOnUpstream", "params": {"repo": id, "worktree": wt}}),
            // --- 2C T8 ---
            json!({"method": "suggestWorktreePath", "params": {"repo": id, "branch": "feature/x"}}),
            // --- end 2C T8 ---
            // --- 2D T10: integrate ---
            json!({"method": "integratePreview", "params": {"repo": id, "worktree": wt, "kind": "merge", "target": "feature/login"}}),
            // --- end 2D T10 ---
            // --- 2D T12 ---
            json!({"method": "conflictFile", "params": {"repo": id, "worktree": wt, "path": "file_0.txt"}}),
            // --- end 2D T12 ---
            // 2B T3.
            json!({"method": "wipHunks", "params": {"repo": id, "worktree": wt, "path": "file_1.txt", "staged": false}}),
            // 2B T10.
            json!({"method": "selectionLines", "params": {"repo": id, "worktree": wt, "path": "file_1.txt", "staged": false, "selection": {"kind": "hunks", "hunks": [0]}}}),
            // --- 3C T1 ---
            json!({"method": "rebasePlan", "params": {"repo": id, "worktree": wt, "branch": "feature/login", "base": "v1.0"}}),
            // --- end 3C T1 ---
            // --- 3A T2 ---
            json!({"method": "fileHistory", "params": {"repo": id, "worktree": wt, "path": "file_1.txt", "skip": 0, "limit": 200}}),
            json!({"method": "blame", "params": {"repo": id, "worktree": wt, "rev": head, "path": "file_0.txt"}}),
            // --- end 3A T2 ---
            // --- 3C T7 ---
            json!({"method": "predictRebase", "params": {"repo": id, "worktree": wt, "base": "v1.0", "rows": [{"oid": login, "action": "pick"}]}}),
            // --- end 3C T7 ---
        ]
    }

    /// The methods that write (`is_write`), which the never-write test leaves out.
    const WRITE_METHODS: &[&str] = &["fetch", "clone", "testWrite", "undo", "redo", "undoEntry","applyKeptStash", "removeIndexLock", "stage", "unstage", "stageAll", "unstageAll", "stagingUndo", "stagingRedo", "writeWorktreeFile", "createWorktreeFile", "commit", "editHeadMessage", "settlePaused", "worktreeAdd", "worktreeRemove", "deleteBranch", "stagePatch", "createBranch", "renameBranch", "setUpstream", "push",
        // 4A T7
        "addRemote",
        // --- 2C T5: checkout ---
        "checkout",
        // --- end 2C T5 ---
        // --- 2C T7 ---
        "stashPush", "stashApply", "stashDrop",
        // --- end 2C T7 ---
        // --- 2C T6: reset ---
        "reset",
        // --- end 2C T6 ---
        // --- 2B T4 ---
        "discard",
        // --- end 2B T4 ---
        // --- 2D T9 / T10 ---
        "integrate", "rebaseControl", "fastForward", "mergeAbort",
        // --- end 2D T9 / T10 ---
        // --- 2D T14 ---
        "pull",
        // --- end 2D T14 ---
        // --- 2D T15 ---
        "resolveFile",
        // --- end 2D T15 ---
        // ux round 1: a cherry-pick or revert's Continue / Skip / Abort
        "pickControl",
        // --- 3A T3 ---
        "restoreFile",
        // --- end 3A T3 ---
        // --- 3B T3 ---
        "createTag", "deleteTag", "pushTags",
        // --- end 3B T3 ---
        // --- 3C T3 ---
        "interactiveRebase",
        // --- end 3C T3 ---
        // --- 3C T6 ---
        "rewordCommit",
        // --- end 3C T6 ---
        // 3B T1
        "cherryPick",
        "revert",
    ];

    /// One request of each write method: the audit checks `is_write` agrees, so a read can't
    /// hide in `WRITE_METHODS`.
    fn write_samples(id: u32, r: &TestRepo) -> Vec<serde_json::Value> {
        use serde_json::json;
        let wt = r.path().canonicalize().unwrap().display().to_string();
        vec![
            json!({"method": "fetch", "params": {"repo": id, "background": false}}),
            // --- 4A T7 ---
            json!({"method": "addRemote", "params": {"repo": id, "worktree": wt, "name": "x", "url": "/nonexistent/x.git"}}),
            // --- end 4A T7 ---
            json!({"method": "clone", "params": {"url": "https://example.com/x.git", "dest": "/nonexistent/x"}}),
            json!({"method": "testWrite", "params": {"repo": id, "worktree": wt, "intent": {"op": "barrier", "label": "x"}}}),
            // Undo / redo (2A T10).
            json!({"method": "undo", "params": {"repo": id, "worktree": wt, "entry": 1}}),
            json!({"method": "redo", "params": {"repo": id, "worktree": wt, "entry": 1}}),
            json!({"method": "undoEntry", "params": {"repo": id, "worktree": wt, "entry": 1}}), // UX Y
            // Autostash banners (2A T11).
            json!({"method": "applyKeptStash", "params": {"repo": id, "worktree": wt, "entry": 1}}),
            // Remove stale lock (2A T12).
            json!({"method": "removeIndexLock", "params": {"repo": id, "path": "/nonexistent/.git/index.lock", "mtimeMs": 0, "ino": 0, "dev": 0}}),
            // The pause (2D T2).
            json!({"method": "settlePaused", "params": {"repo": id, "worktree": wt}}),
            // --- 2C T3 ---
            json!({"method": "createBranch", "params": {"repo": id, "worktree": wt, "name": "x", "start": "0000000000000000000000000000000000000000", "checkout": false}}),
            json!({"method": "renameBranch", "params": {"repo": id, "worktree": wt, "from": "a", "to": "b"}}),
            json!({"method": "setUpstream", "params": {"repo": id, "worktree": wt, "branch": "main", "upstream": null}}),
            // --- end 2C T3 ---
            // --- 2C T8 ---
            json!({"method": "worktreeAdd", "params": {"repo": id, "worktree": wt, "path": "/nonexistent/x", "branch": {"kind": "existing", "name": "main"}}}),
            json!({"method": "worktreeRemove", "params": {"repo": id, "worktree": wt, "path": "/nonexistent/x"}}),
            // --- end 2C T8 ---
            // Save a working file (2B T6): refused as Stale before writing.
            json!({"method": "writeWorktreeFile", "params": {"repo": id, "worktree": wt, "path": "file_1.txt", "text": "x", "base": "0"}}),
            // UX round 3 O.1: refused (it exists) before writing.
            json!({"method": "createWorktreeFile", "params": {"repo": id, "worktree": wt, "path": "file_1.txt"}}),
            // 2B T1.
            json!({"method": "stage", "params": {"repo": id, "worktree": wt, "paths": ["file_1.txt"]}}),
            json!({"method": "unstage", "params": {"repo": id, "worktree": wt, "paths": ["file_1.txt"]}}),
            json!({"method": "stageAll", "params": {"repo": id, "worktree": wt}}),
            json!({"method": "unstageAll", "params": {"repo": id, "worktree": wt}}),
            // 2B T2: both refused as Stale (nothing to undo) before writing.
            json!({"method": "stagingUndo", "params": {"repo": id, "worktree": wt}}),
            json!({"method": "stagingRedo", "params": {"repo": id, "worktree": wt}}),
            // 2B T5: both refused for the empty summary before writing.
            json!({"method": "commit", "params": {"repo": id, "worktree": wt, "summary": "", "expect": {}}}),
            json!({"method": "editHeadMessage", "params": {"repo": id, "worktree": wt, "message": ""}}),
            // 2C T4: refused (no such branch) before writing.
            json!({"method": "deleteBranch", "params": {"repo": id, "worktree": wt, "branch": "x", "local": true, "remote": null}}),
            // --- 2D T9: integrate ---
            json!({"method": "integrate", "params": {"repo": id, "worktree": wt, "kind": "rebase", "target": "main"}}),
            json!({"method": "rebaseControl", "params": {"repo": id, "worktree": wt, "action": "abort"}}),
            // --- end 2D T9 ---
            // ux round 1: refused (no cherry-pick or revert in progress) before writing.
            json!({"method": "pickControl", "params": {"repo": id, "worktree": wt, "action": "abort"}}),
            // --- 2D T10: integrate ---
            json!({"method": "fastForward", "params": {"repo": id, "worktree": wt, "branch": "x", "to": "main"}}),
            json!({"method": "mergeAbort", "params": {"repo": id, "worktree": wt}}),
            // --- end 2D T10 ---
            // 2B T3: refused as Stale (the empty base) before writing.
            json!({"method": "stagePatch", "params": {"repo": id, "worktree": wt, "path": "file_1.txt", "staged": false, "selection": {"kind": "hunks", "hunks": [0]}, "base": {}}}),
            // --- 2B T4 ---
            json!({"method": "discard", "params": {"repo": id, "worktree": wt, "scope": {"kind": "paths", "paths": ["nope.txt"]}}}),
            // --- end 2B T4 ---
            // 2D T11: refused (no upstream) before writing.
            json!({"method": "push", "params": {"repo": id, "worktree": wt, "branch": "main"}}),
            // --- 2D T14 ---
            json!({"method": "pull", "params": {"repo": id, "worktree": wt, "mode": "ffOnly"}}),
            // --- end 2D T14 ---
            // --- 2C T5: checkout ---
            json!({"method": "checkout", "params": {"repo": id, "worktree": wt, "target": {"kind": "branch", "name": "main"}}}),
            // --- end 2C T5 ---
            // --- 2C T7 ---
            json!({"method": "stashPush", "params": {"repo": id, "worktree": wt, "message": ""}}),
            json!({"method": "stashApply", "params": {"repo": id, "worktree": wt, "oid": "0000000000000000000000000000000000000000", "pop": false}}),
            json!({"method": "stashDrop", "params": {"repo": id, "worktree": wt, "oid": "0000000000000000000000000000000000000000"}}),
            // --- end 2C T7 ---
            // --- 2C T6: reset ---
            json!({"method": "reset", "params": {"repo": id, "worktree": wt, "to": "0000000000000000000000000000000000000000", "mode": "soft"}}),
            // --- end 2C T6 ---
            // --- 2D T15 ---
            json!({"method": "resolveFile", "params": {"repo": id, "worktree": wt, "path": "a.txt", "resolution": {"kind": "asIs"}}}),
            // --- end 2D T15 ---
            // --- 3A T3 ---
            json!({"method": "restoreFile", "params": {"repo": id, "worktree": wt, "sha": "0000000000000000000000000000000000000000", "path": "file_1.txt"}}),
            // --- end 3A T3 ---
            // 3B T3: refused (a bad name, no such tag) before writing.
            json!({"method": "createTag", "params": {"repo": id, "worktree": wt, "name": "a..b", "target": "0000000000000000000000000000000000000000"}}),
            json!({"method": "deleteTag", "params": {"repo": id, "worktree": wt, "name": "nope", "local": true}}),
            json!({"method": "pushTags", "params": {"repo": id, "worktree": wt, "remote": "origin", "tag": "nope"}}),
            // 3C T3: refused (x isn't checked out) before writing.
            json!({"method": "interactiveRebase", "params": {"repo": id, "worktree": wt, "branch": "x", "base": "main", "rows": []}}),
            // 3C T6: refused (an empty message) before writing.
            json!({"method": "rewordCommit", "params": {"repo": id, "worktree": wt, "oid": "0000000000000000000000000000000000000000", "message": ""}}),
            // 3B T1: refused (nothing to apply) before writing.
            json!({"method": "cherryPick", "params": {"repo": id, "worktree": wt, "oids": []}}),
            json!({"method": "revert", "params": {"repo": id, "worktree": wt, "oids": []}}),
        ]
    }

    /// Samples that fail by design here: the harness-less `Api` has no log folder, URL opener,
    /// openers or askpass, and the profile samples name no existing profile. Each refusal comes
    /// before any repository access.
    const EXPECTED_FAILURES: &[&str] = &["openLogsFolder", "openUrl", "openIn", "switchProfile", "deleteProfile", "authAnswer", "saveProfile", "addForgeAccount", "removeForgeAccount", "forgeProjectSettings", "forgeForks"];

    #[tokio::test(flavor = "multi_thread")]
    async fn no_read_request_writes_to_the_repository() {
        let r = TestRepo::new();
        fixtures::basic(&r);
        let api = api();
        let id = open(&api, &r).await as u32;
        let before = repo_bytes(&r);
        let objects_before = object_files(&r);
        let mut failed = std::collections::BTreeSet::new();
        for sample in read_samples(id, &r) {
            let request: Request = serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{sample}: {e}"));
            assert!(!request.is_write(), "{sample}");
            match api.dispatch(request).await {
                Err(e) => {
                    failed.insert(format!("{}: {}", sample["method"].as_str().unwrap(), e.message));
                }
                // --- 3C T7 ---
                // The prediction must really run merge-tree, or the object check below proves nothing.
                Ok(v) if sample["method"] == "predictRebase" => assert!(v["off"].is_null(), "{v}"),
                // --- end 3C T7 ---
                Ok(_) => {}
            }
        }
        api.unwatch_all();
        assert_eq!(repo_bytes(&r), before, "a read changed the repository");
        assert_eq!(object_files(&r), objects_before, "a read wrote to the object store");
        // Exactly the expected ones: any other never exercised its real path, and an expected one
        // that now succeeds should leave the list.
        let methods: std::collections::BTreeSet<&str> = failed.iter().map(|f| f.split(':').next().unwrap()).collect();
        assert_eq!(methods, EXPECTED_FAILURES.iter().copied().collect(), "failed samples: {failed:?}");
        for sample in write_samples(id, &r) {
            let request: Request = serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{sample}: {e}"));
            assert!(request.is_write(), "{sample}");
        }
    }

    #[test]
    fn the_never_write_samples_cover_every_read_request() {
        // From the Rust type itself (not the generated file, which may be stale).
        let ts = <Request as TS>::decl(&ts_rs::Config::default());
        let methods: std::collections::BTreeSet<String> = regex::Regex::new(r#""method": "(\w+)""#).unwrap().captures_iter(&ts).map(|c| c[1].to_string()).collect();
        assert!(methods.len() > 40, "{ts}");
        let r = TestRepo::new();
        fixtures::basic(&r);
        let sampled: std::collections::BTreeSet<String> = read_samples(1, &r).iter().map(|s| s["method"].as_str().unwrap().to_string()).collect();
        let missing: Vec<&String> = methods.iter().filter(|m| !sampled.contains(*m) && !WRITE_METHODS.contains(&m.as_str())).collect();
        assert!(missing.is_empty(), "read requests the never-write test doesn't dispatch: {missing:?}");
        let writes: std::collections::BTreeSet<String> = write_samples(1, &r).iter().map(|s| s["method"].as_str().unwrap().to_string()).collect();
        assert_eq!(writes, WRITE_METHODS.iter().map(|m| m.to_string()).collect(), "one sample per write method");
    }
    // --- 4A T5 ---
    #[tokio::test]
    async fn forge_account_requests_round_trip_and_the_token_never_shows() {
        use crate::forge::fake::{FakeConnector, FakeProvider, MemTokens};
        use crate::forge::{ForgeKind, TokenStorage};
        const TOKEN: &str = "glpat-FAKE-test-token";
        let tokens = MemTokens::new(TokenStorage::File);
        let api = api().with_forge(FakeConnector::with(TOKEN, FakeProvider::new(ForgeKind::GitLab, "gitlab.example.com")), tokens.clone());
        let req: Request = serde_json::from_value(serde_json::json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": TOKEN}})).unwrap();
        assert!(!format!("{req:?}").contains(TOKEN), "Request's Debug (the dispatch log) never shows a token");
        let added = api.dispatch(req).await.unwrap();
        assert_eq!(added["account"]["storage"], "file");
        assert!(!added.to_string().contains(TOKEN));
        let list = api.dispatch(serde_json::from_value(serde_json::json!({"method": "forgeAccounts"})).unwrap()).await.unwrap();
        assert_eq!(list[0]["account"]["user"]["username"], "ada");
        assert_eq!(list[0]["status"]["kind"], "ok");
        let page = api.dispatch(serde_json::from_value(serde_json::json!({"method": "forgeTokenPage", "params": {"host": "https://gitlab.example.com/", "kind": "gitlab"}})).unwrap()).await.unwrap();
        assert!(page.as_str().unwrap().starts_with("https://gitlab.example.com/-/user_settings/personal_access_tokens?"));
        api.dispatch(serde_json::from_value(serde_json::json!({"method": "removeForgeAccount", "params": {"host": "gitlab.example.com"}})).unwrap()).await.unwrap();
        assert!(tokens.map.lock().unwrap().is_empty());
        let none = api.dispatch(serde_json::from_value(serde_json::json!({"method": "forgeAccounts"})).unwrap()).await.unwrap();
        assert_eq!(none, serde_json::json!([]));
    }

    #[tokio::test]
    async fn deleting_a_profile_deletes_its_tokens() {
        use crate::forge::fake::{FakeConnector, FakeProvider, MemTokens};
        use crate::forge::{ForgeKind, TokenStorage};
        const TOKEN: &str = "glpat-FAKE-test-token";
        let tokens = MemTokens::new(TokenStorage::Keyring);
        let api = api().with_forge(FakeConnector::with(TOKEN, FakeProvider::new(ForgeKind::GitLab, "gitlab.example.com")), tokens.clone());
        let work = api.dispatch(req(serde_json::json!({"method": "createProfile", "params": {"name": "Work", "color": "#336699"}}))).await.unwrap();
        let id = work["id"].as_str().unwrap().to_string();
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": id}}))).await.unwrap();
        api.dispatch(req(serde_json::json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": TOKEN}}))).await.unwrap();
        assert_eq!(tokens.token(&id, "gitlab.example.com").as_deref(), Some(TOKEN));
        api.dispatch(req(serde_json::json!({"method": "switchProfile", "params": {"id": "default"}}))).await.unwrap();
        api.dispatch(req(serde_json::json!({"method": "deleteProfile", "params": {"id": id}}))).await.unwrap();
        assert!(tokens.map.lock().unwrap().is_empty(), "no orphaned token");
    }
    // --- end 4A T5 ---
    // --- 4A T6 ---
    #[tokio::test]
    async fn forge_avatars_come_before_gravatar_and_follow_their_setting() {
        use crate::forge::fake::{FakeConnector, FakeProvider, MemTokens};
        use crate::forge::{ForgeKind, TokenStorage};
        const TOKEN: &str = "glpat-FAKE-test-token";
        let mut p = FakeProvider::new(ForgeKind::GitLab, "gitlab.example.com");
        p.avatars.insert("grace@example.com".into(), crate::avatar::AvatarPayload { mime: "image/png".into(), base64: "Rk9SR0U=".into() });
        let api = api().with_avatars(Arc::new(FakeAvatars)).with_forge(FakeConnector::with(TOKEN, p), MemTokens::new(TokenStorage::Keyring));
        api.dispatch(req(serde_json::json!({"method": "addForgeAccount", "params": {"host": "gitlab.example.com", "kind": "gitlab", "token": TOKEN}}))).await.unwrap();
        let ask = |email: &'static str| api.dispatch(req(serde_json::json!({"method": "avatar", "params": {"email": email}})));
        assert_eq!(ask("grace@example.com").await.unwrap()["base64"], "Rk9SR0U=", "the forge's first");
        assert_eq!(ask("ada@example.com").await.unwrap()["base64"], "iVBO", "then Gravatar");
        api.dispatch(req(serde_json::json!({"method": "saveSettings", "params": {"settings": {"forgeAvatars": false}}}))).await.unwrap();
        assert!(ask("grace@example.com").await.unwrap().is_null(), "off: the forge isn't asked");
        assert_eq!(ask("ada@example.com").await.unwrap()["base64"], "iVBO");
    }

    #[tokio::test]
    async fn repo_projects_without_a_forge_list_the_remotes_unmapped() {
        let r = TestRepo::new();
        r.commit("a");
        r.git(&["remote", "add", "origin", "https://gitlab.example.com/group/project.git"]);
        let api = api();
        let id = open(&api, &r).await as u32;
        let rp = api.dispatch(req(serde_json::json!({"method": "forgeRepoProjects", "params": {"repo": id, "refresh": false}}))).await.unwrap();
        assert_eq!(rp, serde_json::json!({"remotes": [{"remote": "origin", "host": "gitlab.example.com", "path": "group/project", "account": null, "project": null, "error": null}], "target": null}));
    }
    // --- end 4A T6 ---
}
