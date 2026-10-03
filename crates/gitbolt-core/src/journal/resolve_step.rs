//! A conflict resolution as a staging undo step (spec #2 §7.6, ux round 2): one path's index
//! entries (stages 1/2/3 before, stage 0 after) and its worktree file, byte for byte. The bytes
//! are kept as blobs (`hash-object -w --no-filters`, dangling like snapshots), so the log stays
//! small in memory and a restore writes exactly what was there, with no filter in between.

use crate::api::blocking;
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::write::WriteCx;
use gix::bstr::ByteSlice;
use std::io::Write as _;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

/// One index entry of the path: `mode` as git prints it (octal), its blob or commit, its stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IndexEntry {
    pub mode: u32,
    pub oid: String,
    pub stage: u32,
}

/// What the worktree holds at the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Disk {
    Absent,
    /// A regular file: its bytes' blob and its permission bits.
    File { blob: String, mode: u32 },
    /// A symlink: its target's blob.
    Link { blob: String },
    /// A directory (a submodule's folder), never written: a step over one needs it unchanged.
    Other,
}

impl Disk {
    /// The same content: the bytes, and for a file whether it's executable (the bit git keeps).
    pub(crate) fn same(&self, other: &Disk) -> bool {
        match (self, other) {
            (Disk::File { blob: a, mode: m }, Disk::File { blob: b, mode: n }) => a == b && (m & 0o111 != 0) == (n & 0o111 != 0),
            _ => self == other,
        }
    }
}

/// The path's index entries (every stage) and its worktree file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PathState {
    pub entries: Vec<IndexEntry>,
    pub disk: Disk,
}

impl PathState {
    pub(crate) fn same(&self, other: &PathState) -> bool {
        self.entries == other.entries && self.disk.same(&other.disk)
    }

    pub(crate) fn conflicted(&self) -> bool {
        self.entries.iter().any(|e| e.stage != 0)
    }
}

/// The merge, rebase, cherry-pick or revert under way, as a key: a resolution is undone only
/// within the stop it was made in (Continue, Skip, Abort, or a terminal's, ends it).
pub(crate) fn operation(root: &Path) -> Option<String> {
    use crate::in_progress::InProgress as I;
    Some(match crate::in_progress::read(root).ok()?? {
        I::Merge { merge_head, .. } => format!("merge {merge_head}"),
        I::Rebase { onto, head_name, step, stopped_at, .. } => format!("rebase {onto} {head_name} {step} {stopped_at:?}"),
        I::CherryPick { head, .. } => format!("cherry-pick {head:?}"),
        I::Revert { head, .. } => format!("revert {head:?}"),
        I::Other { what } => format!("other {what}"),
    })
}

/// A step can carry the path from `a` to `b` and back: each side is restorable, or they match.
pub(crate) fn restorable(a: &PathState, b: &PathState) -> bool {
    a.disk.same(&b.disk) || (a.disk != Disk::Other && b.disk != Disk::Other)
}

fn entries(repo: &gix::Repository, path: &str) -> Result<Vec<IndexEntry>, GbError> {
    let index = repo.index_or_empty().map_err(gix_err)?;
    let mut out: Vec<IndexEntry> = index
        .entries()
        .iter()
        .filter(|e| e.path(&index) == path.as_bytes().as_bstr())
        .map(|e| IndexEntry { mode: e.mode.bits(), oid: e.id.to_string(), stage: e.stage_raw() })
        .collect();
    out.sort_by_key(|e| e.stage);
    Ok(out)
}

/// Where the path stands in the worktree. Folders on the way are never followed through a
/// symlink (git doesn't either: a file "beyond a symbolic link" isn't the path).
enum Place {
    /// Every folder on the way is a real one: the path's full name.
    At(PathBuf),
    /// A folder on the way is missing.
    Missing,
    /// A symlink or a file stands where a folder on the way should be.
    InTheWay(String),
}

fn place(root: &Path, path: &str) -> Result<Place, GbError> {
    crate::blob::check_relative(path)?;
    let mut at = root.to_path_buf();
    let (dirs, name) = path.rsplit_once('/').unwrap_or(("", path));
    for part in dirs.split('/').filter(|p| !p.is_empty()) {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_dir() => {}
            Ok(_) => return Ok(Place::InTheWay(at.strip_prefix(root).unwrap_or(&at).display().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Place::Missing),
            Err(e) => return Err(e.into()),
        }
    }
    at.push(name);
    Ok(Place::At(at))
}

