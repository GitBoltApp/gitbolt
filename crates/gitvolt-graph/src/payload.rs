//! The graph's payload types, serialized to the UI (TypeScript from ts-rs, `just gen-types`, into
//! ui/src/api/gen/ like the core's), and the per-worktree data it carries.

use crate::layout::{NodeKind, Segment};
use crate::{render_ascii, AsciiRow};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphPayload {
    pub rows: Vec<RowPayload>,
    pub labels: Vec<RefLabel>,
    pub max_lanes: u16,
    /// The pinned refs, the one leading lane 0 first: the chosen pin (the default trunk or an
    /// explicit one) and its pair, a local branch's upstream or the local branch tracking a remote
    /// one, local first; in a fork by default, the original project's trunk then the local main.
    /// Their commits are laid out at the left (lane 0, and lane 1 for a diverged pair's second).
    /// Only refs whose commit is in the window; empty when nothing is pinned.
    pub pinned_refs: Vec<String>,
    pub head: HeadPayload,
    pub truncated: bool,
    /// The open worktree (the one this tab opened), spelled as its WIP row's
    /// `WipPayload::worktree_path` would be, dirty or not: what "Compare with working tree"
    /// targets. Absent if it isn't among `git worktree list`'s usable ones.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub open_worktree: Option<String>,
    /// Every usable worktree of the repository (spec #2 §11.2).
    pub worktrees: Vec<GraphWorktree>,
    // 2D-T6 begin
    /// Each worktree's merge, rebase or other in-progress operation (spec #2 §13.2), keyed by its
    /// path as its WIP row's `worktreePath` spells it (Deviation 1). Absent when none is mid-operation.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[ts(optional, as = "Option<std::collections::BTreeMap<String, crate::InProgress>>")]
    pub in_progress: std::collections::BTreeMap<String, InProgress>,
    // 2D-T6 end
    /// The repository is a fork (`snapshot::fork_of`): which remote is your fork, which the
    /// original project, and how that was told. Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fork: Option<ForkPayload>,
}

/// A fork's remotes as the graph sees them: the default pin is the original project's trunk,
/// and a commit on a local branch standing for a trunk here gets a notice (the commit panel).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForkPayload {
    /// Your fork's remote (`origin`).
    pub fork: String,
    /// The original project's remote (`upstream`).
    pub original: String,
    /// The original remote's host, and the forge it's detected as (the UI applies the
    /// profile's host-type overrides by host): what a change for it is called, a merge request
    /// on GitLab.
    pub host: Option<String>,
    pub host_kind: HostKind,
    pub detected_by: ForkDetection,
    /// The original project's trunk (`refs/remotes/upstream/main`); `None` until it's fetched.
    pub trunk: Option<String>,
    /// Your fork's own trunk (`refs/remotes/origin/main`), never pinned by default.
    pub fork_trunk: Option<String>,
    /// The local branches a commit on which goes to a trunk rather than a branch of its own:
    /// `trunk`'s local counterpart (the default pin's local branch) and every local branch whose
    /// upstream is `fork_trunk`. Full names, sorted.
    pub trunk_branches: Vec<String>,
}

/// How a fork was told (`ForkPayload::detected_by`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ForkDetection {
    /// The forge's cached data: the fork remote's project is a fork of the original remote's.
    Forge,
    /// No forge data: a remote named `upstream` next to `origin` (GitHub's fork workflow).
    UpstreamRemote,
}

