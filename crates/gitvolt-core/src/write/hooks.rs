//! git prints nothing of its own when a hook fails; only the hook's output reaches stderr
//! (checked on git 2.53). So a hook-running write points `GIT_TRACE2_EVENT` at a private file and
//! reads which hook child exited non-zero: that failure becomes `HookFailed { hook }`.

use crate::error::{ErrorDetail, GbError, GbErrorKind};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

/// One write's trace2 event file: private (0600, `tempfile`) and removed when dropped.
pub(crate) struct Trace2 {
    file: tempfile::NamedTempFile,
}

impl Trace2 {
    /// In `dir` (the data dir's `tmp/`, 0700).
    pub(crate) fn new(dir: &Path) -> std::io::Result<Self> {
        Ok(Self { file: tempfile::Builder::new().prefix("trace2-").suffix(".json").tempfile_in(dir)? })
    }

    /// The variables that make git append its events to this file.
    pub(crate) fn env(&self) -> Vec<(OsString, OsString)> {
        vec![("GIT_TRACE2_EVENT".into(), self.file.path().as_os_str().to_owned())]
    }

    pub(crate) fn failed_hook(&self) -> Option<String> {
        failed_hook(&std::fs::read_to_string(self.file.path()).unwrap_or_default())
    }
}

/// Hooks whose non-zero exit aborts the git command (the others' exit codes are ignored by git).
const ABORTABLE: &[&str] = &[
    "pre-commit",
    "commit-msg",
    "prepare-commit-msg",
    "pre-merge-commit",
    "pre-rebase",
    "pre-push",
    "pre-applypatch",
    "applypatch-msg",
    "reference-transaction",
];

/// A plain non-zero exit: git reports a signal death as 128 + signal.
fn plain_failure(code: i64) -> bool {
    code != 0 && !(129..=159).contains(&code)
}

/// The first abortable hook (`child_class: "hook"`) of the top-level git (a `sid` without `/`: a
/// nested git's is `parent/child`) whose `child_exit` is a plain non-zero `code`. Children are
/// matched by (`sid`, `child_id`): a nested git process numbers its own children from 0.
pub(crate) fn failed_hook(trace: &str) -> Option<String> {
    let mut hooks: HashMap<(String, u64), String> = HashMap::new();
    for line in trace.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let (Some(sid), Some(id)) = (v["sid"].as_str(), v["child_id"].as_u64()) else { continue };
        if sid.contains('/') {
            continue;
        }
        match v["event"].as_str() {
            Some("child_start") if v["child_class"] == "hook" => {
                let name = v["hook_name"].as_str().map(str::to_string).or_else(|| {
                    v["argv"][0].as_str().and_then(|a| Path::new(a).file_name()).map(|n| n.to_string_lossy().into_owned())
                });
                if let Some(name) = name.filter(|n| ABORTABLE.contains(&n.as_str())) {
                    hooks.insert((sid.to_string(), id), name);
                }
            }
            Some("child_exit") if v["code"].as_i64().is_some_and(plain_failure) => {
                if let Some(name) = hooks.get(&(sid.to_string(), id)) {
                    return Some(name.clone());
                }
            }
            _ => {}
        }
    }
    None
}

