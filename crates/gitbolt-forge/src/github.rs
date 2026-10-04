//! GitHub REST (spec #4 §3.1): identity, repositories, settings, forks, avatars. GitHub has no
//! avatar-by-email API: an avatar comes from a noreply email's user id, or an email → avatar URL
//! learned from API data (`learn_avatar`). Never a user search by email (30 a minute, public
//! emails only). 4B–4D add the pull request methods, in their marked blocks.

use crate::avatar_cache::{payload_of, DiskAvatarCache, Lookup};
use crate::endpoints::HostEndpoints;
use crate::http::{encode_component, ClientConfig, HttpClient, HttpResponse, Method};
use crate::time::unix_now;
use gitbolt_core::avatar::AvatarPayload;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const GITHUB_HEADERS: [(&str, &str); 2] = [("Accept", "application/vnd.github+json"), ("X-GitHub-Api-Version", "2022-11-28")];
pub const FORKS_PER_PAGE: u32 = 100;
pub const FORK_PAGES: usize = 3;

/// The user id in a `<id>+<login>@users.noreply.github.com` email.
pub fn noreply_id(email: &str) -> Option<u64> {
    let lower = email.trim().to_ascii_lowercase();
    let local = lower.strip_suffix("@users.noreply.github.com")?;
    local.split_once('+')?.0.parse().ok()
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
  }

