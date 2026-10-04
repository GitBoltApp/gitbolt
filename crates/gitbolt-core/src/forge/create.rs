//! The Create flyout's local half (spec #4 §4 "4C"): the branch's first commit since its target
//! (the title and description prefill), the template files as the local copy of the target branch
//! has them (used when the forge can't be asked), and the template rules both providers share.
//! Reads only: `git rev-parse`, `rev-list`, `log`, `ls-tree`, `cat-file`.

use crate::error::GbError;
use crate::forge::types::{ForgeKind, ForgeProject, ForgeProjectSettings, MrTemplate};
use crate::git::{GitCli, GitInvocation};
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

/// GitLab's merge request templates: the `.md` files directly in it.
pub const GITLAB_TEMPLATE_DIR: &str = ".gitlab/merge_request_templates";
/// GitHub's: `.github/pull_request_template.md`, and the `.md` files directly in
/// `.github/pull_request_template/`. Names compare case-insensitively, as GitHub does.
pub const GITHUB_DIR: &str = ".github";
pub const GITHUB_TEMPLATE_FILE: &str = "pull_request_template.md";
pub const GITHUB_TEMPLATE_DIR: &str = "pull_request_template";
/// GitLab's `Default.md`, and the name GitHub's single template takes.
pub const DEFAULT_TEMPLATE: &str = "Default";
pub const MAX_TEMPLATES: usize = 20;
pub const MAX_TEMPLATE_BYTES: usize = 64 * 1024;

/// The prefill (ruling 5): the oldest non-merge commit on the branch's first-parent line since
/// the target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FirstCommit {
    pub summary: String,
    pub body: String,
    /// Non-merge commits on that line since the target.
    pub count: u32,
}

/// Everything the flyout shows besides what the user types (`forgeCreateContext`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateContext {
    /// The project the MR/PR goes to.
    pub project: ForgeProject,
    /// The path of the project the branch is pushed to (a fork's, for one from a fork).
    pub source_project: String,
    pub settings: ForgeProjectSettings,
    /// `Default` first, then by name.
    pub templates: Vec<MrTemplate>,
    /// The forge couldn't be asked: `templates` come from the local copy of the target branch.
    pub templates_local: bool,
    /// `None`: no commit on the branch since the target, or no local copy of the target.
    pub first_commit: Option<FirstCommit>,
}

/// `file` without a (case-insensitive) `.md`; `None` when it has none or nothing before it.
fn strip_md(file: &str) -> Option<&str> {
    let n = file.len().checked_sub(3)?;
    file.get(n..).filter(|ext| ext.eq_ignore_ascii_case(".md"))?;
    file.get(..n).filter(|stem| !stem.is_empty())
}

/// Whether `path` (repository-relative, `/`-separated) is one of `kind`'s templates.
pub fn is_template_path(kind: ForgeKind, path: &str) -> bool {
    let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
    if strip_md(file).is_none() {
        return false;
    }
    match kind {
        ForgeKind::GitLab => dir == GITLAB_TEMPLATE_DIR,
        ForgeKind::GitHub => (dir == GITHUB_DIR && file.eq_ignore_ascii_case(GITHUB_TEMPLATE_FILE)) || dir.eq_ignore_ascii_case(&format!("{GITHUB_DIR}/{GITHUB_TEMPLATE_DIR}")),
    }
}

/// What the template picker shows: the file name without `.md`; GitHub's single file is `Default`.
pub fn template_name(path: &str) -> String {
    let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
    if dir == GITHUB_DIR && file.eq_ignore_ascii_case(GITHUB_TEMPLATE_FILE) {
        return DEFAULT_TEMPLATE.to_string();
    }
    strip_md(file).unwrap_or(file).to_string()
}

/// `Default` first, then by name (case-insensitive), at most `MAX_TEMPLATES`.
pub fn sort_templates(mut list: Vec<MrTemplate>) -> Vec<MrTemplate> {
    list.sort_by_key(|t| (!t.name.eq_ignore_ascii_case(DEFAULT_TEMPLATE), t.name.to_lowercase()));
    list.truncate(MAX_TEMPLATES);
    list
}

