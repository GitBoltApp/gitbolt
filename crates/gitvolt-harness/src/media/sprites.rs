//! Procedural pixel art for Orbital: ships from half-masks, planets, asteroids, stations,
//! explosions, thruster flames and icons, and sheets of frames. One light, from the top left;
//! ramps with cool shadows; dithering only at band seams; selective outlines.

use super::canvas::{tone, Canvas, Dither};
use super::noise;
use super::palette::{outline_for, ramp_of, GOLD, GREEN, RED, STEEL, TEAL, VIOLET};
use super::rng::Rng;
use std::f32::consts::{PI, TAU};

/// Towards the light (top left, out of the screen), about unit length.
const LIGHT: (f32, f32, f32) = (-0.55, -0.6, 0.58);
/// The light's direction on the screen, unit length.
const LIGHT2: (f32, f32) = (-0.676, -0.737);
/// Sprites shade in clean bands; only a pixel or two at each seam is checkered.
const SEAM: Dither = Dither::Checker(0.16);

fn lambert(nx: f32, ny: f32, nz: f32) -> f32 {
    (nx * LIGHT.0 + ny * LIGHT.1 + nz * LIGHT.2).max(0.0)
}

/// How brightly the light falls on each pixel of a mask's shape, read as a rounded body: each
/// pixel's height is its distance from empty space (up to `reach`), and the slopes of that
/// height field are lit like any surface. Row-major, `w` × `h`.
fn relief(w: i32, h: i32, solid: impl Fn(i32, i32) -> bool, reach: f32) -> Vec<f32> {
    let r = reach.ceil() as i32;
    let mut height = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            if !solid(x, y) {
                continue;
            }
            let mut d = reach;
            for dy in -r..=r {
                for dx in -r..=r {
                    if !solid(x + dx, y + dy) {
                        d = d.min(((dx * dx + dy * dy) as f32).sqrt() - 0.5);
                    }
                }
            }
            height[(y * w + x) as usize] = d / reach;
        }
    }
    let at = |x: i32, y: i32| if x < 0 || y < 0 || x >= w || y >= h { 0.0 } else { height[(y * w + x) as usize] };
    let steep = 2.2;
    (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            let (gx, gy) = ((at(x + 1, y) - at(x - 1, y)) / 2.0, (at(x, y + 1) - at(x, y - 1)) / 2.0);
            let (nx, ny) = (-gx * steep, -gy * steep);
            let len = (nx * nx + ny * ny + 1.0).sqrt();
            lambert(nx / len, ny / len, 1.0 / len)
        })
        .collect()
}

/// A tone for an outlined sprite's fill: from the ramp above its darkest, which the outline
/// keeps to itself so the silhouette never melts into a shaded side.
fn fill(ramp: &[u8], t: f32, x: i32, y: i32) -> u8 {
    tone(&ramp[1..], t, x, y, SEAM)
}

/// After `outline`: a filled pixel on the canvas edge has no room for an outline outside it,
/// so it becomes its own ramp's darkest.
fn seal(c: &mut Canvas) {
    for y in 0..c.h as i32 {
        for x in 0..c.w as i32 {
            let p = c.get(x, y);
            if p != 0 && (x == 0 || y == 0 || x == c.w as i32 - 1 || y == c.h as i32 - 1) {
                c.set(x, y, outline_for(p));
            }
        }
    }
}

/// The left half of a ship facing up, centre column included, top row first:
/// '.' empty, '#' hull, 'a' accent stripe, 'c' canopy, 'e' engine nozzle, 'l' running light.
pub struct ShipSpec<'a> {
    pub half: &'a [&'a str],
    pub hull: &'a [u8],
    pub accent: &'a [u8],
    pub canopy: &'a [u8],
}

/// (2·half_w − 1 + 2) × (rows + 2): the mirrored mask inside a 1-pixel margin for the outline.
pub fn ship(spec: &ShipSpec) -> Canvas {
    let rows = spec.half.len() as i32;
    let half_w = spec.half[0].len() as i32;
    assert!(spec.half.iter().all(|r| r.len() as i32 == half_w), "ragged ship mask");
    let (w, h) = (2 * half_w - 1 + 2, rows + 2);
    let at = |x: i32, y: i32| -> u8 {
        if y < 1 || y > rows || x < 1 || x > w - 2 {
            return b'.';
        }
        let col = x - 1;
        let m = if col < half_w { col } else { 2 * (half_w - 1) - col };
        spec.half[(y - 1) as usize].as_bytes()[m as usize]
    };
    let canopy_rows: Vec<i32> = (0..h).filter(|&y| (0..w).any(|x| at(x, y) == b'c')).collect();
    let cx = (w - 1) as f32 / 2.0;
    let light = relief(w, h, |x, y| at(x, y) != b'.', 2.5);
    let mut c = Canvas::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let m = at(x, y);
            if m == b'.' {
                continue;
            }
            // Rounded edges, and the whole hull a little lighter left of the spine and nose up.
            let side = (x as f32 - cx) / cx.max(1.0);
            let height = 1.0 - (y - 1) as f32 / rows as f32;
            let t = 1.05 * light[(y * w + x) as usize] - 0.18 - 0.14 * side + 0.08 * (height - 0.5);
            let colour = match m {
                b'#' => fill(spec.hull, t, x, y),
                b'a' => fill(spec.accent, t + 0.06, x, y),
                b'c' => {
                    // Glass: a glint at the top left, darkening down and to the right.
                    let first = canopy_rows.first().copied().unwrap_or(y);
                    let down = (y - first) as f32 / canopy_rows.len().max(1) as f32;
                    let glint = at(x - 1, y) != b'c' && at(x, y - 1) != b'c' && x as f32 <= cx;
                    if glint { spec.canopy[spec.canopy.len() - 1] } else { tone(&spec.canopy[1..], 0.62 - 0.3 * down - 0.25 * side.max(0.0), x, y, Dither::None) }
                }
                b'e' => {
                    if x as f32 <= cx { spec.hull[2] } else { spec.hull[1] }
                }
                // Port red, starboard green, as on any vessel; a lone centre light is amber.
                b'l' if (x as f32) < cx => RED[2],
                b'l' if (x as f32) > cx => GREEN[2],
                b'l' => GOLD[4],
                other => panic!("ship masks use . # a c e l, not {:?}", other as char),
            };
            c.set(x, y, colour);
        }
    }
    c.outline(outline_for);
    c
}

