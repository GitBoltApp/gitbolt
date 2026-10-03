//! The merge tool's data (spec #2 §13.3), read-only. Index stages 1/2/3 are merged with
//! `git merge-file --diff3` on temp copies (Deviation 2: git's own xdiff, as 2A's autostash
//! prediction does; nothing is written to the repository). The markers carry a per-call nonce at
//! size 48, so file content can't be mistaken for one. The two panes are the full stage-2 and
//! stage-3 texts; each region's place in them comes from a line diff of "every region taken from
//! that side" against the side's text (the region's lines are verbatim in it).
//!
//! Line endings (T7 review): every line keeps its own terminator in the region data. A
//! `Conflict` line is `"text\n"`, `"text\r\n"`, or `"text"` for a last line with no newline; the
//! merged output is the plain concatenation of common text and ticked lines.

use crate::api::{blocking, Api};
use crate::blob::{decode_blob, worktree_id};
use crate::error::{gix_err, ErrorDetail, GbError, GbErrorKind};
use crate::events::{ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::journal::{resolve_step, UndoKind};
use crate::payload::{ConflictKind, Eol};
use crate::write::{Staging, WriteClass, WriteCx, WriteIntent};
use gix::bstr::ByteSlice;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum Segment {
    /// Whole lines, each with its own terminator (the file's last line may have none).
    Common { text: String },
    /// Lines WITH their own terminators (`\n`, `\r\n`, or none on a file's last line).
    Conflict { id: u32, base: Vec<String>, current: Vec<String>, incoming: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneRegion {
    pub id: u32,
    /// 1-based; an empty region sits before this line.
    pub start: u32,
    pub lines: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Pane {
    pub text: String,
    pub regions: Vec<PaneRegion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConflictLabels {
    pub current: String,
    pub incoming: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConflictFilePayload {
    pub path: String,
    pub kind: ConflictKind,
    /// Both sides are text: the panes and the output. Otherwise: Take current / Take incoming /
    /// Delete file.
    pub text: bool,
    pub segments: Vec<Segment>,
    pub current: Option<Pane>,
    pub incoming: Option<Pane>,
    pub labels: ConflictLabels,
    /// The worktree file's, for the save (§7.5): `UTF-8`, `UTF-8 BOM`, …
    pub encoding: String,
    pub eol: Eol,
    /// The worktree file's hash (`ResolveFile`'s `base`); `None` when there's no file.
    pub base: Option<String>,
}

const MARKER: usize = 48;

/// The marker size for these inputs: 48, or longer until no input line is exactly a marker-sized
/// run of `=` (the middle marker carries no label, so content must not be able to imitate it).
fn marker_size(texts: &[&str]) -> usize {
    let mut size = MARKER;
    while texts.iter().any(|t| t.lines().any(|l| l.trim_end_matches('\r') == "=".repeat(size))) {
        size += 1;
    }
    size
}

/// `git merge-file --diff3` output (markers of size `MARKER`, labels `<nonce>c`, `<nonce>b`,
/// `<nonce>i`) → segments. Lines keep their terminators.
pub(crate) fn parse_markers(text: &str, nonce: &str, size: usize) -> Vec<Segment> {
    let open = format!("{} {nonce}c", "<".repeat(size));
    let base = format!("{} {nonce}b", "|".repeat(size));
    let mid = "=".repeat(size);
    let close = format!("{} {nonce}i", ">".repeat(size));
    #[derive(PartialEq)]
    enum At {
        Common,
        Current,
        Base,
        Incoming,
    }
    let (mut out, mut common, mut at, mut id) = (Vec::new(), String::new(), At::Common, 0u32);
    let (mut cur, mut bas, mut inc): (Vec<String>, Vec<String>, Vec<String>) = (Vec::new(), Vec::new(), Vec::new());
    for line in text.split_inclusive('\n') {
        // Git writes the markers with the file's own line ending.
        let bare = line.strip_suffix('\n').unwrap_or(line);
        let bare = bare.strip_suffix('\r').unwrap_or(bare);
        match (&at, bare) {
            (At::Common, l) if l == open => {
                if !common.is_empty() {
                    out.push(Segment::Common { text: std::mem::take(&mut common) });
                }
                at = At::Current;
            }
            (At::Current, l) if l == base => at = At::Base,
            (At::Current | At::Base, l) if l == mid => at = At::Incoming,
            (At::Incoming, l) if l == close => {
                out.push(Segment::Conflict { id, base: std::mem::take(&mut bas), current: std::mem::take(&mut cur), incoming: std::mem::take(&mut inc) });
                id += 1;
                at = At::Common;
            }
            (At::Common, _) => common.push_str(line),
            (At::Current, _) => cur.push(line.to_string()),
            (At::Base, _) => bas.push(line.to_string()),
            (At::Incoming, _) => inc.push(line.to_string()),
        }
    }
    if !common.is_empty() {
        out.push(Segment::Common { text: common });
    }
    out
}

/// `merge-file` terminates a conflict side's last line before its closing marker even when that
/// side's file ends without a newline. A conflict that ends the file gets that line's original
/// (missing) terminator back.
fn restore_missing_final_newline(segs: &mut [Segment], current: &str, incoming: &str, base: &str) {
    let Some(Segment::Conflict { base: b, current: c, incoming: i, .. }) = segs.last_mut() else { return };
    for (lines, text) in [(c, current), (i, incoming), (b, base)] {
        if !text.ends_with('\n')
            && let Some(last) = lines.last_mut()
        {
            // Back to the side's own last line: merge-file added `\n` (`\r\n` in a CRLF file),
            // and a real trailing `\r` is the line's own.
            let tail = text.rsplit('\n').next().unwrap_or_default();
            if last.starts_with(tail) && matches!(&last[tail.len()..], "\n" | "\r\n") {
                *last = tail.to_string();
            }
        }
    }
}

fn line_count(text: &str) -> u32 {
    text.matches('\n').count() as u32 + u32::from(!text.is_empty() && !text.ends_with('\n'))
}

/// Each region's place in one side's full text (Deviation 2).
fn pane(segs: &[Segment], current: bool, full: &str) -> Pane {
    use gix::diff::blob::{Algorithm, Diff, InternedInput};
    let mut view = String::new();
    let mut spans = Vec::new();
    let mut line = 0u32;
    for s in segs {
        match s {
            Segment::Common { text } => {
                view.push_str(text);
                line += line_count(text);
            }
            Segment::Conflict { id, current: c, incoming: i, .. } => {
                let lines = if current { c } else { i };
                spans.push((*id, line, lines.len() as u32));
                for l in lines {
                    view.push_str(l);
                }
                line += lines.len() as u32;
            }
        }
    }
    let input = InternedInput::new(view.as_str(), full);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    let total = line as usize;
    let mut map: Vec<Option<u32>> = vec![None; total + 1];
    let (mut i, mut j) = (0u32, 0u32);
    for h in diff.hunks() {
        while i < h.before.start {
            map[i as usize] = Some(j);
            i += 1;
            j += 1;
        }
        i = h.before.end;
        j = h.after.end;
    }
    while (i as usize) < total {
        map[i as usize] = Some(j);
        i += 1;
        j += 1;
    }
    let full_lines = line_count(full);
    let regions = spans
        .into_iter()
        .map(|(id, start, lines)| {
            let at = if lines > 0 { map[start as usize] } else { None };
            let mapped = at.or_else(|| map[(start + lines) as usize..].iter().flatten().next().copied()).unwrap_or(full_lines);
            PaneRegion { id, start: mapped + 1, lines }
        })
        .collect();
    Pane { text: full.to_string(), regions }
}

/// The worktree bytes' hash, as 2B's `WipBase.worktree` spells it.
pub(crate) fn file_hash(bytes: &[u8]) -> String {
    worktree_id(bytes)
}

/// The labels (§13.3): a GitBolt-started op's own target name first, then git's files.
fn labels(repo: &gix::Repository, state: Option<&crate::in_progress::InProgress>, paused_target: Option<String>) -> ConflictLabels {
    use crate::in_progress::InProgress;
    let short = |oid: &str| oid.get(..7).unwrap_or(oid).to_string();
    let subject = |oid: &str| repo.rev_parse_single(oid).ok().and_then(|id| Some(id.object().ok()?.try_into_commit().ok()?.message().ok()?.summary().to_string())).unwrap_or_default();
    match state {
        Some(InProgress::Merge { merge_head, message, .. }) => {
            let named = message
                .lines()
                .next()
                .and_then(|l| l.strip_prefix("Merge branch '").or_else(|| l.strip_prefix("Merge remote-tracking branch '")))
                .and_then(|r| r.split('\'').next())
                .map(str::to_string);
            let current = repo.head_name().ok().flatten().map(|n| n.shorten().to_string()).unwrap_or_else(|| "HEAD".into());
            ConflictLabels { current, incoming: paused_target.or(named).unwrap_or_else(|| short(merge_head)) }
        }
        Some(InProgress::Rebase { onto, stopped_at, .. }) => {
            let replayed = stopped_at.as_deref().map(|s| format!("{} {}", short(s), subject(s)).trim_end().to_string()).unwrap_or_default();
            ConflictLabels { current: paused_target.unwrap_or_else(|| short(onto)), incoming: replayed }
        }
        _ => ConflictLabels { current: "Current".into(), incoming: "Incoming".into() },
    }
}

pub(crate) fn kind_of(base: bool, current: bool, incoming: bool) -> Option<ConflictKind> {
    Some(match (base, current, incoming) {
        (true, true, true) => ConflictKind::BothModified,
        (false, true, true) => ConflictKind::BothAdded,
        (true, false, true) => ConflictKind::DeletedByUs,
        (true, true, false) => ConflictKind::DeletedByThem,
        (false, true, false) => ConflictKind::AddedByUs,
        (false, false, true) => ConflictKind::AddedByThem,
        (true, false, false) => ConflictKind::BothDeleted,
        (false, false, false) => return None,
    })
}

pub(crate) async fn conflict_file(api: &Api, repo: u32, worktree: &str, path: String) -> Result<Option<ConflictFilePayload>, GbError> {
    crate::blob::check_relative(&path)?;
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let paused_target = api.journal(&root).ok().and_then(|s| s.load().ok()).and_then(|j| j.paused().and_then(|e| e.paused.as_ref().map(|p| p.target.clone())));
    let tmp = api.tmp_dir()?;
    let (r, p) = (root.clone(), path.clone());
    let read = blocking(move || {
        let repo = gix::open(&r).map_err(gix_err)?;
        let index = repo.index_or_empty().map_err(gix_err)?;
        let mut stages: [Option<Vec<u8>>; 3] = [None, None, None];
        let mut gitlink = false;
        for e in index.entries().iter().filter(|e| e.path(&index) == p.as_bytes().as_bstr()) {
            let stage = e.stage_raw() as usize;
            if (1..=3).contains(&stage) {
                // A submodule's commit isn't in this repository: present, with no text.
                if e.mode == gix::index::entry::Mode::COMMIT {
                    gitlink = true;
                    stages[stage - 1] = Some(Vec::new());
                } else {
                    stages[stage - 1] = Some(repo.find_object(e.id).map_err(gix_err)?.detach().data);
                }
            }
        }
        let state = crate::in_progress::read(&r)?;
        let labels = labels(&repo, state.as_ref(), paused_target);
        let on_disk = std::fs::read(r.join(&p)).ok();
        Ok::<_, GbError>((stages, labels, on_disk, gitlink))
    })
    .await?;
    let ([base, current, incoming], labels, on_disk, gitlink) = read;
    let Some(kind) = kind_of(base.is_some(), current.is_some(), incoming.is_some()) else { return Ok(None) };
    let disk = on_disk.as_deref().map(|b| decode_blob(b, None));
    let (encoding, eol) = disk.as_ref().filter(|d| !d.binary).map(|d| (d.encoding.clone(), d.eol)).unwrap_or_else(|| ("UTF-8".into(), Eol::Lf));
    let base_hash = on_disk.as_deref().map(file_hash);
    let decoded = |b: &Option<Vec<u8>>| b.as_deref().map(|b| decode_blob(b, None)).filter(|d| !d.binary).and_then(|d| d.text);
    // A binary base next to text sides can't be merged as text either.
    let base_text = match &base {
        None => Some(String::new()),
        Some(_) => decoded(&base),
    };
    let (false, Some(cur_text), Some(inc_text), Some(base_text)) = (gitlink, decoded(&current), decoded(&incoming), base_text) else {
        return Ok(Some(ConflictFilePayload { path, kind, text: false, segments: Vec::new(), current: None, incoming: None, labels, encoding, eol, base: base_hash }));
    };
    let dir = tempfile::Builder::new().prefix("conflict-").tempdir_in(&tmp)?;
    let (cp, bp, ip) = (dir.path().join("current"), dir.path().join("base"), dir.path().join("incoming"));
    std::fs::write(&cp, cur_text.as_bytes())?;
    std::fs::write(&bp, base_text.as_bytes())?;
    std::fs::write(&ip, inc_text.as_bytes())?;
    let nonce = crate::random::random_hex(8);
    let msize = marker_size(&[&cur_text, &base_text, &inc_text]);
    let size = format!("--marker-size={msize}");
    let (lc, lb, li) = (format!("{nonce}c"), format!("{nonce}b"), format!("{nonce}i"));
    let args: Vec<std::ffi::OsString> = ["merge-file", "-q", "--diff3", size.as_str(), "-L", lc.as_str(), "-L", lb.as_str(), "-L", li.as_str()].into_iter().map(Into::into).chain([cp.clone(), bp, ip].map(|p| p.into_os_string())).collect();
    // A positive exit is the number of conflicts; a real failure prints to stderr.
    if let Err(e) = api.cli.run(GitInvocation::new(dir.path(), args)).await
        && e.stderr.as_deref().is_some_and(|s| !s.trim().is_empty())
    {
        return Err(e);
    }
    let merged = std::fs::read_to_string(&cp)?;
    let mut segments = parse_markers(&merged, &nonce, msize);
    restore_missing_final_newline(&mut segments, &cur_text, &inc_text, &base_text);
    let current = Some(pane(&segments, true, &cur_text));
    let incoming = Some(pane(&segments, false, &inc_text));
    Ok(Some(ConflictFilePayload { path, kind, text: true, segments, current, incoming, labels, encoding, eol, base: base_hash }))
}

// --- 2D T15: resolving a conflicted file ---

/// How one conflicted file is resolved (spec #2 §13.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum Resolution {
    /// The merge tool's output, each line with its own terminator (the EOL ruling), written as
    /// sent. One exception: in a file whose lines all end in CRLF, a bare `\n` becomes `\r\n`
    /// (an `autocrlf` or `eol=crlf` worktree, where the stages, hence the regions, are LF).
    Text { text: String },
    /// Stage 2 (git's "ours"): its file checked out and staged, or its submodule commit staged;
    /// removed when that side deleted the path.
    Current,
    /// Stage 3 (git's "theirs"), as `Current`.
    Incoming,
    Delete,
    /// Mark resolved: the file as it is.
    AsIs,
}

pub(crate) struct ResolveIntent {
    pub path: String,
    pub resolution: Resolution,
    /// `conflictFile`'s hash of the worktree file: a `Text` save requires it; for `Current` /
    /// `Incoming`, a file changed since is "Discard your edits?".
    pub base: Option<String>,
    pub confirm_markers: bool,
    /// "Discard your edits to <path>?" answered yes.
    pub confirm_discard: bool,
}

/// One index entry of a conflicted path.
struct Side {
    gitlink: bool,
    oid: String,
}

/// The path's entries at stages 1 (base), 2 (current) and 3 (incoming).
type Stages = [Option<Side>; 3];

fn read_stages(root: &std::path::Path, path: &str) -> Result<Stages, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let index = repo.index_or_empty().map_err(gix_err)?;
    let mut out: Stages = [None, None, None];
    for e in index.entries().iter().filter(|e| e.path(&index) == path.as_bytes().as_bstr()) {
        let stage = e.stage_raw() as usize;
        if (1..=3).contains(&stage) {
            out[stage - 1] = Some(Side { gitlink: e.mode == gix::index::entry::Mode::COMMIT, oid: e.id.to_string() });
        }
    }
    Ok(out)
}

/// git's markers of `size` (7, or the path's `conflict-marker-size`), all three kinds, at line
/// starts: `<<<<<<< label`, `=======`, `>>>>>>> label`.
fn has_markers(text: &str, size: usize) -> bool {
    let is = |c: char, l: &str, labelled: bool| {
        let run = c.to_string().repeat(size);
        l.strip_prefix(run.as_str()).is_some_and(|rest| rest.is_empty() || (labelled && rest.starts_with(' ')))
    };
    let any = |c: char, labelled: bool| text.lines().any(|l| is(c, l, labelled));
    any('<', true) && any('=', false) && any('>', true)
}

/// A user's path for the resolve commands: never a glob (`[id].tsx` is one file).
fn literal(inv: GitInvocation) -> GitInvocation {
    inv.env("GIT_LITERAL_PATHSPECS", "1")
}

/// The worktree file's text, decoded with its `working-tree-encoding` (`None`: no file, or not
/// text), and its marker size.
async fn disk_text(cx: &WriteCx<'_>, path: &str) -> Result<(Option<String>, usize), GbError> {
    let file = crate::blob::safe_join(cx.root, path)?;
    if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file()) {
        return Ok((None, 7));
    }
    let bytes = std::fs::read(&file)?;
    let declared = crate::blob::working_tree_encoding(&cx.api.cli, cx.root, path).await?;
    let out = cx.api.cli.run(GitInvocation::new(cx.root, ["check-attr", "-z", "conflict-marker-size", "--", path])).await?;
    let size = crate::blob::parse_check_attr(&out.stdout).and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0).unwrap_or(7);
    let d = decode_blob(&bytes, declared.as_deref());
    Ok((d.text.filter(|_| !d.binary), size))
}

/// The labels git wrote on the file's markers (`<<<<<<< HEAD`, `||||||| base`, `>>>>>>> x`),
/// the first of each, and whether it has base (diff3) markers.
fn disk_labels(text: &str, size: usize) -> (String, String, Option<String>) {
    let label = |c: char| {
        let open = format!("{} ", c.to_string().repeat(size));
        text.lines().find_map(|l| l.strip_prefix(open.as_str()).map(str::to_string))
    };
    (label('<').unwrap_or_default(), label('>').unwrap_or_default(), label('|'))
}

/// A blob's bytes look binary to git (a NUL in its first 8000 bytes, `buffer_is_binary`).
fn git_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

/// The blob id of the file git left in the worktree for this conflict, in the index's (clean)
/// form; `None` when it can't be told exactly (a submodule side, a merge-file failure).
/// - One side present (modify/delete, a rename's halves): that side's file.
/// - A binary side: git keeps the current side's file.
/// - Both text: `git merge-file` over the raw stages (an empty base for add/add), with the
///   labels read off the file's own markers, its marker size and the configured style.
async fn git_conflicted_id(cx: &WriteCx<'_>, stages: &Stages, text: Option<&str>, size: usize) -> Result<Option<String>, GbError> {
    if stages.iter().flatten().any(|s| s.gitlink) {
        return Ok(None);
    }
    let (cur, inc) = match (&stages[1], &stages[2]) {
        (Some(c), Some(i)) => (c.oid.clone(), i.oid.clone()),
        (Some(one), None) | (None, Some(one)) => return Ok(Some(one.oid.clone())),
        (None, None) => return Ok(None),
    };
    let base = stages[0].as_ref().map(|s| s.oid.clone());
    let root = cx.root.to_path_buf();
    let (cur_id, inc_id) = (cur.clone(), inc.clone());
    let (blobs, style) = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let read = |oid: &str| -> Result<Vec<u8>, GbError> {
            let id = gix::ObjectId::from_hex(oid.as_bytes()).map_err(|e| GbError::new(GbErrorKind::Other, e.to_string()))?;
            Ok(repo.find_object(id).map_err(gix_err)?.detach().data)
        };
        let base = base.as_deref().map(read).transpose()?.unwrap_or_default();
        let style = repo.config_snapshot().string("merge.conflictStyle").map(|s| s.to_string());
        Ok::<_, GbError>(([read(&cur_id)?, base, read(&inc_id)?], style))
    })
    .await?;
    if blobs.iter().any(|b| git_binary(b)) {
        return Ok(Some(cur));
    }
    let (lc, li, lb) = text.map(|t| disk_labels(t, size)).unwrap_or_default();
    let diff3 = lb.is_some();
    let dir = tempfile::Builder::new().prefix("conflict-").tempdir_in(&cx.tmp)?;
    let names = ["current", "base", "incoming"].map(|n| dir.path().join(n));
    for (p, b) in names.iter().zip(&blobs) {
        std::fs::write(p, b)?;
    }
    let mut args: Vec<std::ffi::OsString> = vec!["merge-file".into(), "-q".into(), format!("--marker-size={size}").into()];
    if diff3 {
        args.push(if style.as_deref() == Some("zdiff3") { "--zdiff3" } else { "--diff3" }.into());
    }
    for l in [lc, lb.unwrap_or_default(), li] {
        args.extend(["-L".into(), l.into()]);
    }
    args.extend(names.iter().map(|p| p.clone().into_os_string()));
    // A positive exit is the number of conflicts; a real failure prints to stderr.
    if let Err(e) = cx.api.cli.run(GitInvocation::new(dir.path(), args)).await
        && e.stderr.as_deref().is_some_and(|s| !s.trim().is_empty())
    {
        return Ok(None);
    }
    Ok(Some(worktree_id(&std::fs::read(&names[0])?)))
}

