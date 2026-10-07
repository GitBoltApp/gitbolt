//! Rewrite marks (spec #2 §12.3, ux round 2): a GitBolt write that rewrote a branch its push
//! target has (a rebase, an amend, Edit HEAD message) records the remote-tracking oid it
//! rewrote away from. A later Push that would be rejected force-pushes with that oid as the
//! lease, without asking: it overwrites only what the user had when they rewrote.
//!
//! One file per repository, in GitBolt's data dir next to the journals, never in `.git` or the
//! user's git config: `<data>/rewrites/<first 16 hex of sha256(canonical common dir)>.json`,
//! 0600 in a 0700 directory, written atomically under an `flock` on a sibling `.lock`. Marks are
//! a convenience: losing one (a corrupt file is read as empty) only means Push asks again.
//!
//! A mark stops applying when:
//! - the branch's tip is neither its rewrite's tip nor a descendant (an outside reset, an undo of
//!   the rewrite): committing more after a rebase keeps it;
//! - a push of the branch succeeds;
//! - the branch is deleted, or its push target changes.

use crate::error::{gix_err, GbError};
use crate::journal::RefMove;
use crate::write::is_ancestor;
use crate::write::refs::read_ref;
use crate::write::sync::{push_target, PushTarget};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// What rewrote the branch: the force push's toast and tooltip name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RewriteKind {
    Rebase,
    Amend,
}

