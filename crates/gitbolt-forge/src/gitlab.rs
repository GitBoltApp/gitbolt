//! GitLab REST v4 (spec #4 §3.1): identity, projects, settings, forks, avatars. 4B–4D add the
//! merge request methods to this impl, in their marked blocks.

use crate::avatar_cache::{image_at, payload_of, DiskAvatarCache, Lookup};
use crate::endpoints::HostEndpoints;
use crate::http::{encode_component, under, ClientConfig, HttpClient, HttpResponse, Method};
use crate::time::unix_now;
use gitbolt_core::avatar::AvatarPayload;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const FORKS_PER_PAGE: u32 = 100;
pub const FORK_PAGES: usize = 3;

// --- 4C T3 ---
pub const USERS_PER_PAGE: u32 = 20;
pub const LABELS_PER_PAGE: u32 = 50;
// --- end 4C T3 ---

pub struct GitLabProvider {
    host: String,
    web: String,
    http: HttpClient,
    avatars: Option<Arc<DiskAvatarCache>>,
    // --- 4B T2 ---
    /// The token's user, once asked (Mine, Review requested).
    me: Mutex<Option<ForgeUser>>,
    /// Project id → path: an MR names its source project by id only.
    paths: Mutex<HashMap<u64, String>>,
    /// Project id → label name → `#rrggbb`, from `/projects/:id/labels` (`fill_label_colors`).
    label_colors: Mutex<HashMap<u64, HashMap<String, String>>>,
    // --- end 4B T2 ---
}

impl GitLabProvider {
    pub fn new(host: &str, endpoints: &HostEndpoints, token: Secret, avatars: Option<Arc<DiskAvatarCache>>) -> Self {
        let http = HttpClient::new(ClientConfig { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), token: Some(token), headers: Vec::new(), timeout: Duration::from_secs(20) });
        Self { host: host.into(), web: endpoints.web.trim_end_matches('/').into(), http, avatars, me: Mutex::new(None), paths: Mutex::default(), label_colors: Mutex::default() } // 4B T2: me, paths
    }

    /// The account's client, for 4B–4D's requests.
    pub fn http(&self) -> &HttpClient {
        &self.http
    }

    /// `/projects/<id or url-encoded path>`.
    pub fn project_url(path_or_id: &str) -> String {
        format!("/projects/{}", encode_component(path_or_id))
    }

    fn fresh<T>(value: T, r: &HttpResponse) -> Fresh<T> {
        Fresh { value, not_modified: r.not_modified, poll_interval_secs: r.poll_interval_secs, fetched_at: unix_now() }
    }
}

fn unreadable(host: &str, what: &str) -> GbError {
    GbError::other(format!("{host} sent a {what} GitBolt couldn't read"))
}

/// GitLab's JSON → the normalized types (pure).
pub mod json {
    use crate::time::parse_rfc3339;
    use gitbolt_core::forge::*;
    use serde_json::Value;

    fn text(v: &Value) -> Option<String> {
        v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
    }

    pub fn user(v: &Value) -> Option<ForgeUser> {
        let username = v["username"].as_str()?.to_string();
        Some(ForgeUser {
            id: v["id"].as_u64()?,
            name: text(&v["name"]).unwrap_or_else(|| username.clone()),
            avatar_url: text(&v["avatar_url"]),
            web_url: v["web_url"].as_str().unwrap_or_default().to_string(),
            email: text(&v["public_email"]).or_else(|| text(&v["email"])),
            username,
        })
    }

    pub fn project(host: &str, v: &Value) -> Option<ForgeProject> {
        let path = v["path_with_namespace"].as_str()?.to_string();
        Some(ForgeProject {
            kind: ForgeKind::GitLab,
            id: v["id"].as_u64()?,
            host: host.to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
            owner: text(&v["namespace"]["full_path"]).unwrap_or_else(|| path.rsplit_once('/').map(|(o, _)| o.to_string()).unwrap_or_default()),
            web_url: v["web_url"].as_str().unwrap_or_default().to_string(),
            default_branch: text(&v["default_branch"]),
            clone_https: v["http_url_to_repo"].as_str().unwrap_or_default().to_string(),
            clone_ssh: v["ssh_url_to_repo"].as_str().unwrap_or_default().to_string(),
            fork_of: text(&v["forked_from_project"]["path_with_namespace"]),
            updated_at: v["last_activity_at"].as_str().and_then(parse_rfc3339),
            archived: v["archived"].as_bool().unwrap_or(false),
            owner_avatar_url: (v["namespace"]["kind"].as_str() == Some("user")).then(|| text(&v["namespace"]["avatar_url"])).flatten(),
            path,
        })
    }

    pub fn settings(v: &Value) -> ForgeProjectSettings {
        let method = match v["merge_method"].as_str() {
            Some("rebase_merge") => MergeMethod::SemiLinear,
            Some("ff") => MergeMethod::FastForward,
            _ => MergeMethod::Merge,
        };
        let squash = match v["squash_option"].as_str() {
            Some("never") => SquashOption::Never,
            Some("always") => SquashOption::Always,
            Some("default_on") => SquashOption::DefaultOn,
            _ => SquashOption::DefaultOff,
        };
        ForgeProjectSettings { merge_methods: vec![method], squash, delete_source_branch: v["remove_source_branch_after_merge"].as_bool().unwrap_or(false) }
    }

    /// What `/personal_access_tokens/self` says about writing: the `api` scope (spec #4 §2).
    pub fn token_write(v: &Value) -> WriteAccess {
        let has_api = v["scopes"].as_array().is_some_and(|a| a.iter().any(|s| s.as_str() == Some("api")));
        if has_api { WriteAccess::Yes } else { WriteAccess::No { missing: "api".into() } }
    }
    // --- 4B T2: merge requests ---
    use std::collections::HashMap;

    /// The prefixes GitLab reads as "draft" (and the older "WIP"), any case.
    const DRAFT_PREFIXES: [&str; 6] = ["draft:", "[draft]", "(draft)", "draft -", "wip:", "[wip]"];

    /// The title without its draft prefix: the state says Draft (Review Focus 5).
    pub fn strip_draft(title: &str) -> &str {
        let t = title.trim_start();
        let lower = t.to_ascii_lowercase();
        for p in DRAFT_PREFIXES {
            if lower.starts_with(p) {
                return t[p.len()..].trim_start();
            }
        }
        t
    }

    pub fn mr_state(state: &str, draft: bool) -> Option<MrState> {
        Some(match state {
            "opened" if draft => MrState::Draft,
            "opened" => MrState::Open,
            "merged" => MrState::Merged,
            "closed" | "locked" => MrState::Closed,
            _ => return None,
        })
    }

