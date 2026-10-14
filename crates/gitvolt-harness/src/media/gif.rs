//! Animated GIF89a over the 32-colour palette: a global colour table, a looping NETSCAPE block,
//! index 0 transparent, LZW-compressed frames.

use super::canvas::Canvas;
use super::palette::PALETTE;
use std::collections::HashMap;

#[derive(Default)]
struct Bits {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}

impl Bits {
    fn put(&mut self, code: u32, width: u32) {
        self.acc |= code << self.n;
        self.n += width;
        while self.n >= 8 {
            self.out.push(self.acc as u8);
            self.acc >>= 8;
            self.n -= 8;
        }
    }
    fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.out.push(self.acc as u8);
        }
        self.out
    }
}

/// GIF's variable-width LZW, as the classic encoders do it: the code width grows once the next
/// free code no longer fits, and the table clears at 4,096 codes.
pub(crate) fn lzw(min: u8, data: &[u8]) -> Vec<u8> {
    let clear = 1u32 << min;
    let end = clear + 1;
    let mut dict: HashMap<(u32, u8), u32> = HashMap::new();
    let mut next = end + 1;
    let mut width = min as u32 + 1;
    let mut bits = Bits::default();
    bits.put(clear, width);
    let mut prefix: Option<u32> = None;
    for &b in data {
        let Some(p) = prefix else {
            prefix = Some(b as u32);
            continue;
        };
        if let Some(&code) = dict.get(&(p, b)) {
            prefix = Some(code);
            continue;
        }
        bits.put(p, width);
        if next < 4096 {
            if next >= (1 << width) && width < 12 {
                width += 1;
            }
            dict.insert((p, b), next);
            next += 1;
        } else {
            bits.put(clear, width);
            dict.clear();
            next = end + 1;
            width = min as u32 + 1;
        }
        prefix = Some(b as u32);
    }
    if let Some(p) = prefix {
        bits.put(p, width);
        if next >= (1 << width) && width < 12 {
            width += 1;
        }
    }
    bits.put(end, width);
    blocks(&bits.finish())
}

/// Data sub-blocks of at most 255 bytes, then the terminator.
fn blocks(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 255 + 2);
    for chunk in data.chunks(255) {
        out.push(chunk.len() as u8);
        out.extend_from_slice(chunk);
    }
    out.push(0);
    out
}

#[cfg(test)]
pub(crate) fn unblock(data: &[u8]) -> Vec<u8> {
    let (mut out, mut at) = (Vec::new(), 0);
    while data[at] != 0 {
        let n = data[at] as usize;
        out.extend_from_slice(&data[at + 1..at + 1 + n]);
        at += 1 + n;
    }
    out
}

pub fn animated(frames: &[Canvas], delay_cs: u16) -> Vec<u8> {
    let (w, h) = (frames[0].w as u16, frames[0].h as u16);
    let mut g = b"GIF89a".to_vec();
    g.extend_from_slice(&w.to_le_bytes());
    g.extend_from_slice(&h.to_le_bytes());
    g.extend_from_slice(&[0b1111_0100, 0, 0]); // global table of 2^(4+1) = 32 colours
    for c in PALETTE {
        g.extend_from_slice(&c[..3]);
    }
    g.extend_from_slice(&[0x21, 0xFF, 11]);
    g.extend_from_slice(b"NETSCAPE2.0");
    g.extend_from_slice(&[3, 1, 0, 0, 0]); // loop forever
    for f in frames {
        assert_eq!((f.w as u16, f.h as u16), (w, h), "frames of one size");
        g.extend_from_slice(&[0x21, 0xF9, 4, 0b0000_1001]); // restore to background, transparent index
        g.extend_from_slice(&delay_cs.to_le_bytes());
        g.extend_from_slice(&[0, 0]);
        g.push(0x2C);
        g.extend_from_slice(&[0, 0, 0, 0]);
        g.extend_from_slice(&w.to_le_bytes());
        g.extend_from_slice(&h.to_le_bytes());
        g.push(0);
        g.push(5);
        g.extend_from_slice(&lzw(5, &f.px));
    }
    g.push(0x3B);
    g
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{GOLD, TEAL};

    /// A plain GIF LZW decoder, to check the encoder against.
    fn unlzw(min: u8, data: &[u8]) -> Vec<u8> {
        let clear = 1u16 << min;
        let end = clear + 1;
        let mut dict: Vec<Vec<u8>> = (0..clear).map(|i| vec![i as u8]).chain([vec![], vec![]]).collect();
        let (mut width, mut bits, mut nbits, mut out, mut prev): (u32, u32, u32, Vec<u8>, Option<Vec<u8>>) = (min as u32 + 1, 0, 0, Vec::new(), None);
        for &byte in data {
            bits |= (byte as u32) << nbits;
            nbits += 8;
            while nbits >= width {
                let code = (bits & ((1 << width) - 1)) as u16;
                bits >>= width;
                nbits -= width;
                if code == clear {
                    dict.truncate(end as usize + 1);
                    width = min as u32 + 1;
                    prev = None;
                    continue;
                }
                if code == end {
                    return out;
                }
                let entry = if (code as usize) < dict.len() {
                    dict[code as usize].clone()
                } else {
                    let p = prev.clone().expect("KwKwK needs a previous code");
                    let mut e = p.clone();
                    e.push(p[0]);
                    e
                };
                if let Some(p) = prev {
                    let mut e = p;
                    e.push(entry[0]);
                    dict.push(e);
                    if dict.len() == (1 << width) && width < 12 {
                        width += 1;
                    }
                }
                out.extend_from_slice(&entry);
                prev = Some(entry);
            }
        }
        out
    }

    #[test]
    fn lzw_round_trips() {
        let mut rng = crate::media::rng::Rng::new(1);
        let noisy: Vec<u8> = (0..20_000).map(|_| rng.below(32) as u8).collect();
        let flat = vec![3u8; 9_000];
        for data in [noisy, flat] {
            assert_eq!(unlzw(5, &unblock(&lzw(5, &data))), data);
        }
    }

    #[test]
    fn animated_gif_is_well_formed() {
        let mut a = Canvas::new(8, 6);
        a.fill_rect(1, 1, 3, 3, GOLD[3]);
        let mut b = Canvas::new(8, 6);
        b.fill_rect(4, 2, 3, 3, TEAL[3]);
        let g = animated(&[a, b], 8);
        assert_eq!(&g[..6], b"GIF89a");
        assert_eq!(u16::from_le_bytes([g[6], g[7]]), 8);
        assert_eq!(*g.last().unwrap(), 0x3B);
        assert!(g.windows(11).any(|w| w == b"NETSCAPE2.0"));
        if let Some((format, w, h, frames)) = crate::media::check::pillow(&g, "gif") {
            assert_eq!((format.as_str(), w, h, frames), ("GIF", 8, 6, 2));
        }
    }

    #[test]
    fn big_noisy_frames_decode_and_are_deterministic() {
        let mut rng = crate::media::rng::Rng::new(7);
        let frames: Vec<Canvas> = (0..3)
            .map(|_| {
                let mut c = Canvas::new(120, 90);
                for p in c.px.iter_mut() {
                    *p = rng.below(32) as u8;
                }
                c
            })
            .collect();
        let g = animated(&frames, 5);
        assert_eq!(g, animated(&frames, 5));
        if let Some((format, w, h, n)) = crate::media::check::pillow(&g, "gif") {
            assert_eq!((format.as_str(), w, h, n), ("GIF", 120, 90, 3));
        }
    }
}
