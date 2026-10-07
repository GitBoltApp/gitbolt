//! Backend → frontend events (spec §4.3). One broadcast bus; `gitbolt-app` forwards it as the
//! Tauri event `gb:event`, and `gitbolt-harness` forwards it on every WebSocket.
//!
//! Deviation (spec §4.3): `repoChanged` also carries `worktrees` (the canonical paths whose
//! status changed), and there are extra events: `opStarted` (an op's id and label),
//! `authResolved` (closes the prompt), `opProgress`, which carries only the op id, and
//! `openRequested` (a second launch's path, 1D R19).

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

/// The Tauri event name every `AppEvent` is emitted under (`TAURI_EVENT` in `ui/src/api/transport.ts`).
pub const TAURI_EVENT: &str = "gb:event";
/// A receiver more than this many events behind skips ahead (and logs a warning).
const CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ChangeKind {
    Worktree,
    Index,
    Refs,
    Head,
    Stash,
    Config,
    /// A merge, rebase, cherry-pick or revert started or ended (spec #2 §3.5).
    State,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum OpKind {
    Fetch,
    Clone,
    // Writes (spec #2 §3.5).
    Commit,
    Checkout,
    Branch,
    Reset,
    Stash,
    Discard,
    Stage,
    Pull,
    Push,
    Merge,
    Rebase,
    Undo,
    Redo,
    Worktree,
    Resolve,
    // Saving a working file (2B, Deviation 11).
    Save,
    // Restore a file from a commit (3A).
    Restore,
}

/// An autostash step (`OpStashStep`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StashStep {
    /// `git stash push`: "Saving your changes…".
    Saving,
    /// `git stash apply` and its drop: "Restoring your changes…".
    Restoring,
    // --- 2C T5 ---
    /// Putting back the files a failed or cancelled checkout rewrote: "Restoring files…".
    RestoringFiles,
    // --- end 2C T5 ---
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum OpOutcome {
    Ok,
    Skipped,
    Failed,
    Cancelled,
}

/// A rebase's place (spec #2 §13.4): step `n` of `m`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProgressStep {
    pub n: u32,
    pub m: u32,
    /// The branch being rebased (short name), when known: the status bar's `Rebasing main (n/m)...`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum AppEvent {
    /// Debounced file-system change in the watched (active) repo. `worktrees`: canonical paths
    /// whose status (or WIP file lists) actually changed. `versions`: for those of them whose WIP
    /// lists the watcher keeps (K44), the lists' new version (`FileListPayload::version`).
    RepoChanged {
        repo: u32,
        kinds: Vec<ChangeKind>,
        worktrees: Vec<String>,
        #[ts(type = "Record<string, string>")]
        #[serde(default)]
        versions: std::collections::BTreeMap<String, String>,
    },
    /// A fetch moved at least one ref.
    RefsUpdated { repo: u32 },
    OpStarted {
        #[ts(type = "number")]
        op: u64,
        kind: OpKind,
        repo: Option<u32>,
        /// Fetch: the repo name. Clone: the destination path.
        label: String,
        /// User-started (`true`) or GitBolt-started (`false`, the background fetch). The UI
        /// shows a background op nowhere but its activity log (K30).
        interactive: bool,
    },
    OpProgress {
        #[ts(type = "number")]
        op: u64,
        phase: String,
        percent: Option<u8>,
        /// A rebase's `n` of `m`; absent for fetch and clone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        step: Option<ProgressStep>,
    },
    /// A push's or fetch's `remote:` lines (spec #2 §12.4), classified: the UI keeps them in
    /// that op's Activity entry, whole.
    OpRemote {
        #[ts(type = "number")]
        op: u64,
        lines: Vec<crate::write::remote_output::RemoteLine>,
    },
    OpFinished {
        #[ts(type = "number")]
        op: u64,
        kind: OpKind,
        repo: Option<u32>,
        outcome: OpOutcome,
        message: Option<String>,
        /// The git command that ran, argv joined for display and redacted (no environment, no
        /// askpass secrets): the activity log shows it (K101).
        command: Option<String>,
    },
    /// One redacted line of a write's hook or progress output (spec #2 §3.3): the UI appends it
    /// to that op's Activity entry.
    OpOutput {
        #[ts(type = "number")]
        op: u64,
        line: String,
    },
    /// A write's autostash step began (`step`), or ended (`None`) (spec #2 §6). Once a step has
    /// run ~60 s, the slow-write status says "Saving your changes…" or "Restoring your
    /// changes…"; while one runs, the op's Cancel reads "Stop — your changes stay in stash
    /// <message>", and stops the step (a 15-minute limit stops it too).
    OpStashStep {
        #[ts(type = "number")]
        op: u64,
        step: Option<StashStep>,
        message: String,
    },
    /// A worktree's undo journal changed (a write, an undo, a banner): Undo/Redo and the banners
    /// follow (spec #2 §3.5).
    JournalChanged { repo: u32, worktree: String, state: crate::journal::JournalState },
    /// The repository's action queue changed (spec #2 §3.6): the status-bar chip follows.
    QueueChanged {
        repo: u32,
        running: Option<crate::write::types::QueueItem>,
        queued: Vec<crate::write::types::QueueItem>,
        stopped: Option<crate::write::types::QueueStop>,
    },
    /// A credential prompt is waiting for the user (spec §5.4).
    AuthWaiting {
        #[ts(type = "number")]
        prompt: u64,
        #[ts(type = "number")]
        op: u64,
        repo: Option<u32>,
        text: String,
        secret: bool,
    },
    AuthResolved {
        #[ts(type = "number")]
        prompt: u64,
    },
    /// Another launch on this config dir handed over its launch path (absolute) and exited
    /// (the single-instance guard, `instance.rs`): the UI opens it in a tab.
    OpenRequested { path: String },
    /// The update check, download or install moved on (`updates.rs`): the status bar's pill and
    /// the update dialog follow.
    UpdateChanged { state: crate::updates::UpdateState },
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<AppEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CAPACITY);
        Self { tx }
    }

    /// Never blocks and never fails: with no subscribers the event is dropped.
    pub fn emit(&self, ev: AppEvent) {
        let _ = self.tx.send(ev);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribers_receive_emitted_events() {
        let bus = EventBus::new();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        bus.emit(AppEvent::RefsUpdated { repo: 3 });
        assert_eq!(a.recv().await.unwrap(), AppEvent::RefsUpdated { repo: 3 });
        assert_eq!(b.recv().await.unwrap(), AppEvent::RefsUpdated { repo: 3 });
    }

    #[test]
    fn emitting_without_subscribers_is_fine() {
        EventBus::new().emit(AppEvent::RefsUpdated { repo: 1 });
    }

    #[test]
    fn serializes_tagged_camel_case_and_round_trips() {
        let ev = AppEvent::RepoChanged { repo: 1, kinds: vec![ChangeKind::Refs, ChangeKind::Worktree], worktrees: vec!["/r".into()], versions: [("/r".to_string(), "00ff".to_string())].into() };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            serde_json::json!({"type": "repoChanged", "repo": 1, "kinds": ["refs", "worktree"], "worktrees": ["/r"], "versions": {"/r": "00ff"}})
        );
        let ev = AppEvent::AuthWaiting { prompt: 2, op: 5, repo: None, text: "Password: ".into(), secret: true };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            serde_json::json!({"type": "authWaiting", "prompt": 2, "op": 5, "repo": null, "text": "Password: ", "secret": true})
        );
        assert_eq!(serde_json::to_value(AppEvent::OpenRequested { path: "/r".into() }).unwrap(), serde_json::json!({"type": "openRequested", "path": "/r"}));
        let back: AppEvent = serde_json::from_value(serde_json::json!({"type": "refsUpdated", "repo": 4})).unwrap();
        assert_eq!(back, AppEvent::RefsUpdated { repo: 4 });
    }

    #[test]
    fn write_op_kinds_and_op_output_serialize() {
        assert_eq!(serde_json::to_value(OpKind::Commit).unwrap(), "commit");
        assert_eq!(serde_json::to_value(OpKind::Undo).unwrap(), "undo");
        assert_eq!(serde_json::to_value(OpKind::Resolve).unwrap(), "resolve");
        let ev = AppEvent::OpOutput { op: 3, line: "lint: ok".into() };
        assert_eq!(serde_json::to_value(&ev).unwrap(), serde_json::json!({"type": "opOutput", "op": 3, "line": "lint: ok"}));
    }
}
