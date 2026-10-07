//! Hex dumps of binary files, for File View and the hex diff (phase 3 UX round 2, lane I). Each
//! side's first `HEX_CAP` bytes are read, never the whole file: a working-tree file through
//! `take`, a small blob from the object database, and a larger blob streamed by
//! `git cat-file blob` with its stdout capped (gix has no streaming blob read).

use crate::blob::{is_binary_head, resolve, Resolved, Side};
use crate::diff::BINARY_SNIFF_BYTES;
use crate::error::{gix_err, GbError};
use crate::git::{GitCli, GitInvocation};
use crate::payload::{DiffContentsPayload, HexDumpPayload, HexSide};
use gix::ObjectId;
use std::io::Read;
use std::path::Path;

/// The most bytes dumped per side: 16 384 lines of 16.
pub const HEX_CAP: u64 = 256 * 1024;
const LINE_BYTES: usize = 16;

/// `bytes` as `hexdump -C` lines without its squeezing (`*`) or its closing offset line: the
/// offset, two groups of eight bytes, then the bytes as ASCII ('.' for anything not printable).
/// A short last line is padded so its ASCII column lines up.
/// `00000000  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |Hello world.|`
pub fn hex_lines(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len().div_ceil(LINE_BYTES) * 79);
    for (i, line) in bytes.chunks(LINE_BYTES).enumerate() {
        let _ = write!(out, "{:08x}  ", i * LINE_BYTES);
        for j in 0..LINE_BYTES {
            match line.get(j) {
                Some(b) => {
                    let _ = write!(out, "{b:02x} ");
                }
                None => out.push_str("   "),
            }
            if j == 7 {
                out.push(' ');
            }
        }
        out.push_str(" |");
        out.extend(line.iter().map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '.' }));
        out.push_str("|\n");
    }
    out
}

/// A side's size and first bytes, or a blob too large to load from the object database.
enum Head {
    Bytes { size: u64, bytes: Vec<u8> },
    LargeBlob { size: u64, oid: ObjectId },
}

fn read_head(repo: &gix::Repository, path: &str, side: &Side, cap: u64) -> Result<Option<Head>, GbError> {
    let Some(resolved) = resolve(repo, path, side)? else { return Ok(None) };
    let size = resolved.size(repo)?;
    let bytes = match resolved {
        Resolved::Blob(oid) if size > cap => return Ok(Some(Head::LargeBlob { size, oid })),
        Resolved::Blob(oid) => repo.find_object(oid).map_err(gix_err)?.detach().data,
        Resolved::Text(t) => t.into_bytes(),
        Resolved::File { path, .. } => {
            let mut bytes = Vec::new();
            std::fs::File::open(path)?.take(cap).read_to_end(&mut bytes)?;
            bytes
        }
        Resolved::Link(path) => std::fs::read_link(path)?.to_string_lossy().into_owned().into_bytes(),
    };
    Ok(Some(Head::Bytes { size, bytes }))
}

fn side(size: u64, mut bytes: Vec<u8>, cap: u64) -> HexSide {
    bytes.truncate(cap as usize);
    // A working-tree file that grew or shrank since its size was read: the bytes read are what's shown.
    let size = if (bytes.len() as u64) < cap { bytes.len() as u64 } else { size.max(cap) };
    HexSide { size, shown: bytes.len() as u64, dump: hex_lines(&bytes) }
}

/// A side's size and its first `cap` bytes (at most), or `None` for no such side.
async fn side_head(repo: &gix::ThreadSafeRepository, cli: &GitCli, cwd: &Path, path: &str, s: Side, cap: u64) -> Result<Option<(u64, Vec<u8>)>, GbError> {
    let (repo, path_owned) = (repo.clone(), path.to_string());
    let head = crate::api::blocking(move || read_head(&repo.to_thread_local(), &path_owned, &s, cap)).await?;
    Ok(match head {
        None => None,
        Some(Head::Bytes { size, bytes }) => Some((size, bytes)),
        Some(Head::LargeBlob { size, oid }) => {
            let out = cli.run(GitInvocation::new(cwd, ["cat-file".to_string(), "blob".to_string(), oid.to_string()]).stdout_limit(cap)).await?;
            Some((size, out.stdout))
        }
    })
}

