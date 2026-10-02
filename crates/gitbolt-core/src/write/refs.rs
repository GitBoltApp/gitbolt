//! Every ref GitBolt moves itself is a CAS: gix's ref transaction with `PreviousValue`
//! (`MustNotExist` / `MustExistAndMatch`) and reflog `AndReference`; or, where gix isn't exact,
//! `git update-ref --stdin -z` (start / create / update / delete / prepare / commit), the same CAS.
//! A mismatch is `RefMoved`, never a silent overwrite.

use crate::error::{gix_err, GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use crate::journal::RefMove;
use crate::write::WriteToken;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::refs::{FullName, Target};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Backend {
    Gix,
    Cli,
}

/// The ref's object id, `None` when it doesn't exist (a symbolic ref is followed).
pub(crate) fn read_ref(repo: &gix::Repository, name: &str) -> Result<Option<String>, GbError> {
    let found = repo.try_find_reference(name).map_err(gix_err)?;
    Ok(found.and_then(|mut r| r.peel_to_id().ok().map(|id| id.detach().to_string())))
}

/// Why the CLI must make the edit (spec #2 §3.4), or `None` when gix can.
pub(crate) fn fallback_reason(ref_storage: Option<&str>, has_tx_hook: bool, has_identity: bool) -> Option<&'static str> {
    if ref_storage.is_some_and(|s| s.eq_ignore_ascii_case("reftable")) {
        return Some("the reftable backend");
    }
    if has_tx_hook {
        // gix runs no hooks.
        return Some("a reference-transaction hook");
    }
    if !has_identity {
        // gix needs a committer for the reflog; git falls back to its own.
        return Some("no committer identity");
    }
    None
}

/// `core.hooksPath` as git resolves it: `~/` from the home dir, relative from the worktree root.
fn hooks_dir(repo: &gix::Repository, workdir: &Path) -> PathBuf {
    match repo.config_snapshot().string("core.hooksPath") {
        Some(p) => {
            let p = p.to_string();
            match (p.strip_prefix("~/"), crate::paths::home_dir()) {
                (Some(rest), Some(home)) => home.join(rest),
                _ if Path::new(&p).is_absolute() => PathBuf::from(p),
                _ => workdir.join(p),
            }
        }
        None => repo.common_dir().join("hooks"),
    }
}

fn executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub(crate) fn backend_for(repo: &gix::Repository, workdir: &Path) -> Backend {
    let storage = repo.config_snapshot().string("extensions.refStorage").map(|s| s.to_string());
    let tx_hook = executable(&hooks_dir(repo, workdir).join("reference-transaction"));
    let identity = repo.committer().is_some_and(|c| c.is_ok());
    match fallback_reason(storage.as_deref(), tx_hook, identity) {
        Some(why) => {
            tracing::debug!(target: "gitbolt_core::write", "ref edit through update-ref: {why}");
            Backend::Cli
        }
        None => Backend::Gix,
    }
}

fn parse(oid: &str) -> Result<gix::ObjectId, GbError> {
    gix::ObjectId::from_hex(oid.as_bytes()).map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {oid}")))
}

fn edits(moves: &[RefMove], message: &str) -> Result<Vec<RefEdit>, GbError> {
    moves
        .iter()
        .map(|m| {
            let name: FullName = m.name.as_str().try_into().map_err(|_| GbError::new(GbErrorKind::InvalidInput, format!("not a ref name: {}", m.name)))?;
            let change = match (&m.old, &m.new) {
                (old, Some(new)) => Change::Update {
                    log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: message.into() },
                    expected: match old {
                        None => PreviousValue::MustNotExist,
                        Some(o) => PreviousValue::MustExistAndMatch(Target::Object(parse(o)?)),
                    },
                    new: Target::Object(parse(new)?),
                },
                (Some(old), None) => Change::Delete { expected: PreviousValue::MustExistAndMatch(Target::Object(parse(old)?)), log: RefLog::AndReference },
                (None, None) => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{}: nothing to do", m.name))),
            };
            Ok(RefEdit { change, name, deref: false })
        })
        .collect()
}

