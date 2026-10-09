//! GitHub REST (spec #4 §3.1): identity, repositories, settings, forks, avatars. GitHub has no
//! avatar-by-email API: an avatar comes from a noreply email's user id, or an email → avatar URL
//! learned from API data (`learn_avatar`). Never a user search by email (30 a minute, public
//! emails only). 4B–4D add the pull request methods, in their marked blocks.

use crate::avatar_cache::{image_at, payload_of, DiskAvatarCache, Lookup};
use crate::known_names::{KnownNames, NameMatch};
use crate::endpoints::HostEndpoints;
use crate::http::{encode_component, ClientConfig, HttpClient, HttpResponse, Method};
use crate::time::unix_now;
use gitbolt_core::avatar::AvatarPayload;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub const GITHUB_HEADERS: [(&str, &str); 2] = [("Accept", "application/vnd.github+json"), ("X-GitHub-Api-Version", "2022-11-28")];
// --- 5A T2 ---
/// GitHub's `full` media type: bodies and comments carry `body_html` (with signed image URLs).
pub const GITHUB_FULL: &str = "application/vnd.github.full+json";
// --- end 5A T2 ---
pub const FORKS_PER_PAGE: u32 = 100;
pub const FORK_PAGES: usize = 3;
// --- GitHub commit-author avatars ---
/// No commit-author lookup while fewer API requests than this are left this hour: avatars are
/// the least of what the account's budget is for.
pub const AUTHOR_LOOKUP_FLOOR: u32 = 500;
// --- end GitHub commit-author avatars ---

/// The user id in a `<id>+<login>@users.noreply.github.com` email.
pub fn noreply_id(email: &str) -> Option<u64> {
    let lower = email.trim().to_ascii_lowercase();
    let local = lower.strip_suffix("@users.noreply.github.com")?;
    local.split_once('+')?.0.parse().ok()
}

/// The login in an older `<login>@users.noreply.github.com` email (no id): a GitHub login, 1–39
/// letters, digits or single inner hyphens.
pub fn noreply_login(email: &str) -> Option<&str> {
    let email = email.trim();
    let at = email.len().checked_sub("@users.noreply.github.com".len())?;
    let (local, domain) = (email.get(..at)?, email.get(at..)?);
    let ok = domain.eq_ignore_ascii_case("@users.noreply.github.com")
        && (1..=39).contains(&local.len())
        && local.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !local.starts_with('-')
        && !local.ends_with('-')
        && !local.contains("--");
    ok.then_some(local)
}

pub struct GitHubProvider {
    host: String,
    api_base: String,
    avatars_base: String,
    http: HttpClient,
    cache: Option<Arc<DiskAvatarCache>>,
    /// Lowercase email → avatar URL, from API data.
    learned: Mutex<HashMap<String, String>>,
      // --- 4B T4 ---
      /// The token's user, once asked (Mine, Review requested).
      me: Mutex<Option<ForgeUser>>,
      // --- end 4B T4 ---
    /// The list's checks by head commit (`pipelines`): asked only for new or running heads.
    checks: crate::pipelines::PipelineCache,
    // --- GitHub commit-author avatars ---
    /// Lowercase emails whose commit author was asked this session, answered or not.
    authors_asked: Mutex<HashSet<String>>,
    /// One commit-author lookup at a time.
    author_turn: tokio::sync::Mutex<()>,
    // --- end GitHub commit-author avatars ---
    // --- commit-author avatars by name ---
    /// The people the API data showed, by name (`known_names`): logins, mostly (a list's users
    /// carry no display name).
    names: KnownNames,
    // --- end commit-author avatars by name ---
    // --- 5A T2 ---
    /// The bases Markdown images load from without asking (`images::github_route`).
    image_bases: Vec<String>,
    // --- end 5A T2 ---
    /// (repo, PR) → (its `updated_at` when asked, `viewerSubscription`): a detail poll asks
    /// GraphQL only when the PR changed.
    subscriptions: Mutex<Subscriptions>,
    // --- comment actions ---
    /// A comment's reactions URL → (its counts when read, its reactions with who and `mine`): read
    /// again only when the comment's counts change.
    reaction_lists: Mutex<ReactionLists>,
    /// (repo, PR) → a review thread's first comment id → the thread's node id (what Resolve takes).
    thread_ids: Mutex<HashMap<(String, u64), HashMap<u64, String>>>,
    // --- end comment actions ---
  }

/// Reactions URL → (`counts`, the reactions).
type ReactionLists = HashMap<String, (Vec<(String, u32)>, Vec<ForgeReaction>)>;

/// The names and counts of `reactions`: what a comment's summary says.
fn counts(reactions: &[ForgeReaction]) -> Vec<(String, u32)> {
    reactions.iter().map(|r| (r.name.clone(), r.count)).collect()
}

/// (repo, PR) → (its `updated_at` when asked, `viewerSubscription`).
type Subscriptions = HashMap<(String, u64), (String, Option<bool>)>;

/// The token's user's subscription to one PR.
pub const SUBSCRIPTION_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { viewerSubscription } } }";

impl GitHubProvider {
    pub fn new(host: &str, endpoints: &HostEndpoints, token: Secret, cache: Option<Arc<DiskAvatarCache>>) -> Self {
        let http = HttpClient::new(ClientConfig { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), token: Some(token), headers: GITHUB_HEADERS.to_vec(), timeout: crate::http::REQUEST_TIMEOUT });
        let avatars_base = endpoints.avatars.clone().unwrap_or_else(|| "https://avatars.githubusercontent.com".into()).trim_end_matches('/').to_string();
        let image_bases = crate::images::default_github_image_bases(&endpoints.web, &avatars_base);
        Self { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), avatars_base, http, cache, learned: Mutex::default(), me: Mutex::new(None), checks: Default::default(), authors_asked: Mutex::default(), author_turn: tokio::sync::Mutex::new(()), names: KnownNames::default(), image_bases, subscriptions: Mutex::default(), reaction_lists: Mutex::default(), thread_ids: Mutex::default() }
    }

    // --- 5A T2 ---
    /// The bases Markdown images load from without asking (`images::github_route`); the harness
    /// points them at its fake.
    pub fn with_image_bases(mut self, bases: Vec<String>) -> Self {
        self.image_bases = bases.into_iter().map(|b| b.trim_end_matches('/').to_string()).collect();
        self
    }
    // --- end 5A T2 ---

    pub fn http(&self) -> &HttpClient {
        &self.http
    }

    /// See `HttpClient::with_change_counter`.
    pub fn with_change_counter(mut self, changes: crate::http::ChangeCounter) -> Self {
        self.http = self.http.with_change_counter(changes);
        self
    }

    /// An email → avatar URL seen in API data (a commit's author, the account's user).
    pub fn learn_avatar(&self, email: &str, url: &str) {
        let email = email.trim().to_ascii_lowercase();
        if !email.is_empty() && !url.is_empty() {
            self.learned.lock().expect("learned avatars poisoned").insert(email, url.to_string());
        }
    }

    /// `/repos/<owner>/<repo>`; anything else isn't a GitHub repository path.
    pub fn repo_url(path: &str) -> Result<String, GbError> {
        match path.split_once('/') {
            Some((o, r)) if !o.is_empty() && !r.is_empty() && !r.contains('/') => Ok(format!("/repos/{}/{}", encode_component(o), encode_component(r))),
            _ => Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} isn't an owner/repository path"))),
        }
    }

    fn fresh<T>(value: T, r: &HttpResponse) -> Fresh<T> {
        Fresh { value, not_modified: r.not_modified, poll_interval_secs: r.poll_interval_secs, fetched_at: unix_now() }
    }
}

fn unreadable(host: &str, what: &str) -> GbError {
    GbError::other(format!("{host} sent a {what} GitBolt couldn't read"))
}

/// GitHub's JSON → the normalized types (pure).
pub mod json {
    use crate::time::parse_rfc3339;
    use gitbolt_core::forge::*;
    use serde_json::Value;
    use std::collections::HashSet;

    pub(crate) fn text(v: &Value) -> Option<String> {
        v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
    }

    // --- MR round 2 ---
    /// `viewerSubscription`: SUBSCRIBED is on; UNSUBSCRIBED and IGNORED are off.
    pub fn subscribed(v: &Value) -> Option<bool> {
        match v.as_str()? {
            "SUBSCRIBED" => Some(true),
            "UNSUBSCRIBED" | "IGNORED" => Some(false),
            _ => None,
        }
    }

    /// A review's POST body: the event, and the message unless empty (an approval needs none).
    pub fn review_body(review: &ReviewSubmit) -> Value {
        let mut b = serde_json::json!({ "event": event_word(review.event) });
        if !review.body.trim().is_empty() {
            b["body"] = review.body.clone().into();
        }
        b
    }

