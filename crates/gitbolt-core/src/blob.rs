//! File contents for the diff viewer (spec §10.2, §10.4). Each side's bytes come from the
//! object database, a commit's tree, a submodule pointer or a worktree file. They're decoded to
//! text with the detected encoding, or kept as base64 for images.

use crate::commit::decode_text;
use crate::diff::{BINARY_SNIFF_BYTES, LARGE_FILE_BYTES, MAX_FORCED_BYTES};
use crate::error::{gix_err, GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use crate::payload::{BlobPayload, DiffContentsPayload, Eol};
use base64::Engine as _;
use gix::ObjectId;
use std::path::{Component, Path, PathBuf};

const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];

/// One side of a diff, resolved by the API layer: worktrees are already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Side {
    Absent,
    Object(ObjectId),
    Submodule(String),
    AtCommit(ObjectId),
    /// A working-tree file. `converts`: a `text`, `eol`, `crlf`, `ident` or `filter` attribute is
    /// set, so git's clean conversion may change its bytes (as may `core.autocrlf`, read when the
    /// file is): a diff against a stored version then compares its clean form (`clean_bytes`).
    Worktree { root: PathBuf, encoding: Option<String>, converts: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    pub text: Option<String>,
    pub binary: bool,
    pub encoding: String,
    pub eol: Eol,
}

/// Decoding order:
/// 1. a byte-order mark
/// 2. the declared `working-tree-encoding` (worktree files only; blobs in the object database
///    are UTF-8 by that attribute's definition)
/// 3. git's NUL heuristic for binary
/// 4. UTF-8
/// 5. Latin-1, which maps every byte
pub fn decode_blob(bytes: &[u8], declared: Option<&str>) -> Decoded {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        let name = if enc == encoding_rs::UTF_8 { "UTF-8 BOM".to_string() } else { enc.name().to_string() };
        return text_result(text.into_owned(), name);
    }
    if let Some(enc) = declared.and_then(|l| encoding_rs::Encoding::for_label(l.trim().as_bytes()))
        && enc != encoding_rs::UTF_8
    {
        let (text, _) = enc.decode_without_bom_handling(bytes);
        return text_result(text.into_owned(), enc.name().to_string());
    }
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Decoded { text: None, binary: true, encoding: String::new(), eol: Eol::None };
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => text_result(s.to_string(), "UTF-8".to_string()),
        Err(_) => text_result(decode_text(bytes), "ISO-8859-1".to_string()),
    }
}

/// `decode_blob`'s binary verdict from a file's first bytes alone (at least
/// `BINARY_SNIFF_BYTES` of them, or all there are): no byte-order mark, no declared non-UTF-8
/// encoding, and a NUL among the first `BINARY_SNIFF_BYTES` (git's rule).
pub fn is_binary_head(head: &[u8], declared: Option<&str>) -> bool {
    if encoding_rs::Encoding::for_bom(head).is_some() {
        return false;
    }
    if declared.and_then(|l| encoding_rs::Encoding::for_label(l.trim().as_bytes())).is_some_and(|e| e != encoding_rs::UTF_8) {
        return false;
    }
    head[..head.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// The blob id of these bytes, as `hash-object` gives it with no filters: the working
/// copy's save base (spec #2 §7.5) and `WipBase.worktree` (§7.3).
pub fn worktree_id(bytes: &[u8]) -> String {
    gix::objs::compute_hash(gix::hash::Kind::Sha1, gix::objs::Kind::Blob, bytes).map(|id| id.to_string()).unwrap_or_default()
}

fn text_result(text: String, encoding: String) -> Decoded {
    let eol = detect_eol(&text);
    Decoded { text: Some(text), binary: false, encoding, eol }
}

pub fn detect_eol(text: &str) -> Eol {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    match (crlf, lf) {
        (0, 0) => Eol::None,
        (0, _) => Eol::Lf,
        (_, 0) => Eol::Crlf,
        _ => Eol::Mixed,
    }
}

/// The two texts differ only in CRLF vs LF line endings.
pub fn eol_only_change(old: &str, new: &str) -> bool {
    old != new && old.replace("\r\n", "\n") == new.replace("\r\n", "\n")
}

pub fn is_image_path(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Whether a path component names the git directory on some filesystem. This is the same idea
/// as git's `is_ntfs_dotgit`/`is_hfs_dotgit`:
/// - `.git` in any case (case-insensitive filesystems)
/// - `.git` with trailing dots or spaces (NTFS drops them)
/// - `.git` with HFS+-ignorable code points
/// - the 8.3 short name `git~1`
pub(crate) fn is_dotgit(name: &str) -> bool {
    const HFS_IGNORABLE: [std::ops::RangeInclusive<char>; 4] =
        ['\u{200C}'..='\u{200F}', '\u{202A}'..='\u{202E}', '\u{206A}'..='\u{206F}', '\u{FEFF}'..='\u{FEFF}'];
    let n: String = name.chars().filter(|c| !HFS_IGNORABLE.iter().any(|r| r.contains(c))).collect();
    let n = n.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    n == ".git" || n == "git~1"
}

/// Returns the real path of `rel` inside `root`. It refuses anything that could leave `root` or
/// reach the git directory:
/// - an empty path, a NUL byte, or an empty, `.` or `..` segment (so no leading, trailing or
///   doubled `/`)
/// - any `.git` alias (see `is_dotgit`)
/// - a parent directory that resolves, through symlinks, outside `root` or into a `.git`
///   directory (for example, a committed `x -> .git` link)
///
/// The returned path is the canonical parent joined with the file name, so the read walks real
/// directories. The last component may itself be a symlink; callers read the link, never its
/// target, as git does.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, GbError> {
    let bad = || GbError::new(GbErrorKind::InvalidInput, format!("path is outside the worktree: {rel:?}"));
    check_relative(rel)?;
    let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let root_real = crate::platform::fs::canonicalize(root)?;
    let parent_real = if dir.is_empty() {
        root_real.clone()
    } else {
        crate::platform::fs::canonicalize(root_real.join(dir)).map_err(|_| GbError::new(GbErrorKind::NotFound, format!("{rel} not found in the worktree")))?
    };
    let inside = parent_real.strip_prefix(&root_real).map_err(|_| bad())?;
    if !inside.components().all(|c| matches!(c, Component::Normal(n) if !is_dotgit(&n.to_string_lossy()))) {
        return Err(bad());
    }
    Ok(parent_real.join(name))
}

/// `safe_join`'s checks on the path alone, before anything touches the disk: relative, no
/// empty, `.`, `..` or `.git` segment, no NUL.
pub fn check_relative(rel: &str) -> Result<(), GbError> {
    let bad = || GbError::new(GbErrorKind::InvalidInput, format!("path is outside the worktree: {rel:?}"));
    let malformed = |s: &str| s.is_empty() || s == "." || s == ".." || is_dotgit(s);
    if rel.is_empty() || rel.contains('\0') || rel.split('/').any(malformed) {
        return Err(bad());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(bad());
    }
    Ok(())
}

/// The raw bytes of `path` on a repository side (a blob, or the file at a commit), as stored:
/// what "Open in…" copies for an old version (spec §14.5). Over `limit` bytes it's refused
/// before anything is read.
pub fn side_bytes(repo: &gix::Repository, path: &str, side: &Side, limit: u64) -> Result<Vec<u8>, GbError> {
    match side {
        Side::Object(_) | Side::AtCommit(_) => {}
        _ => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path}: only a stored version can be copied"))),
    }
    let resolved = resolve(repo, path, side)?.ok_or_else(|| not_found(format!("{path} has no stored version")))?;
    let size = resolved.size(repo)?;
    if size > limit {
        let mib = |n: u64| n.div_ceil(1024 * 1024);
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is too large to open ({} MiB; the limit is {} MiB)", mib(size), mib(limit))));
    }
    let mib = |n: u64| n.div_ceil(1024 * 1024);
    Ok(resolved.bytes(repo, limit)?.ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, format!("{path} is too large to open (the limit is {} MiB)", mib(limit))))?.0)
}

