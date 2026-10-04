//! The forge connector `Api::with_forge` takes (spec #4 §3.1): a provider for an account, at the
//! endpoints its host has (the defaults, or the harness's fake forge).

use crate::avatar_cache::DiskAvatarCache;
use crate::endpoints::{default_endpoints, HostEndpoints};
use crate::github::GitHubProvider;
use crate::gitlab::GitLabProvider;
use gitbolt_core::error::{GbError, GbErrorKind};
use gitbolt_core::forge::{ForgeConnector, ForgeKind, ForgeProvider};
use gitbolt_core::redact::Secret;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct ForgeConfig {
    /// Hosts whose endpoints replace the defaults (the harness: the fake forge).
    pub overrides: HashMap<String, HostEndpoints>,
    /// Only the overridden hosts (the harness: no test reaches a real forge).
    pub only_overrides: bool,
    /// Forge avatars' disk cache, one directory per host (`~/.cache/gitbolt/forge-avatars`).
    pub avatar_dir: Option<PathBuf>,
}

pub struct Forge {
    cfg: ForgeConfig,
    caches: Mutex<HashMap<String, Arc<DiskAvatarCache>>>,
}

impl Forge {
    pub fn new(cfg: ForgeConfig) -> Self {
        Self { cfg, caches: Mutex::default() }
    }

    /// One cache per host, shared by every provider for it (a re-added account keeps it).
    fn cache(&self, host: &str) -> Option<Arc<DiskAvatarCache>> {
        let dir = self.cfg.avatar_dir.as_ref()?;
        let mut caches = self.caches.lock().expect("avatar caches poisoned");
        Some(caches.entry(host.to_string()).or_insert_with(|| Arc::new(DiskAvatarCache::new(dir.join(host.replace(':', "_"))))).clone())
    }
}

impl ForgeConnector for Forge {
    fn connect(&self, kind: ForgeKind, host: &str, token: Secret) -> Result<Arc<dyn ForgeProvider>, GbError> {
        let endpoints = match self.cfg.overrides.get(host) {
            Some(e) => e.clone(),
            None if self.cfg.only_overrides => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{host} isn't reachable from this build (tests use the fake forge)"))),
            None => default_endpoints(kind, host),
        };
        let cache = self.cache(host);
        Ok(match kind {
            ForgeKind::GitLab => Arc::new(GitLabProvider::new(host, &endpoints, token, cache)),
            ForgeKind::GitHub => Arc::new(GitHubProvider::new(host, &endpoints, token, cache)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_overridden_hosts_are_reachable_when_the_harness_says_so() {
        let mut overrides = HashMap::new();
        overrides.insert("gitlab.example.com".to_string(), HostEndpoints { api: "http://127.0.0.1:9/gitlab/api/v4".into(), web: "http://127.0.0.1:9/gitlab".into(), avatars: None });
        let f = Forge::new(ForgeConfig { overrides, only_overrides: true, avatar_dir: None });
        let p = f.connect(ForgeKind::GitLab, "gitlab.example.com", Secret::new("glpat-FAKE-test-token")).unwrap();
        assert_eq!((p.kind(), p.host()), (ForgeKind::GitLab, "gitlab.example.com"));
        let e = f.connect(ForgeKind::GitLab, "gitlab.com", Secret::new("x")).err().unwrap();
        assert_eq!(e.message, "gitlab.com isn't reachable from this build (tests use the fake forge)");
        let app = Forge::new(ForgeConfig { overrides: HashMap::new(), only_overrides: false, avatar_dir: None });
        assert_eq!(app.connect(ForgeKind::GitHub, "github.com", Secret::new("x")).unwrap().kind(), ForgeKind::GitHub);
    }

    /// One token in memory.
    struct OneToken;
    impl gitbolt_core::forge::TokenStore for OneToken {
        fn put(&self, _: &gitbolt_core::forge::AccountKey, _: &Secret) -> Result<gitbolt_core::forge::TokenStorage, GbError> {
            Ok(gitbolt_core::forge::TokenStorage::Keyring)
        }
        fn get(&self, _: &gitbolt_core::forge::AccountKey, _: gitbolt_core::forge::TokenStorage) -> Result<Option<Secret>, GbError> {
            Ok(Some(Secret::new("glpat-FAKE-test-token")))
        }
        fn delete(&self, _: &gitbolt_core::forge::AccountKey) -> Result<(), GbError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn an_unreachable_forge_is_skipped_for_avatars_and_shown_in_settings() {
        use crate::test_server::{closed_base, Canned, TestServer};
        use gitbolt_core::forge::accounts::{AccountStatus, ForgeAccount};
        use gitbolt_core::forge::hub::ForgeHub;
        use gitbolt_core::forge::{ForgeUser, TokenStorage};
        use gitbolt_core::settings::SettingsStore;
        const HOST: &str = "gitlab.example.com";
        let base = closed_base();
        let overrides = HashMap::from([(HOST.to_string(), HostEndpoints { api: format!("{base}/api/v4"), web: base.clone(), avatars: None })]);
        let forge = Arc::new(Forge::new(ForgeConfig { overrides, only_overrides: true, avatar_dir: None }));
        let now_secs = crate::time::unix_now();
        let hub = ForgeHub::new(forge, Arc::new(OneToken), Arc::new(move || now_secs * 1000));
        let store = SettingsStore::in_memory();
        let user = ForgeUser { id: 1, username: "ada".into(), name: "Ada".into(), avatar_url: None, web_url: String::new(), email: None };
        store.set_forge_accounts("default", vec![ForgeAccount { host: HOST.into(), kind: ForgeKind::GitLab, user, storage: TokenStorage::Keyring, version: None, version_checked_at: now_secs, added_at: now_secs }]).unwrap();
        assert!(hub.avatar(&store, "ada@example.com").await.is_none());
        let status = hub.accounts(&store)[0].status.clone();
        assert!(matches!(&status, AccountStatus::Unreachable { message } if message.starts_with("Couldn't reach gitlab.example.com")), "{status:?}");
        // The port answers now; within the cooldown nothing is sent to it.
        let s = TestServer::start_at(base.trim_start_matches("http://"), |_, _| Canned::json(200, "{}"));
        let started = std::time::Instant::now();
        for _ in 0..3 {
            assert!(hub.avatar(&store, "ada@example.com").await.is_none());
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(s.hits(), 0);
    }
}
