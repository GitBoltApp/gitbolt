//! Orbital's title illustration, press screenshots and trailer frames, composed from the
//! sprites on a dithered sky. Every sprite is lit from the top left, so the scenes keep that
//! light: extrusions and drop shadows fall to the bottom right.

use super::{art, glyphs, SEED};
use crate::media::canvas::{tone, Canvas, Dither};
use crate::media::font::{draw_text, text_width, Glyph};
use crate::media::palette::{GOLD, GREEN, RED, SPACE, STEEL, TEAL, VIOLET};
use crate::media::rng::Rng;
use crate::media::scene::{gauge, nebula, panel, sky, starfield};
use crate::media::sprites::{asteroid_frames, planet, PlanetSpec, Surface};

fn seed(name: &str) -> u64 {
    Rng::named(SEED, name).next_u64()
}

/// The word in the HUD font at `scale`: a gold face shading from cream at the top to orange
/// at the bottom with a lit top edge, extruded towards the bottom right, outlined and shadowed.
/// `reveal` (0–1) draws only that fraction of it from the left, for a wipe.
fn logo(c: &mut Canvas, text: &str, x: i32, y: i32, scale: i32, reveal: f32) {
    let glyphs = glyphs::text_glyphs();
    let mut ink = Canvas::new(c.w, c.h);
    draw_text(&mut ink, &glyphs, text, x, y, scale, GOLD[3]);
    let cut = x + ((text_width(text, scale) + scale) as f32 * reveal.clamp(0.0, 1.0)) as i32;
    for py in 0..c.h as i32 {
        for px in cut..c.w as i32 {
            ink.set(px, py, 0);
        }
    }
    let depth = (scale / 2).max(1);
    let mut body = Canvas::new(c.w, c.h);
    for k in (1..=depth).rev() {
        for py in 0..c.h as i32 {
            for px in 0..c.w as i32 {
                if ink.get(px, py) != 0 {
                    body.set(px + k, py + k, if k == depth { GOLD[0] } else { GOLD[1] });
                }
            }
        }
    }
    let height = (7 * scale) as f32;
    for py in 0..c.h as i32 {
        for px in 0..c.w as i32 {
            if ink.get(px, py) == 0 {
                continue;
            }
            let colour = if ink.get(px, py - 1) == 0 {
                GOLD[5]
            } else {
                let t = 0.95 - (py - y) as f32 / height * 0.9;
                tone(&GOLD[2..], t, px, py, Dither::Checker(0.3))
            };
            body.set(px, py, colour);
        }
    }
    body.outline(|_| SPACE[0]);
    let mut shadow = Canvas::new(c.w, c.h);
    for (i, p) in body.px.iter().enumerate() {
        if *p != 0 {
            shadow.px[i] = SPACE[0];
        }
    }
    c.blit(&shadow, depth + 1, depth + 1);
    c.blit(&body, 0, 0);
}

/// HUD text in the game's font, one font pixel per pixel, with a one-pixel drop shadow so it
/// reads over stars and clouds.
fn hud(c: &mut Canvas, glyphs: &[Glyph], t: &str, x: i32, y: i32, colour: u8) -> i32 {
    draw_text(c, glyphs, t, x + 1, y + 1, 1, SPACE[0]);
    draw_text(c, glyphs, t, x, y, 1, colour)
}

/// Text centred on `cx`.
fn centred(c: &mut Canvas, glyphs: &[Glyph], t: &str, cx: i32, y: i32, scale: i32, colour: u8) {
    let x = cx - text_width(t, scale) / 2;
    draw_text(c, glyphs, t, x + scale.max(2) / 2, y + scale.max(2) / 2, scale, SPACE[0]);
    draw_text(c, glyphs, t, x, y, scale, colour);
}

/// Corner brackets around a target, the HUD's lock-on marker.
fn bracket(c: &mut Canvas, x: i32, y: i32, w: i32, h: i32, colour: u8) {
    for (cx, cy, dx, dy) in [(x, y, 1, 1), (x + w - 1, y, -1, 1), (x, y + h - 1, 1, -1), (x + w - 1, y + h - 1, -1, -1)] {
        for k in 0..4 {
            c.set(cx + k * dx, cy, colour);
            c.set(cx, cy + k * dy, colour);
        }
    }
}

