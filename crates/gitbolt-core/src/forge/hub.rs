//! The forge hub (spec #4 §3.2, §3.3):
//! - the active profile's accounts;
//! - a provider per account, built from the token store on first use and kept until the account
//!   changes;
//! - each account's last known status.
//!
//! 4A T6 adds the remote → project mapping and forge avatars.

use crate::error::{ErrorDetail, GbError, GbErrorKind};
use crate::forge::accounts::{check_kind_host, normalize_host, AccountStatus, ForgeAccount, ForgeAccountView};
use crate::forge::{AccountKey, ForgeConnector, ForgeKind, ForgeProvider, TokenStore, WriteAccess};
use crate::journal::Clock;
use crate::redact::Secret;
use crate::settings::{Profile, SettingsStore};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// GitLab's version is read again once it's this old (spec #4 §3.2: "refreshed daily").
pub const VERSION_MAX_AGE_SECS: i64 = 24 * 3600;

pub struct ForgeHub {
    connector: Arc<dyn ForgeConnector>,
    tokens: Arc<dyn TokenStore>,
    providers: Mutex<HashMap<AccountKey, Arc<dyn ForgeProvider>>>,
    status: Mutex<HashMap<AccountKey, AccountStatus>>,
    /// Unix milliseconds (`journal::Clock`).
    clock: Clock,
    // --- 4A T6 ---
    /// Projects by (host, path), until a refresh or the account changes (spec #4 §3.3).
    projects: Mutex<HashMap<(String, String), crate::forge::ForgeProject>>,
    // --- end 4A T6 ---
}

impl ForgeHub {
    pub fn new(connector: Arc<dyn ForgeConnector>, tokens: Arc<dyn TokenStore>, clock: Clock) -> Self {
        Self {
            connector,
            tokens,
            providers: Mutex::default(),
            status: Mutex::default(),
            clock,
            // --- 4A T6 ---
            projects: Mutex::default(),
            // --- end 4A T6 ---
        }
    }

    fn now(&self) -> i64 {
        (self.clock)() / 1000
    }

    pub fn key(profile: &str, host: &str) -> AccountKey {
        AccountKey { profile: profile.to_string(), host: host.to_string() }
    }

    /// The active profile's accounts, with what their last requests said (no request now).
    pub fn accounts(&self, store: &SettingsStore) -> Vec<ForgeAccountView> {
        let profile = store.active_profile();
        let now = self.now();
        profile
            .forge_accounts
            .iter()
            .map(|a| {
                let key = Self::key(&profile.id, &a.host);
                let limited = self.providers.lock().expect("providers poisoned").get(&key).and_then(|p| p.rate_limit().limited_until).filter(|u| *u > now);
                let status = match limited {
                    Some(until) => AccountStatus::RateLimited { until },
                    None => self.status.lock().expect("status poisoned").get(&key).cloned().filter(|s| !matches!(s, AccountStatus::RateLimited { until } if *until <= now)).unwrap_or(AccountStatus::Ok),
                };
                ForgeAccountView { account: a.clone(), status }
            })
            .collect()
    }

