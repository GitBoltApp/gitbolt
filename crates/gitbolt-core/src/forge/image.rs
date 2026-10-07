//! An image a rendered Markdown body links, as the core fetched it (spec #5 §4.2). The forge's own
//! hosts load through the target project's provider (its allowlist, the token only to the
//! account's own API host); anything else is the user's choice ("Load image from <host>") and
//! goes through the connector's token-less client.

use crate::error::GbError;
use crate::forge::hub::ForgeHub;
use crate::payload::RemotePayload;
use crate::settings::SettingsStore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ForgeImage {
    /// The picture (png, gif, webp or jpeg), base64.
    Found { mime: String, base64: String },
    /// Not shown: a 404, not an image GitBolt shows (SVG included), a sign-in page. `reason` is
    /// short and says why ("404", "needs sign-in"); the placeholder shows it on hover.
    Missing { reason: String },
    /// A 401/403: a signed address whose signature ran out (GitHub's private attachments). The UI
    /// asks for the bodies again, which carry fresh signatures.
    Expired,
    /// Not one of the forge's own hosts, or it redirected off them: the UI offers to load it.
    Ask { host: String },
}

impl ForgeImage {
    pub fn ask(url: &str) -> Self {
        Self::Ask { host: image_host(url) }
    }
}

/// `url`'s `host[:port]`, lowercased, without userinfo (what "Load image from <host>" names).
pub fn image_host(url: &str) -> String {
    let rest = url.trim().split_once("://").map_or(url.trim(), |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    authority.rsplit('@').next().unwrap_or(authority).to_ascii_lowercase()
}

/// The extension a video type plays as.
fn video_ext(mime: &str) -> &'static str {
    match mime {
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/ogg" => "ogv",
        _ => "mp4",
    }
}

/// The file "Open with default app" saves a video as: the address's own file name (letters,
/// digits, `.`, `-` and `_` kept) with the extension its type plays as, else `video.<ext>`.
pub fn video_file_name(url: &str, mime: &str) -> String {
    let ext = video_ext(mime);
    let path = url.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    let clean: String = last.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let stem = clean.rsplit_once('.').map_or(clean.as_str(), |(s, _)| s).trim_start_matches('.');
    if stem.is_empty() { format!("video.{ext}") } else { format!("{stem}.{ext}") }
}

