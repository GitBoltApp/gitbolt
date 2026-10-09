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
    /// The owner's picture, a user's, an organization's or a group's (GitHub's `owner.avatar_url`,
    /// GitLab's `namespace.avatar_url`): the remote's icon shows it.
    #[serde(default)]
    pub owner_avatar_url: Option<String>,
}

/// One page of a project's forks; `next` is the following page, `None` on the last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForkPage {
    pub forks: Vec<ForgeProject>,
    pub next: Option<u32>,
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
    /// The budget `remaining` counts down from (`X-RateLimit-Limit`, `RateLimit-Limit`).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// What an account's client did since it was last asked (the poll's debug line).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestStats {
    /// Requests sent to the forge.
    pub sent: u64,
    /// Of those, answered 304 (an ETag matched).
    pub not_modified: u64,
    /// GETs answered from what was kept a moment ago, without a request (`FRESH_SECS`).
    pub fresh: u64,
}

/// One forge answer as the cross-session cache keeps it (`forge::cache`): the request's cache
/// key (its URL, and its `Accept` when it has its own), its ETag and its JSON body. Never a
/// token: those only travel in headers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredResponse {
    pub key: String,
    pub etag: String,
    pub body: String,
    pub next_page: Option<String>,
    pub poll_interval_secs: Option<u32>,
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
    /// GitLab's `locked`: the forge is merging it now (moments; then it's merged).
    Merging,
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
    /// A label's colour by name, `#rrggbb` (`label_color`): the ones the forge said (GitHub's
    /// `labels[].color`, GitLab's with `with_labels_details`). A label without one is a plain chip.
    #[serde(default)]
    #[ts(type = "Record<string, string>")]
    pub label_colors: std::collections::BTreeMap<String, String>,
    #[ts(type = "number")]
    pub updated_at: i64,
    /// 4D: its description/body carries GitBolt's Stack table (`stack::MARK_START`): the stack
    /// evidence the after-merge retarget needs (a forge write before any confirm).
    #[serde(default)]
    pub stacked: bool,
    /// Set to merge once its checks pass (GitLab's auto-merge, GitHub's auto-merge); `None`: not set.
    #[serde(default)]
    pub auto_merge: Option<AutoMerge>,
}

/// Who set an open MR/PR to merge when its checks pass, and how it will merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AutoMerge {
    /// GitLab's `merge_user`, GitHub's `auto_merge.enabled_by`; `None` when the forge doesn't say.
    pub enabled_by: Option<ForgeUser>,
    /// GitHub's chosen method; `None` on GitLab (it merges with the project's).
    pub method: Option<MergeMethod>,
}

/// A forge's label colour as `#rrggbb` (lowercase): GitHub's `ededed`, GitLab's `#428BCA` or
/// `#fff`. Anything else is no colour (it goes into a CSS custom property).
pub fn label_color(raw: &str) -> Option<String> {
    let hex = raw.trim().trim_start_matches('#');
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let full = match hex.len() {
        6 => hex.to_string(),
        3 => hex.chars().flat_map(|c| [c, c]).collect(),
        _ => return None,
    };
    Some(format!("#{}", full.to_ascii_lowercase()))
}

/// The label names and colours of a forge's `labels` array: names (GitLab's plain list) or
/// objects with `name` and `color` (GitHub's; GitLab's with `with_labels_details=true`).
pub fn labels_of(v: &serde_json::Value) -> (Vec<String>, std::collections::BTreeMap<String, String>) {
    let mut names = Vec::new();
    let mut colors = std::collections::BTreeMap::new();
    for l in v.as_array().into_iter().flatten() {
        let Some(name) = l.as_str().or(l["name"].as_str()) else { continue };
        if let Some(c) = l["color"].as_str().and_then(label_color) {
            colors.insert(name.to_string(), c);
        }
        names.push(name.to_string());
    }
    (names, colors)
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
    /// The commit its changes are counted from, as the forge says (GitLab's
    /// `diff_refs.base_sha`, GitHub's `base.sha`): the Compare button's FROM, after a local
    /// merge-base with the head (GitHub's is the target's tip when it was last updated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_sha: Option<String>,
    /// The token's user gets its notifications (GitLab's `subscribed`, GitHub's
    /// `viewerSubscription`); `None`: the forge didn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subscribed: Option<bool>,
    // --- 5A T1 ---
    /// GitHub's rendered description (the `full` media type): its signed attachment URLs
    /// (spec #5 §4.2). `None` for GitLab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub body_html: Option<String>,
    // --- end 5A T1 ---
    // --- branch update ---
    /// The source branch is behind its target and the forge can bring it up to date (GitLab's
    /// Rebase, GitHub's Update branch); `None`: no update offered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub update: Option<BranchUpdateOffer>,
    // --- end branch update ---
}

