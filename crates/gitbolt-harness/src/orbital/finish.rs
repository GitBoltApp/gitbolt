//! What Orbital needs real git for, after the fast-import: the checkout, the bare origin and the
//! teammate's not-yet-fetched commit, upstreams, two stashes, a partly staged working tree, and
//! the forge data plan 4 will serve.

use super::calendar::{END, iso_datetime};
use super::content::Content;
use super::corpus::{literal_of, retune, tune};
use super::data;
use super::history::{History, Mark, SCRATCH, fast_import};
use super::model::{Edit, Render, Value, path_of};
use super::people::{PEOPLE, git_as, person};
use super::schedule::{MrState, Outcome, const_literal, pinned};
use crate::media::rng::Rng;
use gitbolt_core::testing::TestRepo;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

/// The subject of the teammate's commit (`refs/demo/teammate` in the origin).
pub const TEAMMATE_SUBJECT: &str = "Shrink the map markers a little";

pub fn finish(
    r: &TestRepo,
    outcome: &Outcome,
    marks: &HashMap<Mark, String>,
    content: &Content,
    rng: &mut Rng,
) -> Result<(), String> {
    let repo = r.path();
    let rafe = person("rafe");
    git_as(repo, rafe, SETUP, &["update-ref", "-d", SCRATCH])?;
    git_as(repo, rafe, SETUP, &["reset", "-q", "--hard", "main"])?;
    let origin = std::path::absolute(r.root().join("origin.git")).map_err(|e| e.to_string())?;
    origin_repo(repo, &origin, outcome, marks)?;
    teammate(&origin, outcome, marks, content)?;
    let origin_url = origin.to_str().ok_or("a UTF-8 origin path")?;
    git_as(repo, rafe, SETUP, &["remote", "add", "origin", origin_url])?;
    git_as(repo, rafe, SETUP, &["remote", "set-head", "origin", "main"])?;
    for name in outcome
        .refs
        .keys()
        .filter_map(|r| r.strip_prefix("refs/heads/"))
    {
        if outcome
            .refs
            .contains_key(&format!("refs/remotes/origin/{name}"))
        {
            git_as(
                repo,
                rafe,
                SETUP,
                &["config", &format!("branch.{name}.remote"), "origin"],
            )?;
            let merge = format!("refs/heads/{name}");
            git_as(
                repo,
                rafe,
                SETUP,
                &["config", &format!("branch.{name}.merge"), &merge],
            )?;
        }
    }
    stashes(repo)?;
    working_tree(repo, rng)?;
    forge_json(r.root(), outcome, marks)
}

fn origin_repo(
    repo: &Path,
    origin: &Path,
    outcome: &Outcome,
    marks: &HashMap<Mark, String>,
) -> Result<(), String> {
    let rafe = person("rafe");
    let root = origin.parent().ok_or("the origin's folder")?;
    git_as(
        root,
        rafe,
        SETUP,
        &["init", "-q", "--bare", "-b", "main", "origin.git"],
    )?;
    std::fs::write(
        origin.join("objects/info/alternates"),
        "../../repo/.git/objects\n",
    )
    .map_err(|e| e.to_string())?;
    for (name, mark) in &outcome.refs {
        if let Some(b) = name.strip_prefix("refs/remotes/origin/") {
            git_as(
                origin,
                rafe,
                SETUP,
                &["update-ref", &format!("refs/heads/{b}"), &marks[mark]],
            )?;
        }
    }
    let tags = git_as(
        repo,
        rafe,
        SETUP,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags",
        ],
    )?;
    for line in tags.lines() {
        let (name, sha) = line.split_once(' ').ok_or("a tag line")?;
        git_as(origin, rafe, SETUP, &["update-ref", name, sha])?;
    }
    Ok(())
}

