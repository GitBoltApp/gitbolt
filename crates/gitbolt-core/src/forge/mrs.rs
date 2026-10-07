//! A repository's merge requests (spec #4 §3.3, §4 "4B"). Every call goes to the project the
//! repository's MRs/PRs target (4A's `RepoProjects.target`), through its account's provider, and
//! records what the answer says about the account (Settings › Accounts shows it):
//! - `branch_mrs`, the badges: one list of open MRs/PRs, mapped to the remote-tracking refs of the
//!   remotes their source projects are on, then a lookup in any state for each asked ref the list
//!   didn't cover (newest first, at most `BRANCH_LOOKUPS`), kept until the ref moves or the
//!   answer ages out (`forge::cache`); a ref that leaves the open list is asked at once. The target project's default branch
//!   and the stack base are never looked up in any state, and a merged or closed MR/PR badges a ref
//!   only while that ref's tip is still its head (`BadgeRefs`); the others go to `history`;
//! - `mr_list`, the sidebar section (Mine / Review requested / All);
//! - `mr_detail`, `mr_discussions`, the hover card and the MR/PR view;
//! - the writes (spec §3.5: remote actions, not journaled). Empty text is refused here, before
//!   the forge is asked.

use crate::error::{ErrorDetail, GbError, GbErrorKind};
use crate::forge::cache::{cache_key, RefLookup, StoredList};
use crate::forge::hub::ForgeHub;
use crate::forge::*;
use crate::payload::RemotePayload;
use crate::settings::SettingsStore;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use ts_rs::TS;

/// Refs the open list didn't cover, looked up one by one, at most this many per poll; their
/// answers are kept (`forge::cache`), so a steady poll asks none.
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
    /// The account's rate limit after this list (the poller paces on it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rate_limit: Option<RateLimitState>,
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
    /// The badges.
    pub mrs: Vec<RefMr>,
    /// Merged or closed MRs/PRs the lookups found whose ref moved on since (or whose tip isn't
    /// known: its branch is gone here): no badge, but 4D's stack walk and after-merge flow read
    /// them (a stack's merged bottom whose branch was deleted after the merge).
    pub history: Vec<RefMr>,
    #[ts(type = "number")]
    pub fetched_at: i64,
    pub poll_interval_secs: Option<u32>,
}

/// A filter's name in the cache's lists.
pub fn filter_name(f: MrFilter) -> &'static str {
    match f {
        MrFilter::All => "all",
        MrFilter::Mine => "mine",
        MrFilter::ReviewRequested => "reviewRequested",
    }
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

/// What the repository says about the refs the badges are for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BadgeRefs {
    /// A remote-tracking ref's current tip: its own commit, or when it's gone (its branch deleted
    /// after a merge), those of the local branches that track it or push to it.
    pub tips: HashMap<String, Vec<String>>,
    /// The stack base (spec #3 §3.11), `refs/remotes/<remote>/<branch>`: never looked up in any state.
    pub stack_base: Option<String>,
}

impl BadgeRefs {
    /// An open MR/PR badges its ref; a merged or closed one only while its head is that ref's tip.
    fn badges(&self, remote_ref: &str, mr: &ForgeMr) -> bool {
        if matches!(mr.state, MrState::Open | MrState::Draft) {
            return true;
        }
        let Some(head) = mr.head_sha.as_deref() else { return false };
        self.tips.get(remote_ref).is_some_and(|tips| tips.iter().any(|t| t.eq_ignore_ascii_case(head)))
    }
}

/// The trunk branches `stackBase` (ui/src/stacks/detect.ts) falls back to.
const TRUNKS: [&str; 3] = ["main", "master", "trunk"];

/// `BadgeRefs` for `asked` (the remote-tracking refs the badges are asked for), read from the repository.
pub fn badge_refs(repo: &gix::Repository, asked: &[String]) -> Result<BadgeRefs, GbError> {
    use crate::refs::RefKind;
    let rr = crate::refs::read_refs(repo)?;
    let remote_tips: HashMap<&str, String> = rr.refs.iter().filter(|r| matches!(r.kind, RefKind::Remote { .. })).map(|r| (r.full_name.as_str(), r.target.to_hex().to_string())).collect();
    let locals: Vec<&crate::refs::RefInfo> = rr.refs.iter().filter(|r| r.kind == RefKind::Local).collect();
    let mut tips = HashMap::new();
    for want in asked {
        let found = match remote_tips.get(want.as_str()) {
            Some(tip) => vec![tip.clone()],
            None => locals
                .iter()
                .filter(|l| {
                    l.upstream.as_deref() == Some(want.as_str())
                        || crate::write::sync::push_target(repo, &l.short_name).is_some_and(|t| format!("refs/remotes/{}/{}", t.remote, t.branch) == *want)
                })
                .map(|l| l.target.to_hex().to_string())
                .collect(),
        };
        tips.insert(want.clone(), found);
    }
    // `stackBase`: a remote's default branch, origin first; else `<remote>/main|master|trunk`.
    use gix::bstr::ByteSlice;
    let mut names: Vec<String> = repo.remote_names().into_iter().map(|n| n.to_str_lossy().into_owned()).collect();
    names.sort_by(|a, b| (a != "origin").cmp(&(b != "origin")).then_with(|| a.cmp(b)));
    let stack_base = names
        .iter()
        .find_map(|n| rr.remote_heads.get(n).filter(|d| remote_tips.contains_key(d.as_str())).cloned())
        .or_else(|| names.iter().find_map(|n| TRUNKS.iter().map(|b| format!("refs/remotes/{n}/{b}")).find(|r| remote_tips.contains_key(r.as_str()))));
    Ok(BadgeRefs { tips, stack_base })
}

