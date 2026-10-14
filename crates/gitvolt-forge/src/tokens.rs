//! Where forge tokens live (spec #4 §2 "Token storage"):
//! - the system Secret Service (libsecret's D-Bus API, through `keyring`), service `gitvolt`,
//!   account `<profile-id>/<host>` (core spec §14.3); GitBolt's entries (service `gitbolt`, its
//!   name before 0.7.0) move to `gitvolt` when first read;
//! - when there's none, `~/.local/share/gitvolt/forge-tokens`: file 0600, directory 0700, always
//!   written through a 0600 temp file and a rename. Settings › Accounts warns about these.
//!
//! Never session-only. Every method blocks: `Api` calls them on the blocking pool. Nothing here
//! logs, prints or formats a token: errors name the host, and `Debug` names the file only.

use gitvolt_core::error::GbError;
use gitvolt_core::forge::{AccountKey, TokenStorage, TokenStore, KEYRING_SERVICE};
use gitvolt_core::redact::{redact, Secret};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use gitvolt_core::platform::fs as pfs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The directory's owner must be us: a directory someone else owns could swap files under us.
/// (Windows: see `gitvolt_core::platform::fs::owned_by_me`.)
fn check_owner(dir: &Path, owned_by_me: bool) -> Result<(), GbError> {
    if !owned_by_me {
        return Err(GbError::other(format!("{} isn't owned by you, so tokens won't be kept in it", dir.display())));
    }
    Ok(())
}

fn io_err(verb: &str, path: &Path, e: std::io::Error) -> GbError {
    GbError::other(format!("Couldn't {verb} {}: {e}", path.display()))
}

/// The token file's directory: created 0700, owned by us, and tightened to 0700 if it's looser.
fn private_dir(dir: &Path) -> Result<(), GbError> {
    let fail = |e| io_err("prepare", dir, e);
    pfs::private_dir_builder(std::fs::DirBuilder::new().recursive(true)).create(dir).map_err(fail)?;
    let meta = std::fs::metadata(dir).map_err(fail)?;
    check_owner(dir, pfs::owned_by_me(&meta))?;
    if pfs::mode(&meta) & 0o777 != 0o700 {
        pfs::set_mode(dir, 0o700).map_err(fail)?;
    }
    Ok(())
}

#[derive(Debug)]
pub enum BackendError {
    /// No Secret Service (no session bus, no daemon, a locked or refused collection).
    Unavailable(String),
    Other(String),
}

impl BackendError {
    fn reason(&self) -> &str {
        match self {
            Self::Unavailable(r) | Self::Other(r) => r,
        }
    }
}

/// A secret store by account name (the Secret Service; tests' fakes).
pub trait SecretBackend: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), BackendError>;
    fn get(&self, account: &str) -> Result<Option<String>, BackendError>;
    fn delete(&self, account: &str) -> Result<(), BackendError>;
}

/// The system keyring (keyring 4's v1 API: the Secret Service on Linux), entries of one service.
/// Never used by tests.
pub struct KeyringBackend {
    service: &'static str,
}

impl KeyringBackend {
    pub fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, BackendError> {
        keyring::Entry::new(self.service, account).map_err(|e| BackendError::Unavailable(redact(&e.to_string())))
    }
}

impl SecretBackend for KeyringBackend {
    fn set(&self, account: &str, secret: &str) -> Result<(), BackendError> {
        self.entry(account)?.set_password(secret).map_err(|e| BackendError::Unavailable(redact(&e.to_string())))
    }
    fn get(&self, account: &str) -> Result<Option<String>, BackendError> {
        match self.entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(BackendError::Unavailable(redact(&e.to_string()))),
        }
    }
    fn delete(&self, account: &str) -> Result<(), BackendError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(BackendError::Other(redact(&e.to_string()))),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct TokenFile {
    version: u32,
    tokens: BTreeMap<String, String>,
}

/// The fallback file. Its lock serializes this process's read-modify-write cycles.
pub struct FileTokenStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl std::fmt::Debug for FileTokenStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileTokenStore").field("path", &self.path).finish()
    }
}

