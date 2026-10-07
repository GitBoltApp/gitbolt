//! Rebase (spec #2 §13.1, §13.4).
//!
//! A long rebase must not crawl (no hooks wrapper through `core.hooksPath`, no store dispatch
//! per commit, no stage-all autostash, no full reload under a spinner), so GitBolt runs one
//! native `git rebase`:
//! - no `--exec`, no `--force-rebase`, no sequence editor (`GIT_EDITOR=true` from the write env);
//! - no replay in gix, and `core.hooksPath` is never touched: git runs the user's hooks itself;
//! - its stderr is drained continuously (`git.rs`), and the progress tap coalesces
//!   `Rebasing (n/m)` to one event per ~100 ms. Nothing of GitBolt's sits between two commits.
//!
//! The UI follows each pick through the tap, not the watcher: the watcher's git-dir watch isn't
//! recursive, so `rebase-merge/msgnum` rewrites never fire, and the write's watcher hold mutes
//! the rest. Every tick carries the latest step (`opProgress.step`), and a tick on which HEAD
//! moved sends `refsUpdated`, so the graph shows the new commits.

use crate::api::{blocking, Api, RepoHandle};
use crate::error::{gix_err, short_ref, GbError, GbErrorKind};
use crate::events::{AppEvent, ChangeKind, OpKind};
use crate::git::GitInvocation;
use crate::in_progress::InProgress;
use crate::journal::autostash::{AutostashRule, AutostashSpec};
use crate::journal::{PausedKind, RefMove, UndoKind};
use crate::write::integrate::{branch_sets, lossy_among, lossy_message, merges_in, BranchLabel, IntegrateOutcome};
use crate::write::progress;
use crate::write::types::{Confirm, WriteResult};
use crate::write::{is_ancestor, run_write, Pause, Plan, Pre, WriteCx, WriteIntent};
use gix::ObjectId;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use ts_rs::TS;

/// The tick's graph update (§13.4): when HEAD moved since the last tick, every tab of the
/// repository reloads its graph (`refsUpdated`), so the new commits appear and the rebasing chip
/// moves. gix only: no locks, no git process.
fn head_ticker(api: &Api, h: &Arc<RepoHandle>, root: &Path, head: Option<String>) -> impl FnMut() + Send + 'static {
    let (bus, ids, root) = (api.bus.clone(), api.repo_writes(h).ids(), root.to_path_buf());
    let mut last = head;
    move || {
        let now = head_oid(&root);
        if now != last {
            last = now;
            for id in &ids {
                bus.emit(AppEvent::RefsUpdated { repo: *id });
            }
        }
    }
}

fn head_oid(root: &Path) -> Option<String> {
    gix::open(root).ok()?.head_id().ok().map(|id| id.to_string())
}

fn oid(hex: &str) -> Option<ObjectId> {
    ObjectId::from_hex(hex.as_bytes()).ok()
}

/// One `git rebase …` (start, `--continue` or `--skip`) through the progress tap.
/// - Stopped on conflicts (or by a failing hook or signer, or at an `edit` stop, which git exits
///   0 from), it pauses: `cx.paused` names
///   `target` for the banner, and records the `onto` git stopped with, which settle judges
///   completion against.
/// - A Cancel of a rebase it started aborts it (review M2): `rebase --abort` puts the branch
///   back, and step 8 restores the autostash, so a Cancel leaves the repository as it was. A
///   Cancel of a Continue or Skip leaves the rebase paused where git stopped, as the banner then
///   shows (the user's resolutions aren't thrown away).
/// - Done counts the commits from the history, not git's counter (which counts `update-ref`
///   steps too, review M3): those the branch has beyond `onto`, or for a branch that was behind
///   it, the ones it fast-forwarded by: one `rev-list --count` (review N5: the counter also
///   counts dropped picks).
///
/// `onto`: the target's oid, when the caller has it (the start resolved it in `plan`). `envs`:
/// extra environment for git (3C: the interactive rebase's sequence editor). A stop that came
/// with git failing (a conflict, a failed `exec`) leaves git's error in `failed` (3C final fix
/// M2: a reword script's hook output).
pub(crate) async fn run_rebase_stop(cx: &mut WriteCx<'_>, args: Vec<String>, target: &str, onto: Option<ObjectId>, envs: Vec<(std::ffi::OsString, std::ffi::OsString)>, failed: &mut Option<GbError>) -> Result<IntegrateOutcome, GbError> {
    // Preflight read both, under this lock: no git process, no repository open (review P1).
    let head_before = cx.before.head.oid.clone();
    let resumed = cx.before.in_progress == Some("rebase");
    let onto = match onto {
        Some(o) => Some(o),
        None if resumed => match crate::in_progress::read(cx.root).ok().flatten() {
            Some(InProgress::Rebase { onto, .. }) => oid(&onto),
            _ => None,
        },
        None => gix::open(cx.root).ok().and_then(|r| r.rev_parse_single(target).ok().map(|t| t.detach())),
    };
    let ticker = head_ticker(cx.api, cx.h, cx.root, head_before.clone());
    // The branch the status bar names: HEAD's, or (a Continue, HEAD detached) the one being rebased.
    let branch = cx.before.head.branch.clone().or_else(|| match crate::in_progress::read(cx.root).ok().flatten() {
        Some(InProgress::Rebase { head_name, .. }) => Some(head_name.strip_prefix("refs/heads/").unwrap_or(&head_name).to_string()),
        _ => None,
    });
    let tap = progress::tap(cx.api.bus.clone(), cx.op.id, "Rebasing", branch, cx.output(), progress::TICK, ticker);
    let inv = cx.git_to(args, tap.tx.clone()).envs(envs);
    let res = cx.run_git(inv).await;
    let last = tap.finish().await;
    for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Head, ChangeKind::Refs, ChangeKind::State] {
        cx.touch(k);
    }
    // 3C T4: an `edit` stop (or a `break`) exits 0 with the rebase still in progress: it's a
    // pause, never a completion.
    // M2: a state that can't be read after exit 0 isn't taken for a completion either.
    let stopped = match &res {
        Ok(_) => match crate::in_progress::read(cx.root) {
            Ok(Some(InProgress::Rebase { conflicted, onto, .. })) => Some((conflicted, onto)),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(target: "gitbolt_core::write", "reading the rebase's state after it ran: {e}");
                Some((0, onto.map(|o| o.to_string()).unwrap_or_default()))
            }
        },
        Err(_) => None,
    };
    if let Some((conflicted, onto)) = stopped {
        cx.paused = Some(Pause { kind: PausedKind::Rebase, target: target.to_string(), target_oid: Some(onto).filter(|o| !o.is_empty()), put_back: Vec::new(), picked: Vec::new(), irebase: None });
        return Ok(IntegrateOutcome::Stopped { kind: PausedKind::Rebase, files: conflicted, warning: None });
    }
    match res {
        Ok(_) => {
            let root = cx.root.to_path_buf();
            let old = head_before.as_deref().and_then(oid);
            // git printed picks: not a fast-forward, so no ancestry check is needed.
            let picked = last.is_some();
            let (new, ff) = blocking(move || {
                let repo = gix::open(&root).map_err(gix_err)?;
                let new = repo.head_id().ok().map(|id| id.detach());
                let ff = match (old, onto) {
                    (Some(o), Some(t)) if !resumed && !picked && new != old => is_ancestor(&repo, o, t).then_some(o),
                    _ => None,
                };
                Ok((new, ff))
            })
            .await?;
            if !resumed && new == old {
                return Ok(IntegrateOutcome::UP_TO_DATE);
            }
            let (Some(new), Some(from)) = (new, ff.or(onto)) else { return Ok(IntegrateOutcome::done(0, false)) };
            // Review N5: from the history, not git's counter, which also counts the picks it
            // dropped ("patch contents already upstream") and `update-ref` steps. One short
            // read, where a walk here would cost a debug build ~10 ms (review P1).
            let commits = crate::write::precheck::commits_not_in(&cx.api.cli, cx.root, &new.to_string(), &from.to_string()).await?;
            Ok(IntegrateOutcome::done(commits, ff.is_some()))
        }
        Err(e) => {
            let cancelled = e.kind == GbErrorKind::Cancelled || cx.op.cancel.is_cancelled();
            let mut e = e;
            if cancelled && !resumed && matches!(crate::in_progress::read(cx.root).ok().flatten(), Some(InProgress::Rebase { .. })) {
                // Its own invocation: the op's cancel token has fired.
                let abort = GitInvocation::write(&cx.token, cx.root, ["rebase", "--abort"]).detach_terminal().stream_stderr(cx.output());
                match cx.api.cli.run(abort).await {
                    Ok(_) => return Err(e),
                    // Review N3: still in progress, so it pauses below: the autostash stays
                    // (never restored into a rebase), and the banner offers Continue and Abort.
                    Err(a) => e = GbError::new(a.kind, format!("Cancelled, but the rebase couldn't be aborted ({}): it's paused, so Continue or Abort it", a.message)),
                }
            }
            match crate::in_progress::read(cx.root).ok().flatten() {
                Some(InProgress::Rebase { .. }) if cancelled && resumed => Err(e),
                Some(InProgress::Rebase { conflicted, onto, .. }) => {
                    cx.paused = Some(Pause { kind: PausedKind::Rebase, target: target.to_string(), target_oid: Some(onto).filter(|o| !o.is_empty()), put_back: Vec::new(), picked: Vec::new(), irebase: None });
                    if cancelled {
                        Err(e)
                    } else {
                        // UX F: a stop with no conflict is git failing at something else (the
                        // signer, a hook, an `exec`): its message goes with the stop.
                        let warning = if conflicted == 0 { Some(stop_reason(cx, &e).await) } else { None };
                        *failed = Some(e);
                        Ok(IntegrateOutcome::Stopped { kind: PausedKind::Rebase, files: conflicted, warning })
                    }
                }
                _ => Err(pre_rebase_refused(e)),
            }
        }
    }
}

/// UX F: why a rebase stopped without a conflict, for the toast ("The rebase stopped: gpg
/// failed to sign the data: …").
/// git's refusal of unstaged changes goes to stdout: an exit status alone is named here.
async fn stop_reason(cx: &WriteCx<'_>, e: &GbError) -> String {
    let said = e.message.trim().trim_end_matches('.');
    if said.starts_with("git exited with status") {
        let unstaged = cx.api.cli.run(GitInvocation::new(cx.root, ["diff", "--name-only", "-z"])).await.is_ok_and(|o| !o.stdout.is_empty());
        if unstaged {
            return "The rebase stopped: it can't go on with unstaged changes. Stage or discard them, then Continue".to_string();
        }
    }
    format!("The rebase stopped: {said}")
}

/// UX F: a pick whose commit never happened, and that git's own `--continue` can't go on from
/// ("you have staged changes": no stop, so no message to commit them with). Only in a rebase
/// GitBolt started (its callers check): a terminal's rebase is git's alone. Two ways in, each
/// recognised only by git's own evidence naming the commit:
/// - the commit failed (the signer, a hook): git put the line back on top of the todo
///   ("rescheduled"), its result staged; `REBASE_HEAD` names that commit, and `done` already
///   ends with the same line;
/// - the write was cancelled while git committed (a signer that never returned): `done` ends with
///   the line, the todo doesn't start with it, and HEAD isn't its commit (`head_is_pick_of`).
///
/// Never at a stop git made itself (`stopped-sha`: a conflict; `amend`: an Edit stop), nor at a
/// `break` or a failed `exec` (their `done` line replays nothing).
struct FailedPick {
    merge: std::path::PathBuf,
    oid: String,
    /// The todo line (`pick <oid> # …`).
    line: String,
    /// Already in `done` (the cancelled case); else on top of the todo.
    interrupted: bool,
    staged: bool,
    /// The index holds exactly the pick's result, or nothing: resetting it loses nothing.
    exact: bool,
}

fn first_command(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))
}

fn last_command(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with('#'))
}

/// Two spellings of one commit (a todo may abbreviate it).
fn same_commit(a: &str, b: &str) -> bool {
    a.len().min(b.len()) >= 7 && (a.starts_with(b) || b.starts_with(a))
}

