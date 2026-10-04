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
    /// a hook exited non-zero (trace2, spec #2 §3.3)
    HookFailed,
    /// a merge, rebase, cherry-pick, revert or am blocks the intent
    InProgress,
    /// a file or the index changed since it was shown
    Stale,
    // --- 4A T1 ---
    /// A forge's rate limit: no request until `ErrorDetail::RateLimited.until` (spec #4 §3.1).
    RateLimited,
    /// A forge (or any HTTP server) couldn't be reached: DNS, connect, TLS or a timeout.
    Network,
    // --- end 4A T1 ---
}

/// What a write error needs beyond its kind (spec #2 §15). Tagged by `kind`, camelCase in TS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ErrorDetail {
    /// `HookFailed`: the hook that exited non-zero.
    Hook { hook: String },
    /// `IndexLocked`: the lock file and its mtime when git hit it, for Remove stale lock.
    IndexLock {
        path: Box<str>,
        #[ts(type = "number")]
        mtime_ms: i64,
        /// With the device: the file's identity, so a lock replaced since (same mtime) isn't removed.
        #[ts(type = "number")]
        ino: u64,
        #[ts(type = "number")]
        dev: u64,
    },
    /// The clean-restore warning (§6.2): restoring the autostash would conflict in `paths`.
    AutostashConflict { paths: Vec<String>, target: String },
    /// `git stash apply --index` refused the index: ask "Apply without restoring what was staged?"
    ApplyWithoutIndex,
    // --- 2C T1: error details ---
    /// A checkout (or worktree add) of a branch another worktree has checked out (spec #2 §9.3):
    /// the toast offers [Switch to it] [Open in a new tab]. `worktree` is as the UI shows it.
    /// (`Box<str>`, as `IndexLock.path`: `GbError` stays under clippy's `result_large_err`.)
    CheckedOutElsewhere { branch: Box<str>, worktree: Box<str> },
    /// A hard reset over changes (§9.4): "Reset main to a1b2c3 and discard changes to 4 files?
    /// You can undo this." Confirmed by sending again with `discard`.
    ResetDiscards { branch: Box<str>, to: Box<str>, files: u32 },
    // --- end 2C T1 ---
    // --- 2D T15 ---
    /// Mark resolved on a file that still has conflict markers (spec #2 §13.3): ask first, then
    /// send again with `confirmMarkers`.
    MarkersRemain { path: Box<str> },
    /// Take current / Take incoming over a file the user edited (review M4): "Discard your edits
    /// to <path>?", then send again with `confirmDiscard`.
    DiscardEdits { path: Box<str> },
    // --- end 2D T15 ---
    // --- 3A T3 ---
    /// Restore a file from a commit over the file's own changes (spec #3 §3.8): "Click again to
    /// replace your changes to <path>", then send again with `confirm`.
    RestoreOverChanges { path: Box<str> },
    // --- end 3A T3 ---
    // --- 3B T2 ---
    /// Undo of a "without committing" pick that stopped on conflicts discards its changes, a
    /// resolution included: ask (`message`), arm in place with `arm`, then send again with
    /// `confirmDiscard`. `op`: `cherry-pick` or `revert`.
    UndoStoppedPick { op: Box<str>, arm: Box<str> },
    // --- end 3B T2 ---
    // --- 3C fix round 3 ---
    /// An interactive rebase's Abort failed part-way (git reset, then stopped): the work from
    /// the stop is kept, its commits on `branch`, its edits in the stash `stash`.
    AbortKeptWork { stash: Option<Box<str>>, branch: Option<Box<str>> },
    // --- end 3C fix round 3 ---
    /// A `fetch --all` where some remotes failed: which, and a short plain reason each (never a
    /// URL with credentials). The sidebar's Remote rows warn on them until a fetch succeeds.
    FetchFailed { remotes: Vec<FailedRemote> },
    // --- 4A T1 ---
    /// `RateLimited`: when the forge takes requests again (unix seconds).
    RateLimited {
        #[ts(type = "number")]
        until: i64,
    },
    // --- end 4A T1 ---
}