/// Whether taking a side or deleting would throw away the user's own edits (the M4 ruling):
/// the file isn't byte for byte what git left (compared in the index's form, so `autocrlf` and
/// `working-tree-encoding` don't count), or that can't be told, or it changed since the caller
/// read it (`base`, the merge tool's). No file: nothing to lose.
async fn hand_edited(cx: &WriteCx<'_>, path: &str, stages: &Stages, base: Option<&str>) -> Result<bool, GbError> {
    let file = crate::blob::safe_join(cx.root, path)?;
    if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file()) {
        return Ok(false);
    }
    let bytes = std::fs::read(&file)?;
    if base.is_some_and(|b| b != file_hash(&bytes)) {
        return Ok(true);
    }
    let (text, size) = disk_text(cx, path).await?;
    let Some(expected) = git_conflicted_id(cx, stages, text.as_deref(), size).await? else { return Ok(true) };
    // The file as git would store it (its clean filters).
    let args: Vec<std::ffi::OsString> = vec!["hash-object".into(), format!("--path={path}").into(), "--".into(), file.into_os_string()];
    let out = cx.api.cli.run(GitInvocation::new(cx.root, args)).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim() != expected)
}

/// The merge tool's save (§7.5 rules, as 2B's `SaveFile`): a regular, writable, text file, only
/// over the bytes `conflictFile` hashed (`Stale` otherwise), in the file's encoding and BOM,
/// atomically. Lines as `Resolution::Text` says.
async fn write_text(cx: &WriteCx<'_>, path: &str, text: &str, base: Option<&str>) -> Result<(), GbError> {
    use crate::write::files::{encode, write_atomic};
    let file = crate::blob::safe_join(cx.root, path)?;
    let changed = || GbError::stale(format!("{path} changed on disk"));
    let meta = std::fs::symlink_metadata(&file).map_err(|_| changed())?;
    if !meta.file_type().is_file() {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} isn't a regular file: resolve it in your editor")));
    }
    if std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o200 == 0 {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is read-only: make it writable first")));
    }
    let bytes = std::fs::read(&file)?;
    if base != Some(file_hash(&bytes).as_str()) {
        return Err(changed());
    }
    let declared = crate::blob::working_tree_encoding(&cx.api.cli, cx.root, path).await?;
    let loaded = decode_blob(&bytes, declared.as_deref());
    if loaded.binary {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is binary: resolve it in your editor")));
    }
    let bom = encoding_rs::Encoding::for_bom(&bytes).is_some();
    let eol = if loaded.eol == Eol::Crlf { Eol::Crlf } else { Eol::None };
    write_atomic(&file, &encode(text, &loaded.encoding, eol, bom)?)
}

