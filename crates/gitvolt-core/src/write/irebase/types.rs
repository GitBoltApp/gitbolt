//! The interactive rebase request's types (spec #3 §3.3; the cross-plan contract, Ruling 1).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A row's action. (#2's `RebaseAction` is the commit panel's Continue / Skip / Abort.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RebaseRowAction {
    Pick,
    Reword,
    Squash,
    /// Squash, discarding this row's message.
    Fixup,
    Drop,
    /// Stop after this commit to amend or split it.
    Edit,
}

/// One editor row, newest first in the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RebaseRow {
    pub oid: String,
    pub action: RebaseRowAction,
    /// The edited message; on a fold target, the group's merged message.
    #[serde(default)]
    #[ts(optional)]
    pub message: Option<String>,
}

/// Where a chip's branch goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "oid", rename_all = "camelCase")]
#[ts(export)]
pub enum ChipAt {
    /// After this row (an oid of the plan, or the base's).
    Row(String),
    /// Deleted once the rebase completes.
    Delete,
    /// A new branch, created at this row.
    New(String),
    /// 3D (Rebase stack): left where it is. No `update-ref` line, never moved or deleted, and
    /// never a move in the journal. Any chip of the range may stay, locked or not.
    Stay,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChipPlan {
    /// Short name (`feature/a`).
    pub branch: String,
    pub at: ChipAt,
}