async fn failed_pick(cx: &WriteCx<'_>) -> Result<Option<FailedPick>, GbError> {
    let root = cx.root.to_path_buf();
    let git_dir = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.git_dir().to_path_buf())).await?;
    let merge = git_dir.join("rebase-merge");
    if !merge.is_dir() || merge.join("stopped-sha").exists() || merge.join("amend").exists() {
        return Ok(None);
    }
    let todo = std::fs::read_to_string(merge.join("git-rebase-todo")).unwrap_or_default();
    let done = std::fs::read_to_string(merge.join("done")).unwrap_or_default();
    let rebase_head = std::fs::read_to_string(git_dir.join("REBASE_HEAD")).unwrap_or_default().trim().to_string();
    let (first, last) = (first_command(&todo), last_command(&done));
    let staged = !cx.api.cli.run(GitInvocation::new(cx.root, ["diff", "--cached", "--name-only", "-z"])).await?.stdout.is_empty();
    // Rescheduled: git's own evidence names the commit.
    if let Some(line) = first
        && let Some(oid) = replayed(line, true)
        && (same_commit(&rebase_head, &oid) || last == Some(line))
    {
        let exact = !staged || pick_result_staged(cx, &oid).await;
        return Ok(Some(FailedPick { line: line.to_string(), oid, interrupted: false, staged, exact, merge }));
    }
    // Interrupted: HEAD isn't its commit, and the index holds nothing else.
    if let Some(line) = last
        && first != Some(line)
        && let Some(oid) = replayed(line, false)
        && !head_is_pick_of(cx, &oid).await
        && (!staged || pick_result_staged(cx, &oid).await)
    {
        return Ok(Some(FailedPick { line: line.to_string(), oid, interrupted: true, staged, exact: true, merge }));
    }
    Ok(None)
}

/// Writes a sequencer file whole or not at all: a temporary file next to it, then a rename.
fn write_state(path: &Path, text: &str) -> Result<(), GbError> {
    let io = |e: std::io::Error| GbError::new(GbErrorKind::Io, format!("{}: {e}", path.display()));
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.gitbolt-tmp"));
    std::fs::write(&tmp, text).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })
}

/// `text` without its last line equal to `line` (and anything after it).
fn without_last(text: &str, line: &str) -> String {
    let mut kept: Vec<&str> = text.lines().collect();
    while kept.last().is_some_and(|l| l.trim() != line) {
        kept.pop();
    }
    kept.pop();
    kept.iter().map(|l| format!("{l}\n")).collect()
}

/// `text` with its first (`first`) or last line equal to `from` replaced by `to`.
fn replace_line(text: &str, from: &str, to: &str, first: bool) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let at = if first { lines.iter().position(|l| l.trim() == from) } else { lines.iter().rposition(|l| l.trim() == from) }?;
    Some(lines.iter().enumerate().map(|(i, l)| format!("{}\n", if i == at { to } else { l })).collect())
}

/// The line as an `edit` (git stops right after its commit), for a typed message: `pick`,
/// `edit` and `reword` lines; `None` for any other command.
fn as_edit(line: &str) -> Option<String> {
    let (cmd, rest) = line.split_once(char::is_whitespace)?;
    ["pick", "p", "edit", "e", "reword", "r"].contains(&cmd).then(|| format!("edit {rest}"))
}

/// Unstages the failed pick's result first (`reset --merge`: unstaged changes kept), only when
/// `exact`. A refusal (a file changed both staged and unstaged) changes nothing.
async fn unstage_pick(cx: &mut WriteCx<'_>, f: &FailedPick) -> Result<(), GbError> {
    if f.staged && f.exact {
        let inv = cx.git(["reset", "-q", "--merge", "HEAD"]);
        cx.run_git(inv).await.map_err(|e| GbError::new(GbErrorKind::InvalidInput, format!("The failed commit's changes couldn't be unstaged ({}). Stage or discard your own changes to those files first", e.message.trim_end_matches('.'))))?;
        cx.touch(ChangeKind::Index);
        cx.touch(ChangeKind::Worktree);
    }
    Ok(())
}

/// Continue: the failed pick's result is unstaged, then its line goes back on top of the todo,
/// so git picks it again. Only when `exact`: anything else staged (the user's own) is left for
/// git's refusal. `stop`: the user typed a message for it, so the line goes back as `edit` (git
/// stops right after the commit, for the message to be amended in: `typed_message_at_stop`).
async fn retry_failed_commit(cx: &mut WriteCx<'_>, stop: bool) -> Result<Option<Repicked>, GbError> {
    let Some(f) = failed_pick(cx).await?.filter(|f| f.exact) else { return Ok(None) };
    tracing::info!(target: "gitbolt_core::write", "the rebase's commit of {} never happened: picking it again", f.oid);
    let edit = as_edit(&f.line).filter(|_| stop);
    let line = edit.clone().unwrap_or_else(|| f.line.clone());
    unstage_pick(cx, &f).await?;
    let todo_path = f.merge.join("git-rebase-todo");
    let todo = std::fs::read_to_string(&todo_path).unwrap_or_default();
    if f.interrupted {
        let done_path = f.merge.join("done");
        let done = std::fs::read_to_string(&done_path).unwrap_or_default();
        write_state(&todo_path, &format!("{line}\n{todo}"))?;
        write_state(&done_path, &without_last(&done, &f.line))?;
        cx.touch(ChangeKind::State);
    } else if let Some(text) = edit.as_ref().and_then(|e| replace_line(&todo, &f.line, e, true)) {
        write_state(&todo_path, &text)?;
        cx.touch(ChangeKind::State);
    }
    Ok(edit.map(|as_edit| Repicked { line: f.line.clone(), as_edit }))
}

/// A failed pick `retry_failed_commit` put back as `edit` for a typed message.
struct Repicked {
    /// Its own todo line (`pick <oid> …`, `edit …`, `reword …`).
    line: String,
    /// As put back (`edit <oid> …`).
    as_edit: String,
}

impl Repicked {
    fn was_edit(&self) -> bool {
        self.line == self.as_edit
    }

    /// The `edit` line gets its own command back wherever git left it (the todo's top when the
    /// pick failed again; `done`'s end when a cancel or a failed amend stopped the write), so no
    /// Edit stop is left that the user never asked for.
    fn restore(&self, root: &Path) {
        if self.was_edit() {
            return;
        }
        let Ok(repo) = gix::open(root) else { return };
        let merge = repo.git_dir().join("rebase-merge");
        for (name, first) in [("git-rebase-todo", true), ("done", false)] {
            let path = merge.join(name);
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let at = if first { first_command(&text) } else { last_command(&text) };
            if at != Some(self.as_edit.as_str()) {
                continue;
            }
            if let Some(fixed) = replace_line(&text, &self.as_edit, &self.line, first)
                && let Err(e) = write_state(&path, &fixed)
            {
                tracing::warn!(target: "gitbolt_core::write", "putting the failed pick's own command back: {e}");
            }
        }
    }
}

/// Skip: the failed pick's result is unstaged first, then its line is dropped from the todo
/// (`done` keeps it, as git's own skip does); then `--continue` goes on with the next line
/// (git's `--skip` would pick it again). The user's own staged changes are never thrown away:
/// Skip refuses. `true`: it was one.
async fn skip_failed_commit(cx: &mut WriteCx<'_>) -> Result<bool, GbError> {
    let Some(f) = failed_pick(cx).await? else { return Ok(false) };
    if !f.exact {
        return Err(GbError::new(GbErrorKind::InvalidInput, "Skip would also throw away changes you staged yourself. Unstage them first"));
    }
    if replayed(&f.line, false).is_none() {
        return Ok(false); // a fixup or squash: git's own skip
    }
    tracing::info!(target: "gitbolt_core::write", "skipping the rebase's failed commit of {}", f.oid);
    unstage_pick(cx, &f).await?;
    if !f.interrupted {
        let (todo_path, done_path) = (f.merge.join("git-rebase-todo"), f.merge.join("done"));
        let todo = std::fs::read_to_string(&todo_path).unwrap_or_default();
        let done = std::fs::read_to_string(&done_path).unwrap_or_default();
        if last_command(&done) != Some(f.line.as_str()) {
            write_state(&done_path, &format!("{done}{}{}\n", if done.is_empty() || done.ends_with('\n') { "" } else { "\n" }, f.line))?;
        }
        let mut lines: Vec<&str> = todo.lines().collect();
        if let Some(i) = lines.iter().position(|l| l.trim() == f.line) {
            lines.remove(i);
        }
        write_state(&todo_path, &lines.iter().map(|l| format!("{l}\n")).collect::<String>())?;
    }
    let _ = std::fs::remove_file(f.merge.join("author-script"));
    cx.touch(ChangeKind::State);
    Ok(true)
}

/// After a Continue that re-picked a failed commit as `edit` (`retry_failed_commit`): at its stop,
/// the typed message is amended in (the guarded `--only` amend of `use_message`), and git's
/// `amend` names the new commit. `false`: not at that stop (the pick failed again, a conflict).
async fn typed_message_at_stop(cx: &mut WriteCx<'_>, message: &str) -> Result<bool, GbError> {
    let root = cx.root.to_path_buf();
    let git_dir = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.git_dir().to_path_buf())).await?;
    if !git_dir.join("rebase-merge/amend").exists() {
        return Ok(false);
    }
    use_message(cx, message).await?;
    let root = cx.root.to_path_buf();
    let head = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.head_id().map_err(gix_err)?.to_string())).await?;
    write_state(&git_dir.join("rebase-merge/amend"), &format!("{head}\n"))?;
    crate::write::irebase::run::refused_message_applied(&git_dir);
    Ok(true)
}

/// A todo line's commit, if it replays one: `pick`, `edit`, `reword`, and (only `fixups`) a
/// `fixup [-C|-c]` or `squash`, whose interrupted amend can't be told from a done one.
fn replayed(line: &str, fixups: bool) -> Option<String> {
    let mut words = line.split_whitespace();
    let cmd = words.next()?;
    let pick = ["pick", "p", "edit", "e", "reword", "r"].contains(&cmd);
    if !pick && !(fixups && ["fixup", "f", "squash", "s"].contains(&cmd)) {
        return None;
    }
    let oid = words.find(|w| !w.starts_with('-'))?;
    (oid.len() >= 7 && oid.bytes().all(|b| b.is_ascii_hexdigit())).then(|| oid.to_string())
}

/// HEAD is `oid` picked: the same author (name, email and date, which a pick keeps) and the tree
/// picking `oid` onto HEAD's parent makes (two commits of one author in the same second aren't
/// taken for each other). Unreadable counts as picked (nothing is replayed again).
async fn head_is_pick_of(cx: &WriteCx<'_>, oid: &str) -> bool {
    let (root, id) = (cx.root.to_path_buf(), oid.to_string());
    let same_author = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let author = |id: ObjectId| -> Result<String, GbError> {
            let c = repo.find_commit(id).map_err(gix_err)?;
            let a = c.author().map_err(gix_err)?;
            Ok(format!("{} <{}> {}", a.name, a.email, a.time))
        };
        let picked = repo.rev_parse_single(id.as_str()).map_err(gix_err)?.detach();
        let head = repo.head_id().map_err(gix_err)?.detach();
        Ok(author(head)? == author(picked)?)
    })
    .await
    .unwrap_or(true);
    if !same_author {
        return false;
    }
    let run = |args: Vec<String>| async move { cx.api.cli.run(GitInvocation::new(cx.root, args)).await.ok().map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or_default().trim().to_string()) };
    let picked = run(vec!["merge-tree".into(), "--write-tree".into(), "--merge-base".into(), format!("{oid}^"), "HEAD^".into(), oid.to_string()]).await;
    let head = run(vec!["rev-parse".into(), "HEAD^{tree}".into()]).await;
    match (picked, head) {
        (Some(p), Some(h)) if !p.is_empty() && !h.is_empty() => p == h,
        _ => true,
    }
}

/// The index holds exactly what picking `oid` onto HEAD makes (git's merge, no conflict).
async fn pick_result_staged(cx: &WriteCx<'_>, oid: &str) -> bool {
    let Ok(out) = cx.api.cli.run(GitInvocation::new(cx.root, ["merge-tree", "--write-tree", "--merge-base", &format!("{oid}^"), "HEAD", oid])).await else { return false };
    let tree = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or_default().trim().to_string();
    if tree.is_empty() {
        return false;
    }
    cx.api.cli.run(GitInvocation::new(cx.root, ["diff", "--cached", "--name-only", "-z", &tree])).await.is_ok_and(|o| o.stdout.is_empty())
}

/// UX F: git keeps a rebase's signing from its start (`rebase-merge/gpg_sign_opt`, `-S` from
/// `commit.gpgsign`), so turning signing off at a stop changed nothing. For a rebase GitBolt
/// started (it never passes `-S` itself), a plain `-S` goes once `commit.gpgsign` is explicitly
/// `false`. On with no file, git's sequencer reads `commit.gpgsign` itself.
async fn sign_as_configured(cx: &WriteCx<'_>) -> Result<(), GbError> {
    let root = cx.root.to_path_buf();
    let git_dir = blocking(move || Ok(gix::open(&root).map_err(gix_err)?.git_dir().to_path_buf())).await?;
    let opt = git_dir.join("rebase-merge").join("gpg_sign_opt");
    if std::fs::read_to_string(&opt).map(|s| s.trim() != "-S").unwrap_or(true) {
        return Ok(());
    }
    // Only an explicit `false` (fix round 1): unset, or `true` from an include that doesn't match
    // on the rebase's detached HEAD (`includeIf "onbranch:…"`), keeps git's `-S`.
    let out = cx.api.cli.run(GitInvocation::new(cx.root, ["config", "--bool", "--get", "commit.gpgsign"]).ok_exit(1)).await?;
    if String::from_utf8_lossy(&out.stdout).trim() != "false" {
        return Ok(());
    }
    tracing::info!(target: "gitbolt_core::write", "commit.gpgsign is off now: the rebase stops signing");
    std::fs::remove_file(&opt).map_err(|e| GbError::new(GbErrorKind::Io, format!("{}: {e}", opt.display())))
}