/// Where that file goes in the app's cache (`open_copy::write_copy`'s key): the address's SHA-256,
/// 16 hex digits, so the same video is saved once.
pub fn video_key(url: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(url.trim().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

impl ForgeHub {
    /// `user_allowed`: the user clicked "Load image from <host>": the connector's token-less
    /// fetch, no account needed. Otherwise only an address the target project's provider serves
    /// (`ForgeProvider::image`); anything else, or no target, answers `Ask` without a request.
    pub async fn image(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], url: &str, user_allowed: bool) -> Result<ForgeImage, GbError> {
        self.media(store, remotes, url, user_allowed, false).await
    }

    /// `image` for a video (`ForgeProvider::video`, the connector's `public_video`).
    pub async fn video(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], url: &str, user_allowed: bool) -> Result<ForgeImage, GbError> {
        self.media(store, remotes, url, user_allowed, true).await
    }

    async fn media(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], url: &str, user_allowed: bool, video: bool) -> Result<ForgeImage, GbError> {
        let url = url.trim();
        let got = if user_allowed {
            if video { self.connector().public_video(url).await } else { self.connector().public_image(url).await }
        } else {
            let Ok(t) = self.mr_target(store, remotes).await else { return Ok(ForgeImage::ask(url)) };
            let fetch = if video { t.provider.video(&t.project, url) } else { t.provider.image(&t.project, url) };
            let Some(fetch) = fetch else { return Ok(ForgeImage::ask(url)) };
            fetch.await
        };
        // The host only: a path can carry an upload's secret, a query a signature.
        let host = image_host(url);
        let what = if video { "video" } else { "image" };
        match &got {
            Ok(ForgeImage::Missing { reason }) => tracing::warn!("markdown {what} from {host} not loaded: {reason}"),
            Ok(ForgeImage::Expired) => tracing::warn!("markdown {what} from {host} not loaded: its signature ran out"),
            Err(e) => tracing::warn!("markdown {what} from {host} not loaded: {}", e.message),
            Ok(_) => {}
        }
        got
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::fake::*;
    use crate::forge::{ForgeKind, TokenStorage};
    use crate::redact::Secret;
    use crate::remotes::HostKind;

    const TOKEN: &str = "glpat-FAKE-test-token";
    const HOST: &str = "gitlab.example.com";
    const UPLOAD: &str = "https://gitlab.example.com/group/project/uploads/0123456789abcdef0123456789abcdef/a.png";

    fn origin() -> Vec<RemotePayload> {
        vec![RemotePayload { name: "origin".into(), host: Some(HOST.into()), path: Some("group/project".into()), host_kind: HostKind::GitLab, main: false }]
    }

    fn png() -> ForgeImage {
        ForgeImage::Found { mime: "image/png".into(), base64: "iVBORw==".into() }
    }

    async fn setup() -> (Arc<FakeConnector>, Arc<FakeProvider>, ForgeHub, Arc<SettingsStore>) {
        let p = FakeProvider::new(ForgeKind::GitLab, HOST);
        p.projects.lock().unwrap().insert("group/project".into(), project(HOST, "group/project", None, 200));
        p.images.lock().unwrap().insert(UPLOAD.into(), png());
        let conn = Arc::new(FakeConnector::default());
        let p = conn.add(TOKEN, p);
        let hub = ForgeHub::new(conn.clone(), MemTokens::new(TokenStorage::Keyring), Arc::new(|| 1_791_115_200_000));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        (conn, p, hub, store)
    }

    #[tokio::test]
    async fn an_image_on_the_forge_comes_from_its_provider() {
        let (conn, p, hub, store) = setup().await;
        assert_eq!(hub.image(&store, &origin(), &format!("  {UPLOAD} "), false).await.unwrap(), png());
        assert!(p.calls().contains(&format!("image {UPLOAD}")), "{:?}", p.calls());
        assert!(conn.public_calls.lock().unwrap().is_empty());
    }

    /// On the test's own thread, so the WARN it logs is the one captured.
    #[tokio::test]
    async fn an_image_not_loaded_is_a_warning_naming_its_host_and_why_only() {
        #[derive(Clone, Default)]
        struct Buf(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let out = buf.clone();
        let sub = tracing_subscriber::fmt().with_writer(move || out.clone()).with_ansi(false).with_max_level(tracing::Level::WARN).finish();
        let _guard = tracing::subscriber::set_default(sub);
        let (_, p, hub, store) = setup().await;
        let signed = "https://gitlab.example.com/group/project/uploads/0123456789abcdef0123456789abcdef/b.png?sig=abc123";
        p.images.lock().unwrap().insert(signed.into(), ForgeImage::Missing { reason: "needs sign-in".into() });
        hub.image(&store, &origin(), signed, false).await.unwrap();
        let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains("WARN") && text.contains("markdown image from gitlab.example.com not loaded: needs sign-in"), "{text}");
        assert!(!text.contains("0123456789abcdef") && !text.contains("abc123") && !text.contains(TOKEN), "{text}");
    }

    #[tokio::test]
    async fn any_other_address_asks_first_and_fetches_nothing() {
        let (conn, _, hub, store) = setup().await;
        let got = hub.image(&store, &origin(), "https://CDN.example.org:8443/x.png", false).await.unwrap();
        assert_eq!(got, ForgeImage::Ask { host: "cdn.example.org:8443".into() });
        assert!(conn.public_calls.lock().unwrap().is_empty(), "no request before the click");
    }

    #[tokio::test]
    async fn without_a_forge_target_every_image_asks() {
        let (_, _, hub, store) = setup().await;
        assert_eq!(hub.image(&store, &[], UPLOAD, false).await.unwrap(), ForgeImage::Ask { host: HOST.into() });
    }

    #[tokio::test]
    async fn a_clicked_image_goes_through_the_connector_without_an_account() {
        let (conn, p, hub, store) = setup().await;
        conn.public.lock().unwrap().insert("https://cdn.example.org/x.png".into(), png());
        assert_eq!(hub.image(&store, &[], "https://cdn.example.org/x.png", true).await.unwrap(), png());
        assert_eq!(*conn.public_calls.lock().unwrap(), ["https://cdn.example.org/x.png"]);
        assert!(!p.calls().iter().any(|c| c.starts_with("image ")), "the provider (and its token) isn't involved");
    }

    #[tokio::test]
    async fn a_video_comes_from_its_provider_too_and_a_clicked_one_from_the_connector() {
        let (conn, p, hub, store) = setup().await;
        let clip = "https://gitlab.example.com/group/project/uploads/0123456789abcdef0123456789abcdef/clip.webm";
        let webm = ForgeImage::Found { mime: "video/webm".into(), base64: "GkXfow==".into() };
        p.videos.lock().unwrap().insert(clip.into(), webm.clone());
        assert_eq!(hub.video(&store, &origin(), clip, false).await.unwrap(), webm);
        assert!(p.calls().contains(&format!("video {clip}")), "{:?}", p.calls());
        assert_eq!(hub.video(&store, &origin(), "https://cdn.example.org/x.webm", false).await.unwrap(), ForgeImage::Ask { host: "cdn.example.org".into() });
        conn.public.lock().unwrap().insert("https://cdn.example.org/x.webm".into(), webm.clone());
        assert_eq!(hub.video(&store, &[], "https://cdn.example.org/x.webm", true).await.unwrap(), webm);
        assert_eq!(*conn.public_calls.lock().unwrap(), ["video https://cdn.example.org/x.webm"]);
    }

    #[test]
    fn a_saved_video_keeps_its_name_with_the_extension_its_type_plays_as() {
        let up = "https://gitlab.example.com/group/project/uploads/0123456789abcdef0123456789abcdef";
        assert_eq!(video_file_name(&format!("{up}/screen%20rec.mp4?x=1#t"), "video/mp4"), "screen20rec.mp4");
        assert_eq!(video_file_name(&format!("{up}/clip.webm"), "video/webm"), "clip.webm");
        assert_eq!(video_file_name(&format!("{up}/demo.MOV"), "video/quicktime"), "demo.mov");
        assert_eq!(video_file_name(&format!("{up}/../.."), "video/mp4"), "video.mp4");
        assert_eq!(video_file_name(&format!("{up}/"), "video/ogg"), "video.ogv");
        assert_eq!(video_key(&format!("{up}/clip.webm")).len(), 16);
        assert_ne!(video_key(&format!("{up}/clip.webm")), video_key(&format!("{up}/other.webm")));
    }

    #[test]
    fn the_host_is_the_authority_without_userinfo() {
        assert_eq!(image_host("https://u:p@Host.Example:8443/x?y#z"), "host.example:8443");
        assert_eq!(image_host("https://cdn.example.org"), "cdn.example.org");
    }
}
