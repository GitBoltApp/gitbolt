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

pub type AvatarFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<AvatarPayload>, GbError>> + Send + 'a>>;

pub trait AvatarProvider: Send + Sync {
    /// `Ok(None)`: there's no avatar for this email (the UI shows initials).
    fn avatar<'a>(&'a self, email: &'a str) -> AvatarFuture<'a>;
}
