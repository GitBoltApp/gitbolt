//! Test doubles for the hub and the API: no network, no keyring.

use crate::avatar::AvatarPayload;
use crate::error::{GbError, GbErrorKind};
use crate::forge::*;
use crate::redact::Secret;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) fn user(name: &str) -> ForgeUser {
    let login = name.to_lowercase();
    ForgeUser { id: 1, username: login.clone(), name: name.into(), avatar_url: None, web_url: format!("https://gitlab.example.com/{login}"), email: Some(format!("{login}@example.com")) }
}

pub(crate) fn project(host: &str, path: &str, fork_of: Option<&str>, updated_at: i64) -> ForgeProject {
    let (owner, name) = path.rsplit_once('/').unwrap_or(("", path));
    ForgeProject {
        kind: ForgeKind::GitLab, id: updated_at as u64, host: host.into(), path: path.into(), name: name.into(), owner: owner.into(),
        web_url: format!("https://{host}/{path}"), default_branch: Some("main".into()), clone_https: format!("https://{host}/{path}.git"),
        clone_ssh: format!("git@{host}:{path}.git"), fork_of: fork_of.map(str::to_string), updated_at: Some(updated_at), archived: false, owner_avatar_url: None,
    }
}

pub(crate) struct FakeProvider {
    pub kind: ForgeKind,
    pub host: String,
    /// Every token check and request fails with AuthFailed.
    pub reject: bool,
    pub user: ForgeUser,
    pub write: WriteAccess,
    pub version: Option<String>,
    pub projects: Mutex<HashMap<String, ForgeProject>>,
    pub forks: Vec<ForgeProject>,
    pub settings: Option<ForgeProjectSettings>,
    pub avatars: HashMap<String, AvatarPayload>,
    pub limited_until: Mutex<Option<i64>>,
    pub calls: Mutex<Vec<String>>,
    // --- 4B T1 ---
    /// Every MR/PR of the fake project (open_mrs keeps the open and draft ones).
    pub mrs: Mutex<Vec<ForgeMr>>,
    pub details: Mutex<HashMap<u64, ForgeMrDetail>>,
    pub threads: Mutex<HashMap<u64, Vec<ForgeDiscussion>>>,
    /// `open_mrs` and `mr_for_branch` fail with this kind.
    pub mr_error: Mutex<Option<GbErrorKind>>,
    // --- end 4B T1 ---
    /// `mr_for_branch` of these branches fails with its kind (one slow branch).
    pub lookup_errors: Mutex<HashMap<String, GbErrorKind>>,
      // --- 4C T5 ---
      pub people: Vec<ForgeUser>,
      pub label_list: Vec<ForgeLabel>,
      /// `None`: asking for templates fails as an unreachable forge (the local fallback's case).
      pub templates: Option<Vec<MrTemplate>>,
      /// What every create's follow-up calls report as failed (GitHub's partial failure).
      pub fail_parts: Mutex<Vec<PartFailure>>,
      pub created: Mutex<Vec<CreateMr>>,
      // --- end 4C T5 ---
      // --- 5A T1 ---
      /// URL → what `image` answers; any other URL isn't this forge's (`None`).
      pub images: Mutex<HashMap<String, ForgeImage>>,
      pub videos: Mutex<HashMap<String, ForgeImage>>,
      // --- end 5A T1 ---
    // --- review comments ---
    /// MR → its diff (`review_diff`) and its pending drafts (`review_drafts`).
    pub review_diffs: Mutex<HashMap<u64, ReviewDiff>>,
    pub drafts: Mutex<HashMap<u64, Vec<ReviewDraft>>>,
    // --- end review comments ---
    // --- MR round 2 ---
    /// What `people_limits` answers.
    pub limits: Mutex<PeopleLimits>,
    /// The next `edit` fails with this.
    pub edit_error: Mutex<Option<GbError>>,
    // --- end MR round 2 ---
}

