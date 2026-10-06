//! Changed-file lists (spec §9.3, §9.4, §8.6) from `git diff-tree` / `git diff` with
//! `-z --raw --numstat`. Each `FileChange` carries the exact blob source of both sides, so the
//! diff viewer never re-derives them.

use crate::blob::{read_bounded, safe_join};
use crate::commit::{parse_commit, parse_oid};
use crate::details::read_commit;
use crate::error::{GbError, GbErrorKind};
use crate::git::{GitCli, GitInvocation};
use crate::payload::{BlobSource, FileChange, FileListPayload};
use crate::status::{status, EntryKind, StatusEntry};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Above this size (either side), the diff viewer asks before loading (spec §10.2).
pub const LARGE_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// The hard ceiling per side, even when the user chose "load anyway" (matches the UI's 64 MiB
/// content cache, spec §4.4).
pub const MAX_FORCED_BYTES: u64 = 64 * 1024 * 1024;
/// Git's binary heuristic (xdiff's `buffer_is_binary`): a NUL in the first 8000 bytes.
pub const BINARY_SNIFF_BYTES: usize = 8000;
pub const SUBMODULE_MODE: u32 = 0o160000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum DiffSpec {
    /// A commit against one of its parents (0-based; ignored for a root commit).
    Commit { id: String, parent: u32 },
    /// `from` → `to` (spec §9.4).
    Compare { from: String, to: String },
    /// A commit against a worktree's files ("Compare with working tree", spec §9.4).
    Worktree { from: String, worktree: String },
    /// A worktree's changes (spec §8.6): index vs HEAD, or worktree vs index plus untracked files.
    Wip { worktree: String, staged: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawChange {
    /// `A`, `C`, `D`, `M`, `R`, `T`, `U` or `X` (the similarity score after R/C is dropped).
    pub status: char,
    pub old_mode: u32,
    pub new_mode: u32,
    /// Full hex ids (callers pass `--no-abbrev`). All zeros means absent, or the worktree side.
    pub old_oid: String,
    pub new_oid: String,
    pub path: String,
    pub old_path: Option<String>,
    /// `None` for binary files (numstat prints `-`).
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    /// Whether a numstat record actually matched this path. `false` (with `additions`/`deletions`
    /// both `None`) means git never computed a content diff for this path at all — the raw
    /// record is a stat-dirty phantom, not a real change (see `drop_phantom_stat_dirty`). `true`
    /// with `None`/`None` means a real binary diff (numstat prints `-\t-`).
    pub has_numstat: bool,
}

pub fn is_null_oid(oid: &str) -> bool {
    oid.bytes().all(|b| b == b'0')
}

/// Parses `-z --raw --numstat` output: every raw record first, then every numstat record
/// (git-diff(1), "Raw output format"). Numstat values are matched to raw records by path, not
/// position, so an odd record (e.g. an unmerged path) can't shift the numbers.
pub fn parse_raw_numstat(out: &[u8]) -> Result<Vec<RawChange>, GbError> {
    let bad = |m: String| GbError::other(format!("unexpected git diff output: {m}"));
    let text = |t: &[u8]| String::from_utf8_lossy(t).into_owned();
    let mut tokens = out.split(|b| *b == 0).peekable();
    let mut changes = Vec::new();
    while let Some(tok) = tokens.next_if(|t| t.first() == Some(&b':')) {
        let header = text(tok);
        let f: Vec<&str> = header[1..].split(' ').collect();
        let [old_mode, new_mode, old_oid, new_oid, status] = f[..] else {
            return Err(bad(format!("raw record {header:?}")));
        };
        let status = status.chars().next().ok_or_else(|| bad(format!("empty status in {header:?}")))?;
        let mode = |s: &str| u32::from_str_radix(s, 8).map_err(|e| bad(format!("mode {s:?}: {e}")));
        let first = tokens.next().map(text).ok_or_else(|| bad(format!("missing path after {header:?}")))?;
        let (path, old_path) = if matches!(status, 'R' | 'C') {
            (tokens.next().map(text).ok_or_else(|| bad(format!("missing rename target after {header:?}")))?, Some(first))
        } else {
            (first, None)
        };
        changes.push(RawChange { status, old_mode: mode(old_mode)?, new_mode: mode(new_mode)?, old_oid: old_oid.into(), new_oid: new_oid.into(), path, old_path, additions: None, deletions: None, has_numstat: false });
    }
    let mut stats: HashMap<String, (Option<u32>, Option<u32>)> = HashMap::new();
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        let line = text(tok);
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(bad(format!("numstat record {line:?}")));
        };
        let path = if p.is_empty() {
            let _old = tokens.next();
            tokens.next().map(text).ok_or_else(|| bad(format!("missing rename target in numstat {line:?}")))?
        } else {
            p.to_string()
        };
        stats.insert(path, (a.parse().ok(), d.parse().ok()));
    }
    for c in &mut changes {
        if let Some(&(a, d)) = stats.get(&c.path) {
            c.additions = a;
            c.deletions = d;
            c.has_numstat = true;
        }
    }
    Ok(changes)
}

/// Whether `oid` is both non-null and actually stored in the object database. `git diff`/`git
/// diff-tree` sometimes print a real-looking (but never-written) transient hash for a new-side
/// file that differs from the index — e.g. `diffcore-rename`'s hashing of a rename destination
/// fills in `p->two->oid` even for a worktree-only file — so a non-null oid alone doesn't mean
/// the blob is fetchable. This is the one check that does, in a single in-process lookup (no
/// second git process, so no time-of-check/time-of-use gap against a changing worktree).
fn object_exists(repo: &gix::Repository, oid: &str) -> bool {
    gix::ObjectId::from_hex(oid.as_bytes()).is_ok_and(|id| repo.has_object(id))
}

fn side(repo: &gix::Repository, oid: &str, mode: u32, new_side: bool, worktree: Option<&str>) -> BlobSource {
    if mode == 0 {
        return BlobSource::Absent;
    }
    if mode == SUBMODULE_MODE {
        // A dirty submodule's new-side oid can be null too; resolved later, once a worktree read
        // is available (`resolve_dirty_submodules`).
        return BlobSource::Submodule { oid: oid.to_string() };
    }
    match (new_side, worktree) {
        (true, Some(w)) if !object_exists(repo, oid) => BlobSource::Worktree { worktree: w.to_string() },
        _ if is_null_oid(oid) => BlobSource::Absent,
        _ => BlobSource::Object { oid: oid.to_string() },
    }
}

