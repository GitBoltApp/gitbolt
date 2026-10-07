//! GitBolt's own releases on the fake GitHub (the update check): the API's release list, and
//! each asset's download, which redirects to a storage host as GitHub's does and streams there,
//! in chunks a test can slow down. Assets are made-up bytes; `SHA256SUMS` lists their real
//! digests unless the seed asks for a wrong one.

use super::{ForgeState, FakeRequest, Reply};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Where the releases live (core's `RELEASES_REPO`).
pub const REPO: &str = "GitBoltApp/gitbolt";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeAsset {
    pub name: String,
    /// Its made-up content's length (`SHA256SUMS` is generated whatever this says).
    pub size: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FakeRelease {
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<FakeAsset>,
    /// Asset names `SHA256SUMS` gives a wrong digest for.
    pub bad_sums: Vec<String>,
}

/// An asset's made-up bytes: its name, repeated to `size`.
pub fn asset_bytes(a: &FakeAsset) -> Vec<u8> {
    a.name.bytes().cycle().take(a.size).collect()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `sha256sum` of the release's other assets.
pub fn sums(r: &FakeRelease) -> Vec<u8> {
    r.assets
        .iter()
        .filter(|a| a.name != "SHA256SUMS")
        .map(|a| format!("{}  {}\n", if r.bad_sums.contains(&a.name) { "0".repeat(64) } else { hex(&asset_bytes(a)) }, a.name))
        .collect::<String>()
        .into_bytes()
}

fn content(r: &FakeRelease, a: &FakeAsset) -> Vec<u8> {
    if a.name == "SHA256SUMS" { sums(r) } else { asset_bytes(a) }
}

/// `GET /repos/GitBoltApp/gitbolt/releases` (no token needed, as on GitHub).
pub(crate) fn api(st: &ForgeState, r: &FakeRequest) -> Option<Reply> {
    if r.method != "GET" || r.path != format!("/repos/{REPO}/releases") {
        return None;
    }
    let list: Vec<Value> = st
        .seed
        .github
        .releases
        .iter()
        .map(|rel| {
            json!({
                "tag_name": rel.tag_name, "name": rel.name, "body": rel.body, "draft": rel.draft, "prerelease": rel.prerelease,
                "html_url": format!("{}/github-web/{REPO}/releases/tag/{}", r.base, rel.tag_name),
                "published_at": "2026-10-07T12:00:00Z",
                "assets": rel.assets.iter().map(|a| json!({
                    "name": a.name, "size": content(rel, a).len(),
                    "browser_download_url": format!("{}/github-releases/{REPO}/releases/download/{}/{}", r.base, rel.tag_name, a.name),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Some(Reply::json(Value::Array(list)))
}

/// `/github-releases/<repo>/releases/download/<tag>/<name>`: a redirect to its storage host.
pub(crate) fn download(r: &FakeRequest) -> Reply {
    match r.segments.as_slice() {
        [owner, repo, releases, download, tag, name] if format!("{owner}/{repo}") == REPO && releases == "releases" && download == "download" => Reply::redirect(&format!("{}/github-objects/{tag}/{name}?signature=fake", r.base)),
        _ => Reply::status(404, json!({ "message": "Not Found" })),
    }
}

/// `/github-objects/<tag>/<name>`: the bytes and the delay between 64 KiB chunks.
pub(crate) fn object(st: &ForgeState, path: &str) -> Option<(Vec<u8>, u64)> {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (tag, name) = (parts.next()?, parts.next()?);
    let rel = st.seed.github.releases.iter().find(|r| r.tag_name == tag)?;
    let a = rel.assets.iter().find(|a| a.name == name)?;
    Some((content(rel, a), st.seed.github.download_chunk_delay_ms))
}
