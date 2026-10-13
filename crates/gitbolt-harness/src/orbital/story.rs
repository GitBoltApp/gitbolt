//! From the corpus and the feature list to steps: each feature's tagged block versions become its
//! branch's commits (versions that share a subject make one commit), its assets commits of their
//! own, and now and then a review fix-up.
//!
//! Every step leaves the code building: a step comes after the steps that add what it uses (an
//! item, a module, a crate in a manifest), a header without a message of its own gains each `use`
//! and `mod` line with the first step that needs it, and a test follows the step it tests.

use super::corpus::{fill, literal_of, tune, Block, Corpus, Kind as BlockKind, Messages, Tagged};
use super::model::{path_of, Edit, Value};
use super::people::find;
use super::schedule::{sensible_tune, Pins};
use crate::media::rng::Rng;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Feature,
    Fix,
    Art,
    Audio,
    Docs,
    Balance,
    Chore,
    Experiment,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fate {
    Merged,
    Direct,
    Open,
    Draft,
    LongLived,
    Unpushed(u8),
    RemoteAhead(u8),
    Diverged,
    Conflict,
    Irebase,
}

#[derive(Clone, Debug)]
pub struct AssetStep {
    pub path: String,
    pub version: u16,
    pub message: String,
}

/// Why a feature may plan no steps here: a later stage makes its commits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deferred {
    /// `later: release` in features.txt: the release's commit and tag come from the releases.
    Release,
    /// The conflict and interactive-rebase branches, built by the specials. They never plan steps
    /// here, corpus or not.
    Special,
    /// `later: unwritten`: its content isn't written yet.
    Unwritten,
}

#[derive(Clone, Debug)]
pub struct Feature {
    pub slug: String,
    pub kind: Kind,
    pub author: &'static str,
    pub milestone: u32,
    pub target: String,
    pub fate: Fate,
    pub title: String,
    pub description: Vec<String>,
    pub assets: Vec<AssetStep>,
    /// features.txt's `later:` line: a feature with no content of its own (yet).
    pub later: Option<Deferred>,
}

impl Feature {
    pub fn branch(&self) -> String {
        let prefix = match self.kind {
            Kind::Feature => "feature",
            Kind::Fix => "fix",
            Kind::Art => "art",
            Kind::Audio => "audio",
            Kind::Docs => "docs",
            Kind::Balance => "balance",
            Kind::Chore => "chore",
            Kind::Experiment => "experiment",
        };
        // `fix/1-0-save`, not `fix/fix-1-0-save`.
        let name = self.slug.strip_prefix(prefix).and_then(|s| s.strip_prefix('-')).unwrap_or(&self.slug);
        format!("{prefix}/{name}")
    }

    /// The stage that makes this feature's commits when the corpus has none for it.
    pub fn deferred(&self) -> Option<Deferred> {
        if matches!(self.fate, Fate::Conflict | Fate::Irebase) { Some(Deferred::Special) } else { self.later }
    }
}

/// An edit worked out when its commit is made, from the branch's state then.
#[derive(Clone, Debug)]
pub enum Derive {
    TuneConst { key: String, factor: f64 },
    TuneCell { path: String, row: String, column: String, factor: f64 },
}

#[derive(Clone, Debug)]
pub struct Step {
    pub message: String,
    pub edits: Vec<Edit>,
    pub derived: Vec<Derive>,
}