impl FakeProvider {
    pub fn new(kind: ForgeKind, host: &str) -> Self {
        Self {
            kind, host: host.into(), reject: false, user: user("Ada"), write: WriteAccess::Yes, version: Some("18.9.1-ee".into()),
            projects: Mutex::default(), forks: Vec::new(), settings: None, avatars: HashMap::new(), limited_until: Mutex::new(None), calls: Mutex::default(),
            // --- 4B T1 ---
            mrs: Mutex::default(), details: Mutex::default(), threads: Mutex::default(), mr_error: Mutex::new(None),
            // --- end 4B T1 ---
            lookup_errors: Mutex::default(),
              // --- 4C T5 ---
              people: Vec::new(), label_list: Vec::new(), templates: Some(Vec::new()), fail_parts: Mutex::default(), created: Mutex::default(),
              // --- end 4C T5 ---
              // --- 5A T1 ---
              images: Mutex::default(),
              videos: Mutex::default(),
              // --- end 5A T1 ---
            // --- review comments ---
            review_diffs: Mutex::default(), drafts: Mutex::default(),
            // --- end review comments ---
            limits: Mutex::default(), edit_error: Mutex::default(),
        }
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn call(&self, what: impl Into<String>) {
        self.calls.lock().unwrap().push(what.into());
    }

    fn check(&self) -> Result<(), GbError> {
        if self.reject { Err(GbError::new(GbErrorKind::AuthFailed, format!("{} rejected the token: add the account again in Settings › Accounts", self.host))) } else { Ok(()) }
    }

    // --- 4B T1 ---
    fn mr_failure(&self) -> Result<(), GbError> {
        match *self.mr_error.lock().unwrap() {
            Some(kind) => Err(GbError::new(kind, "fake failure")),
            None => Ok(()),
        }
    }
    // --- end 4B T1 ---
}

impl ForgeProvider for FakeProvider {
    fn kind(&self) -> ForgeKind {
        self.kind
    }
    fn host(&self) -> &str {
        &self.host
    }
    fn rate_limit(&self) -> RateLimitState {
        RateLimitState { limited_until: *self.limited_until.lock().unwrap(), ..Default::default() }
    }
    fn check_token(&self) -> ForgeFuture<'_, TokenCheck> {
        self.call("check_token");
        Box::pin(async move {
            self.check()?;
            Ok(TokenCheck { user: self.user.clone(), write: self.write.clone() })
        })
    }
    fn current_user(&self) -> ForgeFuture<'_, ForgeUser> {
        self.call("current_user");
        Box::pin(async move {
            self.check()?;
            Ok(self.user.clone())
        })
    }
    fn version(&self) -> ForgeFuture<'_, Option<String>> {
        self.call("version");
        Box::pin(async move { Ok(self.version.clone()) })
    }
    fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> {
        self.call(format!("project {path}"));
        Box::pin(async move {
            self.check()?;
            self.projects.lock().unwrap().get(path).cloned().map(|p| Fresh::new(p, 1)).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host)))
        })
    }
    fn project_settings<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> {
        self.call(format!("settings {}", project.path));
        Box::pin(async move { self.settings.clone().ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host))) })
    }
    fn forks<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> {
        self.call(format!("forks {}", project.path));
        Box::pin(async move { Ok(self.forks.clone()) })
    }
    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        self.call(format!("avatar {email}"));
        Box::pin(async move { Ok(self.avatars.get(email).cloned()) })
    }
    /// Serves its own host's `/uploads/` and Gravatar's, from `avatars` keyed by the URL.
    fn avatar_at<'a>(&'a self, url: &'a str) -> Option<ForgeFuture<'a, Option<AvatarPayload>>> {
        let url = crate::forge::avatar_fetch_url(url, &[&format!("https://{}/uploads", self.host)])?;
        self.call(format!("avatar_at {url}"));
        Some(Box::pin(async move { Ok(self.avatars.get(&url).cloned()) }))
    }
    // --- 4B T1 ---
    fn open_mrs<'a>(&'a self, project: &'a ForgeProject, filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        self.call(format!("open_mrs {} {filter:?}", project.path));
        Box::pin(async move {
            self.check()?;
            self.mr_failure()?;
            let mrs = self.mrs.lock().unwrap().iter().filter(|m| matches!(m.state, MrState::Open | MrState::Draft)).filter(|m| filter != MrFilter::Mine || m.author.username == self.user.username).cloned().collect();
            Ok(Fresh { value: mrs, not_modified: false, poll_interval_secs: Some(30), fetched_at: 9 })
        })
    }
    fn mr_for_branch<'a>(&'a self, _project: &'a ForgeProject, source: &'a SourceRef) -> ForgeFuture<'a, Fresh<Option<ForgeMr>>> {
        self.call(format!("mr_for_branch {} {}", source.project, source.branch));
        Box::pin(async move {
            self.check()?;
            self.mr_failure()?;
            if let Some(kind) = self.lookup_errors.lock().unwrap().get(&source.branch) {
                return Err(GbError::new(*kind, "fake failure"));
            }
            let found = self.mrs.lock().unwrap().iter().filter(|m| m.source_project == source.project && m.source_branch == source.branch).max_by_key(|m| m.updated_at).cloned();
            Ok(Fresh::new(found, 9))
        })
    }
    fn mr_detail<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<ForgeMrDetail>> {
        self.call(format!("mr_detail {number}"));
        Box::pin(async move { self.details.lock().unwrap().get(&number).cloned().map(|d| Fresh::new(d, 9)).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host))) })
    }
    fn discussions<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<Vec<ForgeDiscussion>>> {
        self.call(format!("discussions {number}"));
        Box::pin(async move { Ok(Fresh::new(self.threads.lock().unwrap().get(&number).cloned().unwrap_or_default(), 9)) })
    }
    fn reply<'a>(&'a self, _project: &'a ForgeProject, number: u64, note: &'a NewNote) -> ForgeFuture<'a, ForgeNote> {
        self.call(format!("reply {number} {:?} {}", note.discussion, note.body));
        Box::pin(async move { Ok(ForgeNote { id: "n1".into(), author: self.user.clone(), body: note.body.clone(), created_at: 9, system: false, position: None, body_html: None, reactions: vec![], web_url: None }) })
    }
    // --- comment actions ---
    fn react<'a>(&'a self, _project: &'a ForgeProject, number: u64, note: &'a NoteRef, name: &'a str, on: bool) -> ForgeFuture<'a, Vec<ForgeReaction>> {
        self.call(format!("react {number} {} {name} {on}", note.note));
        Box::pin(async move { Ok(if on { vec![ForgeReaction { name: name.into(), count: 1, mine: true, users: vec![self.user.name.clone()] }] } else { vec![] }) })
    }
    fn edit_note<'a>(&'a self, _project: &'a ForgeProject, number: u64, note: &'a NoteRef, body: &'a str) -> ForgeFuture<'a, ForgeNote> {
        self.call(format!("edit_note {number} {} {body}", note.note));
        Box::pin(async move { Ok(ForgeNote { id: note.note.clone(), author: self.user.clone(), body: body.into(), created_at: 9, system: false, position: None, body_html: None, reactions: vec![], web_url: None }) })
    }
    fn delete_note<'a>(&'a self, _project: &'a ForgeProject, number: u64, note: &'a NoteRef) -> ForgeFuture<'a, ()> {
        self.call(format!("delete_note {number} {}", note.note));
        Box::pin(async { Ok(()) })
    }
    fn resolve<'a>(&'a self, _project: &'a ForgeProject, number: u64, discussion: &'a str, resolved: bool) -> ForgeFuture<'a, ThreadState> {
        self.call(format!("resolve {number} {discussion} {resolved}"));
        Box::pin(async move { Ok(ThreadState { resolved, resolved_by: resolved.then(|| self.user.name.clone()) }) })
    }
    // --- end comment actions ---
    fn approve<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ()> {
        self.call(format!("approve {number}"));
        Box::pin(async { Ok(()) })
    }
    fn request_changes<'a>(&'a self, _project: &'a ForgeProject, number: u64, body: &'a str) -> ForgeFuture<'a, ()> {
        self.call(format!("request_changes {number} {body}"));
        Box::pin(async { Ok(()) })
    }
    fn merge<'a>(&'a self, _project: &'a ForgeProject, number: u64, opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        self.call(format!("merge {number} {:?}", opts.squash));
        Box::pin(async move { self.change(number, |m| m.state = MrState::Merged) })
    }
    fn set_auto_merge<'a>(&'a self, _project: &'a ForgeProject, number: u64, opts: &'a MergeOptions) -> ForgeFuture<'a, ForgeMr> {
        self.call(format!("set_auto_merge {number} {:?}", opts.method));
        Box::pin(async move { self.change(number, |m| m.auto_merge = Some(AutoMerge { enabled_by: Some(self.user.clone()), method: opts.method })) })
    }
    fn cancel_auto_merge<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ForgeMr> {
        self.call(format!("cancel_auto_merge {number}"));
        Box::pin(async move { self.change(number, |m| m.auto_merge = None) })
    }
    fn edit<'a>(&'a self, _project: &'a ForgeProject, number: u64, edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        self.call(format!("edit {number} {:?}", edit.title));
        if let Some(e) = self.edit_error.lock().unwrap().take() {
            return Box::pin(async move { Err(e) });
        }
        Box::pin(async move { self.change(number, |m| if let Some(t) = &edit.title { m.title = t.clone() }) })
    }
    fn people_limits<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, PeopleLimits> {
        self.call(format!("people_limits {}", project.path));
        Box::pin(async move { Ok(*self.limits.lock().unwrap()) })
    }
    fn set_draft<'a>(&'a self, _project: &'a ForgeProject, number: u64, draft: bool) -> ForgeFuture<'a, ForgeMr> {
        self.call(format!("set_draft {number} {draft}"));
        Box::pin(async move { self.change(number, |m| m.state = if draft { MrState::Draft } else { MrState::Open }) })
    }
    // --- end 4B T1 ---
      // --- 4C T5 ---
      fn create_mr<'a>(&'a self, project: &'a ForgeProject, req: &'a CreateMr) -> ForgeFuture<'a, CreateOutcome> {
          self.call(format!("create {} {}", project.path, req.source.branch));
          Box::pin(async move {
              self.check()?;
              let number = {
                  let mut created = self.created.lock().unwrap();
                  created.push(req.clone());
                  created.len() as u64
              };
              let mr = ForgeMr {
                  number, title: req.title.clone(), state: if req.draft { MrState::Draft } else { MrState::Open }, author: self.user.clone(),
                  source_project: req.source.project.clone(), source_branch: req.source.branch.clone(), target_project: project.path.clone(),
                  target_branch: req.target_branch.clone(), head_sha: None, web_url: format!("{}/-/merge_requests/{number}", project.web_url), pipeline: None,
                  review: ReviewSummary { decision: ReviewDecision::None, approvals: 0, approvals_required: None, reviews: Vec::new() },
                  conflicts: None, labels: req.labels.clone(), label_colors: Default::default(), updated_at: 0, stacked: crate::forge::stack::carries_stack_table(&req.description), auto_merge: None,
              };
              Ok(CreateOutcome { mr, failed: self.fail_parts.lock().unwrap().clone() })
          })
      }
      fn complete_create<'a>(&'a self, _project: &'a ForgeProject, number: u64, _req: &'a CreateMr, parts: &'a [CreatePart]) -> ForgeFuture<'a, Vec<PartFailure>> {
          self.call(format!("complete {number} {parts:?}"));
          Box::pin(async move {
              self.check()?;
              self.fail_parts.lock().unwrap().retain(|f| !parts.contains(&f.part));
              Ok(Vec::new())
          })
      }
      fn search_users<'a>(&'a self, _project: &'a ForgeProject, query: &'a str) -> ForgeFuture<'a, Vec<ForgeUser>> {
          self.call(format!("users {query}"));
          Box::pin(async move { Ok(self.people.iter().filter(|u| u.username.contains(query)).cloned().collect()) })
      }
      fn labels<'a>(&'a self, _project: &'a ForgeProject, query: &'a str) -> ForgeFuture<'a, Vec<ForgeLabel>> {
          self.call(format!("labels {query}"));
          Box::pin(async move { Ok(self.label_list.iter().filter(|l| l.name.contains(query)).cloned().collect()) })
      }
      fn mr_templates<'a>(&'a self, _project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Vec<MrTemplate>> {
          self.call(format!("templates {branch}"));
          Box::pin(async move { self.templates.clone().ok_or_else(|| GbError::new(GbErrorKind::Network, format!("Couldn't reach {}: timed out", self.host))) })
      }
      // --- end 4C T5 ---
    // --- 5A T1 ---
    fn image<'a>(&'a self, _project: &'a ForgeProject, url: &'a str) -> Option<ForgeFuture<'a, ForgeImage>> {
        self.call(format!("image {url}"));
        let found = self.images.lock().unwrap().get(url).cloned()?;
        Some(Box::pin(async move { Ok(found) }))
    }
    // --- end 5A T1 ---
    fn video<'a>(&'a self, _project: &'a ForgeProject, url: &'a str) -> Option<ForgeFuture<'a, ForgeImage>> {
        self.call(format!("video {url}"));
        let found = self.videos.lock().unwrap().get(url).cloned()?;
        Some(Box::pin(async move { Ok(found) }))
    }
    // --- review comments ---
    fn review_diff<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ReviewDiff> {
        self.call(format!("review_diff {number}"));
        Box::pin(async move { self.review_diffs.lock().unwrap().get(&number).cloned().ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host))) })
    }
    fn review_drafts<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, ReviewDrafts> {
        self.call(format!("review_drafts {number}"));
        Box::pin(async move { Ok(ReviewDrafts { refs: Some(fake_refs()), drafts: self.drafts.lock().unwrap().get(&number).cloned().unwrap_or_default(), pending_review: None, can_draft: true }) })
    }
    fn add_draft<'a>(&'a self, _project: &'a ForgeProject, number: u64, c: &'a NewReviewComment) -> ForgeFuture<'a, ReviewDraft> {
        self.call(format!("add_draft {number} {}:{} {}", c.anchor.path, c.anchor.end.number(), c.body));
        Box::pin(async move {
            let mut all = self.drafts.lock().unwrap();
            let list = all.entry(number).or_default();
            // A line's number on its side: (new, old).
            let at = |l: &ReviewLine| match l.side() {
                DiffSide::New => (Some(l.number()), None),
                DiffSide::Old => (None, Some(l.number())),
            };
            let (line, old_line) = at(&c.anchor.end);
            let (start_line, start_old_line) = c.anchor.start.as_ref().map_or((None, None), at);
            let position = DiffPosition { path: c.anchor.path.clone(), old_path: None, line, old_line, snippet: None, start_line, start_old_line, head_sha: Some(c.refs.head_sha.clone()), outdated: false };
            let d = ReviewDraft { id: format!("draft-{}", list.len() + 1), body: c.body.clone(), position: Some(position), reply_to: None };
            list.push(d.clone());
            Ok(d)
        })
    }
    fn edit_draft<'a>(&'a self, _project: &'a ForgeProject, number: u64, id: &'a str, body: &'a str) -> ForgeFuture<'a, ReviewDraft> {
        self.call(format!("edit_draft {number} {id} {body}"));
        Box::pin(async move {
            let mut all = self.drafts.lock().unwrap();
            let d = all.entry(number).or_default().iter_mut().find(|d| d.id == id).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host)))?;
            d.body = body.into();
            Ok(ReviewDraft { id: id.into(), body: body.into(), position: None, reply_to: None })
        })
    }
    fn delete_draft<'a>(&'a self, _project: &'a ForgeProject, number: u64, id: &'a str) -> ForgeFuture<'a, ()> {
        self.call(format!("delete_draft {number} {id}"));
        Box::pin(async move {
            self.drafts.lock().unwrap().entry(number).or_default().retain(|d| d.id != id);
            Ok(())
        })
    }
    fn submit_review<'a>(&'a self, _project: &'a ForgeProject, number: u64, review: &'a ReviewSubmit) -> ForgeFuture<'a, SubmitOutcome> {
        self.call(format!("submit_review {number} {:?} {}", review.event, review.body));
        Box::pin(async move {
            self.drafts.lock().unwrap().remove(&number);
            Ok(SubmitOutcome::default())
        })
    }
    fn discard_review<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, u32> {
        self.call(format!("discard_review {number}"));
        Box::pin(async move { Ok(self.drafts.lock().unwrap().remove(&number).map_or(0, |l| l.len() as u32)) })
    }
    fn comment_now<'a>(&'a self, _project: &'a ForgeProject, number: u64, c: &'a NewReviewComment) -> ForgeFuture<'a, ForgeDiscussion> {
        self.call(format!("comment_now {number} {}:{} {}", c.anchor.path, c.anchor.end.number(), c.body));
        Box::pin(async move { Ok(ForgeDiscussion { id: "d-now".into(), notes: vec![], resolvable: true, resolved: false, resolved_by: None }) })
    }
    // --- end review comments ---
}

