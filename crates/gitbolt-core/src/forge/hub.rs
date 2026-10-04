//! The forge hub (spec #4 §3.2, §3.3):
//! - the active profile's accounts;
//! - a provider per account, built from the token store on first use and kept until the account
//!   changes;
//! - each account's last known status.
//!
//! 4A T6 adds the remote → project mapping and forge avatars.

use crate::error::{ErrorDetail, GbError, GbErrorKind};
use crate::forge::accounts::{check_kind_host, normalize_host, AccountStatus, ForgeAccount, ForgeAccountView};
use crate::forge::{is_forbidden, AccountKey, ForgeConnector, ForgeKind, ForgeProvider, TokenStorage, TokenStore, WriteAccess};
use crate::journal::Clock;
use crate::redact::Secret;
use crate::settings::{Profile, SettingsStore};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// GitLab's version is read again once it's this old (spec #4 §3.2: "refreshed daily").
pub const VERSION_MAX_AGE_SECS: i64 = 24 * 3600;

/// A token read that failed, kept for the account record it was read for (`added_at`,
/// `storage`): a dismissed keyring prompt doesn't come back on every avatar.
struct FailedRead {
    added_at: i64,
    storage: TokenStorage,
    error: GbError,
}

pub struct ForgeHub {
    connector: Arc<dyn ForgeConnector>,
    tokens: Arc<dyn TokenStore>,
    providers: Mutex<HashMap<AccountKey, Arc<dyn ForgeProvider>>>,
    status: Mutex<HashMap<AccountKey, AccountStatus>>,
    /// One per account: held across a token read and the provider build (single flight), and
    /// across an add or remove.
    locks: Mutex<HashMap<AccountKey, Arc<tokio::sync::Mutex<()>>>>,
    failed: Mutex<HashMap<AccountKey, FailedRead>>,
    /// Unix milliseconds (`journal::Clock`).
    clock: Clock,
    // --- 4A T6 ---
    /// Projects by (profile, host, path), until a refresh or the account changes (spec #4 §3.3).
    projects: Mutex<HashMap<(String, String, String), crate::forge::ForgeProject>>,
    // --- end 4A T6 ---
}

