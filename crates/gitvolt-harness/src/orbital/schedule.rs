//! Lays the plan on Orbital's two years: each feature becomes a branch forked from its target at
//! its first step and merged back GitLab-style after review, or left as its fate says; direct
//! features commit on main; tuning fillers land on main between them; releases tag main or their
//! release branch, which merges back. Everything goes out through one `History`.

use super::calendar::{civil, iso_date, milestone_start, next_work_time, unix, END, START};
use super::content::Content;
use super::corpus::{fill, literal_of, subject_ok, tune, Corpus, Kind as BlockKind, Messages};
use super::data;
use super::history::{History, Mark};
use super::model::{changed_paths, path_of, Edit, Render, Snapshot, Value};
use super::people::{person, Person, PEOPLE};
use super::releases::{self, semver, Entry, Release, Section, EARLY_CUTS};
use super::story::{builds_on, human, Deferred, Derive, Fate, FeaturePlan, Kind, Step};
use crate::media::rng::Rng;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

pub const TARGET_COMMITS: usize = 1_400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MrState {
    Merged,
    Opened,
    Draft,
}

#[derive(Clone, Debug)]
pub struct MergeRequest {
    pub iid: u32,
    pub title: String,
    pub description: Vec<String>,
    pub source: String,
    pub target: String,
    pub author: &'static str,
    pub state: MrState,
    pub created: i64,
    pub merged: Option<(i64, Mark)>,
}

pub struct Outcome {
    pub refs: BTreeMap<String, Mark>,
    pub main: Snapshot,
    pub mrs: Vec<MergeRequest>,
    pub commits: usize,
    pub last_time: i64,
}

#[derive(Clone, Copy, Debug)]
enum Filler {
    Const,
    Cell,
    Dep,
}

#[derive(Clone, Copy, Debug)]
enum Event {
    Step { f: usize, i: usize },
    Merge { f: usize },
    Pull { f: usize },
    Forced { f: usize },
    Filler { who: &'static str, kind: Filler },
    Balance { b: usize },
    BalanceMerge { b: usize },
    /// A release branch cut from main ahead of its release.
    Cut { branch: &'static str },
    Release { r: usize },
    MergeBack { r: usize },
}

/// A balance pass: a playtest's tunes on a branch of their own, merged before the release.
struct Balance {
    name: String,
    title: String,
    author: &'static str,
    kind: Filler,
    steps: Vec<i64>,
    merge: i64,
}

/// Fillers at most: tunes are a seasoning, not most of main's history.
const MAX_FILLERS: usize = 300;

/// The playtest before each release that isn't a patch: the two weeks up to three days before
/// its milestone ends (the day before its tag), or before its branch is cut early.
fn playtests(releases: &[Release]) -> Vec<(i64, i64)> {
    releases
        .iter()
        .filter(|r| semver(r.version).2 == 0)
        .map(|r| {
            let end = match EARLY_CUTS.iter().find(|c| c.0 == r.branch) {
                Some(&(_, m)) => milestone_start(m),
                None => milestone_start(r.milestone + 1),
            } - 3 * 86_400;
            (end - 14 * 86_400, end)
        })
        .collect()
}

/// When each release is tagged and merged back and who by, and when each release branch is cut.
struct ReleaseTimes {
    tagged: Vec<i64>,
    back: Vec<Option<i64>>,
    by: Vec<&'static Person>,
    cuts: BTreeMap<&'static str, i64>,
}

/// Who tags a release: the author of the `later: release` feature at its milestone, else whoever
/// tags most of the others, else rafe.
fn releaser(plans: &[FeaturePlan], r: &Release) -> &'static Person {
    let tags: Vec<&FeaturePlan> = plans.iter().filter(|p| p.feature.later == Some(Deferred::Release)).collect();
    if let Some(p) = tags.iter().find(|p| p.feature.milestone == r.milestone) {
        return person(p.feature.author);
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for p in &tags {
        *counts.entry(p.feature.author).or_default() += 1;
    }
    counts.into_iter().max_by_key(|&(h, n)| (n, std::cmp::Reverse(h))).map_or_else(|| person("rafe"), |(h, _)| person(h))
}

/// The release a feature on a release branch ships in: the branch's first at or after its
/// milestone.
fn ships_in(releases: &[Release], target: &str, milestone: u32) -> Option<usize> {
    releases.iter().position(|r| r.branch == target && r.milestone >= milestone)
}

fn release_times(plans: &[FeaturePlan], releases: &[Release], rng: &mut Rng) -> ReleaseTimes {
    let mut rt = ReleaseTimes { tagged: Vec::new(), back: Vec::new(), by: Vec::new(), cuts: BTreeMap::new() };
    for &(branch, m) in &EARLY_CUTS {
        if releases.iter().any(|r| r.branch == branch) {
            rt.cuts.insert(branch, milestone_start(m) - 3_600);
        }
    }
    for r in releases {
        // Some time in the working day, two days before the milestone ends; merged back a day later.
        let by = releaser(plans, r);
        let t = at_work(by, milestone_start(r.milestone + 1) - 2 * 86_400 + rng.range(0, 6 * 3_600), rng).min(LATE);
        rt.tagged.push(t);
        rt.back.push(r.merges_back.then(|| at_work(by, t + 86_400 + rng.range(-3 * 3_600, 3 * 3_600), rng).min(END)));
        rt.by.push(by);
        if let Some(b) = r.cuts {
            rt.cuts.insert(b, t + 60);
        }
    }
    rt
}

struct Branch {
    tip: Mark,
    state: Snapshot,
    /// Every edit since the branch was made: what a merge applies to its target.
    log: Vec<Edit>,
    /// Main's state when the branch forked or last pulled it.
    base: Snapshot,
    /// Keys a pull merged line by line, with the branch's own value then: a later step setting
    /// one merges again, so main's lines stay.
    merged: BTreeMap<String, Value>,
}

impl Branch {
    fn new(tip: Mark, state: Snapshot) -> Branch {
        Branch { tip, base: state.clone(), state, log: Vec::new(), merged: BTreeMap::new() }
    }
}

struct Timing {
    steps: Vec<i64>,
    merge: Option<i64>,
    pulls: Vec<i64>,
    /// From the first step until it reaches main (or the end): the keys held there.
    held: (i64, i64),
    /// When it lands on its own target.
    lands: i64,
}

const LATE: i64 = END - 6 * 3_600;

/// Past `LATE`, work bunches up minutes apart instead, so nothing lands after the end.
fn clamp_late(prev: i64, t: i64, rng: &mut Rng) -> i64 {
    if t > LATE { (prev + rng.range(600, 3_600)).min(END) } else { t }
}

/// `t` if `who` is at work then, else some time into their next working day (not always first
/// thing: a morning of nothing but commits at nine reads as made up).
fn at_work(who: &Person, t: i64, rng: &mut Rng) -> i64 {
    let w = next_work_time(who, t, rng);
    if w == t { w } else { w + rng.range(0, i64::from(who.hours.1 - who.hours.0) * 3_600 * 6 / 10) }
}

/// At work, `hours` (a range) after `t`.
fn after(who: &Person, t: i64, hours: (u32, u32), rng: &mut Rng) -> i64 {
    let gap = rng.range(i64::from(hours.0) * 3_600, i64::from(hours.1) * 3_600 + 1);
    at_work(who, t + gap, rng)
}

fn merger(author: &str) -> &'static Person {
    person(if author == "ilse" { "rafe" } else { "ilse" })
}

/// Whether the schedule lays this feature out. A feature with no steps is made elsewhere (a
/// release, a special branch, content not written yet).
fn scheduled(p: &FeaturePlan) -> bool {
    !p.steps.is_empty()
}

/// A release branch's fix is written against the release: each key it changes is at the version
/// before its own there.
fn follows_on(p: &FeaturePlan, state: &Snapshot) {
    let mut seen = BTreeSet::new();
    for e in p.steps.iter().flat_map(|s| &s.edits) {
        let Some(Value::Version(n) | Value::Tuned(n, _)) = &e.value else { continue };
        if !seen.insert(&e.key) {
            continue;
        }
        let have = match state.get(&e.key) {
            Some(Value::Version(h) | Value::Tuned(h, _)) => *h,
            _ => 0,
        };
        assert!(have + 1 == *n, "{} sets {} to v{n} on {}, which has v{have}: what it follows landed on main after the cut", p.feature.slug, e.key, p.feature.target);
    }
}

/// The earliest a step can be: a devlog entry goes out on or after the date its front matter
/// gives (midnight, the author's time).
fn not_before(corpus: &Corpus, step: &Step, who: &Person) -> Option<i64> {
    step.edits
        .iter()
        .filter(|e| e.key.starts_with("docs/devlog/") && e.key.ends_with(".md"))
        .filter_map(|e| {
            let Some(Value::Version(n)) = &e.value else { return None };
            let text = &corpus.file(&e.key)?.blocks.first()?.versions.get(usize::from(*n).checked_sub(1)?)?.text;
            let date = text.lines().find_map(|l| l.strip_prefix("date: "))?.trim();
            let mut ymd = date.splitn(3, '-').map(str::parse::<u32>);
            let (Some(Ok(y)), Some(Ok(m)), Some(Ok(d))) = (ymd.next(), ymd.next(), ymd.next()) else { return None };
            Some(unix(i64::from(y), m, d, 0, 0) - i64::from(who.tz_minutes) * 60)
        })
        .max()
}

/// Who commits a step: a devlog entry's signer, else the feature's author.
fn committer(corpus: &Corpus, step: &Step, author: &str) -> &'static Person {
    step.edits
        .iter()
        .filter(|e| e.key.starts_with("docs/devlog/"))
        .find_map(|e| {
            let Some(Value::Version(n)) = &e.value else { return None };
            let text = &corpus.file(&e.key)?.blocks.first()?.versions.get(usize::from(*n).checked_sub(1)?)?.text;
            let name = text.lines().find_map(|l| l.strip_prefix("author: "))?.trim();
            PEOPLE.iter().find(|p| p.name.split(' ').next() == Some(name))
        })
        .unwrap_or_else(|| person(author))
}

