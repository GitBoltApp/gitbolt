//! Stacked merge requests (spec #4 §4 "4D"). A stack's MRs/PRs each target the branch below.
//! Where the forge has no native stacks (everything but GitLab ≥ 19.1), each open one carries a
//! marker-fenced Stack table that GitBolt rewrites; the text outside the markers is never touched
//! (Rulings 2–4).

use crate::forge::{ForgeKind, ForgeMr, MrState};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MARK_START: &str = "<!-- gitbolt-stack:start -->";
pub const MARK_END: &str = "<!-- gitbolt-stack:end -->";

/// A description/body with GitBolt's Stack table in it (`ForgeMr::stacked`).
pub fn carries_stack_table(description: &str) -> bool {
    // A whole block (a start marker with an end marker after it), as the splice reads one: a stray
    // start marker quoted in a description isn't a table.
    description.find(MARK_START).is_some_and(|s| description[s + MARK_START.len()..].contains(MARK_END))
}

/// `Native`: the forge links the chain itself (GitLab ≥ 19.1) and GitBolt writes no table.
/// `Managed`: GitBolt keeps the table in each open MR/PR's description.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StackMode {
    Native,
    Managed,
}

/// A new MR/PR's title and description, from its branch's first commit (Ruling 6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MrPrefill {
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StackMember {
    pub branch: String,
    /// What its MR/PR should target: the branch below, or the base for the bottom one.
    pub target_branch: String,
    /// Its newest MR/PR, in any state.
    pub mr: Option<ForgeMr>,
    /// Set when it has no MR/PR, or only a closed one (Ruling 7).
    pub prefill: Option<MrPrefill>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StackView {
    /// The remote whose project the MRs/PRs live in (spec #4 §3.3's target).
    pub remote: String,
    /// That project's path.
    pub project: String,
    pub kind: ForgeKind,
    pub mode: StackMode,
    /// Bottom → top.
    pub members: Vec<StackMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StackEditFailure {
    #[ts(type = "number")]
    pub number: u64,
    pub message: String,
}

/// What a table sync did, per MR/PR number (spec #4 §3.5: partial failures are explicit).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StackSync {
    #[ts(type = "Array<number>")]
    pub edited: Vec<u64>,
    #[ts(type = "Array<number>")]
    pub unchanged: Vec<u64>,
    pub failed: Vec<StackEditFailure>,
}

/// One row of the table.
pub struct TableRow<'a> {
    pub number: u64,
    pub title: &'a str,
    pub state: MrState,
}

/// `!12` (GitLab) / `#12` (GitHub): the UI's `mrRef`.
pub fn mr_ref(kind: ForgeKind, number: u64) -> String {
    match kind {
        ForgeKind::GitLab => format!("!{number}"),
        ForgeKind::GitHub => format!("#{number}"),
    }
}

fn state_word(s: MrState) -> &'static str {
    match s {
        MrState::Open => "Open",
        MrState::Draft => "Draft",
        MrState::Merged => "Merged",
        MrState::Closed => "Closed",
    }
}