#[derive(Clone, Copy, Debug)]
pub enum Surface {
    Rocky { craters: u32 },
    Oceanic,
    Banded,
    Icy,
    Molten,
}

pub struct PlanetSpec<'a> {
    pub radius: u32,
    pub surface: Surface,
    pub ramp_a: &'a [u8],
    pub ramp_b: &'a [u8],
    pub seed: u64,
    pub ring: Option<&'a [u8]>,
    pub atmosphere: Option<u8>,
}

/// A lit sphere with its surface, an optional ring (its far half behind the disc, its near half
/// in front) and an optional atmosphere glowing on the lit limb.
pub fn planet(spec: &PlanetSpec) -> Canvas {
    let r = spec.radius as f32;
    let pad = 2 + if spec.ring.is_some() { (r * 0.7) as u32 } else { 0 };
    let size = 2 * spec.radius + 2 * pad;
    let mut c = Canvas::new(size, size);
    let (cx, cy) = (size as f32 / 2.0, size as f32 / 2.0);
    if let Some(ring) = spec.ring {
        draw_ring(&mut c, cx, cy, r, ring, false);
    }
    let mut rng = Rng::named(spec.seed, "planet");
    let craters: Vec<(f32, f32, f32)> = match spec.surface {
        Surface::Rocky { craters } => (0..craters).map(|_| (rng.range_f(-1.3, 1.1), rng.range_f(-1.0, 1.0), rng.range_f(0.14, 0.36))).collect(),
        // The banded giant's storm.
        Surface::Banded => vec![(rng.range_f(-0.7, 0.3), rng.range_f(-0.5, -0.2), 0.0)],
        _ => Vec::new(),
    };
    for y in 0..size as i32 {
        for x in 0..size as i32 {
            let (dx, dy) = ((x as f32 + 0.5 - cx) / r, (y as f32 + 0.5 - cy) / r);
            let d2 = dx * dx + dy * dy;
            if d2 > 1.0 {
                continue;
            }
            let nz = (1.0 - d2).sqrt();
            let t = 0.05 + 0.88 * lambert(dx, dy, nz);
            // Texture coordinates on the sphere: longitude across, latitude down.
            let (u, v) = (dx.atan2(nz), dy.asin());
            c.set(x, y, surface_colour(spec, &craters, u, v, t, x, y));
        }
    }
    if let Some(a) = spec.atmosphere {
        let glow = ramp_of(a);
        let top = glow.iter().position(|&g| g == a).unwrap_or(0);
        for y in 0..size as i32 {
            for x in 0..size as i32 {
                let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
                let d = dx.hypot(dy);
                if d <= r || d > r + 1.25 || c.get(x, y) != 0 {
                    continue;
                }
                // Brightest where the limb faces the light, fading a step at a time round to
                // the terminator.
                let facing = (dx * LIGHT2.0 + dy * LIGHT2.1) / d;
                let steps = if facing > 0.55 { 0 } else if facing > 0.15 { 1 } else if facing > -0.2 { 2 } else { continue };
                if steps <= top {
                    c.set(x, y, glow[top - steps]);
                }
            }
        }
    }
    if let Some(ring) = spec.ring {
        draw_ring(&mut c, cx, cy, r, ring, true);
    }
    c
}

