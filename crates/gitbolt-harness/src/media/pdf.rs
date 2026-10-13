//! A small PDF writer: numbered objects and an xref table, deflated content streams, the standard
//! Helvetica and Courier faces (WinAnsi), and images indexed over Orbital's palette.

use super::canvas::Canvas;
use super::palette::{PALETTE, SPACE};
use super::png::zlib;

pub type Rgb = [u8; 3];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Font {
    Regular,
    Bold,
    Italic,
    Mono,
}

impl Font {
    pub fn resource(self) -> &'static str {
        match self {
            Font::Regular => "/F1",
            Font::Bold => "/F2",
            Font::Italic => "/F3",
            Font::Mono => "/F4",
        }
    }
    pub fn base(self) -> &'static str {
        match self {
            Font::Regular => "Helvetica",
            Font::Bold => "Helvetica-Bold",
            Font::Italic => "Helvetica-Oblique",
            Font::Mono => "Courier",
        }
    }
}

/// Advance widths of ASCII 32–126 in thousandths of the size (the faces' published metrics;
/// Helvetica-Oblique shares Helvetica's).
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
    722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
    556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

pub fn text_width(font: Font, size: f32, s: &str) -> f32 {
    let bold = font == Font::Bold;
    let units: u32 = s
        .chars()
        .map(|ch| match (font, ch) {
            (Font::Mono, _) => 600,
            (_, ' '..='~') => (if bold { &HELVETICA_BOLD } else { &HELVETICA })[ch as usize - 32] as u32,
            (_, '\u{2014}' | '\u{2026}') => 1000,
            (_, '\u{2022}') => 350,
            (_, '\u{2018}' | '\u{2019}') => if bold { 278 } else { 222 },
            (_, '\u{201C}' | '\u{201D}') => if bold { 500 } else { 333 },
            (_, '\u{00D7}') => 584,
            (_, '\u{00B0}') => 400,
            (_, '\u{00B7}') => 278,
            _ => 556,
        })
        .sum();
    units as f32 * size / 1000.0
}

/// `s` as a PDF string literal in WinAnsiEncoding: Latin-1 as octal escapes, the typographic
/// dashes, quotes, bullet and ellipsis mapped, anything else `?`.
pub fn encode(s: &str) -> String {
    let mut out = String::from("(");
    for ch in s.chars() {
        match ch {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            ' '..='~' => out.push(ch),
            '\u{2014}' => out.push_str("\\227"),
            '\u{2013}' => out.push_str("\\226"),
            '\u{2018}' => out.push_str("\\221"),
            '\u{2019}' => out.push_str("\\222"),
            '\u{201C}' => out.push_str("\\223"),
            '\u{201D}' => out.push_str("\\224"),
            '\u{2022}' => out.push_str("\\225"),
            '\u{2026}' => out.push_str("\\205"),
            '\u{00A0}'..='\u{00FF}' => out.push_str(&format!("\\{:03o}", ch as u32)),
            _ => out.push('?'),
        }
    }
    out.push(')');
    out
}

/// `s` as a PDF text string for /Info, which is PDFDocEncoding, not WinAnsi: the typographic
/// marks sit at codes of their own there, Latin-1 keeps its codes, and anything else becomes `?`.
pub fn encode_info(s: &str) -> String {
    let mut out = String::from("(");
    for ch in s.chars() {
        match ch {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            ' '..='~' => out.push(ch),
            '\u{2022}' => out.push_str("\\200"),
            '\u{2026}' => out.push_str("\\203"),
            '\u{2014}' => out.push_str("\\204"),
            '\u{2013}' => out.push_str("\\205"),
            '\u{201C}' => out.push_str("\\215"),
            '\u{201D}' => out.push_str("\\216"),
            '\u{2018}' => out.push_str("\\217"),
            '\u{2019}' => out.push_str("\\220"),
            '\u{00A1}'..='\u{00FF}' if ch != '\u{00AD}' => out.push_str(&format!("\\{:03o}", ch as u32)),
            _ => out.push('?'),
        }
    }
    out.push(')');
    out
}

fn num(v: f32) -> String {
    let s = format!("{v:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.to_string() }
}

fn rgb(c: Rgb) -> String {
    format!("{} {} {}", num(c[0] as f32 / 255.0), num(c[1] as f32 / 255.0), num(c[2] as f32 / 255.0))
}

#[derive(Clone, Copy, Debug)]
pub enum Paint {
    Fill,
    Stroke,
    Both,
}

impl Paint {
    fn op(self) -> &'static str {
        match self {
            Paint::Fill => "f",
            Paint::Stroke => "S",
            Paint::Both => "B",
        }
    }
}

/// A page's content stream, in PDF user space (points, y up from the bottom).
#[derive(Default)]
pub struct Ops(pub String);

