//! Add a remote (spec #4 §4 "4A": the Remote panel's +, a fork in a click). `git remote add`
//! writes only the repository's config, and isn't journaled (spec #2 §5.3 "Not journaled"):
//! Undo would be a Remove remote. The fetch that follows is its own request (`fetch` with
//! `remote`), so a failed fetch leaves the remote added and says why.
//!
//! Remove a remote (the Remote panel's right-click): `git remote remove`, journaled. What git
//! removed is read back, not predicted: the `refs/remotes/` refs that went (verify records their
//! moves), every local config value that went (`remote.<name>.*`, the upstreams of the branches
//! tracking it, `remote.pushDefault`: the entry's `config`, in the file's order) and its
//! symbolic refs (`RemovedRemote`). Undo puts them back; redo removes them again.

use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::{GitCli, GitInvocation};
use crate::journal::{ConfigChange, RemovedRemote, UndoKind};
use crate::write::names::remote_name_error;
use crate::write::{Plan, Pre, Staging, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) struct AddRemote {
    pub name: String,
    pub url: String,
}

/// Why `url` can't be a remote's URL: empty; a leading `-`, which git would read as an option;
/// whitespace or control characters (a pasted line break).
pub fn remote_url_error(url: &str) -> Option<&'static str> {
    if url.is_empty() {
        return Some("Enter the remote's URL");
    }
    if url.starts_with('-') {
        return Some("A remote URL can't start with -");
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some("A remote URL can't contain spaces or control characters");
    }
    None
}

impl WriteIntent for AddRemote {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    /// Never the URL: it may carry credentials.
    fn label(&self) -> String {
        format!("add remote {}", self.name)
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        if let Some(why) = remote_name_error(&self.name) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        if let Some(why) = remote_url_error(&self.url) {
            return Err(GbError::new(GbErrorKind::InvalidInput, why));
        }
        let repo = gix::open(pre.root).map_err(crate::error::gix_err)?;
        if repo.remote_names().into_iter().any(|n| n.to_str_lossy() == self.name.as_str()) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("A remote named {} already exists", self.name)));
        }
        Ok(Plan::default())
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let inv = cx.git(["remote", "add", "--", self.name.as_str(), self.url.as_str()]);
        cx.run_git(inv).await?;
        cx.touch(ChangeKind::Config);
        Ok(())
    }
}

pub(crate) struct RemoveRemote {
    pub name: String,
}

/// The repository's own config (`git config --local --list`), key and value, in file order. A read.
async fn local_config(cli: &GitCli, root: &Path) -> Result<Vec<(String, String)>, GbError> {
    let out = cli.run(GitInvocation::new(root, ["config", "--local", "--null", "--list"])).await?;
    Ok(parse_config_list(&out.stdout))
}

/// `--null --list` records (`key\nvalue\0`). A key written with no value (`prune`, no `=`) comes
/// as `key\0`: git reads it as true, and that's what replay writes back.
fn parse_config_list(raw: &[u8]) -> Vec<(String, String)> {
    raw.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let r = String::from_utf8_lossy(r);
            let (k, v) = r.split_once('\n').unwrap_or((r.as_ref(), "true"));
            (k.to_string(), v.to_string())
        })
        .collect()
}

/// A `remote.<name>.<var>` key of exactly this remote (not of `<name>.x`).
fn is_remote_key(key: &str, name: &str) -> bool {
    key.strip_prefix("remote.").and_then(|k| k.strip_prefix(name)).and_then(|k| k.strip_prefix('.')).is_some_and(|var| !var.is_empty() && !var.contains('.'))
}

/// A key `git remote remove <name>` may change: the remote's own, a branch's upstream or push
/// remote, `remote.pushDefault`. Anything else that changed meanwhile isn't the removal's, and
/// Undo leaves it alone.
fn removal_key(key: &str, name: &str) -> bool {
    is_remote_key(key, name)
        || key == "remote.pushdefault"
        || (key.starts_with("branch.") && [".remote", ".merge", ".pushremote"].iter().any(|v| key.ends_with(v)))
}