/// The sidebar's view of a live mark: what rewrote the branch, and the remote a Push replaces
/// commits on (the push target's remote, by its real name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Rewritten {
    pub kind: RewriteKind,
    pub remote: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteMark {
    /// The local branch's short name.
    pub branch: String,
    pub remote: String,
    /// The branch on `remote` it pushes to.
    pub remote_branch: String,
    /// `refs/remotes/<remote>/<remote_branch>`.
    pub remote_ref: String,
    /// `remote_ref`'s oid when the branch was rewritten: the lease, whatever a fetch did since.
    pub lease_oid: String,
    /// The branch's tip right after the rewrite.
    pub new_tip: String,
    pub kind: RewriteKind,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Marks {
    version: u32,
    marks: Vec<RewriteMark>,
}

const VERSION: u32 = 1;

/// One repository's marks file.
pub(crate) struct RewriteStore {
    dir: PathBuf,
    path: PathBuf,
    lock: PathBuf,
}

impl RewriteStore {
    /// `common_dir`: the repository's common git dir (canonicalized here).
    pub(crate) fn new(data_dir: &Path, common_dir: &Path) -> Self {
        let common = crate::platform::fs::canonicalize(common_dir).unwrap_or_else(|_| common_dir.to_path_buf());
        let name = &crate::journal::JournalStore::hex(&Sha256::digest(common.as_os_str().as_encoded_bytes()))[..16];
        let dir = data_dir.join("rewrites");
        Self { path: dir.join(format!("{name}.json")), lock: dir.join(format!("{name}.lock")), dir }
    }

    /// No lock and no directory created: a read (the sidebar) never writes.
    pub(crate) fn peek(&self) -> Vec<RewriteMark> {
        std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice::<Marks>(&b).ok()).map(|m| m.marks).unwrap_or_default()
    }

    /// Runs `f` on the marks under the lock; writes them back only if `f` changed them.
    pub(crate) fn update<T>(&self, f: impl FnOnce(&mut Vec<RewriteMark>) -> T) -> Result<T, GbError> {
        let _lock = self.locked()?;
        let mut marks = match std::fs::read(&self.path) {
            Ok(b) => serde_json::from_slice::<Marks>(&b).map(|m| m.marks).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let before = marks.clone();
        let out = f(&mut marks);
        if marks != before {
            let bytes = serde_json::to_vec_pretty(&Marks { version: VERSION, marks }).map_err(|e| GbError::other(format!("rewrite marks: {e}")))?;
            crate::journal::write_private(&self.path, &bytes)?;
        }
        Ok(out)
    }

    fn locked(&self) -> Result<std::fs::File, GbError> {
        let data = self.dir.parent().ok_or_else(|| GbError::other("rewrites dir has no parent"))?;
        if let Some(parent) = data.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::paths::private_dir(data)?;
        crate::paths::private_dir(&self.dir)?;
        crate::journal::lock_exclusive(&self.lock)
    }
}

fn oid(hex: &str) -> Option<gix::ObjectId> {
    gix::ObjectId::from_hex(hex.as_bytes()).ok()
}

fn tracking(t: &PushTarget) -> String {
    format!("refs/remotes/{}/{}", t.remote, t.branch)
}

/// The mark still applies to a branch at `tip`: it's the rewrite's tip or a descendant.
fn live_at(repo: &gix::Repository, mark: &RewriteMark, tip: Option<&str>) -> bool {
    match (oid(&mark.new_tip), tip.and_then(oid)) {
        (Some(new), Some(tip)) => is_ancestor(repo, new, tip),
        _ => false,
    }
}

/// Its push target is still the one it was recorded for.
fn same_target(repo: &gix::Repository, mark: &RewriteMark) -> bool {
    push_target(repo, &mark.branch).is_some_and(|t| t.remote == mark.remote && t.branch == mark.remote_branch)
}

/// `old → new` rewrote history (it isn't a fast-forward).
fn rewrote(repo: &gix::Repository, old: gix::ObjectId, new: gix::ObjectId) -> bool {
    old != new && !is_ancestor(repo, old, new)
}

/// `branch` is `remote`'s default branch: what `refs/remotes/<remote>/HEAD` names, or (with no
/// such ref) `main`, `master` or `trunk`. A force there is never silent.
pub(crate) fn is_default_branch(repo: &gix::Repository, remote: &str, branch: &str) -> bool {
    let head = format!("refs/remotes/{remote}/HEAD");
    let named = repo.try_find_reference(head.as_str()).ok().flatten().and_then(|r| r.target().try_name().map(|n| n.as_bstr().to_string()));
    match named {
        Some(full) => full.strip_prefix(&format!("refs/remotes/{remote}/")) == Some(branch),
        None => ["main", "master", "trunk"].contains(&branch),
    }
}

/// Every commit the rewrite replaces (on the remote: `new..lease`; locally: `new..old`) is the
/// user's own, by author email: someone else's work is never forced away without asking.
fn all_mine(repo: &gix::Repository, me: &str, lease: gix::ObjectId, old: gix::ObjectId, new: gix::ObjectId) -> bool {
    let Ok(walk) = repo.rev_walk([lease, old]).with_hidden([new]).all() else { return false };
    for info in walk {
        let Some(c) = info.ok().and_then(|i| repo.find_commit(i.id).ok()) else { return false };
        let Ok(a) = c.author() else { return false };
        if !a.email.to_string().eq_ignore_ascii_case(me) {
            return false;
        }
    }
    true
}

/// After a write moved `moves` (`kind`: the write rewrites, and succeeded; `me`: the author email
/// git commits with): records a mark for each branch it rewrote whose push target's
/// remote-tracking ref the rewrite left behind, and drops each moved branch's mark that no longer
/// applies.
///
/// A mark is recorded only when (review round 1):
/// - the remote-tracking ref was part of the branch before the rewrite (an ancestor of its old
///   tip): commits on the remote the user never had are never leased away;
/// - every commit it replaces, on the remote or locally, has the user's author email;
/// - the branch isn't the remote's default branch.
///
/// A branch rewritten again while its mark is live keeps the first lease: the remote state from
/// before the first rewrite.
pub(crate) fn after_write(repo: &gix::Repository, marks: &mut Vec<RewriteMark>, kind: Option<RewriteKind>, me: Option<&str>, moves: &[RefMove]) {
    for m in moves {
        let Some(branch) = m.name.strip_prefix("refs/heads/") else { continue };
        let at = marks.iter().position(|x| x.branch == branch);
        let rewrite = kind.zip(m.old.as_deref().and_then(oid)).zip(m.new.as_deref().and_then(oid)).filter(|((_, old), new)| rewrote(repo, *old, *new));
        let Some(((kind, old), new)) = rewrite else {
            if let Some(i) = at
                && !live_at(repo, &marks[i], m.new.as_deref())
            {
                marks.remove(i);
            }
            continue;
        };
        let lease = at.filter(|&i| live_at(repo, &marks[i], m.old.as_deref()) && same_target(repo, &marks[i])).and_then(|i| oid(&marks[i].lease_oid));
        if let Some(i) = at {
            marks.remove(i);
        }
        let Some(t) = push_target(repo, branch) else { continue };
        let remote_ref = tracking(&t);
        let Some(lease) = lease.or_else(|| read_ref(repo, &remote_ref).ok().flatten().and_then(|h| oid(&h)).filter(|l| is_ancestor(repo, *l, old))) else { continue };
        // An identity with no email matches nothing: an empty author email isn't the user's.
        let Some(me) = me.filter(|m| !m.trim().is_empty()) else { continue };
        if !is_ancestor(repo, lease, new) && !is_default_branch(repo, &t.remote, &t.branch) && all_mine(repo, me, lease, old, new) {
            marks.push(RewriteMark { branch: branch.to_string(), remote: t.remote, remote_branch: t.branch, remote_ref, lease_oid: lease.to_string(), new_tip: new.to_string(), kind });
        }
    }
}

/// `after_write` on the repository's file; a failure is logged, never the write's.
pub(crate) async fn record(api: &crate::api::Api, common_dir: &Path, root: &Path, kind: Option<RewriteKind>, moves: &[RefMove]) {
    if !moves.iter().any(|m| m.name.starts_with("refs/heads/")) {
        return;
    }
    let store = RewriteStore::new(&api.data_dir, common_dir);
    // Nothing to drop and nothing to record: no file is created.
    if kind.is_none() && store.peek().is_empty() {
        return;
    }
    // Who the user commits as (the commit box's identity read): only their own commits are forced away.
    // Only a branch with a push target can get a mark: no `git var` for the rest.
    let targeted = || gix::open(root).is_ok_and(|repo| moves.iter().filter_map(|m| m.name.strip_prefix("refs/heads/")).any(|b| push_target(&repo, b).is_some()));
    let me = match kind {
        Some(_) if targeted() => crate::write::commit::identity(&api.cli, root).await.ok().flatten().map(|i| i.email).filter(|e| !e.trim().is_empty()),
        _ => None,
    };
    let (root, moves) = (root.to_path_buf(), moves.to_vec());
    let res = crate::api::blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        store.update(|marks| after_write(&repo, marks, kind, me.as_deref(), &moves))
    })
    .await;
    if let Err(e) = res {
        tracing::warn!(target: "gitbolt_core::write", "rewrite marks: {e}");
    }
}

