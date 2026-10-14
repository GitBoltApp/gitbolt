//! Git LFS writes (`lfs.rs` has the reads): Fetch and Pull for the repository, one file's
//! Download from the diff, and Track / Stop tracking a `*.<ext>` pattern. Each runs `git lfs`
//! through `run_write`, so it queues, shows in Activity and is refused where other writes are.
//! The transfers are network commands (askpass, progress, Cancel) and aren't journaled: they
//! only add objects to the LFS store, and a checkout only swaps pointer files for the files they
//! stand for. Track and Stop tracking edit `.gitattributes`, journaled with before and after
//! snapshots of it, as a restore is.

use crate::api::Api;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{snapshot, UndoKind};
use crate::write::restore::untracked_of;
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, NetCx, Plan, Pre, Staging, WriteClass, WriteCx, WriteIntent};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

/// git-lfs prints its progress only to a terminal unless this is set.
const FORCE_PROGRESS: (&str, &str) = ("GIT_LFS_FORCE_PROGRESS", "1");

#[derive(Debug, Clone, PartialEq, Eq)]
enum Transfer {
    /// `git lfs fetch`: the objects HEAD's files need, into the store.
    Fetch,
    /// `git lfs fetch`, then `git lfs checkout`: the working tree's pointer files become files.
    Pull,
    /// One file's objects at `refs` (commits; none: HEAD), then its checkout if the working tree
    /// has it as a pointer. `oids`: the objects the diff is missing, checked afterwards.
    Download { path: String, refs: Vec<String>, oids: Vec<String> },
}

/// A transfer's answer: of the objects a Download asked for, those still not in the store (the
/// remote didn't have them at those commits; empty for Fetch and Pull); and `not_set_up`: a
/// checkout was due, but git-lfs isn't set up in the repository (no `filter.lfs.*`: `git lfs
/// install` wasn't run), so it was skipped (git-lfs would only say so and exit 0).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LfsTransferOutcome {
    pub missing: Vec<String>,
    pub not_set_up: bool,
}

struct LfsTransfer {
    what: Transfer,
}

impl LfsTransfer {
    /// `git lfs fetch`'s arguments: a Download's include and, with refs, the remote to fetch them
    /// from (git-lfs takes refs only after a remote).
    fn fetch_args(&self, root: &Path) -> Result<Vec<String>, GbError> {
        let mut args = vec!["lfs".to_string(), "fetch".into()];
        if let Transfer::Download { path, refs, .. } = &self.what {
            args.extend(["--include".into(), crate::lfs::include_pattern(path)?]);
            if !refs.is_empty() {
                let repo = gix::open(root).map_err(gix_err)?;
                let remote = crate::lfs::default_remote(&repo).ok_or_else(|| GbError::new(GbErrorKind::NotFound, "There's no remote to download it from"))?;
                args.push(remote);
                args.extend(refs.iter().cloned());
            }
        }
        Ok(args)
    }
}