// --- 4B T1 ---
impl FakeProvider {
    fn change(&self, number: u64, f: impl FnOnce(&mut ForgeMr)) -> Result<ForgeMr, GbError> {
        let mut mrs = self.mrs.lock().unwrap();
        let m = mrs.iter_mut().find(|m| m.number == number).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("Not found on {}", self.host)))?;
        f(m);
        Ok(m.clone())
    }
}

/// An MR of `group/project` from `source_project`'s `branch`.
pub(crate) fn mr(number: u64, source_project: &str, branch: &str, state: MrState) -> ForgeMr {
    ForgeMr {
        number, title: format!("MR {number}"), state, author: user("Ada"),
        source_project: source_project.into(), source_branch: branch.into(), target_project: "group/project".into(), target_branch: "main".into(),
        head_sha: Some(format!("{number:040}")), web_url: format!("https://gitlab.example.com/group/project/-/merge_requests/{number}"),
        pipeline: None, review: ReviewSummary { decision: ReviewDecision::None, approvals: 0, approvals_required: None, reviews: vec![] },
        conflicts: Some(false), labels: vec![], label_colors: Default::default(), updated_at: number as i64, stacked: false, auto_merge: None,
    }
}
// --- end 4B T1 ---

// --- review comments ---
/// The diff refs the fake answers: base `b…`, head `h…`.
pub(crate) fn fake_refs() -> DiffRefs {
    DiffRefs { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: "h".repeat(40) }
}
// --- end review comments ---