// --- branch update ---
/// A forge-side update of an MR's source branch with its target: the forge rewrites the branch,
/// not the repository (the local branch then lags its remote, as after anyone's push).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BranchUpdate {
    /// GitLab's Rebase, GitHub's Update with rebase.
    Rebase,
    /// GitLab's Rebase without pipeline (`skip_ci`).
    RebaseSkipCi,
    /// GitHub's Update branch: merges the base into the head.
    Merge,
}

/// How the forge offers to update the source branch (`ForgeMrDetail::update`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchUpdateOffer {
    /// Commits the target has that the source branch doesn't (GitLab's
    /// `diverged_commits_count`); `None`: the forge didn't count them (GitHub says only "behind").
    pub behind: Option<u32>,
    /// The kinds this forge offers, the primary first.
    pub kinds: Vec<BranchUpdate>,
    /// The forge is updating it now (GitLab's `rebase_in_progress`).
    pub in_progress: bool,
}
// --- end branch update ---

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
    /// A multi-line note's first line, as `line` / `old_line` are its last (GitLab's `line_range`,
    /// GitHub's `start_line`): `None` for a single-line note.
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub start_old_line: Option<u32>,
    // --- review comments ---
    /// The MR head the position is against (GitLab's `position.head_sha`); `None` where the
    /// forge doesn't say (GitHub: `outdated` says it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head_sha: Option<String>,
    /// The forge couldn't carry it to the MR's head (GitHub's `line: null`): its lines are the
    /// original commit's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub outdated: bool,
    // --- end review comments ---
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
    // --- 5A T1 ---
    /// GitHub's rendered body (the `full` media type): its signed attachment URLs. `None` for GitLab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub body_html: Option<String>,
    // --- end 5A T1 ---
    // --- comment actions ---
    /// Its emoji reactions, in the forge's order; none: not sent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<ForgeReaction>>", optional)]
    pub reactions: Vec<ForgeReaction>,
    /// GitHub's `html_url` (its permalink); `None` for GitLab (the MR's address + `#note_<id>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub web_url: Option<String>,
    // --- end comment actions ---
}

// --- comment actions ---
/// One emoji on a note: its name as the forge spells it (GitLab's `thumbsup`, GitHub's `+1`), how
/// many reacted with it, whether the token's user did, and who (display names), when the forge
/// said (GitHub's comment summaries don't: `users` is empty and `mine` false until asked).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeReaction {
    pub name: String,
    pub count: u32,
    pub mine: bool,
    #[serde(default)]
    pub users: Vec<String>,
}

/// A note to react to, edit or delete: its discussion (GitHub's `issue-…` or `thread-…` says
/// which kind of comment it is) and its id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoteRef {
    pub discussion: String,
    pub note: String,
}

/// GitHub's reactions, in its order: the only names it takes.
pub const GITHUB_REACTIONS: [&str; 8] = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"];

