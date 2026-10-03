//! The interactive rebase's todo (spec #3 §3.3), built from the editor's plan. Pure: no git and no
//! files. The intent writes `Todo::files` and the todo into the session directory.

use super::types::{ChipAt, ChipPlan, RebaseRowAction as A};
use crate::error::{GbError, GbErrorKind};
use crate::write::names::branch_name_error;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// One row as the intent hands it over: the request's row, plus what the commit says.
#[derive(Debug, Clone)]
pub(crate) struct PlannedRow {
    pub oid: String,
    pub action: A,
    pub message: Option<String>,
    /// The commit's own message (`%B`).
    pub original: String,
    /// The commit's `%ae %at %s`. The reword script checks HEAD against it (Ruling 3).
    pub guard: String,
}

#[derive(Debug, Clone)]
pub(crate) struct TodoPlan {
    /// The rebased branch (short): git moves it itself, so its chip gets no line.
    pub branch: String,
    /// The base's oid: a chip there gets its `update-ref` before the first pick.
    pub base: String,
    /// Newest first, as the editor shows them.
    pub rows: Vec<PlannedRow>,
    pub chips: Vec<ChipPlan>,
    /// Every local branch's tip (short → oid).
    pub tips: BTreeMap<String, String>,
    /// Branches that can't move (short → why).
    pub locked: BTreeMap<String, String>,
    /// The session directory the message files and scripts go in.
    pub dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Todo {
    /// `git-rebase-todo`, verbatim.
    pub text: String,
    /// Written before git runs: (path, contents).
    pub files: Vec<(PathBuf, String)>,
    /// Edit rows' new messages: original oid → message file, applied at that stop (T4).
    pub edit_messages: BTreeMap<String, PathBuf>,
    /// Branches (short) git moves or creates with `update-ref` lines, in todo order.
    pub update_refs: Vec<String>,
    /// Branches (short) deleted once the rebase completes.
    pub deletes: Vec<String>,
}

fn invalid(m: impl Into<String>) -> GbError {
    GbError::new(GbErrorKind::InvalidInput, m)
}

fn short(oid: &str) -> &str {
    // Chip oids come over IPC unvalidated: never slice inside a char.
    oid.get(..7).unwrap_or(oid)
}

fn subject(message: &str) -> &str {
    message.lines().next().unwrap_or("").trim()
}

fn norm(m: &str) -> String {
    m.replace("\r\n", "\n").trim_end().to_string()
}

/// `'…'` for sh: each `'` inside becomes `'\''`.
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A squash group's default message: the messages, oldest first, separated by blank lines
/// (spec #3 §3.3). The UI's `mergedMessage` (T8) is the same function.
pub(crate) fn merged(messages: &[&str]) -> String {
    let parts: Vec<String> = messages.iter().map(|m| norm(m)).filter(|m| !m.is_empty()).collect();
    format!("{}\n", parts.join("\n\n"))
}

/// The reword's exec script (Ruling 3): the amend runs only while HEAD is still the target. A
/// Skip at the target leaves HEAD on the commit before it, which keeps its message.
fn reword_script(oid: &str, guard: &str, msg: &Path) -> String {
    format!(
        "#!/bin/sh\n# GitBolt: the new message of {short} (interactive rebase)\n[ \"$(git log -1 --no-show-signature --format='%ae %at %s')\" = {guard} ] || exit 0\nexec git commit -q --amend --only --allow-empty -F {msg}\n",
        short = short(oid),
        guard = sh_quote(guard),
        msg = sh_quote(&msg.display().to_string()),
    )
}

/// The rows from one target up to the next: the target, then the rows that fold into it.
struct Group {
    target: usize,
    folded: Vec<usize>,
}

/// The `update-ref` lines at one point of the todo (`None`: before the first pick), by name.
fn refs_at(at: &BTreeMap<Option<usize>, Vec<String>>, place: Option<usize>, text: &mut String, update_refs: &mut Vec<String>) {
    let mut names = at.get(&place).cloned().unwrap_or_default();
    names.sort();
    for b in names {
        text.push_str(&format!("update-ref refs/heads/{b}\n"));
        update_refs.push(b);
    }
}

fn dropped(r: &PlannedRow) -> String {
    format!("# dropped {} {}\n", r.oid, subject(&r.original))
}

pub(crate) fn build(plan: &TodoPlan) -> Result<Todo, GbError> {
    let mut seen = HashSet::new();
    for r in &plan.rows {
        if !seen.insert(r.oid.as_str()) {
            return Err(invalid(format!("{} is in the plan twice", short(&r.oid))));
        }
    }
    let replay: Vec<&PlannedRow> = plan.rows.iter().rev().collect();
    let mut groups: Vec<Group> = Vec::new();
    // Each row's group, for the chips (None: before the first pick).
    let mut owner: HashMap<&str, Option<usize>> = HashMap::new();
    for (i, r) in replay.iter().enumerate() {
        match r.action {
            A::Drop => {}
            A::Squash | A::Fixup => {
                let Some(g) = groups.last_mut() else {
                    return Err(invalid(format!("Nothing below {} {} to squash it into", short(&r.oid), subject(&r.original))));
                };
                let target = replay[g.target];
                if target.action == A::Edit {
                    return Err(invalid(format!(
                        "{} can't fold into {}: an Edit row stops before the commits above it fold in",
                        short(&r.oid),
                        short(&target.oid)
                    )));
                }
                g.folded.push(i);
            }
            A::Pick | A::Reword | A::Edit => groups.push(Group { target: i, folded: Vec::new() }),
        }
        owner.insert(r.oid.as_str(), groups.len().checked_sub(1));
    }
    if groups.is_empty() {
        return Err(invalid("Every commit is dropped: keep at least one, or cancel the rebase"));
    }

    // Chips: where each `update-ref` goes.
    let mut at: BTreeMap<Option<usize>, Vec<String>> = BTreeMap::new();
    let mut deletes = Vec::new();
    let mut named = HashSet::new();
    let top = Some(groups.len() - 1);
    for c in &plan.chips {
        if !named.insert(c.branch.as_str()) {
            return Err(invalid(format!("{} has two chips", c.branch)));
        }
        let place = |oid: &str| -> Result<Option<usize>, GbError> {
            if oid == plan.base {
                return Ok(None);
            }
            owner.get(oid).copied().ok_or_else(|| invalid(format!("{}: {} isn't one of the rebased commits", c.branch, short(oid))))
        };
        // The rebased branch: git moves it to the last group's commit itself, so its chip gets no
        // line, and anywhere else is refused rather than ignored.
        if c.branch == plan.branch {
            if matches!(&c.at, ChipAt::Row(o) if place(o)? == top) {
                continue;
            }
            return Err(invalid(format!("{} is the rebased branch: it stays on the top commit", c.branch)));
        }
        let tip = plan.tips.get(&c.branch);
        // 3D's Stay: the branch stays where it is, locked or not: no line, never moved.
        if c.at == ChipAt::Stay {
            if tip.is_none() {
                return Err(invalid(format!("{} doesn't exist", c.branch)));
            }
            continue;
        }
        if let Some(why) = plan.locked.get(&c.branch) {
            if matches!(&c.at, ChipAt::Row(o) if Some(o) == tip) {
                continue;
            }
            return Err(invalid(format!("{} can't move: {why}", c.branch)));
        }
        match &c.at {
            ChipAt::Delete | ChipAt::Row(_) if tip.is_none() => return Err(invalid(format!("{} doesn't exist", c.branch))),
            ChipAt::Delete => deletes.push(c.branch.clone()),
            ChipAt::Row(oid) => at.entry(place(oid)?).or_default().push(c.branch.clone()),
            ChipAt::New(_) if tip.is_some() => return Err(invalid(format!("{} already exists", c.branch))),
            ChipAt::New(oid) => {
                if branch_name_error(&c.branch).is_some() {
                    return Err(invalid(format!("\"{}\" isn't a valid branch name", c.branch)));
                }
                at.entry(place(oid)?).or_default().push(c.branch.clone());
            }
            ChipAt::Stay => {} // handled above
        }
    }

    let mut text = format!("# GitBolt: interactive rebase of {} ({} commits)\n", plan.branch, plan.rows.len());
    let mut files = Vec::new();
    let mut edit_messages = BTreeMap::new();
    let mut update_refs = Vec::new();
    let mut n = 0usize;
    for r in &replay[..groups[0].target] {
        text.push_str(&dropped(r));
    }
    refs_at(&at, None, &mut text, &mut update_refs);
    for (k, g) in groups.iter().enumerate() {
        let t = replay[g.target];
        let verb = if t.action == A::Edit { "edit" } else { "pick" };
        text.push_str(&format!("{verb} {} {}\n", t.oid, subject(&t.original)));
        // The rows up to the next target: this group's folds, and the drops among them. A chip on
        // one of those drops lands after this group's lines: it "moves down".
        let end = groups.get(k + 1).map_or(replay.len(), |next| next.target);
        for r in &replay[g.target + 1..end] {
            match r.action {
                A::Drop => text.push_str(&dropped(r)),
                _ => text.push_str(&format!("fixup {} {}\n", r.oid, subject(&r.original))),
            }
        }
        let mut messages: Vec<&str> = vec![t.original.as_str()];
        messages.extend(g.folded.iter().map(|&i| replay[i]).filter(|r| r.action == A::Squash).map(|r| r.message.as_deref().unwrap_or(&r.original)));
        let wanted = match &t.message {
            Some(m) => Some(m.clone()),
            None if messages.len() > 1 => Some(merged(&messages)),
            None => None,
        };
        if let Some(m) = wanted.filter(|m| norm(m) != norm(&t.original)) {
            if m.trim().is_empty() {
                return Err(invalid(format!("Write a message for {}", short(&t.oid))));
            }
            n += 1;
            let msg = plan.dir.join(format!("{n}.msg"));
            files.push((msg.clone(), format!("{}\n", norm(&m))));
            if t.action == A::Edit {
                edit_messages.insert(t.oid.clone(), msg);
            } else {
                let script = plan.dir.join(format!("{n}.sh"));
                files.push((script.clone(), reword_script(&t.oid, &t.guard, &msg)));
                text.push_str(&format!("exec sh {}\n", sh_quote(&script.display().to_string())));
            }
        }
        refs_at(&at, Some(k), &mut text, &mut update_refs);
    }
    Ok(Todo { text, files, edit_messages, update_refs, deletes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GbErrorKind;
    use crate::write::irebase::types::{ChipAt, ChipPlan, RebaseRowAction as A};

    fn oid(c: char) -> String {
        c.to_string().repeat(40)
    }

    /// Row `c` ("C" for 'c'), its message "C\n", authored at a distinct time.
    fn row(c: char, action: A) -> PlannedRow {
        let s = c.to_ascii_uppercase();
        PlannedRow { oid: oid(c), action, message: None, original: format!("{s}\n"), guard: format!("ada@example.com {} {s}", c as u32) }
    }

    fn chip(branch: &str, at: ChipAt) -> ChipPlan {
        ChipPlan { branch: branch.into(), at }
    }

    /// Rows newest first; branches `a`, `b`, `c` (the rebased one) at rows 'a', 'b', 'c'.
    fn plan(rows: Vec<PlannedRow>, chips: Vec<ChipPlan>) -> TodoPlan {
        let tips = [("a", 'a'), ("b", 'b'), ("c", 'c')].iter().map(|(b, c)| (b.to_string(), oid(*c))).collect();
        TodoPlan { branch: "c".into(), base: oid('0'), rows, chips, tips, locked: Default::default(), dir: "/data dir/s1".into() }
    }

    /// The todo's lines after its header comment.
    fn body(t: &Todo) -> Vec<String> {
        t.text.lines().skip(1).map(str::to_string).collect()
    }

    fn pick(c: char) -> String {
        format!("pick {} {}", oid(c), c.to_ascii_uppercase())
    }

    const EXEC_1: &str = "exec sh '/data dir/s1/1.sh'";

    #[test]
    fn picks_replay_oldest_first() {
        let t = build(&plan(vec![row('c', A::Pick), row('b', A::Pick), row('a', A::Pick)], vec![])).unwrap();
        assert_eq!(body(&t), [pick('a'), pick('b'), pick('c')]);
        assert!(t.files.is_empty() && t.update_refs.is_empty() && t.deletes.is_empty());
    }

    #[test]
    fn a_reword_amends_through_its_guarded_script() {
        let mut b = row('b', A::Reword);
        b.message = Some("B, reworded\n\nBody".into());
        let t = build(&plan(vec![row('c', A::Pick), b, row('a', A::Pick)], vec![])).unwrap();
        assert_eq!(body(&t), [pick('a'), pick('b'), EXEC_1.to_string(), pick('c')]);
        let file = |name: &str| t.files.iter().find(|(p, _)| p.ends_with(name)).unwrap_or_else(|| panic!("{name}")).1.clone();
        assert_eq!(file("1.msg"), "B, reworded\n\nBody\n");
        let script = file("1.sh");
        assert!(script.contains("[ \"$(git log -1 --no-show-signature --format='%ae %at %s')\" = 'ada@example.com 98 B' ] || exit 0"), "{script}");
        assert!(script.contains("exec git commit -q --amend --only --allow-empty -F '/data dir/s1/1.msg'"), "{script}");
    }

    #[test]
    fn an_unchanged_message_adds_no_exec() {
        let mut b = row('b', A::Reword);
        b.message = Some("B\r\n\n".into());
        let t = build(&plan(vec![b, row('a', A::Pick)], vec![])).unwrap();
        assert_eq!(body(&t), [pick('a'), pick('b')]);
    }

    /// Squash and Fixup fold down into the nearest row below that isn't dropped; the merged
    /// default is the target's message, then each Squash row's (never a Fixup's), oldest first.
    #[test]
    fn a_squash_group_merges_its_messages_and_skips_fixups_and_drops() {
        let rows = vec![row('e', A::Squash), row('d', A::Fixup), row('c', A::Drop), row('b', A::Squash), row('a', A::Pick)];
        let t = build(&plan(rows, vec![])).unwrap();
        assert_eq!(
            body(&t),
            [pick('a'), format!("fixup {} B", oid('b')), format!("# dropped {} C", oid('c')), format!("fixup {} D", oid('d')), format!("fixup {} E", oid('e')), EXEC_1.to_string()]
        );
        assert_eq!(t.files.iter().find(|(p, _)| p.ends_with("1.msg")).unwrap().1, "A\n\nB\n\nE\n");
        // The script guards on the target's author and subject: after the fixups HEAD keeps A's.
        assert!(t.files.iter().any(|(p, s)| p.ends_with("1.sh") && s.contains("'ada@example.com 97 A'")));
    }

    #[test]
    fn a_fixup_only_group_keeps_the_targets_message() {
        let t = build(&plan(vec![row('b', A::Fixup), row('a', A::Pick)], vec![])).unwrap();
        assert_eq!(body(&t), [pick('a'), format!("fixup {} B", oid('b'))]);
        assert!(t.files.is_empty());
    }

    #[test]
    fn a_reword_target_uses_its_own_edited_message() {
        let mut a = row('a', A::Reword);
        a.message = Some("A and B together".into());
        let t = build(&plan(vec![row('b', A::Squash), a], vec![])).unwrap();
        assert_eq!(body(&t), [pick('a'), format!("fixup {} B", oid('b')), EXEC_1.to_string()]);
        assert_eq!(t.files.iter().find(|(p, _)| p.ends_with("1.msg")).unwrap().1, "A and B together\n");
    }

    #[test]
    fn an_edit_row_stops_and_keeps_its_new_message_for_the_stop() {
        let mut b = row('b', A::Edit);
        b.message = Some("B at the stop".into());
        let t = build(&plan(vec![b, row('a', A::Pick)], vec![])).unwrap();
        assert_eq!(body(&t), [pick('a'), format!("edit {} B", oid('b'))]);
        assert_eq!(t.edit_messages.get(&oid('b')).unwrap(), std::path::Path::new("/data dir/s1/1.msg"));
    }

    #[test]
    fn refusals() {
        let msg = |rows: Vec<PlannedRow>| {
            let e = build(&plan(rows, vec![])).unwrap_err();
            assert_eq!(e.kind, GbErrorKind::InvalidInput);
            e.message
        };
        assert!(msg(vec![row('b', A::Drop), row('a', A::Drop)]).starts_with("Every commit is dropped"));
        assert!(msg(vec![row('b', A::Pick), row('a', A::Squash)]).starts_with("Nothing below aaaaaaa A"));
        assert!(msg(vec![row('b', A::Fixup), row('a', A::Edit)]).contains("an Edit row"));
        assert!(msg(vec![row('a', A::Pick), row('a', A::Pick)]).contains("twice"));
        // Drops don't open a group: a Squash with only drops below it has nothing to fold into,
        // and a Fixup reaches an Edit target through a drop.
        assert!(msg(vec![row('b', A::Squash), row('a', A::Drop)]).starts_with("Nothing below bbbbbbb B"));
        assert!(msg(vec![row('c', A::Fixup), row('b', A::Drop), row('a', A::Edit)]).contains("an Edit row"));
        let mut b = row('b', A::Reword);
        b.message = Some("  \n".into());
        assert!(msg(vec![b, row('a', A::Pick)]).starts_with("Write a message for bbbbbbb"));
    }

    #[test]
    fn chips_follow_their_rows_through_folds_and_drops() {
        // Newest first: e dropped, d squashed into c, c picked, b and a dropped.
        let rows = vec![row('e', A::Drop), row('d', A::Squash), row('c', A::Pick), row('b', A::Drop), row('a', A::Drop)];
        let chips = vec![
            chip("on-squash", ChipAt::New(oid('d'))), // d folds into c: after c's group
            chip("on-drop", ChipAt::New(oid('e'))),   // e dropped: the group below it, c's
            chip("a", ChipAt::Row(oid('b'))),         // b dropped and nothing survives below: before the first pick
            chip("b", ChipAt::Row(oid('0'))),         // the base: before the first pick
            chip("c", ChipAt::Row(oid('c'))),         // the rebased branch: git moves it, no line
        ];
        let t = build(&plan(rows, chips)).unwrap();
        assert_eq!(
            body(&t),
            [
                format!("# dropped {} A", oid('a')),
                format!("# dropped {} B", oid('b')),
                "update-ref refs/heads/a".to_string(),
                "update-ref refs/heads/b".to_string(),
                pick('c'),
                format!("fixup {} D", oid('d')),
                format!("# dropped {} E", oid('e')),
                EXEC_1.to_string(), // "C\n\nD\n", the merged default
                "update-ref refs/heads/on-drop".to_string(),
                "update-ref refs/heads/on-squash".to_string(),
            ]
        );
        assert_eq!(t.update_refs, ["a", "b", "on-drop", "on-squash"]);
    }

    #[test]
    fn deletes_new_branches_and_locked_chips() {
        let rows = || vec![row('c', A::Pick), row('b', A::Pick), row('a', A::Pick)];
        let t = build(&plan(rows(), vec![chip("a", ChipAt::Delete), chip("b", ChipAt::Row(oid('b')))])).unwrap();
        assert_eq!(t.deletes, ["a"]);
        assert_eq!(body(&t), [pick('a'), pick('b'), "update-ref refs/heads/b".to_string(), pick('c')]);
        let err = |chips: Vec<ChipPlan>, locked: &[(&str, &str)]| {
            let mut p = plan(rows(), chips);
            p.locked = locked.iter().map(|(b, w)| (b.to_string(), w.to_string())).collect();
            build(&p).map(|t| body(&t)).map_err(|e| e.message)
        };
        assert_eq!(err(vec![chip("b", ChipAt::New(oid('a')))], &[]).unwrap_err(), "b already exists");
        assert!(err(vec![chip("x y", ChipAt::New(oid('a')))], &[]).unwrap_err().contains("isn't a valid branch name"));
        assert!(err(vec![chip("gone", ChipAt::Row(oid('a')))], &[]).unwrap_err().contains("doesn't exist"));
        assert!(err(vec![chip("a", ChipAt::Row(oid('9')))], &[]).unwrap_err().contains("isn't one of the rebased commits"));
        // A locked chip on its own tip stays where it is, with no line; anything else is refused.
        assert_eq!(err(vec![chip("a", ChipAt::Row(oid('a')))], &[("a", "checked out in /w")]).unwrap(), [pick('a'), pick('b'), pick('c')]);
        assert_eq!(err(vec![chip("a", ChipAt::Delete)], &[("a", "checked out in /w")]).unwrap_err(), "a can't move: checked out in /w");
        assert!(err(vec![chip("b", ChipAt::Row(oid('b'))), chip("b", ChipAt::Delete)], &[]).unwrap_err().contains("two chips"));
    }

    /// 3D's Stay: no line, no delete, locked or not; a branch that doesn't exist is refused.
    #[test]
    fn a_stay_chip_gets_no_line() {
        let rows = || vec![row('c', A::Pick), row('b', A::Pick), row('a', A::Pick)];
        let mut p = plan(rows(), vec![chip("a", ChipAt::Stay), chip("b", ChipAt::Stay)]);
        p.locked = [("a".to_string(), "checked out in /w".to_string())].into();
        let t = build(&p).unwrap();
        assert_eq!(body(&t), [pick('a'), pick('b'), pick('c')]);
        assert!(t.update_refs.is_empty() && t.deletes.is_empty());
        assert_eq!(build(&plan(rows(), vec![chip("gone", ChipAt::Stay)])).unwrap_err().message, "gone doesn't exist");
        assert_eq!(serde_json::to_value(ChipAt::Stay).unwrap(), serde_json::json!({ "kind": "stay" }));
    }

    /// The rebased branch (`c`) stays on the last group's commit, git moving it: its chip there
    /// gets no line, and anywhere else, Delete or a second chip is refused.
    #[test]
    fn the_rebased_branchs_chip_stays_on_top() {
        let run = |rows: Vec<PlannedRow>, chips: Vec<ChipPlan>| build(&plan(rows, chips)).map(|t| body(&t)).map_err(|e| e.message);
        let picks = || vec![row('c', A::Pick), row('b', A::Pick), row('a', A::Pick)];
        assert_eq!(run(picks(), vec![chip("c", ChipAt::Row(oid('c')))]).unwrap(), [pick('a'), pick('b'), pick('c')]);
        // The effective top: a dropped or folded newest row belongs to the last group.
        assert!(run(vec![row('c', A::Drop), row('b', A::Pick), row('a', A::Pick)], vec![chip("c", ChipAt::Row(oid('c')))]).is_ok());
        assert!(run(vec![row('c', A::Fixup), row('b', A::Pick), row('a', A::Pick)], vec![chip("c", ChipAt::Row(oid('b')))]).is_ok());
        for at in [ChipAt::Row(oid('b')), ChipAt::Row(oid('0')), ChipAt::Delete, ChipAt::New(oid('c'))] {
            assert_eq!(run(picks(), vec![chip("c", at)]).unwrap_err(), "c is the rebased branch: it stays on the top commit");
        }
        assert!(run(picks(), vec![chip("c", ChipAt::Row(oid('c'))), chip("c", ChipAt::Row(oid('c')))]).unwrap_err().contains("two chips"));
    }

    #[test]
    fn short_never_splits_a_char() {
        assert_eq!(short("ééééé"), "ééééé"); // byte 7 falls inside a char: the whole string
        assert_eq!(short("abc"), "abc");
        assert_eq!(short(&oid('a')), "aaaaaaa");
    }

    /// Review Focus 3: a guard with a quote, and paths with a space and a quote.
    #[test]
    fn quoting_survives_quotes_and_spaces() {
        assert_eq!(sh_quote("it's a $(x) `y`"), r#"'it'\''s a $(x) `y`'"#);
        let mut b = row('b', A::Reword);
        b.guard = "o'brien@example.com 5 Don't".into();
        b.message = Some("New".into());
        let mut p = plan(vec![b, row('a', A::Pick)], vec![]);
        p.dir = "/it's here/s".into();
        let t = build(&p).unwrap();
        assert!(t.text.contains(r"exec sh '/it'\''s here/s/1.sh'"), "{}", t.text);
        let script = &t.files.iter().find(|(p, _)| p.ends_with("1.sh")).unwrap().1;
        assert!(script.contains(r"= 'o'\''brien@example.com 5 Don'\''t' ]"), "{script}");
    }

    #[test]
    fn merged_drops_empty_messages_and_normalises() {
        assert_eq!(merged(&["A\r\n", "", "B\n\n"]), "A\n\nB\n");
    }
}