/// A commit only the origin has, in the origin's own objects (the repo's objects are borrowed,
/// and its prune must never take this one). Its tune is one no test of Orbital's names or pins,
/// so main still passes its tests once the visitor pulls it.
fn teammate(
    origin: &Path,
    outcome: &Outcome,
    marks: &HashMap<Mark, String>,
    content: &Content,
) -> Result<(), String> {
    const KEY: &str = "crates/orbital-game/src/map_view.rs#const:MARKER_SIZE";
    let mut state = outcome.main.clone();
    let (n, old) =
        const_literal(content, KEY, &state).ok_or("map_view.rs needs a MARKER_SIZE constant")?;
    if pinned(content.corpus, KEY, &old) {
        return Err(format!("a test names or pins {KEY}"));
    }
    state.apply(&[Edit::set(KEY, Value::Tuned(n, Rc::from(tune(&old, 0.8))))]);
    let noor = person("noor");
    let t = END + 3 * 3_600;
    let mut h = History::new();
    let changes = h.changes([path_of(KEY).to_string()], |p| content.render(p, &state));
    let base = &marks[&outcome.refs["refs/remotes/origin/main"]];
    let m = h.commit_after(base, noor.sig(t), noor.sig(t), TEAMMATE_SUBJECT, &changes);
    h.reset("refs/demo/teammate", m);
    fast_import(origin, &h.finish(), None)?;
    git_as(origin, noor, t, &["update-ref", "-d", SCRATCH])?;
    Ok(())
}

/// `text` with the literal of `const NAME:` scaled by `factor`.
fn retune_named(text: &str, name: &str, factor: f64) -> Result<String, String> {
    let line = text
        .lines()
        .find(|l| l.contains(&format!("const {name}:")))
        .ok_or_else(|| format!("no const {name}"))?;
    let old = literal_of(line).ok_or_else(|| format!("{name} has no literal"))?;
    let new_line = retune(line, &tune(old, factor)).ok_or("retune")?;
    Ok(text.replacen(line, new_line.trim_end(), 1))
}

fn edit_file(
    repo: &Path,
    rel: &str,
    f: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    let p = repo.join(rel);
    let text = std::fs::read_to_string(&p).map_err(|e| format!("{rel}: {e}"))?;
    std::fs::write(&p, f(&text)?).map_err(|e| format!("{rel}: {e}"))
}

/// Rafe sets the clone up early that Friday afternoon (13:00, +00:00).
const SETUP: i64 = END - 5 * 3_600;
/// Friday afternoon, the last day of the two years, inside each one's working hours: Kasimir's
/// 16:00 (+02:00), Ilse's 17:00 (+01:00).
const KASIMIR_STASH: i64 = END - 4 * 3_600;
const ILSE_STASH: i64 = END - 2 * 3_600;

fn stashes(repo: &Path) -> Result<(), String> {
    let (kasimir, ilse) = (person("kasimir"), person("ilse"));
    git_as(
        repo,
        kasimir,
        KASIMIR_STASH - 300,
        &["switch", "-q", "feature/autopilot"],
    )?;
    edit_file(repo, "crates/orbital-game/src/autopilot.rs", |t| {
        retune_named(t, "AUTOPILOT_GAIN", 1.4)
    })?;
    git_as(
        repo,
        kasimir,
        KASIMIR_STASH,
        &[
            "stash",
            "push",
            "-q",
            "-m",
            "PID gains from Thursday's playtest",
        ],
    )?;
    git_as(repo, ilse, ILSE_STASH - 300, &["switch", "-q", "main"])?;
    edit_file(repo, "crates/orbital-render/src/bloom.rs", |t| {
        retune_named(t, "BLOOM_THRESHOLD", 0.8)
    })?;
    edit_file(repo, "crates/orbital-render/shaders/bloom.wgsl", |t| {
        Ok(format!(
            "{t}// Try 0.6 with the new tonemap before lowering it further.\n"
        ))
    })?;
    git_as(
        repo,
        ilse,
        ILSE_STASH,
        &["stash", "push", "-q", "-m", "Try a softer bloom threshold"],
    )?;
    Ok(())
}