/// One remote a fetch couldn't get, with a short reason ("couldn't reach host", "authentication failed").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct FailedRemote {
    pub name: String,
    pub reason: String,
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
    /// Kind-specific data (spec #2 §15); absent for most errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<ErrorDetail>,
}

impl GbError {
    pub fn new(kind: GbErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), command_id: None, stderr: None, detail: None }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(GbErrorKind::Other, message)
    }

    pub fn with_detail(mut self, detail: ErrorDetail) -> Self {
        self.detail = Some(detail);
        self
    }

    /// A ref GitBolt expected at one value is elsewhere (spec #2 §4): the toast says "Branch
    /// changed outside GitBolt — refresh and retry"; the message names the ref.
    pub fn ref_moved(name: &str) -> Self {
        Self::new(GbErrorKind::RefMoved, format!("{} changed outside GitBolt", short_ref(name)))
    }

    /// `what`: "merge", "rebase", "cherry-pick", "revert", "am" or "bisect".
    pub fn in_progress(what: &str) -> Self {
        Self::new(GbErrorKind::InProgress, format!("A {what} is in progress"))
    }

    pub fn stale(message: impl Into<String>) -> Self {
        Self::new(GbErrorKind::Stale, message)
    }

    // --- 2C T1: checked out elsewhere ---
    pub fn checked_out_elsewhere(branch: &str, shown: &str) -> Self {
        Self::new(GbErrorKind::InvalidInput, format!("{branch} is checked out in {shown}."))
            .with_detail(ErrorDetail::CheckedOutElsewhere { branch: branch.into(), worktree: shown.into() })
    }
    // --- end 2C T1 ---
}