    pub fn event_word(e: ReviewEvent) -> &'static str {
        match e {
            ReviewEvent::Comment => "COMMENT",
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
        }
    }
    // --- end MR round 2 ---

    pub fn user(v: &Value) -> Option<ForgeUser> {
        let login = v["login"].as_str()?.to_string();
        Some(ForgeUser { id: v["id"].as_u64()?, name: text(&v["name"]).unwrap_or_else(|| login.clone()), avatar_url: text(&v["avatar_url"]), web_url: v["html_url"].as_str().unwrap_or_default().to_string(), email: text(&v["email"]), username: login })
    }

    pub fn project(host: &str, v: &Value) -> Option<ForgeProject> {
        let path = v["full_name"].as_str()?.to_string();
        Some(ForgeProject {
            kind: ForgeKind::GitHub,
            id: v["id"].as_u64()?,
            host: host.to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
            owner: v["owner"]["login"].as_str().unwrap_or_default().to_string(),
            web_url: v["html_url"].as_str().unwrap_or_default().to_string(),
            default_branch: text(&v["default_branch"]),
            clone_https: v["clone_url"].as_str().unwrap_or_default().to_string(),
            clone_ssh: v["ssh_url"].as_str().unwrap_or_default().to_string(),
            fork_of: text(&v["parent"]["full_name"]),
            updated_at: v["pushed_at"].as_str().or(v["updated_at"].as_str()).and_then(parse_rfc3339),
            archived: v["archived"].as_bool().unwrap_or(false),
            owner_avatar_url: text(&v["owner"]["avatar_url"]),
            path,
        })
    }

    /// The allowed merge methods; a field the token can't see takes GitHub's default (allowed).
    pub fn settings(v: &Value) -> ForgeProjectSettings {
        let allow = |k: &str| v[k].as_bool().unwrap_or(true);
        let mut merge_methods = Vec::new();
        if allow("allow_merge_commit") {
            merge_methods.push(MergeMethod::Merge);
        }
        if allow("allow_squash_merge") {
            merge_methods.push(MergeMethod::Squash);
        }
        if allow("allow_rebase_merge") {
            merge_methods.push(MergeMethod::Rebase);
        }
        let squash = if !allow("allow_squash_merge") {
            SquashOption::Never
        } else if merge_methods == [MergeMethod::Squash] {
            SquashOption::Always
        } else {
            SquashOption::DefaultOff
        };
        ForgeProjectSettings { merge_methods, squash, delete_source_branch: v["delete_branch_on_merge"].as_bool().unwrap_or(false) }
    }

    /// A classic token's `X-OAuth-Scopes`: `repo` (or `public_repo`) writes. A fine-grained token
    /// sends none: its permissions can't be read, so `Unknown` (spec #4 §3.2).
    pub fn token_write(scopes: Option<&str>) -> WriteAccess {
        match scopes {
            None => WriteAccess::Unknown,
            Some(s) if s.split(',').map(str::trim).any(|x| x == "repo" || x == "public_repo") => WriteAccess::Yes,
            Some(_) => WriteAccess::No { missing: "repo".into() },
        }
    }
    // --- 4B T4: pull requests ---
    /// A branch's badge: its open (or draft) PR, else its most recently updated one.
    pub fn pick_for_branch(mrs: Vec<ForgeMr>) -> Option<ForgeMr> {
        match mrs.iter().position(|m| matches!(m.state, MrState::Open | MrState::Draft)) {
            Some(i) => mrs.into_iter().nth(i),
            None => mrs.into_iter().max_by_key(|m| m.updated_at),
        }
    }

    pub fn users(v: &Value) -> Vec<ForgeUser> {
        v.as_array().into_iter().flatten().filter_map(user).collect()
    }

    /// The logins of `ids` among the PR's pending review requests, or the ids that aren't
    /// requested (they reviewed: a submitted review stays, so there's nothing to withdraw).
    pub fn requested_logins(pr: &Value, ids: &[u64]) -> Result<Vec<String>, Vec<u64>> {
        let requested = users(&pr["requested_reviewers"]);
        let login = |id: &u64| requested.iter().find(|u| u.id == *id).map(|u| u.username.clone());
        let missing: Vec<u64> = ids.iter().filter(|id| login(id).is_none()).copied().collect();
        if missing.is_empty() { Ok(ids.iter().filter_map(login).collect()) } else { Err(missing) }
    }

    /// Of `logins`, those an add-assignees answer doesn't have (GitHub drops, silently, whoever
    /// can't be assigned).
    pub fn not_assigned(answer: &Value, logins: &[String]) -> Vec<String> {
        let have: Vec<String> = answer["assignees"].as_array().into_iter().flatten().filter_map(|u| u["login"].as_str().map(str::to_lowercase)).collect();
        logins.iter().filter(|l| !have.contains(&l.to_lowercase())).cloned().collect()
    }

    /// One PR from a list or a GET. A list has no `mergeable` (`conflicts: None`).
    pub fn pr(v: &Value) -> Option<ForgeMr> {
        let draft = v["draft"].as_bool().unwrap_or(false);
        let merged = v["merged"].as_bool().unwrap_or(false) || v["merged_at"].is_string();
        let state = match v["state"].as_str()? {
            "open" if draft => MrState::Draft,
            "open" => MrState::Open,
            _ if merged => MrState::Merged,
            _ => MrState::Closed,
        };
        let requested = users(&v["requested_reviewers"]);
        Some(ForgeMr {
            number: v["number"].as_u64()?,
            title: v["title"].as_str()?.to_string(),
            state,
            author: user(&v["user"])?,
            // A deleted fork's head repository is null.
            source_project: v["head"]["repo"]["full_name"].as_str().unwrap_or_default().to_string(),
            source_branch: v["head"]["ref"].as_str()?.to_string(),
            target_project: v["base"]["repo"]["full_name"].as_str().unwrap_or_default().to_string(),
            target_branch: v["base"]["ref"].as_str()?.to_string(),
            head_sha: text(&v["head"]["sha"]),
            web_url: v["html_url"].as_str().unwrap_or_default().to_string(),
            pipeline: None,
            review: ReviewSummary {
                decision: if requested.is_empty() { ReviewDecision::None } else { ReviewDecision::ReviewRequired },
                approvals: 0,
                approvals_required: None,
                reviews: requested.into_iter().map(|u| ForgeReview { user: u, state: ReviewState::Pending, submitted_at: None }).collect(),
            },
            conflicts: v["mergeable"].as_bool().map(|m| !m),
            labels: labels_of(&v["labels"]).0,
            label_colors: labels_of(&v["labels"]).1,
            updated_at: v["updated_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            stacked: v["body"].as_str().is_some_and(gitbolt_core::forge::stack::carries_stack_table),
            auto_merge: auto_merge(&v["auto_merge"]),
        })
    }

    /// REST's `auto_merge` (null when not set): who enabled it and the method.
    pub fn auto_merge(v: &Value) -> Option<AutoMerge> {
        if !v.is_object() {
            return None;
        }
        let method = match v["merge_method"].as_str() {
            Some("merge") => Some(MergeMethod::Merge),
            Some("squash") => Some(MergeMethod::Squash),
            Some("rebase") => Some(MergeMethod::Rebase),
            _ => None,
        };
        Some(AutoMerge { enabled_by: user(&v["enabled_by"]), method })
    }

    fn rank(s: PipelineStatus) -> u8 {
        match s {
            PipelineStatus::Failed => 6,
            PipelineStatus::Running => 5,
            PipelineStatus::Pending => 4,
            PipelineStatus::Manual => 3,
            PipelineStatus::Canceled => 2,
            PipelineStatus::Success => 1,
            PipelineStatus::Skipped => 0,
        }
    }

    /// GraphQL's `statusCheckRollup.contexts` (check runs and statuses) as one pipeline, the
    /// worst of them, as `checks` reads REST's. `None`: it has neither.
    pub fn rollup(contexts: &Value, web_url: &str) -> Option<ForgePipeline> {
        let mut all: Vec<PipelineStatus> = Vec::new();
        for c in contexts.as_array().into_iter().flatten() {
            all.push(match (c["__typename"].as_str(), c["status"].as_str(), c["conclusion"].as_str(), c["state"].as_str()) {
                (Some("StatusContext"), _, _, Some("SUCCESS")) => PipelineStatus::Success,
                (Some("StatusContext"), _, _, Some("PENDING" | "EXPECTED")) => PipelineStatus::Pending,
                (Some("StatusContext"), _, _, _) => PipelineStatus::Failed,
                (_, Some("IN_PROGRESS"), _, _) => PipelineStatus::Running,
                (_, Some("COMPLETED"), Some("SUCCESS" | "NEUTRAL"), _) => PipelineStatus::Success,
                (_, Some("COMPLETED"), Some("SKIPPED"), _) => PipelineStatus::Skipped,
                (_, Some("COMPLETED"), Some("CANCELLED"), _) => PipelineStatus::Canceled,
                (_, Some("COMPLETED"), Some("ACTION_REQUIRED"), _) => PipelineStatus::Manual,
                (_, Some("COMPLETED"), _, _) => PipelineStatus::Failed,
                _ => PipelineStatus::Pending,
            });
        }
        all.into_iter().max_by_key(|s| rank(*s)).map(|status| ForgePipeline { status, web_url: Some(web_url.to_string()) })
    }

    /// A commit's check runs (`/check-runs`) and statuses (`/status`) as one pipeline: the
    /// worst of them. `None`: it has neither.
    pub fn checks(runs: &Value, statuses: &Value, web_url: &str) -> Option<ForgePipeline> {
        let mut all: Vec<PipelineStatus> = Vec::new();
        for r in runs["check_runs"].as_array().into_iter().flatten() {
            all.push(match (r["status"].as_str(), r["conclusion"].as_str()) {
                (Some("in_progress"), _) => PipelineStatus::Running,
                (Some("completed"), Some("success" | "neutral")) => PipelineStatus::Success,
                (Some("completed"), Some("skipped")) => PipelineStatus::Skipped,
                (Some("completed"), Some("cancelled")) => PipelineStatus::Canceled,
                (Some("completed"), Some("action_required")) => PipelineStatus::Manual,
                (Some("completed"), _) => PipelineStatus::Failed,
                _ => PipelineStatus::Pending,
            });
        }
        for s in statuses["statuses"].as_array().into_iter().flatten() {
            all.push(match s["state"].as_str() {
                Some("success") => PipelineStatus::Success,
                Some("pending") => PipelineStatus::Pending,
                _ => PipelineStatus::Failed,
            });
        }
        all.into_iter().max_by_key(|s| rank(*s)).map(|status| ForgePipeline { status, web_url: Some(web_url.to_string()) })
    }

    /// The latest decisive review per user (a comment doesn't undo an approval; a dismissal
    /// does); requested reviewers are pending.
    pub fn review(reviews: &[Value], requested: &Value) -> ReviewSummary {
        let mut latest: Vec<ForgeReview> = Vec::new();
        for r in reviews {
            let Some(u) = user(&r["user"]) else { continue };
            let at = r["submitted_at"].as_str().and_then(parse_rfc3339);
            let state = match r["state"].as_str() {
                Some("APPROVED") => Some(ReviewState::Approved),
                Some("CHANGES_REQUESTED") => Some(ReviewState::ChangesRequested),
                Some("COMMENTED") => None,
                Some("DISMISSED") => {
                    latest.retain(|x| x.user.id != u.id);
                    continue;
                }
                _ => continue,
            };
            match (latest.iter_mut().find(|x| x.user.id == u.id), state) {
                (Some(x), Some(s)) => {
                    x.state = s;
                    x.submitted_at = at;
                }
                (None, Some(s)) => latest.push(ForgeReview { user: u, state: s, submitted_at: at }),
                (None, None) => latest.push(ForgeReview { user: u, state: ReviewState::Commented, submitted_at: at }),
                (Some(_), None) => {}
            }
        }
        for u in users(requested) {
            match latest.iter_mut().find(|x| x.user.id == u.id) {
                Some(x) => x.state = ReviewState::Pending,
                None => latest.push(ForgeReview { user: u, state: ReviewState::Pending, submitted_at: None }),
            }
        }
        let approvals = latest.iter().filter(|x| x.state == ReviewState::Approved).count() as u32;
        let decision = if latest.iter().any(|x| x.state == ReviewState::ChangesRequested) {
            ReviewDecision::ChangesRequested
        } else if approvals > 0 {
            ReviewDecision::Approved
        } else if latest.iter().any(|x| x.state == ReviewState::Pending) {
            ReviewDecision::ReviewRequired
        } else {
            ReviewDecision::None
        };
        ReviewSummary { decision, approvals, approvals_required: None, reviews: latest }
    }

    /// Why GitHub won't merge it (`mergeable` is computed lazily: `null` while checking).
    pub fn merge_status(v: &Value) -> MergeStatus {
        let blocked = |r: &str| MergeStatus::Blocked { reason: r.to_string() };
        if v["merged"].as_bool() == Some(true) {
            return blocked("It's merged already");
        }
        if v["state"].as_str() == Some("closed") {
            return blocked("It's closed");
        }
        if v["draft"].as_bool() == Some(true) {
            return blocked("Mark it ready first: it's a draft");
        }
        match (v["mergeable"].as_bool(), v["mergeable_state"].as_str()) {
            (None, _) | (_, Some("unknown")) => MergeStatus::Checking,
            (Some(false), _) | (_, Some("dirty")) => blocked("It has conflicts: rebase or merge the base branch first"),
            (_, Some("blocked")) => blocked("Branch protection blocks it: required reviews or checks"),
            (_, Some("behind")) => blocked("The base branch moved ahead: update the branch first"),
            (_, Some("draft")) => blocked("Mark it ready first: it's a draft"),
            _ => MergeStatus::Mergeable,
        }
    }

    /// A conversation or review comment.
    pub fn comment_note(v: &Value) -> Option<ForgeNote> {
        Some(ForgeNote {
            id: v["id"].as_u64()?.to_string(),
            author: user(&v["user"])?,
            body: v["body"].as_str().unwrap_or_default().to_string(),
            created_at: v["created_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            system: false,
            position: None,
            body_html: text(&v["body_html"]),
            reactions: reaction_summary(&v["reactions"]),
            web_url: text(&v["html_url"]),
        })
    }

    // --- comment actions ---
    /// A comment's `reactions` summary (counts only: no "mine", no who), in GitHub's order.
    pub fn reaction_summary(v: &Value) -> Vec<ForgeReaction> {
        GITHUB_REACTIONS.iter().filter_map(|n| v[*n].as_u64().filter(|c| *c > 0).map(|c| ForgeReaction { name: (*n).to_string(), count: c as u32, mine: false, users: Vec::new() })).collect()
    }

    /// One page of `REVIEW_THREADS_QUERY`: each thread's (first comment id, node id, resolved,
    /// by whom), and the next page's cursor. `None`: GitHub didn't answer it.
    #[allow(clippy::type_complexity)]
    pub fn review_threads(answer: &Value) -> Option<(Vec<(u64, String, bool, Option<String>)>, Option<String>)> {
        let threads = &answer["data"]["repository"]["pullRequest"]["reviewThreads"];
        let out = threads["nodes"]
            .as_array()?
            .iter()
            .filter_map(|t| Some((t["comments"]["nodes"][0]["databaseId"].as_u64()?, text(&t["id"])?, t["isResolved"].as_bool() == Some(true), text(&t["resolvedBy"]["login"]))))
            .collect();
        let next = (threads["pageInfo"]["hasNextPage"].as_bool() == Some(true)).then(|| text(&threads["pageInfo"]["endCursor"])).flatten();
        Some((out, next))
    }

    /// A comment's reactions (`/reactions`: `content` and `user`), grouped.
    pub fn reaction_list(list: &[Value], me: Option<u64>) -> Vec<ForgeReaction> {
        group_reactions(list.iter().filter_map(|r| Some((r["content"].as_str()?, r["user"]["id"].as_u64()?, r["user"]["login"].as_str().unwrap_or_default()))), me, true)
    }
    // --- end comment actions ---

    /// A review comment's `diff_hunk` ends at the commented line: its last three lines.
    pub fn hunk_tail(hunk: &str) -> Option<String> {
        let lines: Vec<&str> = hunk.lines().filter(|l| !l.starts_with("@@")).collect();
        (!lines.is_empty()).then(|| lines[lines.len().saturating_sub(3)..].join("\n"))
    }

    fn review_position(v: &Value) -> Option<DiffPosition> {
        let path = text(&v["path"])?;
        let num = |k: &str| v[k].as_u64().map(|n| n as u32);
        // (new, old) by its side: `LEFT` is the old one.
        let sided = |side: &str, n: Option<u32>| if v[side].as_str() == Some("LEFT") { (None, n) } else { (n, None) };
        let (line, old_line) = sided("side", num("line").or(num("original_line")));
        // A multi-line comment's first line (`start_side`: GitHub sends it with `start_line`).
        let start = sided("start_side", num("start_line").or(num("original_start_line")));
        let (start_line, start_old_line) = Some(start).filter(|s| *s != (line, old_line)).unwrap_or_default();
        let hunk = v["diff_hunk"].as_str();
        // The hunk is the original commit's, and ends at the comment's last line: a range's lines
        // are found by the original numbers.
        let range = start_line.or(start_old_line).is_some();
        let snippet = if range { hunk.and_then(|h| crate::gitlab::json::range_snippet(h, sided("side", num("original_line")), sided("start_side", num("original_start_line")))) } else { None };
        Some(DiffPosition {
            path,
            old_path: None,
            line,
            old_line,
            snippet: snippet.or_else(|| hunk.and_then(hunk_tail)),
            start_line,
            start_old_line,
            head_sha: None,
            // GitHub couldn't carry it to the head: `line` is null, its lines are the original's.
            // A comment on the whole file (`subject_type: "file"`) has neither, and isn't outdated.
            outdated: num("line").is_none() && num("original_line").is_some(),
        })
    }

    /// The conversation (`issue-<id>`), review summaries with text (`review-<id>`) and review
    /// threads by their first comment (`thread-<id>`), oldest first.
    pub fn discussions(comments: &[Value], review_comments: &[Value], reviews: &[Value]) -> Vec<ForgeDiscussion> {
        let one = |id: String, n: ForgeNote| ForgeDiscussion { id, notes: vec![n], resolvable: false, resolved: false, resolved_by: None };
        let mut out: Vec<ForgeDiscussion> = comments.iter().filter_map(|c| comment_note(c).map(|n| one(format!("issue-{}", n.id), n))).collect();
        for r in reviews {
            let body = r["body"].as_str().unwrap_or_default();
            if body.trim().is_empty() || r["state"].as_str() == Some("PENDING") {
                continue;
            }
            let (Some(id), Some(author)) = (r["id"].as_u64(), user(&r["user"])) else { continue };
            let created_at = r["submitted_at"].as_str().and_then(parse_rfc3339).unwrap_or(0);
            out.push(one(format!("review-{id}"), ForgeNote { id: format!("review-{id}"), author, body: body.to_string(), created_at, system: false, position: None, body_html: text(&r["body_html"]), reactions: Vec::new(), web_url: text(&r["html_url"]) }));
        }
        // A pending review's comments (the user's own, if GitHub lists them) aren't threads yet.
        let pending: HashSet<u64> = reviews.iter().filter(|r| r["state"].as_str() == Some("PENDING")).filter_map(|r| r["id"].as_u64()).collect();
        let mut threads: Vec<(u64, ForgeDiscussion)> = Vec::new();
        for c in review_comments {
            if c["pull_request_review_id"].as_u64().is_some_and(|r| pending.contains(&r)) {
                continue;
            }
            let (Some(id), Some(mut note)) = (c["id"].as_u64(), comment_note(c)) else { continue };
            let root = c["in_reply_to_id"].as_u64().unwrap_or(id);
            match threads.iter_mut().find(|(r, _)| *r == root) {
                Some((_, d)) => d.notes.push(note),
                None => {
                    note.position = review_position(c);
                    threads.push((root, one(format!("thread-{root}"), note)));
                }
            }
        }
        out.extend(threads.into_iter().map(|(_, d)| d));
        out.sort_by_key(|d| d.notes.first().map_or(0, |n| n.created_at));
        out
    }
    // --- end 4B T4 ---
    // --- 4C T4 ---
    /// A label; GitHub's colour has no `#`.
    pub fn label(v: &Value) -> Option<ForgeLabel> {
        let color = text(&v["color"]).map(|c| if c.starts_with('#') { c } else { format!("#{c}") });
        Some(ForgeLabel { name: v["name"].as_str()?.to_string(), color, description: text(&v["description"]) })
    }

    /// The POST /pulls body. A branch from a fork is `owner:branch` (ruling 3). GitHub takes no
    /// squash or delete-branch at create (those are merge-time).
    pub fn create_body(target: &str, req: &CreateMr) -> Value {
        let owner = req.source.project.split('/').next().unwrap_or("");
        let head = if req.source.project == target || owner.is_empty() { req.source.branch.clone() } else { format!("{owner}:{}", req.source.branch) };
        serde_json::json!({ "title": req.title.trim(), "head": head, "base": req.target_branch, "body": req.description, "draft": req.draft })
    }

    /// The pull request GitHub answered a create with.
    pub fn created_pull(v: &Value) -> Option<ForgeMr> {
        let state = if v["merged"].as_bool() == Some(true) || v["merged_at"].is_string() {
            MrState::Merged
        } else if v["state"] == "closed" {
            MrState::Closed
        } else if v["draft"].as_bool() == Some(true) {
            MrState::Draft
        } else {
            MrState::Open
        };
        Some(ForgeMr {
            number: v["number"].as_u64()?,
            title: v["title"].as_str()?.to_string(),
            state,
            author: user(&v["user"])?,
            source_project: v["head"]["repo"]["full_name"].as_str().unwrap_or_default().to_string(),
            source_branch: v["head"]["ref"].as_str()?.to_string(),
            target_project: v["base"]["repo"]["full_name"].as_str()?.to_string(),
            target_branch: v["base"]["ref"].as_str()?.to_string(),
            head_sha: text(&v["head"]["sha"]),
            web_url: v["html_url"].as_str()?.to_string(),
            pipeline: None,
            review: ReviewSummary { decision: ReviewDecision::None, approvals: 0, approvals_required: None, reviews: Vec::new() },
            conflicts: v["mergeable"].as_bool().map(|m| !m),
            labels: labels_of(&v["labels"]).0,
            label_colors: labels_of(&v["labels"]).1,
            updated_at: v["updated_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            stacked: v["body"].as_str().is_some_and(gitbolt_core::forge::stack::carries_stack_table),
            auto_merge: None,
        })
    }

    /// A `/contents` file's bytes (base64, with GitHub's line breaks).
    pub fn decode_content(v: &Value) -> Vec<u8> {
        try_decode_content(v).unwrap_or_default()
    }

    /// The same, but None when `content` is absent (`encoding: "none"` over 1 MB) or isn't base64.
    pub fn try_decode_content(v: &Value) -> Option<Vec<u8>> {
        use base64::Engine;
        let raw: String = v["content"].as_str()?.chars().filter(|c| !c.is_whitespace()).collect();
        base64::engine::general_purpose::STANDARD.decode(raw).ok()
    }

    /// The people search, done here (ruling 11): a case-insensitive part of the login or name.
    pub fn matches(u: &ForgeUser, query: &str) -> bool {
        let q = query.trim().to_lowercase();
        q.is_empty() || u.username.to_lowercase().contains(&q) || u.name.to_lowercase().contains(&q)
    }
    // --- end 4C T4 ---

    // --- review comments ---
    use gitbolt_core::forge::review::commentable_lines;

    /// A PR's base and head (`start_sha` is the base: GitHub has no other). `base.sha` is the
    /// base branch's tip, not the merge base `/pulls/{n}/files` diffs from; GitHub's comments
    /// name only the head (`commit_id`), so nothing sends the base back.
    pub fn diff_refs(pr: &Value) -> Option<DiffRefs> {
        let base = text(&pr["base"]["sha"])?;
        Some(DiffRefs { start_sha: base.clone(), base_sha: base, head_sha: text(&pr["head"]["sha"])? })
    }

    /// `/pulls/{n}/files`, each with its commentable lines; a changed file without a `patch`
    /// (a large one) takes no comment here.
    pub fn review_files(files: &[Value]) -> Vec<ReviewFile> {
        files
            .iter()
            .filter_map(|f| {
                let path = text(&f["filename"])?;
                let patch = f["patch"].as_str();
                let too_large = patch.is_none() && f["changes"].as_u64().unwrap_or(0) > 0;
                Some(ReviewFile { old_path: text(&f["previous_filename"]).unwrap_or_else(|| path.clone()), lines: patch.map(commentable_lines).unwrap_or_default(), too_large, path })
            })
            .collect()
    }

    /// LEFT for the old side (removed lines), RIGHT for the new one (added and unchanged).
    fn side_word(s: DiffSide) -> &'static str {
        match s {
            DiffSide::Old => "LEFT",
            DiffSide::New => "RIGHT",
        }
    }

    /// REST `POST /pulls/{n}/comments`'s body: on the head the comment was written against.
    pub fn comment_body(c: &NewReviewComment) -> Value {
        let a = &c.anchor;
        let mut b = serde_json::json!({ "body": c.body, "commit_id": c.refs.head_sha, "path": a.path, "line": a.end.number(), "side": side_word(a.end.side()) });
        if let Some(s) = &a.start {
            b["start_line"] = s.number().into();
            b["start_side"] = side_word(s.side()).into();
        }
        b
    }

    /// `ADD_THREAD_MUTATION`'s variables, in the pending review `review` (its node id).
    pub fn thread_variables(c: &NewReviewComment, review: &str) -> Value {
        let a = &c.anchor;
        serde_json::json!({ "review": review, "path": a.path, "body": c.body, "line": a.end.number(), "side": side_word(a.end.side()), "startLine": a.start.map(|s| s.number()), "startSide": a.start.map(|s| side_word(s.side())) })
    }

    /// The user's pending review among `/pulls/{n}/reviews` (GitHub lists only the user's own):
    /// its id and node id.
    pub fn pending_review(reviews: &[Value], me: u64) -> Option<(u64, String)> {
        let r = reviews.iter().find(|r| r["state"].as_str() == Some("PENDING") && r["user"]["id"].as_u64() == Some(me))?;
        Some((r["id"].as_u64()?, text(&r["node_id"])?))
    }

    /// A pending review comment (`/reviews/{id}/comments`), by its node id (GraphQL's edits take it).
    pub fn draft(v: &Value) -> Option<ReviewDraft> {
        Some(ReviewDraft { id: text(&v["node_id"])?, body: v["body"].as_str().unwrap_or_default().to_string(), position: review_position(v), reply_to: v["in_reply_to_id"].as_u64().map(|r| format!("thread-{r}")) })
    }

    /// `addPullRequestReviewThread`'s new thread, as its first comment's draft.
    pub fn thread_draft(t: &Value) -> Option<ReviewDraft> {
        let c = &t["comments"]["nodes"][0];
        let num = |k: &str| t[k].as_u64().map(|n| n as u32);
        let sided = |side: &str, n: Option<u32>| if t[side].as_str() == Some("LEFT") { (None, n) } else { (n, None) };
        let (line, old_line) = sided("diffSide", num("line"));
        let (start_line, start_old_line) = if num("startLine").is_some() { sided("startDiffSide", num("startLine")) } else { (None, None) };
        let position = DiffPosition { path: text(&t["path"])?, old_path: None, line, old_line, snippet: None, start_line, start_old_line, head_sha: None, outdated: t["isOutdated"].as_bool() == Some(true) };
        Some(ReviewDraft { id: text(&c["id"])?, body: c["body"].as_str().unwrap_or_default().to_string(), position: Some(position), reply_to: None })
    }
    // --- end review comments ---
}

impl ForgeProvider for GitHubProvider {
    fn kind(&self) -> ForgeKind {
        ForgeKind::GitHub
    }

    fn host(&self) -> &str {
        &self.host
    }

    fn export_responses(&self, project: &ForgeProject) -> Vec<StoredResponse> {
        // The repository's PR lists and the repository itself.
        let Ok(repo) = Self::repo_url(&project.path) else { return Vec::new() };
        let base = self.http.url(&repo);
        self.http.export(|k| k.starts_with(&format!("{base}/pulls?")) || k == base)
    }

    fn import_responses(&self, entries: Vec<StoredResponse>) {
        self.http.import(entries);
    }

    fn take_request_stats(&self) -> RequestStats {
        self.http.take_stats()
    }

    fn rate_limit(&self) -> RateLimitState {
        self.http.rate_limit()
    }

    fn current_user(&self) -> ForgeFuture<'_, ForgeUser> {
        Box::pin(async move {
            let r = self.http.get("/user").await?;
            let user = json::user(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "user"))?;
            if let (Some(email), Some(url)) = (&user.email, &user.avatar_url) {
                self.learn_avatar(email, url);
            }
            self.names.learn(&user);
            Ok(user)
        })
    }

    fn check_token(&self) -> ForgeFuture<'_, TokenCheck> {
        Box::pin(async move {
            let r = self.http.get("/user").await?;
            let user = json::user(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "user"))?;
            if let (Some(email), Some(url)) = (&user.email, &user.avatar_url) {
                self.learn_avatar(email, url);
            }
            self.names.learn(&user);
            Ok(TokenCheck { user, write: json::token_write(r.oauth_scopes.as_deref()) })
        })
    }

    fn version(&self) -> ForgeFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }

    fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> {
        Box::pin(async move {
            let r = self.http.get(&Self::repo_url(path)?).await?;
            let p = json::project(&self.host, &r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "repository"))?;
            Ok(Self::fresh(p, &r))
        })
    }

    fn project_settings<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> {
        Box::pin(async move {
            let r = self.http.get(&Self::repo_url(&project.path)?).await?;
            Ok(json::settings(&r.json(&self.host)?))
        })
    }

    fn forks<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> {
        Box::pin(async move {
            let path = format!("{}/forks?per_page={FORKS_PER_PAGE}&sort=newest", Self::repo_url(&project.path)?);
            Ok(self.http.get_pages(&path, FORK_PAGES).await?.iter().filter_map(|v| json::project(&self.host, v)).collect())
        })
    }

    // --- forks paging ---
    fn forks_page<'a>(&'a self, project: &'a ForgeProject, page: u32, per_page: u32) -> ForgeFuture<'a, ForkPage> {
        Box::pin(async move {
            let path = format!("{}/forks?sort=newest&per_page={per_page}&page={page}", Self::repo_url(&project.path)?);
            let r = self.http.get(&path).await?;
            let items: Vec<Value> = r.json(&self.host)?;
            Ok(ForkPage { forks: items.iter().filter_map(|v| json::project(&self.host, v)).collect(), next: r.next_page.is_some().then(|| page + 1) })
        })
    }
    // --- end forks paging ---
    /// Only GitHub's avatar host (or Gravatar's), checked by `avatar_fetch_url`, never with the
    /// token: `own_origin` is the API's.
    fn avatar_at<'a>(&'a self, url: &'a str) -> Option<ForgeFuture<'a, Option<AvatarPayload>>> {
        let url = avatar_fetch_url(url, &[&self.avatars_base])?;
        Some(Box::pin(async move { image_at(&self.http, self.cache.as_deref(), &url, &self.api_base).await }))
    }

    // --- 5A T2: Markdown images ---
    /// GitHub's own image hosts (`image_bases`); never the token (it goes only to the API).
    fn image<'a>(&'a self, _project: &'a ForgeProject, url: &'a str) -> Option<ForgeFuture<'a, ForgeImage>> {
        let route = crate::images::github_route(url, &self.image_bases)?;
        Some(Box::pin(async move {
            let allowed = |next: &str| self.image_bases.iter().any(|b| crate::http::under(next, b));
            crate::images::fetch(&self.http, self.cache.as_deref(), &route, &self.api_base, &allowed).await
        }))
    }
    fn video<'a>(&'a self, _project: &'a ForgeProject, url: &'a str) -> Option<ForgeFuture<'a, ForgeImage>> {
        let route = crate::images::github_route(url, &self.image_bases)?;
        Some(Box::pin(async move {
            let allowed = |next: &str| self.image_bases.iter().any(|b| crate::http::under(next, b));
            crate::images::fetch_video(&self.http, &route, &self.api_base, &allowed).await
        }))
    }
    // --- end 5A T2 ---

    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async move {
            let email = email.trim();
            // The avatar host also serves a picture by login (a redirect to its `/u/<id>`).
            let url = match (noreply_id(email), noreply_login(email)) {
                (Some(id), _) => Some(format!("{}/u/{id}?s=80", self.avatars_base)),
                (None, Some(login)) => Some(format!("{}/{login}?s=80", self.avatars_base)),
                (None, None) => self.learned.lock().expect("learned avatars poisoned").get(&email.to_ascii_lowercase()).cloned(),
            };
            let Some(url) = url else { return Ok(None) };
            if let Some(cache) = &self.cache {
                match cache.lookup(email) {
                    Lookup::Found(p) => return Ok(Some(p)),
                    Lookup::Missing => return Ok(None),
                    Lookup::Unknown => {}
                }
            }
            // `own_origin` is the API's: the avatar host is another origin, so no token goes there.
            let found = self.http.get_image(&url, &self.api_base).await?;
            Ok(match (found, &self.cache) {
                (Some((ct, bytes)), Some(cache)) => cache.store_found(email, &ct, &bytes),
                (Some((ct, bytes)), None) => payload_of(&ct, &bytes),
                (None, Some(cache)) => {
                    cache.store_missing(email);
                    None
                }
                (None, None) => None,
            })
        })
    }

    // --- GitHub commit-author avatars ---
    /// `GET /repos/{o}/{r}/commits?author=<email>&per_page=1`: GitHub's `author` filter matches
    /// the commit author's email, and the first commit's `author` is the account GitHub linked it
    /// to. Its `avatar_url` is fetched without the token and kept under the email (disk cache,
    /// `learned`); no linked account is "none" for a day. Each email is asked once a session, one
    /// at a time, and never while under `AUTHOR_LOOKUP_FLOOR` requests are left. Never the search
    /// API. The email is never logged.
    fn avatar_for_email_in<'a>(&'a self, project: &'a ForgeProject, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async move {
            let email = email.trim().to_ascii_lowercase();
            if email.is_empty() || noreply_id(&email).is_some() || noreply_login(&email).is_some() {
                return Ok(None);
            }
            let miss_key = format!("author:{email}");
            if let Some(cache) = &self.cache {
                if let Lookup::Found(p) = cache.lookup(&email) {
                    return Ok(Some(p));
                }
                if let Lookup::Missing = cache.lookup(&miss_key) {
                    return Ok(None);
                }
            }
            let low = |s: &Self| s.http.rate_limit().remaining.is_some_and(|n| n < AUTHOR_LOOKUP_FLOOR);
            if low(self) || self.authors_asked.lock().expect("authors poisoned").contains(&email) {
                return Ok(None);
            }
            let _turn = self.author_turn.lock().await;
            // Checked again in turn: the request before this one may have spent the budget, or asked for this email.
            if low(self) || !self.authors_asked.lock().expect("authors poisoned").insert(email.clone()) {
                return Ok(None);
            }
            let path = format!("{}/commits?author={}&per_page=1", Self::repo_url(&project.path)?, encode_component(&email));
            let items: Vec<Value> = self.http.get(&path).await?.json(&self.host)?;
            let linked = items.first().and_then(|c| c["author"]["avatar_url"].as_str()).and_then(|u| avatar_fetch_url(u, &[&self.avatars_base]).filter(|u| !is_gravatar_url(u)));
            let Some(url) = linked else {
                if let Some(cache) = &self.cache {
                    cache.store_missing(&miss_key);
                }
                return Ok(None);
            };
            self.learn_avatar(&email, &url);
            // `own_origin` is the API's: the avatar host is another origin, so no token goes there.
            let found = self.http.get_image(&url, &self.api_base).await?;
            Ok(match (found, &self.cache) {
                (Some((ct, bytes)), Some(cache)) => cache.store_found(&email, &ct, &bytes),
                (Some((ct, bytes)), None) => payload_of(&ct, &bytes),
                (None, Some(cache)) => {
                    cache.store_missing(&miss_key);
                    None
                }
                (None, None) => None,
            })
        })
    }
    // --- end GitHub commit-author avatars ---

    // --- commit-author avatars by name ---
    /// Only `known_names` (free): GitHub's user search is its own tight budget, and the commits
    /// lookup above already asks GitHub who an email is. The one person seen whose login (or
    /// name) is exactly `name`: their picture from the avatar host, without the token, kept under
    /// `email` (disk cache, `learned`).
    fn avatar_for_name<'a>(&'a self, email: &'a str, name: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async move {
            let email = email.trim().to_ascii_lowercase();
            if email.is_empty() || noreply_id(&email).is_some() || noreply_login(&email).is_some() {
                return Ok(None);
            }
            if let Some(cache) = &self.cache
                && let Lookup::Found(p) = cache.lookup(&email)
            {
                return Ok(Some(p));
            }
            let NameMatch::One(Some(url)) = self.names.find(name) else { return Ok(None) };
            let Some(url) = avatar_fetch_url(&url, &[&self.avatars_base]).filter(|u| !is_gravatar_url(u)) else { return Ok(None) };
            self.learn_avatar(&email, &url);
            // `own_origin` is the API's: the avatar host is another origin, so no token goes there.
            Ok(match (self.http.get_image(&url, &self.api_base).await?, &self.cache) {
                (Some((ct, bytes)), Some(cache)) => cache.store_found(&email, &ct, &bytes),
                (Some((ct, bytes)), None) => payload_of(&ct, &bytes),
                (None, _) => None,
            })
        })
    }
    // --- end commit-author avatars by name ---

    // --- 4B: pull requests ---
    // --- 4B T4: reads ---
    fn open_mrs<'a>(&'a self, project: &'a ForgeProject, filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(self.list_open(project, filter, true))
    }

    fn open_mrs_light<'a>(&'a self, project: &'a ForgeProject, filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(self.list_open(project, filter, false))
    }

    // --- 4D T4 ---
    fn open_mrs_targeting<'a>(&'a self, project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let r = self.http.get(&format!("{repo}/pulls?state=open&base={}&per_page=100", encode_component(branch))).await?;
            let list: Vec<Value> = r.json(&self.host)?;
            Ok(Self::fresh(list.iter().filter_map(json::pr).collect(), &r))
        })
    }
    // --- end 4D T4 ---

    fn mr_for_branch<'a>(&'a self, project: &'a ForgeProject, source: &'a SourceRef) -> ForgeFuture<'a, Fresh<Option<ForgeMr>>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let owner = source.project.split('/').next().unwrap_or_default();
            let head = encode_component(&format!("{owner}:{}", source.branch));
            let r = self.http.get(&format!("{repo}/pulls?head={head}&state=all&sort=updated&direction=desc&per_page=10")).await?;
            let list: Vec<Value> = r.json(&self.host)?;
            let mrs: Vec<ForgeMr> = list.iter().filter_map(json::pr).filter(|m| m.source_project == source.project).collect();
            Ok(Self::fresh(json::pick_for_branch(mrs), &r))
        })
    }

    fn mr_detail<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<ForgeMrDetail>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let r = self.http.get_as(&format!("{repo}/pulls/{number}"), GITHUB_FULL).await?;
            let v: Value = r.json(&self.host)?;
            let (reviews, reviews_same) = self.pages_fresh(&format!("{repo}/pulls/{number}/reviews?per_page=100"), COMMENT_PAGES).await?;
            let mut mr = json::pr(&v).ok_or_else(|| unreadable(&self.host, "pull request"))?;
            let mut checks_same = true;
            if let Some(sha) = mr.head_sha.clone() {
                (mr.pipeline, checks_same) = self.checks_soft(project, &sha).await?;
            }
            mr.review = json::review(&reviews, &v["requested_reviewers"]);
            let reviewers = mr.review.reviews.iter().map(|x| x.user.clone()).collect();
            let detail = ForgeMrDetail {
                description: v["body"].as_str().unwrap_or_default().to_string(),
                reviewers,
                assignees: json::users(&v["assignees"]),
                merge_status: json::merge_status(&v),
                squash: None,
                delete_source_branch: None,
                base_sha: json::text(&v["base"]["sha"]),
                subscribed: self.subscription(project, number, v["updated_at"].as_str().unwrap_or_default()).await,
                mr,
                body_html: json::text(&v["body_html"]),
            };
            self.names.learn_detail(&detail);
            // Not modified only when the PR, its reviews and its checks all were (a 304 each).
            let mut fresh = Self::fresh(detail, &r);
            fresh.not_modified &= reviews_same && checks_same;
            Ok(fresh)
        })
    }

    fn discussions<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<Vec<ForgeDiscussion>>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let comments = self.http.get_pages_as(&format!("{repo}/issues/{number}/comments?per_page=100"), COMMENT_PAGES, GITHUB_FULL).await?;
            let review_comments = self.http.get_pages_as(&format!("{repo}/pulls/{number}/comments?per_page=100"), COMMENT_PAGES, GITHUB_FULL).await?;
            let reviews = self.http.get_pages_as(&format!("{repo}/pulls/{number}/reviews?per_page=100"), COMMENT_PAGES, GITHUB_FULL).await?;
            let mut ds = json::discussions(&comments, &review_comments, &reviews);
            self.fill_reactions(&repo, &mut ds).await;
            self.fill_threads(project, number, &mut ds).await;
            self.names.learn_discussions(&ds);
            Ok(Fresh::new(ds, unix_now()))
        })
    }
    // --- end 4B T4 ---
    // --- 4B T5: writes ---
    /// A review thread (`thread-<root>`) gets a reply in it; anything else goes to the conversation.
    fn reply<'a>(&'a self, project: &'a ForgeProject, number: u64, note: &'a NewNote) -> ForgeFuture<'a, ForgeNote> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let path = match note.discussion.as_deref().and_then(|d| d.strip_prefix("thread-")) {
                Some(root) => format!("{repo}/pulls/{number}/comments/{}/replies", encode_component(root)),
                None => format!("{repo}/issues/{number}/comments"),
            };
            let r = self.http.send_json(Method::Post, &path, &json!({ "body": note.body })).await?;
            json::comment_note(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "comment"))
        })
    }

    // --- comment actions ---
    /// The comment's reactions, read first (removing one takes its id); then the one asked for
    /// added or removed, unless it's so already.
    fn react<'a>(&'a self, project: &'a ForgeProject, _number: u64, note: &'a NoteRef, name: &'a str, on: bool) -> ForgeFuture<'a, Vec<ForgeReaction>> {
        Box::pin(async move {
            if !GITHUB_REACTIONS.contains(&name) {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("GitHub has no :{name}: reaction")));
            }
            let url = format!("{}/reactions", comment_url(&Self::repo_url(&project.path)?, note)?);
            let me = self.me().await?;
            let mut list = self.http.get_pages(&format!("{url}?per_page=100"), REACTION_PAGES).await?;
            let mine = list.iter().position(|r| r["content"].as_str() == Some(name) && r["user"]["id"].as_u64() == Some(me.id));
            match (on, mine) {
                (true, None) => {
                    let r = self.http.send_json(Method::Post, &url, &json!({ "content": name })).await?;
                    list.push(r.json(&self.host)?);
                }
                (false, Some(i)) => {
                    let id = list[i]["id"].as_u64().ok_or_else(|| unreadable(&self.host, "reaction"))?;
                    self.http.delete(&format!("{url}/{id}")).await?;
                    list.remove(i);
                }
                _ => {}
            }
            let after = json::reaction_list(&list, Some(me.id));
            self.reaction_lists.lock().expect("reactions poisoned").insert(url, (counts(&after), after.clone()));
            Ok(after)
        })
    }

    fn edit_note<'a>(&'a self, project: &'a ForgeProject, _number: u64, note: &'a NoteRef, body: &'a str) -> ForgeFuture<'a, ForgeNote> {
        Box::pin(async move {
            let r = self.http.send_json(Method::Patch, &comment_url(&Self::repo_url(&project.path)?, note)?, &json!({ "body": body })).await?;
            json::comment_note(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "comment"))
        })
    }

    fn delete_note<'a>(&'a self, project: &'a ForgeProject, _number: u64, note: &'a NoteRef) -> ForgeFuture<'a, ()> {
        Box::pin(async move {
            self.http.delete(&comment_url(&Self::repo_url(&project.path)?, note)?).await?;
            Ok(())
        })
    }

    /// A review thread (`thread-<first comment id>`) by its node id, from the last read (or read now).
    fn resolve<'a>(&'a self, project: &'a ForgeProject, number: u64, discussion: &'a str, resolved: bool) -> ForgeFuture<'a, ThreadState> {
        Box::pin(async move {
            let root = discussion.strip_prefix("thread-").and_then(|r| r.parse::<u64>().ok()).ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Only a review thread can be resolved"))?;
            let key = (project.path.clone(), number);
            let known = |s: &Self| s.thread_ids.lock().expect("thread ids poisoned").get(&key).and_then(|m| m.get(&root)).cloned();
            let id = match known(self) {
                Some(id) => id,
                None => {
                    self.review_threads(project, number).await;
                    known(self).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("GitHub has no such review thread on #{number}")))?
                }
            };
            let (query, field) = if resolved { (RESOLVE_THREAD_MUTATION, "resolveReviewThread") } else { (UNRESOLVE_THREAD_MUTATION, "unresolveReviewThread") };
            let v: Value = self.http.send_json(Method::Post, "/graphql", &json!({ "query": query, "variables": { "id": id } })).await?.json(&self.host)?;
            if let Some(m) = v["errors"][0]["message"].as_str() {
                return Err(GbError::other(format!("GitHub: {m}")));
            }
            let t = &v["data"][field]["thread"];
            let now = t["isResolved"].as_bool().ok_or_else(|| unreadable(&self.host, "review thread"))?;
            Ok(ThreadState { resolved: now, resolved_by: json::text(&t["resolvedBy"]["login"]).filter(|_| now) })
        })
    }
    // --- end comment actions ---

    fn approve<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ()> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            self.http.send_json(Method::Post, &format!("{repo}/pulls/{number}/reviews"), &json!({ "event": "APPROVE" })).await?;
            Ok(())
        })
    }

    fn request_changes<'a>(&'a self, project: &'a ForgeProject, number: u64, body: &'a str) -> ForgeFuture<'a, ()> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            self.http.send_json(Method::Post, &format!("{repo}/pulls/{number}/reviews"), &json!({ "event": "REQUEST_CHANGES", "body": body })).await?;
            Ok(())
        })
    }

    // --- MR round 2 ---
    /// One review: `POST /pulls/{n}/reviews` with the event and its message.
    fn review<'a>(&'a self, project: &'a ForgeProject, number: u64, review: &'a ReviewSubmit) -> ForgeFuture<'a, ReviewOutcome> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            self.http.send_json(Method::Post, &format!("{repo}/pulls/{number}/reviews"), &json::review_body(review)).await?;
            Ok(ReviewOutcome::default())
        })
    }

    fn people_limits<'a>(&'a self, _project: &'a ForgeProject) -> ForgeFuture<'a, PeopleLimits> {
        Box::pin(async { Ok(PeopleLimits::GITHUB) })
    }

    /// GraphQL's `updateSubscription` on the PR's node.
    fn set_subscribed<'a>(&'a self, project: &'a ForgeProject, number: u64, on: bool) -> ForgeFuture<'a, bool> {
        Box::pin(async move {
            let v = self.pull_json(project, number).await?;
            let id = v["node_id"].as_str().ok_or_else(|| unreadable(&self.host, "pull request"))?;
            let state = if on { "SUBSCRIBED" } else { "UNSUBSCRIBED" };
            let query = "mutation($id: ID!, $state: SubscriptionState!) { updateSubscription(input: {subscribableId: $id, state: $state}) { subscribable { viewerSubscription } } }";
            let r = self.http.send_json(Method::Post, "/graphql", &json!({ "query": query, "variables": { "id": id, "state": state } })).await?;
            let a: Value = r.json(&self.host)?;
            if let Some(message) = a["errors"][0]["message"].as_str() {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("GitHub: {message}")));
            }
            let now = json::subscribed(&a["data"]["updateSubscription"]["subscribable"]["viewerSubscription"]).unwrap_or(on);
            let stamp = v["updated_at"].as_str().unwrap_or_default().to_string();
            self.subscriptions.lock().expect("subscriptions poisoned").insert((project.path.clone(), number), (stamp, Some(now)));
            Ok(now)
        })
    }
    // --- end MR round 2 ---

    // --- review comments ---
    fn review_diff<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ReviewDiff> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let refs = json::diff_refs(&self.pull_json(project, number).await?).ok_or_else(|| unreadable(&self.host, "pull request"))?;
            let files = self.http.get_pages(&format!("{repo}/pulls/{number}/files?per_page=100"), REVIEW_FILE_PAGES).await?;
            Ok(ReviewDiff { refs, files: json::review_files(&files) })
        })
    }

    /// The pending review's comments by REST (GraphQL's review comments have no side).
    fn review_drafts<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ReviewDrafts> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let pending = self.pending_review(project, number).await?;
            let drafts = match &pending {
                Some((id, _)) => self.http.get_pages(&format!("{repo}/pulls/{number}/reviews/{id}/comments?per_page=100"), COMMENT_PAGES).await?.iter().filter_map(json::draft).collect(),
                None => Vec::new(),
            };
            let refs = json::diff_refs(&self.pull_json(project, number).await?);
            Ok(ReviewDrafts { refs, drafts, pending_review: pending.map(|(_, node)| node), can_draft: true })
        })
    }

    /// Into the pending review, which a first draft starts on the head it was written against.
    /// A review this call started and whose thread GitHub then refused is taken back: an empty
    /// pending review would stop Comment now.
    fn add_draft<'a>(&'a self, project: &'a ForgeProject, number: u64, comment: &'a NewReviewComment) -> ForgeFuture<'a, ReviewDraft> {
        Box::pin(async move {
            let (review, started) = match self.pending_review(project, number).await? {
                Some((_, node)) => (node, false),
                None => match self.start_review(project, number, &comment.refs.head_sha).await {
                    Ok(node) => (node, true),
                    // Two quick first drafts: the other one started it meanwhile. Into that one.
                    Err(e) if e.message.contains("pending review") => match self.pending_review(project, number).await? {
                        Some((_, node)) => (node, false),
                        None => return Err(e),
                    },
                    Err(e) => return Err(e),
                },
            };
            let thread = self.graphql_data(&json!({ "query": ADD_THREAD_MUTATION, "variables": json::thread_variables(comment, &review) }), "addPullRequestReviewThread").await.and_then(|v| match json::thread_draft(&v["thread"]) {
                Some(d) => Ok(d),
                None if v["thread"].is_null() => Err(GbError::new(GbErrorKind::InvalidInput, THREAD_REFUSED)),
                None => Err(unreadable(&self.host, "review thread")),
            });
            if thread.is_err() && started {
                let taken = self.graphql_data(&json!({ "query": DISCARD_REVIEW_MUTATION, "variables": { "review": review } }), "deletePullRequestReview").await;
                if let Err(e) = taken {
                    tracing::warn!("couldn't take back the empty pending review on {}: {}", self.host, e.message);
                }
            }
            thread
        })
    }

    fn edit_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, id: &'a str, body: &'a str) -> ForgeFuture<'a, ReviewDraft> {
        Box::pin(async move {
            let v = self.graphql_data(&json!({ "query": EDIT_DRAFT_MUTATION, "variables": { "id": id, "body": body } }), "updatePullRequestReviewComment").await?;
            let c = &v["pullRequestReviewComment"];
            Ok(ReviewDraft { id: json::text(&c["id"]).unwrap_or_else(|| id.to_string()), body: c["body"].as_str().unwrap_or(body).to_string(), position: None, reply_to: None })
        })
    }

    fn delete_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, id: &'a str) -> ForgeFuture<'a, ()> {
        Box::pin(async move {
            self.graphql_data(&json!({ "query": DELETE_DRAFT_MUTATION, "variables": { "id": id } }), "deletePullRequestReviewComment").await?;
            Ok(())
        })
    }

    /// The pending review with the event and its summary; without one, the composer's review.
    fn submit_review<'a>(&'a self, project: &'a ForgeProject, number: u64, review: &'a ReviewSubmit) -> ForgeFuture<'a, SubmitOutcome> {
        Box::pin(async move {
            let Some((_, node)) = self.pending_review(project, number).await? else {
                self.review(project, number, review).await?;
                return Ok(SubmitOutcome { body_posted: !review.body.trim().is_empty(), event_sent: true, ..SubmitOutcome::default() });
            };
            let body = (!review.body.trim().is_empty()).then(|| review.body.clone());
            self.graphql_data(&json!({ "query": SUBMIT_REVIEW_MUTATION, "variables": { "review": node, "event": json::event_word(review.event), "body": body } }), "submitPullRequestReview").await?;
            Ok(SubmitOutcome { body_posted: body.is_some(), event_sent: true, ..SubmitOutcome::default() })
        })
    }

    fn discard_review<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, u32> {
        Box::pin(async move {
            let Some((id, node)) = self.pending_review(project, number).await? else { return Ok(0) };
            let repo = Self::repo_url(&project.path)?;
            let count = self.http.get_pages(&format!("{repo}/pulls/{number}/reviews/{id}/comments?per_page=100"), COMMENT_PAGES).await?.len() as u32;
            self.graphql_data(&json!({ "query": DISCARD_REVIEW_MUTATION, "variables": { "review": node } }), "deletePullRequestReview").await?;
            Ok(count)
        })
    }

    fn comment_now<'a>(&'a self, project: &'a ForgeProject, number: u64, comment: &'a NewReviewComment) -> ForgeFuture<'a, ForgeDiscussion> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let r = self.http.send_json(Method::Post, &format!("{repo}/pulls/{number}/comments"), &json::comment_body(comment)).await.map_err(single_comment_refused)?;
            let v: Value = r.json(&self.host)?;
            json::discussions(&[], std::slice::from_ref(&v), &[]).into_iter().next().ok_or_else(|| unreadable(&self.host, "review comment"))
        })
    }
    // --- end review comments ---

    /// The method is chosen among the repository's; deleting the branch is the repository's own
    /// setting (ruling 8), so `delete_source_branch` and `squash` are ignored.
    fn merge<'a>(&'a self, project: &'a ForgeProject, number: u64, opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let body = merge_body(opts)?;
            let repo = Self::repo_url(&project.path)?;
            self.http.send_json(Method::Put, &format!("{repo}/pulls/{number}/merge"), &Value::Object(body)).await.map_err(|e| merge_refused(number, e))?;
            self.pull(project, number).await
        })
    }

    // --- auto-merge ---
    /// GraphQL's `enablePullRequestAutoMerge` (REST has none), with the method and message;
    /// `squash` and `delete_source_branch` are the method's and the repository's, as for a merge.
    fn set_auto_merge<'a>(&'a self, project: &'a ForgeProject, number: u64, opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let v = self.pull_json(project, number).await?;
            let id = v["node_id"].as_str().ok_or_else(|| unreadable(&self.host, "pull request"))?;
            self.mutate(&enable_auto_merge(id, opts)?, |m| auto_merge_error(number, m)).await?;
            self.pull(project, number).await
        })
    }

    fn cancel_auto_merge<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let v = self.pull_json(project, number).await?;
            let id = v["node_id"].as_str().ok_or_else(|| unreadable(&self.host, "pull request"))?;
            let query = "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } } }";
            self.mutate(&json!({ "query": query, "variables": { "id": id } }), |m| GbError::new(GbErrorKind::InvalidInput, format!("GitHub: {m}"))).await?;
            self.pull(project, number).await
        })
    }
    // --- end auto-merge ---

    fn edit<'a>(&'a self, project: &'a ForgeProject, number: u64, edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            if let Some(change) = edit.reviewers.as_ref().filter(|c| !c.is_empty()) {
                self.change_reviewers(project, number, change).await?;
            }
            if let Some(change) = edit.assignees.as_ref().filter(|c| !c.is_empty()) {
                self.change_assignees(project, number, change).await?;
            }
            if let Some(labels) = &edit.labels {
                self.http.send_json(Method::Put, &format!("{repo}/issues/{number}/labels"), &json!({ "labels": labels })).await?;
            }
            let mut body = serde_json::Map::new();
            if let Some(t) = &edit.title {
                body.insert("title".into(), t.trim().into());
            }
            if let Some(d) = &edit.description {
                body.insert("body".into(), d.clone().into());
            }
            if !body.is_empty() {
                self.http.send_json(Method::Patch, &format!("{repo}/pulls/{number}"), &Value::Object(body)).await?;
            }
            self.pull(project, number).await
        })
    }

    /// REST can't change it: GraphQL's two mutations (ruling 7).
    fn set_draft<'a>(&'a self, project: &'a ForgeProject, number: u64, draft: bool) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let v = self.pull_json(project, number).await?;
            let id = v["node_id"].as_str().ok_or_else(|| unreadable(&self.host, "pull request"))?.to_string();
            let mutation = if draft { "convertPullRequestToDraft" } else { "markPullRequestReadyForReview" };
            let query = format!("mutation($id: ID!) {{ {mutation}(input: {{pullRequestId: $id}}) {{ pullRequest {{ isDraft }} }} }}");
            let r = self.http.send_json(Method::Post, "/graphql", &json!({ "query": query, "variables": { "id": id } })).await?;
            if let Some(message) = r.json::<Value>(&self.host)?["errors"][0]["message"].as_str() {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("GitHub: {message}")));
            }
            self.pull(project, number).await
        })
    }
    // --- end 4B T5 ---
    // --- end 4B ---
    // --- 4C ---
    // --- 4C T4: create (POST /pulls, then the follow-up calls), people, labels, templates ---
    fn create_mr<'a>(&'a self, project: &'a ForgeProject, req: &'a CreateMr) -> ForgeFuture<'a, CreateOutcome> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let r = self.http.send_json(Method::Post, &format!("{repo}/pulls"), &json::create_body(&project.path, req)).await?;
            let mut mr = json::created_pull(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "pull request"))?;
            let failed = self.follow_up(project, mr.number, req, &[CreatePart::Reviewers, CreatePart::Assignees, CreatePart::Labels]).await;
            if !failed.iter().any(|f| f.part == CreatePart::Labels) {
                mr.labels = req.labels.clone();
            }
            Ok(CreateOutcome { mr, failed })
        })
    }

    fn complete_create<'a>(&'a self, project: &'a ForgeProject, number: u64, req: &'a CreateMr, parts: &'a [CreatePart]) -> ForgeFuture<'a, Vec<PartFailure>> {
        Box::pin(async move { Ok(self.follow_up(project, number, req, parts).await) })
    }

    fn search_users<'a>(&'a self, project: &'a ForgeProject, query: &'a str) -> ForgeFuture<'a, Vec<ForgeUser>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let all = self.http.get_pages(&format!("{repo}/assignees?per_page=100"), PEOPLE_PAGES).await?;
            let users: Vec<ForgeUser> = all.iter().filter_map(json::user).filter(|u| json::matches(u, query)).take(PEOPLE_SHOWN).collect();
            self.names.learn_all(&users);
            Ok(users)
        })
    }

    fn labels<'a>(&'a self, project: &'a ForgeProject, query: &'a str) -> ForgeFuture<'a, Vec<ForgeLabel>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let q = query.trim().to_lowercase();
            let all = self.http.get_pages(&format!("{repo}/labels?per_page=100"), LABEL_PAGES).await?;
            Ok(all.iter().filter_map(json::label).filter(|l| l.name.to_lowercase().contains(&q)).collect())
        })
    }

    fn mr_templates<'a>(&'a self, project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Vec<MrTemplate>> {
        Box::pin(async move {
            use gitbolt_core::forge::create::{clip_template, is_template_path, sort_templates, template_name, GITHUB_DIR, GITHUB_TEMPLATE_DIR, MAX_TEMPLATES};
            let repo = Self::repo_url(&project.path)?;
            let at = encode_component(branch);
            let top: Vec<Value> = match self.http.get(&format!("{repo}/contents/{GITHUB_DIR}?ref={at}")).await {
                Ok(r) => r.json(&self.host)?,
                // No `.github` on that branch: no templates (a final answer). A 403 is an error, so
                // the hub falls back to the local copy (a private repo the token can't read).
                Err(e) if e.kind == GbErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(e),
            };
            let mut paths: Vec<String> = Vec::new();
            for e in &top {
                let (Some(kind), Some(path)) = (e["type"].as_str(), e["path"].as_str()) else { continue };
                if kind == "file" && is_template_path(ForgeKind::GitHub, path) {
                    paths.push(path.to_string());
                } else if kind == "dir" && e["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(GITHUB_TEMPLATE_DIR)) {
                    let inner: Vec<Value> = match self.http.get(&format!("{repo}/contents/{}?ref={at}", enc_path(path))).await {
                        Ok(r) => r.json(&self.host)?,
                        Err(e) if skippable(&e) => continue,
                        Err(e) => return Err(e),
                    };
                    paths.extend(inner.iter().filter(|x| x["type"] == "file").filter_map(|x| x["path"].as_str()).filter(|p| is_template_path(ForgeKind::GitHub, p)).map(str::to_string));
                }
            }
            paths.truncate(MAX_TEMPLATES);
            let mut out = Vec::with_capacity(paths.len());
            for path in paths {
                let v: Value = match self.http.get(&format!("{repo}/contents/{}?ref={at}", enc_path(&path))).await {
                    Ok(r) => r.json(&self.host)?,
                    Err(e) if skippable(&e) => continue,
                    Err(e) => return Err(e),
                };
                let Some(bytes) = json::try_decode_content(&v) else { continue };
                out.push(MrTemplate { name: template_name(&path), body: clip_template(&bytes), path });
            }
            Ok(sort_templates(out))
        })
    }
    // --- end 4C T4 ---
    // --- end 4C ---
    // --- 4D ---
    // --- 4D: stacks ---
    /// Points the PR at `target_branch` (spec #4 §4 "4D"): `PATCH …/pulls/:n` with `base`.
    fn retarget<'a>(&'a self, project: &'a ForgeProject, number: u64, target_branch: &'a str) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let path = format!("{}/pulls/{number}", Self::repo_url(&project.path)?);
            let r = self.http.send_json(Method::Patch, &path, &serde_json::json!({ "base": target_branch })).await?;
            json::pr(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "pull request"))
        })
    }
    // --- end 4D ---
}