fn surface_colour(spec: &PlanetSpec, spots: &[(f32, f32, f32)], u: f32, v: f32, t: f32, x: i32, y: i32) -> u8 {
    let seam = Dither::Checker(0.22);
    let seed = spec.seed;
    match spec.surface {
        Surface::Banded => {
            let warp = noise::fbm(seed, u * 2.0 + 7.0, v * 3.0 + 7.0, 3);
            let band = ((v * 5.0 + warp * 1.8) * PI).sin() * 0.5 + 0.5;
            let (su, sv, _) = spots[0];
            let storm = ((u - su) / 0.4).powi(2) + ((v - sv) / 0.18).powi(2);
            if storm < 1.0 {
                // A pale eye in a dark collar.
                return if storm > 0.45 { tone(spec.ramp_b, t * 0.5, x, y, Dither::None) } else { tone(spec.ramp_a, 0.2 + t, x, y, Dither::None) };
            }
            let ramp = if band > 0.55 { spec.ramp_b } else { spec.ramp_a };
            tone(ramp, t * (0.8 + 0.3 * band), x, y, seam)
        }
        Surface::Oceanic => {
            // Coasts and cloud carry the detail here, so the shading seams stay narrow.
            let seam = Dither::Checker(0.1);
            let height = noise::fbm(seed, u * 2.2 + 3.0, v * 2.2 + 3.0, 4);
            let ice = v.abs() + 0.25 * noise::value(seed ^ 0x1CE, u * 3.0, v * 3.0) > 1.2;
            // Cloud wisps: the thin ridges of a field stretched along the latitudes and bent by a
            // slower one, only where a broad cover field lets them form.
            let bend = noise::fbm(seed ^ 0xBE4D, u * 1.3 + 2.0, v * 2.0 + 2.0, 2) - 0.5;
            let ridge = (noise::value(seed ^ 0xC10D, u * 0.7 + 11.0, v * 6.0 + bend * 2.0 + 11.0) - 0.5).abs();
            let cover = noise::fbm(seed ^ 0xC0FE, u * 1.1 + 4.0, v * 1.6 + 4.0, 2);
            let wisp = cover > 0.42 && ridge < 0.022 + 0.1 * (cover - 0.42);
            if ice {
                // Ice takes the light like snow, and goes blue-grey in shadow.
                tone(STEEL, 0.25 + 0.75 * t, x, y, seam)
            } else if wisp {
                // Bright on the day side; towards the night only a haze over the sea.
                if t > 0.4 { tone(&STEEL[3..], (t - 0.4) * 2.0, x, y, Dither::None) } else { tone(spec.ramp_a, t * 1.2 + 0.12, x, y, Dither::None) }
            } else if height > 0.53 {
                tone(spec.ramp_b, t * (0.85 + 0.4 * (height - 0.53)), x, y, seam)
            } else if height > 0.49 {
                // Shallows along the coasts.
                tone(spec.ramp_a, t * 1.15 + 0.08, x, y, seam)
            } else {
                tone(spec.ramp_a, t * 0.92, x, y, seam)
            }
        }
        Surface::Rocky { .. } => {
            let maria = noise::fbm(seed ^ 0x3A71A, u * 1.6 + 5.0, v * 1.6 + 5.0, 3) > 0.56;
            let t = t * (0.9 + 0.2 * noise::fbm(seed, u * 4.0, v * 4.0, 3)) * if maria { 0.82 } else { 1.0 };
            for &(cu, cv, cr) in spots {
                let (ou, ov) = ((u - cu) / cr, (v - cv) / cr);
                let d = ou.hypot(ov);
                if d >= 1.0 || t < 0.12 {
                    continue;
                }
                // Towards the light along the surface: positive on the bowl's near wall.
                let toward = (ou * LIGHT2.0 + ov * LIGHT2.1) / d.max(0.01);
                let crater = if d < 0.75 {
                    // The bowl: its near wall in shadow, its far wall facing the light.
                    if d > 0.3 && toward > 0.25 { t - 0.32 } else if d > 0.3 && toward < -0.25 { t + 0.06 } else { t - 0.14 }
                } else if toward > 0.0 {
                    // The raised rim catches the light on its lit side.
                    t + 0.16
                } else {
                    t - 0.04
                };
                return tone(spec.ramp_a, crater, x, y, Dither::None);
            }
            tone(spec.ramp_a, t, x, y, seam)
        }
        Surface::Icy => {
            let crack = (noise::fbm(seed, u * 2.4 + 1.0, v * 2.4 + 1.0, 3) - 0.5).abs() < 0.018;
            if crack { tone(spec.ramp_b, 0.2 + t * 0.6, x, y, Dither::None) } else { tone(spec.ramp_a, 0.18 + 0.82 * t, x, y, seam) }
        }
        Surface::Molten => {
            let lava = (noise::fbm(seed, u * 2.2 + 2.0, v * 2.2 + 2.0, 3) - 0.5).abs();
            if lava < 0.026 {
                // Lava glows on the night side too.
                tone(spec.ramp_b, 0.62 + 0.38 * t, x, y, Dither::None)
            } else if lava < 0.05 {
                // The crust beside it warms.
                tone(spec.ramp_a, 0.45 + 0.5 * t, x, y, seam)
            } else {
                tone(spec.ramp_a, t * 0.9, x, y, seam)
            }
        }
    }
}

/// The ring, tilted: its far half (`front` false) is drawn before the planet, its near half
/// after. The planet's shadow falls across the far half, away from the light.
fn draw_ring(c: &mut Canvas, cx: f32, cy: f32, r: f32, ramp: &[u8], front: bool) {
    let (outer, inner, tilt) = (r * 1.65, r * 1.22, 0.34);
    for y in 0..c.h as i32 {
        for x in 0..c.w as i32 {
            let (px, py) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let d = px.hypot(py / tilt);
            if d < inner || d > outer || (py >= 0.0) != front {
                continue;
            }
            let band = (d - inner) / (outer - inner);
            if (0.55..0.64).contains(&band) {
                continue; // the gap between the inner and outer rings
            }
            let mut t = if ((band * 5.0) as i32) % 2 == 0 { 0.78 } else { 0.56 } - 0.3 * (px / outer);
            // In shadow if a step towards the light lands on the disc.
            let shadow = (1..=8).any(|k| {
                let s = k as f32 * r / 4.0;
                (px + LIGHT2.0 * s).hypot(py + LIGHT2.1 * s) < r
            });
            if shadow && !front && px > 0.0 {
                t = 0.08;
            }
            c.set(x, y, tone(ramp, t, x, y, Dither::Checker(0.2)));
        }
    }
}

