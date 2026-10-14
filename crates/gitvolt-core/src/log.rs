//! In-memory ring buffers of every git invocation (the Debug → Commands tab) and every core API
//! request (the Debug → Requests tab).

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use ts_rs::TS;

pub const STDERR_LOG_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandLogEntry {
    #[ts(type = "number")]
    pub id: u64,
    pub args: Vec<String>,
    pub cwd: String,
    #[ts(type = "number")]
    pub started_ms: i64,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub stderr: String,
}

pub struct CommandLog {
    inner: Mutex<VecDeque<CommandLogEntry>>,
    next_id: AtomicU64,
    capacity: usize,
}

impl CommandLog {
    pub fn new(capacity: usize) -> Self {
        Self { inner: Mutex::new(VecDeque::with_capacity(capacity)), next_id: AtomicU64::new(1), capacity }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn push(&self, entry: CommandLogEntry) {
        let mut q = self.inner.lock().expect("command log poisoned");
        if q.len() == self.capacity {
            q.pop_front();
        }
        q.push_back(entry);
    }

    /// Replaces a logged command's stderr (a push's Details, with the server's lines first).
    pub fn set_stderr(&self, id: u64, stderr: &str) {
        let mut entries = self.inner.lock().expect("command log poisoned");
        if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
            e.stderr = truncate_utf8(stderr, STDERR_LOG_LIMIT).to_string();
        }
    }

    /// Oldest first.
    pub fn entries(&self) -> Vec<CommandLogEntry> {
        self.inner.lock().expect("command log poisoned").iter().cloned().collect()
    }
}

// --- the request log ---
/// One core API request (`Api::dispatch`), as the Debug modal's Requests tab lists it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RequestLogEntry {
    #[ts(type = "number")]
    pub id: u64,
    /// The method as the UI sends it (`graph`, `commitDetails`, …).
    pub method: String,
    /// The identifying params only (`params_summary`): never a token, a body or a file's content.
    pub params: String,
    #[ts(type = "number")]
    pub started_ms: i64,
    /// Milliseconds, to the microsecond.
    pub duration_ms: f64,
    /// None: it succeeded.
    pub error: Option<crate::error::GbErrorKind>,
    /// The error's message, redacted and capped.
    pub error_message: Option<String>,
    /// The git commands it ran (their ids in the command log), in order.
    #[ts(type = "number[]")]
    pub commands: Vec<u64>,
}

/// The last `capacity` requests, oldest first.
pub struct RequestLog {
    inner: Mutex<VecDeque<RequestLogEntry>>,
    next_id: AtomicU64,
    capacity: usize,
}

impl RequestLog {
    pub fn new(capacity: usize) -> Self {
        Self { inner: Mutex::new(VecDeque::with_capacity(capacity)), next_id: AtomicU64::new(1), capacity }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn push(&self, entry: RequestLogEntry) {
        let mut q = self.inner.lock().expect("request log poisoned");
        if q.len() == self.capacity {
            q.pop_front();
        }
        q.push_back(entry);
    }

    /// Oldest first.
    pub fn entries(&self) -> Vec<RequestLogEntry> {
        self.inner.lock().expect("request log poisoned").iter().cloned().collect()
    }
}

tokio::task_local! {
    /// The git commands the current request has started (`note_command`).
    static REQUEST_COMMANDS: Arc<Mutex<Vec<u64>>>;
}

/// A git command started: the request running it (if any, on this task) links to it.
pub fn note_command(id: u64) {
    let _ = REQUEST_COMMANDS.try_with(|c| c.lock().expect("request commands poisoned").push(id));
}

/// Runs `f`, collecting the ids of the git commands it starts on its own task (one a
/// `tokio::spawn`ed task starts isn't attributed).
pub async fn with_command_scope<F: std::future::Future>(f: F) -> (F::Output, Vec<u64>) {
    let ids = Arc::new(Mutex::new(Vec::new()));
    let out = REQUEST_COMMANDS.scope(ids.clone(), f).await;
    let ids = std::mem::take(&mut *ids.lock().expect("request commands poisoned"));
    (out, ids)
}

/// A summary's cap, in characters (a `…` follows when it's cut).
pub const SUMMARY_LIMIT: usize = 240;
const VALUE_LIMIT: usize = 120;
/// The params a summary keeps (snake_case, as the Debug text names them): ids, paths, revisions,
/// names, numbers. Anything else (a message, a body, a file's content, a token, a query) is left out.
const SUMMARY_KEYS: &[&str] = &[
    "repo", "worktree", "path", "old_path", "rev", "id", "oid", "sha", "number", "remote", "branch", "base", "target", "name", "host", "kind", "url", "to", "staged",
    "limit", "tag", "upstream", "spec", "pin", "old", "new", "mode", "scope", "entry", "background", "dest",
];

/// A request's identifying params, from its Debug text (`Graph { repo: 3, limit: None, … }` →
/// `repo=3`): only `SUMMARY_KEYS`, found outside string literals (so key-like text inside a
/// message never matches), `None`s left out, each value capped, the whole redacted and capped.
pub fn params_summary(debug: &str) -> String {
    let b = debug.as_bytes();
    let mut out = String::new();
    let Some(open) = debug.find(['{', '(']) else { return out };
    let mut i = open + 1;
    while i < b.len() && out.len() <= SUMMARY_LIMIT * 2 {
        let c = b[i];
        if c == b'"' {
            i = skip_string(b, i);
        } else if (c.is_ascii_alphabetic() || c == b'_') && matches!(b[i - 1], b' ' | b'{' | b'(' | b',' | b'[') {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            let key = &debug[start..i];
            if debug[i..].starts_with(": ") {
                i += 2;
                if SUMMARY_KEYS.contains(&key) {
                    let (value, next) = summary_value(debug, i);
                    if let Some(v) = value {
                        if !out.is_empty() {
                            out.push(' ');
                        }
                        out.push_str(&camel(key));
                        out.push('=');
                        out.push_str(&v);
                    }
                    i = next;
                }
            }
        } else {
            i += 1;
        }
    }
    let out = crate::redact::redact(&out);
    if out.chars().count() > SUMMARY_LIMIT { format!("{}…", out.chars().take(SUMMARY_LIMIT).collect::<String>()) } else { out }
}

/// Past the string literal starting at `b[i]` (a `"`).
fn skip_string(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' => return j + 1,
            _ => j += 1,
        }
    }
    b.len()
}

