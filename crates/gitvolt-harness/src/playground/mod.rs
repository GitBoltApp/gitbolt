//! The playground's repositories, in Orbital's world: the same names and teaching shapes as the
//! core's test fixtures (`gitvolt_core::testing::fixtures`), with Orbital's people, real-looking
//! files and dates. Built with plain git as each person, author and committer alike.

mod media_repos;
pub use media_repos::{lfs, previews, submodules};

use crate::media::palette::{GOLD, RED, TEAL};
use crate::media::sprites;
use crate::orbital::art;
use crate::orbital::calendar::unix;
use crate::orbital::people::{git_as, person};
use gitvolt_core::testing::TestRepo;
use std::path::{Path, PathBuf};

/// Commits as Orbital's people, one minute apart from wherever the clock was last set.
struct Play<'a> {
    r: &'a TestRepo,
    t: i64,
}

impl<'a> Play<'a> {
    fn new(r: &'a TestRepo, y: i64, m: u32, d: u32, h: u32) -> Self {
        Play { r, t: unix(y, m, d, h, 0) }
    }
    fn at(&mut self, y: i64, m: u32, d: u32, h: u32, min: u32) {
        self.t = unix(y, m, d, h, min);
    }
    fn write(&self, rel: &str, text: &str) {
        self.r.write(rel, text);
    }
    fn write_bytes(&self, rel: &str, bytes: &[u8]) {
        self.r.write_bytes(rel, bytes);
    }
    fn git_in(&mut self, dir: &Path, who: &str, args: &[&str]) -> String {
        self.t += 60;
        git_as(dir, person(who), self.t, args).unwrap_or_else(|e| panic!("{e}"))
    }
    fn git(&mut self, who: &str, args: &[&str]) -> String {
        let dir = self.r.path().to_path_buf();
        self.git_in(&dir, who, args)
    }
    fn commit(&mut self, who: &str, message: &str) -> String {
        self.git(who, &["add", "-A"]);
        self.git(who, &["commit", "-q", "-m", message]);
        self.git(who, &["rev-parse", "HEAD"])
    }
    /// A bare `origin.git` beside the repo, added as `origin`.
    fn origin(&mut self, who: &str) -> PathBuf {
        let origin = std::path::absolute(self.r.root().join("origin.git")).expect("absolute origin");
        let root = self.r.root().to_path_buf();
        self.git_in(&root, who, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        self.git(who, &["remote", "add", "origin", origin.to_str().expect("UTF-8 path")]);
        origin
    }
}

const SITE_README: &str = "# orbital-site\n\nThe website for Orbital, a small space-trading game. Plain HTML and CSS, built by nothing.\n\nNews posts live in `news/`, one Markdown file each.\n";
const SITE_INDEX_V1: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>Orbital</title>\n  <link rel=\"stylesheet\" href=\"css/site.css\">\n</head>\n<body>\n  <header><h1>Orbital</h1><p>A small space-trading game about orbits, cargo and bad decisions.</p></header>\n  <nav><a href=\"news/\">News</a></nav>\n</body>\n</html>\n";
const SITE_CSS: &str = "body { margin: 0; background: #0e1424; color: #e6ecf5; font: 16px/1.5 system-ui, sans-serif; }\nheader { padding: 48px 24px; background: linear-gradient(135deg, #253255, #4b2f73); }\nh1 { margin: 0; color: #ffc95e; letter-spacing: 0.08em; }\nnav a { color: #3cc2ae; margin: 0 12px; }\n";
const FIRST_LOOK: &str = "---\ntitle: A first look at Orbital\ndate: 2026-03-03\nauthor: Wen Castellano\n---\n\n# A first look at Orbital\n\nOrbital is a game about flying cargo between stations without running out of fuel. You don't fly in straight lines: you burn, and your orbit bends.\n\nWe're four months in. The scout flies, the depot trades, and the economy is wrong in interesting ways.\n";
const PRESS: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>Orbital press kit</title>\n  <link rel=\"stylesheet\" href=\"css/site.css\">\n</head>\n<body>\n  <h1>Press kit</h1>\n  <p>Orbital is made by six people in four time zones.</p>\n  <p><a href=\"trailer.html\">Watch the trailer</a></p>\n  <p>Contact: press@orbital.example.com</p>\n</body>\n</html>\n";

pub fn basic(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 3, 2, 9);
    p.write("README.md", SITE_README);
    p.write("index.html", SITE_INDEX_V1);
    p.write("css/site.css", SITE_CSS);
    p.commit("ilse", "Start the Orbital website");
    p.at(2026, 3, 3, 14, 10);
    p.write("news/2026-03-first-look.md", FIRST_LOOK);
    let first_look = p.commit("wen", "Post the first look at Orbital");
    p.origin("rafe");
    p.git("rafe", &["push", "-q", "-u", "origin", "main"]);
    p.git("rafe", &["remote", "set-head", "origin", "main"]);
    p.git("rafe", &["tag", "-a", "-m", "Website 1.0", "v1.0", &first_look]);
    p.at(2026, 3, 5, 16, 30);
    p.git("noor", &["switch", "-q", "-c", "feature/press-page"]);
    p.write("press.html", PRESS);
    p.commit("noor", "Add the press page");
    p.write("index.html", &SITE_INDEX_V1.replace("<a href=\"news/\">News</a>", "<a href=\"news/\">News</a> <a href=\"press.html\">Press</a>"));
    p.commit("noor", "Link the press page from the menu");
    p.git("noor", &["push", "-q", "-u", "origin", "feature/press-page"]);
    p.at(2026, 3, 6, 10, 5);
    p.git("wen", &["switch", "-q", "main"]);
    p.write("news/2026-03-first-look.md", &FIRST_LOOK.replace("four months", "five months"));
    p.commit("wen", "Fix the timeline in the first look");
    p.at(2026, 3, 6, 11, 40);
    p.git("ilse", &["merge", "-q", "--no-ff", "-m", "Merge branch 'feature/press-page' into 'main'", "feature/press-page"]);
    p.git("ilse", &["push", "-q", "origin", "main"]);
    p.at(2026, 3, 9, 8, 15);
    p.git("rafe", &["switch", "-q", "-c", "hotfix"]);
    p.write("press.html", &PRESS.replace("trailer.html", "media/trailer.html"));
    p.commit("rafe", "Fix the trailer link on the press page");
    p.git("rafe", &["switch", "-q", "main"]);
    p.write("css/site.css", &SITE_CSS.replace("#253255, #4b2f73", "#0e1424, #2c1f4a"));
    p.git("ilse", &["stash", "push", "-q", "-m", "Try a darker header"]);
    let wt = std::path::absolute(r.root().join("wt-hotfix")).expect("absolute worktree");
    p.git("rafe", &["worktree", "add", "-q", wt.to_str().expect("UTF-8 path"), "hotfix"]);
    std::fs::write(wt.join("press.html"), PRESS.replace("six people", "six people and a cat")).expect("edit the worktree");
    p.write("news/2026-03-first-look.md", &format!("{}\nNext time: the trading screen.\n", FIRST_LOOK.replace("four months", "five months")));
}

