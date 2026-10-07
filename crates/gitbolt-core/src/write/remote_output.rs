//! Servers run scripts on push and print `remote:` lines (a hook's rejection, a CI link, the
//! user's integration-rebase script). GitBolt keeps every one, whole, on success as well as on
//! failure, in the op's Activity entry, and counts the ones worth reading for the toast.

use crate::api::Api;
use crate::error::GbError;
use crate::events::AppEvent;
use crate::git::GitOutput;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteKind {
    Info,
    /// Kept in the log, never counted: forge links with their URL, blank lines, pack meters.
    Boilerplate,
    /// Failure-looking: the toast becomes a warning that stays.
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteLine {
    pub text: String,
    pub kind: RemoteKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteSummary {
    /// Info + Warning lines: the toast's "Server output (N lines)".
    pub lines: u32,
    /// The first Warning line, which a warning toast quotes.
    pub warning: Option<String>,
}

/// §12.4's failure words, matched case-insensitively anywhere in the line.
const WARNINGS: [&str; 10] = ["error", "fatal", "fail", "reject", "denied", "conflict", "could not", "cannot", "abort", "warning"];
/// Forge lines followed by their URL line.
const LINK_INTROS: [&str; 3] = ["To create a merge request for ", "View merge request for ", "Create a pull request for "];
/// git's own pack messages from the remote side (Deviation 6).
const METERS: [&str; 7] = ["Enumerating objects:", "Counting objects:", "Compressing objects:", "Finding sources:", "Resolving deltas:", "Writing objects:", "Total "];

fn classify(text: &str, after_intro: bool) -> RemoteKind {
    let t = text.trim();
    if t.is_empty() || METERS.iter().any(|m| t.starts_with(m)) || crate::netops::parse_progress(t).is_some() || LINK_INTROS.iter().any(|p| t.starts_with(p)) {
        return RemoteKind::Boilerplate;
    }
    if after_intro && (t.starts_with("https://") || t.starts_with("http://")) {
        return RemoteKind::Boilerplate;
    }
    let lower = t.to_lowercase();
    if WARNINGS.iter().any(|w| lower.contains(w)) { RemoteKind::Warning } else { RemoteKind::Info }
}

/// git's stderr → its `remote:` lines, in order: prefix stripped, a `\r`-rewritten line folded to
/// its last state, redacted.
pub fn parse(stderr: &str) -> Vec<RemoteLine> {
    let mut out = Vec::new();
    let mut after_intro = false;
    for raw in stderr.split('\n') {
        let line = raw.rsplit('\r').find(|s| !s.trim().is_empty()).unwrap_or("").trim_end();
        let Some(rest) = line.strip_prefix("remote:") else { continue };
        let text = crate::redact::redact(rest.strip_prefix(' ').unwrap_or(rest)).trim_end().to_string();
        let kind = classify(&text, after_intro);
        after_intro = LINK_INTROS.iter().any(|p| text.trim_start().starts_with(p));
        out.push(RemoteLine { text, kind });
    }
    out
}

pub fn summarize(lines: &[RemoteLine]) -> RemoteSummary {
    RemoteSummary {
        lines: lines.iter().filter(|l| l.kind != RemoteKind::Boilerplate).count() as u32,
        warning: lines.iter().find(|l| l.kind == RemoteKind::Warning).map(|l| l.text.trim().to_string()),
    }
}

/// A failure's Details (§12.4): the `remote:` lines (a hook's rejection reasons) first, then
/// git's own (`error:`, `hint:`), each in order.
pub fn details_first(stderr: &str) -> String {
    let (remote, rest): (Vec<&str>, Vec<&str>) = stderr.lines().partition(|l| l.trim_start_matches('\r').starts_with("remote:"));
    remote.into_iter().map(str::trim_end).chain(rest).collect::<Vec<_>>().join("\n")
}

/// A push's or fetch's server output. Emits `opRemote` (its Activity entry keeps the lines) and,
/// on a failure, puts the `remote:` lines first in its Details: the error's `stderr` and its
/// command-log entry. Returns the toast's summary.
pub(crate) fn capture(api: &Api, op: u64, res: &mut Result<GitOutput, GbError>) -> RemoteSummary {
    let stderr = match res {
        Ok(o) => o.stderr.clone(),
        Err(e) => e.stderr.clone().unwrap_or_default(),
    };
    let lines = parse(&stderr);
    if let Err(e) = res
        && !lines.is_empty()
    {
        let first = details_first(&stderr);
        if let Some(id) = e.command_id {
            api.cli.log().set_stderr(id, &first);
        }
        e.stderr = Some(first);
    }
    let summary = summarize(&lines);
    if !lines.is_empty() {
        api.bus.emit(AppEvent::OpRemote { op, lines });
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUSH: &str = "Enumerating objects: 5, done.\nremote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nremote: Resolving deltas: 100% (1/1)\nremote: \nremote: To create a merge request for dev, visit:\nremote:   https://gitlab.example/team/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=dev\nremote: \nremote: integration: rebase onto dev failed: conflict in a.txt\nremote: Deployed preview for dev\nTo /tmp/origin.git\n   1a2b3c4..5d6e7f8  dev -> dev\n";

    #[test]
    fn remote_lines_are_folded_classified_and_counted() {
        let lines = parse(PUSH);
        let kinds: Vec<(&str, RemoteKind)> = lines.iter().map(|l| (l.text.as_str(), l.kind)).collect();
        assert_eq!(
            kinds,
            [
                ("Counting objects: 100% (2/2), done.", RemoteKind::Boilerplate),
                ("Resolving deltas: 100% (1/1)", RemoteKind::Boilerplate),
                ("", RemoteKind::Boilerplate),
                ("To create a merge request for dev, visit:", RemoteKind::Boilerplate),
                ("  https://gitlab.example/team/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=dev", RemoteKind::Boilerplate),
                ("", RemoteKind::Boilerplate),
                ("integration: rebase onto dev failed: conflict in a.txt", RemoteKind::Warning),
                ("Deployed preview for dev", RemoteKind::Info),
            ]
        );
        assert_eq!(summarize(&lines), RemoteSummary { lines: 2, warning: Some("integration: rebase onto dev failed: conflict in a.txt".into()) });
    }

    #[test]
    fn github_boilerplate_and_every_warning_word() {
        let gh = "remote: \nremote: Create a pull request for 'x' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/x\nremote: \nremote: View merge request for y:\nremote:   https://gitlab.example/o/r/-/merge_requests/3\n";
        assert!(parse(gh).iter().all(|l| l.kind == RemoteKind::Boilerplate), "{:?}", parse(gh));
        for w in ["ERROR: x", "fatal: y", "build failed", "push rejected", "access denied", "merge conflict", "could not lock", "cannot write", "aborting", "warning: z"] {
            assert_eq!(parse(&format!("remote: {w}\n"))[0].kind, RemoteKind::Warning, "{w}");
        }
        assert_eq!(parse("remote: all good\n")[0].kind, RemoteKind::Info);
        assert_eq!(summarize(&parse("Everything up-to-date\n")), RemoteSummary::default(), "no remote lines: nothing to show");
    }

    #[test]
    fn a_url_line_is_boilerplate_only_after_its_intro() {
        let l = parse("remote: see https://ci.example/run/1\n");
        assert_eq!(l[0].kind, RemoteKind::Info);
    }

    #[test]
    fn credentials_in_remote_lines_are_redacted() {
        let l = parse("remote: mirror at https://user:secret@host/x\n");
        assert!(!l[0].text.contains("secret"), "{}", l[0].text);
    }

    #[test]
    fn details_put_remote_lines_first() {
        let stderr = "To /tmp/origin.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to '/tmp/origin.git'\nremote: Branch main is protected\nremote: Ask a maintainer\n";
        assert_eq!(details_first(stderr), "remote: Branch main is protected\nremote: Ask a maintainer\nTo /tmp/origin.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to '/tmp/origin.git'");
    }

    /// A rejecting `pre-receive` (spec #2 §17.1): its lines are captured and lead the Details,
    /// in the error and in the command log; the toast's summary counts them.
    #[tokio::test]
    async fn a_rejected_push_puts_the_servers_reasons_first() {
        use crate::testing::{isolated_git_env, TestRepo};
        let r = TestRepo::new();
        r.commit("one");
        r.add_origin();
        r.push("main");
        let hook = r.root().join("origin.git/hooks/pre-receive");
        std::fs::write(&hook, "#!/bin/sh\necho 'Branch main is protected'\necho 'Ask a maintainer'\nexit 1\n").unwrap();
        crate::platform::fs::set_mode(&hook, 0o755).unwrap();
        r.commit("two");
        let api = crate::api::Api::new(crate::git::GitCli::new(std::sync::Arc::new(crate::log::CommandLog::new(10))).with_env(isolated_git_env()), None);
        let mut res = api.cli.run(crate::git::GitInvocation::new(r.path(), ["push", "--progress", "origin", "main"])).await;
        let mut rx = api.subscribe();
        let summary = capture(&api, 7, &mut res);
        assert_eq!(summary.lines, 2);
        let err = res.unwrap_err();
        assert!(err.stderr.as_deref().unwrap().starts_with("remote: Branch main is protected\nremote: Ask a maintainer\n"), "{:?}", err.stderr);
        let logged = api.cli.log().entries().into_iter().find(|e| Some(e.id) == err.command_id).unwrap();
        assert!(logged.stderr.starts_with("remote: Branch main is protected"), "{}", logged.stderr);
        match rx.try_recv().unwrap() {
            crate::events::AppEvent::OpRemote { op, lines } => assert_eq!((op, lines.len()), (7, 2)),
            other => panic!("{other:?}"),
        }
    }
}