impl Step {
    pub fn new(message: impl Into<String>, edits: Vec<Edit>) -> Step {
        Step { message: message.into(), edits, derived: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub struct FeaturePlan {
    pub feature: Feature,
    pub steps: Vec<Step>,
    pub keys: BTreeSet<String>,
    /// A commit on main while the branch is open: (hours after the fork, author, step).
    pub forced_main: Option<(u32, &'static str, Step)>,
}

pub type Assets<'a> = &'a dyn Fn(&str, u16) -> Rc<[u8]>;

fn kind(s: &str) -> Result<Kind, String> {
    Ok(match s {
        "feature" => Kind::Feature,
        "fix" => Kind::Fix,
        "art" => Kind::Art,
        "audio" => Kind::Audio,
        "docs" => Kind::Docs,
        "balance" => Kind::Balance,
        "chore" => Kind::Chore,
        "experiment" => Kind::Experiment,
        other => return Err(format!("unknown kind {other:?}")),
    })
}

fn fate(s: &str) -> Result<Fate, String> {
    let n = |rest: &str| rest.parse::<u8>().map_err(|e| format!("{s}: {e}"));
    Ok(match s {
        "merged" => Fate::Merged,
        "direct" => Fate::Direct,
        "open" => Fate::Open,
        "draft" => Fate::Draft,
        "long-lived" => Fate::LongLived,
        "diverged" => Fate::Diverged,
        "conflict" => Fate::Conflict,
        "irebase" => Fate::Irebase,
        other => {
            if let Some(rest) = other.strip_prefix("unpushed:") {
                Fate::Unpushed(n(rest)?)
            } else if let Some(rest) = other.strip_prefix("remote-ahead:") {
                Fate::RemoteAhead(n(rest)?)
            } else {
                return Err(format!("unknown fate {other:?}"));
            }
        }
    })
}

pub fn parse_features(text: &str) -> Result<Vec<Feature>, String> {
    let mut out: Vec<Feature> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let at = |e: String| format!("features.txt:{}: {e}", i + 1);
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') {
            let f = out.last_mut().ok_or_else(|| at("a detail line before any feature".into()))?;
            let d = line.trim_start();
            if let Some(text) = d.strip_prefix("> ") {
                f.description.push(text.to_string());
            } else if let Some(rest) = d.strip_prefix("asset ") {
                let (head, msg) = rest.split_once(" \"").ok_or_else(|| at("asset lines end with a quoted message".into()))?;
                let (path, v) = head.rsplit_once(" v").ok_or_else(|| at("asset <path> v<N>".into()))?;
                let version = v.parse().map_err(|e| at(format!("{e}")))?;
                f.assets.push(AssetStep { path: path.to_string(), version, message: msg.trim_end_matches('"').to_string() });
            } else if let Some(later) = d.strip_prefix("later: ") {
                if f.later.is_some() {
                    return Err(at("a second later: line".into()));
                }
                f.later = Some(match later {
                    "release" => Deferred::Release,
                    "unwritten" => Deferred::Unwritten,
                    other => return Err(at(format!("later: {other:?} (later: release or later: unwritten)"))),
                });
            } else {
                return Err(at(format!("unknown detail line {d:?}")));
            }
            continue;
        }
        let c: Vec<&str> = line.split('|').map(str::trim).collect();
        if c.len() != 7 {
            return Err(at(format!("{} columns, not 7", c.len())));
        }
        if out.iter().any(|f| f.slug == c[0]) {
            return Err(at(format!("the feature {} twice", c[0])));
        }
        let author = find(c[2]).ok_or_else(|| at(format!("unknown author {:?}", c[2])))?.handle;
        out.push(Feature {
            slug: c[0].to_string(),
            kind: kind(c[1]).map_err(at)?,
            author,
            milestone: c[3].parse().map_err(|e| at(format!("{e}")))?,
            target: c[4].to_string(),
            fate: fate(c[5]).map_err(at)?,
            title: c[6].to_string(),
            description: Vec::new(),
            assets: Vec::new(),
            later: None,
        });
    }
    Ok(out)
}

/// `MAX_CARGO_MASS` → "the max cargo mass".
pub fn human(const_name: &str) -> String {
    format!("the {}", const_name.to_ascii_lowercase().replace('_', " "))
}

pub fn plan(corpus: &Corpus, features: &[Feature], messages: &Messages, assets: Assets, rng: &mut Rng) -> Result<Vec<FeaturePlan>, String> {
    // One draw, then a stream per feature: adding a feature doesn't reshuffle the others' reviews.
    let seed = rng.next_u64();
    let names = distinctive_names(corpus);
    let pins = Pins::of(corpus);
    features
        .iter()
        .map(|f| plan_one(corpus, &names, &pins, f, messages, assets, &mut Rng::named(seed, &format!("review:{}", f.slug))))
        .collect()
}

fn subject(message: &str) -> &str {
    message.lines().next().unwrap_or(message)
}

fn plan_one(corpus: &Corpus, names: &BTreeSet<String>, pins: &Pins, f: &Feature, messages: &Messages, assets: Assets, rng: &mut Rng) -> Result<FeaturePlan, String> {
    let mut steps: Vec<Step> = Vec::new();
    if f.deferred() != Some(Deferred::Special) {
        steps = feature_steps(corpus, names, f, assets)?;
        if steps.is_empty() && f.deferred().is_none() {
            return Err(format!("feature {} has no steps: tag some corpus blocks @{} or give it assets (or a later: line)", f.slug, f.slug));
        }
        if f.fate == Fate::Merged
            && !steps.is_empty()
            && rng.chance(0.3)
            && let Some(step) = review_step(corpus, pins, f, &steps, messages, rng)
            && !steps.iter().any(|s| subject(&s.message) == subject(&step.message))
        {
            steps.push(step);
        }
        let mut seen = BTreeSet::new();
        if let Some(s) = steps.iter().find(|s| !seen.insert(subject(&s.message))) {
            return Err(format!("feature {}: two steps say {:?}", f.slug, subject(&s.message)));
        }
    }
    let keys = steps
        .iter()
        .flat_map(|s| {
            s.edits.iter().map(|e| e.key.clone()).chain(s.derived.iter().map(|d| match d {
                Derive::TuneConst { key, .. } => key.clone(),
                Derive::TuneCell { path, .. } => path.clone(),
            }))
        })
        .collect();
    Ok(FeaturePlan { feature: f.clone(), steps, keys, forced_main: None })
}

/// For each plan, the plans before it (in milestone, then list order) that land on its target
/// (a release branch's fixes land on main too) and that it builds on: they touch a Rust file it touches, or its code names an item, a module
/// or a crate they add. Each plan's steps were written against main with every earlier feature on
/// it; the schedule starts a feature once these have landed, and lets the rest run alongside.
pub fn builds_on(corpus: &Corpus, plans: &[FeaturePlan]) -> Vec<BTreeSet<usize>> {
    let names = distinctive_names(corpus);
    let block = |key: &str| {
        let path = path_of(key);
        corpus.file(path)?.blocks.iter().find(|b| b.key(path) == key)
    };
    struct Reads {
        code: BTreeSet<String>,
        adds: BTreeSet<String>,
        words: BTreeSet<String>,
    }
    let reads: Vec<Reads> = plans
        .iter()
        .map(|p| {
            let mut r = Reads { code: BTreeSet::new(), adds: BTreeSet::new(), words: BTreeSet::new() };
            for e in p.steps.iter().flat_map(|s| &s.edits) {
                let path = path_of(&e.key);
                if path.ends_with(".rs") {
                    r.code.insert(path.to_string());
                }
                let (Some(b), Some(Value::Version(n) | Value::Tuned(n, _))) = (block(&e.key), &e.value) else { continue };
                let at = usize::from(*n) - 1;
                let v = &b.versions[at];
                if v.removed {
                    continue;
                }
                let fresh = at == 0 || b.versions[at - 1].removed;
                if fresh && matches!(b.kind, BlockKind::Item | BlockKind::Const) && names.contains(&b.name) {
                    r.adds.insert(b.name.clone());
                }
                if at == 0 && matches!(b.kind, BlockKind::Header | BlockKind::Whole) {
                    if let Some((_, m)) = module_of(path) {
                        r.adds.insert(m.to_string());
                    }
                    if let Some(dir) = path.strip_suffix("/Cargo.toml").and_then(|d| d.strip_prefix("crates/")) {
                        r.adds.insert(dir.replace('-', "_"));
                    }
                }
                if path.ends_with("Cargo.toml") {
                    let before = at.checked_sub(1).map(|p| deps(&b.versions[p].text)).unwrap_or_default();
                    r.adds.extend(deps(&v.text).difference(&before).cloned());
                }
                let text = match &e.value {
                    Some(Value::Tuned(_, t)) if b.kind == BlockKind::Header => t.to_string(),
                    _ => v.text.clone(),
                };
                r.words.extend(code(&text).split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(str::to_string));
            }
            r
        })
        .collect();
    let mut order: Vec<usize> = (0..plans.len()).collect();
    order.sort_by_key(|&i| (plans[i].feature.milestone, i));
    let mut out = vec![BTreeSet::new(); plans.len()];
    for (n, &b) in order.iter().enumerate() {
        for &a in &order[..n] {
            let (fa, fb) = (&plans[a].feature, &plans[b].feature);
            // A release branch's fix reaches main with the branch's merge back.
            let reaches = fa.target == fb.target || (fa.target.starts_with("release/") && fb.target == "main");
            if !matches!(fa.fate, Fate::Merged | Fate::Direct) || !reaches {
                continue;
            }
            if !reads[a].code.is_disjoint(&reads[b].code) || !reads[a].adds.is_disjoint(&reads[b].words) {
                out[b].insert(a);
            }
        }
    }
    out
}

// --- Reading code ---

/// The text without its comment lines, so prose doesn't count as a use.
fn code(text: &str) -> String {
    text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

fn ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `word` in `text` as a whole identifier.
fn has_word(text: &str, word: &str) -> bool {
    let b = text.as_bytes();
    text.match_indices(word).any(|(s, _)| {
        let e = s + word.len();
        (s == 0 || !ident(b[s - 1])) && (e >= b.len() || !ident(b[e]))
    })
}

/// `name::` in `text`, as a path's first segment or a later one.
fn has_path(text: &str, name: &str) -> bool {
    let b = text.as_bytes();
    let pat = format!("{name}::");
    text.match_indices(&pat).any(|(s, _)| s == 0 || !ident(b[s - 1]))
}

/// Whether the code declares `name`: `pub struct Ship`, `fn burn_fuel(`, `pub const MAX_FUEL:`.
fn defines(code: &str, name: &str) -> bool {
    code.lines().any(|l| {
        let mut t = l.trim_start();
        for p in ["pub(crate) ", "pub "] {
            t = t.strip_prefix(p).unwrap_or(t);
        }
        ["const fn ", "fn ", "struct ", "enum ", "trait ", "type ", "const ", "static "].iter().any(|p| {
            t.strip_prefix(p).is_some_and(|rest| rest.starts_with(name) && !rest.as_bytes().get(name.len()).is_some_and(|&b| ident(b)))
        })
    })
}

/// Item and constant names that only one block has and that read as code (`Ship`, `burn_fuel`,
/// `MAX_FUEL`, not `new` or `draw`): a mention of one is a use of that block.
fn distinctive_names(corpus: &Corpus) -> BTreeSet<String> {
    let mut count: BTreeMap<&str, usize> = BTreeMap::new();
    for f in &corpus.files {
        for b in f.blocks.iter().filter(|b| matches!(b.kind, BlockKind::Item | BlockKind::Const)) {
            *count.entry(&b.name).or_default() += 1;
        }
    }
    count
        .into_iter()
        .filter(|&(n, c)| c == 1 && ((n.starts_with(|c: char| c.is_ascii_uppercase()) && n.len() >= 3) || (n.contains('_') && n.len() >= 4)))
        .map(|(n, _)| n.to_string())
        .collect()
}

/// The dependencies a Cargo.toml lists, in its `[…dependencies]` tables.
fn deps(toml: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut in_deps = false;
    for l in toml.lines().map(str::trim) {
        if l.starts_with('[') {
            in_deps = l.contains("dependencies");
        } else if in_deps && let Some((name, _)) = l.split_once('=') {
            out.insert(name.trim().trim_end_matches(".workspace").replace('-', "_"));
        }
    }
    out
}

/// A Rust file's crate source directory and its module's name: `crates/x/src/` and `ship` for
/// `crates/x/src/ship.rs`; none for a crate root.
fn module_of(path: &str) -> Option<(&str, &str)> {
    let at = path.find("/src/")? + 5;
    let (src, rel) = path.split_at(at);
    let rel = rel.strip_suffix(".rs")?;
    let rel = rel.strip_suffix("/mod").unwrap_or(rel);
    (!matches!(rel, "lib" | "main")).then(|| (src, rel.rsplit('/').next().unwrap_or(rel)))
}

/// The crate directory of a path under `crates/<name>/`.
fn crate_dir(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("crates/")?;
    Some(&path[..7 + rest.find('/')?])
}

/// Whether Rust code at `user` can name an item defined at `path`: the same crate, or one its
/// manifest (at its last version) depends on.
fn sees(corpus: &Corpus, user: &str, path: &str) -> bool {
    let (Some(a), Some(b)) = (crate_dir(user), crate_dir(path)) else { return false };
    if !user.ends_with(".rs") {
        return false;
    }
    a == b
        || corpus
            .file(&format!("{a}/Cargo.toml"))
            .and_then(|f| f.blocks.first()?.versions.last())
            .is_some_and(|v| deps(&v.text).contains(&b["crates/".len()..].replace('-', "_")))
}

/// Where `mod name;` in the file at `path` looks for the module.
fn module_paths(path: &str, name: &str) -> [String; 2] {
    let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
    let base = if matches!(file, "lib.rs" | "main.rs" | "mod.rs") { dir.to_string() } else { path.trim_end_matches(".rs").to_string() };
    let base = if base.is_empty() { String::new() } else { format!("{base}/") };
    [format!("{base}{name}.rs"), format!("{base}{name}/mod.rs")]
}

// --- Headers, a line at a time ---

#[derive(Clone, Debug, PartialEq)]
enum Line<'a> {
    /// `[pub ]use <prefix>::{<names>};` (or `::<name>;`).
    Use { public: bool, prefix: &'a str, names: Vec<&'a str>, raw: &'a str },
    Mod { name: &'a str, raw: &'a str },
    Other(&'a str),
}

fn parse_header(text: &str) -> Vec<Line<'_>> {
    text.lines()
        .map(|raw| {
            let (public, rest) = match raw.strip_prefix("pub use ") {
                Some(r) => (true, Some(r)),
                None => (false, raw.strip_prefix("use ")),
            };
            if let Some(path) = rest.and_then(|r| r.strip_suffix(';')).filter(|p| p.matches('{').count() <= 1) {
                let parsed = match path.split_once("::{") {
                    Some((prefix, names)) => names.strip_suffix('}').map(|n| (prefix, n.split(',').map(str::trim).filter(|x| !x.is_empty()).collect())),
                    None => path.rsplit_once("::").map(|(prefix, name)| (prefix, vec![name])),
                };
                if let Some((prefix, names)) = parsed {
                    return Line::Use { public, prefix, names, raw };
                }
            }
            let t = raw.trim();
            match t.strip_prefix("pub mod ").or_else(|| t.strip_prefix("pub(crate) mod ")).or_else(|| t.strip_prefix("mod ")).and_then(|m| m.strip_suffix(';')) {
                Some(name) => Line::Mod { name, raw },
                None => Line::Other(raw),
            }
        })
        .collect()
}

/// The name an import brings into scope: `Y` for `X as Y`, the module for `self`.
fn bound<'a>(prefix: &'a str, name: &'a str) -> &'a str {
    match name.rsplit_once(" as ") {
        Some((_, alias)) => alias,
        None if name == "self" => prefix.rsplit("::").next().unwrap_or(prefix),
        None => name,
    }
}

fn use_line(public: bool, prefix: &str, names: &[&str]) -> String {
    let p = if public { "pub " } else { "" };
    match names {
        [one] if *one != "self" => format!("{p}use {prefix}::{one};"),
        _ => format!("{p}use {prefix}::{{{}}};", names.join(", ")),
    }
}

/// The names a header's (non-`pub`) `use` lines bring into scope.
fn imports(text: &str) -> BTreeSet<String> {
    parse_header(text)
        .into_iter()
        .filter_map(|l| match l {
            Line::Use { public: false, prefix, names, .. } => Some(names.into_iter().map(move |x| bound(prefix, x).to_string())),
            _ => None,
        })
        .flatten()
        .collect()
}

/// Lines joined, with no blank line twice in a row or at either end.
fn tidy(lines: &[String]) -> String {
    let mut out = String::new();
    let mut blank = false;
    for l in lines {
        if l.trim().is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if blank {
            out.push('\n');
            blank = false;
        }
        out.push_str(l);
        out.push('\n');
    }
    out
}

// --- Steps ---

struct Ver<'c> {
    t: Tagged,
    path: &'c str,
    block: &'c Block,
    message: Option<&'c str>,
    code: String,
}

impl Ver<'_> {
    fn removed(&self) -> bool {
        self.block.versions[self.t.version].removed
    }
}

/// A commit being put together: corpus versions (indices into the feature's versions), header
/// edits and asset edits.
struct Draft {
    message: String,
    members: Vec<usize>,
    headers: Vec<(usize, Value)>,
    assets: Vec<Edit>,
}

impl Draft {
    fn new(message: impl Into<String>) -> Draft {
        Draft { message: message.into(), members: Vec::new(), headers: Vec::new(), assets: Vec::new() }
    }
}

/// The feature's code and asset steps.
///
/// - Messaged versions with the same subject make one step. Steps go in the order their subjects
///   first appear in the corpus, moved later where a block's earlier version, an item they use, a
///   module they call into or a crate they import is in a later step; a test step moves up to
///   right after the step it tests, and docs move after the code.
/// - A messageless constant rides in the first step that uses it or touches a later block of its
///   file (never before its block's previous version nor after its next), else the last step
///   before it in its file, else the feature's first step.
/// - A file's only header version, if messageless, lands line by line: each `use` with the first
///   step whose code needs it, each `mod` with its module's file.
fn feature_steps(corpus: &Corpus, names: &BTreeSet<String>, f: &Feature, assets: Assets) -> Result<Vec<Step>, String> {
    let vs: Vec<Ver> = corpus
        .tagged(&f.slug)
        .into_iter()
        .map(|t| {
            let file = &corpus.files[t.file];
            let block = &file.blocks[t.block];
            let v = &block.versions[t.version];
            Ver { t, path: &file.path, block, message: v.message.as_deref(), code: if v.removed { String::new() } else { code(&v.text) } }
        })
        .collect();
    let n = vs.len();
    let same_block = |a: usize, b: usize| vs[a].t.file == vs[b].t.file && vs[a].t.block == vs[b].t.block;
    let headers_in = |file: usize| vs.iter().filter(|v| v.t.file == file && v.block.kind == BlockKind::Header).count();
    let partial: Vec<bool> = vs.iter().map(|v| v.block.kind == BlockKind::Header && headers_in(v.t.file) == 1).collect();
    let is_header = |j: usize| vs[j].block.kind == BlockKind::Header;

    // Groups by subject, keeping a message that has a body.
    let mut groups: Vec<String> = Vec::new();
    let mut group: Vec<Option<usize>> = vec![None; n];
    for (i, v) in vs.iter().enumerate() {
        let Some(m) = v.message else { continue };
        let g = match groups.iter().position(|g| subject(g) == subject(m)) {
            Some(g) => {
                if !groups[g].contains('\n') && m.contains('\n') {
                    groups[g] = m.to_string();
                }
                g
            }
            None => {
                groups.push(m.to_string());
                groups.len() - 1
            }
        };
        group[i] = Some(g);
    }
    let gn = groups.len();

    // What must come first.
    let mut edges: BTreeSet<(usize, usize)> = BTreeSet::new();
    // Why each edge is there, for the error when they loop.
    let mut why: BTreeMap<(usize, usize), String> = BTreeMap::new();
    let mut add = |edges: &mut BTreeSet<(usize, usize)>, a: usize, b: usize, reason: &dyn Fn() -> String| {
        if a != b && edges.insert((a, b)) {
            why.insert((a, b), reason());
        }
    };
    let mut last: Option<usize> = None;
    for i in (0..n).filter(|&i| group[i].is_some()) {
        if let Some(j) = last
            && same_block(i, j)
        {
            add(&mut edges, group[j].expect("grouped"), group[i].expect("grouped"), &|| format!("{} v{} then v{}", vs[i].block.key(vs[i].path), vs[j].t.version + 1, vs[i].t.version + 1));
        }
        last = Some(i);
    }
    for i in 0..n {
        let (v, Some(g)) = (&vs[i], group[i]) else { continue };
        let name = &v.block.name;
        let introduces = matches!(v.block.kind, BlockKind::Item | BlockKind::Const)
            && names.contains(name)
            && (v.t.version == 0 || v.block.versions[v.t.version - 1].removed)
            && defines(&v.code, name);
        if introduces {
            // Headers are cut to the imports their file needs, so only code waits.
            for j in (0..n).filter(|&j| !same_block(i, j) && !is_header(j) && sees(corpus, vs[j].path, v.path) && has_word(&vs[j].code, name)) {
                if let Some(h) = group[j] {
                    add(&mut edges, g, h, &|| format!("{} uses {name}", vs[j].block.key(vs[j].path)));
                }
            }
        }
    }
    for i in (0..n).filter(|&i| vs[i].block.kind == BlockKind::Header && vs[i].t.version == 0) {
        let Some((src, m)) = module_of(vs[i].path) else { continue };
        let Some(g) = (0..n).filter(|&j| vs[j].t.file == vs[i].t.file).filter_map(|j| group[j]).min() else { continue };
        for j in (0..n).filter(|&j| vs[j].t.file != vs[i].t.file && !is_header(j) && vs[j].path.starts_with(src) && has_path(&vs[j].code, m)) {
            if let Some(h) = group[j] {
                add(&mut edges, g, h, &|| format!("{} calls into the new module {m}", vs[j].block.key(vs[j].path)));
            }
        }
    }
    for i in (0..n).filter(|&i| vs[i].path.ends_with("/Cargo.toml") && !vs[i].removed()) {
        let (v, Some(g)) = (&vs[i], group[i]) else { continue };
        let src = format!("{}src/", v.path.trim_end_matches("Cargo.toml"));
        let before = v.t.version.checked_sub(1).map(|p| deps(&v.block.versions[p].text)).unwrap_or_default();
        for d in deps(&v.block.versions[v.t.version].text).difference(&before) {
            for j in (0..n).filter(|&j| vs[j].path.starts_with(&src) && !is_header(j)) {
                let Some(h) = group[j] else { continue };
                // The names the feature's own headers in that file import from the crate.
                let imported: Vec<&str> = vs
                    .iter()
                    .filter(|h| h.t.file == vs[j].t.file && h.block.kind == BlockKind::Header)
                    .flat_map(|h| parse_header(&h.block.versions[h.t.version].text))
                    .filter_map(|l| match l {
                        Line::Use { prefix, names, .. } if prefix.split("::").next() == Some(d.as_str()) => Some(names.into_iter().map(move |x| bound(prefix, x))),
                        _ => None,
                    })
                    .flatten()
                    .collect();
                if has_path(&vs[j].code, d) || imported.iter().any(|x| has_word(&vs[j].code, x)) {
                    add(&mut edges, g, h, &|| format!("{} uses the crate {d}", vs[j].block.key(vs[j].path)));
                }
            }
        }
    }
    // A header with a message anchors its step: a new file starts there, and code needing an
    // import it adds comes after.
    for h in (0..n).filter(|&h| partial[h]) {
        let (v, Some(g)) = (&vs[h], group[h]) else { continue };
        let before = v.t.version.checked_sub(1).map(|p| v.block.versions[p].text.as_str()).unwrap_or("");
        let added: Vec<String> = imports(&v.block.versions[v.t.version].text).difference(&imports(before)).cloned().collect();
        for j in (0..n).filter(|&j| j != h && vs[j].t.file == v.t.file) {
            let Some(q) = group[j] else { continue };
            if v.t.version == 0 {
                add(&mut edges, g, q, &|| format!("{} starts with its header", v.path));
            } else if let Some(x) = added.iter().find(|x| has_word(&vs[j].code, x)) {
                add(&mut edges, g, q, &|| format!("{} uses {x}, which the header imports", vs[j].block.key(vs[j].path)));
            }
        }
    }
    // A test step follows the steps bringing the items it names, unless that would loop.
    let tests: Vec<bool> = (0..gn).map(|g| (0..n).filter(|&i| group[i] == Some(g)).all(|i| vs[i].block.kind == BlockKind::Test)).collect();
    for j in (0..n).filter(|&j| group[j].is_some_and(|g| tests[g])) {
        let t = group[j].expect("grouped");
        for i in 0..n {
            let first_here = !(0..i).any(|k| same_block(i, k));
            let names_it = matches!(vs[i].block.kind, BlockKind::Item | BlockKind::Const) && has_word(&vs[j].code, &vs[i].block.name);
            if let Some(p) = group[i]
                && p != t
                && first_here
                && names_it
                && vs[i].t.file == vs[j].t.file
                && !reaches(&edges, t, p)
            {
                add(&mut edges, p, t, &|| format!("{} tests {}", vs[j].block.key(vs[j].path), vs[i].block.name));
            }
        }
    }
    // Prose (docs, the devlog) follows the code it describes.
    let prose: Vec<bool> = (0..gn).map(|g| (0..n).filter(|&i| group[i] == Some(g)).all(|i| vs[i].path.ends_with(".md"))).collect();
    let keys: Vec<(usize, u8, usize)> = (0..gn)
        .map(|g| match edges.iter().filter(|e| e.1 == g).map(|e| e.0).max() {
            Some(p) if tests[g] => (p, 1, g),
            _ if prose[g] => (gn + g, 0, g),
            _ => (g, 0, g),
        })
        .collect();
    let pos = order(&keys, &edges).map_err(|stuck| {
        // Every stuck step waits on another: walk back until one repeats, and that's a loop.
        let mut path = vec![stuck[0]];
        let mut lp = loop {
            let b = *path.last().expect("a step");
            let a = edges.iter().find(|e| e.1 == b && stuck.contains(&e.0)).expect("a stuck step waits on a stuck step").0;
            if let Some(at) = path.iter().position(|&x| x == a) {
                break path[at..].iter().copied().chain([a]).collect::<Vec<_>>();
            }
            path.push(a);
        };
        lp.reverse();
        let steps: Vec<String> = lp.windows(2).map(|w| format!("{:?} before {:?} ({})", subject(&groups[w[0]]), subject(&groups[w[1]]), why[&(w[0], w[1])])).collect();
        format!("feature {}: its steps need each other first:\n  {}", f.slug, steps.join("\n  "))
    })?;

    // Messageless constants (and headers of a file with several header versions) ride along.
    let mut slot: Vec<Option<usize>> = group.iter().map(|g| g.map(|g| pos[g])).collect();
    let mut orphans: Vec<usize> = Vec::new();
    for i in 0..n {
        if slot[i].is_some() || partial[i] {
            continue;
        }
        let v = &vs[i];
        let floor = (0..i).rev().find(|&j| same_block(i, j)).and_then(|j| slot[j]);
        let ceiling = (i + 1..n).find(|&j| same_block(i, j) && group[j].is_some()).and_then(|j| slot[j]);
        let within = |p: &usize| floor.is_none_or(|f| *p >= f) && ceiling.is_none_or(|c| *p <= c);
        let grouped_pos = |j: usize| group[j].map(|g| pos[g]);
        let name = &v.block.name;
        let uses = (0..n).filter(|&j| {
            v.block.kind == BlockKind::Const && !same_block(i, j) && (vs[j].t.file == v.t.file || names.contains(name)) && has_word(&vs[j].code, name)
        });
        let later = (i + 1..n).filter(|&j| vs[j].t.file == v.t.file);
        let before = (0..i).filter(|&j| vs[j].t.file == v.t.file).filter_map(grouped_pos);
        slot[i] = uses.chain(later).filter_map(grouped_pos).filter(within).min().or_else(|| before.filter(within).max()).or(floor).or(ceiling);
        if slot[i].is_none() {
            orphans.push(i);
        }
    }

    let mut drafts: Vec<Draft> = (0..gn).map(|_| Draft::new("")).collect();
    for (g, m) in groups.iter().enumerate() {
        drafts[pos[g]].message = m.clone();
    }
    for (i, s) in slot.iter().enumerate() {
        if let Some(p) = s {
            drafts[*p].members.push(i);
        }
    }
    let mut extra: Vec<Draft> = Vec::new();
    for a in &f.assets {
        let edit = Edit::set(a.path.clone(), Value::Bytes(assets(&a.path, a.version)));
        match drafts.iter_mut().chain(extra.iter_mut()).find(|d| subject(&d.message) == subject(&a.message)) {
            Some(d) => d.assets.push(edit),
            None => {
                let mut d = Draft::new(a.message.clone());
                d.assets.push(edit);
                extra.push(d);
            }
        }
    }
    let at = drafts.len().min(1);
    drafts.splice(at..at, extra);
    if drafts.is_empty() && (!orphans.is_empty() || partial.contains(&true)) {
        drafts.push(Draft::new(f.title.clone()));
    }
    if !orphans.is_empty() {
        drafts[0].members.extend(orphans);
        drafts[0].members.sort_unstable();
    }
    let mut draft_of: Vec<Option<usize>> = vec![None; n];
    // (A header's edits come from `ride_headers`, its member slot only anchors it.)
    for (k, d) in drafts.iter().enumerate() {
        for &i in &d.members {
            draft_of[i] = Some(k);
        }
    }
    ride_headers(corpus, &vs, &partial, &draft_of, &mut drafts);

    Ok(drafts
        .into_iter()
        .filter_map(|d| {
            let mut ordered: Vec<((usize, usize, usize), Edit)> = d
                .members
                .iter()
                .filter(|&&i| !partial[i])
                .map(|&i| {
                    let v = &vs[i];
                    ((v.t.file, v.t.block, v.t.version), Edit::set(v.block.key(v.path), Value::Version(v.block.versions[v.t.version].n)))
                })
                .collect();
            for (i, value) in d.headers {
                let v = &vs[i];
                ordered.push(((v.t.file, v.t.block, v.t.version), Edit::set(v.block.key(v.path), value)));
            }
            ordered.sort_by_key(|(k, _)| *k);
            let mut edits: Vec<Edit> = Vec::new();
            // Two versions of one block in a step: the later one is what the commit holds.
            for e in ordered.into_iter().map(|(_, e)| e).chain(d.assets) {
                if let Some(at) = edits.iter().position(|x| x.key == e.key) {
                    edits.remove(at);
                }
                edits.push(e);
            }
            (!edits.is_empty()).then(|| Step::new(d.message, edits))
        })
        .collect())
}

/// Whether `to` can be reached from `from` along `edges`.
fn reaches(edges: &BTreeSet<(usize, usize)>, from: usize, to: usize) -> bool {
    let mut seen = BTreeSet::from([from]);
    let mut todo = vec![from];
    while let Some(a) = todo.pop() {
        if a == to {
            return true;
        }
        for &(_, b) in edges.range((a, 0)..(a + 1, 0)) {
            if seen.insert(b) {
                todo.push(b);
            }
        }
    }
    false
}

/// Each node's position in a topological order, the ready node with the lowest key first; or
/// the nodes caught in a cycle.
fn order(keys: &[(usize, u8, usize)], edges: &BTreeSet<(usize, usize)>) -> Result<Vec<usize>, Vec<usize>> {
    let n = keys.len();
    let mut incoming = vec![0usize; n];
    for &(_, b) in edges {
        incoming[b] += 1;
    }
    let mut ready: BTreeSet<((usize, u8, usize), usize)> = (0..n).filter(|&g| incoming[g] == 0).map(|g| (keys[g], g)).collect();
    let mut pos = vec![usize::MAX; n];
    let mut next = 0;
    while let Some((_, g)) = ready.pop_first() {
        pos[g] = next;
        next += 1;
        for &(_, b) in edges.range((g, 0)..(g + 1, 0)) {
            incoming[b] -= 1;
            if incoming[b] == 0 {
                ready.insert((keys[b], b));
            }
        }
    }
    if next == n { Ok(pos) } else { Err((0..n).filter(|&g| pos[g] == usize::MAX).collect()) }
}

/// Lands each messageless header (a file's only header version here) a line at a time: from the
/// first step touching its file, the header is its new version with only the `use` names the
/// file's code needs so far and the `mod` lines whose files exist; it reaches the new version
/// by the feature's end.
fn ride_headers(corpus: &Corpus, vs: &[Ver], partial: &[bool], draft_of: &[Option<usize>], drafts: &mut [Draft]) {
    let n = vs.len();
    // The draft from which a file the feature creates exists.
    fn exists(vs: &[Ver], partial: &[bool], draft_of: &[Option<usize>], path: &str, depth: usize) -> usize {
        let Some(h) = (0..vs.len()).find(|&j| vs[j].path == path && vs[j].block.kind == BlockKind::Header && vs[j].t.version == 0) else {
            return 0;
        };
        if partial[h] { start(vs, partial, draft_of, h, depth + 1) } else { draft_of[h].unwrap_or(0) }
    }
    // The draft a header starts landing in: the first that brings a module it declares, or its
    // own step if it has a message, or else the first touching its file.
    fn start(vs: &[Ver], partial: &[bool], draft_of: &[Option<usize>], h: usize, depth: usize) -> usize {
        let file = vs[h].t.file;
        let touched = if vs[h].message.is_some() { draft_of[h] } else { (0..vs.len()).filter(|&j| vs[j].t.file == file && j != h).filter_map(|j| draft_of[j]).min() };
        let target = &vs[h].block.versions[vs[h].t.version].text;
        let old: BTreeSet<&str> = match vs[h].t.version.checked_sub(1) {
            Some(p) => parse_header(&vs[h].block.versions[p].text).into_iter().filter_map(|l| if let Line::Mod { name, .. } = l { Some(name) } else { None }).collect(),
            None => BTreeSet::new(),
        };
        let modules = parse_header(target)
            .into_iter()
            .filter_map(|l| match l {
                Line::Mod { name, .. } if !old.contains(name) && depth < 8 => {
                    module_paths(vs[h].path, name).iter().filter(|p| vs.iter().any(|v| v.path == p.as_str())).map(|p| exists(vs, partial, draft_of, p, depth)).min()
                }
                _ => None,
            })
            .min();
        touched.into_iter().chain(modules).min().unwrap_or(0)
    }

    // Each touched block's version, draft by draft: before the feature, the one before its first.
    let mut state: BTreeMap<(usize, usize), Option<usize>> = BTreeMap::new();
    for v in vs.iter().filter(|v| v.block.kind != BlockKind::Header) {
        state.entry((v.t.file, v.t.block)).or_insert(v.t.version.checked_sub(1));
    }
    let riders: Vec<usize> = (0..n).filter(|&h| partial[h]).collect();
    let starts: Vec<usize> = riders.iter().map(|&h| start(vs, partial, draft_of, h, 0)).collect();
    let mut shown: Vec<Option<String>> = riders.iter().map(|&h| vs[h].t.version.checked_sub(1).map(|p| tidy(&lines(&vs[h].block.versions[p].text)))).collect();
    let mut landed: Vec<Option<usize>> = vec![None; riders.len()];
    for (k, draft) in drafts.iter_mut().enumerate() {
        for &i in &draft.members {
            if vs[i].block.kind != BlockKind::Header {
                state.insert((vs[i].t.file, vs[i].t.block), Some(vs[i].t.version));
            }
        }
        for (r, &h) in riders.iter().enumerate() {
            if k < starts[r] {
                continue;
            }
            let text = cut_header(corpus, vs, h, k, &state, &|p: &str| exists(vs, partial, draft_of, p, 0));
            if shown[r].as_ref() != Some(&text) {
                let target = &vs[h].block.versions[vs[h].t.version];
                let value = if text == tidy(&lines(&target.text)) { Value::Version(target.n) } else { Value::Tuned(target.n, Rc::from(text.as_str())) };
                draft.headers.push((h, value));
                shown[r] = Some(text);
                landed[r] = Some(k);
            }
        }
    }
    // A header whose code never needed all of it (a corpus slip) still ends at its version.
    for (r, &h) in riders.iter().enumerate() {
        let target = &vs[h].block.versions[vs[h].t.version];
        if shown[r].as_deref() != Some(tidy(&lines(&target.text)).as_str()) {
            let k = landed[r].unwrap_or(starts[r]).min(drafts.len() - 1);
            drafts[k].headers.retain(|(i, _)| *i != h);
            drafts[k].headers.push((h, Value::Version(target.n)));
        }
    }
}

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect()
}

