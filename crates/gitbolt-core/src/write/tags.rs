//! Tags (spec #3 §3.9).
//! - Create: lightweight, a CAS of `refs/tags/<t>`; annotated, `git tag -a -F -` (it signs per
//!   `tag.gpgSign`). Journaled (MoveRefs): Undo deletes it, Redo puts the same object back.
//! - Delete: local, a CAS (MoveRefs); remote, `git push <remote> :refs/tags/<t>` (a Barrier);
//!   Both: the remote first, then the local tag, as 2C's branch delete does.
//! - Push: one tag (`refs/tags/<t>:refs/tags/<t>`) or every tag (`--tags`) to a remote: a Barrier.
//!   Never `--force`: a tag the remote has differently is refused.

use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{RefMove, UndoKind};
use crate::write::names::tag_name_error;
use crate::write::remote_output::{self, RemoteSummary};
use crate::write::{Plan, Pre, Staging, WriteCx, WriteIntent};
use serde::Serialize;
use ts_rs::TS;

fn tag_ref(name: &str) -> String {
    format!("refs/tags/{name}")
}

pub(crate) struct CreateTag {
    pub name: String,
    /// The commit it names (full oid).
    pub target: String,
    /// `Some`: an annotated tag with this message.
    pub message: Option<String>,
}

impl WriteIntent for CreateTag {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("create tag {}", self.name)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    /// An annotated tag may sign (no timeout while a pinentry waits).
    fn runs_hooks(&self) -> bool {
        self.message.is_some()
    }
    /// A tag leaves the index alone: the staging undo log stays.
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    fn refs(&self) -> Vec<String> {
        if tag_name_error(&self.name).is_some() { Vec::new() } else { vec![tag_ref(&self.name)] }
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(why) = tag_name_error(&self.name) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        if pre.before.refs.get(&tag_ref(&self.name)).cloned().flatten().is_some() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("A tag named {} already exists", self.name)));
        }
        if self.message.as_deref().is_some_and(|m| m.trim().is_empty()) {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Enter a tag message"));
        }
        let target = gix::ObjectId::from_hex(self.target.as_bytes()).map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {}", self.target)))?;
        let repo = gix::open(pre.root).map_err(gix_err)?;
        if !repo.find_object(target).is_ok_and(|o| o.kind == gix::object::Kind::Commit) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} isn't a commit in this repository", self.target)));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        match &self.message {
            None => cx.cas(&[RefMove { name: tag_ref(&self.name), old: None, new: Some(self.target.clone()) }], &format!("tag: {}", self.name)).await?,
            Some(m) => {
                let inv = cx.git(["tag", "-a", "-F", "-", "--", self.name.as_str(), self.target.as_str()]).stdin(format!("{}\n", m.trim_end()).into_bytes());
                cx.run_git(inv).await?;
            }
        }
        cx.touch(ChangeKind::Refs);
        Ok(())
    }
}

pub(crate) struct DeleteTag {
    pub name: String,
    pub local: bool,
    pub remote: Option<String>,
}

