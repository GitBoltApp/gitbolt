//! Orbital: a fictional 2D space-trading game in Rust ("a small space-trading game about
//! orbits, cargo and bad decisions"), generated as a lived-in repository for GitVolt's demo.

pub mod art;
pub mod assets;
pub mod calendar;
pub mod content;
pub mod corpus;
pub mod data;
pub mod design_doc;
pub mod finish;
pub mod forge;
pub mod glyphs;
pub mod history;
pub mod model;
pub mod people;
pub mod releases;
pub mod scenes;
pub mod schedule;
pub mod specials;
pub mod story;

/// Every random choice in Orbital's repository derives from this.
pub const SEED: u64 = 0x000B_17A1_2024;

/// The random choices of Orbital's history, from the story through the finish.
pub(crate) fn history_rng() -> crate::media::rng::Rng {
    crate::media::rng::Rng::named(SEED, "history")
}

/// Builds Orbital into `r` (fresh from `TestRepo::init_at`): the whole history through one
/// fast-import, then what needs real git (`finish`). Writes `<root>/repo`, `<root>/origin.git`
/// and `<root>/forge.json`.
pub fn build(r: &gitvolt_core::testing::TestRepo) {
    let corpus = corpus::Corpus::load();
    let messages = corpus::Messages::load();
    let features = story::parse_features(corpus::FEATURES).expect("features.txt");
    let mut rng = history_rng();
    let asset = |path: &str, version: u16| -> std::rc::Rc<[u8]> { std::rc::Rc::from(assets::bytes(path, version)) };
    let mut plans = story::plan(&corpus, &features, &messages, &asset, &mut rng).expect("the story");
    specials::apply(&mut plans, &corpus).expect("the special branches");
    let content = content::Content { corpus: &corpus, sections: Default::default() };
    let mut hist = history::History::new();
    let outcome = schedule::run(&plans, &content, &messages, &mut hist, &mut rng, &releases::RELEASES, schedule::TARGET_COMMITS);
    let marks_file = r.root().join(".orbital-marks");
    history::fast_import(&r.path().join(".git"), &hist.finish(), Some(&marks_file)).expect("fast-import Orbital's history");
    let marks = history::read_marks(&marks_file);
    std::fs::remove_file(&marks_file).expect("remove the marks file");
    finish::finish(r, &outcome, &marks, &content).expect("finish Orbital");
}