// --- 4B T4: pull requests (reads) ---
pub const PR_PER_PAGE: u32 = 100;
/// The badges' open list reads at most this many pages.
pub const OPEN_PAGES: usize = 5;
/// Without GraphQL, the open PRs whose checks are read per list (two requests each).
pub const PIPELINE_LOOKUPS: usize = 20;
/// The open PRs' head checks (`refresh_checks`): one query for up to 100 PRs.
pub const ROLLUP_QUERY: &str = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } } } } } }";
pub const COMMENT_PAGES: usize = 5;
// --- comment actions ---
/// Comments whose reactions (who, and whether the user's among them) one discussions read asks
/// for, at most; the others keep their counts until a later read.
pub const REACTION_LOOKUPS: usize = 20;
pub const REACTION_PAGES: usize = 3;
/// A PR's review threads: their node ids (to resolve), whether and by whom they're resolved, and
/// their first comment's id (the `thread-<id>` discussions are named after it).
pub const REVIEW_THREADS_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved resolvedBy { login } comments(first: 1) { nodes { databaseId } } } } } } }";
pub const RESOLVE_THREAD_MUTATION: &str = "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved resolvedBy { login } } } }";
pub const UNRESOLVE_THREAD_MUTATION: &str = "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { isResolved resolvedBy { login } } } }";
pub const THREAD_PAGES: usize = 3;