/// Hands out providers by token: a known token (for that host) gets its provider, any other a
/// rejecting one. Counts connects.
#[derive(Default)]
pub(crate) struct FakeConnector {
    pub by_token: Mutex<HashMap<String, Arc<FakeProvider>>>,
    pub connects: AtomicUsize,
    // --- 5A T1 ---
    /// URL → what `public_image` answers (else a network error); every URL asked, in order.
    pub public: Mutex<HashMap<String, ForgeImage>>,
    pub public_calls: Mutex<Vec<String>>,
    // --- end 5A T1 ---
}

impl FakeConnector {
    pub fn with(token: &str, p: FakeProvider) -> Arc<Self> {
        let c = Arc::new(Self::default());
        c.add(token, p);
        c
    }

    pub fn add(&self, token: &str, p: FakeProvider) -> Arc<FakeProvider> {
        let p = Arc::new(p);
        self.by_token.lock().unwrap().insert(token.into(), p.clone());
        p
    }
}

impl ForgeConnector for FakeConnector {
    fn connect(&self, kind: ForgeKind, host: &str, token: Secret) -> Result<Arc<dyn ForgeProvider>, GbError> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        let known = self.by_token.lock().unwrap().get(token.expose()).cloned().filter(|p| p.host == host);
        Ok(match known {
            Some(p) => p,
            None => Arc::new(FakeProvider { reject: true, ..FakeProvider::new(kind, host) }),
        })
    }
    // --- 5A T1 ---
    fn public_image<'a>(&'a self, url: &'a str) -> ForgeFuture<'a, ForgeImage> {
        self.public_calls.lock().unwrap().push(url.to_string());
        let found = self.public.lock().unwrap().get(url).cloned();
        Box::pin(async move { found.ok_or_else(|| GbError::new(GbErrorKind::Network, "Couldn't reach the image host")) })
    }
    fn public_video<'a>(&'a self, url: &'a str) -> ForgeFuture<'a, ForgeImage> {
        self.public_calls.lock().unwrap().push(format!("video {url}"));
        let found = self.public.lock().unwrap().get(url).cloned();
        Box::pin(async move { found.ok_or_else(|| GbError::new(GbErrorKind::Network, "Couldn't reach the video host")) })
    }
    // --- end 5A T1 ---
}