/// Ruling 4: one line; Markdown's table and emphasis characters escaped; `<` and `>` as entities,
/// so no title can close the block or open another.
fn escape_cell(title: &str) -> String {
    let one_line = title.split(['\r', '\n']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let mut out = String::with_capacity(one_line.len() + 8);
    for c in one_line.chars() {
        match c {
            '\\' | '|' | '*' | '_' | '`' | '[' | ']' => {
                out.push('\\');
                out.push(c);
            }
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// The description's line ending: CRLF when it has one (GitHub's web editor), else LF.
pub fn eol_of(description: &str) -> &'static str {
    if description.contains("\r\n") { "\r\n" } else { "\n" }
}

/// The marker-fenced Stack table (spec #4 §4 "4D"): bottom → top, `current`'s row in bold.
pub fn render_block(kind: ForgeKind, rows: &[TableRow<'_>], current: u64, eol: &str) -> String {
    let noun = match kind {
        ForgeKind::GitLab => "MR",
        ForgeKind::GitHub => "PR",
    };
    let mut lines = vec![
        MARK_START.to_string(),
        "**Stack** (kept up to date by GitBolt)".to_string(),
        String::new(),
        format!("| # | {noun} | Title | State |"),
        "|---|---|---|---|".to_string(),
    ];
    for (i, r) in rows.iter().enumerate() {
        let cells = [(i + 1).to_string(), mr_ref(kind, r.number), escape_cell(r.title), state_word(r.state).to_string()];
        let cells: Vec<String> = if r.number == current {
            cells.iter().map(|c| if c.is_empty() { String::new() } else { format!("**{c}**") }).collect()
        } else {
            cells.to_vec()
        };
        lines.push(format!("| {} |", cells.join(" | ")));
    }
    lines.push(MARK_END.to_string());
    lines.join(eol)
}

/// `description` with `block` in place of its first complete block (Ruling 3): a block is an end
/// marker and the last start marker before it; later complete blocks are GitBolt's and go;
/// dangling markers are text. Without a block, `block` is appended after a blank line. Every
/// byte outside the markers is kept, so splicing twice gives the same text.
pub fn splice_block(description: &str, block: &str) -> String {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut from = 0;
    while let Some(e) = description[from..].find(MARK_END).map(|i| i + from) {
        let end = e + MARK_END.len();
        if let Some(s) = description[from..e].rfind(MARK_START).map(|i| i + from) {
            spans.push((s, end));
        }
        from = end;
    }
    let Some(&(first_start, first_end)) = spans.first() else {
        if description.is_empty() {
            return block.to_string();
        }
        let eol = eol_of(description);
        let sep = if description.ends_with('\n') { eol.to_string() } else { format!("{eol}{eol}") };
        return format!("{description}{sep}{block}");
    };
    let mut out = String::with_capacity(description.len() + block.len());
    out.push_str(&description[..first_start]);
    out.push_str(block);
    let mut at = first_end;
    for &(s, e) in &spans[1..] {
        out.push_str(&description[at..s]);
        at = e;
    }
    out.push_str(&description[at..]);
    out
}

// --- 4D T3: the hub's stack requests ---
use crate::error::{GbError, GbErrorKind};
use crate::forge::hub::ForgeHub;
use crate::forge::{native_stacked_mrs, AccountKey, ForgeProject, ForgeProvider, MrEdit, SourceRef};
use crate::payload::RemotePayload;
use crate::settings::SettingsStore;
use std::sync::Arc;

/// What the stack requests act on: the repo's target project (spec #4 §3.3) and its provider.
pub(crate) struct StackCtx {
    pub remote: String,
    pub key: AccountKey,
    pub provider: Arc<dyn ForgeProvider>,
    pub project: ForgeProject,
    pub mode: StackMode,
}

/// Each member's first commit as a new MR/PR's title and description (Ruling 6): the oldest
/// commit `refs/heads/<member>` has beyond the member below (the bottom: beyond `base_ref`).
/// `None` for a branch that doesn't exist or has no commit of its own. Reads gix only.
pub(crate) fn prefills(repo: &gix::Repository, branches: &[String], base_ref: &str) -> Vec<Option<MrPrefill>> {
    let id = |r: &str| repo.rev_parse_single(format!("{r}^{{commit}}").as_str()).ok().map(|i| i.detach());
    let mut below = id(base_ref);
    branches
        .iter()
        .map(|b| {
            let tip = id(&format!("refs/heads/{b}"));
            let first = tip.and_then(|t| {
                // Nothing to hide below: don't walk the whole history.
                let walk = repo.rev_walk([t]).with_hidden([below?]);
                walk.all().ok()?.filter_map(Result::ok).map(|info| info.id).last()
            });
            let prefill = first.and_then(|oid| {
                let message = repo.find_commit(oid).ok()?.message_raw().ok()?.to_string();
                let message = message.trim_end();
                let (subject, rest) = message.split_once('\n').unwrap_or((message, ""));
                Some(MrPrefill { title: subject.trim().to_string(), description: rest.trim_start_matches(['\r', '\n']).trim_end().to_string() })
            });
            below = tip.or(below);
            prefill
        })
        .collect()
}

impl ForgeHub {
    pub(crate) async fn stack_ctx(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload]) -> Result<StackCtx, GbError> {
        let projects = self.repo_projects(store, remotes, false).await;
        let remote = projects.target.ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "This repository has no forge project: add an account in Settings › Accounts"))?;
        let (key, provider, project) = self.project_for_remote(store, remotes, &remote).await?;
        let version = crate::forge::hub::account_for(&store.active_profile().forge_accounts, &key.host).and_then(|a| a.version.clone());
        let mode = if native_stacked_mrs(provider.kind(), version.as_deref()) { StackMode::Native } else { StackMode::Managed };
        Ok(StackCtx { remote, key, provider, project, mode })
    }

    /// Each branch's MR/PR in the target project: an open or draft one before a newer closed one.
    async fn member_mrs(&self, c: &StackCtx, branches: &[String]) -> Result<Vec<Option<ForgeMr>>, GbError> {
        let mut out = Vec::with_capacity(branches.len());
        for b in branches {
            let source = SourceRef { project: c.project.path.clone(), branch: b.clone() };
            let r = c.provider.mr_for_branch(&c.project, &source).await;
            self.record(&c.key, &r);
            out.push(r?.value);
        }
        Ok(out)
    }

    /// The stack's MRs/PRs (spec #4 §4 "4D"). `branches` bottom → top; `base`: the forge branch
    /// the bottom targets; `prefills`: `prefills()`'s, kept only where a new MR/PR is needed.
    pub async fn stack_view(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], branches: &[String], base: &str, prefills: Vec<Option<MrPrefill>>) -> Result<StackView, GbError> {
        let c = self.stack_ctx(store, remotes).await?;
        let mrs = self.member_mrs(&c, branches).await?;
        let mut prefills = prefills.into_iter();
        let members = branches
            .iter()
            .zip(mrs)
            .enumerate()
            .map(|(i, (branch, mr))| {
                let prefill = prefills.next().flatten();
                let needs_one = mr.as_ref().is_none_or(|m| m.state == MrState::Closed);
                StackMember { branch: branch.clone(), target_branch: if i == 0 { base.to_string() } else { branches[i - 1].clone() }, prefill: if needs_one { prefill } else { None }, mr }
            })
            .collect();
        Ok(StackView { remote: c.remote, project: c.project.path.clone(), kind: c.project.kind, mode: c.mode, members })
    }

    /// Rewrites the Stack table in every open MR/PR of the stack (Ruling 2): managed stacks only,
    /// an unchanged description isn't sent, and one failure doesn't stop the others.
    pub async fn sync_stack(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], branches: &[String], _base: &str) -> Result<StackSync, GbError> {
        let c = self.stack_ctx(store, remotes).await?;
        let mrs: Vec<ForgeMr> = self.member_mrs(&c, branches).await?.into_iter().flatten().collect();
        let mut sync = StackSync::default();
        if c.mode == StackMode::Native {
            sync.unchanged = mrs.iter().filter(|m| matches!(m.state, MrState::Open | MrState::Draft)).map(|m| m.number).collect();
            return Ok(sync);
        }
        let rows: Vec<TableRow<'_>> = mrs.iter().map(|m| TableRow { number: m.number, title: &m.title, state: m.state }).collect();
        for m in mrs.iter().filter(|m| matches!(m.state, MrState::Open | MrState::Draft)) {
            match self.sync_one(&c, m.number, &rows).await {
                Ok(true) => sync.edited.push(m.number),
                Ok(false) => sync.unchanged.push(m.number),
                Err(e) => sync.failed.push(StackEditFailure { number: m.number, message: e.message }),
            }
        }
        Ok(sync)
    }

    /// `Ok(true)`: the description changed and was sent.
    async fn sync_one(&self, c: &StackCtx, number: u64, rows: &[TableRow<'_>]) -> Result<bool, GbError> {
        let detail = c.provider.mr_detail(&c.project, number).await;
        self.record(&c.key, &detail);
        let description = detail?.value.description;
        let next = splice_block(&description, &render_block(c.project.kind, rows, number, eol_of(&description)));
        if next == description {
            return Ok(false);
        }
        let edit = MrEdit { title: None, description: Some(next), labels: None };
        let r = c.provider.edit(&c.project, number, &edit).await;
        self.record(&c.key, &r);
        r.map(|_| true)
    }

    /// Points MR/PR `number` of the target project at `target` (spec #4 §4 "4D").
    pub async fn retarget_mr(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, target: &str) -> Result<ForgeMr, GbError> {
        let c = self.stack_ctx(store, remotes).await?;
        let r = c.provider.retarget(&c.project, number, target).await;
        self.record(&c.key, &r);
        if r.is_ok() {
            self.cache.forget_lists(&crate::forge::cache::cache_key(&c.key, &c.project.path));
        }
        r
    }
}
// --- end 4D T3 ---
// --- 4D T4: the merge guard (Ruling 12) ---

