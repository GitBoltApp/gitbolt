//! Typed errors returned by every backend command.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub enum GbErrorKind {
    AuthFailed,
    NonFastForward,
    Conflict,
    DirtyWorktree,
    IndexLocked,
    RefMoved,
    Cancelled,
    NotFound,
    InvalidInput,
    GitTooOld,
    Io,
    Other,
}

#[derive(Debug, Clone, Serialize, TS, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
#[error("{message}")]
pub struct GbError {
    pub kind: GbErrorKind,
    pub message: String,
    #[ts(type = "number | null")]
    pub command_id: Option<u64>,
    pub stderr: Option<String>,
}

impl GbError {
    pub fn new(kind: GbErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), command_id: None, stderr: None }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(GbErrorKind::Other, message)
    }
}

impl From<std::io::Error> for GbError {
    fn from(e: std::io::Error) -> Self {
        Self::new(GbErrorKind::Io, e.to_string())
    }
}

/// Wraps any gix (or other library) error as `Other`.
pub fn gix_err<E: std::fmt::Display>(e: E) -> GbError {
    GbError::other(e.to_string())
}

/// Maps git's stderr (always produced with `LC_ALL=C`) to an error kind. Order matters.
pub fn classify_stderr(stderr: &str) -> GbErrorKind {
    use GbErrorKind::*;
    const RULES: &[(GbErrorKind, &[&str])] = &[
        (IndexLocked, &[".lock': File exists"]),
        (RefMoved, &["but expected", "cannot lock ref"]),
        (AuthFailed, &["Authentication failed", "could not read Username", "could not read Password", "Permission denied (publickey", "terminal prompts disabled", "HTTP Basic: Access denied"]),
        (NonFastForward, &["Not possible to fast-forward", "non-fast-forward", "Diverging branches can't be fast-forwarded", "(fetch first)"]),
        (Conflict, &["CONFLICT (", "Merge conflict", "needs merge", "resolve your current index first"]),
        (DirtyWorktree, &["would be overwritten by", "Please commit your changes or stash them"]),
        (NotFound, &["not a git repository", "unknown revision", "did not match any file(s) known to git", "bad revision", "does not appear to be a git repository"]),
    ];
    RULES
        .iter()
        .find(|(_, needles)| needles.iter().any(|n| stderr.contains(n)))
        .map(|(kind, _)| *kind)
        .unwrap_or(Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_git_messages() {
        use GbErrorKind::*;
        let cases = [
            ("fatal: Unable to create '/r/.git/index.lock': File exists.", IndexLocked),
            ("error: cannot lock ref 'refs/heads/x': is at 1234 but expected 5678", RefMoved),
            ("fatal: Authentication failed for 'https://h/x.git/'", AuthFailed),
            ("fatal: could not read Username for 'https://h': terminal prompts disabled", AuthFailed),
            ("git@h: Permission denied (publickey).", AuthFailed),
            ("fatal: Not possible to fast-forward, aborting.", NonFastForward),
            (" ! [rejected]        main -> main (fetch first)", NonFastForward),
            ("CONFLICT (content): Merge conflict in a.txt", Conflict),
            ("error: Your local changes to the following files would be overwritten by checkout:", DirtyWorktree),
            ("fatal: not a git repository (or any of the parent directories): .git", NotFound),
            ("fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.", NotFound),
            ("something else entirely", Other),
        ];
        for (stderr, want) in cases {
            assert_eq!(classify_stderr(stderr), want, "{stderr}");
        }
    }

    #[test]
    fn serializes_camel_case() {
        let e = GbError { kind: GbErrorKind::NotFound, message: "m".into(), command_id: Some(3), stderr: None };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"kind":"NotFound","message":"m","commandId":3,"stderr":null}"#);
    }
}