fn to_changes(repo: &gix::Repository, raw: Vec<RawChange>, worktree: Option<&str>) -> Vec<FileChange> {
    raw.into_iter()
        .map(|c| FileChange {
            submodule: c.old_mode == SUBMODULE_MODE || c.new_mode == SUBMODULE_MODE,
            conflict: None,
            old: side(repo, &c.old_oid, c.old_mode, false, worktree),
            new: side(repo, &c.new_oid, c.new_mode, true, worktree),
            status: c.status.to_string(),
            path: c.path,
            old_path: c.old_path,
            additions: c.additions,
            deletions: c.deletions,
        })
        .collect()
}

/// A conflicted path shows as two raw records under a plain (unstaged) `git diff`: a placeholder
/// `U` record (mode/oids all zero, nothing useful) and an `M` record carrying the real "ours"
/// (index stage 2) oid as old and the null oid (the conflict-marked worktree file) as new — with
/// the numstat counts attached to the `M` record. Left alone, both become separate `FileChange`s
/// for the same path and the counts get totalled twice. Keep one `U` entry per such path, with
/// the `M` record's oids/mode/counts.
fn collapse_unmerged(changes: Vec<RawChange>) -> Vec<RawChange> {
    let mut groups: HashMap<String, Vec<RawChange>> = HashMap::new();
    for c in changes {
        groups.entry(c.path.clone()).or_default().push(c);
    }
    let mut out: Vec<RawChange> = groups
        .into_values()
        .flat_map(|mut group| {
            if group.len() > 1 && group.iter().any(|c| c.status == 'U') {
                group.retain(|c| c.status != 'U');
                if let Some(m) = group.first_mut() {
                    m.status = 'U';
                }
            }
            group
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// A dirty submodule's new-side oid comes back null from `git diff`/`git diff-tree`: neither
/// command tries to hash the submodule's checked-out commit. Resolve it to what's actually
/// checked out there. `Absent` if the submodule isn't initialized, isn't a git repository, has no
/// commits yet, or the path (its last component isn't re-canonicalized by `safe_join`) is itself
/// a symlink — e.g. a committed `sub -> .git` alias must not resolve to the *superproject's* HEAD.
///
/// This opens `dir` with `gix::open`, never `git`'s own repository discovery (which walks
/// upward through parent directories looking for a `.git`): an empty or not-yet-initialized
/// submodule directory would otherwise silently resolve to the enclosing superproject's HEAD.
/// `gix::open` only ever considers `dir` itself and `dir/.git`, so there's no such fallback.
fn resolve_submodule_head(wt: &Path, path: &str) -> BlobSource {
    let Ok(dir) = safe_join(wt, path) else { return BlobSource::Absent };
    let Ok(meta) = std::fs::symlink_metadata(&dir) else { return BlobSource::Absent };
    if !meta.is_dir() {
        return BlobSource::Absent;
    }
    match gix::open(&dir).ok().and_then(|repo| repo.head_id().ok().map(gix::ObjectId::from)) {
        Some(id) => BlobSource::Submodule { oid: id.to_string() },
        None => BlobSource::Absent,
    }
}

fn resolve_dirty_submodules(wt: &Path, files: &mut [FileChange]) {
    for f in files.iter_mut() {
        if f.submodule
            && let BlobSource::Submodule { oid } = &f.new
            && is_null_oid(oid)
        {
            f.new = resolve_submodule_head(wt, &f.path);
        }
    }
}

fn diff_tree(tail: &[String]) -> Vec<String> {
    ["diff-tree", "-r", "-M", "--no-ext-diff", "--no-textconv", "--no-abbrev", "-z", "--raw", "--numstat"].iter().map(|s| s.to_string()).chain(tail.iter().cloned()).collect()
}

/// Porcelain `git diff` (index/worktree comparisons). `-c diff.autoRefreshIndex=false` (passed as
/// argv, not repo config, so it can never be overridden by the user's own config) stops git from
/// silently rewriting `.git/index` to clear stat-dirty entries it finds identical (`C1`) — but it
/// also makes git list every merely-stat-dirty path as a phantom `M` with no real content diff.
/// Callers must run those results through `drop_phantom_stat_dirty`.
fn diff_porcelain(extra: &[&str]) -> Vec<String> {
    ["-c", "diff.autoRefreshIndex=false", "diff", "--no-ext-diff", "--no-textconv", "--no-abbrev", "-z", "--raw", "--numstat"].iter().chain(extra).map(|s| s.to_string()).collect()
}

/// Drops the phantom `M` records `diff_porcelain` produces for a stat-dirty-but-content-identical
/// path (see its doc comment and `C1` in the pre-review): git flags the path as changed purely
/// because its stat info doesn't match the index, without ever reading it to check, so there's no
/// numstat record for it. A real change — including one that also happens to be stat-dirty —
/// always gets a numstat record (git has to read the file to diff it) and/or shows up in `git
/// status`, which does the real content comparison. Keep a record unless both signals agree it's
/// clean: `git status` doesn't consider the path dirty, and the numstat side is uninformative —
/// either no numstat record at all, or one that can't tell content changed from unchanged.
/// Binary paths are the latter: `--numstat` always prints `-\t-\tpath` (additions/deletions both
/// `None`) whether or not the bytes actually differ, so `has_numstat` alone can't rule out a
/// phantom binary entry; `dirty` has to decide those too.
fn drop_phantom_stat_dirty(raw: Vec<RawChange>, dirty: &HashSet<String>) -> Vec<RawChange> {
    raw.into_iter().filter(|c| !(c.status == 'M' && !dirty.contains(&c.path) && (!c.has_numstat || (c.additions.is_none() && c.deletions.is_none())))).collect()
}

/// Every path `git status` considers not-clean: staged, unstaged, untracked or conflicted. Used
/// as the ground truth for `drop_phantom_stat_dirty` (status does a real content comparison and,
/// thanks to `GIT_OPTIONAL_LOCKS=0`, never writes back what it finds).
fn dirty_paths(entries: &[StatusEntry]) -> HashSet<String> {
    entries.iter().filter(|e| e.kind != EntryKind::Ignored).map(|e| e.path.clone()).collect()
}

/// The paths whose worktree side `git status` considers not-clean (`Y` isn't `.`): the ground
/// truth for the unstaged list's (worktree vs index) phantom filter. A path that's only staged
/// (`M.`) is clean there, however stat-dirty: `git apply --cached` (staging a hunk or line)
/// writes its index entry without stat info, so the read-only diff lists it as a phantom.
fn worktree_dirty_paths(entries: &[StatusEntry]) -> HashSet<String> {
    entries.iter().filter(|e| e.kind != EntryKind::Ignored && e.worktree != '.').map(|e| e.path.clone()).collect()
}

async fn run(cli: &GitCli, cwd: &Path, args: Vec<String>) -> Result<Vec<RawChange>, GbError> {
    let out = cli.run(GitInvocation::new(cwd, args)).await?;
    parse_raw_numstat(&out.stdout)
}

/// Line count of an untracked text file up to `LARGE_FILE_BYTES`. `None` for anything else
/// (binary, too big, a symlink or not a file).
fn count_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > LARGE_FILE_BYTES {
        return None;
    }
    let bytes = read_bounded(path, LARGE_FILE_BYTES).ok()??;
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return None;
    }
    let lines = bytes.iter().filter(|&&b| b == b'\n').count() + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"));
    Some(lines as u32)
}

/// The gix lookups (`to_changes`, dirty submodules) and untracked-file reads of a file list, on
/// the blocking pool: with `--untracked-files=all` and a large un-ignored folder they're a lot
/// of disk I/O (Rust minor #14).
async fn off_runtime<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, GbError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| GbError::other(format!("file list task failed: {e}")))
}