// --- review comments ---
/// A review's diff reads at most this many pages of 100 files (GitHub lists 3000 at most).
pub const REVIEW_FILE_PAGES: usize = 30;
pub const ADD_REVIEW_MUTATION: &str = "mutation($pr: ID!, $commit: GitObjectID) { addPullRequestReview(input: {pullRequestId: $pr, commitOID: $commit}) { pullRequestReview { id } } }";
pub const ADD_THREAD_MUTATION: &str = "mutation($review: ID!, $path: String!, $body: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide) { addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide}) { thread { id path line startLine diffSide startDiffSide isOutdated comments(first: 1) { nodes { id body } } } } }";
pub const EDIT_DRAFT_MUTATION: &str = "mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) { pullRequestReviewComment { id body } } }";
pub const DELETE_DRAFT_MUTATION: &str = "mutation($id: ID!) { deletePullRequestReviewComment(input: {id: $id}) { clientMutationId } }";
pub const SUBMIT_REVIEW_MUTATION: &str = "mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, body: $body}) { pullRequestReview { id state } } }";
pub const DISCARD_REVIEW_MUTATION: &str = "mutation($review: ID!) { deletePullRequestReview(input: {pullRequestReviewId: $review}) { clientMutationId } }";
/// GitHub answered a new thread with none (`thread: null`) and no reason.
pub const THREAD_REFUSED: &str = "GitHub won't take a comment on that line";
pub const SINGLE_WHILE_PENDING: &str = "GitHub won't post a single comment while your review is pending: add it to the review, or submit the review first";