/// `run_rebase_stop`, git's environment as the write sets it.
pub(crate) async fn run_rebase(cx: &mut WriteCx<'_>, args: Vec<String>, target: &str, onto: Option<ObjectId>) -> Result<IntegrateOutcome, GbError> {
    run_rebase_stop(cx, args, target, onto, Vec::new(), &mut None).await
}

/// A rebase isn't traced (`traces_hooks`): `pre-rebase`, the one hook that refuses a rebase
/// without stopping in it, is named from git's own message.
fn pre_rebase_refused(e: GbError) -> GbError {
    if e.kind == GbErrorKind::Cancelled || !e.stderr.as_deref().is_some_and(|s| s.contains("pre-rebase hook refused")) {
        return e;
    }
    let first = e.stderr.as_deref().and_then(|s| s.lines().map(str::trim).find(|l| !l.is_empty())).map(str::to_string);
    GbError { kind: GbErrorKind::HookFailed, message: first.unwrap_or_else(|| "pre-rebase hook failed".into()), detail: Some(crate::error::ErrorDetail::Hook { hook: "pre-rebase".into() }), ..e }
}

/// What `--update-refs` moves, read when the op runs (under the lock, review M5): the stacked
/// branches, and the merged-in ones it would move too but mustn't (review I2). Neither holds a
/// branch checked out in any worktree: git never moves those.
async fn update_ref_sets(cx: &WriteCx<'_>, branch: &str, target: ObjectId) -> Result<(Vec<(String, ObjectId)>, Vec<(String, ObjectId)>), GbError> {
    let out: std::collections::HashSet<String> = crate::worktree::list_worktrees(cx.root).await?.into_iter().filter_map(|w| w.branch).collect();
    let (root, branch) = (cx.root.to_path_buf(), branch.to_string());
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let sets = branch_sets(&repo, &branch, target)?;
        let free = |v: Vec<(String, ObjectId)>| v.into_iter().filter(|(n, _)| !out.contains(n)).collect::<Vec<_>>();
        Ok((free(sets.stacked), free(sets.merged_in)))
    })
    .await
}

/// A stopped rebase won't move the merged-in branches at its end: they leave git's
/// `rebase-merge/update-refs` (one `ref`, `before`, `after` line triple per ref, which git reads
/// back when the rebase ends). Review N1: only a file of that exact shape (whole triples, a ref
/// name then two hex oids) is edited. Anything else is left alone, and the Continue or Skip that
/// ends the rebase moves the branches back instead (`PausedOp::put_back`, `put_back`).
/// `false`: the file was left alone.
fn drop_update_refs(root: &Path, keep: &[(String, ObjectId)]) -> Result<bool, GbError> {
    let repo = gix::open(root).map_err(gix_err)?;
    let path = repo.git_dir().join("rebase-merge/update-refs");
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(true) };
    let Some(kept) = pruned_update_refs(&text, keep) else {
        tracing::warn!(target: "gitbolt_core::write", "{}: not git's ref/before/after triples; left alone", path.display());
        return Ok(false);
    };
    let tmp = path.with_extension("gitbolt.tmp");
    std::fs::write(&tmp, kept).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| GbError::new(GbErrorKind::Io, format!("{}: {e}", path.display())))?;
    Ok(true)
}

/// `text` without `keep`'s triples, or `None` when it isn't the shape git writes.
fn pruned_update_refs(text: &str, keep: &[(String, ObjectId)]) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let is_oid = |l: &str| matches!(l.len(), 40 | 64) && l.bytes().all(|b| b.is_ascii_hexdigit());
    let shaped = lines.len().is_multiple_of(3) && lines.chunks(3).all(|c| c[0].starts_with("refs/") && is_oid(c[1]) && is_oid(c[2]));
    shaped.then(|| lines.chunks(3).filter(|c| !keep.iter().any(|(n, _)| c[0] == n)).flat_map(|c| c.iter().map(|l| format!("{l}\n"))).collect())
}

/// The merged-in branches GitBolt's paused rebase couldn't prune from git's update list (N1),
/// read under the lock from its paused entry (`PausedOp::put_back`). A rebase started outside
/// GitBolt has no paused entry, so its `--update-refs` moves are the user's and stay (N6).
fn put_back_of_pause(cx: &WriteCx<'_>) -> Result<Vec<(String, ObjectId)>, GbError> {
    let journal = cx.api.journal(cx.root)?.load()?;
    let Some(op) = journal.paused().and_then(|e| e.paused.as_ref()).filter(|p| p.kind == PausedKind::Rebase) else { return Ok(Vec::new()) };
    Ok(op.put_back.iter().filter_map(|(n, o)| Some((n.clone(), oid(o)?))).collect())
}

/// After a run that ended the rebase: a merged-in branch `--update-refs` moved into the rebased
/// history goes back where it was. Review N2: if that CAS fails (it moved again meanwhile), the
/// move git made is recorded in the entry instead, so Undo puts it back.
async fn put_back(cx: &mut WriteCx<'_>, keep: &[(String, ObjectId)]) -> Result<(), GbError> {
    if keep.is_empty() {
        return Ok(());
    }
    let now = where_now(cx, keep).await?;
    for ((name, old), (at, rebased)) in keep.iter().zip(now) {
        let (Some(at), true) = (at, rebased) else { continue };
        if at == *old {
            continue;
        }
        let m = RefMove { name: name.clone(), old: Some(at.to_string()), new: Some(old.to_string()) };
        if let Err(e) = crate::write::refs::cas(&cx.api.cli, &cx.token, &cx.h.repo, cx.root, &[m], &format!("rebase: keep {} where it was (merged in, not stacked)", short_ref(name))).await {
            tracing::warn!(target: "gitbolt_core::write", "putting {name} back after the rebase: {e}; the entry records the move instead");
            cx.watch_refs([(name.clone(), Some(old.to_string()))]);
        }
    }
    Ok(())
}

/// Each ref's value now, and whether it's in the rebased history (an ancestor of HEAD).
async fn where_now(cx: &WriteCx<'_>, refs: &[(String, ObjectId)]) -> Result<Vec<(Option<ObjectId>, bool)>, GbError> {
    let (root, names): (_, Vec<String>) = (cx.root.to_path_buf(), refs.iter().map(|(n, _)| n.clone()).collect());
    blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let tip = repo.head_id().map_err(gix_err)?.detach();
        Ok(names
            .iter()
            .map(|n| {
                let at = crate::write::refs::read_ref(&repo, n).ok().flatten().and_then(|v| oid(&v));
                (at, at.is_some_and(|a| is_ancestor(&repo, a, tip)))
            })
            .collect())
    })
    .await
}

/// What `plan` found, for `run` (review P1: one repository open and one `y..x` walk).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Planned {
    target: ObjectId,
    /// `y..x` holds a merge: `--rebase-merges`.
    merges: bool,
    /// The user's `rebase.updateRefs`.
    update_refs_config: Option<bool>,
}

pub(crate) struct RebaseIntent {
    pub target: String,
    pub update_refs: Option<bool>,
    /// `git pull --rebase` semantics (§12.2).
    pub fork_point: bool,
    pub confirm: Confirm,
    pub label: BranchLabel,
    /// Set by `plan` (`Default::default()` when built).
    pub planned: std::sync::OnceLock<Planned>,
}

