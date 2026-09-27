//! Minimal, version-proof parser for raw git commit objects.

use crate::error::{GbError, GbErrorKind};
use crate::payload::CommitMessage;
use gix::ObjectId;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Unix timestamp, or 0 if the signature line's timestamp couldn't be parsed.
    pub time: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommit {
    pub parents: Vec<ObjectId>,
    pub author: Signature,
    pub committer: Signature,
    pub summary: String,
    pub body: String,
    /// Full message: decoded, CRLF normalized to LF, trailing whitespace trimmed.
    pub message: String,
    pub signed: bool,
}

/// UTF-8 if valid, otherwise Latin-1 (which maps every byte and never fails).
pub fn decode_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

fn decode_with(encoding: Option<&str>, bytes: &[u8]) -> String {
    match encoding.map(str::to_ascii_lowercase).as_deref() {
        None | Some("utf-8") | Some("utf8") => decode_text(bytes),
        // ISO-8859-1/latin1 and anything unknown: Latin-1 is lossless per byte.
        Some(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

fn parse_signature(raw: &[u8]) -> Signature {
    let text = decode_text(raw);
    let (Some(lt), Some(gt)) = (text.rfind('<'), text.rfind('>')) else {
        return Signature { name: text.trim().to_string(), ..Default::default() };
    };
    let name = text[..lt].trim().to_string();
    let email = text[lt + 1..gt.max(lt + 1)].to_string();
    let time = text[gt + 1..].split_whitespace().next().and_then(|t| t.parse().ok()).unwrap_or(0);
    Signature { name, email, time }
}

/// A full 40-hex (SHA-1) object id sent by the UI: the only kind this gix build (without its
/// `sha256` feature) can represent. Abbreviations and everything else (for example text starting
/// with `-`, which git would read as an option) are rejected, so a parsed id is always safe to
/// pass to git as an argument.
pub fn parse_oid(s: &str) -> Result<ObjectId, GbError> {
    if s.len() != 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("not a full object id: {s:?}")));
    }
    ObjectId::from_hex(s.as_bytes()).map_err(|e| GbError::new(GbErrorKind::InvalidInput, format!("bad object id {s:?}: {e}")))
}

pub fn parse_commit(raw: &[u8]) -> Result<ParsedCommit, GbError> {
    let split = raw.windows(2).position(|w| w == b"\n\n");
    let (headers, message) = match split {
        Some(i) => (&raw[..i], &raw[i + 2..]),
        None => (raw, &b""[..]),
    };
    let mut parents = Vec::new();
    let mut author = Signature::default();
    let mut committer = Signature::default();
    let mut encoding: Option<String> = None;
    let mut signed = false;
    for line in headers.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.first() == Some(&b' ') {
            continue; // continuation of a multi-line header (gpgsig, mergetag)
        }
        let (key, value) = match line.iter().position(|b| *b == b' ') {
            Some(i) => (&line[..i], &line[i + 1..]),
            None => (line, &b""[..]),
        };
        match key {
            b"parent" => parents.push(
                ObjectId::from_hex(value).map_err(|e| GbError::other(format!("bad parent id in commit: {e}")))?,
            ),
            b"author" => author = parse_signature(value),
            b"committer" => committer = parse_signature(value),
            b"encoding" => encoding = Some(decode_text(value)),
            b"gpgsig" | b"gpgsig-sha256" => signed = true,
            _ => {}
        }
    }
    let message = decode_with(encoding.as_deref(), message);
    // Normalize CRLF line endings so the "\n\n" summary/body split (and any consumer of the
    // body) never has to deal with a stray '\r'.
    let message = message.replace("\r\n", "\n");
    let mut message = message;
    message.truncate(message.trim_end().len());
    let (summary, body) = match message.split_once("\n\n") {
        Some((s, b)) => (s, b.trim()),
        None => (message.as_str(), ""),
    };
    let summary = summary.lines().next().unwrap_or("").trim().to_string();
    let body = body.to_string();
    Ok(ParsedCommit { parents, author, committer, summary, body, message, signed })
}

/// The full message of commit `id` (a full hex object id), read in-process with gix (read-only).
pub fn read_commit_message(repo: &gix::Repository, id: &str) -> Result<CommitMessage, GbError> {
    let oid = parse_oid(id)?;
    let parsed = parse_commit(&crate::details::read_commit(repo, oid)?)?;
    // Everything after the first line: unlike `ParsedCommit::body`, this keeps the other lines of
    // a multi-line first paragraph.
    let body = parsed.message.split_once('\n').map(|(_, rest)| rest.trim()).unwrap_or("");
    Ok(CommitMessage { id: oid.to_string(), body: body.to_string(), summary: parsed.summary })
}

#[cfg(test)]
mod tests {
    use super::*;

    const P1: &str = "1111111111111111111111111111111111111111";
    const P2: &str = "2222222222222222222222222222222222222222";

    fn raw(extra_headers: &str, msg: &[u8]) -> Vec<u8> {
        let mut v = format!(
            "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent {P1}\nparent {P2}\nauthor Ada Q. Lovelace <ada@example.com> 1700000000 +0100\ncommitter Grace Hopper <grace@example.com> 1700000600 -0500\n{extra_headers}\n"
        )
        .into_bytes();
        v.extend_from_slice(msg);
        v
    }

    #[test]
    fn parses_headers_summary_and_body() {
        let c = parse_commit(&raw("", b"Fix the thing\n\nLonger explanation\nsecond line\n")).unwrap();
        assert_eq!(c.parents.iter().map(|p| p.to_string()).collect::<Vec<_>>(), vec![P1, P2]);
        assert_eq!(c.author.name, "Ada Q. Lovelace");
        assert_eq!(c.author.email, "ada@example.com");
        assert_eq!(c.author.time, 1_700_000_000);
        assert_eq!(c.committer.time, 1_700_000_600);
        assert_eq!(c.summary, "Fix the thing");
        assert_eq!(c.body, "Longer explanation\nsecond line");
        assert!(!c.signed);
    }