/// A template file's text: at most `MAX_TEMPLATE_BYTES`, `\r\n` as `\n`.
pub fn clip_template(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_TEMPLATE_BYTES)]).replace("\r\n", "\n")
}

/// A commit message as the flyout's two fields: the first line, and the rest without its leading
/// blank lines (`\r\n` as `\n`, trailing whitespace dropped).
pub fn split_message(message: &str) -> (String, String) {
    let text = message.replace("\r\n", "\n");
    let text = text.trim_end();
    let Some((summary, mut body)) = text.split_once('\n') else { return (text.to_string(), String::new()) };
    while let Some((line, rest)) = body.split_once('\n') {
        if !line.trim().is_empty() {
            break;
        }
        body = rest;
    }
    let body = if body.trim().is_empty() { "" } else { body };
    (summary.trim_end().to_string(), body.to_string())
}

/// The first of `revs` that names a commit here.
async fn first_existing(cli: &GitCli, root: &Path, revs: &[String]) -> Result<Option<String>, GbError> {
    for rev in revs {
        let spec = format!("{rev}^{{commit}}");
        let out = cli.run(GitInvocation::new(root, ["rev-parse", "--verify", "-q", spec.as_str()]).ok_exit(1)).await?;
        if !String::from_utf8_lossy(&out.stdout).trim().is_empty() {
            return Ok(Some(rev.clone()));
        }
    }
    Ok(None)
}

/// `branch`'s first commit since the first of `bases` that exists (ruling 5).
pub async fn first_commit(cli: &GitCli, root: &Path, branch: &str, bases: &[String]) -> Result<Option<FirstCommit>, GbError> {
    let Some(base) = first_existing(cli, root, bases).await? else { return Ok(None) };
    let span = format!("{base}..refs/heads/{branch}");
    let flags = ["--first-parent", "--no-merges"];
    let count = cli.run(GitInvocation::new(root, ["rev-list", "--count"].into_iter().chain(flags).chain([span.as_str(), "--"]))).await?;
    let count: u32 = String::from_utf8_lossy(&count.stdout).trim().parse().unwrap_or(0);
    if count == 0 {
        return Ok(None);
    }
    // The oldest is the last of the newest-first list: skip all but one.
    let skip = (count - 1).to_string();
    let out = cli.run(GitInvocation::new(root, ["rev-list", "--skip", skip.as_str(), "-1"].into_iter().chain(flags).chain([span.as_str(), "--"]))).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(first) = text.lines().map(str::trim).find(|l| !l.is_empty()) else { return Ok(None) };
    let msg = cli.run(GitInvocation::new(root, ["log", "-1", "--no-show-signature", "--format=%B", first, "--"])).await?;
    let (summary, body) = split_message(&String::from_utf8_lossy(&msg.stdout));
    Ok(Some(FirstCommit { summary, body, count }))
}