impl WriteIntent for RebaseIntent {
    type Outcome = IntegrateOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Rebase
    }
    fn label(&self) -> String {
        self.label.get()
    }
    fn undo(&self) -> Option<UndoKind> {
        Some(UndoKind::Rewind)
    }
    fn rewrite(&self) -> Option<crate::write::rewrites::RewriteKind> {
        Some(crate::write::rewrites::RewriteKind::Rebase)
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn traces_hooks(&self) -> bool {
        false
    }
    fn confirm(&self) -> Confirm {
        self.confirm
    }
    async fn plan(&self, pre: &Pre<'_>) -> Result<Plan, GbError> {
        let branch = pre.before.head.branch.as_deref().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Check out a branch to rebase it"))?;
        self.label.settle(branch);
        // Review P1: one open and one `y..x` walk, shared with `run`; the merge check runs only
        // on merges that walk found.
        let repo = gix::open(pre.root).map_err(gix_err)?;
        let target = repo.rev_parse_single(self.target.as_str()).map_err(|e| GbError::new(GbErrorKind::NotFound, format!("{}: {e}", self.target)))?.detach();
        let merges = match pre.before.head.oid.as_deref().and_then(oid) {
            Some(tip) => merges_in(&pre.api.cli, pre.root, tip, target).await?,
            None => Vec::new(),
        };
        // Review I2: `--rebase-merges` keeps merges, but remakes each from its parents.
        if let Some(merge) = lossy_among(&repo, &merges)? {
            return Err(GbError::new(GbErrorKind::InvalidInput, lossy_message(branch, &merge, &self.target)));
        }
        let _ = self.planned.set(Planned { target, merges: !merges.is_empty(), update_refs_config: repo.config_snapshot().boolean("rebase.updateRefs") });
        // --- 2C repo-safety ---
        // The rebase's first step checks the target out, a two-way move from HEAD: a file of
        // the target written where a populated submodule or an embedded clone sits deletes it
        // whole (safety review 2 N2), refused first; the same check says what the move sweeps
        // away (M1, M2).
        let mut rule = AutostashRule::Rebased;
        if let Some(tip) = pre.before.head.oid.as_deref().and_then(oid) {
            rule = crate::write::precheck::refuse_repos_in_the_way(&pre.api.cli, pre.root, tip, target, "rebase").await?.rule_over(rule);
        }
        // --- end 2C repo-safety ---
        Ok(Plan { autostash: Some(AutostashSpec { rule, target: Some(target), op: format!("rebase onto {}", self.target), target_name: Some(self.target.clone()) }), ..Plan::default() })
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<IntegrateOutcome, GbError> {
        let branch = cx.before.head.branch.clone().ok_or_else(|| GbError::new(GbErrorKind::InvalidInput, "Check out a branch to rebase it"))?;
        let Planned { target, merges, update_refs_config } = *self.planned.get().ok_or_else(|| GbError::new(GbErrorKind::Other, "rebase ran without its plan"))?;
        let wanted = self.update_refs.or(update_refs_config).unwrap_or(false);
        let (stacked, keep) = if wanted { update_ref_sets(cx, &branch, target).await? } else { (Vec::new(), Vec::new()) };
        // Merges stay merges (review I2); the update-refs flag is always explicit, so git's own
        // `rebase.updateRefs` can't move a merged-in branch either.
        let mut args = vec!["rebase".to_string()];
        if merges {
            args.push("--rebase-merges".into());
        }
        args.push(if wanted && !stacked.is_empty() { "--update-refs" } else { "--no-update-refs" }.into());
        if self.fork_point {
            args.push("--fork-point".into());
        }
        args.push(self.target.clone());
        // Review I1: the journal records HEAD's branch and these, as they are now, and no other.
        let keep = if stacked.is_empty() { Vec::new() } else { keep };
        cx.watch_refs(stacked.iter().map(|(n, o)| (n.clone(), Some(o.to_string()))));
        let out = run_rebase(cx, args, &self.target, Some(target)).await?;
        match &out {
            IntegrateOutcome::Done { .. } if !stacked.is_empty() => {
                let now = where_now(cx, &stacked).await?;
                for ((name, old), (at, rebased)) in stacked.iter().zip(now) {
                    // Moved by someone else meanwhile: not this rebase's to record.
                    if !rebased && at != Some(*old) {
                        cx.unwatch_ref(name);
                    }
                }
                put_back(cx, &keep).await?;
            }
            IntegrateOutcome::Stopped { .. } if !keep.is_empty() => {
                if !drop_update_refs(cx.root, &keep)?
                    && let Some(p) = cx.paused.as_mut()
                {
                    p.put_back = keep.iter().map(|(n, o)| (n.clone(), o.to_string())).collect();
                }
            }
            _ => {}
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RebaseAction {
    Continue,
    Skip,
    Abort,
}

/// The commit panel's Continue, Skip and Abort (§13.2). Not journaled: the paused rebase's own
/// entry settles in step 7b once the rebase is over.
struct RebaseControl {
    action: RebaseAction,
    target: String,
    /// Continue's message, as the commit panel shows it (ux round 1); `None`: git's own.
    message: Option<String>,
}

/// Continue commits the stopped pick with the commit panel's message (the UI sends one only when
/// the user edited it): git reads it from its own message file (`rebase-merge/message`, or
/// `rebase-apply/final-commit`), so it goes there. At an `edit` stop (`rebase-merge/amend` names
/// the commit git made), git's Continue amends HEAD keeping its message, so the message is
/// amended into HEAD here, but only while HEAD is still that commit (git's own check): a commit
/// the user made, split or reworded there is left alone. With nothing staged it's the message
/// alone (`--only`); with staged changes (3C final fix I2) they go in too, as Continue's own
/// amend would have put them (then nothing's left staged, so git's Continue doesn't amend
/// again). At the stop of a Reword row whose message a hook refused (3C final ruling), the same
/// amend applies a message typed there. An unchanged message touches nothing.
async fn use_message(cx: &mut WriteCx<'_>, message: &str) -> Result<(), GbError> {
    let root = cx.root.to_path_buf();
    let (git_dir, head, head_message) = blocking(move || {
        let repo = gix::open(&root).map_err(gix_err)?;
        let head = repo.head_id().ok().map(|id| id.to_string());
        let msg = repo.head_commit().ok().and_then(|c| c.message_raw().ok().map(|m| m.to_string()));
        Ok((repo.git_dir().to_path_buf(), head, msg))
    })
    .await?;
    let text = format!("{}\n", message.trim_end());
    let same = |old: &str| old.replace("\r\n", "\n").trim_end() == text.trim_end();
    let merge = git_dir.join("rebase-merge");
    // The commit to amend: an `edit` stop's (git's `amend`), or (3C final ruling) the commit a
    // Reword row's refused message was for, at that stop: git commits nothing there itself.
    // A refused reword's amend is the message alone: staged changes stay staged (re-review).
    let (amend, refused) = match std::fs::read_to_string(merge.join("amend")) {
        Ok(a) => (Some(a), false),
        Err(_) => (crate::in_progress::refused(&git_dir).map(|(oid, _)| oid), true),
    };
    if let Some(amend) = amend {
        let staged = cx.api.cli.run(GitInvocation::new(cx.root, ["diff", "--cached", "--name-only"])).await?;
        let nothing_staged = staged.stdout.iter().all(u8::is_ascii_whitespace);
        let at_stop = head.as_deref() == Some(amend.trim());
        if at_stop && !head_message.as_deref().is_some_and(same) {
            let args: &[&str] = if nothing_staged || refused { &["commit", "-q", "--amend", "--only", "--allow-empty", "-F", "-"] } else { &["commit", "-q", "--amend", "--allow-empty", "-F", "-"] };
            let inv = cx.git(args.iter().copied()).stdin(text.into_bytes());
            cx.run_git(inv).await?;
            cx.touch(ChangeKind::Head);
            cx.touch(ChangeKind::Index);
            if refused {
                crate::write::irebase::run::refused_message_applied(&git_dir);
            }
            // git's `amend` stays on the commit it made: an Abort keeps this one as the stop's work.
            return Ok(());
        }
        if nothing_staged {
            return Ok(());
        }
    }
    let file = if merge.is_dir() { merge.join("message") } else { git_dir.join("rebase-apply").join("final-commit") };
    if same(&std::fs::read_to_string(&file).unwrap_or_default()) {
        return Ok(());
    }
    std::fs::write(&file, &text).map_err(|e| GbError::new(GbErrorKind::Io, format!("{}: {e}", file.display())))
}

impl WriteIntent for RebaseControl {
    type Outcome = IntegrateOutcome;
    fn kind(&self) -> OpKind {
        OpKind::Rebase
    }
    fn label(&self) -> String {
        match self.action {
            RebaseAction::Continue => "continue the rebase".into(),
            RebaseAction::Skip => "skip a commit of the rebase".into(),
            RebaseAction::Abort => "abort the rebase".into(),
        }
    }
    fn undo(&self) -> Option<UndoKind> {
        None
    }
    fn runs_hooks(&self) -> bool {
        true
    }
    fn traces_hooks(&self) -> bool {
        false
    }
    fn allowed_in_progress(&self) -> bool {
        true
    }
    async fn run(&self, cx: &mut WriteCx<'_>) -> Result<IntegrateOutcome, GbError> {
        if cx.before.in_progress != Some("rebase") {
            return Err(GbError::new(GbErrorKind::InvalidInput, "No rebase is in progress"));
        }
        // --- 3C T4: GitBolt's interactive rebase ---
        // Its session (Edit messages, chip deletes), and its pins: git re-reads the saved todo
        // (`# dropped` lines included) with the comment char of this invocation.
        let session = crate::write::irebase::run::session_of_pause(cx)?;
        let pins: Vec<String> = if session.is_some() { crate::write::irebase::run::GIT_PINS.iter().map(|s| s.to_string()).collect() } else { Vec::new() };
        // --- end 3C T4 ---
        match self.action {
            RebaseAction::Continue | RebaseAction::Skip => {
                let mut step = if self.action == RebaseAction::Continue { "--continue" } else { "--skip" };
                // Review N1: if the update list couldn't be pruned at GitBolt's pause, git moves
                // the merged-in branches at the end; they go back here (only then, N6).
                let keep = put_back_of_pause(cx)?;
                // UX N: the stop this step starts at; a stop it makes has another key.
                let at = crate::write::irebase::split::stop_key(cx.root);
                // The message the user typed in the box (the UI sends one only when edited).
                let typed = self.message.as_deref().filter(|m| self.action == RebaseAction::Continue && !m.trim().is_empty());
                // --- UX F: a stop where the commit failed (the signer) can go on ---
                let ours = !self.target.is_empty();
                // --- UX L: GitBolt's Edit stop is "about to commit" ---
                let staged_stop = if session.is_some() { crate::write::irebase::edit::staged_stop(cx).await? } else { None };
                if staged_stop.is_some() && self.action == RebaseAction::Skip {
                    // git's `--skip` would reset the stop's changes away, the user's own with them.
                    return Err(GbError::new(GbErrorKind::InvalidInput, "Skip isn't offered at an Edit stop: discard its changes to leave the commit out, then Continue"));
                }
                // --- end UX L ---
                if ours {
                    sign_as_configured(cx).await?;
                }
                // UX L: what's staged is committed first (the original's author kept), or HEAD goes
                // back to git's commit when nothing changed; then git goes on.
                let at_edit = match &staged_stop {
                    Some(st) => Some(crate::write::irebase::edit::commit_at_stop(cx, st, typed).await?),
                    None => None,
                };
                // A failed commit picked again (only in GitBolt's own rebases): `Some` when it
                // was put back as `edit`, so the typed message goes in at that stop.
                let mut repicked = None;
                match self.action {
                    RebaseAction::Continue if ours => repicked = retry_failed_commit(cx, typed.is_some()).await?,
                    // git's `--skip` would pick it again: it's dropped, then git continues.
                    RebaseAction::Skip if ours && skip_failed_commit(cx).await? => step = "--continue",
                    _ => {}
                }
                // --- end UX F ---
                if let Some(m) = typed.filter(|_| repicked.is_none() && staged_stop.is_none()) {
                    use_message(cx, m).await?;
                }
                let mut args = pins;
                args.extend(["rebase".to_string(), step.into()]);
                let mut failed = None;
                use crate::write::irebase::edit::{restage, AtStop};
                let first = match at_edit {
                    // A cancel before git moves past the stop can't be timed from a test: its hook.
                    #[cfg(test)]
                    Some(AtStop::Restored) if crate::write::irebase::edit::test_hook::cancels(cx.root) => Err(GbError::new(GbErrorKind::Cancelled, "Cancelled")),
                    _ => run_rebase_stop(cx, args.clone(), &self.target, None, Vec::new(), &mut failed).await,
                };
                // UX L: back on git's commit, and git didn't get past it (a cancel, a failure): the
                // stop is staged again.
                if let (Some(st), Some(AtStop::Restored), Err(_) | Ok(IntegrateOutcome::Stopped { .. })) = (&staged_stop, at_edit, &first) {
                    restage(cx, st).await;
                }
                // --- UX F: the typed message reaches the re-picked commit ---
                let out = match (&repicked, typed) {
                    (Some(r), Some(m)) => match first {
                        Ok(IntegrateOutcome::Stopped { kind, files, warning }) => match typed_message_at_stop(cx, m).await {
                            Ok(true) if r.was_edit() => Ok(IntegrateOutcome::Stopped { kind, files, warning }),
                            // It was a pick (or a reword): no stop of the user's own here.
                            Ok(true) => {
                                failed = None;
                                run_rebase_stop(cx, args, &self.target, None, Vec::new(), &mut failed).await
                            }
                            Ok(false) => {
                                r.restore(cx.root);
                                Ok(IntegrateOutcome::Stopped { kind, files, warning })
                            }
                            // The amend failed (the signer again): paused at the commit, which a
                            // Continue with the message amends then.
                            Err(e) => {
                                r.restore(cx.root);
                                let why = format!("The typed message wasn't applied: {}. Continue with it to retry, or without it to keep the old one", e.message.trim_end_matches('.'));
                                Ok(IntegrateOutcome::Stopped { kind, files, warning: Some(why) })
                            }
                        },
                        other => {
                            // A cancel, a failure, or done without the stop: no stray `edit`.
                            r.restore(cx.root);
                            other
                        }
                    },
                    _ => first,
                }?;
                // --- end UX F ---
                if matches!(out, IntegrateOutcome::Done { .. }) {
                    put_back(cx, &keep).await?;
                }
                // --- 3C T4: an interactive rebase's deletes, or its next Edit message ---
                match &session {
                    Some(s) => crate::write::irebase::run::after_step(cx, s, out, failed.as_ref(), &at).await,
                    None => Ok(out),
                }
                // --- end 3C T4 ---
            }
            RebaseAction::Abort => {
                use crate::write::irebase::split;
                // 3C T5: a Split's pieces, never committed again, would stop the abort.
                let gone = if session.is_some() { split::clear_leftovers(cx).await? } else { Vec::new() };
                // 3C fix round 1 (I2): the work done at the stop goes into a kept stash first.
                // Fix round 2: commits on a branch, edits in a stash, both before the abort.
                let work = match &session {
                    Some(s) => match split::keep_work(cx, s).await {
                        Ok(w) => Some(w),
                        Err(e) => {
                            split::put_back(cx.root, &gone);
                            return Err(e);
                        }
                    },
                    None => None,
                };
                let mut args = pins;
                args.extend(["rebase".to_string(), "--abort".into()]);
                let inv = cx.git(args);
                let res = cx.run_git(inv).await;
                if let Err(e) = res {
                    // Fix round 3: roll back only an abort that reset nothing.
                    match &work {
                        Some(w) if !split::untouched(cx, w).await => {
                            split::finish_kept_work(cx, w, true).await;
                            for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Head, ChangeKind::State] {
                                cx.touch(k);
                            }
                            return Err(split::kept_error(e, w));
                        }
                        Some(w) => split::finish_kept_work(cx, w, false).await,
                        None => {}
                    }
                    split::put_back(cx.root, &gone);
                    return Err(e);
                }
                if let Some(w) = &work {
                    split::finish_kept_work(cx, w, true).await;
                }
                for k in [ChangeKind::Worktree, ChangeKind::Index, ChangeKind::Head, ChangeKind::State] {
                    cx.touch(k);
                }
                Ok(match work {
                    // UX N: a conflict stop's work is kept too, in the stash: nothing is counted
                    // as discarded any more.
                    Some(w) => IntegrateOutcome::Aborted { stash: w.stash, branch: w.branch },
                    None => IntegrateOutcome::ABORTED,
                })
            }
        }
    }
}

pub(crate) async fn control(api: &Api, repo: u32, worktree: &str, action: RebaseAction, message: Option<String>) -> Result<WriteResult<IntegrateOutcome>, GbError> {
    let h = api.handle(repo)?;
    let root = api.worktree_dir(&h, worktree).await?;
    let target = api.journal(&root)?.load()?.paused().and_then(|e| e.paused.as_ref().map(|p| p.target.clone())).unwrap_or_default();
    run_write(api, repo, worktree, Default::default(), RebaseControl { action, target, message }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Api, Request};
    use crate::events::AppEvent;
    use crate::git::GitCli;
    use crate::log::CommandLog;
    use crate::testing::{fixtures, isolated_git_env, TestRepo};
    use crate::write::integrate::IntegrateKind;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn api() -> (Api, tempfile::TempDir) {
        let data = tempfile::tempdir().unwrap();
        (Api::new(GitCli::new(Arc::new(CommandLog::new(5000))).with_env(isolated_git_env()), None).with_data_dir(data.path().to_path_buf()), data)
    }

    async fn open(api: &Api, path: &Path) -> u32 {
        api.dispatch(Request::OpenRepo { path: path.display().to_string() }).await.unwrap()["id"].as_u64().unwrap() as u32
    }

    fn wt(p: &Path) -> String {
        crate::platform::fs::canonicalize(p).unwrap().display().to_string()
    }

    async fn rebase(api: &Api, id: u32, r: &Path, target: &str, update_refs: Option<bool>) -> Result<serde_json::Value, crate::error::GbError> {
        api.dispatch(Request::Integrate { repo: id, worktree: wt(r), kind: IntegrateKind::Rebase, target: target.into(), update_refs, expect: Default::default(), ff_only: None, confirm: Default::default() }).await
    }

    async fn control(api: &Api, id: u32, r: &Path, action: RebaseAction) -> serde_json::Value {
        api.dispatch(Request::RebaseControl { repo: id, worktree: wt(r), action, message: None }).await.unwrap()
    }

    /// Ux round 1: Continue commits the stopped pick with the commit panel's edited message.
    #[tokio::test]
    async fn continue_uses_the_edited_message() {
        let r = rebase_conflict();
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", None).await.unwrap();
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = api.dispatch(Request::RebaseControl { repo: id, worktree: wt(r.path()), action: RebaseAction::Continue, message: Some("Fix x properly\n\nWith a body.".into()) }).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%B"]).trim_end(), "Fix x properly\n\nWith a body.");
    }

    /// An `edit` stop (started outside GitBolt): git already made the commit, so an edited
    /// message amends it before Continue.
    #[tokio::test]
    async fn continue_after_an_edit_stop_amends_the_message() {
        let r = TestRepo::new();
        r.commit("base");
        r.commit("second");
        r.git(&["-c", "sequence.editor=sed -i 1s/^pick/edit/", "rebase", "-q", "-i", "HEAD~1"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(Request::RebaseControl { repo: id, worktree: wt(r.path()), action: RebaseAction::Continue, message: Some("second, renamed".into()) }).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "second, renamed");
        assert_eq!(r.git(&["rev-list", "--count", "HEAD"]), "2");
    }

    /// Review 1: at an `edit` stop where the user committed again (a split), HEAD isn't the
    /// commit git stopped at: Continue amends nothing, whatever message it's sent.
    #[tokio::test]
    async fn an_edit_stop_where_head_moved_is_not_amended() {
        let r = TestRepo::new();
        r.commit("base");
        r.commit("second");
        r.git(&["-c", "sequence.editor=sed -i 1s/^pick/edit/", "rebase", "-q", "-i", "HEAD~1"]);
        r.git(&["commit", "-q", "--allow-empty", "-m", "split piece"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = api.dispatch(Request::RebaseControl { repo: id, worktree: wt(r.path()), action: RebaseAction::Continue, message: Some("second".into()) }).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["log", "-2", "--format=%s"]), "split piece\nsecond", "the split piece kept its own message");
    }

    fn tips(r: &TestRepo) -> Vec<String> {
        ["feature/a", "feature/b", "feature/c"].iter().map(|b| r.git(&["rev-parse", b])).collect()
    }

    /// §13.1, §17.1 "Stacks": ticked, the three branches move; undo restores every ref.
    #[tokio::test]
    async fn a_stack_moves_together_and_undo_restores_every_ref() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        let before = tips(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = rebase(&api, id, r.path(), "main", Some(true)).await.unwrap();
        // Review M3: the branch's 3 commits, not git's counter (which counts the update-ref steps).
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 3, "fastForward": false}));
        let main = r.git(&["rev-parse", "main"]);
        for b in ["feature/a", "feature/b", "feature/c"] {
            assert!(r.try_git(&["merge-base", "--is-ancestor", &main, b]).is_ok(), "{b} is on main now");
        }
        assert_eq!(res["journal"]["undo"]["label"], "rebase feature/c onto main");
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(tips(&r), before, "undo moved the stacked branches back too");
        assert_eq!(r.git(&["branch", "--show-current"]), "feature/c");
    }

    /// Unticked, only `X` moves.
    #[tokio::test]
    async fn unticked_only_the_checked_out_branch_moves() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        let before = tips(&r);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", Some(false)).await.unwrap();
        let after = tips(&r);
        assert_eq!((&after[0], &after[1]), (&before[0], &before[1]));
        assert_ne!(after[2], before[2]);
    }

    /// feature changes c.txt, main changes it too; d.txt has an uncommitted change. HEAD: feature.
    fn rebase_conflict() -> TestRepo {
        let r = TestRepo::new();
        r.write("c.txt", "base\n");
        r.write("d.txt", "d\n");
        r.git(&["add", "c.txt", "d.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        r.switch("feature");
        r.write("d.txt", "dirty\n");
        r
    }

    /// §13.2: stopped on conflicts, the rebase pauses with its autostash; Continue completes it,
    /// the autostash comes back, and Undo is one "rebase" step.
    #[tokio::test]
    async fn a_stopped_rebase_continues_to_completion() {
        let r = rebase_conflict();
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = rebase(&api, id, r.path(), "main", None).await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "stopped", "kind": "rebase", "files": 1}));
        assert_eq!(res["journal"]["paused"]["kind"], "rebase");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "d\n");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = control(&api, id, r.path(), RebaseAction::Continue).await;
        assert_eq!(res["outcome"]["status"], "done");
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(res["journal"]["undo"]["label"], "rebase feature onto main");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Fix x", "git reused the commit's message");
    }

    #[tokio::test]
    async fn abort_restores_the_branch_and_the_autostash_and_skip_drops_the_commit() {
        let r = rebase_conflict();
        let tip = r.git(&["rev-parse", "feature"]);
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", None).await.unwrap();
        let res = control(&api, id, r.path(), RebaseAction::Abort).await;
        assert_eq!(res["outcome"]["status"], "aborted");
        assert_eq!(r.git(&["rev-parse", "feature"]), tip);
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
        let git_dir = crate::platform::fs::canonicalize(r.path().join(".git")).unwrap();
        assert!(crate::journal::JournalStore::new(data.path(), &git_dir, &crate::platform::fs::canonicalize(r.path()).unwrap()).load().unwrap().undo.is_empty());

        rebase(&api, id, r.path(), "main", None).await.unwrap();
        let res = control(&api, id, r.path(), RebaseAction::Skip).await;
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["rev-parse", "feature"]), r.git(&["rev-parse", "main"]), "the only commit was skipped");
    }

    /// Re-review N1, false completion: aborted in a terminal, then reset to the target. The
    /// branch now holds the target, but the rebase didn't complete: the entry goes, the autostash
    /// comes back.
    #[tokio::test]
    async fn an_outside_abort_then_a_reset_to_the_target_settles_as_an_abort() {
        let r = rebase_conflict();
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", None).await.unwrap();
        r.git(&["rebase", "--abort"]);
        r.git(&["reset", "-q", "--hard", "main"]);
        let res = api.dispatch(Request::SettlePaused { repo: id, worktree: wt(r.path()) }).await.unwrap();
        assert!(res["journal"]["paused"].is_null());
        let git_dir = crate::platform::fs::canonicalize(r.path().join(".git")).unwrap();
        assert!(crate::journal::JournalStore::new(data.path(), &git_dir, &crate::platform::fs::canonicalize(r.path()).unwrap()).load().unwrap().undo.is_empty(), "not recorded as a rebase");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
    }

    /// Re-review N1, false abort: the target moved during the pause (a fetch, another worktree).
    /// Continue still completes the rebase it paused, onto the commit it started with.
    #[tokio::test]
    async fn a_target_that_moves_during_the_pause_doesnt_turn_continue_into_an_abort() {
        let r = rebase_conflict();
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", None).await.unwrap();
        let moved = r.git(&["commit-tree", "main^{tree}", "-p", "main", "-m", "moved"]);
        r.git(&["update-ref", "refs/heads/main", &moved]);
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = control(&api, id, r.path(), RebaseAction::Continue).await;
        assert_eq!(res["outcome"]["status"], "done");
        assert!(res["journal"]["paused"].is_null());
        assert_eq!(res["journal"]["undo"]["label"], "rebase feature onto main", "the completed rebase is still one undo step");
        assert_eq!(std::fs::read_to_string(r.path().join("d.txt")).unwrap(), "dirty\n");
    }

    /// §13.4 and the T6 review: the watcher can't see a pick (`msgnum` sits in `rebase-merge/`),
    /// so the tap carries each one. With picks slower than a tick, every step arrives, and so
    /// does a graph reload per pick.
    #[tokio::test(flavor = "multi_thread")]
    async fn each_pick_reaches_the_ui_as_a_step_and_a_graph_reload() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.hook("post-commit", "#!/bin/sh\nsleep 0.3\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let mut rx = api.subscribe();
        let res = rebase(&api, id, r.path(), "main", Some(false)).await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 3, "fastForward": false}));
        // The write's own refresh (`repoChanged`, then `refsUpdated`) comes after the run.
        let (mut steps, mut reloads, mut announced) = (Vec::new(), 0, false);
        while let Ok(ev) = rx.try_recv() {
            match ev {
                AppEvent::OpProgress { step: Some(s), .. } => steps.push((s.n, s.m)),
                AppEvent::RefsUpdated { .. } if !announced => reloads += 1,
                AppEvent::RepoChanged { .. } => announced = true,
                _ => {}
            }
        }
        assert_eq!(steps, vec![(1, 3), (2, 3), (3, 3)]);
        assert!(reloads >= 3, "a graph reload per pick, before the end's: {reloads}");
    }

    #[tokio::test]
    async fn a_detached_head_isnt_rebased() {
        let r = TestRepo::new();
        r.commit("one");
        r.git(&["switch", "-q", "--detach"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        assert_eq!(rebase(&api, id, r.path(), "main", None).await.unwrap_err().kind, crate::error::GbErrorKind::InvalidInput);
    }

    /// §17.1 "Signing": rebased commits come out signed by the user's own setup.
    #[cfg(unix)] // signing: the test's gpg/ssh-keygen wrappers are sh scripts (Windows signing is phase 2)
    #[tokio::test]
    async fn rebased_commits_are_signed() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        if !r.signing_ssh() {
            return;
        }
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", Some(false)).await.unwrap();
        let sig = r.git(&["log", "-1", "--format=%G?", "feature/c"]);
        assert!(sig == "G" || sig == "U", "{sig}");
    }

    fn journal(data: &Path, r: &TestRepo) -> crate::journal::Journal {
        let git_dir = crate::platform::fs::canonicalize(r.path().join(".git")).unwrap();
        crate::journal::JournalStore::new(data, &git_dir, &crate::platform::fs::canonicalize(r.path()).unwrap()).load().unwrap()
    }

    /// Review I1 (scenario s4): another worktree commits on its branch while the rebase is
    /// paused. The rebase's entry records only its own branch, and Undo leaves the other one be.
    #[tokio::test]
    async fn a_commit_in_another_worktree_during_the_pause_isnt_the_rebases() {
        let r = rebase_conflict();
        r.git(&["branch", "other", "main"]);
        let w = r.add_worktree("o", "other");
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        assert_eq!(rebase(&api, id, r.path(), "main", None).await.unwrap()["outcome"]["status"], "stopped");
        std::fs::write(w.join("o.txt"), "work in other\n").unwrap();
        r.git_in(&w, &["add", "o.txt"]);
        r.git_in(&w, &["commit", "-q", "-m", "other work"]);
        let other = r.git(&["rev-parse", "other"]);
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = control(&api, id, r.path(), RebaseAction::Continue).await;
        assert_eq!(res["outcome"]["status"], "done");
        let j = journal(data.path(), &r);
        assert_eq!(j.undo.last().unwrap().refs.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["refs/heads/feature"]);
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "other"]), other, "the other worktree's commit stays");
        assert!(r.git_in(&w, &["status", "--porcelain"]).is_empty());
    }

    /// `feature`: `feature work` (where `stk` points), then a `--no-ff` merge of `side`; main
    /// moves. With `evil`, the merge adds a file of its own.
    fn merged_side(evil: bool) -> TestRepo {
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("side");
        r.write("s.txt", "side\n");
        r.git(&["add", "s.txt"]);
        r.git(&["commit", "-q", "-m", "side work"]);
        r.switch("main");
        r.switch_new("feature");
        r.write("f.txt", "feature\n");
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "feature work"]);
        r.git(&["branch", "stk"]);
        r.git(&["merge", "-q", "--no-ff", "--no-commit", "side"]);
        if evil {
            r.write("evil.txt", "made in the merge\n");
            r.git(&["add", "evil.txt"]);
        }
        r.git(&["commit", "-q", "-m", "Merge side"]);
        r.switch("main");
        r.write("m.txt", "m\n");
        r.git(&["add", "m.txt"]);
        r.git(&["commit", "-q", "-m", "main moves"]);
        r.switch("feature");
        r
    }

    /// Review I2 (scenario s3): a merge with a change of its own can't be remade by git; the
    /// rebase refuses before anything moves, so the merge's own file survives and `side` stays.
    #[tokio::test]
    async fn a_merge_with_changes_of_its_own_isnt_rebased_away() {
        let r = merged_side(true);
        let (tip, side) = (r.git(&["rev-parse", "feature"]), r.git(&["rev-parse", "side"]));
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let e = rebase(&api, id, r.path(), "main", Some(true)).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::InvalidInput);
        assert!(e.message.contains("Merge side"), "{}", e.message);
        assert_eq!(r.git(&["rev-parse", "feature"]), tip);
        assert!(r.path().join("evil.txt").exists(), "the merge's own file survives");
        assert_eq!(r.git(&["rev-parse", "side"]), side);
    }

    /// Review I2: `--rebase-merges` keeps the merge; `stk` (stacked) moves, `side` (merged in)
    /// isn't stacked and stays where it was, and the count is the branch's own commits.
    #[tokio::test]
    async fn merges_survive_and_a_merged_in_branch_isnt_moved() {
        let r = merged_side(false);
        let (stk, side) = (r.git(&["rev-parse", "stk"]), r.git(&["rev-parse", "side"]));
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let p = api.dispatch(Request::IntegratePreview { repo: id, worktree: wt(r.path()), kind: IntegrateKind::Rebase, target: "main".into() }).await.unwrap();
        assert_eq!(p["stacked"], serde_json::json!([{"name": "stk", "worktree": null}]));
        let res = rebase(&api, id, r.path(), "main", Some(true)).await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 3, "fastForward": false}));
        assert_eq!(r.git(&["rev-list", "--count", "--merges", "main..feature"]), "1", "still a merge");
        assert!(r.path().join("s.txt").exists() && r.path().join("m.txt").exists());
        assert_eq!(r.git(&["rev-parse", "side"]), side, "merged in, not stacked");
        assert_ne!(r.git(&["rev-parse", "stk"]), stk);
        assert_eq!(r.git(&["rev-parse", "stk"]), r.git(&["rev-parse", "feature^1"]));
        let entry = res["journal"]["undo"]["entry"].as_u64().unwrap();
        api.dispatch(Request::Undo { repo: id, worktree: wt(r.path()), entry, confirm: None, confirm_autostash: None, without_index: None, confirm_discard: None }).await.unwrap();
        assert_eq!(r.git(&["rev-parse", "stk"]), stk);
    }

    /// Review I2 across a pause: the merged-in branch leaves git's own update list, so the
    /// Continue that ends the rebase doesn't move it either.
    #[tokio::test]
    async fn a_paused_rebase_doesnt_move_a_merged_in_branch_at_its_end() {
        let r = merged_side(false);
        r.switch("main");
        r.write("f.txt", "main's\n");
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "main touches f"]);
        r.switch("feature");
        let side = r.git(&["rev-parse", "side"]);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        assert_eq!(rebase(&api, id, r.path(), "main", Some(true)).await.unwrap()["outcome"]["status"], "stopped");
        r.write("f.txt", "resolved\n");
        r.git(&["add", "f.txt"]);
        let res = control(&api, id, r.path(), RebaseAction::Continue).await;
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(r.git(&["rev-parse", "side"]), side);
        assert_eq!(r.git(&["rev-parse", "stk"]), r.git(&["rev-parse", "feature^1"]), "the stacked one moved");
    }

    /// Review M1 (scenario s10): aborted outside, reset to the target, then new work: not the
    /// rebase's commits, so not a completion.
    #[tokio::test]
    async fn an_outside_abort_reset_and_new_commit_isnt_a_completion() {
        let r = rebase_conflict();
        let (api, data) = api();
        let id = open(&api, r.path()).await;
        rebase(&api, id, r.path(), "main", None).await.unwrap();
        r.git(&["rebase", "--abort"]);
        r.git(&["reset", "-q", "--hard", "main"]);
        r.commit("unrelated new work");
        let res = api.dispatch(Request::SettlePaused { repo: id, worktree: wt(r.path()) }).await.unwrap();
        assert!(res["journal"]["paused"].is_null());
        assert!(journal(data.path(), &r).undo.is_empty(), "not recorded as a rebase");
    }

    /// Review M2: a Cancel aborts the rebase it started; the branch and the changes are back.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_rebase_is_aborted_and_the_autostash_comes_back() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.hook("post-commit", "#!/bin/sh\nsleep 0.5\n");
        r.write("file_0.txt", "dirty\n");
        let tip = r.git(&["rev-parse", "feature/c"]);
        let (api, data) = api();
        let api = Arc::new(api);
        let id = open(&api, r.path()).await;
        let mut rx = api.subscribe();
        let (a2, p) = (api.clone(), r.path().to_path_buf());
        let run = tokio::spawn(async move { rebase(&a2, id, &p, "main", Some(false)).await });
        let op = loop {
            if let Ok(AppEvent::OpStarted { op, .. }) = rx.recv().await {
                break op;
            }
        };
        tokio::time::sleep(Duration::from_millis(700)).await;
        api.dispatch(Request::CancelOp { op }).await.unwrap();
        assert_eq!(run.await.unwrap().unwrap_err().kind, crate::error::GbErrorKind::Cancelled);
        assert_eq!(crate::in_progress::read(r.path()).unwrap(), None, "aborted, not paused");
        assert_eq!(r.git(&["rev-parse", "feature/c"]), tip);
        assert_eq!(r.git(&["branch", "--show-current"]), "feature/c");
        assert_eq!(std::fs::read_to_string(r.path().join("file_0.txt")).unwrap(), "dirty\n");
        let j = journal(data.path(), &r);
        assert!(j.undo.is_empty() && j.paused().is_none());
    }

    /// Review M3 (scenario s8): a branch behind its target fast-forwards, and says so.
    #[tokio::test]
    async fn a_branch_behind_its_target_fast_forwards() {
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("feature");
        r.switch("main");
        r.commit("m1");
        r.commit("m2");
        r.switch("feature");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = rebase(&api, id, r.path(), "main", Some(false)).await.unwrap();
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 2, "fastForward": true}));
        assert_eq!(rebase(&api, id, r.path(), "main", Some(false)).await.unwrap()["outcome"]["status"], "upToDate");
    }

    /// Review M1': a conflicted Continue commits with `--cleanup=strip`, so a `#` line of the
    /// message goes. It's still the rebase completing: Undo is one "rebase" step.
    #[tokio::test]
    async fn a_continue_that_strips_a_hash_line_still_completes() {
        let r = TestRepo::new();
        r.write("c.txt", "base\n");
        r.git(&["add", "c.txt"]);
        r.git(&["commit", "-q", "-m", "base"]);
        r.switch_new("feature");
        r.write("c.txt", "feature\n");
        r.git(&["commit", "-q", "-am", "Fix x", "-m", "#123 related"]);
        r.switch("main");
        r.write("c.txt", "main\n");
        r.git(&["commit", "-q", "-am", "main"]);
        r.switch("feature");
        assert!(r.git(&["log", "-1", "--format=%B"]).contains("#123 related"));
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        assert_eq!(rebase(&api, id, r.path(), "main", None).await.unwrap()["outcome"]["status"], "stopped");
        r.write("c.txt", "resolved\n");
        r.git(&["add", "c.txt"]);
        let res = control(&api, id, r.path(), RebaseAction::Continue).await;
        assert_eq!(res["outcome"]["status"], "done");
        assert!(!r.git(&["log", "-1", "--format=%B"]).contains("#123"), "git's strip cleanup took the line");
        assert_eq!(res["journal"]["undo"]["label"], "rebase feature onto main");
    }

    /// Review N5: upstream already has one commit's change (with more of its own, so the
    /// patch-ids differ). git drops that pick but still counts it; the outcome counts commits.
    #[tokio::test]
    async fn a_dropped_pick_isnt_counted() {
        let r = TestRepo::new();
        r.commit("base");
        r.switch_new("feature");
        r.write("a.txt", "a\n");
        r.git(&["add", "a.txt"]);
        r.git(&["commit", "-q", "-m", "Add a"]);
        r.write("b.txt", "b\n");
        r.git(&["add", "b.txt"]);
        r.git(&["commit", "-q", "-m", "Add b"]);
        r.switch("main");
        r.write("a.txt", "a\n");
        r.write("m.txt", "m\n");
        r.git(&["add", "a.txt", "m.txt"]);
        r.git(&["commit", "-q", "-m", "Upstream has a, and m"]);
        r.switch("feature");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = rebase(&api, id, r.path(), "main", Some(false)).await.unwrap();
        assert_eq!(r.git(&["rev-list", "--count", "main..feature"]), "1");
        assert_eq!(res["outcome"], serde_json::json!({"status": "done", "commits": 1, "fastForward": false}));
    }

    /// Review N6: a rebase started in a terminal with `--update-refs` moves the branches the user
    /// asked git to move; GitBolt's Continue never moves them back.
    #[tokio::test]
    async fn continuing_an_outside_rebase_keeps_its_update_refs() {
        let r = merged_side(false);
        r.switch("main");
        r.write("f.txt", "main's\n");
        r.git(&["add", "f.txt"]);
        r.git(&["commit", "-q", "-m", "main touches f"]);
        r.switch("feature");
        let side = r.git(&["rev-parse", "side"]);
        assert!(r.try_git(&["rebase", "--rebase-merges", "--update-refs", "main"]).is_err(), "stops on f.txt");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        r.write("f.txt", "resolved\n");
        r.git(&["add", "f.txt"]);
        let res = control(&api, id, r.path(), RebaseAction::Continue).await;
        assert_eq!(res["outcome"]["status"], "done");
        assert_ne!(r.git(&["rev-parse", "side"]), side, "git moved it, as the user asked");
        assert_eq!(r.git(&["rev-parse", "stk"]), r.git(&["rev-parse", "feature^1"]));
    }

    /// Untraced (review P1), a refusing `pre-rebase` is still named.
    #[tokio::test]
    async fn a_refusing_pre_rebase_hook_is_named() {
        let r = TestRepo::new();
        fixtures::stack(&r);
        r.hook("pre-rebase", "#!/bin/sh\necho 'not today' >&2\nexit 1\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let e = rebase(&api, id, r.path(), "main", Some(false)).await.unwrap_err();
        assert_eq!(e.kind, crate::error::GbErrorKind::HookFailed);
        assert_eq!(e.detail, Some(crate::error::ErrorDetail::Hook { hook: "pre-rebase".into() }));
    }

    /// Review N1: only git's own shape of `rebase-merge/update-refs` is edited.
    #[test]
    fn the_update_list_is_pruned_only_in_gits_shape() {
        let (a, b) = ("1".repeat(40), "2".repeat(40));
        let side = ("refs/heads/side".to_string(), ObjectId::from_hex(a.as_bytes()).unwrap());
        let text = format!("refs/heads/stk\n{a}\n{b}\nrefs/heads/side\n{a}\n{b}\n");
        assert_eq!(pruned_update_refs(&text, std::slice::from_ref(&side)), Some(format!("refs/heads/stk\n{a}\n{b}\n")));
        assert_eq!(pruned_update_refs("refs/heads/side\n", std::slice::from_ref(&side)), None, "not whole triples");
        assert_eq!(pruned_update_refs(&format!("refs/heads/side {a} {b}\nx\ny\n"), &[side]), None, "not ref, oid, oid");
    }

    /// Review N4: the preview names the merge a rebase would refuse, before Rebase is pressed.
    #[tokio::test]
    async fn the_preview_flags_a_lossy_merge() {
        let r = merged_side(true);
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let p = api.dispatch(Request::IntegratePreview { repo: id, worktree: wt(r.path()), kind: IntegrateKind::Rebase, target: "main".into() }).await.unwrap();
        assert!(p["lossyMerge"].as_str().is_some_and(|m| m.contains("Merge side") && m.starts_with("feature has a merge commit")), "{p}");
        let clean = merged_side(false);
        let id = open(&api, clean.path()).await;
        let p = api.dispatch(Request::IntegratePreview { repo: id, worktree: wt(clean.path()), kind: IntegrateKind::Rebase, target: "main".into() }).await.unwrap();
        assert!(p["lossyMerge"].is_null());
    }

    /// Review M5: the label names the branch the op finds when it runs.
    #[test]
    fn the_label_settles_on_the_branch_the_op_runs_on() {
        let l = BranchLabel::new(Some("feature".into()), |b| format!("rebase {b} onto main"));
        assert_eq!(l.get(), "rebase feature onto main");
        l.settle("hotfix");
        assert_eq!(l.get(), "rebase hotfix onto main");
        assert_eq!(BranchLabel::new(None, |b| format!("rebase {b} onto main")).get(), "rebase HEAD onto main");
    }

    fn copy_repo(from: &Path, to: &Path) {
        let ok = std::process::Command::new("cp").args(["-a"]).arg(from).arg(to).status().unwrap();
        assert!(ok.success());
    }

    /// §13.4, §16: a 60-commit rebase through `Integrate`, request to result, takes ≤ 1.5× bare
    /// `git rebase` on a copy of the same fixture, best of 5 each. No hook wrapping, and at most
    /// one progress event per ~100 ms. (wave test pass; `ulimit -v 4000000`, `timeout 300`.)
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "timing: run alone in the wave test pass (`cargo test -p gitbolt-core --lib -- --ignored a_60_commit`); next to the full suite GitBolt's extra processes lose to load"]
    async fn a_60_commit_rebase_runs_at_cli_speed() {
        let base = TestRepo::new();
        fixtures::rebase60(&base);
        let scratch = tempfile::tempdir().unwrap();
        let mut cli_best = Duration::MAX;
        let mut gb_best = Duration::MAX;
        // Runs alternate, so both sides see the same machine load (the full suite runs this
        // test next to hundreds of others).
        for i in 0..5 {
            let dir = scratch.path().join(format!("cli-{i}"));
            copy_repo(base.path(), &dir);
            let t = Instant::now();
            let ok = std::process::Command::new("git").current_dir(&dir).args(["rebase", "main"]).envs(isolated_git_env()).env("GIT_EDITOR", "true").output().unwrap();
            cli_best = cli_best.min(t.elapsed());
            assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));

            let dir = scratch.path().join(format!("gb-{i}"));
            copy_repo(base.path(), &dir);
            let (api, _data) = api();
            let id = open(&api, &dir).await;
            let mut rx = api.subscribe();
            let t = Instant::now();
            let res = rebase(&api, id, &dir, "main", Some(false)).await.unwrap();
            let took = t.elapsed();
            gb_best = gb_best.min(took);
            assert_eq!(res["outcome"]["commits"], 60);
            let mut progress = 0u128;
            while let Ok(ev) = rx.try_recv() {
                if matches!(ev, AppEvent::OpProgress { step: Some(_), .. }) {
                    progress += 1;
                }
            }
            assert!(progress <= took.as_millis() / 100 + 2, "{progress} progress events in {took:?}");
            assert!(api.cli.log().entries().iter().all(|e| !e.args.iter().any(|a| a.contains("hooksPath"))), "core.hooksPath is never set");
        }
        eprintln!("rebase60: GitBolt best {gb_best:?}, bare git best {cli_best:?}");
        assert!(gb_best.as_secs_f64() <= cli_best.as_secs_f64() * 1.5, "GitBolt {gb_best:?} vs bare git {cli_best:?}");
    }

    /// 2D T14 re-review m1 (`AutostashRule::Rebased`): git checks out the target first, so an
    /// untracked file where the local commits deleted a file the target still has is stashed,
    /// not left for git to refuse ("could not detach HEAD").
    #[tokio::test]
    async fn an_untracked_file_the_targets_checkout_would_overwrite_is_stashed() {
        let r = TestRepo::new();
        r.write("x.txt", "tracked x\n");
        r.write("y.txt", "y\n");
        r.git(&["add", "x.txt", "y.txt"]);
        r.git(&["commit", "-q", "-m", "Base"]);
        r.switch_new("up");
        r.write("y.txt", "y upstream\n");
        r.git(&["commit", "-q", "-am", "Upstream change"]);
        r.switch("main");
        r.git(&["rm", "-q", "--cached", "x.txt"]);
        r.git(&["commit", "-q", "-m", "Untrack x"]);
        r.write("x.txt", "my untracked x\n");
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let res = rebase(&api, id, r.path(), "up", None).await.unwrap();
        assert_eq!(res["outcome"]["status"], "done");
        assert_eq!(std::fs::read_to_string(r.path().join("y.txt")).unwrap(), "y upstream\n");
        assert_eq!(std::fs::read_to_string(r.path().join("x.txt")).unwrap(), "my untracked x\n");
        assert!(r.git(&["ls-files", "x.txt"]).is_empty(), "still untracked");
    }

    // --- 2C repo-safety (safety review 2 N2) ---
    /// R7c: `up` replaced the clean populated gitlink `sm` by a file; the rebase's first step
    /// checks `up` out, which would delete the clone whole: refused, nothing changed.
    #[tokio::test]
    async fn a_rebase_never_deletes_a_populated_submodule_the_target_replaces_by_a_file() {
        let (r, _sub) = crate::write::integrate::tests::gitlink_to_file_repo();
        let (api, _data) = api();
        let id = open(&api, r.path()).await;
        let head = r.git(&["rev-parse", "HEAD"]);
        let e = rebase(&api, id, r.path(), "up", None).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (crate::error::GbErrorKind::InvalidInput, "sm is a repository in the way of the rebase: move it first"));
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head);
        assert!(r.path().join("sm/.git").is_dir());
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }
    // --- end 2C repo-safety ---
}


