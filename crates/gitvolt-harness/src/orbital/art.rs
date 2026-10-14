//! Orbital's sprites, by name and version. The masks are drawn by hand; shading, outlines and
//! dithering come from `media::sprites`.

use super::SEED;
use crate::media::canvas::Canvas;
use crate::media::palette::{GOLD, GREEN, RED, STEEL, TEAL, VIOLET};
use crate::media::rng::Rng;
use crate::media::sprites::{self, PlanetSpec, ShipSpec, StationSpec, Surface};

pub const SHIPS: [&str; 6] = ["scout", "hauler", "interceptor", "miner", "courier", "freighter"];
pub const STATIONS: [&str; 3] = ["ring", "depot", "outpost"];
pub const PLANETS: [&str; 5] = ["verdant", "cinder", "glacier", "tempest", "dustball"];
pub const ICONS: [&str; 8] = ["fuel", "cargo", "credits", "shield", "map", "dock", "trade", "settings"];

/// Every seed here is named for its sprite and version, so a new version never repaints another.
fn seed(kind: &str, name: &str, version: u16) -> u64 {
    Rng::named(SEED, &format!("{kind}:{name}:{version}")).next_u64()
}

// Ship masks: the left half of each ship, centre column included (see `sprites::ShipSpec`).
// Sizes include the outline. Enclosed '.'s are panel seams: the outline draws them as dark lines.

// A small arrow: swept wings with drooping tips, a stripe down the spine. (13×14)
const SCOUT_V1: &[&str] = &[
    ".....#", "....##", "....#c", "...##c", "...#cc", "...##a", "..###a", ".####a", "#####a", "##.##a", "#..###", "...#ee",
];
// The rework: wings 2 px wider, the stripes moved onto them, a longer canopy. (15×15)
const SCOUT_V2: &[&str] = &[
    "......#", ".....##", ".....#c", "....##c", "....#cc", "....#cc", "....###", "...##a#", "..##a##", ".##a###", "##a####", "#a..###", "#...#ee",
];
// The repaint: v2 with a wider, deeper engine. (15×15)
const SCOUT_V3: &[&str] = &[
    "......#", ".....##", ".....#c", "....##c", "....#cc", "....#cc", "....###", "...##a#", "..##a##", ".##a###", "##a####", "#a.##ee", "#..#eee",
];
// The HD scout: wing and spine stripes, panel seams, running lights, twin engines. (21×21)
const SCOUT_V4: &[&str] = &[
    ".........#", "........##", "........#c", ".......##c", ".......#cc", ".......#cc", "......##cc", "......####", "......####", ".....###.#", "....####a#", "...#####a#", "..###a##a#", ".###a###a#", "l##a####a#", "##a#####.#", "##..##.###", "#...##.#ee", "....#eee##",
];
// A cab towing a ribbed cargo box, rails along its sides. (17×19)
const HAULER_V1: &[&str] = &[
    ".......#", "......##", "......#c", ".....##c", ".....#cc", ".....###", "......##", "..######", ".a######", ".a#.....", ".a######", ".a######", ".a#.....", ".a######", "..######", "...##e##", "...#eee#",
];
// The box narrowed, with cargo pods strutted on either side. (17×19)
const HAULER_V2: &[&str] = &[
    ".......#", "......##", "......#c", ".....##c", ".....#cc", ".....###", "......##", ".a.#####", "aa######", "aa.#....", "aa.#####", "aa######", "aa.#....", "aa.#####", ".a.#####", "...##e##", "...#eee#",
];
// A long dart: needle nose, delta wings at the tail. (15×19)
const INTERCEPTOR_V1: &[&str] = &[
    "......#", "......#", "......#", ".....##", ".....#c", ".....#c", "....##c", "....#cc", "....###", "....##a", "...###a", "...###a", "..####a", ".#####a", "######a", "#####.a", "....#e#",
];
// Forward-swept wings, their tips level with the canopy, and two engines. (15×19)
const INTERCEPTOR_V2: &[&str] = &[
    "......#", "......#", "......#", ".....##", ".....#c", ".....#c", "....##c", "....#cc", "#...###", "##..##a", ".##.##a", ".#####a", "..####a", "...###a", "...##.a", "..#ee#.", "..#ee#.",
];
// A drill nose between two claws, a wide visor, a chunky body. (15×15)
const MINER: &[&str] = &[
    ".##...#", "##...##", "#....##", "##..###", ".##.###", ".######", "#######", "#a#cccc", "#a#####", "#a#####", "#a#####", ".######", "..##ee#",
];
// A slim needle with a long canopy, straight stub wings and tail fins. (13×19)
const COURIER: &[&str] = &[
    ".....#", "....##", "....#c", "....#c", "...##c", "...#cc", "...#cc", "...##c", "...###", "aa####", ".a####", "...##a", "...##a", "...##a", "..###a", ".##.#e", ".#..ee",
];
// A long spine carrying three pairs of cargo blocks. (21×24)
const FREIGHTER: &[&str] = &[
    ".........#", "........##", "........#c", ".......##c", ".......#cc", ".......###", "........##", "..#####.##", "..##a#####", "..##a##.##", "..#####.##", "........##", "..#####.##", "..l#a#####", "..##a##.##", "..#####.##", "........##", "..#####.##", "..##a#####", "..##a##.##", "..#####.##", ".......#e#",
];

