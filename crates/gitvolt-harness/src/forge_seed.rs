//! `forge.json` v1 (website demo plan 4): a fixture's fake GitLab, in the harness fake forge's own
//! seed format (`GitLabSeed`) without tokens. The website demo serves it in the page; `just
//! demo-golden` seeds the harness's fake forge with it, and adds the visitor's account, to record
//! the core's answers. Shared by Orbital and `forge_lab`.

use crate::fake_forge::gitlab_mrs::FakeDiff;
use crate::fake_forge::{FakeProject, FakeUser, GitLabSeed, GITLAB_HOST};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FORGE_JSON: &str = "forge.json";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeFile {
    pub version: u32,
    pub host: String,
    /// The project the fixture's `origin` is (`group/name`).
    pub project: String,
    /// The visitor's username.
    pub me: String,
    pub gitlab: GitLabSeed,
}

pub fn me() -> FakeUser {
    FakeUser { id: 100, username: "you".into(), name: "You".into(), email: Some("you@example.com".into()), avatar_url: None }
}

pub fn forge_url(project: &str) -> String {
    format!("https://{GITLAB_HOST}/{project}.git")
}

pub fn project(id: u64, path: &str, updated_at: &str) -> FakeProject {
    FakeProject {
        id,
        path: path.into(),
        default_branch: Some("main".into()),
        http_url: Some(forge_url(path)),
        ssh_url: Some(format!("git@{GITLAB_HOST}:{path}.git")),
        updated_at: updated_at.into(),
        ..Default::default()
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git").current_dir(dir).args(args).envs(gitvolt_core::testing::isolated_git_env()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("git {args:?}: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// GitLab's `diffs` of `base..head`: one per file, each from its first `@@` line (empty for a pure
/// rename), renames found as `git diff -M` finds them.
pub fn diffs(repo: &Path, base: &str, head: &str) -> Result<Vec<FakeDiff>, String> {
    let text = git(repo, &["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", "-U3", base, head])?;
    let mut out: Vec<FakeDiff> = Vec::new();
    for chunk in text.split("\ndiff --git ").map(|c| c.strip_prefix("diff --git ").unwrap_or(c)) {
        if chunk.trim().is_empty() {
            continue;
        }
        let header = chunk.lines().next().unwrap_or_default();
        let (old, new) = header.split_once(" b/").map(|(a, b)| (a.trim_start_matches("a/").to_string(), b.to_string())).ok_or("a diff header")?;
        let old = chunk.lines().find_map(|l| l.strip_prefix("rename from ")).map(str::to_string).unwrap_or(old);
        let new = chunk.lines().find_map(|l| l.strip_prefix("rename to ")).map(str::to_string).unwrap_or(new);
        let diff = chunk.find("\n@@").map(|i| chunk[i + 1..].to_string()).unwrap_or_default();
        let diff = if diff.is_empty() || diff.ends_with('\n') { diff } else { format!("{diff}\n") };
        out.push(FakeDiff { old_path: old, new_path: new, diff });
    }
    Ok(out)
}

/// The new-side line number of the first added line equal to `text` in `path`'s diff.
pub fn added_line(diffs: &[FakeDiff], path: &str, text: &str) -> Option<u32> {
    added_line_where(diffs, path, |l| l == text)
}

/// The new-side line number of the first added line in `path`'s diff that `pick` takes.
pub fn added_line_where(diffs: &[FakeDiff], path: &str, pick: impl Fn(&str) -> bool) -> Option<u32> {
    let d = diffs.iter().find(|d| d.new_path == path)?;
    let mut new = 0u32;
    for line in d.diff.lines() {
        if let Some(h) = line.strip_prefix("@@ ") {
            new = h.split_whitespace().nth(1)?.trim_start_matches('+').split(',').next()?.parse().ok()?;
            continue;
        }
        match line.chars().next() {
            Some('+') if pick(&line[1..]) => return Some(new),
            Some('+') | Some(' ') => new += 1,
            _ => {}
        }
    }
    None
}

pub fn write(root: &Path, f: &ForgeFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(f).map_err(|e| e.to_string())? + "\n";
    std::fs::write(root.join(FORGE_JSON), text).map_err(|e| e.to_string())
}

/// `root`'s `forge.json`: `None` without one, an error naming what's wrong with one that isn't v1.
pub fn load(root: &Path) -> Result<Option<ForgeFile>, String> {
    let path = root.join(FORGE_JSON);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(None) };
    let doc: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: unparsable: {e}", path.display()))?;
    match doc.get("version").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(VERSION) => serde_json::from_value(doc).map(Some).map_err(|e| format!("{}: unparsable as v{VERSION}: {e}", path.display())),
        v => Err(format!("{}: version {}, expected {VERSION}", path.display(), v.map_or("missing".to_string(), |v| v.to_string()))),
    }
}

pub fn read(root: &Path) -> Option<ForgeFile> {
    load(root).ok().flatten()
}