impl WriteIntent for LfsTransfer {
    type Outcome = LfsTransferOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Lfs
    }
    fn label(&self) -> String {
        match &self.what {
            Transfer::Fetch => "LFS fetch".into(),
            Transfer::Pull => "LFS pull".into(),
            Transfer::Download { path, .. } => format!("download {path} from LFS"),
        }
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    /// Network and checkout: no timeout, cancellable.
    fn runs_hooks(&self) -> bool {
        true
    }
    fn traces_hooks(&self) -> bool {
        false
    }
    /// A fetch only fills the store.
    fn allowed_in_progress(&self) -> bool {
        self.what == Transfer::Fetch
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    /// The download, holding only the queue slot, as pull's fetch.
    async fn transfer_first(&self, net: &mut NetCx<'_>) -> Result<(), GbError> {
        let args = self.fetch_args(net.root)?;
        let (tx, progress) = crate::netops::forward_progress_to(net.api.bus.clone(), net.op.id, Some(net.output()));
        let inv = net.git(args).env(FORCE_PROGRESS.0, FORCE_PROGRESS.1).stream_stderr(tx).stream_stdout_too();
        let res = net.api.cli.run(inv).await;
        let _ = progress.await;
        res.map(|_| ()).map_err(|e| crate::netops::user_cancelled(e, net.op))
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<LfsTransferOutcome, GbError> {
        let checkout: Option<Vec<String>> = match &self.what {
            Transfer::Fetch => None,
            Transfer::Pull => Some(Vec::new()),
            // Only a working-tree file that's still a pointer is checked out, and only it.
            Transfer::Download { path, .. } => {
                let file = crate::blob::safe_join(cx.root, path).ok();
                let pointer = file.and_then(|f| crate::blob::read_bounded(&f, crate::lfs::POINTER_MAX - 1).ok().flatten()).is_some_and(|b| crate::lfs::parse_pointer(&b).is_some());
                if pointer { Some(vec!["--".to_string(), crate::lfs::include_pattern(path)?]) } else { None }
            }
        };
        let not_set_up = checkout.is_some() && !crate::lfs::filter_configured(&gix::open(cx.root).map_err(gix_err)?);
        if let Some(patterns) = checkout.filter(|_| !not_set_up) {
            cx.partial = true;
            let inv = cx.git(["lfs".to_string(), "checkout".into()].into_iter().chain(patterns)).env(FORCE_PROGRESS.0, FORCE_PROGRESS.1).stream_stdout_too();
            cx.run_git(inv).await?;
            cx.touch(ChangeKind::Worktree);
        }
        let missing = match &self.what {
            Transfer::Download { oids, .. } => {
                let repo = gix::open(cx.root).map_err(gix_err)?;
                let storage = crate::lfs::storage_dir(&repo);
                oids.iter().filter(|o| crate::lfs::stored(&crate::lfs::object_path(&storage, o)).is_none()).cloned().collect()
            }
            _ => Vec::new(),
        };
        Ok(LfsTransferOutcome { missing, not_set_up })
    }
}

/// Full lowercase hex of the given kind's length, or `InvalidInput`.
fn check_hex(s: &str, len: usize, what: &str) -> Result<(), GbError> {
    let ok = s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok { Ok(()) } else { Err(GbError::new(GbErrorKind::InvalidInput, format!("not {what}: {s:?}"))) }
}

pub(crate) async fn lfs_fetch(api: &Api, repo: u32, worktree: &str) -> Result<WriteResult<LfsTransferOutcome>, GbError> {
    run_write(api, repo, worktree, Expect::default(), LfsTransfer { what: Transfer::Fetch }).await
}

pub(crate) async fn lfs_pull(api: &Api, repo: u32, worktree: &str) -> Result<WriteResult<LfsTransferOutcome>, GbError> {
    run_write(api, repo, worktree, Expect::default(), LfsTransfer { what: Transfer::Pull }).await
}

pub(crate) async fn lfs_download(api: &Api, repo: u32, worktree: &str, path: String, refs: Vec<String>, oids: Vec<String>) -> Result<WriteResult<LfsTransferOutcome>, GbError> {
    crate::blob::check_relative(&path)?;
    crate::lfs::include_pattern(&path)?;
    for r in &refs {
        check_hex(r, 40, "a commit id").or_else(|_| check_hex(r, 64, "a commit id"))?;
    }
    for o in &oids {
        check_hex(o, 64, "an LFS object id")?;
    }
    run_write(api, repo, worktree, Expect::default(), LfsTransfer { what: Transfer::Download { path, refs, oids } }).await
}

/// Track (`git lfs track`) or stop tracking (`git lfs untrack`) `*.<ext>`: an edit of the
/// working tree's `.gitattributes`, which then shows as a change to commit.
struct LfsTrack {
    pattern: String,
    untrack: bool,
}

const ATTRIBUTES: &str = ".gitattributes";

impl WriteIntent for LfsTrack {
    type Outcome = ();
    fn kind(&self) -> OpKind {
        OpKind::Lfs
    }
    fn label(&self) -> String {
        if self.untrack { format!("stop tracking {} with LFS", self.pattern) } else { format!("track {} with LFS", self.pattern) }
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Restore)
    }
    /// The index is never written.
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        Ok(Plan { snapshot: Some((vec![ATTRIBUTES.to_string()], untracked_of(pre.root, ATTRIBUTES)?)), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<(), GbError> {
        let snap = cx.snapshot.clone().ok_or_else(|| GbError::other("the LFS track has no snapshot"))?;
        let file = cx.root.join(ATTRIBUTES);
        let before = std::fs::read(&file).ok();
        cx.partial = true;
        let verb = if self.untrack { "untrack" } else { "track" };
        let inv = cx.git(["lfs", verb, self.pattern.as_str()]);
        cx.run_git(inv).await?;
        if std::fs::read(&file).ok() == before {
            cx.partial = false;
            let message = if self.untrack { format!("No .gitattributes line tracks {} with LFS", self.pattern) } else { format!("{} is already tracked with LFS", self.pattern) };
            return Err(GbError::new(GbErrorKind::InvalidInput, message));
        }
        cx.after = Some(snapshot::create(&cx.snapshots(), &self.label(), &snap.paths, &untracked_of(cx.root, ATTRIBUTES)?).await?);
        cx.touch(ChangeKind::Worktree);
        Ok(())
    }
}

pub(crate) async fn lfs_track(api: &Api, repo: u32, worktree: &str, pattern: String, untrack: bool) -> Result<WriteResult<()>, GbError> {
    crate::lfs::check_pattern(&pattern)?;
    run_write(api, repo, worktree, Expect::default(), LfsTrack { pattern, untrack }).await
}

#[cfg(all(test, unix))]
mod tests {
    use crate::lfs::tests::{pointer_text, OID};
    use crate::testing::state::RepoState;
    use crate::write::test_support::{call, journal_step, open, open_at, repo, wt};
    use serde_json::json;
    use std::path::{Path, PathBuf};

    /// A stand-in `git-lfs` on PATH (git runs `git-lfs` for `git lfs`): `version`, `track` and
    /// `untrack` edit `.gitattributes` as git-lfs does; `fetch` and `checkout` log their
    /// arguments, and `fetch` puts the object `$FAKE_LFS_OBJECT` (`<oid> <content>`) in the store.
    fn fake_lfs(dir: &Path) -> PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = r#"#!/bin/sh
log="$FAKE_LFS_LOG"
cmd="$1"; shift
case "$cmd" in
  version) echo "git-lfs/3.9.9 (fake; linux amd64)";;
  track) grep -qxF "$1 filter=lfs diff=lfs merge=lfs -text" .gitattributes 2>/dev/null && { echo "\"$1\" already supported"; exit 0; }
         echo "$1 filter=lfs diff=lfs merge=lfs -text" >> .gitattributes; echo "Tracking \"$1\"";;
  untrack) [ -f .gitattributes ] || exit 0
         grep -vxF "$1 filter=lfs diff=lfs merge=lfs -text" .gitattributes > .gitattributes.new; mv .gitattributes.new .gitattributes;;
  fetch) echo "fetch $*" >> "$log"; echo "Downloading LFS objects:  50% (1/2), 1 B | 1 B/s" >&2
         if [ -n "$FAKE_LFS_OBJECT" ]; then set -- $FAKE_LFS_OBJECT; oid=$1
           d=".git/lfs/objects/$(echo $oid | cut -c1-2)/$(echo $oid | cut -c3-4)"; mkdir -p "$d"; printf '%s' "$2" > "$d/$oid"; fi;;
  checkout) echo "checkout $*" >> "$log";;
  *) echo "fake git-lfs: $cmd" >&2; exit 2;;