// --- UX F: commit signing at a rebase's commits ---
/// Signing the way the user's global config does it (`commit.gpgsign`, `gpg.program`), with a
/// stand-in signer (never the user's own gpg): one that signs, one that fails, one that never
/// returns (a TTY pinentry nobody sees).
#[cfg(test)]
mod signing_tests {
    use super::last_command;
    use crate::api::Request;
    use crate::error::GbErrorKind;
    use crate::events::AppEvent;
    use crate::testing::{fixtures, TestRepo};
    use crate::write::irebase::run::tests::{picks, set, stay};
    use crate::write::test_support::{api, call, open, wt};
    use serde_json::{json, Value};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    /// Reads the payload, notes `GPG_TTY`, and prints a status line and a signature as gpg does.
    const SIGNS: &str = "cat >/dev/null; echo \"$GPG_TTY\" > \"$(dirname \"$0\")/tty\"; printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1 X\\n' >&2; printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'";
    const FAILS: &str = "cat >/dev/null; echo 'gpg: signing failed: No pinentry' >&2; exit 2";
    const BLOCKS: &str = "exec sleep 600";

    struct Signer {
        dir: tempfile::TempDir,
    }

    impl Signer {
        /// `commit.gpgsign=true` with a stand-in `gpg.program` in `r`'s own config.
        fn on(r: &TestRepo, body: &str) -> Self {
            let s = Self { dir: tempfile::tempdir().unwrap() };
            r.git(&["config", "commit.gpgsign", "true"]);
            r.git(&["config", "gpg.format", "openpgp"]);
            s.set(r, body);
            s
        }

