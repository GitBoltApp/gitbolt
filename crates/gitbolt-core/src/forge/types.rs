//! The forge layer's normalized types (spec #4 §3.1). The UI never branches on the forge kind,
//! except for labels ("MR"/"PR", "!12"/"#12") and forge-only fields. Times are unix seconds.
//! 4A fills the identity, project and token types. The merge request types are the contract
//! 4B–4D implement (`provider.rs` declares the methods that return them).

use crate::remotes::HostKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ForgeKind {
    GitLab,
    GitHub,
}

impl ForgeKind {
    /// The forge a host type speaks, if any (`Generic` speaks none).
    pub fn from_host_kind(k: HostKind) -> Option<Self> {
        match k {
            HostKind::GitLab => Some(Self::GitLab),
            HostKind::GitHub => Some(Self::GitHub),
            HostKind::Generic => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::GitLab => "GitLab",
            Self::GitHub => "GitHub",
        }
    }
}

/// Where an account's token is kept (spec #4 §2 "Token storage").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TokenStorage {
    Keyring,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeUser {
    #[ts(type = "number")]
    pub id: u64,
    pub username: String,
    /// The display name; the username when the forge has none.
    pub name: String,
    // `default`: a profile file from an older or newer GitBolt still loads.
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub web_url: String,
    /// The public email, or the account's own for its own user, when the forge says.
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeProject {
    pub kind: ForgeKind,
    #[ts(type = "number")]
    pub id: u64,
    pub host: String,
    /// `group/sub/project` (GitLab) or `owner/repo` (GitHub).
    pub path: String,
    pub name: String,
    /// The namespace (`group/sub`) or the owner's login: what a fork's remote is named after.
    pub owner: String,
    pub web_url: String,
    /// `None` for an empty project.
    pub default_branch: Option<String>,
    pub clone_https: String,
    pub clone_ssh: String,
    /// The parent's `path` when this is a fork.
    pub fork_of: Option<String>,
    #[ts(type = "number | null")]
    pub updated_at: Option<i64>,
    pub archived: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
    /// GitLab's "merge commit with semi-linear history".
    SemiLinear,
    FastForward,
}

/// GitLab's `squash_option`; GitHub's is derived from which merge methods the repository allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SquashOption {
    Never,
    DefaultOff,
    DefaultOn,
    Always,
}

/// What the Create and merge forms inherit from the project (spec #4 §2: "inherit the project's settings").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeProjectSettings {
    pub merge_methods: Vec<MergeMethod>,
    pub squash: SquashOption,
    /// Delete the source branch after merging, by default.
    pub delete_source_branch: bool,
}

/// Whether a token may make changes (spec #4 §3.2). `Unknown`: the forge can't say (a GitHub
/// fine-grained token, an older GitLab).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum WriteAccess {
    Yes,
    No { missing: String },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TokenCheck {
    pub user: ForgeUser,
    pub write: WriteAccess,
}

/// One account's rate limit as its last responses said.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RateLimitState {
    /// Set while limited: no request until then.
    #[ts(type = "number | null")]
    pub limited_until: Option<i64>,
    pub remaining: Option<u32>,
    #[ts(type = "number | null")]
    pub reset_at: Option<i64>,
}

/// A value with what its request said about freshness (spec #4 §3.4): a 304 (`not_modified`), the
/// server's poll interval, and when it was read (for the UI's "last updated" note).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Fresh<T> {
    pub value: T,
    pub not_modified: bool,
    pub poll_interval_secs: Option<u32>,
    #[ts(type = "number")]
    pub fetched_at: i64,
}

