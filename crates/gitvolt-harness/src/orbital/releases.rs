//! Orbital's releases: the versions and where they're tagged, the release branches, and the two
//! files releases write (the root Cargo.toml and CHANGELOG.md).

use super::corpus::{fill, subject_ok, Messages};
use super::model::{Edit, Snapshot, Value};
use super::story::{Kind, Step};
use crate::media::rng::Rng;
use std::collections::BTreeSet;
use std::rc::Rc;

pub struct Release {
    pub version: &'static str,
    pub milestone: u32,
    pub branch: &'static str,
    pub cuts: Option<&'static str>,
    pub merges_back: bool,
}

const fn on_main(version: &'static str, milestone: u32) -> Release {
    Release { version, milestone, branch: "main", cuts: None, merges_back: false }
}

pub const RELEASES: [Release; 15] = [
    on_main("0.1.0", 4),
    on_main("0.2.0", 7),
    on_main("0.3.0", 10),
    on_main("0.4.0", 14),
    on_main("0.5.0", 17),
    on_main("0.6.0", 19),
    on_main("0.7.0", 22),
    on_main("0.8.0", 25),
    on_main("0.9.0", 27),
    Release { version: "1.0.0", milestone: 30, branch: "main", cuts: Some("release/1.0"), merges_back: false },
    Release { version: "1.0.1", milestone: 31, branch: "release/1.0", cuts: None, merges_back: true },
    Release { version: "1.1.0", milestone: 34, branch: "main", cuts: Some("release/1.1"), merges_back: false },
    Release { version: "1.1.1", milestone: 35, branch: "release/1.1", cuts: None, merges_back: true },
    Release { version: "1.2.0", milestone: 38, branch: "release/1.2", cuts: None, merges_back: true },
    Release { version: "1.2.1", milestone: 39, branch: "release/1.2", cuts: None, merges_back: true },
];

/// Branches cut from main ahead of their release, for release candidates: (branch, milestone it's
/// cut at the start of, once the earlier milestones' work has landed).
pub const EARLY_CUTS: [(&str, u32); 1] = [("release/1.2", 37)];

/// Each dependency the crates take from the workspace, and its versions oldest first. wgpu stays
/// on 24: the render crate's code is written against its API.
pub const DEPS: [(&str, &[&str]); 10] = [
    ("bytemuck", &["1.19.0", "1.20.0", "1.21.0", "1.22.0"]),
    ("env_logger", &["0.11.5", "0.11.6", "0.11.8"]),
    ("gilrs", &["0.11.0", "0.11.1"]),
    ("glam", &["0.29.0", "0.29.2", "0.30.0", "0.30.2", "0.30.4"]),
    ("log", &["0.4.22", "0.4.25", "0.4.27"]),
    ("pollster", &["0.3.0", "0.4.0"]),
    ("serde", &["1.0.217", "1.0.219"]),
    ("serde_json", &["1.0.138", "1.0.140"]),
    ("wgpu", &["23.0.1", "24.0.0", "24.0.1", "24.0.3"]),
    ("winit", &["0.30.5", "0.30.8", "0.30.9", "0.30.11"]),
];

const DEP: &str = "Cargo.toml#dep:";

/// The member crates, in the order the workspace lists them.
const MEMBERS: [&str; 3] = ["orbital-core", "orbital-render", "orbital-game"];

#[derive(Clone, Debug)]
pub struct Entry {
    pub kind: Kind,
    pub title: String,
    pub iid: u32,
}

#[derive(Clone, Debug)]
pub struct Section {
    pub version: String,
    pub date: String,
    pub entries: Vec<Entry>,
}

pub fn semver(v: &str) -> (u32, u32, u32) {
    let mut p = v.split('.').map(|n| n.parse().unwrap_or(0));
    (p.next().unwrap_or(0), p.next().unwrap_or(0), p.next().unwrap_or(0))
}

/// The workspace manifest as the first crate's manifest adds it: version 0.0.0. Its dependencies
/// follow the crates' manifests (`sync_deps`), each at its first version; CHANGELOG.md comes with
/// the first release.
pub fn initial_edits() -> Vec<Edit> {
    vec![Edit::set("Cargo.toml#version", Value::Text("0.0.0".into()))]
}

/// A member crate's manifest: `crates/<name>/Cargo.toml`.
pub fn is_member_manifest(path: &str) -> bool {
    path.strip_prefix("crates/").and_then(|p| p.strip_suffix("/Cargo.toml")).is_some_and(|name| !name.contains('/'))
}