/// The badges' placement, without a request: which refs the open list covers, which it doesn't
/// (`wanted`: their lookups in any state answer for them), and where each MR/PR goes.
struct BadgePlan {
    /// The open list's refs.
    covered: HashSet<String>,
    /// (ref, remote, branch) for each asked ref the open list doesn't cover, but the trunks.
    wanted: Vec<(String, String, String)>,
    on_host: Vec<(String, String)>,
}

impl BadgePlan {
    /// `on_host`: the remotes on the target's host whose project is known, (remote, project path).
    fn new(target: &ForgeProject, open: &[ForgeMr], on_host: &[(String, String)], refs: &[String], repo: &BadgeRefs) -> Self {
        // Never looked up in any state: the target project's default branch (on each remote of
        // that project) and the stack base. An open MR/PR from one still badges it (the open list:
        // a contributor's PR from their fork's `main`, which is their stack base).
        let mut trunks: HashSet<String> = repo.stack_base.iter().cloned().collect();
        if let Some(d) = &target.default_branch {
            trunks.extend(on_host.iter().filter(|(_, path)| *path == target.path).map(|(r, _)| format!("refs/remotes/{r}/{d}")));
        }
        let covered: HashSet<String> = open.iter().flat_map(|mr| on_host.iter().filter(|(_, path)| *path == mr.source_project).map(|(remote, _)| format!("refs/remotes/{remote}/{}", mr.source_branch))).collect();
        let names: Vec<&str> = on_host.iter().map(|(r, _)| r.as_str()).collect();
        let wanted = refs
            .iter()
            .filter(|r| !covered.contains(*r) && !trunks.contains(*r))
            .filter_map(|r| split_remote_ref(r, &names).map(|(remote, branch)| (r.clone(), remote.to_string(), branch.to_string())))
            .collect();
        Self { covered, wanted, on_host: on_host.to_vec() }
    }

    /// The badges and the history: the open list's, then the wanted refs' lookups.
    fn place(&self, open: &[ForgeMr], known: &std::collections::BTreeMap<String, RefLookup>, repo: &BadgeRefs) -> (Vec<RefMr>, Vec<RefMr>) {
        let (mut out, mut history) = (Vec::new(), Vec::new());
        let mut put = |remote_ref: String, mr: ForgeMr| {
            let to = if repo.badges(&remote_ref, &mr) { &mut out } else { &mut history };
            to.push(RefMr { remote_ref, mr });
        };
        for mr in open {
            for (remote, _) in self.on_host.iter().filter(|(_, path)| *path == mr.source_project) {
                put(format!("refs/remotes/{remote}/{}", mr.source_branch), mr.clone());
            }
        }
        for (full, _, _) in &self.wanted {
            if let Some(mr) = known.get(full).and_then(|l| l.mr.clone()) {
                put(full.clone(), mr);
            }
        }
        (out, history)
    }
}