impl ForgeHub {
    pub fn new(connector: Arc<dyn ForgeConnector>, tokens: Arc<dyn TokenStore>, clock: Clock) -> Self {
        Self {
            connector,
            tokens,
            providers: Mutex::default(),
            status: Mutex::default(),
            locks: Mutex::default(),
            failed: Mutex::default(),
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

    fn lock_for(&self, key: &AccountKey) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().expect("locks poisoned").entry(key.clone()).or_default().clone()
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
            // A 403: the token is good, its scope isn't.
            GbErrorKind::AuthFailed if is_forbidden(&e) => GbError::new(GbErrorKind::AuthFailed, format!("{host} accepted the token but it can't read your user: give it the api scope (GitLab) or read access (GitHub)")),
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
        let lock = self.lock_for(&key);
        let _held = lock.lock().await;
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
        let lock = self.lock_for(&key);
        let _held = lock.lock().await;
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
    /// The first use reads the token (once, however many ask at the same time); a read that
    /// failed answers the same until the account changes.
    pub async fn provider_for_host(&self, store: &Arc<SettingsStore>, host: &str) -> Result<Option<(ForgeAccount, Arc<dyn ForgeProvider>)>, GbError> {
        let profile = store.active_profile();
        let Some(account) = profile.forge_accounts.iter().find(|a| a.host == host).cloned() else { return Ok(None) };
        let key = Self::key(&profile.id, host);
        if let Some(p) = self.providers.lock().expect("providers poisoned").get(&key).cloned() {
            return Ok(Some((account, p)));
        }
        let lock = self.lock_for(&key);
        let held = lock.lock().await;
        // Another caller may have built it, or failed, while this one waited.
        if let Some(p) = self.providers.lock().expect("providers poisoned").get(&key).cloned() {
            return Ok(Some((account, p)));
        }
        if let Some(f) = self.failed.lock().expect("failed poisoned").get(&key).filter(|f| f.added_at == account.added_at && f.storage == account.storage) {
            return Err(f.error.clone());
        }
        let account = self.move_to_keyring(store, &key, account).await;
        let (tokens, k, storage) = (self.tokens.clone(), key.clone(), account.storage);
        let token = match crate::api::blocking(move || tokens.get(&k, storage)).await {
            Ok(Some(token)) => token,
            Ok(None) => {
                self.status.lock().expect("status poisoned").insert(key.clone(), AccountStatus::TokenMissing);
                return Err(self.fail(key, &account, GbError::new(GbErrorKind::AuthFailed, format!("The token for {host} is missing: add the account again in Settings › Accounts"))));
            }
            // The keyring refused or is away: Settings shows it, not OK.
            Err(e) => {
                self.status.lock().expect("status poisoned").insert(key.clone(), AccountStatus::AuthFailed { message: e.message.clone() });
                return Err(self.fail(key, &account, e));
            }
        };
        let provider = self.connector.connect(account.kind, host, token)?;
        self.providers.lock().expect("providers poisoned").insert(key, provider.clone());
        drop(held);
        let account = self.refresh_version(store, &profile.id, account, &provider).await;
        Ok(Some((account, provider)))
    }

    fn fail(&self, key: AccountKey, account: &ForgeAccount, error: GbError) -> GbError {
        self.failed.lock().expect("failed poisoned").insert(key, FailedRead { added_at: account.added_at, storage: account.storage, error: error.clone() });
        error
    }

    /// A token kept in the file goes to the system keyring once it's there (spec #4 §2: the
    /// file is the fallback, and Settings says a restart secures it). A failure keeps the file.
    async fn move_to_keyring(&self, store: &Arc<SettingsStore>, key: &AccountKey, account: ForgeAccount) -> ForgeAccount {
        if account.storage != TokenStorage::File {
            return account;
        }
        let (tokens, k) = (self.tokens.clone(), key.clone());
        match crate::api::blocking(move || tokens.migrate_to_keyring(&k)).await {
            Ok(Some(storage)) => self.update_account(store, &key.profile, &account, |a| a.storage = storage).unwrap_or(ForgeAccount { storage, ..account }),
            Ok(None) => account,
            Err(_) => {
                tracing::warn!("forge token for {} stays in the file: the system keyring didn't take it", key.host);
                account
            }
        }
    }

    /// Changes `account`'s stored record, only if it's still the one read (same `added_at`): a
    /// re-add in the meantime wins. The record as changed, or `None`.
    fn update_account(&self, store: &Arc<SettingsStore>, profile: &str, account: &ForgeAccount, change: impl FnOnce(&mut ForgeAccount)) -> Option<ForgeAccount> {
        let mut accounts = store.forge_accounts(profile);
        let a = accounts.iter_mut().find(|a| a.host == account.host && a.added_at == account.added_at)?;
        change(a);
        let changed = a.clone();
        match store.set_forge_accounts(profile, accounts) {
            Ok(()) => Some(changed),
            Err(e) => {
                tracing::warn!("forge account {} not updated: {}", account.host, e.message);
                None
            }
        }
    }

    /// GitLab's version, once it's a day old (best effort: a failure keeps the old one).
    async fn refresh_version(&self, store: &Arc<SettingsStore>, profile: &str, account: ForgeAccount, provider: &Arc<dyn ForgeProvider>) -> ForgeAccount {
        if account.kind != ForgeKind::GitLab || self.now() - account.version_checked_at <= VERSION_MAX_AGE_SECS {
            return account;
        }
        let Ok(version) = provider.version().await else { return account };
        let now = self.now();
        self.update_account(store, profile, &account, |a| {
            a.version = version.clone();
            a.version_checked_at = now;
        })
        .unwrap_or(ForgeAccount { version, version_checked_at: now, ..account })
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
        self.failed.lock().expect("failed poisoned").clear();
        // --- 4A T6 ---
        self.projects.lock().expect("projects poisoned").clear();
        // --- end 4A T6 ---
    }

    fn drop_host(&self, key: &AccountKey) {
        self.providers.lock().expect("providers poisoned").remove(key);
        self.status.lock().expect("status poisoned").remove(key);
        self.failed.lock().expect("failed poisoned").remove(key);
        // --- 4A T6 ---
        self.projects.lock().expect("projects poisoned").retain(|(p, h, _), _| !(p == &key.profile && h == &key.host));
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

/// The profile's account for a remote's host (spec #4 §3.3). The host itself first: an https
/// remote keeps a non-default port (`h:8443`, `remotes::forge_host`). A host without a port (an
/// SSH remote, whose port says nothing about the web's) also maps to the only account on that
/// host, whatever its port. Two such accounts (`h:8443`, `h:9443`) are ambiguous: none. With
/// `h` and `h:8443`, the port-less `h` is an exact match and wins.
pub fn account_for<'a>(accounts: &'a [ForgeAccount], host: &str) -> Option<&'a ForgeAccount> {
    if let Some(a) = accounts.iter().find(|a| a.host == host) {
        return Some(a);
    }
    if host.contains(':') {
        return None;
    }
    let mut same_name = accounts.iter().filter(|a| a.host.split_once(':').is_some_and(|(name, _)| name == host));
    match (same_name.next(), same_name.next()) {
        (Some(a), None) => Some(a),
        _ => None,
    }
}

impl ForgeHub {
    /// The project at `path` on `host` (a remote's) with its provider; `Ok(None)` without an account.
    async fn project_on(&self, store: &Arc<SettingsStore>, host: &str, path: &str, refresh: bool) -> Result<Option<(Arc<dyn ForgeProvider>, ForgeProject)>, GbError> {
        let profile = store.active_profile();
        let Some(host) = account_for(&profile.forge_accounts, host).map(|a| a.host.clone()) else { return Ok(None) };
        let Some((_, provider)) = self.provider_for_host(store, &host).await? else { return Ok(None) };
        let cache_key = (profile.id.clone(), host.clone(), path.to_string());
        if !refresh && let Some(p) = self.projects.lock().expect("projects poisoned").get(&cache_key).cloned() {
            return Ok(Some((provider, p)));
        }
        let key = Self::key(&profile.id, &host);
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
                rp.account = account_for(&accounts, host).map(|a| a.kind);
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
        let profile = store.active_profile();
        let account_host = account_for(&profile.forge_accounts, host).map_or_else(|| host.clone(), |a| a.host.clone());
        Ok((Self::key(&profile.id, &account_host), provider, project))
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
        let profile = store.active_profile();
        for host in profile.forge_accounts.iter().map(|a| a.host.clone()) {
            let Ok(Some((_, provider))) = self.provider_for_host(store, &host).await else { continue };
            match provider.avatar_for_email(email).await {
                Ok(Some(found)) => return Some(found),
                Ok(None) => {}
                Err(e) => {
                    tracing::debug!("forge avatar from {host}: {}", e.message);
                    // Settings shows an unreachable forge (its client then skips it a while).
                    if e.kind == GbErrorKind::Network {
                        self.record::<()>(&Self::key(&profile.id, &host), &Err(e));
                    }
                }
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

    // --- 4A final review ---
    use crate::avatar::AvatarPayload as Avatar;
    use crate::forge::{ForgeFuture, ForgeUser, Fresh, RateLimitState, TokenCheck};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// MemTokens that counts reads, can fail them (a dismissed keyring prompt), and has a
    /// "keyring" that takes file tokens once `keyring_up`.
    struct Counting {
        mem: Arc<MemTokens>,
        reads: AtomicUsize,
        fail: AtomicBool,
        keyring_up: AtomicBool,
        migrations: AtomicUsize,
    }

    impl Counting {
        fn new(storage: TokenStorage) -> Arc<Self> {
            Arc::new(Self { mem: MemTokens::new(storage), reads: AtomicUsize::new(0), fail: AtomicBool::new(false), keyring_up: AtomicBool::new(false), migrations: AtomicUsize::new(0) })
        }
        fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }
    }

    impl TokenStore for Counting {
        fn put(&self, key: &AccountKey, token: &Secret) -> Result<TokenStorage, GbError> {
            self.mem.put(key, token)
        }
        fn get(&self, key: &AccountKey, storage: TokenStorage) -> Result<Option<Secret>, GbError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            // Long enough for every concurrent caller to be waiting.
            std::thread::sleep(std::time::Duration::from_millis(30));
            if self.fail.load(Ordering::SeqCst) {
                return Err(GbError::other(format!("Couldn't read the token for {} from the system keyring: the unlock prompt was dismissed", key.host)));
            }
            self.mem.get(key, storage)
        }
        fn delete(&self, key: &AccountKey) -> Result<(), GbError> {
            self.mem.delete(key)
        }
        fn migrate_to_keyring(&self, key: &AccountKey) -> Result<Option<TokenStorage>, GbError> {
            if !self.keyring_up.load(Ordering::SeqCst) {
                return Err(GbError::other("no Secret Service on the session bus"));
            }
            self.migrations.fetch_add(1, Ordering::SeqCst);
            Ok(self.mem.token(&key.profile, &key.host).map(|_| TokenStorage::Keyring))
        }
    }

    #[tokio::test]
    async fn concurrent_first_uses_read_the_token_once_and_build_one_provider() {
        let conn = FakeConnector::with(TOKEN, FakeProvider::new(ForgeKind::GitLab, HOST));
        let tokens = Counting::new(TokenStorage::Keyring);
        let hub = ForgeHub::new(conn.clone(), tokens.clone(), Arc::new(|| NOW_MS));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        hub.reset();
        let connects = conn.connects.load(Ordering::SeqCst);
        let all = futures_util::future::join_all((0..8).map(|_| hub.provider_for_host(&store, HOST))).await;
        assert!(all.iter().all(|r| matches!(r, Ok(Some(_)))));
        assert_eq!(tokens.reads(), 1);
        assert_eq!(conn.connects.load(Ordering::SeqCst), connects + 1);
    }

    #[tokio::test]
    async fn a_failed_token_read_is_kept_until_the_account_changes_and_settings_shows_it() {
        let mut p = FakeProvider::new(ForgeKind::GitLab, HOST);
        p.avatars.insert("grace@example.com".into(), Avatar { mime: "image/png".into(), base64: "Rk9SR0U=".into() });
        let conn = FakeConnector::with(TOKEN, p);
        let tokens = Counting::new(TokenStorage::Keyring);
        let hub = ForgeHub::new(conn, tokens.clone(), Arc::new(|| NOW_MS));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        hub.reset();
        tokens.fail.store(true, Ordering::SeqCst);
        for _ in 0..5 {
            assert!(hub.avatar(&store, "grace@example.com").await.is_none());
        }
        assert_eq!(tokens.reads(), 1, "one prompt, not one per avatar");
        let message = "Couldn't read the token for gitlab.example.com from the system keyring: the unlock prompt was dismissed";
        assert_eq!(hub.accounts(&store)[0].status, AccountStatus::AuthFailed { message: message.into() });
        // Adding the account again clears it.
        tokens.fail.store(false, Ordering::SeqCst);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        hub.providers.lock().unwrap().clear();
        assert!(hub.avatar(&store, "grace@example.com").await.is_some());
        assert_eq!(tokens.reads(), 2);
        // So does removing it.
        hub.providers.lock().unwrap().clear();
        tokens.fail.store(true, Ordering::SeqCst);
        assert!(hub.provider_for_host(&store, HOST).await.is_err());
        assert_eq!(hub.failed.lock().unwrap().len(), 1);
        hub.remove_account(&store, HOST).await.unwrap();
        assert!(hub.failed.lock().unwrap().is_empty());
    }

    /// Delegates to a FakeProvider; `on_version` runs inside `version()`, `check` replaces
    /// `check_token`'s answer.
    struct Hooked {
        inner: FakeProvider,
        on_version: Box<dyn Fn() + Send + Sync>,
        check: Option<GbError>,
    }

    impl ForgeProvider for Hooked {
        fn kind(&self) -> ForgeKind {
            self.inner.kind()
        }
        fn host(&self) -> &str {
            self.inner.host()
        }
        fn rate_limit(&self) -> RateLimitState {
            self.inner.rate_limit()
        }
        fn check_token(&self) -> ForgeFuture<'_, TokenCheck> {
            match &self.check {
                Some(e) => {
                    let e = e.clone();
                    Box::pin(async move { Err(e) })
                }
                None => self.inner.check_token(),
            }
        }
        fn current_user(&self) -> ForgeFuture<'_, ForgeUser> {
            self.inner.current_user()
        }
        fn version(&self) -> ForgeFuture<'_, Option<String>> {
            (self.on_version)();
            self.inner.version()
        }
        fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> {
            self.inner.project(path)
        }
        fn project_settings<'a>(&'a self, p: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> {
            self.inner.project_settings(p)
        }
        fn forks<'a>(&'a self, p: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> {
            self.inner.forks(p)
        }
        fn avatar_for_email<'a>(&'a self, e: &'a str) -> ForgeFuture<'a, Option<Avatar>> {
            self.inner.avatar_for_email(e)
        }
    }

