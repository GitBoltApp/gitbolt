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
        Box::pin(async move {
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
            for m in mrs.iter_mut().take(PIPELINE_LOOKUPS) {
                if let Some(sha) = m.head_sha.clone() {
                    m.pipeline = self.checks_soft(project, &sha).await?;
                }
            }
            Ok(Self::fresh(mrs, &r))
        })
    }

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
            let reviews = self.http.get_pages(&format!("{repo}/pulls/{number}/reviews?per_page=100"), COMMENT_PAGES).await?;
            let mut mr = json::pr(&v).ok_or_else(|| unreadable(&self.host, "pull request"))?;
            if let Some(sha) = mr.head_sha.clone() {
                mr.pipeline = self.checks_soft(project, &sha).await?;
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
            Ok(Self::fresh(detail, &r))
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
    // --- end 4C ---
    // --- 4D ---
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

    /// `checks`, but a token that can't read them (a 403 without a rate limit, or a 404) just has
    /// no pipeline; rate limits, a rejected token (401) and network errors still fail.
    async fn checks_soft(&self, project: &ForgeProject, sha: &str) -> Result<Option<ForgePipeline>, GbError> {
        match self.checks(project, sha).await {
            Err(e) if e.kind == GbErrorKind::NotFound || crate::http::is_forbidden(&e) => Ok(None),
            r => r,
        }
    }

    /// A commit's checks and statuses as one pipeline.
    async fn checks(&self, project: &ForgeProject, sha: &str) -> Result<Option<ForgePipeline>, GbError> {
        let repo = Self::repo_url(&project.path)?;
        let runs: Value = self.http.get(&format!("{repo}/commits/{sha}/check-runs?per_page=100")).await?.json(&self.host)?;
        let statuses: Value = self.http.get(&format!("{repo}/commits/{sha}/status")).await?.json(&self.host)?;
        Ok(json::checks(&runs, &statuses, &format!("{}/commit/{sha}", project.web_url)))
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
}