/// An orbit's path around (cx, cy): its far half (above the centre) goes behind whatever the
/// caller draws next, its near half is returned to blit in front of it.
fn orbit(c: &mut Canvas, cx: f32, cy: f32, rx: f32, ry: f32, colour: u8, dash: u32) -> Canvas {
    let mut path = Canvas::new(c.w, c.h);
    path.ellipse(cx, cy, rx, ry, colour, dash);
    let mut near = Canvas::new(c.w, c.h);
    for y in 0..c.h as i32 {
        for x in 0..c.w as i32 {
            let p = path.get(x, y);
            if p == 0 {
                continue;
            }
            if (y as f32) < cy { c.set(x, y, p) } else { near.set(x, y, p) }
        }
    }
    near
}

/// A ship with its flame under the nozzle, both `scale`d, centred on (cx, cy).
fn ship_with_flame(c: &mut Canvas, ship: &Canvas, flame: &Canvas, cx: i32, cy: i32, scale: u32) {
    let (ship, flame) = (ship.scaled(scale), flame.scaled(scale));
    let (x, y) = (cx - ship.w as i32 / 2, cy - ship.h as i32 / 2);
    c.blit(&flame, cx - flame.w as i32 / 2, y + ship.h as i32 - 2 * scale as i32);
    c.blit(&ship, x, y);
}

/// The key art: the logo over a nebula, a ringed gas giant to the lower right with the scout
/// climbing out of its orbit, a station and a moon in the distance, rocks in the foreground.
/// v1 is the early title screen's art (first sprites, capitals only); v2 the reworked one.
pub fn title(version: u16) -> Canvas {
    let v = version.min(2);
    let s = seed(&format!("title:{version}"));
    let glyphs = glyphs::text_glyphs();
    let mut c = Canvas::new(480, 270);
    sky(&mut c, s);
    nebula(&mut c, s, VIOLET, TEAL, if v >= 2 { 1.0 } else { 0.75 });
    starfield(&mut c, s, 460);

    let moon = art::planet("dustball", v);
    c.blit(&moon, 448 - moon.w as i32 / 2, 30 - moon.h as i32 / 2);
    c.blit(&art::station("ring", v), 18, 116);

    let (gx, gy) = (372.0, 200.0);
    let near = orbit(&mut c, gx, gy, 176.0, 58.0, TEAL[3], 4);
    let ring = if v >= 2 { STEEL } else { &STEEL[..5] };
    let giant = planet(&PlanetSpec { radius: 88, surface: Surface::Banded, ramp_a: GOLD, ramp_b: VIOLET, seed: s, ring: Some(ring), atmosphere: (v >= 2).then_some(GOLD[4]) });
    c.blit(&giant, gx as i32 - giant.w as i32 / 2, gy as i32 - giant.h as i32 / 2);
    c.blit(&near, 0, 0);

    // The scout at the orbit's left end, where it runs straight up the screen.
    let flame = &art::thruster_frames(v)[1];
    ship_with_flame(&mut c, &art::ship("scout", v), flame, gx as i32 - 176, gy as i32 - 22, 4);

    let rocks = asteroid_frames(s, 24, 8, if v >= 2 { &GOLD[..4] } else { STEEL });
    c.blit(&rocks[2].scaled(3), -18, 214);
    c.blit(&rocks[5].scaled(2), 62, 240);
    c.blit(&rocks[7], 104, 226);

    logo(&mut c, "ORBITAL", 240 - text_width("ORBITAL", 8) / 2, 22, 8, 1.0);
    let tagline = if v >= 2 { "A small space-trading game" } else { "A SMALL SPACE-TRADING GAME" };
    centred(&mut c, &glyphs, tagline, 240, 96, 2, if v >= 2 { TEAL[4] } else { STEEL[4] });
    c
}

/// A panel with a title strip (v2's HUD polish; v1's panels are plain).
fn titled_panel(c: &mut Canvas, glyphs: &[Glyph], x: i32, y: i32, w: i32, h: i32, title: Option<&str>) {
    panel(c, x, y, w, h);
    if let Some(title) = title {
        c.fill_rect(x + 2, y + 2, w - 4, 11, TEAL[0]);
        c.fill_rect(x + 2, y + 13, w - 4, 1, TEAL[1]);
        draw_text(c, glyphs, title, x + 5, y + 4, 1, TEAL[4]);
    }
}

/// An icon with a value beside it, for the HUD's status rows.
fn stat(c: &mut Canvas, glyphs: &[Glyph], icon: &str, value: &str, x: i32, y: i32, colour: u8) {
    c.blit(&art::icon(icon, 1), x, y);
    hud(c, glyphs, value, x + 14, y + 2, colour);
}