/// `reactions` grouped by name, in first-seen order (GitHub's: its own order): `(name, user id,
/// display name)` each, `me` the token's user.
pub fn group_reactions<'a>(items: impl IntoIterator<Item = (&'a str, u64, &'a str)>, me: Option<u64>, github: bool) -> Vec<ForgeReaction> {
    let mut out: Vec<ForgeReaction> = Vec::new();
    for (name, id, who) in items {
        let r = match out.iter_mut().find(|r| r.name == name) {
            Some(r) => r,
            None => {
                out.push(ForgeReaction { name: name.to_string(), count: 0, mine: false, users: Vec::new() });
                out.last_mut().expect("just pushed")
            }
        };
        r.count += 1;
        r.mine |= me == Some(id);
        r.users.push(who.to_string());
    }
    if github {
        out.sort_by_key(|r| GITHUB_REACTIONS.iter().position(|n| *n == r.name).unwrap_or(usize::MAX));
    }
    out
}
// --- end comment actions ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeDiscussion {
    pub id: String,
    pub notes: Vec<ForgeNote>,
    pub resolvable: bool,
    pub resolved: bool,
    // --- comment actions ---
    /// Who resolved it (a display name or login), when the forge said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolved_by: Option<String>,
    /// When it was resolved (Unix seconds), when the forge said (GitLab).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub resolved_at: Option<i64>,
    // --- end comment actions ---
}

// --- comment actions ---
/// A thread's resolution after Resolve or Unresolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadState {
    pub resolved: bool,
    pub resolved_by: Option<String>,
}
// --- end comment actions ---

// --- review comments ---
/// A side of an MR's diff: the old one (removed lines) or the new one (added and unchanged lines).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DiffSide {
    Old,
    New,
}

/// How a line of an MR's diff changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LineKind {
    Added,
    Removed,
    Context,
}

/// One line of an MR's diff that takes a review comment (`review::commentable_lines`). Its
/// numbers are GitLab's diff parser's: an added line's `old_line` is the old line it comes
/// before, a removed line's `new_line` the new line it comes before. Only GitLab's line codes
/// read those; a position names a line by its own sides (`position_lines`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewLine {
    pub kind: LineKind,
    pub old_line: u32,
    pub new_line: u32,
}

impl ReviewLine {
    /// The side a comment on it is on: a removed line's is the old one, the others' the new one.
    pub fn side(&self) -> DiffSide {
        if self.kind == LineKind::Removed { DiffSide::Old } else { DiffSide::New }
    }

    /// Its number on `side()`.
    pub fn number(&self) -> u32 {
        match self.side() {
            DiffSide::Old => self.old_line,
            DiffSide::New => self.new_line,
        }
    }

    /// (old, new) as a position names them: an added line has no old number, a removed one no
    /// new one, an unchanged one both (GitLab: https://docs.gitlab.com/api/discussions/).
    pub fn position_lines(&self) -> (Option<u32>, Option<u32>) {
        match self.kind {
            LineKind::Added => (None, Some(self.new_line)),
            LineKind::Removed => (Some(self.old_line), None),
            LineKind::Context => (Some(self.old_line), Some(self.new_line)),
        }
    }
}

/// The commits an MR's diff is between, as the forge reports them: GitLab's `diff_refs`
/// (https://docs.gitlab.com/api/merge_requests/); GitHub's base and head (`start_sha` is the base).
/// GitHub's `base_sha` is the base branch's tip when the PR was last updated, not the merge base
/// its files diff from: only `head_sha` names a commit of the diff there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffRefs {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
}

/// Where a new review comment goes: `end`, or the range from `start` down to `end`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewAnchor {
    /// The file's path at the head.
    pub path: String,
    /// Its path at the base (the same unless it was renamed).
    pub old_path: String,
    pub start: Option<ReviewLine>,
    pub end: ReviewLine,
}

/// A review comment to write: where, what, and the diff it was written against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewReviewComment {
    pub anchor: ReviewAnchor,
    pub body: String,
    pub refs: DiffRefs,
}

/// One file of the MR's diff as the forge has it, with the lines that take a comment.
/// `too_large`: the forge sent no diff for it (GitHub's large files, GitLab's `too_large` or
/// `collapsed`), so none of its lines does here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewFile {
    pub path: String,
    pub old_path: String,
    pub lines: Vec<ReviewLine>,
    pub too_large: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewDiff {
    pub refs: DiffRefs,
    pub files: Vec<ReviewFile>,
}