fn timings(plans: &[FeaturePlan], corpus: &Corpus, releases: &[Release], rt: &mut ReleaseTimes, rng: &mut Rng) -> Vec<Option<Timing>> {
    let deps = builds_on(corpus, plans);
    let mut order: Vec<usize> = (0..plans.len()).filter(|&i| scheduled(&plans[i])).collect();
    order.sort_by_key(|&i| (plans[i].feature.milestone, i));
    let first = &plans[*order.first().expect("a feature to schedule")].feature;
    assert!(first.fate == Fate::Direct, "the first feature ({}) is direct: it makes the root commit", first.slug);
    // (target, key): until when a feature landing there holds the key.
    let mut busy: BTreeMap<(&str, &str), i64> = BTreeMap::new();
    let mut out: Vec<Option<Timing>> = (0..plans.len()).map(|_| None).collect();
    let span = milestone_start(2) - milestone_start(1);
    // A release branch's fix is written on top of the main features it shares keys with, so they
    // (and what they wait for, early enough for it to fit after them) land before the branch is
    // cut. A feature takes a day for every three steps at the most squeezed, plus a weekend. (An
    // early cut waits for its earlier milestones instead.)
    let mut deadline: Vec<i64> = vec![i64::MAX / 2; plans.len()];
    let takes = |p: &FeaturePlan| (p.steps.len() as i64 / 3 + 3) * 86_400;
    let lands_on_main = |j: usize| plans[j].feature.target == "main" && matches!(plans[j].feature.fate, Fate::Merged | Fate::Direct);
    for (n, &i) in order.iter().enumerate().rev() {
        let p = &plans[i];
        if let Some(&cut) = rt.cuts.get(p.feature.target.as_str())
            && !EARLY_CUTS.iter().any(|c| c.0 == p.feature.target)
        {
            deadline[i] = cut;
        }
        if deadline[i] >= i64::MAX / 2 {
            continue;
        }
        let by = if p.feature.target == "main" { deadline[i] - takes(p) } else { deadline[i] - 3_600 };
        for &j in &order[..n] {
            if lands_on_main(j) && (deps[i].contains(&j) || !plans[j].keys.is_disjoint(&p.keys)) {
                deadline[j] = deadline[j].min(by);
            }
        }
    }
    let mut root = START;
    let mut early: Vec<(&str, u32)> = EARLY_CUTS.iter().copied().filter(|c| rt.cuts.contains_key(c.0)).collect();
    for (n, &i) in order.iter().enumerate() {
        let p = &plans[i];
        let who = person(p.feature.author);
        let target = p.feature.target.as_str();
        // An early cut comes once the features of the few milestones before it have landed on
        // main (not the long-running ones, such as the devlog).
        early.retain(|&(branch, m)| {
            if p.feature.milestone < m {
                return true;
            }
            let recent = milestone_start(m.saturating_sub(3).max(1));
            let landed = order[..n]
                .iter()
                .filter(|&&j| plans[j].feature.milestone < m && lands_on_main(j))
                .filter_map(|&j| out[j].as_ref().filter(|t| t.held.0 >= recent).map(|t| t.lands))
                .max();
            let at = rt.cuts[branch].max(landed.map_or(START, |t| t + 3_600));
            rt.cuts.insert(branch, at);
            false
        });
        // A release branch's fix starts early in its milestone, once the branch is cut.
        let cut = (target != "main").then(|| *rt.cuts.get(target).unwrap_or_else(|| panic!("{} targets {target}, which no release cuts", p.feature.slug)));
        let window = if cut.is_some() { span * 3 / 10 } else { span * 6 / 10 };
        let mut planned = if n == 0 { START } else { milestone_start(p.feature.milestone) + rng.range(0, window) };
        let due = if cut.is_some() { i64::MAX / 2 } else { deadline[i] };
        if due < i64::MAX / 2 {
            planned = planned.min((due - takes(p)).max(milestone_start(p.feature.milestone)));
        }
        // After the root, after the features it builds on have landed, and after every feature
        // sharing one of its keys has landed. One that never lands doesn't hold anything up: its
        // branch just falls behind main there (fillers still leave its keys alone).
        let landed = deps[i].iter().filter_map(|&d| out[d].as_ref().map(|t: &Timing| if plans[d].feature.target == target { t.lands } else { t.held.1 }));
        let held = p.keys.iter().filter_map(|k| busy.get(&(target, k.as_str())).copied());
        let free = landed.chain(held).chain((n > 0).then_some(root)).chain(cut).max().map_or(planned, |t| planned.max(t + 3_600));
        let by: Vec<&Person> = p.steps.iter().map(|s| committer(corpus, s, p.feature.author)).collect();
        let floor = |k: usize, rng: &mut Rng| not_before(corpus, &p.steps[k], by[k]).map(|t| at_work(by[k], t, rng));
        let start = at_work(by[0], free, rng).max(floor(0, rng).unwrap_or(START));
        assert!(start < LATE, "feature {} can't start before the end: the features it waits for land too late", p.feature.slug);
        if n == 0 {
            root = start;
        }
        // A feature that started late (it waited on others) goes quicker, so the history doesn't
        // drift ever further behind its milestones.
        let late = u32::try_from((start - planned) / 86_400).unwrap_or(0);
        let hurry = |(lo, hi): (u32, u32)| if late > 1 { (lo, (hi / (1 + late / 2)).max(lo + 2)) } else { (lo, hi) };
        let gap = if p.feature.fate == Fate::LongLived { (24, 240) } else { hurry((1, 30)) };
        // Steps that wouldn't fit before the end come closer together (but stay hours apart),
        // rather than bunching up minutes apart on the last day.
        let mut steps = Vec::new();
        for squeeze in [1, 2, 4, 8, 16] {
            steps = vec![start];
            for (k, &who) in by.iter().enumerate().skip(1) {
                let prev = *steps.last().expect("a first step");
                let t = after(who, prev, (gap.0, (gap.1 / squeeze).max(gap.0 + 1)), rng).max(floor(k, rng).unwrap_or(START));
                steps.push(t);
            }
            if steps.last().is_some_and(|&t| t <= LATE.min(due - 12 * 3_600)) {
                break;
            }
        }
        for k in 1..steps.len() {
            steps[k] = clamp_late(steps[k - 1], steps[k], rng);
        }
        let last = *steps.last().expect("a step");
        let merge = (p.feature.fate == Fate::Merged).then(|| {
            let t = after(merger(p.feature.author), last, hurry((3, 48)), rng);
            let t = if t > due { before(merger(p.feature.author), last + 1_800, due, rng) } else { t };
            clamp_late(last, t, rng)
        });
        let pulls = if p.feature.fate == Fate::LongLived {
            [steps.len() / 3, 2 * steps.len() / 3]
                .into_iter()
                .map(|k| {
                    let t = after(who, steps[k], (1, 4), rng);
                    clamp_late(steps[k], t, rng)
                })
                .collect()
        } else {
            Vec::new()
        };
        let lands = match p.feature.fate {
            Fate::Merged => merge.expect("a merge time"),
            Fate::Direct => last,
            _ => i64::MAX / 2,
        };
        assert!(lands <= due, "{} lands on main on {}, after a release branch it's part of is cut ({})", p.feature.slug, iso_date(lands), iso_date(due));
        if matches!(p.feature.fate, Fate::Merged | Fate::Direct) {
            for k in &p.keys {
                busy.insert((target, k), lands);
            }
        }
        // A release branch's fix ships in the branch's release, and holds its keys on main until
        // the branch merges back.
        let (mut held_from, mut held_until) = (start, lands);
        if let Some(cut) = cut {
            held_from = cut;
            let r = ships_in(releases, target, p.feature.milestone).unwrap_or_else(|| panic!("{} targets {target}, which no later release tags", p.feature.slug));
            assert!(lands < rt.tagged[r], "{} merges into {target} after v{} is tagged", p.feature.slug, releases[r].version);
            held_until = rt.back[r].unwrap_or(i64::MAX / 2);
            for k in &p.keys {
                let until = busy.entry(("main", k)).or_default();
                *until = (*until).max(held_until);
            }
        }
        out[i] = Some(Timing { steps, merge, pulls, held: (held_from, held_until), lands });
    }
    out
}

struct Timeline<'a> {
    content: &'a Content<'a>,
    messages: &'a Messages,
    hist: &'a mut History,
    branches: BTreeMap<String, Branch>,
    mrs: Vec<MergeRequest>,
    commits: Vec<Vec<Mark>>,
    /// Sees each branch's state after each of its commits (the tests' build check).
    observe: &'a mut dyn FnMut(&str, &Snapshot, &str),
    /// What the first crate's manifest brings along: the workspace's.
    root: Vec<Edit>,
    /// The constants no tuning commit may change.
    pins: Pins,
}

/// The crate a path is in: `crates/orbital-game/` for its sources.
fn crate_dir(path: &str) -> &str {
    path.split_once("/src/").map_or(path, |(c, _)| c)
}

/// A literal's value: `1_200.0` is 1200, `0.35_f32` is 0.35.
fn value_of(literal: &str) -> Option<f64> {
    let digits: String = literal.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '_' || *c == '-').filter(|c| *c != '_').collect();
    digits.trim_end_matches('.').parse::<f64>().ok().map(|v| v + 0.0)
}

/// The numbers written in some code, as values (`300.0`, `1_200`, `65u32`), not the digits inside
/// a name (`v2`, `slot_3`).
fn numbers(text: &str) -> impl Iterator<Item = f64> + '_ {
    let b = text.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    (0..b.len()).filter(move |&i| b[i].is_ascii_digit() && (i == 0 || !ident(b[i - 1]))).filter_map(move |i| {
        let end = (i..b.len()).find(|&j| !(b[j].is_ascii_digit() || b[j] == b'_' || (b[j] == b'.' && b.get(j + 1).is_some_and(u8::is_ascii_digit)))).unwrap_or(b.len());
        value_of(&text[i..end])
    })
}

/// For each crate, every number any version of any of its tests writes: a constant whose value
/// is among them is pinned by a test (now, or once that test lands), and no filler retunes it.
fn test_numbers(corpus: &Corpus) -> BTreeMap<String, BTreeSet<u64>> {
    let mut out: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    for f in &corpus.files {
        let set = out.entry(crate_dir(&f.path).to_string()).or_default();
        for v in f.blocks.iter().filter(|b| b.kind == BlockKind::Test).flat_map(|b| &b.versions) {
            set.extend(numbers(&v.text).map(f64::to_bits));
        }
    }
    out
}

