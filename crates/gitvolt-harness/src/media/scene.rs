//! Backgrounds and HUD pieces for Orbital's scenes.

use super::canvas::{bayer4, tone, Canvas, Dither};
use super::noise;
use super::palette::{GOLD, SPACE, STEEL, TEAL};
use super::rng::Rng;

/// Deep space: darker at the top, a little lighter towards the bottom, Bayer-dithered.
pub fn sky(c: &mut Canvas, seed: u64) {
    for y in 0..c.h as i32 {
        for x in 0..c.w as i32 {
            let t = 0.15 + 0.45 * y as f32 / c.h as f32 + 0.1 * (noise::fbm(seed, x as f32 / 90.0, y as f32 / 90.0, 2) - 0.5);
            c.set(x, y, tone(&SPACE[..3], t, x, y, Dither::Bayer));
        }
    }
}

/// Wisps of two colours where (warped) fBm is dense; only over sky pixels. The thin edges are
/// a Bayer-dithered coverage of the darkest step, so a cloud fades into the sky instead of
/// ending at a contour, and the two colours meet through a dithered seam.
pub fn nebula(c: &mut Canvas, seed: u64, a: &[u8], b: &[u8], strength: f32) {
    for y in 0..c.h as i32 {
        for x in 0..c.w as i32 {
            if !SPACE.contains(&c.get(x, y)) {
                continue;
            }
            let (fx, fy) = (x as f32, y as f32);
            // Domain warp: drags the clouds into streaks rather than round blobs.
            let wx = fx + 46.0 * (noise::fbm(seed ^ 0x11, fx / 110.0, fy / 110.0, 3) - 0.5);
            let wy = fy + 30.0 * (noise::fbm(seed ^ 0x22, fx / 110.0, fy / 110.0, 3) - 0.5);
            let d = noise::fbm(seed ^ 0xAB, wx / 80.0, wy / 50.0, 5);
            let density = ((d - 0.5) * 3.4 * strength).clamp(0.0, 1.0);
            if density <= 0.0 || bayer4(x, y) >= (density * 3.0).min(1.0) {
                continue;
            }
            let mix = noise::fbm(seed ^ 0xCD, fx / 130.0, fy / 130.0, 3) + (bayer4(x, y) - 0.5) * 0.08;
            let ramp = if mix > 0.5 { a } else { b };
            c.set(x, y, tone(&ramp[..ramp.len().min(3)], density * 0.8, x, y, Dither::Bayer));
        }
    }
}

pub fn starfield(c: &mut Canvas, seed: u64, count: u32) {
    let mut rng = Rng::named(seed, "stars");
    for _ in 0..count {
        let (x, y) = (rng.below(c.w as u64) as i32, rng.below(c.h as u64) as i32);
        let roll = rng.unit();
        if roll < 0.7 {
            c.set(x, y, if rng.chance(0.5) { SPACE[3] } else { STEEL[2] });
        } else if roll < 0.96 {
            c.set(x, y, STEEL[4]);
        } else {
            let tint = if rng.chance(0.5) { GOLD[5] } else { TEAL[4] };
            c.set(x, y, STEEL[5]);
            for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                c.set(x + dx, y + dy, tint);
            }
        }
    }
}

pub fn panel(c: &mut Canvas, x: i32, y: i32, w: i32, h: i32) {
    c.fill_rect(x, y, w, h, SPACE[1]);
    for xx in x + 2..x + w - 2 {
        c.set(xx, y, TEAL[2]);
        c.set(xx, y + h - 1, TEAL[1]);
    }
    for yy in y + 2..y + h - 2 {
        c.set(x, yy, TEAL[2]);
        c.set(x + w - 1, yy, TEAL[1]);
    }
    for (cx, cy) in [(x + 1, y + 1), (x + w - 2, y + 1), (x + 1, y + h - 2), (x + w - 2, y + h - 2)] {
        c.set(cx, cy, TEAL[3]);
    }
}

pub fn gauge(c: &mut Canvas, x: i32, y: i32, w: i32, frac: f32, ramp: &[u8]) {
    c.fill_rect(x, y, w, 4, SPACE[2]);
    let filled = (w as f32 * frac.clamp(0.0, 1.0)) as i32;
    for xx in 0..filled {
        for yy in 0..4 {
            let t = 0.85 - 0.2 * yy as f32 - 0.2 * (1.0 - xx as f32 / w as f32);
            c.set(x + xx, y + yy, tone(ramp, t, x + xx, y + yy, Dither::Checker(0.3)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::VIOLET;

    #[test]
    fn sky_is_space_and_lighter_below() {
        let mut c = Canvas::new(64, 64);
        sky(&mut c, 3);
        assert!(c.px.iter().all(|p| SPACE.contains(p)));
        let mean = |rows: std::ops::Range<usize>| rows.clone().flat_map(|y| c.px[y * 64..y * 64 + 64].iter().map(|&p| p as f32)).sum::<f32>() / (rows.len() * 64) as f32;
        assert!(mean(48..64) > mean(0..16));
    }

    #[test]
    fn nebula_paints_only_over_sky() {
        let mut c = Canvas::new(160, 120);
        sky(&mut c, 9);
        c.fill_rect(10, 10, 40, 40, GOLD[3]);
        nebula(&mut c, 9, VIOLET, TEAL, 1.0);
        assert!((10..50).all(|y| (10..50).all(|x| c.get(x, y) == GOLD[3])), "the sprite stays");
        let clouds = c.px.iter().filter(|p| VIOLET.contains(p) || TEAL.contains(p)).count();
        assert!(clouds > 500 && clouds < 160 * 120 * 3 / 4, "{clouds}");
    }

    #[test]
    fn panel_has_notched_corners_and_gauge_fills_its_fraction() {
        let mut c = Canvas::filled(40, 20, SPACE[0]);
        panel(&mut c, 0, 0, 40, 20);
        assert_eq!((c.get(0, 0), c.get(1, 1), c.get(5, 0), c.get(5, 5)), (SPACE[1], TEAL[3], TEAL[2], SPACE[1]));
        gauge(&mut c, 2, 8, 30, 0.5, TEAL);
        let lit = (2..32).filter(|&x| TEAL.contains(&c.get(x, 9))).count();
        assert_eq!(lit, 15);
    }
}