async fn dump_side(repo: &gix::ThreadSafeRepository, cli: &GitCli, cwd: &Path, path: &str, s: Side, cap: u64) -> Result<Option<HexSide>, GbError> {
    Ok(side_head(repo, cli, cwd, path, s, cap).await?.map(|(size, bytes)| side(size, bytes, cap)))
}

/// A diff held back by the large-file gates (`too_large`) whose old or new side is binary
/// (`is_binary_head` on its first `BINARY_SNIFF_BYTES`, read without the rest) isn't held back:
/// it shows as a capped hex dump, so its size doesn't matter. Those sides are marked binary and
/// `too_large` cleared. Text files and images keep the gates.
pub async fn ungate_binary(repo: &gix::ThreadSafeRepository, cli: &GitCli, cwd: &Path, path: &str, old: &Side, new: &Side, c: &mut DiffContentsPayload) -> Result<(), GbError> {
    if !c.too_large || c.image {
        return Ok(());
    }
    let mut binary = false;
    for (s, payload) in [(old, &mut c.old), (new, &mut c.new)] {
        let Some(p) = payload else { continue };
        let declared = match s {
            Side::Worktree { encoding, .. } => encoding.as_deref(),
            _ => None,
        };
        if let Some((_, head)) = side_head(repo, cli, cwd, path, s.clone(), BINARY_SNIFF_BYTES as u64).await?
            && is_binary_head(&head, declared)
        {
            p.binary = true;
            binary = true;
        }
    }
    c.too_large &= !binary;
    Ok(())
}

