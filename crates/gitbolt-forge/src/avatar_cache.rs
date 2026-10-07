//! Forge avatars on disk, one directory per forge host, in the Gravatar cache's format (core spec
//! §14.3): `<dir>/<sha256(email)>.<ext>` plus `index.json`. Found avatars stay 7 days and "none"
//! answers 1 day. Network errors are never cached (the caller doesn't store them).

use crate::gravatar::{email_key, ensure_private_dir, image_ext, now, payload, write_atomic, FOUND_TTL_SECS, MISSING_TTL_SECS};
use crate::http::HttpClient;
use gitbolt_core::avatar::AvatarPayload;
use gitbolt_core::error::GbError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Entries kept per host; the oldest go first.
pub const MAX_ENTRIES: usize = 2000;
const EXTS: [&str; 4] = ["png", "gif", "webp", "jpg"];

// --- 5A T3 ---
/// sha256 of `s` exactly as given (no trimming, no case folding), as hex.
pub fn exact_key(s: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
// --- end 5A T3 ---

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

/// An avatar payload, if `content_type` (or, for a generic binary type, `bytes`) is an image
/// GitBolt shows.
pub fn payload_of(content_type: &str, bytes: &[u8]) -> Option<AvatarPayload> {
    image_ext(content_type, bytes).map(|ext| payload(ext, bytes))
}

/// The picture at `url` (a forge's `avatar_url`, already allowed by the caller), through the
/// host's cache keyed by the URL: `HttpClient::get_image`'s size cap, redirect and token rules.
pub async fn image_at(http: &HttpClient, cache: Option<&DiskAvatarCache>, url: &str, own_origin: &str) -> Result<Option<AvatarPayload>, GbError> {
    let key = format!("url:{url}");
    if let Some(cache) = cache {
        match cache.lookup(&key) {
            Lookup::Found(p) => return Ok(Some(p)),
            Lookup::Missing => return Ok(None),
            Lookup::Unknown => {}
        }
    }
    let found = http.get_image(url, own_origin).await?;
    Ok(match (found, cache) {
        (Some((ct, bytes)), Some(cache)) => {
            // A 200 that isn't an image GitBolt shows is "none" for a while, not asked every time.
            let found = cache.store_found(&key, &ct, &bytes);
            if found.is_none() {
                cache.store_missing(&key);
            }
            found
        }
        (Some((ct, bytes)), None) => payload_of(&ct, &bytes),
        (None, Some(cache)) => {
            cache.store_missing(&key);
            None
        }
        (None, None) => None,
    })
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
        self.lookup_hashed(&email_key(email))
    }

    // --- 5A T3: Markdown images keep their case ---
    /// `lookup` by an exact key (`exact_key`): a Markdown image's URL, whose path and query can
    /// differ only in case (base64, case-sensitive hosts). Avatars keep `lookup`'s folded key.
    pub fn lookup_exact(&self, key: &str) -> Lookup {
        self.lookup_hashed(&exact_key(key))
    }

    pub fn store_found_exact(&self, key: &str, content_type: &str, bytes: &[u8]) -> Option<AvatarPayload> {
        self.store_found_hashed(&exact_key(key), content_type, bytes)
    }

    pub fn store_missing_exact(&self, key: &str) {
        self.remember(&exact_key(key), None);
    }
    // --- end 5A T3 ---

    fn lookup_hashed(&self, key: &str) -> Lookup {
        let Some(entry) = self.with_index(|i| i.get(key).cloned()) else { return Lookup::Unknown };
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
        self.store_found_hashed(&email_key(email), content_type, bytes)
    }

    fn store_found_hashed(&self, key: &str, content_type: &str, bytes: &[u8]) -> Option<AvatarPayload> {
        let ext = image_ext(content_type, bytes)?;
        let written = ensure_private_dir(&self.dir).and_then(|_| write_atomic(&self.dir.join(format!("{key}.{ext}")), bytes));
        if let Err(e) = written {
            tracing::warn!("forge avatar not cached: {e}");
        } else {
            self.remember(key, Some(ext));
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

    #[tokio::test]
    async fn a_linked_picture_that_isnt_an_image_is_none_for_a_while() {
        use crate::test_server::{Canned, TestServer};
        let s = TestServer::start(|_, _| Canned { status: 200, headers: vec![("Content-Type".into(), "text/html".into())], body: b"<html>".to_vec() });
        let http = HttpClient::new(crate::http::ClientConfig { host: "h".into(), api_base: format!("{}/api", s.base), token: None, headers: vec![], timeout: std::time::Duration::from_secs(5) });
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskAvatarCache::new(dir.path().join("h"));
        let url = format!("{}/uploads/a.png", s.base);
        assert_eq!(image_at(&http, Some(&cache), &url, &s.base).await.unwrap(), None);
        assert_eq!(image_at(&http, Some(&cache), &url, &s.base).await.unwrap(), None);
        assert_eq!(s.hits(), 1, "remembered as none");
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

    // --- 5A T3 ---
    #[test]
    fn image_keys_keep_their_case_and_avatar_keys_still_fold_it() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskAvatarCache::new(dir.path().join("github.com"));
        let a = "img:https://raw.githubusercontent.com/o/r/main/Shot.png";
        let b = "img:https://raw.githubusercontent.com/o/r/main/shot.png";
        cache.store_found_exact(a, "image/png", b"\x89PNGa").unwrap();
        assert!(matches!(cache.lookup_exact(a), Lookup::Found(_)));
        assert!(matches!(cache.lookup_exact(b), Lookup::Unknown), "a URL differing only in case is another image");
        cache.store_missing_exact(b);
        assert!(matches!(cache.lookup_exact(a), Lookup::Found(_)), "and doesn't overwrite it");
        assert!(matches!(cache.lookup_exact(b), Lookup::Missing));
        assert_ne!(exact_key(a), email_key(a));
        cache.store_found("Ada@Example.com", "image/png", b"\x89PNGx").unwrap();
        assert!(matches!(cache.lookup("ada@example.com"), Lookup::Found(_)), "avatar keys are unchanged");
    }
    // --- end 5A T3 ---

    #[test]
    fn payload_of_takes_images_only() {
        assert!(payload_of("image/jpeg; charset=binary", b"x").is_some());
        assert!(payload_of("application/json", b"{}").is_none());
    }

    #[test]
    fn a_generic_binary_type_is_shown_when_its_bytes_are_an_image() {
        // GitLab's uploads API answers every file as an `application/octet-stream` attachment.
        let png = b"\x89PNG\r\n\x1a\nrest";
        assert_eq!(payload_of("application/octet-stream", png).unwrap().mime, "image/png");
        assert_eq!(payload_of("", b"GIF89a....").unwrap().mime, "image/gif");
        assert_eq!(payload_of("binary/octet-stream", b"\xff\xd8\xff\xe0").unwrap().mime, "image/jpeg");
        assert_eq!(payload_of("application/octet-stream", b"RIFF\x10\0\0\0WEBPVP8 ").unwrap().mime, "image/webp");
        assert!(payload_of("application/octet-stream", b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>").is_none(), "never an SVG");
        assert!(payload_of("text/html", png).is_none(), "only a generic type is sniffed");
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskAvatarCache::new(dir.path().to_path_buf());
        assert_eq!(cache.store_found_exact("img:a", "application/octet-stream", png).unwrap().mime, "image/png");
        assert!(matches!(cache.lookup_exact("img:a"), Lookup::Found(p) if p.mime == "image/png"));
    }
}
