//! Save a working file from the editable working copy (spec #2 §7.5, UX round 2 G.2): in the
//! file's loaded encoding, BOM and line endings, atomically (temp + rename in the same folder,
//! mode kept), only if its bytes still hash to the base the editor loaded. Journaled (G.2
//! reverses §7.5's "not journaled"): Undo puts the file back as it was before the save.

use crate::api::Api;
use crate::blob::{decode_blob, safe_join, working_tree_encoding, worktree_id};
use crate::error::{GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::{snapshot, UndoKind};
use crate::payload::Eol;
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, Plan, Pre, Staging, WriteClass, WriteCx, WriteIntent};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveOutcome {
    /// The written bytes' `worktree_id`: the editor's next base.
    pub hash: String,
}

/// `text` in `encoding` (as `decode_blob` named it), with the file's line endings (`Mixed` and
/// `None` keep the editor's) and its BOM when it had one.
pub(crate) fn encode(text: &str, encoding: &str, eol: Eol, bom: bool) -> Result<Vec<u8>, GbError> {
    let text = match eol {
        Eol::Crlf => text.replace("\r\n", "\n").replace('\n', "\r\n"),
        Eol::Lf => text.replace("\r\n", "\n"),
        Eol::Mixed | Eol::None => text.to_string(),
    };
    let bad = || GbError::new(GbErrorKind::InvalidInput, format!("This text can't be saved as {encoding}"));
    let utf16 = |le: bool| {
        let mut out = if bom { if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] } } else { Vec::new() };
        for u in text.encode_utf16() {
            out.extend(if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        out
    };
    Ok(match encoding {
        "UTF-8" => text.into_bytes(),
        "UTF-8 BOM" => [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat(),
        "UTF-16LE" => utf16(true),
        "UTF-16BE" => utf16(false),
        // `decode_blob`'s Latin-1 maps each byte to the char of that value; this is its inverse.
        "ISO-8859-1" => text.chars().map(|c| u8::try_from(u32::from(c)).map_err(|_| bad())).collect::<Result<_, _>>()?,
        other => {
            let enc = encoding_rs::Encoding::for_label(other.as_bytes()).ok_or_else(bad)?;
            let (out, _, had_errors) = enc.encode(&text);
            if had_errors {
                return Err(bad());
            }
            out.into_owned()
        }
    })
}

/// Temp file in the same folder, the old mode, fsync, rename over.
pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> Result<(), GbError> {
    let dir = file.parent().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "no folder to save into"))?;
    let perms = std::fs::metadata(file)?.permissions();
    let mut tmp = tempfile::Builder::new().prefix(".gitbolt-save-").tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    std::fs::set_permissions(tmp.path(), perms)?;
    tmp.persist(file).map_err(|e| GbError::from(e.error))?;
    // Make the rename itself durable; best effort (some filesystems can't fsync a directory).
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// What `plan` checked under the lock, for `run` to write.
#[derive(Default)]
struct Checked {
    file: Option<std::path::PathBuf>,
    bytes: Vec<u8>,
}

/// An edit of a working-tree file, saved (§7.5; UX round 2 G.2). Journaled: a `before` and an
/// `after` snapshot of its one path, as a discard's (§5.3), so Undo puts the file back as it was
/// and Redo as saved.
struct WriteWorktreeFile {
    path: String,
    text: String,
    base: String,
    checked: std::sync::Mutex<Checked>,
}

/// A path inside a nested repository (a submodule, an embedded clone): that repository's file,
/// which this one's snapshot can't carry.
fn in_nested_repo(root: &Path, rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut dir = root.to_path_buf();
    parts[..parts.len().saturating_sub(1)].iter().any(|p| {
        dir.push(p);
        dir.join(".git").symlink_metadata().is_ok()
    })
}