/// The origin's `post-receive` for `sync`: GitLab's merge-request boilerplate, a deploy line, and
/// for `dev` a failure-looking line.
const SYNC_POST_RECEIVE: &str = r#"#!/bin/sh
while read old new ref; do
  branch=${ref#refs/heads/}
  echo ""
  echo "To create a merge request for $branch, visit:"
  echo "  http://gitlab.example.com/orbital/modkit/-/merge_requests/new?merge_request%5Bsource_branch%5D=$branch"
  echo ""
  if [ "$branch" = dev ]; then echo "integration: rebase onto dev failed: conflict in src/loader.rs"; fi
  echo "Deployed preview for $branch"
done
"#;

pub fn sync(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 4, 6, 9);
    p.write("README.md", "# orbital-modkit\n\nMod support for Orbital: a mods folder, a manifest and Lua hooks.\n");
    p.write("mod.toml.example", "name = \"example-mod\"\nversion = \"0.1.0\"\nauthor = \"someone\"\nhooks = [\"docking\", \"trade\"]\n");
    p.commit("ilse", "Initial commit");
    p.at(2026, 4, 6, 15, 20);
    p.write("docs/manifest.md", "# The mod manifest\n\nEvery mod ships a `mod.toml` with a name, a version, an author and the hooks it uses.\n");
    p.commit("wen", "Document the mod manifest");
    p.origin("ilse");
    p.git("ilse", &["push", "-q", "-u", "origin", "main"]);
    p.git("ilse", &["remote", "set-head", "origin", "main"]);
    p.at(2026, 4, 7, 10, 0);
    p.git("teodor", &["switch", "-q", "-c", "dev"]);
    p.write("src/loader.rs", "//! Finds and loads mods.\n\nuse std::path::Path;\n\n/// Every folder under `mods/` that holds a `mod.toml`.\npub fn discover(root: &Path) -> Vec<std::path::PathBuf> {\n    let Ok(entries) = std::fs::read_dir(root.join(\"mods\")) else { return Vec::new() };\n    entries.flatten().map(|e| e.path()).filter(|p| p.join(\"mod.toml\").is_file()).collect()\n}\n");
    p.commit("teodor", "Load mods from the mods folder");
    p.git("teodor", &["push", "-q", "-u", "origin", "dev"]);
    p.at(2026, 4, 7, 13, 30);
    p.git("kasimir", &["switch", "-q", "main"]);
    p.git("kasimir", &["switch", "-q", "-c", "feature/lua-hooks"]);
    p.write("src/hooks.rs", "//! Events a Lua script can subscribe to.\n\n/// The events mods can hook.\npub enum Event {\n    Docking,\n    Trade,\n    Jump,\n}\n\npub fn expose_docking(lua: &mlua::Lua) -> mlua::Result<()> {\n    lua.globals().set(\"on_docking\", lua.create_table()?)\n}\n");
    p.commit("kasimir", "Expose the docking event to Lua");
    p.git("kasimir", &["push", "-q", "-u", "origin", "feature/lua-hooks"]);
    p.write("src/hooks_trade.rs", "//! The trade event.\n\npub fn expose_trade(lua: &mlua::Lua) -> mlua::Result<()> {\n    lua.globals().set(\"on_trade\", lua.create_table()?)\n}\n");
    p.commit("kasimir", "Expose the trade event to Lua");
    p.git("wen", &["switch", "-q", "main"]);
    p.git("wen", &["switch", "-q", "-c", "feature/mod-manifest"]);
    p.write("src/manifest.rs", "//! Reads a mod's `mod.toml`.\n\n#[derive(Debug, serde::Deserialize)]\npub struct Manifest {\n    pub name: String,\n    pub version: String,\n    pub author: String,\n    #[serde(default)]\n    pub hooks: Vec<String>,\n}\n\npub fn read(text: &str) -> Result<Manifest, toml::de::Error> {\n    toml::from_str(text)\n}\n");
    p.commit("wen", "Read mod.toml");
    p.git("ilse", &["switch", "-q", "main"]);
    // Another contributor's clone moves origin ahead of this one.
    let root = r.root().to_path_buf();
    p.at(2026, 4, 8, 14, 0);
    p.git_in(&root, "noor", &["clone", "-q", "origin.git", "elsewhere"]);
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("docs")).expect("docs dir");
    std::fs::write(elsewhere.join("docs/layout.md"), "# The mod folder\n\n```\nmods/\n  my-mod/\n    mod.toml\n    main.lua\n```\n").expect("write layout");
    p.git_in(&elsewhere, "noor", &["add", "-A"]);
    p.git_in(&elsewhere, "noor", &["commit", "-q", "-m", "Document the mod folder layout"]);
    p.git_in(&elsewhere, "noor", &["push", "-q", "origin", "main"]);
    p.git_in(&elsewhere, "noor", &["switch", "-q", "feature/lua-hooks"]);
    std::fs::write(elsewhere.join("src/hooks_jump.rs"), "//! The jump event.\n\npub fn expose_jump(lua: &mlua::Lua) -> mlua::Result<()> {\n    lua.globals().set(\"on_jump\", lua.create_table()?)\n}\n").expect("write jump");
    p.git_in(&elsewhere, "noor", &["add", "-A"]);
    p.git_in(&elsewhere, "noor", &["commit", "-q", "-m", "Expose the jump event to Lua"]);
    p.git_in(&elsewhere, "noor", &["push", "-q", "origin", "feature/lua-hooks"]);
    // Installed last, so the fixture's own pushes stay quiet.
    r.origin_hook("post-receive", SYNC_POST_RECEIVE);
}