    /// Checks `token` against `host` and keeps it (spec #4 §3.2): the token's user, its write
    /// scope, GitLab's version. A host that has an account gets the new token instead.
    pub async fn add_account(&self, store: &Arc<SettingsStore>, host: &str, kind: ForgeKind, token: Secret) -> Result<ForgeAccountView, GbError> {
        let host = normalize_host(host)?;
        check_kind_host(kind, &host)?;
        let token = token.trimmed();
        if token.is_empty() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Paste a token first"));
        }
        let provider = self.connector.connect(kind, &host, token.clone())?;
        let check = provider.check_token().await.map_err(|e| match e.kind {
            GbErrorKind::AuthFailed => GbError::new(GbErrorKind::AuthFailed, format!("{host} rejected this token: check that you copied all of it")),
            _ => e,
        })?;
        if let WriteAccess::No { missing } = &check.write {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("This token can't make changes: create one with the {missing} scope")));
        }
        let version = match kind {
            ForgeKind::GitLab => provider.version().await.ok().flatten(),
            ForgeKind::GitHub => None,
        };
        let profile = store.active_profile();
        let key = Self::key(&profile.id, &host);
        let (tokens, k, t) = (self.tokens.clone(), key.clone(), token.clone());
        let storage = crate::api::blocking(move || tokens.put(&k, &t)).await?;
        let now = self.now();
        let account = ForgeAccount { host: host.clone(), kind, user: check.user, storage, version, version_checked_at: now, added_at: now };
        let mut accounts = store.forge_accounts(&profile.id);
        accounts.retain(|a| a.host != host);
        accounts.push(account.clone());
        store.set_forge_accounts(&profile.id, accounts)?;
        self.drop_host(&key);
        self.providers.lock().expect("providers poisoned").insert(key.clone(), provider);
        self.status.lock().expect("status poisoned").insert(key, AccountStatus::Ok);
        Ok(ForgeAccountView { account, status: AccountStatus::Ok })
    }

    pub async fn remove_account(&self, store: &Arc<SettingsStore>, host: &str) -> Result<(), GbError> {
        let host = normalize_host(host)?;
        let profile = store.active_profile();
        if !profile.forge_accounts.iter().any(|a| a.host == host) {
            return Err(no_account(&host));
        }
        let key = Self::key(&profile.id, &host);
        let (tokens, k) = (self.tokens.clone(), key.clone());
        crate::api::blocking(move || tokens.delete(&k)).await?;
        store.set_forge_accounts(&profile.id, profile.forge_accounts.into_iter().filter(|a| a.host != host).collect())?;
        self.drop_host(&key);
        Ok(())
    }

    /// A deleted profile's tokens (spec #4 §6: no secret outlives its account). Best effort.
    pub async fn forget_profile(&self, profile: &Profile) {
        for a in &profile.forge_accounts {
            let key = Self::key(&profile.id, &a.host);
            let (tokens, k) = (self.tokens.clone(), key.clone());
            if let Err(e) = crate::api::blocking(move || tokens.delete(&k)).await {
                tracing::warn!("forge token for {} not deleted with its profile: {}", a.host, e.message);
            }
            self.drop_host(&key);
        }
    }

    /// The account for `host` in the active profile and its provider; `Ok(None)` without one.
    pub async fn provider_for_host(&self, store: &Arc<SettingsStore>, host: &str) -> Result<Option<(ForgeAccount, Arc<dyn ForgeProvider>)>, GbError> {
        let profile = store.active_profile();
        let Some(account) = profile.forge_accounts.iter().find(|a| a.host == host).cloned() else { return Ok(None) };
        let key = Self::key(&profile.id, host);
        if let Some(p) = self.providers.lock().expect("providers poisoned").get(&key).cloned() {
            return Ok(Some((account, p)));
        }
        let (tokens, k, storage) = (self.tokens.clone(), key.clone(), account.storage);
        let Some(token) = crate::api::blocking(move || tokens.get(&k, storage)).await? else {
            self.status.lock().expect("status poisoned").insert(key, AccountStatus::TokenMissing);
            return Err(GbError::new(GbErrorKind::AuthFailed, format!("The token for {host} is missing: add the account again in Settings › Accounts")));
        };
        let provider = self.connector.connect(account.kind, host, token)?;
        self.providers.lock().expect("providers poisoned").insert(key, provider.clone());
        let account = self.refresh_version(store, &profile.id, account, &provider).await;
        Ok(Some((account, provider)))
    }

    /// GitLab's version, once it's a day old (best effort: a failure keeps the old one).
    async fn refresh_version(&self, store: &Arc<SettingsStore>, profile: &str, mut account: ForgeAccount, provider: &Arc<dyn ForgeProvider>) -> ForgeAccount {
        if account.kind != ForgeKind::GitLab || self.now() - account.version_checked_at <= VERSION_MAX_AGE_SECS {
            return account;
        }
        if let Ok(version) = provider.version().await {
            account.version = version;
            account.version_checked_at = self.now();
            let mut accounts = store.forge_accounts(profile);
            if let Some(a) = accounts.iter_mut().find(|a| a.host == account.host) {
                *a = account.clone();
            }
            let _ = store.set_forge_accounts(profile, accounts);
        }
        account
    }

    /// Notes what a provider call said about its account: auth, reachability, rate limit.
    /// Anything else (a project not found) says nothing about the account.
    pub fn record<T>(&self, key: &AccountKey, result: &Result<T, GbError>) {
        let status = match result {
            Ok(_) => AccountStatus::Ok,
            Err(e) => match (e.kind, &e.detail) {
                (GbErrorKind::AuthFailed, _) => AccountStatus::AuthFailed { message: e.message.clone() },
                (GbErrorKind::Network, _) => AccountStatus::Unreachable { message: e.message.clone() },
                (GbErrorKind::RateLimited, Some(ErrorDetail::RateLimited { until })) => AccountStatus::RateLimited { until: *until },
                _ => return,
            },
        };
        self.status.lock().expect("status poisoned").insert(key.clone(), status);
    }

    /// Harness reset: every cached provider, status and project.
    pub fn reset(&self) {
        self.providers.lock().expect("providers poisoned").clear();
        self.status.lock().expect("status poisoned").clear();
        // --- 4A T6 ---
        self.projects.lock().expect("projects poisoned").clear();
        // --- end 4A T6 ---
    }

    fn drop_host(&self, key: &AccountKey) {
        self.providers.lock().expect("providers poisoned").remove(key);
        self.status.lock().expect("status poisoned").remove(key);
        // --- 4A T6 ---
        self.projects.lock().expect("projects poisoned").retain(|(h, _), _| h != &key.host);
        // --- end 4A T6 ---
    }
}

