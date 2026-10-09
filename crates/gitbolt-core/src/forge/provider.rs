//! What `gitbolt-forge` implements per forge kind (spec #4 §3.1), and what the app injects into
//! `Api`: a connector that builds a provider for an account, and a token store.
//!
//! The methods 4B–4D use are declared here with default bodies that refuse, so each plan adds
//! its own to the GitLab and GitHub impls without touching this trait.

use crate::avatar::AvatarPayload;
use crate::error::{GbError, GbErrorKind};
use crate::forge::image::ForgeImage;
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

/// Gravatar's avatar addresses, https only: a forge (GitLab) links them for users without an upload.
pub const GRAVATAR_AVATAR_BASES: [&str; 3] = ["https://secure.gravatar.com/avatar/", "https://www.gravatar.com/avatar/", "https://gravatar.com/avatar/"];

/// `url` is a Gravatar picture (the user's Gravatar setting decides whether GitBolt fetches it).
pub fn is_gravatar_url(url: &str) -> bool {
    GRAVATAR_AVATAR_BASES.iter().any(|b| url.len() > b.len() && url.get(..b.len()).is_some_and(|p| p.eq_ignore_ascii_case(b)))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `url` is `base` or below it (`base/…`, `base?…`), the scheme and host compared without case.
fn under_base(url: &str, base: &str) -> bool {
    let base = base.trim_end_matches('/');
    url.get(..base.len()).is_some_and(|p| p.eq_ignore_ascii_case(base)) && matches!(url.as_bytes().get(base.len()), None | Some(b'/' | b'?'))
}

/// `url`'s scheme, authority, path and query, when its shape is one an avatar address may have:
/// no userinfo or `@` anywhere, no fragment, backslash, whitespace or control character, no
/// encoded `/` or `\` in the path, and a path that, percent-decoded once, has no `.` or `..`
/// segment and no `%` left (a double encoding). Anything else could resolve somewhere else on the
/// host than the prefix it seems to be under.
fn avatar_url_parts(url: &str) -> Option<(&str, &str, &str, Option<&str>)> {
    if url.is_empty() || url.contains(['@', '\\', '#']) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (scheme, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, after) = rest.split_at(end);
    let (path, query) = match after.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (after, None),
    };
    let lower = path.to_ascii_lowercase();
    if authority.is_empty() || lower.contains("%2f") || lower.contains("%5c") {
        return None;
    }
    let decoded = percent_decode(path)?;
    if decoded.contains(['%', '\\']) || decoded.split('/').any(|s| s == "." || s == "..") {
        return None;
    }
    Some((scheme, authority, path, query))
}

/// `url` has a shape an avatar address may have (`avatar_fetch_url`'s checks without the allowlist).
pub fn avatar_url_is_clean(url: &str) -> bool {
    avatar_url_parts(url.trim()).is_some()
}