/// `git check-attr -z working-tree-encoding -- <path>` output: `path NUL attr NUL value NUL`.
pub fn parse_check_attr(out: &[u8]) -> Option<String> {
    let value = out.split(|b| *b == 0).nth(2)?;
    let value = String::from_utf8_lossy(value).trim().to_string();
    (!matches!(value.as_str(), "" | "unspecified" | "unset" | "set")).then_some(value)
}

pub async fn working_tree_encoding(cli: &GitCli, root: &Path, path: &str) -> Result<Option<String>, GbError> {
    let out = cli.run(GitInvocation::new(root, ["check-attr", "-z", "working-tree-encoding", "--", path])).await?;
    Ok(parse_check_attr(&out.stdout))
}

/// The attributes that make git's clean conversion change a file's bytes (`-text` turns it off).
const CONVERTING_ATTRS: [&str; 5] = ["text", "eol", "crlf", "ident", "filter"];

/// What `git check-attr -z working-tree-encoding text eol crlf ident filter -- <path>` says
/// (`path NUL attr NUL value NUL`, per attribute): the declared encoding, and whether any
/// converting attribute is set to something other than `unset`.
pub fn parse_worktree_attrs(out: &[u8]) -> (Option<String>, bool) {
    let fields: Vec<&[u8]> = out.split(|b| *b == 0).collect();
    let (mut encoding, mut converts) = (None, false);
    for triple in fields.chunks(3).filter(|t| t.len() == 3) {
        let value = String::from_utf8_lossy(triple[2]).trim().to_string();
        match &*String::from_utf8_lossy(triple[1]) {
            "working-tree-encoding" => encoding = (!matches!(value.as_str(), "" | "unspecified" | "unset" | "set")).then_some(value),
            attr if CONVERTING_ATTRS.contains(&attr) => converts |= !matches!(value.as_str(), "" | "unspecified" | "unset"),
            _ => {}
        }
    }
    (encoding, converts)
}

/// A worktree path's declared `working-tree-encoding`, and whether a converting attribute is set
/// (`Side::Worktree`'s `converts`). One `check-attr` for both.
pub async fn worktree_attrs(cli: &GitCli, root: &Path, path: &str) -> Result<(Option<String>, bool), GbError> {
    let args = ["check-attr", "-z", "working-tree-encoding"].into_iter().chain(CONVERTING_ATTRS).chain(["--", path]);
    let out = cli.run(GitInvocation::new(root, args)).await?;
    Ok(parse_worktree_attrs(&out.stdout))
}