/// C1: a checkout or a removal where a repository stands would delete it, `.git` and all.
fn refuse_repo_in_the_way(root: &std::path::Path, path: &str) -> Result<(), GbError> {
    if crate::write::precheck::repo_at(root, path) {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("{path} is a repository in the way: move it first")));
    }
    Ok(())
}

/// A submodule side taken (review M-b) while the submodule is checked out at another commit: a
/// stage-all would stage that commit back. The UI warns; GitBolt never moves the submodule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmoduleBehind {
    pub path: String,
    /// The submodule's checked-out commit.
    pub head: String,
    /// The commit staged for it.
    pub taken: String,
}

/// The checked-out commit of the submodule at `path`; `None` when it isn't checked out.
fn submodule_head(root: &std::path::Path, path: &str) -> Option<String> {
    let dir = crate::blob::safe_join(root, path).ok()?;
    if !dir.join(".git").exists() {
        return None;
    }
    Some(gix::open(&dir).ok()?.head_id().ok()?.to_string())
}

impl WriteIntent for ResolveIntent {
    /// `Some` only after a submodule side was taken (`SubmoduleBehind`).
    type Outcome = Option<SubmoduleBehind>;
    fn kind(&self) -> OpKind {
        OpKind::Resolve
    }
    fn label(&self) -> String {
        format!("resolve {}", self.path)
    }
    fn class(&self) -> WriteClass {
        WriteClass::Immediate
    }
    /// Not journaled (§5.3): the merge's Abort undoes it.
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    /// A resolution is a staging undo step (ux round 2), recorded by `run` itself.
    fn staging(&self) -> Staging {
        Staging::Own
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<Option<SubmoduleBehind>, GbError> {
        let p = self.path.as_str();
        // Under the lock: a double send, or a row resolved elsewhere, must not act again (a
        // second Take current would `git rm` the resolved file).
        let (r, path) = (cx.root.to_path_buf(), p.to_string());
        let stages = blocking(move || read_stages(&r, &path)).await?;
        if stages.iter().all(Option::is_none) {
            return Err(GbError::stale(format!("{p} isn't conflicted anymore")));
        }
        // The staging undo step: the path's stages and file, kept before anything changes. Best
        // effort: a file that can't be kept (unreadable, say) is still resolved, just not undoable.
        let before = resolve_step::capture(cx, p).await.inspect_err(|e| tracing::warn!(target: "gitbolt_core::write", "resolve {p}: not undoable: {e}"));
        let behind = self.act(cx, &stages).await?;
        let after = if before.is_ok() { resolve_step::capture(cx, p).await.inspect_err(|e| tracing::warn!(target: "gitbolt_core::write", "resolve {p}: not undoable: {e}")).ok() } else { None };
        match (before.ok(), after) {
            (Some(before), Some(after)) => crate::journal::staging::record_resolve(cx, self.undo_label(), p, before, after),
            _ => cx.api.staging.with(cx.root, |l| l.redo.clear()),
        }
        Ok(behind)
    }
}

impl ResolveIntent {
    /// The staging undo log's label: "resolve a.txt with incoming", "mark a.txt resolved".
    fn undo_label(&self) -> String {
        let p = &self.path;
        match self.resolution {
            Resolution::Text { .. } => format!("resolve {p}"),
            Resolution::Current => format!("resolve {p} with current"),
            Resolution::Incoming => format!("resolve {p} with incoming"),
            Resolution::Delete => format!("resolve {p} by deleting it"),
            Resolution::AsIs => format!("mark {p} resolved"),
        }
    }