esac
"#;
        let path = bin.join("git-lfs");
        std::fs::write(&path, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// An API whose git finds the fake git-lfs, logging to `<dir>/log`.
    fn lfs_api(dir: &Path, data: &Path, object: Option<String>) -> crate::api::Api {
        use crate::git::GitCli;
        use crate::log::CommandLog;
        let bin = fake_lfs(dir);
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let mut env = crate::testing::isolated_git_env();
        env.push(("PATH".into(), path.into()));
        env.push(("FAKE_LFS_LOG".into(), dir.join("log").into()));
        if let Some(o) = object {
            env.push(("FAKE_LFS_OBJECT".into(), o.into()));
        }
        crate::api::Api::new(GitCli::new(std::sync::Arc::new(CommandLog::new(100))).with_env(env), None).with_data_dir(data.to_path_buf())
    }

    fn log(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("log")).unwrap_or_default()
    }

    #[tokio::test]
    async fn track_and_untrack_edit_gitattributes_and_undo() {
        let (tmp, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let api = lfs_api(tmp.path(), data.path(), None);
        let r = repo();
        let id = open(&api, &r).await;
        let before = RepoState::capture(&r);
        let res = call(&api, "lfsTrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.psd" })).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "track *.psd with LFS");
        assert_eq!(std::fs::read_to_string(r.path().join(".gitattributes")).unwrap(), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
        assert!(r.git(&["status", "--porcelain"]).contains("?? .gitattributes"), "it shows as a change");
        let again = call(&api, "lfsTrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.psd" })).await.unwrap_err();
        assert!(again.message.contains("already tracked"), "{}", again.message);
        let after = RepoState::capture(&r);
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(RepoState::capture(&r), before, "undo removes the new .gitattributes");
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(RepoState::capture(&r), after);

        r.git(&["add", ".gitattributes"]);
        r.git(&["commit", "-qm", "lfs"]);
        let res = call(&api, "lfsUntrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.psd" })).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "stop tracking *.psd with LFS");
        assert_eq!(std::fs::read_to_string(r.path().join(".gitattributes")).unwrap(), "");
        let none = call(&api, "lfsUntrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.png" })).await.unwrap_err();
        assert!(none.message.contains("No .gitattributes line"), "{}", none.message);
        let bad = call(&api, "lfsTrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "--global" })).await.unwrap_err();
        assert_eq!(bad.kind, crate::error::GbErrorKind::InvalidInput);
    }

    /// A Download names the file and the commits (after the remote), then checks out a pointer
    /// file; it reports the objects still missing.
    #[tokio::test]
    async fn download_fetches_one_file_at_its_commits_and_checks_out_a_pointer() {
        let (tmp, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let api = lfs_api(tmp.path(), data.path(), Some(format!("{OID} hello")));
        let r = repo();
        r.git(&["config", "filter.lfs.process", "git-lfs filter-process"]);
        r.git(&["remote", "add", "origin", "/nonexistent/origin.git"]);
        r.write("art/logo.psd", &pointer_text(OID, 5));
        r.write("art/logo[1].psd", &pointer_text(OID, 5));
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "pointer"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let id = open(&api, &r).await;
        let res = call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(r.path()), "path": "art/logo.psd", "refs": [head], "oids": [OID] })).await.unwrap();
        assert_eq!(res["outcome"]["missing"], json!([]));
        assert_eq!(log(tmp.path()), format!("fetch --include art/logo.psd origin {head}\ncheckout -- art/logo.psd\n"));
        call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(r.path()), "path": "art/logo[1].psd", "refs": [head], "oids": [] })).await.unwrap();
        let escaped = format!("fetch --include {p} origin {head}\ncheckout -- {p}\n", p = r"art/logo\[1\].psd");
        assert!(log(tmp.path()).ends_with(&escaped), "glob characters are escaped: {}", log(tmp.path()));
        let comma = call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(r.path()), "path": "a,b.psd", "refs": [], "oids": [] })).await.unwrap_err();
        assert!(comma.message.contains("comma"), "never widened to every file: {}", comma.message);
        let other = "b".repeat(64);
        let res = call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(r.path()), "path": "a.txt", "refs": [], "oids": [other] })).await.unwrap();
        assert_eq!(res["outcome"]["missing"], json!([other]), "the remote didn't have it");
        assert!(log(tmp.path()).ends_with("fetch --include a.txt\n"), "no refs: HEAD's, with no remote; a.txt isn't a pointer, so no checkout");
        let bad = call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(r.path()), "path": "a.txt", "refs": ["HEAD"], "oids": [] })).await.unwrap_err();
        assert_eq!(bad.kind, crate::error::GbErrorKind::InvalidInput, "refs are commit ids");
    }

    #[tokio::test]
    async fn fetch_and_pull_run_git_lfs_and_are_not_journaled() {
        let (tmp, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let api = lfs_api(tmp.path(), data.path(), None);
        let r = repo();
        let id = open(&api, &r).await;
        let res = call(&api, "lfsFetch", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(res["journal"]["undo"].is_null(), "{res}");
        // git-lfs isn't set up here (no `git lfs install`): the pull fetches, and says the
        // checkout was skipped.
        let status = call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap();
        assert_eq!((status["used"].as_bool(), status["version"].as_str(), status["filter"].as_bool()), (Some(false), Some("3.9.9"), Some(false)));
        let res = call(&api, "lfsPull", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(res["outcome"]["notSetUp"], true);
        assert_eq!(log(tmp.path()), "fetch \nfetch \n");
        r.git(&["config", "filter.lfs.process", "git-lfs filter-process"]);
        let res = call(&api, "lfsPull", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert_eq!(res["outcome"]["notSetUp"], false);
        assert_eq!(log(tmp.path()), "fetch \nfetch \nfetch \ncheckout \n");
        assert_eq!(call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap()["filter"], true);
    }

    /// git-lfs's version is read once per session; `recheck` reads it again.
    #[tokio::test]
    async fn the_git_lfs_version_is_read_once_unless_rechecked() {
        let (tmp, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let api = lfs_api(tmp.path(), data.path(), None);
        let r = repo();
        let id = open(&api, &r).await;
        assert_eq!(call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap()["version"], "3.9.9");
        std::fs::remove_file(tmp.path().join("bin/git-lfs")).unwrap();
        assert_eq!(call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap()["version"], "3.9.9", "cached");
        assert!(call(&api, "lfsStatus", json!({ "repo": id, "recheck": true })).await.unwrap()["version"].is_null(), "read again: gone");
        assert!(call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap()["version"].is_null());
    }

    /// The same requests against the real git-lfs, offline: a `file://` remote served by
    /// git-lfs's standalone file transfer agent. Run only with git-lfs: `GITVOLT_TEST_GIT_LFS`
    /// (the binary or its folder), or `git-lfs` on PATH; otherwise each test says so and passes.
    mod real {
        use super::*;
        use crate::events::AppEvent;
        use sha2::Digest as _;
        use std::process::Command;

        /// The folder holding the real `git-lfs`.
        fn real_lfs() -> Option<PathBuf> {
            if let Some(v) = std::env::var_os("GITVOLT_TEST_GIT_LFS") {
                let p = PathBuf::from(v);
                let dir = if p.is_dir() { p } else { p.parent()?.to_path_buf() };
                return dir.join("git-lfs").is_file().then_some(dir);
            }
            std::env::split_paths(&std::env::var_os("PATH")?).find(|d| d.join("git-lfs").is_file())
        }

        macro_rules! need_lfs {
            () => {
                match real_lfs() {
                    Some(dir) => dir,
                    None => {
                        eprintln!("skipped: no git-lfs (set GITVOLT_TEST_GIT_LFS to the binary to run this)");
                        return;
                    }
                }
            };
        }

        /// Files under `d`, recursively.
        fn walk_count(d: &Path) -> usize {
            std::fs::read_dir(d).map(|rd| rd.flatten().map(|e| if e.path().is_dir() { walk_count(&e.path()) } else { 1 }).sum()).unwrap_or(0)
        }

        fn path_with(bin: &Path) -> std::ffi::OsString {
            std::env::join_paths(std::iter::once(bin.to_path_buf()).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()))).unwrap()
        }

        /// `git <args>` in `dir`, isolated, with git-lfs on PATH; its stdout, or a panic.
        fn git(bin: &Path, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
            let out = Command::new("git").current_dir(dir).args(args).envs(crate::testing::isolated_git_env()).env("PATH", path_with(bin)).envs(env.iter().copied()).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim_end().to_string()
        }

        fn real_api(bin: &Path, data: &Path) -> crate::api::Api {
            use crate::git::GitCli;
            use crate::log::CommandLog;
            let mut env = crate::testing::isolated_git_env();
            env.push(("PATH".into(), path_with(bin)));
            crate::api::Api::new(GitCli::new(std::sync::Arc::new(CommandLog::new(100))).with_env(env), None).with_data_dir(data.to_path_buf())
        }

        #[tokio::test]
        async fn track_and_untrack_write_git_lfss_own_lines() {
            let bin = need_lfs!();
            let data = tempfile::tempdir().unwrap();
            let api = real_api(&bin, data.path());
            let r = repo();
            let id = open(&api, &r).await;
            let status = call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap();
            assert!(status["version"].as_str().is_some_and(|v| v.starts_with('3')), "{status}");
            assert_eq!(status["filter"], false, "git lfs install wasn't run");
            git(&bin, r.path(), &["lfs", "install", "--local"], &[]);
            assert_eq!(call(&api, "lfsStatus", json!({ "repo": id })).await.unwrap()["filter"], true);
            call(&api, "lfsTrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.psd" })).await.unwrap();
            assert_eq!(std::fs::read_to_string(r.path().join(".gitattributes")).unwrap(), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
            let again = call(&api, "lfsTrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.psd" })).await.unwrap_err();
            assert!(again.message.contains("already tracked"), "git-lfs exits 0 and changes nothing: {}", again.message);
            let none = call(&api, "lfsUntrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.png" })).await.unwrap_err();
            assert!(none.message.contains("No .gitattributes line"), "{}", none.message);
            call(&api, "lfsUntrack", json!({ "repo": id, "worktree": wt(r.path()), "pattern": "*.psd" })).await.unwrap();
            assert_eq!(std::fs::read_to_string(r.path().join(".gitattributes")).unwrap(), "");
            journal_step(&api, id, r.path(), "undo").await.unwrap();
            assert_eq!(std::fs::read_to_string(r.path().join(".gitattributes")).unwrap(), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
        }

        /// A published repository with three LFS files, and a clone that has them as pointers:
        /// Download fetches one file (escaped, at its commit, from the file remote) and checks
        /// it out; its progress reaches `opProgress`. A file whose object was put in the store
        /// by hand is checked out too.
        #[tokio::test(flavor = "multi_thread")]
        async fn download_fetches_and_checks_out_one_file_from_a_file_remote() {
            let bin = need_lfs!();
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            git(&bin, root, &["init", "-q", "--bare", "-b", "main", "origin.git"], &[]);
            git(&bin, root, &["init", "-q", "-b", "main", "a"], &[]);
            let a = root.join("a");
            git(&bin, &a, &["lfs", "install", "--local"], &[]);
            git(&bin, &a, &["lfs", "track", "*.psd"], &[]);
            std::fs::create_dir_all(a.join("art")).unwrap();
            std::fs::write(a.join("art/logo.psd"), b"the real logo\x00\x01").unwrap();
            std::fs::write(a.join("art/logo[1].psd"), b"the other logo").unwrap();
            std::fs::write(a.join("art/logo1.psd"), b"a third one").unwrap();
            git(&bin, &a, &["add", "."], &[]);
            git(&bin, &a, &["commit", "-q", "-m", "art"], &[]);
            let origin = root.join("origin.git");
            git(&bin, &a, &["remote", "add", "origin", origin.to_str().unwrap()], &[]);
            git(&bin, &a, &["config", "lfs.standalonetransferagent", "lfs-standalone-file"], &[]);
            git(&bin, &a, &["push", "-q", "origin", "main"], &[]);

            git(&bin, root, &["clone", "-q", origin.to_str().unwrap(), "b"], &[("GIT_LFS_SKIP_SMUDGE", "1")]);
            let b = root.join("b");
            git(&bin, &b, &["config", "lfs.standalonetransferagent", "lfs-standalone-file"], &[]);
            git(&bin, &b, &["lfs", "install", "--local"], &[]);
            assert!(std::fs::read_to_string(b.join("art/logo.psd")).unwrap().starts_with("version https://git-lfs"), "cloned as pointers");
            let head = git(&bin, &b, &["rev-parse", "HEAD"], &[]);
            let oid = |bytes: &[u8]| sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();

            let data = tempfile::tempdir().unwrap();
            let api = real_api(&bin, data.path());
            let id = open_at(&api, &b).await;
            let mut events = api.subscribe();
            let count = || walk_count(&b.join(".git/lfs/objects"));
            assert_eq!(count(), 0);
            let res = call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(&b), "path": "art/logo[1].psd", "refs": [head], "oids": [oid(b"the other logo")] })).await.unwrap();
            assert_eq!(count(), 1, "only logo[1]'s object is fetched (escaped: not logo1's)");
            assert_eq!(res["outcome"]["missing"], json!([]));
            assert_eq!(std::fs::read(b.join("art/logo[1].psd")).unwrap(), b"the other logo");
            assert!(std::fs::read_to_string(b.join("art/logo1.psd")).unwrap().starts_with("version https://git-lfs"), "logo[1] isn't a glob for logo1");
            assert!(std::fs::read_to_string(b.join("art/logo.psd")).unwrap().starts_with("version https://git-lfs"));
            let mut phases = Vec::new();
            let mut output = Vec::new();
            loop {
                match events.try_recv() {
                    Ok(AppEvent::OpProgress { phase, percent, .. }) => phases.push((phase, percent)),
                    Ok(AppEvent::OpOutput { line, .. }) => output.push(line),
                    Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
            assert!(phases.iter().any(|(p, pc)| p == "Downloading LFS objects" && pc.is_some()), "git-lfs's progress reaches opProgress: {phases:?}, output {output:?}");
            assert_eq!(git(&bin, &b, &["status", "--porcelain"], &[]), "", "a checked-out LFS file isn't a change");

            // In the store by hand (no transfer needed): checked out all the same.
            let logo = b"the real logo\x00\x01";
            let store = b.join(".git/lfs/objects").join(&oid(logo)[..2]).join(&oid(logo)[2..4]);
            std::fs::create_dir_all(&store).unwrap();
            std::fs::write(store.join(oid(logo)), logo).unwrap();
            call(&api, "lfsDownload", json!({ "repo": id, "worktree": wt(&b), "path": "art/logo.psd", "refs": [], "oids": [oid(logo)] })).await.unwrap();
            assert_eq!(std::fs::read(b.join("art/logo.psd")).unwrap(), logo);
            assert!(std::fs::read_to_string(b.join("art/logo1.psd")).unwrap().starts_with("version https://git-lfs"), "still only the one file");
        }
    }
}