    struct One(Arc<Hooked>);
    impl ForgeConnector for One {
        fn connect(&self, _: ForgeKind, _: &str, _: Secret) -> Result<Arc<dyn ForgeProvider>, GbError> {
            Ok(self.0.clone())
        }
    }

    fn account(name: &str, added_at: i64, version: &str, checked: i64) -> ForgeAccount {
        ForgeAccount { host: HOST.into(), kind: ForgeKind::GitLab, user: user(name), storage: TokenStorage::Keyring, version: Some(version.into()), version_checked_at: checked, added_at }
    }

    #[tokio::test]
    async fn a_re_add_during_a_version_refresh_is_never_overwritten() {
        let store = SettingsStore::in_memory();
        store.set_forge_accounts("default", vec![account("Ada", 1, "18.0.0", 0)]).unwrap();
        let s2 = store.clone();
        // While GitLab is asked its version, the user adds the account again.
        let readd = move || s2.set_forge_accounts("default", vec![account("Grace", 2, "19.1.0", NOW_MS / 1000)]).unwrap();
        let p = Arc::new(Hooked { inner: FakeProvider::new(ForgeKind::GitLab, HOST), on_version: Box::new(readd), check: None });
        let tokens = MemTokens::new(TokenStorage::Keyring);
        tokens.put(&ForgeHub::key("default", HOST), &Secret::new(TOKEN)).unwrap();
        let hub = ForgeHub::new(Arc::new(One(p)), tokens, Arc::new(|| NOW_MS));
        hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(store.forge_accounts("default"), vec![account("Grace", 2, "19.1.0", NOW_MS / 1000)]);
    }

