//! The patch builder (spec #2 §7.3): from git's diff of one file and the user's selection, the
//! patch `git apply` takes. Pure: no git, no I/O. The UI sends line numbers, never patch text.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the user picked: whole hunks (their indexes in `HunksPayload.hunks`), or lines by number:
/// `old` for `-` lines (old side), `new` for `+` lines (new side). Only changed lines count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum StageSelection {
    Hunks { hunks: Vec<u32> },
    Lines { old: Vec<LineRange>, new: Vec<LineRange> },
}

/// 1-based, inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// Forward: staging (the patch applies as is). Reverse: unstaging and discarding (applied `-R`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dir {
    Forward,
    Reverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Context,
    Del,
    Add,
}

#[derive(Debug, Clone)]
struct Line {
    kind: Kind,
    /// The line's bytes after its marker, with its `\n`.
    text: Vec<u8>,
    /// Followed by `\ No newline at end of file`.
    no_eol: bool,
    /// Its number on the side it's on (both for context).
    old: u32,
    new: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    lines: Vec<Line>,
}

impl ParsedHunk {
    pub(crate) fn summary(&self) -> crate::hunks::Hunk {
        let pick = |k: Kind, f: fn(&Line) -> u32| self.lines.iter().filter(|l| l.kind == k).map(f).collect();
        crate::hunks::Hunk { old_start: self.old_start, old_lines: self.old_lines, new_start: self.new_start, new_lines: self.new_lines, del: pick(Kind::Del, |l| l.old), add: pick(Kind::Add, |l| l.new) }
    }
}

/// The refusal for a binary diff.
pub(crate) const BINARY: &str = "Binary file: stage the whole file";

pub(crate) struct Parsed {
    /// Every line before the first `@@`, with its `\n`.
    header: Vec<Vec<u8>>,
    pub hunks: Vec<ParsedHunk>,
    pub binary: bool,
    /// `diff --git` (or `--cc`) sections: one for a patchable file. A typechange (file ↔
    /// symlink) gives two, a folder one per file in it.
    sections: u32,
    /// A conflicted path: a combined diff (`diff --cc`) or `* Unmerged path`.
    unmerged: bool,
    /// Every mode the header names (`index …` suffix, `old`/`new`/`new file`/`deleted file mode`).
    modes: Vec<Vec<u8>>,
}

impl Parsed {
    /// Why this diff can't be staged by hunk or line (the whole file still can).
    pub(crate) fn refusal(&self) -> Option<&'static str> {
        let mode = |m: &[u8]| self.modes.iter().any(|x| x == m);
        if self.unmerged {
            Some("Resolve the conflict first")
        } else if self.sections > 1 {
            Some("The file's type changed: stage the whole file")
        } else if mode(b"160000") {
            Some("Submodule: stage the whole file")
        } else if mode(b"120000") {
            Some("Symlink: stage the whole file")
        } else if self.binary {
            Some(BINARY)
        } else {
            None
        }
    }

    /// No hunks, only a mode change (`chmod +x`).
    pub(crate) fn mode_only(&self) -> bool {
        self.hunks.is_empty() && self.header.iter().any(|l| l.starts_with(b"old mode "))
    }
}

/// The mode a header line names, if any.
fn header_mode(line: &[u8]) -> Option<Vec<u8>> {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    for prefix in [&b"old mode "[..], b"new mode ", b"new file mode ", b"deleted file mode "] {
        if let Some(m) = line.strip_prefix(prefix) {
            return Some(m.to_vec());
        }
    }
    // `index a..b 100644`: the mode both sides share.
    let rest = line.strip_prefix(b"index ")?;
    rest.iter().position(|b| *b == b' ').map(|i| rest[i + 1..].to_vec())
}

/// A line that starts a file section.
fn section_start(raw: &[u8]) -> bool {
    [&b"diff --git "[..], b"diff --cc ", b"diff --combined "].iter().any(|p| raw.starts_with(p))
}

