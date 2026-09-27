//! Minimal, version-proof parser for raw git commit objects.

use crate::error::GbError;
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
    let message = message.trim_end();
    let (summary, body) = match message.split_once("\n\n") {
        Some((s, b)) => (s, b.trim()),
        None => (message, ""),
    };
    Ok(ParsedCommit {
        parents,
        author,
        committer,
        summary: summary.lines().next().unwrap_or("").trim().to_string(),
        body: body.to_string(),
        signed,
    })
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
}