/// Tokens in memory. `put` answers `storage`.
pub(crate) struct MemTokens {
    pub map: Mutex<HashMap<AccountKey, String>>,
    pub storage: TokenStorage,
}

impl MemTokens {
    pub fn new(storage: TokenStorage) -> Arc<Self> {
        Arc::new(Self { map: Mutex::default(), storage })
    }

    pub fn token(&self, profile: &str, host: &str) -> Option<String> {
        self.map.lock().unwrap().get(&AccountKey { profile: profile.into(), host: host.into() }).cloned()
    }
}

impl TokenStore for MemTokens {
    fn put(&self, key: &AccountKey, token: &Secret) -> Result<TokenStorage, GbError> {
        self.map.lock().unwrap().insert(key.clone(), token.expose().to_string());
        Ok(self.storage)
    }
    fn get(&self, key: &AccountKey, _storage: TokenStorage) -> Result<Option<Secret>, GbError> {
        Ok(self.map.lock().unwrap().get(key).cloned().map(Secret::new))
    }
    fn delete(&self, key: &AccountKey) -> Result<(), GbError> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}
// --- 4D T3: a provider with merge requests, for the stack requests ---
/// (4B's `fake::mr(number, source_project, branch, state)` is a different helper: this one has a target and a title.)
pub(crate) fn stack_mr(number: u64, source: &str, target: &str, state: MrState, title: &str) -> ForgeMr {
    ForgeMr {
        number,
        title: title.into(),
        state,
        author: user("Ada"),
        source_project: "group/project".into(),
        source_branch: source.into(),
        target_project: "group/project".into(),
        target_branch: target.into(),
        head_sha: Some(format!("{number:040}")),
        web_url: format!("https://gitlab.example.com/group/project/-/merge_requests/{number}"),
        pipeline: None,
        review: ReviewSummary { decision: ReviewDecision::None, approvals: 0, approvals_required: None, reviews: vec![] },
        conflicts: Some(false),
        labels: vec![],
        label_colors: Default::default(),
        updated_at: number as i64,
        stacked: false,
        auto_merge: None,
    }
}