/// GitHub refuses a single comment while the user's review is pending: said plainly.
pub(crate) fn single_comment_refused(e: GbError) -> GbError {
    if e.kind == GbErrorKind::InvalidInput && e.message.contains("pending review") {
        return GbError::new(GbErrorKind::InvalidInput, SINGLE_WHILE_PENDING);
    }
    e
}
// --- end review comments ---

/// A conversation comment's (`issue-…`) or review comment's (`thread-…`) URL; a review's summary
/// (`review-…`) is neither.
pub fn comment_url(repo: &str, note: &NoteRef) -> Result<String, GbError> {
    let kind = if note.discussion.starts_with("issue-") {
        "issues"
    } else if note.discussion.starts_with("thread-") {
        "pulls"
    } else {
        return Err(GbError::new(GbErrorKind::InvalidInput, "A review's summary can't be changed here: open it on GitHub"));
    };
    if note.note.is_empty() || !note.note.bytes().all(|b| b.is_ascii_digit()) {
        return Err(GbError::new(GbErrorKind::InvalidInput, "GitHub has no such comment"));
    }
    Ok(format!("{repo}/{kind}/comments/{}", note.note))
}
// --- end comment actions ---

impl GitHubProvider {
    /// The token's user, asked once.
    async fn me(&self) -> Result<ForgeUser, GbError> {
        let cached = self.me.lock().expect("me poisoned").clone();
        if let Some(u) = cached {
            return Ok(u);
        }
        let u = self.current_user().await?;
        *self.me.lock().expect("me poisoned") = Some(u.clone());
        Ok(u)
    }

    // --- comment actions ---
    /// Who reacted and whether the user did, for the comments with reactions (their summaries
    /// say only how many): kept per comment and asked again only when its counts change, at most
    /// REACTION_LOOKUPS a read. The user is asked once, and only when some comment has any.
    async fn fill_reactions(&self, repo: &str, ds: &mut [ForgeDiscussion]) {
        let mut asked = 0;
        let mut me: Option<Option<u64>> = None;
        for d in ds.iter_mut() {
            for n in d.notes.iter_mut().filter(|n| !n.reactions.is_empty()) {
                let Ok(url) = comment_url(repo, &NoteRef { discussion: d.id.clone(), note: n.id.clone() }).map(|u| format!("{u}/reactions")) else { continue };
                let now = counts(&n.reactions);
                let kept = self.reaction_lists.lock().expect("reactions poisoned").get(&url).filter(|(c, _)| *c == now).map(|(_, l)| l.clone());
                if let Some(l) = kept {
                    n.reactions = l;
                    continue;
                }
                if asked == REACTION_LOOKUPS {
                    continue;
                }
                asked += 1;
                if me.is_none() {
                    me = Some(self.me().await.ok().map(|u| u.id));
                }
                let Ok(list) = self.http.get_pages(&format!("{url}?per_page=100"), REACTION_PAGES).await else { continue };
                let l = json::reaction_list(&list, me.flatten());
                self.reaction_lists.lock().expect("reactions poisoned").insert(url, (counts(&l), l.clone()));
                n.reactions = l;
            }
        }
    }

    /// The PR's review threads, one GraphQL query (a page per 100 threads): each thread's first
    /// comment id → (node id, resolved, by whom). The node ids are kept for Resolve. `None`:
    /// GitHub didn't answer.
    #[allow(clippy::type_complexity)]
    async fn review_threads(&self, project: &ForgeProject, number: u64) -> Option<HashMap<u64, (String, bool, Option<String>)>> {
        let (owner, name) = project.path.split_once('/')?;
        let mut out = HashMap::new();
        let mut after: Option<String> = None;
        for _ in 0..THREAD_PAGES {
            let body = json!({ "query": REVIEW_THREADS_QUERY, "variables": { "owner": owner, "name": name, "number": number, "after": after } });
            let v: Value = self.http.send_json(Method::Post, "/graphql", &body).await.ok()?.json(&self.host).ok()?;
            let (page, next) = json::review_threads(&v)?;
            out.extend(page.into_iter().map(|(root, id, resolved, by)| (root, (id, resolved, by))));
            match next {
                Some(c) => after = Some(c),
                None => break,
            }
        }
        let ids = out.iter().map(|(root, (id, _, _))| (*root, id.clone())).collect();
        self.thread_ids.lock().expect("thread ids poisoned").insert((project.path.clone(), number), ids);
        Some(out)
    }

    /// Marks the review threads resolvable, resolved and by whom (`review_threads`), when the PR has any.
    async fn fill_threads(&self, project: &ForgeProject, number: u64, ds: &mut [ForgeDiscussion]) {
        if !ds.iter().any(|d| d.id.starts_with("thread-")) {
            return;
        }
        let Some(threads) = self.review_threads(project, number).await else { return };
        for d in ds.iter_mut() {
            let Some((_, resolved, by)) = d.id.strip_prefix("thread-").and_then(|r| r.parse::<u64>().ok()).and_then(|r| threads.get(&r)) else { continue };
            d.resolvable = true;
            d.resolved = *resolved;
            d.resolved_by = by.clone().filter(|_| *resolved);
        }
    }
    // --- end comment actions ---

    /// The open PRs for `filter`, newest activity first; `with_checks`: the first PIPELINE_LOOKUPS
    /// with their checks (the list), else none (the badges).
    async fn list_open(&self, project: &ForgeProject, filter: MrFilter, with_checks: bool) -> Result<Fresh<Vec<ForgeMr>>, GbError> {
        let repo = Self::repo_url(&project.path)?;
        let r = self.http.get(&format!("{repo}/pulls?state=open&sort=updated&direction=desc&per_page={PR_PER_PAGE}")).await?;
        let mut list: Vec<Value> = r.json(&self.host)?;
        // The badges (no checks) read every page, so a PR past the first hundred still badges.
        if !with_checks {
            let mut next = r.next_page.clone();
            for _ in 1..OPEN_PAGES {
                let Some(p) = next.take() else { break };
                let more = self.http.get(&p).await?;
                list.extend(more.json::<Vec<Value>>(&self.host)?);
                next = more.next_page.clone();
            }
        }
        let me = match filter {
            MrFilter::All => None,
            _ => Some(self.me().await?.username),
        };
        let keep = |v: &Value| match (filter, me.as_deref()) {
            (MrFilter::Mine, Some(me)) => v["user"]["login"].as_str() == Some(me),
            (MrFilter::ReviewRequested, Some(me)) => v["requested_reviewers"].as_array().is_some_and(|a| a.iter().any(|u| u["login"].as_str() == Some(me))),
            _ => true,
        };
        let mut mrs: Vec<ForgeMr> = list.iter().filter(|v| keep(v)).filter_map(json::pr).collect();
        if with_checks {
            self.refresh_checks(project, &mrs).await;
            for m in &mut mrs {
                m.pipeline = m.head_sha.as_deref().and_then(|sha| self.checks.get(sha));
            }
        }
        self.names.learn_mrs(&mrs);
        Ok(Self::fresh(mrs, &r))
    }

    /// Every page of a list (`HttpClient::get_pages`), and whether each page was a 304.
    async fn pages_fresh(&self, path: &str, max_pages: usize) -> Result<(Vec<Value>, bool), GbError> {
        let (mut out, mut same) = (Vec::new(), true);
        let mut next = Some(path.to_string());
        for _ in 0..max_pages {
            let Some(p) = next.take() else { break };
            let r = self.http.get(&p).await?;
            same &= r.not_modified;
            out.extend(r.json::<Vec<Value>>(&self.host)?);
            next = r.next_page;
        }
        Ok((out, same))
    }

    /// The listed PRs' checks, kept by head (`PipelineCache`): asked only when a head is new,
    /// still running, or kept too long. One GraphQL query answers every open PR's; without it
    /// (an error that isn't a limit), REST's two requests per head, for the first PIPELINE_LOOKUPS.
    /// Best effort: a failure keeps what's kept (only those pipelines wait), never the list.
    async fn refresh_checks(&self, project: &ForgeProject, mrs: &[ForgeMr]) {
        let now = unix_now();
        let shas: Vec<&str> = mrs.iter().filter_map(|m| m.head_sha.as_deref()).collect();
        if shas.is_empty() || !self.checks.needs(shas.iter().copied(), now) {
            return;
        }
        match self.rollups(project).await {
            Ok(found) => {
                for sha in &shas {
                    self.checks.put(sha, found.get(&sha.to_ascii_lowercase()).cloned().flatten(), now);
                }
            }
            Err(e) if matches!(e.kind, GbErrorKind::RateLimited | GbErrorKind::AuthFailed | GbErrorKind::Network) && !is_forbidden(&e) => {
                tracing::debug!("checks from {}: {}", self.host, e.message);
            }
            Err(e) => {
                tracing::debug!("checks from {} by GraphQL: {}; asking REST", self.host, e.message);
                for sha in shas.into_iter().filter(|s| self.checks.needs([*s], now)).take(PIPELINE_LOOKUPS) {
                    match self.checks_soft(project, sha).await {
                        Ok((p, _)) => self.checks.put(sha, p, now),
                        Err(e) if e.kind == GbErrorKind::RateLimited => break,
                        Err(e) => tracing::debug!("checks of {sha}: {}", e.message),
                    }
                }
            }
        }
    }

    /// Every open PR's checks in one GraphQL query: head commit → its pipeline (`None`: none).
    async fn rollups(&self, project: &ForgeProject) -> Result<HashMap<String, Option<ForgePipeline>>, GbError> {
        let (owner, name) = project.path.split_once('/').ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("{} isn't an owner/repository path", project.path)))?;
        let r = self.http.send_json(Method::Post, "/graphql", &json!({ "query": ROLLUP_QUERY, "variables": { "owner": owner, "name": name } })).await?;
        let v: Value = r.json(&self.host)?;
        let Some(nodes) = v["data"]["repository"]["pullRequests"]["nodes"].as_array() else {
            let said = v["errors"][0]["message"].as_str().unwrap_or("no data");
            return Err(GbError::other(format!("{}: {said}", self.host)));
        };
        let mut out = HashMap::new();
        for pr in nodes {
            for c in pr["commits"]["nodes"].as_array().into_iter().flatten() {
                let Some(sha) = c["commit"]["oid"].as_str() else { continue };
                let web = format!("{}/commit/{sha}", project.web_url);
                out.insert(sha.to_ascii_lowercase(), json::rollup(&c["commit"]["statusCheckRollup"]["contexts"]["nodes"], &web));
            }
        }
        Ok(out)
    }

    /// `checks`, but a token that can't read them (a 403 without a rate limit, or a 404) just has
    /// no pipeline; rate limits, a rejected token (401) and network errors still fail.
    async fn checks_soft(&self, project: &ForgeProject, sha: &str) -> Result<(Option<ForgePipeline>, bool), GbError> {
        match self.checks(project, sha).await {
            Err(e) if e.kind == GbErrorKind::NotFound || crate::http::is_forbidden(&e) => Ok((None, false)),
            r => r,
        }
    }

    /// A commit's checks and statuses as one pipeline, and whether both answered 304.
    async fn checks(&self, project: &ForgeProject, sha: &str) -> Result<(Option<ForgePipeline>, bool), GbError> {
        let repo = Self::repo_url(&project.path)?;
        let runs = self.http.get(&format!("{repo}/commits/{sha}/check-runs?per_page=100")).await?;
        let statuses = self.http.get(&format!("{repo}/commits/{sha}/status")).await?;
        let same = runs.not_modified && statuses.not_modified;
        Ok((json::checks(&runs.json(&self.host)?, &statuses.json(&self.host)?, &format!("{}/commit/{sha}", project.web_url)), same))
    }
}
// --- end 4B T4 ---

// --- 4B T5: pull requests (writes) ---
/// GitHub's refusals of a merge, said plainly: the head moved (409), or it can't merge now (405).
pub fn merge_refused(number: u64, e: GbError) -> GbError {
    if e.message.contains("Head branch was modified") {
        return GbError::new(GbErrorKind::InvalidInput, format!("#{number} changed since it was loaded: refresh and try again"));
    }
    if e.message.contains("HTTP 405") {
        return GbError::new(GbErrorKind::InvalidInput, format!("GitHub can't merge #{number} now: refresh to see why"));
    }
    e
}

/// GitHub's name for a merge method; `Err` for the ones it doesn't have.
fn method_word(m: MergeMethod) -> Result<&'static str, GbError> {
    match m {
        MergeMethod::Merge => Ok("merge"),
        MergeMethod::Squash => Ok("squash"),
        MergeMethod::Rebase => Ok("rebase"),
        MergeMethod::SemiLinear => Err(GbError::new(GbErrorKind::InvalidInput, "GitHub can't merge with semi-linear merges")),
        MergeMethod::FastForward => Err(GbError::new(GbErrorKind::InvalidInput, "GitHub can't merge with fast-forward merges")),
    }
}

// --- auto-merge ---
/// The merge PUT's body: the method and the expected head (the message is GitHub's own).
pub fn merge_body(opts: &MergeOptions) -> Result<serde_json::Map<String, Value>, GbError> {
    let mut body = serde_json::Map::new();
    body.insert("merge_method".into(), method_word(opts.method.unwrap_or(MergeMethod::Merge))?.into());
    if let Some(sha) = &opts.expected_sha {
        body.insert("sha".into(), sha.clone().into());
    }
    Ok(body)
}

/// GraphQL's `enablePullRequestAutoMerge` for the PR's node `id` (REST has none).
pub fn enable_auto_merge(id: &str, opts: &MergeOptions) -> Result<Value, GbError> {
    let method = method_word(opts.method.unwrap_or(MergeMethod::Merge))?.to_ascii_uppercase();
    let query = "mutation($id: ID!, $method: PullRequestMergeMethod!, $sha: GitObjectID) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $sha}) { pullRequest { number } } }";
    Ok(json!({ "query": query, "variables": { "id": id, "method": method, "sha": opts.expected_sha } }))
}

/// GitHub's GraphQL refusal of an auto-merge, said plainly.
pub fn auto_merge_error(number: u64, message: &str) -> GbError {
    let plain = if message.contains("Auto merge is not allowed") || message.contains("not allowed for this repository") {
        "Auto-merge isn't enabled for this repository".to_string()
    } else if message.contains("Head branch was modified") {
        format!("#{number} changed since it was loaded: refresh and try again")
    } else if message.contains("clean status") {
        format!("#{number} can merge now: use Merge")
    } else {
        format!("GitHub: {message}")
    };
    GbError::new(GbErrorKind::InvalidInput, plain)
}
// --- end auto-merge ---

impl GitHubProvider {
    // --- auto-merge ---
    /// A GraphQL mutation; its first error, said plainly by `refused`.
    async fn mutate(&self, body: &Value, refused: impl Fn(&str) -> GbError) -> Result<(), GbError> {
        let r = self.http.send_json(Method::Post, "/graphql", body).await?;
        match r.json::<Value>(&self.host)?["errors"][0]["message"].as_str() {
            Some(message) => Err(refused(message)),
            None => Ok(()),
        }
    }
    // --- end auto-merge ---