    pub fn pipeline_status(s: &str) -> Option<PipelineStatus> {
        Some(match s {
            "created" | "waiting_for_resource" | "preparing" | "pending" | "scheduled" | "waiting_for_callback" => PipelineStatus::Pending,
            "running" => PipelineStatus::Running,
            "success" => PipelineStatus::Success,
            "failed" => PipelineStatus::Failed,
            "canceled" | "canceling" => PipelineStatus::Canceled,
            "skipped" => PipelineStatus::Skipped,
            "manual" => PipelineStatus::Manual,
            _ => return None,
        })
    }

    pub fn pipeline(v: &Value) -> Option<ForgePipeline> {
        Some(ForgePipeline { status: pipeline_status(v["status"].as_str()?)?, web_url: text(&v["web_url"]) })
    }

    /// `/pipelines` (newest first) → each commit's newest pipeline.
    pub fn pipelines_by_sha(v: &Value) -> HashMap<String, ForgePipeline> {
        let mut out = HashMap::new();
        for p in v.as_array().into_iter().flatten() {
            if let (Some(sha), Some(pl)) = (p["sha"].as_str(), pipeline(p)) {
                out.entry(sha.to_string()).or_insert(pl);
            }
        }
        out
    }

    pub fn users(v: &Value) -> Vec<ForgeUser> {
        v.as_array().into_iter().flatten().filter_map(user).collect()
    }

