//! What `gitbolt-forge` implements per forge kind (spec #4 §3.1), and what the app injects into
//! `Api`: a connector that builds a provider for an account, and a token store.
//!
//! The methods 4B–4D use are declared here with default bodies that refuse, so each plan adds
//! its own to the GitLab and GitHub impls without touching this trait.

use crate::avatar::AvatarPayload;
use crate::error::{GbError, GbErrorKind};
use crate::forge::types::*;
use crate::redact::Secret;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type ForgeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, GbError>> + Send + 'a>>;

/// A method this forge (or this plan) doesn't have yet.
pub fn unsupported<'a, T: Send + 'a>(what: &'static str) -> ForgeFuture<'a, T> {
    Box::pin(async move { Err(GbError::new(GbErrorKind::InvalidInput, format!("{what} isn't supported by this forge yet"))) })
}

/// Set on a 403's message (an `AuthFailed` like a 401's): see [`is_forbidden`].
pub const FORBIDDEN_MARK: &str = " refused: ";

/// A 403 (the token works but isn't allowed this), as opposed to a 401 (the token is rejected).
pub fn is_forbidden(e: &GbError) -> bool {
    e.kind == GbErrorKind::AuthFailed && e.message.contains(FORBIDDEN_MARK)
}

/// The keyring's service name (core spec §14.3).
pub const KEYRING_SERVICE: &str = "gitbolt";

/// One account: a host in a profile (spec #4 §2: one account per host per profile).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AccountKey {
    pub profile: String,
    pub host: String,
}

impl AccountKey {
    /// The keyring's account name: `<profile-id>/<host>` (core spec §14.3).
    pub fn keyring_account(&self) -> String {
        format!("{}/{}", self.profile, self.host)
    }
}

/// One authenticated account on one forge. Every method may fail with `AuthFailed`, `NotFound`,
/// `RateLimited`, `Network`, `InvalidInput` or `Other`; messages never contain the token.
pub trait ForgeProvider: Send + Sync {
    fn kind(&self) -> ForgeKind;
    fn host(&self) -> &str;
    fn rate_limit(&self) -> RateLimitState;

    // Identity (4A).
    /// The token's user, and whether the token may write (spec #4 §3.2).
    fn check_token(&self) -> ForgeFuture<'_, TokenCheck>;
    fn current_user(&self) -> ForgeFuture<'_, ForgeUser>;
    /// GitLab's version (`19.1.0-ee`); `None` where the forge has none (GitHub).
    fn version(&self) -> ForgeFuture<'_, Option<String>>;

    // Projects (4A).
    /// The project at `path` (`project_from_remote`, spec #4 §3.3).
    fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>>;
    fn project_settings<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings>;
    /// The project's forks, newest activity first.
    fn forks<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>>;

    // Avatars (4A). `Ok(None)`: the forge has none for this email (Gravatar is next).
    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>>;

