//! GitLab REST v4 (spec #4 §3.1): identity, projects, settings, forks, avatars. 4B–4D add the
//! merge request methods to this impl, in their marked blocks.

use crate::avatar_cache::{payload_of, DiskAvatarCache, Lookup};
use crate::endpoints::HostEndpoints;
use crate::http::{encode_component, under, ClientConfig, HttpClient, HttpResponse};
use crate::time::unix_now;
use gitbolt_core::avatar::AvatarPayload;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

pub const FORKS_PER_PAGE: u32 = 100;
pub const FORK_PAGES: usize = 3;

pub struct GitLabProvider {
    host: String,
    web: String,
    http: HttpClient,
    avatars: Option<Arc<DiskAvatarCache>>,
}

impl GitLabProvider {
    pub fn new(host: &str, endpoints: &HostEndpoints, token: Secret, avatars: Option<Arc<DiskAvatarCache>>) -> Self {
        let http = HttpClient::new(ClientConfig { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), token: Some(token), headers: Vec::new(), timeout: Duration::from_secs(20) });
        Self { host: host.into(), web: endpoints.web.trim_end_matches('/').into(), http, avatars }
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
}

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
    // --- end 4B ---
}

#[cfg(test)]
mod tests {
    use super::json;
    use gitbolt_core::forge::*;
    use serde_json::json;

    #[test]
    fn normalizes_a_user_preferring_the_public_email() {
        let u = json::user(&json!({"id": 7, "username": "ada", "name": "", "avatar_url": "https://g/a.png", "web_url": "https://g/ada", "public_email": "", "email": "ada@corp.example"})).unwrap();
        assert_eq!(u, ForgeUser { id: 7, username: "ada".into(), name: "ada".into(), avatar_url: Some("https://g/a.png".into()), web_url: "https://g/ada".into(), email: Some("ada@corp.example".into()) });
        assert!(json::user(&json!({"id": 7})).is_none());
    }

    #[test]
    fn normalizes_a_fork_and_its_settings() {
        let v = json!({
            "id": 77, "name": "project", "path_with_namespace": "alice/project", "namespace": {"full_path": "alice"},
            "web_url": "https://g/alice/project", "default_branch": "main", "http_url_to_repo": "https://g/alice/project.git",
            "ssh_url_to_repo": "git@g:alice/project.git", "forked_from_project": {"path_with_namespace": "group/project"},
            "last_activity_at": "2026-10-04T12:00:00.000Z", "archived": false,
            "merge_method": "rebase_merge", "squash_option": "always", "remove_source_branch_after_merge": true
        });
        let p = json::project("g", &v).unwrap();
        assert_eq!((p.kind, p.id, p.owner.as_str(), p.fork_of.as_deref(), p.updated_at), (ForgeKind::GitLab, 77, "alice", Some("group/project"), Some(1_791_115_200)));
        assert_eq!(json::settings(&v), ForgeProjectSettings { merge_methods: vec![MergeMethod::SemiLinear], squash: SquashOption::Always, delete_source_branch: true });
        assert_eq!(json::settings(&json!({})), ForgeProjectSettings { merge_methods: vec![MergeMethod::Merge], squash: SquashOption::DefaultOff, delete_source_branch: false });
    }

    #[test]
    fn the_api_scope_is_what_writes() {
        assert_eq!(json::token_write(&json!({"scopes": ["api", "read_user"]})), WriteAccess::Yes);
        assert_eq!(json::token_write(&json!({"scopes": ["read_api"]})), WriteAccess::No { missing: "api".into() });
    }
}