/// One usable worktree as the graph sees it (spec #2 §11.2): the UI moves the HEAD marker and
/// the "checked out elsewhere" chips to the tab's active worktree from these, with no request.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphWorktree {
    /// Spelled as its WIP row's `WipPayload::worktree_path`.
    pub path: String,
    /// The full ref its HEAD names; `None` when detached or bare.
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    /// The operation in progress there, by kind (`merge`, `rebase`, or what git calls the other
    /// one: `cherry-pick`, `revert`, `am`); the detail is in `GraphPayload.in_progress`, keyed by
    /// this path.
    pub in_progress: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RowPayload {
    pub id: String,
    pub kind: NodeKind,
    pub lane: u16,
    pub color: u8,
    /// Packed segments; see `graph::Segment::pack`.
    pub segments: Vec<u32>,
    pub summary: String,
    pub body_first_line: String,
    pub author_name: String,
    pub author_email: String,
    #[ts(type = "number")]
    pub author_time: i64,
    /// Committer timestamp (unix seconds): what the Date/Time column shows. It
    /// differs from `author_time` once a commit is amended, rebased or cherry-picked. 0 on WIP rows.
    #[ts(type = "number")]
    pub committer_time: i64,
    pub parents: Vec<String>,
    /// MR/PR/issue references in the summary and body, as written (`!42`, `group/project!7`,
    /// `#12`, `owner/repo#3`), first occurrence first, at most 20 (`message_refs`, §9.2). The
    /// host decides what each means. Empty on WIP rows.
    pub mr_refs: Vec<String>,
    pub wip: Option<WipPayload>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WipPayload {
    pub worktree_path: String,
    pub worktree_name: Option<String>,
    pub modified: u32,
    pub added: u32,
    pub deleted: u32,
    pub renamed: u32,
    pub conflicted: u32,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeadPayload {
    pub branch: Option<String>,
    pub target: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RefLabel {
    pub row: u32,
    pub name: String,
    pub local: Option<String>,
    pub remotes: Vec<RemoteRefLabel>,
    pub tag: bool,
    pub is_head: bool,
    pub worktree: Option<String>,
    /// The worktree (any, the open one included) whose HEAD is this local branch.
    pub checked_out: Option<String>,
    /// A local branch whose upstream has another branch name (`feature/a` tracking
    /// `origin/feature/b`): that upstream's short name, for the chip's warning (UX round 3, M.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream_mismatch: Option<String>,
    /// An annotated tag's message and tagger (UX round 3, M.2); absent on a lightweight tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotation: Option<TagAnnotation>,
}

/// An annotated tag's message and tagger, for the tag chip's and the sidebar row's tooltip (UX
/// round 3, M.2). Read in process with the refs, cached by tag object (`refs::read_tag`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagAnnotation {
    /// The message's first `refs::TAG_MESSAGE_LINES` lines (any signature left out), trimmed.
    pub message: String,
    /// More of the message follows.
    pub truncated: bool,
    /// The tagger's name.
    pub tagger: Option<String>,
    /// When it was tagged (unix seconds); 0 without a tagger.
    #[ts(type = "number")]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteRefLabel {
    pub full_name: String,
    pub remote: String,
    /// The remote's host name, so the UI can apply the profile's host-type override.
    pub host: Option<String>,
    pub host_kind: HostKind,
}

impl GraphPayload {
    /// ASCII dump: layout grid, then the row summary (WIP rows show their worktree).
    pub fn ascii(&self) -> String {
        let segs: Vec<Vec<Segment>> = self.rows.iter().map(|r| r.segments.iter().map(|&s| Segment::unpack(s)).collect()).collect();
        let labels: Vec<String> = self
            .rows
            .iter()
            .map(|r| match &r.wip {
                Some(w) => format!("// WIP {}", w.worktree_name.as_deref().unwrap_or("(main)")),
                None => r.summary.clone(),
            })
            .collect();
        let rows: Vec<AsciiRow> = self
            .rows
            .iter()
            .zip(&segs)
            .zip(&labels)
            .map(|((r, s), l)| AsciiRow { lane: r.lane, kind: r.kind, segments: s, label: l })
            .collect();
        render_ascii(&rows, self.max_lanes)
    }
}

// `Deserialize` and `Ord`: the profile's host-type overrides are a map keyed by host (§14.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum HostKind {
    GitLab,
    GitHub,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum InProgress {
    /// `MERGE_HEAD` exists. `message`: `MERGE_MSG`, line endings normalised (§8.2).
    Merge { merge_head: String, message: String, conflicted: u32 },
    /// `rebase-merge/` (or `rebase-apply/`). `onto` and `stopped_at` are oids; `head_name` is the
    /// branch being rebased (`refs/heads/main`). `message`: what Continue commits the stopped
    /// pick with (`rebase-merge/message`, `rebase-apply/final-commit`), line endings normalised;
    /// empty when git wrote none.
    Rebase {
        onto: String,
        head_name: String,
        step: u32,
        total: u32,
        stopped_at: Option<String>,
        // --- 3C T4 ---
        /// At an `edit` stop: the commit git made there (`rebase-merge/amend`). `None` at a
        /// conflict, or a stop of another kind.
        edit_stop: Option<String>,
        // --- end 3C T4 ---
        /// UX L: GitVolt's Edit stop is "about to commit": right after git stopped, HEAD was
        /// soft-reset to the edited commit's parent (this oid), so its changes are staged and its
        /// message (`message`) is the commit box's. `None`: git's own stop (HEAD on `edit_stop`),
        /// as a terminal's rebase has it.
        edit_base: Option<String>,
        /// UX L, with `edit_base`: the paths the stopped commit adds. One left untracked is a
        /// piece of it not staged yet: Continue waits for it (any other untracked file doesn't).
        edit_added: Vec<String>,
        /// UX L, with `edit_base`: the index isn't the stopped commit's tree (changed, or some of
        /// it unstaged): an Abort keeps it.
        edit_changed: bool,
        /// 3C final fix (I1): the stopped pick is an `edit` line that stopped before git made its
        /// commit (a conflict): git won't stop again once it's resolved, so this stop is the Edit's.
        edit_conflict: bool,
        /// 3C final fix (M1, M2): GitVolt couldn't apply this stop's new message (a commit-msg
        /// hook refused it): why. HEAD keeps the old one.
        message_failed: Option<String>,
        /// 3C fix round 2: GitVolt's own interactive rebase (its session is there): Commit at
        /// its Edit stops is GitVolt's. `false` for one started in a terminal.
        gitvolt: bool,
        conflicted: u32,
        message: String,
    },
    /// `CHERRY_PICK_HEAD` (a single pick, or a range's, `.git/sequencer/` too). `head`: the commit
    /// being picked; `message`: `MERGE_MSG`, what Continue commits it with. A range stopped
    /// between picks (`sequencer/` alone) isn't an operation here, as for gix.
    CherryPick { head: Option<String>, message: String, conflicted: u32 },
    /// `REVERT_HEAD`: as `CherryPick`, for the commit being reverted.
    Revert { head: Option<String>, message: String, conflicted: u32 },
    /// `git am`, started outside GitVolt; #3 adds its actions.
    Other { what: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(default)]
#[ts(export, export_to = "../../demo/gen/")]
pub struct WipCounts {
    pub modified: u32,
    pub added: u32,
    pub deleted: u32,
    /// Renamed in the index (`R`); one per path, so a staged and unstaged edit of the same path
    /// is one file, as in the WIP panel's "N file changes".
    pub renamed: u32,
    pub conflicted: u32,
}

impl WipCounts {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}
