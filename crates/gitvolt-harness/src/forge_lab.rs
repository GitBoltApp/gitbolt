//! `forge_lab` (website demo plan 4): a small repository whose origin is a project on the fake
//! GitLab (`orbital/forge-lab`), with a merge request of every kind, for the demo forge's golden
//! scenarios. Orbital's 2,000 commits stay out of the parity suite.

use crate::fake_forge::gitlab_mrs::{FakeAward, FakeDiscussion, FakeMergeRequest, FakeNote, FakePosition};
use crate::fake_forge::{FakeLabel, FakeUser, GitLabSeed, GITLAB_HOST};
use crate::forge_seed::{self, ForgeFile};
use gitvolt_core::testing::TestRepo;

pub const PROJECT: &str = "orbital/forge-lab";

fn user(id: u64, handle: &str, name: &str) -> FakeUser {
    FakeUser { id, username: handle.into(), name: name.into(), email: Some(format!("{handle}@example.com")), avatar_url: None }
}

fn note(id: u64, author: &str, body: &str, at: &str) -> FakeNote {
    FakeNote { id, author: author.into(), body: body.into(), created_at: at.into(), system: false, position: None, awards: vec![] }
}

pub fn build(r: &TestRepo) {
    let hud = "pub const HUD_MARGIN: u32 = 12;\n\npub fn draw_hud(frame: &mut Frame) {\n    frame.margin(HUD_MARGIN);\n}\n";
    r.write("src/hud.rs", hud);
    r.write("README.md", "# Forge lab\n\nA corner of Orbital for trying merge requests.\n");
    r.commit_all_as("Start the forge lab", "Ada Lovelace", "ada@example.com");
    r.write("src/audio.rs", "pub const CHIME_VOLUME: f32 = 0.8;\n");
    r.commit_all_as("Add the docking chime", "Grace Hopper", "grace@example.com");
    let branch = |name: &str, from: &str, edits: &[(&str, &str, &str)]| {
        r.git(&["switch", "-q", "-c", name, from]);
        for (path, content, message) in edits {
            r.write(path, content);
            r.commit_all_as(message, "Ada Lovelace", "ada@example.com");
        }
        r.git(&["switch", "-q", "main"]);
    };
    let scaled = format!("{hud}\n/// The HUD's scale for a window `height` pixels tall.\npub fn hud_scale(height: u32) -> u32 {{\n    (height / 720).max(1)\n}}\n");
    branch("feature/hud-scale", "main", &[("src/hud.rs", &scaled, "Scale the HUD with the window"), ("docs/hud.md", "# HUD\n\nIt scales in whole steps from 720 px.\n", "Say how the HUD scales")]);
    branch("feature/radar", "main", &[("src/radar.rs", "pub fn draw_radar() {}\n", "Sketch a radar panel")]);
    branch("fix/dock-chime", "main", &[("src/audio.rs", "pub const CHIME_VOLUME: f32 = 0.6;\n", "Play the docking chime once, softer")]);
    // GitLab's merge commit message.
    r.git(&["merge", "-q", "--no-ff", "-m", "Merge branch 'fix/dock-chime' into 'main'\n\nSee merge request orbital/forge-lab!3", "fix/dock-chime"]);
    branch("feature/stack-a", "main", &[("src/cargo.rs", "pub struct Hold;\n", "Add the cargo hold")]);
    branch("feature/stack-b", "feature/stack-a", &[("src/cargo.rs", "pub struct Hold;\n\npub fn capacity(_: &Hold) -> u32 { 40 }\n", "Give the hold a capacity")]);
    branch("feature/ünï-names", "main", &[("docs/names.md", "Ünï, Ōrbit, Søren\n", "Allow accented station names")]);
    r.add_origin();
    r.git(&["push", "-q", "--all", "origin"]);
    r.git(&["remote", "set-head", "origin", "main"]);
    for b in ["main", "feature/hud-scale", "feature/radar", "feature/stack-a", "feature/stack-b", "feature/ünï-names"] {
        r.git(&["branch", "-q", "--set-upstream-to", &format!("origin/{b}"), b]);
    }
    // The merged MR's source branch went with the merge, as GitLab's "Delete source branch" does.
    r.git(&["branch", "-q", "-D", "fix/dock-chime"]);
    r.git(&["push", "-q", "origin", "--delete", "fix/dock-chime"]);
    r.git(&["fetch", "-q", "--prune", "origin"]);
    // The origin is named by its forge URL; the demo (and `url.<path>.insteadOf`) maps it back.
    r.git(&["remote", "set-url", "origin", &forge_seed::forge_url(PROJECT)]);

    let sha = |rev: &str| r.git(&["rev-parse", rev]);
    let at = |day: u32, h: u32| format!("2026-10-{day:02}T{h:02}:00:00Z");
    let mr = |iid: u64, title: &str, source: &str, target: &str, author: &str| {
        let (head, base) = if source == "fix/dock-chime" { (sha("main^2"), sha("main^1")) } else { (sha(source), r.git(&["merge-base", target, source])) };
        let diffs = forge_seed::diffs(r.path(), &base, &head).expect("the MR's diff");
        FakeMergeRequest {
            iid,
            project: PROJECT.into(),
            source_branch: source.into(),
            target_branch: target.into(),
            title: title.into(),
            state: "opened".into(),
            author: author.into(),
            head_sha: head,
            base_sha: base,
            diffs,
            merge_status: "mergeable".into(),
            updated_at: at(10, 9 + iid as u32),
            ..Default::default()
        }
    };
    let mut one = mr(1, "Scale the HUD with the window", "feature/hud-scale", "main", "ada");
    let line = forge_seed::added_line(&one.diffs, "src/hud.rs", "pub fn hud_scale(height: u32) -> u32 {");
    one.description = "The HUD keeps its size on big windows.\n\n- scales in whole steps\n- documented in `docs/hud.md`".into();
    one.pipeline = Some("success".into());
    one.approvals_required = 1;
    one.merge_status = "not_approved".into();
    one.reviewers = vec!["you".into(), "grace".into()];
    one.labels = vec!["hud".into()];
    one.subscribers = vec!["you".into()];
    let position = FakePosition { new_path: "src/hud.rs".into(), old_path: "src/hud.rs".into(), new_line: line, old_line: None, start: None, head_sha: one.head_sha.clone() };
    one.discussions = vec![
        FakeDiscussion { id: "d1".into(), notes: vec![note(101, "grace", "Looks good overall. One question on the rounding.", &at(10, 11))], ..Default::default() },
        FakeDiscussion {
            id: "d2".into(),
            notes: vec![FakeNote {
                position: Some(position),
                awards: vec![FakeAward { id: 501, name: "thumbsup".into(), user: "grace".into() }],
                ..note(102, "lars", "Could this round to the nearest step instead?\n\n```suggestion\npub fn hud_scale(height: u32) -> u32 {\n```", &at(10, 12))
            }],
            resolvable: true,
            ..Default::default()
        },
        FakeDiscussion {
            id: "d3".into(),
            notes: vec![note(103, "grace", "Is 720 the right first step?", &at(10, 13)), note(104, "ada", "It's the smallest window we support.", &at(10, 14))],
            resolvable: true,
            resolved: true,
            resolved_by: Some("grace".into()),
            resolved_at: Some(at(10, 15)),
        },
        FakeDiscussion { id: "d4".into(), notes: vec![FakeNote { system: true, ..note(105, "ada", "added 1 commit", &at(10, 16)) }], ..Default::default() },
    ];
    let mut two = mr(2, "Draft: Add a radar panel", "feature/radar", "main", "grace");
    two.pipeline = Some("running".into());
    two.merge_status = "draft_status".into();
    let mut three = mr(3, "Play the docking chime once, softer", "fix/dock-chime", "main", "grace");
    three.state = "merged".into();
    three.merge_commit_sha = sha("main");
    three.pipeline = Some("success".into());
    three.labels = vec!["audio".into()];
    let mut four = mr(4, "Add the cargo hold", "feature/stack-a", "main", "ada");
    four.approved_by = vec!["grace".into()];
    four.approvals_required = 1;
    four.labels = vec!["stack".into()];
    let mut five = mr(5, "Give the hold a capacity", "feature/stack-b", "feature/stack-a", "ada");
    five.labels = vec!["stack".into()];
    let six = mr(6, "Allow accented station names", "feature/ünï-names", "main", "lars");
    let (ada, grace, lars) = (user(101, "ada", "Ada Lovelace"), user(102, "grace", "Grace Hopper"), user(103, "lars", "Lars Tidemann"));
    let gitlab = GitLabSeed {
        version: "18.9.1-ee".into(),
        projects: vec![forge_seed::project(4242, PROJECT, &at(10, 16))],
        users: vec![ada.clone(), grace.clone(), lars.clone()],
        members: vec![forge_seed::me(), ada, grace, lars],
        labels: vec![
            FakeLabel { name: "hud".into(), color: "#428bca".into(), description: Some("The heads-up display".into()) },
            FakeLabel { name: "audio".into(), color: "#d9534f".into(), description: None },
            FakeLabel { name: "stack".into(), color: "#5cb85c".into(), description: None },
        ],
        merge_requests: vec![one, two, three, four, five, six],
        ..Default::default()
    };
    forge_seed::write(r.root(), &ForgeFile { version: forge_seed::VERSION, host: GITLAB_HOST.into(), project: PROJECT.into(), me: "you".into(), gitlab }).expect("write forge.json");
}
