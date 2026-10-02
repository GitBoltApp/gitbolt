//! Save a working file from the editable working copy (spec #2 §7.5): in the file's loaded
//! encoding, BOM and line endings, atomically (temp + rename in the same folder, mode kept),
//! only if its bytes still hash to the base the editor loaded. Not journaled: the editor's own
//! undo covers it.

use crate::api::Api;
use crate::blob::{decode_blob, safe_join, working_tree_encoding, worktree_id};
use crate::error::{GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::journal::UndoKind;
use crate::payload::Eol;
use crate::write::types::{Expect, WriteResult};
use crate::write::{run_write, Staging, WriteClass, WriteCx, WriteIntent};
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

struct SaveFile {
    path: String,
    text: String,
    base: String,
}

impl WriteIntent for SaveFile {
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
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    fn staging(&self) -> Staging {
        Staging::Keep
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<SaveOutcome, GbError> {
        let file = safe_join(cx.root, &self.path)?;
        let changed = || GbError::stale(format!("{} changed on disk", self.path));
        let meta = std::fs::symlink_metadata(&file).map_err(|_| changed())?;
        if !meta.file_type().is_file() {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} isn't a regular file: edit it in your editor", self.path)));
        }
        if std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o200 == 0 {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is read-only: make it writable first", self.path)));
        }
        let bytes = std::fs::read(&file)?;
        if worktree_id(&bytes) != self.base {
            return Err(changed());
        }
        let declared = working_tree_encoding(&cx.api.cli, cx.root, &self.path).await?;
        let loaded = decode_blob(&bytes, declared.as_deref());
        if loaded.binary {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is binary: edit it in your editor", self.path)));
        }
        let bom = encoding_rs::Encoding::for_bom(&bytes).is_some();
        let out = encode(&self.text, &loaded.encoding, loaded.eol, bom)?;
        write_atomic(&file, &out)?;
        cx.touch(ChangeKind::Worktree);
        Ok(SaveOutcome { hash: worktree_id(&out) })
    }
}

pub(crate) async fn save_file(api: &Api, repo: u32, worktree: &str, path: String, text: String, base: String) -> Result<WriteResult<SaveOutcome>, GbError> {
    run_write(api, repo, worktree, Expect::default(), SaveFile { path, text, base }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Api;
    use crate::payload::Eol;
    use crate::testing::TestRepo;
    use crate::write::test_support::{api, call, open, repo, wt};
    use serde_json::{json, Value};

    async fn save(api: &Api, id: u32, r: &TestRepo, path: &str, text: &str, base: &str) -> Result<Value, crate::error::GbError> {
        call(api, "saveFile", json!({ "repo": id, "worktree": wt(r.path()), "path": path, "text": text, "base": base })).await
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
        assert!(res["journal"]["undo"].is_null(), "saving isn't journaled");
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
        let s = SaveFile { path: "a".into(), text: String::new(), base: String::new() };
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