/// 4A's `FakeProvider` for identity and projects, plus merge requests with descriptions in
/// memory. Every MR call is logged (`log`). `fail_edit` / `fail_retarget`: that MR's write fails.
pub(crate) struct StackFake {
    pub base: FakeProvider,
    pub mrs: Mutex<Vec<(ForgeMr, String)>>,
    /// The project's "delete source branch" default (`project_settings`).
    pub settings_delete: bool,
    pub fail_edit: Option<u64>,
    pub fail_retarget: Option<u64>,
    // --- 4D T4 ---
    /// This MR's retarget fails when it points anywhere but `main` (a revert that fails).
    pub fail_back: Option<u64>,
    /// `project_settings` fails.
    pub fail_settings: bool,
    // --- end 4D T4 ---
    pub log: Mutex<Vec<String>>,
}

impl StackFake {
    /// GitLab at `version`, with `group/project` and these MRs (with their descriptions).
    pub fn new(version: &str, mrs: Vec<(ForgeMr, &str)>) -> Self {
        let mut base = FakeProvider::new(ForgeKind::GitLab, "gitlab.example.com");
        base.version = Some(version.into());
        base.projects.lock().unwrap().insert("group/project".into(), project("gitlab.example.com", "group/project", None, 1));
        Self {
            base,
            mrs: Mutex::new(mrs.into_iter().map(|(m, d)| (m, d.to_string())).collect()),
            settings_delete: false,
            fail_edit: None,
            fail_retarget: None,
            // --- 4D T4 ---
            fail_back: None,
            fail_settings: false,
            // --- end 4D T4 ---
            log: Mutex::default(),
        }
    }

    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    pub fn description(&self, n: u64) -> String {
        self.mrs.lock().unwrap().iter().find(|(m, _)| m.number == n).map(|(_, d)| d.clone()).unwrap_or_default()
    }