/// A lumpy rock turning once over `frames`, its pits and craters turning with it while the
/// light stays put.
pub fn asteroid_frames(seed: u64, size: u32, frames: u32, ramp: &[u8]) -> Vec<Canvas> {
    let (cx, cy) = (size as f32 / 2.0, size as f32 / 2.0);
    let r0 = size as f32 / 2.0 - 1.5;
    let mut rng = Rng::named(seed, "asteroid");
    let stretch = rng.range_f(0.7, 0.85);
    let craters: Vec<(f32, f32, f32)> = (0..3 + rng.below(3)).map(|_| (rng.range_f(-0.55, 0.55), rng.range_f(-0.45, 0.45), rng.range_f(0.14, 0.26))).collect();
    (0..frames)
        .map(|k| {
            let rot = k as f32 / frames as f32 * TAU;
            let (s, co) = (-rot).sin_cos();
            let mut c = Canvas::new(size, size);
            for y in 0..size as i32 {
                for x in 0..size as i32 {
                    let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
                    // Into the rock's own frame, where its outline and craters are fixed.
                    let (lx, ly) = (dx * co - dy * s, dx * s + dy * co);
                    let a = ly.atan2(lx);
                    let ellipse = 1.0 / (a.cos().powi(2) + (a.sin() / stretch).powi(2)).sqrt();
                    let lump = 0.66 + 0.34 * noise::fbm(seed, a.cos() * 1.6 + 4.0, a.sin() * 1.6 + 4.0, 3);
                    let rr = r0 * ellipse * lump;
                    let d = dx.hypot(dy);
                    if d > rr {
                        continue;
                    }
                    let q = d / rr;
                    let nz = (1.0 - q * q).max(0.0).sqrt();
                    let bump = noise::fbm(seed ^ 0x00C0_FFEE, lx * 0.3 + 9.0, ly * 0.3 + 9.0, 2) - 0.5;
                    let mut t = 0.98 * lambert(dx / rr, dy / rr, nz) - 0.06 + 0.3 * bump;
                    for &(ccx, ccy, cr) in &craters {
                        let (ox, oy) = ((lx - ccx * r0) / (cr * r0), (ly - ccy * r0) / (cr * r0));
                        let cd = ox.hypot(oy);
                        if cd >= 1.0 {
                            continue;
                        }
                        // Back to the screen, where the light is.
                        let (sx, sy) = (ox * co + oy * s, -ox * s + oy * co);
                        let toward = (sx * LIGHT2.0 + sy * LIGHT2.1) / cd.max(0.01);
                        t = if cd < 0.7 { t * (0.7 - 0.32 * toward) } else { t + 0.12 * toward };
                    }
                    c.set(x, y, fill(ramp, t, x, y));
                }
            }
            c.outline(outline_for);
            c
        })
        .collect()
}

pub struct StationSpec<'a> {
    pub size: u32,
    pub spokes: u32,
    pub panels: bool,
    pub hull: &'a [u8],
    pub glass: &'a [u8],
    pub lights_on: bool,
}

