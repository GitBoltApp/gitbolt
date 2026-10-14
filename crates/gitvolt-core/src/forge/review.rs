//! Inline review comments (spec 2026-10-08 §6): the lines an MR's diff takes comments on, GitLab's
//! line codes, and the checks a comment's place passes before the forge is asked. The hub's
//! review calls are in this file too (`impl ForgeHub`).

use crate::error::{GbError, GbErrorKind};
use crate::forge::hub::ForgeHub;
use crate::forge::mrs::MrTarget;
use crate::forge::types::*;
use crate::forge::version_at_least;
use crate::payload::RemotePayload;
use crate::settings::SettingsStore;
use std::sync::Arc;

pub const DOWN_THE_DIFF: &str = "A range runs down the diff, from its first line to its last";

fn refuse(message: &str) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, message)
}

/// The lines of one file's unified diff (from its first `@@`, as GitLab's `/diffs` and GitHub's
/// `patch` send it) that take a review comment: every line of every hunk, in order. Both forges
/// take comments only there (spec §6 "Forge rules").
pub fn commentable_lines(diff: &str) -> Vec<ReviewLine> {
    crate::write::patch::parse(diff.as_bytes()).hunks.iter().flat_map(|h| h.numbered()).map(|(kind, old_line, new_line)| ReviewLine { kind, old_line, new_line }).collect()
}

/// GitLab's line code for `line` of `path` (the file's new path): `<SHA1 of the path>_<old>_<new>`
/// with the parser's numbers (https://docs.gitlab.com/api/discussions/, "Line code").
pub fn line_code(path: &str, line: &ReviewLine) -> String {
    let mut h = gix::hash::hasher(gix::hash::Kind::Sha1);
    h.update(path.as_bytes());
    let sha = h.try_finalize().expect("the SHA-1 of a path");
    format!("{}_{}_{}", sha.to_hex(), line.old_line, line.new_line)
}

/// What a comment must be before a forge is asked: some text, a file and the head it's against,
/// and a range that runs down the diff (its start before its end, in diff order).
pub fn check_comment(c: &NewReviewComment) -> Result<(), GbError> {
    if c.body.trim().is_empty() {
        return Err(refuse("Write a comment first"));
    }
    if c.anchor.path.is_empty() || c.refs.head_sha.is_empty() {
        return Err(refuse("Pick a line of the diff first"));
    }
    if let Some(s) = &c.anchor.start
        && (s == &c.anchor.end || s.old_line > c.anchor.end.old_line || s.new_line > c.anchor.end.new_line)
    {
        return Err(refuse(DOWN_THE_DIFF));
    }
    Ok(())
}

/// The one rule for a review's message, the composer's (`review`) and the pending review's
/// (`submit_review`): with no drafts going in, Comment needs one, and so does Request changes,
/// except on GitLab. There request changes is just the approval withdrawn, and an empty one is the
/// retry of a part-way submit whose summary already went in (`SubmitOutcome::body_posted`).
/// Approve never needs one. `kind` is `None` before the target is known: only the refusals that
/// don't depend on it are made then, so they come before the forge is asked anything.
pub(crate) fn check_review_message(review: &ReviewSubmit, drafts: u32, kind: Option<ForgeKind>) -> Result<(), GbError> {
    if drafts > 0 || !review.body.trim().is_empty() {
        return Ok(());
    }
    match (review.event, kind) {
        (ReviewEvent::Comment, _) => Err(refuse("Write a comment first")),
        (ReviewEvent::RequestChanges, Some(k)) if k != ForgeKind::GitLab => Err(refuse("Say what to change first")),
        _ => Ok(()),
    }
}

/// GitLab takes a draft note's `position` from 16.3 (the 16.2 API docs list none on create):
/// https://archives.docs.gitlab.com/16.3/ee/api/draft_notes.html
pub const GITLAB_DRAFT_POSITIONS: (u32, u32) = (16, 3);
pub const OLD_GITLAB_DRAFTS: &str = "This GitLab keeps line comments in a review from version 16.3: use Comment now";

impl ForgeHub {
    /// Whether the account's forge keeps a draft's line: GitLab from 16.3. An unknown version is
    /// let through (the provider checks the answer kept the position).
    fn can_draft(&self, store: &Arc<SettingsStore>, t: &MrTarget) -> bool {
        if t.project.kind != ForgeKind::GitLab {
            return true;
        }
        let version = crate::forge::hub::account_for(&store.active_profile().forge_accounts, &t.key.host).and_then(|a| a.version.clone());
        version.is_none_or(|v| version_at_least(&v, GITLAB_DRAFT_POSITIONS.0, GITLAB_DRAFT_POSITIONS.1))
    }

