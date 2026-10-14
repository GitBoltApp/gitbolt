//! Orbital's GitLab (website demo plan 4): `forge.json` v1 from the history's merge requests.
//! Heads and bases come from the origin; the open ones get pipelines, approvals, reviewers and a
//! few threads (diff notes where their line is in the MR's diff, else general notes).

use super::calendar::iso_datetime;
use super::history::Mark;
use super::people::PEOPLE;
use super::schedule::{MrState, Outcome};
use crate::fake_forge::gitlab_mrs::{FakeAward, FakeDiscussion, FakeMergeRequest, FakeNote, FakePosition};
use crate::fake_forge::{FakeLabel, FakeUser, GitLabSeed, GITLAB_HOST};
use crate::forge_seed::{self, ForgeFile};
use std::collections::HashMap;
use std::path::Path;

pub const PROJECT: &str = "orbital/orbital";

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git").current_dir(dir).args(args).envs(gitvolt_core::testing::isolated_git_env()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("git {args:?}: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// The 2x scout sprite the `hd-sprites` MR's description shows, as an upload of the project.
const UPLOAD_SECRET: &str = "5c0a7e1d9b3f4a6c8e2d0b1a3c5e7f90";
const UPLOAD_FILE: &str = "scout-2x.png";

/// Writes the MR's upload under `<root>/forge-uploads/<secret>/` (the demo reads it from there).
pub fn write_uploads(root: &Path) -> Result<(), String> {
    let dir = root.join("forge-uploads").join(UPLOAD_SECRET);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(UPLOAD_FILE), super::art::ship("scout", 3).scaled(2).to_png()).map_err(|e| e.to_string())
}

/// What each open branch's MR looks like on the forge (branch suffix → pipeline, merge status, approvers, required).
fn shape(source: &str) -> (&'static str, &'static str, &'static [&'static str], u32) {
    match source.rsplit('/').next().unwrap_or(source) {
        "hd-sprites" => ("success", "mergeable", &["rafe"], 1),
        "station-ui" => ("running", "ci_still_running", &[], 0),
        "fuel-rework" => ("failed", "conflict", &[], 1),
        "hud-polish" => ("success", "not_approved", &[], 1),
        "trade-routes" => ("success", "need_rebase", &["ilse"], 1),
        "autopilot" => ("pending", "ci_must_pass", &[], 0),
        _ => ("running", "draft_status", &[], 0),
    }
}

/// The project's labels: the branch kinds that name an area, and two topics.
const LABELS: [&str; 8] = ["art", "audio", "balance", "docs", "feature", "fix", "hud", "net"];

/// An MR's labels (at most two): its branch's kind when that's a label, then a topic its branch or
/// title names as a word (`hud`; `net` for multiplayer work).
fn labels(source: &str, title: &str) -> Vec<String> {
    let kind = source.split_once('/').map_or("", |(k, _)| k);
    let words: Vec<String> = format!("{source} {title}").split(|c: char| !c.is_alphanumeric()).map(str::to_lowercase).collect();
    let has = |w: &[&str]| words.iter().any(|x| w.contains(&x.as_str()));
    let mut out: Vec<String> = Vec::new();
    if LABELS.contains(&kind) && kind != "hud" && kind != "net" {
        out.push(kind.into());
    }
    if has(&["hud"]) {
        out.push("hud".into());
    }
    if has(&["multiplayer", "lockstep", "netcode", "network", "net"]) {
        out.push("net".into());
    }
    out.truncate(2);
    out
}

/// A diff note's file, and how its line starts.
type At = (&'static str, &'static str);

/// The threads on Orbital's open MRs: (branch suffix, discussion id, author, body, a diff note's
/// file and the start of the line it sits on: the file's first added line in the MR's diff that
/// starts so, past its indentation).
const THREADS: &[(&str, &str, &str, &str, Option<At>)] = &[
    ("hd-sprites", "o1", "teodor", "The 2x scout reads much better on the station screen. Do the explosion frames still line up?", None),
    ("hd-sprites", "o2", "noor", "They do: I redrew the four frames on the new grid.", None),
    ("station-ui", "o3", "ilse", "Can the cargo list keep its scroll when a trade goes through?", None),
    ("station-ui", "o4", "kasimir", "Could the rows start from a named offset, like their height?\n\n```suggestion\n            let at = Vec2::new(120.0, PORTS_TOP + port as f32 * PORT_ROW_HEIGHT);\n```", Some(("crates/orbital-game/src/station_ui.rs", "let at = "))),
    ("hud-polish", "o5", "ilse", "Gauge colours look right in colour-blind mode too.", None),
    ("hud-polish", "o6", "wen", "Could the frame be a pixel thinner?", Some(("crates/orbital-game/src/hud.rs", ""))),
    ("fuel-rework", "o7", "rafe", "This conflicts with the economy table on main: the fuel prices moved there last week.", None),
    ("trade-routes", "o8", "ilse", "Rebase on main first: the planner changed under it.", None),
];