/// The dependencies a member manifest takes from the workspace (`x = { workspace = true }` or
/// `x.workspace = true`), other than the members themselves.
pub fn workspace_deps(toml: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut in_deps = false;
    for l in toml.lines().map(str::trim) {
        if l.starts_with('[') {
            in_deps = l.contains("dependencies");
        } else if in_deps && let Some((name, rest)) = l.split_once('=') {
            let name = name.trim();
            let (name, inline) = match name.strip_suffix(".workspace") {
                Some(n) => (n, true),
                None => (name, rest.contains("workspace = true")),
            };
            if inline && !name.starts_with("orbital-") {
                out.insert(name.to_string());
            }
        }
    }
    out
}

/// The edits that make the workspace list exactly `used`: a new dependency at its first version,
/// one no crate uses any more gone.
pub fn sync_deps(snap: &Snapshot, used: &BTreeSet<String>) -> Vec<Edit> {
    let mut out: Vec<Edit> = snap.keys().filter_map(|(k, _)| k.strip_prefix(DEP)).filter(|name| !used.contains(*name)).map(|name| Edit::remove(format!("{DEP}{name}"))).collect();
    for name in used {
        let key = format!("{DEP}{name}");
        if snap.get(&key).is_none() {
            let ladder = DEPS.iter().find(|d| d.0 == name).unwrap_or_else(|| panic!("a crate uses {name}, which DEPS doesn't list")).1;
            out.push(Edit::set(key, Value::Text(Rc::from(ladder[0]))));
        }
    }
    out
}

/// The version after the dependency's current one, if there is a newer one.
pub fn next_version(snap: &Snapshot, dep_key: &str) -> Option<&'static str> {
    let name = dep_key.strip_prefix(DEP)?;
    let current = text(snap, dep_key)?;
    let ladder = DEPS.iter().find(|d| d.0 == name)?.1;
    ladder.get(ladder.iter().position(|v| *v == current)? + 1).copied()
}

pub fn bump(main: &Snapshot, dep_key: &str, messages: &Messages, rng: &mut Rng) -> Option<Step> {
    let name = dep_key.strip_prefix(DEP)?;
    let next = next_version(main, dep_key)?;
    let message = (0..8).map(|_| fill(&messages.pick("bump-dep", rng), &[("dep", name), ("version", next)])).find(|m| subject_ok(m).is_ok())?;
    Some(Step::new(message, vec![Edit::set(dep_key, Value::Text(Rc::from(next)))]))
}

fn text<'a>(snap: &'a Snapshot, key: &str) -> Option<&'a str> {
    match snap.get(key)? {
        Value::Text(t) => Some(t),
        _ => None,
    }
}

pub fn render_cargo(snap: &Snapshot) -> Option<String> {
    let version = text(snap, "Cargo.toml#version")?;
    let mut members: Vec<String> = snap.paths().into_iter().filter(|p| is_member_manifest(p)).map(|p| p["crates/".len()..p.len() - "/Cargo.toml".len()].to_string()).collect();
    members.sort_by_key(|m| (MEMBERS.iter().position(|x| x == m).unwrap_or(MEMBERS.len()), m.clone()));
    let list: Vec<String> = members.iter().map(|m| format!("\"crates/{m}\"")).collect();
    let mut out = format!("[workspace]\nresolver = \"3\"\nmembers = [{}]\n\n[workspace.package]\nversion = \"{version}\"\nedition = \"2024\"\nlicense = \"MIT\"\n\n[workspace.dependencies]\n", list.join(", "));
    // The game is the binary; the other members are libraries it (and they) depend on.
    for m in members.iter().filter(|m| *m != "orbital-game") {
        out += &format!("{m} = {{ path = \"crates/{m}\" }}\n");
    }
    for (k, _) in snap.keys().filter(|(k, _)| k.starts_with(DEP)) {
        let (name, v) = (&k[DEP.len()..], text(snap, k)?);
        out += &match name {
            "bytemuck" | "serde" => format!("{name} = {{ version = \"{v}\", features = [\"derive\"] }}\n"),
            _ => format!("{name} = \"{v}\"\n"),
        };
    }
    out += "\n[profile.release]\nlto = \"thin\"\n";
    Some(out)
}

/// The changelog's headings and the kinds of change each one lists.
const HEADINGS: [(&str, &[Kind]); 3] = [("Added", &[Kind::Feature, Kind::Art, Kind::Audio, Kind::Experiment]), ("Changed", &[Kind::Balance, Kind::Chore, Kind::Docs]), ("Fixed", &[Kind::Fix])];

/// A section's entries in the order the changelog lists them.
pub fn ordered(section: &Section) -> Vec<&Entry> {
    HEADINGS.iter().flat_map(|(_, kinds)| section.entries.iter().filter(|e| kinds.contains(&e.kind))).collect()
}