    async fn act(&self, cx: &mut WriteCx<'_>, stages: &Stages) -> Result<Option<SubmoduleBehind>, GbError> {
        let p = self.path.as_str();
        let mut behind = None;
        let root = cx.root;
        // A submodule's conflict is resolved in the index alone: its files are never touched.
        let gitlink = stages.iter().flatten().any(|s| s.gitlink);
        let add = |cx: &WriteCx<'_>| literal(cx.git(["add", "--", p]));
        let rm = |cx: &WriteCx<'_>| literal(cx.git(["rm", "-q", "--", p]));
        // Out of the index only (every stage); the submodule's folder stays as it is.
        let unlink = |cx: &WriteCx<'_>| literal(cx.git(["update-index", "--force-remove", "--", p]));
        match &self.resolution {
            Resolution::Text { text } => {
                write_text(cx, p, text, self.base.as_deref()).await?;
                cx.touch(ChangeKind::Worktree);
                let inv = add(cx);
                cx.run_git(inv).await?;
            }
            Resolution::Current | Resolution::Incoming => {
                let (stage, flag) = if self.resolution == Resolution::Current { (2, "--ours") } else { (3, "--theirs") };
                match &stages[stage - 1] {
                    // Review I2: the side's commit, staged as is (initialized or not).
                    Some(side) if side.gitlink => {
                        let inv = literal(cx.git(["update-index", "--cacheinfo", "160000", side.oid.as_str(), p]));
                        cx.run_git(inv).await?;
                        let (r, path) = (root.to_path_buf(), p.to_string());
                        if let Some(head) = blocking(move || Ok::<_, GbError>(submodule_head(&r, &path))).await?
                            && head != side.oid
                        {
                            behind = Some(SubmoduleBehind { path: p.to_string(), head, taken: side.oid.clone() });
                        }
                    }
                    None if gitlink => {
                        let inv = unlink(cx);
                        cx.run_git(inv).await?;
                    }
                    side => {
                        refuse_repo_in_the_way(root, p)?;
                        self.ask_before_discarding(cx, stages).await?;
                        if side.is_some() {
                            let inv = literal(cx.git(["checkout", flag, "--", p]));
                            cx.run_git(inv).await?;
                            let inv = add(cx);
                            cx.run_git(inv).await?;
                        } else {
                            // Review Focus 5: that side deleted the file.
                            let inv = rm(cx);
                            cx.run_git(inv).await?;
                        }
                    }
                }
            }
            Resolution::Delete => {
                let inv = if gitlink {
                    unlink(cx)
                } else {
                    refuse_repo_in_the_way(root, p)?;
                    // Review M-e: a Delete loses hand edits as surely as a Take.
                    self.ask_before_discarding(cx, stages).await?;
                    rm(cx)
                };
                cx.run_git(inv).await?;
            }
            Resolution::AsIs => {
                let (text, size) = disk_text(cx, p).await?;
                if !self.confirm_markers && text.is_some_and(|t| has_markers(&t, size)) {
                    return Err(GbError::new(GbErrorKind::Conflict, format!("{p} still has conflict markers")).with_detail(ErrorDetail::MarkersRemain { path: p.into() }));
                }
                let inv = add(cx);
                cx.run_git(inv).await?;
            }
        }
        cx.touch(ChangeKind::Index);
        cx.touch(ChangeKind::Worktree);
        Ok(behind)
    }