    /// One MR from a list or a GET. `target`: the project's path; `source`: its source project's.
    pub fn mr(v: &Value, target: &str, source: &str) -> Option<ForgeMr> {
        let draft = v["draft"].as_bool().or(v["work_in_progress"].as_bool()).unwrap_or(false);
        let raw = v["title"].as_str()?;
        Some(ForgeMr {
            number: v["iid"].as_u64()?,
            title: if draft { strip_draft(raw) } else { raw }.to_string(),
            state: mr_state(v["state"].as_str()?, draft)?,
            author: user(&v["author"])?,
            source_project: source.to_string(),
            source_branch: v["source_branch"].as_str()?.to_string(),
            target_project: target.to_string(),
            target_branch: v["target_branch"].as_str()?.to_string(),
            head_sha: text(&v["sha"]),
            web_url: v["web_url"].as_str().unwrap_or_default().to_string(),
            pipeline: pipeline(&v["head_pipeline"]),
            review: ReviewSummary { decision: ReviewDecision::None, approvals: 0, approvals_required: None, reviews: Vec::new() },
            conflicts: v["has_conflicts"].as_bool(),
            labels: labels_of(&v["labels"]).0,
            label_colors: labels_of(&v["labels"]).1,
            updated_at: v["updated_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            stacked: v["description"].as_str().is_some_and(gitbolt_core::forge::stack::carries_stack_table),
        })
    }

    /// Why GitLab won't merge it (`detailed_merge_status`, GitLab ≥ 15.6; `merge_status` before).
    pub fn merge_status(v: &Value) -> MergeStatus {
        let blocked = |r: &str| MergeStatus::Blocked { reason: r.to_string() };
        match v["state"].as_str() {
            Some("merged") => return blocked("It's merged already"),
            Some("closed" | "locked") => return blocked("It's closed"),
            _ => {}
        }
        match v["detailed_merge_status"].as_str() {
            Some("mergeable") => MergeStatus::Mergeable,
            Some("checking" | "unchecked" | "preparing" | "approvals_syncing") => MergeStatus::Checking,
            Some("ci_must_pass") => blocked("The pipeline must succeed first"),
            Some("ci_still_running") => blocked("The pipeline is still running"),
            Some("discussions_not_resolved") => blocked("Resolve all threads first"),
            Some("draft_status") => blocked("Mark it ready first: it's a draft"),
            Some("not_approved") => blocked("It needs approval first"),
            Some("requested_changes") => blocked("A reviewer requested changes"),
            Some("conflict") => blocked("It has conflicts: rebase or merge the target branch first"),
            Some("need_rebase") => blocked("Rebase the source branch first"),
            Some("blocked_status" | "merge_request_blocked") => blocked("Another merge request blocks it"),
            Some("not_open") => blocked("It isn't open"),
            Some("broken_status") => blocked("The source branch can't be merged as it is"),
            Some("external_status_checks") => blocked("External status checks must pass first"),
            Some("jira_association_missing") => blocked("Its title or description needs a Jira issue key"),
            Some("merge_time") => blocked("It can't merge before its scheduled time"),
            Some("security_policy_violations") => blocked("Security policies block it"),
            Some("locked_paths" | "locked_lfs_files") => blocked("Locked files block it"),
            Some("title_regex") => blocked("Its title doesn't match the project's rule"),
            Some("commits_status") => blocked("Its commits don't meet the project's rules"),
            Some(other) => blocked(&format!("GitLab says: {}", other.replace('_', " "))),
            None => match v["merge_status"].as_str() {
                Some("can_be_merged") => MergeStatus::Mergeable,
                Some("cannot_be_merged" | "cannot_be_merged_recheck") => blocked("It has conflicts: rebase or merge the target branch first"),
                _ => MergeStatus::Checking,
            },
        }
    }

    /// The approvals (`/approvals`, any tier) and the review decision.
    pub fn review(v: &Value, approvals: Option<&Value>) -> ReviewSummary {
        let reviews: Vec<ForgeReview> = approvals
            .map(|a| a["approved_by"].as_array().into_iter().flatten().filter_map(|x| user(&x["user"])).map(|u| ForgeReview { user: u, state: ReviewState::Approved, submitted_at: None }).collect())
            .unwrap_or_default();
        let required = approvals.and_then(|a| a["approvals_required"].as_u64()).filter(|n| *n > 0).map(|n| n as u32);
        let count = reviews.len() as u32;
        let decision = if v["detailed_merge_status"].as_str() == Some("requested_changes") {
            ReviewDecision::ChangesRequested
        } else if required.map_or(count > 0, |r| count >= r) {
            ReviewDecision::Approved
        } else if required.is_some() || v["reviewers"].as_array().is_some_and(|r| !r.is_empty()) {
            ReviewDecision::ReviewRequired
        } else {
            ReviewDecision::None
        };
        ReviewSummary { decision, approvals: count, approvals_required: required, reviews }
    }

    pub fn detail(v: &Value, target: &str, source: &str, approvals: Option<&Value>) -> Option<ForgeMrDetail> {
        let mut m = mr(v, target, source)?;
        m.review = review(v, approvals);
        Some(ForgeMrDetail {
            mr: m,
            description: v["description"].as_str().unwrap_or_default().to_string(),
            reviewers: users(&v["reviewers"]),
            assignees: users(&v["assignees"]),
            merge_status: merge_status(v),
            squash: v["squash"].as_bool(),
            delete_source_branch: v["force_remove_source_branch"].as_bool(),
        })
    }

    fn position(v: &Value) -> Option<DiffPosition> {
        let path = text(&v["new_path"]).or_else(|| text(&v["old_path"]))?;
        let old_path = text(&v["old_path"]).filter(|p| *p != path);
        Some(DiffPosition { path, old_path, line: v["new_line"].as_u64().map(|n| n as u32), old_line: v["old_line"].as_u64().map(|n| n as u32), snippet: None })
    }

    pub fn note(v: &Value) -> Option<ForgeNote> {
        Some(ForgeNote {
            id: v["id"].as_u64().map(|n| n.to_string()).or_else(|| text(&v["id"]))?,
            author: user(&v["author"])?,
            body: v["body"].as_str().unwrap_or_default().to_string(),
            created_at: v["created_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            system: v["system"].as_bool().unwrap_or(false),
            position: position(&v["position"]),
        })
    }

    pub fn discussion(v: &Value) -> Option<ForgeDiscussion> {
        let raw = v["notes"].as_array()?;
        let first = raw.first()?;
        let notes: Vec<ForgeNote> = raw.iter().filter_map(note).collect();
        (!notes.is_empty()).then(|| ForgeDiscussion {
            id: v["id"].as_str().unwrap_or_default().to_string(),
            notes,
            resolvable: first["resolvable"].as_bool().unwrap_or(false),
            resolved: first["resolved"].as_bool().unwrap_or(false),
        })
    }

    /// Up to three lines of a unified diff ending at the commented one (`new_line` on the new
    /// side, else `old_line` on the old), each with its `+`, `-` or space.
    pub fn snippet(diff: &str, new_line: Option<u32>, old_line: Option<u32>) -> Option<String> {
        let (mut old, mut new) = (0u32, 0u32);
        let mut window: std::collections::VecDeque<&str> = std::collections::VecDeque::new();
        for line in diff.lines() {
            if let Some(h) = line.strip_prefix("@@ ") {
                let start = |p: Option<&str>, sign: char| p.and_then(|s| s.strip_prefix(sign)).and_then(|s| s.split(',').next()).and_then(|s| s.parse::<u32>().ok());
                let mut parts = h.split_whitespace();
                old = start(parts.next(), '-').unwrap_or(0);
                new = start(parts.next(), '+').unwrap_or(0);
                window.clear();
                continue;
            }
            if line.starts_with('\\') {
                continue;
            }
            if window.len() == 3 {
                window.pop_front();
            }
            window.push_back(line);
            let hit = match line.chars().next() {
                Some('+') => {
                    let hit = new_line == Some(new);
                    new += 1;
                    hit
                }
                Some('-') => {
                    let hit = new_line.is_none() && old_line == Some(old);
                    old += 1;
                    hit
                }
                _ => {
                    let hit = new_line == Some(new) || (new_line.is_none() && old_line == Some(old));
                    old += 1;
                    new += 1;
                    hit
                }
            };
            if hit {
                return Some(window.iter().copied().collect::<Vec<_>>().join("\n"));
            }
        }
        None
    }

    /// Each diff note's snippet, from the MR's diffs (`/diffs`: `new_path`, `old_path`, `diff`).
    pub fn fill_snippets(discussions: &mut [ForgeDiscussion], diffs: &[Value]) {
        for n in discussions.iter_mut().flat_map(|d| d.notes.iter_mut()) {
            let Some(pos) = n.position.as_mut() else { continue };
            if pos.snippet.is_some() {
                continue;
            }
            let diff = diffs.iter().find(|d| d["new_path"].as_str() == Some(pos.path.as_str()) || d["old_path"].as_str() == Some(pos.path.as_str())).and_then(|d| d["diff"].as_str());
            pos.snippet = diff.and_then(|d| snippet(d, pos.line, pos.old_line));
        }
    }

    /// A branch's badge: its open (or draft) MR, else its most recently updated one.
    pub fn pick_for_branch(mrs: Vec<ForgeMr>) -> Option<ForgeMr> {
        match mrs.iter().position(|m| matches!(m.state, MrState::Open | MrState::Draft)) {
            Some(i) => mrs.into_iter().nth(i),
            None => mrs.into_iter().max_by_key(|m| m.updated_at),
        }
    }
    // --- end 4B T2 ---
    // --- 4C T3 ---
    pub fn label(v: &Value) -> Option<ForgeLabel> {
        Some(ForgeLabel { name: v["name"].as_str()?.to_string(), color: text(&v["color"]), description: text(&v["description"]) })
    }

    /// Ruling 9: GitLab's draft is the title prefix, which every version honours.
    pub fn draft_title(title: &str, draft: bool) -> String {
        let t = title.trim();
        let lower = t.to_lowercase();
        let marked = ["draft:", "[draft]", "(draft)"].iter().any(|p| lower.starts_with(p));
        if draft && !marked { format!("Draft: {t}") } else { t.to_string() }
    }

    /// The POST body. A fork's MR is created in the fork (`source_id`) and names the target.
    pub fn create_body(req: &CreateMr, source_id: u64, target_id: u64) -> Value {
        let mut b = serde_json::json!({
            "source_branch": req.source.branch, "target_branch": req.target_branch, "title": draft_title(&req.title, req.draft),
            "description": req.description, "assignee_ids": req.assignees, "reviewer_ids": req.reviewers, "labels": req.labels,
        });
        if source_id != target_id {
            b["target_project_id"] = serde_json::json!(target_id);
        }
        if let Some(s) = req.squash {
            b["squash"] = serde_json::json!(s);
        }
        if let Some(d) = req.delete_source_branch {
            b["remove_source_branch"] = serde_json::json!(d);
        }
        b
    }

    /// The MR GitLab answered a create with, under the paths it was made with (the answer has ids).
    pub fn created_mr(v: &Value, source_project: &str, target_project: &str) -> Option<ForgeMr> {
        let draft = v["draft"].as_bool().or(v["work_in_progress"].as_bool()).unwrap_or(false);
        let state = match v["state"].as_str()? {
            "merged" => MrState::Merged,
            "closed" | "locked" => MrState::Closed,
            _ if draft => MrState::Draft,
            _ => MrState::Open,
        };
        Some(ForgeMr {
            number: v["iid"].as_u64()?,
            title: v["title"].as_str()?.to_string(),
            state,
            author: user(&v["author"])?,
            source_project: source_project.to_string(),
            source_branch: v["source_branch"].as_str()?.to_string(),
            target_project: target_project.to_string(),
            target_branch: v["target_branch"].as_str()?.to_string(),
            head_sha: text(&v["sha"]),
            web_url: v["web_url"].as_str()?.to_string(),
            pipeline: None,
            review: ReviewSummary { decision: ReviewDecision::None, approvals: 0, approvals_required: None, reviews: Vec::new() },
            conflicts: v["has_conflicts"].as_bool(),
            labels: labels_of(&v["labels"]).0,
            label_colors: labels_of(&v["labels"]).1,
            updated_at: v["updated_at"].as_str().and_then(parse_rfc3339).unwrap_or(0),
            stacked: v["description"].as_str().is_some_and(gitbolt_core::forge::stack::carries_stack_table),
        })
    }
    // --- end 4C T3 ---
}

// --- 4B T2: merge requests (reads) ---
pub const MR_PER_PAGE: u32 = 100;
pub const DISCUSSION_PAGES: usize = 5;
pub const DIFF_PAGES: usize = 3;

impl GitLabProvider {
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

    /// A project's path by id (cached).
    async fn project_path(&self, project: &ForgeProject, id: u64) -> Result<String, GbError> {
        if id == project.id {
            return Ok(project.path.clone());
        }
        let cached = self.paths.lock().expect("paths poisoned").get(&id).cloned();
        if let Some(p) = cached {
            return Ok(p);
        }
        // A project the token can't see (a private fork: 404 or 403) is cached too, so each id is
        // asked once; a network error or a rate limit isn't, and fails the call as before.
        let looked_up = match self.http.get(&Self::project_url(&id.to_string())).await {
            Ok(r) => r.json::<Value>(&self.host).ok().and_then(|v| v["path_with_namespace"].as_str().map(str::to_string)),
            Err(e) if e.kind == GbErrorKind::NotFound || crate::http::is_forbidden(&e) => None,
            Err(e) => return Err(e),
        };
        let path = looked_up.unwrap_or_else(|| format!("project {id}"));
        self.paths.lock().expect("paths poisoned").insert(id, path.clone());
        Ok(path)
    }

    /// An MR's source project path; one the token can't see (a private fork) is named by id.
    async fn source_of(&self, project: &ForgeProject, v: &Value) -> String {
        match v["source_project_id"].as_u64() {
            Some(id) => self.project_path(project, id).await.unwrap_or_else(|_| format!("project {id}")),
            None => project.path.clone(),
        }
    }

    /// The project's recent pipelines by commit: best effort (a project without CI has none).
    async fn pipelines(&self, project: &ForgeProject) -> HashMap<String, ForgePipeline> {
        match self.http.get(&format!("/projects/{}/pipelines?per_page=100&order_by=updated_at&sort=desc", project.id)).await {
            Ok(r) => r.json::<Value>(&self.host).map(|v| json::pipelines_by_sha(&v)).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    }

    /// The open MRs for `filter`, newest activity first; `with_pipelines`: with the project's recent
    /// pipelines (the list), else without (the badges).
    async fn list_open(&self, project: &ForgeProject, filter: MrFilter, with_pipelines: bool) -> Result<Fresh<Vec<ForgeMr>>, GbError> {
        let mut path = format!("/projects/{}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page={MR_PER_PAGE}&with_labels_details=true", project.id);
        match filter {
            MrFilter::All => {}
            MrFilter::Mine => path.push_str("&scope=created_by_me"),
            MrFilter::ReviewRequested => path.push_str(&format!("&reviewer_id={}", self.me().await?.id)),
        }
        let r = self.http.get(&path).await?;
        let list: Vec<Value> = r.json(&self.host)?;
        let pipelines = if list.is_empty() || !with_pipelines { HashMap::new() } else { self.pipelines(project).await };
        Ok(Self::fresh(self.mrs_of(project, &list, &pipelines).await, &r))
    }

    async fn mrs_of(&self, project: &ForgeProject, list: &[Value], pipelines: &HashMap<String, ForgePipeline>) -> Vec<ForgeMr> {
        let mut out = Vec::with_capacity(list.len());
        for v in list {
            let source = self.source_of(project, v).await;
            if let Some(mut m) = json::mr(v, &project.path, &source) {
                if m.pipeline.is_none() {
                    m.pipeline = m.head_sha.as_ref().and_then(|s| pipelines.get(s).cloned());
                }
                out.push(m);
            }
        }
        out
    }

    /// Colours for `mr`'s labels that came without one (a single MR's GET): from the project's
    /// labels (its groups' included), kept per project for the session and asked again (an
    /// ETag-revalidated GET) only when the MR names a label the kept map doesn't have. Best effort:
    /// a failure leaves plain chips.
    async fn fill_label_colors(&self, project: &ForgeProject, mr: &mut ForgeMr) {
        let wanted: Vec<String> = mr.labels.iter().filter(|l| !mr.label_colors.contains_key(*l)).cloned().collect();
        if wanted.is_empty() {
            return;
        }
        let kept = self.label_colors.lock().expect("label colours poisoned").get(&project.id).cloned();
        let colors = match kept {
            Some(c) if wanted.iter().all(|l| c.contains_key(l)) => c,
            kept => match self.http.get(&format!("/projects/{}/labels?per_page=100", project.id)).await.and_then(|r| r.json::<Vec<Value>>(&self.host)) {
                Ok(list) => {
                    let c: HashMap<String, String> = list.iter().filter_map(json::label).filter_map(|l| Some((l.name, label_color(l.color.as_deref()?)?))).collect();
                    self.label_colors.lock().expect("label colours poisoned").insert(project.id, c.clone());
                    c
                }
                Err(e) => {
                    tracing::debug!("label colours from {}: {}", self.host, e.message);
                    kept.unwrap_or_default()
                }
            },
        };
        for l in wanted {
            if let Some(c) = colors.get(&l) {
                mr.label_colors.insert(l, c.clone());
            }
        }
    }

    fn mr_url(project: &ForgeProject, number: u64) -> String {
        format!("/projects/{}/merge_requests/{number}", project.id)
    }
}
// --- end 4B T2 ---

// --- 4B T3: merge requests (writes) ---
/// GitLab's refusals of a merge, said plainly: another head sha (409), or it can't merge now
/// (405/406: not open, not approved, a draft, conflicts…).
pub fn merge_refused(number: u64, e: GbError) -> GbError {
    if e.message.contains("SHA does not match") {
        return GbError::new(GbErrorKind::InvalidInput, format!("!{number} changed since it was loaded: refresh and try again"));
    }
    if e.message.contains("HTTP 405") || e.message.contains("HTTP 406") {
        return GbError::new(GbErrorKind::InvalidInput, format!("GitLab can't merge !{number} now: refresh to see why"));
    }
    e
}

impl GitLabProvider {
    /// An MR JSON the forge answered a write with, normalized.
    async fn mr_from(&self, project: &ForgeProject, v: &Value) -> Result<ForgeMr, GbError> {
        let source = self.source_of(project, v).await;
        json::mr(v, &project.path, &source).ok_or_else(|| unreadable(&self.host, "merge request"))
    }

    async fn current(&self, project: &ForgeProject, number: u64) -> Result<Value, GbError> {
        self.http.get(&Self::mr_url(project, number)).await?.json(&self.host)
    }
}
// --- end 4B T3 ---

impl ForgeProvider for GitLabProvider {
    fn kind(&self) -> ForgeKind {
        ForgeKind::GitLab
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
            json::user(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "user"))
        })
    }