    // --- MR round 2: notifications ---
    /// The token's user's subscription to PR `number` (GraphQL's `viewerSubscription`), asked
    /// again only once the PR's `stamp` (its `updated_at`) moved. Best effort: `None` if GitHub
    /// didn't say.
    async fn subscription(&self, project: &ForgeProject, number: u64, stamp: &str) -> Option<bool> {
        let key = (project.path.clone(), number);
        if let Some((s, v)) = self.subscriptions.lock().expect("subscriptions poisoned").get(&key)
            && s == stamp
        {
            return *v;
        }
        let (owner, name) = project.path.split_once('/')?;
        let body = json!({ "query": SUBSCRIPTION_QUERY, "variables": { "owner": owner, "name": name, "number": number } });
        let v: Value = self.http.send_json(Method::Post, "/graphql", &body).await.ok()?.json(&self.host).ok()?;
        let on = json::subscribed(&v["data"]["repository"]["pullRequest"]["viewerSubscription"]);
        self.subscriptions.lock().expect("subscriptions poisoned").insert(key, (stamp.to_string(), on));
        on
    }
    // --- end MR round 2 ---

    async fn pull_json(&self, project: &ForgeProject, number: u64) -> Result<Value, GbError> {
        self.http.get(&format!("{}/pulls/{number}", Self::repo_url(&project.path)?)).await?.json(&self.host)
    }

    /// The PR as it is now (after a write).
    async fn pull(&self, project: &ForgeProject, number: u64) -> Result<ForgeMr, GbError> {
        json::pr(&self.pull_json(project, number).await?).ok_or_else(|| unreadable(&self.host, "pull request"))
    }
}

// --- review comments ---
impl GitHubProvider {
    /// The user's pending review on PR `number`: its id and node id.
    async fn pending_review(&self, project: &ForgeProject, number: u64) -> Result<Option<(u64, String)>, GbError> {
        let repo = Self::repo_url(&project.path)?;
        let me = self.me().await?;
        let reviews = self.http.get_pages(&format!("{repo}/pulls/{number}/reviews?per_page=100"), COMMENT_PAGES).await?;
        Ok(json::pending_review(&reviews, me.id))
    }

    /// A new pending review on PR `number`, on `head`: its node id.
    async fn start_review(&self, project: &ForgeProject, number: u64, head: &str) -> Result<String, GbError> {
        let pr = self.pull_json(project, number).await?;
        let id = json::text(&pr["node_id"]).ok_or_else(|| unreadable(&self.host, "pull request"))?;
        let v = self.graphql_data(&json!({ "query": ADD_REVIEW_MUTATION, "variables": { "pr": id, "commit": head } }), "addPullRequestReview").await?;
        json::text(&v["pullRequestReview"]["id"]).ok_or_else(|| unreadable(&self.host, "review"))
    }

    /// A GraphQL request's `data.<field>`; its first error, in GitHub's words, as a refusal.
    async fn graphql_data(&self, body: &Value, field: &str) -> Result<Value, GbError> {
        let v: Value = self.http.send_json(Method::Post, "/graphql", body).await?.json(&self.host)?;
        if let Some(m) = v["errors"][0]["message"].as_str() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("GitHub: {m}")));
        }
        Ok(v["data"][field].clone())
    }
}
// --- end review comments ---
// --- end 4B T5 ---

// --- 4C T4: the create's follow-up calls ---
pub const PEOPLE_PAGES: usize = 3;
pub const PEOPLE_SHOWN: usize = 20;
pub const LABEL_PAGES: usize = 3;

impl GitHubProvider {
    /// The requested parts in order: reviewers, assignees, labels (ruling 12). A failed one is
    /// recorded and doesn't stop the next; an empty one is skipped.
    async fn follow_up(&self, project: &ForgeProject, number: u64, req: &CreateMr, parts: &[CreatePart]) -> Vec<PartFailure> {
        let mut failed = Vec::new();
        for part in [CreatePart::Reviewers, CreatePart::Assignees, CreatePart::Labels] {
            if !parts.contains(&part) {
                continue;
            }
            if let Err(e) = self.add_part(project, number, req, part).await {
                failed.push(PartFailure { part, message: part_message(&self.host, &e) });
            }
        }
        failed
    }

    async fn add_part(&self, project: &ForgeProject, number: u64, req: &CreateMr, part: CreatePart) -> Result<(), GbError> {
        let repo = Self::repo_url(&project.path)?;
        let (path, body) = match part {
            CreatePart::Reviewers if !req.reviewers.is_empty() => (format!("{repo}/pulls/{number}/requested_reviewers"), json!({ "reviewers": self.logins(&req.reviewers).await? })),
            CreatePart::Assignees if !req.assignees.is_empty() => (format!("{repo}/issues/{number}/assignees"), json!({ "assignees": self.logins(&req.assignees).await? })),
            CreatePart::Labels if !req.labels.is_empty() => (format!("{repo}/issues/{number}/labels"), json!({ "labels": req.labels })),
            _ => return Ok(()),
        };
        let r = self.http.send_json(Method::Post, &path, &body).await?;
        if part == CreatePart::Assignees {
            let wanted: Vec<String> = body["assignees"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect();
            let missing = json::not_assigned(&r.json(&self.host)?, &wanted);
            if !missing.is_empty() {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("couldn't assign: {}", missing.join(", "))));
            }
        }
        Ok(())
    }

    /// Withdraws review requests, then asks the added people. GitHub can't take back a review
    /// already submitted (removing someone only withdraws a pending request; their review stays
    /// on the PR), so removing a reviewer who reviewed is refused, saying so, before any write.
    async fn change_reviewers(&self, project: &ForgeProject, number: u64, change: &PeopleEdit) -> Result<(), GbError> {
        let path = format!("{}/pulls/{number}/requested_reviewers", Self::repo_url(&project.path)?);
        if !change.remove.is_empty() {
            // The PR as it is now, not as a GET moments ago saw it.
            self.http.expire_fresh();
            let logins = match json::requested_logins(&self.pull_json(project, number).await?, &change.remove) {
                Ok(logins) => logins,
                Err(reviewed) => {
                    let who = self.logins(&reviewed).await?.join(", ");
                    return Err(GbError::new(GbErrorKind::InvalidInput, format!("{who} already reviewed: GitHub keeps a submitted review, so they stay a reviewer")));
                }
            };
            self.http.send_json(Method::Delete, &path, &json!({ "reviewers": logins })).await?;
        }
        if !change.add.is_empty() {
            self.http.send_json(Method::Post, &path, &json!({ "reviewers": self.logins(&change.add).await? })).await?;
        }
        Ok(())
    }

    async fn change_assignees(&self, project: &ForgeProject, number: u64, change: &PeopleEdit) -> Result<(), GbError> {
        let path = format!("{}/issues/{number}/assignees", Self::repo_url(&project.path)?);
        if !change.remove.is_empty() {
            self.http.send_json(Method::Delete, &path, &json!({ "assignees": self.logins(&change.remove).await? })).await?;
        }
        if !change.add.is_empty() {
            let logins = self.logins(&change.add).await?;
            let r = self.http.send_json(Method::Post, &path, &json!({ "assignees": logins })).await?;
            let missing = json::not_assigned(&r.json(&self.host)?, &logins);
            if !missing.is_empty() {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("GitHub didn't assign {}: they can't be assigned in {}", missing.join(", "), project.path)));
            }
        }
        Ok(())
    }

    /// GitHub's reviewers and assignees are logins; `CreateMr` carries ids (ruling 11).
    /// `GET /user/{id}` is ETag-cached: a repeat is a 304.
    async fn logins(&self, ids: &[u64]) -> Result<Vec<String>, GbError> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let r = self.http.get(&format!("/user/{id}")).await.map_err(|e| match e.kind {
                GbErrorKind::NotFound => GbError::new(GbErrorKind::InvalidInput, format!("{} has no user {id}", self.host)),
                _ => e,
            })?;
            out.push(json::user(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "user"))?.username);
        }
        Ok(out)
    }
}

/// A template entry GitHub won't show us is skipped; network, rate-limit and 401 errors still fail.
fn skippable(e: &GbError) -> bool {
    e.kind == GbErrorKind::NotFound || crate::http::is_forbidden(e)
}

/// The reason alone, for the toast: "github.com: Validation Failed: …" → "Validation Failed: …".
fn part_message(host: &str, e: &GbError) -> String {
    e.message.strip_prefix(&format!("{host}: ")).unwrap_or(&e.message).to_string()
}

/// A repository path for `/contents/…`: each segment encoded, the `/` kept.
fn enc_path(path: &str) -> String {
    path.split('/').map(encode_component).collect::<Vec<_>>().join("/")
}
// --- end 4C T4 ---

#[cfg(test)]
mod tests {
    use super::{json, noreply_id, noreply_login};
    use gitbolt_core::forge::*;

    #[test]
    fn normalizes_a_user_and_a_repo_with_its_parent() {
        let u = json::user(&json!({"id": 583231, "login": "octocat", "name": null, "avatar_url": "https://a/u/583231", "html_url": "https://github.com/octocat", "email": null})).unwrap();
        assert_eq!((u.name.as_str(), u.email), ("octocat", None));
        let r = json::project("github.com", &json!({
            "id": 502, "name": "widget", "full_name": "octocat/widget", "owner": {"login": "octocat", "type": "User", "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"}, "html_url": "https://github.com/octocat/widget",
            "default_branch": "main", "clone_url": "https://github.com/octocat/widget.git", "ssh_url": "git@github.com:octocat/widget.git",
            "parent": {"full_name": "octo-org/widget"}, "pushed_at": "2026-10-04T12:00:00Z", "updated_at": "2020-01-01T00:00:00Z", "archived": false
        })).unwrap();
        assert_eq!((r.kind, r.owner.as_str(), r.fork_of.as_deref(), r.updated_at), (ForgeKind::GitHub, "octocat", Some("octo-org/widget"), Some(1_791_115_200)));
        assert_eq!(r.owner_avatar_url.as_deref(), Some("https://avatars.githubusercontent.com/u/583231?v=4"), "a user's");
        let org = json::project("github.com", &json!({"id": 1, "full_name": "octo-org/widget", "owner": {"login": "octo-org", "type": "Organization", "avatar_url": "https://avatars.githubusercontent.com/u/9?v=4"}})).unwrap();
        assert_eq!(org.owner_avatar_url.as_deref(), Some("https://avatars.githubusercontent.com/u/9?v=4"), "an organization's too");
    }

    #[test]
    fn settings_come_from_the_allowed_merge_methods() {
        let only_squash = json!({"allow_merge_commit": false, "allow_squash_merge": true, "allow_rebase_merge": false, "delete_branch_on_merge": true});
        assert_eq!(json::settings(&only_squash), ForgeProjectSettings { merge_methods: vec![MergeMethod::Squash], squash: SquashOption::Always, delete_source_branch: true });
        let no_squash = json!({"allow_merge_commit": true, "allow_squash_merge": false, "allow_rebase_merge": true});
        assert_eq!(json::settings(&no_squash), ForgeProjectSettings { merge_methods: vec![MergeMethod::Merge, MergeMethod::Rebase], squash: SquashOption::Never, delete_source_branch: false });
        assert_eq!(json::settings(&json!({})).squash, SquashOption::DefaultOff, "not shown to this token: GitHub's defaults");
    }

    #[test]
    fn classic_scopes_say_whether_it_writes_and_fine_grained_tokens_cant_say() {
        assert_eq!(json::token_write(Some("repo, read:user")), WriteAccess::Yes);
        assert_eq!(json::token_write(Some("repo, read:org")), WriteAccess::Yes);
        assert_eq!(json::token_write(Some("read:org")), WriteAccess::No { missing: "repo".into() });
        assert_eq!(json::token_write(Some("public_repo")), WriteAccess::Yes);
        assert_eq!(json::token_write(Some("read:user")), WriteAccess::No { missing: "repo".into() });
        assert_eq!(json::token_write(None), WriteAccess::Unknown);
    }

    #[test]
    fn noreply_emails_carry_the_user_id() {
        assert_eq!(noreply_id("583231+octocat@users.noreply.github.com"), Some(583231));
        assert_eq!(noreply_login("oldstyle@users.noreply.github.com"), Some("oldstyle"));
        assert_eq!(noreply_login("Some-User@Users.NoReply.GitHub.com"), Some("Some-User"));
        for not in ["583231+octocat@users.noreply.github.com", "noreply@github.com", "a--b@users.noreply.github.com", "-a@users.noreply.github.com", "a.b@users.noreply.github.com", "@users.noreply.github.com", "oldstyle@example.com"] {
            assert_eq!(noreply_login(not), None, "{not}");
        }
        assert_eq!(noreply_id(" 583231+Octocat@Users.NoReply.GitHub.com "), Some(583231));
        assert_eq!(noreply_id("octocat@users.noreply.github.com"), None, "the old login-only form has no id");
        assert_eq!(noreply_id("ada@example.com"), None);
    }
    // --- 4B T4 ---
    use serde_json::Value;

    fn user_json(id: u64, login: &str) -> Value {
        json!({"id": id, "login": login})
    }

    // --- 5A T2 ---
    #[test]
    fn notes_and_review_bodies_keep_githubs_body_html() {
        let html = "<p><img src=\"https://private-user-images.githubusercontent.com/1/2-u.png?jwt=a\"></p>";
        let c = json!({"id": 41, "user": user_json(2, "monalisa"), "body": "![x](https://github.com/user-attachments/assets/u)", "body_html": html, "created_at": "2026-10-03T07:00:00Z"});
        assert_eq!(json::comment_note(&c).unwrap().body_html.as_deref(), Some(html));
        let r = json!({"id": 31, "user": user_json(3, "hubot"), "state": "COMMENTED", "body": "b", "body_html": "<p>b</p>", "submitted_at": "2026-10-03T08:00:00Z"});
        assert_eq!(json::discussions(&[], &[], &[r])[0].notes[0].body_html.as_deref(), Some("<p>b</p>"));
        assert_eq!(json::comment_note(&json!({"id": 1, "user": user_json(2, "monalisa"), "body": "x"})).unwrap().body_html, None, "the plain media type has none");
    }
    // --- end 5A T2 ---

    #[test]
    fn normalizes_a_pull_request_and_its_states() {
        let v = json!({
            "number": 3, "title": "Dev work", "state": "open", "draft": false, "user": user_json(2, "monalisa"),
            "head": {"ref": "dev", "sha": "abc", "repo": {"full_name": "octo-org/widget"}}, "base": {"ref": "main", "repo": {"full_name": "octo-org/widget"}},
            "html_url": "https://github.com/octo-org/widget/pull/3", "labels": [{"name": "backend"}], "requested_reviewers": [user_json(1, "octocat")], "updated_at": "2026-10-04T12:00:00Z"
        });
        let m = json::pr(&v).unwrap();
        assert_eq!((m.number, m.state, m.source_branch.as_str(), m.labels.clone(), m.conflicts), (3, MrState::Open, "dev", vec!["backend".to_string()], None));
        assert_eq!((m.review.decision, m.review.reviews[0].state), (ReviewDecision::ReviewRequired, ReviewState::Pending));
        let mut draft = v.clone();
        draft["draft"] = true.into();
        assert_eq!(json::pr(&draft).unwrap().state, MrState::Draft);
        let mut merged = v.clone();
        merged["state"] = "closed".into();
        merged["merged_at"] = "2026-10-04T12:00:00Z".into();
        assert_eq!(json::pr(&merged).unwrap().state, MrState::Merged);
        merged["merged_at"] = Value::Null;
        assert_eq!(json::pr(&merged).unwrap().state, MrState::Closed);
        let mut gone_fork = v;
        gone_fork["head"]["repo"] = Value::Null;
        assert_eq!(json::pr(&gone_fork).unwrap().source_project, "", "a deleted fork");
    }

    #[test]
    fn a_pull_request_whose_body_has_gitbolts_stack_table_is_stacked() {
        let v = |body: Value| json!({
            "number": 3, "title": "Dev work", "state": "open", "user": user_json(2, "monalisa"), "body": body,
            "head": {"ref": "dev", "sha": "abc", "repo": {"full_name": "octo-org/widget"}}, "base": {"ref": "main", "repo": {"full_name": "octo-org/widget"}},
        });
        assert!(json::pr(&v("Intro\n\n<!-- gitbolt-stack:start -->\n| table |\n<!-- gitbolt-stack:end -->".into())).unwrap().stacked);
        assert!(!json::pr(&v("Plain text".into())).unwrap().stacked);
        assert!(!json::pr(&v(Value::Null)).unwrap().stacked, "a PR with no body");
        let mut created = v("<!-- gitbolt-stack:start -->\nT\n<!-- gitbolt-stack:end -->".into());
        created["html_url"] = "https://github.com/octo-org/widget/pull/3".into();
        assert!(json::created_pull(&created).unwrap().stacked);
    }

    #[test]
    fn checks_and_statuses_make_one_pipeline_the_worst_of_them() {
        let runs = |list: Value| json!({"check_runs": list});
        let statuses = |list: Value| json!({"statuses": list});
        let p = |r: Value, s: Value| json::checks(&runs(r), &statuses(s), "u").map(|p| p.status);
        assert_eq!(p(json!([{"status": "completed", "conclusion": "success"}]), json!([])), Some(PipelineStatus::Success));
        assert_eq!(p(json!([{"status": "completed", "conclusion": "success"}, {"status": "in_progress"}]), json!([{"state": "pending"}])), Some(PipelineStatus::Running));
        assert_eq!(p(json!([{"status": "in_progress"}]), json!([{"state": "error"}])), Some(PipelineStatus::Failed));
        assert_eq!(p(json!([{"status": "queued"}]), json!([])), Some(PipelineStatus::Pending));
        assert_eq!(p(json!([{"status": "completed", "conclusion": "skipped"}]), json!([])), Some(PipelineStatus::Skipped));
        assert_eq!(p(json!([]), json!([])), None);
    }