/// Push's lease for `branch` to `target`, with the tip it checked, if it has a live mark and a
/// plain push would be rejected (its tip doesn't contain the remote-tracking ref). A dead mark is
/// dropped here.
pub(crate) fn lease_for(data_dir: &Path, common_dir: &Path, repo: &gix::Repository, branch: &str, target: &PushTarget) -> Result<Option<(RewriteMark, gix::ObjectId)>, GbError> {
    let store = RewriteStore::new(data_dir, common_dir);
    if !store.peek().iter().any(|m| m.branch == branch) {
        return Ok(None);
    }
    let tip = read_ref(repo, &format!("refs/heads/{branch}"))?;
    let mark = store.update(|marks| {
        let i = marks.iter().position(|m| m.branch == branch)?;
        if !live_at(repo, &marks[i], tip.as_deref()) || !same_target(repo, &marks[i]) {
            marks.remove(i);
            return None;
        }
        Some(marks[i].clone())
    })?;
    let Some(mark) = mark.filter(|m| m.remote == target.remote && m.remote_branch == target.branch) else { return Ok(None) };
    let theirs = read_ref(repo, &mark.remote_ref)?.and_then(|h| oid(&h));
    let ours = tip.as_deref().and_then(oid);
    Ok(match (theirs, ours) {
        (Some(theirs), Some(ours)) if !is_ancestor(repo, theirs, ours) => Some((mark, ours)),
        _ => None,
    })
}