    fn check_token(&self) -> ForgeFuture<'_, TokenCheck> {
        Box::pin(async move {
            let user = self.current_user().await?;
            // GitLab ≥ 15.5 describes the token itself. An older one (404), or a token that isn't
            // a personal one (401), can't say: accepted, and a write says so later (4B).
            let write = match self.http.get("/personal_access_tokens/self").await {
                Ok(r) => json::token_write(&r.json(&self.host)?),
                Err(e) if matches!(e.kind, GbErrorKind::NotFound | GbErrorKind::AuthFailed) => WriteAccess::Unknown,
                Err(e) => return Err(e),
            };
            Ok(TokenCheck { user, write })
        })
    }

    fn version(&self) -> ForgeFuture<'_, Option<String>> {
        Box::pin(async move {
            let r = self.http.get("/version").await?;
            Ok(r.json::<Value>(&self.host)?["version"].as_str().map(str::to_string))
        })
    }

    fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> {
        Box::pin(async move {
            let r = self.http.get(&Self::project_url(path)).await?;
            let p = json::project(&self.host, &r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "project"))?;
            Ok(Self::fresh(p, &r))
        })
    }

    fn project_settings<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> {
        Box::pin(async move {
            let r = self.http.get(&Self::project_url(&project.id.to_string())).await?;
            Ok(json::settings(&r.json(&self.host)?))
        })
    }

    fn forks<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> {
        Box::pin(async move {
            let path = format!("/projects/{}/forks?per_page={FORKS_PER_PAGE}&order_by=last_activity_at&sort=desc", project.id);
            Ok(self.http.get_pages(&path, FORK_PAGES).await?.iter().filter_map(|v| json::project(&self.host, v)).collect())
        })
    }

    // --- forks paging ---
    fn forks_page<'a>(&'a self, project: &'a ForgeProject, page: u32, per_page: u32) -> ForgeFuture<'a, ForkPage> {
        Box::pin(async move {
            let path = format!("/projects/{}/forks?order_by=last_activity_at&sort=desc&per_page={per_page}&page={page}", project.id);
            let r = self.http.get(&path).await?;
            let items: Vec<Value> = r.json(&self.host)?;
            Ok(ForkPage { forks: items.iter().filter_map(|v| json::project(&self.host, v)).collect(), next: r.next_page.is_some().then(|| page + 1) })
        })
    }
    // --- end forks paging ---
    /// Only the account's own uploads (`<web>/uploads/…`; with the token, as `avatar_for_email` fetches
    /// them, for an instance that keeps them private) or Gravatar's (without it), checked by
    /// `avatar_fetch_url`.
    fn avatar_at<'a>(&'a self, url: &'a str) -> Option<ForgeFuture<'a, Option<AvatarPayload>>> {
        let url = avatar_fetch_url(url, &[&format!("{}/uploads", self.web)])?;
        Some(Box::pin(async move { image_at(&self.http, self.avatars.as_deref(), &url, &self.web).await }))
    }

    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async move {
            let email = email.trim();
            if email.is_empty() {
                return Ok(None);
            }
            if let Some(cache) = &self.avatars {
                match cache.lookup(email) {
                    Lookup::Found(p) => return Ok(Some(p)),
                    Lookup::Missing => return Ok(None),
                    Lookup::Unknown => {}
                }
            }
            let r = self.http.get(&format!("/avatar?email={}&size=80", encode_component(email))).await?;
            let url = r.json::<Value>(&self.host)?["avatar_url"].as_str().map(str::to_string);
            // Only an image the forge itself hosts. A Gravatar URL falls through to GitBolt's own
            // Gravatar lookup, which follows the user's Gravatar setting.
            let found = match url.filter(|u| under(u, &self.web)) {
                Some(u) => self.http.get_image(&u, &self.web).await?,
                None => None,
            };
            Ok(match (found, &self.avatars) {
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

    // --- 4B: merge requests ---
    // --- 4B T2: reads ---
    fn open_mrs<'a>(&'a self, project: &'a ForgeProject, filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(self.list_open(project, filter, true))
    }

    fn open_mrs_light<'a>(&'a self, project: &'a ForgeProject, filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(self.list_open(project, filter, false))
    }

    // --- 4D T4 ---
    fn open_mrs_targeting<'a>(&'a self, project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(async move {
            let path = format!("/projects/{}/merge_requests?state=opened&target_branch={}&per_page=100&with_labels_details=true", project.id, encode_component(branch));
            let r = self.http.get(&path).await?;
            let list: Vec<Value> = r.json(&self.host)?;
            Ok(Self::fresh(self.mrs_of(project, &list, &HashMap::new()).await, &r))
        })
    }
    // --- end 4D T4 ---

    fn mr_for_branch<'a>(&'a self, project: &'a ForgeProject, source: &'a SourceRef) -> ForgeFuture<'a, Fresh<Option<ForgeMr>>> {
        Box::pin(async move {
            let path = format!("/projects/{}/merge_requests?source_branch={}&state=all&order_by=updated_at&sort=desc&per_page=20&with_labels_details=true", project.id, encode_component(&source.branch));
            let r = self.http.get(&path).await?;
            let list: Vec<Value> = r.json(&self.host)?;
            let mrs: Vec<ForgeMr> = self.mrs_of(project, &list, &HashMap::new()).await.into_iter().filter(|m| m.source_project == source.project).collect();
            Ok(Self::fresh(json::pick_for_branch(mrs), &r))
        })
    }

    fn mr_detail<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<ForgeMrDetail>> {
        Box::pin(async move {
            let url = Self::mr_url(project, number);
            let r = self.http.get(&url).await?;
            let v: Value = r.json(&self.host)?;
            let source = self.source_of(project, &v).await;
            // Every tier has `/approvals`; a 404 (an old GitLab) is "no approvals".
            let (approvals, approvals_same) = match self.http.get(&format!("{url}/approvals")).await {
                Ok(a) => (Some(a.json::<Value>(&self.host)?), a.not_modified),
                Err(e) if e.kind == GbErrorKind::NotFound => (None, false),
                Err(e) => return Err(e),
            };
            let mut d = json::detail(&v, &project.path, &source, approvals.as_ref()).ok_or_else(|| unreadable(&self.host, "merge request"))?;
            // A single MR's GET has label names only (`with_labels_details` is for the lists).
            self.fill_label_colors(project, &mut d.mr).await;
            // Not modified only when the MR and its approvals both were (a 304 each).
            let mut fresh = Self::fresh(d, &r);
            fresh.not_modified &= approvals_same;
            Ok(fresh)
        })
    }

    fn discussions<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<Vec<ForgeDiscussion>>> {
        Box::pin(async move {
            let url = Self::mr_url(project, number);
            let raw = self.http.get_pages(&format!("{url}/discussions?per_page=100"), DISCUSSION_PAGES).await?;
            let mut ds: Vec<ForgeDiscussion> = raw.iter().filter_map(json::discussion).collect();
            if ds.iter().any(|d| d.notes.iter().any(|n| n.position.is_some())) {
                // The snippets come from the MR's own diffs: best effort (no `/diffs` before GitLab 15.7).
                let diffs = self.http.get_pages(&format!("{url}/diffs?per_page=100"), DIFF_PAGES).await.unwrap_or_default();
                json::fill_snippets(&mut ds, &diffs);
            }
            Ok(Fresh::new(ds, unix_now()))
        })
    }
    // --- end 4B T2 ---
    // --- 4B T3: writes ---
    fn reply<'a>(&'a self, project: &'a ForgeProject, number: u64, note: &'a NewNote) -> ForgeFuture<'a, ForgeNote> {
        Box::pin(async move {
            let url = Self::mr_url(project, number);
            let path = match &note.discussion {
                Some(d) => format!("{url}/discussions/{}/notes", encode_component(d)),
                None => format!("{url}/notes"),
            };
            let r = self.http.send_json(Method::Post, &path, &json!({ "body": note.body })).await?;
            json::note(&r.json(&self.host)?).ok_or_else(|| unreadable(&self.host, "note"))
        })
    }

    fn approve<'a>(&'a self, project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ()> {
        Box::pin(async move {
            self.http.send_json(Method::Post, &format!("{}/approve", Self::mr_url(project, number)), &json!({})).await?;
            Ok(())
        })
    }

    /// GitLab's REST API has no review state (ruling 6): the comment, then the user's approval
    /// withdrawn. Not approved (a 404) is fine.
    fn request_changes<'a>(&'a self, project: &'a ForgeProject, number: u64, body: &'a str) -> ForgeFuture<'a, ()> {
        Box::pin(async move {
            let url = Self::mr_url(project, number);
            if !body.trim().is_empty() {
                self.http.send_json(Method::Post, &format!("{url}/notes"), &json!({ "body": body })).await?;
            }
            match self.http.send_json(Method::Post, &format!("{url}/unapprove"), &json!({})).await {
                Ok(_) => Ok(()),
                Err(e) if e.kind == GbErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        })
    }

    /// The method is the project's (GitLab merges with it); `opts.method` is ignored.
    fn merge<'a>(&'a self, project: &'a ForgeProject, number: u64, opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let mut body = serde_json::Map::new();
            if let Some(s) = opts.squash {
                body.insert("squash".into(), s.into());
            }
            if let Some(d) = opts.delete_source_branch {
                body.insert("should_remove_source_branch".into(), d.into());
            }
            if let Some(sha) = &opts.expected_sha {
                body.insert("sha".into(), sha.clone().into());
            }
            let r = self.http.send_json(Method::Put, &format!("{}/merge", Self::mr_url(project, number)), &Value::Object(body)).await.map_err(|e| merge_refused(number, e))?;
            self.mr_from(project, &r.json(&self.host)?).await
        })
    }

    /// A draft keeps its prefix: a new title for it is sent as `Draft: <title>` (Review Focus 5).
    fn edit<'a>(&'a self, project: &'a ForgeProject, number: u64, edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let current = self.current(project, number).await?;
            let draft = current["draft"].as_bool().or(current["work_in_progress"].as_bool()).unwrap_or(false);
            let mut body = serde_json::Map::new();
            if let Some(t) = &edit.title {
                let t = json::strip_draft(t.trim());
                body.insert("title".into(), if draft { format!("Draft: {t}") } else { t.to_string() }.into());
            }
            if let Some(d) = &edit.description {
                body.insert("description".into(), d.clone().into());
            }
            if let Some(l) = &edit.labels {
                body.insert("labels".into(), l.join(",").into());
            }
            let r = self.http.send_json(Method::Put, &Self::mr_url(project, number), &Value::Object(body)).await?;
            self.mr_from(project, &r.json(&self.host)?).await
        })
    }

    /// GitLab's draft is its title's prefix.
    fn set_draft<'a>(&'a self, project: &'a ForgeProject, number: u64, draft: bool) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let current = self.current(project, number).await?;
            let title = json::strip_draft(current["title"].as_str().unwrap_or_default()).to_string();
            let title = if draft { format!("Draft: {title}") } else { title };
            let r = self.http.send_json(Method::Put, &Self::mr_url(project, number), &json!({ "title": title })).await?;
            self.mr_from(project, &r.json(&self.host)?).await
        })
    }
    // --- end 4B T3 ---
    // --- end 4B ---
    // --- 4C ---
    // --- 4C T3: create, people, labels, templates ---
    fn create_mr<'a>(&'a self, project: &'a ForgeProject, req: &'a CreateMr) -> ForgeFuture<'a, CreateOutcome> {
        Box::pin(async move {
            // GitLab creates in the source project; a fork's MR names its target (ruling 3).
            let source_id = if req.source.project == project.path { project.id } else { self.project(&req.source.project).await?.value.id };
            let body = json::create_body(req, source_id, project.id);
            let r = self.http.send_json(Method::Post, &format!("/projects/{source_id}/merge_requests"), &body).await?;
            let mr = json::created_mr(&r.json(&self.host)?, &req.source.project, &project.path).ok_or_else(|| unreadable(&self.host, "merge request"))?;
            Ok(CreateOutcome { mr, failed: Vec::new() })
        })
    }

    fn search_users<'a>(&'a self, project: &'a ForgeProject, query: &'a str) -> ForgeFuture<'a, Vec<ForgeUser>> {
        Box::pin(async move {
            let path = format!("/projects/{}/members/all?query={}&per_page={USERS_PER_PAGE}", project.id, encode_component(query.trim()));
            let r = self.http.get(&path).await?;
            Ok(r.json::<Vec<Value>>(&self.host)?.iter().filter_map(json::user).collect())
        })
    }

    fn labels<'a>(&'a self, project: &'a ForgeProject, query: &'a str) -> ForgeFuture<'a, Vec<ForgeLabel>> {
        Box::pin(async move {
            let path = format!("/projects/{}/labels?search={}&per_page={LABELS_PER_PAGE}", project.id, encode_component(query.trim()));
            let r = self.http.get(&path).await?;
            Ok(r.json::<Vec<Value>>(&self.host)?.iter().filter_map(json::label).collect())
        })
    }

    fn mr_templates<'a>(&'a self, project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Vec<MrTemplate>> {
        Box::pin(async move {
            use gitbolt_core::forge::create::{clip_template, is_template_path, sort_templates, template_name, GITLAB_TEMPLATE_DIR, MAX_TEMPLATES};
            let at = encode_component(branch);
            let tree = format!("/projects/{}/repository/tree?path={}&ref={at}&per_page=100", project.id, encode_component(GITLAB_TEMPLATE_DIR));
            let entries: Vec<Value> = match self.http.get(&tree).await {
                Ok(r) => r.json(&self.host)?,
                // No such directory on that branch: no templates (a final answer, ruling 7).
                Err(e) if e.kind == GbErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(e),
            };
            let paths: Vec<String> = entries
                .iter()
                .filter(|e| e["type"] == "blob")
                .filter_map(|e| e["path"].as_str())
                .filter(|p| is_template_path(ForgeKind::GitLab, p))
                .take(MAX_TEMPLATES)
                .map(str::to_string)
                .collect();
            let mut out = Vec::with_capacity(paths.len());
            for path in paths {
                // One file the token can't read (or that went away) is skipped, not the whole list.
                let r = match self.http.get(&format!("/projects/{}/repository/files/{}/raw?ref={at}", project.id, encode_component(&path))).await {
                    Ok(r) => r,
                    Err(e) if e.kind == GbErrorKind::NotFound || crate::http::is_forbidden(&e) => continue,
                    Err(e) => return Err(e),
                };
                out.push(MrTemplate { name: template_name(&path), body: clip_template(&r.body), path });
            }
            Ok(sort_templates(out))
        })
    }
    // --- end 4C T3 ---
    // --- end 4C ---
    // --- 4D ---
    // --- 4D: stacks ---
    /// Points the MR at `target_branch` (spec #4 §4 "4D"): `PUT …/merge_requests/:iid`.
    fn retarget<'a>(&'a self, project: &'a ForgeProject, number: u64, target_branch: &'a str) -> ForgeFuture<'a, ForgeMr> {
        Box::pin(async move {
            let r = self.http.send_json(Method::Put, &Self::mr_url(project, number), &serde_json::json!({ "target_branch": target_branch })).await?;
            self.mr_from(project, &r.json(&self.host)?).await
        })
    }
    // --- end 4D ---
}