impl GitHubProvider {
    pub fn new(host: &str, endpoints: &HostEndpoints, token: Secret, cache: Option<Arc<DiskAvatarCache>>) -> Self {
        let http = HttpClient::new(ClientConfig { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), token: Some(token), headers: GITHUB_HEADERS.to_vec(), timeout: Duration::from_secs(20) });
        let avatars_base = endpoints.avatars.clone().unwrap_or_else(|| "https://avatars.githubusercontent.com".into()).trim_end_matches('/').to_string();
        Self { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), avatars_base, http, cache, learned: Mutex::default(), me: Mutex::new(None) }
    }

    pub fn http(&self) -> &HttpClient {
        &self.http
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

    fn text(v: &Value) -> Option<String> {
        v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
    }

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
            labels: v["labels"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str().map(str::to_string)).collect(),
            updated_at: v["updated_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            stacked: v["body"].as_str().is_some_and(gitbolt_core::forge::stack::carries_stack_table),
        })
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
        })
    }

    /// A review comment's `diff_hunk` ends at the commented line: its last three lines.
    pub fn hunk_tail(hunk: &str) -> Option<String> {
        let lines: Vec<&str> = hunk.lines().filter(|l| !l.starts_with("@@")).collect();
        (!lines.is_empty()).then(|| lines[lines.len().saturating_sub(3)..].join("\n"))
    }

    fn review_position(v: &Value) -> Option<DiffPosition> {
        let path = text(&v["path"])?;
        let left = v["side"].as_str() == Some("LEFT");
        let line = v["line"].as_u64().or(v["original_line"].as_u64()).map(|n| n as u32);
        Some(DiffPosition { path, old_path: None, line: if left { None } else { line }, old_line: if left { line } else { None }, snippet: v["diff_hunk"].as_str().and_then(hunk_tail) })
    }

    /// The conversation (`issue-<id>`), review summaries with text (`review-<id>`) and review
    /// threads by their first comment (`thread-<id>`), oldest first.
    pub fn discussions(comments: &[Value], review_comments: &[Value], reviews: &[Value]) -> Vec<ForgeDiscussion> {
        let one = |id: String, n: ForgeNote| ForgeDiscussion { id, notes: vec![n], resolvable: false, resolved: false };
        let mut out: Vec<ForgeDiscussion> = comments.iter().filter_map(|c| comment_note(c).map(|n| one(format!("issue-{}", n.id), n))).collect();
        for r in reviews {
            let body = r["body"].as_str().unwrap_or_default();
            if body.trim().is_empty() || r["state"].as_str() == Some("PENDING") {
                continue;
            }
            let (Some(id), Some(author)) = (r["id"].as_u64(), user(&r["user"])) else { continue };
            let created_at = r["submitted_at"].as_str().and_then(parse_rfc3339).unwrap_or(0);
            out.push(one(format!("review-{id}"), ForgeNote { id: format!("review-{id}"), author, body: body.to_string(), created_at, system: false, position: None }));
        }
        let mut threads: Vec<(u64, ForgeDiscussion)> = Vec::new();
        for c in review_comments {
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
            labels: v["labels"].as_array().map(|a| a.iter().filter_map(|l| l["name"].as_str().map(str::to_string)).collect()).unwrap_or_default(),
            updated_at: v["updated_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            stacked: v["body"].as_str().is_some_and(gitbolt_core::forge::stack::carries_stack_table),
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
}

impl ForgeProvider for GitHubProvider {
    fn kind(&self) -> ForgeKind {
        ForgeKind::GitHub
    }

    fn host(&self) -> &str {
        &self.host
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

    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async move {
            let email = email.trim();
            let url = match noreply_id(email) {
                Some(id) => Some(format!("{}/u/{id}?s=80", self.avatars_base)),
                None => self.learned.lock().expect("learned avatars poisoned").get(&email.to_ascii_lowercase()).cloned(),
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
            let r = self.http.get(&format!("{repo}/pulls/{number}")).await?;
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
                mr,
            };
            // Not modified only when the PR, its reviews and its checks all were (a 304 each).
            let mut fresh = Self::fresh(detail, &r);
            fresh.not_modified &= reviews_same && checks_same;
            Ok(fresh)
        })
    }

    fn discussions<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<Vec<ForgeDiscussion>>> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
            let comments = self.http.get_pages(&format!("{repo}/issues/{number}/comments?per_page=100"), COMMENT_PAGES).await?;
            let review_comments = self.http.get_pages(&format!("{repo}/pulls/{number}/comments?per_page=100"), COMMENT_PAGES).await?;
            let reviews = self.http.get_pages(&format!("{repo}/pulls/{number}/reviews?per_page=100"), COMMENT_PAGES).await?;
            Ok(Fresh::new(json::discussions(&comments, &review_comments, &reviews), unix_now()))
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

    /// The method is chosen among the repository's; deleting the branch is the repository's own
    /// setting (ruling 8), so `delete_source_branch` and `squash` are ignored.
    fn merge<'a>(&'a self, project: &'a ForgeProject, number: u64, opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let method = method_word(opts.method.unwrap_or(MergeMethod::Merge))?;
            let repo = Self::repo_url(&project.path)?;
            let mut body = serde_json::Map::new();
            body.insert("merge_method".into(), method.into());
            if let Some(sha) = &opts.expected_sha {
                body.insert("sha".into(), sha.clone().into());
            }
            self.http.send_json(Method::Put, &format!("{repo}/pulls/{number}/merge"), &Value::Object(body)).await.map_err(|e| merge_refused(number, e))?;
            self.pull(project, number).await
        })
    }

    fn edit<'a>(&'a self, project: &'a ForgeProject, number: u64, edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let repo = Self::repo_url(&project.path)?;
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
            Ok(all.iter().filter_map(json::user).filter(|u| json::matches(u, query)).take(PEOPLE_SHOWN).collect())
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
/// Open PRs whose checks are read per list (two requests each; GitHub's 304s are free).
pub const PIPELINE_LOOKUPS: usize = 20;
pub const COMMENT_PAGES: usize = 5;

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

    /// The open PRs for `filter`, newest activity first; `with_checks`: the first PIPELINE_LOOKUPS
    /// with their checks (the list), else none (the badges).
    async fn list_open(&self, project: &ForgeProject, filter: MrFilter, with_checks: bool) -> Result<Fresh<Vec<ForgeMr>>, GbError> {
        let repo = Self::repo_url(&project.path)?;
        let r = self.http.get(&format!("{repo}/pulls?state=open&sort=updated&direction=desc&per_page={PR_PER_PAGE}")).await?;
        let list: Vec<Value> = r.json(&self.host)?;
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
            for m in mrs.iter_mut().take(PIPELINE_LOOKUPS) {
                if let Some(sha) = m.head_sha.clone() {
                    m.pipeline = self.checks_soft(project, &sha).await?.0;
                }
            }
        }
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