impl FileTokenStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// Harness reset: no tokens at all.
    pub fn clear(&self) {
        let _g = self.lock.lock().expect("token file lock poisoned");
        let _ = std::fs::remove_file(&self.path);
    }

    fn read(&self) -> Result<TokenFile, GbError> {
        let fail = |e| io_err("read", &self.path, e);
        match std::fs::symlink_metadata(&self.path) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(GbError::other(format!("{} is a symbolic link, so it won't be used for tokens", self.path.display())));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TokenFile { version: 1, tokens: BTreeMap::new() }),
            Err(e) => return Err(fail(e)),
        }
        let bytes = std::fs::read(&self.path).map_err(fail)?;
        // An older or hand-made copy readable by others is tightened before use.
        if pfs::mode(&std::fs::metadata(&self.path).map_err(fail)?) & 0o077 != 0 {
            pfs::set_mode(&self.path, 0o600).map_err(fail)?;
        }
        serde_json::from_slice(&bytes).map_err(|_| GbError::other(format!("{} isn't a token file that can be read", self.path.display())))
    }

    /// Unique O_EXCL 0600 temp file in the same directory, renamed over the token file.
    fn write(&self, dir: &Path, file: &TokenFile) -> Result<(), GbError> {
        let fail = |e| io_err("write", &self.path, e);
        let json = serde_json::to_vec(file).map_err(|e| GbError::other(format!("token file: {e}")))?;
        let mut tmp = pfs::private_temp(tempfile::Builder::new().prefix(".forge-tokens.").suffix(".tmp")).tempfile_in(dir).map_err(fail)?;
        tmp.write_all(&json).map_err(fail)?;
        tmp.as_file().sync_all().map_err(fail)?;
        tmp.persist(&self.path).map_err(|e| fail(e.error))?;
        // The rename itself must survive a crash.
        pfs::sync_dir(dir).map_err(fail)
    }

    fn update(&self, f: impl FnOnce(&mut TokenFile)) -> Result<(), GbError> {
        let _g = self.lock.lock().expect("token file lock poisoned");
        let dir = self.path.parent().ok_or_else(|| GbError::other("the token file has no directory"))?;
        private_dir(dir)?;
        // Another process (a second app instance) is held off by a sidecar flock.
        let lock_path = self.path.with_extension("lock");
        // A planted symlink (or a FIFO, which would block the open) is refused, never followed.
        let lock_file = pfs::no_follow(pfs::private_file(std::fs::OpenOptions::new().create(true).truncate(false).write(true)))
            .open(&lock_path).map_err(|e| io_err("open", &lock_path, e))?;
        // `flock` (`LockFileEx` on Windows), released when the file closes.
        lock_file.lock().map_err(|e| io_err("lock", &lock_path, e))?;
        let _flock = lock_file;
        let mut file = self.read()?;
        file.version = 1;
        f(&mut file);
        if file.tokens.is_empty() {
            match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(io_err("remove", &self.path, e)),
            }
        } else {
            self.write(dir, &file)
        }
    }
}

impl TokenStore for FileTokenStore {
    fn put(&self, key: &AccountKey, token: &Secret) -> Result<TokenStorage, GbError> {
        self.update(|f| {
            f.tokens.insert(key.keyring_account(), token.expose().to_string());
        })?;
        Ok(TokenStorage::File)
    }

    fn get(&self, key: &AccountKey, _storage: TokenStorage) -> Result<Option<Secret>, GbError> {
        let _g = self.lock.lock().expect("token file lock poisoned");
        Ok(self.read()?.tokens.get(&key.keyring_account()).map(|t| Secret::new(t.clone())))
    }

    fn delete(&self, key: &AccountKey) -> Result<(), GbError> {
        self.update(|f| {
            f.tokens.remove(&key.keyring_account());
        })
    }
}

/// The app's store: the keyring when it takes the token, else the file (and Settings warns).
pub struct SystemTokenStore {
    keyring: Option<Box<dyn SecretBackend>>,
    /// GitBolt's entries (`legacy::KEYRING_SERVICE`): a token only there moves to `keyring` when
    /// it's first read.
    legacy: Option<Box<dyn SecretBackend>>,
    file: FileTokenStore,
}

impl SystemTokenStore {
    pub fn new(keyring: Option<Box<dyn SecretBackend>>, file: FileTokenStore) -> Self {
        Self { keyring, legacy: None, file }
    }