/// Press screenshots, 320×180 as the game renders them (sprites at 1:1; the dock's camera
/// zooms 2×): "orbit" (the flight view with a transfer planned), "trade" (a station market),
/// "dock" (the final approach). v2 is the retake after the HUD polish: titled panels, icons,
/// later numbers.
pub fn screenshot(kind: &str, version: u16) -> Canvas {
    let v2 = version >= 2;
    let s = seed(&format!("screenshot:{kind}"));
    let glyphs = glyphs::text_glyphs();
    let g = &glyphs[..];
    let mut c = Canvas::new(320, 180);
    sky(&mut c, s);
    nebula(&mut c, s, VIOLET, TEAL, 0.45);
    starfield(&mut c, s, 170);
    let flame = &art::thruster_frames(2)[if v2 { 2 } else { 0 }];
    match kind {
        "orbit" => {
            let (px, py) = (138.0, 98.0);
            let current = orbit(&mut c, px, py, 98.0, 42.0, TEAL[2], 0);
            // The planned transfer shares the current orbit's left end and reaches out to the depot.
            let transfer = orbit(&mut c, px + 44.0, py - 4.0, 142.0, 62.0, GOLD[3], 2);
            let depot = art::station("depot", 1);
            let (dx, dy) = (252, 44);
            c.blit(&depot, dx - depot.w as i32 / 2, dy - depot.h as i32 / 2);
            bracket(&mut c, dx - 27, dy - 27, 54, 54, GOLD[4]);
            hud(&mut c, g, if v2 { "Halden Depot" } else { "HALDEN DEPOT" }, dx - 35, dy + 30, GOLD[4]);
            let world = planet(&PlanetSpec { radius: 40, surface: Surface::Oceanic, ramp_a: TEAL, ramp_b: GREEN, seed: s, ring: None, atmosphere: Some(TEAL[4]) });
            c.blit(&world, px as i32 - world.w as i32 / 2, py as i32 - world.h as i32 / 2);
            c.blit(&current, 0, 0);
            c.blit(&transfer, 0, 0);
            // The ship at the current orbit's right end, climbing; v2 is a moment later.
            let a: f32 = if v2 { -0.22 } else { 0.0 };
            let (sx, sy) = (px + 98.0 * a.cos(), py + 42.0 * a.sin());
            ship_with_flame(&mut c, &art::ship("scout", 2), flame, sx as i32, sy as i32 - 2, 1);
            c.set(sx as i32, sy as i32 - 13, GOLD[5]);

            titled_panel(&mut c, g, 6, 6, 100, if v2 { 60 } else { 50 }, v2.then_some("Kestrel"));
            let top = if v2 { 21 } else { 11 };
            if !v2 {
                hud(&mut c, g, "KESTREL", 12, top, GOLD[4]);
            }
            let (alt, vel) = if v2 { ("Alt 1,262 km", "Vel 3.11 km/s") } else { ("ALT 1,240 KM", "VEL 3.18 KM/S") };
            hud(&mut c, g, alt, 12, top + if v2 { 0 } else { 11 }, STEEL[4]);
            hud(&mut c, g, vel, 12, top + if v2 { 11 } else { 22 }, STEEL[4]);
            if v2 {
                c.blit(&art::icon("fuel", 2), 10, 43);
                gauge(&mut c, 25, 47, 75, 0.58, GOLD);
            } else {
                gauge(&mut c, 12, 45, 88, 0.62, GOLD);
            }
            titled_panel(&mut c, g, 226, 128, 88, 46, v2.then_some("Transfer"));
            let lines: [&str; 3] = if v2 { ["", "Burn in 0:31", "Dv 412 m/s"] } else { ["TRANSFER", "BURN IN 0:42", "DV 412 M/S"] };
            for (k, line) in lines.iter().enumerate() {
                hud(&mut c, g, line, 232, if v2 { 136 } else { 133 } + 11 * k as i32, if k == 0 { TEAL[4] } else { STEEL[4] });
            }
            stat(&mut c, g, "credits", if v2 { "4,120" } else { "3,860" }, 6, 162, GOLD[4]);
            stat(&mut c, g, "cargo", "18/24", 62, 162, STEEL[4]);
        }
        "trade" => {
            let world = art::planet("glacier", 2);
            c.blit(&world, 296 - world.w as i32 / 2, 26 - world.h as i32 / 2);
            let station = art::station("ring", 2);
            c.blit(&station, 258 - station.w as i32 / 2, 66 - station.h as i32 / 2);
            // Our hauler, docked at the ring's lower port.
            let hauler = art::ship("hauler", 2);
            c.blit(&hauler, 258 - hauler.w as i32 / 2, 98);

            titled_panel(&mut c, g, 8, 8, 196, 164, v2.then_some("Halden Depot \u{b7} Market"));
            let top = if v2 { 20 } else { 13 };
            if !v2 {
                hud(&mut c, g, "HALDEN DEPOT - MARKET", 14, top, GOLD[4]);
            }
            let head = top + if v2 { 5 } else { 13 };
            for (t, x) in [("Item", 22), ("Buy", 130), ("Sell", 166)] {
                draw_text(&mut c, g, &if v2 { t.to_string() } else { t.to_uppercase() }, x, head, 1, TEAL[3]);
            }
            c.fill_rect(14, head + 10, 184, 1, TEAL[1]);
            let rows: [(&str, u32, u32, i8); 7] = [
                ("Fuel cells", 84, 79, 1),
                ("Water ice", 12, 10, -1),
                ("Iron ore", 31, 27, 0),
                ("Alloy plate", 140, 131, 1),
                ("Medkits", 210, 196, -1),
                ("Circuitry", 355, 338, 1),
                ("Coolant", 46, 41, 0),
            ];
            for (i, &(name, buy, sell, trend)) in rows.iter().enumerate() {
                let y = head + 15 + i as i32 * 14;
                // Economy drift between the takes: prices move a little.
                let (buy, sell) = if v2 { (buy + buy / 9, sell + sell / 9) } else { (buy, sell) };
                let selected = i == 3;
                if selected {
                    c.fill_rect(12, y - 3, 188, 13, SPACE[3]);
                    draw_text(&mut c, g, ">", 14, y, 1, GOLD[5]);
                }
                let name = if v2 { name.to_string() } else { name.to_uppercase() };
                draw_text(&mut c, g, &name, 22, y, 1, if selected { STEEL[5] } else { STEEL[4] });
                for (value, right) in [(buy, 153), (sell, 189)] {
                    let t = value.to_string();
                    draw_text(&mut c, g, &t, right - text_width(&t, 1), y, 1, GOLD[4]);
                }
                if v2 && trend != 0 {
                    let (arrow, colour) = if trend > 0 { ("\u{2191}", GREEN[2]) } else { ("\u{2193}", RED[2]) };
                    draw_text(&mut c, g, arrow, 193, y, 1, colour);
                }
            }
            let keys = if v2 { "[B] Buy  [S] Sell  [Esc] Leave" } else { "[B] BUY  [S] SELL" };
            draw_text(&mut c, g, keys, 16, 158, 1, STEEL[3]);

            titled_panel(&mut c, g, 212, 120, 102, 52, v2.then_some("Hold"));
            let top = if v2 { 137 } else { 126 };
            hud(&mut c, g, if v2 { "18/24 t" } else { "HOLD 18/24 T" }, 218, top, STEEL[4]);
            gauge(&mut c, 218, top + 11, 90, 0.75, TEAL);
            stat(&mut c, g, "credits", if v2 { "4,120" } else { "3,860" }, 217, top + 18, GOLD[4]);
        }
        "dock" => {
            let station = art::station("ring", 2).scaled(2);
            let (cx, cy) = (160, 58);
            c.blit(&station, cx - station.w as i32 / 2, cy - station.h as i32 / 2);
            // The approach corridor: chevrons pointing up the glide path to the port.
            let port = cy + 44;
            for k in 0..4 {
                let y = port + 12 + k * 9;
                let colour = if k % 2 == if v2 { 1 } else { 0 } { TEAL[4] } else { TEAL[2] };
                let half = 6 + k * 2;
                c.line(cx - half, y + half / 2, cx, y, colour);
                c.line(cx + half, y + half / 2, cx, y, colour);
            }
            bracket(&mut c, cx - 10, port - 8, 21, 16, GREEN[2]);
            let hauler = art::ship("hauler", 2);
            let ship_y = if v2 { 150 } else { 158 };
            ship_with_flame(&mut c, &hauler, flame, cx, ship_y, 2);

            titled_panel(&mut c, g, 6, 128, 116, 46, v2.then_some("Docking"));
            let top = if v2 { 144 } else { 133 };
            let lines: [(&str, u8); 2] = if v2 { [("Range 9 m", GOLD[4]), ("Closing 0.3 m/s", STEEL[4])] } else { [("DOCKING 12 M", GOLD[4]), ("CLOSING 0.4 M/S", STEEL[4])] };
            for (k, (line, colour)) in lines.iter().enumerate() {
                hud(&mut c, g, line, 12, top + 11 * k as i32, *colour);
            }
            gauge(&mut c, 12, if v2 { 166 } else { 156 }, 104, if v2 { 0.94 } else { 0.86 }, if v2 { TEAL } else { RED });
            hud(&mut c, g, if v2 { "Halden Ring" } else { "HALDEN RING" }, 222, 8, GOLD[4]);
            hud(&mut c, g, if v2 { "Port 2 clear" } else { "PORT 2 CLEAR" }, 222, 19, GREEN[2]);
            if v2 {
                stat(&mut c, g, "fuel", "58%", 222, 156, GREEN[2]);
                stat(&mut c, g, "cargo", "18/24", 266, 156, STEEL[4]);
            }
        }
        other => panic!("no screenshot {other}"),
    }
    c
}