#[cfg(test)]
mod tests {
    use super::json;
    use gitbolt_core::forge::*;

    #[test]
    fn normalizes_a_user_preferring_the_public_email() {
        let u = json::user(&json!({"id": 7, "username": "ada", "name": "", "avatar_url": "https://g/a.png", "web_url": "https://g/ada", "public_email": "", "email": "ada@corp.example"})).unwrap();
        assert_eq!(u, ForgeUser { id: 7, username: "ada".into(), name: "ada".into(), avatar_url: Some("https://g/a.png".into()), web_url: "https://g/ada".into(), email: Some("ada@corp.example".into()) });
        assert!(json::user(&json!({"id": 7})).is_none());
    }

    #[test]
    fn normalizes_a_fork_and_its_settings() {
        let v = json!({
            "id": 77, "name": "project", "path_with_namespace": "alice/project", "namespace": {"full_path": "alice", "kind": "user", "avatar_url": "https://g/uploads/-/system/user/avatar/7/a.png"},
            "web_url": "https://g/alice/project", "default_branch": "main", "http_url_to_repo": "https://g/alice/project.git",
            "ssh_url_to_repo": "git@g:alice/project.git", "forked_from_project": {"path_with_namespace": "group/project"},
            "last_activity_at": "2026-10-04T12:00:00.000Z", "archived": false,
            "merge_method": "rebase_merge", "squash_option": "always", "remove_source_branch_after_merge": true
        });
        let p = json::project("g", &v).unwrap();
        assert_eq!((p.kind, p.id, p.owner.as_str(), p.fork_of.as_deref(), p.updated_at), (ForgeKind::GitLab, 77, "alice", Some("group/project"), Some(1_791_115_200)));
        assert_eq!(p.owner_avatar_url.as_deref(), Some("https://g/uploads/-/system/user/avatar/7/a.png"));
        let group = json::project("g", &json!({"id": 1, "path_with_namespace": "group/project", "namespace": {"full_path": "group", "kind": "group", "avatar_url": "https://g/uploads/g.png"}})).unwrap();
        assert_eq!(group.owner_avatar_url, None, "a group's isn't kept");
        assert_eq!(json::settings(&v), ForgeProjectSettings { merge_methods: vec![MergeMethod::SemiLinear], squash: SquashOption::Always, delete_source_branch: true });
        assert_eq!(json::settings(&json!({})), ForgeProjectSettings { merge_methods: vec![MergeMethod::Merge], squash: SquashOption::DefaultOff, delete_source_branch: false });
    }

