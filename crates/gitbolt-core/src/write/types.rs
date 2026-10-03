//! Payloads the write requests share (spec #2 §3.1, §3.6).

use crate::events::OpKind;
use crate::journal::JournalState;
use crate::payload::FileListPayload;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// What the UI's snapshot showed when the user acted (spec #2 §3.1, §4): preflight compares it
/// with HEAD and the refs, so an outside move is `RefMoved` before anything runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Expect {
    /// The HEAD oid shown; `None` = not checked.
    pub head: Option<String>,
    /// Full ref name → the oid shown (`None` = it must not exist).
    #[ts(type = "Record<string, string | null>")]
    pub refs: BTreeMap<String, Option<String>>,
}

/// What the user already confirmed for this intent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Confirm {
    /// The clean-restore warning (§6.2) was shown and the user chose Continue.
    pub autostash: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueueItem {
    #[ts(type = "number")]
    pub id: u64,
    pub label: String,
    pub kind: OpKind,
    /// The op (`cancelOp` cancels the running one).
    #[ts(type = "number")]
    pub op: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueueStop {
    /// The item that failed.
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueueStatePayload {
    pub running: Option<QueueItem>,
    /// In click order; "not run" while `stopped`.
    pub queued: Vec<QueueItem>,
    pub stopped: Option<QueueStop>,
}

/// Every write's answer (spec #2 §3.1): the UI applies `journal`, `staging` and `wip` at once, so
/// it never waits on the file watcher.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WriteResult<T> {
    pub outcome: T,
    pub journal: JournalState,
    pub staging: StagingUndoState,
    pub wip: Option<WipListsPayload>,
}

/// The staging undo log's state (§7.6, 2B). 2A has no staging, so every write returns the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StagingUndoState {
    pub undo: Option<String>,
    pub redo: Option<String>,
    /// Why staging undo is off (files are conflicted and no resolution is in the log: "Stage and
    /// unstage can't be undone while files are conflicted.").
    pub off: Option<String>,
}

/// The worktree's fresh WIP lists, as `fileList` would answer them, with the version the
/// write's `repoChanged` carries (K44).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WipListsPayload {
    pub worktree: String,
    pub version: String,
    pub staged: FileListPayload,
    pub unstaged: FileListPayload,
}