/// Every constant-like name (`MUSIC_VOLUME`) any version of any test writes, in any crate: a test
/// may hold a constant to a relation (`EFFECTS_GAIN / MUSIC_VOLUME` is 6 dB) that no single value
/// shows, so no filler retunes a constant a test names.
pub(crate) fn test_names(corpus: &Corpus) -> BTreeSet<String> {
    let tests = corpus.files.iter().flat_map(|f| &f.blocks).filter(|b| b.kind == BlockKind::Test).flat_map(|b| &b.versions);
    tests
        .flat_map(|v| v.text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')))
        .filter(|w| w.starts_with(|c: char| c.is_ascii_uppercase()) && w.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .map(str::to_string)
        .collect()
}

/// Every string literal any version of any test writes: a test that reads a table and looks up
/// a row by name (`"scout"`, `"Verdant"`) holds that row's numbers.
fn test_strings(corpus: &Corpus) -> BTreeSet<String> {
    let tests = corpus.files.iter().flat_map(|f| &f.blocks).filter(|b| b.kind == BlockKind::Test).flat_map(|b| &b.versions);
    tests.flat_map(|v| v.text.split('"').skip(1).step_by(2).map(str::to_string).collect::<Vec<_>>()).collect()
}

/// Whether a test names the constant, or a test of its crate writes its value (as it stands, or as
/// any version of the corpus wrote it): retuning it could fail that test.
fn pinned_by(corpus: &Corpus, named: &BTreeSet<String>, tested: &BTreeMap<String, BTreeSet<u64>>, key: &str, literal: &str) -> bool {
    if key.rsplit_once("#const:").is_some_and(|(_, name)| named.contains(name)) {
        return true;
    }
    let Some(tested) = tested.get(crate_dir(path_of(key))) else { return false };
    let path = path_of(key);
    let designed = corpus.file(path).and_then(|f| f.blocks.iter().find(|b| b.key(path) == key)).into_iter().flat_map(|b| &b.versions).filter_map(|v| literal_of(&v.text));
    designed.chain([literal]).filter_map(value_of).any(|v| tested.contains(&v.abs().to_bits()))
}

/// `pinned_by` with the corpus's tests: for a tune made outside the schedule (the teammate's).
pub(crate) fn pinned(corpus: &Corpus, key: &str, literal: &str) -> bool {
    pinned_by(corpus, &test_names(corpus), &test_numbers(corpus), key, literal)
}

/// The corpus's tests, read once: what the fillers and the reviews' tunes leave alone.
#[derive(Default)]
pub(crate) struct Pins {
    /// Each crate's numbers its tests write (`test_numbers`).
    tested: BTreeMap<String, BTreeSet<u64>>,
    /// The constants any test names (`test_names`).
    named: BTreeSet<String>,
    /// The strings any test writes (`test_strings`): a table row they name keeps its numbers.
    pub(crate) rows: BTreeSet<String>,
}

impl Pins {
    pub(crate) fn of(corpus: &Corpus) -> Self {
        Self { tested: test_numbers(corpus), named: test_names(corpus), rows: test_strings(corpus) }
    }

    /// Whether a tuning commit may change the constant from `literal`: a tunable number that no
    /// test pins.
    pub(crate) fn free(&self, corpus: &Corpus, key: &str, literal: &str) -> bool {
        tunable(key, literal) && !pinned_by(corpus, &self.named, &self.tested, key, literal)
    }
}

/// Whether a tune of a constant designed as `design` to `new` reads as one: never zero, and a
/// ratio such as a zoom step stays on its side of one (a zoom step of 1.0 zooms nothing).
pub(crate) fn sensible_tune(design: f64, new: f64) -> bool {
    new != 0.0 && (design == 1.0 || (design > 1.0) == (new > 1.0))
}

/// The edits that keep the workspace's dependencies in line with the member crates' manifests,
/// once the root Cargo.toml exists and a step touched a manifest.
fn dep_edits(content: &Content, state: &Snapshot, touched: &BTreeSet<String>) -> Vec<Edit> {
    if state.get("Cargo.toml#version").is_none() || !touched.iter().any(|p| releases::is_member_manifest(p)) {
        return Vec::new();
    }
    let used: BTreeSet<String> = state
        .paths()
        .into_iter()
        .filter(|p| releases::is_member_manifest(p))
        .filter_map(|p| content.render(&p, state))
        .flat_map(|b| releases::workspace_deps(&String::from_utf8_lossy(&b)))
        .collect();
    releases::sync_deps(state, &used)
}

impl Timeline<'_> {
    fn resolve(&self, d: &Derive, state: &Snapshot) -> Option<Edit> {
        match d {
            Derive::TuneConst { key, factor } => {
                let (n, old) = const_literal(self.content, key, state)?;
                Some(Edit::set(key.clone(), Value::Tuned(n, Rc::from(tune(&old, *factor)))))
            }
            Derive::TuneCell { path, row, column, factor } => {
                let text = String::from_utf8(self.content.render(path, state)?.to_vec()).ok()?;
                let t = data::set_cell(&text, data::delimiter(path)?, row, column, *factor)?;
                Some(Edit::set(path.clone(), Value::Bytes(Rc::from(t.text.into_bytes()))))
            }
        }
    }

    /// Commits `step` on `branch` as `who` at `t`; a branch with no tip yet makes the root.
    fn commit(&mut self, branch: &str, step: &Step, who: &'static Person, t: i64) -> Mark {
        let state = &self.branches[branch].state;
        let mut edits = step.edits.clone();
        if !self.root.is_empty() && edits.iter().any(|e| releases::is_member_manifest(path_of(&e.key))) {
            edits.splice(0..0, std::mem::take(&mut self.root));
        }
        for d in &step.derived {
            edits.push(self.resolve(d, state).unwrap_or_else(|| panic!("can't work out {d:?} on {branch}")));
        }
        let b = self.branches.get_mut(branch).expect("the branch");
        for e in &mut edits {
            if let (Some(own), Some(new)) = (b.merged.get(&e.key), &e.value) {
                let merged = merge_value(self.content.corpus, &e.key, Some(own), b.state.get(&e.key), new);
                b.merged.insert(e.key.clone(), new.clone());
                e.value = Some(merged);
            }
        }
        let mut touched = b.state.apply(&edits);
        let sync = dep_edits(self.content, &b.state, &touched);
        touched.extend(b.state.apply(&sync));
        edits.extend(sync);
        b.log.extend(edits);
        let parents: Vec<Mark> = if b.tip == 0 { Vec::new() } else { vec![b.tip] };
        let (content, state) = (self.content, &b.state);
        let changes = self.hist.changes(touched, |p| content.render(p, state));
        let m = self.hist.commit(&parents, who.sig(t), who.sig(t), &step.message, &changes);
        b.tip = m;
        (self.observe)(branch, &b.state, &step.message);
        m
    }

    /// Merges `source` into `target`; a kept source stays (a release branch merging back).
    fn merge(&mut self, source: &str, target: &str, message: &str, who: &'static Person, t: i64, keep: bool) -> Mark {
        let src = if keep {
            let b = &self.branches[source];
            Branch { tip: b.tip, state: b.state.clone(), log: b.log.clone(), base: Snapshot::default(), merged: BTreeMap::new() }
        } else {
            self.branches.remove(source).expect("the source branch")
        };
        let tgt = self.branches.get_mut(target).expect("the target branch");
        let touched = tgt.state.apply(&src.log);
        tgt.log.extend(src.log);
        let (content, state) = (self.content, &tgt.state);
        let changes = self.hist.changes(touched, |p| content.render(p, state));
        let m = self.hist.commit(&[tgt.tip, src.tip], who.sig(t), who.sig(t), message, &changes);
        tgt.tip = m;
        (self.observe)(target, &tgt.state, message);
        m
    }

    /// Merges main into a long-lived branch: main's state plus what the branch changed since it
    /// last synced. A key both changed (a header's `mod` lines, a manifest's dependencies) merges
    /// line by line.
    fn pull_main(&mut self, branch: &str, who: &'static Person, t: i64) {
        let main = &self.branches["main"];
        let (main_tip, theirs) = (main.tip, main.state.clone());
        let b = self.branches.get_mut(branch).expect("the long-lived branch");
        let mut edits: Vec<Edit> = b.base.keys().filter(|(k, _)| b.state.get(k).is_none()).map(|(k, _)| Edit::remove(k.clone())).collect();
        let mut own: Vec<(String, Value)> = Vec::new();
        for (k, mine) in b.state.keys() {
            let base = b.base.get(k);
            if base == Some(mine) {
                continue;
            }
            let main_has = theirs.get(k);
            if main_has == base || main_has == Some(mine) {
                edits.push(Edit::set(k.clone(), mine.clone()));
            } else {
                own.push((k.clone(), b.merged.get(k).unwrap_or(mine).clone()));
                edits.push(Edit::set(k.clone(), merge_value(self.content.corpus, k, base, main_has, mine)));
            }
        }
        b.merged.extend(own);
        let mut state = theirs.clone();
        state.apply(&edits);
        let sync = dep_edits(self.content, &state, &changed_paths(&b.state, &state));
        state.apply(&sync);
        let touched = changed_paths(&b.state, &state);
        b.state = state;
        b.base = theirs;
        let (content, state) = (self.content, &b.state);
        let changes = self.hist.changes(touched, |p| content.render(p, state));
        let message = format!("Merge branch 'main' into {branch}");
        b.tip = self.hist.commit(&[b.tip, main_tip], who.sig(t), who.sig(t), &message, &changes);
        (self.observe)(branch, &b.state, &message);
    }

    /// A tune of a constant or a table cell on `on`'s state, leaving alone the keys `avoid` names.
    fn tune_step(&self, on: &str, who: &Person, kind: Filler, avoid: &dyn Fn(&str) -> bool, rng: &mut Rng) -> Option<Step> {
        let main = &self.branches[on].state;
        let free = |k: &str| !avoid(k);
        // A template whose subject keeps the house style (72 characters at most) with these values.
        let fitting = |pool: &str, vars: &[(&str, &str)], rng: &mut Rng| (0..8).map(|_| fill(&self.messages.pick(pool, rng), vars)).find(|m| subject_ok(m).is_ok());
        let step = match kind {
            Filler::Cell => {
                let tables: Vec<String> = main.paths().into_iter().filter(|p| data::delimiter(p).is_some() && free(p)).collect();
                if tables.is_empty() {
                    return None;
                }
                let path = rng.pick(&tables).clone();
                let text = self.content.render(&path, main).and_then(|b| String::from_utf8(b.to_vec()).ok())?;
                // The table as last written, for the values a balance pass stays near.
                let design = self.content.corpus.file(&path).and_then(|f| f.blocks.first()?.versions.iter().rev().find(|v| !v.removed)).map_or(text.as_str(), |v| v.text.as_str());
                let c = data::tune_cell_near(&text, design, data::delimiter(&path).expect("a table"), &self.pins.rows, rng)?;
                let message = fitting("tune-cell", &[("row", &c.row), ("column", &c.column.replace('_', " ")), ("old", &c.old), ("new", &c.new)], rng)?;
                Step::new(message, vec![Edit::set(path, Value::Bytes(Rc::from(c.text.into_bytes())))])
            }
            Filler::Dep if main.keys().any(|(k, _)| k.starts_with("Cargo.toml#dep:")) => {
                let deps: Vec<&String> = main.keys().map(|(k, _)| k).filter(|k| k.starts_with("Cargo.toml#dep:") && free(k) && releases::next_version(main, k).is_some()).collect();
                if deps.is_empty() {
                    return None;
                }
                releases::bump(main, rng.pick(&deps), self.messages, rng)?
            }
            // Without a workspace manifest (the tests' small histories), a dependency bump
            // retunes a constant instead.
            Filler::Dep | Filler::Const => {
                let area = match who.handle {
                    "ilse" => "crates/orbital-core/",
                    "teodor" => "crates/orbital-render/",
                    "kasimir" => "crates/orbital-game/",
                    _ => "",
                };
                let consts: Vec<(&String, u16, String)> = main
                    .keys()
                    .filter(|(k, _)| k.contains("#const:") && free(k))
                    .filter_map(|(k, _)| {
                        let (n, lit) = const_literal(self.content, k, main)?;
                        self.pins.free(self.content.corpus, k, &lit).then_some((k, n, lit))
                    })
                    .collect();
                let preferred: Vec<&(&String, u16, String)> = consts.iter().filter(|c| c.0.starts_with(area)).collect();
                let pool: Vec<&(&String, u16, String)> = if preferred.is_empty() { consts.iter().collect() } else { preferred };
                if pool.is_empty() {
                    return None;
                }
                let (key, n, old) = *rng.pick(&pool);
                let factor = f64::from(if rng.chance(0.5) { rng.range_f(1.05, 1.3) } else { rng.range_f(0.75, 0.95) });
                let number = |s: &str| s.replace('_', "").parse::<f64>().unwrap_or(0.0);
                // Nudged, not walked off: within a factor of 1.5 of the value as written, never
                // down to zero, and a ratio stays on its side of one.
                let design = self.content.corpus.file(path_of(key)).and_then(|f| f.blocks.iter().find(|b| b.key(path_of(key)) == **key)).and_then(|b| literal_of(&b.versions[usize::from(*n) - 1].text)).map(number);
                let strays = |lit: &str| design.is_some_and(|d| d != 0.0 && (!(1.0 / 1.5..=1.5).contains(&(number(lit) / d)) || !sensible_tune(d, number(lit))));
                // This way or the other; a value with no room either way waits for another day.
                let new = [factor, 1.0 / factor].into_iter().map(|f| tune(old, f)).find(|x| !strays(x) && number(x) != 0.0)?;
                let pool_name = if number(&new) > number(old) { "tune-up" } else { "tune-down" };
                let name = key.rsplit_once("#const:").map_or("", |x| x.1);
                let message = fitting(pool_name, &[("what", &human(name)), ("old", old), ("new", &new)], rng)?;
                Step::new(message, vec![Edit::set(key.to_string(), Value::Tuned(*n, Rc::from(new)))])
            }
        };
        Some(step)
    }
}

/// A key's text: a header (or its partial cut), a whole file, a table a filler retuned.
fn text_of(corpus: &Corpus, key: &str, value: &Value) -> Option<String> {
    let path = path_of(key);
    let block = || corpus.file(path)?.blocks.iter().find(|b| b.key(path) == key);
    match value {
        Value::Tuned(_, t) if key.ends_with("#header") => Some(t.to_string()),
        Value::Version(n) if key.ends_with("#header") || key == path => {
            let v = block()?.versions.get(usize::from(*n).checked_sub(1)?)?;
            Some(if v.removed { String::new() } else { v.text.clone() })
        }
        Value::Bytes(b) => String::from_utf8(b.to_vec()).ok(),
        _ => None,
    }
}

/// The kind of sorted run a line sits in, if any.
fn run_of(line: &str) -> Option<&'static str> {
    let l = line.strip_prefix("pub ").unwrap_or(line);
    if l.starts_with("mod ") {
        Some("mod")
    } else if l.starts_with("use ") {
        Some("use")
    } else if line.starts_with(|c: char| c.is_ascii_lowercase()) && line.contains(" = ") {
        Some("key")
    } else {
        None
    }
}

