//! Orbital's text corpus, in this format:
//!
//! ```text
//! A corpus file holds one or more repository files:
//!
//!   #file <path in the Orbital repository>
//!
//! then that file's blocks. A block starts with a directive line and runs to the next directive or
//! #file line (trailing blank lines dropped):
//!
//!   #header v<N> @<feature> ["<message>"]                       a Rust file's module doc and `use`s
//!   #const <NAME> v<N> @<feature> ["<message>"] [!removed]      one `pub const NAME: T = <number>;`
//!   #item <name> v<N> @<feature> "<message>" [!removed]         a fn, struct, enum, impl or trait
//!   #test <name> v<N> @<feature> "<message>" [!removed]         a #[test] fn (rendered inside mod tests)
//!   #whole v<N> @<feature> "<message>" [!removed]               a whole non-Rust file (one per file)
//!
//! - Directive lines start with exactly `#file `, `#header `, `#const `, `#item `, `#test ` or
//!   `#whole `; `#[test]`, `#![…]`, Markdown `# Heading` and YAML comments never match. A line
//!   starting with `#;` is a corpus comment.
//! - Versions of a block are numbered from 1 with no gaps and written together, in order.
//! - `@feature` is a slug from features.txt: the branch that brings this version in.
//! - Messages are commit subjects in the house style (sentence case, no trailing period, at most 72
//!   characters, no `feat:` prefixes); `\n` makes a line break (`\n\n` before a body), `\"` a quote.
//!   `#header` and `#const` may omit theirs: they ride in the next messaged step of the same
//!   feature in the same file (or the previous one).
//! - A Rust file renders as: the header; its constants, one after another; each item, separated by
//!   a blank line; then `#[cfg(test)] mod tests { use super::*; … }` holding the tests, indented by
//!   the renderer. Write items unindented, exactly as rustfmt (edition 2024, default settings) would.
//! - A `#const` block is optional doc comment lines plus one `pub const NAME: T = <literal>;` line
//!   whose literal is a plain number (`42`, `12.5`, `1_500`; no exponent, no suffix): tuning commits
//!   change it.
//! - `!removed` takes the block out of the file at that version.
//! - Only made-up names; no URLs except https://gitlab.example.com/… and https://orbital.example.com/…;
//!   emails only @example.com.
//! ```
//!
//! [`parse`] holds corpus files to that strictly (every error names the corpus file and line), and
//! the guards in this module's tests check the whole corpus for the house style, made-up hosts and
//! emails, the roadmap's order, versions that change nothing, and rustfmt.

use crate::media::rng::Rng;
use std::collections::BTreeMap;

pub const FEATURES: &str = include_str!("corpus/features.txt");
pub const MESSAGES: &str = include_str!("corpus/messages.txt");
/// Every corpus file, in the order a feature's steps are taken: core, render, game, shaders,
/// docs, data, and the special branches' own files.
pub const SOURCES: &[(&str, &str)] = &[
    ("core/lib.txt", include_str!("corpus/core/lib.txt")),
    ("core/math.txt", include_str!("corpus/core/math.txt")),
    ("core/body.txt", include_str!("corpus/core/body.txt")),
    ("core/physics.txt", include_str!("corpus/core/physics.txt")),
    ("core/orbit.txt", include_str!("corpus/core/orbit.txt")),
    ("core/time.txt", include_str!("corpus/core/time.txt")),
    ("core/rng.txt", include_str!("corpus/core/rng.txt")),
    ("core/world.txt", include_str!("corpus/core/world.txt")),
    ("core/systems.txt", include_str!("corpus/core/systems.txt")),
    ("core/error.txt", include_str!("corpus/core/error.txt")),
    ("core/cargo.txt", include_str!("corpus/core/cargo.txt")),
    ("core/ship.txt", include_str!("corpus/core/ship.txt")),
    ("core/economy.txt", include_str!("corpus/core/economy.txt")),
    ("core/station.txt", include_str!("corpus/core/station.txt")),
    ("core/contracts.txt", include_str!("corpus/core/contracts.txt")),
    ("core/level.txt", include_str!("corpus/core/level.txt")),
    ("core/save.txt", include_str!("corpus/core/save.txt")),
    ("render/lib.txt", include_str!("corpus/render/lib.txt")),
    ("render/renderer.txt", include_str!("corpus/render/renderer.txt")),
    ("render/painter.txt", include_str!("corpus/render/painter.txt")),
    ("render/camera.txt", include_str!("corpus/render/camera.txt")),
    ("render/atlas.txt", include_str!("corpus/render/atlas.txt")),
    ("render/sprite_batch.txt", include_str!("corpus/render/sprite_batch.txt")),
    ("render/text.txt", include_str!("corpus/render/text.txt")),
    ("render/starfield.txt", include_str!("corpus/render/starfield.txt")),
    ("render/trails.txt", include_str!("corpus/render/trails.txt")),
    ("render/bloom.txt", include_str!("corpus/render/bloom.txt")),
    ("render/debug_draw.txt", include_str!("corpus/render/debug_draw.txt")),
    ("render/panels.txt", include_str!("corpus/render/panels.txt")),
    ("render/shaders.txt", include_str!("corpus/render/shaders.txt")),
    ("game/main.txt", include_str!("corpus/game/main.txt")),
    ("game/app.txt", include_str!("corpus/game/app.txt")),
    ("game/input.txt", include_str!("corpus/game/input.txt")),
    ("game/flight.txt", include_str!("corpus/game/flight.txt")),
    ("game/menu.txt", include_str!("corpus/game/menu.txt")),
    ("game/docked.txt", include_str!("corpus/game/docked.txt")),
    ("game/map_view.txt", include_str!("corpus/game/map_view.txt")),
    ("game/settings.txt", include_str!("corpus/game/settings.txt")),
    ("game/save_slots.txt", include_str!("corpus/game/save_slots.txt")),
    ("game/hud.txt", include_str!("corpus/game/hud.txt")),
    ("game/audio.txt", include_str!("corpus/game/audio.txt")),
    ("game/contracts_ui.txt", include_str!("corpus/game/contracts_ui.txt")),
    ("game/trade_screen.txt", include_str!("corpus/game/trade_screen.txt")),
    ("game/mods.txt", include_str!("corpus/game/mods.txt")),
    ("game/strings.txt", include_str!("corpus/game/strings.txt")),
    ("game/net.txt", include_str!("corpus/game/net.txt")),
    ("game/lobby.txt", include_str!("corpus/game/lobby.txt")),
    ("game/autopilot.txt", include_str!("corpus/game/autopilot.txt")),
    ("game/station_ui.txt", include_str!("corpus/game/station_ui.txt")),
    ("game/trade_routes.txt", include_str!("corpus/game/trade_routes.txt")),
    ("game/wormhole.txt", include_str!("corpus/game/wormhole.txt")),
    ("docs.txt", include_str!("corpus/docs.txt")),
    ("devlog.txt", include_str!("corpus/devlog.txt")),
    ("press.txt", include_str!("corpus/press.txt")),
    ("tooling.txt", include_str!("corpus/tooling.txt")),
    ("data.txt", include_str!("corpus/data.txt")),
    ("game/specials.txt", include_str!("corpus/game/specials.txt")),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Header,
    Const,
    Item,
    Test,
    Whole,
}

impl Kind {
    fn directive(self) -> &'static str {
        match self {
            Kind::Header => "#header",
            Kind::Const => "#const",
            Kind::Item => "#item",
            Kind::Test => "#test",
            Kind::Whole => "#whole",
        }
    }

    fn usage(self) -> &'static str {
        match self {
            Kind::Header => "#header v<N> @<feature> [\"<message>\"]",
            Kind::Const => "#const <NAME> v<N> @<feature> [\"<message>\"] [!removed]",
            Kind::Item => "#item <name> v<N> @<feature> \"<message>\" [!removed]",
            Kind::Test => "#test <name> v<N> @<feature> \"<message>\" [!removed]",
            Kind::Whole => "#whole v<N> @<feature> \"<message>\" [!removed]",
        }
    }

    fn named(self) -> bool {
        matches!(self, Kind::Const | Kind::Item | Kind::Test)
    }

    /// Items, tests and whole files are steps of their own; headers and constants ride along.
    fn messaged(self) -> bool {
        matches!(self, Kind::Item | Kind::Test | Kind::Whole)
    }
}

const KINDS: [Kind; 5] = [Kind::Header, Kind::Const, Kind::Item, Kind::Test, Kind::Whole];

#[derive(Clone, Debug)]
pub struct Version {
    pub n: u16,
    pub feature: String,
    pub message: Option<String>,
    pub removed: bool,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Block {
    pub kind: Kind,
    pub name: String,
    pub versions: Vec<Version>,
}

impl Block {
    pub fn key(&self, path: &str) -> String {
        match self.kind {
            Kind::Whole => path.to_string(),
            Kind::Header => format!("{path}#header"),
            Kind::Const => format!("{path}#const:{}", self.name),
            Kind::Item => format!("{path}#item:{}", self.name),
            Kind::Test => format!("{path}#test:{}", self.name),
        }
    }