/// A blob id of the repository's hash kind, streamed (a large file is never held in memory).
fn hash_file(kind: gix::hash::Kind, file: &Path) -> Result<String, GbError> {
    let mut f = std::fs::File::open(file)?;
    let len = f.metadata()?.len();
    let id = gix::objs::compute_stream_hash(kind, gix::objs::Kind::Blob, &mut f, len, &mut gix::progress::Discard, &std::sync::atomic::AtomicBool::new(false))
        .map_err(|e| GbError::other(format!("couldn't read {}: {e}", file.display())))?;
    Ok(id.to_string())
}

fn hash_bytes(kind: gix::hash::Kind, bytes: &[u8]) -> Result<String, GbError> {
    gix::objs::compute_hash(kind, gix::objs::Kind::Blob, bytes).map(|id| id.to_string()).map_err(|e| GbError::other(e.to_string()))
}

/// What's at the path. Beyond a symlinked folder, or a file in a folder's place: `Other`, which
/// never matches a step's file, so nothing is written or removed there.
fn read_disk(kind: gix::hash::Kind, root: &Path, path: &str) -> Result<Disk, GbError> {
    let file = match place(root, path)? {
        Place::At(f) => f,
        Place::Missing => return Ok(Disk::Absent),
        Place::InTheWay(_) => return Ok(Disk::Other),
    };
    let meta = match std::fs::symlink_metadata(&file) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Disk::Absent),
        Err(e) => return Err(e.into()),
    };
    let ft = meta.file_type();
    if ft.is_symlink() {
        let target = std::fs::read_link(&file)?;
        Ok(Disk::Link { blob: hash_bytes(kind, target.as_os_str().as_bytes())? })
    } else if ft.is_file() {
        let mode = std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o7777;
        Ok(Disk::File { blob: hash_file(kind, &file)?, mode })
    } else {
        Ok(Disk::Other)
    }
}

/// The path as it is now, read only (no object written): what an undo compares against.
pub(crate) async fn read(root: &Path, path: &str) -> Result<PathState, GbError> {
    let (r, p) = (root.to_path_buf(), path.to_string());
    blocking(move || {
        let repo = gix::open(&r).map_err(gix_err)?;
        Ok(PathState { entries: entries(&repo, &p)?, disk: read_disk(repo.object_hash(), &r, &p)? })
    })
    .await
}

/// The path as it is now, its bytes stored as a blob, so a later restore can write them back.
/// git reads a file itself (`hash-object -w --no-filters -- <file>`, streamed); the id must be
/// the one just read, or the file changed meanwhile.
pub(crate) async fn capture(cx: &WriteCx<'_>, path: &str) -> Result<PathState, GbError> {
    let (r, p) = (cx.root.to_path_buf(), path.to_string());
    let state = read(&r, &p).await?;
    let inv = match (&state.disk, place(&r, &p)?) {
        (Disk::File { .. }, Place::At(file)) => cx.git(["hash-object".into(), "-w".into(), "--no-filters".into(), "--".into(), file.into_os_string()]),
        (Disk::Link { .. }, Place::At(file)) => cx.git(["hash-object", "-w", "--no-filters", "--stdin"]).stdin(std::fs::read_link(&file)?.as_os_str().as_bytes().to_vec()),
        _ => return Ok(state),
    };
    let out = cx.api.cli.run(inv).await?;
    let stored = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match &state.disk {
        Disk::File { blob, .. } | Disk::Link { blob } if *blob == stored => Ok(state),
        _ => Err(GbError::other(format!("{path} changed while a copy was kept"))),
    }
}

/// `update-index -z --index-info`: every stage of the path out, then `to`'s entries in.
pub(crate) fn index_info(path: &str, to: &[IndexEntry], oid_len: usize) -> Vec<u8> {
    let mut info = format!("0 {}\t{path}\0", "0".repeat(oid_len)).into_bytes();
    for e in to {
        info.extend_from_slice(format!("{:o} {} {}\t{path}\0", e.mode, e.oid, e.stage).as_bytes());
    }
    info
}

/// A side of a step, ready to write: its bytes are loaded before anything is touched, so a blob
/// that's gone (a `gc --prune=now`) fails the undo up front.
#[derive(Debug, Clone)]
pub(crate) enum Ready {
    Absent,
    File { bytes: Vec<u8>, mode: u32 },
    Link { target: Vec<u8> },
}