/// What `before_merge` retargeted, for `after_failed_merge`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeGuard {
    /// The merged MR/PR's source branch: where the moved ones pointed.
    pub from: String,
    /// The merged MR/PR's target branch: where they point now.
    pub to: String,
    pub moved: Vec<u64>,
}

impl ForgeHub {
    /// Before GitBolt merges MR/PR `number` and its source branch is deleted (research §6: GitHub
    /// can close a PR whose base branch is deleted, irrecoverably), the open MRs/PRs that target
    /// that branch are pointed at its target. `deletes_branch`: the merge's option; `None` follows
    /// the project's default; GitHub ignores the option (the repository's setting decides), so it
    /// always reads the setting (unreadable: treated as deleting, since retargeting is harmless when the branch stays). Native GitLab stacks retarget themselves, and a fork's merge
    /// deletes a branch in the fork: nothing to do for either.
    pub async fn before_merge(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], number: u64, deletes_branch: Option<bool>) -> Result<MergeGuard, GbError> {
        let c = self.stack_ctx(store, remotes).await?;
        if c.mode == StackMode::Native {
            return Ok(MergeGuard::default());
        }
        let deletes = match deletes_branch {
            Some(d) if c.project.kind != ForgeKind::GitHub => d,
            _ => {
                let s = c.provider.project_settings(&c.project).await;
                self.record(&c.key, &s);
                match s {
                    Ok(s) => s.delete_source_branch,
                    // GitHub: retargeting is harmless when the branch stays, so an unknown setting counts as "deletes it".
                    Err(e) if c.project.kind == ForgeKind::GitHub => {
                        tracing::warn!("{}'s merge settings unread ({}): retargeting dependents anyway", c.project.path, e.message);
                        true
                    }
                    Err(e) => return Err(GbError::new(e.kind, format!("Not merged: couldn't read {}'s merge settings: {}", c.project.path, e.message))),
                }
            }
        };
        if !deletes {
            return Ok(MergeGuard::default());
        }
        let detail = c.provider.mr_detail(&c.project, number).await;
        self.record(&c.key, &detail);
        let merging = detail?.value.mr;
        if merging.source_project != merging.target_project {
            return Ok(MergeGuard::default());
        }
        let open = c.provider.open_mrs_targeting(&c.project, &merging.source_branch).await;
        self.record(&c.key, &open);
        let dependents: Vec<u64> = open?.value.into_iter().filter(|m| m.number != number && m.target_branch == merging.source_branch && m.target_project == merging.target_project).map(|m| m.number).collect();
        let mut guard = MergeGuard { from: merging.source_branch.clone(), to: merging.target_branch.clone(), moved: Vec::new() };
        for n in dependents {
            let r = c.provider.retarget(&c.project, n, &merging.target_branch).await;
            self.record(&c.key, &r);
            if let Err(e) = r {
                let stuck = self.after_failed_merge(store, remotes, &guard).await;
                let mut message = format!("Not merged: couldn't retarget {} first ({})", mr_ref(c.project.kind, n), e.message);
                append_stuck(&mut message, c.project.kind, &stuck, &guard.to);
                return Err(GbError::new(e.kind, message));
            }
            guard.moved.push(n);
        }
        Ok(guard)
    }

    /// The merge failed after `before_merge`: the moved MRs/PRs point back. Returns the ones that
    /// couldn't be (they still target `guard.to`).
    pub async fn after_failed_merge(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], guard: &MergeGuard) -> Vec<u64> {
        if guard.moved.is_empty() {
            return Vec::new();
        }
        let Ok(c) = self.stack_ctx(store, remotes).await else { return guard.moved.clone() };
        let mut stuck = Vec::new();
        for n in &guard.moved {
            let r = c.provider.retarget(&c.project, *n, &guard.from).await;
            self.record(&c.key, &r);
            if let Err(e) = r {
                tracing::warn!("{} not pointed back at {}: {}", mr_ref(c.project.kind, *n), guard.from, e.message);
                stuck.push(*n);
            }
        }
        stuck
    }

    /// The error to give for a merge that failed after `before_merge` moved dependents. A network
    /// failure may have merged anyway: nothing is put back, and the message says so.
    pub async fn merge_failed(&self, store: &Arc<SettingsStore>, remotes: &[RemotePayload], guard: &MergeGuard, mut err: GbError) -> GbError {
        if guard.moved.is_empty() {
            return err;
        }
        if err.kind == GbErrorKind::Network {
            err.message = format!("{} (dependents were retargeted to {} first)", err.message, guard.to);
            return err;
        }
        let stuck = self.after_failed_merge(store, remotes, guard).await;
        if !stuck.is_empty() {
            let kind = self.stack_ctx(store, remotes).await.map(|c| c.project.kind).unwrap_or(ForgeKind::GitLab);
            append_stuck(&mut err.message, kind, &stuck, &guard.to);
        }
        err
    }
}