    /// With GitBolt's keyring entries to adopt.
    pub fn with_legacy(mut self, legacy: Box<dyn SecretBackend>) -> Self {
        self.legacy = Some(legacy);
        self
    }

    /// The Secret Service (GitVolt's entries, then GitBolt's), with `file_path`
    /// (`<data dir>/forge-tokens`) as the fallback.
    pub fn system(file_path: PathBuf) -> Self {
        Self::new(Some(Box::new(KeyringBackend::new(KEYRING_SERVICE))), FileTokenStore::new(file_path))
            .with_legacy(Box::new(KeyringBackend::new(gitvolt_core::legacy::KEYRING_SERVICE)))
    }

    /// GitBolt's entry for `account`, when GitVolt's keyring has none: written to GitVolt's, read
    /// back, and only then deleted. A copy that doesn't take leaves GitBolt's entry (the token
    /// works from it, and the next read tries again). Messages name the host, never the token.
    /// A GitBolt entry that can't be read (the user refused the keychain prompt) is an error,
    /// not "no token".
    fn adopt_legacy(&self, keyring: &dyn SecretBackend, account: &str, host: &str) -> Result<Option<String>, GbError> {
        let Some(legacy) = self.legacy.as_ref() else { return Ok(None) };
        let token = match legacy.get(account) {
            Ok(Some(t)) => t,
            Ok(None) => return Ok(None),
            Err(e) => {
                tracing::warn!("forge token for {host}: GitBolt's keyring entry couldn't be read: {}", e.reason());
                return Err(GbError::other(format!("Couldn't read the token for {host} from the system keyring: {}", e.reason())));
            }
        };
        match keyring.set(account, &token).and_then(|()| keyring.get(account)) {
            Ok(Some(back)) if back == token => {
                if let Err(e) = legacy.delete(account) {
                    tracing::warn!("forge token for {host} moved from GitBolt's keyring entry, which wasn't removed: {}", e.reason());
                }
            }
            Ok(_) => tracing::warn!("forge token for {host} stays in GitBolt's keyring entry: the copy didn't read back"),
            Err(e) => tracing::warn!("forge token for {host} stays in GitBolt's keyring entry: {}", e.reason()),
        }
        Ok(Some(token))
    }
}

impl TokenStore for SystemTokenStore {
    fn put(&self, key: &AccountKey, token: &Secret) -> Result<TokenStorage, GbError> {
        if let Some(k) = &self.keyring {
            match k.set(&key.keyring_account(), token.expose()) {
                Ok(()) => {
                    // A copy from a time the keyring was away goes: one place per token.
                    if let Err(e) = self.file.delete(key) {
                        tracing::warn!("forge token for {} saved to the keyring, but the old file copy wasn't removed: {}", key.host, e.message);
                    }
                    return Ok(TokenStorage::Keyring);
                }
                Err(e) => tracing::warn!("forge token for {} goes to the file: the system keyring refused it ({})", key.host, e.reason()),
            }
        }
        self.file.put(key, token)
    }

    fn get(&self, key: &AccountKey, storage: TokenStorage) -> Result<Option<Secret>, GbError> {
        match storage {
            // A token moved to the keyring whose account record still says File (the profile
            // write failed after the move) is found there.
            TokenStorage::File => match self.file.get(key, storage)? {
                Some(t) => Ok(Some(t)),
                None => {
                    let Some(k) = &self.keyring else { return Ok(None) };
                    let account = key.keyring_account();
                    match k.get(&account).ok().flatten() {
                        Some(t) => Ok(Some(Secret::new(t))),
                        None => Ok(self.adopt_legacy(k.as_ref(), &account, &key.host)?.map(Secret::new)),
                    }
                }
            },
            TokenStorage::Keyring => {
                let k = self.keyring.as_ref().ok_or_else(|| GbError::other(format!("Couldn't read the token for {} from the system keyring: this build has none", key.host)))?;
                let account = key.keyring_account();
                match k.get(&account) {
                    Ok(Some(t)) => Ok(Some(Secret::new(t))),
                    Ok(None) => Ok(self.adopt_legacy(k.as_ref(), &account, &key.host)?.map(Secret::new)),
                    Err(e) => Err(GbError::other(format!("Couldn't read the token for {} from the system keyring: {}", key.host, e.reason()))),
                }
            }
        }
    }