pub fn ship(name: &str, version: u16) -> Canvas {
    let (half, accent, canopy): (&[&str], &[u8], &[u8]) = match (name, version) {
        ("scout", 1) => (SCOUT_V1, GOLD, TEAL),
        ("scout", 2) => (SCOUT_V2, TEAL, TEAL),
        ("scout", 3) => (SCOUT_V3, RED, TEAL),
        ("scout", 4) => (SCOUT_V4, GOLD, TEAL),
        ("hauler", 1) => (HAULER_V1, GOLD, TEAL),
        ("hauler", 2) => (HAULER_V2, VIOLET, TEAL),
        ("interceptor", 1) => (INTERCEPTOR_V1, RED, TEAL),
        ("interceptor", 2) => (INTERCEPTOR_V2, RED, TEAL),
        ("miner", 1) => (MINER, TEAL, GOLD),
        ("courier", 1) => (COURIER, VIOLET, TEAL),
        ("freighter", 1) => (FREIGHTER, GOLD, TEAL),
        _ => panic!("no ship {name} v{version}"),
    };
    sprites::ship(&ShipSpec { half, hull: STEEL, accent, canopy })
}

/// The faction-tinted scout repainted in violet: Orbital's staged, uncommitted sprite (main
/// already has the red v3, so the working tree needs a paint of its own).
pub fn scout_repaint() -> Canvas {
    sprites::ship(&ShipSpec { half: SCOUT_V3, hull: STEEL, accent: VIOLET, canopy: TEAL })
}

pub fn station(name: &str, version: u16) -> Canvas {
    let spec = match (name, version) {
        ("ring", 1) => StationSpec { size: 64, spokes: 6, panels: true, hull: STEEL, glass: TEAL, lights_on: false },
        ("ring", 2) => StationSpec { size: 64, spokes: 8, panels: true, hull: STEEL, glass: TEAL, lights_on: true },
        ("depot", 1) => StationSpec { size: 48, spokes: 4, panels: false, hull: STEEL, glass: GOLD, lights_on: true },
        ("outpost", 1) => StationSpec { size: 40, spokes: 3, panels: true, hull: STEEL, glass: TEAL, lights_on: true },
        _ => panic!("no station {name} v{version}"),
    };
    sprites::station(&spec)
}

/// Version 2 is the full-size planet with its atmosphere; version 1 is four pixels smaller and
/// bare. The dustball has no air, so it never gets an atmosphere, only more craters in v2.
pub fn planet(name: &str, version: u16) -> Canvas {
    let v2 = match version {
        1 => false,
        2 => true,
        _ => panic!("no planet {name} v{version}"),
    };
    let (radius, surface, ramp_a, ramp_b, ring, glow) = match name {
        "verdant" => (28, Surface::Oceanic, TEAL, GREEN, None, Some(TEAL[4])),
        "cinder" => (22, Surface::Molten, RED, GOLD, None, Some(GOLD[3])),
        "glacier" => (24, Surface::Icy, STEEL, TEAL, None, Some(TEAL[3])),
        "tempest" => (40, Surface::Banded, GOLD, VIOLET, Some(STEEL), Some(GOLD[4])),
        "dustball" => (16, Surface::Rocky { craters: if v2 { 9 } else { 6 } }, STEEL, STEEL, None, None),
        _ => panic!("no planet {name}"),
    };
    let (radius, atmosphere) = if v2 { (radius, glow) } else { (radius - 4, None) };
    sprites::planet(&PlanetSpec { radius, surface, ramp_a, ramp_b, seed: seed("planet", name, version), ring, atmosphere })
}

pub fn asteroids(version: u16) -> Canvas {
    let frames = match version {
        1 => sprites::asteroid_frames(seed("asteroids", "field", version), 24, 8, STEEL),
        2 => sprites::asteroid_frames(seed("asteroids", "field", version), 32, 8, &GOLD[..4]),
        _ => panic!("no asteroids v{version}"),
    };
    sprites::sheet(&frames, 8)
}