/// The riding header `h` as of draft `k`.
fn cut_header(corpus: &Corpus, vs: &[Ver], h: usize, k: usize, state: &BTreeMap<(usize, usize), Option<usize>>, exists: &dyn Fn(&str) -> usize) -> String {
    let hv = &vs[h];
    let file = hv.t.file;
    let target = parse_header(&hv.block.versions[hv.t.version].text);
    let old = hv.t.version.checked_sub(1).map(|p| parse_header(&hv.block.versions[p].text)).unwrap_or_default();
    let uses = |ls: &[Line]| -> BTreeSet<String> {
        ls.iter().filter_map(|l| if let Line::Use { prefix, names, .. } = l { Some(names.iter().map(|x| bound(prefix, x).to_string()).collect::<Vec<_>>()) } else { None }).flatten().collect()
    };
    let (old_names, target_names) = (uses(&old), uses(&target));
    let old_mods: BTreeSet<&str> = old.iter().filter_map(|l| if let Line::Mod { name, .. } = l { Some(*name) } else { None }).collect();
    // The code of the file's blocks this feature touches, as of draft k.
    let body: Vec<String> = state
        .iter()
        .filter(|((f, _), _)| *f == file)
        .filter_map(|(&(f, b), v)| {
            let version = &corpus.files[f].blocks[b].versions[(*v)?];
            (!version.removed).then(|| code(&version.text))
        })
        .collect();
    let needed = |name: &str| name == "*" || body.iter().any(|t| has_word(t, name));
    // A module file the feature brings exists from its step; any other, if the corpus has it.
    let module_exists = |name: &str| {
        module_paths(hv.path, name).iter().any(|p| if vs.iter().any(|v| v.path == p.as_str()) { exists(p) <= k } else { corpus.file(p).is_some() })
    };
    // A re-export stands once its module's file and the item do.
    let reexport = |prefix: &str, name: &str| {
        let first = prefix.split("::").next().unwrap_or(prefix);
        let item = module_paths(hv.path, first).into_iter().find_map(|p| {
            let v = vs.iter().find(|v| v.path == p && v.block.name == name && matches!(v.block.kind, BlockKind::Item | BlockKind::Const))?;
            let at = *state.get(&(v.t.file, v.t.block))?;
            Some(at.is_some_and(|a| !v.block.versions[a].removed))
        });
        (old_mods.contains(first) || module_exists(first)) && item.unwrap_or(true)
    };
    let keep_target = |public: bool, prefix: &str, name: &str| {
        let b = bound(prefix, name);
        if public { reexport(prefix, name) } else { old_names.contains(b) || needed(b) }
    };
    let keep_old = |public: bool, prefix: &str, name: &str| {
        let b = bound(prefix, name);
        !target_names.contains(b) && !public && needed(b)
    };

    let mut out: Vec<String> = Vec::new();
    for l in &target {
        match l {
            Line::Other(s) => out.push(s.to_string()),
            Line::Mod { name, raw } => {
                if old_mods.contains(name) || module_exists(name) {
                    out.push(raw.to_string());
                }
            }
            Line::Use { public, prefix, names, raw } => {
                let mut kept: Vec<&str> = names.iter().copied().filter(|x| keep_target(*public, prefix, x)).collect();
                if let Some(Line::Use { names: was, .. }) = old.iter().find(|o| matches!(o, Line::Use { public: p, prefix: q, .. } if p == public && q == prefix)) {
                    for (at, x) in was.iter().enumerate() {
                        if !names.contains(x) && keep_old(*public, prefix, x) {
                            let after = was[..at].iter().rev().find_map(|y| kept.iter().position(|z| z == y));
                            kept.insert(after.map_or(0, |p| p + 1), x);
                        }
                    }
                }
                if kept == *names {
                    out.push(raw.to_string());
                } else if !kept.is_empty() {
                    out.push(use_line(*public, prefix, &kept));
                }
            }
        }
    }
    // Imports whose whole line the new version drops, while the code still needs them.
    for l in &old {
        let Line::Use { public, prefix, names, .. } = l else { continue };
        if target.iter().any(|t| matches!(t, Line::Use { public: p, prefix: q, .. } if p == public && q == prefix)) {
            continue;
        }
        let kept: Vec<&str> = names.iter().copied().filter(|x| keep_old(*public, prefix, x)).collect();
        if kept.is_empty() {
            continue;
        }
        let line = use_line(*public, prefix, &kept);
        let is_use = |s: &String| s.starts_with("use ") || s.starts_with("pub use ");
        let at = out.iter().position(|s| is_use(s) && *s > line).or_else(|| out.iter().rposition(is_use).map(|p| p + 1)).unwrap_or(out.len());
        out.insert(at, line);
    }
    tidy(&out)
}