/// `mine` merged line by line with `theirs` since `base`: their lines, without the ones mine
/// dropped, and with the ones mine added, each after the line it follows in mine (and in order
/// within a sorted run). Anything that isn't text (an item, a constant) keeps mine.
fn merge_value(corpus: &Corpus, key: &str, base: Option<&Value>, theirs: Option<&Value>, mine: &Value) -> Value {
    let text = |v: Option<&Value>| v.map_or(Some(String::new()), |v| text_of(corpus, key, v));
    let (Some(base), Some(theirs), Some(own)) = (text(base), text(theirs), text_of(corpus, key, mine)) else { return mine.clone() };
    let lines = |s: &str| s.lines().map(str::to_string).collect::<Vec<_>>();
    let (base, theirs, own) = (lines(&base), lines(&theirs), lines(&own));
    let dropped = |l: &String| !l.trim().is_empty() && base.contains(l) && !own.contains(l);
    let mut out: Vec<String> = theirs.iter().filter(|l| !dropped(l)).cloned().collect();
    for (i, l) in own.iter().enumerate() {
        if l.trim().is_empty() || base.contains(l) || out.contains(l) {
            continue;
        }
        let mut at = own[..i].iter().rev().find_map(|p| out.iter().position(|o| o == p)).map_or(0, |p| p + 1);
        // Within a sorted run (`mod` lines, `use` lines, a manifest's dependencies), in order.
        while at < out.len() && run_of(&out[at]).is_some() && run_of(&out[at]) == run_of(l) && out[at] < *l {
            at += 1;
        }
        out.insert(at, l.clone());
    }
    let text: String = out.iter().map(|l| format!("{l}\n")).collect();
    match mine {
        Value::Version(n) | Value::Tuned(n, _) if key.ends_with("#header") => Value::Tuned(*n, Rc::from(text.as_str())),
        _ => Value::Bytes(Rc::from(text.into_bytes())),
    }
}

/// The constant's version and current literal on `state`.
pub(crate) fn const_literal(content: &Content, key: &str, state: &Snapshot) -> Option<(u16, String)> {
    let (path, _) = key.split_once("#const:")?;
    match state.get(key)? {
        Value::Tuned(n, lit) => Some((*n, lit.to_string())),
        Value::Version(n) => {
            let block = content.corpus.file(path)?.blocks.iter().find(|b| b.key(path) == key)?;
            Some((*n, literal_of(&block.versions[*n as usize - 1].text)?.to_string()))
        }
        _ => None,
    }
}

/// Whether a filler may retune the constant: a gameplay or feel number, not a size, slot, tick
/// count, format, seed or physical constant, and not zero (scaling would only step it away).
fn tunable(key: &str, literal: &str) -> bool {
    const FIXED: [&str; 18] = ["CAPACITY", "SLOT", "TICK", "VERSION", "SEED", "SIZE", "EPSILON", "PORT", "PACKET", "BYTES", "GLYPH", "DIGIT", "ROW_", "WARP_", "PEERS", "LEVEL", "TONNES", "KN_PER"];
    let name = key.rsplit_once("#const:").map_or("", |x| x.1);
    name != "G" && !FIXED.iter().any(|w| name.contains(w)) && literal.replace('_', "").parse::<f64>().is_ok_and(|v| v != 0.0)
}

pub fn run(plans: &[FeaturePlan], content: &Content, messages: &Messages, hist: &mut History, rng: &mut Rng, releases: &[Release], target: usize) -> Outcome {
    run_observed(plans, content, messages, hist, rng, releases, target, &mut |_, _, _| {})
}

/// The latest time in `(lo, hi]`, give or take half an hour, that `who` is at work: a merge
/// squeezed in before a deadline.
fn before(who: &Person, lo: i64, hi: i64, rng: &mut Rng) -> i64 {
    let mut t = hi - rng.range(0, 1_800);
    while t > lo {
        if next_work_time(who, t, rng) == t {
            return t;
        }
        t -= 1_800;
    }
    hi.max(lo)
}