/// The address to fetch for a forge's `avatar_url`, or `None`: never an open fetcher. Only under
/// one of `bases` (the account's own: GitLab's `<web>/uploads`, GitHub's avatar host) or on
/// Gravatar's https hosts (the caller checks the Gravatar setting), with a clean shape
/// (`avatar_url_parts`), and https, unless its base itself is plain http (the harness's fake
/// forge). Gravatar's `d=` (a fallback address Gravatar would redirect to) becomes `d=404`.
pub fn avatar_fetch_url(url: &str, bases: &[&str]) -> Option<String> {
    let url = url.trim();
    let (scheme, authority, path, query) = avatar_url_parts(url)?;
    let own = bases.iter().find(|b| under_base(url, b));
    let gravatar = is_gravatar_url(url);
    if own.is_none() && !gravatar {
        return None;
    }
    let https = scheme.eq_ignore_ascii_case("https");
    if !https && !own.is_some_and(|b| b.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("http://"))) {
        return None;
    }
    if gravatar {
        let kept = query.unwrap_or("").split('&').filter(|kv| !kv.is_empty() && !matches!(kv.split('=').next(), Some("d" | "default")));
        let q: Vec<&str> = kept.chain(["d=404"]).collect();
        return Some(format!("{scheme}://{authority}{path}?{}", q.join("&")));
    }
    Some(url.to_string())
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

    /// One page of the forks, newest first. The default slices `forks`; providers ask the forge for just the page.
    fn forks_page<'a>(&'a self, project: &'a ForgeProject, page: u32, per_page: u32) -> ForgeFuture<'a, ForkPage> {
        Box::pin(async move {
            let all = self.forks(project).await?;
            let per = per_page.max(1) as usize;
            let start = (page.max(1) as usize - 1).saturating_mul(per);
            let next = (start.saturating_add(per) < all.len()).then(|| page.max(1) + 1);
            Ok(ForkPage { forks: all.into_iter().skip(start).take(per).collect(), next })
        })
    }

    // Avatars (4A). `Ok(None)`: the forge has none for this email (Gravatar is next).
    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>>;
    // --- GitHub commit-author avatars ---
    /// The last step for an email neither `avatar_for_email` nor Gravatar knows: the account
    /// linked to `email`'s commits in `project` (the repo's own forge target, so the email only
    /// goes where its commits came from). Rationed: providers answer each email at most once a
    /// session. By default there's no such lookup.
    fn avatar_for_email_in<'a>(&'a self, _project: &'a ForgeProject, _email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async { Ok(None) })
    }
    // --- end GitHub commit-author avatars ---
    // --- commit-author avatars by name ---
    /// The very last step, for a commit author whose `email` no other step knows: the one person
    /// this account has seen (MR/PR authors, assignees, reviewers, approvers, note authors) whose
    /// display name or username is exactly `name` (case and spacing aside), else, where the forge
    /// has one, a user search by that name (never by email) with a single exact match. Two people
    /// with that name: none. A found picture is kept under `email`. By default there's none.
    fn avatar_for_name<'a>(&'a self, _email: &'a str, _name: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        Box::pin(async { Ok(None) })
    }
    // --- end commit-author avatars by name ---
    /// The picture at `url`, a forge user's or project owner's `avatar_url`, cached like the
    /// others. `None` (and no request) unless `url` is one this account serves: under its own web
    /// host (GitLab's uploads) or its forge's avatar host (GitHub's), or Gravatar's
    /// (GitLab links it). Every implementation checks `url` with `avatar_fetch_url` (its shape and
    /// its own bases). The token only goes where `HttpClient::get_image` sends it: the account's
    /// own host, never an avatar CDN.
    fn avatar_at<'a>(&'a self, _url: &'a str) -> Option<ForgeFuture<'a, Option<AvatarPayload>>> {
        None
    }
    // --- 5A T1: Markdown images ---
    /// An image a Markdown body of `project` links (spec #5 §4.2), when `url` is on one of this
    /// forge's own hosts; `None`, and no request, for any other address (the UI offers to load it
    /// on a click). The token goes only where `HttpClient::get_image_within` sends it.
    fn image<'a>(&'a self, _project: &'a ForgeProject, _url: &'a str) -> Option<ForgeFuture<'a, ForgeImage>> {
        None
    }
    // --- end 5A T1 ---
    /// A video a Markdown body embeds, as `image` (the same hosts and token rules): `Found` with a
    /// `video/*` type, up to the video size cap.
    fn video<'a>(&'a self, _project: &'a ForgeProject, _url: &'a str) -> Option<ForgeFuture<'a, ForgeImage>> {
        None
    }

    // --- the cross-session cache (`forge::cache`) ---
    /// `project`'s list answers this provider keeps (their ETags and bodies), for the cache.
    fn export_responses(&self, _project: &ForgeProject) -> Vec<StoredResponse> {
        Vec::new()
    }
    /// Answers a previous run kept: the next request of each is conditional (`If-None-Match`).
    fn import_responses(&self, _entries: Vec<StoredResponse>) {}
    /// The client's counts since the last call (and starts them again).
    fn take_request_stats(&self) -> RequestStats {
        RequestStats::default()
    }

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
    // --- MR round 2: the review composer ---
    /// A review from the composer. By default: Comment is a note, Approve approves (then the
    /// note, if any), Request changes is `request_changes`. GitHub posts one review; GitLab
    /// sets the requested-changes reviewer state where it can.
    fn review<'a>(&'a self, project: &'a ForgeProject, number: u64, review: &'a ReviewSubmit) -> ForgeFuture<'a, ReviewOutcome> {
        Box::pin(review_by_parts(self, project, number, review))
    }
    /// How many reviewers and assignees an MR/PR of `project` may have (`PeopleLimits`).
    /// Default: no limit known (a change the forge trims is caught after the write).
    fn people_limits<'a>(&'a self, _project: &'a ForgeProject) -> ForgeFuture<'a, PeopleLimits> {
        Box::pin(async { Ok(PeopleLimits::default()) })
    }
    /// Subscribes the token's user to the MR/PR's notifications, or unsubscribes; the state after.
    fn set_subscribed<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _on: bool) -> ForgeFuture<'a, bool> {
        unsupported("Notifications")
    }
    // --- end MR round 2 ---
    // --- comment actions ---
    /// Adds (`on`) or removes the token's user's `name` reaction on a note, if not so already;
    /// the note's reactions after.
    fn react<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _note: &'a NoteRef, _name: &'a str, _on: bool) -> ForgeFuture<'a, Vec<ForgeReaction>> {
        unsupported("Reactions")
    }
    /// The note with its new body, as the forge answered (no position or reactions: the caller
    /// keeps its own).
    fn edit_note<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _note: &'a NoteRef, _body: &'a str) -> ForgeFuture<'a, ForgeNote> {
        unsupported("Editing a comment")
    }
    fn delete_note<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _note: &'a NoteRef) -> ForgeFuture<'a, ()> {
        unsupported("Deleting a comment")
    }
    /// Resolves a resolvable thread (GitLab's discussion, GitHub's review thread), or unresolves it.
    fn resolve<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _discussion: &'a str, _resolved: bool) -> ForgeFuture<'a, ThreadState> {
        unsupported("Resolving a thread")
    }
    // --- end comment actions ---
    fn merge<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Merging")
    }
    // --- auto-merge ---
    /// Sets it to merge once its checks pass, with `opts` (GitLab's auto-merge, GitHub's
    /// auto-merge). GitLab merges at once when they've passed already: the answer says which.
    fn set_auto_merge<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Auto-merge")
    }
    fn cancel_auto_merge<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Auto-merge")
    }
    // --- end auto-merge ---
    fn edit<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Editing a merge request")
    }
    fn set_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _draft: bool) -> ForgeFuture<'a, ForgeMr> {
        unsupported("Changing draft status")
    }
    // --- review comments (spec 2026-10-08 §6) ---
    /// The MR's diff as the forge has it, with the lines each file takes comments on.
    fn review_diff<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, ReviewDiff> {
        unsupported("Commenting on lines")
    }
    /// The user's pending review: its drafts and the diff refs; `can_draft` true (the hub knows
    /// GitLab's version).
    fn review_drafts<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, ReviewDrafts> {
        unsupported("Commenting on lines")
    }
    /// Adds a line comment to the user's pending review (GitHub starts one when none is).
    fn add_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _comment: &'a NewReviewComment) -> ForgeFuture<'a, ReviewDraft> {
        unsupported("Commenting on lines")
    }
    /// The draft with its new body, as the forge answered (no position: the caller keeps its own).
    fn edit_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _id: &'a str, _body: &'a str) -> ForgeFuture<'a, ReviewDraft> {
        unsupported("Commenting on lines")
    }
    fn delete_draft<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _id: &'a str) -> ForgeFuture<'a, ()> {
        unsupported("Commenting on lines")
    }
    /// Sends the pending review with `review`'s event and summary (without one pending: the
    /// review alone). `published` is left at 0: the hub counted the drafts before.
    fn submit_review<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _review: &'a ReviewSubmit) -> ForgeFuture<'a, SubmitOutcome> {
        unsupported("Commenting on lines")
    }
    /// Deletes the pending review and its drafts: how many drafts went.
    fn discard_review<'a>(&'a self, _project: &'a ForgeProject, _number: u64) -> ForgeFuture<'a, u32> {
        unsupported("Commenting on lines")
    }
    /// A line comment now, outside any review: its new thread.
    fn comment_now<'a>(&'a self, _project: &'a ForgeProject, _number: u64, _comment: &'a NewReviewComment) -> ForgeFuture<'a, ForgeDiscussion> {
        unsupported("Commenting on lines")
    }
    // --- end review comments ---
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

