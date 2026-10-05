//! A branch's `branch.<name>.*` config (spec #2 §5.3, §19 item 15): read before and after a
//! branch operation, recorded in the journal entry as `ConfigChange`s, and replayed by undo and
//! redo. GitBolt writes only the repository's own config, and only for the branch the user acted on.

use crate::error::GbError;
use crate::events::ChangeKind;
use crate::git::{GitCli, GitInvocation};
use crate::journal::ConfigChange;
use crate::write::WriteCx;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Full key (`branch.feature/x.remote`) → its values, in config order.
#[cfg_attr(not(any(test, feature = "testing")), allow(dead_code))] // first readers: the test intents; 2C T3, T4
pub(crate) type BranchConfig = BTreeMap<String, Vec<String>>;

/// `git config --null --get-regexp` records (`key\nvalue\0`) for exactly `branch.<name>.<var>`.
/// The section and the variable are lowercase in git's output; the name keeps its case. A key
/// with a dot after the name's prefix belongs to a longer branch name.
#[cfg_attr(not(any(test, feature = "testing")), allow(dead_code))] // first readers: the test intents; 2C T3, T4
pub(crate) fn parse_branch_config(raw: &[u8], name: &str) -> BranchConfig {
    let prefix = format!("branch.{name}.");
    let mut map = BranchConfig::new();
    for rec in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let rec = String::from_utf8_lossy(rec);
        // A key with no value (no `=`) comes as `key\0`: git reads it as true.
        let (key, value) = rec.split_once('\n').unwrap_or((rec.as_ref(), "true"));
        if let Some(var) = key.strip_prefix(&prefix)
            && !var.is_empty()
            && !var.contains('.')
        {
            map.entry(key.to_string()).or_default().push(value.to_string());
        }
    }
    map
}

/// The repository's own `branch.<name>.*` (a read, with the never-write environment).
#[cfg_attr(not(any(test, feature = "testing")), allow(dead_code))] // first readers: the test intents; 2C T3, T4
pub(crate) async fn branch_config(cli: &GitCli, root: &Path, name: &str) -> Result<BranchConfig, GbError> {
    let inv = GitInvocation::new(root, ["config", "--local", "--null", "--get-regexp", r"^branch\."]);
    match cli.run(inv).await {
        Ok(out) => Ok(parse_branch_config(&out.stdout, name)),
        // Exit 1 with nothing on stderr: no key matches.
        Err(e) if quiet_exit(&e) => Ok(BranchConfig::new()),
        Err(e) => Err(e),
    }
}

/// git exited non-zero and said nothing: `config`'s "no such key" (exit 1 or 5). A run that was
/// cancelled, timed out or never finished has no stderr at all (`None`), and is an error.
fn quiet_exit(e: &GbError) -> bool {
    e.stderr.as_deref().is_some_and(|s| s.trim().is_empty())
}

/// Where git itself writes a variable when it sets a branch up (`--set-upstream-to`): `remote`
/// before `merge`. Replay writes in this order so the config lists the keys as git would; the
/// rest follow by key.
fn write_rank(key: &str) -> u8 {
    match key.rsplit('.').next() {
        Some("remote") => 0,
        Some("merge") => 1,
        _ => 2,
    }
}

/// Every key whose values differ, in git's order (`remote`, `merge`, then the rest by key).
#[cfg_attr(not(any(test, feature = "testing")), allow(dead_code))] // first readers: the test intents; 2C T3, T4
pub(crate) fn changes(before: &BranchConfig, after: &BranchConfig) -> Vec<ConfigChange> {
    let keys: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    let mut keys: Vec<&String> = keys.into_iter().collect();
    keys.sort_by_key(|k| (write_rank(k), (*k).clone()));
    keys.into_iter()
        .filter_map(|k| {
            let (old, new) = (before.get(k).cloned().unwrap_or_default(), after.get(k).cloned().unwrap_or_default());
            (old != new).then(|| ConfigChange { key: k.clone(), old, new })
        })
        .collect()
}