const COMMODITIES: &str = "fuel_cells Fuel cells, water_ice Water ice, iron_ore Iron ore, alloy_plate Alloy plate, medkits Medkits, circuitry Circuitry, hydroponics Hydroponics, reactor_parts Reactor parts, coolant Coolant, ceramics Ceramics, sensors Sensors, rations Rations, textiles Textiles, solar_film Solar film, drill_bits Drill bits, optics Optics, polymers Polymers, seeds Seeds, batteries Batteries, nav_charts Nav charts, spare_hulls Spare hulls, beacons Beacons, cryo_pods Cryo pods, lenses Lenses, filters Filters, gyros Gyros, magnets Magnets, salvage Salvage, art_prints Art prints";

/// The commodity table, with `(file line, new base_price)` overrides (line 1 is the header).
fn commodities_csv(overrides: &[(usize, u32)]) -> String {
    let mut lines = vec!["id,name,base_price,mass_t,volatility,legal".to_string()];
    for (i, item) in COMMODITIES.split(", ").enumerate() {
        let (id, name) = item.split_once(' ').expect("id and name");
        let price = overrides.iter().find(|(line, _)| *line == i + 2).map_or(10 + 13 * i as u32, |(_, p)| *p);
        lines.push(format!("{id},{name},{price},{:.2},{:.2},yes", 0.5 + 0.25 * (i % 5) as f32, 0.05 * (1 + i % 4) as f32));
    }
    lines.join("\n") + "\n"
}

