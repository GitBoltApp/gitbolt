//! Monospaced pixel fonts as TrueType files (one square contour per pixel, a 5×9 cell on a
//! 600-unit advance), and the same glyphs drawn onto a `Canvas`.

use super::canvas::Canvas;

/// A 5×9 cell: rows 0–6 sit above the baseline (capitals use all seven), rows 7–8 below it
/// (descenders). '#' is ink, '.' is not; every row is 5 characters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Glyph {
    pub ch: char,
    pub rows: [&'static str; 9],
}

pub struct FontSpec<'a> {
    pub family: &'a str,
    pub style: &'a str,
    /// (1, 100) is "1.100".
    pub version: (u16, u16),
    pub notice: &'a str,
    pub glyphs: &'a [Glyph],
}

const UNIT: i16 = 100;
const ADVANCE: u16 = 600;

/// The glyph for `ch`, or its uppercase glyph when it has none of its own.
fn glyph_for(glyphs: &[Glyph], ch: char) -> Option<&Glyph> {
    glyphs.iter().find(|g| g.ch == ch).or_else(|| {
        let upper = ch.to_uppercase().next()?;
        (upper != ch).then(|| glyphs.iter().find(|g| g.ch == upper)).flatten()
    })
}

pub fn ttf(spec: &FontSpec) -> Vec<u8> {
    // Glyph 0 .notdef (a hollow box), 1 space, then spec.glyphs in order.
    let mut contours: Vec<Vec<Vec<(i16, i16)>>> = vec![
        vec![vec![(50, 0), (50, 700), (450, 700), (450, 0)], vec![(100, 50), (400, 50), (400, 650), (100, 650)]],
        vec![],
    ];
    for g in spec.glyphs {
        let mut glyph = Vec::new();
        for (row, line) in g.rows.iter().enumerate() {
            for (col, px) in line.bytes().enumerate() {
                if px != b'#' {
                    continue;
                }
                // Row 6 sits on the baseline: rows 7 and 8 are the descender.
                let (y1, y0) = ((7 - row as i16) * UNIT, (6 - row as i16) * UNIT);
                let (x0, x1) = (50 + col as i16 * UNIT, 50 + (col as i16 + 1) * UNIT);
                // Clockwise, as TrueType's outer contours are.
                glyph.push(vec![(x0, y0), (x0, y1), (x1, y1), (x1, y0)]);
            }
        }
        contours.push(glyph);
    }
    let num_glyphs = contours.len() as u16;

    let mut glyf = Vec::new();
    let mut loca = vec![0u32];
    let (mut max_points, mut max_contours) = (0u16, 0u16);
    let mut lsbs = Vec::new();
    for glyph in &contours {
        if glyph.is_empty() {
            lsbs.push(0i16);
            loca.push(glyf.len() as u32);
            continue;
        }
        let points: Vec<(i16, i16)> = glyph.iter().flatten().copied().collect();
        let x_min = points.iter().map(|p| p.0).min().unwrap_or(0);
        let x_max = points.iter().map(|p| p.0).max().unwrap_or(0);
        let y_min = points.iter().map(|p| p.1).min().unwrap_or(0);
        let y_max = points.iter().map(|p| p.1).max().unwrap_or(0);
        lsbs.push(x_min);
        max_points = max_points.max(points.len() as u16);
        max_contours = max_contours.max(glyph.len() as u16);
        for v in [glyph.len() as i16, x_min, y_min, x_max, y_max] {
            glyf.extend_from_slice(&v.to_be_bytes());
        }
        let mut end = 0u16;
        for c in glyph {
            end += c.len() as u16;
            glyf.extend_from_slice(&(end - 1).to_be_bytes());
        }
        glyf.extend_from_slice(&0u16.to_be_bytes()); // no instructions
        glyf.extend(std::iter::repeat_n(0x01u8, points.len())); // on-curve, 16-bit deltas
        let mut prev = 0i16;
        for p in &points {
            glyf.extend_from_slice(&(p.0 - prev).to_be_bytes());
            prev = p.0;
        }
        prev = 0;
        for p in &points {
            glyf.extend_from_slice(&(p.1 - prev).to_be_bytes());
            prev = p.1;
        }
        while glyf.len() % 4 != 0 {
            glyf.push(0);
        }
        loca.push(glyf.len() as u32);
    }

    let be16 = |out: &mut Vec<u8>, vals: &[u16]| vals.iter().for_each(|v| out.extend_from_slice(&v.to_be_bytes()));
    let mut head = Vec::new();
    head.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    let (major, minor) = spec.version;
    head.extend_from_slice(&(((major as u32) << 16) | ((minor as u32 * 65_536 + 500) / 1_000)).to_be_bytes());
    head.extend_from_slice(&0u32.to_be_bytes()); // checkSumAdjustment, set last
    head.extend_from_slice(&0x5F0F_3CF5u32.to_be_bytes());
    be16(&mut head, &[0x000B, 1000]);
    head.extend_from_slice(&3_850_000_000i64.to_be_bytes()); // created, 2025 (seconds since 1904)
    head.extend_from_slice(&3_850_000_000i64.to_be_bytes()); // modified
    for v in [0i16, -200, 550, 700] { // xMin, yMin, xMax, yMax
        head.extend_from_slice(&v.to_be_bytes());
    }
    be16(&mut head, &[0, 8, 2, 1, 0]); // macStyle, lowestRecPPEM, fontDirectionHint, long loca, glyphDataFormat

    let mut hhea = Vec::new();
    hhea.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    for v in [800i16, -200, 0] {
        hhea.extend_from_slice(&v.to_be_bytes());
    }
    be16(&mut hhea, &[ADVANCE, 0, 50, 550, 1, 0, 0, 0, 0, 0, 0, 0, num_glyphs]);

    let mut maxp = Vec::new();
    maxp.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    be16(&mut maxp, &[num_glyphs, max_points, max_contours, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);

    let last_char = spec.glyphs.iter().map(|g| g.ch as u32).max().unwrap_or(0x20).clamp(0x20, 0xFFFF) as u16;
    let mut os2 = Vec::new();
    be16(&mut os2, &[4, ADVANCE, 400, 5, 0]);
    for v in [650i16, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0] {
        os2.extend_from_slice(&v.to_be_bytes()); // sub/superscript sizes and offsets, strikeout, family class
    }
    os2.extend_from_slice(&[2, 11, 6, 9, 0, 0, 0, 0, 0, 0]); // panose
    for v in [0b11u32, 0, 0, 0] {
        os2.extend_from_slice(&v.to_be_bytes()); // Basic Latin and Latin-1 Supplement
    }
    os2.extend_from_slice(b"GBLT");
    be16(&mut os2, &[0x0040, 0x20, last_char]);
    for v in [800i16, -200, 0] {
        os2.extend_from_slice(&v.to_be_bytes());
    }
    be16(&mut os2, &[800, 200]);
    for v in [1u32, 0] {
        os2.extend_from_slice(&v.to_be_bytes());
    }
    be16(&mut os2, &[700, 700, 0, 32, 1]);

    let mut hmtx = Vec::new();
    for lsb in &lsbs {
        hmtx.extend_from_slice(&ADVANCE.to_be_bytes());
        hmtx.extend_from_slice(&lsb.to_be_bytes());
    }

    // cmap: one format 4 segment per character, then the closing 0xFFFF one.
    let mut chars: Vec<(u16, u16)> = vec![(0x20, 1)];
    for (i, g) in spec.glyphs.iter().enumerate() {
        assert!((g.ch as u32) <= 0xFFFF, "{:?} is outside the BMP", g.ch);
        chars.push((g.ch as u16, 2 + i as u16));
    }
    for lower in 'a'..='z' {
        if spec.glyphs.iter().any(|g| g.ch == lower) {
            continue;
        }
        if let Some(gid) = spec.glyphs.iter().position(|g| g.ch == lower.to_ascii_uppercase()) {
            chars.push((lower as u16, 2 + gid as u16));
        }
    }
    chars.sort();
    chars.dedup_by_key(|c| c.0);
    let seg_count = chars.len() as u16 + 1;
    let search_range = 2 * (1u16 << (15 - seg_count.leading_zeros()));
    let entry_selector = (search_range / 2).trailing_zeros() as u16;
    let mut sub = Vec::new();
    be16(&mut sub, &[4, 0, 0, seg_count * 2, search_range, entry_selector, seg_count * 2 - search_range]);
    be16(&mut sub, &chars.iter().map(|c| c.0).chain([0xFFFF]).collect::<Vec<_>>());
    be16(&mut sub, &[0]);
    be16(&mut sub, &chars.iter().map(|c| c.0).chain([0xFFFF]).collect::<Vec<_>>());
    be16(&mut sub, &chars.iter().map(|c| c.1.wrapping_sub(c.0)).chain([1]).collect::<Vec<_>>());
    be16(&mut sub, &vec![0; seg_count as usize]);
    let len = sub.len() as u16;
    sub[2..4].copy_from_slice(&len.to_be_bytes());
    let mut cmap = Vec::new();
    be16(&mut cmap, &[0, 1, 3, 1]);
    cmap.extend_from_slice(&12u32.to_be_bytes());
    cmap.extend_from_slice(&sub);

    let (family, style) = (spec.family, spec.style);
    let version = format!("Version {major}.{minor:03}");
    let names = [
        (0u16, spec.notice.to_string()),
        (1, family.to_string()),
        (2, style.to_string()),
        (3, format!("{family} {style} {version}")),
        (4, format!("{family} {style}")),
        (5, version),
        (6, format!("{}-{style}", family.replace(' ', ""))),
    ];
    let mut strings = Vec::new();
    let mut name = Vec::new();
    be16(&mut name, &[0, names.len() as u16, 6 + 12 * names.len() as u16]);
    for (id, text) in &names {
        let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        be16(&mut name, &[3, 1, 0x409, *id, utf16.len() as u16, strings.len() as u16]);
        strings.extend(utf16);
    }
    name.extend(strings);

    let mut post = Vec::new();
    post.extend_from_slice(&0x0003_0000u32.to_be_bytes());
    post.extend_from_slice(&0u32.to_be_bytes()); // italicAngle
    for v in [-100i16, 50] {
        post.extend_from_slice(&v.to_be_bytes());
    }
    for v in [1u32, 0, 0, 0, 0] {
        post.extend_from_slice(&v.to_be_bytes()); // isFixedPitch, then the memory hints
    }

    let loca_bytes: Vec<u8> = loca.iter().flat_map(|o| o.to_be_bytes()).collect();
    let tables: [(&[u8; 4], Vec<u8>); 10] = [
        (b"OS/2", os2),
        (b"cmap", cmap),
        (b"glyf", glyf),
        (b"head", head),
        (b"hhea", hhea),
        (b"hmtx", hmtx),
        (b"loca", loca_bytes),
        (b"maxp", maxp),
        (b"name", name),
        (b"post", post),
    ];
    sfnt(&tables)
}

/// Draws `text` with its top-left at (x, y), each font pixel a `scale`-square of `colour`. A
/// character with no glyph and no capital to fall back on is skipped (its advance kept).
pub fn draw_text(c: &mut Canvas, glyphs: &[Glyph], text: &str, x: i32, y: i32, scale: i32, colour: u8) -> i32 {
    for (i, ch) in text.chars().enumerate() {
        let Some(g) = glyph_for(glyphs, ch) else { continue };
        let left = x + i as i32 * 6 * scale;
        for (row, line) in g.rows.iter().enumerate() {
            for (col, px) in line.bytes().enumerate() {
                if px == b'#' {
                    c.fill_rect(left + col as i32 * scale, y + row as i32 * scale, scale, scale, colour);
                }
            }
        }
    }
    text_width(text, scale)
}

/// Six font pixels per character, less the trailing gap.
pub fn text_width(text: &str, scale: i32) -> i32 {
    (text.chars().count() as i32 * 6 - 1).max(0) * scale
}

/// The pixel font's glyphs (capitals, digits, punctuation), re-cut to 9 rows.
pub const BASIC: &[Glyph] = &[
    Glyph { ch: 'A', rows: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#", ".....", "....."] },
    Glyph { ch: 'B', rows: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####.", ".....", "....."] },
    Glyph { ch: 'C', rows: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: 'D', rows: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####.", ".....", "....."] },
    Glyph { ch: 'E', rows: ["#####", "#....", "#....", "####.", "#....", "#....", "#####", ".....", "....."] },
    Glyph { ch: 'F', rows: ["#####", "#....", "#....", "####.", "#....", "#....", "#....", ".....", "....."] },
    Glyph { ch: 'G', rows: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####", ".....", "....."] },
    Glyph { ch: 'H', rows: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#", ".....", "....."] },
    Glyph { ch: 'I', rows: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###.", ".....", "....."] },
    Glyph { ch: 'J', rows: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##..", ".....", "....."] },
    Glyph { ch: 'K', rows: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#", ".....", "....."] },
    Glyph { ch: 'L', rows: ["#....", "#....", "#....", "#....", "#....", "#....", "#####", ".....", "....."] },
    Glyph { ch: 'M', rows: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#", ".....", "....."] },
    Glyph { ch: 'N', rows: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", ".....", "....."] },
    Glyph { ch: 'O', rows: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: 'P', rows: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#....", ".....", "....."] },
    Glyph { ch: 'Q', rows: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#", ".....", "....."] },
    Glyph { ch: 'R', rows: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#", ".....", "....."] },
    Glyph { ch: 'S', rows: [".####", "#....", "#....", ".###.", "....#", "....#", "####.", ".....", "....."] },
    Glyph { ch: 'T', rows: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#..", ".....", "....."] },
    Glyph { ch: 'U', rows: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: 'V', rows: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#..", ".....", "....."] },
    Glyph { ch: 'W', rows: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#.", ".....", "....."] },
    Glyph { ch: 'X', rows: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#", ".....", "....."] },
    Glyph { ch: 'Y', rows: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#..", ".....", "....."] },
    Glyph { ch: 'Z', rows: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####", ".....", "....."] },
    Glyph { ch: '0', rows: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: '1', rows: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###.", ".....", "....."] },
    Glyph { ch: '2', rows: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####", ".....", "....."] },
    Glyph { ch: '3', rows: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: '4', rows: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#.", ".....", "....."] },
    Glyph { ch: '5', rows: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: '6', rows: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: '7', rows: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#...", ".....", "....."] },
    Glyph { ch: '8', rows: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###.", ".....", "....."] },
    Glyph { ch: '9', rows: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##..", ".....", "....."] },
    Glyph { ch: '.', rows: [".....", ".....", ".....", ".....", ".....", ".##..", ".##..", ".....", "....."] },
    Glyph { ch: ',', rows: [".....", ".....", ".....", ".....", ".##..", "..#..", ".#...", ".....", "....."] },
    Glyph { ch: '!', rows: ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#..", ".....", "....."] },
    Glyph { ch: '?', rows: [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#..", ".....", "....."] },
    Glyph { ch: '-', rows: [".....", ".....", ".....", "#####", ".....", ".....", ".....", ".....", "....."] },
    Glyph { ch: ':', rows: [".....", ".##..", ".##..", ".....", ".##..", ".##..", ".....", ".....", "....."] },
    Glyph { ch: '\'', rows: ["..#..", "..#..", ".#...", ".....", ".....", ".....", ".....", ".....", "....."] },
    Glyph { ch: '"', rows: [".#.#.", ".#.#.", ".....", ".....", ".....", ".....", ".....", ".....", "....."] },
    Glyph { ch: '(', rows: ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#.", ".....", "....."] },
    Glyph { ch: ')', rows: [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#...", ".....", "....."] },
    Glyph { ch: '/', rows: [".....", "....#", "...#.", "..#..", ".#...", "#....", ".....", ".....", "....."] },
    Glyph { ch: '+', rows: [".....", "..#..", "..#..", "#####", "..#..", "..#..", ".....", ".....", "....."] },
    Glyph { ch: '=', rows: [".....", ".....", "#####", ".....", "#####", ".....", ".....", ".....", "....."] },
    Glyph { ch: '#', rows: [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#.", ".....", "....."] },
];

/// The font file: the table directory (tags sorted), each table 4-byte aligned, checksums, and
/// `head`'s checkSumAdjustment.
fn sfnt(tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    fn checksum(bytes: &[u8]) -> u32 {
        bytes.chunks(4).fold(0u32, |sum, c| {
            let mut word = [0u8; 4];
            word[..c.len()].copy_from_slice(c);
            sum.wrapping_add(u32::from_be_bytes(word))
        })
    }
    let n = tables.len() as u16;
    let pow = 1u16 << (15 - n.leading_zeros());
    let mut out = Vec::new();
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    for v in [n, pow * 16, pow.trailing_zeros() as u16, n * 16 - pow * 16] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    let mut offset = 12 + 16 * tables.len();
    let mut head_at = 0;
    for (tag, data) in tables {
        if *tag == b"head" {
            head_at = offset;
        }
        out.extend_from_slice(*tag);
        out.extend_from_slice(&checksum(data).to_be_bytes());
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    for (_, data) in tables {
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    let adjust = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
    out[head_at + 8..head_at + 12].copy_from_slice(&adjust.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[Glyph] = &[
        Glyph { ch: 'A', rows: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#", ".....", "....."] },
        Glyph { ch: 'g', rows: [".....", ".....", ".####", "#...#", "#...#", ".####", "....#", "#...#", ".###."] },
        Glyph { ch: 'é', rows: ["...#.", "..#..", ".###.", "#...#", "#####", "#....", ".###.", ".....", "....."] },
        Glyph { ch: '\u{E000}', rows: ["..#..", ".###.", ".###.", "#####", "#####", "#####", ".###.", ".....", "....."] },
    ];

    fn spec(glyphs: &[Glyph]) -> FontSpec<'_> {
        FontSpec { family: "Orbital HUD", style: "Regular", version: (1, 100), notice: "Made up for GitVolt's showcase. Public domain.", glyphs }
    }

    fn table<'a>(font: &'a [u8], tag: &[u8; 4]) -> &'a [u8] {
        let n = u16::from_be_bytes([font[4], font[5]]) as usize;
        for i in 0..n {
            let rec = &font[12 + 16 * i..28 + 16 * i];
            if &rec[..4] == tag {
                let off = u32::from_be_bytes(rec[8..12].try_into().unwrap()) as usize;
                let len = u32::from_be_bytes(rec[12..16].try_into().unwrap()) as usize;
                return &font[off..off + len];
            }
        }
        panic!("no {} table", String::from_utf8_lossy(tag));
    }
    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_be_bytes([b[at], b[at + 1]])
    }

    /// What a strict sanitizer (Chromium's OTS) checks first: counts agree across tables, loca
    /// is monotone and ends at glyf's end, the cmap reaches real glyphs.
    #[test]
    fn font_tables_are_self_consistent() {
        let font = ttf(&spec(SAMPLE));
        assert_eq!(&font[..4], &[0, 1, 0, 0]);
        let sum = font.chunks(4).fold(0u32, |s, c| s.wrapping_add(u32::from_be_bytes(c.try_into().unwrap())));
        assert_eq!(sum, 0xB1B0_AFBA, "checkSumAdjustment balances the file");
        let num_glyphs = u16_at(table(&font, b"maxp"), 4) as usize;
        assert_eq!(num_glyphs, 2 + SAMPLE.len(), ".notdef, space, then the glyphs");
        let hhea = table(&font, b"hhea");
        assert_eq!(u16_at(hhea, 34) as usize, num_glyphs, "numberOfHMetrics");
        assert_eq!(table(&font, b"hmtx").len(), 4 * num_glyphs);
        let loca = table(&font, b"loca");
        let offs: Vec<u32> = loca.chunks(4).map(|c| u32::from_be_bytes(c.try_into().unwrap())).collect();
        assert_eq!(offs.len(), num_glyphs + 1);
        assert!(offs.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(*offs.last().unwrap() as usize, table(&font, b"glyf").len());
        let os2 = table(&font, b"OS/2");
        assert_eq!(os2.len(), 96);
        assert_eq!((u16_at(os2, 64), u16_at(os2, 66)), (0x20, 0xE000), "first and last char");
        let head = table(&font, b"head");
        assert_eq!(u32::from_be_bytes(head[4..8].try_into().unwrap()), (1 << 16) | 6554, "fontRevision 1.100");
    }

    #[test]
    fn descenders_go_below_the_baseline_and_accents_map() {
        let font = ttf(&spec(SAMPLE));
        let glyf = table(&font, b"glyf");
        let loca = table(&font, b"loca");
        let off = |gid: usize| u32::from_be_bytes(loca[4 * gid..4 * gid + 4].try_into().unwrap()) as usize;
        let y_min = |gid: usize| i16::from_be_bytes([glyf[off(gid) + 4], glyf[off(gid) + 5]]);
        assert_eq!(y_min(2), 0, "A sits on the baseline");
        assert_eq!(y_min(3), -200, "g descends two rows");
        let text = String::from_utf8_lossy(&font).replace('\0', "");
        assert!(text.contains("Orbital HUD") && text.contains("Version 1.100"));
    }

    #[test]
    fn fc_query_reads_it() {
        let Ok(dir) = tempfile::tempdir() else { return };
        let path = dir.path().join("hud.ttf");
        std::fs::write(&path, ttf(&spec(SAMPLE))).unwrap();
        let Ok(out) = std::process::Command::new("fc-query").arg(&path).output() else {
            eprintln!("skipping: no fc-query");
            return;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && text.contains("family: \"Orbital HUD\""), "{text}");
    }

    #[test]
    fn basic_glyphs_are_well_formed() {
        for g in BASIC {
            assert!(g.rows.iter().all(|r| r.len() == 5 && r.bytes().all(|b| b == b'#' || b == b'.')), "{:?}", g.ch);
            assert_eq!(&g.rows[7..], &[".....", "....."], "{:?}: no descender", g.ch);
        }
        assert!(BASIC.iter().any(|g| g.ch == 'Z') && BASIC.iter().any(|g| g.ch == '9'));
    }

    #[test]
    fn draws_text_with_fallbacks() {
        let mut c = Canvas::new(40, 12);
        let w = draw_text(&mut c, SAMPLE, "Ag?", 1, 1, 1, 5);
        assert_eq!(w, text_width("Ag?", 1));
        assert_eq!(w, 17);
        assert_eq!(c.get(2, 1), 5, "A's top bar");
        assert_eq!(c.get(8, 9), 5, "g's descender, row 8");
        let mut big = Canvas::new(40, 40);
        draw_text(&mut big, SAMPLE, "a", 0, 0, 2, 5);
        assert_eq!(big.get(2, 0), 5, "lowercase falls back to the capital, at scale 2");
    }
}