/// A ring station seen from above: hub, spokes, a lit ring with windows, solar wings and docking
/// lights (amber when on, dim red when off, so two frames blink).
pub fn station(s: &StationSpec) -> Canvas {
    let n = s.size as i32;
    let mut c = Canvas::new(s.size, s.size);
    let (cx, cy) = (s.size as f32 / 2.0, s.size as f32 / 2.0);
    let ring_r = s.size as f32 * if s.panels { 0.3 } else { 0.38 };
    let tube = (s.size as f32 * 0.035).max(1.6);
    let top = s.hull.len() - 1;
    if s.panels {
        let (pw, ph) = ((s.size as f32 * 0.13) as i32, (s.size as f32 * 0.3) as i32 | 1);
        let py = cy as i32 - ph / 2;
        for side in [-1i32, 1] {
            let x0 = if side < 0 { 1 } else { n - 1 - pw };
            // Struts: lit along the top.
            let (from, to) = if side < 0 { (x0 + pw, (cx - ring_r) as i32) } else { ((cx + ring_r) as i32, x0 - 1) };
            for x in from..=to {
                c.set(x, cy as i32 - 1, s.hull[top - 1]);
                c.set(x, cy as i32, s.hull[1]);
            }
            for yy in 0..ph {
                for xx in 0..pw {
                    let frame = xx == 0 || xx == pw - 1 || yy == 0 || yy == ph - 1;
                    let colour = if frame {
                        if xx == 0 || yy == 0 { s.hull[top - 1] } else { s.hull[1] }
                    } else if yy % 4 == 0 || xx % 3 == 0 {
                        s.glass[0]
                    } else {
                        // Cells catch the light down the wing, a glint on each cell's corner.
                        let corner = yy % 4 == 1 && xx % 3 == 1;
                        let t = 0.62 - 0.4 * yy as f32 / ph as f32 + if corner { 0.22 } else { 0.0 };
                        tone(s.glass, t, xx, yy, SEAM)
                    };
                    c.set(x0 + xx, py + yy, colour);
                }
            }
        }
    }
    for k in 0..s.spokes {
        let a = k as f32 / s.spokes as f32 * TAU + PI / 4.0;
        let (ex, ey) = ((cx + a.cos() * ring_r).floor() as i32, (cy + a.sin() * ring_r).floor() as i32);
        // Lit spokes face the light; the others stay in the hull's shade.
        let lit = a.cos() * LIGHT2.0 + a.sin() * LIGHT2.1 > 0.0;
        c.line(cx as i32, cy as i32, ex, ey, s.hull[if lit { 3 } else { 2 }]);
    }
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let d = dx.hypot(dy);
            let across = (d - ring_r) / tube;
            if across.abs() <= 1.0 {
                // A tube: lit on the side facing the light, on the outer half up top.
                let nz = (1.0 - across * across).max(0.0).sqrt();
                let t = 0.95 * lambert(dx / d * across, dy / d * across, nz) - 0.02;
                c.set(x, y, fill(s.hull, t, x, y));
            }
        }
    }
    for k in 0..16 {
        let a = (k as f32 + 0.5) / 16.0 * TAU;
        let (wx, wy) = ((cx + a.cos() * ring_r).floor() as i32, (cy + a.sin() * ring_r).floor() as i32);
        // Windows: lit from inside, so they glow brightest on the ring's shaded side.
        let bright = a.cos() * LIGHT2.0 + a.sin() * LIGHT2.1 < 0.3;
        c.set(wx, wy, s.glass[s.glass.len() - if bright { 2 } else { 3 }]);
    }
    let hub_r = s.size as f32 * 0.13;
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = ((x as f32 + 0.5 - cx) / hub_r, (y as f32 + 0.5 - cy) / hub_r);
            let d2 = dx * dx + dy * dy;
            if d2 <= 1.0 {
                let t = lambert(dx, dy, (1.0 - d2).sqrt()) - 0.04;
                c.set(x, y, fill(s.hull, t, x, y));
            }
        }
    }
    // The docking port on the hub's crown: a dark mouth with a lit lip.
    let (hx, hy) = (cx.floor() as i32, cy.floor() as i32);
    c.set(hx, hy, s.hull[0]);
    c.set(hx - 1, hy, s.hull[1]);
    c.set(hx, hy - 1, s.hull[1]);
    c.set(hx + 1, hy + 1, s.hull[top]);
    let light = if s.lights_on { GOLD[4] } else { RED[1] };
    let reach = (ring_r + tube + 1.0).ceil() as i32;
    for (dx, dy) in [(0, -reach), (0, reach), (-1, -reach), (1, reach)] {
        c.set(hx + dx, hy + dy, light);
    }
    c.outline(outline_for);
    seal(&mut c);
    c
}

