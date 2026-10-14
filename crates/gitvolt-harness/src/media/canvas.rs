//! An indexed canvas over `palette::PALETTE`: what every sprite, scene and frame is drawn on.

use super::palette::PALETTE;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canvas {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

impl Canvas {
    pub fn new(w: u32, h: u32) -> Canvas {
        Canvas::filled(w, h, 0)
    }

    pub fn filled(w: u32, h: u32, c: u8) -> Canvas {
        Canvas { w, h, px: vec![c; (w * h) as usize] }
    }

    fn inside(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as u32) < self.w && (y as u32) < self.h
    }

    pub fn get(&self, x: i32, y: i32) -> u8 {
        if self.inside(x, y) { self.px[(y as u32 * self.w + x as u32) as usize] } else { 0 }
    }

    pub fn set(&mut self, x: i32, y: i32, c: u8) {
        if self.inside(x, y) {
            let i = (y as u32 * self.w + x as u32) as usize;
            self.px[i] = c;
        }
    }

    pub fn fill_rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: u8) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.set(xx, yy, c);
            }
        }
    }

    /// Bresenham.
    pub fn line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, c: u8) {
        let (dx, dy) = ((x1 - x0).abs(), -(y1 - y0).abs());
        let (sx, sy) = (if x0 < x1 { 1 } else { -1 }, if y0 < y1 { 1 } else { -1 });
        let (mut x, mut y, mut err) = (x0, y0, dx + dy);
        loop {
            self.set(x, y, c);
            if x == x1 && y == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
    }

    pub fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, c: u8) {
        self.fill_ellipse(cx, cy, r, r, c);
    }

    /// Pixels whose centres fall inside.
    pub fn fill_ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, c: u8) {
        for y in (cy - ry).floor() as i32..=(cy + ry).ceil() as i32 {
            for x in (cx - rx).floor() as i32..=(cx + rx).ceil() as i32 {
                let (dx, dy) = ((x as f32 + 0.5 - cx) / rx, (y as f32 + 0.5 - cy) / ry);
                if dx * dx + dy * dy <= 1.0 {
                    self.set(x, y, c);
                }
            }
        }
    }

    /// The outline of an ellipse, one pixel wide; `dash` > 0 draws `dash` steps on, `dash` off.
    pub fn ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, c: u8, dash: u32) {
        let steps = ((rx + ry) * std::f32::consts::PI * 1.5).ceil().max(8.0) as u32;
        let mut last = (i32::MIN, i32::MIN);
        let mut n = 0u32;
        for i in 0..steps {
            let a = i as f32 / steps as f32 * std::f32::consts::TAU;
            let p = ((cx + rx * a.cos()).floor() as i32, (cy + ry * a.sin()).floor() as i32);
            if p == last {
                continue;
            }
            last = p;
            if dash == 0 || (n / dash).is_multiple_of(2) {
                self.set(p.0, p.1, c);
            }
            n += 1;
        }
    }

    /// Even-odd scanline fill, sampled at pixel centres.
    pub fn fill_polygon(&mut self, pts: &[(f32, f32)], c: u8) {
        let ymin = pts.iter().map(|p| p.1).fold(f32::MAX, f32::min).floor() as i32;
        let ymax = pts.iter().map(|p| p.1).fold(f32::MIN, f32::max).ceil() as i32;
        for y in ymin..=ymax {
            let sy = y as f32 + 0.5;
            let mut xs = Vec::new();
            for i in 0..pts.len() {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                if (a.1 <= sy) != (b.1 <= sy) {
                    xs.push(a.0 + (sy - a.1) / (b.1 - a.1) * (b.0 - a.0));
                }
            }
            xs.sort_by(f32::total_cmp);
            for pair in xs.chunks(2) {
                if let [x0, x1] = pair {
                    for x in (x0 - 0.5).ceil() as i32..=(x1 - 0.5).floor() as i32 {
                        self.set(x, y, c);
                    }
                }
            }
        }
    }

    /// Colours every transparent pixel next to (4-neighbour) a filled one, with `colour_for`
    /// of that neighbour: selective outlining when it's `palette::outline_for`.
    pub fn outline(&mut self, colour_for: impl Fn(u8) -> u8) {
        let src = self.clone();
        for y in 0..self.h as i32 {
            for x in 0..self.w as i32 {
                if src.get(x, y) != 0 {
                    continue;
                }
                let mut neighbours = [(0, -1), (-1, 0), (1, 0), (0, 1)].into_iter().map(|(dx, dy)| src.get(x + dx, y + dy));
                if let Some(n) = neighbours.find(|&n| n != 0) {
                    self.set(x, y, colour_for(n));
                }
            }
        }
    }

    pub fn blit(&mut self, src: &Canvas, x: i32, y: i32) {
        for sy in 0..src.h as i32 {
            for sx in 0..src.w as i32 {
                let c = src.get(sx, sy);
                if c != 0 {
                    self.set(x + sx, y + sy, c);
                }
            }
        }
    }

    /// Nearest-neighbour, `k` times larger.
    pub fn scaled(&self, k: u32) -> Canvas {
        let mut out = Canvas::new(self.w * k, self.h * k);
        for y in 0..out.h {
            for x in 0..out.w {
                out.px[(y * out.w + x) as usize] = self.px[((y / k) * self.w + x / k) as usize];
            }
        }
        out
    }

    pub fn colours(&self) -> usize {
        let mut seen = [false; 256];
        for &p in &self.px {
            seen[p as usize] = true;
        }
        seen[1..].iter().filter(|&&s| s).count()
    }

    pub fn to_png(&self) -> Vec<u8> {
        super::png::indexed(self.w, self.h, &PALETTE, &self.px)
    }
}

