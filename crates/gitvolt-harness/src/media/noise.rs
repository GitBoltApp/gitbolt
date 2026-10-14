//! Value noise and fractal sums of it: nebulae, planet bands, asteroid outlines.

use super::rng::hash2;

fn lattice(seed: u64, x: i32, y: i32) -> f32 {
    (hash2(seed, x, y) >> 40) as f32 / 16_777_216.0
}

fn ease(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Smooth noise in [0, 1): eased bilinear interpolation over a hashed lattice.
pub fn value(seed: u64, x: f32, y: f32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (tx, ty) = (ease(x - x0), ease(y - y0));
    let (ix, iy) = (x0 as i32, y0 as i32);
    let top = lattice(seed, ix, iy) + (lattice(seed, ix + 1, iy) - lattice(seed, ix, iy)) * tx;
    let bottom = lattice(seed, ix, iy + 1) + (lattice(seed, ix + 1, iy + 1) - lattice(seed, ix, iy + 1)) * tx;
    (top + (bottom - top) * ty).min(0.999_999)
}

/// `octaves` of `value`, each at twice the frequency and half the weight, normalised to [0, 1).
pub fn fbm(seed: u64, x: f32, y: f32, octaves: u32) -> f32 {
    let (mut sum, mut weight, mut total, mut freq) = (0.0, 1.0, 0.0, 1.0);
    for o in 0..octaves {
        sum += value(seed.wrapping_add(o as u64 * 0x9E37_79B9), x * freq, y * freq) * weight;
        total += weight;
        weight *= 0.5;
        freq *= 2.0;
    }
    (sum / total).min(0.999_999)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_is_bounded_smooth_and_repeatable() {
        for i in 0..2_000 {
            let (x, y) = (i as f32 * 0.37, i as f32 * 0.11);
            let v = value(9, x, y);
            assert!((0.0..1.0).contains(&v));
            assert!((value(9, x + 0.01, y) - v).abs() < 0.05, "smooth at {x},{y}");
            assert_eq!(v, value(9, x, y));
            let f = fbm(9, x, y, 4);
            assert!((0.0..1.0).contains(&f));
        }
        assert_ne!(value(1, 0.5, 0.5), value(2, 0.5, 0.5));
    }
}
