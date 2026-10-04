//! Test doubles for the hub and the API: no network, no keyring.

use crate::avatar::AvatarPayload;
use crate::error::{GbError, GbErrorKind};
use crate::forge::*;
use crate::redact::Secret;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) fn user(name: &str) -> ForgeUser {
    let login = name.to_lowercase();
    ForgeUser { id: 1, username: login.clone(), name: name.into(), avatar_url: None, web_url: format!("https://gitlab.example.com/{login}"), email: Some(format!("{login}@example.com")) }
}

pub(crate) fn project(host: &str, path: &str, fork_of: Option<&str>, updated_at: i64) -> ForgeProject {
    let (owner, name) = path.rsplit_once('/').unwrap_or(("", path));
    ForgeProject {
        kind: ForgeKind::GitLab, id: updated_at as u64, host: host.into(), path: path.into(), name: name.into(), owner: owner.into(),
        web_url: format!("https://{host}/{path}"), default_branch: Some("main".into()), clone_https: format!("https://{host}/{path}.git"),
        clone_ssh: format!("git@{host}:{path}.git"), fork_of: fork_of.map(str::to_string), updated_at: Some(updated_at), archived: false,
    }
}

pub(crate) struct FakeProvider {
    pub kind: ForgeKind,
    pub host: String,
    /// Every token check and request fails with AuthFailed.
    pub reject: bool,
    pub user: ForgeUser,
    pub write: WriteAccess,
    pub version: Option<String>,
    pub projects: Mutex<HashMap<String, ForgeProject>>,
    pub forks: Vec<ForgeProject>,
    pub settings: Option<ForgeProjectSettings>,
    pub avatars: HashMap<String, AvatarPayload>,
    pub limited_until: Mutex<Option<i64>>,
    pub calls: Mutex<Vec<String>>,
}

impl FakeProvider {
    pub fn new(kind: ForgeKind, host: &str) -> Self {
        Self {
            kind, host: host.into(), reject: false, user: user("Ada"), write: WriteAccess::Yes, version: Some("18.9.1-ee".into()),
            projects: Mutex::default(), forks: Vec::new(), settings: None, avatars: HashMap::new(), limited_until: Mutex::new(None), calls: Mutex::default(),
        }
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn call(&self, what: impl Into<String>) {
        self.calls.lock().unwrap().push(what.into());
    }

    fn check(&self) -> Result<(), GbError> {
        if self.reject { Err(GbError::new(GbErrorKind::AuthFailed, format!("{} rejected the token: add the account again in Settings › Accounts", self.host))) } else { Ok(()) }
    }
}

impl ForgeProvider for FakeProvider {
    fn kind(&self) -> ForgeKind {
        self.kind
    }
    fn host(&self) -> &str {
        &self.host
    }
    fn rate_limit(&self) -> RateLimitState {
        RateLimitState { limited_until: *self.limited_until.lock().unwrap(), ..Default::default() }
    }
    fn check_token(&self) -> ForgeFuture<'_, TokenCheck> {
        self.call("check_token");
        Box::pin(async move {
            self.check()?;
            Ok(TokenCheck { user: self.user.clone(), write: self.write.clone() })
        })
    }
    fn current_user(&self) -> ForgeFuture<'_, ForgeUser> {
        self.call("current_user");
        Box::pin(async move {
            self.check()?;
            Ok(self.user.clone())
        })
    }
    fn version(&self) -> ForgeFuture<'_, Option<String>> {
        self.call("version");
        Box::pin(async move { Ok(self.version.clone()) })
    }
    fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> {
        self.call(format!("project {path}"));
        Box::pin(async move {
            self.check()?;
            self.projects.lock().unwrap().get(path).cloned().map(|p| Fresh::new(p, 1)).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host)))
        })
    }
    fn project_settings<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> {
        self.call(format!("settings {}", project.path));
        Box::pin(async move { self.settings.clone().ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host))) })
    }
    fn forks<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> {
        self.call(format!("forks {}", project.path));
        Box::pin(async move { Ok(self.forks.clone()) })
    }
    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        self.call(format!("avatar {email}"));
        Box::pin(async move { Ok(self.avatars.get(email).cloned()) })
    }
}

/// Hands out providers by token: a known token (for that host) gets its provider, any other a
/// rejecting one. Counts connects.
#[derive(Default)]
pub(crate) struct FakeConnector {
    pub by_token: Mutex<HashMap<String, Arc<FakeProvider>>>,
    pub connects: AtomicUsize,
}

impl FakeConnector {
    pub fn with(token: &str, p: FakeProvider) -> Arc<Self> {
        let c = Arc::new(Self::default());
        c.add(token, p);
        c
    }

    pub fn add(&self, token: &str, p: FakeProvider) -> Arc<FakeProvider> {
        let p = Arc::new(p);
        self.by_token.lock().unwrap().insert(token.into(), p.clone());
        p
    }
}

impl ForgeConnector for FakeConnector {
    fn connect(&self, kind: ForgeKind, host: &str, token: Secret) -> Result<Arc<dyn ForgeProvider>, GbError> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        let known = self.by_token.lock().unwrap().get(token.expose()).cloned().filter(|p| p.host == host);
        Ok(match known {
            Some(p) => p,
            None => Arc::new(FakeProvider { reject: true, ..FakeProvider::new(kind, host) }),
        })
    }
}

/// Tokens in memory. `put` answers `storage`.
pub(crate) struct MemTokens {
    pub map: Mutex<HashMap<AccountKey, String>>,
    pub storage: TokenStorage,
}

impl MemTokens {
    pub fn new(storage: TokenStorage) -> Arc<Self> {
        Arc::new(Self { map: Mutex::default(), storage })
    }

    pub fn token(&self, profile: &str, host: &str) -> Option<String> {
        self.map.lock().unwrap().get(&AccountKey { profile: profile.into(), host: host.into() }).cloned()
    }
}

impl TokenStore for MemTokens {
    fn put(&self, key: &AccountKey, token: &Secret) -> Result<TokenStorage, GbError> {
        self.map.lock().unwrap().insert(key.clone(), token.expose().to_string());
        Ok(self.storage)
    }
    fn get(&self, key: &AccountKey, _storage: TokenStorage) -> Result<Option<Secret>, GbError> {
        Ok(self.map.lock().unwrap().get(key).cloned().map(Secret::new))
    }
    fn delete(&self, key: &AccountKey) -> Result<(), GbError> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}
