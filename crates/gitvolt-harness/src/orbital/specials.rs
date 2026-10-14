//! The two branches built by hand. `balance/fuel-rework` conflicts with main in a Rust file, a
//! table and an image (the merge tool's showcase). `feature/hud-polish` is set up for an
//! interactive rebase: a WIP commit, a typo to reword, a fixup, a reorder that conflicts, and an
//! early commit main has since changed under it.
//!
//! Their tunes are derived when each commit is made, from the branch's state then (fillers retune
//! these numbers before the fork), and both features hold the keys they derive, so nothing else
//! touches them on main after the fork except the competing change.

use super::art;
use super::corpus::{Corpus, Kind};
use super::model::{Edit, Value};
use super::story::{Derive, Fate, FeaturePlan, Step};
use std::rc::Rc;

pub const FUEL_KEY: &str = "crates/orbital-core/src/ship.rs#const:FUEL_BURN_RATE";
pub const COMMODITIES: &str = "assets/data/economy/commodities.csv";
pub const FUEL_ICON: &str = "assets/ui/icons/fuel.png";
pub const HUD_MARGIN_KEY: &str = "crates/orbital-game/src/hud.rs#const:HUD_MARGIN";
pub const GAUGES: &str = "crates/orbital-game/src/hud_gauges.rs";

pub fn apply(plans: &mut [FeaturePlan], corpus: &Corpus) -> Result<(), String> {
    for p in plans.iter_mut() {
        match p.feature.fate {
            Fate::Conflict => fuel_rework(p, corpus),
            Fate::Irebase => hud_polish(p, corpus)?,
            _ => {}
        }
    }
    Ok(())
}

fn tune_const(key: &str, factor: f64) -> Derive {
    Derive::TuneConst { key: key.into(), factor }
}

fn tune_fuel(column: &str, factor: f64) -> Derive {
    Derive::TuneCell { path: COMMODITIES.into(), row: "fuel_cells".into(), column: column.into(), factor }
}

fn fuel_icon(version: u16) -> Edit {
    Edit::set(FUEL_ICON, Value::Bytes(Rc::from(art::icon("fuel", version).to_png())))
}

fn derived(message: &str, edits: Vec<Edit>, derived: Vec<Derive>) -> Step {
    Step { message: message.into(), edits, derived }
}

/// Every version the corpus tags `@feature` outside `except` (a path), as edits.
fn tagged(corpus: &Corpus, feature: &str, except: &str) -> Vec<Edit> {
    corpus
        .tagged(feature)
        .into_iter()
        .filter(|t| corpus.files[t.file].path != except)
        .map(|t| {
            let f = &corpus.files[t.file];
            let b = &f.blocks[t.block];
            Edit::set(b.key(&f.path), Value::Version(b.versions[t.version].n))
        })
        .collect()
}

/// The ship already burns fuel in proportion to its thrust; the rework makes a burn cheaper in
/// fuel and the fuel dearer, and main's competing change goes the other way on both. Each side
/// also brings what the corpus tags `@fuel-rework` (ship.rs's dry-tank test, rewritten to hold at
/// any burn rate), the same on both, so the merge takes it cleanly.
fn fuel_rework(p: &mut FeaturePlan, corpus: &Corpus) {
    let test = tagged(corpus, "fuel-rework", "");
    let mut main = test.clone();
    main.push(fuel_icon(4));
    p.steps = vec![
        derived("Burn less fuel per unit of thrust and charge more for it", test, vec![tune_const(FUEL_KEY, 0.6), tune_fuel("base_price", 1.25)]),
        Step::new("Show a fuel cell in the HUD instead of a drop", vec![fuel_icon(3)]),
        derived("Make fuel cell prices more volatile", Vec::new(), vec![tune_fuel("volatility", 1.5)]),
    ];
    p.forced_main = Some((26, "wen", derived("Balance fuel for the long hauls", main, vec![tune_const(FUEL_KEY, 1.3), tune_fuel("base_price", 0.8)])));
    p.keys = p.steps.iter().flat_map(|s| s.edits.iter().map(|e| e.key.clone())).chain([FUEL_KEY, COMMODITIES].map(String::from)).collect();
}