    #[test]
    fn the_latest_decisive_review_per_user_decides() {
        let r = |id: u64, login: &str, state: &str| json!({"user": user_json(id, login), "state": state, "submitted_at": "2026-10-04T12:00:00Z"});
        let s = json::review(&[r(3, "hubot", "CHANGES_REQUESTED"), r(3, "hubot", "COMMENTED"), r(3, "hubot", "APPROVED")], &json!([user_json(1, "octocat")]));
        assert_eq!((s.decision, s.approvals), (ReviewDecision::Approved, 1));
        assert_eq!(s.reviews.iter().map(|x| (x.user.username.as_str(), x.state)).collect::<Vec<_>>(), [("hubot", ReviewState::Approved), ("octocat", ReviewState::Pending)]);
        let s = json::review(&[r(3, "hubot", "APPROVED"), r(4, "mona", "CHANGES_REQUESTED")], &json!([]));
        assert_eq!(s.decision, ReviewDecision::ChangesRequested);
        let s = json::review(&[r(3, "hubot", "APPROVED"), r(3, "hubot", "DISMISSED")], &json!([]));
        assert_eq!((s.decision, s.approvals), (ReviewDecision::None, 0));
    }

    #[test]
    fn mergeability_says_why_not() {
        let m = |extra: Value| {
            let mut v = json!({"state": "open", "draft": false, "merged": false});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            json::merge_status(&v)
        };
        assert_eq!(m(json!({"mergeable": true, "mergeable_state": "clean"})), MergeStatus::Mergeable);
        assert_eq!(m(json!({"mergeable": true, "mergeable_state": "unstable"})), MergeStatus::Mergeable, "only optional checks fail");
        assert_eq!(m(json!({"mergeable": null})), MergeStatus::Checking);
        assert_eq!(m(json!({"mergeable": false, "mergeable_state": "dirty"})), MergeStatus::Blocked { reason: "It has conflicts: rebase or merge the base branch first".into() });
        assert_eq!(m(json!({"mergeable": true, "mergeable_state": "blocked"})), MergeStatus::Blocked { reason: "Branch protection blocks it: required reviews or checks".into() });
        assert_eq!(m(json!({"draft": true})), MergeStatus::Blocked { reason: "Mark it ready first: it's a draft".into() });
        assert_eq!(m(json!({"merged": true})), MergeStatus::Blocked { reason: "It's merged already".into() });
    }

    #[test]
    fn a_hunks_tail_is_its_last_three_lines() {
        assert_eq!(json::hunk_tail("@@ -1,3 +1,4 @@\n a\n b\n+c\n+d").as_deref(), Some(" b\n+c\n+d"));
        assert_eq!(json::hunk_tail("@@ -1 +1,2 @@\n Readme\n+Second line").as_deref(), Some(" Readme\n+Second line"));
        assert_eq!(json::hunk_tail("@@ -1 +1 @@"), None);
    }

    #[test]
    fn a_multi_line_review_comment_has_its_range_and_its_lines() {
        let hunk = "@@ -1,6 +1,7 @@\n one\n-two\n+zwei\n+drei\n three\n four\n five";
        let pos = |extra: Value| {
            let mut c = json!({"id": 51, "user": {"id": 2, "login": "hubot"}, "body": "b", "path": "a.txt", "line": 6, "original_line": 6, "side": "RIGHT", "diff_hunk": hunk, "start_line": null, "original_start_line": null, "start_side": null});
            c.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            json::discussions(&[], &[c], &[]).remove(0).notes.remove(0).position.unwrap()
        };
        let p = pos(json!({}));
        assert_eq!((p.line, p.start_line, p.start_old_line, p.snippet.as_deref()), (Some(6), None, None, Some(" three\n four\n five")));
        let p = pos(json!({"start_line": 2, "original_start_line": 2, "start_side": "RIGHT"}));
        assert_eq!((p.line, p.start_line, p.start_old_line), (Some(6), Some(2), None));
        assert_eq!(p.snippet.as_deref(), Some("+zwei\n+drei\n three\n four\n five"));
        // From an old line to a new one; outdated (no `start_line` / `line`): the original ones.
        let p = pos(json!({"line": null, "start_line": null, "original_start_line": 2, "start_side": "LEFT"}));
        assert_eq!((p.line, p.start_line, p.start_old_line), (Some(6), None, Some(2)));
        assert_eq!(p.snippet.as_deref(), Some("-two\n+zwei\n+drei\n three\n four\n five"));
        // Old lines both.
        let p = pos(json!({"line": 4, "original_line": 4, "side": "LEFT", "start_line": 1, "original_start_line": 1, "start_side": "LEFT", "diff_hunk": "@@ -1,4 +1,1 @@\n one\n-two\n-three\n-four"}));
        assert_eq!((p.line, p.old_line, p.start_line, p.start_old_line), (None, Some(4), None, Some(1)));
        assert_eq!(p.snippet.as_deref(), Some(" one\n-two\n-three\n-four"));
    }
    // --- end 4B T4 ---
    // --- 4C T4 ---
    fn create_req(source: &str) -> CreateMr {
        CreateMr {
            source: SourceRef { project: source.into(), branch: "feature".into() }, target_branch: "main".into(), title: " Add the widget ".into(),
            description: "It spins.".into(), draft: true, reviewers: vec![], assignees: vec![], labels: vec![], squash: Some(true), delete_source_branch: Some(true),
        }
    }

    #[test]
    fn the_create_body_heads_a_fork_with_its_owner_and_drops_gitlab_only_fields() {
        assert_eq!(json::create_body("octo-org/widget", &create_req("octo-org/widget")), json!({"title": "Add the widget", "head": "feature", "base": "main", "body": "It spins.", "draft": true}));
        assert_eq!(json::create_body("octo-org/widget", &create_req("octocat/widget"))["head"], "octocat:feature");
    }

    #[test]
    fn a_created_pull_normalizes_from_its_head_and_base() {
        let mut v = json!({
            "number": 1, "title": "Add the widget", "state": "open", "draft": false, "user": {"id": 583231, "login": "octocat"},
            "head": {"ref": "feature", "sha": "abc", "repo": {"full_name": "octocat/widget"}}, "base": {"ref": "main", "repo": {"full_name": "octo-org/widget"}},
            "html_url": "https://github.com/octo-org/widget/pull/1", "labels": [{"name": "bug"}], "mergeable": null, "updated_at": "2026-10-04T12:00:00Z"
        });
        let mr = json::created_pull(&v).unwrap();
        assert_eq!((mr.number, mr.state, mr.source_project.as_str(), mr.target_project.as_str(), mr.conflicts), (1, MrState::Open, "octocat/widget", "octo-org/widget", None));
        assert_eq!((mr.source_branch.as_str(), mr.target_branch.as_str(), mr.labels.clone()), ("feature", "main", vec!["bug".to_string()]));
        v["draft"] = json!(true);
        assert_eq!(json::created_pull(&v).unwrap().state, MrState::Draft);
    }

    #[test]
    fn contents_decode_across_githubs_line_breaks_labels_get_a_hash_and_people_match_loosely() {
        assert_eq!(json::decode_content(&json!({"content": "SGVs\nbG8=\n", "encoding": "base64"})), b"Hello");
        assert_eq!(json::label(&json!({"name": "bug", "color": "d73a4a", "description": null})).unwrap().color.as_deref(), Some("#d73a4a"));
        let u = ForgeUser { id: 2, username: "hubot".into(), name: "Hubot".into(), avatar_url: None, web_url: String::new(), email: None };
        assert!(json::matches(&u, "HUB") && json::matches(&u, " ") && !json::matches(&u, "octo"));
    }
    #[test]
    fn a_file_without_content_does_not_decode() {
        assert!(json::try_decode_content(&json!({"encoding": "none"})).is_none());
        assert!(json::try_decode_content(&json!({"content": "!!!"})).is_none());
        assert_eq!(json::try_decode_content(&json!({"content": "SGk=", "encoding": "base64"})), Some(b"Hi".to_vec()));
    }
    // --- end 4C T4 ---

    #[test]
    fn only_a_pending_review_request_can_be_withdrawn() {
        let pr = json!({"requested_reviewers": [{"id": 1, "login": "octocat"}, {"id": 3, "login": "hubot"}]});
        assert_eq!(json::requested_logins(&pr, &[3]), Ok(vec!["hubot".to_string()]));
        // 2 reviewed (no longer requested): GitHub keeps the review, nothing to withdraw.
        assert_eq!(json::requested_logins(&pr, &[1, 2]), Err(vec![2]));
        assert_eq!(json::requested_logins(&json!({}), &[1]), Err(vec![1]));
    }

    #[test]
    fn the_assignees_github_dropped_are_named() {
        let answer = json!({"assignees": [{"id": 3, "login": "Hubot"}]});
        assert_eq!(json::not_assigned(&answer, &["hubot".into(), "stranger".into()]), ["stranger"]);
        assert!(json::not_assigned(&answer, &["HUBOT".into()]).is_empty(), "logins are case-insensitive");
    }

    // --- auto-merge ---
    #[test]
    fn a_prs_auto_merge_says_who_enabled_it_and_the_method() {
        let pr = |auto: serde_json::Value| json::pr(&json!({"number": 3, "title": "t", "state": "open", "user": {"id": 2, "login": "monalisa"}, "head": {"ref": "dev"}, "base": {"ref": "main"}, "auto_merge": auto})).unwrap().auto_merge;
        let set = pr(json!({"enabled_by": {"id": 3, "login": "hubot"}, "merge_method": "squash", "commit_title": "t", "commit_message": "m"})).unwrap();
        assert_eq!((set.enabled_by.map(|u| u.username), set.method), (Some("hubot".into()), Some(MergeMethod::Squash)));
        assert_eq!(pr(serde_json::Value::Null), None);
    }

    // --- MR round 2 ---
    #[test]
    fn a_review_body_names_the_event_and_carries_a_message_only_when_there_is_one() {
        let r = |event, body: &str| json::review_body(&ReviewSubmit { event, body: body.into() });
        assert_eq!(r(ReviewEvent::Comment, "Note"), json!({"event": "COMMENT", "body": "Note"}));
        assert_eq!(r(ReviewEvent::Approve, " "), json!({"event": "APPROVE"}));
        assert_eq!(r(ReviewEvent::RequestChanges, "Fix it"), json!({"event": "REQUEST_CHANGES", "body": "Fix it"}));
    }

    #[test]
    fn the_viewer_subscription_is_on_only_when_subscribed() {
        assert_eq!(json::subscribed(&json!("SUBSCRIBED")), Some(true));
        assert_eq!(json::subscribed(&json!("IGNORED")), Some(false));
        assert_eq!(json::subscribed(&json!("UNSUBSCRIBED")), Some(false));
        assert_eq!(json::subscribed(&serde_json::Value::Null), None);
    }
    // --- end MR round 2 ---

    #[test]
    fn the_merge_body_leaves_the_message_to_github() {
        let opts = MergeOptions { method: Some(MergeMethod::Squash), expected_sha: Some("abc".into()), ..Default::default() };
        assert_eq!(serde_json::Value::Object(super::merge_body(&opts).unwrap()), json!({"merge_method": "squash", "sha": "abc"}));
    }

    #[test]
    fn the_enable_mutation_carries_the_method_and_head() {
        let opts = MergeOptions { method: Some(MergeMethod::Rebase), expected_sha: Some("abc".into()), ..Default::default() };
        let m = super::enable_auto_merge("PR_3", &opts).unwrap();
        assert!(m["query"].as_str().unwrap().contains("enablePullRequestAutoMerge"));
        assert_eq!(m["variables"], json!({"id": "PR_3", "method": "REBASE", "sha": "abc"}));
        assert!(super::enable_auto_merge("PR_3", &MergeOptions { method: Some(MergeMethod::FastForward), ..Default::default() }).is_err());
    }

    #[test]
    fn auto_merge_refusals_are_said_plainly() {
        assert_eq!(super::auto_merge_error(3, "Pull request Auto merge is not allowed for this repository").message, "Auto-merge isn't enabled for this repository");
        assert_eq!(super::auto_merge_error(3, "Pull request is in clean status").message, "#3 can merge now: use Merge");
        assert_eq!(super::auto_merge_error(3, "Head branch was modified. Review and try the merge again.").message, "#3 changed since it was loaded: refresh and try again");
        assert_eq!(super::auto_merge_error(3, "Something else").message, "GitHub: Something else");
    }
    // --- end auto-merge ---

    // --- comment actions ---
    #[test]
    fn a_comments_summary_counts_its_reactions_and_carries_its_link() {
        let n = json::comment_note(&json!({"id": 41, "user": user_json(2, "monalisa"), "body": "b", "created_at": "2026-10-03T07:00:00Z",
            "html_url": "https://github.com/octo-org/widget/pull/3#issuecomment-41",
            "reactions": {"url": "x", "total_count": 3, "+1": 2, "-1": 0, "laugh": 0, "hooray": 0, "confused": 0, "heart": 1, "rocket": 0, "eyes": 0}})).unwrap();
        assert_eq!(n.web_url.as_deref(), Some("https://github.com/octo-org/widget/pull/3#issuecomment-41"));
        assert_eq!(n.reactions.iter().map(|r| (r.name.as_str(), r.count, r.mine)).collect::<Vec<_>>(), [("+1", 2, false), ("heart", 1, false)]);
        let list = json::reaction_list(&[json!({"id": 1, "content": "heart", "user": {"id": 2, "login": "monalisa"}}), json!({"id": 2, "content": "+1", "user": {"id": 1, "login": "octocat"}})], Some(1));
        assert_eq!(list.iter().map(|r| (r.name.as_str(), r.mine, r.users.clone())).collect::<Vec<_>>(), [("+1", true, vec!["octocat".to_string()]), ("heart", false, vec!["monalisa".to_string()])]);
    }

    #[test]
    fn a_comments_url_comes_from_its_discussion_and_a_reviews_summary_has_none() {
        let at = |d: &str, n: &str| super::comment_url("/repos/o/r", &NoteRef { discussion: d.into(), note: n.into() });
        assert_eq!(at("issue-41", "41").unwrap(), "/repos/o/r/issues/comments/41");
        assert_eq!(at("thread-51", "52").unwrap(), "/repos/o/r/pulls/comments/52");
        assert!(at("review-31", "review-31").is_err());
        assert!(at("issue-41", "41/../x").is_err());
    }