pub(crate) fn prepare(root: &Path, path: &str, disk: &Disk) -> Result<Ready, GbError> {
    let load = |oid: &str| -> Result<Vec<u8>, GbError> {
        let repo = gix::open(root).map_err(gix_err)?;
        let id = gix::ObjectId::from_hex(oid.as_bytes()).map_err(|e| GbError::other(e.to_string()))?;
        let obj = repo.find_object(id).map_err(|_| GbError::other(format!("The kept copy of {path} is gone (git gc pruned it)")))?;
        Ok(obj.detach().data)
    };
    if let Place::InTheWay(what) = place(root, path)? {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{what} is in the way of {path}")));
    }
    Ok(match disk {
        Disk::Absent => Ready::Absent,
        Disk::File { blob, mode } => Ready::File { bytes: load(blob)?, mode: *mode },
        Disk::Link { blob } => Ready::Link { target: load(blob)? },
        Disk::Other => return Err(GbError::other(format!("{path} can't be restored"))),
    })
}

/// The folders on the way to `path`, created where missing (`git rm` removes emptied ones); an
/// existing one must be a real folder, never a symlink out of the worktree.
fn make_parents(root: &Path, path: &str) -> Result<PathBuf, GbError> {
    let (dirs, name) = path.rsplit_once('/').unwrap_or(("", path));
    let mut at = root.to_path_buf();
    for part in dirs.split('/').filter(|p| !p.is_empty()) {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_dir() => {}
            Ok(_) => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{} is in the way of {path}", at.strip_prefix(root).unwrap_or(&at).display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&at)?,
            Err(e) => return Err(e.into()),
        }
    }
    at.push(name);
    Ok(at)
}

/// Puts `to` at `path`, only over what `over` describes: the file is hashed again right before
/// the rename (or the removal), so an edit saved meanwhile is refused, never clobbered. A file or
/// a link is made under a temp name in the same folder (`.gitbolt-undo-*`), then renamed over the
/// path in one step: at every moment the path holds the old content or the new. The rename makes
/// a new inode (as an editor's save does): hard links to the old file and its xattrs aren't
/// carried. A crash before the rename can leave the temp file behind, untracked.
pub(crate) fn write_disk(kind: gix::hash::Kind, root: &Path, path: &str, to: &Ready, over: &Disk) -> Result<(), GbError> {
    crate::blob::check_relative(path)?;
    let changed = || GbError::stale(format!("{path} changed on disk; nothing was undone"));
    let file = match to {
        Ready::Absent => match place(root, path)? {
            Place::At(f) => f,
            Place::Missing => return Ok(()),
            Place::InTheWay(what) => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{what} is in the way of {path}"))),
        },
        _ => make_parents(root, path)?,
    };
    let dir = file.parent().ok_or_else(|| GbError::other("no folder to write into"))?.to_path_buf();
    let builder = || {
        let mut b = tempfile::Builder::new();
        b.prefix(".gitbolt-undo-");
        b
    };
    match to {
        Ready::Absent => {
            if !read_disk(kind, root, path)?.same(over) {
                return Err(changed());
            }
            match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        Ready::File { bytes, mode } => {
            let mut tmp = builder().tempfile_in(&dir)?;
            tmp.write_all(bytes)?;
            tmp.as_file().sync_all()?;
            std::fs::set_permissions(tmp.path(), std::os::unix::fs::PermissionsExt::from_mode(*mode))?;
            if !read_disk(kind, root, path)?.same(over) {
                return Err(changed());
            }
            // The rename replaces a symlink at the path; it never follows one.
            tmp.persist(&file).map_err(|e| GbError::from(e.error))?;
        }
        Ready::Link { target } => {
            let tmp = builder().make_in(&dir, |p| std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(target), p))?;
            if !read_disk(kind, root, path)?.same(over) {
                return Err(changed());
            }
            tmp.persist(&file).map_err(|e| GbError::from(e.error))?;
        }
    }
    // Make the rename (or removal) durable; best effort (some filesystems can't fsync a folder).
    if let Ok(d) = std::fs::File::open(&dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// The repository's object hash (SHA-1, or SHA-256).
pub(crate) fn hash_kind(root: &Path) -> Result<gix::hash::Kind, GbError> {
    Ok(gix::open(root).map_err(gix_err)?.object_hash())
}
