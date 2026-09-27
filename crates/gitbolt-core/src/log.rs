//! In-memory ring buffer of every git invocation (the Debug → Command log view).

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
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

    /// Oldest first.
    pub fn entries(&self) -> Vec<CommandLogEntry> {
        self.inner.lock().expect("command log poisoned").iter().cloned().collect()
    }
}

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

    #[test]
    fn truncates_on_char_boundary() {
        assert_eq!(truncate_utf8("héllo", 2), "h");
        assert_eq!(truncate_utf8("abc", 10), "abc");
    }
}