/// `raw` as `FileChange`s, off the runtime; for a worktree side, with dirty submodules resolved.
async fn changes(repo: &gix::ThreadSafeRepository, raw: Vec<RawChange>, worktree: Option<(PathBuf, String)>) -> Result<Vec<FileChange>, GbError> {
    let repo = repo.clone();
    off_runtime(move || {
        let mut files = to_changes(&repo.to_thread_local(), raw, worktree.as_ref().map(|(_, name)| name.as_str()));
        if let Some((wt, _)) = &worktree {
            resolve_dirty_submodules(wt, &mut files);
        }
        files
    })
    .await
}

fn resolved(worktree: Option<&Path>) -> Result<&Path, GbError> {
    worktree.ok_or_else(|| GbError::other("worktree diff requested without a validated worktree"))
}

/// The image types the image diff shows (`ui/src/image/sources.ts`'s `IMAGE_MIME`).
const IMAGE_DIFF_EXTENSIONS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"];

/// An image path without its extension (folder and stem). `None` for any other file, and for a
/// name that's only an extension (`.png`).
fn image_stem(path: &str) -> Option<&str> {
    let (stem, ext) = path.rsplit_once('.')?;
    let name = stem.rsplit_once('/').map_or(stem, |(_, n)| n);
    (!name.is_empty() && IMAGE_DIFF_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())).then_some(stem)
}

/// A format change (`shot.png` deleted, `shot.webp` added) as one renamed row, so the image diff
/// compares the two: git's rename detection is by content, and a re-encoded image shares none.
/// Display only (nothing staged or committed changes), within one list: a WIP pair whose halves
/// are in different stages stays two rows. Only an unambiguous pair: exactly one deleted and one
/// added image with that folder and stem. The row keeps the deleted side's line count and the
/// added side's (an SVG's), so the totals don't change.
fn pair_image_conversions(mut files: Vec<FileChange>) -> Vec<FileChange> {
    fn candidate<'a>(f: &'a FileChange, status: &str) -> Option<&'a str> {
        if f.status == status && !f.submodule { image_stem(&f.path) } else { None }
    }
    let mut by_stem: HashMap<&str, (Vec<usize>, Vec<usize>)> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        if let Some(stem) = candidate(f, "D") {
            by_stem.entry(stem).or_default().0.push(i);
        } else if let Some(stem) = candidate(f, "A") {
            by_stem.entry(stem).or_default().1.push(i);
        }
    }
    let pairs: Vec<(usize, usize)> = by_stem
        .into_values()
        .filter_map(|(d, a)| match (&d[..], &a[..]) {
            ([d], [a]) => Some((*d, *a)),
            _ => None,
        })
        .collect();
    if pairs.is_empty() {
        return files;
    }
    let mut gone = HashSet::new();
    for (d, a) in pairs {
        let deleted = files[d].clone();
        let added = &mut files[a];
        added.status = "R".into();
        added.old_path = Some(deleted.path);
        added.old = deleted.old;
        added.deletions = deleted.deletions;
        gone.insert(d);
    }
    files.into_iter().enumerate().filter(|(i, _)| !gone.contains(i)).map(|(_, f)| f).collect()
}

fn totals(files: Vec<FileChange>) -> FileListPayload {
    let files = pair_image_conversions(files);
    let added: u64 = files.iter().filter_map(|f| f.additions).map(u64::from).sum();
    let deleted: u64 = files.iter().filter_map(|f| f.deletions).map(u64::from).sum();
    let added = u32::try_from(added).unwrap_or(u32::MAX);
    let deleted = u32::try_from(deleted).unwrap_or(u32::MAX);
    FileListPayload { files, added, deleted, version: None }
}

/// A worktree's staged changes: index vs HEAD.
async fn wip_staged(repo: &gix::ThreadSafeRepository, cli: &GitCli, wt: &Path) -> Result<Vec<FileChange>, GbError> {
    let raw = run(cli, wt, diff_porcelain(&["-M", "--cached"])).await?;
    changes(repo, raw, None).await
}