impl Ops {
    pub fn fill(&mut self, c: Rgb) {
        self.0 += &format!("{} rg\n", rgb(c));
    }
    pub fn stroke(&mut self, c: Rgb) {
        self.0 += &format!("{} RG\n", rgb(c));
    }
    pub fn width(&mut self, w: f32) {
        self.0 += &format!("{} w\n", num(w));
    }
    pub fn dash(&mut self, on: f32, off: f32) {
        self.0 += &format!("[{} {}] 0 d\n", num(on), num(off));
    }
    pub fn solid(&mut self) {
        self.0 += "[] 0 d\n";
    }
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, paint: Paint) {
        self.0 += &format!("{} {} {} {} re {}\n", num(x), num(y), num(w), num(h), paint.op());
    }
    /// A rectangle with corners of radius `r` (quarter circles as Béziers).
    pub fn round_rect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, paint: Paint) {
        let r = r.min(w / 2.0).min(h / 2.0);
        let k = r * (1.0 - 0.5523);
        let p = |x: f32, y: f32| format!("{} {}", num(x), num(y));
        let (x1, y1) = (x + w, y + h);
        self.0 += &format!(
            "{} m {} l {} {} {} c {} l {} {} {} c {} l {} {} {} c {} l {} {} {} c h {}\n",
            p(x + r, y),
            p(x1 - r, y), p(x1 - k, y), p(x1, y + k), p(x1, y + r),
            p(x1, y1 - r), p(x1, y1 - k), p(x1 - k, y1), p(x1 - r, y1),
            p(x + r, y1), p(x + k, y1), p(x, y1 - k), p(x, y1 - r),
            p(x, y + r), p(x, y + k), p(x + k, y), p(x + r, y),
            paint.op()
        );
    }
    pub fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) {
        self.0 += &format!("{} {} m {} {} l S\n", num(x0), num(y0), num(x1), num(y1));
    }
    /// Four Bézier quarters (k = 0.5523).
    pub fn ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, paint: Paint) {
        let (kx, ky) = (rx * 0.5523, ry * 0.5523);
        let p = |x: f32, y: f32| format!("{} {}", num(x), num(y));
        self.0 += &format!(
            "{} m {} {} {} c {} {} {} c {} {} {} c {} {} {} c {}\n",
            p(cx + rx, cy),
            p(cx + rx, cy + ky), p(cx + kx, cy + ry), p(cx, cy + ry),
            p(cx - kx, cy + ry), p(cx - rx, cy + ky), p(cx - rx, cy),
            p(cx - rx, cy - ky), p(cx - kx, cy - ry), p(cx, cy - ry),
            p(cx + kx, cy - ry), p(cx + rx, cy - ky), p(cx + rx, cy),
            paint.op()
        );
    }
    pub fn polygon(&mut self, pts: &[(f32, f32)], paint: Paint) {
        for (i, (x, y)) in pts.iter().enumerate() {
            self.0 += &format!("{} {} {}\n", num(*x), num(*y), if i == 0 { "m" } else { "l" });
        }
        self.0 += &format!("h {}\n", paint.op());
    }
    pub fn text(&mut self, font: Font, size: f32, x: f32, y: f32, s: &str) {
        self.0 += &format!("BT {} {} Tf {} {} Td {} Tj ET\n", font.resource(), num(size), num(x), num(y), encode(s));
    }
    pub fn image(&mut self, name: &str, x: f32, y: f32, w: f32, h: f32) {
        self.0 += &format!("q {} 0 0 {} {} {} cm {name} Do Q\n", num(w), num(h), num(x), num(y));
    }
}

#[derive(Default)]
pub struct Pdf {
    objects: Vec<Vec<u8>>,
}

impl Pdf {
    /// An object number to fill in later (pages name their parent before it's written).
    pub fn reserve(&mut self) -> usize {
        self.objects.push(Vec::new());
        self.objects.len()
    }
    pub fn set(&mut self, id: usize, body: impl Into<Vec<u8>>) {
        self.objects[id - 1] = body.into();
    }
    pub fn add(&mut self, body: impl Into<Vec<u8>>) -> usize {
        self.objects.push(body.into());
        self.objects.len()
    }
    pub fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
        let z = zlib(data);
        let sep = if dict.is_empty() { "" } else { " " };
        let mut out = format!("<< {dict}{sep}/Length {} /Filter /FlateDecode >>\nstream\n", z.len()).into_bytes();
        out.extend_from_slice(&z);
        out.extend_from_slice(b"\nendstream");
        out
    }
    pub fn finish(&self, root: usize, info: usize) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets = Vec::with_capacity(self.objects.len());
        for (i, body) in self.objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", self.objects.len() + 1).as_bytes());
        for o in offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root {root} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n", self.objects.len() + 1).as_bytes());
        out
    }
}

/// An image XObject indexed over `PALETTE`; transparent pixels take the navy backdrop.
pub fn image_object(c: &Canvas) -> Vec<u8> {
    let lookup: String = PALETTE.iter().map(|p| format!("{:02x}{:02x}{:02x}", p[0], p[1], p[2])).collect();
    let pixels: Vec<u8> = c.px.iter().map(|&p| if p == 0 { SPACE[1] } else { p }).collect();
    Pdf::stream(
        &format!("/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace [/Indexed /DeviceRGB {} <{lookup}>] /BitsPerComponent 8 /Interpolate false", c.w, c.h, PALETTE.len() - 1),
        &pixels,
    )
}