/// How gix words a failed precondition (`ReferenceOutOfDate`, `MustNotExist`, a missing ref).
const GIX_MISMATCH: &[&str] = &["Expected reference content", "Expected the reference not to exist", "must exist with content", "reference to delete must exist", "reference to update must exist"];

fn gix_causes(e: &gix::Error) -> String {
    e.iter_errors().map(|x| x.to_string()).collect::<Vec<_>>().join(" | ")
}

/// A ref lock another process holds: gix's contention, which `gix_cas` waits out.
fn ref_locked(e: &gix::Error) -> bool {
    let all = gix_causes(e);
    !GIX_MISMATCH.iter().any(|n| all.contains(n)) && all.to_ascii_lowercase().contains("lock")
}

/// A held ref lock isn't `IndexLocked` (2A final M7): that toast names `.git/index.lock`, and
/// Remove stale lock handles only that one.
fn classify_gix(e: &gix::Error) -> GbError {
    let shown = e.to_string();
    if GIX_MISMATCH.iter().any(|n| gix_causes(e).contains(n)) {
        GbError::new(GbErrorKind::RefMoved, shown)
    } else if ref_locked(e) {
        GbError::other(format!("Another git process holds a ref lock: try again once it's done ({shown})"))
    } else {
        GbError::other(shown)
    }
}