    /// "Discard your edits to <path>?" unless answered yes already.
    async fn ask_before_discarding(&self, cx: &WriteCx<'_>, stages: &Stages) -> Result<(), GbError> {
        let p = self.path.as_str();
        if !self.confirm_discard && hand_edited(cx, p, stages, self.base.as_deref()).await? {
            return Err(GbError::new(GbErrorKind::Conflict, format!("Discard your edits to {p}?")).with_detail(ErrorDetail::DiscardEdits { path: p.into() }));
        }
        Ok(())
    }
}
// --- end 2D T15 ---

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Api, Request};
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use std::sync::Arc;

    async fn setup(rebase: bool) -> (TestRepo, Api, u32, tempfile::TempDir) {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        let data = tempfile::tempdir().unwrap();
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
        let id = api.dispatch(Request::OpenRepo { path: r.path().display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32;
        if rebase {
            r.switch("feature/x");
            assert!(r.try_git(&["rebase", "main"]).is_err());
        } else {
            let wt = r.path().canonicalize().unwrap().display().to_string();
            crate::write::test_intents::run(&api, id, &wt, Default::default(), crate::write::test_intents::TestIntent::MergeStop { target: "feature/x".into() }).await.unwrap();
        }
        (r, api, id, data)
    }

    async fn file(api: &Api, id: u32, r: &TestRepo, path: &str) -> serde_json::Value {
        api.dispatch(Request::ConflictFile { repo: id, worktree: r.path().canonicalize().unwrap().display().to_string(), path: path.into() }).await.unwrap()
    }

    #[tokio::test]
    async fn a_text_conflict_has_segments_full_panes_and_mapped_regions() {
        let (r, api, id, _data) = setup(false).await;
        let f = file(&api, id, &r, "a.txt").await;
        assert_eq!(f["kind"], "bothModified");
        assert_eq!(f["text"], true);
        let segs = f["segments"].as_array().unwrap();
        let conflicts: Vec<&serde_json::Value> = segs.iter().filter(|s| s["kind"] == "conflict").collect();
        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0]["current"], serde_json::json!(["current three\n"]));
        assert_eq!(conflicts[0]["incoming"], serde_json::json!(["incoming three\n"]));
        assert_eq!(conflicts[0]["base"], serde_json::json!(["line 3\n"]));
        assert_eq!(segs[0], serde_json::json!({"kind": "common", "text": "line 0\nline 1\nline 2\n"}));
        let stage2 = r.git(&["show", ":2:a.txt"]) + "\n";
        assert_eq!(f["current"]["text"].as_str().unwrap(), stage2, "the pane is the full stage-2 file");
        assert_eq!(f["current"]["regions"], serde_json::json!([{"id": 0, "start": 4, "lines": 1}, {"id": 1, "start": 16, "lines": 1}]));
        assert_eq!(f["incoming"]["regions"], serde_json::json!([{"id": 0, "start": 4, "lines": 1}, {"id": 1, "start": 16, "lines": 1}]));
        assert_eq!(f["labels"], serde_json::json!({"current": "main", "incoming": "feature/x"}));
        assert_eq!((f["encoding"].as_str(), f["eol"].as_str()), (Some("UTF-8"), Some("lf")));
        assert!(f["base"].is_string());
    }

    #[tokio::test]
    async fn binary_and_one_sided_conflicts_get_no_panes() {
        let (r, api, id, _data) = setup(false).await;
        let bin = file(&api, id, &r, "logo.bin").await;
        assert_eq!((bin["kind"].as_str(), bin["text"].as_bool()), (Some("bothModified"), Some(false)));
        let gone = file(&api, id, &r, "gone.txt").await;
        assert_eq!((gone["kind"].as_str(), gone["text"].as_bool()), (Some("deletedByUs"), Some(false)));
        assert!(file(&api, id, &r, "clean.txt").await.is_null(), "not conflicted");
    }

    /// §13.3: in a rebase, Current is what it's rebased onto and Incoming the commit being
    /// replayed. Started outside GitBolt, the onto side has no name: its short oid.
    #[tokio::test]
    async fn rebase_labels_are_named_for_the_user() {
        let (r, api, id, _data) = setup(true).await;
        let f = file(&api, id, &r, "a.txt").await;
        let replayed = &r.git(&["rev-parse", "feature/x"])[..7];
        let onto = &r.git(&["rev-parse", "main"])[..7];
        assert_eq!(f["labels"], serde_json::json!({"current": onto, "incoming": format!("{replayed} Feature edits")}));
    }

    #[test]
    fn markers_parse_into_segments_with_the_nonce() {
        let text = "a\n<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< n1c\nx\n|||||||||||||||||||||||||||||||||||||||||||||||| n1b\nb\n================================================\ny\nz\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> n1i\nc";
        let segs = parse_markers(text, "n1", MARKER);
        assert_eq!(
            segs,
            vec![
                Segment::Common { text: "a\n".into() },
                Segment::Conflict { id: 0, base: vec!["b\n".into()], current: vec!["x\n".into()], incoming: vec!["y\n".into(), "z\n".into()] },
                Segment::Common { text: "c".into() },
            ]
        );
    }

    /// The T7 review's convention: CRLF and a missing final newline survive in the region data,
    /// and the pane regions still map (the lines are verbatim in the side's text).
    #[tokio::test]
    async fn crlf_and_a_missing_final_newline_stay_in_the_region_lines() {
        let r = TestRepo::new();
        r.write_bytes("w.txt", b"top\r\nmid\r\nend\r\nlast base");
        r.git(&["add", "w.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("other");
        r.write_bytes("w.txt", b"top\r\nTHEIRS\r\nend\r\nlast theirs");
        r.git(&["commit", "-q", "-am", "Other"]);
        r.switch("main");
        r.write_bytes("w.txt", b"top\r\nOURS\r\nend\r\nlast ours");
        r.git(&["commit", "-q", "-am", "Main"]);
        let data = tempfile::tempdir().unwrap();
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
        let id = api.dispatch(Request::OpenRepo { path: r.path().display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32;
        assert!(r.try_git(&["merge", "other"]).is_err());
        let f = file(&api, id, &r, "w.txt").await;
        let conflicts: Vec<&serde_json::Value> = f["segments"].as_array().unwrap().iter().filter(|s| s["kind"] == "conflict").collect();
        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0]["current"], serde_json::json!(["OURS\r\n"]));
        assert_eq!(conflicts[0]["incoming"], serde_json::json!(["THEIRS\r\n"]));
        assert_eq!(conflicts[1]["current"], serde_json::json!(["last ours"]), "no newline at EOF");
        assert_eq!(conflicts[1]["incoming"], serde_json::json!(["last theirs"]));
        assert_eq!(f["current"]["regions"], serde_json::json!([{"id": 0, "start": 2, "lines": 1}, {"id": 1, "start": 4, "lines": 1}]));
        assert_eq!(f["eol"], "crlf");
    }

    /// A plain `git merge other` that stops on `w.txt` (base, main's and other's bytes).
    async fn merged(base: &[u8], ours: &[u8], theirs: &[u8], config: &[(&str, &str)]) -> (TestRepo, Api, u32, tempfile::TempDir) {
        let r = TestRepo::new();
        for (k, v) in config {
            r.git(&["config", k, v]);
        }
        r.write_bytes("w.txt", base);
        r.git(&["add", "w.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("other");
        r.write_bytes("w.txt", theirs);
        r.git(&["commit", "-q", "-am", "Other"]);
        r.switch("main");
        r.write_bytes("w.txt", ours);
        r.git(&["commit", "-q", "-am", "Main"]);
        let (api, id, data) = open(&r).await;
        assert!(r.try_git(&["merge", "other"]).is_err());
        (r, api, id, data)
    }

    async fn open(r: &TestRepo) -> (Api, u32, tempfile::TempDir) {
        let data = tempfile::tempdir().unwrap();
        let api = Api::new(GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf());
        let id = api.dispatch(Request::OpenRepo { path: r.path().display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32;
        (api, id, data)
    }

    fn regions(f: &serde_json::Value, side: &str) -> Vec<(u64, u64, u64)> {
        f[side]["regions"].as_array().unwrap().iter().map(|g| (g["id"].as_u64().unwrap(), g["start"].as_u64().unwrap(), g["lines"].as_u64().unwrap())).collect()
    }

    fn conflicts_of(f: &serde_json::Value) -> Vec<serde_json::Value> {
        f["segments"].as_array().unwrap().iter().filter(|s| s["kind"] == "conflict").cloned().collect()
    }

    #[tokio::test]
    async fn a_submodule_conflict_is_non_text_not_an_error() {
        let r = TestRepo::new();
        r.commit("Base");
        let (a, b, c) = ("1".repeat(40), "2".repeat(40), "3".repeat(40));
        let info = format!("160000 {a} 1\tsub\n160000 {b} 2\tsub\n160000 {c} 3\tsub\n");
        let mut child = std::process::Command::new("git").current_dir(r.path()).args(["update-index", "--index-info"]).envs(isolated_git_env()).stdin(std::process::Stdio::piped()).spawn().unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), info.as_bytes()).unwrap();
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        let (api, id, _d) = open(&r).await;
        let f = file(&api, id, &r, "sub").await;
        assert_eq!((f["kind"].as_str(), f["text"].as_bool()), (Some("bothModified"), Some(false)));
    }

    #[tokio::test]
    async fn a_content_line_of_equals_cannot_end_a_side_early() {
        let eq = "=".repeat(MARKER);
        let ours = format!("a\nours 1\n{eq}\nours 2\nz\n");
        let (r, api, id, _d) = merged(b"a\nmid\nz\n", ours.as_bytes(), b"a\ntheirs\nz\n", &[]).await;
        let f = file(&api, id, &r, "w.txt").await;
        let c = conflicts_of(&f);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0]["current"], serde_json::json!(["ours 1\n", format!("{eq}\n"), "ours 2\n"]));
        assert_eq!(c[0]["incoming"], serde_json::json!(["theirs\n"]));
    }

    #[tokio::test]
    async fn a_trailing_cr_on_a_last_line_without_newline_is_kept() {
        let (r, api, id, _d) = merged(b"a\nold", b"a\nours\r", b"a\ntheirs", &[]).await;
        let f = file(&api, id, &r, "w.txt").await;
        let c = conflicts_of(&f);
        assert_eq!(c[0]["current"], serde_json::json!(["ours\r"]));
        assert_eq!(c[0]["incoming"], serde_json::json!(["theirs"]));
    }

    #[tokio::test]
    async fn a_binary_base_with_text_sides_is_non_text() {
        let (r, api, id, _d) = merged(b"bin\0ary\n", b"ours\n", b"theirs\n", &[]).await;
        let f = file(&api, id, &r, "w.txt").await;
        assert_eq!(f["text"], false);
    }

    /// Many identical lines around and inside the regions: each pane region must hold exactly the
    /// region's own lines.
    #[tokio::test]
    async fn duplicate_heavy_files_anchor_regions_on_the_right_lines() {
        let rows = |edits: &[(usize, &str)]| -> String { (0..60).map(|i| edits.iter().find(|(j, _)| *j == i).map(|(_, t)| *t).unwrap_or("dup").to_string() + "\n").collect() };
        let base = rows(&[(10, "mid"), (30, "mid"), (50, "mid")]);
        let ours = rows(&[(10, "dup"), (11, "o1b"), (30, "o2"), (50, "o3"), (3, "ours only")]);
        let theirs = rows(&[(10, "t1"), (30, "t2"), (31, "dup"), (50, "t3"), (40, "theirs only")]);
        let (r, api, id, _d) = merged(base.as_bytes(), ours.as_bytes(), theirs.as_bytes(), &[]).await;
        let f = file(&api, id, &r, "w.txt").await;
        let c = conflicts_of(&f);
        assert!(c.len() >= 3);
        for side in ["current", "incoming"] {
            let text = f[side]["text"].as_str().unwrap().to_string();
            let lines: Vec<&str> = text.split_inclusive('\n').collect();
            for (id, start, n) in regions(&f, side) {
                let want: Vec<&str> = c[id as usize][side].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
                assert_eq!(&lines[start as usize - 1..(start + n) as usize - 1], want.as_slice(), "{side} region {id} at {start}");
            }
        }
    }

    #[tokio::test]
    async fn zdiff3_config_does_not_change_the_markers() {
        let (r, api, id, _d) = merged(b"a\nbase\nz\n", b"a\nours\nz\n", b"a\ntheirs\nz\n", &[("merge.conflictStyle", "zdiff3")]).await;
        let f = file(&api, id, &r, "w.txt").await;
        let c = conflicts_of(&f);
        assert_eq!((c[0]["base"].clone(), c[0]["current"].clone()), (serde_json::json!(["base\n"]), serde_json::json!(["ours\n"])));
    }

    #[tokio::test]
    async fn marker_like_content_stays_content() {
        let ours = "a\n<<<<<<< HEAD\nours\n>>>>>>> x\nz\n";
        let theirs = "a\n=======\ntheirs\n|||||||\nz\n";
        let (r, api, id, _d) = merged(b"a\nbase\nz\n", ours.as_bytes(), theirs.as_bytes(), &[]).await;
        let f = file(&api, id, &r, "w.txt").await;
        let c = conflicts_of(&f);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0]["current"], serde_json::json!(["<<<<<<< HEAD\n", "ours\n", ">>>>>>> x\n"]));
        assert_eq!(c[0]["incoming"], serde_json::json!(["=======\n", "theirs\n", "|||||||\n"]));
    }

    #[tokio::test]
    async fn add_add_text_has_an_empty_base_and_no_trailing_common() {
        let r = TestRepo::new();
        r.commit("Base");
        r.switch_new("other");
        r.write("n.txt", "theirs\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Other"]);
        r.switch("main");
        r.write("n.txt", "ours\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Main"]);
        let (api, id, _d) = open(&r).await;
        assert!(r.try_git(&["merge", "other"]).is_err());
        let f = file(&api, id, &r, "n.txt").await;
        assert_eq!((f["kind"].as_str(), f["text"].as_bool()), (Some("bothAdded"), Some(true)));
        let c = conflicts_of(&f);
        assert_eq!((c[0]["base"].clone(), c[0]["current"].clone(), c[0]["incoming"].clone()), (serde_json::json!([]), serde_json::json!(["ours\n"]), serde_json::json!(["theirs\n"])));
        assert_eq!(f["segments"].as_array().unwrap().len(), 1, "a conflict alone");
        assert_eq!(regions(&f, "current"), vec![(0, 1, 1)]);
    }

    #[tokio::test]
    async fn delete_modify_is_one_sided() {
        let r = TestRepo::new();
        r.write("d.txt", "x\n");
        r.git(&["add", "d.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("other");
        r.write("d.txt", "y\n");
        r.git(&["commit", "-q", "-am", "Modify"]);
        r.switch("main");
        r.git(&["rm", "-q", "d.txt"]);
        r.git(&["commit", "-q", "-m", "Delete"]);
        let (api, id, _d) = open(&r).await;
        assert!(r.try_git(&["merge", "other"]).is_err());
        let f = file(&api, id, &r, "d.txt").await;
        assert_eq!((f["kind"].as_str(), f["text"].as_bool()), (Some("deletedByUs"), Some(false)));
        assert!(f["current"].is_null());
    }

    #[tokio::test]
    async fn a_larger_file_keeps_every_region_in_place() {
        let rows = |tag: &str| -> String { (0..3000).map(|i| if i % 100 == 50 { format!("{tag} {i}\n") } else { format!("line {i}\n") }).collect() };
        let (r, api, id, _d) = merged(rows("base").as_bytes(), rows("ours").as_bytes(), rows("theirs").as_bytes(), &[]).await;
        let f = file(&api, id, &r, "w.txt").await;
        let got = regions(&f, "current");
        assert_eq!(got.len(), 30);
        assert_eq!(got[7], (7, 751, 1));
        assert_eq!(regions(&f, "incoming")[29], (29, 2951, 1));
    }

    // --- 2D T15 ---
    async fn resolve_in(api: &Api, id: u32, wt: &std::path::Path, path: &str, resolution: Resolution, confirm_markers: bool, confirm_discard: bool) -> Result<serde_json::Value, GbError> {
        let worktree = wt.canonicalize().unwrap().display().to_string();
        let f = api.dispatch(Request::ConflictFile { repo: id, worktree: worktree.clone(), path: path.into() }).await.unwrap();
        let base = f["base"].as_str().map(str::to_string);
        api.dispatch(Request::ResolveFile { repo: id, worktree, path: path.into(), resolution, base, confirm_markers: Some(confirm_markers), confirm_discard: Some(confirm_discard) }).await
    }

    async fn resolve(api: &Api, id: u32, r: &TestRepo, path: &str, resolution: Resolution, confirm_markers: bool) -> Result<serde_json::Value, GbError> {
        resolve_in(api, id, r.path(), path, resolution, confirm_markers, false).await
    }

    fn unmerged(r: &TestRepo) -> Vec<String> {
        r.git(&["diff", "--name-only", "--diff-filter=U"]).lines().map(str::to_string).collect()
    }

    /// §13.3: each resolution leaves Conflicted; then the merge's Commit makes one Undo step.
    #[tokio::test]
    async fn every_resolution_then_commit_completes_the_merge() {
        let (r, api, id, _data) = setup(false).await;
        resolve(&api, id, &r, "a.txt", Resolution::Text { text: "resolved\n".into() }, false).await.unwrap();
        resolve(&api, id, &r, "logo.bin", Resolution::Incoming, false).await.unwrap();
        resolve(&api, id, &r, "gone.txt", Resolution::Delete, false).await.unwrap();
        assert!(unmerged(&r).is_empty());
        assert_eq!(std::fs::read(r.path().join("a.txt")).unwrap(), b"resolved\n");
        assert_eq!(std::fs::read(r.path().join("logo.bin")).unwrap(), vec![0, 7, 7, 7, 0, 9]);
        assert!(!r.path().join("gone.txt").exists());
        let res = api.dispatch(Request::Commit { repo: id, worktree: r.path().canonicalize().unwrap().display().to_string(), summary: "Merge feature/x".into(), description: String::new(), amend: false, stage_all: false, expect: Default::default() }).await.unwrap();
        assert_eq!(res["journal"]["undo"]["label"], "merge feature/x into main", "the commit is absorbed into the merge");
        assert_eq!(r.git(&["rev-list", "--count", "--merges", "-1", "HEAD"]), "1");
    }

    /// Review Focus 5: taking the side that deleted the file deletes it.
    #[tokio::test]
    async fn taking_the_deleted_side_removes_the_file() {
        let (r, api, id, _data) = setup(false).await;
        resolve(&api, id, &r, "gone.txt", Resolution::Current, false).await.unwrap();
        assert!(!r.path().join("gone.txt").exists());
        assert!(!unmerged(&r).contains(&"gone.txt".to_string()));
    }

    #[tokio::test]
    async fn taking_the_side_that_kept_the_file_restores_and_stages_it() {
        let (r, api, id, _data) = setup(false).await;
        resolve(&api, id, &r, "gone.txt", Resolution::Incoming, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("gone.txt")).unwrap(), "modified on feature/x\n");
        assert!(!unmerged(&r).contains(&"gone.txt".to_string()));
        assert_eq!(r.git(&["diff", "--cached", "--name-only", "--", "gone.txt"]), "gone.txt");
    }

    /// Review I1: a second Take (a double send, a stale row) is Stale; it never removes the file.
    #[tokio::test]
    async fn a_resolved_path_is_not_resolved_again() {
        let (r, api, id, _data) = setup(false).await;
        resolve(&api, id, &r, "a.txt", Resolution::Current, false).await.unwrap();
        for resolution in [Resolution::Current, Resolution::Incoming, Resolution::Delete, Resolution::AsIs] {
            let err = resolve(&api, id, &r, "a.txt", resolution.clone(), false).await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::Stale, "{resolution:?}");
        }
        assert!(r.path().join("a.txt").exists());
        assert_eq!(r.git(&["status", "--porcelain", "--", "a.txt"]), "");
    }

    #[tokio::test]
    async fn mark_resolved_asks_while_markers_remain() {
        let (r, api, id, _data) = setup(false).await;
        let err = resolve(&api, id, &r, "a.txt", Resolution::AsIs, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Conflict);
        assert!(matches!(err.detail, Some(crate::error::ErrorDetail::MarkersRemain { .. })));
        assert!(unmerged(&r).contains(&"a.txt".to_string()));
        resolve(&api, id, &r, "a.txt", Resolution::AsIs, true).await.unwrap();
        assert!(!unmerged(&r).contains(&"a.txt".to_string()));
    }

    /// Review M3: the path's `conflict-marker-size` is the one checked.
    #[tokio::test]
    async fn mark_resolved_knows_a_configured_marker_size() {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        std::fs::write(r.path().join(".git/info/attributes"), "a.txt conflict-marker-size=5\n").unwrap();
        let (api, id, _data) = open(&r).await;
        assert!(r.try_git(&["merge", "--no-edit", "feature/x"]).is_err());
        assert!(std::fs::read_to_string(r.path().join("a.txt")).unwrap().lines().any(|l| l.starts_with("<<<<< ")));
        let err = resolve(&api, id, &r, "a.txt", Resolution::AsIs, false).await.unwrap_err();
        assert!(matches!(err.detail, Some(crate::error::ErrorDetail::MarkersRemain { .. })), "{err:?}");
    }

    /// Review Focus 4: a CRLF worktree file (`core.autocrlf=true`) is written back with CRLF.
    #[tokio::test]
    async fn a_text_resolution_keeps_the_files_crlf() {
        let r = TestRepo::new();
        r.git(&["config", "core.autocrlf", "true"]);
        fixtures::conflicts(&r);
        let (api, id, _data) = open(&r).await;
        let _ = r.try_git(&["merge", "--no-edit", "feature/x"]);
        assert_eq!(file(&api, id, &r, "a.txt").await["eol"], "crlf");
        resolve(&api, id, &r, "a.txt", Resolution::Text { text: "one\ntwo\n".into() }, false).await.unwrap();
        assert_eq!(std::fs::read(r.path().join("a.txt")).unwrap(), b"one\r\ntwo\r\n");
    }

    /// The EOL ruling: outside a CRLF file the lines go out as sent, each with its own
    /// terminator, a last line without a newline included.
    #[tokio::test]
    async fn a_text_resolution_writes_the_lines_as_sent() {
        let (r, api, id, _data) = setup(false).await;
        resolve(&api, id, &r, "a.txt", Resolution::Text { text: "one\r\ntwo\nend".into() }, false).await.unwrap();
        assert_eq!(std::fs::read(r.path().join("a.txt")).unwrap(), b"one\r\ntwo\nend");
    }

    #[tokio::test]
    async fn a_stale_base_is_refused() {
        let (r, api, id, _data) = setup(false).await;
        let req = Request::ResolveFile { repo: id, worktree: r.path().canonicalize().unwrap().display().to_string(), path: "a.txt".into(), resolution: Resolution::Text { text: "x\n".into() }, base: Some("0".repeat(40)), confirm_markers: None, confirm_discard: None };
        assert_eq!(api.dispatch(req).await.unwrap_err().kind, GbErrorKind::Stale);
        assert!(unmerged(&r).contains(&"a.txt".to_string()), "nothing written");
    }

    /// Review M1, M2: a binary or read-only file on disk isn't written as text.
    #[tokio::test]
    async fn a_text_resolution_refuses_a_binary_or_read_only_file() {
        let (r, api, id, _data) = setup(false).await;
        r.write_bytes("a.txt", b"bin\0ary\n");
        let err = resolve(&api, id, &r, "a.txt", Resolution::Text { text: "x\n".into() }, false).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, "a.txt is binary: resolve it in your editor"));
        r.write("a.txt", "text\n");
        std::fs::set_permissions(r.path().join("a.txt"), std::os::unix::fs::PermissionsExt::from_mode(0o444)).unwrap();
        let err = resolve(&api, id, &r, "a.txt", Resolution::Text { text: "x\n".into() }, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
        assert_eq!(std::fs::read(r.path().join("a.txt")).unwrap(), b"text\n");
    }

    /// C1: a checkout or a removal never deletes a repository standing at the path.
    #[tokio::test]
    async fn a_repository_in_the_way_is_never_removed() {
        let (r, api, id, _data) = setup(false).await;
        std::fs::remove_file(r.path().join("gone.txt")).unwrap();
        std::fs::create_dir_all(r.path().join("gone.txt/.git")).unwrap();
        std::fs::write(r.path().join("gone.txt/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        for resolution in [Resolution::Current, Resolution::Incoming, Resolution::Delete] {
            let err = resolve(&api, id, &r, "gone.txt", resolution.clone(), false).await.unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{resolution:?}");
            assert!(r.path().join("gone.txt/.git/HEAD").exists(), "{resolution:?}");
        }
    }

    /// Review C1: the path is literal. `[id].tsx` is one file, never the glob matching `i.tsx`
    /// and `d.tsx`.
    #[tokio::test]
    async fn a_glob_like_path_touches_only_itself() {
        let r = TestRepo::new();
        for (p, t) in [("[id].tsx", "base\n"), ("i.tsx", "committed\n"), ("d.tsx", "committed\n")] {
            r.write(p, t);
        }
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("x");
        r.write("[id].tsx", "theirs\n");
        r.git(&["commit", "-q", "-am", "X"]);
        r.switch("main");
        r.write("[id].tsx", "ours\n");
        r.git(&["commit", "-q", "-am", "Ours"]);
        let (api, id, _data) = open(&r).await;
        assert!(r.try_git(&["merge", "x"]).is_err());
        r.write("i.tsx", "my unsaved work\n");
        r.write("d.tsx", "more work\n");
        let clean = |r: &TestRepo| {
            assert_eq!(std::fs::read_to_string(r.path().join("i.tsx")).unwrap(), "my unsaved work\n");
            assert_eq!(std::fs::read_to_string(r.path().join("d.tsx")).unwrap(), "more work\n");
            assert_eq!(r.git(&["diff", "--cached", "--name-only", "--", "i.tsx", "d.tsx"]), "", "nothing else staged");
        };
        resolve(&api, id, &r, "[id].tsx", Resolution::Current, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(r.path().join("[id].tsx")).unwrap(), "ours\n");
        clean(&r);
        // Delete and Mark resolved on a fresh conflict of the same file.
        r.git(&["merge", "--abort"]);
        r.write("i.tsx", "my unsaved work\n");
        r.write("d.tsx", "more work\n");
        assert!(r.try_git(&["merge", "x"]).is_err());
        resolve(&api, id, &r, "[id].tsx", Resolution::Delete, false).await.unwrap();
        assert!(!r.path().join("[id].tsx").exists());
        clean(&r);
        r.git(&["merge", "--abort"]);
        r.write("i.tsx", "my unsaved work\n");
        r.write("d.tsx", "more work\n");
        assert!(r.try_git(&["merge", "x"]).is_err());
        resolve(&api, id, &r, "[id].tsx", Resolution::AsIs, true).await.unwrap();
        clean(&r);
    }

    /// Review M4: taking a side over the user's own edits asks first.
    #[tokio::test]
    async fn taking_a_side_over_hand_edits_asks_first() {
        let (r, api, id, _data) = setup(false).await;
        r.write("a.txt", "resolved by hand\n");
        let err = resolve(&api, id, &r, "a.txt", Resolution::Current, false).await.unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Conflict);
        assert!(matches!(err.detail, Some(crate::error::ErrorDetail::DiscardEdits { .. })), "{err:?}");
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), "resolved by hand\n");
        resolve_in(&api, id, r.path(), "a.txt", Resolution::Current, false, true).await.unwrap();
        assert!(std::fs::read_to_string(r.path().join("a.txt")).unwrap().contains("current three"));
        // A file changed since the caller read it, markers or not.
        let wt = r.path().canonicalize().unwrap().display().to_string();
        let req = Request::ResolveFile { repo: id, worktree: wt, path: "logo.bin".into(), resolution: Resolution::Incoming, base: Some("0".repeat(40)), confirm_markers: None, confirm_discard: None };
        let err = api.dispatch(req).await.unwrap_err();
        assert!(matches!(err.detail, Some(crate::error::ErrorDetail::DiscardEdits { .. })), "{err:?}");
    }

    /// The M4 ruling (re-review I-a): one hunk merged by hand, the other still marked up, is an
    /// edit; Take and Delete ask.
    #[tokio::test]
    async fn a_partly_edited_file_with_markers_left_asks() {
        let (r, api, id, _data) = setup(false).await;
        let text = std::fs::read_to_string(r.path().join("a.txt")).unwrap();
        let (open, close) = (text.find("<<<<<<<").unwrap(), text.find(">>>>>>>").unwrap());
        let end = close + text[close..].find('\n').unwrap() + 1;
        let edited = format!("{}MY CAREFUL MERGE OF A\n{}", &text[..open], &text[end..]);
        assert!(has_markers(&edited, 7), "the second hunk is still marked up");
        r.write("a.txt", &edited);
        for resolution in [Resolution::Current, Resolution::Incoming, Resolution::Delete] {
            let err = resolve(&api, id, &r, "a.txt", resolution.clone(), false).await.unwrap_err();
            assert!(matches!(err.detail, Some(crate::error::ErrorDetail::DiscardEdits { .. })), "{resolution:?}: {err:?}");
        }
        assert_eq!(std::fs::read_to_string(r.path().join("a.txt")).unwrap(), edited);
    }

    /// git's own conflicted file is recognised exactly, so an untouched one never asks: a rebase's
    /// labels, `autocrlf`, the zdiff3 style, add/add, a one-sided conflict.
    #[tokio::test]
    async fn an_untouched_conflicted_file_never_asks() {
        let (r, api, id, _d) = setup(true).await;
        resolve(&api, id, &r, "a.txt", Resolution::Incoming, false).await.unwrap();
        resolve(&api, id, &r, "gone.txt", Resolution::Delete, false).await.unwrap();
        let r = TestRepo::new();
        r.git(&["config", "core.autocrlf", "true"]);
        fixtures::conflicts(&r);
        let (api, id, _d) = open(&r).await;
        assert!(r.try_git(&["merge", "--no-edit", "feature/x"]).is_err());
        resolve(&api, id, &r, "a.txt", Resolution::Current, false).await.unwrap();
        let (r, api, id, _d) = merged(b"a\nbase\nz\n", b"a\nours\nz\n", b"a\ntheirs\nz\n", &[("merge.conflictStyle", "zdiff3")]).await;
        assert!(std::fs::read_to_string(r.path().join("w.txt")).unwrap().contains("|||||||"));
        resolve(&api, id, &r, "w.txt", Resolution::Incoming, false).await.unwrap();
        let (r, api, id, _d) = merged(b"a\nbase\nz\n", b"a\nours\nz\n", b"a\ntheirs\nz\n", &[("merge.conflictStyle", "diff3")]).await;
        resolve(&api, id, &r, "w.txt", Resolution::Delete, false).await.unwrap();
        let r = TestRepo::new();
        r.commit("Base");
        r.switch_new("other");
        r.write("n.txt", "theirs\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Other"]);
        r.switch("main");
        r.write("n.txt", "ours\n");
        r.git(&["add", "n.txt"]);
        r.git(&["commit", "-q", "-m", "Main"]);
        let (api, id, _d) = open(&r).await;
        assert!(r.try_git(&["merge", "other"]).is_err());
        resolve(&api, id, &r, "n.txt", Resolution::Incoming, false).await.unwrap();
    }

    /// The index-only conflict of a submodule: stages 1-3 of `sub` (commits that needn't exist).
    fn gitlink_conflict(r: &TestRepo) -> [String; 3] {
        r.commit("Base");
        let (a, b, c) = ("1".repeat(40), "2".repeat(40), "3".repeat(40));
        let info = format!("160000 {a} 1\tsub\n160000 {b} 2\tsub\n160000 {c} 3\tsub\n");
        let mut child = std::process::Command::new("git").current_dir(r.path()).args(["update-index", "--index-info"]).envs(isolated_git_env()).stdin(std::process::Stdio::piped()).spawn().unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), info.as_bytes()).unwrap();
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        [a, b, c]
    }

    /// Review I2: a submodule conflict stages the chosen side's commit, initialized or not, and
    /// its checked-out folder is the thing resolved, not a repository in the way.
    #[tokio::test]
    async fn taking_a_side_of_a_submodule_conflict_stages_its_commit() {
        let r = TestRepo::new();
        let [_, ours, theirs] = gitlink_conflict(&r);
        let (api, id, _d) = open(&r).await;
        // Uninitialized: no folder at all.
        resolve(&api, id, &r, "sub", Resolution::Incoming, false).await.unwrap();
        assert_eq!(r.git(&["ls-files", "-s", "--", "sub"]), format!("160000 {theirs} 0\tsub"));
        // Checked out: a `.git` inside, left as it is.
        let r = TestRepo::new();
        let [_, ours2, _] = gitlink_conflict(&r);
        assert_eq!(ours, ours2);
        std::fs::create_dir_all(r.path().join("sub/.git")).unwrap();
        std::fs::write(r.path().join("sub/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let (api, id, _d) = open(&r).await;
        resolve(&api, id, &r, "sub", Resolution::Current, false).await.unwrap();
        assert_eq!(r.git(&["ls-files", "-s", "--", "sub"]), format!("160000 {ours} 0\tsub"));
        assert!(r.path().join("sub/.git/HEAD").exists());
    }

    /// Review M-b: a checked-out submodule at another commit is reported, and left where it is.
    #[tokio::test]
    async fn taking_a_submodule_side_reports_a_checkout_elsewhere() {
        let r = TestRepo::new();
        let [_, _, theirs] = gitlink_conflict(&r);
        let sub = TestRepo::new();
        let head = sub.commit("Sub");
        std::fs::rename(sub.path(), r.path().join("sub")).unwrap();
        let (api, id, _d) = open(&r).await;
        let res = resolve(&api, id, &r, "sub", Resolution::Incoming, false).await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"path": "sub", "head": head, "taken": theirs}));
        assert_eq!(r.try_git_in(&r.path().join("sub"), &["rev-parse", "HEAD"]).unwrap(), head, "never moved");
        // Not checked out: nothing to report.
        let r = TestRepo::new();
        gitlink_conflict(&r);
        let (api, id, _d) = open(&r).await;
        assert!(resolve(&api, id, &r, "sub", Resolution::Current, false).await.unwrap()["outcome"].is_null());
    }

    #[tokio::test]
    async fn deleting_a_submodule_conflict_leaves_its_files() {
        let r = TestRepo::new();
        gitlink_conflict(&r);
        std::fs::create_dir_all(r.path().join("sub/.git")).unwrap();
        std::fs::write(r.path().join("sub/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let (api, id, _d) = open(&r).await;
        resolve(&api, id, &r, "sub", Resolution::Delete, false).await.unwrap();
        assert_eq!(r.git(&["ls-files", "-s", "--", "sub"]), "");
        assert!(r.path().join("sub/.git/HEAD").exists());
    }

    /// Review M5: a linked worktree's conflict is resolved in its own index and files.
    #[tokio::test]
    async fn a_linked_worktrees_conflict_is_resolved_there() {
        let r = TestRepo::new();
        fixtures::conflicts(&r);
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("linked");
        r.git(&["worktree", "add", "-q", "-b", "linked", wt.to_str().unwrap(), "main"]);
        let (api, id, _data) = open(&r).await;
        assert!(r.try_git_in(&wt, &["merge", "feature/x"]).is_err());
        resolve_in(&api, id, &wt, "a.txt", Resolution::Incoming, false, false).await.unwrap();
        assert!(std::fs::read_to_string(wt.join("a.txt")).unwrap().contains("incoming three"));
        let left = r.try_git_in(&wt, &["diff", "--name-only", "--diff-filter=U"]).unwrap();
        assert!(!left.lines().any(|l| l == "a.txt"), "{left}");
        assert!(unmerged(&r).is_empty(), "the main worktree isn't merging");
        assert!(!std::fs::read_to_string(r.path().join("a.txt")).unwrap().contains("incoming"));
    }

    /// Review M5: rename/rename (1 to 2) leaves three paths; taking current keeps its name.
    #[tokio::test]
    async fn rename_rename_resolves_path_by_path() {
        let r = TestRepo::new();
        r.write("r.txt", "shared content\nline two\nline three\n");
        r.git(&["add", "r.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("x");
        r.git(&["mv", "r.txt", "b1.txt"]);
        r.git(&["commit", "-q", "-m", "Rename to b1"]);
        r.switch("main");
        r.git(&["mv", "r.txt", "a1.txt"]);
        r.git(&["commit", "-q", "-m", "Rename to a1"]);
        let (api, id, _data) = open(&r).await;
        assert!(r.try_git(&["merge", "x"]).is_err());
        let mut paths = unmerged(&r);
        paths.sort();
        assert_eq!(paths, ["a1.txt", "b1.txt", "r.txt"]);
        for p in ["a1.txt", "b1.txt", "r.txt"] {
            resolve(&api, id, &r, p, Resolution::Current, false).await.unwrap();
        }
        assert!(unmerged(&r).is_empty());
        assert!(r.path().join("a1.txt").exists());
        assert!(!r.path().join("b1.txt").exists());
        assert!(!r.path().join("r.txt").exists());
    }

    #[test]
    fn markers_need_all_three_kinds_at_the_size() {
        assert!(has_markers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n", 7));
        assert!(has_markers("<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n", 7));
        assert!(!has_markers("a\n=======\nb\n", 7));
        assert!(!has_markers("<<<<<<< x\n== not a marker\n>>>>>>> y\n", 7));
        assert!(has_markers("<<<<< x\n=====\n>>>>> y\n", 5));
        assert!(!has_markers("<<<<< x\n=====\n>>>>> y\n", 7));
        assert!(!has_markers("<<<<<<<< x\n========\n>>>>>>>> y\n", 7), "longer runs aren't size-7 markers");
    }

    #[test]
    fn resolutions_serialize_tagged_and_camel_case() {
        assert_eq!(serde_json::to_value(Resolution::AsIs).unwrap(), serde_json::json!({"kind": "asIs"}));
        assert_eq!(serde_json::from_value::<Resolution>(serde_json::json!({"kind": "text", "text": "x"})).unwrap(), Resolution::Text { text: "x".into() });
    }
    // --- end 2D T15 ---
}
