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
    /// A 404, or not an image GitBolt shows (SVG included).
    Missing,
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

impl ForgeHub {
    /// `user_allowed`: the user clicked "Load image from <host>": the connector's token-less
    /// fetch, no account needed. Otherwise only an address the target project's provider serves
    /// (`ForgeProvider::image`); anything else, or no target, answers `Ask` without a request.
    pub async fn image(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], url: &str, user_allowed: bool) -> Result<ForgeImage, GbError> {
        let url = url.trim();
        if user_allowed {
            return self.connector().public_image(url).await;
        }
        let Ok(t) = self.mr_target(store, remotes).await else { return Ok(ForgeImage::ask(url)) };
        match t.provider.image(&t.project, url) {
            Some(fetch) => fetch.await,
            None => Ok(ForgeImage::ask(url)),
        }
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

    #[test]
    fn the_host_is_the_authority_without_userinfo() {
        assert_eq!(image_host("https://u:p@Host.Example:8443/x?y#z"), "host.example:8443");
        assert_eq!(image_host("https://cdn.example.org"), "cdn.example.org");
    }
}