/// One of the user's pending review comments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewDraft {
    /// GitHub: the comment's node id (`PRRC_…`, what GraphQL's edits take); GitLab: the draft
    /// note's id.
    pub id: String,
    pub body: String,
    /// `None`: a draft on no line (GitLab's general draft, or a draft reply).
    pub position: Option<DiffPosition>,
    /// The discussion a draft reply answers (GitLab's `discussion_id`, GitHub's `thread-<id>`).
    pub reply_to: Option<String>,
}

/// The user's pending review on an MR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewDrafts {
    /// `None`: the forge hasn't worked the diff out yet (GitLab right after a create).
    pub refs: Option<DiffRefs>,
    pub drafts: Vec<ReviewDraft>,
    /// GitHub's pending review (its node id), which can exist with no comment; `None` on GitLab.
    pub pending_review: Option<String>,
    /// Add to review works on this forge (GitLab from 16.3).
    pub can_draft: bool,
}

/// How a review with its drafts went in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmitOutcome {
    /// The drafts the review published.
    pub published: u32,
    /// GitLab: the drafts went in but the event after them (approve, request changes, the
    /// summary) was refused: why.
    pub event_error: Option<String>,
    /// The summary note (GitHub: the review body) went in. A retry must not post it again.
    #[serde(default)]
    pub body_posted: bool,
    /// The event itself went in (GitLab: the approval, or the approval withdrawn). With
    /// `event_error` set, only the summary is left to send.
    #[serde(default)]
    pub event_sent: bool,
    /// As `ReviewOutcome::fallback`.
    pub fallback: bool,
}
// --- end review comments ---

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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MergeOptions {
    pub method: Option<MergeMethod>,
    pub squash: Option<bool>,
    pub delete_source_branch: Option<bool>,
    /// Merge only if the head is still this commit. The commit messages are the forge's own.
    pub expected_sha: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MrEdit {
    pub title: Option<String>,
    pub description: Option<String>,
    pub labels: Option<Vec<String>>,
    /// People to add and remove (the MR/PR view's + Add and ×): a change, not the whole list,
    /// since GitHub's reviewers include people who already reviewed (no longer requested), whom
    /// a whole list would ask again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reviewers: Option<PeopleEdit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub assignees: Option<PeopleEdit>,
}

/// Users (forge ids) to add and remove.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeopleEdit {
    #[ts(type = "Array<number>")]
    pub add: Vec<u64>,
    #[ts(type = "Array<number>")]
    pub remove: Vec<u64>,
}

/// How many reviewers and assignees one MR/PR may have; `None`: no limit GitBolt knows of.
/// GitLab Free allows one of each (its REST API silently keeps the first id); GitHub at most 10
/// assignees.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeopleLimits {
    pub max_reviewers: Option<u32>,
    pub max_assignees: Option<u32>,
}

impl PeopleLimits {
    /// GitHub's: at most 10 assignees.
    pub const GITHUB: PeopleLimits = PeopleLimits { max_reviewers: None, max_assignees: Some(10) };
}

/// An MR/PR's head ref on its target's remote, to fetch (the MR view's Compare).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MrHead {
    pub kind: ForgeKind,
    #[ts(type = "number")]
    pub number: u64,
}

impl MrHead {
    /// The refspec: the forge's ref into `refs/remotes/<remote>/mr/<n>` (GitLab) or `…/pr/<n>`
    /// (GitHub), the usual names for them.
    pub fn refspec(&self, remote: &str) -> String {
        let n = self.number;
        match self.kind {
            ForgeKind::GitLab => format!("+refs/merge-requests/{n}/head:refs/remotes/{remote}/mr/{n}"),
            ForgeKind::GitHub => format!("+refs/pull/{n}/head:refs/remotes/{remote}/pr/{n}"),
        }
    }
}

/// What a review from the composer does (GitHub's review events).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

/// A review from the composer: the event and its message (optional for Approve).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSubmit {
    pub event: ReviewEvent,
    pub body: String,
}

