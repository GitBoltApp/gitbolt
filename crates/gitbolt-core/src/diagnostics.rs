//! "Copy diagnostics" (spec §16.2): versions, OS, CEF/Chromium, git and the settings with
//! secrets removed and `$HOME` shown as `~`.

use crate::redact::redact;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UiDiagnostics {
    pub user_agent: String,
    #[ts(type = "unknown")]
    pub settings: Value,
}

pub struct DiagnosticsInput<'a> {
    pub app_version: &'a str,
    pub runtime: &'a str,
    pub git_version: Option<(u32, u32, u32)>,
    pub os: String,
    pub session: String,
    pub ui: &'a UiDiagnostics,
}

pub fn chromium_version(user_agent: &str) -> Option<&str> {
    let rest = &user_agent[user_agent.find("Chrome/")? + "Chrome/".len()..];
    Some(rest.split_whitespace().next().unwrap_or(rest))
}

const SECRET_KEYS: &[&str] = &["token", "password", "passphrase", "secret", "authorization", "credential", "apikey", "api_key", "privatekey", "private_key"];

/// Settings with secret-looking keys masked and every string passed through `redact`.
pub fn scrub_settings(v: &Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, val)| {
                    let lower = k.to_ascii_lowercase();
                    let masked = SECRET_KEYS.iter().any(|s| lower.contains(s));
                    (k.clone(), if masked { Value::String("***".into()) } else { scrub_settings(val) })
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(scrub_settings).collect()),
        Value::String(s) => Value::String(redact(s)),
        other => other.clone(),
    }
}

/// Shows the home directory as `~`, so the text doesn't carry the user's name.
pub fn tilde_home(text: &str, home: Option<&Path>) -> String {
    match home.and_then(|h| h.to_str()).filter(|h| h.len() > 1) {
        Some(h) => text.replace(h, "~"),
        None => text.to_string(),
    }
}

/// `PRETTY_NAME` from /etc/os-release, the kernel release and the architecture. macOS: its
/// version and build, from SystemVersion.plist.
pub fn os_description() -> String {
    #[cfg(target_os = "macos")]
    if let Some(desc) = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok().and_then(|p| macos_description(&p)) {
        return desc;
    }
    let pretty = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string())))
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.trim().to_string()).unwrap_or_default();
    format!("{pretty} (Linux {kernel}, {})", std::env::consts::ARCH)
}

/// `macOS <ProductVersion> (<ProductBuildVersion>, <arch>)` from a SystemVersion.plist.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_description(plist: &str) -> Option<String> {
    let value = |key: &str| {
        let rest = &plist[plist.find(&format!("<key>{key}</key>"))?..];
        let start = rest.find("<string>")? + "<string>".len();
        let len = rest[start..].find("</string>")?;
        Some(rest[start..start + len].trim().to_string())
    };
    let version = value("ProductVersion")?;
    let build = value("ProductBuildVersion").unwrap_or_default();
    Some(format!("macOS {version} ({build}, {})", std::env::consts::ARCH))
}

/// The session type, noting that the CEF runtime always draws through X11 (spec §4.1).
pub fn session_description() -> String {
    match std::env::var("XDG_SESSION_TYPE").as_deref() {
        Ok("wayland") => "wayland (window via XWayland)".into(),
        Ok(other) if !other.is_empty() => other.to_string(),
        _ => "unknown".into(),
    }
}

pub fn format(i: &DiagnosticsInput) -> String {
    let git = i.git_version.map(|(a, b, c)| format!("{a}.{b}.{c}")).unwrap_or_else(|| "unavailable".into());
    let settings = serde_json::to_string_pretty(&scrub_settings(&i.ui.settings)).unwrap_or_default();
    let text = format!(
        "GitBolt {}\nRuntime: {}\nChromium: {}\nOS: {}\nSession: {}\ngit: {}\nSettings:\n{}\n",
        i.app_version,
        i.runtime,
        chromium_version(&i.ui.user_agent).unwrap_or("unknown"),
        i.os,
        i.session,
        git,
        settings
    );
    tilde_home(&text, crate::paths::home_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_chromium_version_from_the_user_agent() {
        let ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";
        assert_eq!(chromium_version(ua), Some("152.0.7977.83"));
        assert_eq!(chromium_version("Mozilla/5.0 Firefox/140.0"), None);
    }

    #[test]
    fn reads_the_macos_version_from_its_plist() {
        let plist = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>ProductBuildVersion</key>\n\t<string>24F74</string>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.5</string>\n</dict>\n</plist>\n";
        assert_eq!(macos_description(plist), Some(format!("macOS 15.5 (24F74, {})", std::env::consts::ARCH)));
        assert_eq!(macos_description("<plist/>"), None);
    }

    /// On macOS the real plist reads.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_macs_version_is_described() {
        assert!(os_description().starts_with("macOS "), "{}", os_description());
    }

    #[test]
    fn scrub_settings_hides_secrets() {
        let token = format!("glpat-{}", "x".repeat(24));
        let v = json!({
            "theme": "nord",
            "forgeAccounts": [{"host": "gitlab.example.com", "token": token, "patExpires": "2027-01-01"}],
            "proxy": "https://user:hunter2@proxy.example.com",
            "askpassSecret": "s3cret",
            "nested": {"password": "p", "Authorization": "Bearer abc"}
        });
        let s = scrub_settings(&v).to_string();
        assert!(!s.contains(&token) && !s.contains("hunter2") && !s.contains("s3cret") && !s.contains("\"p\"") && !s.contains("Bearer abc"), "{s}");
        assert!(s.contains("\"theme\":\"nord\""));
        assert!(s.contains("gitlab.example.com"));
        assert!(s.contains("https://***@proxy.example.com"));
    }

    #[test]
    fn home_becomes_a_tilde() {
        assert_eq!(tilde_home("/home/ada/repos/x and /home/adam", Some(Path::new("/home/ada"))), "~/repos/x and ~m");
        assert_eq!(tilde_home("/x", None), "/x");
        assert_eq!(tilde_home("/x", Some(Path::new("/"))), "/x");
    }

    #[test]
    fn formats_every_section() {
        let ui = UiDiagnostics { user_agent: "x Chrome/152.0.7977.83 y".into(), settings: json!({"theme": "nord"}) };
        let text = format(&DiagnosticsInput { app_version: "0.1.0", runtime: "tauri 3.0.0-alpha.3", git_version: Some((2, 53, 0)), os: "Ubuntu 26.04.1 LTS (Linux 7.0.0-31-generic, x86_64)".into(), session: "wayland (window via XWayland)".into(), ui: &ui });
        for line in ["GitBolt 0.1.0", "Runtime: tauri 3.0.0-alpha.3", "Chromium: 152.0.7977.83", "OS: Ubuntu 26.04.1 LTS", "Session: wayland", "git: 2.53.0", "\"theme\": \"nord\""] {
            assert!(text.contains(line), "missing {line:?} in:\n{text}");
        }
    }
}