    #[tokio::test]
    async fn a_token_that_cant_read_the_user_asks_for_scope_not_a_recopy() {
        let check = Some(GbError::new(GbErrorKind::AuthFailed, format!("{HOST}{}insufficient_scope", crate::forge::FORBIDDEN_MARK)));
        let p = Arc::new(Hooked { inner: FakeProvider::new(ForgeKind::GitLab, HOST), on_version: Box::new(|| {}), check });
        let hub = ForgeHub::new(Arc::new(One(p)), MemTokens::new(TokenStorage::Keyring), Arc::new(|| NOW_MS));
        let e = hub.add_account(&SettingsStore::in_memory(), HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::AuthFailed, "gitlab.example.com accepted the token but it can't read your user: give it the api scope (GitLab) or read access (GitHub)"));
    }

    #[tokio::test]
    async fn a_file_token_moves_to_the_keyring_on_first_use_once_it_is_up() {
        let conn = FakeConnector::with(TOKEN, FakeProvider::new(ForgeKind::GitLab, HOST));
        let tokens = Counting::new(TokenStorage::File);
        let hub = ForgeHub::new(conn, tokens.clone(), Arc::new(|| NOW_MS));
        let store = SettingsStore::in_memory();
        assert_eq!(hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap().account.storage, TokenStorage::File);
        hub.reset();
        // The keyring is still away: the token stays in the file, and works.
        hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(store.forge_accounts("default")[0].storage, TokenStorage::File);
        assert_eq!(tokens.mem.token("default", HOST).as_deref(), Some(TOKEN));
        hub.reset();
        tokens.keyring_up.store(true, Ordering::SeqCst);
        let (account, _) = hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(account.storage, TokenStorage::Keyring);
        assert_eq!(store.forge_accounts("default")[0].storage, TokenStorage::Keyring);
        assert_eq!(tokens.migrations.load(Ordering::SeqCst), 1);
        hub.reset();
        hub.provider_for_host(&store, HOST).await.unwrap().unwrap();
        assert_eq!(tokens.migrations.load(Ordering::SeqCst), 1, "moved once");
    }

    #[tokio::test]
    async fn an_account_with_a_port_maps_its_https_and_ssh_remotes() {
        const PORTED: &str = "gitlab.example.com:8443";
        let p = FakeProvider::new(ForgeKind::GitLab, PORTED);
        p.projects.lock().unwrap().insert("group/project".into(), project(PORTED, "group/project", None, 1));
        let conn = FakeConnector::with(TOKEN, p);
        let hub = hub(conn.clone(), MemTokens::new(TokenStorage::Keyring));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, PORTED, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        // `details::forge_remotes`: https keeps the port, SSH doesn't.
        let remotes = [remote("origin", Some(PORTED), Some("group/project")), remote("ssh", Some(HOST), Some("group/project"))];
        let rp = hub.repo_projects(&store, &remotes, false).await;
        for r in &rp.remotes {
            assert_eq!((r.account, r.project.as_ref().map(|p| p.host.as_str())), (Some(ForgeKind::GitLab), Some(PORTED)), "{}", r.remote);
        }
        assert!(hub.forks(&store, &remotes, "ssh").await.is_ok());
        // A second account on the host, without a port: SSH remotes are its (an exact match).
        let q = FakeProvider::new(ForgeKind::GitLab, HOST);
        q.projects.lock().unwrap().insert("group/project".into(), project(HOST, "group/project", None, 2));
        conn.add(TOKEN2, q);
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN2)).await.unwrap();
        let rp = hub.repo_projects(&store, &remotes, false).await;
        assert_eq!(rp.remotes[0].project.as_ref().unwrap().host, PORTED);
        assert_eq!(rp.remotes[1].project.as_ref().unwrap().host, HOST);
        // Two accounts with ports on one host: an SSH remote is ambiguous.
        let two = [ForgeAccount { host: PORTED.into(), ..account("Ada", 1, "x", 0) }, ForgeAccount { host: "gitlab.example.com:9443".into(), ..account("Ada", 1, "x", 0) }];
        assert!(account_for(&two, HOST).is_none());
        assert_eq!(account_for(&two, PORTED).map(|a| a.host.as_str()), Some(PORTED));
    }

    #[tokio::test]
    async fn one_profiles_cached_project_never_answers_for_another() {
        let (_, hub, store) = mapped().await;
        let remotes = [remote("origin", Some(HOST), Some("group/project"))];
        assert!(hub.repo_projects(&store, &remotes, false).await.remotes[0].project.is_some());
        let work = store.create_profile("Work", "#00f").unwrap();
        store.switch_profile(&work.id).unwrap();
        // Work's own account on the host, whose token sees no such project.
        let conn = FakeConnector::with(TOKEN2, FakeProvider::new(ForgeKind::GitLab, HOST));
        let fresh = ForgeHub::new(conn, MemTokens::new(TokenStorage::Keyring), Arc::new(|| NOW_MS));
        fresh.projects.lock().unwrap().insert(("default".into(), HOST.into(), "group/project".into()), project(HOST, "group/project", None, 1));
        fresh.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN2)).await.unwrap();
        let rp = fresh.repo_projects(&store, &remotes, false).await;
        assert_eq!(rp.remotes[0].error.as_deref(), Some("Not found on gitlab.example.com"), "Default's cached project isn't Work's");
    }
    // --- end 4A final review ---
}