pub fn conflicts(r: &TestRepo) {
    let credits = |ramp| sprites::icon(art::icon_mask("credits", 1), ramp).to_png();
    let mut p = Play::new(r, 2026, 5, 4, 9);
    p.write("data/commodities.csv", &commodities_csv(&[]));
    r.write_bytes("icons/credits.png", &credits(GOLD));
    p.write("docs/old-pricing.md", "# Old pricing\n\nPrices were flat per station before the 1.0 economy. Kept for reference.\n");
    p.commit("wen", "Add the commodity table");
    p.at(2026, 5, 4, 14, 0);
    p.git("wen", &["switch", "-q", "-c", "balance/station-list"]);
    p.write("data/stations.csv", "id,name,body,faction\ndepot,Meridian Depot,Ceres,traders\nrelay,Kuiper Relay,Neptune,miners\nyard,Hesper Yard,Venus,builders\n");
    p.commit("wen", "Add the station list");
    p.git("wen", &["switch", "-q", "main"]);
    p.at(2026, 5, 5, 10, 0);
    p.git("wen", &["switch", "-q", "-c", "feature/price-rework"]);
    p.write("data/commodities.csv", &commodities_csv(&[(4, 58), (16, 190)]));
    r.write_bytes("icons/credits.png", &credits(TEAL));
    p.write("docs/old-pricing.md", "# Old pricing\n\nPrices were flat per station before the 1.0 economy. Kept for reference.\n\nThe rework replaces the flat table with per-region prices that drift with supply.\n");
    p.commit("wen", "Rework prices for the new economy");
    p.git("ilse", &["switch", "-q", "main"]);
    p.at(2026, 5, 6, 11, 0);
    p.write("data/commodities.csv", &commodities_csv(&[(4, 49), (16, 215)]));
    r.write_bytes("icons/credits.png", &credits(RED));
    p.git("ilse", &["rm", "-q", "docs/old-pricing.md"]);
    p.commit("ilse", "Reprice for the 1.1 balance pass");
}

