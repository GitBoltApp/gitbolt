//! Reads `logs/<ref>` files directly (format: `<old> <new> <name> <<email>> <time> <tz>\t<message>`).

use gix::ObjectId;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReflogEntry {
    pub old: ObjectId,
    pub new: ObjectId,
    pub time: i64,
    pub message: String,
}

/// Newest first. A missing reflog is an empty list.
pub fn read_reflog(common_dir: &Path, full_ref: &str) -> std::io::Result<Vec<ReflogEntry>> {
    let path = common_dir.join("logs").join(full_ref);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut out: Vec<ReflogEntry> = text.lines().filter_map(parse_line).collect();
    out.reverse();
    Ok(out)
}

fn parse_line(line: &str) -> Option<ReflogEntry> {
    let (head, message) = line.split_once('\t').unwrap_or((line, ""));
    let mut it = head.split(' ');
    let old = ObjectId::from_hex(it.next()?.as_bytes()).ok()?;
    let new = ObjectId::from_hex(it.next()?.as_bytes()).ok()?;
    let mut tail = head.rsplit(' ');
    let _tz = tail.next()?;
    let time = tail.next()?.parse().ok()?;
    Some(ReflogEntry { old, new, time, message: message.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_newest_first_and_names_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs/refs");
        std::fs::create_dir_all(&logs).unwrap();
        let a = "1".repeat(40);
        let b = "2".repeat(40);
        let c = "3".repeat(40);
        std::fs::write(
            logs.join("stash"),
            format!("{a} {b} Ada Q Lovelace <ada@example.com> 1700000000 +0000\tOn main: one\n{b} {c} Ada <ada@example.com> 1700000060 -0500\tOn main: two\n"),
        )
        .unwrap();
        let entries = read_reflog(dir.path(), "refs/stash").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "On main: two");
        assert_eq!(entries[0].time, 1_700_000_060);
        assert_eq!(entries[1].new.to_string(), b);
    }

    #[test]
    fn missing_reflog_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_reflog(dir.path(), "refs/stash").unwrap().is_empty());
    }
}
