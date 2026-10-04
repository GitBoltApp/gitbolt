//! A repository's merge requests (spec #4 §3.3, §4 "4B"). Every call goes to the project the
//! repository's MRs/PRs target (4A's `RepoProjects.target`), through its account's provider, and
//! records what the answer says about the account (Settings › Accounts shows it):
//! - `branch_mrs`, the badges: one list of open MRs/PRs, mapped to the remote-tracking refs of the
//!   remotes their source projects are on, then a lookup in any state for each asked ref the list
//!   didn't cover (newest first, at most `BRANCH_LOOKUPS`);
//! - `mr_list`, the sidebar section (Mine / Review requested / All);
//! - `mr_detail`, `mr_discussions`, the hover card and the MR/PR view;
//! - the writes (spec §3.5: remote actions, not journaled). Empty text is refused here, before
//!   the forge is asked.

use crate::error::{GbError, GbErrorKind};
use crate::forge::hub::ForgeHub;
use crate::forge::*;
use crate::payload::RemotePayload;
use crate::settings::SettingsStore;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use ts_rs::TS;

/// Refs the open list didn't cover, looked up one by one per poll, at most this many.
pub const BRANCH_LOOKUPS: usize = 25;

pub const NO_TARGET: &str = "This repository has no remote on a forge account: add one in Settings › Accounts";

/// Where a repository's MRs/PRs are, and the provider to ask.
pub struct MrTarget {
    pub key: AccountKey,
    pub provider: Arc<dyn ForgeProvider>,
    pub project: ForgeProject,
    pub remote: String,
}

/// The sidebar section's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MrList {
    pub kind: ForgeKind,
    /// The remote whose project the list is of.
    pub remote: String,
    pub project: ForgeProject,
    pub filter: MrFilter,
    pub mrs: Vec<ForgeMr>,
    #[ts(type = "number")]
    pub fetched_at: i64,
    pub poll_interval_secs: Option<u32>,
}

/// One badge: an MR/PR and the remote-tracking ref of its source branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RefMr {
    /// `refs/remotes/<remote>/<branch>`.
    pub remote_ref: String,
    pub mr: ForgeMr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchMrs {
    pub kind: ForgeKind,
    pub remote: String,
    pub mrs: Vec<RefMr>,
    #[ts(type = "number")]
    pub fetched_at: i64,
    pub poll_interval_secs: Option<u32>,
}

/// `refs/remotes/<remote>/<branch>` → (remote, branch), with the longest remote name that fits
/// (a remote's name may hold a `/`).
pub fn split_remote_ref<'a>(full: &'a str, remotes: &[&str]) -> Option<(&'a str, &'a str)> {
    let rest = full.strip_prefix("refs/remotes/")?;
    remotes
        .iter()
        .filter(|r| rest.len() > r.len() + 1 && rest.starts_with(**r) && rest.as_bytes()[r.len()] == b'/')
        .max_by_key(|r| r.len())
        .map(|r| (&rest[..r.len()], &rest[r.len() + 1..]))
}

fn refuse(message: &str) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, message)
}

