//! Orbital's palette: 32 colours in seven ramps on a deep navy, built around GitVolt's lane
//! colours (teal, orange, violet, gold). Each ramp runs dark to light with its shadows shifted
//! cool and its highlights warm, the usual pixel-art practice that keeps shading from looking
//! grey. Index 0 is transparent.

pub const PALETTE: [[u8; 4]; 32] = [
    [0, 0, 0, 0],
    // space
    [7, 10, 20, 255], [14, 20, 36, 255], [24, 33, 58, 255], [37, 50, 85, 255],
    // violet
    [44, 31, 74, 255], [75, 47, 115, 255], [116, 70, 163, 255], [168, 117, 207, 255],
    // teal
    [11, 58, 64, 255], [19, 96, 102, 255], [31, 143, 138, 255], [60, 194, 174, 255], [164, 240, 206, 255],
    // gold
    [74, 28, 20, 255], [138, 52, 24, 255], [208, 96, 42, 255], [240, 149, 58, 255], [255, 201, 94, 255], [255, 242, 176, 255],
    // red
    [61, 15, 34, 255], [125, 29, 54, 255], [201, 52, 74, 255],
    // steel: plum darks, so outlines and shadows stay apart from the navy backdrop
    [43, 13, 46, 255], [68, 58, 70, 255], [82, 90, 116, 255], [126, 136, 159, 255], [180, 188, 203, 255], [241, 239, 230, 255],
    // green
    [23, 61, 42, 255], [47, 110, 60, 255], [106, 168, 79, 255],
];

pub const SPACE: &[u8] = &[1, 2, 3, 4];
pub const VIOLET: &[u8] = &[5, 6, 7, 8];
pub const TEAL: &[u8] = &[9, 10, 11, 12, 13];
pub const GOLD: &[u8] = &[14, 15, 16, 17, 18, 19];
pub const RED: &[u8] = &[20, 21, 22];
pub const STEEL: &[u8] = &[23, 24, 25, 26, 27, 28];
pub const GREEN: &[u8] = &[29, 30, 31];
pub const RAMPS: [&[u8]; 7] = [SPACE, VIOLET, TEAL, GOLD, RED, STEEL, GREEN];

pub fn ramp_of(c: u8) -> &'static [u8] {
    RAMPS.into_iter().find(|r| r.contains(&c)).unwrap_or_else(|| panic!("colour {c} is in no ramp"))
}

/// What outlines a pixel of colour `c`: its ramp's darkest (selective outlining).
pub fn outline_for(c: u8) -> u8 {
    ramp_of(c)[0]
}

pub fn luma(c: u8) -> f32 {
    let [r, g, b, _] = PALETTE[c as usize];
    0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramps_partition_the_palette_and_rise_in_luma() {
        let mut seen: Vec<u8> = RAMPS.iter().flat_map(|r| r.iter().copied()).collect();
        seen.sort();
        assert_eq!(seen, (1..32).collect::<Vec<u8>>(), "every colour in exactly one ramp");
        for ramp in RAMPS {
            assert!(ramp.windows(2).all(|w| luma(w[0]) < luma(w[1])), "{ramp:?} rises");
        }
        assert_eq!(PALETTE[0][3], 0);
        assert!(PALETTE[1..].iter().all(|c| c[3] == 255));
    }

    #[test]
    fn shadows_are_cooler_than_highlights() {
        let bias = |c: u8| PALETTE[c as usize][2] as i32 - PALETTE[c as usize][0] as i32;
        for ramp in [STEEL, GOLD, TEAL] {
            assert!(bias(ramp[0]) > bias(ramp[ramp.len() - 1]), "{ramp:?}");
        }
    }

    #[test]
    fn outline_is_the_ramps_darkest() {
        assert_eq!(outline_for(STEEL[4]), STEEL[0]);
        assert_eq!(outline_for(GOLD[2]), GOLD[0]);
        assert_eq!(ramp_of(TEAL[3]), TEAL);
    }

    /// Björn Ottosson's OKLab, where Euclidean distance tracks how different two colours look.
    fn oklab(c: u8) -> [f32; 3] {
        let lin = |u: u8| {
            let u = u as f32 / 255.0;
            if u <= 0.04045 { u / 12.92 } else { ((u + 0.055) / 1.055).powf(2.4) }
        };
        let [r, g, b, _] = PALETTE[c as usize].map(lin);
        let l = (0.4122215 * r + 0.5363325 * g + 0.0514460 * b).cbrt();
        let m = (0.2119035 * r + 0.6806995 * g + 0.107397 * b).cbrt();
        let s = (0.0883025 * r + 0.2817188 * g + 0.6299787 * b).cbrt();
        [
            0.2104543 * l + 0.7936178 * m - 0.004072 * s,
            1.9779985 * l - 2.4285922 * m + 0.4505937 * s,
            0.0259040 * l + 0.7827718 * m - 0.8086758 * s,
        ]
    }

    fn distance(a: u8, b: u8) -> f32 {
        let (a, b) = (oklab(a), oklab(b));
        a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f32>().sqrt()
    }

    #[test]
    fn outlines_stand_out_from_space() {
        // VIOLET's and TEAL's darkest sit 0.048 and 0.058 from SPACE's two lightest (nebula
        // tones, not the backdrop), so they get a lower floor that still stops them drifting closer.
        for (ramp, floor) in [(VIOLET, 0.045), (TEAL, 0.045), (GOLD, 0.06), (RED, 0.06), (STEEL, 0.06), (GREEN, 0.06)] {
            for &s in SPACE {
                let d = distance(outline_for(ramp[0]), s);
                assert!(d >= floor, "outline {} is {d:.3} from space colour {s}", ramp[0]);
            }
        }
    }
}
