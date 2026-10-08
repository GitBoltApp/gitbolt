//! GitHub's releases as the update check reads them: which one is an update, which of its assets
//! this install takes, and the `SHA256SUMS` check of a download.
//!
//! The asset names are an API (docs/releasing.md): an installed GitBolt finds its package in a
//! later release by these names.

use super::install::InstallKind;
use super::version::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// The checksums asset every release carries (`sha256sum` output).
pub const SUMS_ASSET: &str = "SHA256SUMS";

/// One release from `GET /repos/{owner}/{repo}/releases`, the fields GitBolt reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GhAsset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    pub browser_download_url: String,
}

impl GhRelease {
    pub fn asset(&self, name: &str) -> Option<&GhAsset> {
        self.assets.iter().find(|a| a.name == name)
    }
}

/// The newest release that's newer than `current`, with its version. Drafts never count; a
/// pre-release only with `include_pre` or when `current` is one itself (a pre-release build
/// always sees the next pre-release). A tag that isn't a version is skipped.
pub fn newest_update<'a>(releases: &'a [GhRelease], current: &Version, include_pre: bool) -> Option<(&'a GhRelease, Version)> {
    let pre_ok = include_pre || current.is_prerelease();
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| Some((r, Version::parse(&r.tag_name)?)))
        .filter(|(r, v)| pre_ok || !(r.prerelease || v.is_prerelease()))
        .filter(|(_, v)| v > current)
        .max_by(|a, b| a.1.cmp(&b.1))
}

/// The asset a `kind` install takes from the release of `version` (docs/releasing.md):
/// - deb: `GitBolt_<version>_amd64.deb`;
/// - arch: `GitBolt-<pkgver>-1-x86_64.pkg.tar.zst`, where pkgver drops the pre-release's `-`
///   (`0.3.0-rc.1` → `0.3.0rc.1`, scripts/arch-pkg.py);
/// - nsis: `GitBolt_<version>_x64-setup.exe`; msi: `GitBolt_<version>_x64.msi`;
/// - dmg: `GitBolt_<version>_<arch>.dmg`, this machine's: `aarch64` (Apple Silicon) or `x64`
///   (Intel, which has no release yet), as Tauri's bundler names them;
/// - none for a build from source.
pub fn asset_name(kind: InstallKind, version: &Version) -> Option<String> {
    let v = version.without_build();
    match kind {
        InstallKind::Deb => Some(format!("GitBolt_{v}_amd64.deb")),
        InstallKind::Arch => Some(format!("GitBolt-{}-1-x86_64.pkg.tar.zst", v.replacen('-', "", 1))),
        InstallKind::Nsis => Some(format!("GitBolt_{v}_x64-setup.exe")),
        InstallKind::Msi => Some(format!("GitBolt_{v}_x64.msi")),
        InstallKind::Dmg => Some(format!("GitBolt_{v}_{DMG_ARCH}.dmg")),
        InstallKind::Unpackaged => None,
    }
}

/// The `.dmg` architecture this build takes.
const DMG_ARCH: &str = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };

/// `sha256sum`'s output: file name → lowercase hex digest. Binary-mode names (`*name`) count
/// too; anything else on a line is ignored.
pub fn parse_sums(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (hash, name) = line.trim_end().split_once(char::is_whitespace)?;
            let name = name.trim_start();
            let name = name.strip_prefix('*').unwrap_or(name);
            (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && !name.is_empty()).then(|| (name.to_string(), hash.to_ascii_lowercase()))
        })
        .collect()
}

/// The file's SHA-256, lowercase hex.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SumCheck {
    /// It matches: the digest.
    Good(String),
    /// `SHA256SUMS` doesn't list it.
    Missing,
    /// It lists another digest.
    Mismatch,
}