    fn served() -> (crate::test_server::TestServer, super::GitHubProvider, ForgeProject) {
        use crate::test_server::{Canned, TestServer};
        let s = TestServer::start(|_, head| {
            let line = head.lines().next().unwrap_or_default().to_string();
            let c = "/repos/octo-org/widget/issues/comments/41";
            if line.starts_with("get /user ") {
                Canned::json(200, r#"{"id": 1, "login": "octocat"}"#)
            } else if line.starts_with(&format!("get {c}/reactions?per_page=100 ")) {
                Canned::json(200, r#"[{"id": 7, "content": "+1", "user": {"id": 1, "login": "octocat"}}, {"id": 8, "content": "+1", "user": {"id": 2, "login": "monalisa"}}]"#)
            } else if line.starts_with(&format!("post {c}/reactions ")) {
                Canned::json(201, r#"{"id": 9, "content": "rocket", "user": {"id": 1, "login": "octocat"}}"#)
            } else if line.starts_with(&format!("patch {c} ")) {
                Canned::json(200, r#"{"id": 41, "user": {"id": 1, "login": "octocat"}, "body": "Edited", "created_at": "2026-10-03T07:00:00Z"}"#)
            } else if line.starts_with("delete ") {
                Canned { status: 204, headers: vec![], body: vec![] }
            } else {
                Canned::json(404, r#"{"message": "Not Found"}"#)
            }
        });
        let ep = crate::endpoints::HostEndpoints { api: s.base.clone(), web: s.base.clone(), avatars: None };
        let p = super::GitHubProvider::new("github.com", &ep, gitbolt_core::redact::Secret::new("ghp_FAKE-test-token"), None);
        let project = ForgeProject { kind: ForgeKind::GitHub, id: 1, host: "github.com".into(), path: "octo-org/widget".into(), name: "widget".into(), owner: "octo-org".into(), web_url: String::new(), default_branch: None, clone_https: String::new(), clone_ssh: String::new(), fork_of: None, updated_at: None, archived: false, owner_avatar_url: None };
        (s, p, project)
    }

    fn lines(s: &crate::test_server::TestServer) -> Vec<String> {
        s.heads.lock().unwrap().iter().map(|h| h.lines().next().unwrap_or_default().trim_end_matches(" http/1.1").to_string()).collect()
    }

    #[tokio::test]
    async fn reacting_adds_or_removes_only_what_isnt_so_and_only_githubs_eight() {
        let (s, p, project) = served();
        let note = NoteRef { discussion: "issue-41".into(), note: "41".into() };
        let after = p.react(&project, 3, &note, "rocket", true).await.unwrap();
        assert_eq!(after.iter().map(|r| (r.name.as_str(), r.count, r.mine)).collect::<Vec<_>>(), [("+1", 2, true), ("rocket", 1, true)]);
        let after = p.react(&project, 3, &note, "+1", false).await.unwrap();
        assert_eq!(after.iter().map(|r| (r.name.as_str(), r.count, r.mine)).collect::<Vec<_>>(), [("+1", 1, false)]);
        p.react(&project, 3, &note, "+1", true).await.unwrap();
        assert_eq!(p.react(&project, 3, &note, "thumbsup", true).await.unwrap_err().message, "GitHub has no :thumbsup: reaction");
        let c = "/repos/octo-org/widget/issues/comments/41/reactions";
        assert_eq!(lines(&s), [
            "get /user".to_string(),
            format!("get {c}?per_page=100"), format!("post {c}"),
            format!("get {c}?per_page=100"), format!("delete {c}/7"),
            format!("get {c}?per_page=100"),
        ], "already mine: nothing sent");
    }

    #[tokio::test]
    async fn a_comment_is_edited_with_patch_and_deleted_on_its_own_url() {
        let (s, p, project) = served();
        let note = NoteRef { discussion: "issue-41".into(), note: "41".into() };
        assert_eq!(p.edit_note(&project, 3, &note, "Edited").await.unwrap().body, "Edited");
        p.delete_note(&project, 3, &NoteRef { discussion: "thread-51".into(), note: "52".into() }).await.unwrap();
        assert!(p.delete_note(&project, 3, &NoteRef { discussion: "review-31".into(), note: "review-31".into() }).await.is_err());
        assert_eq!(lines(&s), ["patch /repos/octo-org/widget/issues/comments/41", "delete /repos/octo-org/widget/pulls/comments/52"]);
    }

    #[tokio::test]
    async fn review_threads_come_from_one_query_and_resolve_by_their_node_id() {
        use crate::test_server::{Canned, TestServer};
        let s = TestServer::start(|_, head| {
            let line = head.lines().next().unwrap_or_default().to_string();
            if line.contains("/pulls/3/comments") {
                Canned::json(200, r#"[{"id": 51, "user": {"id": 3, "login": "hubot"}, "body": "Why?", "created_at": "2026-10-03T08:01:00Z", "path": "README.md", "line": 2, "side": "RIGHT", "diff_hunk": "@@ -1 +1,2 @@\n+x"}]"#)
            } else if line.starts_with("post /graphql ") {
                Canned::json(200, r#"{"data": {"repository": {"pullRequest": {"reviewThreads": {"pageInfo": {"hasNextPage": false, "endCursor": null}, "nodes": [{"id": "PRRT_51", "isResolved": true, "resolvedBy": {"login": "monalisa"}, "comments": {"nodes": [{"databaseId": 51}]}}]}}}, "unresolveReviewThread": {"thread": {"isResolved": false, "resolvedBy": null}}}}"#)
            } else {
                Canned::json(200, "[]")
            }
        });
        let ep = crate::endpoints::HostEndpoints { api: s.base.clone(), web: s.base.clone(), avatars: None };
        let p = super::GitHubProvider::new("github.com", &ep, gitbolt_core::redact::Secret::new("ghp_FAKE-test-token"), None);
        let (_other, _, project) = served();
        let ds = p.discussions(&project, 3).await.unwrap().value;
        assert_eq!((ds[0].id.as_str(), ds[0].resolvable, ds[0].resolved, ds[0].resolved_by.as_deref()), ("thread-51", true, true, Some("monalisa")));
        assert_eq!(p.resolve(&project, 3, "thread-51", false).await.unwrap(), ThreadState { resolved: false, resolved_by: None });
        let graphql: Vec<String> = s.heads.lock().unwrap().iter().filter(|h| h.starts_with("post /graphql")).cloned().collect();
        assert_eq!(graphql.len(), 2, "the threads once, then the mutation with the node id kept from it");
        assert!(p.resolve(&project, 3, "issue-41", true).await.is_err());
    }

    #[tokio::test]
    async fn who_reacted_is_asked_only_for_comments_whose_counts_changed() {
        use crate::test_server::{Canned, TestServer};
        let counts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(1));
        let c2 = counts.clone();
        let s = TestServer::start(move |_, head| {
            let line = head.lines().next().unwrap_or_default().to_string();
            let n = c2.load(std::sync::atomic::Ordering::SeqCst);
            if line.starts_with("get /user ") {
                Canned::json(200, r#"{"id": 1, "login": "octocat"}"#)
            } else if line.contains("/issues/3/comments") {
                Canned::json(200, &format!(r#"[{{"id": 41, "user": {{"id": 2, "login": "monalisa"}}, "body": "b", "created_at": "2026-10-03T07:00:00Z", "reactions": {{"+1": {n}}}}}, {{"id": 42, "user": {{"id": 2, "login": "monalisa"}}, "body": "c", "created_at": "2026-10-03T07:01:00Z", "reactions": {{"+1": 0}}}}]"#))
            } else if line.contains("/issues/comments/41/reactions") {
                let items: Vec<String> = (0..n).map(|i| format!(r#"{{"id": {i}, "content": "+1", "user": {{"id": {}, "login": "u{i}"}}}}"#, i + 1)).collect();
                Canned::json(200, &format!("[{}]", items.join(",")))
            } else {
                Canned::json(200, "[]")
            }
        });
        let ep = crate::endpoints::HostEndpoints { api: s.base.clone(), web: s.base.clone(), avatars: None };
        let p = super::GitHubProvider::new("github.com", &ep, gitbolt_core::redact::Secret::new("ghp_FAKE-test-token"), None);
        let (_other, _, project) = served();
        let ds = p.discussions(&project, 3).await.unwrap().value;
        assert_eq!((ds[0].notes[0].reactions[0].mine, ds[0].notes[0].reactions[0].users.clone()), (true, vec!["u0".to_string()]));
        assert!(ds[1].notes[0].reactions.is_empty());
        let asked = |s: &TestServer| s.heads.lock().unwrap().iter().filter(|h| h.contains("/reactions")).count();
        assert_eq!(asked(&s), 1);
        p.discussions(&project, 3).await.unwrap();
        assert_eq!(asked(&s), 1, "the same counts: who reacted is kept");
        counts.store(2, std::sync::atomic::Ordering::SeqCst);
        let ds = p.discussions(&project, 3).await.unwrap().value;
        assert_eq!((asked(&s), ds[0].notes[0].reactions[0].count), (2, 2));
        assert_eq!(s.heads.lock().unwrap().iter().filter(|h| h.starts_with("get /user ")).count(), 1, "the user once");
    }
    // --- end comment actions ---

    // --- review comments ---
    fn rl(kind: LineKind, old: u32, new: u32) -> ReviewLine {
        ReviewLine { kind, old_line: old, new_line: new }
    }

    fn review_comment(start: Option<ReviewLine>, end: ReviewLine) -> NewReviewComment {
        let refs = DiffRefs { base_sha: "b".into(), start_sha: "b".into(), head_sha: "h".into() };
        NewReviewComment { anchor: ReviewAnchor { path: "README.md".into(), old_path: "README.md".into(), start, end }, body: "Both?".into(), refs }
    }

    #[test]
    fn a_comment_names_its_lines_sides_left_for_removed_right_for_the_rest() {
        let range = review_comment(Some(rl(LineKind::Context, 1, 1)), rl(LineKind::Added, 2, 2));
        assert_eq!(json::thread_variables(&range, "PRR_9"), json!({"review": "PRR_9", "path": "README.md", "body": "Both?", "line": 2, "side": "RIGHT", "startLine": 1, "startSide": "RIGHT"}));
        let removed = review_comment(None, rl(LineKind::Removed, 3, 2));
        assert_eq!(json::thread_variables(&removed, "PRR_9")["side"], "LEFT");
        assert_eq!(json::comment_body(&removed), json!({"body": "Both?", "commit_id": "h", "path": "README.md", "line": 3, "side": "LEFT"}));
        assert_eq!(json::comment_body(&range)["start_line"], 1);
    }

    #[test]
    fn the_pending_review_and_its_comments_read_from_rest_and_graphql() {
        let me = json!({"id": 1, "login": "octocat"});
        let reviews = [json!({"id": 8, "node_id": "PRR_8", "state": "COMMENTED", "user": me}), json!({"id": 9, "node_id": "PRR_9", "state": "PENDING", "user": me})];
        assert_eq!(json::pending_review(&reviews, 1), Some((9, "PRR_9".to_string())));
        assert_eq!(json::pending_review(&reviews, 2), None);
        let d = json::draft(&json!({"id": 7, "node_id": "PRRC_7", "body": "Why?", "path": "README.md", "line": 2, "side": "RIGHT", "diff_hunk": "@@ -1 +1,2 @@\n Readme\n+Second line", "user": me})).unwrap();
        assert_eq!((d.id.as_str(), d.position.as_ref().unwrap().line, d.position.as_ref().unwrap().outdated), ("PRRC_7", Some(2), false));
        let t = json::thread_draft(&json!({"id": "PRRT_7", "path": "README.md", "line": 3, "startLine": 1, "diffSide": "LEFT", "startDiffSide": "LEFT", "isOutdated": false, "comments": {"nodes": [{"id": "PRRC_7", "body": "Gone?"}]}})).unwrap();
        let pos = t.position.unwrap();
        assert_eq!((t.id.as_str(), pos.line, pos.old_line, pos.start_old_line), ("PRRC_7", None, Some(3), Some(1)));
        let files = json::review_files(&[json!({"filename": "a.md", "patch": "@@ -1 +1,2 @@\n a\n+b", "changes": 1}), json!({"filename": "big.json", "previous_filename": "old.json", "changes": 9000})]);
        assert_eq!((files[0].lines.len(), files[1].too_large, files[1].old_path.as_str()), (2, true, "old.json"));
    }

    #[test]
    fn a_pending_comment_is_no_thread_and_an_outdated_one_says_so() {
        let u = json!({"id": 2, "login": "hubot"});
        let reviews = [json!({"id": 9, "state": "PENDING", "user": u, "body": ""})];
        let comments = [
            json!({"id": 7, "pull_request_review_id": 9, "user": u, "body": "Draft", "created_at": "2026-10-03T08:00:00Z", "path": "README.md", "line": 2, "side": "RIGHT"}),
            json!({"id": 8, "pull_request_review_id": 10, "user": u, "body": "Old", "created_at": "2026-10-03T08:01:00Z", "path": "README.md", "line": null, "original_line": 2, "side": "RIGHT"}),
        ];
        let ds = json::discussions(&[], &comments, &reviews);
        assert_eq!(ds.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["thread-8"]);
        let pos = ds[0].notes[0].position.as_ref().unwrap();
        assert_eq!((pos.line, pos.outdated), (Some(2), true));
        let on_the_file = json!({"id": 9, "user": u, "body": "Whole file", "created_at": "2026-10-03T08:02:00Z", "path": "README.md", "subject_type": "file", "line": null, "original_line": null, "side": "RIGHT"});
        let pos = json::discussions(&[], &[on_the_file], &[]).remove(0).notes.remove(0).position.unwrap();
        assert_eq!((pos.line, pos.old_line, pos.outdated), (None, None, false), "a file's comment has no line to lose");
    }

    #[test]
    fn a_single_comment_refused_for_a_pending_review_is_said_plainly() {
        use gitbolt_core::error::{GbError, GbErrorKind};
        let e = GbError::new(GbErrorKind::InvalidInput, "github.com: Validation Failed: user_id can only have one pending review per pull request");
        assert_eq!(super::single_comment_refused(e).message, super::SINGLE_WHILE_PENDING);
        // As github.com sends it: the reason a plain string in `errors`.
        let e = crate::http::status_error("github.com", 422, br#"{"message":"Unprocessable Entity","errors":["User can only have one pending review per pull request"]}"#);
        assert_eq!(super::single_comment_refused(e).message, super::SINGLE_WHILE_PENDING);
        let other = GbError::new(GbErrorKind::InvalidInput, "github.com: Validation Failed: line must be part of the diff");
        assert!(super::single_comment_refused(other).message.contains("part of the diff"));
    }

    #[tokio::test]
    async fn a_first_draft_starts_the_pending_review_on_the_head_then_adds_its_thread() {
        use crate::test_server::{Canned, TestServer};
        let s = TestServer::start(|_, head| {
            let line = head.lines().next().unwrap_or_default().to_string();
            let pull = "/repos/octo-org/widget/pulls/3";
            if line.starts_with("get /user ") {
                Canned::json(200, r#"{"id": 1, "login": "octocat"}"#)
            } else if line.starts_with(&format!("get {pull}/reviews?per_page=100 ")) {
                Canned::json(200, "[]")
            } else if line.starts_with(&format!("get {pull} ")) {
                Canned::json(200, r#"{"number": 3, "node_id": "PR_3", "head": {"sha": "h"}, "base": {"sha": "b"}}"#)
            } else if line.starts_with("post /graphql ") {
                Canned::json(200, r#"{"data": {"addPullRequestReview": {"pullRequestReview": {"id": "PRR_9"}}, "addPullRequestReviewThread": {"thread": {"id": "PRRT_7", "path": "README.md", "line": 2, "startLine": 1, "diffSide": "RIGHT", "startDiffSide": "RIGHT", "isOutdated": false, "comments": {"nodes": [{"id": "PRRC_7", "body": "Both?"}]}}}}}"#)
            } else {
                Canned::json(404, r#"{"message": "Not Found"}"#)
            }
        });
        let ep = crate::endpoints::HostEndpoints { api: s.base.clone(), web: s.base.clone(), avatars: None };
        let p = super::GitHubProvider::new("github.com", &ep, gitbolt_core::redact::Secret::new("ghp_FAKE-test-token"), None);
        let (_other, _, project) = served();
        let d = p.add_draft(&project, 3, &review_comment(Some(rl(LineKind::Context, 1, 1)), rl(LineKind::Added, 2, 2))).await.unwrap();
        assert_eq!((d.id.as_str(), d.position.unwrap().start_line), ("PRRC_7", Some(1)));
        let bodies: Vec<Value> = s.bodies.lock().unwrap().iter().filter(|b| b.contains("mutation")).map(|b| serde_json::from_str(b).unwrap()).collect();
        assert_eq!((bodies[0]["variables"]["pr"].clone(), bodies[0]["variables"]["commit"].clone()), (json!("PR_3"), json!("h")));
        assert_eq!((bodies[1]["variables"]["review"].clone(), bodies[1]["variables"]["startLine"].clone()), (json!("PRR_9"), json!(1)));
    }

    #[tokio::test]
    async fn a_first_draft_that_lost_the_race_to_start_the_review_goes_into_the_other_ones() {
        use crate::test_server::{Canned, TestServer};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let (reads, posts) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (r2, p2) = (reads.clone(), posts.clone());
        let s = TestServer::start(move |_, head| {
            let line = head.lines().next().unwrap_or_default().to_string();
            let pull = "/repos/octo-org/widget/pulls/3";
            if line.starts_with("get /user ") {
                Canned::json(200, r#"{"id": 1, "login": "octocat"}"#)
            } else if line.starts_with(&format!("get {pull}/reviews?per_page=100 ")) {
                // None pending at first; the other draft's review by the time it's read again.
                if r2.fetch_add(1, Ordering::SeqCst) == 0 { Canned::json(200, "[]") } else { Canned::json(200, r#"[{"id": 5, "node_id": "PRR_5", "state": "PENDING", "user": {"id": 1, "login": "octocat"}}]"#) }
            } else if line.starts_with(&format!("get {pull} ")) {
                Canned::json(200, r#"{"number": 3, "node_id": "PR_3", "head": {"sha": "h"}, "base": {"sha": "b"}}"#)
            } else if line.starts_with("post /graphql ") {
                if p2.fetch_add(1, Ordering::SeqCst) == 0 {
                    Canned::json(200, r#"{"data": {"addPullRequestReview": null}, "errors": [{"message": "User can only have one pending review per pull request"}]}"#)
                } else {
                    Canned::json(200, r#"{"data": {"addPullRequestReviewThread": {"thread": {"id": "PRRT_7", "path": "README.md", "line": 2, "diffSide": "RIGHT", "isOutdated": false, "comments": {"nodes": [{"id": "PRRC_7", "body": "Both?"}]}}}}}"#)
                }
            } else {
                Canned::json(404, r#"{"message": "Not Found"}"#)
            }
        });
        let ep = crate::endpoints::HostEndpoints { api: s.base.clone(), web: s.base.clone(), avatars: None };
        let p = super::GitHubProvider::new("github.com", &ep, gitbolt_core::redact::Secret::new("ghp_FAKE-test-token"), None);
        let (_other, _, project) = served();
        let d = p.add_draft(&project, 3, &review_comment(None, rl(LineKind::Added, 2, 2))).await.unwrap();
        assert_eq!(d.id, "PRRC_7");
        let bodies: Vec<Value> = s.bodies.lock().unwrap().iter().filter(|b| b.contains("mutation")).map(|b| serde_json::from_str(b).unwrap()).collect();
        assert_eq!(bodies.len(), 2, "no second review started, none deleted: {bodies:?}");
        assert_eq!(bodies[1]["variables"]["review"], "PRR_5");
        assert_eq!(reads.load(Ordering::SeqCst), 2, "the pending review read again once");
    }

    #[tokio::test]
    async fn a_review_started_for_a_refused_thread_is_taken_back() {
        use crate::test_server::{Canned, TestServer};
        let s = TestServer::start(|_, head| {
            let line = head.lines().next().unwrap_or_default().to_string();
            let pull = "/repos/octo-org/widget/pulls/3";
            if line.starts_with("get /user ") {
                Canned::json(200, r#"{"id": 1, "login": "octocat"}"#)
            } else if line.starts_with(&format!("get {pull}/reviews?per_page=100 ")) {
                Canned::json(200, "[]")
            } else if line.starts_with(&format!("get {pull} ")) {
                Canned::json(200, r#"{"number": 3, "node_id": "PR_3", "head": {"sha": "h"}, "base": {"sha": "b"}}"#)
            } else if line.starts_with("post /graphql ") {
                // No thread and no reason (GitHub does this for a line it won't take).
                Canned::json(200, r#"{"data": {"addPullRequestReview": {"pullRequestReview": {"id": "PRR_9"}}, "addPullRequestReviewThread": {"thread": null}, "deletePullRequestReview": {"clientMutationId": null}}}"#)
            } else {
                Canned::json(404, r#"{"message": "Not Found"}"#)
            }
        });
        let ep = crate::endpoints::HostEndpoints { api: s.base.clone(), web: s.base.clone(), avatars: None };
        let p = super::GitHubProvider::new("github.com", &ep, gitbolt_core::redact::Secret::new("ghp_FAKE-test-token"), None);
        let (_other, _, project) = served();
        let e = p.add_draft(&project, 3, &review_comment(None, rl(LineKind::Added, 9, 9))).await.unwrap_err();
        assert_eq!(e.message, super::THREAD_REFUSED);
        let bodies: Vec<Value> = s.bodies.lock().unwrap().iter().filter(|b| b.contains("mutation")).map(|b| serde_json::from_str(b).unwrap()).collect();
        assert_eq!(bodies.len(), 3, "{bodies:?}");
        assert!(bodies[2]["query"].as_str().unwrap().contains("deletePullRequestReview(") && bodies[2]["variables"]["review"] == "PRR_9", "{bodies:?}");
    }
    // --- end review comments ---
}
