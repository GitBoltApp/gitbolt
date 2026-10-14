//! PNG encoders: indexed (pixel art, transparency through tRNS) and RGB(A) (smooth scenes,
//! Paeth-filtered), deflated at the best level.

use flate2::{write::ZlibEncoder, Compression};
use std::io::Write;

pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in bytes {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

pub(crate) fn zlib(raw: &[u8]) -> Vec<u8> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::best());
    z.write_all(raw).expect("deflate into memory");
    z.finish().expect("deflate into memory")
}

fn png(w: u32, h: u32, colour_type: u8, extra: &[(&[u8; 4], Vec<u8>)], raw: &[u8]) -> Vec<u8> {
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, colour_type, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    chunk(&mut out, b"IHDR", &ihdr);
    for (kind, data) in extra {
        chunk(&mut out, kind, data);
    }
    chunk(&mut out, b"IDAT", &zlib(raw));
    chunk(&mut out, b"IEND", &[]);
    out
}

/// An 8-bit indexed PNG; `pixels` index `palette` (RGBA). Entries with alpha below 255 go in
/// tRNS (up to the last such entry, as the format allows).
pub fn indexed(w: u32, h: u32, palette: &[[u8; 4]], pixels: &[u8]) -> Vec<u8> {
    assert_eq!(pixels.len(), (w * h) as usize, "pixel count");
    assert!(!palette.is_empty() && palette.len() <= 256, "palette size");
    let plte: Vec<u8> = palette.iter().flat_map(|c| [c[0], c[1], c[2]]).collect();
    let alpha: Vec<u8> = palette.iter().map(|c| c[3]).collect();
    let mut extra = vec![(b"PLTE", plte)];
    if let Some(last) = alpha.iter().rposition(|&a| a != 255) {
        extra.push((b"tRNS", alpha[..=last].to_vec()));
    }
    let mut raw = Vec::with_capacity(((w + 1) * h) as usize);
    for row in pixels.chunks(w as usize) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    png(w, h, 3, &extra, &raw)
}

pub(crate) fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = a as i16 + b as i16 - c as i16;
    let (pa, pb, pc) = ((p - a as i16).abs(), (p - b as i16).abs(), (p - c as i16).abs());
    if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c }
}

/// Rows of `bpp`-byte pixels, each Paeth-filtered.
fn filtered(rows: &[Vec<u8>], bpp: usize) -> Vec<u8> {
    let mut raw = Vec::with_capacity(rows.iter().map(|r| r.len() + 1).sum());
    let empty = vec![0u8; rows.first().map_or(0, Vec::len)];
    for (y, row) in rows.iter().enumerate() {
        let prev = if y == 0 { &empty } else { &rows[y - 1] };
        raw.push(4);
        for i in 0..row.len() {
            let a = if i >= bpp { row[i - bpp] } else { 0 };
            let c = if i >= bpp { prev[i - bpp] } else { 0 };
            raw.push(row[i].wrapping_sub(paeth(a, prev[i], c)));
        }
    }
    raw
}

/// An 8-bit RGB PNG drawn by `f(x, y)`.
pub fn rgb(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let rows: Vec<Vec<u8>> = (0..h).map(|y| (0..w).flat_map(|x| f(x, y)).collect()).collect();
    png(w, h, 2, &[], &filtered(&rows, 3))
}

/// An 8-bit RGBA PNG.
pub fn rgba(w: u32, h: u32, pixels: &[[u8; 4]]) -> Vec<u8> {
    assert_eq!(pixels.len(), (w * h) as usize, "pixel count");
    let rows: Vec<Vec<u8>> = pixels.chunks(w as usize).map(|r| r.iter().flatten().copied().collect()).collect();
    png(w, h, 6, &[], &filtered(&rows, 4))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// The chunks of `png` (kind, data), each CRC checked.
    fn chunks(png: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let mut out = Vec::new();
        let mut at = 8;
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let kind: [u8; 4] = png[at + 4..at + 8].try_into().unwrap();
            let data = png[at + 8..at + 8 + len].to_vec();
            let crc = u32::from_be_bytes(png[at + 8 + len..at + 12 + len].try_into().unwrap());
            assert_eq!(crc, crc32(&png[at + 4..at + 8 + len]), "{} CRC", String::from_utf8_lossy(&kind));
            out.push((kind, data));
            at += 12 + len;
        }
        out
    }

    fn inflate(chunks: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
        let idat: Vec<u8> = chunks.iter().filter(|c| &c.0 == b"IDAT").flat_map(|c| c.1.clone()).collect();
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&idat[..]).read_to_end(&mut raw).unwrap();
        raw
    }

    #[test]
    fn indexed_png_has_palette_transparency_and_rows() {
        let palette = [[0, 0, 0, 0], [255, 0, 0, 255], [0, 255, 0, 255]];
        let pixels = [0, 1, 2, 1, 2, 0];
        let png = indexed(3, 2, &palette, &pixels);
        let cs = chunks(&png);
        let kinds: Vec<&[u8; 4]> = cs.iter().map(|c| &c.0).collect();
        assert_eq!(kinds, [b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"]);
        assert_eq!(cs[0].1[8..10], [8, 3], "8-bit indexed");
        assert_eq!(cs[1].1.len(), 9);
        assert_eq!(cs[2].1, [0], "only the transparent entry, trailing opaque ones dropped");
        assert_eq!(inflate(&cs), [0, 0, 1, 2, 0, 1, 2, 0]);
        if let Some((format, w, h, _)) = crate::media::check::pillow(&png, "png") {
            assert_eq!((format.as_str(), w, h), ("PNG", 3, 2));
        }
    }

    #[test]
    fn opaque_palette_has_no_trns() {
        let png = indexed(1, 1, &[[9, 9, 9, 255]], &[0]);
        assert!(chunks(&png).iter().all(|c| &c.0 != b"tRNS"));
    }

    #[test]
    fn rgb_png_unfilters_to_the_pixels() {
        let f = |x: u32, y: u32| [(x * 40) as u8, (y * 50) as u8, ((x + y) * 20) as u8];
        let png = rgb(5, 4, f);
        let raw = inflate(&chunks(&png));
        assert_eq!(raw.len(), (5 * 3 + 1) * 4);
        // Undo Paeth (filter 4) row by row and compare.
        let stride = 15;
        let mut prev = vec![0u8; stride];
        for y in 0..4u32 {
            let row = &raw[(y as usize) * (stride + 1)..(y as usize + 1) * (stride + 1)];
            assert_eq!(row[0], 4, "Paeth");
            let mut cur = vec![0u8; stride];
            for i in 0..stride {
                let a = if i >= 3 { cur[i - 3] } else { 0 };
                let c = if i >= 3 { prev[i - 3] } else { 0 };
                cur[i] = row[1 + i].wrapping_add(paeth(a, prev[i], c));
            }
            for x in 0..5u32 {
                assert_eq!(cur[(x * 3) as usize..(x * 3 + 3) as usize], f(x, y));
            }
            prev = cur;
        }
        if let Some((format, w, h, _)) = crate::media::check::pillow(&png, "png") {
            assert_eq!((format.as_str(), w, h), ("PNG", 5, 4));
        }
    }

    #[test]
    fn rgba_png_is_colour_type_6() {
        let png = rgba(2, 1, &[[1, 2, 3, 4], [5, 6, 7, 8]]);
        assert_eq!(chunks(&png)[0].1[8..10], [8, 6]);
    }
}