    pub async fn review_diff(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<ReviewDiff, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.review_diff(&t.project, number).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn review_drafts(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<ReviewDrafts, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.review_drafts(&t.project, number).await;
        self.record(&t.key, &r);
        let mut d = r?;
        d.can_draft &= self.can_draft(store, &t);
        Ok(d)
    }

    pub async fn add_draft(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, comment: NewReviewComment) -> Result<ReviewDraft, GbError> {
        check_comment(&comment)?;
        let t = self.mr_target(store, remotes).await?;
        if !self.can_draft(store, &t) {
            return Err(refuse(OLD_GITLAB_DRAFTS));
        }
        let r = t.provider.add_draft(&t.project, number, &comment).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn edit_draft(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, id: String, body: String) -> Result<ReviewDraft, GbError> {
        if body.trim().is_empty() {
            return Err(refuse("A comment can't be empty: delete it instead"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.edit_draft(&t.project, number, &id, &body).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn delete_draft(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, id: String) -> Result<(), GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.delete_draft(&t.project, number, &id).await;
        self.record(&t.key, &r);
        r
    }

    /// Sends the pending review. Its drafts are counted first: with none, the message is as the
    /// composer's `review` needs it (`check_review_message`); with some, the drafts are the review.
    pub async fn submit_review(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, review: ReviewSubmit) -> Result<SubmitOutcome, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let pending = t.provider.review_drafts(&t.project, number).await;
        self.record(&t.key, &pending);
        let count = pending?.drafts.len() as u32;
        check_review_message(&review, count, Some(t.provider.kind()))?;
        let r = t.provider.submit_review(&t.project, number, &review).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r.map(|o| SubmitOutcome { published: count, ..o })
    }

    pub async fn discard_review(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<u32, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.discard_review(&t.project, number).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn comment_now(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, comment: NewReviewComment) -> Result<ForgeDiscussion, GbError> {
        check_comment(&comment)?;
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.comment_now(&t.project, number, &comment).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(old: u32, new: u32) -> ReviewLine { ReviewLine { kind: LineKind::Context, old_line: old, new_line: new } }
    fn add(old: u32, new: u32) -> ReviewLine { ReviewLine { kind: LineKind::Added, old_line: old, new_line: new } }
    fn del(old: u32, new: u32) -> ReviewLine { ReviewLine { kind: LineKind::Removed, old_line: old, new_line: new } }

    #[test]
    fn every_line_of_every_hunk_takes_a_comment_numbered_as_gitlab_does() {
        let diff = "@@ -1,4 +1,5 @@\n a\n-b\n+B\n+C\n d\n e\n@@ -20,2 +21,3 @@\n t\n+u\n v\n";
        assert_eq!(commentable_lines(diff), [ctx(1, 1), del(2, 2), add(3, 2), add(3, 3), ctx(3, 4), ctx(4, 5), ctx(20, 21), add(21, 22), ctx(21, 23)]);
        // GitHub's `patch` has no trailing newline, and may end with "\ No newline at end of file".
        assert_eq!(commentable_lines("@@ -1 +1,2 @@\n Readme\n+Second line\n\\ No newline at end of file"), [ctx(1, 1), add(2, 2)]);
    }

    #[test]
    fn a_new_files_lines_come_before_old_line_zero_and_no_diff_has_none() {
        assert_eq!(commentable_lines("@@ -0,0 +1,2 @@\n+x\n+y\n"), [add(0, 1), add(0, 2)]);
        assert_eq!(commentable_lines(""), []);
    }

    #[test]
    fn the_line_code_is_the_paths_sha1_and_both_numbers() {
        // https://docs.gitlab.com/api/discussions/ "Line code": `<SHA>_<old>_<new>`, SHA the SHA1 of the filename.
        assert_eq!(line_code("README.md", &add(2, 2)), "8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d_2_2");
        assert_eq!(line_code("src/app.rs", &del(7, 6)), "a841ae12f0c6bcc9fffab1c77aa87ed0e21a0708_7_6");
    }

    fn comment(start: Option<ReviewLine>, end: ReviewLine, body: &str) -> NewReviewComment {
        let refs = DiffRefs { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: "h".repeat(40) };
        NewReviewComment { anchor: ReviewAnchor { path: "src/app.rs".into(), old_path: "src/app.rs".into(), start, end }, body: body.into(), refs }
    }

    #[test]
    fn a_comment_needs_text_and_a_range_that_runs_down_the_diff() {
        assert_eq!(check_comment(&comment(None, add(3, 3), "  ")).unwrap_err().message, "Write a comment first");
        assert!(check_comment(&comment(Some(ctx(1, 1)), add(3, 3), "Both?")).is_ok());
        assert!(check_comment(&comment(Some(del(2, 2)), add(3, 2), "Swap?")).is_ok(), "a removed line, then an added one: down the diff");
        assert_eq!(check_comment(&comment(Some(add(3, 3)), ctx(1, 1), "x")).unwrap_err().message, DOWN_THE_DIFF);
        assert_eq!(check_comment(&comment(Some(add(3, 3)), add(3, 3), "x")).unwrap_err().message, DOWN_THE_DIFF);
        let mut no_head = comment(None, add(3, 3), "x");
        no_head.refs.head_sha.clear();
        assert_eq!(check_comment(&no_head).unwrap_err().message, "Pick a line of the diff first");
    }

    #[test]
    fn one_message_rule_for_the_composer_and_the_pending_review() {
        use ReviewEvent::*;
        let said = |event, body: &str, drafts, kind| check_review_message(&ReviewSubmit { event, body: body.into() }, drafts, kind).err().map(|e| e.message);
        assert_eq!(said(Comment, " ", 0, None).as_deref(), Some("Write a comment first"), "known before the target");
        assert_eq!(said(RequestChanges, "", 0, None), None, "needs the target's kind");
        assert_eq!(said(RequestChanges, "", 0, Some(ForgeKind::GitHub)).as_deref(), Some("Say what to change first"));
        assert_eq!(said(RequestChanges, "", 0, Some(ForgeKind::GitLab)), None, "GitLab's retry of a part-way one");
        assert_eq!(said(Comment, "", 2, Some(ForgeKind::GitHub)), None, "the drafts are the review");
        assert_eq!(said(Approve, "", 0, Some(ForgeKind::GitHub)), None);
        assert_eq!(said(RequestChanges, "Fix it", 0, Some(ForgeKind::GitHub)), None);
    }

    use crate::forge::fake::*;
    use crate::forge::hub::ForgeHub;
    use crate::payload::RemotePayload;
    use crate::redact::Secret;
    use crate::remotes::HostKind;
    use crate::settings::SettingsStore;
    use std::sync::Arc;

    const TOKEN: &str = "glpat-FAKE-test-token";
    const HOST: &str = "gitlab.example.com";

    /// An account on HOST whose GitLab says `version`; origin is `group/project`.
    async fn setup(version: &str) -> (Arc<FakeProvider>, ForgeHub, Arc<SettingsStore>, Vec<RemotePayload>) {
        let mut p = FakeProvider::new(ForgeKind::GitLab, HOST);
        p.version = Some(version.into());
        p.projects.lock().unwrap().insert("group/project".into(), project(HOST, "group/project", None, 1));
        let conn = Arc::new(FakeConnector::default());
        let p = conn.add(TOKEN, p);
        let hub = ForgeHub::new(conn, MemTokens::new(TokenStorage::Keyring), Arc::new(|| 1_791_115_200_000));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        let origin = RemotePayload { name: "origin".into(), host: Some(HOST.into()), path: Some("group/project".into()), host_kind: HostKind::GitLab, main: false };
        (p, hub, store, vec![origin])
    }

    #[tokio::test]
    async fn an_older_gitlab_takes_no_drafts_and_says_to_comment_now() {
        let (p, hub, store, remotes) = setup("16.2.4").await;
        assert!(!hub.review_drafts(&store, &remotes, 12).await.unwrap().can_draft);
        let e = hub.add_draft(&store, &remotes, 12, comment(None, add(2, 2), "Why?")).await.unwrap_err();
        assert_eq!(e.message, OLD_GITLAB_DRAFTS);
        assert!(!p.calls().iter().any(|c| c.starts_with("add_draft")), "never asked");
        hub.comment_now(&store, &remotes, 12, comment(None, add(2, 2), "Why?")).await.unwrap();
        let (_, hub, store, remotes) = setup("16.3.0-ee").await;
        assert!(hub.review_drafts(&store, &remotes, 12).await.unwrap().can_draft);
    }

    #[tokio::test]
    async fn submitting_needs_a_message_only_without_drafts_and_counts_them() {
        let (p, hub, store, remotes) = setup("18.9.1-ee").await;
        let review = |event, body: &str| ReviewSubmit { event, body: body.into() };
        assert_eq!(hub.submit_review(&store, &remotes, 12, review(ReviewEvent::Comment, "")).await.unwrap_err().message, "Write a comment first");
        // GitLab: the retry of a part-way request changes whose summary went in.
        hub.submit_review(&store, &remotes, 12, review(ReviewEvent::RequestChanges, " ")).await.unwrap();
        assert!(p.calls().iter().any(|c| c.starts_with("submit_review 12 RequestChanges")), "{:?}", p.calls());
        hub.add_draft(&store, &remotes, 12, comment(Some(ctx(1, 1)), add(2, 2), "Both?")).await.unwrap();
        let out = hub.submit_review(&store, &remotes, 12, review(ReviewEvent::Comment, "")).await.unwrap();
        assert_eq!(out, SubmitOutcome { published: 1, event_error: None, body_posted: false, event_sent: false, fallback: false });
        assert!(p.calls().iter().any(|c| c == "submit_review 12 Comment "), "{:?}", p.calls());
        assert!(hub.review_drafts(&store, &remotes, 12).await.unwrap().drafts.is_empty());
    }

    #[tokio::test]
    async fn empty_text_and_backwards_ranges_are_refused_before_the_forge_is_asked() {
        let (p, hub, store, remotes) = setup("18.9.1-ee").await;
        assert_eq!(hub.edit_draft(&store, &remotes, 12, "1".into(), " ".into()).await.unwrap_err().message, "A comment can't be empty: delete it instead");
        assert_eq!(hub.add_draft(&store, &remotes, 12, comment(Some(add(3, 3)), ctx(1, 1), "x")).await.unwrap_err().message, DOWN_THE_DIFF);
        assert_eq!(hub.comment_now(&store, &remotes, 12, comment(None, add(2, 2), "")).await.unwrap_err().message, "Write a comment first");
        assert!(!p.calls().iter().any(|c| c.starts_with("add_draft") || c.starts_with("edit_draft") || c.starts_with("comment_now")), "{:?}", p.calls());
        assert_eq!(hub.discard_review(&store, &remotes, 12).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn the_fakes_draft_keeps_its_ranges_start_on_each_side() {
        let (_, hub, store, remotes) = setup("18.9.1-ee").await;
        let d = hub.add_draft(&store, &remotes, 12, comment(Some(del(2, 2)), add(3, 3), "Swap?")).await.unwrap();
        let p = d.position.unwrap();
        assert_eq!((p.start_line, p.start_old_line, p.line, p.old_line), (None, Some(2), Some(3), None), "a removed start is on the old side");
        let d = hub.add_draft(&store, &remotes, 12, comment(Some(ctx(1, 1)), add(3, 3), "Both?")).await.unwrap();
        assert_eq!(d.position.unwrap().start_line, Some(1));
        let d = hub.add_draft(&store, &remotes, 12, comment(None, add(3, 3), "One")).await.unwrap();
        assert_eq!(d.position.map(|p| (p.start_line, p.start_old_line)), Some((None, None)));
    }

    #[tokio::test]
    async fn the_fakes_edit_changes_the_kept_draft() {
        let (_, hub, store, remotes) = setup("18.9.1-ee").await;
        let d = hub.add_draft(&store, &remotes, 12, comment(None, add(2, 2), "Why?")).await.unwrap();
        let edited = hub.edit_draft(&store, &remotes, 12, d.id.clone(), "Why not?".into()).await.unwrap();
        assert_eq!((edited.body.as_str(), edited.position), ("Why not?", None), "the answer has no position: the caller keeps its own");
        let kept = hub.review_drafts(&store, &remotes, 12).await.unwrap().drafts;
        assert_eq!((kept.len(), kept[0].body.as_str(), kept[0].position.is_some()), (1, "Why not?", true));
        assert_eq!(hub.edit_draft(&store, &remotes, 12, "draft-9".into(), "x".into()).await.unwrap_err().kind, GbErrorKind::NotFound);
    }
}