impl GitHubProvider {
    async fn pull_json(&self, project: &ForgeProject, number: u64) -> Result<Value, GbError> {
        self.http.get(&format!("{}/pulls/{number}", Self::repo_url(&project.path)?)).await?.json(&self.host)
    }

    /// The PR as it is now (after a write).
    async fn pull(&self, project: &ForgeProject, number: u64) -> Result<ForgeMr, GbError> {
        json::pr(&self.pull_json(project, number).await?).ok_or_else(|| unreadable(&self.host, "pull request"))
    }
}
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
            let got: Value = r.json(&self.host)?;
            let have: Vec<String> = got["assignees"].as_array().into_iter().flatten().filter_map(|u| u["login"].as_str().map(str::to_lowercase)).collect();
            let missing: Vec<String> = body["assignees"].as_array().into_iter().flatten().filter_map(|l| l.as_str()).filter(|l| !have.contains(&l.to_lowercase())).map(str::to_string).collect();
            if !missing.is_empty() {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("couldn't assign: {}", missing.join(", "))));
            }
        }
        Ok(())
    }

    /// GitHub's reviewers and assignees are logins; `CreateMr` carries ids (ruling 11).
    /// `GET /user/{id}` is ETag-cached: a repeat is a 304.
    async fn logins(&self, ids: &[u64]) -> Result<Vec<String>, GbError> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let r = self.http.get(&format!("/user/{id}")).await?;
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
    use super::{json, noreply_id};
    use gitbolt_core::forge::*;

    #[test]
    fn normalizes_a_user_and_a_repo_with_its_parent() {
        let u = json::user(&json!({"id": 583231, "login": "octocat", "name": null, "avatar_url": "https://a/u/583231", "html_url": "https://github.com/octocat", "email": null})).unwrap();
        assert_eq!((u.name.as_str(), u.email), ("octocat", None));
        let r = json::project("github.com", &json!({
            "id": 502, "name": "widget", "full_name": "octocat/widget", "owner": {"login": "octocat"}, "html_url": "https://github.com/octocat/widget",
            "default_branch": "main", "clone_url": "https://github.com/octocat/widget.git", "ssh_url": "git@github.com:octocat/widget.git",
            "parent": {"full_name": "octo-org/widget"}, "pushed_at": "2026-10-04T12:00:00Z", "updated_at": "2020-01-01T00:00:00Z", "archived": false
        })).unwrap();
        assert_eq!((r.kind, r.owner.as_str(), r.fork_of.as_deref(), r.updated_at), (ForgeKind::GitHub, "octocat", Some("octo-org/widget"), Some(1_791_115_200)));
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
        assert_eq!(json::token_write(Some("public_repo")), WriteAccess::Yes);
        assert_eq!(json::token_write(Some("read:user")), WriteAccess::No { missing: "repo".into() });
        assert_eq!(json::token_write(None), WriteAccess::Unknown);
    }

    #[test]
    fn noreply_emails_carry_the_user_id() {
        assert_eq!(noreply_id("583231+octocat@users.noreply.github.com"), Some(583231));
        assert_eq!(noreply_id(" 583231+Octocat@Users.NoReply.GitHub.com "), Some(583231));
        assert_eq!(noreply_id("octocat@users.noreply.github.com"), None, "the old login-only form has no id");
        assert_eq!(noreply_id("ada@example.com"), None);
    }
    // --- 4B T4 ---
    use serde_json::Value;

    fn user_json(id: u64, login: &str) -> Value {
        json!({"id": id, "login": login})
    }

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
}