/// Retunes one of the feature's own constants, at the version its steps leave it: up or down the
/// way the feature moved it, if it did. Leaves alone what no filler tunes either (sizes, slots,
/// tick counts, versions, physical constants, and what a test names or pins), and a value one of
/// the feature's subjects quotes.
fn review_step(corpus: &Corpus, pins: &Pins, f: &Feature, steps: &[Step], messages: &Messages, rng: &mut Rng) -> Option<Step> {
    let subjects: Vec<&str> = steps.iter().map(|s| subject(&s.message)).collect();
    let mut last: BTreeMap<&str, u16> = BTreeMap::new();
    for e in steps.iter().flat_map(|s| &s.edits) {
        if let (Some(Value::Version(n)), true) = (&e.value, e.key.contains("#const:")) {
            last.insert(&e.key, *n);
        }
    }
    let quoted = |lit: &str| {
        let plain = lit.replace('_', "");
        let whole = plain.strip_suffix(".0").unwrap_or(&plain).to_string();
        subjects.iter().any(|s| [lit, plain.as_str(), whole.as_str()].iter().any(|x| has_word(s, x)))
    };
    let number = |lit: &str| lit.replace('_', "").parse::<f64>().ok();
    let tagged = corpus.tagged(&f.slug);
    let consts: Vec<(&str, &str, u16, &str, Option<bool>)> = last
        .into_iter()
        .filter_map(|(key, n)| {
            let (path, name) = key.split_once("#const:")?;
            let file = corpus.file(path)?;
            let bi = file.blocks.iter().position(|b| b.kind == BlockKind::Const && b.name == name)?;
            let block = &file.blocks[bi];
            let v = block.versions.get(usize::from(n).checked_sub(1)?)?;
            let lit = (!v.removed).then(|| literal_of(&v.text)).flatten()?;
            // Not a size or a physical constant, not a zero (scaling would only step it away from
            // zero), and not a value a test holds.
            if !pins.free(corpus, key, lit) || quoted(lit) {
                return None;
            }
            // The way the feature moved it: from the version before its first to its last.
            let first = tagged.iter().find(|t| corpus.files[t.file].path == path && t.block == bi)?.version;
            let before = first.checked_sub(1).map(|p| &block.versions[p]).filter(|b| !b.removed).and_then(|b| literal_of(&b.text)).and_then(number);
            let way = before.zip(number(lit)).filter(|(a, b)| a != b).map(|(a, b)| b > a);
            Some((key, name, n, lit, way))
        })
        .collect();
    if consts.is_empty() {
        return None;
    }
    let (key, name, n, old, way) = *rng.pick(&consts);
    let up = way.unwrap_or_else(|| rng.chance(0.5));
    // Scaling a negative number up lowers it.
    let negative = number(old).is_some_and(|x| x < 0.0);
    let factor = f64::from(if up != negative { rng.range_f(1.05, 1.3) } else { rng.range_f(0.75, 0.95) });
    let new = tune(old, factor);
    // A ratio that would cross one (a zoom step down to 1.0) isn't a tune a reviewer asks for.
    if !sensible_tune(number(old)?, number(&new)?) {
        return None;
    }
    let rose = number(&new) > number(old);
    let message = fill(&messages.pick(if rose { "review-up" } else { "review-down" }, rng), &[("what", &human(name)), ("old", old), ("new", &new)]);
    Some(Step::new(message, vec![Edit::set(key, Value::Tuned(n, Rc::from(new)))]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbital::corpus::{subject_ok, FEATURES};

    const CORPUS: &str = r#"#file crates/x/src/lib.rs
#header v1 @first
//! X.
#header v2 @second
//! X, faster.
#const SPEED v1 @first
pub const SPEED: f32 = 10.0;
#item go v1 @first "Add go"
pub fn go() {}
#item go v2 @second "Make go faster"
pub fn go() {
    let _ = SPEED;
}
#file README.md
#whole v1 @first "Write the readme"
# X
"#;
    const FEATURES_T: &str = "# comment\nfirst | chore | ilse | 1 | main | direct | Start X\n  asset assets/a.png v1 \"Draw a\"\nsecond | feature | teodor | 2 | main | merged | Make X faster\n  > Faster now.\n  > Really.\nthird | balance | wen | 3 | main | conflict | Rework X\n";
    const REVIEW: &str = "[review-up]\nTweak {what} up after review\n[review-down]\nTweak {what} down after review\n";

    fn stub(path: &str, v: u16) -> Rc<[u8]> {
        Rc::from(format!("{path}@{v}").into_bytes())
    }

    fn plans() -> Vec<FeaturePlan> {
        let corpus = Corpus::from_sources(&[("t.txt", CORPUS)]).unwrap();
        let features = parse_features(FEATURES_T).unwrap();
        plan(&corpus, &features, &Messages::parse(REVIEW).unwrap(), &stub, &mut Rng::new(1)).unwrap()
    }

    fn plan_of(corpus: &str, features: &str) -> Result<Vec<FeaturePlan>, String> {
        let corpus = Corpus::from_sources(&[("t.txt", corpus)]).unwrap();
        plan(&corpus, &parse_features(features).unwrap(), &Messages::parse("").unwrap(), &stub, &mut Rng::new(1))
    }

    fn subjects(p: &FeaturePlan) -> Vec<&str> {
        p.steps.iter().map(|s| subject(&s.message)).collect()
    }

    fn keys(s: &Step) -> Vec<&str> {
        s.edits.iter().map(|e| e.key.as_str()).collect()
    }

    const F: &str = "f | feature | ilse | 1 | main | direct | F\n";

    #[test]
    fn a_branch_name_does_not_repeat_its_kind() {
        let f = parse_features("fix-1-0-save | fix | ilse | 31 | release/1.0 | merged | Fix it\nfixture | feature | wen | 2 | main | merged | Add it\n").unwrap();
        assert_eq!(f[0].branch(), "fix/1-0-save");
        assert_eq!(f[1].branch(), "feature/fixture");
    }

    #[test]
    fn features_parse_with_assets_and_descriptions() {
        let f = parse_features(FEATURES_T).unwrap();
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].fate.clone(), f[0].branch()), (Fate::Direct, "chore/first".to_string()));
        assert_eq!(f[1].description, ["Faster now.", "Really."]);
        assert_eq!((f[0].assets[0].path.as_str(), f[0].assets[0].version, f[0].assets[0].message.as_str()), ("assets/a.png", 1, "Draw a"));
        assert_eq!(f[1].author, "teodor");
        assert_eq!(f[1].branch(), "feature/second");
        assert!(parse_features("x | feature | nobody | 1 | main | merged | T\n").is_err());
        assert!(parse_features("x | feature | ilse | 1 | main | sideways | T\n").is_err());
        assert!(parse_features("x | feature | ilse | 1 | main | merged | T\nx | fix | ilse | 2 | main | merged | U\n").unwrap_err().contains("twice"));
        assert!(parse_features("x | feature | ilse | 1 | main | merged | T\n  later: soon\n").unwrap_err().contains("later"));
        assert_eq!(parse_features("x | feature | ilse | 1 | main | unpushed:2 | T\n").unwrap()[0].fate, Fate::Unpushed(2));
    }

    #[test]
    fn headers_and_constants_ride_with_the_next_messaged_step() {
        let p = plans();
        assert_eq!(subjects(&p[0]), ["Add go", "Draw a", "Write the readme"]);
        assert_eq!(keys(&p[0].steps[0]), ["crates/x/src/lib.rs#header", "crates/x/src/lib.rs#const:SPEED", "crates/x/src/lib.rs#item:go"]);
        assert_eq!(p[0].steps[1].edits[0].value, Some(Value::Bytes(stub("assets/a.png", 1))));
        let second = &p[1].steps;
        assert_eq!(second.len(), 1, "no constant of its own, so no review step");
        assert_eq!(keys(&second[0]), ["crates/x/src/lib.rs#header", "crates/x/src/lib.rs#item:go"]);
        assert_eq!(second[0].edits[0].value, Some(Value::Version(2)));
        assert!(p[2].steps.is_empty(), "the conflict branch is built elsewhere");
        assert!(p[1].keys.contains("crates/x/src/lib.rs#item:go"));
    }

    #[test]
    fn a_review_step_retunes_one_of_the_features_constants() {
        let corpus = Corpus::from_sources(&[("t.txt", CORPUS)]).unwrap();
        let messages = Messages::parse(REVIEW).unwrap();
        let mut features = parse_features(FEATURES_T).unwrap();
        features[0].fate = Fate::Merged;
        let reviewed = (0..40).find_map(|seed| {
            let p = plan(&corpus, &features, &messages, &stub, &mut Rng::new(seed)).unwrap();
            (p[0].steps.len() == 4).then_some(p)
        });
        let p = reviewed.expect("some seed gives a review step");
        let last = p[0].steps.last().unwrap();
        let Some(Value::Tuned(1, lit)) = &last.edits[0].value else { panic!("{last:?}") };
        let up = lit.parse::<f32>().unwrap() > 10.0;
        assert_eq!(last.message, format!("Tweak the speed {} after review", if up { "up" } else { "down" }));
    }

    #[test]
    fn a_review_keeps_the_features_direction_and_skips_quoted_and_sizing_constants() {
        let corpus = "#file a.rs\n#header v1 @start\n//! A.\n#const RANGE v1 @start\npub const RANGE: u32 = 400;\n#const RANGE v2 @f\npub const RANGE: u32 = 300;\n#const BELT v1 @f\npub const BELT: u32 = 24;\n#const BUFFER_CAPACITY v1 @f\npub const BUFFER_CAPACITY: u32 = 64;\n#item a v1 @start \"Add a\"\npub fn a() {}\n#item a v2 @f \"Thin the belt to 24 rocks\"\npub fn a() {\n    1;\n}\n";
        let corpus = Corpus::from_sources(&[("t.txt", corpus)]).unwrap();
        let features = parse_features("start | chore | ilse | 1 | main | direct | Start\nf | feature | ilse | 1 | main | merged | F\n").unwrap();
        let messages = Messages::parse(REVIEW).unwrap();
        let mut seen = 0;
        for seed in 0..60 {
            let p = plan(&corpus, &features, &messages, &stub, &mut Rng::new(seed)).unwrap();
            let Some(last) = p[1].steps.get(1) else { continue };
            seen += 1;
            assert_eq!(last.edits[0].key, "a.rs#const:RANGE", "BELT is quoted and BUFFER_CAPACITY a size");
            assert_eq!(last.message, "Tweak the range down after review", "the feature lowered it");
            assert!(matches!(&last.edits[0].value, Some(Value::Tuned(2, lit)) if lit.parse::<u32>().unwrap() < 300));
        }
        assert!(seen > 5, "{seen}");
    }

    #[test]
    fn a_feature_without_steps_is_an_error() {
        let corpus = Corpus::from_sources(&[("t.txt", CORPUS)]).unwrap();
        let features = parse_features("lonely | feature | ilse | 1 | main | merged | Nothing here\n").unwrap();
        let err = plan(&corpus, &features, &Messages::parse("").unwrap(), &stub, &mut Rng::new(1)).unwrap_err();
        assert!(err.contains("lonely"), "{err}");
    }

    #[test]
    fn features_built_elsewhere_plan_no_steps() {
        let features = "tag-v010 | chore | rafe | 4 | main | merged | Tag v0.1.0\n  later: release\nroute-stops | feature | wen | 38 | main | merged | Show the next stop\n  later: unwritten\nhud-polish | feature | kasimir | 39 | main | irebase | Polish the HUD\nfirst | chore | ilse | 1 | main | direct | Start X\n";
        let p = plan_of(CORPUS, features).unwrap();
        let deferred: Vec<(Option<Deferred>, usize)> = p.iter().map(|p| (p.feature.deferred(), p.steps.len())).collect();
        assert_eq!(deferred, [(Some(Deferred::Release), 0), (Some(Deferred::Unwritten), 0), (Some(Deferred::Special), 0), (None, 2)]);
        assert!(p[..3].iter().all(|p| p.keys.is_empty()));
        assert!(plan_of(CORPUS, "tag-v020 | chore | rafe | 7 | main | merged | Tag v0.2.0\n").is_err(), "an empty feature needs its later: line");
    }

    #[test]
    fn versions_sharing_a_subject_make_one_commit_across_files() {
        let corpus = "#file a.rs\n#header v1 @f\n//! A.\n#item one v1 @f \"Add the pair\"\npub fn one() {}\n#item two v1 @f \"Add two\"\npub fn two() {}\n#file b.md\n#whole v1 @f \"Add the pair\\n\\nWith a body.\"\nb\n";
        let p = plan_of(corpus, &format!("{F}  asset c.png v1 \"Add the pair\"\n  asset d.png v1 \"Draw d\"\n  asset d.png v2 \"Draw d\"\n")).unwrap();
        assert_eq!(subjects(&p[0]), ["Add the pair", "Draw d", "Add two"]);
        assert_eq!(p[0].steps[0].message, "Add the pair\n\nWith a body.", "the message with a body wins");
        assert_eq!(keys(&p[0].steps[0]), ["a.rs#header", "a.rs#item:one", "b.md", "c.png"]);
        assert_eq!(keys(&p[0].steps[1]), ["d.png"], "one asset path per step, at its last version");
        assert_eq!(p[0].steps[1].edits[0].value, Some(Value::Bytes(stub("d.png", 2))));
    }

    #[test]
    fn a_blocks_versions_keep_their_order_across_steps() {
        // "Second" first appears before "First", but `p` needs v1 before v2.
        let corpus = "#file a.rs\n#header v1 @f\n//! A.\n#item q v1 @f \"Second\"\npub fn q() {}\n#item p v1 @f \"First\"\npub fn p() {}\n#item p v2 @f \"Second\"\npub fn p() {\n    q();\n}\n";
        let p = plan_of(corpus, F).unwrap();
        assert_eq!(subjects(&p[0]), ["First", "Second"]);
        assert_eq!(keys(&p[0].steps[0]), ["a.rs#header", "a.rs#item:p"], "the header rides with the first step in its file");
        // Two blocks whose versions need the steps in opposite orders can't be planned.
        let tangled = "#file a.rs\n#header v1 @f\n//! A.\n#item p v1 @f \"One\"\npub fn p() {}\n#item p v2 @f \"Two\"\npub fn p() {\n    1;\n}\n#item q v1 @f \"Two\"\npub fn q() {}\n#item q v2 @f \"One\"\npub fn q() {\n    1;\n}\n";
        let err = plan_of(tangled, F).unwrap_err();
        assert!(err.contains("feature f") && err.contains("need each other first"), "{err}");
    }

    #[test]
    fn a_step_comes_after_the_items_modules_and_crates_it_uses() {
        let corpus = "#file crates/g/Cargo.toml\n#whole v1 @start \"Add the manifest\"\n[dependencies]\nglam = { workspace = true }\n#whole v2 @f \"Add gilrs\"\n[dependencies]\ngilrs = { workspace = true }\nglam = { workspace = true }\n#file crates/g/src/main.rs\n#header v1 @start\n//! G.\n#header v2 @f\n//! G.\n\nmod pad;\n\nuse gilrs::Gilrs;\nuse pad::Stick;\n#item run v1 @start \"Run\"\nfn run() {}\n#item run v2 @f \"Steer with the stick\"\nfn run() {\n    let _ = Stick::read(Gilrs::new());\n}\n#file crates/g/src/pad.rs\n#header v1 @f\n//! The pad.\n#item Stick v1 @f \"Read the stick\"\npub struct Stick;\n";
        let p = plan_of(corpus, &format!("start | chore | ilse | 1 | main | direct | Start\n{F}")).unwrap();
        assert_eq!(subjects(&p[1]), ["Add gilrs", "Read the stick", "Steer with the stick"]);
        assert_eq!(keys(&p[1].steps[1]), ["crates/g/src/main.rs#header", "crates/g/src/pad.rs#header", "crates/g/src/pad.rs#item:Stick"]);
        assert_eq!(p[1].steps[1].edits[0].value, Some(Value::Tuned(2, "//! G.\n\nmod pad;\n".into())), "`mod pad;` comes with pad.rs, nothing else yet");
        assert_eq!(p[1].steps[2].edits[0].value, Some(Value::Version(2)), "the imports come with their first use");
    }

    #[test]
    fn a_header_adding_several_modules_gains_each_with_its_file() {
        let corpus = "#file src/lib.rs\n#header v1 @start\n//! Lib.\n#header v2 @f\n//! Lib.\n\npub mod body;\npub mod world;\n#file src/body.rs\n#header v1 @f\n//! Bodies.\n#item Body v1 @f \"Add bodies\"\npub struct Body;\n#file src/world.rs\n#header v1 @f\n//! World.\n#item World v1 @f \"Add the world\"\npub struct World;\n";
        let p = plan_of(corpus, &format!("start | chore | ilse | 1 | main | direct | Start\n{F}")).unwrap();
        let lib: Vec<&Option<Value>> = p[1].steps.iter().map(|s| &s.edits[0].value).collect();
        assert_eq!(lib, [&Some(Value::Tuned(2, "//! Lib.\n\npub mod body;\n".into())), &Some(Value::Version(2))]);
    }

    #[test]
    fn a_test_follows_the_step_bringing_what_it_tests() {
        let corpus = "#file a.rs\n#header v1 @f\n//! A.\n#item one v1 @f \"Add one\"\npub fn one() {}\n#item two v1 @f \"Add two\"\npub fn two() {}\n#test one_works v1 @f \"Test one\"\n#[test]\nfn one_works() {\n    one();\n}\n#test two_works v1 @f \"Test two\"\n#[test]\nfn two_works() {\n    two();\n}\n";
        assert_eq!(subjects(&plan_of(corpus, F).unwrap()[0]), ["Add one", "Test one", "Add two", "Test two"]);
    }

    #[test]
    fn messageless_versions_alone_make_one_step_named_by_the_feature() {
        let corpus = "#file a.rs\n#header v1 @start\n//! A.\n#header v2 @doc\n//! A, in metres.\n#item a v1 @start \"Add a\"\npub fn a() {}\n";
        let p = plan_of(corpus, "start | chore | ilse | 1 | main | direct | Start\ndoc | docs | rafe | 1 | main | direct | Write down the units\n").unwrap();
        assert_eq!(subjects(&p[1]), ["Write down the units"]);
        assert_eq!(keys(&p[1].steps[0]), ["a.rs#header"]);
        assert_eq!(p[1].steps[0].edits[0].value, Some(Value::Version(2)));
    }

    #[test]
    fn headers_parse_and_cut_back_to_shape() {
        let h = parse_header("//! X.\n\npub mod a;\n\npub use a::{A, B};\nuse crate::b::{self, C as D};\nuse glam::Vec2;\n");
        assert!(matches!(&h[2], Line::Mod { name: "a", .. }));
        assert!(matches!(&h[4], Line::Use { public: true, prefix: "a", names, .. } if names == &["A", "B"]));
        assert!(matches!(&h[5], Line::Use { public: false, prefix: "crate::b", names, .. } if names == &["self", "C as D"]));
        assert_eq!((bound("crate::b", "self"), bound("crate::b", "C as D")), ("b", "D"));
        assert_eq!(use_line(false, "glam", &["Vec2"]), "use glam::Vec2;");
        assert_eq!(use_line(true, "a", &["A", "B"]), "pub use a::{A, B};");
        assert_eq!(tidy(&lines("\n//! X.\n\n\nuse a::B;\n\n")), "//! X.\n\nuse a::B;\n");
        assert_eq!(module_of("crates/x/src/ship.rs"), Some(("crates/x/src/", "ship")));
        assert_eq!(module_of("crates/x/src/lib.rs"), None);
        assert_eq!(module_paths("crates/g/src/app.rs", "hud"), ["crates/g/src/app/hud.rs", "crates/g/src/app/hud/mod.rs"]);
        assert_eq!(deps("[package]\nname = \"x\"\n\n[dependencies]\norbital-core = { workspace = true }\nlog.workspace = true\n"), BTreeSet::from(["orbital_core".to_string(), "log".to_string()]));
    }

    #[test]
    fn human_names() {
        assert_eq!(human("MAX_CARGO_MASS"), "the max cargo mass");
        assert_eq!(human("G"), "the g");
    }

    fn real(seed: u64) -> Vec<FeaturePlan> {
        let features = parse_features(FEATURES).unwrap();
        plan(&Corpus::load(), &features, &Messages::load(), &stub, &mut Rng::new(seed)).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn the_real_features_plan_cleanly() {
        let plans = real(crate::orbital::SEED);
        let mut by_fate: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for p in &plans {
            let f = &p.feature;
            let e = by_fate.entry(format!("{:?}", f.fate)).or_default();
            e.0 += 1;
            e.1 += p.steps.len();
            assert!(!p.steps.is_empty() || f.deferred().is_some(), "{} has no steps", f.slug);
            assert!(p.steps.is_empty() || f.later.is_none(), "{} has content now: drop its later: line", f.slug);
            for s in &p.steps {
                assert!(!s.edits.is_empty(), "{}: {:?} changes nothing", f.slug, s.message);
                subject_ok(subject(&s.message)).unwrap_or_else(|e| panic!("{}: {e}", f.slug));
                let mut ks = BTreeSet::new();
                assert!(s.edits.iter().all(|e| ks.insert(&e.key)), "{}: {:?} sets a key twice", f.slug, s.message);
            }
            // Walking the steps, each block only moves forward through its versions.
            let mut at: BTreeMap<&str, u16> = BTreeMap::new();
            for e in p.steps.iter().flat_map(|s| &s.edits) {
                if let Some(Value::Version(n)) = &e.value
                    && !e.key.ends_with("#header")
                {
                    let before = at.insert(&e.key, *n);
                    assert!(before.is_none_or(|b| b < *n), "{}: {} goes from v{before:?} to v{n}", f.slug, e.key);
                }
            }
        }
        let total: usize = by_fate.values().map(|v| v.1).sum();
        eprintln!("{} features, {total} steps; by fate (features, steps): {by_fate:?}", plans.len());
    }

    #[test]
    fn the_same_seed_plans_the_same_steps() {
        let show = |p: &[FeaturePlan]| format!("{p:?}");
        assert_eq!(show(&real(5)), show(&real(5)));
    }

    #[test]
    fn a_new_feature_leaves_the_others_reviews_alone() {
        let corpus = Corpus::load();
        let messages = Messages::load();
        let features = parse_features(FEATURES).unwrap();
        let mut more = features.clone();
        more.insert(3, parse_features("extra | feature | ilse | 1 | main | merged | Add an extra\n  later: unwritten\n").unwrap().remove(0));
        let a = plan(&corpus, &features, &messages, &stub, &mut Rng::new(9)).unwrap();
        let b = plan(&corpus, &more, &messages, &stub, &mut Rng::new(9)).unwrap();
        let show = |p: &[FeaturePlan]| p.iter().filter(|p| p.feature.slug != "extra").map(|p| format!("{:?}", p.steps)).collect::<Vec<_>>();
        assert_eq!(show(&a), show(&b));
    }

    /// Replays every feature's steps on main as it stands when the feature starts (features in
    /// milestone order, merged and direct ones landing on main) and checks that
    /// each step builds: `mod`s have their files, `use`s resolve, crates are in their manifest and
    /// no import goes unused, both between a feature's steps and once it's done (so main builds
    /// after every merge).
    #[test]
    fn every_intermediate_step_resolves() {
        let corpus = Corpus::load();
        let plans = real(crate::orbital::SEED);
        let mut order: Vec<usize> = (0..plans.len()).collect();
        order.sort_by_key(|&i| (plans[i].feature.milestone, i));
        let mut main = Snapshot::default();
        let (mut transient, mut persistent) = (Vec::new(), Vec::new());
        let renders = check::Renders::default();
        for &i in &order {
            let p = &plans[i];
            let f = &p.feature;
            let base = main.clone();
            let before = check::problems(&corpus, &base, &renders, None);
            let mut snap = base;
            let mut per_step = Vec::new();
            for s in &p.steps {
                let touched = snap.apply(&s.edits);
                per_step.push(check::problems(&corpus, &snap, &renders, Some(&touched)));
            }
            let end = per_step.last().cloned().unwrap_or_default();
            for (k, probs) in per_step.iter().enumerate() {
                for prob in probs.difference(&before) {
                    if k > 0 && per_step[k - 1].contains(prob) {
                        continue;
                    }
                    let line = format!("{} [step {}/{} {:?}]: {prob}", f.slug, k + 1, p.steps.len(), subject(&p.steps[k].message));
                    if end.contains(prob) { persistent.push(line) } else { transient.push(line) }
                }
            }
            if matches!(f.fate, Fate::Merged | Fate::Direct) {
                main = snap;
            }
        }
        assert!(transient.is_empty(), "steps that don't build ({}):\n  {}", transient.len(), transient.join("\n  "));
        assert!(persistent.is_empty(), "features that leave main not building ({}):\n  {}", persistent.len(), persistent.join("\n  "));
    }

    #[test]
    fn the_build_check_finds_missing_modules_crates_items_and_unused_imports() {
        let corpus = "#file crates/orbital-core/Cargo.toml\n#whole v1 @x \"Add the manifest\"\n[dependencies]\nglam = { workspace = true }\n#file crates/orbital-core/src/lib.rs\n#header v1 @x\n//! Core.\n\npub mod a;\npub mod gone;\n\nuse crate::a::{Here, Missing};\nuse glam::Vec2;\nuse serde::Serialize;\n#item f v1 @x \"Add f\"\npub fn f(_: Here, _: Missing, _: Serialize) {}\n#file crates/orbital-core/src/a.rs\n#header v1 @x\n//! A.\n#item Here v1 @x \"Add here\"\npub struct Here;\n#file crates/orbital-core/src/stray.rs\n#header v1 @x\n//! Nobody declares this.\n";
        let corpus = Corpus::from_sources(&[("t.txt", corpus)]).unwrap();
        let mut snap = Snapshot::default();
        for f in &corpus.files {
            for b in &f.blocks {
                snap.apply(&[Edit::set(b.key(&f.path), Value::Version(1))]);
            }
        }
        let found: Vec<String> = check::problems(&corpus, &snap, &check::Renders::default(), None).into_iter().collect();
        assert_eq!(
            found,
            [
                "DEP crates/orbital-core/src/lib.rs: uses serde but crates/orbital-core/Cargo.toml lacks it",
                "MOD crates/orbital-core/src/lib.rs: `mod gone;` without its file",
                "ORPHAN crates/orbital-core/src/stray.rs: no `mod stray;` declares it",
                "UNUSED crates/orbital-core/src/lib.rs: import Vec2 unused",
                "USE crates/orbital-core/src/lib.rs: `use crate::a::{Here, Missing};`: Missing not defined",
            ]
        );
    }

    use super::check;
    use crate::orbital::model::Snapshot;
}