const BAYER4: [[u8; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

pub fn bayer4(x: i32, y: i32) -> f32 {
    (BAYER4[(y & 3) as usize][(x & 3) as usize] as f32 + 0.5) / 16.0
}

/// How a tone between two ramp steps is drawn: `None` rounds to the nearest; `Checker(band)`
/// checkers only within `band` of the midpoint (clean bands with a dithered seam, for sprites);
/// `Bayer` dithers the whole way (soft gradients, for nebulae and skies).
#[derive(Clone, Copy, Debug)]
pub enum Dither {
    None,
    Checker(f32),
    Bayer,
}

/// The colour of `ramp` for tone `t` (0 darkest … 1 lightest) at pixel (x, y).
pub fn tone(ramp: &[u8], t: f32, x: i32, y: i32, d: Dither) -> u8 {
    let top = ramp.len() - 1;
    let pos = t.clamp(0.0, 1.0) * top as f32;
    let lo = (pos.floor() as usize).min(top);
    let frac = pos - lo as f32;
    let up = match d {
        Dither::None => frac >= 0.5,
        Dither::Checker(band) => {
            if frac < 0.5 - band / 2.0 {
                false
            } else if frac > 0.5 + band / 2.0 {
                true
            } else {
                (x + y).rem_euclid(2) == 0
            }
        }
        Dither::Bayer => frac > bayer4(x, y),
    };
    ramp[if up { (lo + 1).min(top) } else { lo }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{outline_for, STEEL};

    #[test]
    fn set_get_clip() {
        let mut c = Canvas::new(4, 3);
        c.set(-1, 0, 5);
        c.set(4, 0, 5);
        c.set(1, 2, 7);
        assert_eq!(c.get(1, 2), 7);
        assert_eq!(c.get(-1, 0), 0);
        assert_eq!(c.px.iter().filter(|&&p| p != 0).count(), 1);
    }

    #[test]
    fn circle_area_is_about_pi_r_squared() {
        let mut c = Canvas::new(64, 64);
        c.fill_circle(32.0, 32.0, 20.0, 3);
        let area = c.px.iter().filter(|&&p| p == 3).count() as f32;
        assert!((area - std::f32::consts::PI * 400.0).abs() < 40.0, "{area}");
    }

    #[test]
    fn polygon_fills_a_triangle() {
        let mut c = Canvas::new(10, 10);
        c.fill_polygon(&[(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)], 2);
        let area = c.px.iter().filter(|&&p| p == 2).count();
        assert!((45..=55).contains(&area), "{area}");
        assert_eq!(c.get(1, 1), 2);
        assert_eq!(c.get(8, 8), 0);
    }

    #[test]
    fn outline_rings_a_square_with_its_ramps_darkest() {
        let mut c = Canvas::new(7, 7);
        c.fill_rect(2, 2, 3, 3, STEEL[3]);
        c.outline(outline_for);
        assert_eq!(c.px.iter().filter(|&&p| p == STEEL[0]).count(), 12, "4-neighbour ring");
        assert_eq!(c.get(1, 1), 0, "corners stay open");
        assert_eq!(c.get(3, 3), STEEL[3]);
    }

    #[test]
    fn tone_hits_the_ends_and_dithers_between() {
        let ramp = [1, 2, 3];
        assert_eq!(tone(&ramp, 0.0, 0, 0, Dither::Bayer), 1);
        assert_eq!(tone(&ramp, 1.0, 5, 5, Dither::Bayer), 3);
        let mixed: Vec<u8> = (0..4).map(|x| tone(&ramp, 0.25, x, 0, Dither::Checker(0.6))).collect();
        assert!(mixed.contains(&1) && mixed.contains(&2), "{mixed:?}");
        assert_eq!(tone(&ramp, 0.05, 1, 0, Dither::Checker(0.2)), 1, "outside the band: nearest");
    }

    #[test]
    fn blit_scale_and_png() {
        let mut a = Canvas::new(2, 2);
        a.set(0, 0, 4);
        let mut b = Canvas::filled(4, 4, 1);
        b.blit(&a, 1, 1);
        assert_eq!((b.get(1, 1), b.get(2, 2)), (4, 1), "0 is transparent");
        let s = a.scaled(3);
        assert_eq!((s.w, s.h, s.get(2, 2), s.get(3, 3)), (6, 6, 4, 0));
        assert_eq!(b.colours(), 2);
        assert_eq!(&b.to_png()[1..4], b"PNG");
    }

    #[test]
    fn dashed_ellipse_has_gaps() {
        let mut solid = Canvas::new(40, 40);
        solid.ellipse(20.0, 20.0, 15.0, 9.0, 3, 0);
        let mut dashed = Canvas::new(40, 40);
        dashed.ellipse(20.0, 20.0, 15.0, 9.0, 3, 3);
        let count = |c: &Canvas| c.px.iter().filter(|&&p| p == 3).count();
        assert!(count(&dashed) < count(&solid) * 3 / 4 && count(&dashed) > count(&solid) / 4);
    }
}