/// What the last session saw (`ForgeHub::cached_mrs`): shown at once on launch, marked stale,
/// until the first poll revalidates it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CachedMrs {
    pub kind: ForgeKind,
    pub remote: String,
    pub project: ForgeProject,
    pub list: Option<MrList>,
    pub badges: Option<BranchMrs>,
    /// Unix seconds: when the oldest of them was read.
    #[ts(type = "number")]
    pub saved_at: i64,
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
        self.restore_responses(&key, &provider, &project);
        Ok(MrTarget { key, provider, project, remote })
    }

    /// The first use of a project this run: its provider gets the answers the last run kept, so
    /// its first requests are conditional (`If-None-Match`).
    fn restore_responses(&self, key: &AccountKey, provider: &Arc<dyn ForgeProvider>, project: &ForgeProject) {
        let ck = cache_key(key, &project.path);
        if self.restored.lock().expect("restored poisoned").insert(ck.clone()) {
            let entries = self.cache.with(&ck, |c| c.responses.clone());
            if !entries.is_empty() {
                provider.import_responses(entries);
            }
        }
    }

    /// The list for `filter` and the badges as the last session (or poll) left them, for the
    /// repository's target as it's chosen now: no request at all (projects, accounts and lists
    /// from the cache; `None` without them). The badges are placed for the refs' tips now.
    pub fn cached_mrs(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], refs: &[String], repo: &BadgeRefs, filter: MrFilter) -> Option<CachedMrs> {
        let profile = store.active_profile();
        let known = |r: &RemotePayload| -> Option<(AccountKey, ForgeProject)> {
            let account = crate::forge::hub::account_for(&profile.forge_accounts, r.host.as_deref()?)?;
            let key = Self::key(&profile.id, &account.host);
            let project = self.cache.with(&cache_key(&key, r.path.as_deref()?), |c| c.project.clone())?;
            Some((key, project))
        };
        let list: Vec<crate::forge::hub::RemoteProject> = remotes
            .iter()
            .map(|r| {
                let account = r.host.as_deref().and_then(|h| crate::forge::hub::account_for(&profile.forge_accounts, h)).map(|a| a.kind);
                crate::forge::hub::RemoteProject { remote: r.name.clone(), host: r.host.clone(), path: r.path.clone(), account, project: account.and_then(|_| known(r)).map(|(_, p)| p), error: None }
            })
            .collect();
        let remote = crate::forge::hub::target_remote(&list, remotes.iter().find(|r| r.main).map(|r| r.name.as_str()))?;
        let (key, project) = known(remotes.iter().find(|r| r.name == remote)?)?;
        let on_host: Vec<(String, String)> = list.iter().filter_map(|r| r.project.as_ref().filter(|p| p.host == project.host).map(|p| (r.remote.clone(), p.path.clone()))).collect();
        let ck = cache_key(&key, &project.path);
        let (stored, open, lookups, saved_at) = self.cache.with(&ck, |c| (c.lists.get(filter_name(filter)).cloned(), c.open.clone(), c.lookups.clone(), c.saved_at));
        if stored.is_none() && open.is_none() {
            return None;
        }
        let list = stored.map(|l| MrList { kind: project.kind, remote: remote.clone(), project: project.clone(), filter, mrs: l.mrs, fetched_at: l.fetched_at, poll_interval_secs: None, rate_limit: None });
        let badges = open.map(|o| {
            let plan = BadgePlan::new(&project, &o.mrs, &on_host, refs, repo);
            let (mrs, history) = plan.place(&o.mrs, &lookups, repo);
            BranchMrs { kind: project.kind, remote: remote.clone(), mrs, history, fetched_at: o.fetched_at, poll_interval_secs: None }
        });
        let oldest = list.iter().map(|l| l.fetched_at).chain(badges.iter().map(|b| b.fetched_at)).min().unwrap_or(saved_at);
        Some(CachedMrs { kind: project.kind, remote, project, list, badges, saved_at: oldest })
    }

    /// After a write to the target: what the cache keeps of its lists may predate it.
    fn wrote(&self, t: &MrTarget) {
        self.cache.forget_lists(&cache_key(&t.key, &t.project.path));
    }

    pub async fn mr_list(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], filter: MrFilter) -> Result<MrList, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.open_mrs(&t.project, filter).await;
        self.record(&t.key, &r);
        // Each poll ends with its list: what it cost, since the last one (no token: URLs only).
        let stats = t.provider.take_request_stats();
        let rate = t.provider.rate_limit();
        tracing::debug!(target: "gitbolt::forge::poll", host = %t.key.host, project = %t.project.path, requests = stats.sent, not_modified = stats.not_modified, from_memory = stats.fresh, rate_remaining = ?rate.remaining, rate_limit = ?rate.limit, ok = r.is_ok(), "forge poll");
        let f = r?;
        let key = cache_key(&t.key, &t.project.path);
        let responses = t.provider.export_responses(&t.project);
        self.cache.with(&key, |c| {
            c.lists.insert(filter_name(filter).to_string(), StoredList { mrs: f.value.clone(), fetched_at: f.fetched_at });
            c.project = Some(t.project.clone());
            c.responses = responses;
        });
        self.cache.save(&key);
        Ok(MrList { kind: t.project.kind, remote: t.remote, project: t.project, filter, mrs: f.value, fetched_at: f.fetched_at, poll_interval_secs: f.poll_interval_secs, rate_limit: Some(t.provider.rate_limit()) })
    }

    /// The badges for `refs` (the local branches' upstreams, newest first) and for every open
    /// MR/PR whose source project is one of the repository's remotes. The target project's
    /// default branch and the stack base are never looked up in any state (a long-lived branch's
    /// ancient MR/PR, say an old `main → legacy` one, is no badge); an open one from them still
    /// badges. A merged or closed MR/PR badges
    /// a ref only while that ref's tip (`repo`) is its head; else it goes to `history`.
    pub async fn branch_mrs(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], refs: &[String], repo: &BadgeRefs) -> Result<BranchMrs, GbError> {
        let t = self.mr_target(store, remotes).await?;
        // Without pipelines: a badge never shows one, and GitHub's checks are two requests per PR.
        let open = t.provider.open_mrs_light(&t.project, MrFilter::All).await;
        self.record(&t.key, &open);
        let open = open?;
        // The remotes on the target's host whose project is known: (remote, project path).
        let rp = self.repo_projects(store, remotes, false).await;
        let on_host: Vec<(String, String)> = rp.remotes.iter().filter_map(|r| r.project.as_ref().filter(|p| p.host == t.project.host).map(|p| (r.remote.clone(), p.path.clone()))).collect();
        let plan = BadgePlan::new(&t.project, &open.value, &on_host, refs, repo);
        // Asked: a ref the last open list badged and this one doesn't (just merged or closed),
        // then one never asked, moved since, or whose answer is too old (`RefLookup::fresh`).
        // Everything else answers from the cache: no request per branch per poll.
        let key = cache_key(&t.key, &t.project.path);
        let (was_open, mut known) = self.cache.with(&key, |c| (std::mem::take(&mut c.open_refs), std::mem::take(&mut c.lookups)));
        let now = self.now();
        let tips_of = |r: &str| repo.tips.get(r).cloned().unwrap_or_default();
        let mut ask: Vec<&(String, String, String)> = plan.wanted.iter().filter(|(full, _, _)| was_open.contains(full) || !known.get(full).is_some_and(|l| l.fresh(&tips_of(full), now))).collect();
        ask.sort_by_key(|(full, _, _)| !was_open.contains(full));
        ask.truncate(BRANCH_LOOKUPS);
        for (full, remote, branch) in ask {
            let Some((_, path)) = on_host.iter().find(|(r, _)| r == remote) else { continue };
            let source = SourceRef { project: path.clone(), branch: branch.clone() };
            let found = t.provider.mr_for_branch(&t.project, &source).await;
            self.record(&t.key, &found);
            match found {
                Ok(f) => {
                    known.insert(full.clone(), RefLookup { tips: tips_of(full), mr: f.value, at: now });
                }
                // A limit or a refused token ends the lookups (the list says so); the rest keep
                // what they had. One that timed out or failed is skipped: only that branch waits.
                Err(e) if matches!(e.kind, GbErrorKind::AuthFailed | GbErrorKind::RateLimited) => break,
                Err(e) => tracing::debug!("forge badges: {full}: {}", e.message),
            }
        }
        // Only the refs asked about now are kept (a deleted branch's lookup goes with it).
        let asked: HashSet<&String> = plan.wanted.iter().map(|(f, _, _)| f).collect();
        known.retain(|r, _| asked.contains(r));
        let (mrs, history) = plan.place(&open.value, &known, repo);
        let responses = t.provider.export_responses(&t.project);
        self.cache.with(&key, |c| {
            c.open_refs = plan.covered.into_iter().collect();
            c.lookups = known;
            c.open = Some(StoredList { mrs: open.value.clone(), fetched_at: open.fetched_at });
            c.project = Some(t.project.clone());
            c.responses = responses;
        });
        self.cache.save(&key);
        Ok(BranchMrs { kind: t.project.kind, remote: t.remote, mrs, history, fetched_at: open.fetched_at, poll_interval_secs: open.poll_interval_secs })
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
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    pub async fn approve(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<(), GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.approve(&t.project, number).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    pub async fn request_changes(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, body: String) -> Result<(), GbError> {
        if body.trim().is_empty() {
            return Err(refuse("Say what to change first"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.request_changes(&t.project, number, &body).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    pub async fn merge(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, opts: MergeOptions) -> Result<ForgeMr, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.merge(&t.project, number, &opts).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    // --- auto-merge ---
    /// Sets it to merge once its checks pass. No stack guard (`before_merge`): nothing merges
    /// now, and retargeting its dependents early would show them its commits.
    pub async fn set_auto_merge(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, opts: MergeOptions) -> Result<ForgeMr, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.set_auto_merge(&t.project, number, &opts).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    pub async fn cancel_auto_merge(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64) -> Result<ForgeMr, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.cancel_auto_merge(&t.project, number).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }
    // --- end auto-merge ---

    pub async fn edit_mr(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, edit: MrEdit) -> Result<ForgeMr, GbError> {
        if edit.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return Err(refuse("The title can't be empty"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.edit(&t.project, number, &edit).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        // --- MR round 2: the forge kept only one: so does the cached limit from now on ---
        if let Err(GbError { detail: Some(ErrorDetail::PeopleLimit { role }), .. }) = &r {
            let key = cache_key(&t.key, &t.project.path);
            let now = self.now();
            self.cache.with(&key, |c| {
                let mut l = c.people_limits.map_or_else(PeopleLimits::default, |(l, _)| l);
                if &**role == "reviewers" { l.max_reviewers = Some(1) } else { l.max_assignees = Some(1) }
                c.people_limits = Some((l, now));
            });
            self.cache.save(&key);
        }
        // --- end MR round 2 ---
        r
    }

    // --- MR round 2 ---
    /// A review from the composer. Request changes and Comment need a message; Approve doesn't.
    pub async fn review(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, review: ReviewSubmit) -> Result<ReviewOutcome, GbError> {
        if review.body.trim().is_empty() {
            match review.event {
                ReviewEvent::RequestChanges => return Err(refuse("Say what to change first")),
                ReviewEvent::Comment => return Err(refuse("Write a comment first")),
                ReviewEvent::Approve => {}
            }
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.review(&t.project, number, &review).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    /// `remote`'s project's people limits: from the forge cache (a day, across restarts), else
    /// asked (one small request) and kept.
    pub async fn people_limits(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], remote: &str) -> Result<PeopleLimits, GbError> {
        let (key, provider, project) = self.project_for_remote(store, remotes, remote).await?;
        let ck = cache_key(&key, &project.path);
        let now = self.now();
        if let Some((l, at)) = self.cache.with(&ck, |c| c.people_limits)
            && now.saturating_sub(at) < crate::forge::cache::PEOPLE_LIMITS_SECS
        {
            return Ok(l);
        }
        let r = provider.people_limits(&project).await;
        self.record(&key, &r);
        let l = r?;
        self.cache.with(&ck, |c| c.people_limits = Some((l, now)));
        self.cache.save(&ck);
        Ok(l)
    }

    /// Subscribes to the MR/PR's notifications, or unsubscribes; the state after.
    pub async fn set_subscribed(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, on: bool) -> Result<bool, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.set_subscribed(&t.project, number, on).await;
        self.record(&t.key, &r);
        r
    }
    // --- end MR round 2 ---

    // --- comment actions ---
    /// Adds or removes the token's user's reaction on a note; the note's reactions after.
    pub async fn react(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, note: NoteRef, name: String, on: bool) -> Result<Vec<ForgeReaction>, GbError> {
        if name.is_empty() || name.len() > 64 || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_+-".contains(&b)) {
            return Err(refuse("That isn't an emoji name"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.react(&t.project, number, &note, &name, on).await;
        self.record(&t.key, &r);
        r
    }

    pub async fn edit_note(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, note: NoteRef, body: String) -> Result<ForgeNote, GbError> {
        if body.trim().is_empty() {
            return Err(refuse("A comment can't be empty: delete it instead"));
        }
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.edit_note(&t.project, number, &note, &body).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    pub async fn delete_note(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, note: NoteRef) -> Result<(), GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.delete_note(&t.project, number, &note).await;
        self.record(&t.key, &r);
        if r.is_ok() {
            self.wrote(&t);
        }
        r
    }

    pub async fn resolve(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, discussion: String, resolved: bool) -> Result<ThreadState, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.resolve(&t.project, number, &discussion, resolved).await;
        self.record(&t.key, &r);
        r
    }
    // --- end comment actions ---

    pub async fn set_draft(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, draft: bool) -> Result<ForgeMr, GbError> {
        let t = self.mr_target(store, remotes).await?;
        let r = t.provider.set_draft(&t.project, number, draft).await;
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
    use crate::forge::fake::*;
    use crate::forge::TokenStorage;
    use crate::redact::Secret;
    use crate::remotes::HostKind;

    const TOKEN: &str = "glpat-FAKE-test-token";
    const HOST: &str = "gitlab.example.com";
    const NOW_MS: i64 = 1_791_115_200_000;

    fn remote(name: &str, path: &str) -> RemotePayload {
        RemotePayload { name: name.into(), host: Some(HOST.into()), path: Some(path.into()), host_kind: HostKind::GitLab, main: false }
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
        let remotes = vec![remote("origin", "group/project"), remote("alice", "alice/project"), RemotePayload { name: "backup".into(), host: None, path: None, host_kind: HostKind::Generic, main: false }];
        (p, hub, store, remotes)
    }

    // --- MR round 2 ---
    /// `setup`, with the clock at `now` and the cache in `dir`.
    async fn setup_at(now: i64, dir: &std::path::Path, limits: PeopleLimits) -> (Arc<FakeProvider>, ForgeHub, Arc<SettingsStore>, Vec<RemotePayload>) {
        let p = FakeProvider::new(ForgeKind::GitLab, HOST);
        p.projects.lock().unwrap().insert("group/project".into(), project(HOST, "group/project", None, 200));
        *p.limits.lock().unwrap() = limits;
        let conn = Arc::new(FakeConnector::default());
        let p = conn.add(TOKEN, p);
        let hub = ForgeHub::new(conn, MemTokens::new(TokenStorage::Keyring), Arc::new(move || now));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new(TOKEN)).await.unwrap();
        // After the account (adding one forgets its host's cache): as a relaunch, which adds none.
        hub.set_cache_dir(dir.to_path_buf());
        (p, hub, store, vec![remote("origin", "group/project")])
    }

    #[tokio::test]
    async fn people_limits_are_kept_a_day_across_restarts_per_project() {
        let dir = tempfile::tempdir().unwrap();
        let one = PeopleLimits { max_reviewers: Some(1), max_assignees: Some(1) };
        let asked = |p: &FakeProvider| p.calls().iter().filter(|c| c.starts_with("people_limits")).count();
        let (p, hub, store, remotes) = setup_at(NOW_MS, dir.path(), one).await;
        assert_eq!(hub.people_limits(&store, &remotes, "origin").await.unwrap(), one);
        assert_eq!(hub.people_limits(&store, &remotes, "origin").await.unwrap(), one);
        assert_eq!(asked(&p), 1, "asked once");
        // A restart an hour later: from the file.
        let (p, hub, store, remotes) = setup_at(NOW_MS + 3_600_000, dir.path(), PeopleLimits::default()).await;
        assert_eq!(hub.people_limits(&store, &remotes, "origin").await.unwrap(), one);
        assert_eq!(asked(&p), 0);
        // A day later: asked again.
        let (p, hub, store, remotes) = setup_at(NOW_MS + 24 * 3_600_000, dir.path(), PeopleLimits::default()).await;
        assert_eq!(hub.people_limits(&store, &remotes, "origin").await.unwrap(), PeopleLimits::default());
        assert_eq!(asked(&p), 1);
    }

    #[tokio::test]
    async fn a_write_the_forge_trimmed_to_one_sets_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let (p, hub, store, remotes) = setup_at(NOW_MS, dir.path(), PeopleLimits::default()).await;
        assert_eq!(hub.people_limits(&store, &remotes, "origin").await.unwrap(), PeopleLimits::default());
        p.mrs.lock().unwrap().push(mr(12, "group/project", "dev", MrState::Open));
        let trimmed = GbError::new(GbErrorKind::InvalidInput, "GitLab kept only Ada: this project allows one reviewer").with_detail(ErrorDetail::PeopleLimit { role: "reviewers".into() });
        *p.edit_error.lock().unwrap() = Some(trimmed);
        let edit = MrEdit { reviewers: Some(PeopleEdit { add: vec![2], remove: vec![] }), ..Default::default() };
        assert!(hub.edit_mr(&store, &remotes, 12, edit).await.is_err());
        assert_eq!(hub.people_limits(&store, &remotes, "origin").await.unwrap(), PeopleLimits { max_reviewers: Some(1), max_assignees: None });
    }

    #[tokio::test]
    async fn the_composer_needs_a_message_to_comment_or_request_changes_but_not_to_approve() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().push(mr(12, "group/project", "dev", MrState::Open));
        let review = |event, body: &str| ReviewSubmit { event, body: body.into() };
        assert_eq!(hub.review(&store, &remotes, 12, review(ReviewEvent::Comment, " ")).await.unwrap_err().message, "Write a comment first");
        assert_eq!(hub.review(&store, &remotes, 12, review(ReviewEvent::RequestChanges, "")).await.unwrap_err().message, "Say what to change first");
        hub.review(&store, &remotes, 12, review(ReviewEvent::Approve, "")).await.unwrap();
        hub.review(&store, &remotes, 12, review(ReviewEvent::Approve, "Nice")).await.unwrap();
        let calls = p.calls();
        assert_eq!(calls.iter().filter(|c| *c == "approve 12").count(), 2);
        assert!(calls.iter().any(|c| c == "reply 12 None Nice"), "{calls:?}");
    }
    // --- end MR round 2 ---

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
        let elsewhere = [RemotePayload { name: "origin".into(), host: Some("github.com".into()), path: Some("o/r".into()), host_kind: HostKind::GitHub, main: false }];
        let e = hub.mr_target(&store, &elsewhere).await.err().unwrap();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, NO_TARGET));
        let gone = [remote("origin", "nobody/nothing")];
        let e = hub.mr_target(&store, &gone).await.err().unwrap();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "Not found on gitlab.example.com"), "the account's remote says why");
    }

    #[tokio::test]
    async fn a_chosen_remote_whose_lookup_failed_is_the_target_and_its_error_surfaces() {
        let (_, hub, store, mut remotes) = setup().await;
        remotes.push(remote("lost", "nobody/nothing"));
        remotes.last_mut().unwrap().main = true;
        let rp = hub.repo_projects(&store, &remotes, false).await;
        assert_eq!(rp.target.as_deref(), Some("lost"));
        assert!(rp.target_chosen);
        let e = hub.mr_target(&store, &remotes).await.err().unwrap();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "Not found on gitlab.example.com"), "not another remote's project");
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
        let b = hub.branch_mrs(&store, &remotes, &refs, &tips(&[("refs/remotes/origin/old", 9)])).await.unwrap();
        let got: Vec<(&str, u64)> = b.mrs.iter().map(|r| (r.remote_ref.as_str(), r.mr.number)).collect();
        assert_eq!(got, [("refs/remotes/origin/dev", 12), ("refs/remotes/alice/fix", 14), ("refs/remotes/origin/old", 9)]);
        assert_eq!((b.kind, b.remote.as_str(), b.poll_interval_secs), (ForgeKind::GitLab, "origin", Some(30)));
        let lookups: Vec<String> = p.calls().into_iter().filter(|c| c.starts_with("mr_for_branch")).collect();
        assert_eq!(lookups, ["mr_for_branch group/project old", "mr_for_branch group/project none"], "dev came with the open list; backup isn't on the forge");
    }

    /// `BadgeRefs` whose refs are at the fake MRs' heads (`mr(n)`'s head is `n` as 40 digits).
    fn tips(at: &[(&str, u64)]) -> BadgeRefs {
        BadgeRefs { tips: at.iter().map(|(r, n)| (r.to_string(), vec![format!("{n:040}")])).collect(), stack_base: None }
    }

    fn got(rs: &[RefMr]) -> Vec<(&str, u64)> {
        rs.iter().map(|r| (r.remote_ref.as_str(), r.mr.number)).collect()
    }

    fn lookups(p: &FakeProvider) -> Vec<String> {
        p.calls().into_iter().filter(|c| c.starts_with("mr_for_branch")).collect()
    }

    #[tokio::test]
    async fn the_default_branch_is_never_looked_up_and_only_an_open_mr_from_it_badges() {
        let (p, hub, store, remotes) = setup().await;
        // An ancient closed one from the default branch to another.
        let mut old = mr(812, "group/project", "main", MrState::Closed);
        old.target_branch = "legacy".into();
        p.mrs.lock().unwrap().push(old);
        let refs = ["refs/remotes/origin/main", "refs/remotes/origin/dev"].map(String::from);
        let b = hub.branch_mrs(&store, &remotes, &refs, &tips(&[("refs/remotes/origin/main", 812)])).await.unwrap();
        assert!(b.mrs.is_empty() && b.history.is_empty(), "{:?} {:?}", b.mrs, b.history);
        assert_eq!(lookups(&p), ["mr_for_branch group/project dev"], "one request fewer: main isn't asked about");
        // An open one from it is open: the open list badges it.
        let mut open = mr(813, "group/project", "main", MrState::Open);
        open.target_branch = "release".into();
        p.mrs.lock().unwrap().push(open);
        let b = hub.branch_mrs(&store, &remotes, &refs, &BadgeRefs::default()).await.unwrap();
        assert_eq!(got(&b.mrs), [("refs/remotes/origin/main", 813)]);
    }

    #[tokio::test]
    async fn the_stack_base_is_never_looked_up() {
        let (p, hub, store, remotes) = setup().await;
        let mut closed = mr(40, "group/project", "develop", MrState::Closed);
        closed.head_sha = Some(format!("{:040}", 40));
        p.mrs.lock().unwrap().push(closed);
        let base = BadgeRefs { stack_base: Some("refs/remotes/origin/develop".into()), ..tips(&[("refs/remotes/origin/develop", 40)]) };
        let refs = ["refs/remotes/origin/develop", "refs/remotes/origin/dev"].map(String::from);
        let b = hub.branch_mrs(&store, &remotes, &refs, &base).await.unwrap();
        assert!(b.mrs.is_empty() && b.history.is_empty(), "{:?}", b.mrs);
        assert_eq!(lookups(&p), ["mr_for_branch group/project dev"]);
    }

    #[tokio::test]
    async fn an_open_pr_from_a_contributors_fork_main_badges_it_though_it_is_their_stack_base() {
        let (p, hub, store, remotes) = setup().await;
        // `alice` is the user's fork (their stack base `alice/main`), `origin` the target.
        p.mrs.lock().unwrap().push(mr(31, "alice/project", "main", MrState::Open));
        let base = BadgeRefs { stack_base: Some("refs/remotes/alice/main".into()), ..tips(&[]) };
        let b = hub.branch_mrs(&store, &remotes, &["refs/remotes/alice/main".to_string()], &base).await.unwrap();
        assert_eq!(got(&b.mrs), [("refs/remotes/alice/main", 31)]);
        assert!(lookups(&p).is_empty(), "the open list covered it");
    }

    #[tokio::test]
    async fn a_merged_or_closed_mr_badges_only_while_its_head_is_the_tip() {
        let (p, hub, store, remotes) = setup().await;
        let mut closed = mr(7, "group/project", "develop", MrState::Closed);
        closed.target_branch = "legacy".into();
        p.mrs.lock().unwrap().extend([mr(9, "group/project", "done", MrState::Merged), closed, mr(11, "group/project", "gone", MrState::Merged)]);
        let refs = ["refs/remotes/origin/done", "refs/remotes/origin/develop", "refs/remotes/origin/gone"].map(String::from);
        // `done` is at the merged head; `develop` moved on long ago; `gone`'s tip isn't known.
        let mut at = tips(&[("refs/remotes/origin/done", 9), ("refs/remotes/origin/develop", 99)]);
        let b = hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert_eq!(got(&b.mrs), [("refs/remotes/origin/done", 9)]);
        assert_eq!(got(&b.history), [("refs/remotes/origin/develop", 7), ("refs/remotes/origin/gone", 11)], "kept for the stacks, without a badge");
        // The branch moved on after the merge (new work pushed to it): no badge any more.
        at.tips.insert("refs/remotes/origin/done".into(), vec![format!("{:040}", 10)]);
        let b = hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert!(b.mrs.is_empty(), "{:?}", b.mrs);
        // Without a head, a merged one never badges.
        let mut headless = mr(9, "group/project", "done", MrState::Merged);
        headless.head_sha = None;
        *p.mrs.lock().unwrap() = vec![headless];
        let b = hub.branch_mrs(&store, &remotes, &refs[..1], &tips(&[("refs/remotes/origin/done", 9)])).await.unwrap();
        assert!(b.mrs.is_empty() && b.history.len() == 1);
    }

    #[test]
    fn badge_refs_reads_tips_the_tracking_branches_of_gone_refs_and_the_stack_base() {
        let r = crate::testing::TestRepo::new();
        r.commit("one");
        r.add_origin();
        r.push("main");
        r.switch_new("done");
        let done = r.commit("two");
        r.push("done");
        r.switch_new("moved");
        let moved_local = r.commit("three");
        r.push("moved");
        let moved_remote = r.commit("four");
        r.git(&["push", "-q", "origin", "moved"]);
        r.git(&["reset", "-q", "--hard", &moved_local]);
        // `done` was deleted on the remote after its merge and pruned here.
        r.git(&["update-ref", "-d", "refs/remotes/origin/done"]);
        let repo = gix::open(r.path()).unwrap();
        let asked = ["refs/remotes/origin/done", "refs/remotes/origin/moved", "refs/remotes/origin/nothing"].map(String::from);
        let b = badge_refs(&repo, &asked).unwrap();
        assert_eq!(b.tips["refs/remotes/origin/done"], std::slice::from_ref(&done), "the local branch tracking it");
        assert_eq!(b.tips["refs/remotes/origin/moved"], [moved_remote], "the ref's own tip, not the local branch's");
        assert!(b.tips["refs/remotes/origin/nothing"].is_empty());
        assert_eq!(b.stack_base.as_deref(), Some("refs/remotes/origin/main"), "origin's main, without a HEAD");
        r.git(&["update-ref", "refs/remotes/origin/develop", &done]);
        r.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
        assert_eq!(badge_refs(&gix::open(r.path()).unwrap(), &[]).unwrap().stack_base.as_deref(), Some("refs/remotes/origin/develop"), "origin's HEAD first");
    }

    #[tokio::test]
    async fn an_open_mr_from_an_unmapped_fork_gets_no_ref() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().push(mr(15, "bob/project", "fix", MrState::Open));
        let b = hub.branch_mrs(&store, &remotes, &[], &BadgeRefs::default()).await.unwrap();
        assert!(b.mrs.is_empty(), "{:?}", b.mrs);
        assert_eq!(hub.mr_list(&store, &remotes, MrFilter::All).await.unwrap().mrs[0].number, 15, "the list still has it");
    }

    #[tokio::test]
    async fn lookups_are_capped() {
        let (p, hub, store, remotes) = setup().await;
        let refs: Vec<String> = (0..40).map(|i| format!("refs/remotes/origin/b{i}")).collect();
        hub.branch_mrs(&store, &remotes, &refs, &BadgeRefs::default()).await.unwrap();
        assert_eq!(p.calls().iter().filter(|c| c.starts_with("mr_for_branch")).count(), BRANCH_LOOKUPS);
    }

    #[tokio::test]
    async fn a_steady_poll_asks_no_branch_and_a_ref_that_leaves_the_open_list_is_asked_at_once() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().extend([mr(12, "group/project", "dev", MrState::Open), mr(9, "group/project", "old", MrState::Merged)]);
        let refs = ["refs/remotes/origin/dev", "refs/remotes/origin/old", "refs/remotes/origin/none"].map(String::from);
        let at = tips(&[("refs/remotes/origin/old", 9), ("refs/remotes/origin/dev", 12)]);
        hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert_eq!(lookups(&p), ["mr_for_branch group/project old", "mr_for_branch group/project none"]);
        p.calls.lock().unwrap().clear();
        let b = hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert!(lookups(&p).is_empty(), "nothing changed: the answers are kept");
        assert_eq!(got(&b.mrs), [("refs/remotes/origin/dev", 12), ("refs/remotes/origin/old", 9)], "and still badge");
        // dev's MR is merged: it leaves the open list, and dev is asked about at once.
        p.mrs.lock().unwrap()[0].state = MrState::Merged;
        let b = hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert_eq!(lookups(&p), ["mr_for_branch group/project dev"]);
        assert_eq!(got(&b.mrs), [("refs/remotes/origin/dev", 12), ("refs/remotes/origin/old", 9)]);
        assert_eq!(b.mrs[0].mr.state, MrState::Merged);
        // A ref that moved is asked again.
        p.calls.lock().unwrap().clear();
        hub.branch_mrs(&store, &remotes, &refs, &tips(&[("refs/remotes/origin/old", 10), ("refs/remotes/origin/dev", 12)])).await.unwrap();
        assert_eq!(lookups(&p), ["mr_for_branch group/project old"]);
    }

    #[tokio::test]
    async fn a_lookup_that_times_out_skips_only_its_branch() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().extend([mr(9, "group/project", "old", MrState::Merged), mr(8, "group/project", "slow", MrState::Merged)]);
        p.lookup_errors.lock().unwrap().insert("slow".into(), GbErrorKind::Network);
        let refs = ["refs/remotes/origin/slow", "refs/remotes/origin/old"].map(String::from);
        let at = tips(&[("refs/remotes/origin/old", 9), ("refs/remotes/origin/slow", 8)]);
        let b = hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert_eq!(got(&b.mrs), [("refs/remotes/origin/old", 9)]);
        // Next poll asks only the one that failed.
        p.lookup_errors.lock().unwrap().clear();
        p.calls.lock().unwrap().clear();
        let b = hub.branch_mrs(&store, &remotes, &refs, &at).await.unwrap();
        assert_eq!(lookups(&p), ["mr_for_branch group/project slow"]);
        assert_eq!(got(&b.mrs), [("refs/remotes/origin/slow", 8), ("refs/remotes/origin/old", 9)]);
    }

    #[tokio::test]
    async fn a_failing_list_fails_the_badges_and_marks_the_account() {
        let (p, hub, store, remotes) = setup().await;
        *p.mr_error.lock().unwrap() = Some(GbErrorKind::Network);
        let e = hub.branch_mrs(&store, &remotes, &[], &BadgeRefs::default()).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Network);
        assert!(matches!(hub.accounts(&store)[0].status, crate::forge::accounts::AccountStatus::Unreachable { .. }));
    }

    #[tokio::test]
    async fn the_list_details_and_discussions_come_from_the_target_project() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().extend([mr(12, "group/project", "dev", MrState::Open), mr(5, "group/project", "x", MrState::Draft)]);
        let detail = ForgeMrDetail { mr: mr(12, "group/project", "dev", MrState::Open), description: "d".into(), reviewers: vec![], assignees: vec![], merge_status: MergeStatus::Mergeable, squash: None, delete_source_branch: None, body_html: None, base_sha: None, subscribed: None };
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
        let edit = MrEdit { title: Some(" ".into()), description: None, labels: None, ..Default::default() };
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
        let opts = MergeOptions { squash: Some(true), ..Default::default() };
        assert_eq!(hub.merge(&store, &remotes, 12, opts).await.unwrap().state, MrState::Merged);
        let calls = p.calls();
        for c in ["reply 12 Some(\"d1\") Thanks", "approve 12", "request_changes 12 Rename it", "set_draft 12 true", "merge 12 Some(true)"] {
            assert!(calls.iter().any(|x| x == c), "{c} in {calls:?}");
        }
    }

    #[tokio::test]
    async fn auto_merge_is_set_and_cancelled_on_the_targets_provider() {
        let (p, hub, store, remotes) = setup().await;
        p.mrs.lock().unwrap().push(mr(12, "group/project", "dev", MrState::Open));
        let opts = MergeOptions { method: Some(MergeMethod::Squash), ..Default::default() };
        let set = hub.set_auto_merge(&store, &remotes, 12, opts).await.unwrap();
        assert_eq!((set.state, set.auto_merge.and_then(|a| a.enabled_by).map(|u| u.username)), (MrState::Open, Some(p.user.username.clone())));
        assert_eq!(hub.cancel_auto_merge(&store, &remotes, 12).await.unwrap().auto_merge, None);
        let calls = p.calls();
        for c in ["set_auto_merge 12 Some(Squash)", "cancel_auto_merge 12"] {
            assert!(calls.iter().any(|x| x == c), "{c} in {calls:?}");
        }
        assert!(!calls.iter().any(|c| c.starts_with("open_mrs_targeting") || c.starts_with("retarget")), "no stack guard: nothing merges now");
    }
}
