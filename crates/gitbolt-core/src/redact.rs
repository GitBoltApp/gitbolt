//! Removes secrets before anything is logged or shown.

use regex::Regex;
use std::sync::LazyLock;

static URL_CREDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(https?://)[^/\s@]+@").unwrap());
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(glpat-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})").unwrap()
});
static AUTH_HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(authorization:\s*)\S+(\s+\S+)?").unwrap());

pub fn redact(s: &str) -> String {
    let s = URL_CREDS.replace_all(s, "${1}***@");
    let s = TOKENS.replace_all(&s, "***");
    AUTH_HEADER.replace_all(&s, "${1}***").into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn removes_url_credentials() {
        assert_eq!(redact(&format!("https://oauth2:glpat-{}@gitlab.example.com/a/b.git", "a".repeat(21))), "https://***@gitlab.example.com/a/b.git");
        assert_eq!(redact("http://user@h/x"), "http://***@h/x");
    }

    #[test]
    fn removes_tokens() {
        let gh = format!("ghp_{}", "a".repeat(36));
        assert_eq!(redact(&format!("token {gh} end")), "token *** end");
        assert_eq!(redact(&format!("glpat-{}", "ABCDEFGHIJ0123456789xyz")), "***");
        assert_eq!(redact(&format!("github_pat_{}", "B".repeat(30))), "***");
    }

    #[test]
    fn removes_authorization_header_values() {
        assert_eq!(redact("Authorization: Bearer abc.def"), "Authorization: ***");
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(redact("https://github.com/o/r/blob/main/a@b.txt"), "https://github.com/o/r/blob/main/a@b.txt");
        assert_eq!(redact("commit -m hello"), "commit -m hello");
    }
}