    #[test]
    fn detects_multiline_gpgsig() {
        let sig = "gpgsig -----BEGIN PGP SIGNATURE-----\n \n abcdef\n -----END PGP SIGNATURE-----\n";
        let c = parse_commit(&raw(sig, b"Signed commit\n")).unwrap();
        assert!(c.signed);
        assert_eq!(c.summary, "Signed commit");
        assert_eq!(c.body, "");
    }

    #[test]
    fn parses_latin1_message() {
        let c = parse_commit(&raw("encoding ISO-8859-1\n", b"caf\xe9 cr\xe8me\n")).unwrap();
        assert_eq!(c.summary, "café crème");
    }

    #[test]
    fn invalid_utf8_without_header_falls_back_to_latin1() {
        let c = parse_commit(&raw("", b"na\xefve\n")).unwrap();
        assert_eq!(c.summary, "naïve");
    }

    #[test]
    fn root_commit_has_no_parents_and_empty_message_is_ok() {
        let raw = b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\n";
        let c = parse_commit(raw).unwrap();
        assert!(c.parents.is_empty());
        assert_eq!(c.summary, "");
    }

    #[test]
    fn crlf_message_preserves_body_without_carriage_returns() {
        let c = parse_commit(&raw("", b"Fix bug\r\n\r\nDetails here\r\n")).unwrap();
        assert_eq!(c.summary, "Fix bug");
        assert_eq!(c.body, "Details here");
        assert!(!c.summary.contains('\r'));
        assert!(!c.body.contains('\r'));
    }

    #[test]
    fn message_without_blank_line_is_summary_only() {
        let c = parse_commit(&raw("", b"Just a title, no body\n")).unwrap();
        assert_eq!(c.summary, "Just a title, no body");
        assert_eq!(c.body, "");
    }

    #[test]
    fn mergetag_multiline_header_is_skipped() {
        let mergetag = "mergetag object 3333333333333333333333333333333333333333\n type commit\n tag v1.0\n -----BEGIN PGP SIGNATURE-----\n abcdef\n -----END PGP SIGNATURE-----\n";
        let c = parse_commit(&raw(mergetag, b"Merge tag 'v1.0'\n\nMerge details\n")).unwrap();
        assert_eq!(c.parents.iter().map(|p| p.to_string()).collect::<Vec<_>>(), vec![P1, P2]);
        assert_eq!(c.summary, "Merge tag 'v1.0'");
        assert_eq!(c.body, "Merge details");
        assert!(!c.signed);
    }

    #[test]
    fn signature_without_email_has_no_panic() {
        let raw = b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Bob\ncommitter Bob\n\nMsg\n";
        let c = parse_commit(raw).unwrap();
        assert_eq!(c.author.name, "Bob");
        assert_eq!(c.author.email, "");
        assert_eq!(c.author.time, 0);
    }

    #[test]
    fn keeps_the_full_message() {
        let c = parse_commit(&raw("", b"Title\nwrapped title line\n\nBody\r\n\r\nCo-authored-by: X <x@y>\n")).unwrap();
        assert_eq!(c.summary, "Title");
        assert_eq!(c.message, "Title\nwrapped title line\n\nBody\n\nCo-authored-by: X <x@y>");
    }

    #[test]
    fn parse_oid_accepts_full_hex_only() {
        assert!(parse_oid(P1).is_ok());
        // SHA-256 repositories (64-hex ids) would need gix's `sha256` feature, which isn't enabled.
        for bad in ["HEAD", "1111111", "--output=/tmp/x", "", &"g".repeat(40), &"ab".repeat(32)] {
            assert_eq!(parse_oid(bad).unwrap_err().kind, crate::error::GbErrorKind::InvalidInput, "{bad}");
        }
    }

    mod read {
        use super::super::*;
        use crate::testing::{fixtures, TestRepo};

        fn open(r: &TestRepo) -> gix::Repository {
            gix::open(r.path()).unwrap()
        }

        #[test]
        fn reads_summary_and_full_body() {
            let r = TestRepo::new();
            fixtures::long_labels(&r);
            let id = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
            let m = read_commit_message(&open(&r), &id).unwrap();
            assert_eq!(m, CommitMessage { id: id.clone(), summary: "Initial commit".into(), body: "With a body line\n\nA second paragraph,\nwrapped over two lines.".into() });
        }

        #[test]
        fn a_multi_line_first_paragraph_keeps_its_other_lines_in_the_body() {
            let r = TestRepo::new();
            let id = r.commit("Line one\nline two\n\nThe body");
            let m = read_commit_message(&open(&r), &id).unwrap();
            assert_eq!(m.summary, "Line one");
            assert_eq!(m.body, "line two\n\nThe body");
            let id = r.commit("Summary only");
            assert_eq!(read_commit_message(&open(&r), &id).unwrap().body, "");
        }

        #[test]
        fn bad_ids_are_rejected() {
            let r = TestRepo::new();
            r.commit("Initial commit");
            let repo = open(&r);
            assert_eq!(read_commit_message(&repo, "not-hex").unwrap_err().kind, GbErrorKind::InvalidInput);
            assert_eq!(read_commit_message(&repo, &"1".repeat(40)).unwrap_err().kind, GbErrorKind::NotFound);
            let tree = r.git(&["rev-parse", "HEAD^{tree}"]);
            assert_eq!(read_commit_message(&repo, &tree).unwrap_err().kind, GbErrorKind::InvalidInput);
        }
    }
}