pub fn explosion(version: u16) -> Canvas {
    let (size, frames) = match version {
        1 => (32, 6),
        2 => (40, 8),
        _ => panic!("no explosion v{version}"),
    };
    sprites::sheet(&sprites::explosion_frames(seed("explosion", "blast", version), size, frames), frames)
}

pub fn thruster_frames(version: u16) -> Vec<Canvas> {
    match version {
        1 => sprites::thruster_frames(seed("thruster", "main", version), 8, 12, 4, GOLD),
        2 => sprites::thruster_frames(seed("thruster", "main", version), 10, 16, 4, TEAL),
        _ => panic!("no thruster v{version}"),
    }
}

pub fn thruster(version: u16) -> Canvas {
    sprites::sheet(&thruster_frames(version), 4)
}

// Icon masks: '#' body, 'o' highlight, '.' empty (an enclosed '.' is an engraved line).

const FUEL_V1: &[&str] = &[
    "............", ".....#......", ".....#......", "....###.....", "...#####....", "...#####....", "..#######...", "..#######...", "..#######...", "...#####....", "....###.....", "............",
];
const FUEL_V2: &[&str] = &[
    "............", ".....#......", ".....#......", "....###.....", "...#####....", "...#####....", "..#######...", "..#.....#...", "..#######...", "...#####....", "....###.....", "............",
];
const FUEL_V3: &[&str] = &[
    "............", "............", ".#########..", ".#.......#..", ".#.oo.##.##.", ".#.oo.##.##.", ".#.oo.##.##.", ".#.......#..", ".#########..", "............", "............", "............",
];
const FUEL_V4: &[&str] = &[
    "............", ".....#......", "....###.....", "....###.....", "...#####....", "..##o####...", ".##o######..", ".#o#######..", ".#########..", "..#######...", "...#####....", "............",
];
const CARGO: &[&str] = &[
    "............", ".oooooooooo.", ".##########.", ".##.####.##.", ".##.####.##.", ".##########.", ".##.####.##.", ".##.####.##.", ".##########.", ".##########.", "............", "............",
];
const CREDITS: &[&str] = &[
    "............", "....####....", "..#oo#####..", "..#o....##..", ".##.####.##.", ".##.####.##.", ".##.####.##.", ".##.####.##.", "..##....##..", "..########..", "....####....", "............",
];
const SHIELD: &[&str] = &[
    "............", ".##########.", ".#oo#######.", ".#o########.", ".##########.", ".####..####.", ".####..####.", ".###....###.", "..##....##..", "...######...", "....####....", "............",
];
const MAP: &[&str] = &[
    "............", ".###....###.", ".###oooo###.", ".###oooo###.", ".###o.o.###.", ".###oo.o###.", ".###o.o.###.", ".###oooo###.", ".###oooo###.", ".###oooo###.", "....oooo....", "............",
];
const DOCK: &[&str] = &[
    "............", ".....##.....", "....#..#....", ".....##.....", "...######...", ".....##.....", ".....##.....", ".#...##...#.", ".##..##..##.", "..##.##.##..", "...######...", "............",
];
const TRADE: &[&str] = &[
    "............", ".......#....", ".......##...", ".#########..", ".......##...", ".......#....", "....#.......", "...##.......", "..#########.", "...##.......", "....#.......", "............",
];
const SETTINGS: &[&str] = &[
    "............", ".....##.....", "..#.####.#..", "..########..", ".##########.", ".###....###.", ".###....###.", ".##########.", "..########..", "..#.####.#..", ".....##.....", "............",
];

const MINE: &[&str] = &[
    "............", "..########..", ".##########.", ".###....###.", ".#.....###..", "......###...", ".....###....", "....###.....", "...###......", "..###.......", "..##........", "............",
];
const TARGET: &[&str] = &[
    "............", ".....##.....", "...######...", "..###..###..", "..##....##..", ".###.##.###.", ".###.##.###.", "..##....##..", "..###..###..", "...######...", ".....##.....", "............",
];

pub fn icon_mask(name: &str, version: u16) -> &'static [&'static str] {
    match (name, version) {
        ("fuel", 1) => FUEL_V1,
        ("fuel", 2) => FUEL_V2,
        ("fuel", 3) => FUEL_V3,
        ("fuel", 4) => FUEL_V4,
        ("cargo", 1) => CARGO,
        ("credits", 1) => CREDITS,
        ("shield", 1) => SHIELD,
        ("map", 1) => MAP,
        ("dock", 1) => DOCK,
        ("trade", 1) => TRADE,
        ("settings", 1) => SETTINGS,
        ("mine", 1) => MINE,
        ("target", 1) => TARGET,
        _ => panic!("no icon {name} v{version}"),
    }
}