impl ForgeHub {
    /// The repository's target project. Without a target, the first remote with an account says
    /// why (its project wasn't found, its token was refused…); without one, `NO_TARGET`.
    pub async fn mr_target(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload]) -> Result<MrTarget, GbError> {
        let rp = self.repo_projects(store, remotes, false).await;
        let remote = rp.target.clone().or_else(|| rp.remotes.iter().find(|r| r.account.is_some()).map(|r| r.remote.clone())).ok_or_else(|| refuse(NO_TARGET))?;
        let (key, provider, project) = self.project_for_remote(store, remotes, &remote).await?;
        Ok(MrTarget { key, provider, project, remote })
    }

    pub async fn mr_list(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], filter: MrFilter) -> Result<MrList, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.open_mrs(&t.project, filter).await;
        self.record(&t.key, &r);
        let f = r?;
        Ok(MrList { kind: t.project.kind, remote: t.remote, project: t.project, filter, mrs: f.value, fetched_at: f.fetched_at, poll_interval_secs: f.poll_interval_secs })
    }

    /// The badges for `refs` (the local branches' upstreams, newest first) and for every open
    /// MR/PR whose source project is one of the repository's remotes.
    pub async fn branch_mrs(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], refs: &[String]) -> Result<BranchMrs, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let open = t.provider.open_mrs(&t.project, MrFilter::All).await;
        self.record(&t.key, &open);
        let open = open?;
        // The remotes on the target's host whose project is known: (remote, project path).
        let rp = self.repo_projects(store, remotes, false).await;
        let on_host: Vec<(String, String)> = rp.remotes.iter().filter_map(|r| r.project.as_ref().filter(|p| p.host == t.project.host).map(|p| (r.remote.clone(), p.path.clone()))).collect();
        let mut out: Vec<RefMr> = Vec::new();
        let mut covered: HashSet<String> = HashSet::new();
        for mr in &open.value {
            for (remote, _) in on_host.iter().filter(|(_, path)| *path == mr.source_project) {
                let remote_ref = format!("refs/remotes/{remote}/{}", mr.source_branch);
                covered.insert(remote_ref.clone());
                out.push(RefMr { remote_ref, mr: mr.clone() });
            }
        }
        let names: Vec<&str> = on_host.iter().map(|(r, _)| r.as_str()).collect();
        let wanted: Vec<(String, String, String)> = refs
            .iter()
            .filter(|r| !covered.contains(*r))
            .filter_map(|r| split_remote_ref(r, &names).map(|(remote, branch)| (r.clone(), remote.to_string(), branch.to_string())))
            .take(BRANCH_LOOKUPS)
            .collect();
        for (full, remote, branch) in wanted {
            let Some((_, path)) = on_host.iter().find(|(r, _)| *r == remote) else { continue };
            let source = SourceRef { project: path.clone(), branch };
            let found = t.provider.mr_for_branch(&t.project, &source).await;
            self.record(&t.key, &found);
            match found {
                Ok(f) => {
                    if let Some(mr) = f.value {
                        out.push(RefMr { remote_ref: full, mr });
                    }
                }
                // The account's trouble ends the poll; a branch the forge can't look up is skipped.
                Err(e) if matches!(e.kind, GbErrorKind::AuthFailed | GbErrorKind::Network | GbErrorKind::RateLimited) => return Err(e),
                Err(_) => {}
            }
        }
        Ok(BranchMrs { kind: t.project.kind, remote: t.remote, mrs: out, fetched_at: open.fetched_at, poll_interval_secs: open.poll_interval_secs })
    }

    pub async fn mr_detail(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<Fresh<ForgeMrDetail>, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.mr_detail(&t.project, number).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn mr_discussions(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<Fresh<Vec<ForgeDiscussion>>, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.discussions(&t.project, number).await;
        self.record(&t.key, &r);
        r
    }

    /// A project on the target's forge by path (an MR's fork, to add it as a remote).
    pub async fn project_by_path(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], path: &str) -> Result<ForgeProject, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.project(path).await;
        self.record(&t.key, &r);
        Ok(r?.value)
    }

    pub async fn reply(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, note: NewNote) -> Result<ForgeNote, GbError> {
        if note.body.trim().is_empty() {
            return Err(refuse("Write a reply first"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.reply(&t.project, number, &note).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn approve(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<(), GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.approve(&t.project, number).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn request_changes(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, body: String) -> Result<(), GbError> {
        if body.trim().is_empty() {
            return Err(refuse("Say what to change first"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.request_changes(&t.project, number, &body).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn merge(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, opts: MergeOptions) -> Result<ForgeMr, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.merge(&t.project, number, &opts).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn edit_mr(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, edit: MrEdit) -> Result<ForgeMr, GbError> {
        if edit.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return Err(refuse("The title can't be empty"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.edit(&t.project, number, &edit).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn set_draft(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, draft: bool) -> Result<ForgeMr, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.set_draft(&t.project, number, draft).await;
        self.record(&t.key, &r);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::fake::*;
    use crate::forge::TokenStorage;
    use crate::redact::Secret;
    use crate::remotes::HostKind;

    const TOKEN: &str = "glpat-FAKE-test-token";
    const HOST: &str = "gitlab.example.com";
    const NOW_MS: i64 = 1_791_115_200_000;

    fn remote(name: &str, path: &str) -> RemotePayload {
        RemotePayload { name: name.into(), host: Some(HOST.into()), path: Some(path.into()), host_kind: HostKind::GitLab }
    }

    /// An account on HOST; origin is `group/project` (the target), `alice` is alice's fork.
    async fn setup() -> (Arc<FakeProvider>, ForgeHub, Arc<SettingsStore>, Vec<RemotePayload>) {
        let p = FakeProvider::new(ForgeKind::GitLab, HOST);
        p.projects.lock().unwrap().insert("group/project".into(), project(HOST, "group/project", None, 200));
        p.projects.lock().unwrap().insert("alice/project".into(), project(HOST, "alice/project", Some("group/project"), 100));
        let conn = Arc::new(FakeConnector::default());
        let p = conn.add(TOKEN, p);
        let hub = ForgeHub::new(conn, MemTokens::new(TokenStorage::Keyring), Arc::new(|| NOW_MS));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        let remotes = vec![remote("origin", "group/project"), remote("alice", "alice/project"), RemotePayload { name: "backup".into(), host: None, path: None, host_kind: HostKind::Generic }];
        (p, hub, store, remotes)
    }

    #[test]
    fn a_remote_ref_splits_on_the_longest_remote_name() {
        assert_eq!(split_remote_ref("refs/remotes/origin/feature/x", &["origin", "or"]), Some(("origin", "feature/x")));
        assert_eq!(split_remote_ref("refs/remotes/team/a/dev", &["team", "team/a"]), Some(("team/a", "dev")));
        assert_eq!(split_remote_ref("refs/remotes/origin", &["origin"]), None);
        assert_eq!(split_remote_ref("refs/heads/main", &["origin"]), None);
    }

    #[tokio::test]
    async fn the_target_is_the_repos_target_remote_and_without_an_account_it_says_how_to_get_one() {
        let (_, hub, store, remotes) = setup().await;
        let t = hub.mr_target(&store, &remotes).await.unwrap();
        assert_eq!((t.remote.as_str(), t.project.path.as_str()), ("origin", "group/project"));
        let elsewhere = [RemotePayload { name: "origin".into(), host: Some("github.com".into()), path: Some("o/r".into()), host_kind: HostKind::GitHub }];
        let e = hub.mr_target(&store, &elsewhere).await.err().unwrap();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, NO_TARGET));
        let gone = [remote("origin", "nobody/nothing")];
        let e = hub.mr_target(&store, &gone).await.err().unwrap();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "Not found on gitlab.example.com"), "the account's remote says why");
    }

    #[tokio::test]
    async fn branch_mrs_map_open_mrs_to_remote_refs_and_look_up_only_the_rest() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().extend([
            mr(12, "group/project", "dev", MrState::Open),
            mr(14, "alice/project", "fix", MrState::Open),
            mr(9, "group/project", "old", MrState::Merged),
        ]);
        let refs = ["refs/remotes/origin/dev", "refs/remotes/origin/old", "refs/remotes/origin/none", "refs/remotes/backup/dev"].map(String::from);
        let b = hub.branch_mrs(&store, &remotes, &refs).await.unwrap();
        let got: Vec<(&str, u64)> = b.mrs.iter().map(|r| (r.remote_ref.as_str(), r.mr.number)).collect();
        assert_eq!(got, [("refs/remotes/origin/dev", 12), ("refs/remotes/alice/fix", 14), ("refs/remotes/origin/old", 9)]);
        assert_eq!((b.kind, b.remote.as_str(), b.poll_interval_secs), (ForgeKind::GitLab, "origin", Some(30)));
        let lookups: Vec<String> = p.calls().into_iter().filter(|c| c.starts_with("mr_for_branch")).collect();
        assert_eq!(lookups, ["mr_for_branch group/project old", "mr_for_branch group/project none"], "dev came with the open list; backup isn't on the forge");
    }

    #[tokio::test]
    async fn an_open_mr_from_an_unmapped_fork_gets_no_ref() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().push(mr(15, "bob/project", "fix", MrState::Open));
        let b = hub.branch_mrs(&store, &remotes, &[]).await.unwrap();
        assert!(b.mrs.is_empty(), "{:?}", b.mrs);
        assert_eq!(hub.mr_list(&store, &remotes, MrFilter::All).await.unwrap().mrs[0].number, 15, "the list still has it");
    }

    #[tokio::test]
    async fn lookups_are_capped() {
        let (p, hub, store, remotes) = setup().await;
        let refs: Vec<String> = (0..40).map(|i| format!("refs/remotes/origin/b{i}")).collect();
        hub.branch_mrs(&store, &remotes, &refs).await.unwrap();
        assert_eq!(p.calls().iter().filter(|c| c.starts_with("mr_for_branch")).count(), BRANCH_LOOKUPS);
    }

    #[tokio::test]
    async fn a_failing_list_fails_the_badges_and_marks_the_account() {
        let (p, hub, store, remotes) = setup().await;
        *p.mr_error.lock().unwrap() = Some(GbErrorKind::Network);
        let e = hub.branch_mrs(&store, &remotes, &[]).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Network);
        assert!(matches!(hub.accounts(&store)[0].status, crate::forge::accounts::AccountStatus::Unreachable { .. }));
    }

    #[tokio::test]
    async fn the_list_details_and_discussions_come_from_the_target_project() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().extend([mr(12, "group/project", "dev", MrState::Open), mr(5, "group/project", "x", MrState::Draft)]);
        let detail = ForgeMrDetail { mr: mr(12, "group/project", "dev", MrState::Open), description: "d".into(), reviewers: vec![], assignees: vec![], merge_status: MergeStatus::Mergeable, squash: None, delete_source_branch: None };
        p.details.lock().unwrap().insert(12, detail.clone());
        let list = hub.mr_list(&store, &remotes, MrFilter::Mine).await.unwrap();
        assert_eq!((list.filter, list.remote.as_str(), list.mrs.len(), list.fetched_at), (MrFilter::Mine, "origin", 2, 9));
        assert_eq!(hub.mr_detail(&store, &remotes, 12).await.unwrap().value, detail);
        assert!(hub.mr_discussions(&store, &remotes, 12).await.unwrap().value.is_empty());
        assert_eq!(hub.project_by_path(&store, &remotes, "alice/project").await.unwrap().fork_of.as_deref(), Some("group/project"));
        assert_eq!(hub.mr_detail(&store, &remotes, 99).await.unwrap_err().kind, GbErrorKind::NotFound);
    }

    #[tokio::test]
    async fn writes_refuse_empty_text_before_reaching_the_forge() {
        let (p, hub, store, remotes) = setup().await;
        let e = hub.reply(&store, &remotes, 12, NewNote { discussion: None, body: " \n".into() }).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "Write a reply first"));
        assert_eq!(hub.request_changes(&store, &remotes, 12, "  ".into()).await.unwrap_err().message, "Say what to change first");
        let edit = MrEdit { title: Some(" ".into()), description: None, labels: None };
        assert_eq!(hub.edit_mr(&store, &remotes, 12, edit).await.unwrap_err().message, "The title can't be empty");
        assert!(p.calls().iter().all(|c| !c.starts_with("reply") && !c.starts_with("request_changes") && !c.starts_with("edit")), "{:?}", p.calls());
    }

    #[tokio::test]
    async fn writes_reach_the_targets_provider() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().push(mr(12, "group/project", "dev", MrState::Open));
        let note = hub.reply(&store, &remotes, 12, NewNote { discussion: Some("d1".into()), body: "Thanks".into() }).await.unwrap();
        assert_eq!(note.body, "Thanks");
        hub.approve(&store, &remotes, 12).await.unwrap();
        hub.request_changes(&store, &remotes, 12, "Rename it".into()).await.unwrap();
        assert_eq!(hub.set_draft(&store, &remotes, 12, true).await.unwrap().state, MrState::Draft);
        let opts = MergeOptions { method: None, squash: Some(true), delete_source_branch: None, expected_sha: None };
        assert_eq!(hub.merge(&store, &remotes, 12, opts).await.unwrap().state, MrState::Merged);
        let calls = p.calls();
        for c in ["reply 12 Some(\"d1\") Thanks", "approve 12", "request_changes 12 Rename it", "set_draft 12 true", "merge 12 Some(true)"] {
            assert!(calls.iter().any(|x| x == c), "{c} in {calls:?}");
        }
    }
}