/// Orbital's GitLab: every MR the history implies, with heads, bases and states; pipelines, approvals and threads on the open ones.
pub fn forge_file(repo: &Path, origin: &Path, outcome: &Outcome, marks: &HashMap<Mark, String>) -> Result<ForgeFile, String> {
    let users: Vec<FakeUser> = PEOPLE.iter().enumerate().map(|(i, p)| FakeUser { id: 101 + i as u64, username: p.handle.into(), name: p.name.into(), email: Some(p.email.into()), avatar_url: None }).collect();
    let mut note_id = 200u64;
    let mut mrs = Vec::new();
    for m in &outcome.mrs {
        let open = !matches!(m.state, MrState::Merged);
        let created = iso_datetime(m.created);
        let (head, base, merge_commit) = match m.merged {
            Some((_, mark)) => {
                let merge = marks[&mark].clone();
                (git(repo, &["rev-parse", &format!("{merge}^2")])?, git(repo, &["rev-parse", &format!("{merge}^1")])?, merge)
            }
            None => {
                let head = git(origin, &["rev-parse", &format!("refs/heads/{}", m.source)])?;
                (head.clone(), git(origin, &["merge-base", &format!("refs/heads/{}", m.target), &head])?, String::new())
            }
        };
        let mut f = FakeMergeRequest {
            iid: u64::from(m.iid),
            project: PROJECT.into(),
            source_branch: m.source.clone(),
            target_branch: m.target.clone(),
            title: if matches!(m.state, MrState::Draft) { format!("Draft: {}", m.title) } else { m.title.clone() },
            description: {
                let mut d = m.description.join("\n");
                if m.source.ends_with("/hd-sprites") {
                    d.push_str(&format!("\n\n![The scout at 2x](https://{GITLAB_HOST}/{PROJECT}/uploads/{UPLOAD_SECRET}/{UPLOAD_FILE})"));
                }
                d
            },
            state: if open { "opened" } else { "merged" }.into(),
            author: m.author.into(),
            head_sha: head.clone(),
            merge_status: "mergeable".into(),
            merge_commit_sha: merge_commit,
            updated_at: m.merged.map_or(created.clone(), |(t, _)| iso_datetime(t)),
            pipeline: Some("success".into()),
            labels: labels(&m.source, &m.title),
            ..Default::default()
        };
        if open {
            f.base_sha = base.clone();
            f.diffs = forge_seed::diffs(origin, &base, &head)?;
            let (pipeline, status, approvers, required) = shape(&m.source);
            f.pipeline = Some(pipeline.into());
            f.merge_status = status.into();
            f.has_conflicts = status == "conflict";
            f.approved_by = approvers.iter().map(|s| s.to_string()).collect();
            f.approvals_required = required;
            f.reviewers = vec!["you".into()];
            if status == "need_rebase" {
                f.diverged_commits_count = git(origin, &["rev-list", "--count", &format!("{head}..refs/heads/{}", m.target)])?.parse().unwrap_or(0);
            }
            let suffix = m.source.rsplit('/').next().unwrap_or(&m.source);
            for (n, (_, id, who, body, at)) in THREADS.iter().filter(|t| t.0 == suffix).enumerate() {
                note_id += 1;
                // A diff note sits on its line if the MR's diff adds one, else it's a general note.
                let position = at.and_then(|(path, start)| {
                    let d = f.diffs.iter().find(|d| d.new_path == path)?;
                    let line = forge_seed::added_line_where(&f.diffs, path, |l| l.trim_start().starts_with(start))?;
                    Some(FakePosition { new_path: path.into(), old_path: d.old_path.clone(), new_line: Some(line), old_line: None, start: None, head_sha: head.clone() })
                });
                let awards = if n == 0 { vec![FakeAward { id: 600 + note_id, name: "thumbsup".into(), user: "rafe".into() }] } else { vec![] };
                f.discussions.push(FakeDiscussion {
                    id: (*id).into(),
                    notes: vec![FakeNote { id: note_id, author: (*who).into(), body: (*body).into(), created_at: created.clone(), system: false, position: position.clone(), awards }],
                    resolvable: position.is_some(),
                    ..Default::default()
                });
            }
        }
        mrs.push(f);
    }
    let mut members = vec![forge_seed::me()];
    members.extend(users.iter().cloned());
    let labels = LABELS.iter().map(|n| FakeLabel { name: (*n).into(), color: "#6c5ce7".into(), description: None }).collect();
    let updated = mrs.iter().map(|m| m.updated_at.clone()).max().unwrap_or_default();
    Ok(ForgeFile {
        version: forge_seed::VERSION,
        host: GITLAB_HOST.into(),
        project: PROJECT.into(),
        me: "you".into(),
        gitlab: GitLabSeed { uploads: vec![format!("{PROJECT}/{UPLOAD_SECRET}/{UPLOAD_FILE}")], version: "18.9.1-ee".into(), projects: vec![forge_seed::project(1701, PROJECT, &updated)], users, members, labels, merge_requests: mrs, ..Default::default() },
    })
}