pub fn render_changelog(snap: &Snapshot, sections: &[Section]) -> Option<String> {
    let version = semver(text(snap, "CHANGELOG.md#version")?);
    let mut out = String::from("# Changelog\n\nNotable changes to Orbital, newest first. Each entry names its merge request.\n");
    let mut shown: Vec<&Section> = sections.iter().filter(|s| semver(&s.version) <= version).collect();
    shown.sort_by_key(|s| std::cmp::Reverse(semver(&s.version)));
    for s in shown {
        out += &format!("\n## [{}] - {}\n", s.version, s.date);
        for (heading, kinds) in HEADINGS {
            let lines: Vec<String> = s.entries.iter().filter(|e| kinds.contains(&e.kind)).map(|e| format!("- {} (!{})", e.title, e.iid)).collect();
            if !lines.is_empty() {
                out += &format!("\n### {heading}\n{}\n", lines.join("\n"));
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbital::content::Content;
    use crate::orbital::corpus::{Corpus, Messages};
    use crate::orbital::history::{fast_import, History};
    use crate::orbital::schedule::run;
    use crate::orbital::story::{parse_features, plan};
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).envs(crate::orbital::people::git_env()).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim_end().to_string()
    }

    /// One feature per milestone that has a release, plus fixes on each release branch.
    fn stream() -> Vec<u8> {
        let mut corpus_text = String::from("#file crates/orbital-render/Cargo.toml\n#whole v1 @m1 \"Add the render crate\"\n[package]\nname = \"orbital-render\"\n\n[dependencies]\nwgpu = { workspace = true }\n#file src/lib.rs\n#header v1 @m1\n//! Lib.\n#item i1 v1 @m1 \"Add item 1\"\npub fn i1() {}\n");
        // The releases are tagged by whoever the `later: release` features name.
        let mut features = String::from("m1 | chore | ilse | 1 | main | direct | Start\ntag3 | chore | kasimir | 10 | main | merged | Tag v0.3.0\n  later: release\n");
        for m in [3, 6, 9, 13, 16, 18, 21, 24, 26, 29, 32, 33, 36, 37, 39] {
            corpus_text += &format!("#item i{m} v1 @m{m} \"Add item {m}\"\npub fn i{m}() {{}}\n");
            features += &format!("m{m} | feature | teodor | {m} | main | merged | Add item {m}\n");
        }
        for (slug, m, target) in [("fix10a", 31, "release/1.0"), ("fix11a", 35, "release/1.1"), ("fix12a", 37, "release/1.2"), ("fix121a", 39, "release/1.2")] {
            corpus_text += &format!("#item {slug} v1 @{slug} \"Fix {slug}\"\npub fn {slug}() {{}}\n");
            features += &format!("{slug} | fix | wen | {m} | {target} | merged | Fix {slug}\n");
        }
        let corpus = Corpus::from_sources(&[("t.txt", &corpus_text)]).unwrap();
        let messages = Messages::parse("[review]\nTweak {what}\n[review-up]\nRaise {what} after review\n[review-down]\nLower {what} after review\n[tune-up]\nRaise {what} from {old} to {new}\n[tune-down]\nLower {what} from {old} to {new}\n[tune-cell]\nBalance {row}\n[bump-dep]\nBump {dep} to {version}\n").unwrap();
        let mut rng = Rng::new(5);
        let plans = plan(&corpus, &parse_features(&features).unwrap(), &messages, &|_: &str, _| std::rc::Rc::from(&b""[..]), &mut rng).unwrap();
        let mut hist = History::new();
        let content = Content { corpus: &corpus, sections: Default::default() };
        run(&plans, &content, &messages, &mut hist, &mut rng, &RELEASES, 120);
        hist.finish()
    }

    fn history() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        fast_import(&dir.path().join(".git"), &stream(), None).unwrap();
        dir
    }

    #[test]
    fn every_release_is_tagged_on_its_branch_and_merged_back() {
        let dir = history();
        let d = dir.path();
        let tags = git(d, &["tag", "--sort=v:refname"]);
        assert_eq!(tags.lines().collect::<Vec<_>>(), RELEASES.iter().map(|r| format!("v{}", r.version)).collect::<Vec<_>>());
        assert_eq!(git(d, &["cat-file", "-t", "v1.0.1"]), "tag");
        for (tag, branch) in [("v1.0.1", "release/1.0"), ("v1.1.1", "release/1.1"), ("v1.2.0", "release/1.2"), ("v1.2.1", "release/1.2")] {
            assert!(Command::new("git").current_dir(d).envs(crate::orbital::people::git_env()).args(["merge-base", "--is-ancestor", tag, branch]).status().unwrap().success(), "{tag} on {branch}");
            assert!(Command::new("git").current_dir(d).envs(crate::orbital::people::git_env()).args(["merge-base", "--is-ancestor", branch, "main"]).status().unwrap().success(), "{branch} merged back");
            assert_eq!(git(d, &["rev-parse", branch]), git(d, &["rev-parse", &format!("origin/{branch}")]), "{branch} is pushed");
        }
        assert!(!Command::new("git").current_dir(d).envs(crate::orbital::people::git_env()).args(["merge-base", "--is-ancestor", "v1.0.1", "v1.0.0"]).status().unwrap().success());
        assert_eq!(git(d, &["log", "-1", "--format=%an %s", "v0.3.0^{commit}"]), "Kasimir Oduya Release v0.3.0");
        assert_eq!(git(d, &["tag", "-l", "--format=%(taggername)", "v1.2.1"]), "Kasimir Oduya");
        assert_eq!(git(d, &["log", "--format=%s", "--grep=^Merge branch 'release/1.2'", "main"]).lines().count(), 2, "release/1.2 merges back twice");
        assert_eq!(git(d, &["for-each-ref", "--format=%(refname:short)", "refs/heads/fix"]), "", "fix branches are merged and gone");
        assert!(git(d, &["log", "--format=%s", "main"]).contains("Merge branch 'release/1.0' into 'main'"));
        let note = git(d, &["tag", "-l", "--format=%(contents)", "v1.0.1"]);
        assert!(note.starts_with("Orbital 1.0.1\n\n- Fix fix10a"), "{note}");
    }

    #[test]
    fn cargo_and_changelog_follow_the_versions() {
        let dir = history();
        let d = dir.path();
        assert!(git(d, &["show", "v0.3.0:Cargo.toml"]).contains("version = \"0.3.0\""));
        assert!(git(d, &["show", "v0.3.0:Cargo.toml"]).contains("wgpu = \""));
        let log = git(d, &["show", "v1.0.1:CHANGELOG.md"]);
        let (a, b) = (log.find("## [1.0.1]").unwrap(), log.find("## [1.0.0]").unwrap());
        assert!(a < b, "newest first");
        assert!(log.contains("### Fixed\n- Fix fix10a (!"), "{log}");
        assert!(!git(d, &["show", "v1.0.0:CHANGELOG.md"]).contains("1.0.1"));
        let main = git(d, &["show", "main:CHANGELOG.md"]);
        assert!(main.contains("## [1.2.0]") && main.contains("## [1.1.1]"), "{main}");
        assert!(git(d, &["show", "v1.2.0:CHANGELOG.md"]).contains("Fix fix12a"));
        let patch = git(d, &["show", "v1.2.1:CHANGELOG.md"]);
        let section = &patch[patch.find("## [1.2.1]").unwrap()..patch.find("## [1.2.0]").unwrap()];
        assert!(section.contains("Fix fix121a") && !section.contains("fix12a ("), "{section}");
        assert!(git(d, &["show", "main:CHANGELOG.md"]).contains("## [1.2.1]"));
    }

    #[test]
    fn releases_are_deterministic() {
        assert_eq!(stream(), stream());
    }

    #[test]
    fn semver_orders_and_deps_bump_up_their_ladder() {
        assert!(semver("1.0.1") > semver("1.0.0") && semver("0.10.0") > semver("0.9.0"));
        let mut s = Snapshot::default();
        s.apply(&initial_edits());
        let used: BTreeSet<String> = workspace_deps("[package]\nname = \"x\"\n\n[dependencies]\norbital-core = { workspace = true }\nwgpu = { workspace = true }\nlog.workspace = true\n").into_iter().collect();
        assert_eq!(used.iter().map(String::as_str).collect::<Vec<_>>(), ["log", "wgpu"]);
        s.apply(&sync_deps(&s, &used));
        let wgpu = DEPS.iter().find(|d| d.0 == "wgpu").unwrap().1;
        assert_eq!(s.get("Cargo.toml#dep:wgpu"), Some(&Value::Text(wgpu[0].into())));
        let m = Messages::parse("[bump-dep]\nBump {dep} to {version}\n").unwrap();
        let step = bump(&s, "Cargo.toml#dep:wgpu", &m, &mut Rng::new(1)).unwrap();
        assert_eq!(step.message, format!("Bump wgpu to {}", wgpu[1]));
        let text = render_cargo(&s).unwrap();
        assert!(text.starts_with("[workspace]\nresolver = \"3\"\n") && text.contains("version = \"0.0.0\""));
        s.apply(&sync_deps(&s, &["log".to_string()].into()));
        assert!(s.get("Cargo.toml#dep:wgpu").is_none(), "an unused dependency leaves the workspace");
        s.apply(&[Edit::set("Cargo.toml#dep:log", Value::Text("0.4.27".into()))]);
        assert!(bump(&s, "Cargo.toml#dep:log", &m, &mut Rng::new(1)).is_none(), "the newest version stays");
    }
}
