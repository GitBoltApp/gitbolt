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
    // --- 5A T1 ---
    /// GitHub's rendered description (the `full` media type): its signed attachment URLs
    /// (spec #5 §4.2). `None` for GitLab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub body_html: Option<String>,
    // --- end 5A T1 ---
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
    // --- 5A T1 ---
    /// GitHub's rendered body (the `full` media type): its signed attachment URLs. `None` for GitLab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub body_html: Option<String>,
    // --- end 5A T1 ---
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
        let mut n = ForgeNote { id: "1".into(), author, body: "b".into(), created_at: 0, system: false, position: None, body_html: None };
        assert!(serde_json::to_value(&n).unwrap().get("bodyHtml").is_none());
        n.body_html = Some("<p>b</p>".into());
        assert_eq!(serde_json::to_value(&n).unwrap()["bodyHtml"], "<p>b</p>");
        let back: ForgeNote = serde_json::from_value(serde_json::json!({"id": "1", "author": {"id": 1, "username": "ada", "name": "Ada", "avatarUrl": null, "webUrl": "https://x/ada", "email": null}, "body": "b", "createdAt": 0, "system": false, "position": null})).unwrap();
        assert_eq!(back.body_html, None);
    }
    // --- end 5A T1 ---
}