#[allow(clippy::too_many_arguments)]
fn run_observed(plans: &[FeaturePlan], content: &Content, messages: &Messages, hist: &mut History, rng: &mut Rng, releases: &[Release], target: usize, observe: &mut dyn FnMut(&str, &Snapshot, &str)) -> Outcome {
    let mut rt = release_times(plans, releases, rng);
    let times = timings(plans, content.corpus, releases, &mut rt, rng);
    let mut events: Vec<(i64, usize, Event)> = Vec::new();
    // Releases first, so one sorts before anything else at its time.
    for (r, (&t, back)) in rt.tagged.iter().zip(&rt.back).enumerate() {
        events.push((t, events.len(), Event::Release { r }));
        if let Some(t) = *back {
            events.push((t, events.len(), Event::MergeBack { r }));
        }
    }
    for (&branch, &t) in &rt.cuts {
        if !releases.iter().any(|r| r.cuts == Some(branch)) {
            events.push((t, events.len(), Event::Cut { branch }));
        }
    }
    let cuts = events.iter().filter(|e| matches!(e.2, Event::Cut { .. })).count();
    for (f, (p, tm)) in plans.iter().zip(&times).enumerate() {
        let Some(tm) = tm else { continue };
        for (i, &t) in tm.steps.iter().enumerate() {
            events.push((t, events.len(), Event::Step { f, i }));
        }
        if let Some(t) = tm.merge {
            events.push((t, events.len(), Event::Merge { f }));
        }
        for &t in &tm.pulls {
            events.push((t, events.len(), Event::Pull { f }));
        }
        // At work, the hours after the fork or a little later.
        if let Some((hours, who, _)) = &p.forced_main {
            let t = at_work(person(who), tm.steps[0] + i64::from(*hours) * 3_600, rng).min(END);
            events.push((t, events.len(), Event::Forced { f }));
        }
    }
    // Every planned event is one commit; fillers make up the rest, up to `MAX_FILLERS` (a few at
    // least, even in tests). Three in four go into balance passes before the releases, two a
    // playtest; the rest land on main, half of them in the playtests too. Two a day at most.
    let budget = target.saturating_sub(events.len() - cuts).clamp((target / 4).min(40), MAX_FILLERS);
    let windows = playtests(releases);
    let (direct, per_pass) = if windows.is_empty() { (budget, 0) } else { (budget / 4, (budget - budget / 4).div_ceil(2 * windows.len()).clamp(2, 8)) };
    let mut per_day: BTreeMap<i64, u32> = BTreeMap::new();
    let mut balances: Vec<Balance> = Vec::new();
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (w, &(from, to)) in windows.iter().enumerate() {
        let (y, mo, _) = civil(to);
        let month = MONTHS[mo as usize - 1];
        let passes = [
            ("wen", Filler::Cell, "tables", format!("Rebalance the tables after the {month} playtest")),
            (["ilse", "teodor", "kasimir", "rafe"][w % 4], Filler::Const, "numbers", format!("Retune the numbers after the {month} playtest")),
        ];
        for (who, kind, what, title) in passes {
            let p = person(who);
            let mut steps = Vec::new();
            let mut at = at_work(p, from + rng.range(0, 2 * 86_400), rng);
            while steps.len() < per_pass && at < to - 86_400 {
                steps.push(at);
                *per_day.entry(at.div_euclid(86_400)).or_default() += 1;
                at = at_work(p, at + rng.range(24 * 3_600, 36 * 3_600), rng);
            }
            let Some(&last) = steps.last() else { continue };
            // Merged before the playtest's end, at work, and not in the same minutes as another
            // pass's merge.
            let by = merger(who);
            let mut merge = after(by, last, (3, 20), rng);
            if merge > to {
                merge = before(by, last + 3_600, to, rng);
            }
            for _ in 0..8 {
                let Some(other) = balances.iter().map(|b| b.merge).find(|m| (m - merge).abs() < 600) else { break };
                let off = rng.range(600, 3_601);
                let t = if rng.chance(0.5) { other - off } else { other + off };
                if t > last + 1_800 && next_work_time(by, t, rng) == t {
                    merge = t;
                }
            }
            balances.push(Balance { name: format!("balance/playtest-{y}-{mo:02}-{what}"), title, author: who, kind, steps, merge });
        }
    }
    for (b, bal) in balances.iter().enumerate() {
        for &t in &bal.steps {
            events.push((t, events.len(), Event::Balance { b }));
        }
        events.push((bal.merge, events.len(), Event::BalanceMerge { b }));
    }
    for n in 0..direct {
        let (who, kind) = match rng.unit() {
            u if u < 0.5 => (*rng.pick(&["ilse", "teodor", "kasimir", "rafe"]), Filler::Const),
            u if u < 0.8 => ("wen", Filler::Cell),
            _ => ("rafe", Filler::Dep),
        };
        // A time they're at work on a day with room, drawn again rather than moved to the next
        // morning, so fillers don't pile up on Monday mornings.
        let p = person(who);
        let draw = |rng: &mut Rng| match windows.as_slice() {
            [] => rng.range(START + 14 * 86_400, END - 2 * 86_400),
            ws if n % 2 == 0 => {
                let (from, to) = *rng.pick(ws);
                rng.range(from, to)
            }
            _ => rng.range(START + 14 * 86_400, END - 2 * 86_400),
        };
        let fits = |t: i64, per_day: &BTreeMap<i64, u32>| per_day.get(&t.div_euclid(86_400)).copied().unwrap_or(0) < 2;
        let mut t = draw(rng);
        let mut tries = 0;
        while (next_work_time(p, t, rng) != t || !fits(t, &per_day)) && tries < 64 {
            t = draw(rng);
            tries += 1;
        }
        if tries == 64 {
            continue;
        }
        let t = t.min(LATE);
        *per_day.entry(t.div_euclid(86_400)).or_default() += 1;
        events.push((t, events.len(), Event::Filler { who, kind }));
    }
    events.sort_by_key(|e| (e.0, e.1));

    let root = if releases.is_empty() { Vec::new() } else { releases::initial_edits() };
    let mut tl = Timeline { content, messages, hist, branches: BTreeMap::new(), mrs: Vec::new(), commits: vec![Vec::new(); plans.len()], observe, root, pins: Pins::of(content.corpus) };
    tl.branches.insert("main".into(), Branch::new(0, Snapshot::default()));
    // Each branch's merge requests since its last release (or since it was cut), and each
    // release's merge back.
    let mut unreleased: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    let mut back_mrs: BTreeMap<usize, u32> = BTreeMap::new();
    let mut diverge_base: BTreeMap<usize, (Mark, Snapshot)> = BTreeMap::new();
    // Each balance pass's merge request and the keys it has tuned.
    let mut passes: Vec<(Option<u32>, BTreeSet<String>)> = vec![(None, BTreeSet::new()); balances.len()];
    let holding = |from: i64, to: i64| -> BTreeSet<&str> {
        plans.iter().zip(&times).filter(|(_, tm)| tm.as_ref().is_some_and(|tm| tm.held.0 < to && from < tm.held.1)).flat_map(|(p, _)| p.keys.iter().map(String::as_str)).collect()
    };
    let mut last_time = START;
    for (t, _, e) in events {
        last_time = last_time.max(t);
        match e {
            Event::Step { f, i } => {
                let p = &plans[f];
                let who = committer(content.corpus, &p.steps[i], p.feature.author);
                if p.feature.fate == Fate::Direct {
                    let m = tl.commit("main", &p.steps[i], who, t);
                    tl.commits[f].push(m);
                    continue;
                }
                let name = p.feature.branch();
                if i == 0 {
                    let base = tl.branches.get(&p.feature.target).unwrap_or_else(|| panic!("{} forks from {}, which doesn't exist yet", name, p.feature.target));
                    if p.feature.target != "main" {
                        follows_on(p, &base.state);
                    }
                    let fork = Branch::new(base.tip, base.state.clone());
                    tl.branches.insert(name.clone(), fork);
                    if p.feature.fate != Fate::LongLived {
                        let state = if p.feature.fate == Fate::Draft { MrState::Draft } else { MrState::Opened };
                        let iid = tl.mrs.len() as u32 + 1;
                        tl.mrs.push(MergeRequest {
                            iid,
                            title: p.feature.title.clone(),
                            description: p.feature.description.clone(),
                            source: name.clone(),
                            target: p.feature.target.clone(),
                            author: p.feature.author,
                            state,
                            created: t,
                            merged: None,
                        });
                    }
                }
                // A diverged branch: the last three steps split, the first of them stays local
                // and the other two go to origin on top of the shared part.
                let n = p.steps.len();
                if p.feature.fate == Fate::Diverged && i == n - 2 {
                    let (tip, state) = diverge_base[&f].clone();
                    let b = tl.branches.get_mut(&name).expect("the branch");
                    b.tip = tip;
                    b.state = state;
                }
                let m = tl.commit(&name, &p.steps[i], who, t);
                tl.commits[f].push(m);
                if p.feature.fate == Fate::Diverged && i + 4 == n {
                    let b = &tl.branches[&name];
                    diverge_base.insert(f, (b.tip, b.state.clone()));
                }
            }
            Event::Merge { f } => {
                let p = &plans[f];
                let name = p.feature.branch();
                let closes = if rng.chance(0.4) { format!("Closes #{}\n\n", rng.range(1, 400)) } else { String::new() };
                let iid = tl.mrs.iter().find(|m| m.source == name).expect("its merge request").iid;
                let message = format!("Merge branch '{name}' into '{}'\n\n{}\n\n{closes}See merge request orbital/orbital!{iid}", p.feature.target, p.feature.title);
                let m = tl.merge(&name, &p.feature.target, &message, merger(p.feature.author), t, false);
                let mr = tl.mrs.iter_mut().find(|m| m.iid == iid).expect("its merge request");
                mr.state = MrState::Merged;
                mr.merged = Some((t, m));
                unreleased.entry(p.feature.target.clone()).or_default().push(Entry { kind: p.feature.kind, title: p.feature.title.clone(), iid });
            }
            Event::Pull { f } => tl.pull_main(&plans[f].feature.branch(), person(plans[f].feature.author), t),
            Event::Forced { f } => {
                let (_, who, step) = plans[f].forced_main.as_ref().expect("a forced step");
                tl.commit("main", step, person(who), t);
            }
            Event::Filler { who, kind } => {
                // Not a key a feature or an open balance pass holds.
                let held = holding(t, t + 1);
                let open: BTreeSet<&str> = balances.iter().zip(&passes).filter(|(b, _)| tl.branches.contains_key(&b.name)).flat_map(|(_, (_, keys))| keys.iter().map(String::as_str)).collect();
                if let Some(step) = tl.tune_step("main", person(who), kind, &|k| held.contains(k) || open.contains(k), rng) {
                    tl.commit("main", &step, person(who), t);
                }
            }
            Event::Balance { b } => {
                // The pass leaves alone every key a feature holds while it's open, and any that
                // changed on main since it forked, so its merge only brings its tunes.
                let bal = &balances[b];
                let who = person(bal.author);
                let reserved = holding(bal.steps[0], bal.merge);
                let open = tl.branches.contains_key(&bal.name);
                let step = {
                    let main = &tl.branches["main"].state;
                    let base = tl.branches.get(&bal.name).map(|br| &br.base);
                    let avoid = |k: &str| reserved.contains(k) || base.is_some_and(|base| main.get(k) != base.get(k));
                    tl.tune_step(if open { &bal.name } else { "main" }, who, bal.kind, &avoid, rng)
                };
                let Some(step) = step else { continue };
                if !open {
                    let main = &tl.branches["main"];
                    let fork = Branch::new(main.tip, main.state.clone());
                    tl.branches.insert(bal.name.clone(), fork);
                    let iid = tl.mrs.len() as u32 + 1;
                    tl.mrs.push(MergeRequest {
                        iid,
                        title: bal.title.clone(),
                        description: vec!["Numbers from the playtest, ahead of the release.".to_string()],
                        source: bal.name.clone(),
                        target: "main".to_string(),
                        author: bal.author,
                        state: MrState::Opened,
                        created: t,
                        merged: None,
                    });
                    passes[b].0 = Some(iid);
                }
                passes[b].1.extend(step.edits.iter().map(|e| e.key.clone()));
                tl.commit(&bal.name, &step, who, t);
            }
            Event::BalanceMerge { b } => {
                let bal = &balances[b];
                let Some(iid) = passes[b].0 else { continue };
                let message = format!("Merge branch '{}' into 'main'\n\n{}\n\nSee merge request orbital/orbital!{iid}", bal.name, bal.title);
                let m = tl.merge(&bal.name, "main", &message, merger(bal.author), t, false);
                let mr = tl.mrs.iter_mut().find(|m| m.iid == iid).expect("its merge request");
                mr.state = MrState::Merged;
                mr.merged = Some((t, m));
                unreleased.entry("main".into()).or_default().push(Entry { kind: Kind::Balance, title: bal.title.clone(), iid });
            }
            Event::Cut { branch } => {
                let main = &tl.branches["main"];
                let fork = Branch::new(main.tip, main.state.clone());
                tl.branches.insert(branch.to_string(), fork);
                let entries = unreleased.remove("main").unwrap_or_default();
                unreleased.insert(branch.to_string(), entries);
            }
            Event::Release { r } => {
                let (rel, by) = (&releases[r], rt.by[r]);
                assert!(tl.branches.contains_key(rel.branch), "v{} is tagged on {}, which doesn't exist yet", rel.version, rel.branch);
                let section = Section { version: rel.version.to_string(), date: iso_date(t), entries: unreleased.remove(rel.branch).unwrap_or_default() };
                let notes: String = releases::ordered(&section).iter().take(3).map(|e| format!("- {}\n", e.title)).collect();
                let note = if notes.is_empty() { format!("Orbital {}\n", rel.version) } else { format!("Orbital {}\n\n{notes}", rel.version) };
                content.sections.borrow_mut().push(section);
                let version = Value::Text(Rc::from(rel.version));
                let step = Step::new(format!("Release v{}", rel.version), vec![Edit::set("Cargo.toml#version", version.clone()), Edit::set("CHANGELOG.md#version", version)]);
                let m = tl.commit(rel.branch, &step, by, t);
                tl.hist.tag(&format!("v{}", rel.version), m, by.sig(t + 300), &note);
                if let Some(branch) = rel.cuts {
                    let state = tl.branches[rel.branch].state.clone();
                    tl.branches.insert(branch.to_string(), Branch::new(m, state));
                    unreleased.insert(branch.to_string(), Vec::new());
                }
                if rel.merges_back {
                    let iid = tl.mrs.len() as u32 + 1;
                    tl.mrs.push(MergeRequest {
                        iid,
                        title: format!("Bring {} back into main", rel.version),
                        description: vec![format!("The fixes and the changelog from {}.", rel.version)],
                        source: rel.branch.to_string(),
                        target: "main".to_string(),
                        author: by.handle,
                        state: MrState::Opened,
                        created: t + 600,
                        merged: None,
                    });
                    back_mrs.insert(r, iid);
                }
            }
            Event::MergeBack { r } => {
                let rel = &releases[r];
                let iid = back_mrs[&r];
                // Main hasn't touched what the branch changed (the fixes' keys are held there),
                // so the merge only brings the branch's work.
                let (main, branch) = (&tl.branches["main"], &tl.branches[rel.branch]);
                if let Some(e) = branch.log.iter().find(|e| !e.key.ends_with("#version") && main.state.get(&e.key) != branch.base.get(&e.key)) {
                    panic!("main changed {} since {} was cut: merging it back would undo that", e.key, rel.branch);
                }
                let message = format!("Merge branch '{}' into 'main'\n\nBring {} back into main\n\nSee merge request orbital/orbital!{iid}", rel.branch, rel.version);
                let m = tl.merge(rel.branch, "main", &message, rt.by[r], t, true);
                let mr = tl.mrs.iter_mut().find(|m| m.iid == iid).expect("its merge request");
                mr.state = MrState::Merged;
                mr.merged = Some((t, m));
                // The branch's next patch release brings back only what comes after this one.
                let main = tl.branches["main"].state.clone();
                let b = tl.branches.get_mut(rel.branch).expect("the release branch");
                b.log.clear();
                b.base = main;
            }
        }
    }

    let mut refs = BTreeMap::new();
    let main_tip = tl.branches["main"].tip;
    refs.insert("refs/heads/main".to_string(), main_tip);
    refs.insert("refs/remotes/origin/main".to_string(), main_tip);
    for (f, p) in plans.iter().enumerate() {
        if p.feature.fate == Fate::Direct {
            continue;
        }
        let name = p.feature.branch();
        let Some(b) = tl.branches.get(&name) else { continue };
        let c = &tl.commits[f];
        let back = |k: usize| {
            assert!(c.len() > k, "{} needs more than {k} commits for its fate", p.feature.slug);
            c[c.len() - 1 - k]
        };
        let (head, origin) = match p.feature.fate {
            Fate::Unpushed(k) => (b.tip, back(usize::from(k))),
            Fate::RemoteAhead(k) => (back(usize::from(k)), b.tip),
            Fate::Diverged => {
                assert!(c.len() >= 4, "{} needs four steps to diverge", p.feature.slug);
                (c[c.len() - 3], b.tip)
            }
            _ => (b.tip, b.tip),
        };
        refs.insert(format!("refs/heads/{name}"), head);
        refs.insert(format!("refs/remotes/origin/{name}"), origin);
        if p.feature.fate == Fate::Irebase {
            let (lower, at) = super::specials::HUD_STACK;
            refs.insert(format!("refs/heads/{lower}"), c[at]);
            refs.insert(format!("refs/remotes/origin/{lower}"), c[at]);
        }
    }
    for name in releases.iter().flat_map(|r| [Some(r.branch), r.cuts]).flatten().filter(|b| *b != "main") {
        if let Some(b) = tl.branches.get(name) {
            refs.insert(format!("refs/heads/{name}"), b.tip);
            refs.insert(format!("refs/remotes/origin/{name}"), b.tip);
        }
    }
    for (r, m) in &refs {
        tl.hist.reset(r, *m);
    }
    let main = tl.branches.remove("main").expect("main").state;
    Outcome { refs, main, mrs: tl.mrs, commits: tl.hist.commits(), last_time }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbital::corpus::{subject_ok, Corpus, FEATURES};
    use crate::orbital::history::{fast_import, read_marks};
    use crate::orbital::releases::RELEASES;
    use crate::orbital::story::{check, parse_features, plan};
    use std::process::Command;

    const CORPUS: &str = r#"#file src/lib.rs
#header v1 @start
//! Lib.
#const SPEED v1 @start
pub const SPEED: f32 = 10.0;
#const RANGE v1 @start
pub const RANGE: u32 = 400;
#item a v1 @start "Add a"
pub fn a() {}
#item b v1 @bee "Add b"
pub fn b() {}
#item b v2 @bee "Polish b"
pub fn b() {
    a();
}
#item c v1 @sea "Add c"
pub fn c() {}
#item d v1 @dee "Add d"
pub fn d() {}
#item d v2 @dee "Grow d"
pub fn d() {
    c();
}
#item e v1 @eel "Add e"
pub fn e() {}
#item e v2 @eel "Grow e"
pub fn e() {
    a();
}
#item f v1 @eff "Add f"
pub fn f() {}
#item g v1 @gee "Add g"
pub fn g() {}
#item g v2 @gee "Grow g"
pub fn g() {
    f();
}
#item g v3 @gee "Grow g more"
pub fn g() {
    f();
    e();
}
#item g v4 @gee "Finish g"
pub fn g() {
    f();
    e();
    d();
}
#item h v1 @long "Start h"
pub fn h() {}
#item h v2 @long "Grow h"
pub fn h() {
    a();
}
#item h v3 @long "Grow h again"
pub fn h() {
    a();
    b();
}
#file data/table.csv
#whole v1 @start "Add the table"
id,name,price,mass
fuel,Fuel cells,84,1.0
ice,Water ice,12,2.0
"#;
    const FEATURES_T: &str = "start | chore | ilse | 1 | main | direct | Start\nbee | feature | teodor | 2 | main | merged | Add b\nsea | feature | wen | 2 | main | open | Add c\ndee | feature | noor | 3 | main | unpushed:1 | Add d\neel | feature | kasimir | 3 | main | remote-ahead:1 | Add e\neff | feature | rafe | 3 | main | draft | Add f\ngee | feature | wen | 4 | main | diverged | Add g\nlong | experiment | teodor | 2 | main | long-lived | Prototype h\n";

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).envs(gitvolt_core::testing::isolated_git_env()).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim_end().to_string()
    }

    fn build(seed: u64) -> (Vec<u8>, Outcome) {
        let corpus = Corpus::from_sources(&[("t.txt", CORPUS)]).unwrap();
        let messages = Messages::parse("[review-up]\nRaise {what} after review\n[review-down]\nLower {what} after review\n[tune-up]\nRaise {what} from {old} to {new}\n[tune-down]\nLower {what} from {old} to {new}\n[tune-cell]\nBalance: {row} {column} {old} → {new}\n[bump-dep]\nBump {dep} to {version}\n").unwrap();
        let mut rng = Rng::new(seed);
        let plans = plan(&corpus, &parse_features(FEATURES_T).unwrap(), &messages, &|_: &str, _| Rc::from(&b""[..]), &mut rng).unwrap();
        let mut hist = History::new();
        let outcome = run(&plans, &Content { corpus: &corpus, sections: Default::default() }, &messages, &mut hist, &mut rng, &[], 60);
        (hist.finish(), outcome)
    }

    fn import(stream: &[u8]) -> (tempfile::TempDir, std::collections::HashMap<u32, String>) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let marks = dir.path().join("marks");
        fast_import(&dir.path().join(".git"), stream, Some(&marks)).unwrap();
        let m = read_marks(&marks);
        (dir, m)
    }

    /// Every commit after its parents and within the two years.
    fn assert_dates(dir: &std::path::Path) {
        let log = git(dir, &["log", "--all", "--format=%H %ct %P"]);
        let times: std::collections::HashMap<&str, i64> = log
            .lines()
            .map(|l| {
                let f: Vec<&str> = l.split(' ').collect();
                (f[0], f[1].parse().unwrap())
            })
            .collect();
        for l in log.lines() {
            let f: Vec<&str> = l.split(' ').collect();
            let t: i64 = f[1].parse().unwrap();
            assert!((START..=END).contains(&t), "{l}");
            for p in &f[2..] {
                assert!(times[p] <= t, "{} is older than its parent {p}", f[0]);
            }
        }
    }

    #[test]
    fn branches_merge_like_gitlab_and_end_as_their_fates_say() {
        let (stream, outcome) = build(7);
        let (dir, _) = import(&stream);
        let d = dir.path();
        let merge = git(d, &["log", "--merges", "--first-parent", "--format=%B", "main", "--grep=feature/bee"]);
        assert!(merge.starts_with("Merge branch 'feature/bee' into 'main'\n\nAdd b\n\n"), "{merge}");
        assert!(merge.contains("See merge request orbital/orbital!"), "{merge}");
        let heads = git(d, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
        assert!(!heads.contains("feature/bee"), "merged branches are deleted");
        for b in ["feature/sea", "feature/dee", "feature/eel", "feature/eff", "feature/gee", "experiment/long"] {
            assert!(heads.contains(&format!("refs/heads/{b}")) && heads.contains(&format!("refs/remotes/origin/{b}")), "{b}");
        }
        let lr = |b: &str| git(d, &["rev-list", "--left-right", "--count", &format!("{b}...origin/{b}")]);
        assert_eq!(lr("main"), "0\t0");
        assert_eq!(lr("feature/sea"), "0\t0");
        assert_eq!(lr("feature/dee"), "1\t0", "unpushed");
        assert_eq!(lr("feature/eel"), "0\t1", "teammate pushed");
        assert_eq!(lr("feature/gee"), "1\t2", "diverged");
        assert!(git(d, &["log", "--format=%s", "experiment/long"]).contains("Merge branch 'main' into experiment/long"));
        let states: Vec<(String, MrState)> = outcome.mrs.iter().map(|m| (m.source.clone(), m.state)).collect();
        assert!(states.contains(&("feature/bee".into(), MrState::Merged)));
        assert!(states.contains(&("feature/eff".into(), MrState::Draft)));
        assert!(states.contains(&("feature/gee".into(), MrState::Opened)));
        assert!(!states.iter().any(|(s, _)| s == "experiment/long" || s == "chore/start"));
        let iids: Vec<u32> = outcome.mrs.iter().map(|m| m.iid).collect();
        assert_eq!(iids, (1..=iids.len() as u32).collect::<Vec<_>>());
    }

    #[test]
    fn fillers_tune_constants_and_cells_on_main_and_the_count_is_met() {
        let (stream, outcome) = build(7);
        let (dir, _) = import(&stream);
        let d = dir.path();
        assert_eq!(outcome.commits, git(d, &["rev-list", "--all", "--count"]).parse::<usize>().unwrap());
        assert!((55..=70).contains(&outcome.commits), "{} commits for a target of 60", outcome.commits);
        let subjects = git(d, &["log", "--format=%s", "main"]);
        assert!(subjects.lines().any(|s| s.starts_with("Raise the ") || s.starts_with("Lower the ")), "{subjects}");
        assert!(subjects.lines().any(|s| s.starts_with("Balance: ")), "{subjects}");
        let table = git(d, &["log", "-p", "--format=", "main", "--", "data/table.csv"]);
        assert!(table.contains("-fuel,") || table.contains("-ice,"), "a cell changed: {table}");
    }

    #[test]
    fn every_commit_is_dated_after_its_parents_and_within_the_two_years() {
        let (stream, _) = build(3);
        let (dir, _) = import(&stream);
        assert_dates(dir.path());
    }

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        assert_eq!(build(11).0, build(11).0);
        assert_ne!(build(11).0, build(12).0);
    }

    /// `token` in `text` as a whole number or word: `300.0` in `due(300.0)`, not in `1300.0`.
    fn has_token(text: &str, token: &str) -> bool {
        let b = text.as_bytes();
        let part = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'.';
        text.match_indices(token).any(|(s, _)| {
            let e = s + token.len();
            (s == 0 || !part(b[s - 1])) && (e >= b.len() || !part(b[e]))
        })
    }

    fn stub(path: &str, v: u16) -> Rc<[u8]> {
        Rc::from(format!("{path} v{v}\n").into_bytes())
    }

    /// The real history, the special branches included: every commit on every branch builds (the
    /// story's check, so main builds after every merge), dates hold (after the parents, within the
    /// two years, each devlog entry on or after its own date) and subjects keep the house style.
    #[test]
    fn the_real_schedule_builds_at_every_commit_and_keeps_its_dates() {
        let corpus = Corpus::load();
        let messages = Messages::load();
        // The build's own stream of choices, so this is the history `orbital::build` writes.
        let mut rng = crate::orbital::history_rng();
        let mut plans = plan(&corpus, &parse_features(FEATURES).unwrap(), &messages, &stub, &mut rng).unwrap();
        crate::orbital::specials::apply(&mut plans, &corpus).unwrap();
        let renders = check::Renders::default();
        let mut problems: BTreeMap<String, String> = BTreeMap::new();
        let mut hist = History::new();
        let content = Content { corpus: &corpus, sections: Default::default() };
        // The story's own steps, main's side of the special branches included: only fillers and
        // the reviews' tunes are held to the pins (the specials' tunes are designed to keep their
        // tests).
        let review = |s: &Step| s.edits.iter().any(|e| e.key.contains("#const:") && matches!(e.value, Some(Value::Tuned(..))));
        let subjects: BTreeSet<String> = plans.iter().flat_map(|p| p.steps.iter().filter(|s| !review(s)).chain(p.forced_main.as_ref().map(|f| &f.2)).map(|s| s.message.lines().next().unwrap_or("").to_string())).collect();
        let mut last: BTreeMap<String, Snapshot> = BTreeMap::new();
        let mut pinned_tunes: Vec<String> = Vec::new();
        let outcome = run_observed(&plans, &content, &messages, &mut hist, &mut rng, &RELEASES, TARGET_COMMITS, &mut |branch, snap, message| {
            // A filler never retunes a constant whose value a test in effect writes (in the
            // crate's test modules, before the tune), nor one a test in effect names (in any
            // crate's).
            let subject = message.lines().next().unwrap_or("");
            if !subjects.contains(subject) && !subject.starts_with("Merge branch ") && let Some(prev) = last.get(branch).or_else(|| last.get("main")) {
                let tests: Vec<(String, String)> = prev
                    .paths()
                    .into_iter()
                    .filter(|p| p.ends_with(".rs"))
                    .filter_map(|p| {
                        let text = String::from_utf8_lossy(&content.render(&p, prev)?).into_owned();
                        let at = text.find("#[cfg(test)]")?;
                        Some((p, text[at..].to_string()))
                    })
                    .collect();
                for (k, v) in snap.keys().filter(|(k, _)| k.contains("#const:")) {
                    let Some((_, old)) = const_literal(&content, k, prev).filter(|_| prev.get(k) != Some(v)) else { continue };
                    let (krate, name) = (crate_dir(path_of(k)), k.rsplit_once("#const:").map_or("", |x| x.1));
                    if tests.iter().any(|(p, t)| p.starts_with(krate) && has_token(t, &old)) {
                        pinned_tunes.push(format!("{subject:?} on {branch}: {k} was {old}"));
                    }
                    if let Some((p, _)) = tests.iter().find(|(_, t)| has_token(t, name)) {
                        pinned_tunes.push(format!("{subject:?} on {branch}: {k}, named by a test in {p}"));
                    }
                }
            }
            last.insert(branch.to_string(), snap.clone());
            for p in check::problems(&corpus, snap, &renders, None) {
                problems.entry(p).or_insert_with(|| branch.to_string());
            }
            // The workspace lists exactly the dependencies its crates take from it.
            if snap.get("Cargo.toml#version").is_some() {
                let used: BTreeSet<String> = snap.paths().iter().filter(|p| releases::is_member_manifest(p)).flat_map(|p| releases::workspace_deps(&String::from_utf8_lossy(&content.render(p, snap).unwrap()))).collect();
                let listed: BTreeSet<String> = snap.keys().filter_map(|(k, _)| k.strip_prefix("Cargo.toml#dep:")).map(str::to_string).collect();
                if used != listed {
                    problems.entry(format!("DEPS the workspace lists {listed:?}, its crates use {used:?}")).or_insert_with(|| branch.to_string());
                }
            }
        });
        assert!(pinned_tunes.is_empty(), "fillers retuned constants a test asserts:\n  {}", pinned_tunes.join("\n  "));
        let found: Vec<String> = problems.iter().map(|(p, b)| format!("{p} (first on {b})")).collect();
        assert!(found.is_empty(), "commits that don't build ({}):\n  {}", found.len(), found.join("\n  "));

        let (dir, shas) = import(&hist.finish());
        let d = dir.path();
        assert_eq!(outcome.commits, git(d, &["rev-list", "--all", "--count"]).parse::<usize>().unwrap());
        assert_dates(d);

        // The special branches, as git sees them. Merging the fuel rework into main conflicts in a
        // text, a table and a binary file, and only there.
        let merge_tree = |args: &[&str]| {
            let out = Command::new("git").current_dir(d).args(["merge-tree", "--write-tree", "--name-only", "--no-messages"]).args(args).envs(gitvolt_core::testing::isolated_git_env()).output().unwrap();
            assert!(out.status.code().is_some_and(|c| c < 2), "git merge-tree {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            let text = String::from_utf8(out.stdout).unwrap();
            let mut lines = text.lines().filter(|l| !l.is_empty()).map(String::from);
            (out.status.code() == Some(1), lines.next().unwrap(), lines.collect::<Vec<_>>())
        };
        let (conflicts, _, paths) = merge_tree(&["main", "balance/fuel-rework"]);
        assert!(conflicts);
        assert_eq!(paths, ["assets/data/economy/commodities.csv", "assets/ui/icons/fuel.png", "crates/orbital-core/src/ship.rs"]);
        // Rebasing the HUD polish onto main: its first commit applies as it is, and the WIP then
        // stops on the margin main changed under it. Moving the colour tweak above the WIP stops
        // too; the fixup moves up cleanly.
        let c: Vec<String> = git(d, &["rev-list", "--reverse", "main..feature/hud-polish"]).lines().map(String::from).collect();
        assert_eq!(c.len(), 7);
        let pick = |onto: &str, commit: &str| {
            let (conflicts, tree, paths) = merge_tree(&["--merge-base", &format!("{commit}^"), onto, commit]);
            (conflicts.then_some(paths), tree)
        };
        let (stops, tree) = pick("main", &c[0]);
        assert_eq!(stops, None, "the first commit onto main");
        let first = git(d, &["commit-tree", &tree, "-p", "main", "-m", "Draw the HUD gauges with a shared frame"]);
        assert_eq!(pick(&first, &c[1]).0, Some(vec!["crates/orbital-game/src/hud.rs".to_string()]), "the WIP after it");
        assert_eq!(pick(&c[0], &c[5]).0, Some(vec!["crates/orbital-game/src/hud_gauges.rs".to_string()]), "the colour tweak above the WIP");
        assert_eq!(pick(&c[0], &c[3]).0, None, "the fixup after the commit it fixes");
        for s in git(d, &["log", "--all", "--format=%s"]).lines() {
            subject_ok(s).unwrap_or_else(|e| panic!("{e}"));
        }
        let added = git(d, &["log", "--all", "--diff-filter=A", "--date=short", "--format=@%H %ad", "--name-only", "--", "docs/devlog/"]);
        let mut entries = 0;
        let mut at = ("", "");
        for l in added.lines().filter(|l| !l.is_empty()) {
            if let Some(c) = l.strip_prefix('@') {
                at = c.split_once(' ').unwrap();
                continue;
            }
            let text = git(d, &["show", &format!("{}:{l}", at.0)]);
            let Some(date) = text.lines().find_map(|x| x.strip_prefix("date: ")).filter(|x| !x.trim().is_empty()) else { continue };
            let day = |s: &str| {
                let f: Vec<u32> = s.trim().split('-').map(|x| x.parse().unwrap()).collect();
                unix(i64::from(f[0]), f[1], f[2], 0, 0) / 86_400
            };
            assert!(date.trim() <= at.1, "{l} is dated {date} but added on {}", at.1);
            assert!(day(at.1) - day(date) <= 14, "{l} is dated {date} but added on {}, more than two weeks later", at.1);
            entries += 1;
        }
        assert!(entries >= 24, "{entries} devlog entries checked");

        // Fillers (commits no feature plans): at most a quarter of main's first-parent line, two a
        // day at most, mostly in the playtests before releases.
        let releases: Vec<String> = RELEASES.iter().map(|r| format!("Release v{}", r.version)).collect();
        let planned: BTreeSet<&str> = plans.iter().flat_map(|p| p.steps.iter().map(|s| s.message.lines().next().unwrap_or(""))).chain(releases.iter().map(String::as_str)).collect();
        let fillers: Vec<(i64, String)> = git(d, &["log", "--all", "--no-merges", "--format=%ct %s"])
            .lines()
            .filter_map(|l| l.split_once(' '))
            .filter(|(_, s)| !planned.contains(s))
            .map(|(t, s)| (t.parse().unwrap(), s.to_string()))
            .collect();
        let main_line = git(d, &["log", "--first-parent", "--no-merges", "--format=%s", "main"]);
        let direct = main_line.lines().filter(|s| !planned.contains(s)).count();
        let first_parent_all = git(d, &["rev-list", "--count", "--first-parent", "main"]).parse::<usize>().unwrap();
        let mut per_day: BTreeMap<i64, usize> = BTreeMap::new();
        for (t, _) in &fillers {
            *per_day.entry(t.div_euclid(86_400)).or_default() += 1;
        }
        let busiest = per_day.values().max().copied().unwrap_or(0);
        let windows = playtests(&RELEASES);
        let in_playtests = fillers.iter().filter(|(t, _)| windows.iter().any(|&(a, b)| (a - 86_400..=b + 86_400).contains(t))).count();
        let balance = outcome.mrs.iter().filter(|m| m.source.starts_with("balance/playtest-")).count();
        eprintln!("{} fillers: {direct} on main ({first_parent_all} first-parent), {} in {balance} balance passes; {in_playtests} in the playtests; at most {busiest} a day", fillers.len(), fillers.len() - direct);
        assert!(direct * 4 <= first_parent_all, "{direct} fillers of {first_parent_all} first-parent commits");
        assert!(busiest <= 2, "{busiest} fillers on one day");
        assert!(in_playtests * 2 >= fillers.len(), "{in_playtests} of {} fillers in the playtests", fillers.len());
        assert!(balance >= 2 * windows.len() - 2, "{balance} balance passes for {} playtests", windows.len());

        // A branch's own commits are at least half an hour apart, even near the end. (A release
        // branch's merge back brings several fix branches' commits, side by side.)
        for m in outcome.mrs.iter().filter(|m| !m.source.starts_with("release/")) {
            let range = match m.merged {
                Some((_, mark)) => format!("{0}^1..{0}^2", shas[&mark]),
                None => format!("main..{}", m.source),
            };
            let mut times: Vec<i64> = git(d, &["log", "--no-merges", "--format=%ct", &range]).lines().map(|x| x.parse().unwrap()).collect();
            times.sort_unstable();
            for w in times.windows(2) {
                assert!(w[1] - w[0] >= 1_800, "{}: two commits {} minutes apart", m.source, (w[1] - w[0]) / 60);
            }
        }

        // The shape, for the record.
        let main = git(d, &["rev-list", "--count", "main"]).parse::<usize>().unwrap();
        let first_parent = git(d, &["rev-list", "--count", "--first-parent", "main"]).parse::<usize>().unwrap();
        let merges = git(d, &["rev-list", "--count", "--merges", "--first-parent", "main"]).parse::<usize>().unwrap();
        let branches = git(d, &["for-each-ref", "--format=%(refname)", "refs/heads"]).lines().count();
        let span = git(d, &["log", "--all", "--format=%cs"]);
        let (first, last) = (span.lines().min().unwrap().to_string(), span.lines().max().unwrap().to_string());
        let mut edges: Vec<(i64, i32)> = Vec::new();
        for m in &outcome.mrs {
            edges.push((m.created, 1));
            edges.push((m.merged.map_or(END, |x| x.0), -1));
        }
        edges.sort_unstable();
        let mut open = 0;
        let in_flight = edges.iter().map(|e| {
            open += e.1;
            open
        });
        let most = in_flight.max().unwrap_or(0);
        let merged = outcome.mrs.iter().filter(|m| m.state == MrState::Merged).count();
        eprintln!(
            "{} commits; main {main} ({first_parent} first-parent, {merges} merges); {} MRs ({merged} merged), at most {most} open at once; {branches} local branches; {first} to {last}",
            outcome.commits,
            outcome.mrs.len()
        );
        assert!(merges >= 100 && first_parent > merges, "merge commits and direct commits on main");
        assert!(most >= 3, "branches run alongside each other ({most} at most)");
        // Waiting on each other, features start late; not so late the roadmap stops making sense.
        let mut late: Vec<(i64, &str)> = outcome
            .mrs
            .iter()
            .filter_map(|m| {
                let p = plans.iter().find(|p| p.feature.branch() == m.source)?;
                Some(((m.created - milestone_start(p.feature.milestone + 1)) / 86_400, m.source.as_str()))
            })
            .collect();
        late.sort_unstable();
        let worst = *late.last().unwrap();
        eprintln!("MRs opened after their milestone ended: {} of {}, the latest {} days ({})", late.iter().filter(|l| l.0 > 0).count(), late.len(), worst.0, worst.1);
        assert!(worst.0 <= 45, "{} opens {} days after its milestone", worst.1, worst.0);
    }

    /// A long-lived branch and main both add `mod` lines to one header: each pull keeps both
    /// sides' lines, even when main hasn't changed since the last pull, and so does a later step
    /// on the branch that sets the header again.
    #[test]
    fn pulls_merge_a_header_both_sides_changed() {
        let text = "#file crates/g/src/main.rs\n#header v1 @x\n//! G.\n\nmod a;\n#header v2 @x \"Add net\"\n//! G.\n\nmod a;\nmod net;\n#header v3 @x \"Add hud\"\n//! G.\n\nmod a;\nmod hud;\n#item main v1 @x \"Start\"\nfn main() {}\n";
        let corpus = Corpus::from_sources(&[("t.txt", text)]).unwrap();
        let content = Content { corpus: &corpus, sections: Default::default() };
        let messages = Messages::parse("[tune-up]\nRaise {what}\n").unwrap();
        let mut hist = History::new();
        let mut tl = Timeline { content: &content, messages: &messages, hist: &mut hist, branches: BTreeMap::new(), mrs: Vec::new(), commits: Vec::new(), observe: &mut |_, _, _| {}, root: Vec::new(), pins: Pins::default() };
        let header = |n: u16| Edit::set("crates/g/src/main.rs#header", Value::Version(n));
        let who = person("teodor");
        tl.branches.insert("main".into(), Branch::new(0, Snapshot::default()));
        tl.commit("main", &Step::new("Start", vec![header(1), Edit::set("crates/g/src/main.rs#item:main", Value::Version(1))]), who, START);
        let main = &tl.branches["main"];
        tl.branches.insert("experiment/net".into(), Branch::new(main.tip, main.state.clone()));
        tl.commit("experiment/net", &Step::new("Add net", vec![header(2)]), who, START + 60);
        tl.commit("main", &Step::new("Add hud", vec![header(3)]), who, START + 120);
        let mods = |tl: &Timeline, b: &str| {
            let text = String::from_utf8(content.render("crates/g/src/main.rs", &tl.branches[b].state).unwrap().to_vec()).unwrap();
            text.lines().filter(|l| l.starts_with("mod ")).map(str::to_string).collect::<Vec<_>>()
        };
        tl.pull_main("experiment/net", who, START + 180);
        assert_eq!(mods(&tl, "experiment/net"), ["mod a;", "mod hud;", "mod net;"]);
        tl.pull_main("experiment/net", who, START + 240);
        assert_eq!(mods(&tl, "experiment/net"), ["mod a;", "mod hud;", "mod net;"]);
        let more = Edit::set("crates/g/src/main.rs#header", Value::Tuned(2, Rc::from("//! G.\n\nmod a;\nmod lobby;\nmod net;\n")));
        tl.commit("experiment/net", &Step::new("Add the lobby", vec![more]), who, START + 300);
        assert_eq!(mods(&tl, "experiment/net"), ["mod a;", "mod hud;", "mod lobby;", "mod net;"]);
        assert_eq!(mods(&tl, "main"), ["mod a;", "mod hud;"]);
    }
}
