//! Opening links in the default browser (spec §14.4). The app injects the Tauri opener; the
//! harness injects a no-op.

use crate::error::{GbError, GbErrorKind};
use std::sync::Arc;

pub type UrlOpener = Arc<dyn Fn(&str) -> Result<(), GbError> + Send + Sync>;

/// Only plain `http(s)` links and `mailto:` addresses may leave the app:
/// - no `file:`, `javascript:` or custom schemes (the scheme match ignores case)
/// - a non-empty host, an optional numeric port, and no userinfo (`https://github.com@evil.example/`
///   is a phishing shape)
/// - `mailto:` with one plausible address (`local@domain.tld`), then an optional `?subject=…`
/// - no whitespace, control characters, or invisible format characters such as bidi overrides
pub fn validate_web_url(url: &str) -> Result<(), GbError> {
    let invalid = || GbError::new(GbErrorKind::InvalidInput, format!("not a web link: {url:?}"));
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || is_format_char(c)) {
        return Err(invalid());
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("mailto:") {
        return if plausible_mail_address(&url["mailto:".len()..]) { Ok(()) } else { Err(invalid()) };
    }
    let rest = ["https://", "http://"].iter().find(|s| lower.starts_with(**s)).map(|s| &url[s.len()..]).ok_or_else(invalid)?;
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.contains('@') {
        return Err(invalid());
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => {
            let end = v6.find(']').ok_or_else(invalid)?;
            let after = &v6[end + 1..];
            (&v6[..end], if after.is_empty() { None } else { Some(after.strip_prefix(':').ok_or_else(invalid)?) })
        }
        None => match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    if host.is_empty() || port.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return Err(invalid());
    }
    Ok(())
}

/// One `local@domain.tld` address, then an optional `?query` (a subject, a body): the local part in
/// RFC 5322's atom characters (percent-escapes included), the domain in dot-separated letter,
/// digit and hyphen labels with at least one dot. Never a list, never a leading `-` or `/`.
fn plausible_mail_address(rest: &str) -> bool {
    let address = rest.split_once('?').map_or(rest, |(a, _)| a);
    let Some((local, domain)) = address.split_once('@') else { return false };
    let local_ok = !local.is_empty()
        && !local.starts_with(['-', '.', '/'])
        && !local.ends_with('.')
        && local.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+/=^_`{|}~.-".contains(&b));
    let label_ok = |l: &str| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    local_ok && domain.contains('.') && domain.split('.').all(label_ok)
}

/// Unicode general category Cf (format) characters that can hide or reorder text: soft hyphen,
/// Arabic and Syriac marks, the Mongolian vowel separator, zero-width characters, bidi embeddings,
/// overrides and isolates, invisible operators, the BOM, interlinear annotations and tag characters.
fn is_format_char(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{0600}'..='\u{0605}' | '\u{061C}' | '\u{06DD}' | '\u{070F}' | '\u{0890}'..='\u{0891}' | '\u{08E2}' | '\u{180E}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}'
        | '\u{FFF9}'..='\u{FFFB}' | '\u{110BD}' | '\u{110CD}' | '\u{13430}'..='\u{1343F}' | '\u{1BCA0}'..='\u{1BCA3}'
        | '\u{1D173}'..='\u{1D17A}' | '\u{E0001}' | '\u{E0020}'..='\u{E007F}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_web_links() {
        for ok in [
            "https://gitlab.example.com/group/project/-/merge_requests/42",
            "HTTPS://GitHub.com/owner/repo/pull/7",
            "http://localhost:8080/x?y=1#z",
            "https://[::1]:8443/",
            "https://example.com",
            "https://gitlab.example.com/group/project/-/commit/abc?ref=a@b",
        ] {
            assert!(validate_web_url(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn accepts_a_mailto_with_one_plausible_address() {
        for ok in [
            "mailto:ada@example.com",
            "MAILTO:Ada.Lovelace+git@mail.example.co.uk",
            "mailto:a_b@x-y.example?subject=Hello%20there",
            "mailto:o%27neil@example.com",
        ] {
            assert!(validate_web_url(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn rejects_a_mailto_without_a_plausible_address() {
        for bad in [
            "mailto:",
            "mailto:ada",
            "mailto:ada@localhost",
            "mailto:@example.com",
            "mailto:ada@",
            "mailto:ada@@example.com",
            "mailto:-x@example.com",
            "mailto:.ada@example.com",
            "mailto:ada@example..com",
            "mailto:ada@-example.com",
            "mailto:a@example.com,b@example.com",
            "mailto:ada@exa_mple.com",
            "mailto:ada <ada@example.com>",
            "mailto:ada@example.com\n",
            "mailto:ada@example.com\u{202E}",
            "mailto:\u{200B}ada@example.com",
            "mailto:?to=ada@example.com",
            "mailto://ada@example.com",
        ] {
            let err = validate_web_url(bad).unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad:?}");
        }
    }

    #[test]
    fn rejects_non_web_empty_authority_userinfo_and_invisible_characters() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "https://",
            "http:///x",
            "http://:80",
            "http://:80/path",
            "https://?q",
            "https://#frag",
            "https://github.com@evil.example/",
            "https://user:pass@example.com/",
            "https://example.com:80x/",
            "https://[]/",
            "https://[::1]x/",
            "https://[::1/",
            "https://x y",
            "https://example.com/\u{202E}gpj.exe",
            "https://example.com/\u{200B}",
            "https://exa\u{2066}mple.com/",
            "https://example.com/\u{FEFF}",
            "https://example.com/\u{E0041}",
            "https://example.com/\n",
        ] {
            let err = validate_web_url(bad).unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{bad:?}");
        }
    }
}