/// gix fails at once on a held lock where the CLI waits `core.filesRefLockTimeout` (100 ms): wait the same.
fn gix_cas(repo: &gix::Repository, moves: &[RefMove], message: &str) -> Result<(), GbError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        match repo.edit_references(edits(moves, message)?) {
            Ok(_) => return Ok(()),
            Err(e) => {
                if !ref_locked(&e) || std::time::Instant::now() >= deadline {
                    return Err(classify_gix(&e));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}

/// Moves name concrete `refs/...` refs: gix (`deref: false`) would replace a symbolic ref with an
/// oid where `update-ref` follows it, so a symbolic ref (HEAD, or an existing symref) is refused.
fn concrete_only(repo: &gix::ThreadSafeRepository, moves: &[RefMove]) -> Result<(), GbError> {
    let repo = repo.to_thread_local();
    for m in moves {
        let bad = || GbError::new(GbErrorKind::InvalidInput, format!("{}: ref moves name concrete refs, not symbolic ones", m.name));
        if !m.name.starts_with("refs/") {
            return Err(bad());
        }
        if let Some(r) = repo.try_find_reference(m.name.as_str()).map_err(gix_err)?
            && matches!(r.target(), gix::refs::TargetRef::Symbolic(_))
        {
            return Err(bad());
        }
    }
    Ok(())
}

/// `update-ref --stdin -z` input: one transaction, NUL-separated fields.
fn transaction(moves: &[RefMove]) -> Result<Vec<u8>, GbError> {
    let mut input = b"start\0".to_vec();
    for m in moves {
        let line = match (&m.old, &m.new) {
            (None, Some(new)) => format!("create {}\0{new}\0", m.name),
            (Some(old), Some(new)) => format!("update {}\0{new}\0{old}\0", m.name),
            (Some(old), None) => format!("delete {}\0{old}\0", m.name),
            (None, None) => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{}: nothing to do", m.name))),
        };
        input.extend_from_slice(line.as_bytes());
    }
    input.extend_from_slice(b"prepare\0commit\0");
    Ok(input)
}

/// The first ref of `moves` whose current value isn't the move's `old`: what a failed CAS means.
fn moved(repo: &gix::ThreadSafeRepository, moves: &[RefMove]) -> Option<GbError> {
    let repo = repo.to_thread_local();
    moves.iter().find(|m| read_ref(&repo, &m.name).ok().is_some_and(|now| now != m.old)).map(|m| GbError::ref_moved(&m.name))
}

pub(crate) async fn cas(cli: &GitCli, token: &WriteToken, repo: &gix::ThreadSafeRepository, workdir: &Path, moves: &[RefMove], message: &str) -> Result<(), GbError> {
    let backend = backend_for(&repo.to_thread_local(), workdir);
    cas_with(backend, cli, token, repo, workdir, moves, message).await
}

pub(crate) async fn cas_with(backend: Backend, cli: &GitCli, token: &WriteToken, repo: &gix::ThreadSafeRepository, workdir: &Path, moves: &[RefMove], message: &str) -> Result<(), GbError> {
    if moves.is_empty() {
        return Ok(());
    }
    concrete_only(repo, moves)?;
    let res = match backend {
        Backend::Gix => {
            let (r, m, msg) = (repo.clone(), moves.to_vec(), message.to_string());
            tokio::task::spawn_blocking(move || gix_cas(&r.to_thread_local(), &m, &msg)).await.map_err(|e| GbError::other(format!("ref edit failed: {e}")))?
        }
        Backend::Cli => {
            let input = transaction(moves)?;
            cli.run(GitInvocation::write(token, workdir, ["update-ref", "-m", message, "--stdin", "-z"]).stdin(input)).await.map(drop)
        }
    };
    // Only a CAS mismatch is `RefMoved` (naming the first ref that moved); lock and IO errors keep their own kinds.
    res.map_err(|e| if e.kind == GbErrorKind::RefMoved { moved(repo, moves).unwrap_or(e) } else { e })
}

// --- 2C T6: a detached HEAD's CAS ---
/// A detached HEAD's own CAS (Deviation 3): `refs/`-only `cas` refuses HEAD, and gix would
/// replace a symbolic HEAD with an oid. `--no-deref` updates HEAD itself, only if it's `old`.
pub(crate) async fn cas_detached_head(cli: &GitCli, token: &WriteToken, root: &Path, old: &str, new: &str, message: &str) -> Result<(), GbError> {
    cli.run(GitInvocation::write(token, root, ["update-ref", "--no-deref", "-m", message, "HEAD", new, old])).await.map(drop)
}
// --- end 2C T6 ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GbErrorKind;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    /// A repo whose own config has an identity: gix reads it for the reflog (never the developer's).
    fn repo() -> (TestRepo, String, String) {
        let r = TestRepo::new();
        r.git(&["config", "user.name", "Ada Lovelace"]);
        r.git(&["config", "user.email", "ada@example.com"]);
        let c1 = r.commit("one");
        let c2 = r.commit("two");
        (r, c1, c2)
    }

    fn open(r: &TestRepo) -> gix::ThreadSafeRepository {
        gix::ThreadSafeRepository::open(r.path()).unwrap()
    }

    fn mv(name: &str, old: Option<&str>, new: Option<&str>) -> RefMove {
        RefMove { name: name.into(), old: old.map(str::to_string), new: new.map(str::to_string) }
    }

    fn at(r: &TestRepo, name: &str) -> Option<String> {
        r.try_git(&["rev-parse", "--verify", "-q", name]).ok()
    }

    #[tokio::test]
    async fn creates_moves_and_deletes_with_a_reflog_message_on_both_backends() {
        for backend in [Backend::Gix, Backend::Cli] {
            let (r, c1, c2) = repo();
            let (repo, t) = (open(&r), WriteToken::for_tests());
            cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/x", None, Some(&c1))], "gitbolt: test create").await.unwrap();
            assert_eq!(at(&r, "refs/heads/x").as_deref(), Some(c1.as_str()), "{backend:?}");
            let log = crate::reflog::read_reflog(&r.path().join(".git"), "refs/heads/x").unwrap();
            assert_eq!(log[0].message, "gitbolt: test create", "{backend:?}");
            cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/x", Some(&c1), Some(&c2))], "gitbolt: test move").await.unwrap();
            assert_eq!(at(&r, "refs/heads/x").as_deref(), Some(c2.as_str()));
            cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/x", Some(&c2), None)], "gitbolt: test delete").await.unwrap();
            assert_eq!(at(&r, "refs/heads/x"), None, "{backend:?}");
        }
    }

    #[tokio::test]
    async fn a_mismatch_is_ref_moved_and_changes_nothing() {
        for backend in [Backend::Gix, Backend::Cli] {
            let (r, c1, c2) = repo();
            let (repo, t) = (open(&r), WriteToken::for_tests());
            r.git(&["branch", "x", &c1]);
            // Expected x at c2, but it's at c1.
            let err = cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/x", Some(&c2), Some(&c1))], "m").await.unwrap_err();
            assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::RefMoved, "x changed outside GitBolt"), "{backend:?}");
            // Create something that exists.
            let err = cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/x", None, Some(&c2))], "m").await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::RefMoved, "{backend:?}");
            // A transaction is all or nothing: y is created only if x matches too.
            let err = cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/y", None, Some(&c2)), mv("refs/heads/x", Some(&c2), Some(&c2))], "m").await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::RefMoved);
            assert_eq!(at(&r, "refs/heads/y"), None, "{backend:?}");
            assert_eq!(at(&r, "refs/heads/x").as_deref(), Some(c1.as_str()));
        }
    }

    #[test]
    fn the_cli_takes_over_where_gix_isnt_exact() {
        assert_eq!(fallback_reason(None, false, true), None);
        assert_eq!(fallback_reason(Some("reftable"), false, true), Some("the reftable backend"));
        assert_eq!(fallback_reason(Some("files"), false, true), None);
        assert_eq!(fallback_reason(None, true, true), Some("a reference-transaction hook"));
        assert_eq!(fallback_reason(None, false, false), Some("no committer identity"));
    }

    #[tokio::test]
    async fn a_reference_transaction_hook_runs_because_the_cli_does_the_edit() {
        let (r, c1, _) = repo();
        let marker = r.root().join("tx-hook-ran");
        let hook = r.path().join(".git/hooks/reference-transaction");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, format!("#!/bin/sh\ncat >/dev/null\ntouch {}\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let repo = open(&r);
        assert_eq!(backend_for(&repo.to_thread_local(), r.path()), Backend::Cli);
        cas(&cli(), &WriteToken::for_tests(), &repo, r.path(), &[mv("refs/heads/x", None, Some(&c1))], "m").await.unwrap();
        assert!(marker.exists(), "git ran the hook");
    }

    #[test]
    fn a_relative_hooks_path_is_resolved_from_the_worktree() {
        let (r, _, _) = repo();
        let dir = r.path().join("myhooks");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("reference-transaction"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(dir.join("reference-transaction"), std::fs::Permissions::from_mode(0o755)).unwrap();
        r.git(&["config", "core.hooksPath", "myhooks"]);
        assert_eq!(backend_for(&open(&r).to_thread_local(), r.path()), Backend::Cli);
        std::fs::set_permissions(dir.join("reference-transaction"), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(backend_for(&open(&r).to_thread_local(), r.path()), Backend::Gix, "a hook git wouldn't run doesn't count");
    }

    #[tokio::test]
    async fn symbolic_refs_are_refused_and_a_held_lock_is_not_ref_moved() {
        for backend in [Backend::Gix, Backend::Cli] {
            let (r, c1, c2) = repo();
            let (repo, t) = (open(&r), WriteToken::for_tests());
            let err = cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("HEAD", Some(&c2), Some(&c1))], "m").await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{backend:?}");
            r.git(&["branch", "x", &c1]);
            std::fs::write(r.path().join(".git/refs/heads/x.lock"), "").unwrap();
            let err = cas_with(backend, &cli(), &t, &repo, r.path(), &[mv("refs/heads/x", Some(&c1), Some(&c2))], "m").await.unwrap_err();
            assert_ne!(err.kind, GbErrorKind::RefMoved, "{backend:?}: {err:?}");
            if matches!(backend, Backend::Gix) {
                assert_eq!(err.kind, GbErrorKind::Other, "a ref lock isn't index.lock (2A final M7): {err:?}");
            }
            assert_eq!(at(&r, "refs/heads/x").as_deref(), Some(c1.as_str()));
        }
    }
}