pub fn icon(name: &str, version: u16) -> Canvas {
    let ramp = match name {
        "fuel" => GREEN,
        "cargo" | "settings" => STEEL,
        "credits" | "trade" => GOLD,
        "shield" => TEAL,
        "map" | "mine" => VIOLET,
        "target" => RED,
        "dock" => RED,
        _ => panic!("no icon {name}"),
    };
    let mask = icon_mask(name, version);
    let mut c = sprites::icon(mask, ramp);
    if name == "fuel" {
        // GREEN has only three steps, the top one the body's own lit side, so the fuel icons
        // borrow TEAL's lightest for their highlights.
        for (y, row) in mask.iter().enumerate() {
            for (x, _) in row.bytes().enumerate().filter(|&(_, b)| b == b'o') {
                c.set(x as i32, y as i32, TEAL[4]);
            }
        }
    }
    c
}

/// Every sprite at every version, each with the scale the preview shows it at.
pub fn preview_items() -> Vec<(String, Canvas, u32)> {
    let mut out = Vec::new();
    for (name, top) in [("scout", 4), ("hauler", 2), ("interceptor", 2), ("miner", 1), ("courier", 1), ("freighter", 1)] {
        for v in 1..=top {
            out.push((format!("ship-{name}-v{v}"), ship(name, v), 6));
        }
    }
    for (name, top) in [("ring", 2), ("depot", 1), ("outpost", 1)] {
        for v in 1..=top {
            out.push((format!("station-{name}-v{v}"), station(name, v), 4));
        }
    }
    for name in PLANETS {
        for v in 1..=2 {
            out.push((format!("planet-{name}-v{v}"), planet(name, v), 3));
        }
    }
    for v in 1..=2 {
        out.push((format!("sheet-asteroids-v{v}"), asteroids(v), 4));
        out.push((format!("sheet-explosion-v{v}"), explosion(v), 4));
        out.push((format!("sheet-thruster-v{v}"), thruster(v), 6));
    }
    for name in ICONS {
        for v in 1..=if name == "fuel" { 4 } else { 1 } {
            out.push((format!("icon-{name}-v{v}"), icon(name, v), 8));
        }
    }
    for v in 1..=2 {
        out.push((format!("scene-title-v{v}"), super::scenes::title(v), 2));
    }
    for kind in ["orbit", "trade", "dock"] {
        for v in 1..=2 {
            out.push((format!("scene-{kind}-v{v}"), super::scenes::screenshot(kind, v), 2));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<(String, Canvas)> {
        preview_items().into_iter().map(|(n, c, _)| (n, c)).collect()
    }

    #[test]
    fn every_listed_version_renders_and_masks_are_well_formed() {
        let items = all();
        assert!(items.len() >= 40, "{}", items.len());
        for name in ICONS {
            for v in 1..=if name == "fuel" { 4 } else { 1 } {
                let m = icon_mask(name, v);
                assert_eq!(m.len(), 12, "{name} v{v}");
                assert!(m.iter().all(|r| r.len() == 12 && r.bytes().all(|b| b"#o.".contains(&b))), "{name} v{v}");
            }
        }
    }

    #[test]
    fn ships_are_detailed_and_reworks_differ() {
        for name in SHIPS {
            assert!(ship(name, 1).colours() >= 7, "{name} is shaded");
        }
        for (name, top) in [("scout", 4), ("hauler", 2), ("interceptor", 2)] {
            for v in 2..=top {
                assert_ne!(ship(name, v).px, ship(name, v - 1).px, "{name} v{v} changes something");
            }
        }
        assert!(ship("scout", 4).w > ship("scout", 2).w, "the HD scout is bigger");
        assert_ne!(icon("fuel", 3).px, icon("fuel", 4).px, "the two competing fuel icons differ");
    }

    #[test]
    fn silhouettes_are_distinct() {
        let masks: Vec<Vec<bool>> = SHIPS.iter().map(|n| ship(n, 1).px.iter().map(|&p| p != 0).collect()).collect();
        for i in 0..masks.len() {
            for j in i + 1..masks.len() {
                assert_ne!(masks[i], masks[j], "{} and {}", SHIPS[i], SHIPS[j]);
            }
        }
    }

    #[test]
    fn pngs_stay_small() {
        // The scenes have their own budgets (`scenes::tests`).
        for (name, c) in all().into_iter().filter(|(n, _)| !n.starts_with("scene-")) {
            let limit = if name.starts_with("sheet") || name.contains("asteroids") || name.contains("explosion") { 32_000 } else { 12_000 };
            assert!(c.to_png().len() < limit, "{name}: {} bytes", c.to_png().len());
        }
    }
}