/// Both sides of `path` as hex dumps of at most `cap` bytes each. `cwd`: where `git cat-file`
/// runs for a large blob (the repository's working directory).
pub async fn hex_dump(repo: &gix::ThreadSafeRepository, cli: &GitCli, cwd: &Path, path: &str, old: Side, new: Side, cap: u64) -> Result<HexDumpPayload, GbError> {
    let old = dump_side(repo, cli, cwd, path, old, cap).await?;
    let new = dump_side(repo, cli, cwd, path, new, cap).await?;
    Ok(HexDumpPayload { old, new, cap })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, TestRepo};
    use std::sync::Arc;

    #[test]
    fn lines_follow_hexdump_c() {
        assert_eq!(hex_lines(b"Hello world\n"), "00000000  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |Hello world.|\n");
        let two = hex_lines(&(0u8..20).collect::<Vec<_>>());
        let lines: Vec<&str> = two.lines().collect();
        assert_eq!(lines[0], "00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|");
        assert_eq!(lines[1], "00000010  10 11 12 13                                       |....|");
        assert_eq!(lines[0].find('|'), lines[1].find('|'), "the ASCII column lines up");
        assert_eq!(hex_lines(b""), "");
        assert_eq!(hex_lines(b"~\x7f\x80 "), "00000000  7e 7f 80 20                                       |~.. |\n");
    }

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(10))).with_env(crate::testing::isolated_git_env())
    }

    #[tokio::test]
    async fn dumps_both_sides_of_a_binary_and_an_absent_side_is_none() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap().into_sync();
        let oid = |spec: &str| Side::Object(ObjectId::from_hex(r.git(&["rev-parse", spec]).as_bytes()).unwrap());
        let p = hex_dump(&repo, &cli(), r.path(), "data.bin", oid("HEAD^1^1:data.bin"), oid("HEAD^1:data.bin"), HEX_CAP).await.unwrap();
        let (old, new) = (p.old.unwrap(), p.new.unwrap());
        assert_eq!((old.size, old.shown, new.size, new.shown), (9, 9, 10, 10));
        assert_eq!(old.dump, "00000000  42 49 4e 00 01 02 6f 6c  64                       |BIN...old|\n");
        assert!(new.dump.ends_with("|BIN...new!|\n"));
        let added = hex_dump(&repo, &cli(), r.path(), "data.bin", Side::Absent, oid("HEAD^1:data.bin"), HEX_CAP).await.unwrap();
        assert!(added.old.is_none() && added.new.is_some());
        assert_eq!(added.cap, HEX_CAP);
    }

    #[tokio::test]
    async fn large_sides_are_capped_and_never_read_whole() {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap().into_sync();
        // A blob over the cap streams through `git cat-file`, capped.
        let big = Side::Object(ObjectId::from_hex(r.git(&["rev-parse", "HEAD^1:big.txt"]).as_bytes()).unwrap());
        let p = hex_dump(&repo, &cli(), r.path(), "big.txt", Side::Absent, big, 64).await.unwrap().new.unwrap();
        assert!(p.size > 2 * 1024 * 1024, "{}", p.size);
        assert_eq!(p.shown, 64);
        assert_eq!(p.dump.lines().count(), 4);
        assert!(p.dump.starts_with("00000000  6c 69 6e 65 20 30 30 30  30 30 20 6f 66 20 74 68  |line 00000 of th|\n"), "{}", p.dump);
        // A sparse worktree file far past any limit: only the head is read.
        let root = r.path().canonicalize().unwrap();
        std::fs::File::create(r.path().join("huge.bin")).unwrap().set_len(8 * 1024 * 1024 * 1024).unwrap();
        let wt = Side::Worktree { root, encoding: None, converts: false };
        let h = hex_dump(&repo, &cli(), r.path(), "huge.bin", Side::Absent, wt, HEX_CAP).await.unwrap().new.unwrap();
        assert_eq!((h.size, h.shown), (8 * 1024 * 1024 * 1024, HEX_CAP));
        assert_eq!(h.dump.lines().count(), (HEX_CAP / 16) as usize);
    }

    #[test]
    fn binary_heads_follow_decode_blobs_order() {
        assert!(is_binary_head(b"BIN\0", None));
        assert!(!is_binary_head(b"plain text", None));
        assert!(!is_binary_head(b"\xFF\xFEh\0i\0", None), "a UTF-16 BOM is text");
        assert!(!is_binary_head(b"h\0i\0", Some("UTF-16LE")), "so is a declared encoding");
        let mut late = vec![b'a'; BINARY_SNIFF_BYTES];
        late.push(0);
        assert!(!is_binary_head(&late, None), "only the first 8000 bytes count, as in git");
    }

    /// The large-file gates are for text: a binary of any size (over the forced ceiling too) goes
    /// straight to its capped hex dump, its kind read from its first bytes only.
    #[tokio::test]
    async fn large_binaries_skip_the_large_file_gates() {
        use crate::blob::diff_contents;
        use crate::diff::MAX_FORCED_BYTES;
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap().into_sync();
        let local = repo.to_thread_local();
        // A blob past the forced ceiling (zeros: it compresses to almost nothing).
        r.write_bytes("huge.dat", &vec![0u8; (MAX_FORCED_BYTES + 1) as usize]);
        let huge = Side::Object(ObjectId::from_hex(r.git(&["hash-object", "-w", "huge.dat"]).as_bytes()).unwrap());
        let big = Side::Object(ObjectId::from_hex(r.git(&["rev-parse", "HEAD^1:big.txt"]).as_bytes()).unwrap());
        for force in [false, true] {
            let mut c = diff_contents(&local, "huge.dat", &Side::Absent, &huge, force).unwrap();
            assert!(c.too_large);
            ungate_binary(&repo, &cli(), r.path(), "huge.dat", &Side::Absent, &huge, &mut c).await.unwrap();
            assert!(!c.too_large, "force {force}");
            let side = c.new.unwrap();
            assert!(side.binary && side.text.is_none() && side.base64.is_none());
            assert_eq!(side.size, MAX_FORCED_BYTES + 1);
        }
        let dump = hex_dump(&repo, &cli(), r.path(), "huge.dat", Side::Absent, huge, HEX_CAP).await.unwrap().new.unwrap();
        assert_eq!((dump.size, dump.shown), (MAX_FORCED_BYTES + 1, HEX_CAP));
        // A large text file keeps its prompt.
        let mut text = diff_contents(&local, "big.txt", &Side::Absent, &big, false).unwrap();
        ungate_binary(&repo, &cli(), r.path(), "big.txt", &Side::Absent, &big, &mut text).await.unwrap();
        assert!(text.too_large && !text.new.unwrap().binary);
        // A large worktree binary (sparse: zeros), on the old side, against the text.
        let root = r.path().canonicalize().unwrap();
        std::fs::File::create(r.path().join("wt.bin")).unwrap().set_len(3 * 1024 * 1024).unwrap();
        let wt = Side::Worktree { root, encoding: None, converts: false };
        let mut c = diff_contents(&local, "wt.bin", &wt, &Side::Absent, false).unwrap();
        ungate_binary(&repo, &cli(), r.path(), "wt.bin", &wt, &Side::Absent, &mut c).await.unwrap();
        assert!(!c.too_large && c.old.unwrap().binary);
    }
}