/// Checks `path` (the download of `name`) against `sums` (the release's `SHA256SUMS`).
pub fn check_sum(path: &Path, name: &str, sums: &str) -> std::io::Result<SumCheck> {
    let Some(want) = parse_sums(sums).remove(name) else { return Ok(SumCheck::Missing) };
    let got = sha256_file(path)?;
    Ok(if got == want { SumCheck::Good(got) } else { SumCheck::Mismatch })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, pre: bool, draft: bool) -> GhRelease {
        GhRelease { tag_name: tag.into(), name: Some(format!("GitBolt {}", tag.trim_start_matches('v'))), body: None, draft, prerelease: pre, html_url: format!("https://github.example/r/{tag}"), published_at: None, assets: Vec::new() }
    }

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn pick(list: &[GhRelease], current: &str, pre: bool) -> Option<String> {
        newest_update(list, &v(current), pre).map(|(r, _)| r.tag_name.clone())
    }

    #[test]
    fn offers_the_newest_release_newer_than_this_one() {
        let list = [release("v0.2.0", false, false), release("v0.3.0", false, false), release("v0.2.1", false, false)];
        assert_eq!(pick(&list, "0.2.0", false).as_deref(), Some("v0.3.0"));
        assert_eq!(pick(&list, "0.3.0", false), None);
        assert_eq!(pick(&list, "0.4.0", false), None);
    }

    #[test]
    fn a_dev_build_isnt_offered_its_own_version() {
        let list = [release("v0.2.0", false, false)];
        assert_eq!(pick(&list, "0.2.0+202610072046.d1d4d7d", false), None);
        assert_eq!(pick(&list, "0.1.9+202610072046.d1d4d7d", false).as_deref(), Some("v0.2.0"));
    }

    #[test]
    fn drafts_are_never_offered() {
        let list = [release("v0.9.0", false, true), release("v0.3.0", false, false)];
        assert_eq!(pick(&list, "0.2.0", true).as_deref(), Some("v0.3.0"));
    }

    #[test]
    fn pre_releases_only_when_asked_or_running_one() {
        let list = [release("v0.3.0", false, false), release("v0.4.0-rc.1", true, false)];
        assert_eq!(pick(&list, "0.2.0", false).as_deref(), Some("v0.3.0"));
        assert_eq!(pick(&list, "0.2.0", true).as_deref(), Some("v0.4.0-rc.1"));
        assert_eq!(pick(&list, "0.4.0-alpha.1", false).as_deref(), Some("v0.4.0-rc.1"));
        // GitHub's flag counts even when the tag looks like a release, and the tag when the flag is off.
        let odd = [release("v0.5.0", true, false), release("v0.6.0-beta", false, false)];
        assert_eq!(pick(&odd, "0.2.0", false), None);
        // The release of a pre-release build's version is newer than it.
        assert_eq!(pick(&[release("v0.4.0", false, false)], "0.4.0-rc.1", false).as_deref(), Some("v0.4.0"));
    }

    #[test]
    fn tags_that_arent_versions_are_skipped() {
        let list = [release("nightly", false, false), release("v0.3.0", false, false)];
        assert_eq!(pick(&list, "0.2.0", false).as_deref(), Some("v0.3.0"));
    }

    #[test]
    fn each_install_kind_takes_its_package() {
        let rel = v("0.3.0");
        let rc = v("0.3.0-rc.1");
        assert_eq!(asset_name(InstallKind::Deb, &rel).as_deref(), Some("GitBolt_0.3.0_amd64.deb"));
        assert_eq!(asset_name(InstallKind::Deb, &rc).as_deref(), Some("GitBolt_0.3.0-rc.1_amd64.deb"));
        assert_eq!(asset_name(InstallKind::Arch, &rel).as_deref(), Some("GitBolt-0.3.0-1-x86_64.pkg.tar.zst"));
        assert_eq!(asset_name(InstallKind::Arch, &rc).as_deref(), Some("GitBolt-0.3.0rc.1-1-x86_64.pkg.tar.zst"));
        assert_eq!(asset_name(InstallKind::Nsis, &rel).as_deref(), Some("GitBolt_0.3.0_x64-setup.exe"));
        assert_eq!(asset_name(InstallKind::Msi, &rel).as_deref(), Some("GitBolt_0.3.0_x64.msi"));
        let dmg = if cfg!(target_arch = "aarch64") { "GitBolt_0.3.0-rc.1_aarch64.dmg" } else { "GitBolt_0.3.0-rc.1_x64.dmg" };
        assert_eq!(asset_name(InstallKind::Dmg, &rc).as_deref(), Some(dmg));
        assert_eq!(asset_name(InstallKind::Unpackaged, &rel), None);
    }

    #[test]
    fn reads_sha256sum_output() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let sums = parse_sums(&format!("{a}  GitBolt_0.3.0_amd64.deb\n{b} *GitBolt-0.3.0-1-x86_64.pkg.tar.zst\nnot a line\n{}  short\n", "c".repeat(10)));
        assert_eq!(sums.len(), 2);
        assert_eq!(sums["GitBolt_0.3.0_amd64.deb"], a);
        assert_eq!(sums["GitBolt-0.3.0-1-x86_64.pkg.tar.zst"], "b".repeat(64));
    }

    #[test]
    fn checks_a_download_against_the_sums() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("GitBolt_0.3.0_amd64.deb");
        std::fs::write(&file, b"hello").unwrap();
        // sha256("hello")
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(check_sum(&file, "GitBolt_0.3.0_amd64.deb", &format!("{good}  GitBolt_0.3.0_amd64.deb\n")).unwrap(), SumCheck::Good(good.into()));
        assert_eq!(check_sum(&file, "GitBolt_0.3.0_amd64.deb", &format!("{}  GitBolt_0.3.0_amd64.deb\n", "0".repeat(64))).unwrap(), SumCheck::Mismatch);
        assert_eq!(check_sum(&file, "GitBolt_0.3.0_amd64.deb", &format!("{good}  GitBolt-0.3.0-1-x86_64.pkg.tar.zst\n")).unwrap(), SumCheck::Missing);
    }
}