/// `@@ -a[,b] +c[,d] @@…`: a missing count is 1.
fn parse_header(line: &[u8]) -> Option<(u32, u32, u32, u32)> {
    let text = std::str::from_utf8(line).ok()?;
    let mut parts = text.strip_prefix("@@ ")?.split(' ');
    let side = |s: &str, sign: char| -> Option<(u32, u32)> {
        let s = s.strip_prefix(sign)?;
        Some(match s.split_once(',') {
            Some((a, b)) => (a.parse().ok()?, b.parse().ok()?),
            None => (s.parse().ok()?, 1),
        })
    };
    let (os, ol) = side(parts.next()?, '-')?;
    let (ns, nl) = side(parts.next()?, '+')?;
    Some((os, ol, ns, nl))
}

/// One or more file sections. A hunk ends by its header's counts; what follows it is header
/// text (a later section's), never content.
pub(crate) fn parse(diff: &[u8]) -> Parsed {
    let mut p = Parsed { header: Vec::new(), hunks: Vec::new(), binary: false, sections: 0, unmerged: false, modes: Vec::new() };
    let (mut old, mut new) = (0, 0);
    // Lines left in the current hunk, by its header counts: (old side, new side).
    let (mut left_old, mut left_new) = (0u32, 0u32);
    for raw in diff.split_inclusive(|b| *b == b'\n') {
        if raw.starts_with(b"@@ ") {
            if let Some((os, ol, ns, nl)) = parse_header(raw) {
                p.hunks.push(ParsedHunk { old_start: os, old_lines: ol, new_start: ns, new_lines: nl, lines: Vec::new() });
                (old, new) = (os.max(1), ns.max(1));
                (left_old, left_new) = (ol, nl);
            }
            continue;
        }
        // `\ No newline at end of file` belongs to the line before it, a hunk's last one too.
        if raw.first() == Some(&b'\\') {
            if let Some(l) = p.hunks.last_mut().and_then(|h| h.lines.last_mut()) {
                l.no_eol = true;
            }
            continue;
        }
        let h = match p.hunks.last_mut() {
            Some(h) if left_old > 0 || left_new > 0 => h,
            _ => {
                p.sections += u32::from(section_start(raw));
                p.unmerged |= raw.starts_with(b"diff --cc ") || raw.starts_with(b"diff --combined ") || raw.starts_with(b"* Unmerged path ");
                p.binary |= raw.starts_with(b"Binary files ") || raw.starts_with(b"GIT binary patch");
                p.modes.extend(header_mode(raw));
                if p.hunks.is_empty() {
                    p.header.push(raw.to_vec());
                }
                continue;
            }
        };
        let line = |kind, old, new| Line { kind, text: raw[1..].to_vec(), no_eol: false, old, new };
        match raw.first() {
            // A blank one is `diff.suppressBlankEmpty`'s empty context line, without its space.
            Some(b' ') | Some(b'\n') => {
                let text = if raw[0] == b'\n' { b"\n".to_vec() } else { raw[1..].to_vec() };
                h.lines.push(Line { kind: Kind::Context, text, no_eol: false, old, new });
                (old, new) = (old + 1, new + 1);
                (left_old, left_new) = (left_old.saturating_sub(1), left_new.saturating_sub(1));
            }
            Some(b'-') => {
                h.lines.push(line(Kind::Del, old, 0));
                old += 1;
                left_old = left_old.saturating_sub(1);
            }
            Some(b'+') => {
                h.lines.push(line(Kind::Add, 0, new));
                new += 1;
                left_new = left_new.saturating_sub(1);
            }
            _ => {}
        }
    }
    p
}

fn in_ranges(ranges: &[LineRange], n: u32) -> bool {
    ranges.iter().any(|r| (r.start..=r.end).contains(&n))
}

fn picked(sel: &StageSelection, hunk: usize, l: &Line) -> bool {
    match sel {
        StageSelection::Hunks { hunks } => l.kind != Kind::Context && hunks.contains(&(hunk as u32)),
        StageSelection::Lines { old, new } => match l.kind {
            Kind::Del => in_ranges(old, l.old),
            Kind::Add => in_ranges(new, l.new),
            Kind::Context => false,
        },
    }
}

/// An unpicked changed line that this direction keeps, as context.
fn becomes_context(l: &Line, pick: bool, dir: Dir) -> bool {
    !pick && matches!((l.kind, dir), (Kind::Del, Dir::Forward) | (Kind::Add, Dir::Reverse))
}