/// `refs/heads/x` → `x`, `refs/remotes/o/x` → `o/x`, `refs/tags/v` → `v`; anything else as is.
pub fn short_ref(name: &str) -> &str {
    ["refs/heads/", "refs/remotes/", "refs/tags/", "refs/"].iter().find_map(|p| name.strip_prefix(p)).unwrap_or(name)
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
        // "stale info" is a force-with-lease rejection: the remote ref moved (spec #2 §15).
        (RefMoved, &["but expected", "cannot lock ref", "(stale info)"]),
        (AuthFailed, &["Authentication failed", "could not read Username", "could not read Password", "Permission denied (publickey", "terminal prompts disabled", "HTTP Basic: Access denied"]),
        (NonFastForward, &["Not possible to fast-forward", "non-fast-forward", "Diverging branches can't be fast-forwarded", "(fetch first)", "is not fully merged"]),
        (Conflict, &["CONFLICT (", "Merge conflict", "needs merge", "resolve your current index first", "Conflicts in index"]),
        // `read-tree -m -u` (undo's Rewind) refusing over local changes: "Entry 'a' not uptodate. Cannot merge."
        (DirtyWorktree, &["would be overwritten by", "Please commit your changes or stash them", "untracked working tree files would be overwritten", "not uptodate. Cannot merge"]),
        (InvalidInput, &["is already checked out at", "is already used by worktree at", "nothing to commit"]),
        (NotFound, &["not a git repository", "unknown revision", "did not match any file(s) known to git", "bad revision", "does not appear to be a git repository", "There is no tracking information"]),
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
        let e = GbError { kind: GbErrorKind::NotFound, message: "m".into(), command_id: Some(3), stderr: None, detail: None };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"kind":"NotFound","message":"m","commandId":3,"stderr":null}"#);
    }

    #[test]
    fn classifies_the_messages_writes_produce() {
        use GbErrorKind::*;
        let cases = [
            ("Conflicts in index. Try without --index.", Conflict),
            ("error: The following untracked working tree files would be overwritten by checkout:\n\ta.txt", DirtyWorktree),
            ("fatal: 'feature/x' is already checked out at '/r/wt-x'", InvalidInput),
            ("fatal: 'feature/x' is already used by worktree at '/r/wt-x'", InvalidInput),
            ("error: the branch 'feature/x' is not fully merged.", NonFastForward),
            ("nothing to commit, working tree clean", InvalidInput),
            ("There is no tracking information for the current branch.", NotFound),
            (" ! [rejected]        main -> main (stale info)", RefMoved),
            ("error: cannot lock ref 'refs/heads/x': reference already exists", RefMoved),
            ("error: Entry 'a.txt' not uptodate. Cannot merge.", DirtyWorktree),
        ];
        for (stderr, want) in cases {
            assert_eq!(classify_stderr(stderr), want, "{stderr}");
        }
    }

    #[test]
    fn the_detail_is_tagged_and_omitted_when_absent() {
        let e = GbError::new(GbErrorKind::HookFailed, "lint failed").with_detail(ErrorDetail::Hook { hook: "pre-commit".into() });
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"kind": "HookFailed", "message": "lint failed", "commandId": null, "stderr": null, "detail": {"kind": "hook", "hook": "pre-commit"}})
        );
        let lock = ErrorDetail::IndexLock { path: "/r/.git/index.lock".into(), mtime_ms: 5, ino: 6, dev: 7 };
        assert_eq!(serde_json::to_value(&lock).unwrap(), serde_json::json!({"kind": "indexLock", "path": "/r/.git/index.lock", "mtimeMs": 5, "ino": 6, "dev": 7}));
        assert!(serde_json::to_value(GbError::other("x")).unwrap().get("detail").is_none());
    }

    #[test]
    fn the_helpers_name_what_moved_blocks_or_went_stale() {
        let moved = GbError::ref_moved("refs/heads/feature/x");
        assert_eq!((moved.kind, moved.message.as_str()), (GbErrorKind::RefMoved, "feature/x changed outside GitBolt"));
        assert_eq!(GbError::ref_moved("HEAD").message, "HEAD changed outside GitBolt");
        let busy = GbError::in_progress("rebase");
        assert_eq!((busy.kind, busy.message.as_str()), (GbErrorKind::InProgress, "A rebase is in progress"));
        assert_eq!(GbError::in_progress("cherry-pick").message, "A cherry-pick is in progress");
        let stale = GbError::stale("a.php changed since it was shown");
        assert_eq!((stale.kind, stale.message.as_str()), (GbErrorKind::Stale, "a.php changed since it was shown"));
        assert_eq!(short_ref("refs/remotes/origin/main"), "origin/main");
        assert_eq!(short_ref("refs/tags/v1"), "v1");
    }

    // --- 2C T1: error details ---
    #[test]
    fn the_2c_details_serialize_for_the_ui() {
        let e = GbError::checked_out_elsewhere("feature/x", "../shop-feature-x");
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert_eq!(e.message, "feature/x is checked out in ../shop-feature-x.");
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"], serde_json::json!({"kind": "checkedOutElsewhere", "branch": "feature/x", "worktree": "../shop-feature-x"}));
        let d = ErrorDetail::ResetDiscards { branch: "main".into(), to: "a1b2c3".into(), files: 4 };
        assert_eq!(serde_json::to_value(&d).unwrap(), serde_json::json!({"kind": "resetDiscards", "branch": "main", "to": "a1b2c3", "files": 4}));
    }
    // --- end 2C T1 ---
    // --- 3A T3 ---
    #[test]
    fn the_restore_detail_serializes_for_the_ui() {
        let d = ErrorDetail::RestoreOverChanges { path: "src/a b.txt".into() };
        assert_eq!(serde_json::to_value(&d).unwrap(), serde_json::json!({"kind": "restoreOverChanges", "path": "src/a b.txt"}));
    }
    // --- end 3A T3 ---
    // --- 4A T1 ---
    #[test]
    fn rate_limited_errors_carry_until_when() {
        let e = GbError::new(GbErrorKind::RateLimited, "x").with_detail(ErrorDetail::RateLimited { until: 1_791_115_200 });
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "RateLimited");
        assert_eq!(v["detail"], serde_json::json!({"kind": "rateLimited", "until": 1_791_115_200i64}));
        assert_eq!(serde_json::to_value(GbErrorKind::Network).unwrap(), "Network");
    }
    // --- end 4A T1 ---
}