impl<T> Fresh<T> {
    pub fn new(value: T, fetched_at: i64) -> Self {
        Self { value, not_modified: false, poll_interval_secs: None, fetched_at }
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Fresh<U> {
        Fresh { value: f(self.value), not_modified: self.not_modified, poll_interval_secs: self.poll_interval_secs, fetched_at: self.fetched_at }
    }
}

// ---------------------------------------------------------------------------------------------
// The merge request contract (4B–4D implement the provider methods that return these).
// ---------------------------------------------------------------------------------------------

/// The badge's state (spec #4 §2 "Badge"): a draft is an open MR/PR marked draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PipelineStatus {
    Pending,
    Running,
    Success,
    Failed,
    Canceled,
    Skipped,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgePipeline {
    pub status: PipelineStatus,
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Commented,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeReview {
    pub user: ForgeUser,
    pub state: ReviewState,
    #[ts(type = "number | null")]
    pub submitted_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSummary {
    pub decision: ReviewDecision,
    pub approvals: u32,
    pub approvals_required: Option<u32>,
    pub reviews: Vec<ForgeReview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeMr {
    /// GitLab's `iid`, GitHub's `number`: what "!12" / "#12" show.
    #[ts(type = "number")]
    pub number: u64,
    pub title: String,
    pub state: MrState,
    pub author: ForgeUser,
    /// The project path the source branch lives in (a fork's, for an MR/PR from a fork).
    pub source_project: String,
    pub source_branch: String,
    pub target_project: String,
    pub target_branch: String,
    pub head_sha: Option<String>,
    pub web_url: String,
    pub pipeline: Option<ForgePipeline>,
    pub review: ReviewSummary,
    /// `None`: the forge hasn't computed it yet (GitHub's `mergeable: null`).
    pub conflicts: Option<bool>,
    pub labels: Vec<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum MergeStatus {
    Mergeable,
    /// The forge is still computing it.
    Checking,
    /// Why Merge is disabled (spec #4 §2: "disabled with the reason").
    Blocked { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeMrDetail {
    pub mr: ForgeMr,
    /// Plain text in phase 4 (spec #4 §2).
    pub description: String,
    pub reviewers: Vec<ForgeUser>,
    pub assignees: Vec<ForgeUser>,
    pub merge_status: MergeStatus,
    pub squash: Option<bool>,
    pub delete_source_branch: Option<bool>,
}

/// Where a diff-line note sits (spec #4 §2: shown in the thread with `file:line` and a snippet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffPosition {
    pub path: String,
    pub old_path: Option<String>,
    pub line: Option<u32>,
    pub old_line: Option<u32>,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeNote {
    pub id: String,
    pub author: ForgeUser,
    pub body: String,
    #[ts(type = "number")]
    pub created_at: i64,
    /// A forge-generated note ("added 2 commits").
    pub system: bool,
    pub position: Option<DiffPosition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeDiscussion {
    pub id: String,
    pub notes: Vec<ForgeNote>,
    pub resolvable: bool,
    pub resolved: bool,
}

/// The sidebar list's filter (spec #4 §2 "MR/PR list").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MrFilter {
    Mine,
    ReviewRequested,
    All,
}

/// A branch in a project: an MR/PR's source (a fork's project for one from a fork).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceRef {
    pub project: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewNote {
    /// Reply in this discussion; `None` starts a new one.
    pub discussion: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MergeOptions {
    pub method: Option<MergeMethod>,
    pub squash: Option<bool>,
    pub delete_source_branch: Option<bool>,
    /// Merge only if the head is still this commit.
    pub expected_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MrEdit {
    pub title: Option<String>,
    pub description: Option<String>,
    pub labels: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateMr {
    pub source: SourceRef,
    pub target_branch: String,
    pub title: String,
    pub description: String,
    pub draft: bool,
    #[ts(type = "Array<number>")]
    pub reviewers: Vec<u64>,
    #[ts(type = "Array<number>")]
    pub assignees: Vec<u64>,
    pub labels: Vec<String>,
    /// GitLab only; `None` follows the project.
    pub squash: Option<bool>,
    pub delete_source_branch: Option<bool>,
}

/// The follow-up calls GitHub's create needs (spec #4 §3.5: partial failures are explicit).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CreatePart {
    Reviewers,
    Assignees,
    Labels,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartFailure {
    pub part: CreatePart,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateOutcome {
    pub mr: ForgeMr,
    pub failed: Vec<PartFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeLabel {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MrTemplate {
    pub name: String,
    pub path: String,
    pub body: String,
}
