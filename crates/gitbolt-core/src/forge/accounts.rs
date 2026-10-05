//! Forge accounts (spec #4 §3.2): one per host per profile, kept in the profile (never the
//! token: that's in the token store), with what the UI shows about each.

use crate::error::{GbError, GbErrorKind};
use crate::forge::types::{ForgeKind, ForgeUser, TokenStorage};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeAccount {
    pub host: String,
    pub kind: ForgeKind,
    /// The token's user when the account was added (avatar and name in Settings).
    pub user: ForgeUser,
    pub storage: TokenStorage,
    /// GitLab's version (`19.1.0-ee`), read at add and once a day (spec #4 §3.2).
    // `default`: a profile file from an older or newer GitBolt still loads.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub version_checked_at: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub added_at: i64,
}

/// What the account's last requests said (no request is made to show it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum AccountStatus {
    Ok,
    RateLimited {
        #[ts(type = "number")]
        until: i64,
    },
    AuthFailed { message: String },
    Unreachable { message: String },
    /// The store has no token for it (the keyring was reset, the file deleted).
    TokenMissing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeAccountView {
    pub account: ForgeAccount,
    pub status: AccountStatus,
}

const HOST_ONLY: &str = "Enter the host only, like gitlab.example.com";

/// What the Host box holds, as a host: lowercase, without a scheme, a path or a query; a port
/// stays. Credentials, spaces and an scp-style URL are refused.
pub fn normalize_host(input: &str) -> Result<String, GbError> {
    let bad = || GbError::new(GbErrorKind::InvalidInput, HOST_ONLY);
    let s = input.trim();
    let s = s.split_once("://").map(|(_, rest)| rest).unwrap_or(s);
    let authority = s.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.to_ascii_lowercase();
    let (name, port) = match host.split_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host.as_str(), None),
    };
    let name_ok = !name.is_empty() && !name.starts_with(['-', '.']) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !name_ok || !port_ok {
        return Err(bad());
    }
    Ok(host)
}

/// GitHub accounts are github.com's (GitHub Enterprise Server is out of scope, spec #4 §9).
pub fn check_kind_host(kind: ForgeKind, host: &str) -> Result<(), GbError> {
    if kind == ForgeKind::GitHub && host != "github.com" {
        return Err(GbError::new(GbErrorKind::InvalidInput, "GitHub accounts are for github.com (GitHub Enterprise Server isn't supported)"));
    }
    Ok(())
}

/// The forge's "new token" page, prefilled with the write scope GitBolt needs (spec #4 §2).
pub fn token_page_url(kind: ForgeKind, host: &str) -> String {
    token_page_url_for(kind, host, false)
}

/// Like [`token_page_url`]; `classic` picks GitHub's classic-token page (no lifetime policy,
/// unlike orgs that cap fine-grained tokens). GitLab has no such choice.
pub fn token_page_url_for(kind: ForgeKind, host: &str, classic: bool) -> String {
    const DESCRIPTION: &str = "name=GitBolt&description=GitBolt%20desktop%20client";
    match kind {
        ForgeKind::GitLab => format!("https://{host}/-/user_settings/personal_access_tokens?{DESCRIPTION}&scopes=api"),
        ForgeKind::GitHub if classic => "https://github.com/settings/tokens/new?description=GitBolt%20desktop%20client&scopes=repo,read:org".to_string(),
        ForgeKind::GitHub => format!("https://github.com/settings/personal-access-tokens/new?{DESCRIPTION}&pull_requests=write&issues=write&checks=read&statuses=read&metadata=read&profile=read"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_box_accepts_a_url_and_keeps_only_the_host() {
        assert_eq!(normalize_host(" https://GitLab.Example.com/group/project ").unwrap(), "gitlab.example.com");
        assert_eq!(normalize_host("gitlab.example.com/").unwrap(), "gitlab.example.com");
        assert_eq!(normalize_host("http://gitlab.example.com:8443?x").unwrap(), "gitlab.example.com:8443");
        for bad in ["", "   ", "https://user:pw@gitlab.example.com", "git@gitlab.example.com:group/x.git", "gitlab example.com", "-gitlab.example.com", "gitlab.example.com:port"] {
            let e = normalize_host(bad).unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "Enter the host only, like gitlab.example.com"), "{bad:?}");
        }
        assert!(check_kind_host(ForgeKind::GitHub, "github.com").is_ok());
        assert!(check_kind_host(ForgeKind::GitLab, "gitlab.example.com").is_ok());
        assert_eq!(check_kind_host(ForgeKind::GitHub, "github.example.com").unwrap_err().message, "GitHub accounts are for github.com (GitHub Enterprise Server isn't supported)");
    }

    #[test]
    fn create_token_pages_are_prefilled_with_write_scope() {
        assert_eq!(token_page_url(ForgeKind::GitLab, "gitlab.example.com"), "https://gitlab.example.com/-/user_settings/personal_access_tokens?name=GitBolt&description=GitBolt%20desktop%20client&scopes=api");
        assert_eq!(token_page_url_for(ForgeKind::GitHub, "github.com", true), "https://github.com/settings/tokens/new?description=GitBolt%20desktop%20client&scopes=repo,read:org");
        assert_eq!(token_page_url_for(ForgeKind::GitLab, "gitlab.example.com", true), token_page_url(ForgeKind::GitLab, "gitlab.example.com"));
        assert_eq!(token_page_url(ForgeKind::GitHub, "github.com"), "https://github.com/settings/personal-access-tokens/new?name=GitBolt&description=GitBolt%20desktop%20client&pull_requests=write&issues=write&checks=read&statuses=read&metadata=read&profile=read");
    }

    #[test]
    fn an_account_saved_without_the_optional_fields_still_loads() {
        let profile = serde_json::json!({
            "version": 1, "id": "default", "name": "Default",
            "forgeAccounts": [{
                "host": "gitlab.example.com", "kind": "gitlab", "storage": "keyring",
                "user": {"id": 7, "username": "ada", "name": "Ada"},
                "somethingNewer": true,
            }],
        });
        let profile: crate::settings::Profile = serde_json::from_value(profile).unwrap();
        let a = profile.forge_accounts.into_iter().next().unwrap();
        assert_eq!((a.version, a.version_checked_at, a.added_at), (None, 0, 0));
        assert_eq!((a.user.avatar_url, a.user.email, a.user.web_url.as_str()), (None, None, ""));
    }

    #[test]
    fn statuses_serialize_tagged() {
        assert_eq!(serde_json::to_value(AccountStatus::RateLimited { until: 5 }).unwrap(), serde_json::json!({"kind": "rateLimited", "until": 5}));
        assert_eq!(serde_json::to_value(AccountStatus::TokenMissing).unwrap(), serde_json::json!({"kind": "tokenMissing"}));
    }
}