fn working_tree(repo: &Path, rng: &mut Rng) -> Result<(), String> {
    let ilse = person("ilse");
    let hud = "crates/orbital-game/src/hud.rs";
    edit_file(repo, hud, |t| retune_named(t, "HUD_MARGIN", 1.25))?;
    git_as(repo, ilse, ILSE_STASH + 1_800, &["add", hud])?;
    edit_file(repo, hud, |t| {
        let f = "/// The HUD's scale for a window `height` pixels tall: 1 up to 720 px, then whole steps.\npub fn hud_scale(height: u32) -> u32 {\n    (height / 720).max(1)\n}\n";
        Ok(match t.find("\n#[cfg(test)]") {
            Some(at) => format!("{}\n{f}{}", &t[..at], &t[at..]),
            None => format!("{t}\n{f}"),
        })
    })?;
    std::fs::write(
        repo.join("assets/sprites/ships/scout.png"),
        super::art::scout_repaint().to_png(),
    )
    .map_err(|e| e.to_string())?;
    git_as(
        repo,
        ilse,
        ILSE_STASH + 1_800,
        &["add", "assets/sprites/ships/scout.png"],
    )?;
    let mut devlogs: Vec<String> = std::fs::read_dir(repo.join("docs/devlog"))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        // Dated entries only (`2026-09-…md`): the folder also holds the template.
        .filter(|n| n.ends_with(".md") && n.starts_with(|c: char| c.is_ascii_digit()))
        .collect();
    devlogs.sort();
    let latest = format!("docs/devlog/{}", devlogs.last().ok_or("no devlog")?);
    edit_file(repo, &latest, |t| {
        Ok(format!(
            "{t}\n**Edit:** in Thursday's playtest the autopilot overshot the second burn of a long transfer.\nKasimir is retuning its gain on his branch before it comes in.\n"
        ))
    })?;
    let table = "assets/data/economy/commodities.csv";
    edit_file(repo, table, |t| {
        data::tune_cell(t, ',', rng)
            .map(|c| c.text)
            .ok_or_else(|| "no cell to tune".to_string())
    })?;
    let notes = repo.join("notes/playtest-2026-10.md");
    std::fs::create_dir_all(notes.parent().ok_or("notes")?).map_err(|e| e.to_string())?;
    std::fs::write(
        &notes,
        "# Playtest, October\n\n- [ ] Autopilot overshoots the second burn\n- [ ] Station screen: keep the cargo list scrolled\n- [x] Docking chime plays once\n",
    )
    .map_err(|e| e.to_string())
}

fn forge_json(root: &Path, outcome: &Outcome, marks: &HashMap<Mark, String>) -> Result<(), String> {
    use serde_json::json;
    let mrs: Vec<serde_json::Value> = outcome
        .mrs
        .iter()
        .map(|m| {
            json!({
                "iid": m.iid,
                "title": m.title,
                "description": m.description.join("\n"),
                "source": m.source,
                "target": m.target,
                "author": person(m.author).email,
                "state": match m.state {
                    MrState::Merged => "merged",
                    MrState::Opened => "opened",
                    MrState::Draft => "draft",
                },
                "createdAt": iso_datetime(m.created),
                "mergedAt": m.merged.map(|(t, _)| iso_datetime(t)),
                "mergeCommit": m.merged.map(|(_, mark)| marks[&mark].clone()),
            })
        })
        .collect();
    let people: Vec<serde_json::Value> = PEOPLE
        .iter()
        .map(|p| json!({ "handle": p.handle, "name": p.name, "email": p.email }))
        .collect();
    let doc = json!({
        "version": 0,
        "note": "Placeholder: plan 4 (the demo's fake forge) owns this file's schema. It lists the merge requests Orbital's history implies; plan 4 adds pipelines, approvals, threads and diff notes.",
        "host": "gitlab.example.com",
        "project": "orbital/orbital",
        "webUrl": "https://gitlab.example.com/orbital/orbital",
        "people": people,
        "mergeRequests": mrs,
    });
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n";
    std::fs::write(root.join("forge.json"), text).map_err(|e| e.to_string())
}