/// Sets each change's key to its `old` values (`to_old`, undo) or its `new` ones (redo):
/// `--unset-all`, then one `--add` per value, so multi-valued keys keep their order.
pub(crate) async fn apply(cx: &mut WriteCx<'_>, changes: &[ConfigChange], to_old: bool) -> Result<(), GbError> {
    for c in changes {
        let values = if to_old { &c.old } else { &c.new };
        let unset = cx.git(["config", "--local", "--unset-all", c.key.as_str()]);
        match cx.run_git(unset).await {
            Ok(_) => {}
            // Exit 5 with nothing on stderr: the key wasn't set.
            Err(e) if quiet_exit(&e) => {}
            Err(e) => return Err(e),
        }
        for v in values {
            let add = cx.git(["config", "--local", "--add", c.key.as_str(), v.as_str()]);
            cx.run_git(add).await?;
        }
    }
    if !changes.is_empty() {
        cx.touch(ChangeKind::Config);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(pairs: &[(&str, &str)]) -> Vec<u8> {
        pairs.iter().flat_map(|(k, v)| format!("{k}\n{v}\0").into_bytes()).collect()
    }

    /// Review Focus 2: a dotted name's keys aren't split at its dots.
    #[test]
    fn parse_branch_config_keeps_dotted_names() {
        let raw = rec(&[
            ("branch.release.1/ü-x.remote", "origin"),
            ("branch.release.1/ü-x.merge", "refs/heads/release.1/ü-x"),
            ("branch.release.remote", "other"),
            ("branch.release.1/ü-x.extra.thing", "not a key of this branch"),
            ("branch.main.remote", "origin"),
            ("branch.release.1/ü-x.pushremote", "a"),
            ("branch.release.1/ü-x.pushremote", "b"),
        ]);
        let c = parse_branch_config(&raw, "release.1/ü-x");
        assert_eq!(c.len(), 3, "{c:?}");
        assert_eq!(c["branch.release.1/ü-x.remote"], ["origin"]);
        assert_eq!(c["branch.release.1/ü-x.pushremote"], ["a", "b"], "multi-valued keys keep their order");
        assert!(parse_branch_config(&raw, "release").contains_key("branch.release.remote"));
        assert_eq!(parse_branch_config(&raw, "release").len(), 1);
    }

    #[test]
    fn a_key_with_no_value_is_true() {
        let mut raw = rec(&[("branch.x.remote", "origin")]);
        raw.extend_from_slice(b"branch.x.rebase\0");
        let c = parse_branch_config(&raw, "x");
        assert_eq!(c["branch.x.rebase"], ["true"]);
        assert_eq!(c["branch.x.remote"], ["origin"]);
    }

    #[test]
    fn changes_list_every_key_that_differs() {
        let before: BranchConfig = [("branch.x.remote".to_string(), vec!["origin".to_string()])].into();
        let after: BranchConfig = [("branch.x.remote".to_string(), vec!["up".to_string()]), ("branch.x.merge".to_string(), vec!["refs/heads/x".to_string()])].into();
        let c = changes(&before, &after);
        assert_eq!(c, vec![
            ConfigChange { key: "branch.x.remote".into(), old: vec!["origin".into()], new: vec!["up".into()] },
            ConfigChange { key: "branch.x.merge".into(), old: vec![], new: vec!["refs/heads/x".into()] },
        ]);
        assert!(changes(&after, &after).is_empty());
        assert_eq!(changes(&after, &BranchConfig::new()).len(), 2, "a removed section: every key goes");
    }

    /// Review I1: only git's quiet exit means "no keys"; a cancelled or timed-out run (no
    /// stderr) isn't an empty config, or undo would unset every key the branch has.
    #[test]
    fn only_a_quiet_exit_means_no_keys() {
        use crate::error::GbErrorKind;
        let with = |stderr: Option<&str>| GbError { stderr: stderr.map(str::to_string), ..GbError::new(GbErrorKind::Other, "git config failed") };
        assert!(quiet_exit(&with(Some(""))));
        assert!(quiet_exit(&with(Some("\n"))));
        assert!(!quiet_exit(&with(None)), "cancelled, timed out: an error");
        assert!(!quiet_exit(&GbError::new(GbErrorKind::Cancelled, "Cancelled")));
        assert!(!quiet_exit(&with(Some("error: could not lock config file .git/config"))));
    }

    #[tokio::test]
    async fn branch_config_reads_one_branch_and_is_empty_when_none() {
        let r = crate::testing::TestRepo::new();
        r.commit("c");
        let cli = crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(50))).with_env(crate::testing::isolated_git_env());
        assert!(branch_config(&cli, r.path(), "x").await.unwrap().is_empty());
        r.git(&["config", "branch.x.remote", "origin"]);
        r.git(&["config", "branch.x.merge", "refs/heads/x"]);
        r.git(&["config", "branch.y.remote", "origin"]);
        let c = branch_config(&cli, r.path(), "x").await.unwrap();
        assert_eq!(c.keys().collect::<Vec<_>>(), ["branch.x.merge", "branch.x.remote"]);
    }
}