/// A frame of the trailer: the scout climbs past a planet while the stars stream by in two
/// layers, then the title comes up (v2 wipes the gold logo in; v1 stamps the name). The sky and
/// nebula hold still between frames so the video encoder spends its bits on what moves.
pub fn trailer_frame(version: u16, i: u32, n: u32) -> Canvas {
    let v2 = version >= 2;
    let s = seed(&format!("trailer:{version}"));
    let glyphs = glyphs::text_glyphs();
    let t = i as f32 / n.max(1) as f32;
    let mut c = Canvas::new(320, 180);
    sky(&mut c, s);
    nebula(&mut c, s, VIOLET, TEAL, 0.6);
    for (layer, count, speed) in [("far", 90u32, 1i32), ("near", 40, 3)] {
        let mut stars = Canvas::new(320, 180);
        starfield(&mut stars, seed(&format!("trailer:{version}:{layer}")), count);
        let dy = (i as i32 * speed).rem_euclid(180);
        c.blit(&stars, 0, dy);
        c.blit(&stars, 0, dy - 180);
    }
    let world = planet(&PlanetSpec { radius: 46, surface: Surface::Oceanic, ramp_a: TEAL, ramp_b: GREEN, seed: s, ring: None, atmosphere: Some(TEAL[4]) });
    // The planet slides down and out to the right, clear of the title by the time it comes up.
    let wy = 10 + (t * 200.0) as i32;
    c.blit(&world, 256 - world.w as i32 / 2, wy - world.h as i32 / 2);
    if v2 {
        let station = art::station("ring", 2);
        c.blit(&station, 54 - station.w as i32 / 2, -60 + (t * 160.0) as i32);
    }
    // Foreground rocks overtake everything.
    let rocks = asteroid_frames(s, 24, 8, STEEL);
    c.blit(&rocks[(i / 2 % 8) as usize].scaled(2), 268, -48 + (i as i32 * 6) % 280);
    c.blit(&rocks[((i / 3 + 4) % 8) as usize], 20, -24 + (i as i32 * 5 + 120) % 220);

    // The scout rises into frame, then holds with a gentle weave.
    let rise = (t * 3.0).min(1.0);
    let sy = 166.0 - 44.0 * (1.0 - (1.0 - rise) * (1.0 - rise));
    let sx = 150.0 + 10.0 * (t * std::f32::consts::TAU * 1.5).sin();
    let flame = &art::thruster_frames(2)[(i % 4) as usize];
    ship_with_flame(&mut c, &art::ship("scout", 2), flame, sx as i32, sy as i32, 2);

    let title_from = n.saturating_sub(14);
    if i >= title_from {
        let k = (i - title_from) as f32 / 8.0;
        if v2 {
            logo(&mut c, "ORBITAL", 160 - text_width("ORBITAL", 5) / 2, 40, 5, k);
            if k >= 1.0 {
                centred(&mut c, &glyphs, "Out now on desktop", 160, 86, 1, TEAL[4]);
            }
        } else {
            centred(&mut c, &glyphs, "ORBITAL", 160, 44, 4, STEEL[5]);
            centred(&mut c, &glyphs, "VERSION 1.0", 160, 82, 1, GOLD[4]);
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{luma, GOLD};

    #[test]
    fn title_is_rich_and_versions_differ() {
        let (a, b) = (title(1), title(2));
        assert_eq!((a.w, a.h), (480, 270));
        assert!(a.colours() >= 20 && b.colours() >= 20, "{} / {}", a.colours(), b.colours());
        assert!(a.px.iter().all(|&p| p != 0), "opaque");
        assert_ne!(a.px, b.px);
        let gold = a.px.iter().filter(|&&p| GOLD.contains(&p)).count();
        assert!(gold > 2_000, "the logo and the ship's flame are there: {gold}");
        assert!(a.to_png().len() < 120_000, "{}", a.to_png().len());
    }

    #[test]
    fn screenshots_have_a_hud_and_stay_small() {
        for kind in ["orbit", "trade", "dock"] {
            for v in 1..=2 {
                let s = screenshot(kind, v);
                assert_eq!((s.w, s.h), (320, 180));
                let bright = s.px.iter().filter(|&&p| luma(p) > 150.0).count();
                assert!(bright > 300, "{kind} v{v}: HUD text and highlights ({bright})");
                assert!(s.scaled(2).to_png().len() < 80_000, "{kind} v{v}");
            }
            assert_ne!(screenshot(kind, 1).px, screenshot(kind, 2).px);
        }
    }

    #[test]
    fn trailer_frames_move() {
        let (f0, f6) = (trailer_frame(1, 0, 48), trailer_frame(1, 6, 48));
        assert_eq!((f0.w, f0.h), (320, 180));
        assert_ne!(f0.px, f6.px);
        assert_eq!(trailer_frame(2, 3, 48).px, trailer_frame(2, 3, 48).px);
    }

    #[test]
    fn title_v2_has_the_stronger_nebula_and_the_teal_mixed_case_tagline() {
        let (a, b) = (title(1), title(2));
        // The tagline band (scale 2, from y 96): v1 is steel capitals, v2 teal mixed case.
        let count = |c: &Canvas, ink: u8| (96..112).flat_map(|y| (0..480).map(move |x| (x, y))).filter(|&(x, y)| c.get(x, y) == ink).count();
        assert!(count(&b, TEAL[4]) > count(&a, TEAL[4]) + 40, "{} vs {}", count(&b, TEAL[4]), count(&a, TEAL[4]));
        assert!(count(&a, STEEL[4]) > count(&b, STEEL[4]) + 40);
        // The nebula goes from 75% to full strength: more of the sky is off the base colour.
        let nebula = |c: &Canvas| c.px.iter().filter(|&&p| VIOLET.contains(&p) || TEAL.contains(&p)).count();
        assert!(nebula(&b) > nebula(&a) + 500, "{} vs {}", nebula(&b), nebula(&a));
        assert_ne!(a.px[..480 * 20], b.px[..480 * 20]);
    }

    #[test]
    fn trailer_ends_on_the_title_and_the_wipe_moves_every_frame() {
        let n = 48;
        let title_from = n - 14;
        let band = |c: &Canvas| (40..70).flat_map(|y| (100..220).map(move |x| (x, y))).filter(|&(x, y)| GOLD.contains(&c.get(x, y))).count();
        // v2: no logo before the wipe, a growing one during it, the whole one with the tagline at the end.
        let gold: Vec<usize> = (title_from - 1..n).map(|i| band(&trailer_frame(2, i, n))).collect();
        assert_eq!(gold[0], 0, "no gold logo before the wipe");
        assert!(gold.windows(2).all(|w| w[1] >= w[0]) && gold[8] > gold[4] && gold[4] > 0, "the wipe grows: {gold:?}");
        let (before, wipe, after) = (trailer_frame(2, title_from + 3, n), trailer_frame(2, title_from + 4, n), trailer_frame(2, title_from + 5, n));
        assert_ne!(wipe.px, before.px);
        assert_ne!(wipe.px, after.px);
        let last = trailer_frame(2, n - 1, n);
        assert!(band(&last) >= *gold.iter().max().unwrap());
        // v1 stamps the name and "VERSION 1.0" over the last frames, and not before.
        let stamp = |i| {
            let f = trailer_frame(1, i, n);
            (80..90).flat_map(|y| (100..220).map(move |x| (x, y))).filter(|&(x, y)| f.get(x, y) == GOLD[4]).count()
        };
        assert_eq!(stamp(title_from - 1), 0);
        assert!(stamp(n - 1) > 0);
    }
}