    #[test]
    fn the_api_scope_is_what_writes() {
        assert_eq!(json::token_write(&json!({"scopes": ["api", "read_user"]})), WriteAccess::Yes);
        assert_eq!(json::token_write(&json!({"scopes": ["read_api"]})), WriteAccess::No { missing: "api".into() });
    }

    #[test]
    fn strips_the_draft_prefix_and_maps_states() {
        assert_eq!(json::strip_draft("Draft: Explore"), "Explore");
        assert_eq!(json::strip_draft("[Draft] Explore"), "Explore");
        assert_eq!(json::strip_draft("WIP: Explore"), "Explore");
        assert_eq!(json::strip_draft("Drafting the plan"), "Drafting the plan");
        assert_eq!(json::mr_state("opened", true), Some(MrState::Draft));
        assert_eq!(json::mr_state("locked", false), Some(MrState::Closed));
        assert_eq!(json::mr_state("weird", false), None);
        let v = json!({"iid": 5, "title": "Draft: Explore", "draft": true, "state": "opened", "author": {"id": 7, "username": "ada", "name": "Ada"}, "source_branch": "x", "target_branch": "main", "sha": "abc", "labels": ["a"], "updated_at": "2026-10-04T12:00:00Z", "has_conflicts": true});
        let m = json::mr(&v, "group/project", "group/project").unwrap();
        assert_eq!((m.title.as_str(), m.state, m.conflicts, m.updated_at, m.labels.clone()), ("Explore", MrState::Draft, Some(true), 1_791_115_200, vec!["a".to_string()]));
    }