fn hud_polish(p: &mut FeaturePlan, corpus: &Corpus) -> Result<(), String> {
    let file = corpus.file(GAUGES).ok_or("corpus/game/specials.txt is missing hud_gauges.rs")?;
    let v = |name: &str, n: u16| -> Result<Edit, String> {
        let b = file
            .blocks
            .iter()
            .find(|b| if name == "header" { b.kind == Kind::Header } else { b.name == name })
            .ok_or_else(|| format!("hud_gauges.rs has no {name}"))?;
        Ok(Edit::set(b.key(GAUGES), Value::Version(n)))
    };
    // What hud-polish tags elsewhere (main.rs's `mod hud_gauges;`) rides with the first commit.
    let elsewhere = tagged(corpus, "hud-polish", GAUGES);
    let mut first = vec![v("header", 1)?, v("draw_gauge_frame", 1)?, v("gauge_colour", 1)?];
    first.extend(elsewhere);
    p.steps = vec![
        Step::new("Draw the HUD gauges with a shared frame", first),
        derived("WIP", vec![v("gauge_colour", 2)?], vec![tune_const(HUD_MARGIN_KEY, 1.5)]),
        Step::new("Add the fuel gague", vec![v("draw_fuel_gauge_framed", 1)?]),
        Step::new("fixup! Draw the HUD gauges with a shared frame", vec![v("draw_gauge_frame", 2)?]),
        Step::new("Test the gauge layout", vec![v("gauge_frame_fits_the_screen", 1)?]),
        Step::new("Tweak the gauge colours again", vec![v("gauge_colour", 3)?]),
        Step::new("Remove the debug prints", vec![v("draw_gauge_frame", 3)?]),
    ];
    p.forced_main = Some((20, "kasimir", derived("Tighten the HUD margins on small screens", Vec::new(), vec![tune_const(HUD_MARGIN_KEY, 0.6)])));
    p.keys = p.steps.iter().flat_map(|s| s.edits.iter().map(|e| e.key.clone())).chain([HUD_MARGIN_KEY.to_string()]).collect();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbital::corpus::{Messages, FEATURES};
    use crate::orbital::story::{parse_features, plan};

    fn plans() -> Vec<FeaturePlan> {
        let corpus = Corpus::load();
        let features = parse_features(FEATURES).unwrap();
        let mut plans = plan(&corpus, &features, &Messages::load(), &|_: &str, _| Rc::from(&b"x"[..]), &mut crate::media::rng::Rng::new(1)).unwrap();
        apply(&mut plans, &corpus).unwrap();
        plans
    }

    #[test]
    fn the_rebase_branch_has_its_seven_commits_and_mains_competing_change() {
        let plans = plans();
        let p = plans.iter().find(|p| p.feature.slug == "hud-polish").unwrap();
        let subjects: Vec<&str> = p.steps.iter().map(|s| s.message.as_str()).collect();
        assert_eq!(subjects, ["Draw the HUD gauges with a shared frame", "WIP", "Add the fuel gague", "fixup! Draw the HUD gauges with a shared frame", "Test the gauge layout", "Tweak the gauge colours again", "Remove the debug prints"]);
        assert!(p.steps[0].edits.iter().any(|e| e.key == "crates/orbital-game/src/main.rs#header"), "the mod line rides with the first commit");
        assert!(matches!(&p.steps[1].derived[..], [Derive::TuneConst { key, .. }] if key == HUD_MARGIN_KEY));
        let (hours, who, step) = p.forced_main.as_ref().unwrap();
        assert_eq!((*hours, *who, step.message.as_str()), (20, "kasimir", "Tighten the HUD margins on small screens"));
        assert!(p.keys.contains(HUD_MARGIN_KEY) && p.keys.contains(&format!("{GAUGES}#item:gauge_colour")));
    }

    #[test]
    fn the_conflict_branch_and_main_change_the_same_three_files() {
        let plans = plans();
        let p = plans.iter().find(|p| p.feature.slug == "fuel-rework").unwrap();
        assert_eq!(p.steps.len(), 3);
        let (_, who, main) = p.forced_main.as_ref().unwrap();
        assert_eq!(*who, "wen");
        assert!(main.edits.iter().any(|e| e.key == FUEL_ICON));
        assert!(main.derived.iter().any(|d| matches!(d, Derive::TuneConst { key, .. } if key == FUEL_KEY)));
        assert!(main.derived.iter().any(|d| matches!(d, Derive::TuneCell { path, row, .. } if path == COMMODITIES && row == "fuel_cells")));
        assert!(p.steps[0].edits.iter().all(|e| main.edits.contains(e)), "the rewritten test is the same on both sides, so it merges cleanly");
        for k in [FUEL_KEY, COMMODITIES, FUEL_ICON] {
            assert!(p.keys.contains(k), "{k} held");
        }
    }

    #[test]
    fn the_keys_they_need_exist_in_the_corpus() {
        let corpus = Corpus::load();
        let has_const = |key: &str| {
            let (path, name) = key.split_once("#const:").unwrap();
            corpus.file(path).is_some_and(|f| f.blocks.iter().any(|b| b.name == name))
        };
        assert!(has_const(FUEL_KEY) && has_const(HUD_MARGIN_KEY));
        let table = corpus.file(COMMODITIES).unwrap();
        assert!(table.blocks[0].versions.iter().all(|v| v.text.lines().any(|l| l.starts_with("fuel_cells,"))));
    }
}