fn append_stuck(message: &mut String, kind: ForgeKind, stuck: &[u64], to: &str) {
    if stuck.is_empty() {
        return;
    }
    let refs: Vec<String> = stuck.iter().map(|n| mr_ref(kind, *n)).collect();
    message.push_str(&format!(" ({} still target{} {to})", refs.join(", "), if stuck.len() == 1 { "s" } else { "" }));
}
// --- end 4D T4 ---

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<TableRow<'static>> {
        vec![
            TableRow { number: 12, title: "Add the parser", state: MrState::Merged },
            TableRow { number: 13, title: "Use the parser", state: MrState::Open },
            TableRow { number: 14, title: "Wire the UI", state: MrState::Draft },
        ]
    }

    const GITLAB_BLOCK: &str = "<!-- gitbolt-stack:start -->\n**Stack** (kept up to date by GitBolt)\n\n| # | MR | Title | State |\n|---|---|---|---|\n| 1 | !12 | Add the parser | Merged |\n| **2** | **!13** | **Use the parser** | **Open** |\n| 3 | !14 | Wire the UI | Draft |\n<!-- gitbolt-stack:end -->";

    #[test]
    fn a_gitlab_table_lists_the_stack_bottom_first_with_this_mr_in_bold() {
        assert_eq!(render_block(ForgeKind::GitLab, &rows(), 13, "\n"), GITLAB_BLOCK);
    }

    #[test]
    fn a_github_table_says_pr_and_hash_numbers() {
        let b = render_block(ForgeKind::GitHub, &rows(), 12, "\n");
        assert!(b.contains("| # | PR | Title | State |"), "{b}");
        assert!(b.contains("| **1** | **#12** | **Add the parser** | **Merged** |"), "{b}");
        assert!(b.contains("| 3 | #14 | Wire the UI | Draft |"), "{b}");
    }

    /// Review Focus 1.
    #[test]
    fn a_title_can_never_break_the_table_or_the_markers() {
        let t = "Fix a | b *now* `x` [y]_z\r\nsecond <!-- gitbolt-stack:end --> \\";
        let b = render_block(ForgeKind::GitLab, &[TableRow { number: 1, title: t, state: MrState::Open }], 9, "\n");
        assert!(b.contains("| 1 | !1 | Fix a \\| b \\*now\\* \\`x\\` \\[y\\]\\_z second &lt;!-- gitbolt-stack:end --&gt; \\\\ | Open |"), "{b}");
        assert_eq!(b.matches(MARK_START).count(), 1);
        assert_eq!(b.matches(MARK_END).count(), 1);
        assert_eq!(b.lines().count(), 7, "one row: {b}");
    }

    #[test]
    fn splicing_into_a_description_without_a_block_appends_it_after_a_blank_line() {
        assert_eq!(splice_block("", "B"), "B");
        assert_eq!(splice_block("Body", "B"), "Body\n\nB");
        assert_eq!(splice_block("Body\n", "B"), "Body\n\nB");
        assert_eq!(splice_block("Body  \r\nMore", "B"), "Body  \r\nMore\r\n\r\nB", "the user's text keeps every byte");
    }

    /// Review Focus 2.
    #[test]
    fn splicing_replaces_the_block_in_place_and_leaves_every_other_byte() {
        let d = "Intro  \r\n\r\n<!-- gitbolt-stack:start -->\r\nold table\r\n<!-- gitbolt-stack:end -->\r\nOutro *kept*";
        let b = render_block(ForgeKind::GitLab, &rows(), 13, eol_of(d));
        let out = splice_block(d, &b);
        assert!(out.starts_with("Intro  \r\n\r\n<!-- gitbolt-stack:start -->\r\n**Stack**"), "{out:?}");
        assert!(out.ends_with("<!-- gitbolt-stack:end -->\r\nOutro *kept*"), "{out:?}");
        assert!(!out.contains("old table"));
        assert!(!out.replace("\r\n", "").contains('\n'), "CRLF throughout: {out:?}");
        assert_eq!(splice_block(&out, &b), out, "idempotent");
    }

    #[test]
    fn a_dangling_marker_is_text_and_extra_blocks_go() {
        let dangling = "Notes <!-- gitbolt-stack:start --> by hand";
        let once = splice_block(dangling, "<!-- gitbolt-stack:start -->\nT\n<!-- gitbolt-stack:end -->");
        assert_eq!(once, "Notes <!-- gitbolt-stack:start --> by hand\n\n<!-- gitbolt-stack:start -->\nT\n<!-- gitbolt-stack:end -->");
        let next = "<!-- gitbolt-stack:start -->\nU\n<!-- gitbolt-stack:end -->";
        assert_eq!(splice_block(&once, next), "Notes <!-- gitbolt-stack:start --> by hand\n\n<!-- gitbolt-stack:start -->\nU\n<!-- gitbolt-stack:end -->");
        let two = "A\n<!-- gitbolt-stack:start -->1<!-- gitbolt-stack:end -->\nB\n<!-- gitbolt-stack:start -->2<!-- gitbolt-stack:end -->\nC";
        assert_eq!(splice_block(two, "X"), "A\nX\nB\n\nC");
        let end_only = "A <!-- gitbolt-stack:end --> B";
        assert_eq!(splice_block(end_only, "X"), "A <!-- gitbolt-stack:end --> B\n\nX");
    }

    #[test]
    fn stack_types_serialize_as_the_ui_reads_them() {
        assert_eq!(serde_json::to_value(StackMode::Native).unwrap(), "native");
        assert_eq!(serde_json::to_value(StackMode::Managed).unwrap(), "managed");
        let sync = StackSync { edited: vec![2], unchanged: vec![3], failed: vec![StackEditFailure { number: 4, message: "m".into() }] };
        assert_eq!(serde_json::to_value(&sync).unwrap(), serde_json::json!({"edited": [2], "unchanged": [3], "failed": [{"number": 4, "message": "m"}]}));
        let m = StackMember { branch: "feature/a".into(), target_branch: "main".into(), mr: None, prefill: Some(MrPrefill { title: "T".into(), description: String::new() }) };
        assert_eq!(serde_json::to_value(&m).unwrap(), serde_json::json!({"branch": "feature/a", "targetBranch": "main", "mr": null, "prefill": {"title": "T", "description": ""}}));
        assert_eq!(mr_ref(ForgeKind::GitLab, 12), "!12");
        assert_eq!(mr_ref(ForgeKind::GitHub, 12), "#12");
    }

    // --- 4D T3 ---
    use crate::forge::fake::{stack_mr, MemTokens, Solo, StackFake};
    use crate::forge::hub::ForgeHub;
    use crate::forge::TokenStorage;
    use crate::payload::RemotePayload;
    use crate::redact::Secret;
    use crate::remotes::HostKind;
    use crate::settings::SettingsStore;
    use std::sync::Arc;

    const HOST: &str = "gitlab.example.com";

    pub(super) async fn setup(fake: StackFake) -> (Arc<StackFake>, ForgeHub, Arc<SettingsStore>, Vec<RemotePayload>) {
        let fake = Arc::new(fake);
        let hub = ForgeHub::new(Arc::new(Solo(fake.clone())), MemTokens::new(TokenStorage::Keyring), Arc::new(|| 1_791_115_200_000));
        let store = SettingsStore::in_memory();
        hub.add_account(&store, HOST, ForgeKind::GitLab, Secret::new("glpat-FAKE-test-token")).await.unwrap();
        let remotes = vec![RemotePayload { name: "origin".into(), host: Some(HOST.into()), path: Some("group/project".into()), host_kind: HostKind::GitLab, main: false }];
        (fake, hub, store, remotes)
    }

    pub(super) fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn the_view_gives_each_member_its_mr_its_target_and_a_prefill_when_it_has_none() {
        let (_, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", vec![(stack_mr(1, "feature/a", "main", MrState::Open, "A"), ""), (stack_mr(2, "feature/b", "main", MrState::Closed, "Old B"), "")])).await;
        let pre = |t: &str| Some(MrPrefill { title: t.into(), description: String::new() });
        let v = hub.stack_view(&store, &remotes, &names(&["feature/a", "feature/b", "feature/c"]), "main", vec![pre("Work on a"), pre("Work on b"), pre("Work on c")]).await.unwrap();
        assert_eq!((v.remote.as_str(), v.project.as_str(), v.kind, v.mode), ("origin", "group/project", ForgeKind::GitLab, StackMode::Managed));
        let m = &v.members;
        assert_eq!(m.iter().map(|x| x.target_branch.as_str()).collect::<Vec<_>>(), ["main", "feature/a", "feature/b"]);
        assert_eq!((m[0].mr.as_ref().map(|x| x.number), m[0].prefill.is_none()), (Some(1), true));
        assert_eq!(m[1].mr.as_ref().map(|x| x.state), Some(MrState::Closed));
        assert_eq!(m[1].prefill.as_ref().map(|p| p.title.as_str()), Some("Work on b"), "a closed MR counts as none (Ruling 7)");
        assert_eq!((m[2].mr.is_none(), m[2].prefill.as_ref().map(|p| p.title.as_str())), (true, Some("Work on c")));
    }

    #[tokio::test]
    async fn gitlab_19_1_is_native_and_its_descriptions_are_never_written() {
        let (fake, hub, store, remotes) = setup(StackFake::new("19.1.0-ee", vec![(stack_mr(1, "feature/a", "main", MrState::Open, "A"), "Body"), (stack_mr(2, "feature/b", "feature/a", MrState::Open, "B"), "")])).await;
        let b = names(&["feature/a", "feature/b"]);
        assert_eq!(hub.stack_view(&store, &remotes, &b, "main", vec![None, None]).await.unwrap().mode, StackMode::Native);
        let sync = hub.sync_stack(&store, &remotes, &b, "main").await.unwrap();
        assert_eq!((sync.edited, sync.unchanged), (vec![], vec![1, 2]));
        assert!(!fake.log().iter().any(|c| c.starts_with("edit") || c.starts_with("mr_detail")), "{:?}", fake.log());
    }

    /// Review Focus 2.
    #[tokio::test]
    async fn the_table_goes_into_open_mrs_only_and_an_unchanged_one_is_never_sent() {
        let (fake, hub, store, remotes) = setup(StackFake::new(
            "18.9.1-ee",
            vec![
                (stack_mr(1, "feature/a", "main", MrState::Merged, "Add the parser"), "A body"),
                (stack_mr(2, "feature/b", "feature/a", MrState::Open, "Use the parser"), "B body"),
                (stack_mr(3, "feature/c", "feature/b", MrState::Draft, "Wire the UI"), ""),
            ],
        ))
        .await;
        let b = names(&["feature/a", "feature/b", "feature/c"]);
        let first = hub.sync_stack(&store, &remotes, &b, "main").await.unwrap();
        assert_eq!((first.edited.clone(), first.unchanged.clone(), first.failed.len()), (vec![2, 3], vec![], 0));
        assert_eq!(fake.description(1), "A body", "a merged MR keeps its last table");
        let d2 = fake.description(2);
        assert!(d2.starts_with("B body\n\n<!-- gitbolt-stack:start -->\n"), "{d2}");
        assert!(d2.contains("| 1 | !1 | Add the parser | Merged |\n| **2** | **!2** | **Use the parser** | **Open** |\n| 3 | !3 | Wire the UI | Draft |"), "{d2}");
        assert!(fake.description(3).starts_with(MARK_START));
        let edits = fake.log().iter().filter(|c| c.starts_with("edit")).count();
        let again = hub.sync_stack(&store, &remotes, &b, "main").await.unwrap();
        assert_eq!((again.edited, again.unchanged), (vec![], vec![2, 3]));
        assert_eq!(fake.log().iter().filter(|c| c.starts_with("edit")).count(), edits, "nothing resent");
    }

    #[tokio::test]
    async fn one_failed_edit_is_reported_and_the_others_still_get_their_table() {
        let mut f = StackFake::new("18.9.1-ee", vec![(stack_mr(1, "feature/a", "main", MrState::Open, "A"), ""), (stack_mr(2, "feature/b", "feature/a", MrState::Open, "B"), "")]);
        f.fail_edit = Some(1);
        let (fake, hub, store, remotes) = setup(f).await;
        let sync = hub.sync_stack(&store, &remotes, &names(&["feature/a", "feature/b"]), "main").await.unwrap();
        assert_eq!(sync.edited, vec![2]);
        assert_eq!(sync.failed, vec![StackEditFailure { number: 1, message: "gitlab.example.com refused the change (403)".into() }]);
        assert!(fake.description(2).contains(MARK_START));
    }

    #[tokio::test]
    async fn retargeting_goes_to_the_target_projects_provider() {
        let (fake, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", vec![(stack_mr(2, "feature/b", "feature/a", MrState::Open, "B"), "")])).await;
        let m = hub.retarget_mr(&store, &remotes, 2, "main").await.unwrap();
        assert_eq!(m.target_branch, "main");
        assert!(fake.log().contains(&"retarget 2 main".to_string()));
    }

    #[tokio::test]
    async fn without_an_account_the_stack_requests_say_what_to_do() {
        let (_, hub, _, remotes) = setup(StackFake::new("18.9.1-ee", vec![])).await;
        let bare = SettingsStore::in_memory();
        let e = hub.retarget_mr(&bare, &remotes, 2, "main").await.unwrap_err();
        assert_eq!(e.message, "This repository has no forge project: add an account in Settings › Accounts");
    }

    #[test]
    fn a_members_prefill_is_its_first_commits_subject_and_body() {
        let r = crate::testing::TestRepo::new();
        crate::testing::fixtures::stack(&r);
        r.switch_new("feature/d");
        r.git(&["commit", "--allow-empty", "-q", "-m", "Start d", "-m", "Why d\n\nMore"]);
        r.git(&["commit", "--allow-empty", "-q", "-m", "Finish d"]);
        let repo = gix::open(r.path()).unwrap();
        let p = prefills(&repo, &names(&["feature/a", "feature/b", "feature/c", "feature/d", "gone"]), "refs/heads/main");
        assert_eq!(p[0], Some(MrPrefill { title: "Work on feature/a".into(), description: String::new() }));
        assert_eq!(p[2].as_ref().map(|x| x.title.as_str()), Some("Work on feature/c"));
        assert_eq!(p[3], Some(MrPrefill { title: "Start d".into(), description: "Why d\n\nMore".into() }), "the first commit, not the newest");
        assert_eq!(p[4], None);
    }
    // --- end 4D T3 ---
    // --- 4D T4 ---
    fn guarded_mrs() -> Vec<(ForgeMr, &'static str)> {
        vec![
            (stack_mr(1, "feature/a", "main", MrState::Open, "A"), ""),
            (stack_mr(2, "feature/b", "feature/a", MrState::Open, "B"), ""),
            (stack_mr(3, "feature/x", "feature/a", MrState::Draft, "X"), ""),
            (stack_mr(4, "feature/c", "feature/b", MrState::Open, "C"), ""),
        ]
    }

    /// Review Focus 5.
    #[tokio::test]
    async fn merging_a_bottom_that_deletes_its_branch_retargets_its_dependents_first() {
        let (fake, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", guarded_mrs())).await;
        let g = hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap();
        assert_eq!(g, MergeGuard { from: "feature/a".into(), to: "main".into(), moved: vec![2, 3] });
        assert_eq!((fake.target(2), fake.target(3), fake.target(4)), ("main".to_string(), "main".to_string(), "feature/b".to_string()));
    }

    #[tokio::test]
    async fn the_projects_default_decides_when_the_merge_doesnt_say() {
        let mut f = StackFake::new("18.9.1-ee", guarded_mrs());
        f.settings_delete = true;
        let (_, hub, store, remotes) = setup(f).await;
        assert_eq!(hub.before_merge(&store, &remotes, 1, None).await.unwrap().moved, vec![2, 3]);
    }

    #[tokio::test]
    async fn a_merge_that_keeps_the_branch_or_a_native_stack_moves_nothing() {
        let (fake, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", guarded_mrs())).await;
        assert_eq!(hub.before_merge(&store, &remotes, 1, Some(false)).await.unwrap(), MergeGuard::default());
        assert_eq!(hub.before_merge(&store, &remotes, 1, None).await.unwrap(), MergeGuard::default(), "the fake project keeps branches");
        assert!(!fake.log().iter().any(|c| c.starts_with("retarget")));
        let (native, hub, store, remotes) = setup(StackFake::new("19.1.0-ee", guarded_mrs())).await;
        assert_eq!(hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap(), MergeGuard::default());
        assert!(!native.log().iter().any(|c| c.starts_with("retarget")), "GitLab 19.1 retargets its own stacks");
    }

    /// Review Focus 5.
    #[tokio::test]
    async fn a_failed_retarget_merges_nothing_and_puts_the_moved_ones_back() {
        let mut f = StackFake::new("18.9.1-ee", guarded_mrs());
        f.fail_retarget = Some(3);
        let (fake, hub, store, remotes) = setup(f).await;
        let e = hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap_err();
        assert_eq!(e.message, "Not merged: couldn't retarget !3 first (gitlab.example.com refused the change (403))");
        assert_eq!(fake.target(2), "feature/a", "put back");
        let log = fake.log();
        assert_eq!(log.iter().filter(|c| c.starts_with("retarget")).cloned().collect::<Vec<_>>(), ["retarget 2 main", "retarget 3 main", "retarget 2 feature/a"]);
    }

    #[tokio::test]
    async fn a_failed_merge_points_the_moved_ones_back() {
        let (fake, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", guarded_mrs())).await;
        let g = hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap();
        hub.after_failed_merge(&store, &remotes, &g).await;
        assert_eq!((fake.target(2), fake.target(3)), ("feature/a".to_string(), "feature/a".to_string()));
    }

    fn forked(f: StackFake) -> StackFake {
        f.mrs.lock().unwrap()[0].0.source_project = "fork/project".into();
        f
    }

    #[tokio::test]
    async fn dependents_come_from_the_targeting_request_not_the_general_list() {
        let (fake, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", guarded_mrs())).await;
        hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap();
        let log = fake.log();
        assert!(log.iter().any(|c| c == "open_mrs_targeting feature/a"), "{log:?}");
        assert!(!log.iter().any(|c| c == "open_mrs"), "{log:?}");
    }

    #[tokio::test]
    async fn a_merge_from_a_fork_deletes_the_forks_branch_and_moves_nothing() {
        let (fake, hub, store, remotes) = setup(forked(StackFake::new("18.9.1-ee", guarded_mrs()))).await;
        assert_eq!(hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap(), MergeGuard::default());
        assert!(!fake.log().iter().any(|c| c.starts_with("retarget")));
    }

    #[tokio::test]
    async fn github_ignores_the_merge_option_and_follows_the_repositorys_setting() {
        let mut f = StackFake::new("18.9.1-ee", guarded_mrs());
        f.base.projects.lock().unwrap().get_mut("group/project").unwrap().kind = ForgeKind::GitHub;
        f.settings_delete = true;
        let (fake, hub, store, remotes) = setup(f).await;
        let g = hub.before_merge(&store, &remotes, 1, Some(false)).await.unwrap();
        assert_eq!(g.moved, vec![2, 3], "the repository deletes the branch whatever the merge says");
        assert!(fake.log().iter().any(|c| c == "project_settings"));
    }

    #[tokio::test]
    async fn settings_that_cant_be_read_block_the_merge() {
        let mut f = StackFake::new("18.9.1-ee", guarded_mrs());
        f.fail_settings = true;
        let (fake, hub, store, remotes) = setup(f).await;
        let e = hub.before_merge(&store, &remotes, 1, None).await.unwrap_err();
        assert_eq!(e.message, "Not merged: couldn't read group/project's merge settings: Can't reach gitlab.example.com");
        assert!(!fake.log().iter().any(|c| c.starts_with("retarget")));
    }

    #[tokio::test]
    async fn github_settings_that_cant_be_read_retarget_the_dependents_anyway() {
        let mut f = StackFake::new("18.9.1-ee", guarded_mrs());
        f.base.projects.lock().unwrap().get_mut("group/project").unwrap().kind = ForgeKind::GitHub;
        f.fail_settings = true;
        let (fake, hub, store, remotes) = setup(f).await;
        let g = hub.before_merge(&store, &remotes, 1, None).await.unwrap();
        assert_eq!(g.moved, vec![2, 3], "an unknown setting counts as deleting the branch");
        assert!(fake.log().iter().any(|c| c == "project_settings"));
    }

    #[tokio::test]
    async fn a_merge_that_fails_puts_back_what_it_can_and_names_what_it_cant() {
        let mut f = StackFake::new("18.9.1-ee", guarded_mrs());
        f.fail_back = Some(3);
        let (fake, hub, store, remotes) = setup(f).await;
        let g = hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap();
        let e = hub.merge_failed(&store, &remotes, &g, GbError::new(GbErrorKind::InvalidInput, "Not mergeable")).await;
        assert_eq!(e.message, "Not mergeable (!3 still targets main)");
        assert_eq!((fake.target(2), fake.target(3)), ("feature/a".to_string(), "main".to_string()));
    }

    #[tokio::test]
    async fn a_network_failure_may_have_merged_so_nothing_is_put_back() {
        let (fake, hub, store, remotes) = setup(StackFake::new("18.9.1-ee", guarded_mrs())).await;
        let g = hub.before_merge(&store, &remotes, 1, Some(true)).await.unwrap();
        let e = hub.merge_failed(&store, &remotes, &g, GbError::new(GbErrorKind::Network, "Can't reach gitlab.example.com")).await;
        assert_eq!(e.message, "Can't reach gitlab.example.com (dependents were retargeted to main first)");
        assert_eq!((fake.target(2), fake.target(3)), ("main".to_string(), "main".to_string()));
    }
    // --- end 4D T4 ---

    #[test]
    fn a_stack_table_needs_both_markers() {
        assert!(carries_stack_table(&format!("x\n{MARK_START}\n| t |\n{MARK_END}\n")));
        assert!(!carries_stack_table(&format!("quoting `{MARK_START}` here")));
        assert!(!carries_stack_table(&format!("{MARK_END} before {MARK_START}")));
        assert!(!carries_stack_table("plain"));
    }
}
