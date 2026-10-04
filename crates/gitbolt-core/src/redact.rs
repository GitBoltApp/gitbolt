//! Removes secrets before anything is logged or shown.

use regex::Regex;
use std::sync::LazyLock;

/// http(s): any userinfo (a lone user name is often a token: `https://<token>@github.com`).
static HTTP_USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(https?://)[^/\s@'\x22]+@").unwrap());
/// Any other scheme (ssh, git, ftp(s), file, `git+ssh`, ...): a `user:password@` userinfo. A user
/// name alone (`ssh://git@host`) isn't secret there.
static URL_PASSWORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s@:'\x22]*:[^/\s@'\x22]*@").unwrap());
/// Tokens in a query string (`?private_token=...`).
static QUERY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([?&](?:access_token|private_token|oauth_token|job_token|token|password|passwd|secret|api_key|apikey|key)=)[^&\s'\x22]+").unwrap());
/// Forge tokens: GitLab's family (`glpat-`, `gloas-`, `glrt-`, ...), GitHub's, Bitbucket and
/// Atlassian app passwords and API tokens.
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(gl(?:pat|oas|dt|rt|cbt|ptt|ft|imt|agent|soat|ffct)-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|ATBB[A-Za-z0-9]{24,}|ATATT[A-Za-z0-9_\-=]{20,})").unwrap()
});
static AUTH_HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(authorization:\s*)\S+(\s+\S+)?").unwrap());

/// Every message, stderr and log line goes through this before it's logged, stored (the activity
/// log) or shown (toasts): `GitCli::run` redacts stderr before taking the error's message.
pub fn redact(s: &str) -> String {
    let s = HTTP_USERINFO.replace_all(s, "${1}***@");
    let s = URL_PASSWORD.replace_all(&s, "${1}***@");
    let s = QUERY_TOKEN.replace_all(&s, "${1}***");
    let s = TOKENS.replace_all(&s, "***");
    AUTH_HEADER.replace_all(&s, "${1}***").into_owned()
}

// --- 4A T1: secrets ---
/// A token in memory (spec #4 §6). It deserializes from a plain JSON string, but never
/// serializes, displays or debug-prints its value. `expose` is for the places that must have it:
/// the `Authorization` header and the token store.
#[derive(Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Without the whitespace a copy from a browser brings along (a trailing newline, spaces).
    pub fn trimmed(&self) -> Self {
        Self(self.0.trim().to_string())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}
// --- end 4A T1 ---

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn removes_url_credentials() {
        assert_eq!(redact(&format!("https://oauth2:glpat-{}@gitlab.example.com/a/b.git", "a".repeat(21))), "https://***@gitlab.example.com/a/b.git");
        assert_eq!(redact("http://user@h/x"), "http://***@h/x");
    }

    /// K96 review: a password in the userinfo of any URL scheme, not just http(s). A user name
    /// alone (`ssh://git@host`) isn't secret there and stays readable.
    #[test]
    fn removes_passwords_from_any_url_scheme() {
        for scheme in ["ssh", "git", "ftp", "ftps", "file", "git+ssh", "ssh+git", "svn+ssh", "rsync", "SSH"] {
            assert_eq!(redact(&format!("{scheme}://ada:hunter2@h.example/x.git")), format!("{scheme}://***@h.example/x.git"), "{scheme}");
        }
        assert_eq!(redact("ssh://git@gitlab.example.com:2222/a/b.git"), "ssh://git@gitlab.example.com:2222/a/b.git", "a user name alone stays");
        assert_eq!(redact("ssh://h.example:22/x.git"), "ssh://h.example:22/x.git", "a port isn't a password");
        assert_eq!(redact("file:///home/ada/repo.git"), "file:///home/ada/repo.git");
        // http(s) keeps hiding a lone user name too: it's often a token.
        assert_eq!(redact("https://ghtoken@github.com/o/r"), "https://***@github.com/o/r");
    }

    /// As git prints them: the URL quoted mid-sentence, sometimes several on one line or across
    /// lines of a whole stderr.
    #[test]
    fn removes_credentials_from_urls_inside_messages() {
        assert_eq!(redact("fatal: repository 'ssh://ada:hunter2@h/x' not found"), "fatal: repository 'ssh://***@h/x' not found");
        assert_eq!(redact("fatal: unable to access 'https://ada:pw@h/x.git/': The requested URL returned error: 403"), "fatal: unable to access 'https://***@h/x.git/': The requested URL returned error: 403");
        assert_eq!(
            redact("Fetching origin\nfatal: unable to connect to git://u:p@a/x (and ftp://u2:p2@b/y)\nerror: could not fetch origin"),
            "Fetching origin\nfatal: unable to connect to git://***@a/x (and ftp://***@b/y)\nerror: could not fetch origin"
        );
        assert_eq!(redact("Cloning into 'x'... from \"ssh://ada:s3cr3t@h/x\"."), "Cloning into 'x'... from \"ssh://***@h/x\".");
    }

    /// Tokens in a query string, and the other forges' token formats.
    #[test]
    fn removes_query_tokens_and_more_token_formats() {
        assert_eq!(redact("https://h/x.git?private_token=abc123&ref=main"), "https://h/x.git?private_token=***&ref=main");
        assert_eq!(redact("'https://h/api?access_token=abc.def'"), "'https://h/api?access_token=***'");
        assert_eq!(redact(&format!("x gloas-{} y", "a".repeat(24))), "x *** y");
        assert_eq!(redact(&format!("glrt-{}", "Z9".repeat(12))), "***");
        assert_eq!(redact(&format!("ATBB{}", "k".repeat(28))), "***");
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
    // --- 4A T1 ---
    #[test]
    fn a_secret_never_shows_its_value() {
        let s: super::Secret = serde_json::from_str("\"  glpat-FAKE-test-token\\n\"").unwrap();
        assert_eq!(format!("{s:?}"), "Secret(***)");
        assert_eq!(format!("{:?}", Some(s.clone())), "Some(Secret(***))");
        assert_eq!(s.trimmed().expose(), "glpat-FAKE-test-token");
        assert!(super::Secret::new(" \n").trimmed().is_empty());
    }
    // --- end 4A T1 ---
}
