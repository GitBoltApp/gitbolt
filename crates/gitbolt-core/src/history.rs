//! File History and Blame (spec #3 §3.10): read-only `git log --follow` and `git blame`. Neither
//! writes to the repository (the never-write audit dispatches both).

use crate::api::Api;
use crate::blob::check_relative;
use crate::error::{GbError, GbErrorKind};
use crate::git::GitInvocation;
use serde::Serialize;
use std::collections::HashMap;
use ts_rs::TS;

/// The most rows one page may ask for (the UI asks for 200).
pub const HISTORY_PAGE_MAX: u32 = 1000;
/// One record per commit: a record separator, then NUL-separated fields.
const LOG_FORMAT: &str = "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%s";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileHistoryRow {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    #[ts(type = "number")]
    pub time: i64,
    pub summary: String,
    /// The file's path at this commit (a rename's new path).
    pub path: String,
    /// `A`, `M`, `D`, `R`, `C` or `T`; empty for a commit that shows no change of its own (a merge).
    pub status: String,
    /// A rename's or copy's source: the file's path in the commits below this one.
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileHistoryPage {
    pub rows: Vec<FileHistoryRow>,
    /// More rows follow these.
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlameHunk {
    pub sha: String,
    /// The first line (1-based) in the file at the blamed commit.
    pub start: u32,
    pub lines: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlameCommit {
    pub sha: String,
    pub author: String,
    pub email: String,
    #[ts(type = "number")]
    pub time: i64,
    pub summary: String,
    /// `git blame` stopped here (the history's root, or a shallow clone's edge).
    pub boundary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlamePayload {
    pub hunks: Vec<BlameHunk>,
    pub commits: Vec<BlameCommit>,
}

fn option_like(rev: &str) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, format!("not a revision: {rev}"))
}

/// One page of `path`'s history from `rev` (the worktree's HEAD when `None`), newest first
/// (spec #3 §3.10). `-M` so a user's `diff.renames=false` can't hide the rename the paths follow;
/// literal pathspecs so `[`, `*` or `:` in a name are just characters (Review Focus 4).
pub(crate) async fn file_history(api: &Api, repo: u32, worktree: &str, path: String, rev: Option<String>, skip: u32, limit: u32) -> Result<FileHistoryPage, GbError> {
    check_relative(&path)?;
    let rev = rev.unwrap_or_else(|| "HEAD".into());
    if rev.starts_with('-') {
        return Err(option_like(&rev));
    }
    let limit = limit.clamp(1, HISTORY_PAGE_MAX) as usize;
    let skip = skip as usize;
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    // Ruling 2: `--skip` loses `--follow`'s rename, so ask for the rows up to this page's end and
    // one more (it says whether there's more), and cut the page here.
    let n = format!("-n{}", skip + limit + 1);
    let args = ["log", "--no-show-signature", "--follow", "-M", "--name-status", "-z", LOG_FORMAT, n.as_str(), "--end-of-options", rev.as_str(), "--", path.as_str()];
    let out = api.cli.run(GitInvocation::new(&root, args).env("GIT_LITERAL_PATHSPECS", "1")).await?;
    let mut rows = parse_follow_log(&out.stdout, &path);
    let more = rows.len() > skip + limit;
    rows.truncate(skip + limit);
    let rows = rows.split_off(skip.min(rows.len()));
    Ok(FileHistoryPage { rows, more })
}

/// `LOG_FORMAT` records with `--name-status -z`: after the fields (and git's `\n`), the followed
/// file's `<status>\0<path>\0`, or `<R|C><score>\0<old>\0<new>\0`; a merge has none. `path` is
/// the file's path where the walk starts, carried down to records with no change of their own.
pub(crate) fn parse_follow_log(out: &[u8], path: &str) -> Vec<FileHistoryRow> {
    let text = String::from_utf8_lossy(out);
    let mut cur = path.to_string();
    let mut rows = Vec::new();
    for rec in text.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let mut f = rec.split('\0');
        let (Some(sha), Some(parents), Some(author), Some(email), Some(time), Some(summary)) = (f.next(), f.next(), f.next(), f.next(), f.next(), f.next()) else {
            continue;
        };
        let change: Vec<&str> = f.map(|s| s.trim_start_matches('\n')).filter(|s| !s.is_empty()).collect();
        let (status, here, old_path) = match change.as_slice() {
            [st, old, new, ..] if st.starts_with('R') || st.starts_with('C') => (st[..1].to_string(), new.to_string(), Some(old.to_string())),
            [st, p, ..] => (st[..1].to_string(), p.to_string(), None),
            _ => (String::new(), cur.clone(), None),
        };
        cur = old_path.clone().unwrap_or_else(|| here.clone());
        rows.push(FileHistoryRow {
            sha: sha.to_string(),
            parents: parents.split(' ').filter(|p| !p.is_empty()).map(String::from).collect(),
            author: author.to_string(),
            email: email.to_string(),
            time: time.parse().unwrap_or(0),
            summary: summary.to_string(),
            path: here,
            status,
            old_path,
        });
    }
    rows
}

/// `path` at `rev`, line by line (spec #3 §3.10). The UI caches it per (rev, path).
pub(crate) async fn blame(api: &Api, repo: u32, worktree: &str, rev: String, path: String) -> Result<BlamePayload, GbError> {
    check_relative(&path)?;
    if rev.starts_with('-') {
        return Err(option_like(&rev));
    }
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let out = api.cli.run(GitInvocation::new(&root, ["blame", "--porcelain", rev.as_str(), "--", path.as_str()])).await?;
    Ok(parse_blame(&out.stdout))
}

/// `git blame --porcelain`: a header `<sha> <orig> <final> <count>` opens each group (`<count>`
/// only on a group's first line), followed by `key value` lines the first time a commit is seen,
/// and a TAB-prefixed content line per line.
pub(crate) fn parse_blame(out: &[u8]) -> BlamePayload {
    let text = String::from_utf8_lossy(out);
    let (mut hunks, mut commits) = (Vec::new(), Vec::<BlameCommit>::new());
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut current: Option<usize> = None;
    for line in text.split('\n') {
        if line.starts_with('\t') {
            continue;
        }
        let mut parts = line.split(' ');
        let first = parts.next().unwrap_or("");
        if (first.len() == 40 || first.len() == 64) && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            let nums: Vec<u32> = parts.filter_map(|p| p.parse().ok()).collect();
            let ci = *index.entry(first.to_string()).or_insert_with(|| {
                commits.push(BlameCommit { sha: first.to_string(), ..BlameCommit::default() });
                commits.len() - 1
            });
            current = Some(ci);
            if let (Some(&start), Some(&lines)) = (nums.get(1), nums.get(2)) {
                hunks.push(BlameHunk { sha: first.to_string(), start, lines });
            }
            continue;
        }
        let Some(ci) = current else { continue };
        let c = &mut commits[ci];
        if line == "boundary" {
            c.boundary = true;
            continue;
        }
        match line.split_once(' ') {
            Some(("author", v)) => c.author = v.to_string(),
            Some(("author-mail", v)) => c.email = v.trim_start_matches('<').trim_end_matches('>').to_string(),
            Some(("author-time", v)) => c.time = v.parse().unwrap_or(0),
            Some(("summary", v)) => c.summary = v.to_string(),
            _ => {}
        }
    }
    BlamePayload { hunks, commits }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::write::{open, send, wt, WriteEnv};
    use crate::testing::{fixtures, TestRepo};
    use serde_json::{json, Value};

    async fn page(env: &WriteEnv, id: u32, r: &TestRepo, path: &str, rev: Option<&str>, skip: u32, limit: u32) -> Value {
        send(&env.api, json!({"method": "fileHistory", "params": {"repo": id, "worktree": wt(r), "path": path, "rev": rev, "skip": skip, "limit": limit}})).await.unwrap()
    }
    fn col(p: &Value, field: &str) -> Vec<String> {
        p["rows"].as_array().unwrap().iter().map(|r| r[field].as_str().unwrap_or("").to_string()).collect()
    }
    fn sha_of(r: &TestRepo, subject: &str) -> String {
        r.git(&["log", "--all", "--format=%H", "-F", &format!("--grep={subject}"), "-1"])
    }

    #[tokio::test]
    async fn history_follows_the_rename_with_each_rows_path() {
        let r = TestRepo::new();
        fixtures::file_history(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let p = page(&env, id, &r, "src/story.txt", None, 0, 200).await;
        assert_eq!(col(&p, "summary"), ["Sharpen the opening", "Move the story under src", "Add the middle", "Start the story"]);
        assert_eq!(col(&p, "path"), ["src/story.txt", "src/story.txt", "story.txt", "story.txt"]);
        assert_eq!(col(&p, "status"), ["M", "R", "M", "A"]);
        assert_eq!(p["rows"][1]["oldPath"], "story.txt");
        assert_eq!(p["rows"][0]["author"], "Ada Lovelace");
        assert_eq!(p["rows"][0]["email"], "ada@example.com");
        assert_eq!(p["rows"][2]["parents"].as_array().unwrap().len(), 1);
        assert_eq!(p["more"], false);
    }

    /// Ruling 2: git's `--skip` drops `--follow`'s rename; pages are cut here instead.
    #[tokio::test]
    async fn pages_cross_the_rename_and_say_when_theres_more() {
        let r = TestRepo::new();
        fixtures::file_history(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let a = page(&env, id, &r, "src/story.txt", None, 0, 2).await;
        assert_eq!(col(&a, "summary"), ["Sharpen the opening", "Move the story under src"]);
        assert_eq!(a["more"], true);
        let b = page(&env, id, &r, "src/story.txt", None, 2, 2).await;
        assert_eq!(col(&b, "summary"), ["Add the middle", "Start the story"]);
        assert_eq!(col(&b, "path"), ["story.txt", "story.txt"]);
        assert_eq!(b["more"], false);
        let c = page(&env, id, &r, "src/story.txt", None, 9, 2).await;
        assert_eq!(c["rows"].as_array().unwrap().len(), 0);
        assert_eq!(c["more"], false);
    }

    #[tokio::test]
    async fn rev_starts_the_walk_at_that_commit() {
        let r = TestRepo::new();
        fixtures::file_history(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let middle = sha_of(&r, "Add the middle");
        let p = page(&env, id, &r, "story.txt", Some(&middle), 0, 200).await;
        assert_eq!(col(&p, "summary"), ["Add the middle", "Start the story"]);
    }

    /// Review Focus 4: `[draft]` is a glob class that would also match `notes d.txt`.
    #[tokio::test]
    async fn a_path_with_glob_characters_is_taken_literally() {
        let r = TestRepo::new();
        r.write("notes [draft].txt", "1\n");
        r.commit_all_as("Draft one", "Ada Lovelace", "ada@example.com");
        r.write("notes d.txt", "d\n");
        r.commit_all_as("Other notes", "Ada Lovelace", "ada@example.com");
        r.write("notes [draft].txt", "2\n");
        r.commit_all_as("Draft two", "Ada Lovelace", "ada@example.com");
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let p = page(&env, id, &r, "notes [draft].txt", None, 0, 200).await;
        assert_eq!(col(&p, "summary"), ["Draft two", "Draft one"]);
        let head = r.git(&["rev-parse", "HEAD"]);
        let b = send(&env.api, json!({"method": "blame", "params": {"repo": id, "worktree": wt(&r), "rev": head, "path": "notes [draft].txt"}})).await.unwrap();
        assert_eq!(b["hunks"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_rev_or_path_that_looks_like_an_option_is_refused() {
        let r = TestRepo::new();
        fixtures::file_history(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let e = send(&env.api, json!({"method": "fileHistory", "params": {"repo": id, "worktree": wt(&r), "path": "src/story.txt", "rev": "--all", "skip": 0, "limit": 5}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
        let e = send(&env.api, json!({"method": "blame", "params": {"repo": id, "worktree": wt(&r), "rev": "HEAD", "path": "../x"}})).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
    }

    /// Spec #3 §3.10: each line group carries its commit; hunks are in file order.
    #[tokio::test]
    async fn blame_groups_lines_by_commit_with_their_authors() {
        let r = TestRepo::new();
        fixtures::file_history(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let b = send(&env.api, json!({"method": "blame", "params": {"repo": id, "worktree": wt(&r), "rev": head, "path": "src/story.txt"}})).await.unwrap();
        let summary = |sha: &str| b["commits"].as_array().unwrap().iter().find(|c| c["sha"] == sha).unwrap()["summary"].as_str().unwrap().to_string();
        let hunks: Vec<(String, u64, u64)> = b["hunks"].as_array().unwrap().iter().map(|h| (summary(h["sha"].as_str().unwrap()), h["start"].as_u64().unwrap(), h["lines"].as_u64().unwrap())).collect();
        let s = |x: &str| x.to_string();
        assert_eq!(hunks, [(s("Sharpen the opening"), 1, 1), (s("Start the story"), 2, 1), (s("Add the middle"), 3, 2), (s("Start the story"), 5, 1), (s("Move the story under src"), 6, 1), (s("Start the story"), 7, 2)]);
        assert_eq!(b["commits"].as_array().unwrap().len(), 4);
        let start = b["commits"].as_array().unwrap().iter().find(|c| c["summary"] == "Start the story").unwrap();
        assert_eq!(start["author"], "Ada Lovelace");
        assert_eq!(start["email"], "ada@example.com");
        assert!(start["time"].as_i64().unwrap() > 0);
    }

    /// Review Focus 1: an older commit is blamed at its own path.
    #[tokio::test]
    async fn blame_at_an_older_commit_reads_its_path() {
        let r = TestRepo::new();
        fixtures::file_history(&r);
        let env = WriteEnv::new();
        let id = open(&env.api, &r).await;
        let middle = sha_of(&r, "Add the middle");
        let b = send(&env.api, json!({"method": "blame", "params": {"repo": id, "worktree": wt(&r), "rev": middle, "path": "story.txt"}})).await.unwrap();
        let spans: Vec<(u64, u64)> = b["hunks"].as_array().unwrap().iter().map(|h| (h["start"].as_u64().unwrap(), h["lines"].as_u64().unwrap())).collect();
        assert_eq!(spans, [(1, 2), (3, 2), (5, 4)]);
    }

    /// A merge shows no change of its own: its row keeps the path of the rows above it.
    #[test]
    fn a_record_without_a_change_keeps_the_current_path() {
        let out = b"\x1em1\0p1 p2\0Ada\0a@x\x001\0Merge\0\x1ec1\0p1\0Ada\0a@x\x002\0Edit\0\nM\0f.txt\0\x1ec0\0\0Ada\0a@x\x003\0Add\0\nR100\0old.txt\0f.txt\0";
        let rows = parse_follow_log(out, "f.txt");
        assert_eq!(rows.iter().map(|r| (r.path.as_str(), r.status.as_str())).collect::<Vec<_>>(), [("f.txt", ""), ("f.txt", "M"), ("f.txt", "R")]);
        assert_eq!(rows[0].parents, ["p1", "p2"]);
        assert!(rows[2].parents.is_empty());
        assert_eq!(rows[2].old_path.as_deref(), Some("old.txt"));
    }
}