/// How a review went in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewOutcome {
    /// GitLab without the requested-changes reviewer state (older servers): Request changes
    /// posted the comment and withdrew the user's approval instead.
    pub fallback: bool,
}

impl PeopleEdit {
    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.remove.is_empty()
    }

    /// The whole list after the change (GitLab's `reviewer_ids`): `current` without the removed
    /// ones, then the added ones not already in it.
    pub fn apply(&self, current: &[u64]) -> Vec<u64> {
        let mut out: Vec<u64> = current.iter().copied().filter(|id| !self.remove.contains(id)).collect();
        for id in &self.add {
            if !out.contains(id) {
                out.push(*id);
            }
        }
        out
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn label_colours_normalize_and_anything_else_is_none() {
        assert_eq!(label_color("ededed").as_deref(), Some("#ededed"), "GitHub's");
        assert_eq!(label_color("#428BCA").as_deref(), Some("#428bca"), "GitLab's");
        assert_eq!(label_color("#FfF").as_deref(), Some("#ffffff"));
        for bad in ["", "#12345", "red", "fff;background:url(x)", "#gggggg"] {
            assert_eq!(label_color(bad), None, "{bad}");
        }
    }

    #[test]
    fn labels_come_as_names_or_objects_with_colours() {
        let (names, colors) = labels_of(&json!(["a", "b"]));
        assert_eq!((names, colors.len()), (vec!["a".to_string(), "b".to_string()], 0), "GitLab without details");
        let (names, colors) = labels_of(&json!([{"name": "feature :gear:", "color": "a2eeef"}, {"name": "docs", "color": "#0075CA"}, {"name": "x", "color": null}]));
        assert_eq!(names, ["feature :gear:", "docs", "x"]);
        assert_eq!(colors.into_iter().collect::<Vec<_>>(), [("docs".to_string(), "#0075ca".to_string()), ("feature :gear:".to_string(), "#a2eeef".to_string())]);
        // An MR from an older GitBolt's cache (no `labelColors`) still loads.
        let old = r#"{"number":1,"title":"t","state":"open","author":{"id":1,"username":"a","name":"A"},"sourceProject":"p","sourceBranch":"b","targetProject":"p","targetBranch":"main","headSha":null,"webUrl":"","pipeline":null,"review":{"decision":"none","approvals":0,"approvalsRequired":null,"reviews":[]},"conflicts":null,"labels":["a"],"updatedAt":0}"#;
        assert!(serde_json::from_str::<ForgeMr>(old).unwrap().label_colors.is_empty());
    }

    // --- 5A T1 ---
    #[test]
    fn body_html_is_sent_only_when_the_forge_gave_one() {
        let author = ForgeUser { id: 1, username: "ada".into(), name: "Ada".into(), avatar_url: None, web_url: "https://x/ada".into(), email: None };
        let mut n = ForgeNote { id: "1".into(), author, body: "b".into(), created_at: 0, system: false, position: None, body_html: None, reactions: vec![], web_url: None };
        assert!(serde_json::to_value(&n).unwrap().get("bodyHtml").is_none());
        n.body_html = Some("<p>b</p>".into());
        assert_eq!(serde_json::to_value(&n).unwrap()["bodyHtml"], "<p>b</p>");
        let back: ForgeNote = serde_json::from_value(serde_json::json!({"id": "1", "author": {"id": 1, "username": "ada", "name": "Ada", "avatarUrl": null, "webUrl": "https://x/ada", "email": null}, "body": "b", "createdAt": 0, "system": false, "position": null})).unwrap();
        assert_eq!(back.body_html, None);
    }
    // --- end 5A T1 ---

    // --- comment actions ---
    #[test]
    fn reactions_group_by_name_with_mine_and_who() {
        let g = group_reactions([("heart", 1, "Ada"), ("+1", 2, "Grace"), ("heart", 2, "Grace")], Some(2), false);
        assert_eq!(g, [
            ForgeReaction { name: "heart".into(), count: 2, mine: true, users: vec!["Ada".into(), "Grace".into()] },
            ForgeReaction { name: "+1".into(), count: 1, mine: true, users: vec!["Grace".into()] },
        ]);
        let g = group_reactions([("eyes", 1, "a"), ("heart", 1, "a"), ("+1", 3, "c")], Some(9), true);
        assert_eq!(g.iter().map(|r| (r.name.as_str(), r.mine)).collect::<Vec<_>>(), [("+1", false), ("heart", false), ("eyes", false)], "GitHub's order");
    }

    #[test]
    fn a_note_without_reactions_or_a_link_reads_and_writes_as_before() {
        let back: ForgeNote = serde_json::from_value(serde_json::json!({"id": "1", "author": {"id": 1, "username": "ada", "name": "Ada"}, "body": "b", "createdAt": 0, "system": false, "position": null})).unwrap();
        assert_eq!((back.reactions.len(), back.web_url.clone()), (0, None));
        let v = serde_json::to_value(&back).unwrap();
        assert!(v.get("reactions").is_none() && v.get("webUrl").is_none());
    }
    // --- end comment actions ---

    // --- review comments ---
    #[test]
    fn review_types_serialize_as_the_ui_reads_them() {
        let l = ReviewLine { kind: LineKind::Context, old_line: 3, new_line: 4 };
        assert_eq!(serde_json::to_value(l).unwrap(), json!({"kind": "context", "oldLine": 3, "newLine": 4}));
        assert_eq!(serde_json::to_value(DiffSide::Old).unwrap(), "old");
        let p: DiffPosition = serde_json::from_value(json!({"path": "a", "oldPath": null, "line": 1, "oldLine": null, "snippet": null})).unwrap();
        assert_eq!((p.head_sha.clone(), p.outdated), (None, false), "a position from an older GitBolt's cache still loads");
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("headSha").is_none() && v.get("outdated").is_none(), "{v}");
        let out = SubmitOutcome { published: 2, event_error: Some("refused".into()), body_posted: true, event_sent: false, fallback: false };
        assert_eq!(serde_json::to_value(out).unwrap(), json!({"published": 2, "eventError": "refused", "bodyPosted": true, "eventSent": false, "fallback": false}));
    }

    #[test]
    fn a_line_is_on_its_own_side_and_a_position_names_only_its_sides() {
        let (add, del, ctx) = (ReviewLine { kind: LineKind::Added, old_line: 3, new_line: 2 }, ReviewLine { kind: LineKind::Removed, old_line: 2, new_line: 2 }, ReviewLine { kind: LineKind::Context, old_line: 3, new_line: 4 });
        assert_eq!((add.side(), add.number(), add.position_lines()), (DiffSide::New, 2, (None, Some(2))));
        assert_eq!((del.side(), del.number(), del.position_lines()), (DiffSide::Old, 2, (Some(2), None)));
        assert_eq!((ctx.side(), ctx.number(), ctx.position_lines()), (DiffSide::New, 4, (Some(3), Some(4))));
    }
    // --- end review comments ---

    #[test]
    fn a_people_change_adds_after_the_kept_ones_once_each() {
        let change = PeopleEdit { add: vec![9, 3, 9], remove: vec![2, 5] };
        assert_eq!(change.apply(&[1, 2, 3]), [1, 3, 9], "3 was there; 9 once; 5 wasn't");
        assert_eq!(PeopleEdit { add: vec![], remove: vec![1] }.apply(&[1]), Vec::<u64>::new());
        assert!(PeopleEdit::default().is_empty());
    }

    #[test]
    fn an_edit_without_people_reads_as_before() {
        let e: MrEdit = serde_json::from_value(json!({"title": "t", "description": null, "labels": null})).unwrap();
        assert_eq!((e.reviewers, e.assignees), (None, None));
        let e: MrEdit = serde_json::from_value(json!({"title": null, "description": null, "labels": null, "reviewers": {"add": [7], "remove": []}})).unwrap();
        assert_eq!(e.reviewers, Some(PeopleEdit { add: vec![7], remove: vec![] }));
    }
}