/// `core.autocrlf` is `true` or `input` in `repo`'s config.
fn autocrlf_on(repo: &gix::Repository) -> bool {
    repo.config_snapshot().string("core.autocrlf").is_some_and(|v| matches!(v.to_string().to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1" | "input"))
}

/// `bytes`, a worktree file at `path`, as `git add` would store it: git's clean conversion (end of
/// line per `core.autocrlf` and the `text`/`eol` attributes, `ident`, `working-tree-encoding`, a
/// `filter` driver's clean command). `None` when nothing changes them.
///
/// gix's filter pipeline, a port of git's own (`convert.c`), run on the worktree's repository so
/// its index and attributes apply. Unlike `git hash-object --path`, it leaves a file alone whose
/// index copy already has CRs, as `git diff` and `git status` do; and it reads nothing back from
/// the object database, where `hash-object` would have to write the result to return it.
pub fn clean_bytes(repo: &gix::Repository, path: &str, bytes: &[u8]) -> Result<Option<Vec<u8>>, GbError> {
    use std::io::Read as _;
    let (mut pipeline, index) = repo.filter_pipeline(None).map_err(gix_err)?;
    let mut out = pipeline.convert_to_git(bytes, Path::new(path), &index).map_err(gix_err)?;
    if !out.is_changed() {
        return Ok(None);
    }
    let mut clean = Vec::new();
    out.read_to_end(&mut clean)?;
    Ok(Some(clean))
}

/// A worktree file's decoded `text` as git compares it: decoded from its clean form, when an
/// attribute (`converts`) or `core.autocrlf` (read now, from the worktree's own repository) can
/// make one. `true` when that differs from the file by more than line endings (the side is then
/// read-only). A conversion that fails (a filter command that exits non-zero, …) keeps the file's
/// own text.
fn clean_text(root: &Path, converts: bool, path: &str, bytes: &[u8], text: String) -> (String, bool) {
    let clean = match gix::open(root).map_err(gix_err).and_then(|repo| if converts || autocrlf_on(&repo) { clean_bytes(&repo, path, bytes) } else { Ok(None) }) {
        Ok(Some(clean)) => clean,
        Ok(None) => return (text, false),
        Err(e) => {
            tracing::warn!("a worktree file's clean conversion failed, so its diff shows it as it is: {}", e.message);
            return (text, false);
        }
    };
    match decode_blob(&clean, None).text {
        Some(clean) => {
            let lf = |t: &str| t.replace("\r\n", "\n");
            let filtered = lf(&clean) != lf(&text);
            (clean, filtered)
        }
        None => (text, false),
    }
}

fn not_found(msg: String) -> GbError {
    GbError::new(GbErrorKind::NotFound, msg)
}

fn submodule_text(oid: &str) -> String {
    format!("Subproject commit {oid}\n")
}

/// A side reduced to where its bytes live.
pub(crate) enum Resolved {
    Blob(ObjectId),
    Text(String),
    File { path: PathBuf, encoding: Option<String> },
    Link(PathBuf),
}

pub(crate) fn resolve(repo: &gix::Repository, path: &str, side: &Side) -> Result<Option<Resolved>, GbError> {
    Ok(Some(match side {
        Side::Absent => return Ok(None),
        Side::Object(oid) => Resolved::Blob(*oid),
        Side::Submodule(oid) => Resolved::Text(submodule_text(oid)),
        Side::AtCommit(commit) => {
            let tree = repo.find_commit(*commit).map_err(|_| not_found(format!("commit {commit} not found")))?.tree().map_err(gix_err)?;
            let entry = tree.lookup_entry_by_path(path).map_err(gix_err)?.ok_or_else(|| not_found(format!("{path} does not exist at {commit}")))?;
            if entry.mode().is_commit() { Resolved::Text(submodule_text(&entry.object_id().to_string())) } else { Resolved::Blob(entry.object_id()) }
        }
        Side::Worktree { root, encoding, .. } => {
            let file = safe_join(root, path)?;
            let meta = std::fs::symlink_metadata(&file).map_err(|_| not_found(format!("{path} not found in the worktree")))?;
            if meta.file_type().is_symlink() {
                Resolved::Link(file)
            } else if meta.is_file() {
                Resolved::File { path: file, encoding: encoding.clone() }
            } else {
                return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is not a file")));
            }
        }
    }))
}

/// A side's bytes and its declared `working-tree-encoding`.
type Loaded = (Vec<u8>, Option<String>);

impl Resolved {
    pub(crate) fn size(&self, repo: &gix::Repository) -> Result<u64, GbError> {
        Ok(match self {
            Resolved::Blob(oid) => {
                let h = repo.find_header(*oid).map_err(|_| not_found(format!("object {oid} not found")))?;
                if h.kind() != gix::object::Kind::Blob {
                    return Err(not_found(format!("{oid} is not a file")));
                }
                h.size()
            }
            Resolved::Text(t) => t.len() as u64,
            Resolved::File { path, .. } => std::fs::metadata(path)?.len(),
            Resolved::Link(path) => std::fs::read_link(path)?.as_os_str().len() as u64,
        })
    }

    /// The bytes and declared encoding; `None` if a working-tree file has grown past `limit` since
    /// `size` checked it (it's read through `take`, never whole).
    fn bytes(self, repo: &gix::Repository, limit: u64) -> Result<Option<Loaded>, GbError> {
        Ok(Some(match self {
            Resolved::Blob(oid) => (repo.find_object(oid).map_err(gix_err)?.detach().data, None),
            Resolved::Text(t) => (t.into_bytes(), None),
            Resolved::File { path, encoding } => match read_bounded(&path, limit)? {
                Some(bytes) => (bytes, encoding),
                None => return Ok(None),
            },
            Resolved::Link(path) => (std::fs::read_link(path)?.to_string_lossy().into_owned().into_bytes(), None),
        }))
    }
}

/// Reads `path` whole if it's at most `limit` bytes, `None` if it's longer (at most `limit + 1`
/// bytes are read either way). Rust minor #5: a size check followed by an unbounded read lets a
/// file that grows in between through.
pub(crate) fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

pub fn diff_contents(repo: &gix::Repository, path: &str, old: &Side, new: &Side, force: bool) -> Result<DiffContentsPayload, GbError> {
    diff_contents_renamed(repo, path, None, old, new, force)
}

/// `diff_contents` for a rename from `old_path`. A raster image converted to an SVG (a format
/// change, `shot.png` → `shot.svg`) is an image diff too, so its raster side carries its bytes;
/// any other rename is read by its new path alone.
pub fn diff_contents_renamed(repo: &gix::Repository, path: &str, old_path: Option<&str>, old: &Side, new: &Side, force: bool) -> Result<DiffContentsPayload, GbError> {
    let to_svg = path.rsplit_once('.').is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("svg"));
    let image = is_image_path(path) || (to_svg && old_path.is_some_and(is_image_path));
    let (old_side, new_side) = (old, new);
    let old = resolve(repo, path, old)?;
    let new = resolve(repo, path, new)?;
    // A working-tree file compared with a stored version is compared as git compares it: in its
    // clean form (a symlink never goes through the filters).
    let clean_at = |side: &Side, this: &Option<Resolved>, other: &Option<Resolved>| match side {
        Side::Worktree { root, converts, .. } if matches!(this, Some(Resolved::File { .. })) && other.is_some() => Some((root.clone(), *converts)),
        _ => None,
    };
    let (old_clean, new_clean) = (clean_at(old_side, &old, &new), clean_at(new_side, &new, &old));
    let old_size = old.as_ref().map(|r| r.size(repo)).transpose()?;
    let new_size = new.as_ref().map(|r| r.size(repo)).transpose()?;
    let limit = if force { MAX_FORCED_BYTES } else { LARGE_FILE_BYTES };
    let mut too_large = [old_size, new_size].into_iter().flatten().any(|s| s > limit);
    // Both sides' bytes first: a working-tree file that grew past `limit` since its size was
    // read makes the whole diff too large, like one that was already.
    // `None`: not read (no such side, or already too large); `Some(None)`: grew past the limit.
    let read = |r: Option<Resolved>| r.filter(|_| !too_large).map(|r| r.bytes(repo, limit)).transpose();
    let (old_bytes, new_bytes) = (read(old)?, read(new)?);
    too_large |= matches!(old_bytes, Some(None)) || matches!(new_bytes, Some(None));
    let load = |bytes: Option<Option<Loaded>>, size: Option<u64>, clean: Option<(PathBuf, bool)>| -> Option<BlobPayload> {
        let size = size?;
        let (bytes, declared) = match bytes {
            Some(Some(read)) if !too_large => read,
            // A grown file is at least one byte past the limit now.
            grown_or_skipped => {
                let size = if matches!(grown_or_skipped, Some(None)) { size.max(limit + 1) } else { size };
                return Some(BlobPayload { size, binary: false, encoding: String::new(), eol: Eol::None, text: None, base64: None, hash: None, filtered: false });
            }
        };
        let d = decode_blob(&bytes, declared.as_deref());
        let base64 = (d.binary && image).then(|| base64::engine::general_purpose::STANDARD.encode(&bytes));
        // The file's own encoding, line endings and hash (what a save keeps and checks), with the
        // text git compares.
        let (text, filtered) = match (d.text, clean) {
            (Some(text), Some((root, converts))) => {
                let (text, filtered) = clean_text(&root, converts, path, &bytes, text);
                (Some(text), filtered)
            }
            (text, _) => (text, false),
        };
        Some(BlobPayload { size, binary: d.binary, encoding: d.encoding, eol: d.eol, text, base64, hash: Some(worktree_id(&bytes)), filtered })
    };
    let old = load(old_bytes, old_size, old_clean);
    let new = load(new_bytes, new_size, new_clean);
    let eol_only = matches!((&old, &new), (Some(BlobPayload { text: Some(a), .. }), Some(BlobPayload { text: Some(b), .. })) if eol_only_change(a, b));
    Ok(DiffContentsPayload { old, new, too_large, eol_only, image })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fixtures, TestRepo};

    fn oid(s: &str) -> ObjectId {
        ObjectId::from_hex(s.as_bytes()).unwrap()
    }

    fn setup() -> (TestRepo, gix::Repository) {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::open(r.path()).unwrap();
        (r, repo)
    }

    fn object(r: &TestRepo, spec: &str) -> Side {
        Side::Object(oid(&r.git(&["rev-parse", spec])))
    }

    #[test]
    fn decodes_utf16_bom_and_latin1_and_flags_eol_only() {
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("h\u{e9}llo\r\n".encode_utf16().flat_map(u16::to_le_bytes));
        let d = decode_blob(&utf16, None);
        assert_eq!((d.text.as_deref(), d.encoding.as_str(), d.eol), (Some("h\u{e9}llo\r\n"), "UTF-16LE", Eol::Crlf));
        assert!(!d.binary, "a UTF-16 BOM wins over the NUL heuristic");
        let l = decode_blob(b"caf\xe9 cr\xe8me\n", None);
        assert_eq!((l.text.as_deref(), l.encoding.as_str()), (Some("caf\u{e9} cr\u{e8}me\n"), "ISO-8859-1"));
        let b = decode_blob(b"x\0y", None);
        assert!(b.binary && b.text.is_none());
        let bom = decode_blob(b"\xEF\xBB\xBFhi\n", None);
        assert_eq!((bom.text.as_deref(), bom.encoding.as_str()), (Some("hi\n"), "UTF-8 BOM"));
        assert_eq!(decode_blob(&utf16[2..], Some("UTF-16LE")).text.as_deref(), Some("h\u{e9}llo\r\n"));
        assert!(eol_only_change("a\r\nb\r\n", "a\nb\n"));
        assert!(!eol_only_change("a\nb\n", "a\nb\n"));
        assert!(!eol_only_change("a\r\n", "b\n"));
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Mixed);
        assert_eq!(detect_eol("no newline"), Eol::None);
    }

    #[test]
    fn worktree_id_is_the_blob_id_of_the_raw_bytes() {
        assert_eq!(worktree_id(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        assert_eq!(worktree_id(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    #[test]
    fn parses_check_attr_output() {
        assert_eq!(parse_check_attr(b"a.txt\0working-tree-encoding\0UTF-16LE\0").as_deref(), Some("UTF-16LE"));
        for v in ["unspecified", "unset", "set"] {
            assert_eq!(parse_check_attr(format!("a.txt\0working-tree-encoding\0{v}\0").as_bytes()), None);
        }
        let attrs = |text: &str, filter: &str| format!("a.txt\0working-tree-encoding\0UTF-16LE\0a.txt\0text\0{text}\0a.txt\0eol\0unspecified\0a.txt\0crlf\0unspecified\0a.txt\0ident\0unspecified\0a.txt\0filter\0{filter}\0");
        assert_eq!(parse_worktree_attrs(attrs("unspecified", "unspecified").as_bytes()), (Some("UTF-16LE".into()), false));
        assert!(!parse_worktree_attrs(attrs("unset", "unspecified").as_bytes()).1, "-text converts nothing");
        for (text, filter) in [("set", "unspecified"), ("auto", "unspecified"), ("unspecified", "lfs")] {
            assert!(parse_worktree_attrs(attrs(text, filter).as_bytes()).1, "{text} {filter}");
        }
    }

    #[test]
    fn text_eol_image_and_binary_sides_of_the_rename_commit() {
        let (r, repo) = setup();
        let text = diff_contents(&repo, "docs/manual.txt", &object(&r, "HEAD^1^1:docs/guide.txt"), &object(&r, "HEAD^1:docs/manual.txt"), false).unwrap();
        let new = text.new.unwrap();
        assert_eq!((new.encoding.as_str(), new.eol, new.binary, text.image, text.eol_only), ("UTF-8", Eol::Lf, false, false, false));
        assert!(new.text.unwrap().contains("Step two, revised."));

        let crlf = diff_contents(&repo, "crlf.txt", &object(&r, "HEAD^1^1:crlf.txt"), &object(&r, "HEAD^1:crlf.txt"), false).unwrap();
        assert!(crlf.eol_only);
        assert_eq!((crlf.old.unwrap().eol, crlf.new.unwrap().eol), (Eol::Crlf, Eol::Lf));

        let png = diff_contents(&repo, "logo.png", &object(&r, "HEAD^1^1:logo.png"), &object(&r, "HEAD^1:logo.png"), false).unwrap();
        assert!(png.image);
        let new = png.new.unwrap();
        assert!(new.binary && new.text.is_none());
        assert_eq!(&base64::engine::general_purpose::STANDARD.decode(new.base64.unwrap()).unwrap()[..4], b"\x89PNG");

        let bin = diff_contents(&repo, "data.bin", &object(&r, "HEAD^1^1:data.bin"), &object(&r, "HEAD^1:data.bin"), false).unwrap();
        let (old, new) = (bin.old.unwrap(), bin.new.unwrap());
        assert!(old.binary && old.base64.is_none(), "only images carry bytes");
        assert_eq!((old.size, new.size), (9, 10));
    }

    /// A raster image converted to an SVG (a paired format change, diff.rs): the old side is a
    /// raster image by its own path, so it carries its bytes for the image diff.
    #[test]
    fn a_format_change_reads_the_old_side_by_its_own_path() {
        let (r, repo) = setup();
        let (png, svg) = (object(&r, "HEAD^1:logo.png"), object(&r, "HEAD^1:icon.svg"));
        let plain = diff_contents(&repo, "icon.svg", &png, &svg, false).unwrap();
        assert!(!plain.image && plain.old.unwrap().base64.is_none());
        let renamed = diff_contents_renamed(&repo, "icon.svg", Some("logo.png"), &png, &svg, false).unwrap();
        assert!(renamed.image);
        assert_eq!(&base64::engine::general_purpose::STANDARD.decode(renamed.old.unwrap().base64.unwrap()).unwrap()[..4], b"\x89PNG");
        assert!(renamed.new.unwrap().text.unwrap().contains("<svg"), "the SVG side stays text");
        let to_text = diff_contents_renamed(&repo, "notes.txt", Some("logo.png"), &png, &svg, false).unwrap();
        assert!(!to_text.image, "an image renamed to anything but an image type isn't an image diff");
    }

    #[test]
    fn large_files_need_force() {
        let (r, repo) = setup();
        let big = object(&r, "HEAD^1:big.txt");
        let gated = diff_contents(&repo, "big.txt", &Side::Absent, &big, false).unwrap();
        assert!(gated.too_large);
        assert!(gated.old.is_none());
        let side = gated.new.unwrap();
        assert!(side.size > LARGE_FILE_BYTES && side.text.is_none());
        let forced = diff_contents(&repo, "big.txt", &Side::Absent, &big, true).unwrap();
        assert!(!forced.too_large);
        assert!(forced.new.unwrap().text.unwrap().starts_with("line 00000 of the big file\n"));
    }

    #[test]
    fn at_commit_reads_the_tree_and_decodes_legacy_encodings() {
        let (r, repo) = setup();
        let head = oid(&r.git(&["rev-parse", "HEAD"]));
        // "Open in…" copies (fix round 2): the bytes as stored, refused above the limit.
        assert_eq!(side_bytes(&repo, "latin1.txt", &Side::AtCommit(head), 64).unwrap(), b"caf\xe9 cr\xe8me br\xfbl\xe9e\n");
        let too_big = side_bytes(&repo, "latin1.txt", &Side::AtCommit(head), 8).unwrap_err();
        assert_eq!(too_big.kind, GbErrorKind::InvalidInput);
        assert!(too_big.message.contains("too large"), "{}", too_big.message);
        let latin1 = diff_contents(&repo, "latin1.txt", &Side::Absent, &Side::AtCommit(head), false).unwrap().new.unwrap();
        assert_eq!((latin1.text.as_deref(), latin1.encoding.as_str()), (Some("caf\u{e9} cr\u{e8}me br\u{fb}l\u{e9}e\n"), "ISO-8859-1"));
        let utf16 = diff_contents(&repo, "utf16.txt", &Side::Absent, &Side::AtCommit(head), false).unwrap().new.unwrap();
        assert_eq!((utf16.text.as_deref(), utf16.encoding.as_str()), (Some("h\u{e9}llo w\u{f6}rld\n"), "UTF-16LE"));
        let missing = diff_contents(&repo, "nope.txt", &Side::Absent, &Side::AtCommit(head), false).unwrap_err();
        assert_eq!(missing.kind, GbErrorKind::NotFound);
    }

    #[test]
    fn submodule_sides_are_synthesized() {
        let (_r, repo) = setup();
        let a = "a".repeat(40);
        let c = diff_contents(&repo, "vendor/lib", &Side::Submodule(a.clone()), &Side::Absent, false).unwrap();
        assert_eq!(c.old.unwrap().text, Some(format!("Subproject commit {a}\n")));
    }

    #[test]
    fn worktree_side_reads_files_and_rejects_escapes() {
        let (r, repo) = setup();
        let root = crate::platform::fs::canonicalize(r.path()).unwrap();
        let wt = |enc: Option<&str>| Side::Worktree { root: root.clone(), encoding: enc.map(str::to_string), converts: false };
        let manual = diff_contents(&repo, "docs/manual.txt", &Side::Absent, &wt(None), false).unwrap();
        assert!(manual.new.unwrap().text.unwrap().contains("Step four (unstaged)."));

        std::fs::write(r.root().join("outside.txt"), "secret").unwrap();
        for bad in ["../outside.txt", "/etc/passwd", ".git/config", "docs/../../outside.txt", ""] {
            let err = diff_contents(&repo, bad, &Side::Absent, &wt(None), false).unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad:?}");
        }
        // Symlinks: Unix only (Windows needs privileges for them).
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(r.root(), r.path().join("escape")).unwrap();
            let err = diff_contents(&repo, "escape/outside.txt", &Side::Absent, &wt(None), false).unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "a symlinked directory must not lead outside");

            std::os::unix::fs::symlink("docs/manual.txt", r.path().join("link.txt")).unwrap();
            let link = diff_contents(&repo, "link.txt", &Side::Absent, &wt(None), false).unwrap().new.unwrap();
            assert_eq!(link.text.as_deref(), Some("docs/manual.txt"), "a symlink shows its target, as git stores it");
        }

        let bytes: Vec<u8> = "hi\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        std::fs::write(r.path().join("w16.txt"), bytes).unwrap();
        let w = diff_contents(&repo, "w16.txt", &Side::Absent, &wt(Some("UTF-16LE")), false).unwrap().new.unwrap();
        assert_eq!((w.text.as_deref(), w.encoding.as_str()), (Some("hi\n"), "UTF-16LE"));
    }

    #[test]
    fn safe_join_rejects_git_dir_aliases_and_malformed_paths() {
        let (r, repo) = setup();
        let root = crate::platform::fs::canonicalize(r.path()).unwrap();
        // Symlinks: Unix only (Windows needs privileges for them).
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(".git", r.path().join("x")).unwrap();
            let wt = Side::Worktree { root: root.clone(), encoding: None, converts: false };
            let err = diff_contents(&repo, "x/config", &Side::Absent, &wt, false).unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "a symlink to .git must not expose it");
            let err = safe_join(&root, "x/config").unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "nor through safe_join directly");
        }
        let _ = &repo;
        for bad in [
            ".GIT/config",
            ".Git/HEAD",
            ".git./config",
            ".git /config",
            ".git. . /config",
            "GIT~1/config",
            "git~1/config",
            ".g\u{200C}it/config",
            "docs/.git",
            "docs/",
            "docs/.",
            "docs/./manual.txt",
            "docs//manual.txt",
            "docs/manual.txt\0",
            "do\0cs/manual.txt",
        ] {
            let err = safe_join(&root, bad).unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("docs", r.path().join("d")).unwrap();
            assert_eq!(safe_join(&root, "d/manual.txt").unwrap(), root.join("docs/manual.txt"), "the returned path walks real directories");
        }
        // Windows spellings: a backslash `..`, a drive, a drive-relative path.
        for bad in ["docs\\..\\..\\outside.txt", "C:\\x", "C:x"] {
            if cfg!(windows) {
                assert_eq!(safe_join(&root, bad).unwrap_err().kind, GbErrorKind::InvalidInput, "{bad:?}");
            }
        }
        assert_eq!(safe_join(&root, ".gitignore-like.txt").unwrap(), root.join(".gitignore-like.txt"), "only .git itself is special");
    }

    /// Rust minor #5: the size check reads `metadata`, then the read happens; a file growing in
    /// between (a log being written) must not get past the limit.
    #[test]
    fn worktree_reads_are_bounded_after_the_size_check() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("grows.log");
        std::fs::write(&f, b"0123456789").unwrap();
        assert_eq!(read_bounded(&f, 10).unwrap(), Some(b"0123456789".to_vec()), "exactly the limit is fine");
        assert_eq!(read_bounded(&f, 9).unwrap(), None, "more than the limit is refused, not read whole");
        let repo = gix::open(TestRepo::new().path()).unwrap();
        let grown = Resolved::File { path: f, encoding: None };
        assert!(grown.bytes(&repo, 4).unwrap().is_none());
    }

    /// What git compares a worktree file as: its clean form (`git add`'s), through the requests
    /// the diff viewer sends.
    mod clean {
        use crate::testing::{fixtures, TestRepo};
        use crate::write::test_support::{api, call, open, repo, wt};
        use serde_json::{json, Value};

        async fn wip_contents(r: &TestRepo, path: &str) -> Value {
            let data = tempfile::tempdir().unwrap();
            let api = api(data.path());
            let id = open(&api, r).await;
            let index = r.git(&["rev-parse", &format!(":{path}")]);
            call(&api, "diffContents", json!({ "repo": id, "path": path, "old": { "kind": "object", "oid": index }, "new": { "kind": "worktree", "worktree": wt(r.path()) }, "force": false })).await.unwrap()
        }

        fn lines(eol: &str, edited: bool) -> String {
            (1..=10).map(|i| if edited && i == 5 { format!("line 05 edited{eol}") } else { format!("line {i:02}{eol}") }).collect()
        }

        /// The text git compares: only the edited line differs from the index. The side still
        /// reports the file's own line endings and the hash of its bytes (the save base).
        #[tokio::test]
        async fn an_autocrlf_files_worktree_side_is_its_clean_text() {
            let r = TestRepo::new();
            fixtures::wip_crlf(&r);
            let c = wip_contents(&r, "auto.txt").await;
            assert_eq!(c["old"]["text"], lines("\n", false));
            assert_eq!(c["new"]["text"], lines("\n", true));
            assert_eq!((c["new"]["eol"].as_str(), c["eolOnly"].as_bool()), (Some("crlf"), Some(false)));
            let raw = std::fs::read(r.path().join("auto.txt")).unwrap();
            assert_eq!(c["new"]["hash"], super::worktree_id(&raw));
            assert_eq!(c["new"].get("filtered"), None, "only line endings were converted: still editable");
            let same = wip_contents(&r, "same.txt").await;
            assert_eq!(same["new"]["text"], same["old"]["text"], "CRLF alone isn't a change");
            assert_eq!(same["eolOnly"], false);
        }

        /// `-text`: no conversion, so its CRLF stays in the text (and in the index).
        #[tokio::test]
        async fn a_minus_text_file_is_compared_byte_for_byte() {
            let r = TestRepo::new();
            fixtures::wip_crlf(&r);
            let c = wip_contents(&r, "raw.txt").await;
            assert_eq!(c["old"]["text"], lines("\r\n", false));
            assert_eq!(c["new"]["text"], lines("\r\n", true));
        }

        /// `.gitattributes` `* text=auto eol=crlf`, no autocrlf: the same clean text; a binary
        /// file (`text=auto` leaves it alone) keeps its bytes.
        #[tokio::test]
        async fn gitattributes_text_auto_eol_crlf() {
            let r = repo();
            r.write(".gitattributes", "* text=auto eol=crlf\n");
            r.write("t.txt", &lines("\n", false));
            r.write_bytes("b.bin", b"\0bin\r\nary\r\n");
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", "attrs"]);
            std::fs::remove_file(r.path().join("t.txt")).unwrap();
            r.git(&["checkout", "--", "t.txt"]);
            assert!(std::fs::read_to_string(r.path().join("t.txt")).unwrap().contains("\r\n"), "checked out as CRLF");
            r.write("t.txt", &lines("\r\n", true));
            let c = wip_contents(&r, "t.txt").await;
            assert_eq!(c["new"]["text"], lines("\n", true));
            assert_eq!(c["new"]["eol"], "crlf");
            r.write_bytes("b.bin", b"\0bin\r\nARY\r\n");
            let b = wip_contents(&r, "b.bin").await;
            assert_eq!((b["new"]["binary"].as_bool(), b["new"]["size"].as_u64()), (Some(true), Some(11)));
        }

        /// A file committed with CRLF before autocrlf was set: git leaves its CRs alone (they're
        /// in the index), so the comparison keeps them too.
        #[tokio::test]
        async fn crlf_already_in_the_index_is_not_converted() {
            let r = repo();
            r.write("w.txt", &lines("\r\n", false));
            r.git(&["add", "w.txt"]);
            r.git(&["commit", "-q", "-m", "w"]);
            r.git(&["config", "core.autocrlf", "true"]);
            r.write("w.txt", &lines("\r\n", true));
            let c = wip_contents(&r, "w.txt").await;
            assert_eq!(c["new"]["text"], lines("\r\n", true));
        }

        /// A clean filter (`filter=`) runs as `git add` would run it. Its text isn't the file's
        /// any more, so the side is marked `filtered` (read-only).
        #[cfg(unix)] // gix runs the filter driver without git's sh and sed on PATH (phase 2)
        #[tokio::test]
        async fn a_clean_filter_runs_and_marks_the_side_filtered() {
            let r = repo();
            r.git(&["config", "filter.redact.clean", "sed s/hunter2/REDACTED/"]);
            r.git(&["config", "filter.redact.smudge", "cat"]);
            r.write(".gitattributes", "s.txt filter=redact\n");
            r.write("s.txt", "user ada\npass hunter2\n");
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", "s"]);
            assert_eq!(r.git(&["show", ":s.txt"]), "user ada\npass REDACTED");
            r.write("s.txt", "user grace\npass hunter2\n");
            let c = wip_contents(&r, "s.txt").await;
            assert_eq!(c["new"]["text"], "user grace\npass REDACTED\n");
            assert_eq!(c["new"]["filtered"], true);
        }

        /// `working-tree-encoding`: the text was already decoded from the file's encoding; its
        /// clean form (UTF-8, LF) is the same text, so the side stays editable.
        #[tokio::test]
        async fn a_working_tree_encoding_file_stays_editable() {
            let r = repo();
            r.write(".gitattributes", "w16.txt working-tree-encoding=UTF-16LE eol=crlf\n");
            let utf16 = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(u16::to_le_bytes).collect() };
            r.write_bytes("w16.txt", &utf16("h\u{e9}\r\nyo\r\n"));
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", "w16"]);
            r.write_bytes("w16.txt", &utf16("h\u{e9}\r\nyo!\r\n"));
            let c = wip_contents(&r, "w16.txt").await;
            assert_eq!(c["old"]["text"], "h\u{e9}\nyo\n");
            assert_eq!((c["new"]["text"].as_str(), c["new"]["encoding"].as_str()), (Some("h\u{e9}\nyo!\n"), Some("UTF-16LE")));
            assert_eq!(c["new"].get("filtered"), None);
        }

        /// The WIP lists are git's: a CRLF-only file isn't listed, the edited one is +1 −1.
        #[tokio::test]
        async fn the_unstaged_list_agrees_with_git_status() {
            let r = TestRepo::new();
            fixtures::wip_crlf(&r);
            let data = tempfile::tempdir().unwrap();
            let api = api(data.path());
            let id = open(&api, &r).await;
            let list = call(&api, "fileList", json!({ "repo": id, "spec": { "kind": "wip", "worktree": wt(r.path()), "staged": false } })).await.unwrap();
            let rows: Vec<(String, u64, u64)> = list["files"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_string(), f["additions"].as_u64().unwrap(), f["deletions"].as_u64().unwrap())).collect();
            assert_eq!(rows, [("auto.txt".to_string(), 1, 1), ("raw.txt".to_string(), 1, 1)]);
        }
    }

    #[test]
    fn forced_reads_have_a_hard_ceiling() {
        let (r, repo) = setup();
        let root = crate::platform::fs::canonicalize(r.path()).unwrap();
        let huge = std::fs::File::create(r.path().join("huge.txt")).unwrap();
        huge.set_len(MAX_FORCED_BYTES + 1).unwrap(); // sparse: no bytes are written
        let wt = Side::Worktree { root, encoding: None, converts: false };
        let c = diff_contents(&repo, "huge.txt", &Side::Absent, &wt, true).unwrap();
        assert!(c.too_large, "even `force` refuses a side over MAX_FORCED_BYTES");
        let side = c.new.unwrap();
        assert_eq!(side.size, MAX_FORCED_BYTES + 1);
        assert!(side.text.is_none() && side.base64.is_none());
    }
}