/// A flash that swells into a fireball, cools through red and leaves grey smoke, with sparks
/// thrown clear. The blast is a cluster of round puffs, each lit like a ball from the top left:
/// they swell and drift outwards, and late on the middle ones thin away first, leaving a ring
/// of smoke. Round puffs keep noise lattices out of the shape.
pub fn explosion_frames(seed: u64, size: u32, frames: u32) -> Vec<Canvas> {
    let (cx, cy) = (size as f32 / 2.0, size as f32 / 2.0);
    let mut rng = Rng::named(seed, "sparks");
    let sparks: Vec<(f32, f32)> = (0..12).map(|_| (rng.range_f(0.0, TAU), rng.range_f(0.75, 1.25))).collect();
    let mut rng = Rng::named(seed, "puffs");
    // (direction, distance out, size), as fractions of the blast's radius; the first sits in the middle.
    let mut puffs = vec![(0.0, 0.0, 0.42, 0.0)];
    for (n, out, size) in [(3, (0.12, 0.28), (0.32, 0.42)), (8, (0.38, 0.64), (0.28, 0.44))] {
        let turn = rng.range_f(0.0, TAU);
        for k in 0..n {
            let a = turn + (k as f32 + rng.range_f(-0.3, 0.3)) / n as f32 * TAU;
            puffs.push((a, rng.range_f(out.0, out.1), rng.range_f(size.0, size.1), rng.range_f(-0.08, 0.08)));
        }
    }
    (0..frames)
        .map(|k| {
            let p = (k as f32 + 0.5) / frames as f32;
            let radius = size as f32 * 0.47 * (0.28 + 0.72 * p.sqrt());
            let mut c = Canvas::new(size, size);
            // Cooler puffs first, so the hottest sit on top.
            let mut order: Vec<(f32, f32, f32, f32)> = puffs
                .iter()
                .map(|&(a, out, s, jitter)| {
                    let (px, py) = (cx + a.cos() * out * radius * 0.95, cy + a.sin() * out * radius * 0.95);
                    // Late on the middle thins first: inner puffs shrink, outer ones linger.
                    let fade = ((p - 0.55) * 1.8).max(0.0) * (1.2 - out);
                    let r = s * radius * (1.0 + 0.25 * p) * (1.0 - fade).max(0.0);
                    let heat = 1.28 - 1.45 * p - 0.45 * out + jitter;
                    (px, py, r, heat)
                })
                .filter(|&(_, _, r, _)| r >= 1.0)
                .collect();
            order.sort_by(|a, b| a.3.total_cmp(&b.3));
            for &(px, py, r, heat) in &order {
                for y in (py - r).floor() as i32..=(py + r).ceil() as i32 {
                    for x in (px - r).floor() as i32..=(px + r).ceil() as i32 {
                        let (dx, dy) = ((x as f32 + 0.5 - px) / r, (y as f32 + 0.5 - py) / r);
                        let d2 = dx * dx + dy * dy;
                        if d2 > 1.0 {
                            continue;
                        }
                        let lit = lambert(dx, dy, (1.0 - d2).sqrt());
                        // A darker rim keeps each puff apart from the one behind it.
                        let rim = if d2 > ((r - 1.0) / r).powi(2) { 0.18 } else { 0.0 };
                        // Hotter towards each puff's core and its lit side.
                        let h = heat + 0.25 * (1.0 - d2) + 0.2 * (lit - 0.5) - rim;
                        let colour = if h > 1.0 {
                            GOLD[5]
                        } else if h > 0.78 {
                            tone(&GOLD[3..], (h - 0.78) / 0.22, x, y, SEAM)
                        } else if h > 0.5 {
                            tone(&GOLD[1..4], (h - 0.5) / 0.28, x, y, SEAM)
                        } else if h > 0.3 {
                            tone(RED, 0.3 + (h - 0.3) * 3.0, x, y, SEAM)
                        } else {
                            // Smoke, lit on its top left.
                            tone(&STEEL[1..5], 0.1 + 0.75 * lit - 1.5 * rim, x, y, SEAM)
                        };
                        c.set(x, y, colour);
                    }
                }
            }
            if p < 0.85 {
                for &(a, speed) in &sparks {
                    let reach = radius * speed * (1.05 + 0.5 * p);
                    let (sx, sy) = ((cx + a.cos() * reach) as i32, (cy + a.sin() * reach) as i32);
                    c.set(sx, sy, if p < 0.4 { GOLD[5] } else { GOLD[3] });
                    if p > 0.3 {
                        // A short trail back towards the blast.
                        let back = reach - 1.5;
                        c.set((cx + a.cos() * back) as i32, (cy + a.sin() * back) as i32, RED[2]);
                    }
                }
            }
            c
        })
        .collect()
}

/// An engine flame pointing down from a nozzle along the top edge, flickering in length and
/// edge from frame to frame: white-hot core, `ramp` towards the tip.
pub fn thruster_frames(seed: u64, w: u32, h: u32, frames: u32, ramp: &[u8]) -> Vec<Canvas> {
    let mut rng = Rng::named(seed, "flame");
    (0..frames)
        .map(|k| {
            let len = h as f32 * rng.range_f(0.6, 1.0);
            let mut c = Canvas::new(w, h);
            let cx = w as f32 / 2.0;
            for y in 0..len.ceil() as i32 {
                let fall = 1.0 - y as f32 / len;
                let ragged = noise::value(seed.wrapping_add(k as u64), y as f32 * 0.7, k as f32 * 3.0) * 0.8;
                let half = (w as f32 / 2.0 - 0.3) * fall.powf(0.6) + ragged - 0.4;
                for x in 0..w as i32 {
                    let off = (x as f32 + 0.5 - cx).abs();
                    if off > half {
                        continue;
                    }
                    let core = 1.0 - off / half.max(0.5);
                    let colour = if core > 0.55 && fall > 0.55 { ramp[ramp.len() - 1] } else { tone(ramp, 0.25 + 0.75 * fall * (0.4 + 0.6 * core), x, y, SEAM) };
                    c.set(x, y, colour);
                }
            }
            c
        })
        .collect()
}

/// An icon from a mask ('#' body, 'o' highlight, '.' empty): a rounded body lit from the top
/// left, outlined. A '.' inside the body
/// becomes an engraved line in the outline colour.
pub fn icon(mask: &[&str], ramp: &[u8]) -> Canvas {
    let (w, h) = (mask[0].len() as i32, mask.len() as i32);
    let at = |x: i32, y: i32| -> u8 {
        if x < 0 || y < 0 || x >= w || y >= h { b'.' } else { mask[y as usize].as_bytes()[x as usize] }
    };
    // Empty space reachable from the edge is outside; the rest of the '.'s are engraved, and
    // the body's relief runs over them as if they were flat.
    let mut outside = vec![false; (w * h) as usize];
    let mut todo: Vec<(i32, i32)> = (0..w).flat_map(|x| [(x, 0), (x, h - 1)]).chain((0..h).flat_map(|y| [(0, y), (w - 1, y)])).collect();
    while let Some((x, y)) = todo.pop() {
        if x < 0 || y < 0 || x >= w || y >= h || outside[(y * w + x) as usize] || at(x, y) != b'.' {
            continue;
        }
        outside[(y * w + x) as usize] = true;
        todo.extend([(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]);
    }
    let light = relief(w, h, |x, y| x >= 0 && y >= 0 && x < w && y < h && !outside[(y * w + x) as usize], 2.0);
    let mut c = Canvas::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let t = light[(y * w + x) as usize] - 0.08 - 0.16 * y as f32 / h as f32;
            let colour = match at(x, y) {
                b'#' => fill(ramp, t, x, y),
                b'o' => ramp[ramp.len() - 1],
                b'.' => continue,
                other => panic!("icon masks use . # o, not {:?}", other as char),
            };
            c.set(x, y, colour);
        }
    }
    c.outline(outline_for);
    seal(&mut c);
    c
}