    // --- 4B: reads ---
    fn open_mrs<'a>(&'a self, _project: &'a ForgeProject, _filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        unsupported("Listing merge requests")
    }
    /// `open_mrs` without pipelines or checks: the badges, which never show one, and cost no
    /// lookups per MR/PR. By default, `open_mrs` itself.
    fn open_mrs_light<'a>(&'a self, project: &'a ForgeProject, filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        self.open_mrs(project, filter)
    }
    // --- 4D T4 ---
    /// The open MRs/PRs whose target is `branch`, all of them (the merge guard must not miss one
    /// past the general list's first page). By default, `open_mrs_light` filtered.
    fn open_mrs_targeting<'a>(&'a self, project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        Box::pin(async move {
            let mut r = self.open_mrs_light(project, MrFilter::All).await?;
            r.value.retain(|m| m.target_branch == branch);
            Ok(r)
        })
    }
    // --- end 4D T4 ---
    fn mr_for_branch<'a>(&'a self, _project: &'a ForgeProject, _source: &'a SourceRef) -> ForgeFuture<'a, Fresh<Option<ForgeMr>>> {
        unsupported("Finding a branch's merge request")
    }
    fn mr_detail<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, Fresh<ForgeMrDetail>> {
        unsupported("Merge request details")
    }
    fn discussions<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, Fresh<Vec<ForgeDiscussion>>> {
        unsupported("Reading discussions")
    }
    // --- 4B: writes ---
    fn reply<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _note: &'a NewNote) -> ForgeFuture<'a, ForgeNote> {
        unsupported("Replying")
    }
    fn approve<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, ()> {
        unsupported("Approving")
    }
    fn request_changes<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _body: &'a str) -> ForgeFuture<'a, ()> {
        unsupported("Requesting changes")
    }
    fn merge<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Merging")
    }
    fn edit<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Editing a merge request")
    }
    fn set_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _draft: bool) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Changing draft status")
    }
    // --- 4C ---
    fn create_mr<'a>(&'a self, _project: &'a ForgeProject, _req: &'a CreateMr) -> ForgeFuture<'a, CreateOutcome> {
        unsupported("Creating a merge request")
    }
    fn search_users<'a>(&'a self, _project: &'a ForgeProject, _query: &'a str) -> ForgeFuture<'a, Vec<ForgeUser>> {
        unsupported("Searching users")
    }
    fn labels<'a>(&'a self, _project: &'a ForgeProject, _query: &'a str) -> ForgeFuture<'a, Vec<ForgeLabel>> {
        unsupported("Listing labels")
    }
    fn mr_templates<'a>(&'a self, _project: &'a ForgeProject, _branch: &'a str) -> ForgeFuture<'a, Vec<MrTemplate>> {
        unsupported("Reading templates")
    }
    // --- 4C T1: an addition to 4A's trait, with a refusing default like the others ---
    /// Adds the parts a create's follow-up calls couldn't (GitHub: reviewers, assignees and labels
    /// on PR `number`), for the Retry of a partial failure (spec #4 §3.5). The parts still failing.
    fn complete_create<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _req: &'a CreateMr, _parts: &'a [CreatePart]) -> ForgeFuture<'a, Vec<PartFailure>> {
        unsupported("Adding reviewers, assignees and labels afterwards")
    }
    // --- end 4C T1 ---
    // --- 4D ---
    fn retarget<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _target_branch: &'a str) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Retargeting")
    }
}

/// Builds a provider for an account (gitbolt-forge's `Forge`; tests' fakes).
pub trait ForgeConnector: Send + Sync {
    /// `Err(InvalidInput)` for a host this build won't talk to (the harness: any real forge).
    fn connect(&self, kind: ForgeKind, host: &str, token: Secret) -> Result<Arc<dyn ForgeProvider>, GbError>;
}

/// Where tokens are kept (spec #4 §2). Every method blocks (Secret Service over D-Bus, file I/O):
/// call it from the blocking pool.
pub trait TokenStore: Send + Sync {
    /// Stores `token` for `key`: in the system keyring, else in the owner-only file.
    fn put(&self, key: &AccountKey, token: &Secret) -> Result<TokenStorage, GbError>;
    /// The token, read from where the account says it is; `Ok(None)` when it's gone.
    fn get(&self, key: &AccountKey, storage: TokenStorage) -> Result<Option<Secret>, GbError>;
    /// Deletes it wherever it is.
    fn delete(&self, key: &AccountKey) -> Result<(), GbError>;
    /// Moves a token kept in the file to the system keyring, now that it's there: the keyring
    /// takes it, then the file copy goes. `Ok(Some(Keyring))` when it moved, or already had
    /// (the file has none and the keyring holds it: a record still saying File heals); `Ok(None)` when
    /// there's nothing to move or no keyring at all (a store with only one place). An error
    /// leaves the file copy as it was.
    fn migrate_to_keyring(&self, _key: &AccountKey) -> Result<Option<TokenStorage>, GbError> {
        Ok(None)
    }
}