/// `ForgeProvider::review`'s default, from the provider's own writes: Comment is a note,
/// Approve approves (then the note, if any), Request changes is `request_changes`.
pub async fn review_by_parts<P: ForgeProvider + ?Sized>(p: &P, project: &ForgeProject, number: u64, review: &ReviewSubmit) -> Result<ReviewOutcome, GbError> {
    let note = || NewNote { discussion: None, body: review.body.clone() };
    match review.event {
        ReviewEvent::Comment => {
            p.reply(project, number, &note()).await?;
        }
        ReviewEvent::Approve => {
            p.approve(project, number).await?;
            if !review.body.trim().is_empty() {
                p.reply(project, number, &note()).await?;
            }
        }
        ReviewEvent::RequestChanges => p.request_changes(project, number, &review.body).await?,
    }
    Ok(ReviewOutcome::default())
}

/// Builds a provider for an account (gitbolt-forge's `Forge`; tests' fakes).
pub trait ForgeConnector: Send + Sync {
    /// `Err(InvalidInput)` for a host this build won't talk to (the harness: any real forge).
    fn connect(&self, kind: ForgeKind, host: &str, token: Secret) -> Result<Arc<dyn ForgeProvider>, GbError>;
    // --- 5A T1 ---
    /// An image the user chose to load ("Load image from <host>"): no token, https only, the
    /// image size cap. Needs no account.
    fn public_image<'a>(&'a self, _url: &'a str) -> ForgeFuture<'a, ForgeImage> {
        unsupported("Loading an image")
    }
    /// `public_image` for a video, up to the video size cap.
    fn public_video<'a>(&'a self, _url: &'a str) -> ForgeFuture<'a, ForgeImage> {
        unsupported("Loading a video")
    }
    // --- end 5A T1 ---
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

#[cfg(test)]
mod tests {
    use super::*;