    #[test]
    fn an_mr_whose_description_has_gitbolts_stack_table_is_stacked() {
        let v = |d: serde_json::Value| json!({"iid": 5, "title": "t", "state": "opened", "author": {"id": 7, "username": "ada"}, "source_branch": "x", "target_branch": "main", "web_url": "u", "description": d});
        assert!(json::mr(&v("Intro\n\n<!-- gitbolt-stack:start -->\n| table |\n<!-- gitbolt-stack:end -->".into()), "group/project", "group/project").unwrap().stacked);
        assert!(!json::mr(&v("Plain text".into()), "group/project", "group/project").unwrap().stacked);
        assert!(!json::mr(&v(serde_json::Value::Null), "group/project", "group/project").unwrap().stacked, "an MR with no description");
        assert!(json::created_mr(&v("<!-- gitbolt-stack:start -->\nT\n<!-- gitbolt-stack:end -->".into()), "group/project", "group/project").unwrap().stacked);
    }

    #[test]
    fn pipelines_merge_statuses_and_approvals() {
        assert_eq!(json::pipeline_status("waiting_for_resource"), Some(PipelineStatus::Pending));
        assert_eq!(json::pipeline_status("canceling"), Some(PipelineStatus::Canceled));
        let by = json::pipelines_by_sha(&json!([{"sha": "a", "status": "failed"}, {"sha": "a", "status": "success"}, {"sha": "b", "status": "manual", "web_url": "u"}]));
        assert_eq!(by["a"].status, PipelineStatus::Failed, "the newest of a commit's pipelines");
        assert_eq!(by["b"].web_url.as_deref(), Some("u"));
        let status = |s: &str| json::merge_status(&json!({"state": "opened", "detailed_merge_status": s}));
        assert_eq!(status("mergeable"), MergeStatus::Mergeable);
        assert_eq!(status("checking"), MergeStatus::Checking);
        assert_eq!(status("ci_must_pass"), MergeStatus::Blocked { reason: "The pipeline must succeed first".into() });
        assert_eq!(status("something_new"), MergeStatus::Blocked { reason: "GitLab says: something new".into() });
        assert_eq!(json::merge_status(&json!({"state": "merged"})), MergeStatus::Blocked { reason: "It's merged already".into() });
        assert_eq!(json::merge_status(&json!({"state": "opened", "merge_status": "cannot_be_merged"})), MergeStatus::Blocked { reason: "It has conflicts: rebase or merge the target branch first".into() });
        let grace = json!({"user": {"id": 8, "username": "grace", "name": "Grace"}});
        let r = json::review(&json!({"detailed_merge_status": "not_approved"}), Some(&json!({"approved_by": [grace.clone()], "approvals_required": 2})));
        assert_eq!((r.decision, r.approvals, r.approvals_required), (ReviewDecision::ReviewRequired, 1, Some(2)));
        assert_eq!(json::review(&json!({}), Some(&json!({"approved_by": [grace], "approvals_required": 0}))).decision, ReviewDecision::Approved);
        assert_eq!(json::review(&json!({"detailed_merge_status": "requested_changes"}), None).decision, ReviewDecision::ChangesRequested);
    }