/// `err` as `HookFailed` when the trace shows a failed hook: the message is the hook's first
/// output line (git sends hook stdout to stderr). A cancel stays a cancel.
pub(crate) fn hook_error(err: GbError, trace: &Trace2) -> GbError {
    // Only a git that ran and exited non-zero (it has stderr): a cancel, a timeout or an I/O
    // failure keeps its own error.
    if err.kind == GbErrorKind::Cancelled || err.stderr.is_none() {
        return err;
    }
    let Some(hook) = trace.failed_hook() else { return err };
    let first = err.stderr.as_deref().and_then(|s| s.lines().map(str::trim).find(|l| !l.is_empty())).map(str::to_string);
    GbError { kind: GbErrorKind::HookFailed, message: first.unwrap_or_else(|| format!("{hook} hook failed")), detail: Some(ErrorDetail::Hook { hook }), ..err }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{GitCli, GitInvocation};
    use crate::log::CommandLog;
    use crate::testing::{isolated_git_env, TestRepo};
    use crate::write::WriteToken;
    use std::sync::Arc;

    const TRACE: &str = r#"{"event":"version","sid":"s1","evt":"4"}
{"event":"child_start","sid":"s1","child_id":0,"child_class":"hook","use_shell":true,"hook_name":"pre-commit","argv":[".git/hooks/pre-commit"]}
{"event":"child_start","sid":"s1","child_id":1,"child_class":"?","argv":["git","status"]}
{"event":"child_exit","sid":"s1","child_id":1,"pid":12,"code":1,"t_rel":0.1}
{"event":"child_exit","sid":"s1","child_id":0,"pid":11,"code":1,"t_rel":0.2}
"#;

    #[test]
    fn the_failed_hook_is_the_hook_child_that_exited_non_zero() {
        assert_eq!(failed_hook(TRACE).as_deref(), Some("pre-commit"), "a non-hook child's failure doesn't count");
        assert_eq!(failed_hook(&TRACE.replace(r#""pid":11,"code":1"#, r#""pid":11,"code":0"#)), None);
        // An older git without `hook_name`: the hook's file name.
        let old = TRACE.replace(r#""hook_name":"pre-commit","#, "");
        assert_eq!(failed_hook(&old).as_deref(), Some("pre-commit"));
        // A nested git (another sid) reusing child id 0 doesn't confuse the two.
        let nested = format!("{TRACE}{}\n", r#"{"event":"child_exit","sid":"s1/s2","child_id":0,"pid":13,"code":1}"#);
        assert_eq!(failed_hook(&nested).as_deref(), Some("pre-commit"));
        assert_eq!(failed_hook("not json\n"), None);
    }

    fn hook(r: &TestRepo, name: &str, script: &str) {
        let p = r.path().join(".git/hooks").join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, script).unwrap();
        crate::platform::fs::set_mode(&p, 0o755).unwrap();
    }

    #[tokio::test]
    async fn a_failing_pre_commit_hook_is_hook_failed_with_its_first_line() {
        let r = TestRepo::new();
        r.commit("base");
        hook(&r, "pre-commit", "#!/bin/sh\necho 'lint failed: a.php' >&2\necho more >&2\nexit 1\n");
        let tmp = tempfile::tempdir().unwrap();
        let trace = Trace2::new(tmp.path()).unwrap();
        let cli = GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env());
        let inv = GitInvocation::write(&WriteToken::for_tests(), r.path(), ["commit", "--allow-empty", "-q", "-F", "-"]).stdin(b"x\n".to_vec()).envs(trace.env());
        let err = hook_error(cli.run(inv).await.unwrap_err(), &trace);
        assert_eq!(err.kind, GbErrorKind::HookFailed);
        assert_eq!(err.message, "lint failed: a.php");
        assert_eq!(err.detail, Some(ErrorDetail::Hook { hook: "pre-commit".into() }));
        assert!(err.stderr.unwrap().contains("more"), "the hook's whole output stays in stderr");
    }

    #[tokio::test]
    async fn a_passing_hook_or_a_plain_failure_is_left_alone() {
        let r = TestRepo::new();
        r.commit("base");
        hook(&r, "pre-commit", "#!/bin/sh\nexit 0\n");
        let tmp = tempfile::tempdir().unwrap();
        let trace = Trace2::new(tmp.path()).unwrap();
        let cli = GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env());
        let bad = GitInvocation::write(&WriteToken::for_tests(), r.path(), ["rev-parse", "--verify", "nope"]).envs(trace.env());
        let err = hook_error(cli.run(bad).await.unwrap_err(), &trace);
        assert_ne!(err.kind, GbErrorKind::HookFailed);
        assert!(err.detail.is_none());
    }

    #[test]
    fn only_a_plain_exit_of_an_abortable_top_level_hook_counts() {
        let post = TRACE.replace("pre-commit", "post-commit");
        assert_eq!(failed_hook(&post), None, "git ignores a post-commit hook's exit code");
        let killed = TRACE.replace(r#""pid":11,"code":1"#, r#""pid":11,"code":143"#);
        assert_eq!(failed_hook(&killed), None, "a signal death isn't a hook verdict");
        let nested = TRACE.replace(r#""sid":"s1","child_id":0"#, r#""sid":"s1/s9","child_id":0"#);
        assert_eq!(failed_hook(&nested), None, "a hook of a nested git isn't ours");
    }

    #[tokio::test]
    async fn a_failing_post_commit_hook_leaves_the_commit_a_success() {
        let r = TestRepo::new();
        r.commit("base");
        hook(&r, "post-commit", "#!/bin/sh\nexit 1\n");
        let tmp = tempfile::tempdir().unwrap();
        let trace = Trace2::new(tmp.path()).unwrap();
        let cli = GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env());
        let ok = GitInvocation::write(&WriteToken::for_tests(), r.path(), ["commit", "--allow-empty", "-q", "-m", "x"]).envs(trace.env());
        assert!(cli.run(ok).await.is_ok(), "git ignores post-commit's exit code");
        // ...and an unrelated failure in the same trace stays what it is.
        let bad = GitInvocation::write(&WriteToken::for_tests(), r.path(), ["rev-parse", "--verify", "nope"]).envs(trace.env());
        assert_ne!(hook_error(cli.run(bad).await.unwrap_err(), &trace).kind, GbErrorKind::HookFailed);
    }

    #[tokio::test]
    async fn a_timeout_stays_a_timeout_even_with_a_failed_hook_in_the_trace() {
        let r = TestRepo::new();
        r.commit("base");
        hook(&r, "pre-commit", "#!/bin/sh\nexit 1\n");
        let tmp = tempfile::tempdir().unwrap();
        let trace = Trace2::new(tmp.path()).unwrap();
        let cli = GitCli::new(Arc::new(CommandLog::new(10))).with_env(isolated_git_env());
        // The hook fails into the trace, then a separate slow write times out.
        let _ = cli.run(GitInvocation::write(&WriteToken::for_tests(), r.path(), ["commit", "--allow-empty", "-q", "-m", "x"]).envs(trace.env())).await;
        assert_eq!(trace.failed_hook().as_deref(), Some("pre-commit"));
        let slow = GitInvocation::write(&WriteToken::for_tests(), r.path(), ["-c", "alias.slow=!sleep 5", "slow"]).envs(trace.env()).timeout(Some(std::time::Duration::from_millis(200)));
        let err = hook_error(cli.run(slow).await.unwrap_err(), &trace);
        assert_ne!(err.kind, GbErrorKind::HookFailed);
        assert!(err.message.contains("timed out"), "{}", err.message);
    }
}