/// A push of `branch` succeeded: its mark is spent.
pub(crate) fn pushed(data_dir: &Path, common_dir: &Path, branch: &str) {
    let store = RewriteStore::new(data_dir, common_dir);
    if !store.peek().iter().any(|m| m.branch == branch) {
        return;
    }
    if let Err(e) = store.update(|marks| marks.retain(|m| m.branch != branch)) {
        tracing::warn!(target: "gitbolt_core::write", "rewrite marks: {e}");
    }
}

/// The sidebar's `rewritten`: each local branch's live mark for its current push target, while
/// the remote-tracking ref is still the lease (moved by a fetch, the push would be refused, so
/// the tooltip doesn't promise a force). A mark seen dead (the tip left the rewrite, the push
/// target changed) is dropped, rechecked under the file's lock, so it can't come back later.
pub(crate) fn annotate(data_dir: &Path, common_dir: &Path, repo: &gix::Repository, locals: &mut [crate::shelldata::LocalBranch]) {
    let store = RewriteStore::new(data_dir, common_dir);
    let marks = store.peek();
    if marks.is_empty() {
        return;
    }
    let tip_of = |name: &str| read_ref(repo, &format!("refs/heads/{name}")).ok().flatten();
    let dead = |m: &RewriteMark| !live_at(repo, m, tip_of(&m.branch).as_deref()) || !same_target(repo, m);
    for b in locals.iter_mut() {
        b.rewritten = marks
            .iter()
            .find(|m| m.branch == b.name && !dead(m) && read_ref(repo, &m.remote_ref).ok().flatten().as_deref() == Some(m.lease_oid.as_str()))
            .map(|m| Rewritten { kind: m.kind, remote: m.remote.clone() });
    }
    if marks.iter().any(dead)
        && let Err(e) = store.update(|marks| marks.retain(|m| !dead(m)))
    {
        tracing::warn!(target: "gitbolt_core::write", "rewrite marks: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};

    /// Review round 2: an identity with an empty email never matches commits whose author email
    /// is empty, so they're never forced away silently.
    #[test]
    fn an_empty_identity_email_records_no_mark() {
        let r = TestRepo::new();
        fixtures::sync(&r);
        r.switch_new("anon");
        r.git(&["commit", "-q", "--allow-empty", "--author=Nobody <>", "-m", "Anonymous"]);
        r.push("anon");
        let old = r.git(&["rev-parse", "anon"]);
        r.git(&["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
        let moves = [RefMove { name: "refs/heads/anon".into(), old: Some(old), new: Some(r.git(&["rev-parse", "anon"])) }];
        let repo = gix::open(r.path()).unwrap();
        let mut marks = Vec::new();
        for me in [Some(""), Some("  "), None] {
            after_write(&repo, &mut marks, Some(RewriteKind::Amend), me, &moves);
            assert!(marks.is_empty(), "{me:?}");
        }
        // The same rewrite by an identity that matches its author email does get one.
        r.git(&["commit", "-q", "--amend", "--allow-empty", "--no-edit", "--author=Ada Lovelace <ada@example.com>"]);
        r.git(&["push", "-q", "-f", "origin", "anon"]);
        let old = r.git(&["rev-parse", "anon"]);
        r.git(&["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
        let moves = [RefMove { name: "refs/heads/anon".into(), old: Some(old), new: Some(r.git(&["rev-parse", "anon"])) }];
        after_write(&gix::open(r.path()).unwrap(), &mut marks, Some(RewriteKind::Amend), Some("ada@example.com"), &moves);
        assert_eq!(marks.len(), 1);
    }
}