impl WriteIntent for DeleteTag {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        if self.local { OpKind::Branch } else { OpKind::Push }
    }
    fn label(&self) -> String {
        match (self.local, &self.remote) {
            (true, Some(r)) => format!("delete tag {} here and from {r}", self.name),
            (false, Some(r)) => format!("delete tag {} from {r}", self.name),
            _ => format!("delete tag {}", self.name),
        }
    }
    /// A remote-only delete is a push: a Barrier. Otherwise the local part's MoveRefs (Both puts
    /// its Barrier below, as branch delete does).
    fn undo(&self) -> Option<UndoKind> {
        Some(if self.local { UndoKind::MoveRefs } else { UndoKind::Barrier })
    }
    fn runs_hooks(&self) -> bool {
        self.remote.is_some()
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    fn refs(&self) -> Vec<String> {
        if self.local { vec![tag_ref(&self.name)] } else { Vec::new() }
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if !self.local && self.remote.is_none() {
            return Err(GbError::new(GbErrorKind::InvalidInput, "Nothing to delete"));
        }
        if self.local && pre.before.refs.get(&tag_ref(&self.name)).cloned().flatten().is_none() {
            return Err(GbError::new(GbErrorKind::NotFound, format!("No tag {}", self.name)));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        if let Some(r) = &self.remote {
            let target = format!(":{}", tag_ref(&self.name));
            let inv = cx.net_git(["push", "--progress", r.as_str(), target.as_str()]);
            let missing = || GbError::new(GbErrorKind::NotFound, format!("{r} has no tag {}", self.name));
            match cx.network(inv).await {
                Err(mut e) => {
                    if e.stderr.as_deref().is_some_and(|s| s.contains("remote ref does not exist")) {
                        e.kind = GbErrorKind::NotFound;
                        e.message = missing().message;
                    }
                    return Err(e);
                }
                // A full refname isn't matched against the remote's refs: git sends the delete,
                // and receive-pack only warns ("deleting a non-existent ref") and succeeds. The
                // remote is unchanged; refuse here, before the local tag goes.
                Ok(out) if out.stderr.to_ascii_lowercase().contains("deleting a non-existent ref") => return Err(missing()),
                Ok(_) => {}
            }
            cx.touch(ChangeKind::Refs);
            if self.local {
                cx.barrier_below(&format!("delete tag {} from {r}", self.name), OpKind::Push)?;
                cx.set_note(format!("{} stays deleted from {r}", self.name))?;
            }
        }
        if self.local {
            let old = cx.before.refs.get(&tag_ref(&self.name)).cloned().flatten();
            let done = cx.cas(&[RefMove { name: tag_ref(&self.name), old, new: None }], &format!("tag: deleted {}", self.name)).await;
            if let (Err(e), Some(r)) = (&done, &self.remote) {
                return Err(GbError { message: format!("Deleted {} from {r}; deleting the local tag failed: {}", self.name, e.message), ..e.clone() });
            }
            done?;
            cx.touch(ChangeKind::Refs);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagPushOutcome {
    /// The op, so the toast's "Server output" link opens its Activity entry.
    #[ts(type = "number")]
    pub op: u64,
    pub remote: String,
    /// `None`: every tag (`--tags`).
    pub tag: Option<String>,
    pub up_to_date: bool,
    pub server: RemoteSummary,
}

pub(crate) struct PushTags {
    pub remote: String,
    pub tag: Option<String>,
}

impl WriteIntent for PushTags {
    type Outcome = TagPushOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Push
    }
    fn label(&self) -> String {
        match &self.tag {
            Some(t) => format!("push tag {t} to {}", self.remote),
            None => format!("push all tags to {}", self.remote),
        }
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Barrier)
    }
    /// `pre-push`, and the network.
    fn runs_hooks(&self) -> bool {
        true
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    fn refs(&self) -> Vec<String> {
        self.tag.iter().map(|t| tag_ref(t)).collect()
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(t) = &self.tag
            && pre.before.refs.get(&tag_ref(t)).cloned().flatten().is_none()
        {
            return Err(GbError::new(GbErrorKind::NotFound, format!("No tag {t}")));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<TagPushOutcome, GbError> {
        let spec = match &self.tag {
            Some(t) => format!("{0}:{0}", tag_ref(t)),
            None => "--tags".to_string(),
        };
        let inv = cx.net_git(["push", "--progress", self.remote.as_str(), spec.as_str()]);
        let res = cx.network(inv).await;
        cx.touch(ChangeKind::Refs);
        let out = res.map_err(|mut e| {
            // The remote has a tag of that name on another object: tags never move, no force.
            if e.stderr.as_deref().is_some_and(|s| s.contains("(already exists)")) {
                e.kind = GbErrorKind::NonFastForward;
                e.message = match &self.tag {
                    Some(t) => format!("{} already has a different tag {t}", self.remote),
                    None => format!("{} already has different tags with some of these names", self.remote),
                };
            }
            e
        })?;
        let server = remote_output::summarize(&remote_output::parse(&out.stderr));
        Ok(TagPushOutcome { op: cx.op.id, remote: self.remote.clone(), tag: self.tag.clone(), up_to_date: out.stderr.contains("Everything up-to-date"), server })
    }
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, journal_step, open, repo, wt};
    use serde_json::{json, Value};

    /// One commit, an origin with main pushed.
    fn tagged() -> TestRepo {
        let r = repo();
        r.add_origin();
        r.push("main");
        r
    }

    fn head(r: &TestRepo) -> String {
        r.git(&["rev-parse", "HEAD"])
    }

    fn has(r: &TestRepo, tag: &str) -> bool {
        r.try_git(&["rev-parse", "--verify", "-q", &format!("refs/tags/{tag}")]).is_ok()
    }

    fn origin_has(r: &TestRepo, tag: &str) -> bool {
        r.try_git_in(&r.root().join("origin.git"), &["rev-parse", "--verify", "-q", &format!("refs/tags/{tag}")]).is_ok()
    }

    fn create(id: u32, r: &TestRepo, name: &str, message: Option<&str>) -> Value {
        json!({"repo": id, "worktree": wt(r.path()), "name": name, "target": head(r), "message": message})
    }

    #[tokio::test]
    async fn a_lightweight_tag_is_created_undone_and_redone() {
        let data = tempfile::tempdir().unwrap();
        let r = tagged();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "createTag", create(id, &r, "v1", None)).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "create tag v1");
        assert_eq!(r.git(&["cat-file", "-t", "refs/tags/v1"]), "commit");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert!(!has(&r, "v1"));
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "refs/tags/v1"]), head(&r));
    }

    #[tokio::test]
    async fn an_annotated_tag_carries_its_message_and_undo_redo_keep_the_object() {
        let data = tempfile::tempdir().unwrap();
        let r = tagged();
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "createTag", create(id, &r, "v2", Some("Release two\n\nNotes."))).await.unwrap();
        assert_eq!(r.git(&["for-each-ref", "--format=%(objecttype) %(contents:subject)", "refs/tags/v2"]), "tag Release two");
        let object = r.git(&["rev-parse", "refs/tags/v2"]);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert!(!has(&r, "v2"));
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "refs/tags/v2"]), object);
    }

    #[tokio::test]
    async fn create_refuses_a_bad_name_a_taken_one_and_an_empty_message() {
        let data = tempfile::tempdir().unwrap();
        let r = tagged();
        r.git(&["tag", "v1"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "createTag", create(id, &r, "a..b", None)).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "A tag name can't contain .."));
        let e = call(&api, "createTag", create(id, &r, "v1", None)).await.unwrap_err();
        assert_eq!(e.message, "A tag named v1 already exists");
        let e = call(&api, "createTag", create(id, &r, "v3", Some("  \n"))).await.unwrap_err();
        assert_eq!(e.message, "Enter a tag message");
        assert!(!has(&r, "v3"));
    }

    /// Review Focus 2.
    #[tokio::test]
    async fn undoing_an_annotated_tag_delete_brings_back_its_message() {
        let data = tempfile::tempdir().unwrap();
        let r = tagged();
        r.tag("v1", "HEAD");
        let object = r.git(&["rev-parse", "refs/tags/v1"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "deleteTag", json!({"repo": id, "worktree": wt(r.path()), "name": "v1", "local": true})).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "delete tag v1");
        assert!(!has(&r, "v1"));
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["rev-parse", "refs/tags/v1"]), object);
        assert_eq!(r.git(&["cat-file", "-t", "refs/tags/v1"]), "tag");
    }

    #[tokio::test]
    async fn push_one_then_all_then_delete_both_and_undo_restores_only_the_local_tag() {
        let data = tempfile::tempdir().unwrap();
        let r = tagged();
        r.git(&["tag", "v1"]);
        r.git(&["tag", "v2"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = call(&api, "pushTags", json!({"repo": id, "worktree": wt(r.path()), "remote": "origin", "tag": "v1"})).await.unwrap();
        assert_eq!((res["outcome"]["remote"].as_str(), res["outcome"]["tag"].as_str(), res["outcome"]["upToDate"].as_bool()), (Some("origin"), Some("v1"), Some(false)));
        assert!(origin_has(&r, "v1") && !origin_has(&r, "v2"));
        assert_eq!(res["journal"]["undo"]["label"], "push tag v1 to origin");
        assert_eq!(res["journal"]["undoBlocked"], "Push can't be undone");
        let res = call(&api, "pushTags", json!({"repo": id, "worktree": wt(r.path()), "remote": "origin"})).await.unwrap();
        assert!(origin_has(&r, "v2"));
        assert_eq!(res["journal"]["undo"]["label"], "push all tags to origin");
        call(&api, "deleteTag", json!({"repo": id, "worktree": wt(r.path()), "name": "v1", "local": true, "remote": "origin"})).await.unwrap();
        assert!(!origin_has(&r, "v1") && !has(&r, "v1"));
        let out = journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(out["outcome"], json!({"status": "done", "label": "delete tag v1 here and from origin", "note": "v1 stays deleted from origin"}));
        assert!(has(&r, "v1") && !origin_has(&r, "v1"));
    }

    #[tokio::test]
    async fn deleting_a_tag_the_remote_lacks_says_so_and_changes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = tagged();
        r.git(&["tag", "v9"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "deleteTag", json!({"repo": id, "worktree": wt(r.path()), "name": "v9", "local": true, "remote": "origin"})).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, "origin has no tag v9"));
        assert!(has(&r, "v9"), "the remote part failed first: the local tag stays");
    }
}
