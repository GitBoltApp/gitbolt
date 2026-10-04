//! GitHub REST (spec #4 §3.1): identity, repositories, settings, forks, avatars. GitHub has no
//! avatar-by-email API: an avatar comes from a noreply email's user id, or an email → avatar URL
//! learned from API data (`learn_avatar`). Never a user search by email (30 a minute, public
//! emails only). 4B–4D add the pull request methods, in their marked blocks.

use crate::avatar_cache::{payload_of, DiskAvatarCache, Lookup};
use crate::endpoints::HostEndpoints;
use crate::http::{encode_component, ClientConfig, HttpClient, HttpResponse};
use crate::time::unix_now;
use gitbolt_core::avatar::AvatarPayload;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::*;
use gitbolt_core::redact::Secret;
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
}

impl GitHubProvider {
    pub fn new(host: &str, endpoints: &HostEndpoints, token: Secret, cache: Option<Arc<DiskAvatarCache>>) -> Self {
        let http = HttpClient::new(ClientConfig { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), token: Some(token), headers: GITHUB_HEADERS.to_vec(), timeout: Duration::from_secs(20) });
        let avatars_base = endpoints.avatars.clone().unwrap_or_else(|| "https://avatars.githubusercontent.com".into()).trim_end_matches('/').to_string();
        Self { host: host.into(), api_base: endpoints.api.trim_end_matches('/').into(), avatars_base, http, cache, learned: Mutex::default() }
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
    // --- end 4B ---
}

#[cfg(test)]
mod tests {
    use super::{json, noreply_id};
    use gitbolt_core::forge::*;
    use serde_json::json;

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
}