    const UPLOADS: &str = "https://gitlab.example.com/uploads";
    const GH: &str = "https://avatars.githubusercontent.com";

    #[test]
    fn an_avatar_address_is_fetched_only_under_the_accounts_bases_or_gravatar() {
        let ok = format!("{UPLOADS}/-/system/user/avatar/7/a%20b.png");
        assert_eq!(avatar_fetch_url(&ok, &[UPLOADS]).as_deref(), Some(ok.as_str()));
        assert!(avatar_fetch_url(&format!("{GH}/u/583231?v=4"), &[GH]).is_some());
        assert!(avatar_fetch_url("HTTPS://Avatars.GitHubUserContent.com/u/1", &[GH]).is_some(), "scheme and host without case");
        for no in [
            "https://gitlab.example.com/api/v4/user".to_string(),
            "https://evil.example.com/uploads/a.png".to_string(),
            "https://gitlab.example.com/uploadsx/a.png".to_string(),
            format!("{GH}.evil.example/u/1"),
            "http://gitlab.example.com/uploads/a.png".to_string(),
            "file:///etc/passwd".to_string(),
            "https://gitlab.example.com".to_string(),
        ] {
            assert_eq!(avatar_fetch_url(&no, &[UPLOADS, GH]), None, "{no}");
        }
        assert!(avatar_fetch_url("http://127.0.0.1:9/gitlab/uploads/a.png", &["http://127.0.0.1:9/gitlab/uploads"]).is_some(), "plain http only under an http base (the harness)");
    }

    #[test]
    fn tricks_around_dot_segments_encodings_and_userinfo_are_refused() {
        for no in [
            "/uploads/..?x", "/uploads/..#x", "/uploads/../api/v4/user", "/uploads/./a.png", "/uploads/..%2f..%2fapi/v4/user",
            "/uploads/..%2F..%2Fapi", "/uploads/%2e%2e/api/v4/user", "/uploads/%2E%2E/api", "/uploads/%252e%252e/api", "/uploads/..%5capi",
            "/uploads\\..\\api", "/uploads/a.png#frag", "/uploads/a%zz.png", "/uploads/a .png",
        ] {
            let url = format!("https://gitlab.example.com{no}");
            assert_eq!(avatar_fetch_url(&url, &[UPLOADS]), None, "{url}");
            assert!(!avatar_url_is_clean(&url), "{url}");
        }
        for no in ["https://x@gitlab.example.com/uploads/a.png", "https://gitlab.example.com/uploads/a@b.png"] {
            assert_eq!(avatar_fetch_url(no, &[UPLOADS]), None, "{no}");
        }
    }

    #[test]
    fn gravatars_fallback_address_becomes_a_404() {
        assert_eq!(
            avatar_fetch_url("https://secure.gravatar.com/avatar/abc?s=80&d=https%3A%2F%2Fevil.example.com%2Fx&default=mm", &[]).as_deref(),
            Some("https://secure.gravatar.com/avatar/abc?s=80&d=404")
        );
        assert_eq!(avatar_fetch_url("https://www.gravatar.com/avatar/abc", &[]).as_deref(), Some("https://www.gravatar.com/avatar/abc?d=404"));
        assert_eq!(avatar_fetch_url("http://secure.gravatar.com/avatar/abc", &[]), None);
    }
}
