//! Forge avatars on disk, one directory per forge host, in the Gravatar cache's format (core spec
//! §14.3): `<dir>/<sha256(email)>.<ext>` plus `index.json`. Found avatars stay 7 days and "none"
//! answers 1 day. Network errors are never cached (the caller doesn't store them).

use crate::gravatar::{email_key, ensure_private_dir, ext_for, now, payload, write_atomic, FOUND_TTL_SECS, MISSING_TTL_SECS};
use gitbolt_core::avatar::AvatarPayload;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Entries kept per host; the oldest go first.
pub const MAX_ENTRIES: usize = 2000;
const EXTS: [&str; 4] = ["png", "gif", "webp", "jpg"];

fn valid_key(k: &str) -> bool {
    k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit())
}

fn ttl_of(e: &Entry) -> i64 {
    if e.ext.is_some() { FOUND_TTL_SECS } else { MISSING_TTL_SECS }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Entry {
    ext: Option<String>,
    fetched: i64,
}

pub enum Lookup {
    Found(AvatarPayload),
    /// The forge said it has none, recently.
    Missing,
    /// Not asked yet, or long enough ago to ask again.
    Unknown,
}

/// An avatar payload, if `content_type` is an image GitBolt shows.
pub fn payload_of(content_type: &str, bytes: &[u8]) -> Option<AvatarPayload> {
    ext_for(content_type).map(|ext| payload(ext, bytes))
}

pub struct DiskAvatarCache {
    dir: PathBuf,
    index: Mutex<Option<HashMap<String, Entry>>>,
}

impl DiskAvatarCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, index: Mutex::new(None) }
    }

    fn with_index<T>(&self, f: impl FnOnce(&mut HashMap<String, Entry>) -> T) -> T {
        let mut guard = self.index.lock().expect("avatar index poisoned");
        let index = guard.get_or_insert_with(|| self.load());
        f(index)
    }

    /// The index from disk, without entries that are malformed (a bad key or extension, which
    /// would name files outside the cache) or expired; expired images are deleted.
    fn load(&self) -> HashMap<String, Entry> {
        let all: HashMap<String, Entry> = std::fs::read(self.dir.join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let t = now();
        let mut kept = HashMap::new();
        for (k, e) in all {
            if !valid_key(&k) || e.ext.as_deref().is_some_and(|x| !EXTS.contains(&x)) {
                continue;
            }
            if t - e.fetched >= ttl_of(&e) {
                if let Some(x) = &e.ext {
                    let _ = std::fs::remove_file(self.dir.join(format!("{k}.{x}")));
                }
                continue;
            }
            kept.insert(k, e);
        }
        self.cap(&mut kept);
        kept
    }

    fn cap(&self, index: &mut HashMap<String, Entry>) {
        while index.len() > MAX_ENTRIES {
            let Some(oldest) = index.iter().min_by_key(|(_, e)| e.fetched).map(|(k, _)| k.clone()) else { break };
            if let Some(Entry { ext: Some(x), .. }) = index.remove(&oldest) {
                let _ = std::fs::remove_file(self.dir.join(format!("{oldest}.{x}")));
            }
        }
    }

    pub fn lookup(&self, email: &str) -> Lookup {
        let key = email_key(email);
        let Some(entry) = self.with_index(|i| i.get(&key).cloned()) else { return Lookup::Unknown };
        let ttl = if entry.ext.is_some() { FOUND_TTL_SECS } else { MISSING_TTL_SECS };
        if now() - entry.fetched >= ttl {
            return Lookup::Unknown;
        }
        match entry.ext {
            None => Lookup::Missing,
            Some(ext) => match std::fs::read(self.dir.join(format!("{key}.{ext}"))) {
                Ok(bytes) => Lookup::Found(payload(&ext, &bytes)),
                Err(_) => Lookup::Unknown,
            },
        }
    }

    /// Keeps an image and answers its payload; `None` (and nothing kept) if it isn't one.
    pub fn store_found(&self, email: &str, content_type: &str, bytes: &[u8]) -> Option<AvatarPayload> {
        let ext = ext_for(content_type)?;
        let key = email_key(email);
        let written = ensure_private_dir(&self.dir).and_then(|_| write_atomic(&self.dir.join(format!("{key}.{ext}")), bytes));
        if let Err(e) = written {
            tracing::warn!("forge avatar not cached: {e}");
        } else {
            self.remember(&key, Some(ext));
        }
        Some(payload(ext, bytes))
    }

    pub fn store_missing(&self, email: &str) {
        self.remember(&email_key(email), None);
    }

    fn remember(&self, key: &str, ext: Option<&str>) {
        let saved = self.with_index(|index| {
            index.insert(key.to_string(), Entry { ext: ext.map(str::to_string), fetched: now() });
            self.cap(index);
            let json = serde_json::to_vec(index).expect("index serializes");
            ensure_private_dir(&self.dir).and_then(|_| write_atomic(&self.dir.join("index.json"), &json))
        });
        if let Err(e) = saved {
            tracing::warn!("forge avatar index not saved: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn found_and_missing_answers_are_kept_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskAvatarCache::new(dir.path().join("gitlab.example.com"));
        assert!(matches!(cache.lookup("ada@example.com"), Lookup::Unknown));
        let p = cache.store_found(" Ada@Example.com ", "image/png", b"\x89PNGx").unwrap();
        assert_eq!(p.mime, "image/png");
        cache.store_missing("nobody@example.com");
        let again = DiskAvatarCache::new(dir.path().join("gitlab.example.com"));
        assert!(matches!(again.lookup("ada@example.com"), Lookup::Found(q) if q == p));
        assert!(matches!(again.lookup("nobody@example.com"), Lookup::Missing));
        assert!(cache.store_found("x@example.com", "text/html", b"<html>").is_none(), "not an image");
        assert!(matches!(again.lookup("x@example.com"), Lookup::Unknown));
    }

    #[cfg(unix)]
    #[test]
    fn the_cache_directory_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h");
        DiskAvatarCache::new(path.clone()).store_missing("a@example.com");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn a_tampered_or_expired_index_is_pruned_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("h");
        std::fs::create_dir_all(&d).unwrap();
        let good = email_key("a@example.com");
        let old = email_key("old@example.com");
        std::fs::write(d.join(format!("{old}.png")), b"x").unwrap();
        let idx = serde_json::json!({
            good.clone(): {"ext": "png", "fetched": now()},
            old.clone(): {"ext": "png", "fetched": 1},
            "../../evil": {"ext": "png", "fetched": now()},
            email_key("b@example.com"): {"ext": "../x", "fetched": now()},
        });
        std::fs::write(d.join("index.json"), idx.to_string()).unwrap();
        let cache = DiskAvatarCache::new(d.clone());
        assert!(matches!(cache.lookup("old@example.com"), Lookup::Unknown));
        assert!(matches!(cache.lookup("b@example.com"), Lookup::Unknown));
        assert!(!d.join(format!("{old}.png")).exists(), "expired image deleted");
        assert_eq!(cache.with_index(|i| i.len()), 1);
    }

    #[test]
    fn payload_of_takes_images_only() {
        assert!(payload_of("image/jpeg; charset=binary", b"x").is_some());
        assert!(payload_of("application/json", b"{}").is_none());
    }
}