/// Every key whose values differ, in `before`'s file order (a key only in `after` last): undo
/// re-adds them in that order, each key's values in theirs.
fn config_changes(before: &[(String, String)], after: &[(String, String)]) -> Vec<ConfigChange> {
    let group = |list: &[(String, String)]| {
        let (mut order, mut map) = (Vec::<String>::new(), BTreeMap::<String, Vec<String>>::new());
        for (k, v) in list {
            if !map.contains_key(k) {
                order.push(k.clone());
            }
            map.entry(k.clone()).or_default().push(v.clone());
        }
        (order, map)
    };
    let ((order, old), (later, new)) = (group(before), group(after));
    order
        .iter()
        .chain(later.iter().filter(|k| !old.contains_key(*k)))
        .filter_map(|k| {
            let (o, n) = (old.get(k).cloned().unwrap_or_default(), new.get(k).cloned().unwrap_or_default());
            (o != n).then(|| ConfigChange { key: k.clone(), old: o, new: n })
        })
        .collect()
}

/// The refs under `refs/remotes/`: the direct ones' oids, the symbolic ones' targets.
type TrackingRefs = (BTreeMap<String, String>, BTreeMap<String, String>);
fn tracking_refs(root: &Path) -> Result<TrackingRefs, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let (mut direct, mut symbolic) = (BTreeMap::new(), BTreeMap::new());
    for r in repo.references().map_err(gix_err)?.all().map_err(gix_err)? {
        let r = r.map_err(|e| GbError::other(format!("reading refs: {e}")))?;
        let name = r.name().as_bstr().to_str_lossy().into_owned();
        if !name.starts_with("refs/remotes/") {
            continue;
        }
        match r.target() {
            gix::refs::TargetRef::Object(id) => direct.insert(name, id.to_string()),
            gix::refs::TargetRef::Symbolic(t) => symbolic.insert(name, t.as_bstr().to_str_lossy().into_owned()),
        };
    }
    Ok((direct, symbolic))
}

impl WriteIntent for RemoveRemote {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Branch
    }
    fn label(&self) -> String {
        format!("remove remote {}", self.name)
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::MoveRefs)
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let config = local_config(&pre.api.cli, pre.root).await?;
        if config.iter().any(|(k, _)| is_remote_key(k, &self.name)) {
            return Ok(Plan::default());
        }
        // Every scope, includes followed: git can't remove a remote it didn't read from here.
        let all = pre.api.cli.run(GitInvocation::new(pre.root, ["config", "--null", "--list"])).await?;
        if parse_config_list(&all.stdout).iter().any(|(k, _)| is_remote_key(k, &self.name)) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is defined outside this repository's config; remove it there", self.name)));
        }
        Err(GbError::new(GbErrorKind::NotFound, format!("No remote {}", self.name)))
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let config_before = local_config(&cx.api.cli, cx.root).await?;
        let (direct_before, symbolic_before) = tracking_refs(cx.root)?;
        // `--`: a name git would read as an option is a name.
        let inv = cx.git(["remote", "remove", "--", self.name.as_str()]);
        let ran = cx.run_git(inv).await;
        // What git did, done or failed half-way: the entry records it (a partial change keeps it).
        let config_after = local_config(&cx.api.cli, cx.root).await?;
        let (direct_after, symbolic_after) = tracking_refs(cx.root)?;
        cx.watch_refs(direct_before.into_iter().filter(|(n, _)| !direct_after.contains_key(n)).map(|(n, oid)| (n, Some(oid))));
        let symrefs: Vec<(String, String)> = symbolic_before.into_iter().filter(|(n, _)| !symbolic_after.contains_key(n)).collect();
        if !symrefs.is_empty() {
            cx.partial = true;
        }
        let name = self.name.clone();
        cx.edit_entry(|e| e.removed_remote = Some(RemovedRemote { name, symrefs }))?;
        let name = &self.name;
        cx.record_config(config_changes(&config_before, &config_after).into_iter().filter(|c| removal_key(&c.key, name)).collect())?;
        cx.touch(ChangeKind::Refs);
        cx.touch(ChangeKind::Config);
        ran.map(|_| ())
    }
}