    pub fn target(&self, n: u64) -> String {
        self.mrs.lock().unwrap().iter().find(|(m, _)| m.number == n).map(|(m, _)| m.target_branch.clone()).unwrap_or_default()
    }

    fn note(&self, what: String) {
        self.log.lock().unwrap().push(what);
    }

    fn missing(&self, n: u64) -> GbError {
        GbError::new(GbErrorKind::NotFound, format!("!{n} not found on gitlab.example.com"))
    }
}

impl ForgeProvider for StackFake {
    fn kind(&self) -> ForgeKind {
        self.base.kind()
    }
    fn host(&self) -> &str {
        self.base.host()
    }
    fn rate_limit(&self) -> RateLimitState {
        self.base.rate_limit()
    }
    fn check_token(&self) -> ForgeFuture<'_, TokenCheck> {
        self.base.check_token()
    }
    fn current_user(&self) -> ForgeFuture<'_, ForgeUser> {
        self.base.current_user()
    }
    fn version(&self) -> ForgeFuture<'_, Option<String>> {
        self.base.version()
    }
    fn project<'a>(&'a self, path: &'a str) -> ForgeFuture<'a, Fresh<ForgeProject>> {
        self.base.project(path)
    }
    fn project_settings<'a>(&'a self, _project: &'a ForgeProject) -> ForgeFuture<'a, ForgeProjectSettings> {
        self.note("project_settings".into());
        let delete = self.settings_delete;
        // --- 4D T4 ---
        let fail = self.fail_settings;
        // --- end 4D T4 ---
        Box::pin(async move {
            // --- 4D T4 ---
            if fail {
                return Err(GbError::new(GbErrorKind::Network, "Can't reach gitlab.example.com"));
            }
            // --- end 4D T4 ---
            Ok(ForgeProjectSettings { merge_methods: vec![MergeMethod::Merge], squash: SquashOption::DefaultOff, delete_source_branch: delete }) })
    }
    fn forks<'a>(&'a self, project: &'a ForgeProject) -> ForgeFuture<'a, Vec<ForgeProject>> {
        self.base.forks(project)
    }
    fn avatar_for_email<'a>(&'a self, email: &'a str) -> ForgeFuture<'a, Option<AvatarPayload>> {
        self.base.avatar_for_email(email)
    }
    fn open_mrs<'a>(&'a self, _project: &'a ForgeProject, _filter: MrFilter) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        self.note("open_mrs".into());
        let open = self.mrs.lock().unwrap().iter().map(|(m, _)| m.clone()).filter(|m| matches!(m.state, MrState::Open | MrState::Draft)).collect();
        Box::pin(async move { Ok(Fresh::new(open, 1)) })
    }
    // --- 4D T4 ---
    fn open_mrs_targeting<'a>(&'a self, _project: &'a ForgeProject, branch: &'a str) -> ForgeFuture<'a, Fresh<Vec<ForgeMr>>> {
        self.note(format!("open_mrs_targeting {branch}"));
        let open = self.mrs.lock().unwrap().iter().map(|(m, _)| m.clone()).filter(|m| matches!(m.state, MrState::Open | MrState::Draft) && m.target_branch == branch).collect();
        Box::pin(async move { Ok(Fresh::new(open, 1)) })
    }
    // --- end 4D T4 ---
    fn mr_for_branch<'a>(&'a self, _project: &'a ForgeProject, source: &'a SourceRef) -> ForgeFuture<'a, Fresh<Option<ForgeMr>>> {
        self.note(format!("mr_for_branch {}", source.branch));
        let newest = self.mrs.lock().unwrap().iter().map(|(m, _)| m.clone()).filter(|m| m.source_branch == source.branch).max_by_key(|m| (matches!(m.state, MrState::Open | MrState::Draft), m.number));
        Box::pin(async move { Ok(Fresh::new(newest, 1)) })
    }
    fn mr_detail<'a>(&'a self, _project: &'a ForgeProject, number: u64) -> ForgeFuture<'a, Fresh<ForgeMrDetail>> {
        self.note(format!("mr_detail {number}"));
        let found = self.mrs.lock().unwrap().iter().find(|(m, _)| m.number == number).cloned();
        Box::pin(async move {
            let (mr, description) = found.ok_or_else(|| self.missing(number))?;
            Ok(Fresh::new(ForgeMrDetail { mr, description, reviewers: vec![], assignees: vec![], merge_status: MergeStatus::Mergeable, squash: None, delete_source_branch: None, body_html: None, base_sha: None, subscribed: None }, 1))
        })
    }
    fn edit<'a>(&'a self, _project: &'a ForgeProject, number: u64, edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        self.note(format!("edit {number}"));
        Box::pin(async move {
            if self.fail_edit == Some(number) {
                return Err(GbError::other("gitlab.example.com refused the change (403)"));
            }
            let mut mrs = self.mrs.lock().unwrap();
            let (mr, d) = mrs.iter_mut().find(|(m, _)| m.number == number).ok_or_else(|| self.missing(number))?;
            if let Some(next) = &edit.description {
                *d = next.clone();
            }
            Ok(mr.clone())
        })
    }
    fn retarget<'a>(&'a self, _project: &'a ForgeProject, number: u64, target: &'a str) -> ForgeFuture<'a, ForgeMr> {
        self.note(format!("retarget {number} {target}"));
        Box::pin(async move {
            if self.fail_retarget == Some(number) {
                return Err(GbError::other("gitlab.example.com refused the change (403)"));
            }
            // --- 4D T4 ---
            if self.fail_back == Some(number) && target != "main" {
                return Err(GbError::other("gitlab.example.com refused the change (403)"));
            }
            // --- end 4D T4 ---
            let mut mrs = self.mrs.lock().unwrap();
            let (mr, _) = mrs.iter_mut().find(|(m, _)| m.number == number).ok_or_else(|| self.missing(number))?;
            mr.target_branch = target.to_string();
            Ok(mr.clone())
        })
    }
}

/// A connector that answers every account with the same provider.
pub(crate) struct Solo(pub Arc<StackFake>);

impl ForgeConnector for Solo {
    fn connect(&self, _kind: ForgeKind, _host: &str, _token: Secret) -> Result<Arc<dyn ForgeProvider>, GbError> {
        Ok(self.0.clone())
    }
}
// --- end 4D T3 ---