        fn set(&self, r: &TestRepo, body: &str) {
            let p = self.dir.path().join(format!("gpg-{}", body.len()));
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            crate::platform::fs::set_mode(&p, 0o755).unwrap();
            r.git(&["config", "gpg.program", p.to_str().unwrap()]);
        }

        fn tty(&self) -> String {
            std::fs::read_to_string(self.dir.path().join("tty")).unwrap_or_default().trim().to_string()
        }
    }

    async fn plain_rebase(api: &crate::api::Api, id: u32, r: &TestRepo) -> Value {
        call(api, "integrate", json!({ "repo": id, "worktree": wt(r.path()), "kind": "rebase", "target": "main", "updateRefs": true })).await.unwrap()
    }

    /// GitBolt's interactive rebase of the stack, its middle commit an Edit row.
    async fn edit_rebase(api: &crate::api::Api, id: u32, r: &TestRepo) -> Value {
        let p = call(api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main" })).await.unwrap();
        let mut rows = picks(&p);
        set(&p, &mut rows, "Work on feature/b", "edit", None);
        call(api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "feature/c", "base": "main", "expect": p["expect"], "rows": rows, "chips": stay(&p) })).await.unwrap()
    }

    async fn cont(api: &crate::api::Api, id: u32, dir: &Path) -> Result<Value, crate::error::GbError> {
        call(api, "rebaseControl", json!({ "repo": id, "worktree": wt(dir), "action": "continue" })).await
    }

    fn rebasing(r: &TestRepo) -> bool {
        matches!(crate::in_progress::read(r.path()).unwrap(), Some(crate::in_progress::InProgress::Rebase { .. }))
    }

    fn subjects(r: &TestRepo) -> String {
        r.git(&["log", "--format=%s", "-4", "feature/c"])
    }

    const MOVED: &str = "Work on feature/c\nWork on feature/b\nWork on feature/a\nMain moves";

    /// The playground's case: a signer that fails stops the rebase at its first commit. The stop
    /// says why (git's message, gpg's reason), Continue with the signer still failing says it
    /// again and stays paused, and with signing turned off at the stop, Continue finishes (git
    /// kept the rebase's `-S`, and its rescheduled pick left its result staged).
    #[tokio::test]
    async fn a_failing_signer_stops_with_its_reason_and_continue_goes_on_once_signing_is_off() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let out = &plain_rebase(&api, id, &r).await["outcome"];
        assert_eq!((&out["status"], &out["files"]), (&json!("stopped"), &json!(0)), "{out}");
        let why = "The rebase stopped: gpg failed to sign the data: gpg: signing failed: No pinentry";
        assert_eq!(out["warning"], why);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!((&out["status"], &out["warning"]), (&json!("stopped"), &json!(why)), "still failing: said again, still paused");
        assert!(rebasing(&r));
        r.git(&["config", "commit.gpgsign", "false"]);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert!(!rebasing(&r));
        assert_eq!(subjects(&r), MOVED);
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/a"]), "Work on feature/a", "git's own message");
        assert!(!r.git(&["cat-file", "commit", "feature/c"]).contains("gpgsig"), "unsigned, as the config now says");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// The Edit-row case: the signer fails at the first pick; fixed, Continue picks it again,
    /// signed, stops at the Edit row, and Continue there finishes. Every write's signer saw
    /// `GPG_TTY=/dev/null` (no TTY pinentry can wait on a terminal).
    #[tokio::test]
    async fn an_edit_rebase_whose_signer_failed_resumes_signed_once_it_works() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let out = &edit_rebase(&api, id, &r).await["outcome"];
        assert!(out["warning"].as_str().is_some_and(|w| w.contains("signing failed: No pinentry")), "{out}");
        signer.set(&r, SIGNS);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "stopped", "{out}");
        assert!(out.get("warning").is_none(), "the Edit stop is a plain stop: {out}");
        // UX L: "about to commit": HEAD on the commit's parent, its change staged.
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Work on feature/a");
        assert!(!r.git(&["diff", "--cached", "--name-only"]).is_empty());
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert_eq!(subjects(&r), MOVED);
        for b in ["feature/a", "feature/b", "feature/c"] {
            assert!(r.git(&["cat-file", "commit", b]).contains("gpgsig"), "{b} is signed");
        }
        assert_eq!(signer.tty(), "/dev/null");
    }

    /// A signer that never returns at an Edit stop's Continue: the write is cancellable, the
    /// cancel leaves the rebase paused where it was, and a later Continue (signer working) finishes.
    #[tokio::test]
    async fn a_hung_signer_at_continue_cancels_to_the_same_pause() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let signer = Signer::on(&r, SIGNS);
        let api = Arc::new(api(data.path()));
        let id = open(&api, &r).await;
        assert_eq!(edit_rebase(&api, id, &r).await["outcome"]["status"], "stopped");
        signer.set(&r, BLOCKS);
        let mut rx = api.subscribe();
        let (a2, p) = (api.clone(), r.path().to_path_buf());
        let run = tokio::spawn(async move { cont(&a2, id, &p).await });
        let op = loop {
            if let Ok(AppEvent::OpStarted { op, .. }) = rx.recv().await {
                break op;
            }
        };
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(!run.is_finished(), "the signer holds it");
        api.dispatch(Request::CancelOp { op }).await.unwrap();
        let e = tokio::time::timeout(Duration::from_secs(10), run).await.expect("a cancel ends it").unwrap().unwrap_err();
        assert_eq!(e.kind, GbErrorKind::Cancelled);
        assert!(rebasing(&r), "still paused");
        let state = call(&api, "journalState", json!({ "repo": id, "worktree": wt(r.path()) })).await.unwrap();
        assert!(!state["paused"].is_null(), "the pause stands: {state}");
        assert_eq!(r.git(&["log", "-1", "--format=%s", "HEAD"]), "Work on feature/b", "at the stop, or the pick after it");
        signer.set(&r, SIGNS);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert_eq!(subjects(&r), MOVED);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// Staged changes of the user's own at a failed commit's stop aren't thrown away for a retry:
    /// git's refusal says so, and the rebase stays paused.
    #[tokio::test]
    async fn the_users_own_staged_changes_are_never_reset_for_a_retry() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        r.write("mine.txt", "mine\n");
        r.git(&["add", "mine.txt"]);
        r.git(&["config", "commit.gpgsign", "false"]);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "stopped", "{out}");
        assert!(out["warning"].as_str().is_some_and(|w| w.contains("staged changes")), "{out}");
        assert!(rebasing(&r));
        assert_eq!(std::fs::read_to_string(r.path().join("mine.txt")).unwrap(), "mine\n");
        assert!(r.git(&["diff", "--cached", "--name-only"]).contains("mine.txt"));
        // Skip refuses too, in plain words, and keeps them.
        let e = call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "skip" })).await.unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (GbErrorKind::InvalidInput, "Skip would also throw away changes you staged yourself. Unstage them first"));
        assert!(rebasing(&r));
        assert!(r.git(&["diff", "--cached", "--name-only"]).contains("mine.txt"));
    }

    async fn cont_with(api: &crate::api::Api, id: u32, dir: &Path, message: &str) -> Value {
        call(api, "rebaseControl", json!({ "repo": id, "worktree": wt(dir), "action": "continue", "message": message })).await.unwrap()
    }

    /// The coordinator's item 1: a message typed at a failed commit's stop reaches that commit
    /// (picked again, then amended at a stop of its own), and the rest of the rebase goes on.
    /// Typed while the signer still fails, the pick keeps its own command (no stray Edit stop).
    #[tokio::test]
    async fn a_message_typed_at_a_failed_commits_stop_reaches_the_commit() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        let todo = || std::fs::read_to_string(r.path().join(".git/rebase-merge/git-rebase-todo")).unwrap();
        let out = &cont_with(&api, id, r.path(), "Work on feature/a, typed\n\nWith a body.").await["outcome"];
        assert_eq!(out["status"], "stopped", "{out}");
        assert!(todo().starts_with("pick "), "still a pick: {}", todo());
        r.git(&["config", "commit.gpgsign", "false"]);
        let out = &cont_with(&api, id, r.path(), "Work on feature/a, typed\n\nWith a body.").await["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert!(!rebasing(&r));
        assert_eq!(subjects(&r), "Work on feature/c\nWork on feature/b\nWork on feature/a, typed\nMain moves");
        assert_eq!(r.git(&["log", "-1", "--format=%B", "feature/c~2"]), "Work on feature/a, typed\n\nWith a body.");
        assert_eq!(r.git(&["log", "-1", "--format=%an", "feature/c~2"]), "Ada Lovelace", "the commit's own author");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// The coordinator's item 2: Skip at a failed commit's stop skips that commit (git's own
    /// `--skip` would pick it again), its staged result gone; the rest goes on.
    #[tokio::test]
    async fn skip_at_a_failed_commits_stop_skips_it() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        r.git(&["config", "commit.gpgsign", "false"]);
        let out = &call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "skip" })).await.unwrap()["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert!(!rebasing(&r));
        assert_eq!(r.git(&["log", "--format=%s", "-3", "feature/c"]), "Work on feature/c\nWork on feature/b\nMain moves");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    // --- fix round 1 ---
    fn state(r: &TestRepo, name: &str) -> String {
        std::fs::read_to_string(r.path().join(".git/rebase-merge").join(name)).unwrap_or_default()
    }

    /// Signs its first `n` calls, then runs `then` (a stand-in for a cached passphrase expiring).
    fn signs_then(n: u32, then: &str) -> String {
        format!("c=\"$(dirname \"$0\")/calls\"; k=$(cat \"$c\" 2>/dev/null || echo 0); echo $((k+1)) > \"$c\"; if [ \"$k\" -ge {n} ]; then {then}; fi; {SIGNS}")
    }

    /// Runs `send` and cancels its op once it's under way; the write's error.
    async fn cancelled(api: &Arc<crate::api::Api>, send: impl std::future::Future<Output = Result<Value, crate::error::GbError>> + Send + 'static) -> crate::error::GbError {
        let mut rx = api.subscribe();
        let run = tokio::spawn(send);
        let op = loop {
            if let Ok(AppEvent::OpStarted { op, .. }) = rx.recv().await {
                break op;
            }
        };
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(!run.is_finished(), "the signer holds it");
        api.dispatch(Request::CancelOp { op }).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("a cancel ends it").unwrap().unwrap_err()
    }

    /// Item 1: a rebase started in a terminal is git's alone: its failed pick is never reset or
    /// re-picked by GitBolt (git's own refusal shows, the index untouched).
    #[tokio::test]
    async fn a_terminal_rebases_failed_pick_is_left_to_git() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        assert!(r.try_git(&["-c", "commit.gpgsign=true", "rebase", "main"]).is_err());
        let staged = r.git(&["diff", "--cached", "--name-only"]);
        assert!(!staged.is_empty());
        r.git(&["config", "commit.gpgsign", "false"]);
        let api = api(data.path());
        let id = open(&api, &r).await;
        let (todo, done) = (state(&r, "git-rebase-todo"), state(&r, "done"));
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "stopped", "{out}");
        assert!(out["warning"].as_str().is_some_and(|w| w.contains("staged changes")), "{out}");
        assert_eq!((state(&r, "git-rebase-todo"), state(&r, "done")), (todo, done));
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), staged);
    }

    /// Item 1: at a `break` (no commit failed there), Skip skips nothing: git's own skip, and
    /// every commit lands.
    #[tokio::test]
    async fn a_break_stop_then_skip_skips_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let api = api(data.path());
        let id = open(&api, &r).await;
        assert_eq!(edit_rebase(&api, id, &r).await["outcome"]["status"], "stopped");
        let todo = r.path().join(".git/rebase-merge/git-rebase-todo");
        std::fs::write(&todo, format!("break\n{}", std::fs::read_to_string(&todo).unwrap())).unwrap();
        // UX L: GitBolt's Continue at its Edit stop (git's own would refuse the staged change).
        assert_eq!(cont(&api, id, r.path()).await.unwrap()["outcome"]["status"], "stopped");
        assert_eq!(last_command(&state(&r, "done")), Some("break"));
        let out = &call(&api, "rebaseControl", json!({ "repo": id, "worktree": wt(r.path()), "action": "skip" })).await.unwrap()["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert_eq!(subjects(&r), MOVED, "nothing skipped");
    }

    /// Item 2: two commits by one author in the same second. A Continue cancelled while the
    /// second one was being committed isn't taken for done (HEAD's tree isn't its pick's): the
    /// next Continue picks it again, nothing dropped.
    #[tokio::test]
    async fn a_cancelled_pick_after_a_same_second_commit_of_the_same_author_isnt_dropped() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.commit("Base");
        r.switch_new("topic");
        for f in ["f1", "f2"] {
            r.write(&format!("{f}.txt"), "x\n");
            r.git(&["add", &format!("{f}.txt")]);
            r.git(&["commit", "-q", "--date=@1700000000 +0000", "-m", f]);
        }
        r.switch("main");
        r.write("main.txt", "main\n");
        r.git(&["add", "main.txt"]);
        r.git(&["commit", "-q", "-m", "Main moves"]);
        r.switch("topic");
        let signer = Signer::on(&r, &signs_then(1, BLOCKS));
        let api = Arc::new(api(data.path()));
        let id = open(&api, &r).await;
        let p = call(&api, "rebasePlan", json!({ "repo": id, "worktree": wt(r.path()), "branch": "topic", "base": "main" })).await.unwrap();
        let mut rows = picks(&p);
        set(&p, &mut rows, "f1", "edit", None);
        let out = call(&api, "interactiveRebase", json!({ "repo": id, "worktree": wt(r.path()), "branch": "topic", "base": "main", "expect": p["expect"], "rows": rows, "chips": stay(&p) })).await.unwrap();
        assert_eq!(out["outcome"]["status"], "stopped", "{out}");
        let (a2, dir) = (api.clone(), r.path().to_path_buf());
        assert_eq!(cancelled(&api, async move { cont(&a2, id, &dir).await }).await.kind, GbErrorKind::Cancelled);
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "f1");
        assert_eq!(r.git(&["log", "-1", "--format=%an %ad", "HEAD"]), r.git(&["log", "-1", "--format=%an %ad", "topic"]), "the same author ident");
        signer.set(&r, SIGNS);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert_eq!(r.git(&["log", "--format=%s", "-3", "topic"]), "f2\nf1\nMain moves");
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    /// Item 3: unstaging comes first; when git refuses it (a file changed both staged and
    /// unstaged), nothing changes, and the error says what to do.
    #[tokio::test]
    async fn a_refused_unstage_changes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        let staged = r.git(&["diff", "--cached", "--name-only"]);
        r.write(&staged, "mine too\n");
        r.git(&["config", "commit.gpgsign", "false"]);
        let (todo, done) = (state(&r, "git-rebase-todo"), state(&r, "done"));
        let e = cont(&api, id, r.path()).await.unwrap_err();
        assert_eq!(e.kind, GbErrorKind::InvalidInput);
        assert!(e.message.starts_with("The failed commit's changes couldn't be unstaged") && e.message.ends_with("Stage or discard your own changes to those files first"), "{}", e.message);
        assert_eq!((state(&r, "git-rebase-todo"), state(&r, "done")), (todo, done));
        assert!(r.path().join(".git/rebase-merge/author-script").exists());
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), staged);
        assert_eq!(std::fs::read_to_string(r.path().join(&staged)).unwrap(), "mine too\n");
    }

    /// Item 4: a sequencer file is replaced whole (temporary file, then rename), nothing left over.
    #[test]
    fn sequencer_files_are_written_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("git-rebase-todo");
        std::fs::write(&path, "pick a\n").unwrap();
        super::write_state(&path, "pick b\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "pick b\n");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary file left");
    }

    /// Item 5: a Continue with a typed message that's cancelled while git re-picks leaves no
    /// `edit` behind; the next one applies the message and finishes.
    #[tokio::test]
    async fn a_cancelled_retagged_continue_puts_the_pick_back() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let signer = Signer::on(&r, FAILS);
        let api = Arc::new(api(data.path()));
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        signer.set(&r, BLOCKS);
        let (a2, dir) = (api.clone(), r.path().to_path_buf());
        let send = async move { call(&a2, "rebaseControl", json!({ "repo": id, "worktree": wt(&dir), "action": "continue", "message": "Typed" })).await };
        assert_eq!(cancelled(&api, send).await.kind, GbErrorKind::Cancelled);
        assert!(rebasing(&r));
        let both = format!("{}{}", state(&r, "git-rebase-todo"), state(&r, "done"));
        assert!(!both.lines().any(|l| l.starts_with("edit ")), "no stray edit: {both}");
        signer.set(&r, SIGNS);
        let out = &cont_with(&api, id, r.path(), "Typed").await["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert_eq!(subjects(&r), "Work on feature/c\nWork on feature/b\nTyped\nMain moves");
    }

    /// Item 5: the re-pick signs, the typed message's amend doesn't: the stop stays (no stray
    /// `edit` line), says so, and a Continue with the message applies it then.
    #[tokio::test]
    async fn a_failed_amend_of_the_typed_message_keeps_the_stop_and_retries() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        signer.set(&r, &signs_then(1, FAILS));
        let out = &cont_with(&api, id, r.path(), "Typed").await["outcome"];
        assert_eq!(out["status"], "stopped", "{out}");
        assert!(out["warning"].as_str().is_some_and(|w| w.starts_with("The typed message wasn't applied: gpg failed to sign the data")), "{out}");
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "Work on feature/a", "picked, its own message");
        assert!(last_command(&state(&r, "done")).is_some_and(|l| l.starts_with("pick ")), "{}", state(&r, "done"));
        signer.set(&r, SIGNS);
        let out = &cont_with(&api, id, r.path(), "Typed").await["outcome"];
        assert_eq!(out["status"], "done", "{out}");
        assert_eq!(subjects(&r), "Work on feature/c\nWork on feature/b\nTyped\nMain moves");
    }

    /// Item 6: only an explicit `commit.gpgsign=false` drops the rebase's `-S`: unset (an include
    /// that doesn't match the detached HEAD reads the same) keeps signing.
    #[tokio::test]
    async fn an_unset_gpgsign_keeps_the_rebases_signing() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        fixtures::stack(&r);
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        plain_rebase(&api, id, &r).await;
        r.git(&["config", "--unset", "commit.gpgsign"]);
        let out = &cont(&api, id, r.path()).await.unwrap()["outcome"];
        assert!(out["warning"].as_str().is_some_and(|w| w.contains("gpg failed to sign")), "still signing: {out}");
        assert_eq!(state(&r, "gpg_sign_opt").trim(), "-S");
    }

    /// Items 1 and 8: a `reword` line (and a `pick`) goes back as `edit` for a typed message;
    /// fixups and squashes don't.
    #[test]
    fn a_typed_message_retags_pick_edit_and_reword_lines() {
        assert_eq!(super::as_edit("pick abc1234 # A").as_deref(), Some("edit abc1234 # A"));
        assert_eq!(super::as_edit("reword abc1234 # A").as_deref(), Some("edit abc1234 # A"));
        assert_eq!(super::as_edit("edit abc1234 # A").as_deref(), Some("edit abc1234 # A"));
        assert_eq!(super::as_edit("fixup abc1234 # A"), None);
        assert!(super::same_commit("abc1234", "abc1234ffff") && !super::same_commit("abc", "abc1234"));
    }
    // --- end fix round 1 ---

    /// A plain commit (and an amend) whose signer fails names gpg's reason.
    #[tokio::test]
    async fn a_commit_whose_signer_fails_says_why() {
        let data = tempfile::tempdir().unwrap();
        let r = TestRepo::new();
        r.commit("base");
        let _signer = Signer::on(&r, FAILS);
        let api = api(data.path());
        let id = open(&api, &r).await;
        r.write("x.txt", "x\n");
        r.git(&["add", "x.txt"]);
        for amend in [false, true] {
            let e = call(&api, "commit", json!({ "repo": id, "worktree": wt(r.path()), "summary": "x", "description": "", "amend": amend, "stageAll": false, "expect": {} })).await.unwrap_err();
            assert_eq!(e.message, "gpg failed to sign the data: gpg: signing failed: No pinentry", "amend {amend}");
        }
        assert_eq!(r.git(&["log", "--format=%s"]), "base");
    }
}
// --- end UX F ---