    fn delete(&self, key: &AccountKey) -> Result<(), GbError> {
        let mut refused = None;
        if let Some(k) = &self.keyring {
            match k.delete(&key.keyring_account()) {
                Ok(()) => {}
                // No store at all: nothing is kept there.
                Err(BackendError::Unavailable(r)) => tracing::warn!("forge token for {} not deleted from the keyring: {}", key.host, r),
                Err(BackendError::Other(r)) => refused = Some(r),
            }
        }
        // GitBolt's entry, if it was never moved: best effort, the account is going anyway.
        if let Some(Err(e)) = self.legacy.as_ref().map(|l| l.delete(&key.keyring_account())) {
            tracing::warn!("forge token for {} not deleted from GitBolt's keyring entry: {}", key.host, e.reason());
        }
        self.file.delete(key)?;
        match refused {
            Some(r) => Err(GbError::other(format!("Couldn't delete the token for {} from the system keyring: {r}", key.host))),
            None => Ok(()),
        }
    }

    fn migrate_to_keyring(&self, key: &AccountKey) -> Result<Option<TokenStorage>, GbError> {
        let Some(k) = &self.keyring else { return Ok(None) };
        let Some(token) = self.file.get(key, TokenStorage::File)? else {
            // Already moved, but the record still says File (the app stopped between the file
            // delete and the profile flush): the record heals.
            let account = key.keyring_account();
            let moved = match k.get(&account).ok().flatten() {
                Some(_) => true,
                // Moved by 0.6.x, which stopped before the profile flush: GitBolt's entry is adopted.
                None => self.adopt_legacy(k.as_ref(), &account, &key.host)?.is_some(),
            };
            return Ok(moved.then_some(TokenStorage::Keyring));
        };
        k.set(&key.keyring_account(), token.expose()).map_err(|e| GbError::other(format!("Couldn't move the token for {} to the system keyring: {}", key.host, e.reason())))?;
        // The keyring has it: one place per token. A copy left behind is still found by `get`
        // and goes with `delete`.
        if let Err(e) = self.file.delete(key) {
            tracing::warn!("forge token for {} moved to the keyring, but the file copy wasn't removed: {}", key.host, e.message);
        }
        Ok(Some(TokenStorage::Keyring))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    const TOKEN: &str = "glpat-FAKE-test-token";

    fn key(host: &str) -> AccountKey {
        AccountKey { profile: "default".into(), host: host.into() }
    }

    fn mode(p: &std::path::Path) -> u32 {
        gitvolt_core::platform::fs::mode(&std::fs::metadata(p).unwrap()) & 0o777
    }

    /// The mode, on Unix (Windows has none: the file is private by the profile's ACL).
    macro_rules! assert_mode {
        ($p:expr, $m:expr $(, $msg:expr)?) => {
            if cfg!(unix) {
                assert_eq!(mode($p), $m $(, $msg)?);
            }
        };
    }

    /// A Secret Service in memory, or none at all (`up: false`).
    #[derive(Default)]
    struct FakeKeyring {
        up: bool,
        map: Mutex<HashMap<String, String>>,
    }
    impl SecretBackend for FakeKeyring {
        fn set(&self, account: &str, secret: &str) -> Result<(), BackendError> {
            if !self.up {
                return Err(BackendError::Unavailable("no Secret Service on the session bus".into()));
            }
            self.map.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn get(&self, account: &str) -> Result<Option<String>, BackendError> {
            if !self.up {
                return Err(BackendError::Unavailable("no Secret Service on the session bus".into()));
            }
            Ok(self.map.lock().unwrap().get(account).cloned())
        }
        fn delete(&self, account: &str) -> Result<(), BackendError> {
            if !self.up {
                return Err(BackendError::Unavailable("no Secret Service on the session bus".into()));
            }
            self.map.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn the_file_store_round_trips_owner_only() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("share").join("gitvolt").join("forge-tokens");
        let store = FileTokenStore::new(path.clone());
        assert_eq!(store.put(&key("gitlab.example.com"), &Secret::new(TOKEN)).unwrap(), TokenStorage::File);
        assert_eq!(store.get(&key("gitlab.example.com"), TokenStorage::File).unwrap().map(|s| s.expose().to_string()).as_deref(), Some(TOKEN));
        assert_mode!(&path, 0o600);
        assert_mode!(path.parent().unwrap(), 0o700);
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["tokens"]["default/gitlab.example.com"], TOKEN);
        let mut leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        leftovers.sort();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("forge-tokens"), std::ffi::OsString::from("forge-tokens.lock")], "no temp file left");
    }

