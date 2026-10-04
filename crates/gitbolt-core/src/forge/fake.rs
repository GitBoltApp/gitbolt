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
        clone_ssh: format!("git@{host}:{path}.git"), fork_of: fork_of.map(str::to_string), updated_at: Some(updated_at), archived: false,
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
      // --- 4C T5 ---
      pub people: Vec<ForgeUser>,
      pub label_list: Vec<ForgeLabel>,
      /// `None`: asking for templates fails as an unreachable forge (the local fallback's case).
      pub templates: Option<Vec<MrTemplate>>,
      /// What every create's follow-up calls report as failed (GitHub's partial failure).
      pub fail_parts: Mutex<Vec<PartFailure>>,
      pub created: Mutex<Vec<CreateMr>>,
      // --- end 4C T5 ---
}

impl FakeProvider {
    pub fn new(kind: ForgeKind, host: &str) -> Self {
        Self {
            kind, host: host.into(), reject: false, user: user("Ada"), write: WriteAccess::Yes, version: Some("18.9.1-ee".into()),
            projects: Mutex::default(), forks: Vec::new(), settings: None, avatars: HashMap::new(), limited_until: Mutex::new(None), calls: Mutex::default(),
            // --- 4B T1 ---
            mrs: Mutex::default(), details: Mutex::default(), threads: Mutex::default(), mr_error: Mutex::new(None),
            // --- end 4B T1 ---
              // --- 4C T5 ---
              people: Vec::new(), label_list: Vec::new(), templates: Some(Vec::new()), fail_parts: Mutex::default(), created: Mutex::default(),
              // --- end 4C T5 ---
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
        Box::pin(async move { Ok(ForgeNote { id: "n1".into(), author: self.user.clone(), body: note.body.clone(), created_at: 9, system: false, position: None }) })
    }
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
    fn edit<'a>(&'a self, _project: &'a ForgeProject, number: u64, edit: &'a MrEdit) -> ForgeFuture<'a, ForgeMr> {
        self.call(format!("edit {number} {:?}", edit.title));
        Box::pin(async move { self.change(number, |m| if let Some(t) = &edit.title { m.title = t.clone() }) })
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
                  conflicts: None, labels: req.labels.clone(), updated_at: 0,
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
        conflicts: Some(false), labels: vec![], updated_at: number as i64,
    }
}
// --- end 4B T1 ---

/// Hands out providers by token: a known token (for that host) gets its provider, any other a
/// rejecting one. Counts connects.
#[derive(Default)]
pub(crate) struct FakeConnector {
    pub by_token: Mutex<HashMap<String, Arc<FakeProvider>>>,
    pub connects: AtomicUsize,
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