/// Undo's refusals, before anything is written: undo needs the name free (a remote added since
/// under it would get this one's settings mixed in), redo needs the remote still there. Every
/// recorded key must still hold what the removal (or its undo) left: the replay would overwrite
/// an upstream set since without a word.
pub(crate) async fn check_removed_remote(cli: &GitCli, root: &Path, removed: &RemovedRemote, config: &[ConfigChange], undo: bool) -> Result<(), GbError> {
    let now = local_config(cli, root).await?;
    let exists = now.iter().any(|(k, _)| is_remote_key(k, &removed.name));
    match (undo, exists) {
        (true, true) => return Err(GbError::new(GbErrorKind::InvalidInput, format!("A remote named {} exists again; remove it to undo", removed.name))),
        (false, false) => return Err(GbError::new(GbErrorKind::InvalidInput, format!("The remote {} is gone already", removed.name))),
        _ => {}
    }
    for c in config {
        let values: Vec<&String> = now.iter().filter(|(k, _)| *k == c.key).map(|(_, v)| v).collect();
        let left = if undo { &c.new } else { &c.old };
        if values != left.iter().collect::<Vec<_>>() {
            let since = if undo { "removed" } else { "restored" };
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} changed since the remote was {since}", c.key)));
        }
    }
    Ok(())
}