    /// `#item greet`, `#header`: how errors name the block.
    fn label(&self) -> String {
        label(self.kind, &self.name)
    }
}

fn label(kind: Kind, name: &str) -> String {
    if name.is_empty() { kind.directive().to_string() } else { format!("{} {name}", kind.directive()) }
}

#[derive(Clone, Debug)]
pub struct File {
    pub path: String,
    pub source: &'static str,
    pub blocks: Vec<Block>,
}

impl File {
    pub fn is_whole(&self) -> bool {
        self.blocks.first().is_some_and(|b| b.kind == Kind::Whole)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tagged {
    pub file: usize,
    pub block: usize,
    pub version: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Corpus {
    pub files: Vec<File>,
}

struct Directive {
    name: String,
    version: u16,
    feature: String,
    message: Option<String>,
    removed: bool,
}

/// Splits a directive's arguments into words and `"quoted"` messages (the flag says which).
fn tokens(rest: &str) -> Result<Vec<(String, bool)>, String> {
    let mut tokens = Vec::new();
    let mut chars = rest.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == ' ' {
            chars.next();
        } else if c == '"' {
            chars.next();
            let mut s = String::new();
            loop {
                match chars.next() {
                    Some('\\') => match chars.next() {
                        Some('n') => s.push('\n'),
                        Some('"') => s.push('"'),
                        Some('\\') => s.push('\\'),
                        other => {
                            let other = other.map(String::from).unwrap_or_default();
                            return Err(format!("bad escape \\{other} in the message (use \\n, \\\" or \\\\)"));
                        }
                    },
                    Some('"') => break,
                    Some(ch) => s.push(ch),
                    None => return Err("the message has no closing quote".into()),
                }
            }
            tokens.push((s, true));
        } else {
            let mut s = String::new();
            while let Some(&ch) = chars.peek().filter(|&&ch| ch != ' ') {
                s.push(ch);
                chars.next();
            }
            tokens.push((s, false));
        }
    }
    Ok(tokens)
}

fn is_ident(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_slug(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn parse_directive(kind: Kind, rest: &str) -> Result<Directive, String> {
    let mut it = tokens(rest)?.into_iter();
    let mut word = |what: &str| match it.next() {
        Some((t, false)) => Ok(t),
        Some((t, true)) => Err(format!("expected {what}, found the message {t:?}")),
        None => Err(format!("missing {what}")),
    };
    let name = if kind.named() { word("the block's name")? } else { String::new() };
    if kind == Kind::Const
        && !(name.starts_with(|c: char| c.is_ascii_uppercase()) && name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))
    {
        return Err(format!("`{name}` isn't an UPPER_CASE constant name"));
    }
    if matches!(kind, Kind::Item | Kind::Test) && !is_ident(&name) {
        return Err(format!("`{name}` isn't a Rust identifier"));
    }
    let v = word("v<N>")?;
    let version: u16 = v.strip_prefix('v').and_then(|n| n.parse().ok()).ok_or_else(|| format!("expected v<N>, found `{v}`"))?;
    if version == 0 {
        return Err("versions are numbered from v1".into());
    }
    let f = word("@<feature>")?;
    let feature = f.strip_prefix('@').ok_or_else(|| format!("expected @<feature>, found `{f}`"))?;
    if !is_slug(feature) {
        return Err(format!("`@{feature}` isn't a feature slug (lowercase letters, digits and dashes)"));
    }
    let (mut message, mut removed) = (None, false);
    for (t, quoted) in it {
        match (quoted, t.as_str()) {
            (true, _) if message.is_none() => message = Some(t),
            (false, "!removed") if !removed => removed = true,
            _ => return Err(format!("unexpected {t:?}")),
        }
    }
    if message.is_none() && kind.messaged() {
        return Err("items, tests and whole files need a message".into());
    }
    if let Some(m) = &message {
        if m.trim().is_empty() {
            return Err("an empty message".into());
        }
        if m.split_once('\n').is_some_and(|(_, body)| !body.starts_with('\n')) {
            return Err("a message's body follows a blank line: write \\n\\n after the subject".into());
        }
    }
    if removed && kind == Kind::Header {
        return Err("a #header can't be !removed: a Rust file renders from its header".into());
    }
    Ok(Directive { name, version, feature: feature.to_string(), message, removed })
}

/// The directive a line starts, if any: `#item` alone counts (and fails with its usage).
fn directive(line: &str) -> Option<(Kind, &str)> {
    KINDS.into_iter().find_map(|kind| {
        let rest = line.strip_prefix(kind.directive())?;
        (rest.is_empty() || rest.starts_with(' ')).then_some((kind, rest))
    })
}

/// A misspelt directive (`#iten a v1 @x`) would otherwise become text of the block above it.
fn unknown_directive(line: &str) -> Option<&str> {
    let words: Vec<&str> = line.split(' ').collect();
    let kw = words[0].strip_prefix('#')?;
    let looks = !kw.is_empty() && kw.bytes().all(|b| b.is_ascii_lowercase());
    let versioned =
        words.windows(2).any(|w| w[0].strip_prefix('v').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) && w[1].starts_with('@'));
    (looks && versioned).then_some(words[0])
}

/// A plain Rust number: `42`, `-0.25`, `1_500`, `12.5`; no exponent, no suffix.
fn plain_number(lit: &str) -> bool {
    let s = lit.strip_prefix('-').unwrap_or(lit);
    let digits_ok = |part: &str| {
        part.starts_with(|c: char| c.is_ascii_digit())
            && part.ends_with(|c: char| c.is_ascii_digit())
            && part.bytes().all(|b| b.is_ascii_digit() || b == b'_')
            && !part.contains("__")
    };
    match s.split_once('.') {
        Some((int, frac)) => digits_ok(int) && digits_ok(frac),
        None => digits_ok(s),
    }
}

/// What a finished version's text must be, by kind. Errors point at its directive.
fn check_text(block: &Block, v: &Version) -> Result<(), String> {
    let what = format!("{} v{}", block.label(), v.n);
    if v.removed {
        return Ok(());
    }
    if v.text.is_empty() && block.kind != Kind::Whole {
        return Err(format!("{what} has no text (only a !removed version or a #whole file is empty)"));
    }
    match block.kind {
        Kind::Const => {
            let name = &block.name;
            let shape = || {
                format!(
                    "a #const {name} block is `///` doc comment lines and then one `pub const {name}: T = <number>;` line \
                     (arrays, expressions and typed constants like `Color` go in an #item)"
                )
            };
            let lines: Vec<&str> = v.text.lines().collect();
            let (last, docs) = lines.split_last().expect("not empty");
            if !docs.iter().all(|l| l.starts_with("///")) || !last.starts_with(&format!("pub const {name}: ")) || !last.ends_with(';') {
                return Err(shape());
            }
            let lit = literal_of(last).ok_or_else(shape)?;
            if !plain_number(lit) {
                return Err(format!(
                    "{name}'s `{lit}` isn't a plain number (like 42, 12.5 or 1_500; no exponent, no suffix): \
                     arrays, expressions and typed constants like `Color` go in an #item"
                ));
            }
        }
        Kind::Test => {
            let name = &block.name;
            if !v.text.lines().any(|l| l == "#[test]") || !v.text.contains(&format!("fn {name}(")) {
                return Err(format!("a #test {name} block is a `#[test]` fn: it needs a `#[test]` line and `fn {name}(`"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// Where the parser is: the open version (file, block, its directive's line) and each file's
/// `#file` line.
struct Parser {
    name: &'static str,
    files: Vec<File>,
    file_lines: Vec<usize>,
    open: Option<(usize, usize, usize)>,
}

type Located = (usize, String);

impl Parser {
    /// Finishes the open version: drops trailing blank lines and checks the text.
    fn close_version(&mut self) -> Result<(), Located> {
        let Some((f, b, line)) = self.open.take() else {
            return Ok(());
        };
        let block = &mut self.files[f].blocks[b];
        let v = block.versions.last_mut().expect("an open version");
        if !v.removed && v.text.starts_with('\n') && !v.text.trim().is_empty() {
            return Err((line, format!("{} v{}'s text starts with a blank line", label(block.kind, &block.name), v.n)));
        }
        let t = v.text.trim_end();
        v.text = if t.is_empty() { String::new() } else { format!("{t}\n") };
        let block = &self.files[f].blocks[b];
        check_text(block, block.versions.last().expect("an open version")).map_err(|e| (line, e))
    }

    fn close_file(&mut self) -> Result<(), Located> {
        self.close_version()?;
        let (Some(f), Some(&line)) = (self.files.last(), self.file_lines.last()) else {
            return Ok(());
        };
        if f.blocks.is_empty() {
            return Err((line, format!("#file {} has no blocks", f.path)));
        }
        if !f.is_whole() && !f.blocks.iter().any(|b| b.kind == Kind::Header) {
            return Err((line, format!("{} has no #header (a Rust file renders from its header)", f.path)));
        }
        Ok(())
    }

    fn line(&mut self, n: usize, line: &str) -> Result<(), Located> {
        let at = |e: String| (n, e);
        if line.starts_with("#;") {
            return Ok(());
        }
        if let Some(rest) = line.strip_prefix("#file").filter(|r| r.is_empty() || r.starts_with(' ')) {
            self.close_file()?;
            let path = rest.trim();
            if path.is_empty()
                || path.starts_with('/')
                || path.contains(char::is_whitespace)
                || path.contains('\\')
                || path.split('/').any(|p| p.is_empty() || p == "." || p == "..")
            {
                return Err(at(format!("#file needs a relative path inside the repository, found {path:?}")));
            }
            if self.files.iter().any(|f| f.path == path) {
                return Err(at(format!("#file {path} twice in {}", self.name)));
            }
            self.files.push(File { path: path.to_string(), source: self.name, blocks: Vec::new() });
            self.file_lines.push(n);
            return Ok(());
        }
        if let Some((kind, rest)) = directive(line) {
            self.close_version()?;
            let d = parse_directive(kind, rest).map_err(|e| {
                let kw = kind.directive();
                at(format!(
                    "{kw}: {e} (usage: {}). A content line can't start with `{kw} ` either: \
                     for a CSS `{kw} {{` selector, use a class or `{}{kw}`",
                    kind.usage(),
                    &kw[1..]
                ))
            })?;
            let fi = self.files.len().checked_sub(1).ok_or_else(|| at("a block before any #file".into()))?;
            let file = &mut self.files[fi];
            if !file.blocks.is_empty() && (kind == Kind::Whole) != file.is_whole() {
                return Err(at("a whole file has one #whole block and nothing else".into()));
            }
            if kind != Kind::Whole && !file.path.ends_with(".rs") {
                return Err(at(format!("#header, #const, #item and #test blocks go only in a .rs file; {} takes one #whole block", file.path)));
            }
            let what = label(kind, &d.name);
            let bi = match file.blocks.iter().position(|b| b.kind == kind && b.name == d.name) {
                Some(b) if b + 1 != file.blocks.len() => {
                    let had = file.blocks[b].versions.len();
                    return Err(at(format!("{what} v{}: versions of a block are written together, right after its v{had}", d.version)));
                }
                Some(b) => b,
                None => {
                    file.blocks.push(Block { kind, name: d.name.clone(), versions: Vec::new() });
                    file.blocks.len() - 1
                }
            };
            let block = &mut file.blocks[bi];
            let had = block.versions.len();
            if d.version as usize != had + 1 {
                return Err(at(format!("{what} v{} follows v{had}: versions are numbered from 1 with no gaps", d.version)));
            }
            if d.removed && d.version == 1 {
                return Err(at(format!("{what} v1 can't be !removed: a block starts with its text")));
            }
            block.versions.push(Version { n: d.version, feature: d.feature, message: d.message, removed: d.removed, text: String::new() });
            self.open = Some((fi, bi, n));
            return Ok(());
        }
        if let Some(kw) = unknown_directive(line) {
            return Err(at(format!("unknown directive {kw} (directives are #file, #header, #const, #item, #test and #whole)")));
        }
        match self.open {
            Some((f, b, _)) => {
                let v = self.files[f].blocks[b].versions.last_mut().expect("an open version");
                if v.removed && !line.trim().is_empty() {
                    return Err(at("a !removed version has no text".into()));
                }
                v.text.push_str(line);
                v.text.push('\n');
            }
            None if line.trim().is_empty() => {}
            None => {
                return Err(at("text outside a block (a block starts with a directive line)".into()));
            }
        }
        Ok(())
    }
}

/// One corpus file's repository files. Errors read `<name>:<line>: <what's wrong>`.
pub fn parse(name: &'static str, text: &str) -> Result<Vec<File>, String> {
    let mut p = Parser { name, files: Vec::new(), file_lines: Vec::new(), open: None };
    let located = |(line, e): Located| format!("{name}:{line}: {e}");
    for (i, line) in text.lines().enumerate() {
        p.line(i + 1, line).map_err(located)?;
    }
    p.close_file().map_err(located)?;
    Ok(p.files)
}

impl Corpus {
    pub fn load() -> Corpus {
        Corpus::from_sources(SOURCES).unwrap_or_else(|e| panic!("{e}"))
    }

    pub fn from_sources(sources: &[(&'static str, &str)]) -> Result<Corpus, String> {
        let mut files: Vec<File> = Vec::new();
        for (name, text) in sources {
            for f in parse(name, text)? {
                if let Some(other) = files.iter().find(|g| g.path == f.path) {
                    let line = text.lines().position(|l| l.strip_prefix("#file ").map(str::trim) == Some(f.path.as_str())).map_or(0, |i| i + 1);
                    return Err(format!("{name}:{line}: {} is already in {}", f.path, other.source));
                }
                files.push(f);
            }
        }
        Ok(Corpus { files })
    }

    pub fn file(&self, path: &str) -> Option<&File> {
        self.files.iter().find(|f| f.path == path)
    }

    /// Every version tagged `@feature`, in corpus order (file, block, version).
    pub fn tagged(&self, feature: &str) -> Vec<Tagged> {
        let mut out = Vec::new();
        for (fi, f) in self.files.iter().enumerate() {
            for (bi, b) in f.blocks.iter().enumerate() {
                for (vi, v) in b.versions.iter().enumerate() {
                    if v.feature == feature {
                        out.push(Tagged { file: fi, block: bi, version: vi });
                    }
                }
            }
        }
        out
    }

    /// The file at `path` given each block key's (version, retuned literal or partial header), or
    /// None while it has no header / is removed.
    pub fn render(&self, path: &str, lookup: impl Fn(&str) -> Option<(u16, Option<String>)>) -> Option<String> {
        let file = self.file(path)?;
        let version = |b: &Block| -> Option<String> {
            let key = b.key(path);
            let (n, tuned) = lookup(&key)?;
            let v = b.versions.get((n as usize).wrapping_sub(1)).unwrap_or_else(|| panic!("{key} has no v{n}"));
            if v.removed {
                return None;
            }
            Some(match tuned {
                // On a header, the text is that version cut down to the lines its file uses so far.
                Some(text) if b.kind == Kind::Header => text,
                Some(lit) => retune(&v.text, &lit).unwrap_or_else(|| panic!("{key} v{n}: no constant to tune")),
                None => v.text.clone(),
            })
        };
        if file.is_whole() {
            return version(&file.blocks[0]);
        }
        let (mut header, mut consts, mut items, mut tests) = (None, Vec::new(), Vec::new(), Vec::new());
        for b in &file.blocks {
            let Some(text) = version(b) else { continue };
            match b.kind {
                Kind::Header => header = Some(text),
                Kind::Const => consts.push(text),
                Kind::Item => items.push(text),
                Kind::Test => tests.push(text),
                Kind::Whole => unreachable!("a Rust file has no #whole block"),
            }
        }
        let mut out = header?.trim_end().to_string();
        out.push('\n');
        if !consts.is_empty() {
            out.push('\n');
            for c in &consts {
                out.push_str(c.trim_end());
                out.push('\n');
            }
        }
        for i in &items {
            out.push('\n');
            out.push_str(i.trim_end());
            out.push('\n');
        }
        if !tests.is_empty() {
            out.push_str("\n#[cfg(test)]\nmod tests {\n    use super::*;\n");
            for t in &tests {
                out.push('\n');
                for line in t.trim_end().lines() {
                    if !line.is_empty() {
                        out.push_str("    ");
                        out.push_str(line);
                    }
                    out.push('\n');
                }
            }
            out.push_str("}\n");
        }
        Some(out)
    }
}

fn const_line(text: &str) -> Option<&str> {
    text.lines().find(|l| !l.trim_start().starts_with("//") && l.contains("const ") && l.contains(" = ") && l.trim_end().ends_with(';'))
}

/// A `#const` block's literal: `40` in `pub const MAX: u32 = 40;`.
pub fn literal_of(text: &str) -> Option<&str> {
    let (_, rhs) = const_line(text)?.rsplit_once(" = ")?;
    Some(rhs.trim_end().trim_end_matches(';'))
}

/// The `#const` block's text with its literal replaced.
pub fn retune(text: &str, literal: &str) -> Option<String> {
    let line = const_line(text)?;
    let cut = line.rfind(" = ")? + 3;
    let tuned = format!("{}{literal};", &line[..cut]);
    Some(text.lines().map(|l| if l == line { tuned.as_str() } else { l }).map(|l| format!("{l}\n")).collect())
}

/// `12000` → `12_000`, keeping a sign.
fn grouped(int: &str) -> String {
    let (sign, digits) = int.strip_prefix('-').map_or(("", int), |d| ("-", d));
    let mut out = String::from(sign);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push('_');
        }
        out.push(ch);
    }
    out
}

/// The literal scaled by `factor`, in the same shape (decimals, underscores). A change too small
/// to show moves it one step instead (away from zero for a factor above 1, towards it below), so
/// a tuning commit always changes something, and never past zero.
pub fn tune(literal: &str, factor: f64) -> String {
    assert!(factor.is_finite() && factor > 0.0, "tune({literal}, {factor})");
    let plain = literal.replace('_', "");
    let towards_up = |v: f64| v == 0.0 || (factor >= 1.0) == (v > 0.0);
    let out = if let Some((_, frac)) = plain.split_once('.') {
        let decimals = frac.len().max(1);
        let v: f64 = plain.parse().unwrap_or_else(|_| panic!("`{literal}` isn't a number"));
        let show = |x: f64| {
            let s = format!("{x:.decimals$}");
            if s.bytes().all(|b| matches!(b, b'-' | b'0' | b'.')) { s.trim_start_matches('-').to_string() } else { s }
        };
        let n = show(v * factor);
        if n != show(v) {
            n
        } else {
            let step = 10f64.powi(-(decimals as i32));
            show(if towards_up(v) { v + step } else { v - step })
        }
    } else {
        let v: i64 = plain.parse().unwrap_or_else(|_| panic!("`{literal}` isn't a number"));
        let n = (v as f64 * factor).round() as i64;
        let n = if n != v {
            n
        } else if towards_up(v as f64) {
            v + 1
        } else {
            v - 1
        };
        n.to_string()
    };
    if !literal.contains('_') {
        return out;
    }
    match out.split_once('.') {
        Some((int, frac)) => format!("{}.{frac}", grouped(int)),
        None => grouped(&out),
    }
}

/// The first column of each feature line (not comments, not indented detail lines).
pub fn feature_slugs(features: &str) -> Vec<String> {
    features.lines().filter(|l| !l.is_empty() && !l.starts_with(['#', ' ', '\t'])).filter_map(|l| l.split('|').next().map(|s| s.trim().to_string())).collect()
}

/// The placeholders a message template may use.
const PLACEHOLDERS: [&str; 7] = ["what", "old", "new", "row", "column", "dep", "version"];

/// The filler message pools of messages.txt: `[pool]`, then one template per line.
#[derive(Clone, Debug, Default)]
pub struct Messages {
    pools: BTreeMap<String, Vec<String>>,
}

impl Messages {
    pub fn parse(text: &str) -> Result<Messages, String> {
        let mut pools: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut current: Option<String> = None;
        for (i, line) in text.lines().enumerate() {
            let at = |e: String| format!("messages.txt:{}: {e}", i + 1);
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                if !is_slug(name) {
                    return Err(at(format!("[{name}] isn't a pool name (lowercase letters, digits and dashes)")));
                }
                if pools.insert(name.to_string(), Vec::new()).is_some() {
                    return Err(at(format!("the pool [{name}] twice")));
                }
                current = Some(name.to_string());
                continue;
            }
            let pool = current.as_ref().ok_or_else(|| at("a line before any [pool]".into()))?;
            for (start, _) in line.match_indices('{') {
                let name = line[start + 1..].split('}').next().unwrap_or("");
                if !PLACEHOLDERS.contains(&name) {
                    return Err(at(format!("unknown placeholder {{{name}}} (use {})", PLACEHOLDERS.map(|p| format!("{{{p}}}")).join(" "))));
                }
            }
            pools.get_mut(pool).expect("the open pool").push(line.to_string());
        }
        Ok(Messages { pools })
    }

    pub fn load() -> Messages {
        Messages::parse(MESSAGES).unwrap_or_else(|e| panic!("{e}"))
    }

    pub fn pool(&self, name: &str) -> &[String] {
        let pool = self.pools.get(name).unwrap_or_else(|| panic!("no [{name}] pool in messages.txt"));
        assert!(!pool.is_empty(), "the [{name}] pool is empty");
        pool
    }

    pub fn pick(&self, name: &str, rng: &mut Rng) -> String {
        rng.pick(self.pool(name)).clone()
    }
}

/// The template with each `{name}` replaced by its value.
pub fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    vars.iter().fold(template.to_string(), |s, (k, v)| s.replace(&format!("{{{k}}}"), v))
}

const CONVENTIONAL: [&str; 10] = ["feat", "fix", "chore", "docs", "refactor", "test", "style", "perf", "build", "ci"];

/// The house style for a commit subject: a capital first letter (after any `fixup! ` or
/// `squash! `), at most 72 characters, no trailing period, no `feat:`-style prefix.
pub fn subject_ok(subject: &str) -> Result<(), String> {
    let rest = subject.strip_prefix("fixup! ").or_else(|| subject.strip_prefix("squash! ")).unwrap_or(subject);
    if subject.trim() != subject {
        return Err(format!("{subject:?}: has leading or trailing spaces"));
    }
    if !rest.starts_with(|c: char| c.is_ascii_uppercase()) {
        return Err(format!("{subject:?}: must start with a capital letter"));
    }
    let len = subject.chars().count();
    if len > 72 {
        return Err(format!("{subject:?}: is {len} characters; the limit is 72"));
    }
    if subject.ends_with('.') {
        return Err(format!("{subject:?}: ends with a period"));
    }
    let first = rest.split([':', '(', ' ']).next().unwrap_or("").to_ascii_lowercase();
    if CONVENTIONAL.contains(&first.as_str()) && rest[first.len()..].starts_with([':', '(']) {
        return Err(format!("{subject:?}: has a conventional-commit prefix; write a plain sentence"));
    }
    Ok(())
}

const DENIED: [&str; 12] =
    ["github.com", "gitlab.com", "crates.io", "docs.rs", "rust-lang.org", "glpat-", "ghp_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "PRIVATE KEY"];

/// XML namespaces are names, not links.
const NAMESPACES: [&str; 2] = ["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"];

/// Top-level domains a bare host name in prose (`itch.io`, `orbital.dev`) ends in. Ones that are
/// also file extensions (`.sh`, `.rs`, `.app`) are left out.
const TLDS: [&str; 17] = ["com", "org", "net", "io", "dev", "gg", "edu", "gov", "co", "uk", "de", "fr", "eu", "us", "tv", "me", "xyz"];

fn made_up_host(host: &str) -> bool {
    host == "example.com" || host.ends_with(".example.com") || host == "cdn.example.net" || host == "localhost" || host == "127.0.0.1"
}

fn host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-'
}

/// Nothing real: no links to real hosts, emails only @example.com, no tokens. Checks any text;
/// [`check_fictional_file`] also looks for bare host names in a file's prose.
pub fn check_fictional(text: &str) -> Result<(), String> {
    let text = NAMESPACES.iter().fold(text.to_string(), |t, ns| t.replace(ns, ""));
    if let Some(d) = DENIED.iter().find(|d| text.contains(*d)) {
        return Err(format!("mentions {d}"));
    }
    for (at, _) in text.match_indices("://") {
        let host: String = text[at + 3..].chars().take_while(|&c| host_char(c)).collect();
        let host = host.trim_end_matches('.');
        if !made_up_host(host) {
            return Err(format!("a link to {host} (links go to gitlab.example.com or orbital.example.com)"));
        }
    }
    let bytes = text.as_bytes();
    for (at, _) in text.match_indices('@') {
        let before = at.checked_sub(1).map(|i| bytes[i]);
        let after: String = text[at + 1..].chars().take_while(|&c| host_char(c)).collect();
        let after = after.trim_end_matches('.');
        let is_email = before.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') && after.contains('.');
        if is_email && after != "example.com" && !after.ends_with(".example.com") {
            return Err(format!("an email at {after} (emails are @example.com)"));
        }
    }
    Ok(())
}

/// [`check_fictional`], plus no bare real host names (`itch.io`) in the file's prose: all of a
/// Markdown or text file (or one without an extension, like `LICENSE` or `COMMIT_EDITMSG`), and
/// the comment lines of code. Code itself is left alone: `body.com`, `[profile.dev]`.
pub fn check_fictional_file(path: &str, text: &str) -> Result<(), String> {
    check_fictional(text)?;
    let name = path.rsplit('/').next().unwrap_or(path);
    let comment = match name.rsplit_once('.').map_or("", |(_, ext)| ext) {
        "" | "md" | "txt" => None,
        "rs" | "wgsl" | "js" | "ts" => Some("//"),
        "toml" | "yml" | "yaml" | "sh" | "gitignore" => Some("#"),
        _ => return Ok(()),
    };
    for line in text.lines() {
        if comment.is_none_or(|c| line.trim_start().starts_with(c)) {
            bare_hosts(line)?;
        }
    }
    Ok(())
}

/// Bare host names: runs of word characters and dots, ending in a top-level domain.
fn bare_hosts(text: &str) -> Result<(), String> {
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.';
    let mut i = 0;
    while i < bytes.len() {
        if !word(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && word(bytes[i]) {
            i += 1;
        }
        let run = text[start..i].trim_end_matches('.');
        let after_link = start > 0 && matches!(bytes[start - 1], b'/' | b'@');
        let method = bytes.get(start + run.len()) == Some(&b'(');
        let labels: Vec<&str> = run.split('.').collect();
        let named = labels.len() >= 2 && labels.iter().all(|l| !l.is_empty()) && TLDS.contains(labels.last().expect("two labels"));
        if named && !after_link && !method && !made_up_host(run) {
            return Err(format!("names the host {run} (made-up hosts end in example.com)"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"#; a corpus comment
#file crates/demo/src/lib.rs
#header v1 @start
//! A demo.

use std::fmt;
#const SPEED v1 @start
/// How fast.
pub const SPEED: f32 = 12.5;
#item greet v1 @start "Add the greeting"
pub fn greet() -> &'static str {
    "hello"
}
#item greet v2 @polish "Greet more warmly\n\nPeople asked for \"there\"."
pub fn greet() -> &'static str {
    "hello there"
}

#test greet_says_hello v1 @start "Test the greeting"
#[test]
fn greet_says_hello() {
    assert!(greet().starts_with("hello"));
}
#item old v1 @start "Add a helper"
pub fn old() {}
#item old v2 @polish "Remove the helper" !removed
#file README.md
#whole v1 @start "Write the readme"
# Demo

A demo.
"#;

    fn first(c: &Corpus, path: &str) -> String {
        let f = c.file(path).unwrap();
        c.render(path, |k| f.blocks.iter().find(|b| b.key(path) == k).map(|_| (1, None))).unwrap()
    }

    #[test]
    fn parses_blocks_versions_and_messages() {
        let c = Corpus::from_sources(&[("sample.txt", SAMPLE)]).unwrap();
        assert_eq!(c.files.len(), 2);
        let lib = &c.files[0];
        let kinds: Vec<(Kind, &str, usize)> = lib.blocks.iter().map(|b| (b.kind, b.name.as_str(), b.versions.len())).collect();
        assert_eq!(
            kinds,
            [(Kind::Header, "", 1), (Kind::Const, "SPEED", 1), (Kind::Item, "greet", 2), (Kind::Test, "greet_says_hello", 1), (Kind::Item, "old", 2)]
        );
        assert_eq!(lib.blocks[2].versions[1].message.as_deref(), Some("Greet more warmly\n\nPeople asked for \"there\"."));
        assert!(lib.blocks[4].versions[1].removed);
        assert_eq!(lib.blocks[2].versions[0].text, "pub fn greet() -> &'static str {\n    \"hello\"\n}\n", "trailing blank lines dropped");
        assert!(c.files[1].is_whole());
        assert_eq!(c.tagged("polish").len(), 2);
        assert_eq!(c.tagged("polish")[0], Tagged { file: 0, block: 2, version: 1 });
    }

    #[test]
    fn renders_a_rust_file_in_rustfmt_shape() {
        let c = Corpus::from_sources(&[("sample.txt", SAMPLE)]).unwrap();
        assert_eq!(
            first(&c, "crates/demo/src/lib.rs"),
            "//! A demo.\n\nuse std::fmt;\n\n/// How fast.\npub const SPEED: f32 = 12.5;\n\npub fn greet() -> &'static str {\n    \"hello\"\n}\n\npub fn old() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn greet_says_hello() {\n        assert!(greet().starts_with(\"hello\"));\n    }\n}\n"
        );
        assert_eq!(first(&c, "README.md"), "# Demo\n\nA demo.\n");
    }

    #[test]
    fn renders_later_versions_tunes_and_removals() {
        let c = Corpus::from_sources(&[("sample.txt", SAMPLE)]).unwrap();
        let path = "crates/demo/src/lib.rs";
        let text = c
            .render(path, |k| match k.split_once('#').map(|x| x.1) {
                Some("const:SPEED") => Some((1, Some("14.0".into()))),
                Some("item:greet") | Some("item:old") => Some((2, None)),
                Some(_) => Some((1, None)),
                None => None,
            })
            .unwrap();
        assert!(text.contains("pub const SPEED: f32 = 14.0;") && text.contains("hello there") && !text.contains("fn old"));
        assert_eq!(c.render(path, |k| (!k.ends_with("#header")).then_some((1, None))), None, "no header, no file");
    }

    #[test]
    fn a_removed_const_and_an_empty_whole_file() {
        let text = "#file src/lib.rs\n#header v1 @x\n//! Lib.\n#const OLD v1 @x\npub const OLD: u32 = 4;\n#const OLD v2 @y !removed\n#const NEW v1 @y\npub const NEW: u32 = 5;\n#file rustfmt.toml\n#whole v1 @x \"Add an empty rustfmt config\"\n";
        let c = Corpus::from_sources(&[("t.txt", text)]).unwrap();
        let at = |n: u16| move |k: &str| Some((if k.ends_with(":OLD") { n } else { 1 }, None));
        assert!(c.render("src/lib.rs", at(1)).unwrap().contains("pub const OLD: u32 = 4;"));
        assert_eq!(c.render("src/lib.rs", at(2)).unwrap(), "//! Lib.\n\npub const NEW: u32 = 5;\n");
        assert_eq!(c.render("rustfmt.toml", |_| Some((1, None))).unwrap(), "");
    }

    #[test]
    fn rejects_malformed_corpora() {
        for (bad, why) in [
            ("#item a v1 @x \"m\"\nfn a() {}\n", "before any #file"),
            ("#file a.rs\n#item a v2 @x \"m\"\n", "v2 follows v0"),
            ("#file a.rs\n#item a v1 @x\n", "need a message"),
            ("#file a.rs\nloose text\n", "outside a block"),
            ("#file a.rs\n#item a v1 @x \"bad \\q\"\n", "escape"),
            ("#file a.md\n#whole v1 @x \"m\"\nx\n#item b v1 @x \"m\"\n", "whole file"),
        ] {
            let err = parse("bad.txt", bad).unwrap_err();
            assert!(err.contains(why) && err.starts_with("bad.txt:"), "{bad:?}: {err}");
        }
    }

    /// The rules a corpus writer is most likely to trip over, each with an error that says which.
    #[test]
    fn rejects_what_the_format_forbids() {
        const H: &str = "#file a.rs\n#header v1 @x\n//! A.\n";
        for (bad, line, why) in [
            (format!("{H}#iten a v1 @x \"Add a\"\nfn a() {{}}\n"), 4, "unknown directive #iten"),
            (format!("{H}#item\n"), 4, "#item <name> v<N>"),
            (format!("{H}#header v2 @y\n//! B.\n#header v3 @z \"M\" !removed\n"), 6, "a #header can't be !removed"),
            (format!("{H}#item a v1 @x \"Add a\" !removed\n"), 4, "v1 can't be !removed"),
            (format!("{H}#item a v1 @x \"Add a\"\nfn a() {{}}\n#item a v2 @x \"Drop a\" !removed\nfn a() {{}}\n"), 7, "!removed version has no text"),
            (format!("{H}#item a v1 @x \"Add a\"\n"), 4, "has no text"),
            (format!("{H}#item a v1 @x \"Add a\"\n\nfn a() {{}}\n"), 4, "starts with a blank line"),
            (
                format!("{H}#item a v1 @x \"Add a\"\nfn a() {{}}\n#item b v1 @x \"Add b\"\nfn b() {{}}\n#item a v2 @x \"Grow a\"\nfn a() {{}}\n"),
                8,
                "written together",
            ),
            (format!("{H}#item a v1 @X \"Add a\"\nfn a() {{}}\n"), 4, "feature slug"),
            (format!("{H}#item a-b v1 @x \"Add a\"\nfn a() {{}}\n"), 4, "a Rust identifier"),
            (format!("{H}#item a v1 @x \"Add a\\nmore\"\nfn a() {{}}\n"), 4, "blank line"),
            (format!("{H}#item a v1 @x \"\"\nfn a() {{}}\n"), 4, "empty message"),
            (format!("{H}#const SPEED v1 @x\npub const PACE: f32 = 1.0;\n"), 4, "pub const SPEED:"),
            (format!("{H}#const SPEED v1 @x\npub const SPEED: f32 = 1e3;\n"), 4, "plain number"),
            (format!("{H}#const SPEED v1 @x\npub const SPEED: f32 = 1.0f32;\n"), 4, "plain number"),
            (format!("{H}#const SPEED v1 @x\n// Fast.\npub const SPEED: f32 = 1.0;\n"), 4, "doc comment lines"),
            (format!("{H}#test t v1 @x \"Test it\"\nfn t() {{}}\n"), 4, "#[test]"),
            (format!("{H}#test t v1 @x \"Test it\"\n#[test]\nfn u() {{}}\n"), 4, "fn t("),
            ("#file a.rs\n#item a v1 @x \"Add a\"\nfn a() {}\n".into(), 1, "has no #header"),
            ("#file a.md\n#header v1 @x\n# A\n".into(), 2, "only in a .rs file"),
            ("#file a.md\n\n#file b.md\n#whole v1 @x \"Add b\"\nb\n".into(), 1, "has no blocks"),
            ("#file a.md\n#whole v1 @x \"Add a\"\na\n#file a.md\n".into(), 4, "a.md twice"),
            ("#file /a.md\n".into(), 1, "a relative path"),
            (format!("{H}#const FRAME v1 @x\npub const FRAME: Color = Color::rgb(1, 2, 3);\n"), 4, "typed constants like `Color` go in an #item"),
            (format!("{H}#const SHIPS v1 @x\npub const SHIPS: [&str; 2] = [\"scout\", \"hauler\"];\n"), 4, "arrays, expressions"),
            ("#file press/press.css\n#whole v1 @x \"Style the press page\"\nbody {}\n#header {\n".into(), 4, "use a class or `header#header`"),
        ] {
            let err = parse("bad.txt", &bad).unwrap_err();
            assert!(err.starts_with(&format!("bad.txt:{line}: ")) && err.contains(why), "{bad:?}: {err}");
        }
        let twice = Corpus::from_sources(&[("one.txt", "#file a.md\n#whole v1 @x \"Add a\"\na\n"), ("two.txt", "#file a.md\n#whole v1 @y \"Add a\"\na\n")]);
        assert_eq!(twice.unwrap_err(), "two.txt:1: a.md is already in one.txt");
    }

    #[test]
    fn content_lines_that_look_like_directives_but_are_not() {
        let text = "#file a.rs\n#header v1 @x\n#![allow(dead_code)]\n//! A.\n#test t v1 @x \"Test it\"\n#[test]\nfn t() {}\n#file .gitlab-ci.yml\n#whole v1 @x \"Add CI\"\n# Stages\nstages:\n  - test\n#file run.sh\n#whole v1 @x \"Add the run script\"\n#!/bin/sh\n#; dropped\necho run\n";
        let files = parse("ok.txt", text).unwrap();
        assert_eq!(files[0].blocks[0].versions[0].text, "#![allow(dead_code)]\n//! A.\n");
        assert_eq!(files[1].blocks[0].versions[0].text, "# Stages\nstages:\n  - test\n");
        assert_eq!(files[2].blocks[0].versions[0].text, "#!/bin/sh\necho run\n");
    }

    #[test]
    fn tuning_keeps_the_literals_shape_and_always_changes_it() {
        assert_eq!(tune("40", 1.1), "44");
        assert_eq!(tune("40", 1.0), "41");
        assert_eq!(tune("2.50", 1.2), "3.00");
        assert_eq!(tune("0.5", 1.0), "0.6");
        assert_eq!(tune("1_000", 1.5), "1_500");
        assert_eq!(tune("12_000", 0.9), "10_800");
        let text = "/// Doc.\npub const MAX: u32 = 40;\n";
        assert_eq!(literal_of(text), Some("40"));
        assert_eq!(retune(text, "44").unwrap(), "/// Doc.\npub const MAX: u32 = 44;\n");
    }

    #[test]
    fn tuning_never_flips_a_sign_or_drops_the_grouping() {
        assert_eq!(tune("0", 0.5), "1");
        assert_eq!(tune("0.0", 0.9), "0.1");
        assert_eq!(tune("-0.01", 0.4), "0.00");
        assert_eq!(tune("-2.0", 1.5), "-3.0");
        assert_eq!(tune("1_500.0", 1.1), "1_650.0");
        assert_eq!(tune("999", 1.002), "1001");
        assert_eq!(literal_of("pub const DRAG: f32 = -0.25;\n"), Some("-0.25"));
        assert_eq!(retune("pub const A: u8 = 1;\n/// After.\n", "2").unwrap(), "pub const A: u8 = 2;\n/// After.\n");
    }

    #[test]
    fn messages_pools_and_fill() {
        let m = Messages::parse("[tune-up]\nRaise {what} to {new}\nBump {what}\n\n[empty-ok]\nX\n").unwrap();
        assert_eq!(m.pool("tune-up").len(), 2);
        assert_eq!(fill("Raise {what} to {new}", &[("what", "the thrust"), ("new", "44")]), "Raise the thrust to 44");
        assert!(Messages::parse("orphan line\n").is_err());
        assert!(Messages::parse("[a]\nRaise {thing}\n").unwrap_err().contains("{thing}"));
        assert!(Messages::parse("[a]\nX\n[a]\nY\n").unwrap_err().contains("twice"));
        let mut rng = Rng::new(3);
        assert!(m.pool("tune-up").contains(&m.pick("tune-up", &mut rng)));
    }

    #[test]
    fn house_style_and_fiction_checks() {
        assert!(subject_ok("Soften gravity near a body's centre").is_ok());
        assert!(subject_ok("fixup! Draw the cargo gauge").is_ok());
        for bad in ["soften gravity", "Soften gravity.", "feat: soften gravity", "Fix: thing", &"Long ".repeat(20)] {
            assert!(subject_ok(bad).is_err(), "{bad}");
        }
        assert!(check_fictional("See https://gitlab.example.com/orbital/orbital/-/issues/4 or mail ilse.varga@example.com").is_ok());
        assert!(check_fictional("<svg xmlns=\"http://www.w3.org/2000/svg\">").is_ok());
        assert!(check_fictional("let x = n @ 1..=3;").is_ok());
        for bad in ["https://github.com/someone/thing", "see crates.io", "mail me@realmail.net", "token glpat-abc", "http://orbital.dev/x"] {
            assert!(check_fictional(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn house_style_edges() {
        for ok in [
            "WIP",
            "Merge branch 'feature/x' into 'main'",
            "Balance: fuel cells base price 40 → 44",
            "Fix the docking chime playing twice",
            "Revert \"Soften gravity\"",
        ] {
            subject_ok(ok).unwrap();
        }
        for bad in ["", " Leading space", "Trailing space ", "Docs(readme): tidy", "squash! lower"] {
            assert!(subject_ok(bad).is_err(), "{bad:?}");
        }
        assert!(subject_ok(&"x".repeat(71).replacen('x', "X", 1)).is_ok());
    }

    #[test]
    fn fiction_check_finds_bare_hosts_in_prose_only() {
        for ok in [
            "let fast = self.dev_mode && c.xyz.length() > 0.0;",
            "use std::io;\nmod net;\nlet n = self.net.peers.len();",
            "@group(0) @binding(1) var tex: texture_2d<f32>;",
        ] {
            check_fictional_file("src/lib.rs", ok).unwrap_or_else(|e| panic!("{ok:?}: {e}"));
        }
        for (path, ok) in [
            ("Cargo.toml", "[profile.dev]\nopt-level = 1\n"),
            ("src/physics.rs", "let pull = body.com * G;\n"),
            ("src/app.rs", "let input = ctx.io.read();\n"),
            ("src/ship.rs", "let left = fuel.de / fuel.capacity;\n"),
            ("README.md", "See README.md, e.g. Cargo.toml and lib.rs at v0.1.0, or https://orbital.example.com.\n"),
            ("docs/x.md", "Run it on http://localhost:8080/ or mail press@orbital.example.com; assets on https://cdn.example.net/x.js"),
        ] {
            check_fictional_file(path, ok).unwrap_or_else(|e| panic!("{path} {ok:?}: {e}"));
        }
        for (path, bad) in [
            ("docs/devlog/2025-01-x.md", "Our itch.io page is up"),
            ("CONTRIBUTING.md", "Join us at discord.gg/orbital."),
            ("LICENSE", "Download from orbital.dev"),
            ("src/lib.rs", "/// Mirrors the layout on orbital.dev.\npub struct Layout;\n"),
            ("Cargo.toml", "# Published on orbital.dev\n[package]\n"),
            ("src/lib.rs", "-----BEGIN OPENSSH PRIVATE KEY-----"),
            ("src/lib.rs", "// see docs.rs/glam"),
            ("src/lib.rs", "const URL: &str = \"https://orbital.dev/api\";"),
        ] {
            assert!(check_fictional_file(path, bad).is_err(), "{path}: {bad}");
        }
    }

    #[test]
    fn roadmap_order_is_checked_per_block() {
        let features =
            "a | feature | ilse | 3 | main | merged | A\n  > Desc\nb | feature | ilse | 5 | main | direct | B\nc | feature | teodor | 9 | main | draft | C\n";
        let ok = Corpus::from_sources(&[("t.txt", "#file a.md\n#whole v1 @a \"Add a\"\na\n#whole v2 @b \"Grow a\"\naa\n")]).unwrap();
        assert!(roadmap_errors(&ok, features).is_empty());
        let bad = Corpus::from_sources(&[("t.txt", "#file a.md\n#whole v1 @b \"Add a\"\na\n#whole v2 @a \"Grow a\"\naa\n")]).unwrap();
        assert_eq!(roadmap_errors(&bad, features), ["a.md v2: @a (milestone 3) comes before v1's @b (milestone 5)"]);
        let unmerged = Corpus::from_sources(&[("t.txt", "#file a.md\n#whole v1 @c \"Add a\"\na\n#whole v2 @a \"Grow a\"\naa\n")]).unwrap();
        assert!(roadmap_errors(&unmerged, features).is_empty(), "a draft never lands on main, so it sets no order");
    }

    /// Per block, each version's feature milestone (from `features`) against the latest before it.
    /// Only features that land on main (`merged`, `direct`) count: the others' versions stay on
    /// their branches.
    fn roadmap_errors(c: &Corpus, features: &str) -> Vec<String> {
        let milestone: BTreeMap<&str, u32> = features
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with(['#', ' ', '\t']))
            .filter_map(|l| {
                let f: Vec<&str> = l.split('|').map(str::trim).collect();
                matches!(f.get(5), Some(&"merged" | &"direct")).then_some((*f.first()?, f.get(3)?.parse().ok()?))
            })
            .collect();
        let mut errors = Vec::new();
        for f in &c.files {
            for b in &f.blocks {
                let mut latest: Option<(&Version, u32)> = None;
                for v in &b.versions {
                    let Some(&m) = milestone.get(v.feature.as_str()) else {
                        continue;
                    };
                    match latest {
                        Some((before, at)) if m < at => errors.push(format!(
                            "{} v{}: @{} (milestone {m}) comes before v{}'s @{} (milestone {at})",
                            b.key(&f.path),
                            v.n,
                            v.feature,
                            before.n,
                            before.feature
                        )),
                        Some((_, at)) if m == at => {}
                        _ => latest = Some((v, m)),
                    }
                }
            }
        }
        errors
    }

    /// Per block, each version whose text is the same as the version before it: a step that would
    /// change nothing. A `!removed` version and the one that brings the block back are exempt.
    fn repeated_versions(c: &Corpus) -> Vec<String> {
        let mut out = Vec::new();
        for f in &c.files {
            for b in &f.blocks {
                for pair in b.versions.windows(2) {
                    let (before, v) = (&pair[0], &pair[1]);
                    if !before.removed && !v.removed && before.text == v.text {
                        out.push(format!("{} v{} repeats v{}", b.key(&f.path), v.n, before.n));
                    }
                }
            }
        }
        out
    }

    #[test]
    fn a_version_that_repeats_its_predecessor_is_found() {
        let c = Corpus::from_sources(&[(
            "t.txt",
            "#file a.md\n#whole v1 @a \"Add a\"\na\n#whole v2 @b \"Grow a\"\na\n#whole v3 @b \"Drop a\" !removed\n#whole v4 @b \"Bring a back\"\na\n#whole v5 @b \"Grow a\"\naa\n",
        )])
        .unwrap();
        assert_eq!(repeated_versions(&c), ["a.md v2 repeats v1"]);
    }

    // --- Guards over the real corpus (they grow with it) ---

    fn every_version(c: &Corpus) -> Vec<(&File, &Block, &Version)> {
        c.files.iter().flat_map(|f| f.blocks.iter().flat_map(move |b| b.versions.iter().map(move |v| (f, b, v)))).collect()
    }

    #[test]
    fn the_corpus_parses_and_tags_known_features() {
        let c = Corpus::load();
        let slugs = feature_slugs(FEATURES);
        for (f, b, v) in every_version(&c) {
            assert!(slugs.contains(&v.feature), "{} {} v{}: unknown feature @{}", f.path, b.name, v.n, v.feature);
        }
        Messages::load();
    }

    #[test]
    fn block_versions_follow_the_roadmap() {
        let errors = roadmap_errors(&Corpus::load(), FEATURES);
        assert!(errors.is_empty(), "a block's versions on merged and direct features must come in milestone order:\n{}", errors.join("\n"));
    }

    #[test]
    fn no_version_repeats_its_predecessor() {
        let repeats = repeated_versions(&Corpus::load());
        assert!(repeats.is_empty(), "every version of a block must change it:\n{}", repeats.join("\n"));
    }

    #[test]
    fn corpus_messages_follow_the_house_style() {
        for (f, b, v) in every_version(&Corpus::load()) {
            if let Some(m) = &v.message {
                subject_ok(m.lines().next().unwrap_or("")).unwrap_or_else(|e| panic!("{} {} v{}: {e}", f.path, b.name, v.n));
            }
        }
    }

    #[test]
    fn const_literals_are_plain_numbers() {
        for (f, b, v) in every_version(&Corpus::load()) {
            if b.kind == Kind::Const && !v.removed {
                let lit = literal_of(&v.text).unwrap_or_else(|| panic!("{} {}: no `const NAME: T = n;` line", f.path, b.name));
                let plain = lit.replace('_', "");
                assert!(
                    plain.parse::<i64>().is_ok() || (plain.contains('.') && plain.parse::<f64>().is_ok() && !plain.contains('e')),
                    "{} {}: {lit}",
                    f.path,
                    b.name
                );
            }
        }
    }

    #[test]
    fn corpus_is_fictional() {
        check_fictional_file("features.txt", FEATURES).unwrap();
        check_fictional_file("messages.txt", MESSAGES).unwrap();
        for (f, b, v) in every_version(&Corpus::load()) {
            check_fictional_file("path.txt", &f.path).unwrap_or_else(|e| panic!("{}: {e}", f.path));
            check_fictional_file(&f.path, &v.text).unwrap_or_else(|e| panic!("{} {} v{}: {e}", f.path, b.name, v.n));
            if let Some(m) = &v.message {
                check_fictional_file("COMMIT_EDITMSG", m).unwrap_or_else(|e| panic!("{} {} v{}'s message: {e}", f.path, b.name, v.n));
            }
        }
    }

    /// Whether rustfmt is missing: then the rustfmt tests skip, except under CI, where they fail.
    fn no_rustfmt() -> bool {
        if std::process::Command::new("rustfmt").arg("--version").output().is_ok_and(|o| o.status.success()) {
            return false;
        }
        assert!(std::env::var_os("CI").is_none(), "rustfmt is missing, and CI runs the rustfmt guard");
        eprintln!("notice: rustfmt not found, so the rendered Rust isn't checked");
        true
    }

    /// The files `mod` lines in `text` (at `path`) point to, both spellings.
    fn module_files(path: &str, text: &str) -> Vec<String> {
        let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
        let base = match file {
            "lib.rs" | "main.rs" | "mod.rs" => dir.to_string(),
            _ => format!("{dir}/{}", file.trim_end_matches(".rs")),
        };
        text.lines()
            .filter_map(|l| {
                let l = l.trim().strip_prefix("pub ").or_else(|| l.trim().strip_prefix("pub(crate) ")).unwrap_or(l.trim());
                l.strip_prefix("mod ")?.strip_suffix(';')
            })
            .flat_map(|m| [format!("{base}/{m}.rs"), format!("{base}/{m}/mod.rs")])
            .map(|p| p.trim_start_matches('/').to_string())
            .collect()
    }

    /// Renders every Rust file once per version number into `<tmp>/v<N>/<path>`, each block at
    /// its vN (or its last below that, skipped while removed), so every version of every block
    /// meets rustfmt. The `v1` tree is the first state, the last tree the latest; each tree keeps
    /// the paths so `mod` lines resolve. One rustfmt call checks them all, given only the files
    /// no `mod` line reaches (rustfmt follows those itself).
    fn rustfmt_check(c: &Corpus) -> Result<(), String> {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("rustfmt.toml"), "").unwrap();
        let rust: Vec<&File> = c.files.iter().filter(|f| f.path.ends_with(".rs")).collect();
        let rounds = rust.iter().flat_map(|f| f.blocks.iter().map(|b| b.versions.len())).max().unwrap_or(0);
        let mut paths = Vec::new();
        for round in 0..rounds {
            let mut rendered = Vec::new();
            for f in &rust {
                let text = c.render(&f.path, |k| {
                    let b = f.blocks.iter().find(|b| b.key(&f.path) == k)?;
                    Some((b.versions[round.min(b.versions.len() - 1)].n, None))
                });
                if let Some(text) = text {
                    let p = dir.path().join(format!("v{}", round + 1)).join(&f.path);
                    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                    std::fs::write(&p, &text).unwrap();
                    rendered.push((f.path.as_str(), text, p));
                }
            }
            let children: Vec<String> = rendered.iter().flat_map(|(path, text, _)| module_files(path, text)).collect();
            paths.extend(rendered.into_iter().filter(|(path, _, _)| !children.iter().any(|c| c == path)).map(|(_, _, p)| p));
        }
        if paths.is_empty() {
            return Ok(());
        }
        let out = std::process::Command::new("rustfmt").args(["--edition", "2024", "--check"]).args(&paths).output().unwrap();
        if out.status.success() {
            return Ok(());
        }
        let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let trees = "a vN/ tree holds each block at its vN, or its last below that";
        if !stderr.trim().is_empty() {
            return Err(format!("rustfmt couldn't read the rendered Rust ({trees}): a `mod` line without its file, or a syntax error?\n{stderr}{stdout}"));
        }
        Err(format!(
            "rendered Rust isn't laid out as rustfmt would ({trees}). \
             Run `rustfmt --edition 2024` on a scratch copy of the rendered file and copy its layout back into the block:\n{stdout}"
        ))
    }

    #[test]
    fn the_rustfmt_check_sees_every_version_and_resolves_modules() {
        if no_rustfmt() {
            return;
        }
        let good = "#file src/lib.rs\n#header v1 @x\n//! Lib.\n\npub mod a;\n#file src/a.rs\n#header v1 @x\n//! A.\n#item a v1 @x \"Add a\"\npub fn a() {}\n";
        rustfmt_check(&Corpus::from_sources(&[("t.txt", good)]).unwrap()).unwrap();
        let middle = format!("{good}#item a v2 @x \"Grow a\"\npub fn a( ) {{}}\n#item a v3 @x \"Shrink a\"\npub fn a() {{}}\n");
        let err = rustfmt_check(&Corpus::from_sources(&[("t.txt", &middle)]).unwrap()).unwrap_err();
        assert!(err.contains("/v2/src/a.rs") && err.contains("laid out"), "{err}");
        assert_eq!(err.matches("Diff in").count(), 1, "a.rs is checked once, through lib.rs's `mod a;`: {err}");
        let missing = good.replace("pub mod a;", "pub mod a;\npub mod b;");
        let err = rustfmt_check(&Corpus::from_sources(&[("t.txt", &missing)]).unwrap()).unwrap_err();
        assert!(err.contains("couldn't read") && err.contains("b.rs"), "{err}");
    }

    #[test]
    fn rust_files_are_rustfmt_clean() {
        if no_rustfmt() {
            return;
        }
        rustfmt_check(&Corpus::load()).unwrap_or_else(|e| panic!("{e}"));
    }

    #[test]
    fn features_are_well_formed() {
        const KINDS: [&str; 8] = ["feature", "fix", "art", "audio", "docs", "balance", "chore", "experiment"];
        const PEOPLE: [&str; 6] = ["ilse", "teodor", "noor", "kasimir", "wen", "rafe"];
        /// The brief's lines, verbatim: the root commit and the roadmap's named features.
        const REQUIRED: [&str; 10] = [
            "workspace-setup | chore | ilse | 1 | main | direct | Set up the Cargo workspace and the core crate",
            "multiplayer | experiment | teodor | 18 | main | long-lived | Prototype lockstep multiplayer",
            "hd-sprites | art | noor | 38 | main | open | Draw the ships at twice the resolution",
            "trade-routes | feature | wen | 38 | main | diverged | Plan multi-stop trade routes",
            "autopilot | feature | kasimir | 39 | main | unpushed:2 | Add an autopilot for transfer burns",
            "station-ui | feature | wen | 39 | main | remote-ahead:2 | Rework the station screen",
            "fuel-rework | balance | ilse | 39 | main | conflict | Burn less fuel per unit of thrust and make fuel cells dearer",
            "hud-polish | feature | kasimir | 39 | main | irebase | Polish the HUD gauges",
            "press-kit-2 | docs | noor | 40 | main | draft | Refresh the press kit for 1.2",
            "wormholes | feature | teodor | 40 | main | draft | Prototype wormholes between sectors",
        ];
        fn emoji(c: char) -> bool {
            matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE0F)
        }
        let mut slugs = Vec::new();
        let mut rows: Vec<Vec<&str>> = Vec::new();
        let mut descriptions = 0;
        let mut first = true;
        for line in FEATURES.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
            assert_eq!(line, line.trim_end(), "trailing spaces: {line:?}");
            if line.starts_with(' ') {
                let d = line.trim_start();
                if let Some(text) = d.strip_prefix("> ") {
                    descriptions += 1;
                    assert!(text.starts_with(|c: char| c.is_ascii_uppercase()), "{line:?}: a description starts with a capital letter");
                    assert!(!text.chars().any(emoji), "{line:?}: no emoji in a description");
                } else if let Some(later) = d.strip_prefix("later: ") {
                    assert!(["release", "unwritten"].contains(&later), "{line:?}: later: release or later: unwritten");
                } else {
                    assert!(d.starts_with("asset "), "detail line {line:?}");
                    if let Some(m) = d.strip_prefix("asset ").and_then(|a| a.split_once('"')).map(|(_, m)| m.trim_end_matches('"')) {
                        subject_ok(m).unwrap();
                    }
                }
                continue;
            }
            let f: Vec<&str> = line.split('|').map(str::trim).collect();
            assert_eq!(f.len(), 7, "{line}");
            if first {
                assert_eq!((f[0], f[5]), ("workspace-setup", "direct"));
                first = false;
            }
            assert!(!slugs.contains(&f[0]), "{} twice", f[0]);
            slugs.push(f[0]);
            assert!(f[0].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "{}", f[0]);
            assert!(KINDS.contains(&f[1]) && PEOPLE.contains(&f[2]), "{line}");
            assert!((1..=40).contains(&f[3].parse::<u32>().unwrap()), "{line}");
            assert!(["main", "release/1.0", "release/1.1", "release/1.2"].contains(&f[4]), "{line}");
            let fate_ok = ["merged", "direct", "open", "draft", "long-lived", "diverged", "conflict", "irebase"].contains(&f[5])
                || f[5]
                    .strip_prefix("unpushed:")
                    .or_else(|| f[5].strip_prefix("remote-ahead:"))
                    .is_some_and(|n| n.parse::<u8>().is_ok());
            assert!(fate_ok, "{line}");
            subject_ok(f[6]).unwrap_or_else(|e| panic!("{e}"));
            rows.push(f.clone());
        }
        let n = rows.len();
        assert!((170..=210).contains(&n), "{n} features");
        for req in REQUIRED {
            assert!(FEATURES.lines().any(|l| l == req), "the brief's line is missing or changed: {req}");
        }
        for (who, min) in [("ilse", 32), ("teodor", 28), ("noor", 22), ("kasimir", 24), ("wen", 28), ("rafe", 24)] {
            let count = rows.iter().filter(|f| f[2] == who).count();
            assert!(count >= min, "{who} has {count} features; the brief asks for at least {min}");
        }
        for (target, count) in [("release/1.0", 2), ("release/1.1", 2), ("release/1.2", 5)] {
            let fixes: Vec<&Vec<&str>> = rows.iter().filter(|f| f[4] == target).collect();
            assert_eq!(fixes.len(), count, "features targeting {target}");
            assert!(fixes.iter().all(|f| f[1] == "fix" && f[5] == "merged"), "the {target} lines are merged fixes");
        }
        let direct = rows.iter().filter(|f| f[5] == "direct").count();
        assert!(direct * 100 >= 12 * n && direct * 100 <= 18 * n, "{direct} of {n} features are direct (12 to 18 percent)");
        assert!(
            descriptions * 10 >= 4 * n && descriptions * 10 <= 8 * n,
            "{descriptions} MR descriptions for {n} features (4 to 8 per 10)"
        );
        let msgs = Messages::load();
        for (pool, min) in [("tune-up", 25), ("tune-down", 25), ("tune-cell", 25), ("bump-dep", 25), ("review", 25), ("review-up", 12), ("review-down", 12)] {
            assert!(msgs.pool(pool).len() >= min, "[{pool}]");
            for t in msgs.pool(pool) {
                let filled = fill(
                    t,
                    &[
                        ("what", "the main thruster force"),
                        ("old", "40"),
                        ("new", "44"),
                        ("row", "Fuel cells"),
                        ("column", "base price"),
                        ("dep", "wgpu"),
                        ("version", "25.0.2"),
                    ],
                );
                subject_ok(&filled).unwrap_or_else(|e| panic!("[{pool}] {e}"));
            }
        }
    }
}
