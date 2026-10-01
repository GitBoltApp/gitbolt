//! Backend → frontend events (spec §4.3). One broadcast bus; `gitbolt-app` forwards it as the
//! Tauri event `gb:event`, and `gitbolt-harness` forwards it on every WebSocket.
//!
//! Deviation (spec §4.3): `repoChanged` also carries `worktrees` (the canonical paths whose
//! status changed), and there are three extra events: `opStarted` (an op's id and label),
//! `authResolved` (closes the prompt), and `opProgress`, which carries only the op id.

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum OpKind {
    Fetch,
    Clone,
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
    },
    OpFinished {
        #[ts(type = "number")]
        op: u64,
        kind: OpKind,
        repo: Option<u32>,
        outcome: OpOutcome,
        message: Option<String>,
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
        let back: AppEvent = serde_json::from_value(serde_json::json!({"type": "refsUpdated", "repo": 4})).unwrap();
        assert_eq!(back, AppEvent::RefsUpdated { repo: 4 });
    }
}