/// The sides (old, new) a line is on in the patch: none when it's dropped.
fn sides(l: &Line, pick: bool, dir: Dir) -> (bool, bool) {
    match (l.kind, pick) {
        (Kind::Context, _) => (true, true),
        (Kind::Del, true) => (true, false),
        (Kind::Add, true) => (false, true),
        _ if becomes_context(l, pick, dir) => (true, true),
        _ => (false, false),
    }
}

/// The text without its line ending, to match a line against its re-added copy.
fn bare(text: &[u8]) -> &[u8] {
    let t = text.strip_suffix(b"\n").unwrap_or(text);
    t.strip_suffix(b"\r").unwrap_or(t)
}

/// Deviation 13: a line without a newline must be the last line of its side, or the patch is
/// invalid. When a picked line or one turned into context breaks that, the selection grows
/// until it holds (picks only grow, so this ends):
/// - an unpicked no-newline line that would become context with a line after it on its side is
///   picked. Forward, that `-b` (no newline) also takes the `+b` re-adding it with a newline, so
///   staging a line appended after it keeps `b` (`-b⏎̸ +b +c`, staging `+c`);
/// - a picked no-newline `-` line with unpicked `+` lines after it that would become context
///   (Reverse) takes them too.
fn tie_no_eol(lines: &[Line], picks: &mut [bool], dir: Dir) {
    loop {
        let mut changed = false;
        for i in 0..lines.len() {
            if !lines[i].no_eol {
                continue;
            }
            let (old_i, new_i) = sides(&lines[i], picks[i], dir);
            let later_on_side = |picks: &[bool], j: usize| {
                let (o, n) = sides(&lines[j], picks[j], dir);
                (old_i && o) || (new_i && n)
            };
            if !(i + 1..lines.len()).any(|j| later_on_side(picks, j)) {
                continue;
            }
            if becomes_context(&lines[i], picks[i], dir) {
                picks[i] = true;
                changed = true;
                if dir == Dir::Forward && lines[i].kind == Kind::Del {
                    let text = bare(&lines[i].text);
                    if let Some(k) = (i + 1..lines.len()).find(|&k| lines[k].kind == Kind::Add && !lines[k].no_eol && bare(&lines[k].text) == text) {
                        picks[k] = true;
                    }
                }
            } else {
                for j in i + 1..lines.len() {
                    if later_on_side(picks, j) && becomes_context(&lines[j], picks[j], dir) {
                        picks[j] = true;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            return;
        }
    }
}

/// A mode change (`old mode`/`new mode`) is the whole file's: a hunk or line never carries it,
/// so staging a hunk doesn't stage a pending `chmod +x`, and unstaging one doesn't revert it.
fn without_mode_change(header: &[Vec<u8>]) -> Vec<Vec<u8>> {
    header.iter().filter(|l| !l.starts_with(b"old mode ") && !l.starts_with(b"new mode ")).cloned().collect()
}

/// `--- /dev/null` / `+++ /dev/null` and the new/deleted-file mode lines no longer hold once a
/// changed line became context: both sides then have content (Deviation 13's sibling). Any other
/// header (a modification, a rename) is kept as is.
fn modification_header(header: &[Vec<u8>]) -> Vec<u8> {
    if !header.iter().any(|l| l.as_slice() == b"--- /dev/null\n" || l.as_slice() == b"+++ /dev/null\n") {
        return header.concat();
    }
    let named = |prefix: &[u8]| header.iter().find(|l| l.starts_with(prefix) && !l.ends_with(b"/dev/null\n")).map(|l| l[prefix.len()..].to_vec());
    let swap = |name: Option<Vec<u8>>, from: &[u8], to: &[u8]| -> Vec<u8> {
        let name = name.unwrap_or_default();
        let (quote, rest) = if name.first() == Some(&b'"') { (&b"\""[..], &name[1..]) } else { (&b""[..], &name[..]) };
        let rest = rest.strip_prefix(from).unwrap_or(rest);
        [quote, to, rest].concat()
    };
    let mut out = Vec::new();
    for l in header {
        if l.starts_with(b"new file mode ") || l.starts_with(b"deleted file mode ") || l.starts_with(b"index ") {
            continue;
        }
        if l.as_slice() == b"--- /dev/null\n" {
            out.extend_from_slice(b"--- ");
            out.extend(swap(named(b"+++ "), b"b/", b"a/"));
        } else if l.as_slice() == b"+++ /dev/null\n" {
            out.extend_from_slice(b"+++ ");
            out.extend(swap(named(b"--- "), b"a/", b"b/"));
        } else {
            out.extend_from_slice(l);
        }
    }
    out
}

/// A range's first line: an empty range's start is the line before it.
fn first_line(start: u32, count: usize) -> i64 {
    i64::from(start) + i64::from(count == 0)
}

fn start_of(first: i64, count: usize) -> i64 {
    (first - i64::from(count == 0)).max(0)
}

/// The patch for `sel` in `dir`, or `None` when nothing changed is selected. The side the patch
/// applies to (old forward, new reverse) never changes, so its start is git's; the other side's
/// start follows the hunks kept before it. The counts are written right (`--recount` agrees).
/// A hunk's picks after the no-newline tie; `None` when the user picked nothing in it.
fn hunk_picks(h: &ParsedHunk, i: usize, sel: &StageSelection, dir: Dir) -> Option<Vec<bool>> {
    let mut picks: Vec<bool> = h.lines.iter().map(|l| picked(sel, i, l)).collect();
    if !picks.iter().any(|p| *p) {
        return None;
    }
    tie_no_eol(&h.lines, &mut picks, dir);
    Some(picks)
}

/// `None` too for a diff [`Parsed::refusal`] refuses: the caller names why.
pub(crate) fn partial_patch(diff: &[u8], sel: &StageSelection, dir: Dir) -> Option<Vec<u8>> {
    let parsed = parse(diff);
    if parsed.refusal().is_some() {
        return None;
    }
    let mut body = Vec::new();
    let mut contexted = false;
    // Σ (new count − old count) of the hunks emitted so far.
    let mut delta: i64 = 0;
    for (i, h) in parsed.hunks.iter().enumerate() {
        let Some(picks) = hunk_picks(h, i, sel, dir) else { continue };
        let out: Vec<(u8, &Line)> = h
            .lines
            .iter()
            .zip(&picks)
            .filter_map(|(l, &pick)| match (l.kind, pick) {
                (Kind::Context, _) => Some((b' ', l)),
                (Kind::Del, true) => Some((b'-', l)),
                (Kind::Add, true) => Some((b'+', l)),
                _ if becomes_context(l, pick, dir) => Some((b' ', l)),
                _ => None,
            })
            .collect();
        let old_lines = out.iter().filter(|(m, _)| *m != b'+').count();
        let new_lines = out.iter().filter(|(m, _)| *m != b'-').count();
        let (old_start, new_start) = match dir {
            Dir::Forward => (i64::from(h.old_start), start_of(first_line(h.old_start, old_lines) + delta, new_lines)),
            Dir::Reverse => (start_of(first_line(h.new_start, new_lines) - delta, old_lines), i64::from(h.new_start)),
        };
        delta += new_lines as i64 - old_lines as i64;
        body.extend(format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n").as_bytes());
        for (mark, l) in out {
            contexted |= mark == b' ' && l.kind != Kind::Context;
            body.push(mark);
            body.extend_from_slice(&l.text);
            if l.no_eol {
                body.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }
    if body.is_empty() {
        return None;
    }
    let header = without_mode_change(&parsed.header);
    let header = if contexted { modification_header(&header) } else { header.concat() };
    Some([header, body].concat())
}

/// How many hunks have a picked line, and how many changed lines go into the patch in `dir`
/// (after the no-newline tie, so a label says what's really staged).
pub(crate) fn selected_lines(diff: &[u8], sel: &StageSelection, dir: Dir) -> (u32, u32) {
    let parsed = parse(diff);
    let mut hunks = 0;
    let mut lines = 0;
    for (i, h) in parsed.hunks.iter().enumerate() {
        let Some(picks) = hunk_picks(h, i, sel, dir) else { continue };
        hunks += 1;
        lines += h.lines.iter().zip(&picks).filter(|(l, p)| **p && l.kind != Kind::Context).count() as u32;
    }
    (hunks, lines)
}

/// "a hunk", "2 hunks", "1 line", "3 lines" (§7.6 and §5.5 labels).
pub(crate) fn selection_label(diff: &[u8], sel: &StageSelection, dir: Dir) -> String {
    let (hunks, lines) = selected_lines(diff, sel, dir);
    match sel {
        StageSelection::Hunks { .. } if hunks == 1 => "a hunk".into(),
        StageSelection::Hunks { .. } => format!("{hunks} hunks"),
        StageSelection::Lines { .. } if lines == 1 => "1 line".into(),
        StageSelection::Lines { .. } => format!("{lines} lines"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two hunks of a 30-line file: line 3 `c` → `C` (a -/+ pair), lines 20–21 replaced by one.
    const TWO: &str = "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n\
@@ -1,6 +1,6 @@\n a\n b\n-c\n+C\n d\n e\n f\n\
@@ -17,8 +17,7 @@\n q\n r\n s\n-t\n-u\n+TU\n v\n w\n x\n";

    fn lines(old: &[(u32, u32)], new: &[(u32, u32)]) -> StageSelection {
        let r = |v: &[(u32, u32)]| v.iter().map(|&(start, end)| LineRange { start, end }).collect();
        StageSelection::Lines { old: r(old), new: r(new) }
    }

    fn label(diff: &[u8], sel: &StageSelection) -> String {
        selection_label(diff, sel, Dir::Forward)
    }

    fn text(p: Option<Vec<u8>>) -> String {
        String::from_utf8(p.expect("a patch")).unwrap()
    }

    #[test]
    fn parse_numbers_each_changed_line() {
        let p = parse(TWO.as_bytes());
        assert_eq!(p.hunks.len(), 2);
        let h = p.hunks[1].summary();
        assert_eq!((h.old_start, h.old_lines, h.new_start, h.new_lines), (17, 8, 17, 7));
        assert_eq!(h.del, [20, 21]);
        assert_eq!(h.add, [20]);
        assert!(!p.binary);
    }

    #[test]
    fn a_hunk_selection_keeps_only_that_hunk() {
        let out = text(partial_patch(TWO.as_bytes(), &StageSelection::Hunks { hunks: vec![1] }, Dir::Forward));
        assert!(out.starts_with("diff --git a/f b/f\n"), "{out}");
        assert!(!out.contains("+C"), "{out}");
        assert!(out.contains("@@ -17,8 +17,7 @@\n q\n r\n s\n-t\n-u\n+TU\n v\n w\n x\n"), "{out}");
    }

    /// §7.3 forward (stage): an unselected `-` becomes context, an unselected `+` is dropped.
    #[test]
    fn forward_keeps_unpicked_deletions_as_context_and_drops_unpicked_additions() {
        let out = text(partial_patch(TWO.as_bytes(), &lines(&[(20, 20)], &[]), Dir::Forward));
        assert!(out.contains("@@ -17,8 +17,7 @@\n q\n r\n s\n-t\n u\n v\n w\n x\n"), "{out}");
        assert!(!out.contains("@@ -1,"), "a hunk with nothing picked is dropped: {out}");
    }

    /// §7.3 reverse (unstage, discard; applied with -R): an unselected `+` becomes context, an
    /// unselected `-` is dropped.
    #[test]
    fn reverse_keeps_unpicked_additions_as_context_and_drops_unpicked_deletions() {
        let out = text(partial_patch(TWO.as_bytes(), &lines(&[], &[(3, 3)]), Dir::Reverse));
        assert!(out.contains("@@ -1,5 +1,6 @@\n a\n b\n+C\n d\n e\n f\n"), "{out}");
    }

    #[test]
    fn nothing_selected_is_none() {
        assert!(partial_patch(TWO.as_bytes(), &lines(&[(9, 12)], &[(9, 12)]), Dir::Forward).is_none());
        assert!(partial_patch(TWO.as_bytes(), &StageSelection::Hunks { hunks: vec![] }, Dir::Forward).is_none());
    }

    #[test]
    fn the_no_newline_marker_stays_with_its_line() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n";
        // Stage only "+b": "-b" (no newline) is then picked too (Deviation 13), and "+c" dropped.
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(2, 2)]), Dir::Forward));
        assert_eq!(out, "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
        // Stage both: the markers ride along.
        let out = text(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }, Dir::Forward));
        assert!(out.ends_with("-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n"), "{out}");
    }

    /// Deviation 13's example: `-b⏎̸ +c⏎̸`, staging only `+c`, stages the pair.
    #[test]
    fn the_no_newline_tie_stages_the_pair() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n";
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(2, 2)]), Dir::Forward));
        assert!(out.ends_with("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"), "{out}");
        // Staging only "-b": "+c" is dropped, "b" goes (the new side ends at "a").
        let out = text(partial_patch(diff.as_bytes(), &lines(&[(2, 2)], &[]), Dir::Forward));
        assert!(out.ends_with("@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n"), "{out}");
    }

    /// Appending to a file without a final newline: git shows `-b⏎̸ +b +c`. Staging only `+c`
    /// must keep `b`: the tie takes `-b`, and with it the `+b` that re-adds it.
    #[test]
    fn staging_a_line_appended_after_a_no_newline_end_keeps_that_line() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n";
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(3, 3)]), Dir::Forward));
        assert!(out.ends_with("@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n"), "{out}");
        // Unstaging only the "-b" side (Reverse): the "+" lines after it can't stay context
        // below a line without a newline, so they're unstaged with it.
        let out = text(partial_patch(diff.as_bytes(), &lines(&[(2, 2)], &[]), Dir::Reverse));
        assert!(out.ends_with("@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n"), "{out}");
        // Unstaging only "+c" needs no tie: "+b" stays as context, "-b" is dropped.
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(3, 3)]), Dir::Reverse));
        assert!(out.ends_with("@@ -1,2 +1,3 @@\n a\n b\n+c\n"), "{out}");
    }

    /// Unstaging part of a newly added file: the patch can't stay a "new file" (Deviation 13's
    /// sibling): its header becomes a modification of the remaining lines.
    #[test]
    fn a_partial_reverse_of_a_new_file_becomes_a_modification() {
        let diff = "diff --git a/n b/n\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n";
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(2, 2)]), Dir::Reverse));
        assert_eq!(out, "diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -1,2 +1,3 @@\n one\n+two\n three\n");
        // Staging part of an untracked file keeps the new-file header: it's still a new file.
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(1, 2)]), Dir::Forward));
        assert!(out.contains("new file mode 100644\n") && out.ends_with("@@ -0,0 +1,2 @@\n+one\n+two\n"), "{out}");
    }

    #[test]
    fn a_partial_forward_of_a_deletion_becomes_a_modification() {
        let diff = "diff --git a/d b/d\ndeleted file mode 100644\nindex 4444444..0000000\n--- a/d\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n";
        let out = text(partial_patch(diff.as_bytes(), &lines(&[(1, 1)], &[]), Dir::Forward));
        assert_eq!(out, "diff --git a/d b/d\n--- a/d\n+++ b/d\n@@ -1,2 +1,1 @@\n-one\n two\n");
        // The whole deletion keeps its header: git apply removes the file.
        let out = text(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }, Dir::Forward));
        assert!(out.contains("deleted file mode 100644\n") && out.contains("+++ /dev/null\n") && out.ends_with("@@ -1,2 +0,0 @@\n-one\n-two\n"), "{out}");
        // Unstaging part of a staged deletion (Reverse): the unpicked "-" is dropped, so the
        // reversed patch re-creates the file with the picked line only.
        let out = text(partial_patch(diff.as_bytes(), &lines(&[(2, 2)], &[]), Dir::Reverse));
        assert!(out.contains("deleted file mode 100644\n") && out.ends_with("@@ -1,1 +0,0 @@\n-two\n"), "{out}");
    }

    /// A whole new file staged as is, header and all.
    #[test]
    fn a_whole_new_file_keeps_its_header() {
        let diff = "diff --git a/n b/n\nnew file mode 100755\nindex 0000000..3333333\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+two\n";
        assert_eq!(text(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }, Dir::Forward)), diff);
        assert_eq!(text(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }, Dir::Reverse)), diff);
    }

    /// A rename's header (similarity, rename from/to) rides along untouched.
    #[test]
    fn a_rename_keeps_its_header() {
        let diff = "diff --git a/old b/new\nsimilarity index 80%\nrename from old\nrename to new\nindex 1111111..2222222 100644\n--- a/old\n+++ b/new\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(2, 2)]), Dir::Forward));
        assert_eq!(out, "diff --git a/old b/new\nsimilarity index 80%\nrename from old\nrename to new\nindex 1111111..2222222 100644\n--- a/old\n+++ b/new\n@@ -1,3 +1,4 @@\n a\n b\n+B\n c\n");
    }

    /// CRLF lines keep their `\r` byte for byte.
    #[test]
    fn crlf_lines_are_kept_byte_for_byte() {
        let diff = "diff --git a/w b/w\n--- a/w\n+++ b/w\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n";
        let out = text(partial_patch(diff.as_bytes(), &lines(&[], &[(2, 2)]), Dir::Forward));
        assert!(out.ends_with("@@ -1,3 +1,4 @@\n a\r\n b\r\n+B\r\n c\r\n"), "{out:?}");
    }

    /// Adjacent hunks: skipping the first moves the second's new-side start back (Forward), or
    /// its old-side start (Reverse); the side the patch applies to keeps git's start.
    #[test]
    fn adjacent_hunks_get_starts_that_follow_the_kept_ones() {
        // Hunk 0 adds two lines after 3; hunk 1 replaces line 11 (new 13).
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,6 +1,8 @@\n 1\n 2\n 3\n+x\n+y\n 4\n 5\n 6\n@@ -8,7 +10,7 @@\n 8\n 9\n 10\n-11\n+ELEVEN\n 12\n 13\n 14\n";
        let out = text(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![1] }, Dir::Forward));
        assert!(out.ends_with("@@ -8,7 +8,7 @@\n 8\n 9\n 10\n-11\n+ELEVEN\n 12\n 13\n 14\n"), "{out}");
        let out = text(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![1] }, Dir::Reverse));
        assert!(out.ends_with("@@ -10,7 +10,7 @@\n 8\n 9\n 10\n-11\n+ELEVEN\n 12\n 13\n 14\n"), "{out}");
        // Only "+y" of hunk 0, then hunk 1 whole: the second's new start counts the one kept line.
        let out = text(partial_patch(diff.as_bytes(), &lines(&[(11, 11)], &[(5, 5), (13, 13)]), Dir::Forward));
        assert!(out.contains("@@ -1,6 +1,7 @@\n 1\n 2\n 3\n+y\n 4\n 5\n 6\n@@ -8,7 +9,7 @@\n"), "{out}");
        // Pure insertion with nothing kept before: an empty old side starts the line before.
        let ins = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,0 +2,2 @@\n+x\n+y\n";
        let out = text(partial_patch(ins.as_bytes(), &lines(&[], &[(3, 3)]), Dir::Reverse));
        assert!(out.ends_with("@@ -2,1 +2,2 @@\n x\n+y\n"), "{out}");
    }

    /// A line selection that spans context lines and both hunks picks only the changed lines in it.
    #[test]
    fn a_selection_spanning_context_picks_only_changed_lines() {
        let out = text(partial_patch(TWO.as_bytes(), &lines(&[], &[(1, 25)]), Dir::Forward));
        assert!(out.contains("@@ -1,6 +1,7 @@\n a\n b\n c\n+C\n d\n e\n f\n"), "{out}");
        assert!(out.contains("@@ -17,8 +18,9 @@\n q\n r\n s\n t\n u\n+TU\n v\n w\n x\n"), "{out}");
        assert_eq!(label(TWO.as_bytes(), &lines(&[], &[(1, 25)])), "2 lines");
    }

    /// `diff.suppressBlankEmpty`: a blank context line comes without its leading space.
    #[test]
    fn a_bare_blank_context_line_counts() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n";
        let p = parse(diff.as_bytes());
        assert_eq!(p.hunks[0].summary().del, [3]);
        let out = text(partial_patch(diff.as_bytes(), &lines(&[(3, 3)], &[(3, 3)]), Dir::Forward));
        assert!(out.ends_with("@@ -1,3 +1,3 @@\n a\n \n-b\n+B\n"), "{out}");
    }

    #[test]
    fn labels_count_hunks_and_changed_lines_only() {
        assert_eq!(label(TWO.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }), "a hunk");
        assert_eq!(label(TWO.as_bytes(), &StageSelection::Hunks { hunks: vec![0, 1] }), "2 hunks");
        assert_eq!(label(TWO.as_bytes(), &lines(&[(1, 30)], &[(1, 30)])), "5 lines", "context lines don't count");
        assert_eq!(label(TWO.as_bytes(), &lines(&[(3, 3)], &[])), "1 line");
    }

    /// Review I1: a hunk or line never carries the file's mode change; a new file keeps its mode.
    #[test]
    fn a_mode_change_never_rides_along() {
        let diff = "diff --git a/m b/m\nold mode 100644\nnew mode 100755\nindex 1111111..2222222\n--- a/m\n+++ b/m\n@@ -1,3 +1,3 @@\n 1\n-2\n+TWO\n 3\n";
        for (sel, dir) in [(StageSelection::Hunks { hunks: vec![0] }, Dir::Forward), (lines(&[], &[(2, 2)]), Dir::Forward), (StageSelection::Hunks { hunks: vec![0] }, Dir::Reverse)] {
            let out = text(partial_patch(diff.as_bytes(), &sel, dir));
            assert!(!out.contains("old mode") && !out.contains("new mode"), "{out}");
            assert!(out.starts_with("diff --git a/m b/m\nindex 1111111..2222222\n--- a/m\n+++ b/m\n@@ -1,3 +1,"), "{out}");
        }
        assert!(!parse(diff.as_bytes()).mode_only());
        let only = "diff --git a/m b/m\nold mode 100644\nnew mode 100755\n";
        assert!(parse(only.as_bytes()).mode_only() && partial_patch(only.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }, Dir::Forward).is_none());
    }

    /// Review I2: a second section (a typechange's add after its delete) is header, not content.
    #[test]
    fn a_second_section_is_never_read_as_lines() {
        let diff = "diff --git a/f b/f\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n\
diff --git a/f b/f\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n";
        let p = parse(diff.as_bytes());
        assert_eq!(p.hunks[0].summary().del, [1, 2], "the next section's header isn't a deleted line");
        assert!(p.hunks[0].summary().add.is_empty());
        assert_eq!(p.hunks[1].summary().add, [1]);
        assert!(p.hunks[1].lines[0].no_eol, "the marker after a hunk's last counted line still attaches");
        assert_eq!(p.refusal(), Some("The file's type changed: stage the whole file"));
        assert!(partial_patch(diff.as_bytes(), &StageSelection::Hunks { hunks: vec![0] }, Dir::Forward).is_none());
    }

    #[test]
    fn symlinks_submodules_and_conflicts_are_refused() {
        let link = "diff --git a/l b/l\nindex 1111111..2222222 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
        assert_eq!(parse(link.as_bytes()).refusal(), Some("Symlink: stage the whole file"));
        assert!(partial_patch(link.as_bytes(), &lines(&[(1, 1)], &[]), Dir::Forward).is_none());
        let sm = "diff --git a/sm b/sm\nindex 1111111..2222222 160000\n--- a/sm\n+++ b/sm\n@@ -1 +1 @@\n-Subproject commit 1111111\n+Subproject commit 2222222\n";
        assert_eq!(parse(sm.as_bytes()).refusal(), Some("Submodule: stage the whole file"));
        assert_eq!(parse(b"* Unmerged path a.txt\n").refusal(), Some("Resolve the conflict first"));
        let cc = "diff --cc a.txt\nindex 1111111,2222222..0000000\n--- a/a.txt\n+++ b/a.txt\n@@@ -1,1 -1,1 +1,5 @@@\n";
        assert_eq!(parse(cc.as_bytes()).refusal(), Some("Resolve the conflict first"));
        assert_eq!(parse(TWO.as_bytes()).refusal(), None);
    }

    /// Review m1: the count is taken after the no-newline tie.
    #[test]
    fn labels_count_the_lines_the_tie_adds() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n";
        assert_eq!(selection_label(diff.as_bytes(), &lines(&[], &[(3, 3)]), Dir::Forward), "3 lines");
        assert_eq!(selection_label(diff.as_bytes(), &lines(&[(2, 2)], &[]), Dir::Reverse), "3 lines");
        assert_eq!(selection_label(diff.as_bytes(), &lines(&[], &[(3, 3)]), Dir::Reverse), "1 line");
    }

    #[test]
    fn a_binary_diff_is_marked() {
        let p = parse(b"diff --git a/b.png b/b.png\nindex 1..2 100644\nBinary files a/b.png and b/b.png differ\n");
        assert!(p.binary && p.hunks.is_empty());
    }
}