/// The value at `i`: a string literal's text, or a number, bool or enum variant's name (the scan
/// then carries on into the variant's fields). None for `None` and for a struct or a list.
fn summary_value(debug: &str, mut i: usize) -> (Option<String>, usize) {
    while debug[i..].starts_with("Some(") {
        i += 5;
    }
    let rest = &debug[i..];
    if rest.starts_with("None") {
        return (None, i + 4);
    }
    if rest.starts_with('"') {
        let end = skip_string(debug.as_bytes(), i);
        let raw = &debug[i + 1..end.saturating_sub(1).max(i + 1)];
        let text = raw.replace("\\\"", "\"").replace("\\\\", "\\");
        let mut v: String = text.chars().take(VALUE_LIMIT).collect();
        if text.chars().count() > VALUE_LIMIT {
            v.push('…');
        }
        if v.is_empty() || v.contains(char::is_whitespace) {
            v = format!("\"{v}\"");
        }
        return (Some(v), end);
    }
    let len = rest.find([',', ' ', '}', ')', ']', '(', '{', '[']).unwrap_or(rest.len());
    if len == 0 { (None, i) } else { (Some(rest[..len].to_string()), i + len) }
}

/// `old_path` → `oldPath`, as the UI sends it.
fn camel(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut up = false;
    for c in key.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}
// --- end the request log ---

pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64) -> CommandLogEntry {
        CommandLogEntry { id, args: vec![], cwd: String::new(), started_ms: 0, duration_ms: 0, exit_code: Some(0), stderr: String::new() }
    }

    #[test]
    fn keeps_only_the_newest_entries() {
        let log = CommandLog::new(2);
        for _ in 0..3 {
            let id = log.next_id();
            log.push(entry(id));
        }
        let ids: Vec<u64> = log.entries().iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![2, 3]);
    }

    // --- the request log ---
    fn request(id: u64) -> RequestLogEntry {
        RequestLogEntry { id, method: "graph".into(), params: String::new(), started_ms: 0, duration_ms: 0.0, error: None, error_message: None, commands: vec![] }
    }

    #[test]
    fn the_request_ring_keeps_only_the_newest() {
        let log = RequestLog::new(2);
        for _ in 0..3 {
            let id = log.next_id();
            log.push(request(id));
        }
        let ids: Vec<u64> = log.entries().iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![2, 3]);
    }

    #[test]
    fn a_summary_keeps_the_identifying_params() {
        assert_eq!(params_summary(r#"Graph { repo: 3, limit: None, pin: Some(Ref { name: "main" }), rescan: Some(true), active: None }"#), "repo=3 pin=Ref name=main");
        assert_eq!(params_summary(r#"FileContents { repo: 1, path: "src/a b.rs", rev: Some("abc123") }"#), r#"repo=1 path="src/a b.rs" rev=abc123"#);
        assert_eq!(params_summary(r#"ForgeMrDetail { repo: 2, remote: "origin", number: 42, refresh: true }"#), "repo=2 remote=origin number=42");
        assert_eq!(params_summary("LaunchRepo"), "");
        assert_eq!(params_summary(r#"FileList { repo: 1, spec: Wip { worktree: "/w", staged: true } }"#), "repo=1 spec=Wip worktree=/w staged=true");
    }

    #[test]
    fn a_summary_never_has_tokens_bodies_or_contents() {
        let token = format!("glpat-{}", "a".repeat(24));
        let commit = format!(r#"Commit {{ repo: 1, worktree: "/w", summary: "secret summary path: "x"", description: "body repo: 9 {token}", amend: false }}"#);
        let s = params_summary(&commit);
        assert_eq!(s, "repo=1 worktree=/w");
        let add = r#"AddForgeAccount { host: "gitlab.example.com", kind: GitLab, token: Secret(***) }"#;
        assert_eq!(params_summary(add), "host=gitlab.example.com kind=GitLab");
        let file = r#"WriteWorktreeFile { repo: 1, worktree: "/w", path: "a.txt", content: "line one\nline two" }"#;
        assert_eq!(params_summary(file), "repo=1 worktree=/w path=a.txt");
        // A whitelisted string is still redacted.
        let url = format!(r#"Clone {{ url: "https://{token}@gitlab.example.com/a.git", dest: "/d" }}"#);
        assert_eq!(params_summary(&url), r#"url=https://***@gitlab.example.com/a.git dest=/d"#);
    }

    #[test]
    fn a_summary_is_short() {
        let long = format!(r#"Blame {{ repo: 1, path: "{}" }}"#, "d/".repeat(200));
        let s = params_summary(&long);
        assert!(s.chars().count() <= SUMMARY_LIMIT + 1, "{}", s.len());
        assert!(s.starts_with("repo=1 path="));
    }

    #[test]
    fn truncates_on_char_boundary() {
        assert_eq!(truncate_utf8("héllo", 2), "h");
        assert_eq!(truncate_utf8("abc", 10), "abc");
    }
}