/// Whether the index tracks `path`. A conflicted entry is the merge tool's, and an intent-to-add
/// one can't come back on Undo (as a discard's, §7.4): both refused.
fn tracked(root: &Path, path: &str) -> Result<bool, GbError> {
    use gix::index::entry::Flags;
    let gix_err = |e: &dyn std::fmt::Display| GbError::other(e.to_string());
    let repo = gix::open(root).map_err(|e| gix_err(&e))?;
    let index = repo.index_or_empty().map_err(|e| gix_err(&e))?;
    let mut found = false;
    for e in index.entries().iter().filter(|e| e.path(&index) == path.as_bytes()) {
        if e.stage_raw() != 0 {
            return Err(GbError::new(GbErrorKind::InProgress, format!("{path} has merge conflicts: resolve it in the merge tool")));
        }
        if e.flags.contains(Flags::INTENT_TO_ADD) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is intent-to-add (git add -N): stage it or unstage it first")));
        }
        found = true;
    }
    Ok(found)
}

impl WriteWorktreeFile {
    fn changed(&self) -> GbError {
        GbError::stale(format!("{} changed on disk", self.path))
    }
}

impl WriteIntent for WriteWorktreeFile {
    type Outcome = SaveOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Save
    }
    fn label(&self) -> String {
        format!("save {}", self.path)
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Restore)
    }
    /// An Edit stop (spec #3 §3.5) is where editing a file matters most.
    fn allowed_in_progress(&self) -> bool {
        true
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    /// Saves of one file in a row are one entry: Undo goes back to before the first.
    fn coalesces(&self) -> bool {
        true
    }
    /// Every refusal comes before the snapshot, so a refused save leaves no journal entry: a path
    /// outside the worktree (`..`, absolute, through a symlinked folder, into `.git` or a nested
    /// repository), anything but a regular, writable text file, a base that no longer matches
    /// (Stale), text the file's encoding can't hold.
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let file = safe_join(pre.root, &self.path)?;
        if in_nested_repo(pre.root, &self.path) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is in a nested repository: edit it there", self.path)));
        }
        let meta = std::fs::symlink_metadata(&file).map_err(|_| self.changed())?;
        if !meta.file_type().is_file() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} isn't a regular file: edit it in your editor", self.path)));
        }
        if std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o200 == 0 {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is read-only: make it writable first", self.path)));
        }
        let bytes = std::fs::read(&file)?;
        if worktree_id(&bytes) != self.base {
            return Err(self.changed());
        }
        let declared = working_tree_encoding(&pre.api.cli, pre.root, &self.path).await?;
        let loaded = decode_blob(&bytes, declared.as_deref());
        if loaded.binary {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is binary: edit it in your editor", self.path)));
        }
        let bom = encoding_rs::Encoding::for_bom(&bytes).is_some();
        let out = encode(&self.text, &loaded.encoding, loaded.eol, bom)?;
        let untracked = if tracked(pre.root, &self.path)? { Vec::new() } else { vec![self.path.clone()] };
        *self.checked.lock().map_err(|_| GbError::other("the save's plan is poisoned"))? = Checked { file: Some(file), bytes: out };
        Ok(Plan { snapshot: Some((vec![self.path.clone()], untracked)), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<SaveOutcome, GbError> {
        let snap = cx.snapshot.clone().ok_or_else(|| GbError::other("the save has no snapshot"))?;
        let Checked { file, bytes } = std::mem::take(&mut *self.checked.lock().map_err(|_| GbError::other("the save's plan is poisoned"))?);
        let file = file.ok_or_else(|| GbError::other("the save has no plan"))?;
        // Changed since the plan (another program): the snapshot may not hold what the user
        // loaded, so nothing is written.
        if std::fs::read(&file).map(|b| worktree_id(&b) != self.base).unwrap_or(true) {
            return Err(self.changed());
        }
        cx.partial = true;
        write_atomic(&file, &bytes)?;
        cx.after = Some(snapshot::create(&cx.snapshots(), &self.label(), &snap.paths, &snap.untracked).await?);
        cx.touch(ChangeKind::Worktree);
        Ok(SaveOutcome { hash: worktree_id(&bytes) })
    }
}

pub(crate) async fn write_worktree_file(api: &Api, repo: u32, worktree: &str, path: String, text: String, base: String) -> Result<WriteResult<SaveOutcome>, GbError> {
    run_write(api, repo, worktree, Expect::default(), WriteWorktreeFile { path, text, base, checked: Default::default() }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Api;
    use crate::payload::Eol;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, journal_step, open, repo, wt};
    use serde_json::{json, Value};

    async fn save(api: &Api, id: u32, r: &TestRepo, path: &str, text: &str, base: &str) -> Result<Value, crate::error::GbError> {
        call(api, "writeWorktreeFile", json!({ "repo": id, "worktree": wt(r.path()), "path": path, "text": text, "base": base })).await
    }

    fn base(r: &TestRepo, path: &str) -> String {
        crate::blob::worktree_id(&std::fs::read(r.path().join(path)).unwrap())
    }

    #[test]
    fn encode_keeps_the_loaded_encoding_bom_and_line_endings() {
        assert_eq!(encode("a\nb\n", "UTF-8", Eol::Crlf, false).unwrap(), b"a\r\nb\r\n");
        assert_eq!(encode("a\r\nb\n", "UTF-8", Eol::Lf, false).unwrap(), b"a\nb\n");
        assert_eq!(encode("é\n", "UTF-8 BOM", Eol::Lf, true).unwrap(), b"\xEF\xBB\xBF\xC3\xA9\n");
        assert_eq!(encode("é", "UTF-16LE", Eol::None, true).unwrap(), [0xFF, 0xFE, 0xE9, 0x00]);
        assert_eq!(encode("é", "UTF-16BE", Eol::None, false).unwrap(), [0x00, 0xE9], "no BOM unless the file had one");
        assert_eq!(encode("é\n", "ISO-8859-1", Eol::Lf, false).unwrap(), b"\xE9\n");
        let err = encode("€ and ✓", "ISO-8859-1", Eol::Lf, false).unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::InvalidInput);
        assert_eq!(err.message, "This text can't be saved as ISO-8859-1");
    }

    #[tokio::test]
    async fn a_save_writes_atomically_keeps_the_mode_and_returns_the_new_hash() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("run.sh", "#!/bin/sh\r\necho hi\r\n");
        std::fs::set_permissions(r.path().join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let res = save(&api, id, &r, "run.sh", "#!/bin/sh\necho bye\n", &base(&r, "run.sh")).await.unwrap();
        assert_eq!(std::fs::read(r.path().join("run.sh")).unwrap(), b"#!/bin/sh\r\necho bye\r\n", "CRLF kept");
        assert_eq!(std::fs::metadata(r.path().join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(res["outcome"]["hash"], base(&r, "run.sh"));
        let unstaged: Vec<&str> = res["wip"]["unstaged"]["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(unstaged, ["run.sh"], "the response's lists refresh the panel (§7.5)");
        assert_eq!(res["journal"]["undo"]["label"], "save run.sh", "a save is journaled (G.2)");
        let leftovers: Vec<_> = std::fs::read_dir(r.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".gitbolt-save")).collect();
        assert!(leftovers.is_empty());
    }

    #[tokio::test]
    async fn a_stale_base_is_refused_and_the_file_is_untouched() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let shown = base(&r, "a.txt");
        r.write("a.txt", "changed on disk\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = save(&api, id, &r, "a.txt", "mine\n", &shown).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
        assert_eq!(err.message, "a.txt changed on disk");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "changed on disk\n");
        let state = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(state["undo"]["entry"].is_null(), "a refused save leaves no journal entry: {state}");
    }

    /// G.2: Undo puts the file back as it was before the save, Redo as saved; the index (a
    /// staged half) is left as it was. An untracked file round-trips too.
    #[tokio::test]
    async fn undo_restores_the_file_and_redo_saves_it_again() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("a.txt", "staged\n");
        r.git(&["add", "a.txt"]);
        r.write("a.txt", "staged\nunstaged\n");
        r.write("new.txt", "untracked\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let staged = r.git(&["diff", "--cached"]);
        for (path, before) in [("a.txt", "staged\nunstaged\n"), ("new.txt", "untracked\n")] {
            let res = save(&api, id, &r, path, "edited\n", &base(&r, path)).await.unwrap();
            assert_eq!(res["journal"]["undo"]["label"], format!("save {path}"));
            assert_eq!(std::fs::read_to_string(r.path().join(path)).unwrap(), "edited\n");
            journal_step(&api, id, r.path(), "undo").await.unwrap();
            assert_eq!(std::fs::read_to_string(r.path().join(path)).unwrap(), before, "undo: {path} as it was");
            journal_step(&api, id, r.path(), "redo").await.unwrap();
            assert_eq!(std::fs::read_to_string(r.path().join(path)).unwrap(), "edited\n", "redo: {path} as saved");
        }
        assert_eq!(r.git(&["diff", "--cached"]), staged, "the index is untouched");
        assert_eq!(r.git(&["ls-files", "new.txt"]), "", "still untracked");
    }

    fn undo_depth(state: &Value) -> Option<u64> {
        state["undo"]["entry"].as_u64()
    }

    /// The coordinator's ruling: saves of one file in a row coalesce into the first's entry (its
    /// `before`, the last one's `after`). One Undo goes back to before the editing session; Redo
    /// to the last save. Anything changed in between (here, the file staged) starts a new entry.
    #[tokio::test]
    async fn saves_of_one_file_in_a_row_are_one_undo_step() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-q", "-m", "b"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let first = save(&api, id, &r, "a.txt", "one\n", &base(&r, "a.txt")).await.unwrap();
        let entry = undo_depth(&first["journal"]).unwrap();
        let second = save(&api, id, &r, "a.txt", "two\n", &base(&r, "a.txt")).await.unwrap();
        assert_eq!(undo_depth(&second["journal"]), Some(entry), "merged into the first save's entry");
        save(&api, id, &r, "a.txt", "three\n", &base(&r, "a.txt")).await.unwrap();
        // Another file's save is its own entry.
        let other = save(&api, id, &r, "b.txt", "b2\n", &base(&r, "b.txt")).await.unwrap();
        assert_ne!(undo_depth(&other["journal"]), Some(entry));
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("b.txt")).unwrap(), "b\n");
        let state = journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a\n", "one Undo: before the first save");
        assert!(undo_depth(&state["journal"]).is_none(), "nothing older: {state}");
        journal_step(&api, id, r.path(), "redo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "three\n", "Redo: the last save");
        // Changed in between (staged): a new entry, so Undo stops at the staged state.
        r.git(&["add", "a.txt"]);
        let staged = save(&api, id, &r, "a.txt", "four\n", &base(&r, "a.txt")).await.unwrap();
        assert_ne!(undo_depth(&staged["journal"]), Some(entry));
        journal_step(&api, id, r.path(), "undo").await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "three\n");
    }

    #[tokio::test]
    async fn a_conflicted_file_or_one_in_a_nested_repository_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        std::fs::create_dir(r.path().join("inner")).unwrap();
        r.git(&["-C", "inner", "init", "-q"]);
        std::fs::write(r.path().join("inner/x.txt"), "inner\n").unwrap();
        // A conflict on a.txt: two branches change it.
        r.git(&["checkout", "-q", "-b", "other"]);
        r.write("a.txt", "theirs\n");
        r.git(&["commit", "-q", "-am", "theirs"]);
        r.git(&["checkout", "-q", "-"]);
        r.write("a.txt", "ours\n");
        r.git(&["commit", "-q", "-am", "ours"]);
        assert!(r.try_git(&["merge", "other"]).is_err(), "conflicts");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = save(&api, id, &r, "a.txt", "x\n", &base(&r, "a.txt")).await.unwrap_err();
        assert!(err.message.contains("merge conflicts"), "{}", err.message);
        let err = save(&api, id, &r, "inner/x.txt", "x\n", &base(&r, "inner/x.txt")).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::InvalidInput);
        assert_eq!(std::fs::read_to_string(r.path().join("inner/x.txt")).unwrap(), "inner\n");
    }

    #[tokio::test]
    async fn a_symlink_or_a_binary_file_is_never_written() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        std::os::unix::fs::symlink("a.txt", r.path().join("link.txt")).unwrap();
        r.write_bytes("b.bin", b"\0\x01binary");
        let api = api(data.path());
        let id = open(&api, &r).await;
        let link_base = crate::blob::worktree_id(b"a.txt");
        assert_eq!(save(&api, id, &r, "link.txt", "x", &link_base).await.unwrap_err().kind, crate::error::GbErrorKind::InvalidInput);
        assert!(std::fs::symlink_metadata(r.path().join("link.txt")).unwrap().file_type().is_symlink(), "still a link");
        assert_eq!(save(&api, id, &r, "b.bin", "x", &base(&r, "b.bin")).await.unwrap_err().kind, crate::error::GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn a_bom_and_utf16_file_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write_bytes("u16.txt", &[0xFF, 0xFE, b'h', 0, b'i', 0, b'\n', 0]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        save(&api, id, &r, "u16.txt", "hé\n", &base(&r, "u16.txt")).await.unwrap();
        assert_eq!(std::fs::read(r.path().join("u16.txt")).unwrap(), [0xFF, 0xFE, b'h', 0, 0xE9, 0, b'\n', 0]);
    }

    #[test]
    fn a_save_leaves_the_staging_log_alone() {
        let s = WriteWorktreeFile { path: "a".into(), text: String::new(), base: String::new(), checked: Default::default() };
        assert_eq!(s.staging(), Staging::Keep);
    }

    #[tokio::test]
    async fn paths_outside_the_worktree_or_into_dot_git_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("x"), "out\n").unwrap();
        let r = repo();
        std::os::unix::fs::symlink(outside.path(), r.path().join("linkdir")).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let abs = outside.path().join("x").display().to_string();
        let b = crate::blob::worktree_id(b"out\n");
        for p in ["../x", abs.as_str(), ".git/config", "linkdir/x"] {
            assert!(save(&api, id, &r, p, "pwned\n", &b).await.is_err(), "{p}");
        }
        assert_eq!(std::fs::read_to_string(outside.path().join("x")).unwrap(), "out\n");
    }

    #[tokio::test]
    async fn a_read_only_or_missing_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        let b = base(&r, "a.txt");
        std::fs::set_permissions(r.path().join("a.txt"), std::fs::Permissions::from_mode(0o444)).unwrap();
        let api = api(data.path());
        let id = open(&api, &r).await;
        let err = save(&api, id, &r, "a.txt", "x\n", &b).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::InvalidInput);
        assert!(err.message.contains("read-only"), "{}", err.message);
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "a\n");
        let err = save(&api, id, &r, "gone.txt", "x", &b).await.unwrap_err();
        assert_eq!(err.kind, crate::error::GbErrorKind::Stale);
    }

    #[tokio::test]
    async fn a_latin1_file_round_trips() {
        let data = tempfile::tempdir().unwrap();
        let r = repo();
        r.write_bytes("l1.txt", b"caf\xE9\n");
        let api = api(data.path());
        let id = open(&api, &r).await;
        save(&api, id, &r, "l1.txt", "caf\u{e9} au lait\n", &base(&r, "l1.txt")).await.unwrap();
        assert_eq!(std::fs::read(r.path().join("l1.txt")).unwrap(), b"caf\xE9 au lait\n");
    }
}
