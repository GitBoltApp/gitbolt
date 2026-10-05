//! Avatar lookup (spec §4.2). Implemented by `gitbolt-forge` (Gravatar in #1, forge APIs in #4)
//! and injected into `Api`, so core never depends on an HTTP client.

use crate::error::GbError;
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AvatarPayload {
    pub mime: String,
    pub base64: String,
}

/// GitHub's noreply addresses: `noreply@github.com` (the committer of every commit made in
/// GitHub's web UI) and `[<id>+]<login>@users.noreply.github.com`. They never receive mail, so
/// no Gravatar account can be verified for one: asking Gravatar is a round trip for nothing. Only
/// a GitHub account can show one (by the user id in the address).
pub fn is_github_noreply(email: &str) -> bool {
    let email = email.trim().to_ascii_lowercase();
    email == "noreply@github.com" || email.ends_with("@users.noreply.github.com")
}

pub type AvatarFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<AvatarPayload>, GbError>> + Send + 'a>>;

pub trait AvatarProvider: Send + Sync {
    /// `Ok(None)`: there's no avatar for this email (the UI shows initials).
    fn avatar<'a>(&'a self, email: &'a str) -> AvatarFuture<'a>;

    /// The "load avatars" setting (spec §14.1): off answers every lookup with `None`, without a
    /// request. Providers that always answer from a local source ignore it.
    fn set_enabled(&self, _on: bool) {}
}
