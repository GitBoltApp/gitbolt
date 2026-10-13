//! MR/PR/issue references in commit messages (spec §9.2), parsed once at graph-assembly time
//! into `RowPayload::mr_refs` so the commit menu (§7) can offer `Open !1187` rows without a
//! backend call.

/// At most this many labels per commit, so a pathological message can't bloat the payload.
pub const MAX_MESSAGE_REFS: usize = 20;

/// Every `!N`, `path!N`, `#N` and `path#N` reference in `message`, exactly as written, in
/// first-occurrence order, deduplicated, capped at [`MAX_MESSAGE_REFS`]. The host kind isn't
/// known here: the UI decides what each one means (GitLab: `!` MRs, `#` issues; GitHub: `#` PRs,
/// `!` ignored). Equivalent to the regex
/// `(?<![\w/.!#-])(?:(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+)?[!#][0-9]+\b` (with Unicode `\w`),
/// applied outside `http://`/`https://` URLs (matched case-insensitively, up to whitespace). The
/// shared vectors in `testdata/message-refs.json` pin the behaviour for the UI tokenizer too.
pub fn parse_message_refs(message: &str) -> Vec<String> {
    let bytes = message.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    // Byte-wise is safe on UTF-8: every byte compared is ASCII, and continuation bytes never are.
    while i < bytes.len() && out.len() < MAX_MESSAGE_REFS {
        match bytes[i] {
            b'h' | b'H' if is_url_start(&bytes[i..]) => {
                i = message[i..].find(char::is_whitespace).map_or(bytes.len(), |n| i + n);
            }
            b'!' | b'#' => match reference_at(message, i) {
                Some((start, end)) => {
                    let label = &message[start..end];
                    if !out.iter().any(|r| r == label) {
                        out.push(label.to_string());
                    }
                    i = end;
                }
                None => i += 1,
            },
            _ => i += 1,
        }
    }
    out
}

fn is_url_start(rest: &[u8]) -> bool {
    let has = |scheme: &[u8]| rest.len() >= scheme.len() && rest[..scheme.len()].eq_ignore_ascii_case(scheme);
    has(b"http://") || has(b"https://")
}

fn is_word(c: char) -> bool {
    // Unicode, not ASCII: the TS port (plan 1B Task 12) must match with `[\p{L}\p{N}_]` under the `u` flag.
    c.is_alphanumeric() || c == '_'
}

/// A path segment byte (`[A-Za-z0-9_.-]`) or the `/` between segments.
fn is_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'/')
}

/// `segment/…/segment`: at least two non-empty segments.
fn is_path(p: &[u8]) -> bool {
    let mut segments = 0;
    for s in p.split(|&b| b == b'/') {
        if s.is_empty() {
            return false;
        }
        segments += 1;
    }
    segments >= 2
}

/// The byte range of the reference whose `!`/`#` sits at `sigil`, if there is one.
fn reference_at(message: &str, sigil: usize) -> Option<(usize, usize)> {
    let bytes = message.as_bytes();
    let digits = sigil + 1;
    let end = digits + bytes[digits..].iter().take_while(|b| b.is_ascii_digit()).count();
    if end == digits || message[end..].chars().next().is_some_and(is_word) {
        return None;
    }
    // Everything glued on the left must form a valid path: a path can't start mid-run (its
    // preceding character would be a glued one), and a bare ref can't follow a run either.
    let start = sigil - bytes[..sigil].iter().rev().take_while(|&&b| is_path_byte(b)).count();
    if start < sigil && !is_path(&bytes[start..sigil]) {
        return None;
    }
    let glued = |c: char| is_word(c) || matches!(c, '/' | '.' | '!' | '#' | '-');
    if message[..start].chars().next_back().is_some_and(glued) {
        return None;
    }
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        message: String,
        refs: Vec<String>,
    }

    #[test]
    fn shared_vectors() {
        let vectors: Vec<Vector> = serde_json::from_str(include_str!("../../../testdata/message-refs.json")).expect("valid vectors");
        assert!(vectors.len() >= 8);
        for v in &vectors {
            assert_eq!(parse_message_refs(&v.message), v.refs, "message: {:?}", v.message);
        }
    }
}