pub fn stack(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 6, 1, 9);
    p.write("Cargo.toml", "[package]\nname = \"orbital-cargo\"\nversion = \"0.4.0\"\nedition = \"2021\"\n\n[dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\n");
    p.write("src/lib.rs", "//! Cargo holds for Orbital's ships.\n\npub mod hold;\n");
    p.commit("ilse", "Start the cargo crate");
    p.at(2026, 6, 2, 10, 0);
    p.git("ilse", &["switch", "-q", "-c", "feature/cargo-model"]);
    p.write("src/hold.rs", "//! A ship's hold: what it carries and what that weighs.\n\n#[derive(Debug, Clone, PartialEq)]\npub struct Crate {\n    pub item: String,\n    pub mass_t: f32,\n}\n\n#[derive(Debug, Default)]\npub struct Hold {\n    pub capacity_t: f32,\n    pub crates: Vec<Crate>,\n}\n\nimpl Hold {\n    pub fn new(capacity_t: f32) -> Self {\n        Hold { capacity_t, crates: Vec::new() }\n    }\n\n    /// Total mass of everything aboard.\n    pub fn mass_t(&self) -> f32 {\n        self.crates.iter().map(|c| c.mass_t).sum()\n    }\n}\n");
    p.commit("ilse", "Model cargo holds and their mass");
    p.at(2026, 6, 3, 15, 0);
    p.git("wen", &["switch", "-q", "-c", "feature/cargo-ui"]);
    p.write("src/ui.rs", "//! The hold as the trade screen shows it.\n\nuse crate::hold::Hold;\n\n/// One line per crate, then the total against the capacity.\npub fn hold_lines(hold: &Hold) -> Vec<String> {\n    let mut lines: Vec<String> = hold\n        .crates\n        .iter()\n        .map(|c| format!(\"{:<16}{:>6.1} t\", c.item, c.mass_t))\n        .collect();\n    lines.push(format!(\"{:.1} / {:.1} t\", hold.mass_t(), hold.capacity_t));\n    lines\n}\n");
    p.commit("wen", "Show the hold on the trade screen");
    p.at(2026, 6, 4, 9, 30);
    p.git("kasimir", &["switch", "-q", "-c", "feature/cargo-tests"]);
    p.write("tests/hold.rs", "use orbital_cargo::hold::{Crate, Hold};\n\nfn crate_of(item: &str, mass_t: f32) -> Crate {\n    Crate { item: item.into(), mass_t }\n}\n\n#[test]\nfn an_empty_hold_weighs_nothing() {\n    assert_eq!(Hold::new(20.0).mass_t(), 0.0);\n}\n\n#[test]\nfn crates_add_up() {\n    let mut hold = Hold::new(20.0);\n    hold.crates.push(crate_of(\"Fuel cells\", 2.5));\n    hold.crates.push(crate_of(\"Medkits\", 0.5));\n    assert_eq!(hold.mass_t(), 3.0);\n}\n");
    p.commit("kasimir", "Test the hold's limits");
    p.at(2026, 6, 5, 11, 0);
    p.git("rafe", &["switch", "-q", "main"]);
    p.write("Cargo.toml", "[package]\nname = \"orbital-cargo\"\nversion = \"0.4.1\"\nedition = \"2021\"\n\n[dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\n");
    p.commit("rafe", "Bump the crate to 0.4.1");
    p.git("rafe", &["switch", "-q", "feature/cargo-tests"]);
}

fn ship_rs(edited: bool) -> String {
    let mut l: Vec<String> = [
        "//! The ship.",
        "",
        "use glam::Vec2;",
        "",
        "/// A hull in flight.",
        "pub struct Ship {",
        "    pub pos: Vec2,",
        "    pub vel: Vec2,",
        "    pub heading: f32,",
        "    pub dry_mass: f32,",
        "    pub fuel: f32,",
        "    pub max_fuel: f32,",
        "    pub thrust_n: f32,",
        "    pub cargo_t: f32,",
        "}",
        "",
        "impl Ship {",
        "    /// A ship at rest at `pos`.",
        "    pub fn new(pos: Vec2, dry_mass: f32) -> Self {",
        "        const TANK: f32 = 40.0;",
        "        Ship { pos, vel: Vec2::ZERO, heading: 0.0, dry_mass, fuel: TANK, max_fuel: TANK, thrust_n: 1200.0, cargo_t: 0.0 }",
        "    }",
        "",
        "    /// Accelerate along the heading for `dt` seconds.",
        "    pub fn thrust(&mut self, dt: f32) {",
        "        if self.fuel <= 0.0 {",
        "            return;",
        "        }",
        "        self.vel += Vec2::from_angle(self.heading) * (self.thrust_n / self.mass()) * dt;",
        "        self.burn_fuel(dt);",
        "    }",
        "",
        "    /// Burn fuel for `dt` seconds of thrust.",
        "    pub fn burn_fuel(&mut self, dt: f32) {",
        "        self.fuel = (self.fuel - dt * 0.5).max(0.0);",
        "    }",
        "",
        "    /// Hull, fuel and cargo together, in tonnes.",
        "    pub fn mass(&self) -> f32 { self.dry_mass + self.fuel * 0.001 + self.cargo_t }",
        "}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(l.len(), 40, "ship.rs is 40 lines");
    if edited {
        l[4] = "/// A hull in flight, ours or a trader's.".into();
        l[19] = "        const TANK: f32 = 45.0;".into();
        l[34] = "        self.fuel = (self.fuel - dt * 0.6).max(0.0);".into();
    }
    l.join("\n") + "\n"
}

pub fn wip_staging(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 4, 13, 9);
    p.git("ilse", &["config", "user.name", "Ilse Varga"]);
    p.git("ilse", &["config", "user.email", "ilse.varga@example.com"]);
    p.write("src/ship.rs", &ship_rs(false));
    let observations = [
        "the scout drifts when the tank runs dry",
        "docking is easier with the assist on",
        "water ice sells high near the depot",
        "the map markers overlap at the far zoom",
        "fuel cells are never in stock at the relay",
        "the new thruster flame reads well",
        "trade prices swing too far on a single sale",
        "jump costs feel fair",
        "the hold fills up before the market does",
        "the tutorial skips the docking clamp",
    ];
    let notes: Vec<String> = (0..39).map(|i| format!("- 2026-03-{:02}: {}", i % 28 + 1, observations[i % 10])).collect();
    p.write("NOTES.md", &format!("# Playtest notes\n{}\n", notes.join("\n")));
    p.write("old_controls.txt", "W/S: thrust\nA/D: turn\nSpace: dock\n");
    p.write("docs/release notes.md", "# Release notes\n\n- 0.4.0: trading\n");
    p.commit("ilse", "Base");
    p.at(2026, 4, 14, 10, 0);
    p.write("src/ship.rs", &ship_rs(true));
    let mut edited: Vec<String> = std::fs::read_to_string(r.path().join("NOTES.md")).expect("notes").lines().map(String::from).collect();
    edited[2] = "- 2026-03-02: docking is much easier with the assist on".into();
    p.write("NOTES.md", &(edited.join("\n") + "\n"));
    p.git("ilse", &["add", "NOTES.md"]);
    edited[29] = "- 2026-03-02: the hold fills up long before the market does".into();
    p.write("NOTES.md", &(edited.join("\n") + "\n"));
    std::fs::remove_file(r.path().join("old_controls.txt")).expect("remove old controls");
    p.write("docs/release notes.md", "# Release notes\n\n- 0.4.0: trading\n- 0.4.1: hauler cargo pods\n");
    p.write("src/autopilot.rs", "//! Autopilot, not wired up yet.\n\npub fn hold_course() {}\n");
}

