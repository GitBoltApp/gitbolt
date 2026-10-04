//! Where an account's API, web pages and avatars are (spec #4 §3.1). The harness replaces them
//! per host with its fake forge's (`ForgeConfig.overrides`, T10).

use gitbolt_core::forge::ForgeKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEndpoints {
    /// `https://gitlab.example.com/api/v4`, `https://api.github.com`. No trailing slash.
    pub api: String,
    /// `https://gitlab.example.com`, `https://github.com`.
    pub web: String,
    /// GitHub's avatar host; `None` for GitLab (its avatars are under `web`).
    pub avatars: Option<String>,
}

pub fn default_endpoints(kind: ForgeKind, host: &str) -> HostEndpoints {
    match kind {
        ForgeKind::GitLab => HostEndpoints { api: format!("https://{host}/api/v4"), web: format!("https://{host}"), avatars: None },
        ForgeKind::GitHub => HostEndpoints { api: "https://api.github.com".into(), web: "https://github.com".into(), avatars: Some("https://avatars.githubusercontent.com".into()) },
    }
}