/// `kind`'s templates in the first of `revs` that exists (ruling 7: the local copy of the
/// target branch, never the working directory).
pub async fn local_templates(cli: &GitCli, root: &Path, kind: ForgeKind, revs: &[String]) -> Result<Vec<MrTemplate>, GbError> {
    let Some(rev) = first_existing(cli, root, revs).await? else { return Ok(Vec::new()) };
    // Only regular files count: a symlink or submodule named `Foo.md` is skipped.
    let mut dirs = vec![match kind {
        ForgeKind::GitLab => format!("{GITLAB_TEMPLATE_DIR}/"),
        ForgeKind::GitHub => format!("{GITHUB_DIR}/"),
    }];
    let mut paths: Vec<String> = Vec::new();
    while let Some(dir) = dirs.pop() {
        let out = cli.run(GitInvocation::new(root, ["ls-tree", "-z", rev.as_str(), "--", dir.as_str()])).await?;
        for rec in out.stdout.split(|b| *b == 0).filter_map(|r| std::str::from_utf8(r).ok()) {
            let Some((meta, path)) = rec.split_once('\t') else { continue };
            let mode = meta.split(' ').next().unwrap_or("");
            if mode == "040000" && kind == ForgeKind::GitHub && dir == format!("{GITHUB_DIR}/") && path.eq_ignore_ascii_case(&format!("{GITHUB_DIR}/{GITHUB_TEMPLATE_DIR}")) {
                dirs.push(format!("{path}/"));
            } else if (mode == "100644" || mode == "100755") && is_template_path(kind, path) && paths.len() < MAX_TEMPLATES {
                paths.push(path.to_string());
            }
        }
    }
    let mut list = Vec::with_capacity(paths.len());
    for path in paths {
        let spec = format!("{rev}:{path}");
        let Ok(blob) = cli.run(GitInvocation::new(root, ["cat-file", "blob", spec.as_str()]).stdout_limit(MAX_TEMPLATE_BYTES as u64)).await else { continue };
        list.push(MrTemplate { name: template_name(&path), body: clip_template(&blob.stdout), path });
    }
    Ok(sort_templates(list))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use std::sync::Arc;

    fn cli() -> GitCli {
        GitCli::new(Arc::new(CommandLog::new(100))).with_env(isolated_git_env())
    }

    fn tpl(name: &str) -> MrTemplate {
        MrTemplate { name: name.into(), path: format!("x/{name}.md"), body: String::new() }
    }

    #[test]
    fn template_paths_follow_each_forge() {
        assert!(is_template_path(ForgeKind::GitLab, ".gitlab/merge_request_templates/Bug.md"));
        assert!(is_template_path(ForgeKind::GitLab, ".gitlab/merge_request_templates/Bug.MD"));
        assert!(!is_template_path(ForgeKind::GitLab, ".gitlab/merge_request_templates/sub/Bug.md"));
        assert!(!is_template_path(ForgeKind::GitLab, ".gitlab/merge_request_templates/notes.txt"));
        assert!(!is_template_path(ForgeKind::GitLab, ".gitlab/merge_request_templates/.md"));
        assert!(!is_template_path(ForgeKind::GitLab, ".gitlab/issue_templates/Bug.md"));
        assert!(is_template_path(ForgeKind::GitHub, ".github/pull_request_template.md"));
        assert!(is_template_path(ForgeKind::GitHub, ".github/PULL_REQUEST_TEMPLATE.md"));
        assert!(is_template_path(ForgeKind::GitHub, ".github/PULL_REQUEST_TEMPLATE/feature.md"));
        assert!(!is_template_path(ForgeKind::GitHub, ".github/PULL_REQUEST_TEMPLATE/a/b.md"));
        assert!(!is_template_path(ForgeKind::GitHub, ".github/workflows/ci.yml"));
        assert!(!is_template_path(ForgeKind::GitHub, "docs/pull_request_template.md"));
    }

    #[test]
    fn names_drop_md_and_githubs_single_file_is_default() {
        assert_eq!(template_name(".github/PULL_REQUEST_TEMPLATE.md"), "Default");
        assert_eq!(template_name(".github/pull_request_template/feature.md"), "feature");
        assert_eq!(template_name(".gitlab/merge_request_templates/Bug Fix.MD"), "Bug Fix");
        assert_eq!(template_name(".gitlab/merge_request_templates/é.md"), "é");
    }

    #[test]
    fn default_sorts_first_then_names_and_the_list_is_capped() {
        let names = |l: Vec<MrTemplate>| l.into_iter().map(|t| t.name).collect::<Vec<_>>();
        assert_eq!(names(sort_templates(vec![tpl("bug"), tpl("Default"), tpl("Alpha")])), ["Default", "Alpha", "bug"]);
        let many: Vec<MrTemplate> = (0..30).map(|i| tpl(&format!("t{i:02}"))).collect();
        assert_eq!(sort_templates(many).len(), MAX_TEMPLATES);
    }

    #[test]
    fn a_message_splits_into_title_and_body() {
        assert_eq!(split_message("Add login\r\n\r\n\r\nWhy.\n\n  - indented\n\n"), ("Add login".into(), "Why.\n\n  - indented".into()));
        assert_eq!(split_message("One line\n"), ("One line".into(), String::new()));
        assert_eq!(split_message("Title\n\n   \n"), ("Title".into(), String::new()));
        assert_eq!(clip_template(b"## Why\r\n"), "## Why\n");
        assert_eq!(clip_template(&vec![b'a'; MAX_TEMPLATE_BYTES + 10]).len(), MAX_TEMPLATE_BYTES);
    }

    /// main pushed as origin/main; feature: "Add login" (with a body), a merge of `side`, "Fix typo".
    fn branched() -> TestRepo {
        let r = TestRepo::new();
        r.commit("one");
        r.git(&["update-ref", "refs/remotes/origin/main", "main"]);
        r.switch_new("side");
        r.commit("Side work");
        r.switch("main");
        r.switch_new("feature");
        r.commit("Add login\n\nWhy it matters.");
        r.merge("side", "Merge side");
        r.commit("Fix typo");
        r
    }

    #[tokio::test]
    async fn the_first_commit_is_the_oldest_on_the_first_parent_line_without_merges() {
        let r = branched();
        let bases = ["refs/remotes/origin/main".to_string(), "refs/heads/main".to_string()];
        let first = first_commit(&cli(), r.path(), "feature", &bases).await.unwrap().unwrap();
        assert_eq!(first, FirstCommit { summary: "Add login".into(), body: "Why it matters.".into(), count: 2 });
        let fallback = ["refs/remotes/origin/nope".to_string(), "refs/heads/main".to_string()];
        assert_eq!(first_commit(&cli(), r.path(), "feature", &fallback).await.unwrap().unwrap().summary, "Add login");
        assert_eq!(first_commit(&cli(), r.path(), "feature", &["refs/heads/nope".to_string()]).await.unwrap(), None, "no local copy of the target");
        assert_eq!(first_commit(&cli(), r.path(), "main", &bases).await.unwrap(), None, "nothing since the target");
    }

    #[tokio::test]
    async fn local_templates_read_the_targets_committed_tree_not_the_working_directory() {
        let r = TestRepo::new();
        r.write(".gitlab/merge_request_templates/Default.md", "## Why\r\n");
        r.write(".gitlab/merge_request_templates/Bug.md", "## Bug\n");
        r.write(".gitlab/merge_request_templates/notes.txt", "x\n");
        std::os::unix::fs::symlink("Bug.md", r.path().join(".gitlab/merge_request_templates/Link.md")).unwrap();
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "templates"]);
        r.git(&["update-ref", "refs/remotes/origin/main", "main"]);
        r.write(".gitlab/merge_request_templates/Default.md", "uncommitted\n");
        let revs = ["refs/remotes/origin/main".to_string(), "refs/heads/main".to_string(), "HEAD".to_string()];
        let list = local_templates(&cli(), r.path(), ForgeKind::GitLab, &revs).await.unwrap();
        assert_eq!(list.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["Default", "Bug"]);
        assert_eq!(list[0].body, "## Why\n");
        assert_eq!(list[0].path, ".gitlab/merge_request_templates/Default.md");
        assert!(local_templates(&cli(), r.path(), ForgeKind::GitHub, &revs).await.unwrap().is_empty());
        assert!(local_templates(&cli(), r.path(), ForgeKind::GitLab, &["refs/heads/nope".to_string()]).await.unwrap().is_empty());
    }

    #[test]
    fn the_context_serializes_as_the_ui_reads_it() {
        let v = serde_json::to_value(FirstCommit { summary: "s".into(), body: "b".into(), count: 1 }).unwrap();
        assert_eq!(v, serde_json::json!({"summary": "s", "body": "b", "count": 1}));
    }
}