pub fn rebase_lab(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 4, 20, 9);
    p.write("docs/docking.md", "Approach at 2 m/s\nClamp at 5 m\nRelease after 3 s\n");
    p.commit("kasimir", "Write down the docking rules");
    p.at(2026, 4, 21, 10, 0);
    p.git("teodor", &["switch", "-q", "-c", "feature/docking"]);
    p.write("src/docking.rs", "//! The docking state machine.\n\n#[derive(Debug, Clone, Copy, PartialEq)]\npub enum State {\n    Approach,\n    Clamp,\n    Docked,\n    Release,\n}\n\nimpl State {\n    pub fn next(self) -> State {\n        match self {\n            State::Approach => State::Clamp,\n            State::Clamp => State::Docked,\n            State::Docked => State::Release,\n            State::Release => State::Release,\n        }\n    }\n}\n");
    p.commit("teodor", "Add the docking state machine");
    p.write("docs/docking.md", "Approach at 1.5 m/s\nClamp at 5 m\nRelease after 3 s\n");
    p.commit("teodor", "Slow the approach to 1.5 m/s");
    p.at(2026, 4, 22, 11, 0);
    p.write("docs/docking.md", "Approach at 1.5 m/s\nClamp at 5 m\nRelease after 3 s\nCheck alignment before the clamp closes\n");
    p.commit("kasimir", "Note the clamp's alignment check");
    p.write("docs/docking.md", "Approach at 1.5 m/s\nClamp at 5 m\nRelease after 3 s\nCheck the alignment is within 2 degrees before the clamp closes\n");
    p.commit("kasimir", "Reword the alignment check");
    p.at(2026, 4, 23, 14, 0);
    p.write("tests/docking.rs", "use orbital::docking::State;\n\n#[test]\nfn approach_leads_to_clamp() {\n    assert_eq!(State::Approach.next(), State::Clamp);\n}\n\n#[test]\nfn release_is_final() {\n    assert_eq!(State::Release.next(), State::Release);\n}\n");
    p.commit("teodor", "Test the docking states");
    p.write("README.md", "# orbital\n\nSee `docs/docking.md` for the docking rules and `src/docking.rs` for the state machine.\n");
    p.commit("teodor", "Document docking in the README");
    p.at(2026, 4, 24, 9, 30);
    p.git("ilse", &["switch", "-q", "main"]);
    p.write("docs/docking.md", "Approach at 2.5 m/s (haulers 3 m/s)\nClamp at 5 m\nRelease after 3 s\n");
    p.commit("ilse", "Allow a faster approach for haulers");
    p.git("teodor", &["switch", "-q", "feature/docking"]);
}