pub(crate) fn no_account(host: &str) -> GbError {
    GbError::new(GbErrorKind::NotFound, format!("No account for {host}: add one in Settings › Accounts"))
}

// --- 4A T6: remotes → projects (spec #4 §3.3), forks, settings, avatars ---
use crate::avatar::AvatarPayload;
use crate::forge::{ForgeProject, ForgeProjectSettings};
use crate::payload::RemotePayload;
use serde::Serialize;
use ts_rs::TS;

/// One remote and the forge project behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteProject {
    pub remote: String,
    pub host: Option<String>,
    pub path: Option<String>,
    /// The kind of the profile's account for `host`; `None` without one.
    pub account: Option<ForgeKind>,
    pub project: Option<ForgeProject>,
    /// Why there's no project although there's an account (not found, rejected, unreachable).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoProjects {
    pub remotes: Vec<RemoteProject>,
    /// The remote whose project the repo's MRs/PRs target (`target_remote`).
    pub target: Option<String>,
}

impl RepoProjects {
    /// Every remote, none mapped (a build without forges).
    pub fn without_accounts(remotes: &[RemotePayload]) -> Self {
        Self { remotes: remotes.iter().map(|r| RemoteProject { remote: r.name.clone(), host: r.host.clone(), path: r.path.clone(), account: None, project: None, error: None }).collect(), target: None }
    }
}

/// Spec #4 §3.3: origin's project, unless it's a fork of another remote's project (origin is
/// the user's fork, `upstream` the project): then that remote's. Without origin, the first mapped.
pub fn target_remote(list: &[RemoteProject]) -> Option<String> {
    let mapped: Vec<&RemoteProject> = list.iter().filter(|r| r.project.is_some()).collect();
    let first = mapped.iter().find(|r| r.remote == "origin").or(mapped.first())?;
    let project = first.project.as_ref()?;
    if let Some(parent) = &project.fork_of
        && let Some(up) = mapped.iter().find(|r| r.project.as_ref().is_some_and(|p| &p.path == parent && p.host == project.host))
    {
        return Some(up.remote.clone());
    }
    Some(first.remote.clone())
}

impl ForgeHub {
    /// The project at `path` on `host` with its provider; `Ok(None)` without an account.
    async fn project_on(&self, store: &Arc<SettingsStore>, host: &str, path: &str, refresh: bool) -> Result<Option<(Arc<dyn ForgeProvider>, ForgeProject)>, GbError> {
        let Some((_, provider)) = self.provider_for_host(store, host).await? else { return Ok(None) };
        let cache_key = (host.to_string(), path.to_string());
        if !refresh && let Some(p) = self.projects.lock().expect("projects poisoned").get(&cache_key).cloned() {
            return Ok(Some((provider, p)));
        }
        let key = Self::key(&store.active_profile().id, host);
        let result = provider.project(path).await;
        self.record(&key, &result);
        let project = result?.value;
        self.projects.lock().expect("projects poisoned").insert(cache_key, project.clone());
        Ok(Some((provider, project)))
    }