/// A worktree's unstaged changes (worktree vs index, minus stat-dirty phantoms) plus its
/// untracked files, given that worktree's `git status` (`entries`). An untracked file in `reuse`
/// takes that line count instead of being read.
async fn wip_unstaged(repo: &gix::ThreadSafeRepository, cli: &GitCli, wt: &Path, entries: Vec<StatusEntry>, reuse: &HashMap<String, Option<u32>>) -> Result<Vec<FileChange>, GbError> {
    let name = wt.to_string_lossy().into_owned();
    let dirty = worktree_dirty_paths(&entries);
    let raw = drop_phantom_stat_dirty(collapse_unmerged(run(cli, wt, diff_porcelain(&[])).await?), &dirty);
    let conflicts: HashMap<String, crate::payload::ConflictKind> = entries
        .iter()
        .filter(|e| e.kind == EntryKind::Unmerged)
        .filter_map(|e| Some((e.path.clone(), crate::payload::ConflictKind::from_xy(e.index, e.worktree)?)))
        .collect();
    let mut files = changes(repo, raw, Some((wt.to_path_buf(), name.clone()))).await?;
    for f in files.iter_mut().filter(|f| f.status == "U") {
        f.conflict = conflicts.get(&f.path).copied();
    }
    let untracked: Vec<(StatusEntry, Option<Option<u32>>)> = entries.into_iter().filter(|e| e.kind == EntryKind::Untracked).map(|e| {
        let known = reuse.get(&e.path).copied();
        (e, known)
    }).collect();
    let wt = wt.to_path_buf();
    files.extend(
        off_runtime(move || {
            untracked
                .into_iter()
                .map(|(e, known)| {
                    let additions = known.unwrap_or_else(|| count_lines(&wt.join(&e.path)));
                    FileChange {
                        path: e.path,
                        old_path: None,
                        status: "A".into(),
                        additions,
                        deletions: additions.map(|_| 0),
                        old: BlobSource::Absent,
                        new: BlobSource::Worktree { worktree: name.clone() },
                        submodule: false,
                        conflict: None,
                    }
                })
                .collect::<Vec<_>>()
        })
        .await?,
    );
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Both of a worktree's WIP lists, `(staged, unstaged)`, exactly as `file_list` gives them, from
/// a status read already made (`entries`, the phantom filter's ground truth): what the watcher
/// keeps for the active tab (K44). `reuse`: line counts already known for untracked files not
/// written to since (by path). Read-only, like `file_list` (C1).
pub async fn wip_lists(repo: &gix::ThreadSafeRepository, cli: &GitCli, wt: &Path, entries: Vec<StatusEntry>, reuse: &HashMap<String, Option<u32>>) -> Result<(FileListPayload, FileListPayload), GbError> {
    let (staged, unstaged) = futures_util::future::join(wip_staged(repo, cli, wt), wip_unstaged(repo, cli, wt, entries, reuse)).await;
    Ok((totals(staged?), totals(unstaged?)))
}

pub async fn file_list(repo: &gix::ThreadSafeRepository, cli: &GitCli, workdir: &Path, spec: &DiffSpec, worktree: Option<&Path>) -> Result<FileListPayload, GbError> {
    let files = match spec {
        DiffSpec::Commit { id, parent } => {
            let id = parse_oid(id)?;
            // The thread-local repo is dropped at the end of this statement, before any await.
            let parents = parse_commit(&read_commit(&repo.to_thread_local(), id)?)?.parents;
            let tail = match parents.get(*parent as usize) {
                Some(p) => vec![p.to_string(), id.to_string()],
                None if parents.is_empty() => vec!["--root".to_string(), "--no-commit-id".to_string(), id.to_string()],
                None => {
                    return Err(GbError::new(
                        GbErrorKind::InvalidInput,
                        format!("commit {id} has {} parent(s); there is no parent {}", parents.len(), u64::from(*parent) + 1),
                    ));
                }
            };
            let raw = run(cli, workdir, diff_tree(&tail)).await?;
            changes(repo, raw, None).await?
        }
        DiffSpec::Compare { from, to } => {
            let tail = vec![parse_oid(from)?.to_string(), parse_oid(to)?.to_string()];
            let raw = run(cli, workdir, diff_tree(&tail)).await?;
            changes(repo, raw, None).await?
        }
        DiffSpec::Worktree { from, .. } => {
            let wt = resolved(worktree)?;
            let from = parse_oid(from)?.to_string();
            let name = wt.to_string_lossy().into_owned();
            let raw = run(cli, wt, diff_porcelain(&["-M", from.as_str(), "--"])).await?;
            // Known narrow gap (not fixed here): `status` is index-vs-HEAD/worktree, not against
            // an arbitrary `from`, so a binary that's genuinely different since a non-HEAD `from`
            // but otherwise clean (uninformative numstat, clean `status`) would be dropped too.
            let dirty = dirty_paths(&status(cli, wt).await?);
            let raw = drop_phantom_stat_dirty(raw, &dirty);
            changes(repo, raw, Some((wt.to_path_buf(), name))).await?
        }
        DiffSpec::Wip { staged: true, .. } => wip_staged(repo, cli, resolved(worktree)?).await?,
        DiffSpec::Wip { staged: false, .. } => {
            let wt = resolved(worktree)?;
            wip_unstaged(repo, cli, wt, status(cli, wt).await?, &HashMap::new()).await?
        }
    };
    Ok(totals(files))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    fn setup() -> (TestRepo, gix::ThreadSafeRepository) {
        let r = TestRepo::new();
        fixtures::details(&r);
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        (r, repo)
    }

    fn by_path(list: &FileListPayload) -> HashMap<&str, &FileChange> {
        list.files.iter().map(|f| (f.path.as_str(), f)).collect()
    }

    #[test]
    fn parses_raw_and_numstat_with_renames_binary_and_newlines() {
        let o = |c: char| c.to_string().repeat(40);
        let z = "0".repeat(40);
        let raw = format!(
            ":100644 100644 {a} {b} R073\0a.txt\0b new.txt\0:100644 100644 {c} {d} M\0bin.dat\0:000000 100644 {z} {e} A\0new\nline.txt\0:160000 160000 {a} {b} M\0sub\01\t0\t\0a.txt\0b new.txt\0-\t-\tbin.dat\01\t0\tnew\nline.txt\01\t1\tsub\0",
            a = o('a'), b = o('b'), c = o('c'), d = o('d'), e = o('e'),
        );
        let ch = parse_raw_numstat(raw.as_bytes()).unwrap();
        assert_eq!(ch.len(), 4);
        assert_eq!((ch[0].status, ch[0].old_path.as_deref(), ch[0].path.as_str()), ('R', Some("a.txt"), "b new.txt"));
        assert_eq!((ch[0].additions, ch[0].deletions), (Some(1), Some(0)));
        assert_eq!((ch[1].additions, ch[1].deletions), (None, None), "binary");
        assert_eq!(ch[2].path, "new\nline.txt");
        assert!(is_null_oid(&ch[2].old_oid));
        assert_eq!(ch[2].old_mode, 0);
        assert_eq!((ch[3].new_mode, ch[3].additions), (SUBMODULE_MODE, Some(1)));
    }

    #[test]
    fn empty_output_is_no_changes_and_garbage_is_an_error() {
        assert!(parse_raw_numstat(b"").unwrap().is_empty());
        assert!(parse_raw_numstat(b":100644 M\0x\0").is_err());
    }

    #[tokio::test]
    async fn rename_commit_lists_every_change_with_its_blob_sources() {
        let (r, repo) = setup();
        let id = r.git(&["rev-parse", "HEAD^1"]);
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id, parent: 0 }, None).await.unwrap();
        let mut statuses: Vec<(&str, &str)> = list.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
        statuses.sort();
        assert_eq!(
            statuses,
            vec![("big.txt", "A"), ("crlf.txt", "M"), ("data.bin", "M"), ("dir with space/\u{fc}n\u{ef}.txt", "A"), ("docs/manual.txt", "R"), ("icon.svg", "M"), ("logo.png", "M"), ("old.txt", "D"), ("src/app.php", "M"), ("ws.txt", "M")]
        );
        let f = by_path(&list);
        assert_eq!(f["docs/manual.txt"].old_path.as_deref(), Some("docs/guide.txt"));
        assert_eq!((f["docs/manual.txt"].additions, f["docs/manual.txt"].deletions), (Some(1), Some(1)));
        assert_eq!((f["logo.png"].additions, f["logo.png"].deletions), (None, None), "binary");
        assert_eq!(f["old.txt"].new, BlobSource::Absent);
        assert_eq!(f["big.txt"].old, BlobSource::Absent);
        assert_eq!(f["src/app.php"].new, BlobSource::Object { oid: r.git(&["rev-parse", "HEAD^1:src/app.php"]) });
        assert!(list.added > 80_000, "big.txt's lines count toward the total");
    }

    #[tokio::test]
    async fn merge_commit_diffs_against_chosen_parent() {
        let (r, repo) = setup();
        let head = r.git(&["rev-parse", "HEAD"]);
        let first = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id: head.clone(), parent: 0 }, None).await.unwrap();
        assert_eq!(first.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["feature.txt"]);
        let second = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id: head.clone(), parent: 1 }, None).await.unwrap();
        assert_eq!(second.files.len(), 10);
        assert!(second.files.iter().all(|f| f.path != "feature.txt"));
        let err = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id: head, parent: 2 }, None).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn root_commit_lists_every_file_as_added() {
        let (r, repo) = setup();
        let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id: root, parent: 0 }, None).await.unwrap();
        assert_eq!(list.files.len(), 10);
        assert!(list.files.iter().all(|f| f.status == "A" && f.old == BlobSource::Absent));
    }

    #[tokio::test]
    async fn compare_matches_the_direct_diff_and_rejects_non_ids() {
        let (r, repo) = setup();
        let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
        let rename = r.git(&["rev-parse", "HEAD^1"]);
        let cmp = file_list(&repo, &cli(), r.path(), &DiffSpec::Compare { from: root.clone(), to: rename.clone() }, None).await.unwrap();
        let direct = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id: rename.clone(), parent: 0 }, None).await.unwrap();
        assert_eq!(cmp.files, direct.files);
        let back = file_list(&repo, &cli(), r.path(), &DiffSpec::Compare { from: rename.clone(), to: root }, None).await.unwrap();
        let f = by_path(&back);
        assert_eq!((f["old.txt"].status.as_str(), f["big.txt"].status.as_str()), ("A", "D"));
        let bad = file_list(&repo, &cli(), r.path(), &DiffSpec::Compare { from: "--output=/tmp/x".into(), to: rename }, None).await.unwrap_err();
        assert_eq!(bad.kind, GbErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn wip_lists_staged_unstaged_and_untracked() {
        let (r, repo) = setup();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let staged = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: true }, Some(&wt)).await.unwrap();
        assert_eq!(staged.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["src/app.php"]);
        assert!(matches!(staged.files[0].new, BlobSource::Object { .. }), "the staged side is the index blob");
        let unstaged = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: false }, Some(&wt)).await.unwrap();
        assert_eq!(unstaged.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["docs/manual.txt", "notes.txt"]);
        let worktree = BlobSource::Worktree { worktree: name };
        assert_eq!(unstaged.files[0].new, worktree);
        assert!(matches!(unstaged.files[0].old, BlobSource::Object { .. }), "the unstaged old side is the index blob");
        assert_eq!((unstaged.files[1].status.as_str(), unstaged.files[1].additions, &unstaged.files[1].new), ("A", Some(1), &worktree));
    }

    /// The watcher passes the line counts it already has for untracked files nobody wrote to
    /// since: those files aren't read again (a bogus count proves it); the others are.
    #[tokio::test]
    async fn wip_lists_reuse_the_given_untracked_counts() {
        let (r, repo) = setup();
        r.write("fresh.txt", "a\nb\nc\n");
        let wt = r.path().canonicalize().unwrap();
        let entries = status(&cli(), &wt).await.unwrap();
        let reuse = HashMap::from([("notes.txt".to_string(), Some(99))]);
        let (_, unstaged) = wip_lists(&repo, &cli(), &wt, entries, &reuse).await.unwrap();
        let f = by_path(&unstaged);
        assert_eq!(f["notes.txt"].additions, Some(99), "reused, not re-read");
        assert_eq!(f["fresh.txt"].additions, Some(3), "counted");
    }

    #[tokio::test]
    async fn commit_against_worktree_mixes_index_and_worktree_sides() {
        let (r, repo) = setup();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let root = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Worktree { from: root, worktree: name.clone() }, Some(&wt)).await.unwrap();
        let f = by_path(&list);
        assert_eq!(f["docs/manual.txt"].status, "R");
        assert_eq!(f["docs/manual.txt"].new, BlobSource::Worktree { worktree: name });
        assert!(matches!(f["src/app.php"].new, BlobSource::Object { .. }), "staged and unchanged since: git names the index blob");
        assert!(f.contains_key("feature.txt"));
        assert!(!f.contains_key("notes.txt"), "untracked files aren't part of a commit-vs-worktree diff");
    }

    /// Bumps a file's mtime, without touching its content, far enough into the future to defeat
    /// racy-git's same-second heuristic (see `status.rs`'s `status_does_not_rewrite_the_index`).
    fn bump_mtime(path: &Path) {
        let f = std::fs::File::open(path).unwrap();
        let modified = f.metadata().unwrap().modified().unwrap();
        f.set_modified(modified + std::time::Duration::from_secs(120)).unwrap();
    }

    /// C1 regression: a stat-dirty (mtime bumped) but content-identical file must not be listed
    /// by either porcelain diff, and — the read-only guarantee — running them must never touch
    /// `.git/index` (byte-for-byte, mtime included). Before the fix, plain `git diff` refreshed
    /// the index for exactly this case (`diff.autoRefreshIndex` defaults to true).
    #[tokio::test]
    async fn stat_dirty_unchanged_file_is_not_listed_and_index_is_untouched() {
        let r = TestRepo::new();
        r.write("f.txt", "hello\n");
        r.commit_all_as("c", "Ada Lovelace", "ada@example.com");
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let root = r.git(&["rev-parse", "HEAD"]);

        bump_mtime(&wt.join("f.txt"));

        let index_path = wt.join(".git/index");
        let before_bytes = std::fs::read(&index_path).unwrap();
        let before_mtime = std::fs::metadata(&index_path).unwrap().modified().unwrap();

        let wip = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: false }, Some(&wt)).await.unwrap();
        assert!(wip.files.iter().all(|f| f.path != "f.txt"), "stat-dirty but content-identical file must not be listed (Wip): {:?}", wip.files);

        let worktree_diff = file_list(&repo, &cli(), r.path(), &DiffSpec::Worktree { from: root, worktree: name }, Some(&wt)).await.unwrap();
        assert!(worktree_diff.files.iter().all(|f| f.path != "f.txt"), "stat-dirty but content-identical file must not be listed (Worktree): {:?}", worktree_diff.files);

        let after_bytes = std::fs::read(&index_path).unwrap();
        let after_mtime = std::fs::metadata(&index_path).unwrap().modified().unwrap();
        assert_eq!(before_bytes, after_bytes, ".git/index bytes must be unchanged by diff (Wip/Worktree)");
        assert_eq!(before_mtime, after_mtime, ".git/index mtime must be unchanged by diff (Wip/Worktree)");
    }

    /// The companion case: a file that's both stat-dirty *and* really changed must still be
    /// listed, by both specs. The phantom-entry filter must not swallow real changes.
    #[tokio::test]
    async fn stat_dirty_and_really_changed_file_is_still_listed() {
        let r = TestRepo::new();
        r.write("f.txt", "hello\n");
        r.commit_all_as("c", "Ada Lovelace", "ada@example.com");
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let root = r.git(&["rev-parse", "HEAD"]);

        r.write("f.txt", "hello\nworld\n");
        bump_mtime(&wt.join("f.txt"));

        let wip = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: false }, Some(&wt)).await.unwrap();
        assert_eq!(wip.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["f.txt"], "a real change must still be listed (Wip)");

        let worktree_diff = file_list(&repo, &cli(), r.path(), &DiffSpec::Worktree { from: root, worktree: name }, Some(&wt)).await.unwrap();
        assert!(worktree_diff.files.iter().any(|f| f.path == "f.txt"), "a real change must still be listed (Worktree): {:?}", worktree_diff.files);
    }

    /// C1 fix-round-1 regression: a binary's numstat is always `-\t-\tpath` (`has_numstat` is
    /// true even when nothing changed), so a stat-dirty-but-byte-identical binary must still be
    /// dropped via the `dirty`/`git status` cross-check, not kept just because it has a numstat
    /// record. And, as ever, no write to `.git/index`.
    #[tokio::test]
    async fn stat_dirty_unchanged_binary_is_not_listed_and_index_is_untouched() {
        let r = TestRepo::new();
        r.write_bytes("f.bin", b"\x00\x01\x02binary data\x00");
        r.commit_all_as("c", "Ada Lovelace", "ada@example.com");
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let root = r.git(&["rev-parse", "HEAD"]);

        bump_mtime(&wt.join("f.bin"));

        let index_path = wt.join(".git/index");
        let before_bytes = std::fs::read(&index_path).unwrap();
        let before_mtime = std::fs::metadata(&index_path).unwrap().modified().unwrap();

        let wip = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: false }, Some(&wt)).await.unwrap();
        assert!(wip.files.iter().all(|f| f.path != "f.bin"), "stat-dirty but byte-identical binary must not be listed (Wip): {:?}", wip.files);

        let worktree_diff = file_list(&repo, &cli(), r.path(), &DiffSpec::Worktree { from: root, worktree: name }, Some(&wt)).await.unwrap();
        assert!(worktree_diff.files.iter().all(|f| f.path != "f.bin"), "stat-dirty but byte-identical binary must not be listed (Worktree): {:?}", worktree_diff.files);

        let after_bytes = std::fs::read(&index_path).unwrap();
        let after_mtime = std::fs::metadata(&index_path).unwrap().modified().unwrap();
        assert_eq!(before_bytes, after_bytes, ".git/index bytes must be unchanged by diff (Wip/Worktree, binary)");
        assert_eq!(before_mtime, after_mtime, ".git/index mtime must be unchanged by diff (Wip/Worktree, binary)");
    }

    /// The companion case for a binary: stat-dirty *and* really changed must still be listed.
    #[tokio::test]
    async fn stat_dirty_binary_that_really_changed_is_still_listed() {
        let r = TestRepo::new();
        r.write_bytes("f.bin", b"\x00\x01\x02binary data\x00");
        r.commit_all_as("c", "Ada Lovelace", "ada@example.com");
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let root = r.git(&["rev-parse", "HEAD"]);

        r.write_bytes("f.bin", b"\x00\x01\x02different binary\x00");
        bump_mtime(&wt.join("f.bin"));

        let wip = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: false }, Some(&wt)).await.unwrap();
        assert_eq!(wip.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["f.bin"], "a real binary change must still be listed (Wip)");

        let worktree_diff = file_list(&repo, &cli(), r.path(), &DiffSpec::Worktree { from: root, worktree: name }, Some(&wt)).await.unwrap();
        assert!(worktree_diff.files.iter().any(|f| f.path == "f.bin"), "a real binary change must still be listed (Worktree): {:?}", worktree_diff.files);
    }

    /// Advances a nested git repository's own HEAD (used to build a "dirty submodule" scenario:
    /// a gitlink whose checkout has moved past what the superproject's index records).
    fn commit_in(dir: &Path, msg: &str) -> String {
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .envs(isolated_git_env())
                .env("GIT_AUTHOR_DATE", "@1767225600 +0000")
                .env("GIT_COMMITTER_DATE", "@1767225600 +0000")
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
            out
        };
        git(&["add", "-A"]);
        git(&["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
        String::from_utf8(git(&["rev-parse", "HEAD"]).stdout).unwrap().trim().to_string()
    }

    #[tokio::test]
    async fn unmerged_wip_path_is_listed_once() {
        let r = TestRepo::new();
        r.write("conflict.txt", "base\n");
        r.commit_all_as("base", "Ada Lovelace", "ada@example.com");
        r.switch_new("a");
        r.write("conflict.txt", "A content\n");
        r.commit_all_as("a", "Ada Lovelace", "ada@example.com");
        r.switch("main");
        r.write("conflict.txt", "B content\n");
        r.commit_all_as("b", "Ada Lovelace", "ada@example.com");
        let _ = r.try_git(&["merge", "-q", "--no-ff", "a"]); // conflicts; left unresolved on purpose
        let stage2 = r.git(&["rev-parse", ":2:conflict.txt"]);

        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name.clone(), staged: false }, Some(&wt)).await.unwrap();
        let matches: Vec<&FileChange> = list.files.iter().filter(|f| f.path == "conflict.txt").collect();
        assert_eq!(matches.len(), 1, "the conflicted path must not appear twice: {:?}", list.files);
        let f = matches[0];
        assert_eq!(f.status, "U");
        assert_eq!(f.old, BlobSource::Object { oid: stage2 }, "old is the stage-2 (\"ours\") blob");
        assert_eq!(f.new, BlobSource::Worktree { worktree: name });
        assert_eq!((f.additions, f.deletions), (Some(4), Some(0)));
        assert_eq!(list.added, 4, "the M record's counts must be totalled once, not twice");
    }

    /// Spec #2 §7.1: conflicted rows say what kind of conflict they are.
    #[tokio::test]
    async fn unmerged_wip_rows_carry_their_conflict_kind() {
        let r = TestRepo::new();
        crate::testing::fixtures::wip_conflict(&r);
        let repo = gix::ThreadSafeRepository::open(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.display().to_string();
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name, staged: false }, Some(&wt)).await.unwrap();
        let c = list.files.iter().find(|f| f.path == "c.txt").unwrap();
        assert_eq!(c.conflict, Some(crate::payload::ConflictKind::BothModified));
        let side = list.files.iter().find(|f| f.path == "side.txt").unwrap();
        assert_eq!(side.conflict, None);
    }

    #[tokio::test]
    async fn dirty_submodule_resolves_to_its_checked_out_head() {
        let r = TestRepo::new();
        r.write("root.txt", "root\n");
        r.commit_all_as("root", "Ada Lovelace", "ada@example.com");
        let sub_dir = r.path().join("vendor/lib");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let init = std::process::Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&sub_dir).envs(isolated_git_env()).output().unwrap();
        assert!(init.status.success(), "{}", String::from_utf8_lossy(&init.stderr));
        std::fs::write(sub_dir.join("f.txt"), "one\n").unwrap();
        commit_in(&sub_dir, "sub one");
        r.git(&["add", "vendor/lib"]); // any directory holding its own .git stages as a gitlink
        r.commit_all_as("add submodule", "Ada Lovelace", "ada@example.com");
        std::fs::write(sub_dir.join("f.txt"), "two\n").unwrap();
        let oid2 = commit_in(&sub_dir, "sub two"); // advances the checkout past the index's record

        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Wip { worktree: name, staged: false }, Some(&wt)).await.unwrap();
        let f = list.files.iter().find(|f| f.path == "vendor/lib").unwrap();
        assert!(f.submodule);
        assert_eq!(f.new, BlobSource::Submodule { oid: oid2 }, "resolved to what's actually checked out, not the null oid git printed");
    }

    #[test]
    fn submodule_head_is_absent_when_not_checked_out() {
        // Inside a real superproject (not a bare tempdir): an empty submodule directory must
        // never resolve to the *superproject's own* HEAD via upward repository discovery.
        let r = TestRepo::new();
        r.commit("root");
        let empty = r.path().join("vendor/lib");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(resolve_submodule_head(r.path(), "vendor/lib"), BlobSource::Absent, "must not fall back to the superproject's own HEAD");
        assert_eq!(resolve_submodule_head(r.path(), "nope"), BlobSource::Absent, "path doesn't exist");
    }

    #[cfg(unix)]
    #[test]
    fn submodule_head_is_absent_for_a_symlinked_path() {
        let r = TestRepo::new();
        r.commit("root");
        std::os::unix::fs::symlink(".git", r.path().join("linked")).unwrap();
        assert_eq!(resolve_submodule_head(r.path(), "linked"), BlobSource::Absent, "a symlinked path must not be opened, even if it points at .git");
    }

    // --- Image format changes (png → webp): one renamed row ---

    fn change(path: &str, status: &str, oid: char) -> FileChange {
        let blob = BlobSource::Object { oid: oid.to_string().repeat(40) };
        let (old, new) = match status {
            "D" => (blob, BlobSource::Absent),
            "A" => (BlobSource::Absent, blob),
            _ => (blob.clone(), blob),
        };
        FileChange { path: path.into(), old_path: None, status: status.into(), additions: None, deletions: None, old, new, submodule: false, conflict: None }
    }

    fn rows(files: &[FileChange]) -> Vec<(&str, Option<&str>, &str)> {
        files.iter().map(|f| (f.path.as_str(), f.old_path.as_deref(), f.status.as_str())).collect()
    }

    #[test]
    fn a_deleted_and_an_added_image_with_the_same_stem_pair_as_a_rename() {
        let files = vec![change("docs/a.txt", "M", 'c'), change("docs/images/screenshot.png", "D", 'a'), change("docs/images/screenshot.webp", "A", 'b')];
        let paired = pair_image_conversions(files);
        assert_eq!(rows(&paired), vec![("docs/a.txt", None, "M"), ("docs/images/screenshot.webp", Some("docs/images/screenshot.png"), "R")]);
        assert_eq!(paired[1].old, BlobSource::Object { oid: "a".repeat(40) }, "old: the deleted blob");
        assert_eq!(paired[1].new, BlobSource::Object { oid: "b".repeat(40) }, "new: the added blob");
    }

    #[test]
    fn every_image_type_the_image_diff_shows_pairs_in_any_case() {
        for (from, to) in [("png", "webp"), ("JPG", "avif"), ("jpeg", "gif"), ("bmp", "ico"), ("svg", "png"), ("png", "SVG")] {
            let paired = pair_image_conversions(vec![change(&format!("i.{to}"), "A", 'b'), change(&format!("i.{from}"), "D", 'a')]);
            assert_eq!(rows(&paired), vec![(format!("i.{to}").as_str(), Some(format!("i.{from}").as_str()), "R")], "{from} → {to}");
        }
    }

    #[test]
    fn an_svg_side_keeps_its_line_count() {
        let mut svg = change("logo.svg", "D", 'a');
        svg.deletions = Some(12);
        let paired = pair_image_conversions(vec![svg, change("logo.png", "A", 'b')]);
        assert_eq!((paired[0].additions, paired[0].deletions), (None, Some(12)));
        assert_eq!(totals(paired).deleted, 12, "the totals don't change");
    }

    #[test]
    fn images_in_different_folders_or_with_other_stems_stay_apart() {
        let apart = vec![change("a/shot.png", "D", 'a'), change("b/shot.webp", "A", 'b'), change("x.png", "D", 'c'), change("y.webp", "A", 'd')];
        assert_eq!(pair_image_conversions(apart.clone()), apart);
    }

    #[test]
    fn two_candidates_for_one_stem_stay_apart() {
        let two_added = vec![change("i.png", "D", 'a'), change("i.webp", "A", 'b'), change("i.avif", "A", 'c')];
        assert_eq!(pair_image_conversions(two_added.clone()), two_added);
        let two_deleted = vec![change("i.png", "D", 'a'), change("i.jpg", "D", 'c'), change("i.webp", "A", 'b')];
        assert_eq!(pair_image_conversions(two_deleted.clone()), two_deleted);
    }

    #[test]
    fn non_images_and_other_statuses_stay_apart() {
        let other = vec![
            change("notes.txt", "D", 'a'),
            change("notes.md", "A", 'b'),
            change("pic.png", "D", 'c'),
            change("pic.tiff", "A", 'd'),
            change("m.png", "M", 'e'),
            change("m.webp", "A", 'f'),
            change(".png", "D", '1'),
            change(".webp", "A", '2'),
        ];
        assert_eq!(pair_image_conversions(other.clone()), other);
        let mut sub = vec![change("s.png", "D", 'a'), change("s.webp", "A", 'b')];
        sub[0].submodule = true;
        assert_eq!(pair_image_conversions(sub.clone()), sub, "a submodule is never an image");
    }

    fn png() -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend([7u8; 64]);
        b
    }

    fn webp() -> Vec<u8> {
        let mut b = b"RIFF\x40\0\0\0WEBPVP8L".to_vec();
        b.extend([3u8; 64]);
        b
    }

    #[tokio::test]
    async fn a_commit_converting_an_image_lists_one_renamed_row() {
        let r = TestRepo::new();
        r.write_bytes("docs/images/screenshot.png", &png());
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "png"]);
        std::fs::remove_file(r.path().join("docs/images/screenshot.png")).unwrap();
        r.write_bytes("docs/images/screenshot.webp", &webp());
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "webp"]);
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let id = r.git(&["rev-parse", "HEAD"]);
        let list = file_list(&repo, &cli(), r.path(), &DiffSpec::Commit { id, parent: 0 }, None).await.unwrap();
        assert_eq!(rows(&list.files), vec![("docs/images/screenshot.webp", Some("docs/images/screenshot.png"), "R")]);
        assert_eq!(list.files[0].old, BlobSource::Object { oid: r.git(&["rev-parse", "HEAD^:docs/images/screenshot.png"]) });
        assert_eq!(list.files[0].new, BlobSource::Object { oid: r.git(&["rev-parse", "HEAD:docs/images/screenshot.webp"]) });
    }

    #[tokio::test]
    async fn wip_pairs_within_one_stage_only() {
        let r = TestRepo::new();
        r.write_bytes("a.png", &png());
        r.write_bytes("b.png", &png());
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "pngs"]);
        let repo = gix::ThreadSafeRepository::discover(r.path()).unwrap();
        let wt = r.path().canonicalize().unwrap();
        let name = wt.to_string_lossy().into_owned();
        let wip = |staged| DiffSpec::Wip { worktree: name.clone(), staged };
        let c = cli();
        // a: both halves unstaged (a deleted tracked file and an untracked one): one row.
        std::fs::remove_file(r.path().join("a.png")).unwrap();
        r.write_bytes("a.webp", &webp());
        // b: the deletion staged, the new file not: two rows, one in each list.
        r.git(&["rm", "-q", "b.png"]);
        r.write_bytes("b.webp", &webp());
        let (staged, unstaged) = (file_list(&repo, &c, r.path(), &wip(true), Some(&wt)).await.unwrap(), file_list(&repo, &c, r.path(), &wip(false), Some(&wt)).await.unwrap());
        assert_eq!(rows(&staged.files), vec![("b.png", None, "D")]);
        assert_eq!(rows(&unstaged.files), vec![("a.webp", Some("a.png"), "R"), ("b.webp", None, "A")]);
        assert_eq!(unstaged.files[0].new, BlobSource::Worktree { worktree: name.clone() });
        // Staging a's two halves pairs them in the staged list instead.
        r.git(&["add", "-A", "--", "a.png", "a.webp"]);
        let (staged, unstaged) = (file_list(&repo, &c, r.path(), &wip(true), Some(&wt)).await.unwrap(), file_list(&repo, &c, r.path(), &wip(false), Some(&wt)).await.unwrap());
        assert_eq!(rows(&staged.files), vec![("a.webp", Some("a.png"), "R"), ("b.png", None, "D")]);
        assert_eq!(rows(&unstaged.files), vec![("b.webp", None, "A")]);
    }
}