    #[test]
    fn a_snippet_ends_at_the_commented_line() {
        let diff = "@@ -1,4 +1,5 @@\n one\n-two\n+zwei\n+drei\n three\n";
        assert_eq!(json::snippet(diff, Some(3), None).as_deref(), Some("-two\n+zwei\n+drei"));
        assert_eq!(json::snippet(diff, None, Some(2)).as_deref(), Some(" one\n-two"));
        assert_eq!(json::snippet(diff, Some(4), None).as_deref(), Some("+zwei\n+drei\n three"));
        assert_eq!(json::snippet(diff, Some(40), None), None);
        assert_eq!(json::snippet("@@ -10,2 +12,2 @@\n a\n+b\n", Some(13), None).as_deref(), Some(" a\n+b"));
    }

    #[test]
    fn a_branchs_mr_is_its_open_one_else_the_newest() {
        let v = |iid: u64, state: &str, at: &str| json::mr(&json!({"iid": iid, "title": "t", "state": state, "author": {"id": 1, "username": "a"}, "source_branch": "x", "target_branch": "main", "updated_at": at}), "p", "p").unwrap();
        let picked = json::pick_for_branch(vec![v(1, "merged", "2026-10-04T00:00:00Z"), v(2, "opened", "2026-01-01T00:00:00Z")]).unwrap();
        assert_eq!(picked.number, 2);
        assert_eq!(json::pick_for_branch(vec![v(1, "merged", "2026-10-04T00:00:00Z"), v(3, "closed", "2026-10-05T00:00:00Z")]).unwrap().number, 3);
        assert!(json::pick_for_branch(vec![]).is_none());
    }
    // --- end 4B T2 ---
    // --- 4C T3 ---
    #[test]
    fn a_draft_is_a_title_prefix_never_doubled() {
        assert_eq!(json::draft_title("Add login", true), "Draft: Add login");
        assert_eq!(json::draft_title(" [Draft] Add login ", true), "[Draft] Add login");
        assert_eq!(json::draft_title("Draft: x", false), "Draft: x");
        assert_eq!(json::draft_title("Add login ", false), "Add login");
    }

    #[test]
    fn the_create_body_names_the_target_only_for_a_fork_and_squash_only_when_set() {
        let req = CreateMr {
            source: SourceRef { project: "alice/project".into(), branch: "feature".into() }, target_branch: "main".into(), title: "Add login".into(),
            description: "Why.".into(), draft: false, reviewers: vec![8], assignees: vec![7], labels: vec!["bug".into(), "ui".into()], squash: None, delete_source_branch: Some(true),
        };
        assert_eq!(
            json::create_body(&req, 77, 42),
            json!({"source_branch": "feature", "target_branch": "main", "title": "Add login", "description": "Why.", "assignee_ids": [7], "reviewer_ids": [8], "labels": ["bug", "ui"], "target_project_id": 42, "remove_source_branch": true})
        );
        assert!(json::create_body(&req, 42, 42).get("target_project_id").is_none());
        assert_eq!(json::create_body(&CreateMr { squash: Some(false), ..req }, 42, 42)["squash"], false);
    }

    #[test]
    fn a_created_mr_normalizes_with_the_paths_it_was_made_with() {
        let v = json!({
            "iid": 3, "title": "Draft: Add login", "state": "opened", "draft": true, "author": {"id": 7, "username": "ada", "name": "Ada"},
            "source_branch": "feature", "target_branch": "main", "sha": "abc", "web_url": "https://g/group/project/-/merge_requests/3",
            "labels": ["bug"], "has_conflicts": false, "updated_at": "2026-10-04T12:00:00Z"
        });
        let mr = json::created_mr(&v, "alice/project", "group/project").unwrap();
        assert_eq!((mr.number, mr.state, mr.source_project.as_str(), mr.target_project.as_str()), (3, MrState::Draft, "alice/project", "group/project"));
        assert_eq!((mr.labels, mr.conflicts, mr.updated_at, mr.head_sha.as_deref()), (vec!["bug".to_string()], Some(false), 1_791_115_200, Some("abc")));
        assert_eq!(mr.review.decision, ReviewDecision::None);
        assert_eq!(json::label(&json!({"name": "bug", "color": "#d9534f", "description": ""})), Some(ForgeLabel { name: "bug".into(), color: Some("#d9534f".into()), description: None }));
    }
    // --- end 4C T3 ---
}