/// Frames of one size side by side, `cols` to a row.
pub fn sheet(frames: &[Canvas], cols: u32) -> Canvas {
    let (fw, fh) = (frames[0].w, frames[0].h);
    assert!(frames.iter().all(|f| (f.w, f.h) == (fw, fh)), "frames of one size");
    let rows = (frames.len() as u32).div_ceil(cols);
    let mut s = Canvas::new(fw * cols, fh * rows);
    for (i, f) in frames.iter().enumerate() {
        s.blit(f, ((i as u32 % cols) * fw) as i32, ((i as u32 / cols) * fh) as i32);
    }
    s
}

/// One of each kind, for the preview and the tests (Orbital's own sprites are `orbital::art`).
pub fn specimens() -> Vec<(String, Canvas, u32)> {
    const SCOUT: &[&str] = &[".....#", "....##", "....#c", "...##c", "...#cc", "...###", "..#a##", ".##a##", "###a##", "##.###", "#..###", "...#ee"];
    const HAULER: &[&str] = &[
        "........#", ".......##", ".......#c", "......##c", "......#cc", "......#cc", ".....###c", ".....####", ".....##a#", "....###a#", "...####a#", "..#####a#",
        ".######a#", "#######a#", "l######a#", "#..#####.", "...#ee#..", "...#ee#..",
    ];
    let mut out = vec![
        ("ship".to_string(), ship(&ShipSpec { half: SCOUT, hull: STEEL, accent: GOLD, canopy: TEAL }), 6),
        ("ship-hauler".to_string(), ship(&ShipSpec { half: HAULER, hull: STEEL, accent: TEAL, canopy: GOLD }), 6),
    ];
    let planets = [
        ("planet-oceanic", PlanetSpec { radius: 24, surface: Surface::Oceanic, ramp_a: TEAL, ramp_b: GREEN, seed: 7, ring: None, atmosphere: Some(TEAL[4]) }),
        ("planet-banded", PlanetSpec { radius: 24, surface: Surface::Banded, ramp_a: GOLD, ramp_b: VIOLET, seed: 7, ring: Some(STEEL), atmosphere: Some(GOLD[4]) }),
        ("planet-rocky", PlanetSpec { radius: 24, surface: Surface::Rocky { craters: 9 }, ramp_a: STEEL, ramp_b: STEEL, seed: 7, ring: None, atmosphere: None }),
        ("planet-icy", PlanetSpec { radius: 24, surface: Surface::Icy, ramp_a: STEEL, ramp_b: TEAL, seed: 7, ring: None, atmosphere: Some(TEAL[3]) }),
        ("planet-molten", PlanetSpec { radius: 24, surface: Surface::Molten, ramp_a: RED, ramp_b: GOLD, seed: 7, ring: None, atmosphere: Some(GOLD[3]) }),
    ];
    for (name, spec) in &planets {
        out.push((name.to_string(), planet(spec), 4));
    }
    out.push(("asteroids".to_string(), sheet(&asteroid_frames(3, 24, 8, STEEL), 8), 4));
    let lit = |lights_on| station(&StationSpec { size: 56, spokes: 6, panels: true, hull: STEEL, glass: TEAL, lights_on });
    out.push(("station".to_string(), sheet(&[lit(true), lit(false)], 2), 4));
    out.push(("explosion".to_string(), sheet(&explosion_frames(5, 32, 6), 6), 4));
    out.push(("thruster".to_string(), sheet(&thruster_frames(6, 8, 12, 4, GOLD), 4), 6));
    const COIN: &[&str] = &[
        "............", "....####....", "..#oo#####..", "..#o....##..", ".##.####.##.", ".##.####.##.", ".##.####.##.", ".##.####.##.", "..##....##..", "..########..",
        "....####....", "............",
    ];
    const CRATE: &[&str] = &[
        "............", ".oooooooooo.", ".##########.", ".##.####.##.", ".###.##.###.", ".####..####.", ".####..####.", ".###.##.###.", ".##.####.##.", ".##########.",
        ".##########.", "............",
    ];
    const GEM: &[&str] = &[
        "............", "....####....", "...#oo###...", "..#oo#####..", ".##o#######.", ".##########.", "..########..", "...######...", "....####....", ".....##.....",
        "............", "............",
    ];
    out.push(("icons".to_string(), sheet(&[icon(COIN, GOLD), icon(CRATE, STEEL), icon(GEM, TEAL), icon(GEM, VIOLET)], 4), 6));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{luma, RAMPS, STEEL, TEAL, GOLD, GREEN, VIOLET};

    const TEST_SHIP: &[&str] = &[
        ".....#", "....##", "....#c", "...##c", "...#cc", "...###", "..#a##", ".##a##", "###a##", "##.###", "#..###", "...#ee",
    ];

    fn mean_luma(c: &Canvas, xs: std::ops::Range<i32>, ys: std::ops::Range<i32>) -> f32 {
        let px: Vec<f32> = ys.flat_map(|y| xs.clone().map(move |x| (x, y))).map(|(x, y)| c.get(x, y)).filter(|&p| p != 0).map(luma).collect();
        px.iter().sum::<f32>() / px.len().max(1) as f32
    }

    /// Every filled pixel touching an empty one (or the edge) is some ramp's darkest.
    fn outlined(c: &Canvas) -> bool {
        let darkest: Vec<u8> = RAMPS.iter().map(|r| r[0]).collect();
        (0..c.h as i32).all(|y| {
            (0..c.w as i32).all(|x| {
                let p = c.get(x, y);
                p == 0 || darkest.contains(&p) || [(0, -1), (-1, 0), (1, 0), (0, 1)].iter().all(|(dx, dy)| c.get(x + dx, y + dy) != 0)
            })
        })
    }

    #[test]
    fn ships_are_symmetric_outlined_shaded_and_lit_from_the_left() {
        let c = ship(&ShipSpec { half: TEST_SHIP, hull: STEEL, accent: GOLD, canopy: TEAL });
        assert_eq!((c.w, c.h), (13, 14));
        for y in 0..c.h as i32 {
            for x in 0..c.w as i32 {
                assert_eq!(c.get(x, y) != 0, c.get(c.w as i32 - 1 - x, y) != 0, "mask symmetric at {x},{y}");
            }
        }
        assert!(c.colours() >= 7, "shaded, not flat: {} colours", c.colours());
        assert!(outlined(&c));
        assert_eq!(c.get(0, 0), 0);
        let mid = c.w as i32 / 2;
        assert!(mean_luma(&c, 0..mid, 0..c.h as i32) > mean_luma(&c, mid + 1..c.w as i32, 0..c.h as i32));
    }

    #[test]
    fn planets_are_lit_from_the_top_left_and_ringed_ones_are_wider() {
        for surface in [Surface::Rocky { craters: 6 }, Surface::Oceanic, Surface::Banded, Surface::Icy, Surface::Molten] {
            let c = planet(&PlanetSpec { radius: 20, surface, ramp_a: TEAL, ramp_b: GREEN, seed: 5, ring: None, atmosphere: Some(TEAL[4]) });
            let (w, h) = (c.w as i32, c.h as i32);
            assert!(mean_luma(&c, 0..w / 2, 0..h / 2) > mean_luma(&c, w / 2..w, h / 2..h), "{surface:?}");
            assert!(c.colours() >= 4, "{surface:?}");
            assert_eq!(c.get(0, 0), 0);
        }
        let ringed = planet(&PlanetSpec { radius: 20, surface: Surface::Banded, ramp_a: GOLD, ramp_b: VIOLET, seed: 2, ring: Some(STEEL), atmosphere: None });
        let filled_cols = (0..ringed.w as i32).filter(|&x| (0..ringed.h as i32).any(|y| ringed.get(x, y) != 0)).count();
        assert!(filled_cols > 48, "the ring reaches past the disc: {filled_cols}");
    }

    #[test]
    fn asteroids_rotate_and_explosions_grow() {
        let rocks = asteroid_frames(11, 24, 8, STEEL);
        assert_eq!(rocks.len(), 8);
        for (i, a) in rocks.iter().enumerate() {
            assert_eq!((a.w, a.h), (24, 24));
            assert!(a.colours() >= 4 && outlined(a));
            for b in &rocks[i + 1..] {
                assert_ne!(a.px, b.px, "every frame differs");
            }
        }
        let boom = explosion_frames(3, 32, 6);
        let area = |c: &Canvas| c.px.iter().filter(|&&p| p != 0).count();
        assert!(area(&boom[2]) > area(&boom[0]), "it grows");
        let flame = thruster_frames(4, 8, 12, 4, GOLD);
        assert_eq!(flame.len(), 4);
        assert_ne!(flame[0].px, flame[1].px, "it flickers");
    }

    #[test]
    fn stations_icons_and_sheets() {
        let on = station(&StationSpec { size: 48, spokes: 4, panels: true, hull: STEEL, glass: TEAL, lights_on: true });
        let off = station(&StationSpec { size: 48, spokes: 4, panels: true, hull: STEEL, glass: TEAL, lights_on: false });
        assert!(on.colours() >= 8 && outlined(&on));
        assert_ne!(on.px, off.px, "the docking lights blink");
        let i = icon(&["....##......", "...####.....", "..##oo##....", "..######....", "...####.....", "....##......", "............", "............", "............", "............", "............", "............"], GOLD);
        assert_eq!((i.w, i.h), (12, 12));
        assert!(outlined(&i));
        let s = sheet(&[on.clone(), off.clone(), on.clone()], 2);
        assert_eq!((s.w, s.h), (96, 96));
    }

    #[test]
    fn sprites_are_deterministic() {
        let a = specimens();
        let b = specimens();
        assert_eq!(a.len(), b.len());
        for ((na, ca, _), (nb, cb, _)) in a.iter().zip(&b) {
            assert_eq!((na, &ca.px), (nb, &cb.px));
        }
    }
}