/// Undo or redo of a removed remote's symbolic refs (its refs and config are the entry's moves and
/// config changes). Undo creates each one only where nothing is now; redo deletes each one still
/// pointing where it did.
pub(crate) async fn replay_symrefs(cx: &mut WriteCx<'_>, removed: &RemovedRemote, undo: bool) -> Result<(), GbError> {
    let (direct, symbolic) = tracking_refs(cx.root)?;
    for (name, target) in &removed.symrefs {
        if undo {
            if direct.contains_key(name) || symbolic.contains_key(name) {
                continue;
            }
            let inv = cx.git(["symbolic-ref", "-m", "undo: remove remote", name.as_str(), target.as_str()]);
            cx.run_git(inv).await?;
        } else if symbolic.get(name) == Some(target) {
            let inv = cx.git(["symbolic-ref", "--delete", name.as_str()]);
            cx.run_git(inv).await?;
        }
        cx.touch(ChangeKind::Refs);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::error::GbErrorKind;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, open, repo, wt};
    use serde_json::json;

    #[tokio::test]
    async fn adds_a_remote_without_a_journal_entry_and_fetches_only_it() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        // A remote whose fetch would fail: proves the fetch below doesn't run `--all`.
        r.git(&["remote", "add", "broken", "/nonexistent/broken.git"]);
        let fork = TestRepo::new();
        fork.commit("Fork work");
        let fork_branch = fork.git(&["branch", "--show-current"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let url = fork.path().display().to_string();
        let res = call(&api, "addRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "alice", "url": url})).await.unwrap();
        assert!(res["outcome"].is_null());
        assert_eq!(r.git(&["remote", "get-url", "alice"]), url);
        assert!(res["journal"]["undo"].is_null(), "not journaled");
        let fetched = call(&api, "fetch", json!({"repo": id, "background": false, "remote": "alice"})).await.unwrap();
        assert_eq!(fetched["status"], "done");
        assert_eq!(r.git(&["rev-parse", &format!("refs/remotes/alice/{fork_branch}")]), fork.git(&["rev-parse", "HEAD"]));
        // The handle was reopened: the sidebar knows the new remote and lists its branch.
        let sidebar = call(&api, "sidebar", json!({"repo": id})).await.unwrap();
        let alice = sidebar["remotes"].as_array().unwrap().iter().find(|g| g["name"] == "alice").cloned().unwrap_or_else(|| panic!("{sidebar}"));
        assert_eq!(alice["branches"][0]["name"], fork_branch.as_str());
        let remotes = call(&api, "remotes", json!({"repo": id})).await.unwrap();
        assert!(remotes.as_array().unwrap().iter().any(|r| r["name"] == "alice"), "{remotes}");
        let unknown = call(&api, "fetch", json!({"repo": id, "background": false, "remote": "nope"})).await.unwrap_err();
        assert_eq!((unknown.kind, unknown.message.as_str()), (GbErrorKind::NotFound, "No remote nope"));
    }

    #[tokio::test]
    async fn refuses_a_taken_name_a_bad_name_and_an_option_like_or_broken_url() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.git(&["remote", "add", "origin", "/nonexistent/origin.git"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = r.git(&["config", "--local", "--list"]);
        for (name, url, why) in [
            ("origin", "/tmp/x.git", "A remote named origin already exists"),
            ("a b", "/tmp/x.git", "A remote name can't contain spaces or ~ ^ : ? * [ \\"),
            ("-x", "/tmp/x.git", "A remote name can't start with -"),
            ("ok", "", "Enter the remote's URL"),
            ("ok", "--upload-pack=touch /tmp/pwned", "A remote URL can't start with -"),
            ("ok", "https://gitlab.example.com/a b.git", "A remote URL can't contain spaces or control characters"),
            ("ok", "https://gitlab.example.com/a.git\n", "A remote URL can't contain spaces or control characters"),
        ] {
            let e = call(&api, "addRemote", json!({"repo": id, "worktree": wt(r.path()), "name": name, "url": url})).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, why), "{name:?} {url:?}");
        }
        assert_eq!(r.git(&["config", "--local", "--list"]), before, "nothing written");
    }

    #[test]
    fn remote_names_follow_git_said_of_a_remote() {
        use crate::write::names::remote_name_error;
        assert_eq!(remote_name_error("").as_deref(), Some("Enter a remote name"));
        assert_eq!(remote_name_error("a..b").as_deref(), Some("A remote name can't contain .."));
        assert_eq!(remote_name_error("alice"), None);
        assert_eq!(remote_name_error("team/alice"), None);
    }

    // --- Remove remote ---

    /// main and feature pushed to origin and tracking it; origin with two fetch refspecs, a
    /// pushurl, its HEAD symref and `remote.pushDefault`; a second remote `up` (and a branch
    /// tracking it) that must stay as it is.
    fn tracked() -> TestRepo {
        let r = repo();
        let origin = r.add_origin();
        r.git(&["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
        r.git(&["config", "remote.origin.pushurl", origin.to_str().unwrap()]);
        r.git(&["push", "-q", "-u", "origin", "HEAD"]);
        r.git(&["switch", "-q", "-c", "feature"]);
        r.git(&["push", "-q", "-u", "origin", "feature"]);
        r.git(&["config", "branch.feature.pushRemote", "origin"]);
        r.git(&["switch", "-q", "-"]);
        r.git(&["config", "remote.pushDefault", "origin"]);
        let main = r.git(&["branch", "--show-current"]);
        r.git(&["symbolic-ref", "refs/remotes/origin/HEAD", &format!("refs/remotes/origin/{main}")]);
        let up = r.root().join("up.git");
        r.git_in(r.root(), &["init", "-q", "--bare", up.to_str().unwrap()]);
        r.git(&["remote", "add", "up", up.to_str().unwrap()]);
        r.git(&["push", "-q", "up", "HEAD:refs/heads/side"]);
        r.git(&["fetch", "-q", "up"]);
        r.git(&["branch", "-q", "--track", "from-up", "up/side"]);
        r
    }

    fn sorted_config(r: &TestRepo) -> Vec<String> {
        let mut lines: Vec<String> = r.git(&["config", "--local", "--list"]).lines().map(String::from).collect();
        lines.sort();
        lines
    }

    fn refs(r: &TestRepo) -> String {
        r.git(&["for-each-ref", "--format=%(refname) %(objectname) %(symref)"])
    }

    #[tokio::test]
    async fn removes_a_remote_with_its_refs_and_upstreams_and_undo_redo_round_trip() {
        round_trip(false).await;
    }

    /// The same with every ref packed: git removes them from `packed-refs`, undo writes them back.
    #[tokio::test]
    async fn packed_refs_round_trip_too() {
        round_trip(true).await;
    }

    async fn round_trip(packed: bool) {
        use crate::write::test_support::journal_step;
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        if packed {
            r.git(&["pack-refs", "--all"]);
            assert!(std::fs::read_to_string(r.path().join(".git/packed-refs")).unwrap().contains("refs/remotes/origin/"));
            assert!(!r.path().join(".git/refs/remotes/origin/feature").exists());
        }
        let api = api(data.path());
        let id = open(&api, &r).await;
        let (config, refs_before) = (sorted_config(&r), refs(&r));
        let fetch = r.git(&["config", "--get-all", "remote.origin.fetch"]);
        assert!(refs_before.contains("refs/remotes/origin/HEAD"), "{refs_before}");

        let res = call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "origin"})).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "remove remote origin", "{res}");
        let left = r.git(&["config", "--local", "--list"]);
        assert!(!left.contains("origin"), "every origin key and upstream went: {left}");
        assert!(left.contains("remote.up.url") && left.contains("branch.from-up.remote=up"), "up stays: {left}");
        assert!(!refs(&r).contains("refs/remotes/origin/"), "{}", refs(&r));
        assert!(refs(&r).contains("refs/remotes/up/"));
        let sidebar = call(&api, "sidebar", json!({"repo": id})).await.unwrap();
        assert!(sidebar["remotes"].as_array().unwrap().iter().all(|g| g["name"] != "origin"), "{sidebar}");
        let removed = (sorted_config(&r), refs(&r));

        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(sorted_config(&r), config);
        assert_eq!(r.git(&["config", "--get-all", "remote.origin.fetch"]), fetch, "the refspecs in their order");
        assert_eq!(refs(&r), refs_before, "every ref back, the HEAD symref as a symref");
        let sidebar = call(&api, "sidebar", json!({"repo": id})).await.unwrap();
        assert!(sidebar["remotes"].as_array().unwrap().iter().any(|g| g["name"] == "origin"), "the handle knows it again: {sidebar}");

        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!((sorted_config(&r), refs(&r)), removed);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!((sorted_config(&r), refs(&r)), (config, refs_before));
    }

    #[tokio::test]
    async fn undo_refuses_when_a_remote_of_that_name_is_back() {
        use crate::write::test_support::journal_step;
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "origin"})).await.unwrap();
        r.git(&["remote", "add", "origin", "/nonexistent/other.git"]);
        let e = journal_step(&api, id, r.path(), "undo").await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "A remote named origin exists again; remove it to undo"));
        assert_eq!(r.git(&["config", "--get-all", "remote.origin.url"]), "/nonexistent/other.git", "untouched");
    }

    #[tokio::test]
    async fn undo_refuses_when_an_upstream_it_restores_was_set_since() {
        use crate::write::test_support::journal_step;
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "origin"})).await.unwrap();
        let main = r.git(&["branch", "--show-current"]);
        r.git(&["branch", "-q", "-u", "up/side", &main]);
        let before = (r.git(&["config", "--local", "--list"]), r.git(&["for-each-ref"]));
        let e = journal_step(&api, id, r.path(), "undo").await.unwrap_err();
        assert_eq!((e.kind, e.message), (GbErrorKind::InvalidInput, format!("branch.{main}.remote changed since the remote was removed")));
        assert_eq!((r.git(&["config", "--local", "--list"]), r.git(&["for-each-ref"])), before, "nothing replayed");
    }

    #[tokio::test]
    async fn a_missing_remote_is_not_found_and_an_option_like_name_is_a_name() {
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        // git itself won't add a remote named `-x`; a hand-edited config can have one.
        r.git(&["config", "remote.-x.url", "/nonexistent/x.git"]);
        r.git(&["config", "remote.-x.fetch", "+refs/heads/*:refs/remotes/-x/*"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let before = r.git(&["config", "--local", "--list"]);
        for name in ["nope", "-v", "--help", "or", ""] {
            let e = call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": name})).await.unwrap_err();
            assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::NotFound, format!("No remote {name}").as_str()), "{name:?}");
        }
        assert_eq!(r.git(&["config", "--local", "--list"]), before, "nothing written");
        let state = call(&api, "journalState", json!({"repo": id, "worktree": wt(r.path())})).await.unwrap();
        assert!(state["undo"].is_null(), "nothing journaled: {state}");
        call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "-x"})).await.unwrap();
        let left = r.git(&["config", "--local", "--list"]);
        assert!(!left.contains("remote.-x."), "{left}");
        assert!(left.contains("remote.origin.url"), "origin stays: {left}");
    }

    #[tokio::test]
    async fn a_remote_from_an_included_file_is_removed_there() {
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        std::fs::write(r.path().join(".git/shared.config"), "[remote \"shared\"]\n\turl = /nonexistent/shared.git\n").unwrap();
        r.git(&["config", "include.path", "shared.config"]);
        assert_eq!(r.git(&["remote", "get-url", "shared"]), "/nonexistent/shared.git");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let e = call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "shared"})).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "shared is defined outside this repository's config; remove it there"));
        assert_eq!(r.git(&["remote", "get-url", "shared"]), "/nonexistent/shared.git", "untouched");
    }

    #[test]
    fn a_key_with_no_value_reads_as_true() {
        let list = super::parse_config_list(b"remote.o.url\n/x.git\0remote.o.prune\0remote.o.mirror\0remote.o.tagopt\n\0");
        let pairs: Vec<(&str, &str)> = list.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(pairs, [("remote.o.url", "/x.git"), ("remote.o.prune", "true"), ("remote.o.mirror", "true"), ("remote.o.tagopt", "")], "an empty value (`=`) stays empty");
    }

    /// A key written with no `=` in the file: undo writes it back as true, which git reads alike.
    #[tokio::test]
    async fn a_valueless_key_comes_back_as_true() {
        use crate::write::test_support::journal_step;
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        let config = r.path().join(".git/config");
        let text = std::fs::read_to_string(&config).unwrap().replace("[remote \"origin\"]\n", "[remote \"origin\"]\n\tprune\n");
        std::fs::write(&config, text).unwrap();
        assert_eq!(r.git(&["config", "--bool", "remote.origin.prune"]), "true");
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "origin"})).await.unwrap();
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["config", "remote.origin.prune"]), "true");
    }

    #[test]
    fn config_changes_keep_file_order_and_each_keys_values() {
        let kv = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let before = kv(&[("core.bare", "false"), ("remote.o.url", "u"), ("remote.o.fetch", "a"), ("remote.o.pushurl", "p"), ("remote.o.fetch", "b"), ("branch.m.remote", "o")]);
        let after = kv(&[("core.bare", "false")]);
        let c = super::config_changes(&before, &after);
        let keys: Vec<&str> = c.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["remote.o.url", "remote.o.fetch", "remote.o.pushurl", "branch.m.remote"]);
        assert_eq!(c[1].old, ["a", "b"]);
        assert!(c.iter().all(|c| c.new.is_empty()));
        assert!(super::is_remote_key("remote.o.url", "o"));
        assert!(!super::is_remote_key("remote.o.x.url", "o"), "remote o.x's");
        assert!(super::is_remote_key("remote.o.x.url", "o.x"));
        assert!(!super::is_remote_key("remote.or.url", "o"));
        for (key, ok) in [("remote.o.fetch", true), ("remote.pushdefault", true), ("branch.a.b.remote", true), ("branch.x.merge", true), ("branch.x.pushremote", true), ("branch.x.rebase", false), ("remote.up.url", false), ("core.bare", false)] {
            assert_eq!(super::removal_key(key, "o"), ok, "{key}");
        }
    }

    /// A config change made while the removal runs (here by a reference-transaction hook) isn't
    /// the removal's: Undo leaves it.
    #[tokio::test]
    async fn an_unrelated_change_during_the_removal_isnt_undone() {
        use crate::write::test_support::journal_step;
        let data = tempfile::tempdir().unwrap();
        let r = tracked();
        r.hook("reference-transaction", "#!/bin/sh\ngit config gitbolt.during yes\nexit 0\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        call(&api, "removeRemote", json!({"repo": id, "worktree": wt(r.path()), "name": "origin"})).await.unwrap();
        assert_eq!(r.git(&["config", "gitbolt.during"]), "yes");
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(r.git(&["config", "gitbolt.during"]), "yes", "not the removal's");
        assert!(r.git(&["config", "--local", "--list"]).contains("remote.origin.url="));
    }
}