/// A rough build check over rendered Rust files (the story's and the schedule's tests).
#[cfg(test)]
pub(crate) mod check {
    use super::{code, has_word, parse_header, Line};
    use crate::orbital::corpus::Corpus;
    use crate::orbital::model::{Snapshot, Value};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::rc::Rc;

    type Seen = Vec<(String, Option<Rc<str>>)>;
    type Rendered = (Vec<(String, Value)>, Option<Rc<str>>);

    /// Rendered files, kept across snapshots while their keys don't change, and each file's
    /// problems with the files they were worked out from.
    #[derive(Default)]
    pub struct Renders {
        texts: RefCell<BTreeMap<String, Rendered>>,
        found: RefCell<BTreeMap<String, (Seen, Vec<String>)>>,
    }

    struct View<'a> {
        corpus: &'a Corpus,
        snap: &'a Snapshot,
        renders: &'a Renders,
        seen: RefCell<Seen>,
    }

    impl View<'_> {
        fn text(&self, path: &str) -> Option<Rc<str>> {
            let t = self.render(path);
            self.seen.borrow_mut().push((path.to_string(), t.clone()));
            t
        }

        fn render(&self, path: &str) -> Option<Rc<str>> {
            if let Some((was, t)) = self.renders.texts.borrow().get(path)
                && was.len() == self.snap.under(path).count()
                && was.iter().zip(self.snap.under(path)).all(|((k, v), (k2, v2))| k == k2 && v == v2)
            {
                return t.clone();
            }
            let keys: Vec<(String, Value)> = self.snap.under(path).map(|(k, v)| (k.to_string(), v.clone())).collect();
            let t: Option<Rc<str>> = self
                .corpus
                .render(path, |k| match self.snap.get(k)? {
                    Value::Version(n) => Some((*n, None)),
                    Value::Tuned(n, l) => Some((*n, Some(l.to_string()))),
                    _ => None,
                })
                .map(Rc::from);
            self.renders.texts.borrow_mut().insert(path.to_string(), (keys, t.clone()));
            t
        }

        /// Whether every file in `seen` renders as it did.
        fn unchanged(&self, seen: &Seen) -> bool {
            seen.iter().all(|(p, t)| match (self.render(p), t) {
                (Some(a), Some(b)) => Rc::ptr_eq(&a, b),
                (None, None) => true,
                _ => false,
            })
        }

        /// The module's file under `crate_dir/src/`, if it exists.
        fn module(&self, crate_dir: &str, segs: &[&str]) -> Option<String> {
            let base = format!("{crate_dir}/src/{}", segs.join("/"));
            [format!("{base}.rs"), format!("{base}/mod.rs")].into_iter().find(|p| self.text(p).is_some())
        }
    }

    fn crate_of(path: &str) -> Option<(&str, String)> {
        let (dir, _) = path.split_once("/src/")?;
        let root = if dir.ends_with("orbital-game") { "main.rs" } else { "lib.rs" };
        Some((dir, format!("{dir}/src/{root}")))
    }

    fn declares(text: &str, name: &str) -> bool {
        super::defines(text, name) || text.lines().any(|l| l.starts_with("pub use ") && has_word(l, name))
    }

    fn in_manifest(toml: &str, dep: &str) -> bool {
        let dashed = dep.replace('_', "-");
        toml.lines().map(str::trim_start).any(|l| [dep, dashed.as_str()].iter().any(|d| l.starts_with(&format!("{d} ")) || l.starts_with(&format!("{d}.")) || l.starts_with(&format!("{d}="))))
    }

    /// The snapshot's problems. With `touched` (the paths a step changed since the last call),
    /// a file that read none of them keeps its problems without a look.
    pub fn problems(corpus: &Corpus, snap: &Snapshot, renders: &Renders, touched: Option<&BTreeSet<String>>) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for path in snap.paths().into_iter().filter(|p| p.ends_with(".rs")) {
            let v = View { corpus, snap, renders, seen: RefCell::default() };
            if let Some((seen, found)) = renders.found.borrow().get(&path)
                && match touched {
                    Some(t) => !t.contains(&path) && !seen.iter().any(|(p, _)| t.contains(p)),
                    None => v.unchanged(seen),
                }
            {
                out.extend(found.iter().cloned());
                continue;
            }
            let mut mine = BTreeSet::new();
            file_problems(&v, snap, &path, &mut mine);
            renders.found.borrow_mut().insert(path.clone(), (v.seen.take(), mine.iter().cloned().collect()));
            out.extend(mine);
        }
        out
    }

    fn file_problems(v: &View, snap: &Snapshot, path: &str, out: &mut BTreeSet<String>) {
        let path = path.to_string();
        {
            let Some(text) = v.text(&path) else {
                let live = snap.under(&path).any(|(k, _)| !k.ends_with("#header"));
                if live {
                    out.insert(format!("NOHEADER {path}"));
                }
                return;
            };
            let Some((crate_dir, root)) = crate_of(&path) else { return };
            let rel: Vec<&str> = path[crate_dir.len() + 5..].trim_end_matches(".rs").trim_end_matches("/mod").split('/').collect();
            let here: Vec<&str> = if path == root { Vec::new() } else { rel };
            if let [.., name] = here.as_slice() {
                let parent = if here.len() == 1 { Some(root.clone()) } else { v.module(crate_dir, &here[..here.len() - 1]) };
                let declared = parent.and_then(|p| v.text(&p)).is_some_and(|t| parse_header(&t).iter().any(|l| matches!(l, Line::Mod { name: m, .. } if m == name)));
                if !declared {
                    out.insert(format!("ORPHAN {path}: no `mod {name};` declares it"));
                }
            }
            let toml = v.text(&format!("{crate_dir}/Cargo.toml")).unwrap_or_default();
            let is_head = |l: &&str| ["use ", "pub use ", "mod ", "pub mod ", "pub(crate) mod "].iter().any(|p| l.starts_with(p)) && l.ends_with(';');
            let head: Vec<&str> = text.lines().filter(is_head).collect();
            let body = code(&text.lines().filter(|l| !is_head(l)).collect::<Vec<_>>().join("\n"));
            for line in parse_header(&head.join("\n")) {
                match line {
                    Line::Mod { name, .. } => {
                        let segs: Vec<&str> = here.iter().copied().chain([name]).collect();
                        if v.module(crate_dir, &segs).is_none() {
                            out.insert(format!("MOD {path}: `mod {name};` without its file"));
                        }
                    }
                    Line::Use { public, prefix, names, raw } => {
                        let segs: Vec<&str> = prefix.split("::").collect();
                        let (dir, mods): (String, Vec<&str>) = match segs[0] {
                            "crate" => (crate_dir.to_string(), segs[1..].to_vec()),
                            "super" => (crate_dir.to_string(), here[..here.len().saturating_sub(1)].iter().copied().chain(segs[1..].iter().copied()).collect()),
                            "std" | "core" | "alloc" | "self" => continue,
                            first if v.module(crate_dir, &here.iter().copied().chain([first]).collect::<Vec<_>>()).is_some() => {
                                (crate_dir.to_string(), here.iter().copied().chain(segs.iter().copied()).collect())
                            }
                            ext => {
                                if !in_manifest(&toml, ext) {
                                    out.insert(format!("DEP {path}: uses {ext} but {crate_dir}/Cargo.toml lacks it"));
                                }
                                match ext.strip_prefix("orbital_") {
                                    Some(c) => (format!("crates/orbital-{c}"), segs[1..].to_vec()),
                                    None => {
                                        for name in names.iter().filter(|_| !public) {
                                            let bound = name.rsplit(" as ").next().unwrap_or(name);
                                            if *name != "*" && !has_word(&body, bound) {
                                                out.insert(format!("UNUSED {path}: import {bound} unused"));
                                            }
                                        }
                                        continue;
                                    }
                                }
                            }
                        };
                        let target = if mods.is_empty() { crate_of(&format!("{dir}/src/x.rs")).and_then(|(_, r)| v.text(&r)) } else { v.module(&dir, &mods).and_then(|p| v.text(&p)) };
                        let Some(target) = target else {
                            out.insert(format!("USE {path}: `{raw}`: module {dir}::{mods:?} missing"));
                            continue;
                        };
                        for name in names {
                            let (name, bound) = match name.split_once(" as ") {
                                Some((a, b)) => (a, b),
                                None if name == "self" => ("self", *mods.last().unwrap_or(&"")),
                                None => (name, name),
                            };
                            if name == "*" {
                                continue;
                            }
                            let sub: Vec<&str> = mods.iter().copied().chain([name]).collect();
                            if name != "self" && v.module(&dir, &sub).is_none() && !declares(&target, name) {
                                out.insert(format!("USE {path}: `{raw}`: {name} not defined"));
                            }
                            if !public && !has_word(&body, bound) {
                                out.insert(format!("UNUSED {path}: import {bound} unused"));
                            }
                        }
                    }
                    Line::Other(_) => {}
                }
            }
        }
    }
}