    /// Every remote with its project (spec #4 §3.3). `refresh` asks the forge again (a cheap
    /// conditional request); otherwise a project seen this session answers from memory.
    pub async fn repo_projects(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], refresh: bool) -> RepoProjects {
        let accounts = store.active_profile().forge_accounts;
        let mut out = Vec::with_capacity(remotes.len());
        for r in remotes {
            let mut rp = RemoteProject { remote: r.name.clone(), host: r.host.clone(), path: r.path.clone(), account: None, project: None, error: None };
            if let (Some(host), Some(path)) = (&r.host, &r.path) {
                rp.account = accounts.iter().find(|a| &a.host == host).map(|a| a.kind);
                if rp.account.is_some() {
                    match self.project_on(store, host, path, refresh).await {
                        Ok(found) => rp.project = found.map(|(_, p)| p),
                        Err(e) => rp.error = Some(e.message),
                    }
                }
            }
            out.push(rp);
        }
        let target = target_remote(&out);
        RepoProjects { remotes: out, target }
    }

    /// `remote`'s project and the provider to ask about it (4B's door to MRs).
    pub async fn project_for_remote(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], remote: &str) -> Result<(AccountKey, Arc<dyn ForgeProvider>, ForgeProject), GbError> {
        let r = remotes.iter().find(|r| r.name == remote).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("No remote {remote}")))?;
        let (Some(host), Some(path)) = (&r.host, &r.path) else {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{remote} isn't on a forge")));
        };
        let (provider, project) = self.project_on(store, host, path, false).await?.ok_or_else(|| no_account(host))?;
        Ok((Self::key(&store.active_profile().id, host), provider, project))
    }

    /// `remote`'s project's forks, newest activity first, each naming its parent.
    pub async fn forks(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], remote: &str) -> Result<Vec<ForgeProject>, GbError> {
        let (key, provider, project) = self.project_for_remote(store, remotes, remote).await?;
        let result = provider.forks(&project).await;
        self.record(&key, &result);
        let mut forks = result?;
        for f in &mut forks {
            f.fork_of.get_or_insert_with(|| project.path.clone());
        }
        forks.sort_by_key(|f| std::cmp::Reverse(f.updated_at));
        Ok(forks)
    }

    pub async fn project_settings(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], remote: &str) -> Result<ForgeProjectSettings, GbError> {
        let (key, provider, project) = self.project_for_remote(store, remotes, remote).await?;
        let result = provider.project_settings(&project).await;
        self.record(&key, &result);
        result
    }

    /// The first avatar any of the active profile's accounts has for `email` (spec #4 §2
    /// "Avatars": forge first). Failures are quiet: Gravatar, then initials, come next.
    pub async fn avatar(&self, store: &Arc<SettingsStore>, email: &str) -> Option<AvatarPayload> {
        if email.trim().is_empty() {
            return None;
        }
        let hosts: Vec<String> = store.active_profile().forge_accounts.iter().map(|a| a.host.clone()).collect();
        for host in hosts {
            let Ok(Some((_, provider))) = self.provider_for_host(store, &host).await else { continue };
            match provider.avatar_for_email(email).await {
                Ok(Some(found)) => return Some(found),
                Ok(None) => {}
                Err(e) => tracing::debug!("forge avatar from {host}: {}", e.message),
            }
        }
        None
    }
}
// --- end 4A T6 ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::fake::*;
    use crate::forge::TokenStorage;

    pub(crate) const TOKEN: &str = "glpat-FAKE-test-token";
    pub(crate) const TOKEN2: &str = "glpat-FAKE-test-token-2";
    pub(crate) const HOST: &str = "gitlab.example.com";
    /// 2026-10-04T12:00:00Z, in ms (the hub's clock is `journal::Clock`).
    pub(crate) const NOW_MS: i64 = 1_791_115_200_000;

    pub(crate) fn hub(conn: Arc<FakeConnector>, tokens: Arc<MemTokens>) -> ForgeHub {
        ForgeHub::new(conn, tokens, Arc::new(|| NOW_MS))
    }

    fn setup(storage: TokenStorage) -> (Arc<FakeConnector>, Arc<MemTokens>, ForgeHub, Arc<SettingsStore>) {
        let conn = FakeConnector::with(TOKEN, FakeProvider::new(ForgeKind::GitLab, HOST));
        let tokens = MemTokens::new(storage);
        let h = hub(conn.clone(), tokens.clone());
        (conn, tokens, h, SettingsStore::in_memory())
    }

    #[tokio::test]
    async fn adding_an_account_checks_the_token_and_keeps_it_out_of_the_profile() {
        let (_, tokens, hub, store) = setup(TokenStorage::Keyring);
        let view = hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        assert_eq!(view.account.user.name, "Ada");
        assert_eq!((view.account.storage, view.account.version.as_deref()), (TokenStorage::Keyring, Some("18.9.1-ee")));
        assert_eq!((view.account.added_at, view.account.version_checked_at), (NOW_MS / 1000, NOW_MS / 1000));
        assert_eq!(view.status, AccountStatus::Ok);
        assert_eq!(tokens.token("default", HOST).as_deref(), Some(TOKEN));
        let profile_json = serde_json::to_string(&store.active_profile()).unwrap();
        assert!(profile_json.contains(HOST) && !profile_json.contains(TOKEN), "{profile_json}");
        assert_eq!(hub.accounts(&store), vec![view]);
    }

    #[tokio::test]
    async fn a_pasted_token_is_trimmed_and_an_empty_one_refused() {
        let (conn, tokens, hub, store) = setup(TokenStorage::Keyring);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(format!("  {TOKEN}\n"))).await.unwrap();
        assert_eq!(tokens.token("default", HOST).as_deref(), Some(TOKEN));
        let before = conn.connects.load(std::sync::atomic::Ordering::SeqCst);
        let e = hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(" \n")).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "Paste a token first"));
        assert_eq!(conn.connects.load(std::sync::atomic::Ordering::SeqCst), before, "nothing was sent anywhere");
    }

    #[tokio::test]
    async fn a_rejected_token_adds_nothing_and_says_so_without_the_token() {
        let (_, tokens, hub, store) = setup(TokenStorage::Keyring);
        let e = hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new("glpat-FAKE-wrong-token")).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::AuthFailed, "gitlab.example.com rejected this token: check that you copied all of it"));
        assert!(hub.accounts(&store).is_empty());
        assert!(tokens.map.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_token_that_cant_write_is_refused_with_the_scope_to_add() {
        let conn = FakeConnector::with(TOKEN, FakeProvider { write: WriteAccess::No { missing: "api".into() }, ..FakeProvider::new(ForgeKind::GitLab, HOST) });
        let tokens = MemTokens::new(TokenStorage::Keyring);
        let (hub, store) = (hub(conn, tokens.clone()), SettingsStore::in_memory());
        let e = hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "This token can't make changes: create one with the api scope"));
        assert!(tokens.map.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn re_adding_a_host_replaces_its_token_and_provider() {
        let (conn, tokens, hub, store) = setup(TokenStorage::Keyring);
        conn.add(TOKEN2, FakeProvider { user: user("Grace"), ..FakeProvider::new(ForgeKind::GitLab, HOST) });
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        let (_, first) = hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(first.current_user().await.unwrap().name, "Ada");
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN2)).await.unwrap();
        let accounts = hub.accounts(&store);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account.user.name, "Grace");
        assert_eq!(tokens.token("default", HOST).as_deref(), Some(TOKEN2));
        let (_, now) = hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(now.current_user().await.unwrap().name, "Grace", "the old token's provider is gone");
    }

    #[tokio::test]
    async fn ui_profile_saves_never_drop_the_accounts() {
        let (_, _, hub, store) = setup(TokenStorage::Keyring);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        // What the UI sends: its own copy of the profile, which has no `forgeAccounts` (#[ts(skip)]).
        let mut sent: serde_json::Value = serde_json::to_value(store.active_profile()).unwrap();
        sent.as_object_mut().unwrap().remove("forgeAccounts");
        sent["name"] = "Work".into();
        store.save_profile(serde_json::from_value(sent).unwrap()).unwrap();
        assert_eq!(store.active_profile().name, "Work");
        assert_eq!(store.active_profile().forge_accounts.len(), 1);
    }

    #[tokio::test]
    async fn removing_an_account_deletes_its_token_and_provider() {
        let (_, tokens, hub, store) = setup(TokenStorage::Keyring);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        hub.remove_account(&store, "https://gitlab.example.com/").await.unwrap();
        assert!(hub.accounts(&store).is_empty());
        assert!(tokens.map.lock().unwrap().is_empty());
        assert!(hub.provider_for_host(&store, HOST).await.unwrap().is_none());
        let e = hub.remove_account(&store, HOST).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "No account for gitlab.example.com: add one in Settings › Accounts"));
    }

    #[tokio::test]
    async fn a_missing_token_says_to_add_the_account_again() {
        let (_, tokens, hub, store) = setup(TokenStorage::File);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        tokens.map.lock().unwrap().clear();
        hub.reset();
        let e = hub.provider_for_host(&store, HOST).await.err().unwrap();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::AuthFailed, "The token for gitlab.example.com is missing: add the account again in Settings › Accounts"));
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::TokenMissing);
        assert_eq!(hub.accounts(&store)[0].account.storage, TokenStorage::File);
    }

    #[tokio::test]
    async fn a_rate_limited_account_says_until_when() {
        let (conn, _, hub, store) = setup(TokenStorage::Keyring);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        let p = conn.by_token.lock().unwrap()[TOKEN].clone();
        *p.limited_until.lock().unwrap() = Some(NOW_MS / 1000 + 300);
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::RateLimited { until: NOW_MS / 1000 + 300 });
        *p.limited_until.lock().unwrap() = Some(NOW_MS / 1000 - 1);
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::Ok, "a limit in the past is over");
        let key = ForgeHub::key("default", HOST);
        hub.record::<()>(&key, &Err(GbError::new(GbErrorKind::Network, "Couldn't reach gitlab.example.com: timed out")));
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::Unreachable { message: "Couldn't reach gitlab.example.com: timed out".into() });
        hub.record::<()>(&key, &Err(GbError::new(GbErrorKind::NotFound, "Not found on gitlab.example.com")));
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::Unreachable { message: "Couldn't reach gitlab.example.com: timed out".into() }, "a missing project says nothing about the account");
        hub.record(&key, &Ok(()));
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::Ok);
    }

    #[tokio::test]
    async fn gitlabs_version_is_read_again_once_a_day() {
        let (conn, _, hub, store) = setup(TokenStorage::Keyring);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        let mut accounts = store.forge_accounts("default");
        accounts[0].version = Some("18.0.0".into());
        accounts[0].version_checked_at = NOW_MS / 1000 - VERSION_MAX_AGE_SECS - 1;
        store.set_forge_accounts("default", accounts).unwrap();
        hub.reset();
        hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        let a = &store.forge_accounts("default")[0];
        assert_eq!((a.version.as_deref(), a.version_checked_at), (Some("18.9.1-ee"), NOW_MS / 1000));
        let versions = conn.by_token.lock().unwrap()[TOKEN].calls().iter().filter(|c| *c == "version").count();
        hub.reset();
        hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(conn.by_token.lock().unwrap()[TOKEN].calls().iter().filter(|c| *c == "version").count(), versions, "fresh: not asked again");
    }

    // --- 4A T6 ---
    use crate::forge::{ForgeProject, ForgeProjectSettings, MergeMethod, SquashOption};
    use crate::payload::RemotePayload;
    use crate::remotes::HostKind;

    fn remote(name: &str, host: Option<&str>, path: Option<&str>) -> RemotePayload {
        RemotePayload { name: name.into(), host: host.map(str::to_string), path: path.map(str::to_string), host_kind: HostKind::GitLab }
    }

    async fn mapped() -> (Arc<FakeConnector>, ForgeHub, Arc<SettingsStore>) {
        let p = FakeProvider {
            forks: vec![project(HOST, "bob/project", None, 100), project(HOST, "alice/project", None, 300)],
            settings: Some(ForgeProjectSettings { merge_methods: vec![MergeMethod::Merge], squash: SquashOption::DefaultOn, delete_source_branch: true }),
            ..FakeProvider::new(ForgeKind::GitLab, HOST)
        };
        p.projects.lock().unwrap().insert("group/project".into(), project(HOST, "group/project", None, 200));
        p.projects.lock().unwrap().insert("ada/project".into(), project(HOST, "ada/project", Some("group/project"), 250));
        let conn = FakeConnector::with(TOKEN, p);
        let h = hub(conn.clone(), MemTokens::new(TokenStorage::Keyring));
        let store = SettingsStore::in_memory();
        h.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        (conn, h, store)
    }

    #[tokio::test]
    async fn remotes_map_to_projects_and_a_forks_parent_is_the_target() {
        let (_, hub, store) = mapped().await;
        let remotes = [remote("origin", Some(HOST), Some("ada/project")), remote("upstream", Some(HOST), Some("group/project")), remote("backup", None, None), remote("gh", Some("github.com"), Some("o/r"))];
        let rp = hub.repo_projects(&store, &remotes, false).await;
        assert_eq!(rp.remotes[0].project.as_ref().unwrap().fork_of.as_deref(), Some("group/project"));
        assert_eq!(rp.remotes[0].account, Some(ForgeKind::GitLab));
        assert_eq!(rp.remotes[1].project.as_ref().unwrap().path, "group/project");
        assert_eq!((rp.remotes[2].account, rp.remotes[2].project.is_none()), (None, true));
        assert_eq!((rp.remotes[3].account, rp.remotes[3].error.is_none(), rp.remotes[3].project.is_none()), (None, true, true), "no account for github.com: nothing asked");
        assert_eq!(rp.target.as_deref(), Some("upstream"));
    }

    #[test]
    fn the_target_is_origin_unless_it_forks_another_remotes_project() {
        let rp = |remote: &str, p: Option<ForgeProject>| RemoteProject { remote: remote.into(), host: Some(HOST.into()), path: p.as_ref().map(|p| p.path.clone()), account: Some(ForgeKind::GitLab), project: p, error: None };
        assert_eq!(target_remote(&[rp("origin", Some(project(HOST, "group/project", None, 1))), rp("fork", Some(project(HOST, "me/project", Some("group/project"), 1)))]).as_deref(), Some("origin"));
        assert_eq!(target_remote(&[rp("origin", Some(project(HOST, "me/project", Some("group/project"), 1)))]).as_deref(), Some("origin"), "the parent isn't a remote here");
        assert_eq!(target_remote(&[rp("origin", None), rp("work", Some(project(HOST, "group/project", None, 1)))]).as_deref(), Some("work"));
        assert_eq!(target_remote(&[rp("origin", None)]), None);
    }

    #[tokio::test]
    async fn projects_are_cached_until_a_refresh_and_a_missing_one_says_why() {
        let (conn, hub, store) = mapped().await;
        let remotes = [remote("origin", Some(HOST), Some("group/project")), remote("gone", Some(HOST), Some("nobody/nothing"))];
        hub.repo_projects(&store, &remotes, false).await;
        let rp = hub.repo_projects(&store, &remotes, false).await;
        assert_eq!(rp.remotes[1].error.as_deref(), Some("Not found on gitlab.example.com"));
        assert_eq!(rp.remotes[1].account, Some(ForgeKind::GitLab));
        let p = conn.by_token.lock().unwrap()[TOKEN].clone();
        let asked = |path: &str| p.calls().iter().filter(|c| **c == format!("project {path}")).count();
        assert_eq!(asked("group/project"), 1, "cached");
        hub.repo_projects(&store, &remotes, true).await;
        assert_eq!(asked("group/project"), 2, "a refresh asks again");
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::Ok, "a missing project says nothing about the account");
    }

    #[tokio::test]
    async fn forks_come_newest_first_and_settings_come_from_the_project() {
        let (_, hub, store) = mapped().await;
        let remotes = [remote("origin", Some(HOST), Some("group/project")), remote("local", None, None)];
        let forks = hub.forks(&store, &remotes, "origin").await.unwrap();
        assert_eq!(forks.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["alice/project", "bob/project"]);
        assert!(forks.iter().all(|f| f.fork_of.as_deref() == Some("group/project")));
        assert_eq!(hub.project_settings(&store, &remotes, "origin").await.unwrap().squash, SquashOption::DefaultOn);
        assert_eq!(hub.forks(&store, &remotes, "local").await.unwrap_err().message, "local isn't on a forge");
        assert_eq!(hub.forks(&store, &remotes, "nope").await.unwrap_err().message, "No remote nope");
        let gh = [remote("origin", Some("github.com"), Some("o/r"))];
        assert_eq!(hub.forks(&store, &gh, "origin").await.unwrap_err().message, "No account for github.com: add one in Settings › Accounts");
    }
    // --- end 4A T6 ---
}