    #[test]
    fn the_file_store_tightens_a_world_readable_file_and_deletes_one_account() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("forge-tokens");
        let store = FileTokenStore::new(path.clone());
        store.put(&key("a.example.com"), &Secret::new("one")).unwrap();
        store.put(&key("b.example.com"), &Secret::new("two")).unwrap();
        gitvolt_core::platform::fs::set_mode(&path, 0o644).unwrap();
        assert!(store.get(&key("a.example.com"), TokenStorage::File).unwrap().is_some());
        assert_mode!(&path, 0o600, "reading tightens it");
        store.delete(&key("a.example.com")).unwrap();
        assert!(store.get(&key("a.example.com"), TokenStorage::File).unwrap().is_none());
        assert_eq!(store.get(&key("b.example.com"), TokenStorage::File).unwrap().unwrap().expose(), "two");
        store.clear();
        assert!(!path.exists());
    }

    #[test]
    fn the_keyring_is_preferred_and_the_file_stays_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("forge-tokens");
        let store = SystemTokenStore::new(Some(Box::new(FakeKeyring { up: true, ..Default::default() })), FileTokenStore::new(path.clone()));
        assert_eq!(store.put(&key("gitlab.example.com"), &Secret::new(TOKEN)).unwrap(), TokenStorage::Keyring);
        assert_eq!(store.get(&key("gitlab.example.com"), TokenStorage::Keyring).unwrap().unwrap().expose(), TOKEN);
        assert!(!path.exists());
    }

    #[test]
    fn no_secret_service_falls_back_to_the_owner_only_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("gitvolt").join("forge-tokens");
        let store = SystemTokenStore::new(Some(Box::new(FakeKeyring::default())), FileTokenStore::new(path.clone()));
        assert_eq!(store.put(&key("gitlab.example.com"), &Secret::new(TOKEN)).unwrap(), TokenStorage::File);
        assert_mode!(&path, 0o600);
        assert_mode!(path.parent().unwrap(), 0o700);
        assert_eq!(store.get(&key("gitlab.example.com"), TokenStorage::File).unwrap().unwrap().expose(), TOKEN);
        // No keyring backend at all (a build or platform without one): the same.
        let bare = SystemTokenStore::new(None, FileTokenStore::new(tmp.path().join("other")));
        assert_eq!(bare.put(&key("h"), &Secret::new("x")).unwrap(), TokenStorage::File);
    }

    #[test]
    fn saving_to_the_keyring_removes_an_older_file_copy_and_delete_clears_both() {
        let tmp = tempfile::tempdir().unwrap();
        let file = FileTokenStore::new(tmp.path().join("forge-tokens"));
        file.put(&key("gitlab.example.com"), &Secret::new("old")).unwrap();
        let store = SystemTokenStore::new(Some(Box::new(FakeKeyring { up: true, ..Default::default() })), FileTokenStore::new(tmp.path().join("forge-tokens")));
        store.put(&key("gitlab.example.com"), &Secret::new(TOKEN)).unwrap();
        assert!(file.get(&key("gitlab.example.com"), TokenStorage::File).unwrap().is_none(), "the file copy is gone");
        store.delete(&key("gitlab.example.com")).unwrap();
        assert!(store.get(&key("gitlab.example.com"), TokenStorage::Keyring).unwrap().is_none());
    }

    #[test]
    fn reading_from_an_unavailable_keyring_is_an_error_that_names_no_token() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SystemTokenStore::new(Some(Box::new(FakeKeyring::default())), FileTokenStore::new(tmp.path().join("t")));
        let e = store.get(&key("gitlab.example.com"), TokenStorage::Keyring).unwrap_err();
        assert_eq!(e.message, "Couldn't read the token for gitlab.example.com from the system keyring: no Secret Service on the session bus");
        assert_eq!(format!("{:?}", FileTokenStore::new(tmp.path().join("t"))), format!("FileTokenStore {{ path: {:?} }}", tmp.path().join("t")));
    }

    /// A keyring that comes up later (`up` flips), as at a restart with GNOME Keyring started.
    #[derive(Default, Clone)]
    struct LateKeyring {
        up: Arc<std::sync::atomic::AtomicBool>,
        map: Arc<Mutex<HashMap<String, String>>>,
    }
    impl SecretBackend for LateKeyring {
        fn set(&self, account: &str, secret: &str) -> Result<(), BackendError> {
            if !self.up.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(BackendError::Unavailable("no Secret Service on the session bus".into()));
            }
            self.map.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn get(&self, account: &str) -> Result<Option<String>, BackendError> {
            if !self.up.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(BackendError::Unavailable("no Secret Service on the session bus".into()));
            }
            Ok(self.map.lock().unwrap().get(account).cloned())
        }
        fn delete(&self, account: &str) -> Result<(), BackendError> {
            self.map.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn a_file_token_moves_to_the_keyring_once_it_comes_up() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("forge-tokens");
        let keyring = LateKeyring::default();
        let store = SystemTokenStore::new(Some(Box::new(keyring.clone())), FileTokenStore::new(path.clone()));
        let k = key("gitlab.example.com");
        assert_eq!(store.put(&k, &Secret::new(TOKEN)).unwrap(), TokenStorage::File);
        let e = store.migrate_to_keyring(&k).unwrap_err();
        assert_eq!(e.message, "Couldn't move the token for gitlab.example.com to the system keyring: no Secret Service on the session bus");
        assert_eq!(store.get(&k, TokenStorage::File).unwrap().unwrap().expose(), TOKEN, "a failed move keeps the file copy");
        keyring.up.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(store.migrate_to_keyring(&k).unwrap(), Some(TokenStorage::Keyring));
        assert_eq!(keyring.map.lock().unwrap().get("default/gitlab.example.com").map(String::as_str), Some(TOKEN));
        assert!(!path.exists() || !std::fs::read_to_string(&path).unwrap().contains(TOKEN), "the file no longer holds it");
        assert_eq!(store.get(&k, TokenStorage::Keyring).unwrap().unwrap().expose(), TOKEN);
        assert_eq!(store.get(&k, TokenStorage::File).unwrap().unwrap().expose(), TOKEN, "a record still saying File finds it in the keyring");
        assert_eq!(store.migrate_to_keyring(&k).unwrap(), Some(TokenStorage::Keyring), "already moved: a record still saying File heals");
        store.delete(&k).unwrap();
        assert_eq!(store.migrate_to_keyring(&k).unwrap(), None, "no token anywhere: nothing to move");
        let fileonly = FileTokenStore::new(tmp.path().join("other"));
        fileonly.put(&k, &Secret::new("x")).unwrap();
        assert_eq!(fileonly.migrate_to_keyring(&k).unwrap(), None, "a file-only store has nowhere to move it");
    }

    fn up() -> LateKeyring {
        let k = LateKeyring::default();
        k.up.store(true, std::sync::atomic::Ordering::SeqCst);
        k
    }

    #[test]
    fn a_token_only_gitbolt_has_moves_to_gitvolts_entry_when_read() {
        let tmp = tempfile::tempdir().unwrap();
        let (new, old) = (up(), up());
        old.map.lock().unwrap().insert("default/gitlab.example.com".into(), TOKEN.into());
        let store = SystemTokenStore::new(Some(Box::new(new.clone())), FileTokenStore::new(tmp.path().join("t"))).with_legacy(Box::new(old.clone()));
        let k = key("gitlab.example.com");
        assert_eq!(store.get(&k, TokenStorage::Keyring).unwrap().unwrap().expose(), TOKEN);
        assert_eq!(new.map.lock().unwrap().get("default/gitlab.example.com").map(String::as_str), Some(TOKEN), "copied to GitVolt's entry");
        assert!(old.map.lock().unwrap().is_empty(), "GitBolt's entry goes once the copy reads back");
        assert_eq!(store.get(&k, TokenStorage::Keyring).unwrap().unwrap().expose(), TOKEN, "then it's GitVolt's own");
        assert!(store.get(&key("github.example.com"), TokenStorage::Keyring).unwrap().is_none(), "in neither: none");
    }

    #[test]
    fn a_copy_that_doesnt_read_back_keeps_gitbolts_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let old = up();
        old.map.lock().unwrap().insert("default/h".into(), TOKEN.into());
        // `Refusing` takes a write but never has the entry afterwards.
        let store = SystemTokenStore::new(Some(Box::new(Refusing(false))), FileTokenStore::new(tmp.path().join("t"))).with_legacy(Box::new(old.clone()));
        assert_eq!(store.get(&key("h"), TokenStorage::Keyring).unwrap().unwrap().expose(), TOKEN, "the token still works");
        assert_eq!(old.map.lock().unwrap().get("default/h").map(String::as_str), Some(TOKEN), "GitBolt's entry stays");
    }

    #[test]
    fn an_existing_gitvolt_entry_is_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let (new, old) = (up(), up());
        new.map.lock().unwrap().insert("default/h".into(), "new-token".into());
        old.map.lock().unwrap().insert("default/h".into(), TOKEN.into());
        let store = SystemTokenStore::new(Some(Box::new(new.clone())), FileTokenStore::new(tmp.path().join("t"))).with_legacy(Box::new(old.clone()));
        assert_eq!(store.get(&key("h"), TokenStorage::Keyring).unwrap().unwrap().expose(), "new-token");
        assert_eq!(new.map.lock().unwrap().get("default/h").map(String::as_str), Some("new-token"));
        assert_eq!(old.map.lock().unwrap().len(), 1, "GitBolt's entry is left alone");
    }

    #[test]
    fn removing_an_account_removes_gitbolts_entry_too() {
        let tmp = tempfile::tempdir().unwrap();
        let (new, old) = (up(), up());
        old.map.lock().unwrap().insert("default/h".into(), TOKEN.into());
        let store = SystemTokenStore::new(Some(Box::new(new)), FileTokenStore::new(tmp.path().join("t"))).with_legacy(Box::new(old.clone()));
        store.delete(&key("h")).unwrap();
        assert!(old.map.lock().unwrap().is_empty());
    }

    #[test]
    fn a_file_record_whose_token_is_only_in_gitbolts_entry_is_found_and_adopted() {
        let tmp = tempfile::tempdir().unwrap();
        let (new, old) = (up(), up());
        old.map.lock().unwrap().insert("default/h".into(), TOKEN.into());
        let store = SystemTokenStore::new(Some(Box::new(new.clone())), FileTokenStore::new(tmp.path().join("t"))).with_legacy(Box::new(old.clone()));
        assert_eq!(store.get(&key("h"), TokenStorage::File).unwrap().unwrap().expose(), TOKEN);
        assert!(old.map.lock().unwrap().is_empty());
        assert_eq!(new.map.lock().unwrap().get("default/h").map(String::as_str), Some(TOKEN));
        // The migrate path's "already moved" branch adopts too.
        let (new2, old2) = (up(), up());
        old2.map.lock().unwrap().insert("default/h".into(), TOKEN.into());
        let s2 = SystemTokenStore::new(Some(Box::new(new2.clone())), FileTokenStore::new(tmp.path().join("t2"))).with_legacy(Box::new(old2.clone()));
        assert_eq!(s2.migrate_to_keyring(&key("h")).unwrap(), Some(TokenStorage::Keyring));
        assert!(old2.map.lock().unwrap().is_empty());
        assert!(new2.map.lock().unwrap().contains_key("default/h"));
    }

    #[test]
    fn an_unreadable_gitbolt_entry_is_a_keyring_error_not_a_missing_token() {
        let tmp = tempfile::tempdir().unwrap();
        let old = LateKeyring::default(); // down: its reads fail, as a refused keychain prompt does
        let store = SystemTokenStore::new(Some(Box::new(up())), FileTokenStore::new(tmp.path().join("t"))).with_legacy(Box::new(old));
        let e = store.get(&key("h"), TokenStorage::Keyring).unwrap_err();
        assert_eq!(e.message, "Couldn't read the token for h from the system keyring: no Secret Service on the session bus");
    }

    #[test]
    fn a_crash_after_the_move_still_heals_a_record_saying_file() {
        let tmp = tempfile::tempdir().unwrap();
        let keyring = LateKeyring::default();
        keyring.up.store(true, std::sync::atomic::Ordering::SeqCst);
        // The move ran (keyring has it, the file doesn't); the profile still says File.
        keyring.map.lock().unwrap().insert("default/gitlab.example.com".into(), TOKEN.into());
        let store = SystemTokenStore::new(Some(Box::new(keyring)), FileTokenStore::new(tmp.path().join("forge-tokens")));
        let k = key("gitlab.example.com");
        assert_eq!(store.migrate_to_keyring(&k).unwrap(), Some(TokenStorage::Keyring));
        assert_eq!(store.migrate_to_keyring(&key("other.example.com")).unwrap(), None, "a token in neither place isn't moved");
    }

    #[test]
    fn a_loose_directory_is_tightened_and_a_foreign_one_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        gitvolt_core::platform::fs::set_mode(&dir, 0o777).unwrap();
        let path = dir.join("forge-tokens");
        FileTokenStore::new(path.clone()).put(&key("h"), &Secret::new("x")).unwrap();
        assert_mode!(&dir, 0o700);
        assert_mode!(&path, 0o600);
        assert!(check_owner(&dir, false).is_err());
        assert!(check_owner(&dir, true).is_ok());
    }

    #[cfg(unix)] // symlinks (Windows: privileges)
    #[test]
    fn a_planted_symlink_is_never_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim");
        std::fs::write(&victim, "keep").unwrap();
        let dir = tmp.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(&victim, dir.join(format!(".forge-tokens.{}.tmp", std::process::id()))).unwrap();
        let path = dir.join("forge-tokens");
        let store = FileTokenStore::new(path.clone());
        store.put(&key("h"), &Secret::new("x")).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        // A symlinked token file is refused outright.
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&victim, &path).unwrap();
        assert!(store.get(&key("h"), TokenStorage::File).is_err());
        assert!(store.put(&key("h"), &Secret::new("y")).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
    }

    struct Refusing(bool);
    impl SecretBackend for Refusing {
        fn set(&self, _: &str, _: &str) -> Result<(), BackendError> { Ok(()) }
        fn get(&self, _: &str) -> Result<Option<String>, BackendError> { Ok(None) }
        fn delete(&self, _: &str) -> Result<(), BackendError> {
            Err(if self.0 { BackendError::Other("access denied".into()) } else { BackendError::Unavailable("no bus".into()) })
        }
    }

    #[test]
    fn a_refused_keyring_delete_is_an_error_but_an_absent_one_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let refused = SystemTokenStore::new(Some(Box::new(Refusing(true))), FileTokenStore::new(tmp.path().join("t")));
        let e = refused.delete(&key("h")).unwrap_err();
        assert_eq!(e.message, "Couldn't delete the token for h from the system keyring: access denied");
        let absent = SystemTokenStore::new(Some(Box::new(Refusing(false))), FileTokenStore::new(tmp.path().join("t")));
        absent.delete(&key("h")).unwrap();
    }

    #[cfg(unix)] // symlinks (Windows: privileges)
    #[test]
    fn a_failed_file_cleanup_after_a_keyring_save_still_reports_the_keyring() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("v");
        std::fs::write(&victim, "").unwrap();
        let path = tmp.path().join("forge-tokens");
        std::os::unix::fs::symlink(&victim, &path).unwrap(); // makes the file store's delete fail
        let store = SystemTokenStore::new(Some(Box::new(FakeKeyring { up: true, ..Default::default() })), FileTokenStore::new(path));
        assert_eq!(store.put(&key("h"), &Secret::new("x")).unwrap(), TokenStorage::Keyring);
    }

    #[test]
    fn two_stores_on_one_file_keep_both_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("d").join("forge-tokens");
        let hs: Vec<_> = (0..2)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let s = FileTokenStore::new(path);
                    for i in 0..15 {
                        s.put(&key(&format!("h{t}-{i}")), &Secret::new("x")).unwrap();
                    }
                })
            })
            .collect();
        hs.into_iter().for_each(|h| h.join().unwrap());
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["tokens"].as_object().unwrap().len(), 30);
    }
}
